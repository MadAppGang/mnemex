/**
 * BM25 full-text index rebuild policy.
 *
 * `ensureFtsIndex()` runs at the top of all three search paths in store.ts and
 * used to be guarded by a per-INSTANCE `ftsIndexReady` flag — while VectorStore
 * instances are per-SEARCH (SemanticBackend builds a fresh Indexer per query and
 * closes it in a `finally`, and each Indexer builds its own VectorStore). The
 * flag was therefore always `false` on entry, so
 * `createIndex(..., { replace: true })` rebuilt the entire BM25 index on EVERY
 * search. A controlled 270-query run wrote 270 new FTS index versions while
 * touching zero data fragments; on this repo's real store (19,862 rows, 2.6 GB)
 * that is ~275 ms per search against a ~9 ms BM25 query.
 *
 * These tests count real `createIndex` calls (the lancedb module is mocked with
 * a counting pass-through, the same device tracker-schema-memo.test.ts uses for
 * sqlite) and pin the contract:
 *   - unchanged corpus  => the index is built ONCE, however many searches run
 *   - fresh store       => the index IS built, BM25 works from the first search
 *   - corpus grew       => the index IS rebuilt on the next search
 *   - corpus shrank     => deletes are reflected in BM25 results
 *   - createIndex fails => the search still returns, it does not throw
 *
 * The optimization must be invisible except in timing: every assertion is about
 * a search returning the right rows.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChunkWithEmbedding } from "../../../src/types.js";

// ── Module mock ─────────────────────────────────────────────────────────────
// The real exports are snapshotted by VALUE before the mock is registered. The
// module namespace object stays live through `mock.module`, so reading
// `ns.connect` inside the wrapper would resolve to the wrapper itself and
// recurse until the stack blows.
const realExports = { ...(await import("@lancedb/lancedb")) };
const realConnect = realExports.connect;

/** Every `createIndex` call since the last reset, by column. */
let createIndexCalls: string[] = [];

/** When set, the next `createIndex` call rejects with this error. */
let createIndexError: Error | null = null;

function countingTable(table: unknown): unknown {
	return new Proxy(table as object, {
		get(target, prop, receiver) {
			if (prop === "createIndex") {
				return async (column: string, options?: unknown) => {
					createIndexCalls.push(column);
					if (createIndexError) throw createIndexError;
					return (
						target as {
							createIndex: (c: string, o?: unknown) => Promise<unknown>;
						}
					).createIndex(column, options);
				};
			}
			const value = Reflect.get(target, prop, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

mock.module("@lancedb/lancedb", () => ({
	...realExports,
	connect: async (uri: string, opts?: unknown) => {
		const conn = await realConnect(uri, opts as never);
		return new Proxy(conn as object, {
			get(target, prop, receiver) {
				if (prop === "openTable" || prop === "createTable") {
					return async (...args: unknown[]) => {
						const fn = Reflect.get(target, prop, receiver) as (
							...a: unknown[]
						) => Promise<unknown>;
						return countingTable(await fn.apply(target, args));
					};
				}
				const value = Reflect.get(target, prop, receiver);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
	},
}));

// Imported AFTER the mock so store.ts picks up the counting lancedb.
const { createVectorStore } = await import("../../../src/core/store.js");

// ── Fixtures ────────────────────────────────────────────────────────────────

const DIM = 8;

/** A deterministic non-zero vector — store.ts rejects zero-dimension batches. */
function vec(seed: number): number[] {
	return Array.from({ length: DIM }, (_, i) => ((seed + i) % 10) / 10 + 0.01);
}

function chunk(id: string, content: string, seed = 1): ChunkWithEmbedding {
	return {
		id,
		contentHash: `hash-${id}`,
		content,
		filePath: `src/${id}.ts`,
		startLine: 1,
		endLine: 10,
		language: "typescript",
		chunkType: "function",
		name: id,
		fileHash: `file-${id}`,
		vector: vec(seed),
	};
}

let dir: string;
let dbPath: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "mnemex-fts-"));
	dbPath = join(dir, "vectors");
	createIndexCalls = [];
	createIndexError = null;
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** Open a store the way a search does: fresh instance, initialize, use, close. */
async function withFreshStore<T>(
	fn: (store: Awaited<ReturnType<typeof makeStore>>) => Promise<T>,
): Promise<T> {
	const store = await makeStore();
	try {
		return await fn(store);
	} finally {
		await store.close();
	}
}

async function makeStore() {
	const store = createVectorStore({ vectorsDir: dbPath, pathRoot: dir });
	await store.initialize();
	return store;
}

/** Seed a corpus, then forget the index calls that seeding caused. */
async function seed(chunks: ChunkWithEmbedding[]): Promise<void> {
	await withFreshStore(async (store) => {
		await store.addChunks(chunks, { pathKind: "repo", branchId: 0 });
	});
}

/**
 * A BM25-only search. `keywordOnly` skips the vector leg, which would otherwise
 * return every row regardless of the query text and mask what BM25 actually
 * matched — the whole point of these assertions.
 */
const searchFor = (text: string) =>
	withFreshStore((store) =>
		store.search(text, undefined, { limit: 10, keywordOnly: true }),
	);

const idsOf = (results: Array<{ chunk: { id: string } }>) =>
	results.map((r) => r.chunk.id).sort();

// ── Tests ───────────────────────────────────────────────────────────────────

describe("ensureFtsIndex — unchanged corpus", () => {
	test("builds the FTS index once across many searches", async () => {
		await seed([
			chunk("alpha", "function alpha() { return parseConfig(); }", 1),
			chunk("beta", "function beta() { return renderView(); }", 2),
		]);
		createIndexCalls = [];

		// Each search is a brand-new VectorStore, exactly like SemanticBackend.
		await searchFor("parseConfig");
		const afterFirst = createIndexCalls.length;

		await searchFor("renderView");
		await searchFor("parseConfig");
		await searchFor("alpha");

		expect(afterFirst).toBe(1);
		expect(createIndexCalls).toEqual(["content"]);
	});

	test("searches keep returning BM25 hits after the index stops being rebuilt", async () => {
		await seed([
			chunk("alpha", "function alpha() { return parseConfig(); }", 1),
			chunk("beta", "function beta() { return renderView(); }", 2),
		]);

		const first = idsOf(await searchFor("parseConfig"));
		const second = idsOf(await searchFor("parseConfig"));
		const third = idsOf(await searchFor("parseConfig"));

		expect(first).toContain("alpha");
		// Identical results on an identical corpus — no ranking change.
		expect(second).toEqual(first);
		expect(third).toEqual(first);
	});
});

describe("ensureFtsIndex — fresh store", () => {
	test("creates the index on a store that has never had one", async () => {
		await seed([
			chunk("alpha", "function alpha() { return parseConfig(); }", 1),
		]);
		createIndexCalls = [];

		const results = await searchFor("parseConfig");

		expect(createIndexCalls).toEqual(["content"]);
		expect(idsOf(results)).toContain("alpha");
	});
});

describe("ensureFtsIndex — corpus changed", () => {
	test("rebuilds after chunks are added, and finds the new content", async () => {
		await seed([
			chunk("alpha", "function alpha() { return parseConfig(); }", 1),
		]);
		await searchFor("parseConfig");
		createIndexCalls = [];

		// Corpus grows. This is the regression that would silently rot BM25.
		await seed([
			chunk("gamma", "function gamma() { return brandnewterm(); }", 3),
		]);

		const results = await searchFor("brandnewterm");

		expect(createIndexCalls).toEqual(["content"]);
		expect(idsOf(results)).toContain("gamma");
	});

	test("a second search after the rebuild does not rebuild again", async () => {
		await seed([
			chunk("alpha", "function alpha() { return parseConfig(); }", 1),
		]);
		await searchFor("parseConfig");
		await seed([
			chunk("gamma", "function gamma() { return brandnewterm(); }", 3),
		]);

		await searchFor("brandnewterm");
		createIndexCalls = [];
		await searchFor("brandnewterm");

		expect(createIndexCalls).toEqual([]);
	});

	test("deleted files stop matching, without needing a rebuild", async () => {
		await seed([
			chunk("alpha", "function alpha() { return uniqueterm(); }", 1),
			chunk("beta", "function beta() { return renderView(); }", 2),
		]);
		expect(idsOf(await searchFor("uniqueterm"))).toContain("alpha");

		await withFreshStore(async (store) => {
			// No warmup search: deleteByFile opens the table itself now. It used
			// to no-op unless the handle was already open on this instance — see
			// store-delete-lazy-open.test.ts.
			await store.deleteByFile("src/alpha.ts");
		});
		createIndexCalls = [];

		const results = idsOf(await searchFor("uniqueterm"));

		expect(results).not.toContain("alpha");
		// Deletes are applied at query time via deletion vectors, so BM25 is
		// already correct — no rebuild needed to hide the removed row.
		expect(createIndexCalls).toEqual([]);
	});
});

describe("ensureFtsIndex — failure handling", () => {
	test("a failing createIndex does not fail the search", async () => {
		await seed([
			chunk("alpha", "function alpha() { return parseConfig(); }", 1),
		]);
		createIndexCalls = [];
		createIndexError = new Error("simulated index build failure");

		// Vector search still works; BM25 is simply unavailable this round.
		const results = await searchFor("parseConfig");

		expect(createIndexCalls).toEqual(["content"]);
		expect(Array.isArray(results)).toBe(true);
	});
});
