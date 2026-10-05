/**
 * `<storeDir>/branches.json` — the branch registry (architecture §3.4).
 *
 * Turns a HEAD label into a stable integer id. Ids are allocated once per label
 * from a monotonic `nextId` and are NEVER reused. There is no ceiling. Rows
 * carry ids, never names: a name in a `LIKE` pattern is CLAUDE.md #22's bug
 * waiting to happen, and an integer cannot be.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * REG-1 (serialisation). `branches.json` may be READ anywhere. It is WRITTEN
 * only while the store lock is held, and every write renames the whole file
 * from an object parsed under the SAME lock acquisition. `openRegistry` takes
 * the held lock and remembers its ownership token. Every mutation re-checks the
 * token and throws `RegistryNotLockedError` if the lock is not the one it was
 * opened under. A static sweep (`branch-registry-reg1.test.ts`) checks the
 * call sites.
 *
 * W-R1 durability (round 3, C1). Serialisation is not durability. When
 * `resolveId` ALLOCATES, the file is renamed at once, before the id is
 * returned, so the id is on disk before any row can carry it. This is one extra
 * rename per label for the life of the store. Every other change waits for the
 * end-of-run `flush()`.
 *
 * `openRegistry`'s raise (C1, mechanism 2). On the lock-held open, `nextId` is
 * raised above the highest branch id any row already carries. This covers an
 * allocation whose rename was lost after all.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * THE FORMAT IS FINAL (formatVersion 1). 3a-2 wrote all eleven fields while
 * setting only some of them, deliberately, so that the lifecycle could be built
 * without an on-disk format change. It was: this phase writes `deletedAt` and
 * `unconfirmedSince` and needs no twelfth field.
 *
 * THE WRITE PATHS, and where each of them is (§3.4's table):
 *   W-R1  `resolveId`              allocate, or RESURRECT (rule R)
 *   W-R2  `applyBranchDecisions`   the confirm pass's decisions (§4.3 Phase B)
 *   W-R3  `stamp`                  headSha / lastIndexedAt at the end of a run
 *   W-R4  `markNeedsReindex`       HEAD moved mid-run (§4.1.5)
 *   W-R5  `finalizeTombstone`      rule C's compaction, after the sweep drained
 *   W-R6  `clearIndexStamp`        `--force`'s `narrowBranch` (§4.5)
 *
 * RULE R (§3.4). A label matching only a TOMBSTONED or UNCONFIRMED entry is
 * RESURRECTED: both fields are cleared, `lastSeen` refreshes and the SAME id
 * comes back. Allocating a fresh id instead would strand every row the sweep
 * had not yet reached under an id nothing resolves to, which no pass in this
 * design can recover. It is safe because of REG-1: W-R1, W-R2 and W-R5 are all
 * inside one lock acquisition, so a sweep cannot be in flight for a label
 * `resolveId` is resolving.
 *
 * RULE C (§3.4). `finalizeTombstone` DROPS a tombstoned entry once its sweep
 * has drained, leaving `nextId` untouched — "never reused" is a property of
 * `nextId` alone. Without it every CI checkout and every bisect step leaves a
 * permanent record in a file that is read on the search path.
 *
 * Time comes from `./clock.js`, never from `Date.now()` or an argument-less
 * `new Date()` (swept).
 */

import { readFileSync } from "node:fs";
import { writeFileAtomicallySync } from "./atomic-file.js";
import type { BranchDecision } from "./branch-lifecycle.js";
import { now } from "./clock.js";
import type { GitHead, HeadKind } from "./git-layout.js";
import {
	getBranchRegistryPathFor,
	getLockPathFor,
	type StoreLocation,
} from "./store-location.js";

/**
 * The row marker for "visible from every branch": docs, observations and every
 * row of a store with no git layout (architecture §3.2.1, §4.4). It is NEVER a
 * branch id. The registry allocates from `FIRST_BRANCH_ID` up.
 */
export const BRANCH_ID_SHARED = 0;

/** The first id the registry can issue. */
export const FIRST_BRANCH_ID = 1;

export const BRANCH_REGISTRY_FORMAT_VERSION = 1;

const HEAD_KINDS: ReadonlySet<string> = new Set<HeadKind>([
	"branch",
	"detached",
	"unknown",
]);

/** One registry entry, in the field order `branches.json` is written in. */
export interface BranchEntry {
	id: number;
	/** `main`; a full 40-hex sha when detached; `HEAD@<sha1-12 of gitDir>` when unreadable. */
	label: string;
	/** Descriptive only, never validated against git. */
	kind: HeadKind;
	/** Detached and unknown HEADs are ephemeral (§4.3); branches are not. */
	ephemeral: boolean;
	/** W-R3 (3b): the commit this branch was last indexed at. */
	headSha: string | null;
	firstSeen: string;
	/** Refreshed by every `resolveId` of this label. */
	lastSeen: string;
	/** W-R3 (3b). */
	lastIndexedAt: string | null;
	/** Tombstone: W-R2 stamped it, and the sweep is reclaiming this branch's rows. */
	deletedAt: string | null;
	/** The FIRST confirm-pass miss. The grace is measured from here, never re-stamped. */
	unconfirmedSince: string | null;
	/** W-R4 (3b): HEAD moved mid-run. */
	needsReindex: boolean;
}

export interface BranchRegistryFile {
	formatVersion: typeof BRANCH_REGISTRY_FORMAT_VERSION;
	/** Only ever increases, and never falls to or below an id a row carries. */
	nextId: number;
	branches: BranchEntry[];
}

/**
 * What the registry needs from the store lock. `IndexLock` satisfies it:
 * `ownershipToken` is non-null exactly while that instance holds the lock.
 */
export interface HeldStoreLock {
	readonly path: string;
	readonly ownershipToken: string | null;
}

/**
 * The raise's input: the highest branch id carried by ANY row this store holds
 * in a table with a `branch_id`, or `null` when none does. Leaving a table out
 * re-opens C1 for that table.
 */
export interface BranchIdRowSource {
	highestBranchId(): number | null;
}

/**
 * Every store that carries branch ids, as one source.
 *
 * 3a-2's finding 4 was that the raise read `files` and nothing else, while
 * LANCEDB rows carry branch ids too. The raise's input is therefore assembled
 * from a LIST rather than from one handle, and
 * `test/unit/core/tracker-branch-id.test.ts` enforces that the list names every
 * store that can carry one. A store whose value is `null` contributes nothing,
 * which is what a fresh or unreadable store honestly reports.
 *
 * The LanceDB side is a NUMBER rather than a source, because reading it is
 * asynchronous and `openRegistry` is called with the store lock already held
 * and must not await inside it. The caller reads it first and passes it in.
 */
export function combineBranchIdSources(
	...sources: ReadonlyArray<BranchIdRowSource | number | null>
): BranchIdRowSource {
	return {
		highestBranchId(): number | null {
			let highest: number | null = null;
			for (const source of sources) {
				const value =
					typeof source === "number" || source === null
						? source
						: source.highestBranchId();
				if (value !== null && (highest === null || value > highest)) {
					highest = value;
				}
			}
			return highest;
		},
	};
}

/**
 * W-R2's outcome. `dropped` is not a failure: it is the mechanism that makes a
 * hoisted, unlocked scan safe, and a caller that reports it can tell a quiet
 * pass from a contended one.
 */
export interface AppliedDecisions {
	readonly applied: readonly BranchDecision[];
	readonly dropped: ReadonlyArray<{
		readonly decision: BranchDecision;
		readonly why: string;
	}>;
}

/** A registry opened, or mutated, without the store lock it was opened under (REG-1). */
export class RegistryNotLockedError extends Error {
	constructor(
		readonly registryPath: string,
		detail: string,
	) {
		super(
			`branch registry ${registryPath}: ${detail}. branches.json is written only while the store lock is held (REG-1)`,
		);
		this.name = "RegistryNotLockedError";
	}
}

/**
 * `branches.json` exists and cannot be trusted. REFUSED, never reset: a reset
 * `nextId` re-issues ids that rows already carry (C1).
 */
export class BranchRegistryCorruptError extends Error {
	constructor(
		readonly registryPath: string,
		detail: string,
	) {
		super(
			`branch registry ${registryPath} is unreadable (${detail}). It is not reset, because a reset re-issues ids that indexed rows already carry. ` +
				"Move it aside and run `mnemex index --force`: the rows are rebuilt, and new ids are issued above every id a row still carries.",
		);
		this.name = "BranchRegistryCorruptError";
	}
}

/** What `resolveId` did, for the caller that has to act on it. */
export interface ResolvedBranch {
	readonly id: number;
	/**
	 * Rule R fired: this entry was tombstoned or unconfirmed and is live again.
	 *
	 * The caller MUST then drop any `store.json` sweep cursor naming this id AND
	 * finish that interrupted sweep's tree-scoped deletion, or the branch keeps
	 * `files` rows describing chunks the sweep already removed and the ordinary
	 * diff reports nothing to do. See `Indexer.indexInternal`.
	 */
	readonly resurrected: boolean;
}

/** A registry opened under a held store lock, for one index run. */
export interface BranchRegistry {
	readonly path: string;
	/**
	 * W-R1. The id for `head`'s label. A NEW label is allocated and the file
	 * renamed before this returns. A known label has its `lastSeen` refreshed,
	 * which waits for `flush()`. A tombstoned or unconfirmed label is
	 * RESURRECTED with its own id (rule R).
	 */
	resolveId(head: GitHead): number;
	/**
	 * `resolveId`'s full answer, for the caller that must react to rule R.
	 * `null` until `resolveId` has run.
	 */
	readonly resolved: ResolvedBranch | null;
	/**
	 * W-R2 (§4.3 Phase B). Apply the hoisted scan's decisions, inside the lock,
	 * against the registry as re-read under it.
	 *
	 * Each decision is VALIDATED and dropped rather than forced when the entry
	 * has moved underneath it. The scan is advisory; this state is authoritative.
	 */
	applyBranchDecisions(decisions: readonly BranchDecision[]): AppliedDecisions;
	/**
	 * W-R5, rule C. Drop a fully-swept tombstoned entry, leaving `nextId` alone.
	 *
	 * `remainingMembershipRows` is the PROOF, not a formality: the caller must
	 * pass the live `count(*) FROM chunk_branches WHERE branch_id = :id` it just
	 * read, and a non-zero value throws. A parameter the body ignores is
	 * CLAUDE.md #32's defect, so this one is compared.
	 */
	finalizeTombstone(id: number, remainingMembershipRows: number): void;
	/** Every entry, live and tombstoned, as a snapshot. Read-only. */
	entries(): readonly BranchEntry[];
	/**
	 * W-R3: record that this branch was indexed at `headSha`, at `indexedAt`.
	 *
	 * Called ONLY when §4.1.5's re-read of HEAD still names the label this run
	 * resolved. A run whose HEAD moved must not claim to have indexed the branch
	 * it started on — the tree it read was somebody else's.
	 *
	 * Waits for `flush()`: the stamp is the run's conclusion, and losing it to a
	 * crash costs one re-index, never a wrong id.
	 */
	stamp(branchId: number, headSha: string | null, indexedAt: string): void;
	/**
	 * W-R6 (§4.5): `--force` is about to remove every row this branch holds, so
	 * the record of when it was last indexed stops being true BEFORE the removal
	 * rather than after it.
	 *
	 * It clears BOTH fields `stamp` writes. §4.5's pseudocode names
	 * `lastIndexedAt` alone, but the two are written together by W-R3 and mean
	 * one thing between them — "this branch was indexed, at that commit, at that
	 * time". Leaving `headSha` behind makes `mnemex branches` print a commit for
	 * a branch that holds nothing, which is the half-true state this call exists
	 * to avoid. `needsReindex` is NOT touched: it is a separate instruction from
	 * §4.1.5 and the run's own `stamp` clears it on success.
	 *
	 * Like every other stamp it waits for `flush()`. A crash between here and
	 * the re-stamp loses the clear, which costs a stale line in one listing and
	 * nothing else: no decision in this design reads either field.
	 */
	clearIndexStamp(branchId: number): void;
	/**
	 * W-R4 (§4.1.5): HEAD moved during the run, so this branch's rows describe a
	 * mixture of two trees. Nothing is rolled back and nothing needs to be — the
	 * tracker rows record the content hash of what was actually read, so the
	 * next run's ordinary diff re-indexes exactly those files. The flag is what
	 * makes that happen on the NEXT run rather than whenever someone notices.
	 */
	markNeedsReindex(branchId: number): void;
	/** End of run: rename the file if anything changed since the last rename. */
	flush(): void;
}

/**
 * Open the registry for one lock-held run: read the file ONCE, raise `nextId`
 * above every id the store's rows carry, and return the handle every mutation
 * goes through.
 *
 * Throws `RegistryNotLockedError` unless `lock` is the store lock for `loc` and
 * is held right now.
 */
export function openRegistry(
	loc: StoreLocation,
	lock: HeldStoreLock,
	rows: BranchIdRowSource,
): BranchRegistry {
	const path = getBranchRegistryPathFor(loc);
	const expectedLockPath = getLockPathFor(loc);
	if (lock.path !== expectedLockPath) {
		throw new RegistryNotLockedError(
			path,
			`the lock passed in is ${lock.path}, not this store's (${expectedLockPath})`,
		);
	}
	const token = lock.ownershipToken;
	if (token === null) {
		throw new RegistryNotLockedError(path, "the store lock is not held");
	}

	const file = readRegistryFile(path);
	let dirty = false;
	/**
	 * D7's fix (§4.3 item 3): an entry THIS run resolved is never tombstoned by
	 * this run's confirm pass. Never persisted — it is a fact about a process,
	 * not about a store.
	 *
	 * A SET, not the last id. An index run resolves exactly one label today, so
	 * a single slot would be equivalent — but "the label this process resolved"
	 * is a claim about every one of them, and a second resolution silently
	 * un-pinning the first is the kind of thing that only shows up as a deleted
	 * index. A set costs nothing and cannot get that wrong.
	 */
	const pinned = new Set<number>();
	let resolved: ResolvedBranch | null = null;

	// C1, mechanism 2: never issue an id that a row already carries, nor one an
	// entry already holds.
	const highestRow = rows.highestBranchId();
	if (
		highestRow !== null &&
		(!Number.isSafeInteger(highestRow) || highestRow < 0)
	) {
		throw new RangeError(
			`branch registry ${path}: rows report a highest branch id of ${highestRow}`,
		);
	}
	const highestEntry = file.branches.reduce(
		(highest, entry) => Math.max(highest, entry.id),
		0,
	);
	const floor = Math.max(
		FIRST_BRANCH_ID,
		highestEntry + 1,
		highestRow === null ? 0 : highestRow + 1,
	);
	if (file.nextId < floor) {
		file.nextId = floor;
		dirty = true;
	}

	const assertHeld = (operation: string): void => {
		if (lock.ownershipToken !== token) {
			throw new RegistryNotLockedError(
				path,
				`${operation} after the store lock it was opened under was released or replaced`,
			);
		}
	};

	const persist = (): void => {
		writeFileAtomicallySync(path, serialiseRegistry(file));
		dirty = false;
	};

	return {
		path,

		resolveId(head: GitHead): number {
			assertHeld("resolveId");
			if (head.label === "") {
				throw new RangeError(`branch registry ${path}: empty HEAD label`);
			}
			const stamp = isoNow();
			const matches = file.branches.filter((b) => b.label === head.label);
			const live = matches.find(
				(b) => b.deletedAt === null && b.unconfirmedSince === null,
			);
			if (live !== undefined) {
				live.lastSeen = stamp;
				live.kind = head.kind;
				pinned.add(live.id);
				resolved = { id: live.id, resurrected: false };
				dirty = true;
				return live.id;
			}
			if (matches.length > 0) {
				// RULE R. The HIGHEST id, because ids are monotonic: if a label
				// somehow has two entries, the most recently allocated one is the
				// one whose rows are the most recent. There is normally exactly
				// one — nothing allocates a second entry for a label while a
				// tombstoned one survives, precisely because of this branch.
				const entry = matches.reduce((best, b) => (b.id > best.id ? b : best));
				const wasResurrected =
					entry.deletedAt !== null || entry.unconfirmedSince !== null;
				entry.deletedAt = null;
				entry.unconfirmedSince = null;
				entry.lastSeen = stamp;
				entry.kind = head.kind;
				pinned.add(entry.id);
				resolved = { id: entry.id, resurrected: wasResurrected };
				dirty = true;
				// Durable AT ONCE, like an allocation and for the same reason: a
				// crash after this must not leave the entry tombstoned while this
				// run's rows carry its id, because the sweep would then delete
				// rows a live branch is pointing at.
				persist();
				return entry.id;
			}

			const id = file.nextId;
			if (!Number.isSafeInteger(id + 1)) {
				throw new RangeError(`branch registry ${path}: nextId ${id} overflows`);
			}
			file.nextId = id + 1;
			file.branches.push({
				id,
				label: head.label,
				kind: head.kind,
				ephemeral: head.kind !== "branch",
				headSha: null,
				firstSeen: stamp,
				lastSeen: stamp,
				lastIndexedAt: null,
				deletedAt: null,
				unconfirmedSince: null,
				needsReindex: false,
			});
			// W-R1: durable BEFORE the id is returned, so before any row carries
			// it. A failed rename un-does the allocation in memory too, so no
			// later flush can publish an id that was never handed out.
			try {
				persist();
			} catch (error) {
				file.branches.pop();
				file.nextId = id;
				throw error;
			}
			pinned.add(id);
			resolved = { id, resurrected: false };
			return id;
		},

		get resolved(): ResolvedBranch | null {
			return resolved;
		},

		applyBranchDecisions(
			decisions: readonly BranchDecision[],
		): AppliedDecisions {
			assertHeld("applyBranchDecisions");
			const applied: BranchDecision[] = [];
			const dropped: Array<{ decision: BranchDecision; why: string }> = [];
			const stamp = isoNow();
			for (const decision of decisions) {
				const entry = file.branches.find((b) => b.id === decision.id);
				const why = dropReason(entry, decision, pinned);
				if (why !== null || entry === undefined) {
					dropped.push({ decision, why: why ?? "no such entry" });
					continue;
				}
				if (decision.set === "unconfirmedSince") entry.unconfirmedSince = stamp;
				else entry.deletedAt = stamp;
				applied.push(decision);
				dirty = true;
			}
			return { applied, dropped };
		},

		finalizeTombstone(id: number, remainingMembershipRows: number): void {
			assertHeld("finalizeTombstone");
			const entry = entryById(file, id);
			if (entry.deletedAt === null) {
				throw new RangeError(
					`branch registry ${path}: entry ${id} ('${entry.label}') is not tombstoned, so rule C does not apply to it`,
				);
			}
			// The proof, COMPARED. A parameter a body ignores is checked by the
			// compiler at call sites only (CLAUDE.md #32), so this one decides.
			if (remainingMembershipRows !== 0) {
				throw new RangeError(
					`branch registry ${path}: entry ${id} ('${entry.label}') still has ${remainingMembershipRows} chunk_branches row(s); rule C drops an entry only once its sweep has drained`,
				);
			}
			file.branches = file.branches.filter((b) => b.id !== id);
			// `nextId` is untouched, which is the whole of "ids are never reused".
			dirty = true;
		},

		entries(): readonly BranchEntry[] {
			return file.branches.map((entry) => ({ ...entry }));
		},

		stamp(branchId: number, headSha: string | null, indexedAt: string): void {
			assertHeld("stamp");
			const entry = entryById(file, branchId);
			entry.headSha = headSha;
			entry.lastIndexedAt = indexedAt;
			// A completed run is the only thing that clears it: the re-index the
			// flag asked for has now happened.
			entry.needsReindex = false;
			dirty = true;
		},

		clearIndexStamp(branchId: number): void {
			assertHeld("clearIndexStamp");
			const entry = entryById(file, branchId);
			entry.headSha = null;
			entry.lastIndexedAt = null;
			dirty = true;
		},

		markNeedsReindex(branchId: number): void {
			assertHeld("markNeedsReindex");
			entryById(file, branchId).needsReindex = true;
			dirty = true;
		},

		flush(): void {
			assertHeld("flush");
			if (dirty) persist();
		},
	};
}

/**
 * Why a decision must not be applied, or `null` when it may be.
 *
 * Phase A read the registry without a lock and Phase B holds one, so every
 * reason here is "the registry moved between the two". Forcing any of them is
 * how a hoisted scan turns into a lost update.
 */
function dropReason(
	entry: BranchEntry | undefined,
	decision: BranchDecision,
	pinned: ReadonlySet<number>,
): string | null {
	if (entry === undefined) return "no such entry";
	if (entry.label !== decision.label) {
		return `entry ${entry.id} is now '${entry.label}', not '${decision.label}'`;
	}
	if (pinned.has(entry.id)) {
		// D7. The label this process just resolved is checked out RIGHT HERE.
		return "this run resolved this entry (pinnedThisRun)";
	}
	if (entry.lastSeen !== decision.observedLastSeen) {
		return "lastSeen moved since the scan";
	}
	if (entry.deletedAt !== null) return "already tombstoned";
	if (decision.set === "unconfirmedSince" && entry.unconfirmedSince !== null) {
		// Re-stamping would push the grace out by a whole period every time two
		// processes scanned at once, so the tombstone would recede for ever.
		return "unconfirmedSince is already set";
	}
	if (
		decision.set === "deletedAt" &&
		decision.reason === "grace-expired" &&
		entry.unconfirmedSince === null
	) {
		// Resurrected, or confirmed present, since the scan: the grace has not
		// run at all, so there is nothing to have expired.
		return "unconfirmedSince was cleared since the scan";
	}
	return null;
}

function entryById(file: BranchRegistryFile, branchId: number): BranchEntry {
	const entry = file.branches.find((b) => b.id === branchId);
	if (entry === undefined) {
		throw new RangeError(
			`branch registry: no entry for id ${String(branchId)}. Only an id this registry issued can be stamped.`,
		);
	}
	return entry;
}

/**
 * READ-ONLY. The registry as it is on disk, for a caller that must not (and
 * cannot) take the store lock — every SEARCH path (§4.4). The file header's
 * "`branches.json` may be READ anywhere" is this function; REG-1 governs
 * WRITES, and this one has no handle, no mutator and no `flush`.
 *
 * An absent file is an EMPTY registry, exactly as `openRegistry` treats it: a
 * store that has never been indexed has no entries, and every label is then
 * unknown (D1). A CORRUPT file still throws `BranchRegistryCorruptError`. That
 * is deliberate and it is not D1's case: D1 covers a knowable "this HEAD has no
 * entry", where returning the superset with `branchUnknown` is more useful than
 * an error. An unreadable registry is a broken store, the error carries the
 * remedy, and silently answering "unknown branch" would hide it behind a flag
 * that means something else.
 */
export function readBranchRegistry(loc: StoreLocation): BranchRegistryFile {
	return readRegistryFile(getBranchRegistryPathFor(loc));
}

/**
 * The registry's bytes, in the canonical key order. Exported so tests can
 * compare a file against what this build would write, not so callers can write
 * it: only `openRegistry`'s handle writes.
 */
export function serialiseRegistry(file: BranchRegistryFile): string {
	return `${JSON.stringify(file, null, 2)}\n`;
}

// ════════════════════════════════════════════════════════════════════════════

function isoNow(): string {
	return new Date(now()).toISOString();
}

/** An absent file is an empty registry. Any other read failure is not. */
function readRegistryFile(path: string): BranchRegistryFile {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") {
			return {
				formatVersion: BRANCH_REGISTRY_FORMAT_VERSION,
				nextId: FIRST_BRANCH_ID,
				branches: [],
			};
		}
		// Unreadable is NOT absent: treating a permission error as "no registry"
		// would restart ids at 1 over rows that already carry them.
		throw new BranchRegistryCorruptError(
			path,
			error instanceof Error ? error.message : String(error),
		);
	}
	return parseRegistry(text, path);
}

function parseRegistry(text: string, path: string): BranchRegistryFile {
	const corrupt = (detail: string) =>
		new BranchRegistryCorruptError(path, detail);
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		throw corrupt(
			`not JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (!isRecord(raw)) throw corrupt("not a JSON object");
	if (raw.formatVersion !== BRANCH_REGISTRY_FORMAT_VERSION) {
		throw corrupt(
			`formatVersion is ${JSON.stringify(raw.formatVersion)}, this build reads ${BRANCH_REGISTRY_FORMAT_VERSION}`,
		);
	}
	if (!isIdAtLeast(raw.nextId, FIRST_BRANCH_ID)) {
		throw corrupt(`nextId is ${JSON.stringify(raw.nextId)}`);
	}
	if (!Array.isArray(raw.branches)) throw corrupt("branches is not an array");

	const branches = raw.branches.map((value, index) =>
		parseEntry(value, index, corrupt),
	);
	const ids = new Set<number>();
	const liveLabels = new Set<string>();
	for (const entry of branches) {
		if (ids.has(entry.id)) throw corrupt(`id ${entry.id} appears twice`);
		ids.add(entry.id);
		if (entry.deletedAt === null) {
			if (liveLabels.has(entry.label)) {
				throw corrupt(`live label '${entry.label}' appears twice`);
			}
			liveLabels.add(entry.label);
		}
	}
	return {
		formatVersion: BRANCH_REGISTRY_FORMAT_VERSION,
		nextId: raw.nextId,
		branches,
	};
}

function parseEntry(
	value: unknown,
	index: number,
	corrupt: (detail: string) => BranchRegistryCorruptError,
): BranchEntry {
	const bad = (field: string) =>
		corrupt(`branches[${index}].${field} is invalid`);
	if (!isRecord(value)) throw corrupt(`branches[${index}] is not an object`);
	if (!isIdAtLeast(value.id, FIRST_BRANCH_ID)) throw bad("id");
	if (typeof value.label !== "string" || value.label === "") {
		throw bad("label");
	}
	if (typeof value.kind !== "string" || !HEAD_KINDS.has(value.kind)) {
		throw bad("kind");
	}
	if (typeof value.ephemeral !== "boolean") throw bad("ephemeral");
	if (!isStringOrNull(value.headSha)) throw bad("headSha");
	if (typeof value.firstSeen !== "string") throw bad("firstSeen");
	if (typeof value.lastSeen !== "string") throw bad("lastSeen");
	if (!isStringOrNull(value.lastIndexedAt)) throw bad("lastIndexedAt");
	if (!isStringOrNull(value.deletedAt)) throw bad("deletedAt");
	if (!isStringOrNull(value.unconfirmedSince)) throw bad("unconfirmedSince");
	if (typeof value.needsReindex !== "boolean") throw bad("needsReindex");
	// Rebuilt in the canonical field order, so a rewrite never reorders a file.
	return {
		id: value.id,
		label: value.label,
		kind: value.kind as HeadKind,
		ephemeral: value.ephemeral,
		headSha: value.headSha,
		firstSeen: value.firstSeen,
		lastSeen: value.lastSeen,
		lastIndexedAt: value.lastIndexedAt,
		deletedAt: value.deletedAt,
		unconfirmedSince: value.unconfirmedSince,
		needsReindex: value.needsReindex,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIdAtLeast(value: unknown, minimum: number): value is number {
	return (
		typeof value === "number" && Number.isSafeInteger(value) && value >= minimum
	);
}

function isStringOrNull(value: unknown): value is string | null {
	return value === null || typeof value === "string";
}
