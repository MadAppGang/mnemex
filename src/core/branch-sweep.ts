/**
 * The two-phase orphan sweep (architecture §4.3), and rule C's compaction.
 *
 * ── WHAT IT IS ──────────────────────────────────────────────────────────────
 * A branch confirmed absent is tombstoned by the confirmation pass (W-R2). Its
 * rows are NOT deleted there: deletion is batched into the NEXT index run, under
 * the store lock, bounded by `ORPHAN_SWEEP_BUDGET` and resumable from a cursor
 * in `store.json`. Doing it on the branch-delete path would put a large write on
 * an interactive operation, and LanceDB deletions are tombstones until
 * compaction anyway.
 *
 * ── S0–S3 ARE `narrowIds`, NOT A SECOND IMPLEMENTATION ─────────────────────
 * §4.3's S0–S3 are exactly §4.1.1's narrow, parameterised by a branch id and a
 * state-derived work list. They are THE SAME CODE, and that is what stops the
 * two drifting apart — revision 1 of the design described the same operation
 * twice, in two different orders. So this module owns the cursor, the budget,
 * the tree-scoped tail and rule C, and calls `narrowIds` for the removal.
 *
 * ── WHY LANCEDB GOES FIRST (W1, §3.5) ───────────────────────────────────────
 * `chunk_branches` is the WORK LIST. Deleting it first loses the ability to find
 * the rows, and there is no other index from a branch id to its rows, so the
 * LanceDB rows would be unreachable by every consistency check this design has.
 * `narrowIds` enforces that order; this module must never reach around it.
 *
 * ── THE ORPHAN TEST IS "MEMBERSHIP IS EMPTY" ────────────────────────────────
 * The membership set IS the reference count. A row another branch still points
 * at has its mirror rewritten; a row nobody points at is deleted. No refcount
 * column exists and none is wanted.
 *
 * ── SR-2 ────────────────────────────────────────────────────────────────────
 * Every loop here calls tracker regions, so every one of them yields with the
 * bare statement `await yieldToEventLoop();` (CLAUDE.md #20, #31). This file is
 * swept by the same caller-side sweep that covers `indexer.ts` and
 * `branch-membership.ts`.
 */

import { narrowIds } from "./branch-membership.js";
import type { BranchEntry, BranchRegistry } from "./branch-registry.js";
import type { IVectorStore } from "./store.js";
import type { SweepCursor } from "./store-meta.js";
import { yieldToEventLoop } from "./sync-region.js";
import type { IFileTracker, TreeScopedTable } from "./tracker.js";

/** Membership rows one run's sweep may reclaim (§4.3). */
export const ORPHAN_SWEEP_BUDGET = 5000;

/** Ids per S0 page, and rows per tree-scoped delete page (§4.3, §4.5). */
export const SWEEP_CHUNK = 512;

/** Called after each page, with the membership rows removed so far. */
export type SweepProgress = (rowsRemoved: number) => void;

export interface SweepOptions {
	/** `Number.POSITIVE_INFINITY` runs to completion — `mnemex branches prune`. */
	readonly budget?: number;
	readonly pageSize?: number;
	/** Where the last run stopped, from `store.json`. */
	readonly cursor?: SweepCursor | null;
	readonly onProgress?: SweepProgress;
}

export interface SweepResult {
	/** Branch ids whose membership drained in this run. */
	readonly branchesDrained: number[];
	/** Branch ids rule C dropped from `branches.json`. */
	readonly branchesFinalized: number[];
	/** LanceDB rows deleted because nobody pointed at them any more. */
	readonly rowsDeleted: number;
	/** LanceDB rows another branch still holds, whose mirror was rewritten. */
	readonly rowsNarrowed: number;
	/** `chunk_branches` rows removed. */
	readonly membershipRowsRemoved: number;
	/** Tree-scoped SQLite rows deleted, per table. */
	readonly treeRowsDeleted: Record<TreeScopedTable, number>;
	/** Where to resume. `null` when there is nothing left in flight. */
	readonly cursor: SweepCursor | null;
	/** The budget ran out before the work did. */
	readonly budgetExhausted: boolean;
	/** Membership rows still held by tombstoned branches after this run. */
	readonly remaining: number;
}

function emptyTreeCounts(): Record<TreeScopedTable, number> {
	return {
		files: 0,
		documents: 0,
		symbols: 0,
		symbol_references: 0,
		graph_metadata: 0,
	};
}

/**
 * Reclaim tombstoned branches, bounded and resumable.
 *
 * Runs inside the store lock, after `resolveId` and `applyBranchDecisions`, so
 * the tombstone set it reads is this run's. **A branch rule R resurrected is
 * not in it**: resurrection clears `deletedAt`, so the filter below skips it
 * without needing a second check — which is §4.3's "the sweep skips any id that
 * `resolveId` resurrected in this run", expressed as a consequence rather than
 * as a rule that can be forgotten.
 */
export async function sweepTombstonedBranches(
	tracker: IFileTracker,
	store: IVectorStore,
	registry: BranchRegistry,
	options: SweepOptions = {},
): Promise<SweepResult> {
	const budget = options.budget ?? ORPHAN_SWEEP_BUDGET;
	const pageSize = options.pageSize ?? SWEEP_CHUNK;
	const branchesDrained: number[] = [];
	const branchesFinalized: number[] = [];
	const treeRowsDeleted = emptyTreeCounts();
	let rowsDeleted = 0;
	let rowsNarrowed = 0;
	let membershipRowsRemoved = 0;
	let spent = 0;
	let cursor: SweepCursor | null = null;
	let budgetExhausted = false;

	const targets = orderTargets(registry.entries(), options.cursor ?? null);

	for (const target of targets) {
		if (spent >= budget) {
			budgetExhausted = true;
			break;
		}
		// Resume inside this branch only if the cursor is the one that named it.
		let last =
			options.cursor?.branchId === target.id ? options.cursor.lastChunkId : "";
		let touched = false;

		// ── S0..S3, one page at a time ────────────────────────────────────────
		for (;;) {
			if (spent >= budget) {
				budgetExhausted = true;
				break;
			}
			const take = Math.min(pageSize, budget - spent);
			const ids = tracker.membershipPage(target.id, last, take);
			await yieldToEventLoop();
			if (ids.length === 0) break;

			const narrowed = await narrowIds(tracker, store, target.id, ids);
			rowsDeleted += narrowed.rowsDeleted;
			rowsNarrowed += narrowed.rowsNarrowed;
			membershipRowsRemoved += ids.length;
			// KEYSET, and it advances only after the delete: the rows in this page
			// are gone, so an OFFSET would skip exactly as many as it removed.
			last = ids[ids.length - 1];
			spent += ids.length;
			touched = true;
			options.onProgress?.(membershipRowsRemoved);
			await yieldToEventLoop();
		}

		if (budgetExhausted) {
			if (touched)
				cursor = {
					branchId: target.id,
					lastChunkId: last,
					remaining: tracker.countMembership(target.id),
				};
			break;
		}

		// ── The tree-scoped tail (§4.3) ───────────────────────────────────────
		// Only once membership has drained: `files` rows are what make
		// `getChanges` report a file NEW, and deleting them while chunk rows
		// survive would leave rows nothing can reach.
		for (;;) {
			const deleted = tracker.deleteBranchTreeRows(target.id, pageSize);
			await yieldToEventLoop();
			let total = 0;
			for (const table of Object.keys(deleted) as TreeScopedTable[]) {
				treeRowsDeleted[table] += deleted[table];
				total += deleted[table];
			}
			if (total === 0) break;
			touched = true;
			spent += total;
			options.onProgress?.(membershipRowsRemoved);
			await yieldToEventLoop();
			if (spent >= budget) {
				budgetExhausted = true;
				break;
			}
		}

		if (budgetExhausted) {
			cursor = {
				branchId: target.id,
				lastChunkId: last,
				remaining: tracker.countMembership(target.id),
			};
			break;
		}

		// ── Rule C ────────────────────────────────────────────────────────────
		branchesDrained.push(target.id);
		const remainingForBranch = tracker.countMembership(target.id);
		await yieldToEventLoop();
		// The count is passed in and COMPARED by the registry: a sweep that
		// believes it finished and a store that still holds rows must not agree
		// to drop the only entry naming them.
		registry.finalizeTombstone(target.id, remainingForBranch);
		branchesFinalized.push(target.id);
		// `touched` is deliberately not read here: the entry is gone, so no cursor
		// can name it.
	}

	return {
		branchesDrained,
		branchesFinalized,
		rowsDeleted,
		rowsNarrowed,
		membershipRowsRemoved,
		treeRowsDeleted,
		cursor,
		budgetExhausted,
		remaining: tombstonedMembership(tracker, registry),
	};
}

/**
 * Tombstoned branches, the cursor's branch FIRST.
 *
 * Resuming where the last run stopped is what makes the budget a rate limit
 * rather than a lottery: round-robin would leave every branch half swept and
 * rule C would never fire.
 */
function orderTargets(
	entries: readonly BranchEntry[],
	cursor: SweepCursor | null,
): BranchEntry[] {
	const tombstoned = entries.filter((entry) => entry.deletedAt !== null);
	tombstoned.sort((a, b) => a.id - b.id);
	if (cursor === null) return tombstoned;
	const index = tombstoned.findIndex((entry) => entry.id === cursor.branchId);
	if (index <= 0) return tombstoned;
	return [tombstoned[index], ...tombstoned.filter((_, i) => i !== index)];
}

/** Membership rows still held by branches that are tombstoned right now. */
function tombstonedMembership(
	tracker: IFileTracker,
	registry: BranchRegistry,
): number {
	const counts = tracker.membershipCounts();
	let total = 0;
	for (const entry of registry.entries()) {
		if (entry.deletedAt === null) continue;
		total += counts.get(entry.id) ?? 0;
	}
	return total;
}

// ════════════════════════════════════════════════════════════════════════════
// narrowBranch — `--force`, scoped to ONE LIVE branch (§4.5 / D3, I-16)
// ════════════════════════════════════════════════════════════════════════════

export interface NarrowBranchResult {
	/** `chunk_branches` rows removed for this branch. */
	readonly membershipRowsRemoved: number;
	/** LanceDB rows deleted because no branch pointed at them any more. */
	readonly rowsDeleted: number;
	/** LanceDB rows another branch still holds, whose mirror was rewritten. */
	readonly rowsNarrowed: number;
	/** Tree-scoped SQLite rows deleted, per table. */
	readonly treeRowsDeleted: Record<TreeScopedTable, number>;
}

/**
 * Remove every row ONE LIVE branch holds, leaving every other branch's alone.
 *
 * ── WHY `--force` NEEDED THIS ───────────────────────────────────────────────
 * `indexInternal`'s `if (force)` called `vectorStore.clear()` (a `dropTable`)
 * plus `fileTracker.clear()`. Neither takes a branch, so a store holding
 * several branches lost ALL of them to a `--force` on any one — silently, since
 * the destroyed branches stay in `branches.json` and `branchUnknown` therefore
 * never fires (decision I-16). One worktree that has indexed two branches is
 * already exposed; it is not a multi-worktree problem.
 *
 * ── THE SAME MACHINERY AS THE SWEEP, NOT A SECOND IMPLEMENTATION ────────────
 * S0–S3 are `narrowIds`, exactly as in `sweepTombstonedBranches`. What differs
 * is deliberate and is §4.5's: the branch is LIVE, keeps its registry entry and
 * its id, is about to be re-indexed by the same run, and the work runs to
 * COMPLETION rather than to a budget — same region sizes, same yields, more
 * iterations. There is no cursor, because there is no next run to resume in.
 *
 * ── ORDER: THE TREE-SCOPED TABLES GO FIRST HERE, AND LAST IN THE SWEEP ──────
 * §4.5's pseudocode puts the `files|documents|symbols|symbol_references|
 * graph_metadata` deletes after the membership loop, which is the sweep's
 * order. For a FORCE that order reintroduces the defect phase 3b-3 found and
 * fixed for the sweep (`completeInterruptedSweep`): a run killed mid-narrow
 * leaves `files` rows whose `content_hash` still matches the working tree, so
 * the next ordinary `mnemex index` finds nothing to do and the chunk rows this
 * call already removed never come back — a silently half-empty branch, for
 * ever. MEASURED, by swapping the two loops below and running
 * `branch-force-interrupted.test.ts` against it: 21 of 22 membership rows come
 * back and the 22nd never does. That test is the assertion; the swapped run is
 * recorded in `implementation-log.md`.
 *
 * Reversing it is safe because W1's reason for the sweep's order is about
 * `chunk_branches`, not about `files`: the work list is `chunk_branches`, this
 * function never reads `files` to find anything, and no consistency check in
 * this design reaches a chunk row through a `files` row. What `files` decides
 * is whether the NEXT run re-indexes the file, and after a force it always
 * must.
 *
 * The sweep keeps its order for the reason it always had: a tombstoned branch
 * has no next run of its own, so its `files` rows are the only record the
 * resurrection path has, and rule R's `completeInterruptedSweep` consumes them.
 */
export async function narrowBranch(
	tracker: IFileTracker,
	store: IVectorStore,
	branchId: number,
	options: {
		readonly pageSize?: number;
		readonly onProgress?: SweepProgress;
	} = {},
): Promise<NarrowBranchResult> {
	const pageSize = options.pageSize ?? SWEEP_CHUNK;
	const treeRowsDeleted = emptyTreeCounts();
	let rowsDeleted = 0;
	let rowsNarrowed = 0;
	let membershipRowsRemoved = 0;

	// ── The tree-scoped tables, FIRST (see the header) ────────────────────────
	for (;;) {
		const deleted = tracker.deleteBranchTreeRows(branchId, pageSize);
		await yieldToEventLoop();
		let total = 0;
		for (const table of Object.keys(deleted) as TreeScopedTable[]) {
			treeRowsDeleted[table] += deleted[table];
			total += deleted[table];
		}
		if (total === 0) break;
		options.onProgress?.(membershipRowsRemoved);
		await yieldToEventLoop();
	}

	// ── S0..S3, one page at a time, to COMPLETION ─────────────────────────────
	let last = "";
	for (;;) {
		const ids = tracker.membershipPage(branchId, last, pageSize);
		await yieldToEventLoop();
		if (ids.length === 0) break;
		const narrowed = await narrowIds(tracker, store, branchId, ids);
		rowsDeleted += narrowed.rowsDeleted;
		rowsNarrowed += narrowed.rowsNarrowed;
		membershipRowsRemoved += ids.length;
		// KEYSET, and it advances only after the delete: the rows in this page
		// are gone, so an OFFSET would skip exactly as many as it removed.
		last = ids[ids.length - 1];
		options.onProgress?.(membershipRowsRemoved);
		await yieldToEventLoop();
	}

	return { membershipRowsRemoved, rowsDeleted, rowsNarrowed, treeRowsDeleted };
}

/**
 * Finish an interrupted sweep's TREE-SCOPED deletion for a branch that is live
 * again (rule R).
 *
 * ── WHY THIS EXISTS, AND WHAT IT FIXES ──────────────────────────────────────
 * §3.4 says a resurrected branch is fine because "the run that just resolved
 * the id rebuilds exactly what was swept (a branch whose `files` rows were
 * deleted reports every file NEW from `getChanges`)". That parenthesis assumes
 * the sweep deletes `files` rows as it goes. It does not — §4.3 deletes them
 * only once membership has drained. So a branch swept HALFWAY and then
 * resurrected keeps `files` rows whose `content_hash` still matches the working
 * tree, `getChanges` reports nothing to do, and the chunk rows the sweep
 * removed are never rebuilt: a silently half-empty branch.
 *
 * Dropping the tree-scoped rows for exactly that branch is the completion of
 * the operation that was interrupted, and it makes the design's own sentence
 * true. It runs ONLY when the `store.json` cursor names this branch, so a
 * tombstone the sweep never reached costs nothing.
 */
export async function completeInterruptedSweep(
	tracker: IFileTracker,
	branchId: number,
	options: {
		readonly pageSize?: number;
		readonly onProgress?: () => void;
	} = {},
): Promise<Record<TreeScopedTable, number>> {
	const pageSize = options.pageSize ?? SWEEP_CHUNK;
	const deletedTotal = emptyTreeCounts();
	for (;;) {
		const deleted = tracker.deleteBranchTreeRows(branchId, pageSize);
		await yieldToEventLoop();
		let total = 0;
		for (const table of Object.keys(deleted) as TreeScopedTable[]) {
			deletedTotal[table] += deleted[table];
			total += deleted[table];
		}
		if (total === 0) return deletedTotal;
		options.onProgress?.();
		await yieldToEventLoop();
	}
}
