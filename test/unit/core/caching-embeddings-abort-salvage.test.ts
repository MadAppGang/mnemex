/**
 * Iteration 2, O3 — an ABORTED call's answered prefix is counted AND cached.
 *
 * A budget cut aborts the overlay's embed batch in flight. `OllamaEmbeddingsClient`
 * sends one request per text, so by the time the abort lands the provider has
 * already answered a prefix of the batch. Before: the rejection dropped those
 * vectors — `accepted` (hence `overlay_embedded`) read short of the wire by up
 * to 63 per cut pass, and nothing was written to the cache, so the NEXT pass
 * sent the same texts again.
 *
 *   O3-1  an inner client answers 5 of 8 texts through `onAnswered`, then the
 *         call is aborted: `accepted` rises by 5, the temp-path cache holds 5
 *         rows (asserted on the sqlite FILE with an independent connection,
 *         never on `stats()`), the rejection propagates, and the next call
 *         sends only the 3 unanswered texts (counted at the inner client)
 *   O3-1b a rejection that is NOT an abort salvages nothing (today's rule)
 *   O3-1c without a signal the inner client receives exactly the caller's
 *         options (the indexing path is unchanged)
 *   O3-1d unknown width: counted, nothing written
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CachingEmbeddingsClient } from "../../../src/core/caching-embeddings-client.js";
import {
	type EmbedCache,
	openEmbedCache,
	resetEmbedCacheForTests,
} from "../../../src/core/embed-cache.js";
import { createDatabaseSync } from "../../../src/core/sqlite.js";
import type {
	EmbedCallOptions,
	EmbeddingProvider,
	EmbedResult,
	IEmbeddingsClient,
} from "../../../src/types.js";

const DIM = 8;

let dir: string;
let dbPath: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "abort-salvage-"));
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

function vectorFor(text: string): number[] {
	let h = 2166136261;
	for (let i = 0; i < text.length; i++) {
		h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
	}
	return Array.from({ length: DIM }, (_, i) => {
		h = Math.imul(h ^ (i + 1), 16777619) >>> 0;
		return (h % 20001) / 10000 - 1;
	});
}

/**
 * A provider that answers one text at a time, like Ollama. `abortAfter`: once
 * that many texts of a call were answered, it aborts the caller's controller
 * (the overlay's budget timer firing) and rejects the way the real clients do.
 * Every text it was SENT is recorded: the counter the assertions trust.
 */
class OneAtATimeProvider implements IEmbeddingsClient {
	readonly sent: string[] = [];
	readonly optionsSeen: Array<EmbedCallOptions | undefined> = [];
	abortAfter: number | null = null;
	controller: AbortController | null = null;
	failWithoutAbortAfter: number | null = null;

	constructor(private readonly knowsWidth = true) {}

	async embed(
		texts: string[],
		_onProgress?: unknown,
		options?: EmbedCallOptions,
	): Promise<EmbedResult> {
		this.optionsSeen.push(options);
		const out: number[][] = [];
		for (let i = 0; i < texts.length; i++) {
			if (this.abortAfter !== null && i === this.abortAfter) {
				this.controller?.abort(new Error("rebuild budget reached"));
				throw options?.signal?.reason ?? new Error("aborted");
			}
			if (
				this.failWithoutAbortAfter !== null &&
				i === this.failWithoutAbortAfter
			) {
				throw new Error("connection reset");
			}
			const text = texts[i] as string;
			this.sent.push(text);
			const vector = vectorFor(text);
			out.push(vector);
			options?.onAnswered?.(i, vector);
		}
		return { embeddings: out };
	}
	async embedOne(text: string): Promise<number[]> {
		return vectorFor(text);
	}
	getModel(): string {
		return "nomic-embed-text";
	}
	getDimension(): number | undefined {
		return this.knowsWidth ? DIM : undefined;
	}
	getProvider(): EmbeddingProvider {
		return "ollama";
	}
	isLocal(): boolean {
		return true;
	}
}

function openCache(): EmbedCache {
	const cache = openEmbedCache(dbPath);
	if (cache === null) throw new Error("openEmbedCache returned null");
	return cache;
}

function client(inner: IEmbeddingsClient, cache: EmbedCache) {
	return new CachingEmbeddingsClient({
		inner,
		cache,
		mode: "persistent",
		clientFingerprint: "",
	});
}

/** Rows on disk, read with an INDEPENDENT connection. */
function rowsOnDisk(): Array<{ key: string; dim: number; blobLength: number }> {
	const db = createDatabaseSync(dbPath);
	try {
		return db
			.prepare(
				"SELECT key, dim, length(vector) AS blobLength FROM embeddings ORDER BY key",
			)
			.all() as Array<{ key: string; dim: number; blobLength: number }>;
	} finally {
		db.close();
	}
}

const TEXTS = Array.from({ length: 8 }, (_, i) => `text-${i}`);

describe("O3-1 — an aborted call's answered prefix is counted and cached", () => {
	test("5 of 8 answered, then aborted: accepted +5, 5 rows on disk, the rejection propagates, the next call sends only 3", async () => {
		const cache = openCache();
		const provider = new OneAtATimeProvider();
		const c = client(provider, cache);
		const controller = new AbortController();
		provider.controller = controller;
		provider.abortAfter = 5;

		const before = c.stats().accepted;
		let rejected: unknown = null;
		try {
			await c.embed(TEXTS, undefined, { signal: controller.signal });
		} catch (err) {
			rejected = err;
		}

		expect(rejected).toBeInstanceOf(Error);
		expect((rejected as Error).message).toBe("rebuild budget reached");
		expect(provider.sent).toEqual(TEXTS.slice(0, 5));
		expect(c.stats().accepted - before).toBe(5);
		// The bytes on disk, not a self-report.
		const rows = rowsOnDisk();
		expect(rows).toHaveLength(5);
		for (const row of rows) {
			expect(row.dim).toBe(DIM);
			expect(row.blobLength).toBe(DIM * 4);
		}

		// The next pass: nothing already answered is re-sent.
		provider.abortAfter = null;
		provider.sent.length = 0;
		const next = await c.embed(TEXTS, undefined, {
			signal: new AbortController().signal,
		});
		expect(provider.sent).toEqual(TEXTS.slice(5));
		expect(next.cacheHits).toBe(5);
		expect(next.embeddings.map((v) => v.length)).toEqual(
			new Array(8).fill(DIM),
		);
		expect(next.embeddings[0]).toEqual(vectorFor("text-0"));
		cache.close();
	});

	test("O3-1b: a rejection that is NOT an abort salvages nothing", async () => {
		const cache = openCache();
		const provider = new OneAtATimeProvider();
		const c = client(provider, cache);
		provider.failWithoutAbortAfter = 5;
		await expect(
			c.embed(TEXTS, undefined, { signal: new AbortController().signal }),
		).rejects.toThrow("connection reset");
		expect(c.stats().accepted).toBe(0);
		expect(rowsOnDisk()).toHaveLength(0);
		cache.close();
	});

	test("O3-1c: with no signal the inner client receives the caller's options untouched", async () => {
		const cache = openCache();
		const provider = new OneAtATimeProvider();
		const c = client(provider, cache);
		await c.embed(["a-1", "a-2"]);
		const opts = { maxAttempts: 2 };
		await c.embed(["b-1"], undefined, opts);
		expect(provider.optionsSeen[0]).toBeUndefined();
		expect(provider.optionsSeen[1]).toBe(opts);
		cache.close();
	});

	test("O3-1d: an unknown width — counted, nothing written", async () => {
		const cache = openCache();
		const provider = new OneAtATimeProvider(false);
		const c = client(provider, cache);
		const controller = new AbortController();
		provider.controller = controller;
		provider.abortAfter = 3;
		await expect(
			c.embed(TEXTS, undefined, { signal: controller.signal }),
		).rejects.toThrow("rebuild budget reached");
		expect(c.stats().accepted).toBe(3);
		expect(rowsOnDisk()).toHaveLength(0);
		cache.close();
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Outer review 2.
//
//   O3-3a  MEDIUM 1: with the cache OFF, `accepted` still counts what the
//          provider answered — on a completed call and on an aborted one.
//          Shipped: the opt-out returned `inner.embed` directly, so
//          `overlay_embedded` read 0 under `"embedCache": false`.
//   O3-3b  MEDIUM 2: a caller's `onAnswered` index is into the CALLER's
//          `texts`, with a cache hit ahead of the misses — with and without a
//          signal. Shipped: the miss-relative index was forwarded.
//   O3-3c  LOW 3: an aborted call counts its phase-1 hits and its answered
//          misses, so `misses - accepted` is still what the provider refused.
// ════════════════════════════════════════════════════════════════════════════

function offClient(inner: IEmbeddingsClient) {
	return new CachingEmbeddingsClient({
		inner,
		cache: null,
		mode: "off",
		clientFingerprint: "",
	});
}

describe("outer review 2 — the caching client's counts and indices", () => {
	test("O3-3a: cache OFF — a completed call counts every answered text", async () => {
		const provider = new OneAtATimeProvider();
		const c = offClient(provider);
		const result = await c.embed(TEXTS.slice(0, 3), undefined, {
			signal: new AbortController().signal,
		});
		expect(provider.sent).toEqual(TEXTS.slice(0, 3));
		expect(result.embeddings).toHaveLength(3);
		expect(c.stats().mode).toBe("off");
		expect(c.stats().accepted).toBe(provider.sent.length);
		// No options at all (the indexing shape): still counted, options untouched.
		await c.embed(["x-1", "x-2"]);
		expect(provider.optionsSeen[1]).toBeUndefined();
		expect(c.stats().accepted).toBe(provider.sent.length);
	});

	test("O3-3a: cache OFF — an aborted call counts its answered prefix and still rejects", async () => {
		const provider = new OneAtATimeProvider();
		const c = offClient(provider);
		const controller = new AbortController();
		provider.controller = controller;
		provider.abortAfter = 4;
		await expect(
			c.embed(TEXTS, undefined, { signal: controller.signal }),
		).rejects.toThrow("rebuild budget reached");
		expect(provider.sent).toHaveLength(4);
		expect(c.stats().accepted).toBe(4);
		// A rejection that is NOT an abort still counts nothing.
		const other = new OneAtATimeProvider();
		const c2 = offClient(other);
		other.failWithoutAbortAfter = 2;
		await expect(
			c2.embed(TEXTS, undefined, { signal: new AbortController().signal }),
		).rejects.toThrow("connection reset");
		expect(c2.stats().accepted).toBe(0);
	});

	test("O3-3a: cache OFF — a refused (empty) answer is not accepted", async () => {
		const refusing: IEmbeddingsClient = {
			...new OneAtATimeProvider(),
			async embed(texts: string[]) {
				return {
					embeddings: texts.map((t, i) => (i === 1 ? [] : vectorFor(t))),
				};
			},
			getModel: () => "nomic-embed-text",
			getDimension: () => DIM,
			getProvider: () => "ollama",
			isLocal: () => true,
			embedOne: async (t: string) => vectorFor(t),
		};
		const c = offClient(refusing);
		await c.embed(["r-0", "r-1", "r-2"]);
		expect(c.stats().accepted).toBe(2);
	});

	for (const withSignal of [true, false]) {
		test(`O3-3b: onAnswered's index is into the caller's texts, one hit ahead of two misses (signal: ${withSignal})`, async () => {
			const cache = openCache();
			const provider = new OneAtATimeProvider();
			const c = client(provider, cache);
			await c.embed(["a"]); // "a" is now a hit
			provider.sent.length = 0;
			const texts = ["a", "b", "c"];
			const seen: Array<{ index: number; text: string | undefined }> = [];
			await c.embed(texts, undefined, {
				...(withSignal ? { signal: new AbortController().signal } : {}),
				onAnswered: (index, vector) => {
					// Which text this vector was computed from — independently.
					const text = texts.find(
						(t) => JSON.stringify(vectorFor(t)) === JSON.stringify([...vector]),
					);
					seen.push({ index, text });
				},
			});
			expect(provider.sent).toEqual(["b", "c"]);
			expect(seen).toEqual([
				{ index: 1, text: "b" },
				{ index: 2, text: "c" },
			]);
			for (const s of seen) expect(texts[s.index]).toBe(s.text);
			cache.close();
		});
	}

	test("O3-3c: an aborted call counts its hits and its answered misses", async () => {
		const cache = openCache();
		const provider = new OneAtATimeProvider();
		const c = client(provider, cache);
		await c.embed(TEXTS.slice(0, 2)); // two hits for the next call
		const before = c.stats();
		const controller = new AbortController();
		provider.controller = controller;
		provider.abortAfter = 3; // 3 of the 6 misses answered
		await expect(
			c.embed(TEXTS, undefined, { signal: controller.signal }),
		).rejects.toThrow("rebuild budget reached");
		const after = c.stats();
		expect(after.hits - before.hits).toBe(2);
		expect(after.misses - before.misses).toBe(3);
		expect(after.accepted - before.accepted).toBe(3);
		expect(after.misses - after.accepted).toBe(0); // nothing refused
		cache.close();
	});
});
