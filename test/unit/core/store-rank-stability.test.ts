/**
 * NFR-5's real mechanism: TIED retriever rows come back in STORAGE order.
 *
 * ── WHAT WAS MEASURED, AND WHAT IT RULED OUT ────────────────────────────────
 * The design said a widening `mergeInsert` shifts rewritten rows' BM25 scores
 * "by up to 5 %", and that the end-of-drain `optimize()` restores them exactly.
 * Measured on a 26 288-row copy of a real repository store with EVERY row
 * rewritten through the shipped `rowsForWidening` + `writeBranchIdsMirror` pair:
 *
 *     BM25 scores differing after the rewrite + optimize():   0 of 1 200 cells
 *     BM25 scores differing after createIndex(replace:true):  0 of 1 200 cells
 *     BM25 ordered id lists identical:            7 of 20, in BOTH cases
 *     of the 13 queries that moved, moves inside EQUAL-SCORE groups:  13 of 13
 *     vector channel:                  20/20 identical, 0 of 1 200 distances
 *
 * So no score ever drifts, a forced FTS rebuild changes nothing (302-314 ms for
 * an identical reading), and the whole effect is ties reordering. Ties are
 * structural here and always will be: a `code_chunk` row and its `code_unit`
 * row carry the SAME text, so they score identically in both channels — the
 * same duplication that puts 49 repeated `(path, startLine, endLine)` tuples in
 * 400 result rows. Fusion is rank-only, so a tie swap is a real fused-score
 * difference, and at the top-20 boundary it evicts a result.
 *
 * ── WHAT THIS FILE ASSERTS ──────────────────────────────────────────────────
 * The invariant, stated so it cannot be satisfied by luck: **for tied rows the
 * result order does not depend on the order they were written in.** Two stores
 * are built from the SAME rows in OPPOSITE insertion order; the ranked output
 * must be identical, and ordered by id.
 *
 * Its falsifier runs in the same test: the RAW retriever lists, read through an
 * independent connection with no stabilisation, must DIFFER between those two
 * stores. That is the cause still firing while the effect is gone. If that
 * assertion ever fails, the fixture has stopped reproducing the condition (a
 * LanceDB change) and must be re-cut — it does not mean the fix regressed.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import { branchScope } from "../../../src/core/branch-scope.js";
import {
	createVectorStore,
	type IVectorStore,
	stabilizeRetrieverOrder,
	trimIncompleteTieTail,
} from "../../../src/core/store.js";
import type { ChunkWithEmbedding } from "../../../src/types.js";

const DIM = 8;
const BRANCH = 1;
const QUERY = "parseConfig deluxe handling";

let roots: string[] = [];

beforeEach(() => {
	roots = [];
});

afterEach(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function newRoot(): { dir: string; vectorsDir: string } {
	const dir = mkdtempSync(join(tmpdir(), "mnemex-rank-stability-"));
	roots.push(dir);
	return { dir, vectorsDir: join(dir, "vectors") };
}

/**
 * Rows that TIE in BOTH channels: identical `content` (so identical BM25
 * score) and identical `vector` (so identical distance), different ids and
 * paths. This is the `code_chunk` / `code_unit` shape, in miniature.
 */
function tiedChunks(): ChunkWithEmbedding[] {
	const vector = new Array(DIM).fill(0.01);
	vector[0] = 1;
	const text = "function parseConfig() { /* deluxe handling */ }";
	// 16 lowercase hex characters: `hexIdList` refuses anything else, because
	// that predicate is interpolated with no escaper (CLAUDE.md #22).
	return ["c", "a", "b", "d"].map((letter) => {
		const id = letter.repeat(16);
		return {
			id,
			contentHash: `hash-${letter}`,
			content: text,
			filePath: `src/${letter}.ts`,
			startLine: 1,
			endLine: 10,
			language: "typescript",
			chunkType: "function" as const,
			name: letter,
			fileHash: `file-${letter}`,
			vector: [...vector],
		};
	});
}

async function seedAndRank(
	vectorsDir: string,
	dir: string,
	chunks: ChunkWithEmbedding[],
): Promise<string[]> {
	const store: IVectorStore = createVectorStore({ vectorsDir, pathRoot: dir });
	await store.initialize();
	try {
		// One row at a time, so the INSERTION ORDER is what lands on disk.
		for (const chunk of chunks) {
			await store.addChunks([chunk], { pathKind: "repo", branchId: BRANCH });
		}
		const vector = new Array(DIM).fill(0.01);
		vector[0] = 1;
		const results = await store.search(QUERY, vector, branchScope(BRANCH), {
			limit: 20,
		});
		return results.map((r) => r.chunk.id);
	} finally {
		await store.close();
	}
}

/** The retriever lists as the ENGINE returns them — no stabilisation. */
async function rawOrders(
	vectorsDir: string,
): Promise<{ bm25: string[]; vec: string[] }> {
	const db = await lancedb.connect(vectorsDir);
	const table = await db.openTable("code_chunks");
	const vector = new Array(DIM).fill(0.01);
	vector[0] = 1;
	const bm25 = (await table
		.query()
		.fullTextSearch(QUERY, { columns: ["content"] })
		.limit(20)
		.toArray()) as Array<{ id: string }>;
	const vec = (await table.vectorSearch(vector).limit(20).toArray()) as Array<{
		id: string;
	}>;
	return { bm25: bm25.map((r) => r.id), vec: vec.map((r) => r.id) };
}

describe("stabilizeRetrieverOrder — the pure function", () => {
	test("_score orders descending, ties broken by id ascending", () => {
		const rows = [
			{ id: "zz", _score: 5 },
			{ id: "aa", _score: 9 },
			{ id: "mm", _score: 5 },
			{ id: "bb", _score: 9 },
		];
		expect(stabilizeRetrieverOrder(rows, "_score").map((r) => r.id)).toEqual([
			"aa",
			"bb",
			"mm",
			"zz",
		]);
	});

	test("_distance orders ascending, ties broken by id ascending", () => {
		const rows = [
			{ id: "zz", _distance: 0.5 },
			{ id: "aa", _distance: 0.9 },
			{ id: "mm", _distance: 0.5 },
		];
		expect(stabilizeRetrieverOrder(rows, "_distance").map((r) => r.id)).toEqual(
			["mm", "zz", "aa"],
		);
	});

	test("the input order cannot leak into the output for tied rows", () => {
		const rows = [
			{ id: "b", _score: 1 },
			{ id: "a", _score: 1 },
			{ id: "c", _score: 1 },
		];
		const reversed = [...rows].reverse();
		expect(stabilizeRetrieverOrder(rows, "_score").map((r) => r.id)).toEqual(
			stabilizeRetrieverOrder(reversed, "_score").map((r) => r.id),
		);
	});

	test("it does not mutate its input", () => {
		const rows = [
			{ id: "b", _score: 1 },
			{ id: "a", _score: 2 },
		];
		stabilizeRetrieverOrder(rows, "_score");
		expect(rows.map((r) => r.id)).toEqual(["b", "a"]);
	});

	test("REFUSES rather than guessing when the rank column is absent", () => {
		// If a lancedb version ever renames or drops `_score`, sorting anyway
		// would order the whole candidate list BY ID — catastrophic, and silent.
		// The input is returned untouched instead, which is exactly the previous
		// behaviour, and the end-to-end test below is what then goes red.
		const rows = [{ id: "b" }, { id: "a" }];
		expect(stabilizeRetrieverOrder(rows, "_score")).toBe(rows);
	});

	test("REFUSES on a non-finite score, and on a non-string id", () => {
		const nan = [
			{ id: "b", _score: Number.NaN },
			{ id: "a", _score: 1 },
		];
		expect(stabilizeRetrieverOrder(nan, "_score")).toBe(nan);
		const badId = [
			{ id: 2, _score: 1 },
			{ id: 1, _score: 2 },
		];
		expect(stabilizeRetrieverOrder(badId, "_score")).toBe(badId);
	});
});

describe("trimIncompleteTieTail — the candidate SET, not its order", () => {
	const rows = (scores: number[]) =>
		scores.map((s, i) => ({ id: `id${i}`, _score: s }));

	test("a list the engine CUT loses its last score group", () => {
		// 5 fetched of 5 requested: the engine cut, so the 3-row tail at score 1
		// is an arbitrary sample of however many rows share that score.
		const list = rows([9, 5, 1, 1, 1]);
		expect(
			trimIncompleteTieTail(list, "_score", {
				fetched: 5,
				keepAtLeast: 2,
			}).map((r) => r._score),
		).toEqual([9, 5]);
	});

	test("a list the engine did NOT cut is returned whole", () => {
		// 3 fetched of 5 requested: the corpus ran out, so the tail is complete
		// and trimming it would delete real results.
		const list = rows([9, 1, 1]);
		expect(
			trimIncompleteTieTail(list, "_score", { fetched: 5, keepAtLeast: 1 }),
		).toBe(list);
	});

	test("it never trims below keepAtLeast", () => {
		// Every fetched row on one score — a single-term query. An arbitrary
		// sample beats an empty channel, and no choice here can be principled.
		const list = rows([4, 4, 4, 4]);
		expect(
			trimIncompleteTieTail(list, "_score", { fetched: 4, keepAtLeast: 2 }),
		).toBe(list);
	});

	test("_distance works the same way, and an empty list is left alone", () => {
		const list = [
			{ id: "a", _distance: 0.1 },
			{ id: "b", _distance: 0.7 },
			{ id: "c", _distance: 0.7 },
		];
		expect(
			trimIncompleteTieTail(list, "_distance", {
				fetched: 3,
				keepAtLeast: 1,
			}).map((r) => r.id),
		).toEqual(["a"]);
		expect(
			trimIncompleteTieTail([], "_distance", { fetched: 3, keepAtLeast: 1 }),
		).toEqual([]);
	});

	test("a missing score column leaves the list untouched", () => {
		const list = [{ id: "a" }, { id: "b" }];
		expect(
			trimIncompleteTieTail(list, "_score", { fetched: 2, keepAtLeast: 1 }),
		).toBe(list);
	});
});

describe("NFR-5 — tied rows rank the same however they were written", () => {
	test("two stores, same rows, OPPOSITE insertion order, identical ranking", async () => {
		const chunks = tiedChunks();
		const forward = newRoot();
		const backward = newRoot();

		const rankedForward = await seedAndRank(
			forward.vectorsDir,
			forward.dir,
			chunks,
		);
		const rankedBackward = await seedAndRank(
			backward.vectorsDir,
			backward.dir,
			[...chunks].reverse(),
		);

		// Not vacuous: every row really did come back.
		expect(rankedForward).toHaveLength(chunks.length);

		// THE FALSIFIER, in place: the engine's own order DOES depend on how
		// the rows were written, so the fixture really does reproduce the
		// condition. A failure here means the fixture stopped exercising the
		// property (a lancedb change) and must be re-cut — not that the fix
		// regressed.
		const rawForward = await rawOrders(forward.vectorsDir);
		const rawBackward = await rawOrders(backward.vectorsDir);
		expect([rawForward.bm25, rawForward.vec]).not.toEqual([
			rawBackward.bm25,
			rawBackward.vec,
		]);

		// THE PROPERTY: the ranking the user sees is the same either way, and
		// it is the total order `(score, id)` — here, ids ascending.
		expect(rankedForward).toEqual(rankedBackward);
		expect(rankedForward).toEqual([...chunks.map((c) => c.id)].sort());
	}, 60_000);

	test("rewriting every row's branchIds mirror does not move the ranking", async () => {
		// The widening drain's write, then M5's optimize(), then the same
		// query — the sequence a second worktree's first index performs.
		const { dir, vectorsDir } = newRoot();
		const chunks = tiedChunks();
		const before = await seedAndRank(vectorsDir, dir, chunks);

		const store = createVectorStore({ vectorsDir, pathRoot: dir });
		await store.initialize();
		const rows = await store.rowsForWidening(chunks.map((c) => c.id));
		const updated = await store.writeBranchIdsMirror(
			rows.map((row) => ({ ...row, branchIds: ",1,2," })),
		);
		await store.optimize();
		const vector = new Array(DIM).fill(0.01);
		vector[0] = 1;
		const after = (
			await store.search(QUERY, vector, branchScope(BRANCH), { limit: 20 })
		).map((r) => r.chunk.id);
		await store.close();

		// Not vacuous: the rewrite really happened.
		expect(updated).toBe(chunks.length);
		expect(after).toEqual(before);
	}, 60_000);
});
