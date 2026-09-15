/**
 * I-7 FINAL's three required tests, plus M1..M5 at the level they operate on.
 *
 * The architecture (§4.1.3, §10) widens membership with a grouped
 * `table.update`, one call per distinct membership value. That is OVERTURNED by
 * measurement: at 114 distinct memberships per 256-id batch it took 390 s,
 * 4 198 dataset versions and +1.2 GB, against 975 ms and 38 versions for
 * update-only `mergeInsert` (`findings/probes-v6.3-v6.4.md`). Decision I-7
 * FINAL replaces the mechanism and requires five checks, each catching exactly
 * one fault:
 *
 *   M1  one source row per id          the duplicate-id LIVELOCK
 *   M2  rows read > distinct ids       crash residue, recorded in DATA
 *   M3  the existence check            an id with no live row (a P1 break)
 *   M4  numUpdatedRows == expected     anything the first three missed
 *   M5  one optimize() per drain       FTS coverage, latency and SCORE drift
 *
 * The three tests I-7 names by hand are:
 *   1. the duplicate-id livelock, REPRODUCED and then shown fixed;
 *   2. an M4 mismatch surfacing as an ERROR;
 *   3. a filtered FTS query returning rewritten rows IN THE SAME ORDER before
 *      and after `optimize()`.
 *
 * Every row assertion reads through an INDEPENDENT `lancedb.connect()` that the
 * store under test never touched.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import {
	canonicalBranchIds,
	drainWidenIntents,
	MembershipIntegrityError,
	narrowIds,
} from "../../../src/core/branch-membership.js";
import {
	createVectorStore,
	type IVectorStore,
	type WidenSourceRow,
} from "../../../src/core/store.js";
import {
	createFileTracker,
	type IFileTracker,
} from "../../../src/core/tracker.js";
import type { ChunkWithEmbedding } from "../../../src/types.js";

const DIM = 8;
const CHUNKS_TABLE = "code_chunks";
const TEST_TIMEOUT_MS = 120_000;

let dir: string;
let vectorsDir: string;
let store: IVectorStore;
let tracker: IFileTracker;

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "mnemex-merge-"));
	vectorsDir = join(dir, "vectors");
	store = createVectorStore({ vectorsDir, pathRoot: dir });
	await store.initialize();
	tracker = createFileTracker(join(dir, "index.db"), dir);
});

afterEach(async () => {
	await store.close();
	tracker.close();
	rmSync(dir, { recursive: true, force: true });
});

/** A 64-hex id, the shape `hexIdList` requires of a code chunk. */
function chunkId(n: number): string {
	return n.toString(16).padStart(64, "0");
}

function vec(seed: number): number[] {
	return Array.from({ length: DIM }, (_, i) => ((seed + i) % 10) / 10 + 0.01);
}

/** One chunk whose CONTENT carries a token unique to it, for the FTS queries. */
function chunk(n: number, extraWords = ""): ChunkWithEmbedding {
	return {
		id: chunkId(n),
		contentHash: `hash-${n}`,
		content: `export function f${n}() { return zq${n.toString(36)}vx; } ${extraWords}`,
		filePath: "src/a.ts",
		startLine: n * 10 + 1,
		endLine: n * 10 + 9,
		language: "typescript",
		chunkType: "function",
		name: `f${n}`,
		fileHash: "file-a",
		vector: vec(n),
	};
}

/** Seed `count` rows under branch 1, registered and queued for widening into 2. */
async function seedWidenBacklog(
	count: number,
	extraWords = "",
): Promise<string[]> {
	const chunks = Array.from({ length: count }, (_, i) => chunk(i, extraWords));
	await store.addChunks(chunks, { pathKind: "repo", branchId: 1 });
	tracker.commitAddBatch(1, {
		registered: chunks.map((c) => ({
			chunkId: c.id,
			pathKind: "repo" as const,
			path: c.filePath,
			contentHash: c.contentHash,
			rowClass: "code_chunk" as const,
		})),
		memberIds: chunks.map((c) => c.id),
		widenIds: [],
		files: [],
		clearAddIntentIds: [],
	});
	// Branch 2 now points at the same rows, and every one of them owes a mirror
	// rewrite: this is what a second worktree's first run produces.
	tracker.commitAddBatch(2, {
		registered: [],
		memberIds: chunks.map((c) => c.id),
		widenIds: chunks.map((c) => c.id),
		files: [],
		clearAddIntentIds: [],
	});
	return chunks.map((c) => c.id);
}

/**
 * A FRESH `VectorStore` over the same directory.
 *
 * MEASURED, and load-bearing for every test below that mutates through an
 * independent connection: a LanceDB `Table` handle is a SNAPSHOT. It does not
 * see a write made through another connection (probe: 4 rows before, 4 rows
 * after an independent delete, 3 through the deleting connection), although it
 * does pick one up on its own next write. Production is unaffected — the store
 * lock is what stops a second writer — but a test that hand-breaks the table
 * and then reuses the same instance is reading the world as it was.
 */
async function reopenStore(): Promise<void> {
	await store.close();
	store = createVectorStore({ vectorsDir, pathRoot: dir });
	await store.initialize();
}

/** Every row, through a connection the store under test never touched. */
async function independentRows(): Promise<Array<Record<string, unknown>>> {
	const db = await lancedb.connect(vectorsDir);
	const table = await db.openTable(CHUNKS_TABLE);
	return (await table.query().toArray()) as Array<Record<string, unknown>>;
}

// ════════════════════════════════════════════════════════════════════════════
// The ONE renderer (§4.1.3a, N11)
// ════════════════════════════════════════════════════════════════════════════

describe("canonicalBranchIds — the one renderer of the mirror", () => {
	test("numeric ascending, delimited both ends, deduplicated", () => {
		// The assertion that fails if anyone renders `group_concat`'s output
		// directly: SQLite does not order it, and its TEXT concatenation sorts
		// 10 before 2.
		expect(canonicalBranchIds([10, 2, 1])).toBe(",1,2,10,");
		expect(canonicalBranchIds([2, 2, 1])).toBe(",1,2,");
		expect(canonicalBranchIds([])).toBe(",,");
		// The sentinel commas are what make `,1,` never match `,11,`.
		expect(canonicalBranchIds([11])).toBe(",11,");
		expect(canonicalBranchIds([11]).includes(",1,")).toBe(false);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// I-7 test 1 — the duplicate-id livelock
// ════════════════════════════════════════════════════════════════════════════

describe("M1/M2 — a crash duplicate does not livelock the drain", () => {
	test(
		"the naive source (one row per ROW read) throws Ambiguous; M1's dedup drains, and M2 counts the duplicate",
		async () => {
			const ids = await seedWidenBacklog(8);
			// A crash between `table.add` and R5b leaves a SECOND row for one id.
			// Appended through the store's own writer, because that is how a crash
			// produces it: a bare `table.add` with no primary key.
			const duplicated = chunk(3);
			await store.addChunks([duplicated], { pathKind: "repo", branchId: 1 });
			expect((await independentRows()).length).toBe(9);

			// ── The LIVELOCK, reproduced ──────────────────────────────────────
			// Build the source the naive way: one row per row READ. 8 ids come
			// back as 9 rows, so id 3 appears twice and LanceDB rejects the whole
			// batch — atomically, and identically on every retry, so the batch's
			// intents would never clear.
			const rowsRead = await store.rowsForWidening(ids);
			expect(rowsRead.length).toBe(9);
			const naive: WidenSourceRow[] = rowsRead.map((row) => ({
				...row,
				branchIds: ",1,2,",
			}));
			let ambiguous: unknown = null;
			try {
				await store.writeBranchIdsMirror(naive);
			} catch (error) {
				ambiguous = error;
			}
			expect(String(ambiguous)).toContain("Ambiguous merge inserts");
			// Atomic: nothing moved.
			const afterThrow = await independentRows();
			expect(afterThrow.filter((r) => r.branchIds !== ",1,").length).toBe(0);

			// ── FIXED ─────────────────────────────────────────────────────────
			const result = await drainWidenIntents(tracker, store);
			expect(result.batches).toBe(1);
			// M2: 9 rows read for 8 distinct ids.
			expect(result.duplicateRows).toBe(1);
			expect(result.remaining).toBe(0);

			// Every row now carries the recomputed mirror, INCLUDING both copies of
			// the duplicated id: `mergeInsert` overwrites every match. The id still
			// has exactly two rows — a duplicate is CARRIED, never multiplied and
			// never collapsed, and repairing it here with delete-then-add is what
			// I-7 forbids. Recovery owns cleanup.
			const after = await independentRows();
			expect(after.length).toBe(9);
			expect(after.every((r) => r.branchIds === ",1,2,")).toBe(true);
			expect(after.filter((r) => r.id === chunkId(3)).length).toBe(2);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"M3 — a backlog id whose row is gone is reported, and the intent still clears",
		async () => {
			const ids = await seedWidenBacklog(4);
			// P1 broken by hand, as §4.1.4's belt row describes: the row is gone
			// while `chunk_index` still names it.
			const missing = ids[2];
			const db = await lancedb.connect(vectorsDir);
			const table = await db.openTable(CHUNKS_TABLE);
			await table.delete(`id = '${missing}'`);
			await reopenStore();

			const result = await drainWidenIntents(tracker, store);
			expect(result.missingRows).toBe(1);
			expect(result.rowsWidened).toBe(3);
			// The backlog DRAINED. Leaving the intent would re-read the same id on
			// every run for the life of the store, and the row is restored by the
			// tier-1 existence check the next time its file is indexed.
			expect(result.remaining).toBe(0);
			expect(tracker.countWidenIntents()).toBe(0);
		},
		TEST_TIMEOUT_MS,
	);
});

// ════════════════════════════════════════════════════════════════════════════
// I-7 test 2 — an M4 mismatch is an ERROR
// ════════════════════════════════════════════════════════════════════════════

describe("M4 — the merge is checked against the read it was computed from", () => {
	test(
		"a store that under-reports numUpdatedRows raises MembershipIntegrityError, and the intents stay",
		async () => {
			await seedWidenBacklog(4);
			// The ONE thing changed: the count the merge reports. Everything else
			// is the real store, so the failure is the check firing, not a fake.
			const underReporting: IVectorStore = new Proxy(store, {
				get(target, prop, receiver) {
					if (prop === "writeBranchIdsMirror") {
						return async (rows: WidenSourceRow[]) => {
							const real = await target.writeBranchIdsMirror(rows);
							return real - 1;
						};
					}
					return Reflect.get(target, prop, receiver);
				},
			}) as IVectorStore;

			let thrown: unknown = null;
			try {
				await drainWidenIntents(tracker, underReporting);
			} catch (error) {
				thrown = error;
			}
			expect(thrown).toBeInstanceOf(MembershipIntegrityError);
			expect(String(thrown)).toContain("the read it was computed from said");
			// Not swallowed into a partial success: the batch's intents are still
			// there, so the next run redoes it rather than believing it done.
			expect(tracker.countWidenIntents()).toBe(4);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"the check is not vacuous: the SAME drain over the SAME fixture passes with the real count",
		async () => {
			await seedWidenBacklog(4);
			const result = await drainWidenIntents(tracker, store);
			expect(result.rowsWidened).toBe(4);
			expect(tracker.countWidenIntents()).toBe(0);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"the conditional merge skips rows already current, and M4 expects exactly that",
		async () => {
			const ids = await seedWidenBacklog(6);
			// Half the batch already carries the final mirror — the state a crash
			// mid-drain leaves, and the one a redo has to be cheap over.
			const db = await lancedb.connect(vectorsDir);
			const table = await db.openTable(CHUNKS_TABLE);
			await table.update({
				where: `id IN ('${ids[0]}', '${ids[1]}', '${ids[2]}')`,
				values: { branchIds: ",1,2," },
			});
			await reopenStore();

			const result = await drainWidenIntents(tracker, store);
			// THREE, not six: `target.branchIds <> source.branchIds` skipped the
			// rows whose mirror was already exact. M4 read the same rows and
			// expected three, which is why this is not a mismatch.
			expect(result.rowsWidened).toBe(3);
			const after = await independentRows();
			expect(after.every((r) => r.branchIds === ",1,2,")).toBe(true);
		},
		TEST_TIMEOUT_MS,
	);
});

// ════════════════════════════════════════════════════════════════════════════
// I-7 test 3 — M5: FTS order across the coverage step
// ════════════════════════════════════════════════════════════════════════════

describe("M5 — optimize() restores the FRESH-INDEX order a widening disturbs", () => {
	test(
		"a filtered FTS query returns the baseline order after optimize(), and a DIFFERENT one without it",
		async () => {
			// One shared term across every row, so the query has to RANK rather
			// than match one row. The rows start in branches 1 AND 2, so the
			// branch-2 pre-filter matches them from the start and the BASELINE is
			// a real ordered answer rather than an empty one.
			const ids = await seedWidenBacklog(40, "shared config search value");
			await drainWidenIntents(tracker, store);
			const db = await lancedb.connect(vectorsDir);
			const table = await db.openTable(CHUNKS_TABLE);
			await table.createIndex("content", {
				config: lancedb.Index.fts(),
				replace: true,
			});

			// `fullTextSearch`, never `fastSearch`: rows rewritten out of the index
			// are returned by the first (982/982 measured) and by NONE of the
			// second, so no path that must see widened rows may use it.
			const query = async (): Promise<string[]> => {
				const fresh = await lancedb.connect(vectorsDir);
				const t = await fresh.openTable(CHUNKS_TABLE);
				const rows = (await t
					.query()
					.fullTextSearch("shared config search value", {
						columns: ["content"],
					})
					.where("(branchIds LIKE '%,0,%' OR branchIds LIKE '%,2,%')")
					.limit(20)
					.toArray()) as Array<{ id: string }>;
				return rows.map((r) => r.id);
			};

			const baseline = await query();
			expect(baseline.length).toBe(20);
			expect(ids).toEqual(expect.arrayContaining(baseline));

			// A third branch arrives and every row's mirror is rewritten, which is
			// what takes them OUT of the FTS index.
			tracker.commitAddBatch(3, {
				registered: [],
				memberIds: ids,
				widenIds: ids,
				files: [],
				clearAddIntentIds: [],
			});
			await reopenStore();
			const drain = await drainWidenIntents(tracker, store);
			expect(drain.rowsWidened).toBe(40);

			// RECALL is not lost while the rows sit outside the index. This is the
			// fact that makes M5 a latency-and-SCORE step and not a correctness
			// one: the same 20 rows come back, through the same pre-filter.
			const widened = await query();
			expect(new Set(widened)).toEqual(new Set(baseline));

			// M5.
			await store.optimize();
			const optimized = await query();
			expect(optimized).toEqual(baseline);

			// THE FALSIFIER, executed rather than asserted: without the optimize()
			// the ORDER is not the baseline's. Measured on this fixture — the
			// unindexed tail is scored differently, fusion is rank-only, so a
			// shift reorders results. If a future LanceDB stopped shifting them,
			// this assertion is what would say so, rather than M5 quietly
			// becoming decorative.
			expect(widened).not.toEqual(baseline);
		},
		TEST_TIMEOUT_MS,
	);
});

// ════════════════════════════════════════════════════════════════════════════
// narrowIds — W1's order, and the two outcomes
// ════════════════════════════════════════════════════════════════════════════

describe("narrowIds — a row another branch still holds is NARROWED, not deleted", () => {
	test(
		"orphans are deleted, survivors keep their row and lose one id from the mirror",
		async () => {
			const ids = await seedWidenBacklog(4);
			await drainWidenIntents(tracker, store);
			expect(
				(await independentRows()).every((r) => r.branchIds === ",1,2,"),
			).toBe(true);

			// Branch 2 stops pointing at two of them; branch 1 still does.
			const result = await narrowIds(tracker, store, 2, [ids[0], ids[1]]);
			expect(result.rowsDeleted).toBe(0);
			expect(result.rowsNarrowed).toBe(2);
			const afterNarrow = await independentRows();
			expect(afterNarrow.length).toBe(4);
			const byId = new Map(afterNarrow.map((r) => [r.id as string, r]));
			expect(byId.get(ids[0])?.branchIds).toBe(",1,");
			expect(byId.get(ids[2])?.branchIds).toBe(",1,2,");

			// Now branch 1 lets go of the same two: membership empties, so the ROWS
			// go — and with them their `chunk_index` entries (W1, LanceDB first).
			const orphaned = await narrowIds(tracker, store, 1, [ids[0], ids[1]]);
			expect(orphaned.rowsDeleted).toBe(2);
			expect(orphaned.rowsNarrowed).toBe(0);
			expect((await independentRows()).length).toBe(2);
			expect(tracker.knownChunkRows([ids[0], ids[1]]).size).toBe(0);
			// The rows nobody narrowed are untouched, in both stores.
			expect(tracker.knownChunkRows([ids[2], ids[3]]).size).toBe(2);
		},
		TEST_TIMEOUT_MS,
	);
});
