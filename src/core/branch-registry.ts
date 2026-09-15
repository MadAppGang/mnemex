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
 * THE FORMAT IS FINAL (formatVersion 1). Every field the design gives an entry
 * is written, including the tombstone fields (`deletedAt`, `unconfirmedSince`)
 * and the run stamps (`headSha`, `lastIndexedAt`, `needsReindex`), although
 * this build never sets them. A later field would be a format change, and a
 * format change after the v4 bump is what this file is laid out to avoid.
 *
 * NOT IN THIS BUILD (Phase 3b): rule R (resurrecting a tombstone), rule C
 * (compaction), the confirm pass (W-R2), the run stamp (W-R3/W-R4) and
 * `--force`'s `clearIndexStamp` (W-R6). A label that matches a tombstoned or
 * unconfirmed entry is REFUSED with `BranchResurrectionUnsupportedError`. This
 * build never writes such an entry, so the refusal is reachable only from a
 * file written by a later build or by hand. A wrong resolution there would
 * strand rows or leak them across branches.
 *
 * Time comes from `./clock.js`, never from `Date.now()` or an argument-less
 * `new Date()` (swept).
 */

import { readFileSync } from "node:fs";
import { writeFileAtomicallySync } from "./atomic-file.js";
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
	/** Tombstone (3b's confirm pass). Never set by this build. */
	deletedAt: string | null;
	/** First confirm-pass miss (3b). Never set by this build. */
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

/**
 * The current HEAD's label matches only a tombstoned or unconfirmed entry.
 * Rule R (resurrect, keeping the id) is Phase 3b's. Until then this is
 * refused, because neither allocating a new id nor reusing the entry as-is is
 * safe (see the file header).
 */
export class BranchResurrectionUnsupportedError extends Error {
	constructor(
		readonly registryPath: string,
		readonly label: string,
		readonly id: number,
	) {
		super(
			`branch registry ${registryPath}: label '${label}' (id ${id}) is tombstoned or unconfirmed, and resurrecting it (rule R) is not part of this build`,
		);
		this.name = "BranchResurrectionUnsupportedError";
	}
}

/** A registry opened under a held store lock, for one index run. */
export interface BranchRegistry {
	readonly path: string;
	/**
	 * W-R1. The id for `head`'s label. A NEW label is allocated and the file
	 * renamed before this returns. A known label has its `lastSeen` refreshed,
	 * which waits for `flush()`.
	 */
	resolveId(head: GitHead): number;
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
				dirty = true;
				return live.id;
			}
			if (matches.length > 0) {
				throw new BranchResurrectionUnsupportedError(
					path,
					head.label,
					matches[0].id,
				);
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
			return id;
		},

		flush(): void {
			assertHeld("flush");
			if (dirty) persist();
		},
	};
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
