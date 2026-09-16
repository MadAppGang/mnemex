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
 * is stamped for. The two are not exclusive: a marker would let the message say
 * WHY, and §4.5's V1.7 is unbuilt (see the log's findings).
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
	if (resolution.scope.kind !== "branch") {
		return { resolution, branchEmpty: false };
	}
	const dbPath = getIndexDbPathFor(loc);
	if (!existsSync(dbPath)) return { resolution, branchEmpty: false };
	const branchId = resolution.scope.branchId;
	const tracker = createFileTracker(dbPath, loc.pathRoot);
	try {
		const tree = tracker.countBranchTreeRows(branchId);
		const membership = tracker.countMembership(branchId);
		return {
			resolution,
			branchEmpty: tree.files === 0 && membership === 0,
		};
	} finally {
		tracker.close();
	}
}
