/**
 * The branch-confirmation pass — Phase A (architecture §4.3, §3.4).
 *
 * ── WHY IT EXISTS (G2) ──────────────────────────────────────────────────────
 * Revision 0's only automatic trigger was `existsSync(<commonDir>/refs/heads/<label>)`.
 * A miss may be a PACKED ref, so a miss could only mark an entry `unconfirmed`
 * and nothing else — and `gc` / `pack-refs` pack loose refs routinely. In a
 * repository whose refs are packed EVERY branch is permanently unconfirmed,
 * `deletedAt` is stamped by nothing, and the sweep has no work list: the answer
 * to "does branch deletion terminate without a human" is no. Reading
 * `packed-refs` is what makes it yes.
 *
 * ── THE READ/WRITE SPLIT, AND WHY IT IS NOT NEGOTIABLE (N1, REG-1) ─────────
 * This module READS. It walks `<commonDir>/refs/heads/**` and streams
 * `<commonDir>/packed-refs`, and it writes nothing, takes no lock and runs no
 * `SyncRegion`. What it returns is a DECISION LIST computed against a snapshot
 * of the registry.
 *
 * Applying that list is `registry.applyBranchDecisions` (W-R2), inside the
 * store lock, against the registry as re-read under it. Revision 1 hoisted the
 * whole pass — reads and writes — out of the lock so the `packed-refs` read
 * would stay out of it, which put three `branches.json` writes outside the lock
 * two sections after §3.4 forbade exactly that. All five round-2 reviewers
 * raised it. So: the scan is advisory, the lock-held state is authoritative,
 * and a decision whose entry has moved underneath it is DROPPED rather than
 * forced.
 *
 * ── BOUNDED ────────────────────────────────────────────────────────────────
 * The ref walk is depth- and count-capped and the `packed-refs` read is capped
 * at `PACKED_REFS_MAX_BYTES`. Over either cap the scan returns an EMPTY
 * decision list with `deferred: true`, surfaced as
 * `IndexResult.branch.confirmationDeferred`. Deferring is the only safe answer:
 * a partial ref set makes present branches look absent, and the decision that
 * follows from that is a tombstone.
 */

import { createReadStream, type Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { BranchEntry } from "./branch-registry.js";
import { now } from "./clock.js";
import type { GitLayout } from "./git-layout.js";

/** Index runs between automatic confirmation passes (§4.3). */
export const BRANCH_CONFIRM_INTERVAL = 20;

/**
 * How long a branch must be missing from BOTH ref sources before it is
 * tombstoned (§4.3). A mid-rebase or mid-`pack-refs` instant is a real state
 * and must not destroy an index, so two passes are needed to reach a tombstone.
 */
export const BRANCH_DELETE_GRACE_MS = 24 * 60 * 60 * 1000;

/** How long an unused ephemeral entry (detached / unreadable HEAD) survives. */
export const EPHEMERAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Live ephemeral entries kept, oldest `lastSeen` evicted first (§4.3).
 *
 * This is what stops CI checkouts, bisect runs and tag checkouts from
 * allocating a durable id per commit until `BRANCH_SOFT_LIMIT` is reached with
 * nothing reclaiming them.
 */
export const EPHEMERAL_MAX = 32;

/** Live entries above which the registry is reported as large — a warning, never a failure. */
export const BRANCH_SOFT_LIMIT = 256;

/** The `packed-refs` read is capped here; over it, the scan defers (§4.3). */
export const PACKED_REFS_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Loose refs examined before the walk gives up and defers.
 *
 * A repository with more than this many branches is not a repository this pass
 * can decide about in a hoisted cold-path read, and guessing is the one thing
 * it must not do.
 */
export const LOOSE_REFS_MAX = 20_000;

/** `refs/heads/a/b/c` is depth 3. Deeper than this and the walk defers. */
export const LOOSE_REFS_MAX_DEPTH = 16;

/** Why a decision was reached. Rendered by `mnemex branches prune`. */
export type BranchDecisionReason =
	/** The label is in neither ref source, and this is the first pass to see that. */
	| "ref-absent"
	/** It has been absent since `unconfirmedSince`, which is now older than the grace. */
	| "grace-expired"
	/** An ephemeral entry not seen for `EPHEMERAL_TTL_MS`. */
	| "ephemeral-ttl"
	/** An ephemeral entry evicted because there are more than `EPHEMERAL_MAX` live ones. */
	| "ephemeral-max";

/**
 * One decision, computed against the Phase-A snapshot and VALIDATED against the
 * lock-held entry before it is applied.
 *
 * `observedLastSeen` is the whole validation: if the entry's `lastSeen` has
 * moved, some other process (or `resolveId` in this very run) has touched it
 * since the scan, and this decision describes a registry that no longer exists.
 */
export interface BranchDecision {
	readonly id: number;
	readonly label: string;
	readonly set: "unconfirmedSince" | "deletedAt";
	readonly observedLastSeen: string;
	readonly reason: BranchDecisionReason;
}

export interface ConfirmScanResult {
	/** Empty when `deferred`. */
	readonly decisions: readonly BranchDecision[];
	/**
	 * A ref source was over its cap, so the scan could not see the whole ref
	 * set. NOTHING is decided: a partial ref set makes live branches look
	 * deleted.
	 */
	readonly deferred: boolean;
	/** Why it deferred, for the report. `null` when it did not. */
	readonly deferredReason: string | null;
	/**
	 * Live `kind: "branch"` labels the scan found in NEITHER ref source —
	 * §4.3's `missingBranchRefs`. Reported whether or not a decision followed,
	 * because "a ref vanished" is a fact the user may want to act on before the
	 * grace expires.
	 */
	readonly missingRefs: readonly string[];
	/** Refs read, both sources together. Diagnostic. */
	readonly refsRead: number;
}

/** Everything the pass can be tuned by. Defaults are the constants above. */
export interface ConfirmScanOptions {
	readonly graceMs?: number;
	readonly ephemeralTtlMs?: number;
	readonly ephemeralMax?: number;
	readonly packedRefsMaxBytes?: number;
	readonly looseRefsMax?: number;
	/** Injected for tests; production passes nothing and `clock.now()` is used. */
	readonly nowMs?: number;
}

const EMPTY_SCAN: ConfirmScanResult = {
	decisions: [],
	deferred: false,
	deferredReason: null,
	missingRefs: [],
	refsRead: 0,
};

/**
 * Should the confirmation pass run in this index run?
 *
 * Three triggers, and the two size-based ones exist because the interval alone
 * bounds nothing useful in the cases the constants were written for: 33 detached
 * checkouts would sit 19 runs above `EPHEMERAL_MAX` waiting for run 40.
 *
 * `runNumber` is 1-based: the run that takes the counter from 19 to 20 is run 20
 * and is the one that fires.
 */
export function shouldConfirmBranches(
	runNumber: number,
	liveEntries: number,
	liveEphemeralEntries: number,
	options: { readonly interval?: number; readonly ephemeralMax?: number } = {},
): boolean {
	const interval = options.interval ?? BRANCH_CONFIRM_INTERVAL;
	const ephemeralMax = options.ephemeralMax ?? EPHEMERAL_MAX;
	return (
		(interval > 0 && runNumber % interval === 0) ||
		liveEntries > BRANCH_SOFT_LIMIT ||
		liveEphemeralEntries > ephemeralMax
	);
}

/** Live: not tombstoned. An `unconfirmedSince` entry is still live. */
export function isLiveEntry(entry: BranchEntry): boolean {
	return entry.deletedAt === null;
}

/**
 * PHASE A. Read both ref sources and decide what the registry should say.
 *
 * Reads only. Never throws: a ref source that cannot be read is a reason to
 * DEFER, never to decide that a branch is gone.
 */
export async function confirmScan(
	layout: GitLayout,
	entries: readonly BranchEntry[],
	options: ConfirmScanOptions = {},
): Promise<ConfirmScanResult> {
	const refs = await readBranchRefs(layout, options);
	if (refs.deferred) {
		return {
			...EMPTY_SCAN,
			deferred: true,
			deferredReason: refs.deferredReason,
			refsRead: refs.labels.size,
		};
	}
	return {
		...decide(entries, refs.labels, options),
		deferred: false,
		deferredReason: null,
		refsRead: refs.labels.size,
	};
}

/**
 * The decision arithmetic, over a ref set someone else read.
 *
 * Separated from the I/O so the rules can be driven directly with a constructed
 * registry and a constructed ref set — which is how `EPHEMERAL_MAX` and the
 * grace are exercised without 33 real checkouts and without waiting a day.
 */
export function decideBranchLifecycle(
	entries: readonly BranchEntry[],
	refLabels: ReadonlySet<string>,
	options: ConfirmScanOptions = {},
): Pick<ConfirmScanResult, "decisions" | "missingRefs"> {
	return decide(entries, refLabels, options);
}

function decide(
	entries: readonly BranchEntry[],
	refLabels: ReadonlySet<string>,
	options: ConfirmScanOptions,
): Pick<ConfirmScanResult, "decisions" | "missingRefs"> {
	const at = options.nowMs ?? now();
	const grace = options.graceMs ?? BRANCH_DELETE_GRACE_MS;
	const ttl = options.ephemeralTtlMs ?? EPHEMERAL_TTL_MS;
	const max = options.ephemeralMax ?? EPHEMERAL_MAX;

	const decisions: BranchDecision[] = [];
	const missingRefs: string[] = [];
	const live = entries.filter(isLiveEntry);

	// ── 1. Branches whose ref is in neither source ───────────────────────────
	for (const entry of live) {
		if (entry.kind !== "branch") continue;
		if (refLabels.has(entry.label)) continue;
		missingRefs.push(entry.label);
		if (entry.unconfirmedSince === null) {
			decisions.push({
				id: entry.id,
				label: entry.label,
				set: "unconfirmedSince",
				observedLastSeen: entry.lastSeen,
				reason: "ref-absent",
			});
			continue;
		}
		// The grace is measured from the FIRST miss, not from this one. A pass
		// that re-stamped `unconfirmedSince` on every miss would push the
		// tombstone out for ever, which is revision 0's outcome by another route.
		if (at - Date.parse(entry.unconfirmedSince) > grace) {
			decisions.push({
				id: entry.id,
				label: entry.label,
				set: "deletedAt",
				observedLastSeen: entry.lastSeen,
				reason: "grace-expired",
			});
		}
	}

	// ── 2. Ephemeral entries: TTL, then the cap ──────────────────────────────
	const ephemeral = live.filter((entry) => entry.ephemeral);
	const expired = new Set<number>();
	for (const entry of ephemeral) {
		if (at - Date.parse(entry.lastSeen) <= ttl) continue;
		expired.add(entry.id);
		decisions.push({
			id: entry.id,
			label: entry.label,
			set: "deletedAt",
			observedLastSeen: entry.lastSeen,
			reason: "ephemeral-ttl",
		});
	}

	// Oldest `lastSeen` first, and the TTL victims are already counted as gone
	// so the cap does not evict twice as many as it should.
	const survivors = ephemeral
		.filter((entry) => !expired.has(entry.id))
		.sort((a, b) => Date.parse(a.lastSeen) - Date.parse(b.lastSeen));
	const overBy = survivors.length - max;
	for (let i = 0; i < overBy; i++) {
		const entry = survivors[i];
		decisions.push({
			id: entry.id,
			label: entry.label,
			set: "deletedAt",
			observedLastSeen: entry.lastSeen,
			reason: "ephemeral-max",
		});
	}

	return { decisions, missingRefs };
}

// ════════════════════════════════════════════════════════════════════════════
// The two ref sources
// ════════════════════════════════════════════════════════════════════════════

interface RefScan {
	readonly labels: Set<string>;
	readonly deferred: boolean;
	readonly deferredReason: string | null;
}

/**
 * Every branch label this repository has, from `refs/heads/**` AND
 * `packed-refs`.
 *
 * BOTH, always. A loose ref that has just been packed exists in both for a
 * moment and in neither for none, so reading only one source is how a live
 * branch looks deleted.
 */
async function readBranchRefs(
	layout: GitLayout,
	options: ConfirmScanOptions,
): Promise<RefScan> {
	const labels = new Set<string>();
	const maxRefs = options.looseRefsMax ?? LOOSE_REFS_MAX;

	const loose = await readLooseHeads(
		join(layout.gitCommonDir, "refs", "heads"),
		"",
		labels,
		maxRefs,
		0,
	);
	if (loose !== null) {
		return { labels, deferred: true, deferredReason: loose };
	}

	const packed = await readPackedRefs(
		join(layout.gitCommonDir, "packed-refs"),
		labels,
		options.packedRefsMaxBytes ?? PACKED_REFS_MAX_BYTES,
	);
	if (packed !== null) {
		return { labels, deferred: true, deferredReason: packed };
	}
	return { labels, deferred: false, deferredReason: null };
}

/**
 * Walk `refs/heads/**`, adding `feature/x` for `refs/heads/feature/x`.
 *
 * Returns `null` on success and a deferral reason otherwise. A MISSING
 * directory is success with no refs: a repository whose refs are all packed has
 * no `refs/heads` entries, which is the case this whole pass exists for.
 */
async function readLooseHeads(
	dir: string,
	prefix: string,
	out: Set<string>,
	maxRefs: number,
	depth: number,
): Promise<string | null> {
	if (depth > LOOSE_REFS_MAX_DEPTH) {
		return `refs/heads nests deeper than ${LOOSE_REFS_MAX_DEPTH}`;
	}
	let items: Dirent[];
	try {
		items = await readdir(dir, { withFileTypes: true });
	} catch (error) {
		const code = (error as NodeJS.ErrnoException | null)?.code;
		// ENOENT: fully packed, or a bare repo with no branches. ENOTDIR: not a
		// ref store at all. Neither is a reason to defer — both mean "no loose
		// refs", which `packed-refs` then answers for.
		if (code === "ENOENT" || code === "ENOTDIR") return null;
		return `refs/heads could not be read (${code ?? "unknown"})`;
	}
	for (const item of items) {
		if (out.size >= maxRefs) return `more than ${maxRefs} refs`;
		const name = prefix === "" ? item.name : `${prefix}/${item.name}`;
		if (item.isDirectory()) {
			const nested = await readLooseHeads(
				join(dir, item.name),
				name,
				out,
				maxRefs,
				depth + 1,
			);
			if (nested !== null) return nested;
		} else if (item.isFile() || item.isSymbolicLink()) {
			out.add(name);
		}
	}
	return null;
}

/**
 * Stream `packed-refs`, adding every `refs/heads/*` label.
 *
 * Streamed rather than read whole, and capped: this is the bounded,
 * asynchronous, cold-path read §2.2 permits, as against the unbounded
 * synchronous per-resolution scan it refuses. The cap is enforced on BYTES SEEN
 * rather than on the file's size at open, so a file that grows under us cannot
 * walk past it.
 *
 * Returns `null` on success, a deferral reason otherwise. An absent file is
 * success: a repository that has never been packed has none.
 */
async function readPackedRefs(
	path: string,
	out: Set<string>,
	maxBytes: number,
): Promise<string | null> {
	try {
		const info = await stat(path);
		if (!info.isFile()) return null;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException | null)?.code;
		if (code === "ENOENT") return null;
		return `packed-refs could not be read (${code ?? "unknown"})`;
	}

	return await new Promise<string | null>((resolve) => {
		const stream = createReadStream(path, { encoding: "utf8" });
		let seen = 0;
		let carry = "";
		let outcome: string | null = null;
		const finish = (reason: string | null): void => {
			outcome = reason;
			stream.destroy();
		};
		stream.on("data", (piece: string | Buffer) => {
			const text = typeof piece === "string" ? piece : piece.toString("utf8");
			seen += Buffer.byteLength(text, "utf8");
			if (seen > maxBytes) {
				finish(`packed-refs is larger than ${maxBytes} bytes`);
				return;
			}
			const lines = (carry + text).split("\n");
			carry = lines.pop() ?? "";
			for (const line of lines) addPackedRef(line, out);
		});
		stream.on("error", (error) => {
			finish(`packed-refs could not be read (${error.message})`);
		});
		stream.on("close", () => {
			if (outcome === null && carry !== "") addPackedRef(carry, out);
			resolve(outcome);
		});
	});
}

/**
 * One `packed-refs` line: `<sha> <fullref>`.
 *
 * `#` is the header (`# pack-refs with: peeled fully-peeled sorted`) and `^` is
 * a peeled tag object. Only `refs/heads/` is of interest — `refs/tags` and
 * `refs/remotes` are not branch labels in this registry's sense, and a detached
 * HEAD's label is a sha, which never appears here as a ref NAME.
 */
function addPackedRef(line: string, out: Set<string>): void {
	if (line === "" || line.startsWith("#") || line.startsWith("^")) return;
	const space = line.indexOf(" ");
	if (space < 0) return;
	const ref = line.slice(space + 1).trim();
	if (!ref.startsWith("refs/heads/") || ref.length === "refs/heads/".length) {
		return;
	}
	out.add(ref.slice("refs/heads/".length));
}
