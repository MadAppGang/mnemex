/**
 * Step 3, phase 5 — the candidate-level merge (R3.2), store level.
 *
 * The overlay's rows enter `VectorStore.search` as CANDIDATES, merged into the
 * index's own retriever lists BEFORE `typeAwareRRFFusion`, so an overlay row is
 * ranked by exactly the fusion an index row is (D-MERGE, `step3-scope.md`
 * §2.3: the cloud merger's per-list min-max put 34 dirty chunks in 57.5 % of
 * the top 10).
 *
 *   M-1    an unrelated overlay chunk ranks below a strong index chunk (A)
 *   M-2    identical text, identical vector -> identical `_distance` in the
 *          index and the overlay store (flat L2 on both sides)
 *   M-3    an UNCHANGED chunk of an edited file keeps its BM25 credit: the
 *          same `keywordScore` (= the same BM25 rank) its index twin had (A)
 *   M-4    a planted new function reaches the top `limit` as `source: "dirty"`
 *          (store level; reachability through `searchScoped` is phase 6)
 *   N-1    an overlay holding nothing (clean / all-index-current) is
 *          deep-equal to no overlay: same statements, same results (A)
 *   BR-1   the calibrated BM25 query carries the branch predicate: another
 *          branch's twin never lends a row its score (A)
 *   DUP-1  one BM25 entry per overlay id when several index rows share one
 *          `(path, contentHash)`; the fused score equals the single-row case (A)
 *   CAL-1  non-twin rows of a served path cannot push the twins past the
 *          calibrated query's limit (A)
 *   HYD    overlay rows hydrate from their materialised candidate: absolute
 *          output path, `source: "dirty"`, no `branchIds`, no summary
 *
 * Real LanceDB in `mkdtemp`; no Indexer, HOME, embed cache or lock involved.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type BranchScope,
	branchScope,
	SCOPE_ALL,
} from "../../../src/core/branch-scope.js";
import type { OverlayCandidates } from "../../../src/core/overlay/types.js";
import {
	createVectorStore,
	type IVectorStore,
	mergeRetrieverLists,
	pairCalibratedTwins,
} from "../../../src/core/store.js";
import type { SearchResult } from "../../../src/types.js";
import {
	chunk,
	doc,
	emptyOverlayCandidates,
	hexId,
	normaliseRoot,
	overlayCandidatesFrom,
	recordTableCalls,
	type ServedFile,
	unit,
	vec,
} from "../../helpers/store-search-fixture.js";

const B1 = branchScope(1);
const REPO1 = { pathKind: "repo" as const, branchId: 1 };
const REPO2 = { pathKind: "repo" as const, branchId: 2 };

let dir: string;
let index: IVectorStore;
let overlayStore: IVectorStore;

beforeEach(async () => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "mnemex-ovmerge-")));
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

function served(path: string, chunks: ServedFile["chunks"]): ServedFile {
	return { path, chunks };
}

async function candidates(
	queryVector: number[],
	files: ServedFile[],
	deleted: string[] = [],
	limit?: number,
): Promise<OverlayCandidates> {
	return overlayCandidatesFrom({
		overlayStore,
		queryVector,
		served: files,
		deleted,
		search: limit === undefined ? {} : { limit },
	});
}

const dirty = (r: SearchResult) => r.source === "dirty";
const at = (results: SearchResult[], id: string) =>
	results.findIndex((r) => r.chunk.id === id);

/** Filler rows in other files, at increasing distance and no shared keyword. */
async function seedFiller(count: number, scope = REPO1): Promise<void> {
	await index.addChunks(
		Array.from({ length: count }, (_, i) =>
			chunk({
				path: `src/filler${i}.ts`,
				label: `filler${i}`,
				near: 2 + i,
				name: `filler${i}`,
				content: `function filler${i}() { return ${i}; }`,
			}),
		),
		scope,
	);
}

describe("M-1 — a poor overlay match ranks as poorly as a poor index match", () => {
	test("an unrelated overlay chunk ranks below the strong index chunk and every nearer index row (A)", async () => {
		const strong = chunk({
			path: "src/strong.ts",
			label: "strong",
			near: 1.05,
			name: "computeTax",
			content: "function computeTax() { return rate; }",
		});
		await index.addChunks([strong], REPO1);
		await seedFiller(4); // near 2, 3, 4, 5
		const unrelated = chunk({
			path: "src/edited.ts",
			label: "unrelated",
			near: 20,
			name: "unrelatedBanner",
			content: "function unrelatedBanner() { return colours; }",
		});
		const overlay = await candidates(vec(1), [
			served("src/edited.ts", [unrelated]),
		]);

		// No keyword hit anywhere: the vector channel alone decides.
		const results = await index.search(
			"zzqqxx",
			vec(1),
			B1,
			{ limit: 10 },
			overlay,
		);
		expect(results[0].chunk.id).toBe(strong.id);
		const u = at(results, unrelated.id);
		expect(u).toBe(results.length - 1);
		expect(u).toBe(5); // strong + 4 fillers, all nearer, rank above it
		expect(results[u].source).toBe("dirty");
		expect(results[u].score).toBeLessThan(results[0].score);
	});
});

describe("M-2 — the two stores measure distance identically", () => {
	test("the same vector in the index and the overlay gives a bit-identical `_distance`", async () => {
		const same = chunk({
			path: "src/same.ts",
			label: "same",
			near: 1.7,
			name: "same",
			content: "function same() { return 1; }",
		});
		await index.addChunks([same], REPO1);
		await overlayStore.addChunks([same], { pathKind: "repo", branchId: 0 });
		for (const q of [vec(1), vec(3), vec(0.4)]) {
			const [i] = await index.vectorCandidates(q, [same.id], {});
			const [o] = await overlayStore.vectorCandidates(q, [same.id], {});
			expect(o._distance).toBe(i._distance);
			expect(o._distance).toBeGreaterThan(0);
		}
	});
});

describe("M-3 — an unchanged chunk keeps its twin's BM25 rank", () => {
	test("same keywordScore as the index twin, > 0, on the overlay's own (moved) lines (A)", async () => {
		const keep = "function alphaKeyword() { return zebraword; }";
		const c1 = chunk({
			path: "src/edit.ts",
			label: "c1",
			near: 4,
			name: "alphaKeyword",
			content: keep,
			startLine: 1,
			endLine: 5,
		});
		const c2 = chunk({
			path: "src/edit.ts",
			label: "c2",
			near: 5,
			name: "oldBody",
			content: "function oldBody() { return other; }",
			startLine: 7,
			endLine: 12,
		});
		const f1 = chunk({
			path: "src/f1.ts",
			label: "f1",
			near: 6,
			name: "z1",
			content: "zebraword zebraword zebraword helper",
		});
		const f2 = chunk({
			path: "src/f2.ts",
			label: "f2",
			near: 7,
			name: "z2",
			content: "function z2() { zebraword(); more(); text(); here(); }",
		});
		await index.addChunks([c1, c2, f1, f2], REPO1);

		const before = await index.search("zebraword", vec(1), B1, { limit: 10 });
		const twinBefore = before[at(before, c1.id)];
		expect(twinBefore.keywordScore).toBeGreaterThan(0);

		// One line inserted above: c1's text unchanged at 3-7, c2 rewritten.
		const c1Moved = chunk({
			path: "src/edit.ts",
			label: "c1m",
			near: 4,
			name: "alphaKeyword",
			content: keep,
			startLine: 3,
			endLine: 7,
		});
		const c2New = chunk({
			path: "src/edit.ts",
			label: "c2n",
			near: 5,
			name: "newBody",
			content: "function newBody() { return changed; }",
			startLine: 9,
			endLine: 15,
		});
		expect(c1Moved.contentHash).toBe(c1.contentHash);
		const overlay = await candidates(vec(1), [
			served("src/edit.ts", [c1Moved, c2New]),
		]);

		const after = await index.search(
			"zebraword",
			vec(1),
			B1,
			{ limit: 10 },
			overlay,
		);
		const twin = after[at(after, c1Moved.id)];
		expect(twin).toBeDefined();
		expect(twin.source).toBe("dirty");
		expect([twin.chunk.startLine, twin.chunk.endLine]).toEqual([3, 7]);
		expect(twin.keywordScore).toBeGreaterThan(0);
		expect(twin.keywordScore).toBe(twinBefore.keywordScore);
		// The stale index rows of the edited file are gone.
		expect(
			after.some((r) => r.chunk.id === c1.id || r.chunk.id === c2.id),
		).toBe(false);
		// The rewritten chunk has no index twin: vector-only (ruling 4).
		const changed = after[at(after, c2New.id)];
		expect(changed.keywordScore).toBe(0);
	});
});

describe("M-4 — a planted new function reaches the top `limit` (store level)", () => {
	test('in the top 5, marked `source: "dirty"` (A)', async () => {
		await seedFiller(8);
		const planted = chunk({
			path: "src/new-feature.ts",
			label: "planted",
			near: 1.01,
			name: "plantedNewFeature",
			content: "export function plantedNewFeature() { return 42; }",
		});
		const overlay = await candidates(vec(1), [
			served("src/new-feature.ts", [planted]),
		]);
		const withOverlay = await index.search(
			"plantedNewFeature",
			vec(1),
			B1,
			{ limit: 5 },
			overlay,
		);
		expect(withOverlay.length).toBe(5);
		expect(withOverlay[0].chunk.id).toBe(planted.id);
		expect(withOverlay[0].source).toBe("dirty");
		expect(withOverlay[0].chunk.filePath).toBe(join(dir, "src/new-feature.ts"));
		const without = await index.search("plantedNewFeature", vec(1), B1, {
			limit: 5,
		});
		expect(at(without, planted.id)).toBe(-1);
	});
});

describe("N-1 — an overlay that holds nothing changes nothing", () => {
	test("empty candidates: identical statements AND identical results to no overlay (A)", async () => {
		await seedFiller(6);
		await index.addChunks(
			[
				chunk({
					path: "src/kw.ts",
					label: "kw",
					near: 2.5,
					name: "kw",
					content: "function kw() { filler3(); }",
				}),
			],
			REPO1,
		);
		const log = await recordTableCalls(index);
		const run = async (overlay?: OverlayCandidates) => {
			log.length = 0;
			const results = await index.search(
				"filler3",
				vec(1),
				B1,
				{ limit: 4 },
				overlay,
			);
			return normaliseRoot({ statements: [...log], results }, dir);
		};
		await run(); // the FTS build happens once, outside the comparison
		const plain = await run();
		const empty = await run(emptyOverlayCandidates());
		expect(plain.results.length).toBe(4);
		expect(empty).toEqual(plain);
	});
});

describe("BR-1 — the calibrated BM25 query is branch-scoped", () => {
	test("a twin held only by ANOTHER branch lends no BM25 credit; lines are this worktree's (A)", async () => {
		const text = "function sharedName() { return quokkaword; }";
		// Branch 2 holds the text in src/br.ts; branch 1's src/br.ts does not.
		await index.addChunks(
			[
				chunk({
					path: "src/br.ts",
					label: "b2",
					near: 9,
					name: "sharedName",
					content: text,
					startLine: 40,
					endLine: 44,
				}),
			],
			REPO2,
		);
		await index.addChunks(
			[
				chunk({
					path: "src/br.ts",
					label: "b1",
					near: 9,
					name: "old",
					content: "function old() { return 0; }",
				}),
			],
			REPO1,
		);
		await seedFiller(3);
		const added = chunk({
			path: "src/br.ts",
			label: "ov",
			near: 9,
			name: "sharedName",
			content: text,
			startLine: 2,
			endLine: 6,
		});
		const overlay = await candidates(vec(1), [served("src/br.ts", [added])]);

		const results = await index.search(
			"quokkaword",
			vec(1),
			B1,
			{ limit: 10 },
			overlay,
		);
		const row = results[at(results, added.id)];
		expect(row).toBeDefined();
		expect(row.source).toBe("dirty");
		expect(row.keywordScore).toBe(0);
		expect([row.chunk.startLine, row.chunk.endLine]).toEqual([2, 6]);
		expect(results.some((r) => r.chunk.startLine === 40)).toBe(false);
	});
});

describe("DUP-1 — one BM25 entry per overlay id", () => {
	/**
	 * Two stores answer the same query: one whose served file holds the twin
	 * ONCE, one where the index holds it twice (identical chunks in one file).
	 * A top row that wins both channels in both stores pins the normaliser, so
	 * `score` is the fused score on one scale.
	 */
	async function fusedScoreOfTwin(
		indexRows: number,
		scope: BranchScope,
		branchRows: { branch: typeof REPO1; startLine: number }[],
	): Promise<{ score: number; keywordScore: number; count: number }> {
		const text = "function dupTwin() { return lemurword; }";
		const top = chunk({
			path: "src/top.ts",
			label: "top",
			near: 1.01,
			name: "top",
			content: "lemurword lemurword lemurword lemurword top",
		});
		await index.addChunks([top], REPO1);
		for (const { branch, startLine } of branchRows.slice(0, indexRows)) {
			await index.addChunks(
				[
					chunk({
						path: "src/dup.ts",
						label: `dup${startLine}`,
						near: 3,
						name: "dupTwin",
						content: text,
						startLine,
						endLine: startLine + 4,
					}),
				],
				branch,
			);
		}
		await seedFiller(3);
		const twin = chunk({
			path: "src/dup.ts",
			label: "ov",
			near: 3,
			name: "dupTwin",
			content: text,
			startLine: 1,
			endLine: 5,
		});
		const overlay = await candidates(vec(1), [served("src/dup.ts", [twin])]);
		const results = await index.search(
			"lemurword",
			vec(1),
			scope,
			{ limit: 10 },
			overlay,
		);
		expect(results[0].chunk.id).toBe(top.id);
		const hits = results.filter((r) => r.chunk.id === twin.id);
		return {
			score: hits[0].score,
			keywordScore: hits[0].keywordScore,
			count: hits.length,
		};
	}

	test("identical chunks twice in one file: fused score equals the single-row case (A)", async () => {
		const single = await fusedScoreOfTwin(1, B1, [
			{ branch: REPO1, startLine: 1 },
		]);
		await index.close();
		rmSync(join(dir, "vectors"), { recursive: true, force: true });
		await overlayStore.close();
		rmSync(join(dir, "dirty-overlay"), { recursive: true, force: true });
		index = createVectorStore({
			vectorsDir: join(dir, "vectors"),
			pathRoot: dir,
		});
		overlayStore = createVectorStore({
			vectorsDir: join(dir, "dirty-overlay", "vectors"),
			pathRoot: dir,
			role: "overlay",
		});
		await index.initialize();
		await overlayStore.initialize();
		const double = await fusedScoreOfTwin(2, B1, [
			{ branch: REPO1, startLine: 1 },
			{ branch: REPO1, startLine: 20 },
		]);
		expect(single.keywordScore).toBeGreaterThan(0);
		expect(double.count).toBe(1);
		expect(double.keywordScore).toBe(single.keywordScore);
		expect(double.score).toBe(single.score);
	});

	test("SCOPE_ALL, two branches each holding the twin: still one entry, same fused score (A)", async () => {
		const single = await fusedScoreOfTwin(1, SCOPE_ALL, [
			{ branch: REPO1, startLine: 1 },
		]);
		await index.close();
		rmSync(join(dir, "vectors"), { recursive: true, force: true });
		await overlayStore.close();
		rmSync(join(dir, "dirty-overlay"), { recursive: true, force: true });
		index = createVectorStore({
			vectorsDir: join(dir, "vectors"),
			pathRoot: dir,
		});
		overlayStore = createVectorStore({
			vectorsDir: join(dir, "dirty-overlay", "vectors"),
			pathRoot: dir,
			role: "overlay",
		});
		await index.initialize();
		await overlayStore.initialize();
		const double = await fusedScoreOfTwin(2, SCOPE_ALL, [
			{ branch: REPO1, startLine: 1 },
			{ branch: REPO2, startLine: 3 },
		]);
		expect(double.count).toBe(1);
		expect(double.keywordScore).toBe(single.keywordScore);
		expect(double.score).toBe(single.score);
	});
});

describe("CAL-1 — the calibrated query's limit applies to twins only", () => {
	test("60 strong non-twin rows of the served path cannot push the weak twin out (A)", async () => {
		const twinText = "function weakTwin() { return okapiword; }";
		const twin = chunk({
			path: "src/big.ts",
			label: "twin",
			near: 30,
			name: "weakTwin",
			content: twinText,
			startLine: 1000,
			endLine: 1004,
		});
		const strong = Array.from({ length: 60 }, (_, i) =>
			chunk({
				path: "src/big.ts",
				label: `s${i}`,
				near: 40 + i,
				name: `s${i}`,
				startLine: 1 + i * 10,
				endLine: 5 + i * 10,
				content: `okapiword okapiword okapiword okapiword okapiword s${i}`,
			}),
		);
		await index.addChunks([twin, ...strong], REPO1);
		// The overlay changed every strong chunk and kept the twin.
		const kept = chunk({
			path: "src/big.ts",
			label: "kept",
			near: 30,
			name: "weakTwin",
			content: twinText,
			startLine: 1000,
			endLine: 1004,
		});
		const rewritten = strong.map((s, i) =>
			chunk({
				path: "src/big.ts",
				label: `r${i}`,
				near: 40 + i,
				name: `r${i}`,
				startLine: s.startLine,
				endLine: s.endLine,
				content: `function r${i}() { return ${i}; }`,
			}),
		);
		const overlay = await candidates(
			vec(1),
			[served("src/big.ts", [kept, ...rewritten])],
			[],
			1,
		);

		const results = await index.search(
			"okapiword",
			vec(1),
			B1,
			{ limit: 1 },
			overlay,
		);
		expect(results.length).toBe(1);
		expect(results[0].chunk.id).toBe(kept.id);
		expect(results[0].keywordScore).toBeGreaterThan(0);
	});
});

describe("HYD — overlay rows hydrate from their materialised candidate", () => {
	test("absolute path, source dirty, no branchIds, no summary — even with an index summary naming its id", async () => {
		const text = "function hydrated() { return ibexword; }";
		const indexed = chunk({
			path: "src/hyd.ts",
			label: "i",
			near: 2,
			name: "hydrated",
			content: text,
		});
		await index.addChunks([indexed], REPO1);
		await seedFiller(2);
		// A symbol summary in ANOTHER file whose sourceIds name the chunk id
		// the overlay will reuse (an unchanged chunk at unchanged lines keeps
		// its id). Not suppressed by path, so only the hydration rule stops it.
		await index.addDocuments(
			[
				doc({
					id: hexId("sum-elsewhere"),
					content: "summary: ibexword summary text",
					documentType: "symbol_summary",
					filePath: "src/other.ts",
					sourceIds: [indexed.id],
					vector: vec(2.1),
				}),
			],
			REPO1,
		);
		const same = chunk({
			path: "src/hyd.ts",
			label: "o",
			near: 2,
			name: "hydrated",
			content: text,
		});
		expect(same.id).toBe(indexed.id);
		const overlay = await candidates(vec(1), [served("src/hyd.ts", [same])]);
		const results = await index.search(
			"ibexword",
			vec(1),
			B1,
			{ limit: 5 },
			overlay,
		);
		const row = results[at(results, same.id)];
		expect(row.source).toBe("dirty");
		expect(row.chunk.filePath).toBe(join(dir, "src/hyd.ts"));
		expect(row.chunk.name).toBe("hydrated");
		expect(row.chunk.content).toBe(text);
		expect("branchIds" in row).toBe(false);
		expect(row.summary).toBeUndefined();
		expect(row.fileSummary).toBeUndefined();
		// Index rows still carry their branch attribution, and no source.
		expect(results.filter((r) => !dirty(r)).length).toBeGreaterThan(0);
		expect(
			results
				.filter((r) => !dirty(r))
				.every((r) => Array.isArray(r.branchIds) && r.source === undefined),
		).toBe(true);
	});

	test("R2 across index + overlay rows: index twins still collapse with identity carried; overlay rows take nothing", async () => {
		// Index: a nameless gap chunk + named unit at one span (R2-A).
		const gap = chunk({
			path: "src/gap.ts",
			label: "gap",
			near: 1.5,
			chunkType: "module",
			content: "export\nfunction tinyGap() { yakword(); }",
			startLine: 3,
			endLine: 5,
		});
		await index.addChunks([gap], REPO1);
		await index.addCodeUnits(
			[
				unit({
					path: "src/gap.ts",
					label: "u",
					near: 1.6,
					name: "tinyGap",
					startLine: 3,
					endLine: 5,
					content: "function tinyGap() { yakword(); }",
				}),
			],
			REPO1,
		);
		// Overlay: a nameless chunk in its own file.
		const ovGap = chunk({
			path: "src/ovgap.ts",
			label: "ovgap",
			near: 1.4,
			chunkType: "module",
			content: "export\nfunction ovGap() { yakword(); }",
			startLine: 1,
			endLine: 3,
		});
		const overlay = await candidates(vec(1), [served("src/ovgap.ts", [ovGap])]);
		const results = await index.search(
			"yakword",
			vec(1),
			B1,
			{ limit: 5 },
			overlay,
		);
		const spans = results.map(
			(r) => `${r.chunk.filePath}:${r.chunk.startLine}-${r.chunk.endLine}`,
		);
		expect(new Set(spans).size).toBe(spans.length);
		const kept = results.find(
			(r) => r.chunk.filePath === join(dir, "src/gap.ts"),
		);
		expect(kept?.chunk.name).toBe("tinyGap");
		const ov = results[at(results, ovGap.id)];
		expect(ov.source).toBe("dirty");
		expect(ov.chunk.name).toBeUndefined();
	});
});

describe("mergeRetrieverLists — the pre-fusion ordering step", () => {
	test("orders by (score, id), cuts at `fetched`, then trims an incomplete tie tail", () => {
		const a = [
			{ id: "b", _distance: 0.2 },
			{ id: "d", _distance: 0.5 },
		];
		const b = [
			{ id: "a", _distance: 0.2 },
			{ id: "c", _distance: 0.4 },
		];
		expect(
			mergeRetrieverLists(a, b, "_distance", {
				fetched: 3,
				keepAtLeast: 1,
				indexEdge: null, // `a` is short: complete, no edge
			}).map((r) => r.id),
		).toEqual(["a", "b"]); // cut at 3, then the last group (c) dropped
		// `_score` is better-when-larger; the tie at the cut is dropped.
		const s = mergeRetrieverLists(
			[
				{ id: "x", _score: 5 },
				{ id: "y", _score: 2 },
			],
			[
				{ id: "w", _score: 2 },
				{ id: "v", _score: 9 },
			],
			"_score",
			{ fetched: 3, keepAtLeast: 1, indexEdge: null },
		);
		expect(s.map((r) => r.id)).toEqual(["v", "x"]);
	});

	test("a duplicate id keeps one entry (the better-scored one)", () => {
		const out = mergeRetrieverLists(
			[{ id: "a", _distance: 0.3 }],
			[
				{ id: "a", _distance: 0.3 },
				{ id: "b", _distance: 0.1 },
			],
			"_distance",
			{ fetched: 10, keepAtLeast: 1, indexEdge: null },
		);
		expect(out.map((r) => r.id)).toEqual(["b", "a"]);
	});
});

describe("pairCalibratedTwins — one-to-one, nearest lines first", () => {
	const row = (
		id: string,
		startLine: number,
		score: number,
		path = "src/p.ts",
		contentHash = "h1",
	) => ({
		id,
		filePath: path,
		contentHash,
		startLine,
		endLine: startLine + 2,
		_score: score,
	});
	function overlayOf(
		refs: { id: string; startLine: number; path?: string; hash?: string }[],
	): OverlayCandidates {
		const byKey = new Map<
			string,
			{ id: string; startLine: number; endLine: number }[]
		>();
		const rowsById = new Map();
		for (const r of refs) {
			const key = `${r.path ?? "src/p.ts"}\0${r.hash ?? "h1"}`;
			const list = byKey.get(key) ?? [];
			list.push({ id: r.id, startLine: r.startLine, endLine: r.startLine + 2 });
			list.sort((x, y) => x.startLine - y.startLine);
			byKey.set(key, list);
			rowsById.set(r.id, {
				id: r.id,
				startLine: r.startLine,
				endLine: r.startLine + 2,
				filePath: r.path ?? "src/p.ts",
				content: "c",
				language: "typescript",
				chunkType: "function",
				contentHash: r.hash ?? "h1",
				fileHash: "f",
				_distance: 0,
			});
		}
		return {
			suppressedPaths: [],
			servedPaths: ["src/p.ts"],
			vector: [],
			chunksByPathHash: byKey,
			rowsById,
		};
	}

	test("two index rows, one overlay chunk: the nearer index row pairs, the other is dropped", () => {
		const out = pairCalibratedTwins(
			[row("i1", 1, 7), row("i2", 20, 7)],
			overlayOf([{ id: "o1", startLine: 18 }]),
		);
		expect(out.map((r) => [r.id, r.startLine, r._score, r.source])).toEqual([
			["o1", 18, 7, "dirty"],
		]);
	});

	test("two of each: each overlay id appears exactly once, nearest pairs win", () => {
		const out = pairCalibratedTwins(
			[row("i1", 1, 7), row("i2", 30, 7)],
			overlayOf([
				{ id: "o1", startLine: 2 },
				{ id: "o2", startLine: 31 },
			]),
		);
		expect(out.map((r) => r.id).sort()).toEqual(["o1", "o2"]);
	});

	test("ties on distance: overlay id asc, then index id asc", () => {
		const out = pairCalibratedTwins(
			[row("i2", 10, 5), row("i1", 10, 5)],
			overlayOf([
				{ id: "ob", startLine: 12 },
				{ id: "oa", startLine: 8 },
			]),
		);
		expect(out.map((r) => r.id).sort()).toEqual(["oa", "ob"]);
		expect(out).toHaveLength(2);
	});

	test("PAIR-BIG: a 2 500 × 2 500 single-hash group pairs one-to-one, nearest lines, without the Cartesian product (review 2, MEDIUM 6)", () => {
		const n = 2500;
		const pad = (i: number) => String(i).padStart(5, "0");
		// Index rows at 10i+1 (score = their line), overlay chunks at 10i+3:
		// each overlay chunk's nearest row is distance 2, the next one 8.
		const rows = Array.from({ length: n }, (_, i) =>
			row(`i${pad(i)}`, i * 10 + 1, i * 10 + 1),
		);
		const refs = Array.from({ length: n }, (_, i) => ({
			id: `o${pad(i)}`,
			startLine: i * 10 + 3,
			endLine: i * 10 + 5,
		}));
		const rowsById = new Map(
			refs.map((r) => [
				r.id,
				{
					id: r.id,
					startLine: r.startLine,
					endLine: r.endLine,
					filePath: "src/p.ts",
					content: "c",
					language: "typescript",
					chunkType: "function",
					contentHash: "h1",
					fileHash: "f",
					_distance: 0,
				},
			]),
		);
		const overlay = {
			chunksByPathHash: new Map([["src/p.ts\0h1", refs]]),
			rowsById,
		} as unknown as OverlayCandidates;
		const started = performance.now();
		const out = pairCalibratedTwins(rows, overlay);
		const ms = performance.now() - started;
		console.log(`PAIR-BIG: ${n} x ${n} paired in ${ms.toFixed(1)} ms`);
		expect(out).toHaveLength(n);
		expect(new Set(out.map((r) => r.id)).size).toBe(n);
		for (const r of out) expect(r._score).toBe(Number(r.startLine) - 2);
		// ONE synchronous call: its own duration IS the event-loop block.
		// The Cartesian sort measured ~1.1 s here (review 2).
		expect(ms).toBeLessThan(250);
	});

	test("index rows of another path or hash pair with nothing", () => {
		const out = pairCalibratedTwins(
			[row("i1", 1, 7, "src/q.ts"), row("i2", 1, 7, "src/p.ts", "h2")],
			overlayOf([{ id: "o1", startLine: 1 }]),
		);
		expect(out).toEqual([]);
	});
});

describe("the calibrated twin query, as EXECUTED", () => {
	/** `limit` args of the calibration queries, in order, from a recorded log. */
	function calibrationCalls(log: { method: string; args: unknown[] }[]) {
		const out: { where: string; limit: number }[] = [];
		for (let i = 0; i < log.length; i++) {
			const w = log[i];
			if (w.method !== "where" || !String(w.args[0]).includes("contentHash IN"))
				continue;
			const next = log[i + 1];
			expect(next.method).toBe("limit");
			out.push({ where: String(w.args[0]), limit: Number(next.args[0]) });
		}
		return out;
	}

	test("branch scope: the main retrievers' branch predicate, code_chunk, repo, served paths, served hashes", async () => {
		const text = "function calib() { return tapirword; }";
		await index.addChunks(
			[
				chunk({
					path: "src/cal_x's.ts",
					label: "i",
					near: 3,
					name: "calib",
					content: text,
				}),
			],
			REPO1,
		);
		const kept = chunk({
			path: "src/cal_x's.ts",
			label: "o",
			near: 3,
			name: "calib",
			content: text,
			startLine: 4,
			endLine: 13,
		});
		const overlay = await candidates(vec(1), [
			served("src/cal_x's.ts", [kept]),
		]);
		const log = await recordTableCalls(index);

		await index.search(
			"tapirword",
			vec(1),
			B1,
			{ limit: 2, language: "typescript" },
			overlay,
		);
		const [call] = calibrationCalls(log);
		expect(call.where).toBe(
			"(branchIds LIKE '%,0,%' OR branchIds LIKE '%,1,%') AND documentType = 'code_chunk' AND pathKind = 'repo'" +
				" AND (filePath IN ('src/cal_x''s.ts')) AND (contentHash IN ('" +
				kept.contentHash +
				"'))" +
				" AND language = 'typescript'",
		);
		expect(call.limit).toBe(12); // 2 × searchFetchLimit(2)

		log.length = 0;
		await index.search("tapirword", vec(1), SCOPE_ALL, { limit: 2 }, overlay);
		const [all] = calibrationCalls(log);
		expect(all.where.startsWith("documentType = 'code_chunk'")).toBe(true);
	});

	test("re-issued with the limit doubled while pairing left too few twins, at most 3 times", async () => {
		const heavy = "wombatword wombatword wombatword wombatword heavy";
		const light = "function light() { return wombatword; }";
		const seed = async (heavyRows: number) => {
			await index.addChunks(
				[
					...Array.from({ length: heavyRows }, (_, i) =>
						chunk({
							path: "src/rep.ts",
							label: `h${i}`,
							near: 50,
							name: "heavy",
							content: heavy,
							startLine: 100 + i * 10,
							endLine: 104 + i * 10,
						}),
					),
					chunk({
						path: "src/rep.ts",
						label: "l",
						near: 60,
						name: "light",
						content: light,
						startLine: 1,
						endLine: 5,
					}),
				],
				REPO1,
			);
		};
		await seed(20);
		const ovHeavy = chunk({
			path: "src/rep.ts",
			label: "oh",
			near: 50,
			name: "heavy",
			content: heavy,
			startLine: 100,
			endLine: 104,
		});
		const ovLight = chunk({
			path: "src/rep.ts",
			label: "ol",
			near: 60,
			name: "light",
			content: light,
			startLine: 1,
			endLine: 5,
		});
		const overlay = await candidates(
			vec(1),
			[served("src/rep.ts", [ovHeavy, ovLight])],
			[],
			1,
		);
		const log = await recordTableCalls(index);

		// 20 heavy twins crowd the light one out of 6 and 12; 24 returns 21 rows.
		const found = await index.search(
			"wombatword",
			vec(1),
			B1,
			{ limit: 1 },
			overlay,
		);
		expect(calibrationCalls(log).map((c) => c.limit)).toEqual([6, 12, 24]);
		expect(found.length).toBe(1);

		// 100 heavy twins: bounded at three re-issues, then it answers with what it has.
		await index.addChunks(
			Array.from({ length: 80 }, (_, i) =>
				chunk({
					path: "src/rep.ts",
					label: `h2-${i}`,
					near: 50,
					name: "heavy",
					content: heavy,
					startLine: 5000 + i * 10,
					endLine: 5004 + i * 10,
				}),
			),
			REPO1,
		);
		log.length = 0;
		await index.search("wombatword", vec(1), B1, { limit: 1 }, overlay);
		expect(calibrationCalls(log).map((c) => c.limit)).toEqual([6, 12, 24, 48]);
	});
});
