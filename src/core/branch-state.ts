/**
 * "Is this branch REGISTERED BUT EMPTY?" — the state `branchUnknown` cannot
 * report (decision I-16's related gap, on top of I-13's V3.21).
 *
 * ── THE GAP ─────────────────────────────────────────────────────────────────
 * `branchUnknown` answers exactly one question: "does the registry hold a live
 * entry for this HEAD?". It is FALSE for a branch whose entry is perfectly
 * healthy and whose rows are all gone — which is what a whole-store rebuild
 * from another worktree (`mnemex index --force-all`, a model change, an index
 * version upgrade, a corruption repair) leaves behind, and what an interrupted
 * `--force` or a partly-drained sweep can leave too. The user switches to that
 * branch, searches, and gets an empty answer with no signal whatsoever. That is
 * D1's own "empty fails INVISIBLY" argument arriving through a door D1 does not
 * watch, because D1 only covers a branch the registry has never seen.
 *
 * ── WHY IT IS COMPUTED FROM ROWS AND NOT FROM A MARKER ──────────────────────
 * §4.5 proposes `store.json.storeRebuildAt`, compared against the branch's
 * `lastIndexedAt`, as the signal for the `--force-all` case. A marker answers
 * "was the store rebuilt after this branch was last indexed"; this answers "does
 * the store hold anything for this branch", which is the fact the user acts on
 * and is true of every way of reaching the state, including the ones no marker
 * is stamped for.
 *
 * The two are not exclusive, and BOTH now exist (Phase 3c, decision I-17 item
 * 3). `branchEmpty` is the SIGNAL and `storeRebuiltElsewhere` is the
 * EXPLANATION: the marker is read only after the rows have already said the
 * branch is empty, so it narrows "your branch holds nothing" to "another
 * worktree rebuilt this index after you last indexed" and can never contradict
 * the rows or be mistaken for them. If `store.json` is lost or hand-edited the
 * explanation disappears and the signal does not, which is the whole reason the
 * ordering is that way round.
 *
 * ── WHAT "EMPTY" MEANS, EXACTLY ─────────────────────────────────────────────
 * Zero `files` rows AND zero `chunk_branches` rows for this branch's id. Both,
 * because either alone has a legitimate non-empty reading: a branch mid-first-
 * run has `files` rows before its membership lands, and a store whose tree-
 * scoped tail has run but whose membership has not is the interrupted-sweep
 * state. It is deliberately NOT "the branch has no symbols": a branch can have
 * chunks and no symbols in a language with no parser, and calling that empty
 * would be a lie on every such repository.
 *
 * Only ever computed for a resolved, LIVE registry id (`scope.kind ===
 * "branch"`). A store with no git layout has no branch to be empty, and an
 * unknown branch is already reported as unknown.
 */

import { existsSync } from "node:fs";
import {
	type BranchScopeResolution,
	resolveBranchScopeForRead,
} from "./branch-scope.js";
import {
	getIndexDbPathFor,
	resolveStoreLocation,
	type StoreLocation,
} from "./store-location.js";
import { readStoreRebuildAt } from "./store-meta.js";
import { createFileTracker } from "./tracker.js";

export interface BranchReadState {
	/** D1's resolution, unchanged: the scope, `branchUnknown`, the labels. */
	readonly resolution: BranchScopeResolution;
	/**
	 * The registry holds a LIVE entry for this HEAD and the store holds no row
	 * under its id. Always `false` when `branchUnknown` is true, when there is
	 * no git layout, and when there is no index at all — each of those is a
	 * different state with its own message.
	 */
	readonly branchEmpty: boolean;
	/**
	 * V1.7 / §4.5: `store.json.storeRebuildAt` is newer than this branch's
	 * `lastIndexedAt`, so a whole-store rebuild is WHY {@link branchEmpty} is
	 * true.
	 *
	 * Never true unless `branchEmpty` is. It is the explanation and never the
	 * signal (decision I-17 item 3): rows cannot lie and cover every way of
	 * reaching an empty branch, including an interrupted `--force` and a partly
	 * drained sweep, which no producer stamps a marker for.
	 */
	readonly storeRebuiltElsewhere: boolean;
}

/**
 * Resolve the read scope AND whether this branch holds anything.
 *
 * Read-only, per call, no lock — the same contract as
 * `resolveBranchScopeForRead`, which it wraps. It opens a second SQLite
 * connection to the tracker and closes it again; measured at 0.15 ms median for
 * the open plus both counts, against a schema memo the calling command has
 * already warmed.
 */
export function resolveBranchReadState(projectPath: string): BranchReadState {
	return resolveBranchReadStateFor(resolveStoreLocation(projectPath));
}

export function resolveBranchReadStateFor(loc: StoreLocation): BranchReadState {
	const resolution = resolveBranchScopeForRead(loc);
	const none = { resolution, branchEmpty: false, storeRebuiltElsewhere: false };
	if (resolution.scope.kind !== "branch") return none;
	const dbPath = getIndexDbPathFor(loc);
	if (!existsSync(dbPath)) return none;
	const tracker = createFileTracker(dbPath, loc.pathRoot);
	let branchEmpty: boolean;
	try {
		branchEmpty = branchHoldsNoRows(tracker, resolution.scope.branchId);
	} finally {
		tracker.close();
	}
	return {
		resolution,
		branchEmpty,
		// V1.7: computed ONLY once the rows have already said the branch is
		// empty, so the marker can narrow the reason and can never stand in for
		// the signal (decision I-17 item 3). One small JSON read, on a path that
		// has already opened SQLite.
		storeRebuiltElsewhere: branchEmpty && rebuiltAfter(loc, resolution),
	};
}

/** `storeRebuildAt` is newer than this branch's `lastIndexedAt` (§4.5). */
function rebuiltAfter(
	loc: StoreLocation,
	resolution: BranchScopeResolution,
): boolean {
	const rebuiltAt = readStoreRebuildAt(loc);
	if (rebuiltAt === null) return false;
	// A cleared stamp counts: a branch whose `lastIndexedAt` was wiped by a
	// rebuild it did not survive is the same story, told with one fact missing.
	return (
		resolution.lastIndexedAt === null || rebuiltAt > resolution.lastIndexedAt
	);
}

/** What this module needs of a tracker: two counts it already exposes. */
export interface BranchRowCounter {
	countBranchTreeRows(branchId: number): { readonly files: number };
	countMembership(branchId: number): number;
}

/**
 * THE definition of "this branch holds nothing", in ONE place.
 *
 * Two callers, deliberately, because they differ only in who owns the
 * connection: `resolveBranchReadStateFor` opens its own (the CLI's graph
 * commands, which hold no tracker at that point), and `Indexer.searchScoped`
 * passes the tracker it already has open (decision I-17 item 2). A second
 * spelling of the predicate is how the two surfaces would come to disagree
 * about what "empty" means, which is the failure the `clear()`-does-not-clear-
 * the-symbol-graph defect had: one rule, stated twice, implemented once.
 *
 * Both counts, never either alone — see this file's header. Neither statement
 * is new: `countBranchTreeRows` and `countMembership` are existing region-
 * wrapped tracker members, so this adds no `.prepare(` and CLAUDE.md #31's
 * clamp arithmetic for R0 is untouched.
 */
export function branchHoldsNoRows(
	tracker: BranchRowCounter,
	branchId: number,
): boolean {
	return (
		tracker.countBranchTreeRows(branchId).files === 0 &&
		tracker.countMembership(branchId) === 0
	);
}
