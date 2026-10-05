/**
 * SF — a ranked search never returns fewer than `limit` results while the
 * index holds `limit` distinct spans for it.
 *
 * The regression (release 0.37.0, black-box TEST-07 on Linux x64): each
 * retriever fetches `fetchLimit = 3 × limit` rows, `trimIncompleteTieTail`
 * drops the tie group AT the cut of a full list (NFR-5: the candidate set must
 * be threshold-bounded), and `collapseSpanTwins` then folds each span's
 * `code_chunk` / `code_unit` pair into one slot. A full 30-row list can hold
 * ~15 spans; trim its tied tail and fewer than `limit` remain. x64 float
 * summation produced the exact tie there; arm64 did not, so it passed on a Mac.
 *
 * This file does not depend on float behaviour: every tie below is built from
 * IDENTICAL vectors, which give bit-identical distances on every platform.
 *
 *   SF-0  the precondition, read straight off the table: at the first depth
 *         the engine list is FULL and its trimmed form holds < `limit` spans
 *   SF-1  `search`: `limit` distinct spans, after one deepening
 *   SF-2  `searchDocuments`: the same
 *   SF-3  `searchCodeUnits` (two revisions per span, SCOPE_ALL): `limit`
 *         distinct spans, after TWO deepenings (6 -> 12 -> 24)
 *   SF-4  bounded: a tie group deeper than the cap stops at
 *         `searchMaxFetchLimit(limit)` and returns what it has
 *   SF-5  every row ties: the trim keeps its sample, no deepening at all
 *   SF-6  the common path issues exactly one query per channel
 *   SF-7  with an overlay: the deepened pass still merges overlay rows
 *   SF-8  `nextFetchLimit`, the pure step function
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { branchScope, SCOPE_ALL } from "../../../src/core/branch-scope.js";
import {
	createVectorStore,
	type IVectorStore,
	nextFetchLimit,
	searchFetchLimit,
	searchMaxFetchLimit,
	stabilizeRetrieverOrder,
	trimIncompleteTieTail,
} from "../../../src/core/store.js";
import type {
	ChunkWithEmbedding,
	CodeUnitWithEmbedding,
} from "../../../src/types.js";
import {
	overlayCandidatesFrom,
	type RecordedCall,
	recordTableCalls,
} from "../../helpers/store-search-fixture.js";

const DIM = 8;
const BRANCH = 1;
/** Matches no row, so the BM25 channel is empty and never full. */
const NO_KEYWORD = "zzqqxx";

let dir: string;
let vectorsDir: string;

beforeEach(() => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "mnemex-shortfall-")));
	vectorsDir = join(dir, "vectors");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function hexId(label: string): string {
	return createHash("sha256").update(label).digest("hex").slice(0, 16);
}

/** First component carries the similarity; equal `near` is an EXACT tie. */
function vec(near: number): number[] {
	const v = new Array(DIM).fill(0.01);
	v[0] = 1 / near;
	return v;
}

const QUERY_VECTOR = vec(1);

interface SpanSpec {
	path: string;
	near: number;
}

function chunkFor(spec: SpanSpec): ChunkWithEmbedding {
	return {
		id: hexId(`chunk:${spec.path}`),
		contentHash: hexId(`chash:${spec.path}`),
		content: `export\nfunction fn() { plain }`,
		filePath: spec.path,
		startLine: 1,
		endLine: 10,
		language: "typescript",
		chunkType: "function",
		name: "fn",
		fileHash: hexId(`file:${spec.path}`),
		vector: vec(spec.near),
	};
}

function unitFor(spec: SpanSpec, revision = ""): CodeUnitWithEmbedding {
	return {
		id: hexId(`unit:${spec.path}:${revision}`),
		parentId: null,
		unitType: "function",
		filePath: spec.path,
		startLine: 1,
		endLine: 10,
		language: "typescript",
		content: `function fn() { plain ${revision} }`,
		name: "fn",
		fileHash: hexId(`file:${spec.path}:${revision}`),
		depth: 1,
		vector: vec(spec.near),
	};
}

/** `leaders` spans at distinct distances 1..n, then `tied` spans at one. */
function spans(leaders: number, tied: number): SpanSpec[] {
	const out: SpanSpec[] = [];
	for (let i = 0; i < leaders; i++) {
		out.push({ path: `src/lead${String(i).padStart(3, "0")}.ts`, near: i + 1 });
	}
	for (let i = 0; i < tied; i++) {
		out.push({
			path: `src/tie${String(i).padStart(3, "0")}.ts`,
			near: leaders + 1,
		});
	}
	return out;
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

/** Every span as a `code_chunk` AND a `code_unit` twin with the SAME vector. */
async function seedTwins(specs: SpanSpec[]): Promise<void> {
	await withStore(async (store) => {
		await store.addChunks(specs.map(chunkFor), {
			pathKind: "repo",
			branchId: BRANCH,
		});
		await store.addCodeUnits(
			specs.map((s) => unitFor(s)),
			{ pathKind: "repo", branchId: BRANCH },
		);
	});
}

function distinct(keys: readonly string[]): number {
	return new Set(keys).size;
}

/** The `.limit(n)` argument of every vector query, in order. */
function vectorLimits(log: readonly RecordedCall[]): number[] {
	const out: number[] = [];
	for (let i = 0; i < log.length; i++) {
		if (log[i].on !== "table" || log[i].method !== "vectorSearch") continue;
		const limit = log
			.slice(i + 1)
			.find((c) => c.method === "limit" && c.on !== "table");
		out.push(limit?.args[0] as number);
	}
	return out;
}

const LIMIT = 6;
/** 4 leader spans (8 rows) + 6 tied spans (12 rows) = 20 rows, 10 spans. */
const SHORTFALL = spans(4, 6);

// ════════════════════════════════════════════════════════════════════════════
// SF-0 — the precondition, measured on the table itself
// ════════════════════════════════════════════════════════════════════════════

describe("SF-0 — the shape really short-falls at the first depth", () => {
	test("full engine list; trimmed tail leaves < limit spans; ≥ limit exist", async () => {
		await seedTwins(SHORTFALL);
		const fetched = searchFetchLimit(LIMIT);
		const rows = await withStore(async (store) => {
			const table = await (
				store as unknown as {
					ensureTableOpen(): Promise<{
						vectorSearch(v: number[]): {
							limit(n: number): {
								toArray(): Promise<Record<string, unknown>[]>;
							};
						};
					} | null>;
				}
			).ensureTableOpen();
			if (table === null) throw new Error("no table");
			return table.vectorSearch(QUERY_VECTOR).limit(fetched).toArray();
		});
		expect(rows).toHaveLength(fetched);
		const trimmed = trimIncompleteTieTail(
			stabilizeRetrieverOrder(rows, "_distance"),
			"_distance",
			{ fetched, keepAtLeast: LIMIT },
		);
		const trimmedSpans = distinct(trimmed.map((r) => String(r.filePath)));
		expect(trimmedSpans).toBe(4);
		expect(trimmedSpans).toBeLessThan(LIMIT);
		expect(SHORTFALL.length).toBeGreaterThanOrEqual(LIMIT);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// SF-1 / SF-2 / SF-3 — every ranked path fills `limit`
// ════════════════════════════════════════════════════════════════════════════

describe("SF-1 — VectorStore.search fills limit after a deepening", () => {
	test("limit distinct spans: the 4 leaders, then 2 of the tie group (A)", async () => {
		await seedTwins(SHORTFALL);
		const { results, limits } = await withStore(async (store) => {
			const log = await recordTableCalls(store);
			const results = await store.search(
				NO_KEYWORD,
				QUERY_VECTOR,
				branchScope(BRANCH),
				{ limit: LIMIT },
			);
			return { results, limits: vectorLimits(log) };
		});
		const paths = results.map((r) => r.chunk.filePath);
		expect(results).toHaveLength(LIMIT);
		expect(distinct(paths)).toBe(LIMIT);
		expect(paths.slice(0, 4)).toEqual(
			SHORTFALL.slice(0, 4).map((s) => join(dir, s.path)),
		);
		const tied = new Set(SHORTFALL.slice(4).map((s) => join(dir, s.path)));
		expect(paths.slice(4).every((p) => tied.has(p))).toBe(true);
		expect(limits).toEqual([18, 36]);
	});

	test("deterministic: the same corpus answers the same list twice", async () => {
		await seedTwins(SHORTFALL);
		const run = () =>
			withStore((store) =>
				store.search(NO_KEYWORD, QUERY_VECTOR, branchScope(BRANCH), {
					limit: LIMIT,
				}),
			);
		const a = (await run()).map((r) => r.chunk.id);
		const b = (await run()).map((r) => r.chunk.id);
		expect(a).toEqual(b);
	});
});

describe("SF-2 — VectorStore.searchDocuments fills limit", () => {
	test("limit distinct code spans (A)", async () => {
		await seedTwins(SHORTFALL);
		const results = await withStore((store) =>
			store.searchDocuments(NO_KEYWORD, QUERY_VECTOR, branchScope(BRANCH), {
				limit: LIMIT,
			}),
		);
		expect(results).toHaveLength(LIMIT);
		expect(distinct(results.map((r) => String(r.document.filePath)))).toBe(
			LIMIT,
		);
	});
});

describe("SF-3 — VectorStore.searchCodeUnits fills limit", () => {
	test("two revisions per span in SCOPE_ALL: 6 -> 12 -> 24 (A)", async () => {
		// limit 3 -> first depth 2 × 3 = 6. 2 leader spans (4 rows) and 4 tied
		// spans (8 rows): at 6 and at 12 the list is full and its tie tail
		// trimmed to the 4 leader rows = 2 spans; at 24 it is short, untrimmed.
		const specs = spans(2, 4);
		await withStore(async (store) => {
			await store.addCodeUnits(
				specs.map((s) => unitFor(s, "rev1")),
				{ pathKind: "repo", branchId: 1 },
			);
			await store.addCodeUnits(
				specs.map((s) => unitFor(s, "rev2")),
				{ pathKind: "repo", branchId: 2 },
			);
		});
		const { results, limits } = await withStore(async (store) => {
			const log = await recordTableCalls(store);
			const results = await store.searchCodeUnits(
				NO_KEYWORD,
				QUERY_VECTOR,
				SCOPE_ALL,
				{ limit: 3 },
			);
			return { results, limits: vectorLimits(log) };
		});
		expect(results).toHaveLength(3);
		expect(distinct(results.map((r) => r.filePath))).toBe(3);
		expect(limits).toEqual([6, 12, 24]);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// SF-4 / SF-5 / SF-6 — bounded, and the common path untouched
// ════════════════════════════════════════════════════════════════════════════

describe("SF-4 — the deepening is bounded", () => {
	test("a tie group deeper than the cap stops at searchMaxFetchLimit (A)", async () => {
		// 4 leaders + 60 tied spans = 128 rows. Every depth up to the cap is
		// full with its tail on the tie group, so every pass trims back to the
		// 4 leaders. The loop must stop at the cap, not chase the corpus.
		await seedTwins(spans(4, 60));
		const { results, limits } = await withStore(async (store) => {
			const log = await recordTableCalls(store);
			const results = await store.search(
				NO_KEYWORD,
				QUERY_VECTOR,
				branchScope(BRANCH),
				{ limit: LIMIT },
			);
			return { results, limits: vectorLimits(log) };
		});
		expect(searchMaxFetchLimit(LIMIT)).toBe(48);
		expect(limits).toEqual([18, 36, 48]);
		expect(Math.max(...limits)).toBeLessThanOrEqual(searchMaxFetchLimit(LIMIT));
		expect(results).toHaveLength(4);
	});
});

describe("SF-5 — every row ties", () => {
	test("the trim keeps its sample; one pass, no deepening (A)", async () => {
		await seedTwins(spans(0, 60));
		const { results, limits } = await withStore(async (store) => {
			const log = await recordTableCalls(store);
			const results = await store.search(
				NO_KEYWORD,
				QUERY_VECTOR,
				branchScope(BRANCH),
				{ limit: LIMIT },
			);
			return { results, limits: vectorLimits(log) };
		});
		expect(limits).toEqual([18]);
		expect(results).toHaveLength(LIMIT);
	});
});

describe("SF-6 — the common path", () => {
	test("a first pass that fills limit issues one query per channel (A)", async () => {
		// 12 leaders at distinct distances: no tie at any cut.
		await seedTwins(spans(12, 0));
		const { results, log } = await withStore(async (store) => {
			const log = await recordTableCalls(store);
			const results = await store.search(
				NO_KEYWORD,
				QUERY_VECTOR,
				branchScope(BRANCH),
				{ limit: LIMIT },
			);
			return { results, log: [...log] };
		});
		expect(results).toHaveLength(LIMIT);
		expect(vectorLimits(log)).toEqual([18]);
		expect(log.filter((c) => c.method === "fullTextSearch")).toHaveLength(1);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// SF-7 — the overlay merge at a deeper depth
// ════════════════════════════════════════════════════════════════════════════

describe("SF-7 — with an overlay", () => {
	test("the deepened pass still merges and serves the overlay row (A)", async () => {
		await seedTwins(SHORTFALL);
		const overlayStore = createVectorStore({
			vectorsDir: join(dir, "overlay"),
			pathRoot: dir,
		});
		await overlayStore.initialize();
		try {
			// A new file between leader 0 (the query itself) and leader 1: it
			// must take result #2, ahead of every other index span.
			const fresh = chunkFor({ path: "src/fresh.ts", near: 1.5 });
			const overlay = await overlayCandidatesFrom({
				overlayStore,
				queryVector: QUERY_VECTOR,
				served: [{ path: "src/fresh.ts", chunks: [fresh] }],
				search: { limit: LIMIT },
			});
			const { results, limits } = await withStore(async (store) => {
				const log = await recordTableCalls(store);
				const results = await store.search(
					NO_KEYWORD,
					QUERY_VECTOR,
					branchScope(BRANCH),
					{ limit: LIMIT },
					overlay,
				);
				return { results, limits: vectorLimits(log) };
			});
			expect(limits).toEqual([18, 36]);
			expect(results).toHaveLength(LIMIT);
			expect(distinct(results.map((r) => r.chunk.filePath))).toBe(LIMIT);
			expect(results[1].chunk.id).toBe(fresh.id);
			expect(results[1].source).toBe("dirty");
		} finally {
			await overlayStore.close();
		}
	});

	test("an overlay list FULL at its own depth caps the deepening there (A)", async () => {
		// The merge gate needs both sides cut at one depth. This overlay was
		// materialised at the first pass's depth (no `vectorFetchLimit`) and
		// holds more rows than that, so a deeper pass would rank index rows
		// against overlay rows that were never read: the search must not go.
		await seedTwins(SHORTFALL);
		const overlayStore = createVectorStore({
			vectorsDir: join(dir, "overlay"),
			pathRoot: dir,
		});
		await overlayStore.initialize();
		try {
			const far = Array.from({ length: 25 }, (_, i) =>
				chunkFor({
					path: `src/far${String(i).padStart(2, "0")}.ts`,
					near: 50 + i,
				}),
			);
			const overlay = await overlayCandidatesFrom({
				overlayStore,
				queryVector: QUERY_VECTOR,
				served: far.map((c) => ({ path: c.filePath, chunks: [c] })),
				search: { limit: LIMIT },
			});
			expect(overlay.vector).toHaveLength(searchFetchLimit(LIMIT));
			expect(overlay.vectorFetchLimit).toBeUndefined();
			const limits = await withStore(async (store) => {
				const log = await recordTableCalls(store);
				await store.search(
					NO_KEYWORD,
					QUERY_VECTOR,
					branchScope(BRANCH),
					{ limit: LIMIT },
					overlay,
				);
				return vectorLimits(log);
			});
			expect(limits).toEqual([18]);

			// The same rows materialised at the cap's depth: the search deepens.
			const deep = {
				...overlay,
				vector: await overlayStore.vectorCandidates(
					QUERY_VECTOR,
					far.map((c) => c.id),
					{ limit: LIMIT },
					searchMaxFetchLimit(LIMIT),
				),
				vectorFetchLimit: searchMaxFetchLimit(LIMIT),
			};
			expect(deep.vector).toHaveLength(25);
			const deepLimits = await withStore(async (store) => {
				const log = await recordTableCalls(store);
				await store.search(
					NO_KEYWORD,
					QUERY_VECTOR,
					branchScope(BRANCH),
					{ limit: LIMIT },
					deep,
				);
				return vectorLimits(log);
			});
			expect(deepLimits).toEqual([18, 36]);
		} finally {
			await overlayStore.close();
		}
	});
});

// ════════════════════════════════════════════════════════════════════════════
// SF-8 — the step function
// ════════════════════════════════════════════════════════════════════════════

describe("SF-8 — nextFetchLimit", () => {
	test("doubles, clamps to the cap, and stops AT the cap", () => {
		expect(nextFetchLimit(30, 80)).toBe(60);
		expect(nextFetchLimit(60, 80)).toBe(80);
		expect(nextFetchLimit(80, 80)).toBeNull();
		expect(nextFetchLimit(100, 80)).toBeNull();
	});

	test("a zero depth never loops", () => {
		expect(nextFetchLimit(0, 0)).toBeNull();
		expect(nextFetchLimit(0, 8)).toBeNull();
	});
});
