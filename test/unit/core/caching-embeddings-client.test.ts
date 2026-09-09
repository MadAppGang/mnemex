/**
 * `CachingEmbeddingsClient` — the caching PROXY over `IEmbeddingsClient`
 * (Phase 2). No network, no LanceDB, no tree-sitter: a COUNTING FAKE stands in
 * for the provider and a real `EmbedCache` (temp file) stands in for the store.
 *
 * The counting fake is the point. The proxy's whole contract is "on a hit the
 * inner client is NOT called", and the only honest evidence for that is a real
 * call counter on the thing that would have been called — not the proxy's own
 * `stats()`. Wherever the claim is "a row exists / does not exist / was
 * refreshed", the assertion reads the BYTES with an independent connection,
 * because every occurrence of the config bug class in this repo has been
 * invisible to the report object (CLAUDE.md #25).
 *
 * Gotchas pinned here: #15 (zero-length vectors are never stored and never
 * served, `=== 0` and never truthiness), #16 (a model name does not identify its
 * provider — §3.6's identity rule and provider coexistence), #20 (progress is
 * stamped on the hit path too — the lock-level proof is in
 * `embed-cache-progress.test.ts`).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assertEmbeddedTextIsChunkContent,
	CachingEmbeddingsClient,
	createCachingEmbeddingsClient,
	EmbedCacheSoundnessError,
	PROGRESS_TICK_ITEMS,
	PROGRESS_TICK_MS,
	ProgressTicker,
} from "../../../src/core/caching-embeddings-client.js";
import type {
	EmbedCache,
	EmbedCacheEntry,
	EmbedCacheLike,
	EmbedCacheStats,
	ModelDims,
	TouchKey,
	VetoedRow,
} from "../../../src/core/embed-cache.js";
import {
	embedCacheKey,
	openEmbedCache,
	resetEmbedCacheForTests,
	WRITE_CHUNK,
} from "../../../src/core/embed-cache.js";
import { TotalEmbeddingFailureError } from "../../../src/core/embeddings-errors.js";
import { createDatabaseSync } from "../../../src/core/sqlite.js";
import type {
	EmbeddingProvider,
	EmbedResult,
	IEmbeddingsClient,
} from "../../../src/types.js";

// ════════════════════════════════════════════════════════════════════════════
// Fixtures
// ════════════════════════════════════════════════════════════════════════════

let dir: string;
let dbPath: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "caching-embed-"));
	dbPath = join(dir, "embed-cache.db");
	for (const key of ["MNEMEX_EMBED_CACHE_PATH", "MNEMEX_DISABLE_EMBED_CACHE"]) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
});

afterEach(() => {
	resetEmbedCacheForTests();
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(dir, { recursive: true, force: true });
});

type FailMode = "none" | "total" | "fatal-401";

interface FakeOptions {
	model?: string;
	provider?: EmbeddingProvider;
	dim?: number;
	/** Slots (within a batch) whose vector comes back EMPTY. */
	emptyAt?: (index: number, text: string) => boolean;
	failMode?: FailMode;
	/** Mimics the real clients, which only know their width after a response. */
	reportsDimension?: boolean;
	local?: boolean;
	costPerCall?: number;
	tokensPerText?: number;
}

/**
 * The counting fake. `calls` and `textsSeen` are REAL counters on the object the
 * proxy would have to call; nothing about them is a self-report by the proxy.
 */
class CountingEmbedder implements IEmbeddingsClient {
	calls = 0;
	textsSeen: string[] = [];
	batches: string[][] = [];
	failMode: FailMode;

	private readonly model: string;
	private readonly provider: EmbeddingProvider;
	private readonly dim: number;
	private readonly opts: FakeOptions;
	private observed: number | undefined;

	constructor(opts: FakeOptions = {}) {
		this.opts = opts;
		this.model = opts.model ?? "nomic-embed-text";
		this.provider = opts.provider ?? "ollama";
		this.dim = opts.dim ?? 8;
		this.failMode = opts.failMode ?? "none";
	}

	/** Deterministic, content-derived, and never all-zero. */
	vectorFor(text: string, dim = this.dim): number[] {
		const out: number[] = new Array(dim);
		let h = 2166136261;
		for (let i = 0; i < text.length; i++) {
			h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
		}
		for (let i = 0; i < dim; i++) {
			h = Math.imul(h ^ (i + 1), 16777619) >>> 0;
			out[i] = (h % 20001) / 10000 - 1;
		}
		return out;
	}

	async embed(
		texts: string[],
		onProgress?: (c: number, t: number, ip?: number) => void,
	): Promise<EmbedResult> {
		this.calls++;
		this.textsSeen.push(...texts);
		this.batches.push([...texts]);

		if (this.failMode === "fatal-401") {
			throw new Error("openrouter embeddings failed: 401 Unauthorized");
		}
		if (this.failMode === "total") {
			throw new TotalEmbeddingFailureError(
				this.provider,
				texts.length,
				"connection reset",
			);
		}

		const embeddings: number[][] = [];
		for (let i = 0; i < texts.length; i++) {
			const text = texts[i] as string;
			const empty = this.opts.emptyAt?.(i, text) ?? false;
			embeddings.push(empty ? [] : this.vectorFor(text));
			onProgress?.(i + 1, texts.length, 1);
		}
		onProgress?.(texts.length, texts.length, 0);

		if ((this.opts.reportsDimension ?? true) === true) {
			const first = embeddings.find((v) => v.length !== 0);
			if (first !== undefined) this.observed = first.length;
		}

		const result: EmbedResult = { embeddings };
		if (this.opts.costPerCall !== undefined)
			result.cost = this.opts.costPerCall;
		if (this.opts.tokensPerText !== undefined) {
			result.totalTokens = this.opts.tokensPerText * texts.length;
		}
		return result;
	}

	async embedOne(text: string): Promise<number[]> {
		const r = await this.embed([text]);
		return r.embeddings[0] as number[];
	}

	getModel(): string {
		return this.model;
	}
	getDimension(): number | undefined {
		return this.observed;
	}
	getProvider(): EmbeddingProvider {
		return this.provider;
	}
	isLocal(): boolean {
		return this.opts.local ?? true;
	}
}

/** A client whose output width CHANGES on a given call — Rule R's trigger. */
class WidthShiftingEmbedder extends CountingEmbedder {
	constructor(
		private readonly widths: number[],
		opts: FakeOptions = {},
	) {
		super(opts);
	}
	override vectorFor(text: string): number[] {
		const width =
			this.widths[Math.min(this.calls - 1, this.widths.length - 1)] ?? 8;
		return super.vectorFor(text, width);
	}
}

/** Records the SHAPE of every write the proxy makes, then delegates. */
class SpyCache implements EmbedCacheLike {
	putManyCalls: Array<{
		entries: number;
		touched: number;
		dims: ModelDims | undefined;
	}> = [];
	evictCalls: number[] = [];
	getCalls = 0;
	dimensionCorrections = 0;

	constructor(private readonly inner: EmbedCacheLike) {}

	get(
		key: string,
		provider: string,
		dimension: number,
		fingerprint: string,
	): number[] | undefined {
		this.getCalls++;
		return this.inner.get(key, provider, dimension, fingerprint);
	}
	putMany(
		entries: readonly EmbedCacheEntry[],
		touched: readonly TouchKey[],
		dims?: ModelDims,
	): void {
		this.putManyCalls.push({
			entries: entries.length,
			touched: touched.length,
			dims,
		});
		this.inner.putMany(entries, touched, dims);
	}
	knownDimension(model: string, provider: string): number | undefined {
		return this.inner.knownDimension(model, provider);
	}
	recordDimension(model: string, provider: string, dimension: number): void {
		this.inner.recordDimension(model, provider, dimension);
	}
	evictKeys(rows: readonly VetoedRow[]): void {
		this.evictCalls.push(rows.length);
		this.inner.evictKeys(rows);
	}
	pendingEvictions(): VetoedRow[] {
		return this.inner.pendingEvictions();
	}
	noteDimensionCorrection(): void {
		this.dimensionCorrections++;
	}
	stats(): EmbedCacheStats {
		return this.inner.stats();
	}
	enforceBudget() {
		return this.inner.enforceBudget();
	}
	close(): void {
		this.inner.close();
	}
}

function openCache(path = dbPath): EmbedCache {
	const cache = openEmbedCache(path);
	if (cache === null) throw new Error("openEmbedCache returned null");
	return cache;
}

function proxy(
	inner: IEmbeddingsClient,
	cache: EmbedCacheLike | null,
	over: Partial<{
		fingerprint: string;
		memoryBudgetBytes: number;
		mode: "persistent" | "off";
	}> = {},
): CachingEmbeddingsClient {
	return new CachingEmbeddingsClient({
		inner,
		cache,
		mode: over.mode ?? "persistent",
		clientFingerprint: over.fingerprint ?? "",
		memoryBudgetBytes: over.memoryBudgetBytes,
	});
}

function texts(n: number, prefix = "chunk"): string[] {
	return Array.from({ length: n }, (_, i) => `${prefix}-${i}`);
}

/**
 * A served vector is EXACTLY `Math.fround` of the one that was stored — §4.3's
 * claim, asserted rather than believed. The cache stores little-endian float32
 * because LanceDB narrows the column to `FixedSizeList<Float32>` anyway, so the
 * value that reaches the table is bit-identical either way. Anything looser than
 * `toBe(Math.fround(x))` here would also pass if the codec silently lost bits.
 */
function expectF32Equal(
	actual: number[] | undefined,
	expected: number[],
): void {
	expect(actual).toBeDefined();
	expect(actual).toHaveLength(expected.length);
	for (let i = 0; i < expected.length; i++) {
		expect((actual as number[])[i]).toBe(Math.fround(expected[i] as number));
	}
}

/** Bytes on disk, read with an INDEPENDENT connection. */
function readRows(path = dbPath): Array<{
	key: string;
	provider: string;
	model: string;
	dim: number;
	fingerprint: string;
	bytes: number;
	blobLength: number;
	created_at: number;
	last_used_at: number;
}> {
	const db = createDatabaseSync(path);
	try {
		return db
			.prepare(
				"SELECT key, provider, model, dim, fingerprint, bytes, length(vector) AS blobLength, created_at, last_used_at FROM embeddings ORDER BY key, provider",
			)
			.all() as ReturnType<typeof readRows>;
	} finally {
		db.close();
	}
}

/** Backdate every row so the TOUCH_RESOLUTION_MS threshold cannot suppress a touch. */
function backdate(path = dbPath, ageMs = 10 * 60_000): number {
	const db = createDatabaseSync(path);
	try {
		const when = Date.now() - ageMs;
		db.prepare("UPDATE embeddings SET last_used_at = ?, created_at = ?").run(
			when,
			when,
		);
		return when;
	} finally {
		db.close();
	}
}

// ════════════════════════════════════════════════════════════════════════════
describe("the warm path — the inner client is NOT called", () => {
	test("an all-hits batch makes ZERO calls and sees ZERO texts", async () => {
		const cache = openCache();
		const fake = new CountingEmbedder();
		const cold = proxy(fake, cache);
		const input = texts(120);

		const first = await cold.embed(input);
		expect(fake.calls).toBe(1);
		expect(first.cacheHits).toBe(0);

		// A SECOND proxy over a SECOND fake, sharing only the cache file — which is
		// the machine-global reuse the feature exists for.
		const warmFake = new CountingEmbedder();
		const warm = proxy(warmFake, cache);
		const second = await warm.embed(input);

		expect(warmFake.calls).toBe(0);
		expect(warmFake.textsSeen).toHaveLength(0);
		expect(second.cacheHits).toBe(120);
		expect(second.embeddings).toHaveLength(120);
		for (let i = 0; i < 120; i++) {
			expectF32Equal(second.embeddings[i], first.embeddings[i] as number[]);
		}
	});

	test("cost and totalTokens come from the inner call only, so a warm run reports neither", async () => {
		const cache = openCache();
		const input = texts(20);
		const cold = proxy(
			new CountingEmbedder({ costPerCall: 0.5, tokensPerText: 10 }),
			cache,
		);
		const first = await cold.embed(input);
		expect(first.cost).toBe(0.5);
		expect(first.totalTokens).toBe(200);

		const warm = proxy(
			new CountingEmbedder({ costPerCall: 0.5, tokensPerText: 10 }),
			cache,
		);
		const second = await warm.embed(input);
		expect(second.cost).toBeUndefined();
		expect(second.totalTokens).toBeUndefined();
	});

	test("§3.6 identity rule: the key is the CLIENT's model, not a prefixed spelling", async () => {
		// `createEmbeddingsClient` strips `ollama/` before the client sees the name,
		// while the tracker stores the unstripped string. Keying on the stored
		// string gives the same text two different hexes and a permanent 0 % hit
		// rate. The proxy only ever asks the client.
		const cache = openCache();
		const trackerSpelling = "ollama/nomic-embed-text";
		const clientSpelling = "nomic-embed-text";

		const run1 = proxy(new CountingEmbedder({ model: clientSpelling }), cache);
		const cold = await run1.embed(texts(5));

		const warmFake = new CountingEmbedder({ model: clientSpelling });
		const run2 = proxy(warmFake, cache);
		const warm = await run2.embed(texts(5));

		expect(warmFake.calls).toBe(0);
		expect(warm.cacheHits).toBe(5);
		// And the stored key is genuinely the stripped spelling.
		expect(readRows()[0]?.model).toBe(clientSpelling);
		expect(cold.keys?.[0]).not.toBe(
			embedCacheKey(trackerSpelling, 8, "chunk-0"),
		);
		expect(cold.keys?.[0]).toBe(embedCacheKey(clientSpelling, 8, "chunk-0"));
	});
});

// ════════════════════════════════════════════════════════════════════════════
describe("the mixed path — the common case", () => {
	test("450 hits + 50 misses is ONE inner call carrying exactly the 50 miss texts", async () => {
		const cache = openCache();
		const all = texts(500);
		await proxy(new CountingEmbedder(), cache).embed(all.slice(0, 450));

		const fake = new CountingEmbedder();
		const seen: Array<
			[number, number, number | undefined, number | undefined]
		> = [];
		const result = await proxy(fake, cache).embed(all, (c, t, ip, hits) => {
			seen.push([c, t, ip, hits]);
		});

		// ONE call, not 50 — a miss at any slot must never fan out per item.
		expect(fake.calls).toBe(1);
		expect(fake.batches).toHaveLength(1);
		expect(fake.batches[0]).toEqual(all.slice(450));

		// Slot alignment is a contract, and it is what `indexer.ts:1137` checks.
		expect(result.embeddings).toHaveLength(500);
		expect(result.cacheHits).toBe(450);
		for (let i = 0; i < 450; i++) {
			// Served from the cache: f32, by §4.3.
			expectF32Equal(result.embeddings[i], fake.vectorFor(all[i] as string));
		}
		for (let i = 450; i < 500; i++) {
			// Straight from the provider, untouched by the cache: bit-for-bit.
			expect(result.embeddings[i]).toEqual(fake.vectorFor(all[i] as string));
		}

		// The ticker is monotonic and lands on `total` exactly once.
		let previous = -1;
		for (const [c, t] of seen) {
			expect(c).toBeGreaterThanOrEqual(previous);
			expect(t).toBe(500);
			previous = c;
		}
		expect(previous).toBe(500);
		// The emits at N that follow the last vector are the WRITE regions stamping
		// the lock: that work is real and it holds the lock while it runs. What
		// guarantee 1 forbids is `final()` adding a DUPLICATE terminal emit, which
		// is pinned directly on the ticker below.
		expect(seen.at(-1)?.[0]).toBe(500);
		// H8: the live hit count travels with the progress.
		expect(seen.at(-1)?.[3]).toBe(450);
	});

	test("`touched` is collected on the MIXED path, not only on the all-hits one", async () => {
		const cache = openCache();
		const all = texts(20);
		// INTERLEAVED on purpose: the cached texts are the EVEN slots, so the very
		// first item of the scan is a MISS. A spelling that stops collecting once a
		// miss appears — or that only flushes `touched` when the batch turned out
		// to be all hits, which is the shape revision 1 shipped — loses nine of the
		// ten touches here. A hits-first fixture would not notice either.
		const cached = all.filter((_, i) => i % 2 === 0);
		await proxy(new CountingEmbedder(), cache).embed(cached);
		const backdatedTo = backdate();
		expect(readRows().every((r) => r.last_used_at === backdatedTo)).toBe(true);

		await proxy(new CountingEmbedder(), cache).embed(all);

		// Read the BYTES: every row that was HIT has a refreshed last_used_at.
		const rows = readRows();
		expect(rows).toHaveLength(20);
		const hitKeys = new Set(
			cached.map((t) => embedCacheKey("nomic-embed-text", 8, t)),
		);
		expect(hitKeys.size).toBe(10);
		let refreshed = 0;
		for (const row of rows) {
			if (!hitKeys.has(row.key)) continue;
			expect(row.created_at).toBe(backdatedTo);
			expect(row.last_used_at).toBeGreaterThan(backdatedTo);
			refreshed++;
		}
		expect(refreshed).toBe(10);
	});

	test("an empty batch calls nothing, throws nothing, and still emits a terminal stamp", async () => {
		const cache = openCache();
		const fake = new CountingEmbedder();
		const seen: number[][] = [];
		const result = await proxy(fake, cache).embed([], (c, t) => {
			seen.push([c, t]);
		});
		expect(fake.calls).toBe(0);
		expect(result.embeddings).toEqual([]);
		expect(seen).toEqual([[0, 0]]);
	});

	test("a miss the provider failed on yields [] in its slot, and every other slot survives", async () => {
		const cache = openCache();
		const fake = new CountingEmbedder({
			emptyAt: (_i, text) => text === "chunk-3",
		});
		const result = await proxy(fake, cache).embed(texts(6));
		expect(result.embeddings).toHaveLength(6);
		expect(result.embeddings[3]).toEqual([]);
		for (const i of [0, 1, 2, 4, 5]) {
			expect((result.embeddings[i] as number[]).length).toBe(8);
		}
	});
});

// ════════════════════════════════════════════════════════════════════════════
describe("flushWrites is the single writer", () => {
	test("an all-hits embed of 5 000 texts issues ceil(5000/WRITE_CHUNK) putMany calls, none oversized", async () => {
		const cache = openCache();
		const input = texts(5000);
		await proxy(new CountingEmbedder(), cache).embed(input);
		backdate();

		const spy = new SpyCache(cache);
		const fake = new CountingEmbedder();
		const result = await proxy(fake, spy).embed(input);

		expect(fake.calls).toBe(0);
		expect(result.cacheHits).toBe(5000);
		expect(spy.putManyCalls).toHaveLength(Math.ceil(5000 / WRITE_CHUNK));
		for (const call of spy.putManyCalls) {
			expect(call.entries).toBe(0);
			expect(call.touched).toBeLessThanOrEqual(WRITE_CHUNK);
			expect(call.touched).toBeGreaterThan(0);
		}
	});

	test("a cold batch chunks its ENTRIES too, and carries the learned dimension on the first slice only", async () => {
		const spy = new SpyCache(openCache());
		const fake = new CountingEmbedder();
		await proxy(fake, spy).embed(texts(600));

		const withEntries = spy.putManyCalls.filter((c) => c.entries > 0);
		expect(withEntries).toHaveLength(Math.ceil(600 / WRITE_CHUNK));
		for (const call of withEntries) {
			expect(call.entries).toBeLessThanOrEqual(WRITE_CHUNK);
		}
		expect(spy.putManyCalls.filter((c) => c.dims !== undefined)).toHaveLength(
			1,
		);
		expect(spy.putManyCalls[0]?.dims).toEqual({
			model: "nomic-embed-text",
			provider: "ollama",
			dimension: 8,
		});
	});

	test("a run with nothing to write touches the cache not at all", async () => {
		const spy = new SpyCache(openCache());
		await proxy(new CountingEmbedder(), spy).embed([]);
		expect(spy.putManyCalls).toEqual([]);
		expect(spy.evictCalls).toEqual([]);
	});
});

// ════════════════════════════════════════════════════════════════════════════
describe("CLAUDE.md #15 — a zero-length vector is never stored and never served", () => {
	test("an empty vector from the provider is NOT inserted (asserted on the bytes)", async () => {
		const cache = openCache();
		const fake = new CountingEmbedder({
			emptyAt: (_i, text) => text === "chunk-1" || text === "chunk-2",
		});
		await proxy(fake, cache).embed(texts(4));

		const rows = readRows();
		expect(rows).toHaveLength(2);
		for (const row of rows) {
			expect(row.blobLength).toBeGreaterThan(0);
			expect(row.bytes).toBe(row.dim * 4);
		}
		// And the skipped texts are genuinely absent, by key.
		for (const text of ["chunk-1", "chunk-2"]) {
			const key = embedCacheKey("nomic-embed-text", 8, text);
			expect(rows.some((r) => r.key === key)).toBe(false);
		}
	});

	test("a batch whose vectors are ALL empty leaves model_dims empty — the one writer rule", async () => {
		const cache = openCache();
		const fake = new CountingEmbedder({
			emptyAt: () => true,
			reportsDimension: false,
		});
		const result = await proxy(fake, cache).embed(texts(5));

		expect(result.embeddings.every((v) => v.length === 0)).toBe(true);
		expect(result.keys).toBeUndefined();
		// A dimension can ONLY enter from a real response vector. Nothing else
		// writes `model_dims`, anywhere, ever.
		expect(cache.knownDimension("nomic-embed-text", "ollama")).toBeUndefined();
		expect(readRows()).toHaveLength(0);
	});

	test("embedOne refuses an empty vector rather than returning one", async () => {
		const cache = openCache();
		const fake = new CountingEmbedder({ emptyAt: () => true });
		await expect(proxy(fake, cache).embedOne("anything")).rejects.toThrow(
			/empty embedding/i,
		);
	});
});

// ════════════════════════════════════════════════════════════════════════════
describe("the three vetoes, seen from the proxy", () => {
	test("a fingerprint mismatch is a miss, and the row is deleted", async () => {
		const cache = openCache();
		const input = texts(3);
		await proxy(new CountingEmbedder(), cache, {
			fingerprint: "trunc:32000",
		}).embed(input);
		expect(readRows()).toHaveLength(3);

		const fake = new CountingEmbedder();
		const result = await proxy(fake, cache, {
			fingerprint: "trunc:8192",
		}).embed(input);

		expect(fake.calls).toBe(1);
		expect(result.cacheHits).toBe(0);
		// The stale rows are gone and the fresh ones carry the new fingerprint.
		const rows = readRows();
		expect(rows).toHaveLength(3);
		expect(rows.every((r) => r.fingerprint === "trunc:8192")).toBe(true);
	});

	test("a row planted at the wrong width is a miss, is deleted, and is replaced", async () => {
		const cache = openCache();
		const key = embedCacheKey("nomic-embed-text", 8, "chunk-0");
		cache.putMany(
			[
				{
					key,
					model: "nomic-embed-text",
					provider: "ollama",
					dimension: 4,
					fingerprint: "",
					vector: [1, 2, 3, 4],
				},
			],
			[],
		);
		expect(readRows()).toHaveLength(1);

		const fake = new CountingEmbedder();
		const result = await proxy(fake, cache).embed(["chunk-0"]);
		expect(fake.calls).toBe(1);
		expect(result.cacheHits).toBe(0);
		const rows = readRows();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.dim).toBe(8);
		expect(rows[0]?.bytes).toBe(32);
	});

	test("two providers with one model name COEXIST — neither evicts the other", async () => {
		const cache = openCache();
		const input = texts(4);
		await proxy(
			new CountingEmbedder({ model: "nomic-embed-text", provider: "ollama" }),
			cache,
		).embed(input);
		await proxy(
			new CountingEmbedder({
				model: "nomic-embed-text",
				provider: "openrouter",
			}),
			cache,
		).embed(input);

		const rows = readRows();
		expect(rows).toHaveLength(8);
		expect(rows.filter((r) => r.provider === "ollama")).toHaveLength(4);
		expect(rows.filter((r) => r.provider === "openrouter")).toHaveLength(4);

		// Both are still served.
		const a = new CountingEmbedder({ provider: "ollama" });
		const b = new CountingEmbedder({ provider: "openrouter" });
		expect((await proxy(a, cache).embed(input)).cacheHits).toBe(4);
		expect((await proxy(b, cache).embed(input)).cacheHits).toBe(4);
		expect(a.calls).toBe(0);
		expect(b.calls).toBe(0);
	});
});

// ════════════════════════════════════════════════════════════════════════════
describe("Rule R — a dimension correction restarts the batch, at most once", () => {
	test("a stale model_dims is corrected, and the NEXT run hits", async () => {
		const cache = openCache();
		// Poison `model_dims` with a width this model does not produce.
		cache.recordDimension("nomic-embed-text", "ollama", 32);
		expect(cache.knownDimension("nomic-embed-text", "ollama")).toBe(32);

		const fake = new CountingEmbedder({ dim: 8, reportsDimension: false });
		const client = proxy(fake, cache);
		const first = await client.embed(texts(6));

		expect(client.stats().dimensionCorrections).toBe(1);
		expect(cache.knownDimension("nomic-embed-text", "ollama")).toBe(8);
		expect(first.embeddings.every((v) => v.length === 8)).toBe(true);

		const warmFake = new CountingEmbedder({ dim: 8, reportsDimension: false });
		const second = await proxy(warmFake, cache).embed(texts(6));
		expect(warmFake.calls).toBe(0);
		expect(second.cacheHits).toBe(6);
	});

	test("stale model_dims + 5 hits + 1 miss ⇒ SIX vectors of ONE width", async () => {
		const cache = openCache();
		const input = texts(6);

		// Plant five rows at the stale width, under keys that encode it, so the
		// scan HITS them and then discovers the true width from the sixth.
		const staleDim = 4;
		for (let i = 0; i < 5; i++) {
			const text = input[i] as string;
			cache.putMany(
				[
					{
						key: embedCacheKey("nomic-embed-text", staleDim, text),
						model: "nomic-embed-text",
						provider: "ollama",
						dimension: staleDim,
						fingerprint: "",
						vector: [0.1, 0.2, 0.3, 0.4],
					},
				],
				[],
			);
		}
		cache.recordDimension("nomic-embed-text", "ollama", staleDim);

		const fake = new CountingEmbedder({ dim: 8, reportsDimension: false });
		const client = proxy(fake, cache);
		const result = await client.embed(input);

		// THE PROPERTY FIRST, the counters second. Nothing downstream enforces
		// width homogeneity — `addChunks` inspects `data[0]` only — so whichever
		// width is first defines the Arrow column and every row of the other width
		// is handed to `table.add`. That is the CLAUDE.md #15 family of defect,
		// reached through the one array the contract treated as type-uniform.
		expect(result.embeddings).toHaveLength(6);
		const widths = new Set(result.embeddings.map((v) => v.length));
		expect([...widths]).toEqual([8]);
		expect(client.stats().dimensionCorrections).toBe(1);
		expect(client.stats().restarts).toBe(1);

		// No row may exist whose KEY encodes one dimension while its `dim` column
		// holds another — that is the shape that makes a cache permanently unusable.
		for (const row of readRows()) {
			const text = input.find(
				(t) => embedCacheKey(row.model, row.dim, t) === row.key,
			);
			expect(text).toBeDefined();
			expect(row.bytes).toBe(row.dim * 4);
		}
		// And the stale rows are gone: only the true width survives.
		expect(readRows().every((r) => r.dim === 8)).toBe(true);
	});

	test("a SECOND correction inside one batch throws rather than splicing two widths", async () => {
		const cache = openCache();
		const input = texts(4);
		const staleDim = 4;
		// Three rows at the stale width, so pass 1 has hits AND a miss. Rule R
		// evicts the hits, so pass 2 has to embed them — which is what gives the
		// client a second chance to change its mind about the width.
		for (let i = 0; i < 3; i++) {
			cache.putMany(
				[
					{
						key: embedCacheKey(
							"nomic-embed-text",
							staleDim,
							input[i] as string,
						),
						model: "nomic-embed-text",
						provider: "ollama",
						dimension: staleDim,
						fingerprint: "",
						vector: [0.1, 0.2, 0.3, 0.4],
					},
				],
				[],
			);
		}
		cache.recordDimension("nomic-embed-text", "ollama", staleDim);

		// Call 1 answers at width 8, call 2 (the restart) at width 16.
		const fake = new WidthShiftingEmbedder([8, 16], {
			dim: 8,
			reportsDimension: false,
		});
		await expect(proxy(fake, cache).embed(input)).rejects.toThrow(
			/dimension changed twice/i,
		);
		expect(fake.calls).toBe(2);
	});
});

// ════════════════════════════════════════════════════════════════════════════
describe("the total-failure downgrade", () => {
	test("5 cached + 1 total failure ⇒ 6 slots, 1 empty, NO throw", async () => {
		const cache = openCache();
		const input = texts(6);
		await proxy(new CountingEmbedder(), cache).embed(input.slice(0, 5));

		const fake = new CountingEmbedder({ failMode: "total" });
		const client = proxy(fake, cache);
		const result = await client.embed(input);

		expect(fake.calls).toBe(1);
		expect(result.embeddings).toHaveLength(6);
		expect(result.embeddings[5]).toEqual([]);
		for (let i = 0; i < 5; i++) {
			expect((result.embeddings[i] as number[]).length).toBe(8);
		}
		expect(result.warnings?.[0]).toMatch(/failed for all 1 texts/);
		expect(client.stats().downgrades).toBe(1);
	});

	test("0 cached + a total failure still THROWS — a cold batch is a genuine 100 %", async () => {
		const cache = openCache();
		const fake = new CountingEmbedder({ failMode: "total" });
		await expect(proxy(fake, cache).embed(texts(4))).rejects.toThrow(
			TotalEmbeddingFailureError,
		);
	});

	test("a 401 is NEVER downgraded, however many hits the batch has", async () => {
		const cache = openCache();
		const input = texts(6);
		await proxy(new CountingEmbedder(), cache).embed(input.slice(0, 5));

		const fake = new CountingEmbedder({ failMode: "fatal-401" });
		await expect(proxy(fake, cache).embed(input)).rejects.toThrow(/401/);
	});

	test("a downgraded batch still refreshes the LRU of the rows it served", async () => {
		const cache = openCache();
		const input = texts(6);
		await proxy(new CountingEmbedder(), cache).embed(input.slice(0, 5));
		const backdatedTo = backdate();

		await proxy(new CountingEmbedder({ failMode: "total" }), cache).embed(
			input,
		);

		expect(readRows().every((r) => r.last_used_at > backdatedTo)).toBe(true);
	});
});

// ════════════════════════════════════════════════════════════════════════════
describe("NFR-2 — the embedded text IS the item's content", () => {
	test("embedContentOf sends the items' content byte for byte", async () => {
		const cache = openCache();
		const fake = new CountingEmbedder();
		const items = [
			{ content: "export function a() {}", name: "a" },
			{ content: "  \n\t weird   bytes \n", name: "b" },
		];
		const result = await proxy(fake, cache).embedContentOf(items, "chunks");
		expect(fake.textsSeen).toEqual(items.map((i) => i.content));
		expect(result.embeddings).toHaveLength(2);
		// And the key is over that exact text.
		expect(result.keys?.[1]).toBe(
			embedCacheKey("nomic-embed-text", 8, items[1]?.content as string),
		);
	});

	test("the assertion fires when a transform is inserted between derivation and dispatch", () => {
		const contents = ["alpha", "beta"];
		expect(() =>
			assertEmbeddedTextIsChunkContent(contents, contents, "chunks"),
		).not.toThrow();
		expect(() =>
			assertEmbeddedTextIsChunkContent(
				contents.map((c) => `context: ${c}`),
				contents,
				"chunks",
			),
		).toThrow(EmbedCacheSoundnessError);
		expect(() =>
			assertEmbeddedTextIsChunkContent(["alpha"], contents, "code-units"),
		).toThrow(/1 texts for 2 items/);
	});
});

// ════════════════════════════════════════════════════════════════════════════
describe("the interface surface — all six members, plus keyFor", () => {
	test("getModel / getProvider / isLocal delegate verbatim", () => {
		const fake = new CountingEmbedder({
			model: "voyage-code-3",
			provider: "voyage",
			local: false,
		});
		const client = proxy(fake, openCache());
		expect(client.getModel()).toBe("voyage-code-3");
		expect(client.getProvider()).toBe("voyage");
		expect(client.isLocal()).toBe(false);
	});

	test("getDimension falls back to the width this model produced LAST time", async () => {
		const cache = openCache();
		await proxy(new CountingEmbedder(), cache).embed(texts(2));

		const fresh = new CountingEmbedder({ reportsDimension: false });
		expect(fresh.getDimension()).toBeUndefined();
		// The proxy answers without a network call — which is what makes a warm run
		// cost zero embedding calls.
		expect(proxy(fresh, cache).getDimension()).toBe(8);
		expect(fresh.calls).toBe(0);
	});

	test("embedOne is a second embedding entry point and it is CACHED", async () => {
		const cache = openCache();
		const cold = new CountingEmbedder();
		const vector = await proxy(cold, cache).embedOne("one text");
		expect(cold.calls).toBe(1);
		expect(vector).toHaveLength(8);

		const warm = new CountingEmbedder();
		const again = await proxy(warm, cache).embedOne("one text");
		expect(warm.calls).toBe(0);
		expectF32Equal(again, vector);
	});

	test("keyFor reproduces the key the proxy computed, and is empty without a dimension", async () => {
		const cache = openCache();
		const cold = proxy(
			new CountingEmbedder({ reportsDimension: false }),
			cache,
		);
		// Nothing known yet: no dimension, so no addressable key.
		expect(cold.keyFor("chunk-0")).toBe("");
		// An explicit width — the L1 path passes `vector.length`.
		expect(cold.keyFor("chunk-0", 8)).toBe(
			embedCacheKey("nomic-embed-text", 8, "chunk-0"),
		);
		// `=== 0`, never truthiness.
		expect(cold.keyFor("chunk-0", 0)).toBe("");

		const result = await proxy(new CountingEmbedder(), cache).embed(texts(3));
		const warm = proxy(
			new CountingEmbedder({ reportsDimension: false }),
			cache,
		);
		expect(warm.keyFor("chunk-2")).toBe(result.keys?.[2]);
	});
});

// ════════════════════════════════════════════════════════════════════════════
describe("tiers, degradation and the opt-out", () => {
	test('mode "off" is a pass-through: no cache, no keys, tier "none"', async () => {
		const cache = new SpyCache(openCache());
		const fake = new CountingEmbedder();
		const client = proxy(fake, cache, { mode: "off" });

		const result = await client.embed(texts(4));
		expect(fake.calls).toBe(1);
		expect(result.keys).toBeUndefined();
		expect(result.cacheHits).toBeUndefined();
		expect(cache.getCalls).toBe(0);
		expect(cache.putManyCalls).toEqual([]);
		expect(client.stats().tier).toBe("none");
		expect(readRows()).toHaveLength(0);
	});

	test("MNEMEX_DISABLE_EMBED_CACHE=1 reaches the factory", async () => {
		// Opened FIRST: `openEmbedCache` itself refuses under the opt-out, so this
		// pins the factory's own read rather than the open path's.
		const spy = new SpyCache(openCache());
		process.env.MNEMEX_DISABLE_EMBED_CACHE = "1";
		const client = createCachingEmbeddingsClient(new CountingEmbedder(), {
			cache: spy,
			clientFingerprint: "",
		});
		await client.embed(texts(3));
		expect(client.stats().mode).toBe("off");
		expect(client.stats().tier).toBe("none");
		expect(spy.putManyCalls).toEqual([]);
	});

	test('a null cache handle degrades to tier "l0" and still reuses WITHIN the run', async () => {
		const fake = new CountingEmbedder();
		const client = proxy(fake, null);
		expect(client.stats().tier).toBe("l0");

		await client.embed(["a", "b"]);
		expect(fake.calls).toBe(1);
		// Second batch: same texts, no persistent store, but L0 covers it.
		const second = await client.embed(["a", "b", "c"]);
		expect(fake.batches[1]).toEqual(["c"]);
		expect(second.cacheHits).toBe(2);
		expect(second.embeddings).toHaveLength(3);
	});

	test("the L0 budget is honoured, and a budget of 0 disables it", async () => {
		const fake = new CountingEmbedder({ dim: 8 });
		// 8 floats * 8 bytes = 64 bytes per vector; 128 bytes holds two.
		const small = proxy(fake, null, { memoryBudgetBytes: 128 });
		await small.embed(texts(10));
		expect(small.memoSizeForTests()).toBeLessThanOrEqual(2);

		const none = proxy(new CountingEmbedder(), null, { memoryBudgetBytes: 0 });
		await none.embed(texts(4));
		expect(none.memoSizeForTests()).toBe(0);
	});
});

// ════════════════════════════════════════════════════════════════════════════
describe("ProgressTicker", () => {
	function record() {
		const calls: Array<
			[number, number, number | undefined, number | undefined]
		> = [];
		return {
			calls,
			cb: (c: number, t: number, ip?: number, hits?: number) => {
				calls.push([c, t, ip, hits]);
			},
		};
	}

	test("advance coalesces at everyItems and reports the hit count", () => {
		const { calls, cb } = record();
		const ticker = new ProgressTicker(cb, 200, 64, 10_000);
		for (let i = 1; i <= 192; i++) ticker.advance(i, i);
		// One emit per 64 CALLS — which is one per bounded region, guarantee 2.
		expect(calls.map(([c]) => c)).toEqual([64, 128, 192]);
		expect(calls[2]).toEqual([192, 200, undefined, 192]);
	});

	test("advance emits on ELAPSED TIME even when the reported number does not move", () => {
		const { calls, cb } = record();
		// everyItems far beyond the loop; everyMs of 0 makes every call due.
		const ticker = new ProgressTicker(cb, 100, 10_000, 0);
		for (let i = 0; i < 3; i++) ticker.advance(0, 0);
		expect(calls).toHaveLength(3);
		expect(calls.every(([c]) => c === 0)).toBe(true);
	});

	test("completed is monotonic: a Rule R restart plateaus, it never rewinds", () => {
		const { calls, cb } = record();
		const ticker = new ProgressTicker(cb, 100, 1, 10_000);
		ticker.advance(40, 40);
		ticker.advance(10, 10); // the restart re-walks ground already reported
		ticker.advance(45, 45);
		expect(calls.map(([c]) => c)).toEqual([40, 40, 45]);
		// ...and the stamps kept coming while it plateaued, which is the point.
		expect(calls).toHaveLength(3);
	});

	test("final is idempotent and does not double-emit the terminal value", () => {
		const { calls, cb } = record();
		const ticker = new ProgressTicker(cb, 10, 64, 10_000);
		ticker.forward(10, 0, 0);
		expect(calls).toHaveLength(1);
		ticker.settle();
		ticker.final();
		ticker.final();
		expect(calls).toHaveLength(1);
		expect(ticker.isFinished).toBe(true);
	});

	test("final emits on a batch that never reached the end, at the count actually reached", () => {
		const { calls, cb } = record();
		const ticker = new ProgressTicker(cb, 100, 64, 10_000);
		ticker.advance(1, 1);
		expect(calls).toHaveLength(0); // below the coalescing threshold
		ticker.final();
		expect(calls).toHaveLength(1);
		// NOT 100: a batch that threw half-way did not complete, and saying it did
		// would lie to the mechanism that decides whether this process still holds
		// its lock.
		expect(calls[0]?.[0]).toBe(1);
		expect(calls[0]?.[1]).toBe(100);
	});

	test("a throw from the inner client still reaches the terminal stamp", async () => {
		const cache = openCache();
		const { calls, cb } = record();
		const fake = new CountingEmbedder({ failMode: "fatal-401" });
		await expect(proxy(fake, cache).embed(texts(4), cb)).rejects.toThrow(/401/);
		// The ticker lives in a `finally`, so the lock is stamped even here.
		expect(calls.length).toBeGreaterThan(0);
		expect(calls.at(-1)?.[1]).toBe(4);
	});

	test("PROGRESS_TICK_MS stays inside DEFAULT_PROGRESS_TIMEOUT / 100 (§6.3 C)", () => {
		// Read from lock.ts's SOURCE: the constant is what the bound is derived
		// from, and an edit there must fail here rather than silently re-base it.
		const source = require("node:fs").readFileSync(
			join(import.meta.dir, "..", "..", "..", "src", "core", "lock.ts"),
			"utf8",
		) as string;
		const match = /const\s+DEFAULT_PROGRESS_TIMEOUT\s*=\s*(\d+)/.exec(source);
		const progressTimeout = Number(match?.[1]);
		expect(progressTimeout).toBe(300000);
		expect(PROGRESS_TICK_MS).toBeLessThanOrEqual(progressTimeout / 100);
		expect(PROGRESS_TICK_ITEMS).toBe(64);
	});
});
