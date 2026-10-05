/**
 * The write side of the branch model: widen, insert, narrow, journal, recover
 * (architecture §4.1, §4.2; decision I-7 FINAL).
 *
 * ── WHAT THIS MODULE IS FOR ─────────────────────────────────────────────────
 * Every mutation in this design touches TWO stores that cannot be committed
 * together — LanceDB rows and SQLite membership — so the ORDER between them is
 * not a local choice. Invariant W1 (§3.5) fixes it once: the LanceDB row goes
 * first and the SQLite state that makes it findable second; the `files` stamp
 * is last, or rides in the same transaction as a journal row that completes its
 * step. This file is the only place in `src/` that implements that ordering, so
 * there is one shape to review rather than one per caller.
 *
 * ── THE PROPERTY IT MAINTAINS ───────────────────────────────────────────────
 * P1: an id present in `chunk_index` implies a live LanceDB row with that id.
 * INSERT maintains it forwards (the append precedes the registration, inside
 * the R5a/R5b journal). NARROW maintains it backwards (the LanceDB delete
 * precedes the `chunk_index` delete, so a crash between them leaves an id
 * ABSENT from `chunk_index` with no row — the safe direction, because nothing
 * reads it and the next run inserts it again). WIDEN maintains it vacuously,
 * PROVIDED the id it widens really does have a row — which is what
 * `existingIds` is for.
 *
 * ── WHY `mergeInsert` AND NOT A GROUPED `update` ────────────────────────────
 * The architecture (§4.1.3, §10) widens with one `table.update` per distinct
 * membership value. Measured (V6.3, 10 000 rows, 9 481 widened): at 114
 * distinct memberships per 256-id batch that is 390 s, 4 198 dataset versions
 * and +1.2 GB, against 975 ms and 38 versions for `mergeInsert`. The count of
 * distinct memberships grows with the number of branches, so the cliff is
 * reached by exactly the users this feature exists for. Decision I-7 FINAL
 * replaces the mechanism; the five mechanisms it requires are marked M1-M5
 * below, and none is optional.
 *
 * ── SR-2 ────────────────────────────────────────────────────────────────────
 * Every loop here calls tracker regions, and the tracker's per-region blocking
 * bound composes into the lock's heartbeat bound only if the event loop reaches
 * its TIMERS phase between two regions (CLAUDE.md #20, #31). So every loop
 * yields with the bare statement `await yieldToEventLoop();`, and this file is
 * swept by the same caller-side sweep that covers `indexer.ts`
 * (`test/unit/core/indexer-loop-sweep.test.ts`).
 */

import type { PathKind } from "./repo-path.js";
import type { IVectorStore, WidenSourceRow } from "./store.js";
import { yieldToEventLoop } from "./sync-region.js";
import type { ChunkRowClass, IFileTracker } from "./tracker.js";

/** Ids per LanceDB predicate and per journal batch (§4.1.1). */
export const WRITE_CHUNK = 256;

/** Ids per recovery batch (§4.1.4, N40). */
export const RECOVERY_CHUNK = 256;

/**
 * The FLOOR on what one run's widening drain will rewrite (§4.1.3b) — not a cap
 * on it.
 *
 * ── WHY THIS IS A FLOOR NOW, AND WAS A CAP ──────────────────────────────────
 * It was `20_000` rows, applied as a hard cap. The pre-release measurement pass
 * indexed a real repository: **25 614 rows**, so a second worktree's first index
 * stopped mid-drain with `branch_widen_remaining=5614` — 22 % of the store not
 * yet visible from the new branch — and converged only on a SECOND `index` run.
 * The third worktree did the same. On a repository 30 % larger it would take
 * three runs.
 *
 * That is a silent truncation of CORRECTNESS by a constant whose job was to
 * bound WORK. The budget's own comment said the leftover "is not silent"
 * because `IndexResult.membershipWidenRemaining` carries it — but §6.3
 * established that two of the four entry points that call `index()` (the git
 * post-commit hook and the MCP search tool's auto-reindex) pass no `onProgress`
 * at all, so the "run it again" line reaches neither. What the user sees is a
 * smaller result set and no explanation: D1's failure shape exactly.
 *
 * So the drain now always clears the backlog that EXISTS WHEN IT STARTS, and
 * this constant only raises that when the backlog is small. Three reasons it is
 * safe to let the drain run to the end of its entry backlog:
 *
 *   - It is BOUNDED by construction. `chunk_write_intent`'s primary key is
 *     `(chunk_id, kind)`, so there is at most ONE `'widen'` row per chunk id no
 *     matter how many branches widened it: the backlog can never exceed the
 *     store's row count, and it is read ONCE, before the loop, so the drain
 *     cannot chase work appended while it runs.
 *   - It is a ONE-TIME cost per worktree, and a small one. Measured on the
 *     26 288-row store: 2.3-2.4 s for ALL of it, against the 23 s that
 *     worktree's whole first index took and the 385 s the first worktree paid.
 *   - It does not lengthen a blocked region. Every batch yields
 *     (`yieldToEventLoop`) and calls `reportProgress`, so a longer drain is more
 *     ticks of the same bounded regions, not one longer one — CLAUDE.md #20 and
 *     #31's arithmetic are functions of the REGION, not of the loop's length.
 *
 * `remaining > 0` therefore no longer means "the budget stopped me"; it means a
 * run crashed or aborted mid-drain and the next run will finish it. That is a
 * genuinely exceptional state, and `budgetExhausted` now reports it as one.
 */
export const WIDEN_BUDGET = 20_000;

/** Every row class, in the order a report renders them. */
export const CHUNK_ROW_CLASSES: readonly ChunkRowClass[] = [
	"code_chunk",
	"code_unit",
	"document",
];

/**
 * THE ONE RENDERER of the `branchIds` mirror (§4.1.3a, N11).
 *
 * §3.2 defines the value as `","` + ASCENDING ids + `","`. SQLite's
 * `group_concat` has no defined order and its text concatenation would sort
 * `10` before `2`, and two renderings of one set split one group into two —
 * which is two writes where there should be one. So the ids travel as numbers
 * and only this function turns them into the stored string.
 */
export function canonicalBranchIds(ids: readonly number[]): string {
	return `,${[...new Set(ids)].sort((a, b) => a - b).join(",")},`;
}

/**
 * A membership write did not do what the read it was computed from said it
 * would (M4). Never ignored, never retried: the two stores disagree, and
 * carrying on would write more state on top of a disagreement.
 *
 * IT NAMES THE REMEDY (I-15, 3b-2's finding 8). Aborting is right — I-7 says a
 * mismatch is never ignored — but a store that has genuinely diverged then
 * cannot be indexed AT ALL, and the counts alone leave the user to work out
 * that `--force` is the way out. A rebuild is the honest repair here: the
 * disagreement is between the LanceDB rows and the SQLite membership, and
 * `--force` rebuilds this branch's half of both from the working tree.
 *
 * IT NOW NAMES THE ESCALATION TOO. `--force` is branch-scoped since §4.5 / D3
 * landed, so a disagreement that is NOT confined to this branch survives it —
 * and the user has no way to know which they have. `--force-all` is the bigger
 * hammer and it exists (`branch-force-scope.test.ts` drives it end to end), so
 * naming it no longer sends anyone to an "unknown option" error, which is the
 * reason it was left out before.
 */
export const MEMBERSHIP_INTEGRITY_REMEDY =
	"This run changed nothing further. Run `mnemex index --force` to rebuild THIS BRANCH from " +
	"the working tree; that is what clears the disagreement, and it leaves every other branch's " +
	"rows alone. If it recurs on a fresh --force, the disagreement is not confined to this " +
	"branch: `mnemex index --force-all` rebuilds the whole store, after which every branch has " +
	"to index itself again. If it survives that too, report it with this message.";

export class MembershipIntegrityError extends Error {
	constructor(
		readonly operation: string,
		detail: string,
	) {
		super(
			`branch membership (${operation}): ${detail}. ${MEMBERSHIP_INTEGRITY_REMEDY}`,
		);
		this.name = "MembershipIntegrityError";
	}
}

/** What one mirror-writing batch observed. The inputs to M2, M3 and M4. */
interface MirrorBatchReport {
	/** Rows the merge reported updating. */
	rowsUpdated: number;
	/** M2: rows read beyond the distinct ids read — a crash duplicate exists. */
	duplicateRows: number;
	/** M3: ids that have no live row at all. */
	missingIds: string[];
}

/**
 * Rewrite the mirror for `ids` from their CURRENT membership, and check the
 * write against the read it was computed from.
 *
 * `memberships` is read by the caller because the two callers scope it
 * differently: the drain wants each id's whole membership, and `narrowIds`
 * wants it MINUS the branch being narrowed. Either way the value written is
 * recomputed from scratch, never patched (U3).
 */
async function writeMirror(
	store: IVectorStore,
	operation: string,
	ids: readonly string[],
	memberships: ReadonlyMap<string, number[]>,
): Promise<MirrorBatchReport> {
	const rows = await store.rowsForWidening([...ids]);

	// M1 — ONE source row per id. Two source rows for one id throw `Ambiguous
	// merge inserts are prohibited` and write nothing, identically on every
	// retry: a single crash duplicate would livelock the backlog for good.
	const source = new Map<string, WidenSourceRow>();
	let duplicateRows = 0;
	for (const row of rows) {
		if (source.has(row.id)) {
			duplicateRows++;
			continue;
		}
		source.set(row.id, row);
	}

	// M4's expectation, computed from THIS read. The merge is conditional
	// (`target.branchIds <> source.branchIds`), so a row whose mirror is already
	// exact is not rewritten and must not be counted.
	let expectedUpdates = 0;
	const batch: WidenSourceRow[] = [];
	for (const [id, row] of source) {
		const wanted = canonicalBranchIds(memberships.get(id) ?? []);
		if (row.branchIds !== wanted) {
			// A duplicated id has two target rows and both are matched, so both
			// are counted: `numUpdatedRows` counts TARGET rows, not source rows.
			expectedUpdates += 1 + duplicatesOf(rows, id);
		}
		batch.push({ ...row, branchIds: wanted });
	}

	// M3 — an id with no live row. Not a merge failure: update-only
	// `mergeInsert` never inserts, so it simply matched nothing. Reported to the
	// caller, which records it in data; the row is restored by the tier-1
	// existence check the next time its file is indexed (§4.1.4's belt).
	const missingIds = ids.filter((id) => !source.has(id));

	const rowsUpdated = await store.writeBranchIdsMirror(batch);

	// M4 — anything the first three missed.
	if (rowsUpdated !== expectedUpdates) {
		throw new MembershipIntegrityError(
			operation,
			`the merge reported ${rowsUpdated} updated rows; the read it was computed from said ${expectedUpdates} ` +
				`(${ids.length} ids, ${rows.length} rows read, ${duplicateRows} duplicate rows, ${missingIds.length} with no row)`,
		);
	}
	return { rowsUpdated, duplicateRows, missingIds };
}

/** How many EXTRA rows beyond the first this id has in `rows`. */
function duplicatesOf(rows: readonly WidenSourceRow[], id: string): number {
	let seen = 0;
	for (const row of rows) if (row.id === id) seen++;
	return seen > 0 ? seen - 1 : 0;
}

export function batchIds(ids: readonly string[], size: number): string[][] {
	const batches: string[][] = [];
	for (let i = 0; i < ids.length; i += size) {
		batches.push([...ids.slice(i, i + size)]);
	}
	return batches;
}

// ════════════════════════════════════════════════════════════════════════════
// NARROW — §4.1.1's M1..M4, and the only membership-removal path in `src/`
// ════════════════════════════════════════════════════════════════════════════

export interface NarrowResult {
	/** Rows whose membership emptied, so the row itself was deleted. */
	rowsDeleted: number;
	/** Rows another branch still points at, so only the mirror was rewritten. */
	rowsNarrowed: number;
	/** M2: rows read beyond the distinct ids read, over the whole call. */
	duplicateRows: number;
	/** M3: ids `chunk_index` names that have no live row. */
	missingRows: number;
}

/**
 * Narrow `ids` out of `branchId`: delete the rows whose membership empties,
 * rewrite the mirror of the rows that survive.
 *
 * THE ONLY membership-removal delete in `src/`, and the only
 * `DELETE FROM chunk_index`. Its order is W1's (§3.5) and is not negotiable:
 * `chunk_branches` is the deletion WORK LIST, so dropping it first loses the
 * ability to find the rows — a LanceDB row whose membership rows are gone is
 * invisible to every consistency check this design has, and for a DELETED file
 * (whose tracker row is gone, so nothing revisits it) that ghost is permanent.
 *
 * Never gated on a "nothing changed" short-circuit. The comment the old
 * `deleteByFile(modifiedFile)` call carried transfers verbatim.
 */
export async function narrowIds(
	tracker: IFileTracker,
	store: IVectorStore,
	branchId: number,
	ids: readonly string[],
): Promise<NarrowResult> {
	const result: NarrowResult = {
		rowsDeleted: 0,
		rowsNarrowed: 0,
		duplicateRows: 0,
		missingRows: 0,
	};
	if (ids.length === 0) return result;

	for (const batch of batchIds(ids, WRITE_CHUNK)) {
		// M1 — journal the removal BEFORE anything moves, so a crash anywhere
		// below leaves a row naming exactly these ids and the next run's
		// recovery FINISHES the removal (never undoes it: the file's new id set
		// is already authoritative, and undoing would resurrect the very ghost
		// chunks the removal exists to delete).
		tracker.beginRemoveIntents(branchId, batch);
		await yieldToEventLoop();

		// M2 — who else still points at these rows.
		const survivors = tracker.membershipsOf(batch, branchId);
		await yieldToEventLoop();

		const orphans = batch.filter((id) => !survivors.has(id));
		const surviving = batch.filter((id) => survivors.has(id));

		// M3 — LanceDB FIRST (W1). A delete of ids that are not there is a no-op,
		// which is what makes a re-driven recovery free.
		result.rowsDeleted += await store.deleteByIds(orphans);
		if (surviving.length > 0) {
			const report = await writeMirror(store, "narrow", surviving, survivors);
			result.rowsNarrowed += report.rowsUpdated;
			result.duplicateRows += report.duplicateRows;
			result.missingRows += report.missingIds.length;
		}

		// M4 — SQLite second, in ONE transaction: this branch's membership, the
		// orphans' `chunk_index` rows, and the intents that bracketed all of it.
		tracker.finishNarrowBatch(branchId, batch, orphans);
		await yieldToEventLoop();
	}
	return result;
}

// ════════════════════════════════════════════════════════════════════════════
// removeFileFromBranch — §4.2, reporting PER ROW CLASS
// ════════════════════════════════════════════════════════════════════════════

export interface RowClassRemoval {
	/** Ids this branch held for the path, in this class. */
	candidates: number;
	rowsDeleted: number;
	rowsNarrowed: number;
}

export interface RemoveFileResult {
	rowsDeleted: number;
	rowsNarrowed: number;
	perClass: Record<ChunkRowClass, RowClassRemoval>;
	/**
	 * 3a-2's finding 2. One class had candidates and removed NOTHING while
	 * another removed something — the signal a zero-row total can never carry.
	 *
	 * Measured there: with only `addChunks` broken, the code-unit rows still
	 * deleted, the total was non-zero, the zero-row warning stayed silent, and
	 * 6 chunk rows survived.
	 */
	partialGhost: boolean;
}

/**
 * Narrow every row of one file out of `branchId`, across ALL THREE row classes.
 *
 * The work list comes from `chunk_index` (§4.1.1's query), NOT from
 * `files.chunk_ids`: that column holds code chunks only, so a `chunk_ids`-driven
 * removal leaves every code unit and every enriched summary of a deleted file
 * behind forever (N4) — F2's exact outcome for two of the five row classes, in
 * the release that closes it for the third.
 *
 * `removeFile` (the SQLite tracker row) is the CALLER's, and runs AFTER this
 * returns, per W1: once the tracker row is gone the file is never revisited by
 * `getChanges`, so residue left by the opposite order is permanent rather than
 * self-healing.
 */
export async function removeFileFromBranch(
	tracker: IFileTracker,
	store: IVectorStore,
	branchId: number,
	pathKind: PathKind,
	storedPath: string,
): Promise<RemoveFileResult> {
	const candidates = tracker.chunkIdsForPath(branchId, pathKind, storedPath);
	const perClass = {
		code_chunk: emptyRemoval(),
		code_unit: emptyRemoval(),
		document: emptyRemoval(),
	} satisfies Record<ChunkRowClass, RowClassRemoval>;

	for (const rowClass of CHUNK_ROW_CLASSES) {
		const ids = candidates
			.filter((row) => row.rowClass === rowClass)
			.map((row) => row.chunkId);
		perClass[rowClass].candidates = ids.length;
		if (ids.length === 0) {
			await yieldToEventLoop();
			continue;
		}
		const narrowed = await narrowIds(tracker, store, branchId, ids);
		perClass[rowClass].rowsDeleted = narrowed.rowsDeleted;
		perClass[rowClass].rowsNarrowed = narrowed.rowsNarrowed;
		await yieldToEventLoop();
	}

	const rowsDeleted = CHUNK_ROW_CLASSES.reduce(
		(total, rowClass) => total + perClass[rowClass].rowsDeleted,
		0,
	);
	const rowsNarrowed = CHUNK_ROW_CLASSES.reduce(
		(total, rowClass) => total + perClass[rowClass].rowsNarrowed,
		0,
	);
	const removedSomething = CHUNK_ROW_CLASSES.some(
		(rowClass) =>
			perClass[rowClass].rowsDeleted + perClass[rowClass].rowsNarrowed > 0,
	);
	const removedNothingDespiteCandidates = CHUNK_ROW_CLASSES.some(
		(rowClass) =>
			perClass[rowClass].candidates > 0 &&
			perClass[rowClass].rowsDeleted + perClass[rowClass].rowsNarrowed === 0,
	);
	return {
		rowsDeleted,
		rowsNarrowed,
		perClass,
		partialGhost: removedSomething && removedNothingDespiteCandidates,
	};
}

function emptyRemoval(): RowClassRemoval {
	return { candidates: 0, rowsDeleted: 0, rowsNarrowed: 0 };
}

/** The one-line rendering of a partial ghost, for the caller's warning. */
export function describeRemoval(
	storedPath: string,
	result: RemoveFileResult,
): string {
	const parts = CHUNK_ROW_CLASSES.filter(
		(rowClass) => result.perClass[rowClass].candidates > 0,
	).map((rowClass) => {
		const per = result.perClass[rowClass];
		return `${rowClass} ${per.rowsDeleted + per.rowsNarrowed}/${per.candidates}`;
	});
	return `${storedPath}: ${parts.join(", ")}`;
}

// ════════════════════════════════════════════════════════════════════════════
// The widening drain — §4.1.3b
// ════════════════════════════════════════════════════════════════════════════

export interface WidenDrainResult {
	/** Rows whose mirror this run rewrote. */
	rowsWidened: number;
	/** Batches drained. */
	batches: number;
	/** M2, summed: rows read beyond the distinct ids read. */
	duplicateRows: number;
	/** M3, summed: backlog ids with no live row. */
	missingRows: number;
	/** `'widen'` intents still outstanding when the drain stopped. */
	remaining: number;
	/**
	 * True when the drain stopped on its budget rather than on an empty backlog.
	 *
	 * Since the budget became a FLOOR over the backlog read at entry, this can
	 * only be reached by an EXPLICIT `options.budget` (a fixture) or by intents
	 * committed after that read — which the store lock prevents. On the shipped
	 * path it reads `false`, and a non-zero `remaining` means a previous run
	 * crashed mid-drain, not that this one was truncated.
	 */
	budgetExhausted: boolean;
	/**
	 * The `'widen'` backlog this drain STARTED with — this run's own intents
	 * plus anything an earlier run left.
	 *
	 * Reported as DATA (`IndexResult.branch.widenBacklog`, `--agent`'s
	 * `branch_widen_backlog`) so that "the drain was complete" is a readable
	 * fact — backlog N, `remaining` 0 — rather than an absence. The hook and the
	 * MCP auto-reindex render no progress line at all, so an absence is all they
	 * would otherwise have.
	 */
	backlog: number;
}

export interface WidenDrainOptions {
	budget?: number;
	/** Called once per batch, with the rows widened so far. CLAUDE.md #20. */
	onBatch?: (rowsWidened: number) => void;
}

/**
 * Drain the `'widen'` backlog: recompute each id's mirror from its WHOLE
 * membership and write it.
 *
 * FOUR properties, each of them a defect in an earlier revision of the design:
 *
 *  - It drains WHETHER OR NOT anything changed. Nothing gates it on a non-empty
 *    change set — that gating is V3.18's falsifier. A second worktree's first
 *    run finds almost every file unchanged and almost every row needing a
 *    widen, so a change-gated pass would leave worktree B seeing a permanent
 *    subset of the store.
 *  - The work list is a SET of committed rows, so it survives a crash and has
 *    no order to fall behind. A high-water-mark cursor cannot represent a
 *    scattered set: ids widened later land at arbitrary hash positions, and any
 *    below a mid-walk cursor were never revisited.
 *  - An intent is BRANCH-AGNOSTIC work. The recompute reads the chunk's whole
 *    membership, so an intent left by branch B is completed correctly by a run
 *    on any branch.
 *  - Recovery does not touch `'widen'` rows: they are this drain's input, not
 *    crash residue, and draining them there would bypass the budget.
 *
 * M5 — the caller runs ONE `store.optimize()` after the drain, never per batch.
 */
export async function drainWidenIntents(
	tracker: IFileTracker,
	store: IVectorStore,
	options: WidenDrainOptions = {},
): Promise<WidenDrainResult> {
	// ONE read, BEFORE the loop. The budget is a floor over it (see
	// `WIDEN_BUDGET`): the drain always clears the backlog that exists when it
	// starts, so a second worktree's first index converges in ONE run instead of
	// leaving a fifth of the store invisible until the next one. Reading it once
	// is also what stops the drain chasing work appended while it runs.
	const backlog = tracker.countWidenIntents();
	const budget = options.budget ?? Math.max(WIDEN_BUDGET, backlog);
	const result: WidenDrainResult = {
		rowsWidened: 0,
		batches: 0,
		duplicateRows: 0,
		missingRows: 0,
		remaining: 0,
		budgetExhausted: false,
		backlog,
	};

	let spent = 0;
	while (spent < budget) {
		const take = Math.min(WRITE_CHUNK, budget - spent);
		const ids = tracker.takeWidenIntents(take);
		await yieldToEventLoop();
		if (ids.length === 0) break;

		const memberships = tracker.membershipsOf(ids);
		await yieldToEventLoop();

		const report = await writeMirror(store, "widen", ids, memberships);
		result.rowsWidened += report.rowsUpdated;
		result.duplicateRows += report.duplicateRows;
		result.missingRows += report.missingIds.length;

		// LAST, and only now: the intent is what guarantees the mirror, so it
		// outlives every step that could fail. An id whose row has gone (M3) has
		// its intent cleared too — the backlog must not livelock on a row the
		// tier-1 existence check will re-insert on the next index of its file.
		tracker.clearWidenIntents(ids);
		spent += ids.length;
		result.batches++;
		options.onBatch?.(result.rowsWidened);
		await yieldToEventLoop();
	}

	result.remaining = tracker.countWidenIntents();
	result.budgetExhausted = spent >= budget && result.remaining > 0;
	return result;
}

// ════════════════════════════════════════════════════════════════════════════
// R-recovery — §4.1.4
// ════════════════════════════════════════════════════════════════════════════

export interface CrashResidueResult {
	/** Appended rows this recovery removed (`'add'` intents). */
	added: number;
	/** Removals this recovery finished (`'remove'` intents). */
	removed: number;
}

/**
 * Re-drive whatever a crashed run left in the journal, at the start of every
 * run, inside the store lock, BEFORE any write of this run.
 *
 * `'add'` residue is UNDONE and `'remove'` residue is COMPLETED, and the
 * asymmetry is not arbitrary. An interrupted append has no `chunk_index` row,
 * so nothing refers to the appended rows and deleting them restores a state the
 * ordinary run then rebuilds. An interrupted removal has already been DECIDED —
 * the file's new id set is authoritative — so undoing it would resurrect
 * exactly the ghost chunks the removal existed to delete.
 *
 * Both directions are idempotent, so a recovery that crashes is recovered by
 * the next one.
 */
export async function recoverCrashResidue(
	tracker: IFileTracker,
	store: IVectorStore,
): Promise<CrashResidueResult> {
	const result: CrashResidueResult = { added: 0, removed: 0 };

	// Bounded: each batch clears its own intents, so this terminates when both
	// selects come back empty. The no-progress guard below is what turns a
	// clear that silently did nothing into a loud error instead of a hang.
	for (;;) {
		const adds = tracker.pendingIntents("add", RECOVERY_CHUNK);
		await yieldToEventLoop();
		if (adds.length === 0) break;
		const ids = adds.map((intent) => intent.chunkId);
		await store.deleteByIds(ids);
		tracker.clearAddIntents(ids);
		result.added += ids.length;
		await yieldToEventLoop();
		if (tracker.pendingIntents("add", 1).some((i) => ids.includes(i.chunkId))) {
			throw new MembershipIntegrityError(
				"recovery",
				`clearing ${ids.length} 'add' intents left at least one behind; the journal is not draining`,
			);
		}
		await yieldToEventLoop();
	}

	for (;;) {
		const removes = tracker.pendingIntents("remove", RECOVERY_CHUNK);
		await yieldToEventLoop();
		if (removes.length === 0) break;
		const byBranch = new Map<number, string[]>();
		for (const intent of removes) {
			const ids = byBranch.get(intent.branchId);
			if (ids === undefined) byBranch.set(intent.branchId, [intent.chunkId]);
			else ids.push(intent.chunkId);
		}
		for (const [branchId, ids] of byBranch) {
			// FINISH the removal: `narrowIds` re-drives M1..M4 for exactly these
			// ids, and every step of it is a no-op against work already done.
			await narrowIds(tracker, store, branchId, ids);
			result.removed += ids.length;
			await yieldToEventLoop();
		}
		const stillThere = tracker.pendingIntents("remove", 1);
		await yieldToEventLoop();
		if (
			stillThere.some((intent) =>
				removes.some((done) => done.chunkId === intent.chunkId),
			)
		) {
			throw new MembershipIntegrityError(
				"recovery",
				`finishing ${removes.length} 'remove' intents left at least one behind; the journal is not draining`,
			);
		}
	}

	return result;
}
