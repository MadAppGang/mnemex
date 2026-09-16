/**
 * V3.3 and V5.4a/b/c — the branch filter at the STORAGE PREDICATE, and NFR-5.
 *
 * Every fixture here writes rows DIRECTLY on several branches through
 * `addChunks(chunks, { pathKind: "repo", branchId })`. Membership WRITES —
 * widen / insert / narrow — are Phase 3b-2's, and are deliberately not used to
 * build test data: a criterion that depended on the mechanism it is meant to
 * check would prove nothing.
 *
 * ── WHAT IS ASSERTED, AND HOW ───────────────────────────────────────────────
 *   V3.3   a file existing only on `feat`, matched by keyword AND by vector, is
 *          ABSENT from a search on `main` — and its row is still IN THE TABLE,
 *          counted through an INDEPENDENT `lancedb.connect()`, so this is the
 *          filter and not a deletion.
 *   V5.4a  a SINGLE-branch store ranks identically with the branch pre-filter
 *          and without it. This is the one new ingredient case 1 of §4.4.3
 *          gains: a predicate that matches every row. Asserted on the ordered
 *          list of `(path, startLine, endLine)` — never on ids, because the v4
 *          upgrade re-hashes every id from a repo-relative path and an id
 *          comparison would fail a CORRECT upgrade.
 *   V5.4b  a second branch that adds NO rows leaves branch A's ordered list
 *          identical, and `countRows()` through an independent connection is
 *          unchanged.
 *   V5.4c  a second branch that CHANGES files containing the query terms leaves
 *          branch A's ordered list identical. This is the release gate. Two
 *          numbers are printed for every run: EXACT ordered-list identity, which
 *          is what the gate asserts, and the mean/max rank displacement, which is
 *          the magnitude an NFR-5 carve-out would have to quote. Identity is the
 *          one that decides the gate; the magnitude carries an ordinal
 *          convention (see `occurrenceKeys`) and identity does not.
 *
 * ── FALSIFIERS, ALL EXECUTED ────────────────────────────────────────────────
 *   V3.3   drop the branch term from EITHER retriever — the foreign chunk comes
 *          back. Both halves run, because `search` builds ONE `filterStr` and
 *          hands it to both, so a single assertion could not tell them apart.
 *   V5.4c  remove the pre-filter — B's rows enter A's list and the ordering
 *          moves grossly. Run, with the displacement printed.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import {
	type BranchScope,
	branchScope,
	SCOPE_ALL,
} from "../../../src/core/branch-scope.js";
import {
	createVectorStore,
	type IVectorStore,
} from "../../../src/core/store.js";
import type { ChunkWithEmbedding, SearchResult } from "../../../src/types.js";

const DIM = 8;
const MAIN = 1;
const FEAT = 2;

let dir: string;
let vectorsDir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "mnemex-branch-search-"));
	vectorsDir = join(dir, "vectors");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/**
 * A unit-ish vector whose FIRST component carries the similarity: `near` 1
 * is closest to the query, and larger values are further away. Deterministic,
 * so the ranking below is a property of the data and not of a random draw.
 */
function vec(near: number): number[] {
	const v = new Array(DIM).fill(0.01);
	v[0] = 1 / near;
	return v;
}

const QUERY_VECTOR = vec(1);

function chunk(
	id: string,
	filePath: string,
	near: number,
	text: string,
	startLine = 1,
): ChunkWithEmbedding {
	return {
		id,
		contentHash: `hash-${id}`,
		content: text,
		filePath,
		startLine,
		endLine: startLine + 9,
		language: "typescript",
		chunkType: "function",
		name: id,
		fileHash: `file-${filePath}`,
		vector: vec(near),
	};
}

async function withStore<T>(
	fn: (store: IVectorStore) => Promise<T>,
): Promise<T> {
	const store = createVectorStore({ vectorsDir, pathRoot: dir });
	await store.initialize();
	try {
		return await fn(store);
	} finally {
		await store.close();
	}
}

/** Fixture rows, written straight onto `branchId`. Not a membership write. */
async function seed(branchId: number, chunks: ChunkWithEmbedding[]) {
	await withStore((store) =>
		store.addChunks(chunks, { pathKind: "repo", branchId }),
	);
}

async function search(
	scope: BranchScope,
	query = "parseConfig",
): Promise<SearchResult[]> {
	return withStore((store) =>
		store.search(query, QUERY_VECTOR, scope, { limit: 20 }),
	);
}

/** The ordered ranking, as §4.4.3 requires it: never ids. */
function ranking(results: SearchResult[]): string[] {
	return results.map(
		(r) => `${r.chunk.filePath}:${r.chunk.startLine}-${r.chunk.endLine}`,
	);
}

/** Row count through an INDEPENDENT connection, never through the store. */
async function independentRowCount(): Promise<number> {
	const db = await lancedb.connect(vectorsDir);
	const table = await db.openTable("code_chunks");
	return table.countRows();
}

/** Every stored `branchIds` cell for a path, through an independent connection. */
async function independentBranchIds(filePath: string): Promise<string[]> {
	const db = await lancedb.connect(vectorsDir);
	const table = await db.openTable("code_chunks");
	const rows = (await table
		.query()
		.where(`filePath = '${filePath}'`)
		.toArray()) as Array<{ branchIds: string }>;
	return rows.map((r) => r.branchIds);
}

/**
 * Disambiguate each `path:start-end` tuple by its ORDINAL within the list.
 *
 * THE DEFECT THIS CLOSES, which this fixture is too small to expose.
 * `displacement()` built `new Map(after.map((key, i) => [key, i]))` over the
 * tuples, and a `Map` keeps the LAST index for a repeated key — so a tuple that
 * occurs twice was scored against the wrong position. A real repository repeats
 * them by construction: one span is carried by BOTH a `code_chunk` row and its
 * `code_unit` row, which is visible directly in `search --agent` output as two
 * `result file=… line=412 end_line=420` lines with different scores. Measured on
 * this repository's own store: **49 of the 400 tuples** in 20 top-20 lists are
 * repeats, and the metric read `mean=0.635 max=14` on two BYTE-IDENTICAL lists.
 *
 * The 30 chunks seeded below have no repeated span, so the published metric has
 * never fired here and could not have. Ordinals make "the second occurrence of
 * this span" a distinct key, which is what the comparison meant all along.
 */
function occurrenceKeys(list: readonly string[]): string[] {
	const seen = new Map<string, number>();
	return list.map((key) => {
		const n = seen.get(key) ?? 0;
		seen.set(key, n + 1);
		return `${key}#${n}`;
	});
}

/**
 * Mean and max rank displacement between two ordered lists, plus EXACT ordered
 * identity.
 *
 * `identical` is the number the gate asserts on (`expect(after).toEqual(before)`
 * is the same statement, per query); mean/max/`setChanged` are the MAGNITUDE an
 * NFR-5 carve-out would have to quote. They are reported side by side
 * deliberately: the magnitude comes from a metric with an ordinal convention in
 * it, and identity does not.
 */
function displacement(
	before: readonly string[],
	after: readonly string[],
): { mean: number; max: number; setChanged: boolean; identical: boolean } {
	const beforeKeys = occurrenceKeys(before);
	const afterKeys = occurrenceKeys(after);
	const position = new Map(afterKeys.map((key, i) => [key, i]));
	let total = 0;
	let max = 0;
	for (let i = 0; i < beforeKeys.length; i++) {
		const now = position.get(beforeKeys[i]);
		const moved = now === undefined ? beforeKeys.length : Math.abs(now - i);
		total += moved;
		max = Math.max(max, moved);
	}
	return {
		mean: beforeKeys.length === 0 ? 0 : total / beforeKeys.length,
		max,
		setChanged:
			beforeKeys.length !== afterKeys.length ||
			beforeKeys.some((key) => !position.has(key)),
		identical:
			beforeKeys.length === afterKeys.length &&
			beforeKeys.every((key, i) => afterKeys[i] === key),
	};
}

// ════════════════════════════════════════════════════════════════════════════
// The INSTRUMENT itself — a metric that cannot report zero measures nothing
// ════════════════════════════════════════════════════════════════════════════

describe("displacement() — the published NFR-5 metric", () => {
	/**
	 * The exact shape a real corpus produces and this file's 30-row fixture
	 * cannot: one `(path, startLine, endLine)` carried by a `code_chunk` row AND
	 * by its `code_unit` row, so the tuple appears twice in one top-20 list.
	 *
	 * Against the pre-fix metric — `new Map(after.map((k, i) => [k, i]))` — every
	 * occurrence resolved to the LAST index, and these two BYTE-IDENTICAL lists
	 * read `mean=1.250 max=3` (measured, by running that metric verbatim on this
	 * exact input). On the repository's own store the same defect read
	 * `mean=0.635 max=14` over 49 repeated tuples in 400.
	 */
	const withRepeats = [
		"src/core/store.ts:412-420",
		"src/core/store.ts:412-420",
		"src/core/indexer.ts:10-20",
		"src/core/store.ts:412-420",
	];

	test("two byte-identical lists with a repeated tuple read exactly zero", () => {
		const d = displacement(withRepeats, [...withRepeats]);
		expect(d.mean).toBe(0);
		expect(d.max).toBe(0);
		expect(d.setChanged).toBe(false);
		expect(d.identical).toBe(true);
	});

	test("...and it still SEES a real move of a repeated tuple", () => {
		// Occurrence #1 and the `indexer.ts` row swap. A metric that scored every
		// occurrence against the same index could not tell this from the case
		// above, which is precisely why the one above could not report zero.
		const moved = [
			"src/core/store.ts:412-420",
			"src/core/indexer.ts:10-20",
			"src/core/store.ts:412-420",
			"src/core/store.ts:412-420",
		];
		const d = displacement(withRepeats, moved);
		expect(d.identical).toBe(false);
		expect(d.max).toBeGreaterThan(0);
		expect(d.setChanged).toBe(false);
	});

	test("a result LEAVING the list is reported as a changed set", () => {
		const d = displacement(["a:1-2", "b:1-2"], ["a:1-2", "c:1-2"]);
		expect(d.setChanged).toBe(true);
		expect(d.identical).toBe(false);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// V3.3 — a chunk that exists only on the other branch
// ════════════════════════════════════════════════════════════════════════════

describe("V3.3 — a search on one branch does not see the other's rows", () => {
	/**
	 * `feat-only.ts` is the NEAREST row by vector AND the strongest keyword
	 * match, so if the predicate is missing anywhere it comes back FIRST. A
	 * fixture whose foreign row was merely plausible could pass by luck.
	 */
	async function seedBothBranches(): Promise<void> {
		await seed(MAIN, [
			chunk("main-a", "src/main-a.ts", 3, "function parseConfig() {}"),
			chunk("main-b", "src/main-b.ts", 4, "parseConfig is called here"),
		]);
		await seed(FEAT, [
			chunk(
				"feat-only",
				"src/feat-only.ts",
				1,
				"parseConfig parseConfig parseConfig deluxe",
			),
		]);
	}

	test("the foreign chunk is absent from the result list", async () => {
		await seedBothBranches();
		const results = await search(branchScope(MAIN));
		expect(ranking(results).join("\n")).not.toContain("feat-only");
		// Not vacuous: this branch's own rows DID come back.
		expect(results.length).toBe(2);
	});

	test("...and the foreign row is still in the table: this is a filter, not a delete", async () => {
		await seedBothBranches();
		await search(branchScope(MAIN));
		expect(await independentRowCount()).toBe(3);
		expect(await independentBranchIds("src/feat-only.ts")).toEqual([",2,"]);
	});

	test("a search on feat DOES see it, and ranks it first", async () => {
		await seedBothBranches();
		const results = await search(branchScope(FEAT));
		expect(results).toHaveLength(1);
		expect(results[0].chunk.filePath).toContain("feat-only.ts");
	});

	test("FALSIFIER: with the predicate dropped, the foreign chunk returns first", async () => {
		await seedBothBranches();
		// `{ kind: "all" }` IS the no-predicate path, so this runs the exact
		// storage query the branch filter is removed from.
		const results = await search(SCOPE_ALL);
		expect(results).toHaveLength(3);
		expect(results[0].chunk.filePath).toContain("feat-only.ts");
	});

	test("FALSIFIER, keyword half: the same holds for a keyword-only search", async () => {
		await seedBothBranches();
		const scoped = await withStore((store) =>
			store.search("parseConfig", undefined, branchScope(MAIN), {
				limit: 20,
				keywordOnly: true,
			}),
		);
		expect(ranking(scoped).join("\n")).not.toContain("feat-only");
		expect(scoped.length).toBe(2);

		const unscoped = await withStore((store) =>
			store.search("parseConfig", undefined, SCOPE_ALL, {
				limit: 20,
				keywordOnly: true,
			}),
		);
		expect(ranking(unscoped).join("\n")).toContain("feat-only");
	});

	test("every returned row carries its branch ids — D1's per-row attribution", async () => {
		await seedBothBranches();
		const results = await search(SCOPE_ALL);
		expect(results).toHaveLength(3);
		// Ids, not labels: the store has no registry and cannot name a branch.
		// `Indexer.searchScoped` resolves these to labels.
		const byPath = new Map(
			results.map((r) => [r.chunk.filePath.split("/").at(-1), r.branchIds]),
		);
		expect(byPath.get("main-a.ts")).toEqual([1]);
		expect(byPath.get("feat-only.ts")).toEqual([2]);
	});

	test("shared rows (branchIds ,0,) are visible from every branch", async () => {
		// §3.2.1's docs/observation marker. The `%,0,%` disjunct in the predicate
		// is load-bearing, not dead code.
		await seed(MAIN, [chunk("m", "src/m.ts", 3, "parseConfig")]);
		await seed(0, [chunk("shared", "docs:lib/x.md", 2, "parseConfig guide")]);

		for (const scope of [branchScope(MAIN), branchScope(FEAT)]) {
			const results = await search(scope);
			expect(
				results.some((r) => r.chunk.filePath.includes("docs:lib/x.md")),
			).toBe(true);
		}
	});
});

// ════════════════════════════════════════════════════════════════════════════
// V5.4 — NFR-5
// ════════════════════════════════════════════════════════════════════════════

/** Twenty queries over one corpus, so "the ranking" is not one lucky list. */
const QUERIES = Array.from({ length: 20 }, (_, i) => `parseConfig topic${i}`);

async function rankingsFor(scope: BranchScope): Promise<string[][]> {
	const out: string[][] = [];
	for (const q of QUERIES) out.push(ranking(await search(scope, q)));
	return out;
}

async function seedBranchA(): Promise<ChunkWithEmbedding[]> {
	const chunks = Array.from({ length: 30 }, (_, i) =>
		chunk(
			`a${i}`,
			`src/a${i}.ts`,
			i + 1,
			`function parseConfig${i}() { /* topic${i % 7} handling */ }`,
			1 + i * 10,
		),
	);
	await seed(MAIN, chunks);
	return chunks;
}

describe("V5.4a — a single-branch store ranks identically with and without the pre-filter", () => {
	test("ordered (path, startLine, endLine) lists are identical, query for query", async () => {
		await seedBranchA();

		const withFilter = await rankingsFor(branchScope(MAIN));
		const withoutFilter = await rankingsFor(SCOPE_ALL);

		expect(withFilter).toEqual(withoutFilter);
		// Not vacuous: the corpus really did rank something.
		expect(withFilter[0].length).toBeGreaterThan(0);
	});
});

describe("V5.4b — a second branch that adds NO rows changes nothing", () => {
	test("branch A's ordered lists are identical, and countRows is unchanged", async () => {
		await seedBranchA();
		const before = await rankingsFor(branchScope(MAIN));
		const rowsBefore = await independentRowCount();

		// A second branch whose tree is IDENTICAL adds no rows: under §4.1.1 the
		// row is shared and WIDENED, not duplicated. The widening machinery is
		// 3b-2's, so the end state is written here directly through the raw
		// driver — every row's cell becomes `,1,2,`. That is a fixture write, not
		// a membership write, and it is the state a real run would leave.
		const db = await lancedb.connect(vectorsDir);
		const table = await db.openTable("code_chunks");
		await table.update({ values: { branchIds: ",1,2," } });

		const rowsAfter = await independentRowCount();
		const after = await rankingsFor(branchScope(MAIN));

		// Not vacuous: branch 2 really can see them now.
		expect((await search(branchScope(FEAT))).length).toBeGreaterThan(0);

		expect(after).toEqual(before);
		expect(rowsAfter - rowsBefore).toBe(0);
	});
});

describe("V5.4c — the release gate: a second branch that changes the query terms' files", () => {
	test("branch A's ordered lists are identical, and the displacement is 0", async () => {
		await seedBranchA();
		const before = await rankingsFor(branchScope(MAIN));

		// Branch B changes files that contain the query terms: new rows for the
		// SAME paths, ranked nearer than anything A holds, with the terms
		// repeated so BM25 ranks them high too.
		await seed(
			FEAT,
			Array.from({ length: 12 }, (_, i) =>
				chunk(
					`b${i}`,
					`src/a${i}.ts`,
					0.5,
					`parseConfig${i} parseConfig${i} topic${i % 7} topic${i % 7} rewritten on feat`,
					1 + i * 10,
				),
			),
		);

		const after = await rankingsFor(branchScope(MAIN));

		// Reported for every run, so the number the NFR-5 carve-out would need
		// is on record whether or not the gate passes.
		let meanSum = 0;
		let maxSeen = 0;
		let setsChanged = 0;
		let identical = 0;
		for (let q = 0; q < QUERIES.length; q++) {
			const d = displacement(before[q], after[q]);
			meanSum += d.mean;
			maxSeen = Math.max(maxSeen, d.max);
			if (d.setChanged) setsChanged++;
			if (d.identical) identical++;
		}
		// Exact ordered-list identity is printed BESIDE the magnitude, because
		// identity is what this gate asserts and the magnitude is what a carve-out
		// would quote. They answer different questions and neither substitutes.
		console.log(
			`V5.4c displacement: mean=${(meanSum / QUERIES.length).toFixed(3)} max=${maxSeen} queriesWithChangedSet=${setsChanged}/${QUERIES.length} orderedListsIdentical=${identical}/${QUERIES.length}`,
		);

		expect(after).toEqual(before);
		expect(identical).toBe(QUERIES.length);
		expect(maxSeen).toBe(0);
		expect(setsChanged).toBe(0);
	});

	test("FALSIFIER: without the pre-filter, B's rows enter A's list and the ordering moves grossly", async () => {
		await seedBranchA();
		const before = await rankingsFor(branchScope(MAIN));

		await seed(
			FEAT,
			Array.from({ length: 12 }, (_, i) =>
				chunk(
					`b${i}`,
					`src/a${i}.ts`,
					0.5,
					`parseConfig${i} parseConfig${i} topic${i % 7} topic${i % 7} rewritten on feat`,
					1 + i * 10,
				),
			),
		);

		const unfiltered = await rankingsFor(SCOPE_ALL);

		let meanSum = 0;
		let maxSeen = 0;
		let setsChanged = 0;
		let identical = 0;
		for (let q = 0; q < QUERIES.length; q++) {
			const d = displacement(before[q], unfiltered[q]);
			meanSum += d.mean;
			maxSeen = Math.max(maxSeen, d.max);
			if (d.setChanged) setsChanged++;
			if (d.identical) identical++;
		}
		console.log(
			`V5.4c FALSIFIER displacement: mean=${(meanSum / QUERIES.length).toFixed(3)} max=${maxSeen} queriesWithChangedSet=${setsChanged}/${QUERIES.length} orderedListsIdentical=${identical}/${QUERIES.length}`,
		);

		expect(unfiltered).not.toEqual(before);
		expect(setsChanged).toBeGreaterThan(0);
		// The instrument can go RED on the identity number too, not only on the
		// magnitude — a green reading from a blind instrument is worth nothing.
		expect(identical).toBeLessThan(QUERIES.length);
	});
});
