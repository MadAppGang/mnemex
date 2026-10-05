/**
 * Iteration 2, F2 — the merge gate: an overlay row enters a retriever channel
 * only where the INDEX list is exact.
 *
 * Root cause (architecture.md, "Iteration 2 — F2 root cause"): each index
 * channel is trimmed by THRESHOLD (`trimIncompleteTieTail` drops the tie group
 * straddling rank `fetchLimit`), so a full engine list comes back SHORTER than
 * `fetchLimit`. The merge then cut the union by COUNT, and the freed slots were
 * refilled by the overlay's best rows however far away they were — rows being
 * compared against index rows the engine never fetched. On the rig, q7 put an
 * unchanged overlay chunk whose index twin sits at vector rank 1742 at vector
 * rank 29, i.e. result #8 of 10.
 *
 *   MG-1  `mergeRetrieverLists` admits an overlay row iff it is STRICTLY
 *         better than `indexEdge` (both directions); `null` admits all; a
 *         non-finite edge admits none
 *   MG-2  `retrieverEdge`: full list -> its last score; short -> null; full
 *         with a non-finite score -> NaN
 *   MG-3  store, vector channel, the q7 shape: a tie straddling `fetchLimit`
 *         plus a far unchanged overlay chunk -> absent; a strictly-better one
 *         -> present, at its index twin's clean position (twin-position oracle)
 *   MG-4  MG-3 on the BM25 side: an FTS tie straddling `fetchLimit` and a
 *         calibrated twin scoring below the edge
 *
 * Real LanceDB in `mkdtemp`; no Indexer, HOME, embed cache or lock involved.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { branchScope } from "../../../src/core/branch-scope.js";
import type { OverlayCandidates } from "../../../src/core/overlay/types.js";
import {
	createVectorStore,
	type IVectorStore,
	mergeRetrieverLists,
	retrieverEdge,
	searchFetchLimit,
} from "../../../src/core/store.js";
import type { SearchResult } from "../../../src/types.js";
import {
	chunk,
	doc,
	hexId,
	overlayCandidatesFrom,
	type ServedFile,
	vec,
} from "../../helpers/store-search-fixture.js";

const B1 = branchScope(1);
const REPO1 = { pathKind: "repo" as const, branchId: 1 };

// ============================================================================
// MG-1 / MG-2 — pure
// ============================================================================

type Row = { id: string; _distance?: number; _score?: number };

const ids = (rows: readonly Row[]) => rows.map((r) => r.id);

describe("MG-1 — mergeRetrieverLists admits an overlay row only strictly past the index edge", () => {
	// fetched = 6; the engine filled the index list and its last two rows
	// tied at E = 0.5, so the trim left `fetched - 2` rows.
	const E = 0.5;
	const EPS = 0.01;
	const index: Row[] = [
		{ id: "i1", _distance: 0.1 },
		{ id: "i2", _distance: 0.2 },
		{ id: "i3", _distance: 0.3 },
		{ id: "i4", _distance: 0.4 },
	];
	const cut = { fetched: 6, keepAtLeast: 2 };
	const better: Row = { id: "o-better", _distance: E - EPS };
	const atEdge: Row = { id: "o-edge", _distance: E };
	const worse: Row = { id: "o-worse", _distance: E + EPS };

	test("_distance: E-ε is admitted at the position its score dictates; E and E+ε are not", () => {
		expect(
			ids(
				mergeRetrieverLists(index, [better], "_distance", {
					...cut,
					indexEdge: E,
				}),
			),
		).toEqual(["i1", "i2", "i3", "i4", "o-better"]);
		// The shipped body put each of these into a freed slot.
		for (const row of [atEdge, worse]) {
			expect(
				ids(
					mergeRetrieverLists(index, [row], "_distance", {
						...cut,
						indexEdge: E,
					}),
				),
			).toEqual(["i1", "i2", "i3", "i4"]);
		}
		// All three at once: still only E-ε.
		expect(
			ids(
				mergeRetrieverLists(index, [worse, atEdge, better], "_distance", {
					...cut,
					indexEdge: E,
				}),
			),
		).toEqual(["i1", "i2", "i3", "i4", "o-better"]);
		// A strictly-better row that beats index rows takes its rank.
		expect(
			ids(
				mergeRetrieverLists(
					index,
					[{ id: "o-top", _distance: 0.15 }],
					"_distance",
					{ ...cut, indexEdge: E },
				),
			),
		).toEqual(["i1", "o-top", "i2", "i3", "i4"]);
	});

	test("_distance: indexEdge null (a short, complete index list) — all three compete", () => {
		for (const row of [better, atEdge, worse]) {
			expect(
				ids(
					mergeRetrieverLists(index, [row], "_distance", {
						...cut,
						indexEdge: null,
					}),
				),
			).toEqual(["i1", "i2", "i3", "i4", row.id]);
		}
	});

	test("_score: the same three cases, direction flipped (larger is better)", () => {
		const sIndex: Row[] = [
			{ id: "i1", _score: 9 },
			{ id: "i2", _score: 8 },
			{ id: "i3", _score: 7 },
			{ id: "i4", _score: 6 },
		];
		const SE = 5;
		const sBetter: Row = { id: "o-better", _score: SE + EPS };
		const sAt: Row = { id: "o-edge", _score: SE };
		const sWorse: Row = { id: "o-worse", _score: SE - EPS };
		expect(
			ids(
				mergeRetrieverLists(sIndex, [sBetter], "_score", {
					...cut,
					indexEdge: SE,
				}),
			),
		).toEqual(["i1", "i2", "i3", "i4", "o-better"]);
		for (const row of [sAt, sWorse]) {
			expect(
				ids(
					mergeRetrieverLists(sIndex, [row], "_score", {
						...cut,
						indexEdge: SE,
					}),
				),
			).toEqual(["i1", "i2", "i3", "i4"]);
		}
		for (const row of [sBetter, sAt, sWorse]) {
			expect(
				ids(
					mergeRetrieverLists(sIndex, [row], "_score", {
						...cut,
						indexEdge: null,
					}),
				),
			).toEqual(["i1", "i2", "i3", "i4", row.id]);
		}
	});

	test("a non-finite edge admits NO overlay row (fails toward the index-only ranking)", () => {
		for (const edge of [Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(
				ids(
					mergeRetrieverLists(
						index,
						[{ id: "o-top", _distance: 0.01 }, better],
						"_distance",
						{ ...cut, indexEdge: edge },
					),
				),
			).toEqual(["i1", "i2", "i3", "i4"]);
		}
	});

	test("the index rows are never gated: only the cut and the trim remove them", () => {
		// Two overlay rows better than everything fill the list to `fetched`;
		// the merged list is then trimmed of its own last group (i4), exactly
		// as ONE engine list over the union would be. The gate removed nothing.
		const overlay: Row[] = [
			{ id: "o1", _distance: 0.01 },
			{ id: "o2", _distance: 0.02 },
		];
		expect(
			ids(
				mergeRetrieverLists(index, overlay, "_distance", {
					...cut,
					indexEdge: E,
				}),
			),
		).toEqual(["o1", "o2", "i1", "i2", "i3"]);
		// One overlay row: short of `fetched`, so every index row stays.
		expect(
			ids(
				mergeRetrieverLists(index, [overlay[0]], "_distance", {
					...cut,
					indexEdge: E,
				}),
			),
		).toEqual(["o1", "i1", "i2", "i3", "i4"]);
	});
});

describe("MG-2 — retrieverEdge", () => {
	test("a full list gives the score of row `fetched - 1`", () => {
		const rows = [
			{ id: "a", _distance: 0.1 },
			{ id: "b", _distance: 0.3 },
			{ id: "c", _distance: 0.3 },
		];
		expect(retrieverEdge(rows, "_distance", 3)).toBe(0.3);
		expect(
			retrieverEdge(
				[
					{ id: "a", _score: 4 },
					{ id: "b", _score: 2 },
				],
				"_score",
				2,
			),
		).toBe(2);
	});

	test("a short list (complete) gives null; so does an empty one", () => {
		expect(retrieverEdge([{ id: "a", _distance: 0.1 }], "_distance", 3)).toBe(
			null,
		);
		expect(retrieverEdge([], "_score", 3)).toBe(null);
	});

	test("a full list with a non-finite score gives NaN", () => {
		const rows = [
			{ id: "a", _distance: 0.1 },
			{ id: "b", _distance: Number.NaN },
		];
		expect(retrieverEdge(rows, "_distance", 2)).toBeNaN();
		expect(
			retrieverEdge([{ id: "a" }, { id: "b", _score: 1 }], "_score", 2),
		).toBeNaN();
	});
});

// ============================================================================
// MG-3 / MG-4 — store level, real LanceDB
// ============================================================================

let dir: string;
let index: IVectorStore;
let overlayStore: IVectorStore;

beforeEach(async () => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "mnemex-ovgate-")));
	index = createVectorStore({
		vectorsDir: join(dir, "vectors"),
		pathRoot: dir,
	});
	await index.initialize();
	overlayStore = createVectorStore({
		vectorsDir: join(dir, "dirty-overlay", "vectors"),
		pathRoot: dir,
		role: "overlay",
	});
	await overlayStore.initialize();
});

afterEach(async () => {
	await index.close();
	await overlayStore.close();
	rmSync(dir, { recursive: true, force: true });
});

async function candidates(
	queryVector: number[],
	files: ServedFile[],
	limit: number,
): Promise<OverlayCandidates> {
	return overlayCandidatesFrom({
		overlayStore,
		queryVector,
		served: files,
		search: { limit },
	});
}

const at = (results: SearchResult[], id: string) =>
	results.findIndex((r) => r.chunk.id === id);

/**
 * Twin-position oracle: an unchanged overlay chunk (same lines, same text,
 * hence the same id as its index twin) sits exactly where its twin sat in an
 * overlay-free search of the same store at the same `limit` — or both are
 * absent.
 */
function expectTwinPositions(
	clean: SearchResult[],
	withOverlay: SearchResult[],
	unchangedIds: string[],
): void {
	for (const id of unchangedIds) {
		expect({ id, at: at(withOverlay, id) }).toEqual({ id, at: at(clean, id) });
		const row = withOverlay[at(withOverlay, id)];
		if (row !== undefined) expect(row.source).toBe("dirty");
	}
}

/** Hidden-from-results filler: summaries are fused, then separated out. */
function summary(label: string, near: number, content: string) {
	return doc({
		id: hexId(`summary:${label}`),
		content,
		documentType: "symbol_summary",
		filePath: `src/summaries/${label}.ts`,
		sourceIds: [],
		vector: vec(near),
	});
}

describe("MG-3 — vector channel, the q7 shape: a far unchanged overlay chunk cannot take a slot the tie-tail trim freed", () => {
	// limit 3 -> fetchLimit 9. With the served file suppressed, the index's
	// vector list is:
	//   1-5  summaries (fused, then separated out of the results)
	//   6    `strong`                      (a visible index chunk)
	//   7-10 `tie1..tie4` at ONE distance  (a tie group straddling rank 9)
	// The engine fills 9, the trim drops ranks 7-9: the list is 6 long, 3
	// slots short of `fetchLimit`. The served file holds `good` (near 7.5,
	// better than the edge) and `far` (near 100, ~1 000x past it).
	const LIMIT = 3;
	const PATH = "src/edited.ts";
	const good = chunk({
		path: PATH,
		label: "good",
		near: 7.5,
		name: "goodMatch",
		content: "function goodMatch() { return near; }",
		startLine: 1,
		endLine: 5,
	});
	const far = chunk({
		path: PATH,
		label: "far",
		near: 100,
		name: "farAway",
		content: "function farAway() { return distant; }",
		startLine: 10,
		endLine: 20,
	});

	async function seedIndex(): Promise<{ strong: string; ties: string[] }> {
		await index.addDocuments(
			[2, 3, 4, 5, 6].map((n) =>
				summary(`s${n}`, n, `summary text number ${n}`),
			),
			REPO1,
		);
		const strong = chunk({
			path: "src/strong.ts",
			label: "strong",
			near: 8,
			name: "strong",
			content: "function strong() { return 1; }",
		});
		const ties = [1, 2, 3, 4].map((i) =>
			chunk({
				path: `src/tie${i}.ts`,
				label: `tie${i}`,
				near: 9, // bit-identical vectors -> bit-identical distances
				name: `tie${i}`,
				content: `function tie${i}() { return ${i}; }`,
			}),
		);
		await index.addChunks([strong, ...ties, good, far], REPO1);
		return { strong: strong.id, ties: ties.map((t) => t.id) };
	}

	test("the trimmed index list is shorter than fetchLimit (the precondition)", async () => {
		await seedIndex();
		const fetchLimit = searchFetchLimit(LIMIT);
		const engine = await overlayStore.vectorCandidates(vec(1), [], {});
		expect(engine).toEqual([]); // the overlay store is empty until served
		const clean = await index.search("zzqqnomatch", vec(1), B1, {
			limit: fetchLimit,
		});
		// Every code row is reachable at depth 27; the ties are bit-identical.
		const tieScores = new Set(
			clean
				.filter((r) => r.chunk.name?.startsWith("tie"))
				.map((r) => r.vectorScore),
		);
		expect(tieScores.size).toBe(4); // distinct RANKS, identical distances
	});

	test("the far chunk is absent; the strictly-better one sits at its twin's clean position", async () => {
		const { strong, ties } = await seedIndex();
		const clean = await index.search("zzqqnomatch", vec(1), B1, {
			limit: LIMIT,
		});
		// Clean: good (vector rank 6), strong (7); the ties are trimmed.
		expect(clean.map((r) => r.chunk.id)).toEqual([good.id, strong]);

		const overlay = await candidates(
			vec(1),
			[{ path: PATH, chunks: [good, far] }],
			LIMIT,
		);
		// The overlay's own list does reach the far row (it is the query's
		// concern, not the overlay read's, to keep it out).
		expect(overlay.vector.map((r) => r.id)).toContain(far.id);

		const withOverlay = await index.search(
			"zzqqnomatch",
			vec(1),
			B1,
			{ limit: LIMIT },
			overlay,
		);
		// RED on the ungated merge: [good, strong, far] — `far` took vector
		// rank 8, a slot the trim freed.
		expect(at(withOverlay, far.id)).toBe(-1);
		expect(withOverlay.map((r) => r.chunk.id)).toEqual([good.id, strong]);
		expect(withOverlay[0].source).toBe("dirty");
		expect(withOverlay.some((r) => ties.includes(r.chunk.id))).toBe(false);
		expectTwinPositions(clean, withOverlay, [good.id, far.id]);
	});
});

describe("MG-4 — BM25 channel: a calibrated twin scoring below the FTS edge is not admitted", () => {
	// keyword-only, limit 3 -> fetchLimit 9. BM25 over one term, tf = 1:
	// score falls with document length, and equal lengths tie exactly.
	//   1-5  summaries, lengths 1..5 tokens past the keyword (hidden)
	//   6    `good` twin (served file),   6 more tokens
	//   7    `strong`,                     7 more tokens
	//   8-11 `tie1..tie4`,                 8 more tokens each (one score)
	//   far  `far` twin (served file),    40 more tokens
	// With the served file suppressed the engine fills 9 (5 + strong + 3
	// ties), the trim drops the ties: 6 rows, 3 slots short.
	const LIMIT = 3;
	const PATH = "src/edited.ts";
	const WORDS = [
		"apple",
		"birch",
		"cedar",
		"delta",
		"ember",
		"fable",
		"grove",
		"heron",
		"inlet",
		"jolly",
	];
	const padded = (n: number, salt: string) =>
		[
			"lockword",
			...Array.from({ length: n }, (_, i) => `${WORDS[i % 10]}${salt}`),
		].join(" ");
	const good = chunk({
		path: PATH,
		label: "good",
		near: 50,
		content: padded(6, "g"),
		startLine: 1,
		endLine: 5,
	});
	const far = chunk({
		path: PATH,
		label: "far",
		near: 51,
		content: padded(40, "f"),
		startLine: 10,
		endLine: 50,
	});

	async function seedIndex(): Promise<{ strong: string; ties: string[] }> {
		await index.addDocuments(
			[1, 2, 3, 4, 5].map((n) => summary(`k${n}`, 60 + n, padded(n, `s${n}`))),
			REPO1,
		);
		const strong = chunk({
			path: "src/strong.ts",
			label: "strong",
			near: 70,
			content: padded(7, "st"),
		});
		const ties = [1, 2, 3, 4].map((i) =>
			chunk({
				path: `src/tie${i}.ts`,
				label: `tie${i}`,
				near: 80 + i,
				content: padded(8, `t${i}`),
			}),
		);
		await index.addChunks([strong, ...ties, good, far], REPO1);
		return { strong: strong.id, ties: ties.map((t) => t.id) };
	}

	test("the far twin is absent; the strictly-better twin keeps its clean position", async () => {
		const { strong, ties } = await seedIndex();
		const opts = { limit: LIMIT, keywordOnly: true };
		const clean = await index.search("lockword", vec(1), B1, opts);
		// Clean: good (BM25 rank 6), strong (7); the ties are trimmed.
		expect(clean.map((r) => r.chunk.id)).toEqual([good.id, strong]);
		// Precondition: the four ties really tie.
		const deep = await index.search("lockword", vec(1), B1, {
			limit: 30,
			keywordOnly: true,
		});
		const tieRows = deep.filter((r) => ties.includes(r.chunk.id));
		expect(tieRows.length).toBe(4);
		expect(new Set(tieRows.map((r) => r.score)).size).toBe(4); // rank-only
		const farDeep = deep[at(deep, far.id)];
		expect(farDeep).toBeDefined();

		const overlay = await candidates(
			vec(1),
			[{ path: PATH, chunks: [good, far] }],
			LIMIT,
		);
		const withOverlay = await index.search(
			"lockword",
			vec(1),
			B1,
			opts,
			overlay,
		);
		// RED on the ungated merge: [good, strong, far] — the calibrated
		// `far` twin took BM25 rank 8, a slot the trim freed.
		expect(at(withOverlay, far.id)).toBe(-1);
		expect(withOverlay.map((r) => r.chunk.id)).toEqual([good.id, strong]);
		expect(withOverlay[0].source).toBe("dirty");
		expect(withOverlay[0].keywordScore).toBe(clean[0].keywordScore);
		expectTwinPositions(clean, withOverlay, [good.id, far.id]);
	});

	/**
	 * MG-5 (outer review 2, LOW 5). The MAIN FTS query throws and the
	 * calibration query after it succeeds (a transient error between the two).
	 * A channel that failed is not a complete list: its edge must admit NO
	 * calibrated twin, failing toward the index-only ranking. Shipped: the
	 * catch recorded `null` — "short, hence complete" — so every twin was
	 * admitted into an empty BM25 channel and the overlay owned it.
	 */
	test("MG-5: the main FTS query threw — no calibrated twin is admitted", async () => {
		await seedIndex();
		const opts = { limit: LIMIT, keywordOnly: true };
		const clean = await index.search("lockword", vec(1), B1, opts);
		expect(clean.length).toBeGreaterThan(0); // the table is open, FTS works
		const overlay = await candidates(
			vec(1),
			[{ path: PATH, chunks: [good, far] }],
			LIMIT,
		);

		// Fail the FIRST full-text query of the next search only.
		type Q = {
			fullTextSearch: (...a: unknown[]) => Q;
			toArray: () => Promise<unknown[]>;
		};
		const table = (index as unknown as { table: { query: () => Q } }).table;
		const realQuery = table.query.bind(table);
		let ftsQueries = 0;
		let threw = false;
		table.query = () => {
			const q = realQuery();
			const realFts = q.fullTextSearch.bind(q);
			q.fullTextSearch = (...a: unknown[]) => {
				ftsQueries++;
				if (ftsQueries === 1) {
					q.toArray = async () => {
						threw = true;
						throw new Error("transient FTS failure");
					};
				}
				return realFts(...a);
			};
			return q;
		};
		try {
			const withOverlay = await index.search(
				"lockword",
				vec(1),
				B1,
				opts,
				overlay,
			);
			expect(threw).toBe(true);
			expect(ftsQueries).toBeGreaterThanOrEqual(2); // calibration ran
			// Shipped: [good] (or [good, far]) as `source: "dirty"`.
			expect(withOverlay.filter((r) => r.source === "dirty")).toEqual([]);
			expect(at(withOverlay, good.id)).toBe(-1);
			expect(at(withOverlay, far.id)).toBe(-1);
		} finally {
			table.query = realQuery;
		}
	});
});
