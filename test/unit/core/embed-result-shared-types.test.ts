/**
 * The seam's two extra result fields and the progress callback's 4th parameter
 * now live on `src/types.ts`, not in `caching-embeddings-client.ts`.
 *
 * Phase 2 declared them locally (`CachedEmbedResult extends EmbedResult`, and a
 * private `CacheAwareProgressCallback`) so that a pure-addition phase would not
 * have to touch a tracked file. Phase 3+4 moved them onto the shared types and
 * left the local names as aliases. This file pins the move itself, which is a
 * different claim from anything the Phase 2 suite asserts: that suite would
 * still be green if the fields had stayed local forever.
 *
 * TWO KINDS OF ASSERTION, because neither alone can see the whole claim.
 *
 *  - RUNTIME, for the values: `cacheHits`, `keys` and the callback's 4th
 *    argument are asserted against a counting fake, so the numbers are real.
 *    These cannot see WHERE the type is declared — the object carries the
 *    fields either way.
 *  - SOURCE, for the declaration: the last `describe` reads `src/types.ts` and
 *    `src/core/caching-embeddings-client.ts` and asserts the fields are
 *    declared on the shared types and no longer re-declared locally. This is
 *    the only assertion that can fail if the move is reverted.
 *
 * The bindings below are annotated with types imported from `src/types.js`,
 * which reads like a compile-time proof but is NOT one here: `tsconfig.json`
 * includes `src/**` only, so `bun run typecheck` never sees this file and bun
 * strips the annotations without checking them. Stated explicitly so the
 * annotations are not mistaken for a gate they do not reach — that is why the
 * source assertions exist.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCachingEmbeddingsClient } from "../../../src/core/caching-embeddings-client.js";
import {
	openEmbedCache,
	resetEmbedCacheForTests,
	resolveEmbedCacheMode,
} from "../../../src/core/embed-cache.js";
import type {
	EmbeddingProgressCallback,
	EmbeddingProvider,
	EmbedResult,
	GlobalConfig,
	IEmbeddingsClient,
} from "../../../src/types.js";

const DIM = 4;

/** Minimal provider stand-in with a real call counter. */
class TinyEmbedder implements IEmbeddingsClient {
	calls = 0;

	async embed(
		texts: string[],
		onProgress?: EmbeddingProgressCallback,
	): Promise<EmbedResult> {
		this.calls++;
		const embeddings = texts.map((t, i) =>
			Array.from({ length: DIM }, (_, d) => (t.length + i + d) / 100 + 0.01),
		);
		onProgress?.(texts.length, texts.length, 0);
		return { embeddings, totalTokens: texts.length };
	}
	async embedOne(text: string): Promise<number[]> {
		return (await this.embed([text])).embeddings[0];
	}
	getModel(): string {
		return "tiny-embed";
	}
	getDimension(): number | undefined {
		return DIM;
	}
	getProvider(): EmbeddingProvider {
		return "ollama";
	}
	isLocal(): boolean {
		return true;
	}
}

let dir: string;
let dbPath: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "mnemex-shared-types-"));
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

function proxyOver(inner: IEmbeddingsClient) {
	const cache = openEmbedCache(dbPath);
	expect(cache).not.toBeNull();
	return createCachingEmbeddingsClient(inner, {
		cache,
		clientFingerprint: "",
	});
}

const TEXTS = ["alpha", "beta", "gamma"];

describe("EmbedResult carries keys and cacheHits", () => {
	test("a warm call reports both, read through the SHARED EmbedResult type", async () => {
		const inner = new TinyEmbedder();

		// Cold: fills the cache.
		const cold: EmbedResult = await proxyOver(inner).embed(TEXTS);
		expect(inner.calls).toBe(1);
		expect(cold.keys).toHaveLength(TEXTS.length);
		expect(cold.cacheHits).toBe(0);

		// Warm: the provider is not called at all.
		const warm: EmbedResult = await proxyOver(inner).embed(TEXTS);
		expect(inner.calls).toBe(1);
		expect(warm.cacheHits).toBe(TEXTS.length);
		expect(warm.keys).toEqual(cold.keys);
	});

	test("the keys are per-slot in input order and address distinct texts", async () => {
		const result: EmbedResult = await proxyOver(new TinyEmbedder()).embed(
			TEXTS,
		);
		const keys = result.keys ?? [];
		expect(keys).toHaveLength(3);
		expect(new Set(keys).size).toBe(3);
		for (const key of keys) expect(key).toMatch(/^[0-9a-f]{64}$/);
	});

	/**
	 * `cost` and `totalTokens` fall to 0 on a warm run, which reads as a bug.
	 * `cacheHits` is what says otherwise, so it must be present on the same
	 * object those two live on — the shared type — rather than on a wrapper only
	 * the cache module knows about.
	 */
	test("a warm run shows zero provider usage BESIDE a non-zero hit count", async () => {
		const inner = new TinyEmbedder();
		await proxyOver(inner).embed(TEXTS);

		const warm: EmbedResult = await proxyOver(inner).embed(TEXTS);
		expect(warm.totalTokens ?? 0).toBe(0);
		expect(warm.cacheHits).toBe(TEXTS.length);
	});
});

describe("EmbeddingProgressCallback's 4th parameter", () => {
	test("a callback typed from src/types.js receives cachedHits", async () => {
		const inner = new TinyEmbedder();
		await proxyOver(inner).embed(TEXTS);

		const seen: Array<number | undefined> = [];
		// Annotated with the SHARED type: a 4-parameter function is only
		// assignable here because the shared type declares the 4th parameter.
		const onProgress: EmbeddingProgressCallback = (
			_completed,
			_total,
			_inProgress,
			cachedHits,
		) => {
			seen.push(cachedHits);
		};

		await proxyOver(inner).embed(TEXTS, onProgress);

		expect(seen.length).toBeGreaterThan(0);
		expect(Math.max(...seen.map((v) => v ?? 0))).toBe(TEXTS.length);
	});

	test("an existing 3-parameter callback is still assignable and still fires", async () => {
		const seen: Array<[number, number]> = [];
		const onProgress: EmbeddingProgressCallback = (completed, total) => {
			seen.push([completed, total]);
		};

		await proxyOver(new TinyEmbedder()).embed(TEXTS, onProgress);
		expect(seen.length).toBeGreaterThan(0);
		expect(seen[seen.length - 1][1]).toBe(TEXTS.length);
	});
});

describe("GlobalConfig.embedCache", () => {
	/**
	 * The field is read with `=== false`, never for falsiness: an ABSENT field
	 * means "untouched", not "off" (CLAUDE.md #25/#29's rule, applied to the one
	 * new config key this feature adds).
	 */
	test("false turns the cache off; absent and true leave it on", () => {
		const off: GlobalConfig = { excludePatterns: [], embedCache: false };
		const on: GlobalConfig = { excludePatterns: [], embedCache: true };
		const untouched: GlobalConfig = { excludePatterns: [] };

		expect(resolveEmbedCacheMode(off.embedCache)).toBe("off");
		expect(resolveEmbedCacheMode(on.embedCache)).toBe("persistent");
		expect(resolveEmbedCacheMode(untouched.embedCache)).toBe("persistent");
	});

	test("with embedCache false the provider is called on every run", async () => {
		const inner = new TinyEmbedder();
		const config: GlobalConfig = { excludePatterns: [], embedCache: false };

		for (let i = 0; i < 2; i++) {
			const cache = openEmbedCache(dbPath);
			const client = createCachingEmbeddingsClient(inner, {
				cache,
				configEnabled: config.embedCache,
				clientFingerprint: "",
			});
			const result: EmbedResult = await client.embed(TEXTS);
			expect(result.cacheHits ?? 0).toBe(0);
		}

		expect(inner.calls).toBe(2);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// The declaration itself — source, not runtime
// ════════════════════════════════════════════════════════════════════════════

/**
 * `CachedEmbedResult` and `CacheAwareProgressCallback` are TYPES. They are
 * erased before anything runs, so no runtime assertion above can tell a shared
 * declaration from a re-declared local one. This reads the source and executes
 * none of it.
 *
 * Same technique, and same reason, as `embed-cache-imports.test.ts`: a rule
 * about where a declaration lives can only be enforced by looking at where it
 * is written.
 */
describe("the declarations live on the shared types", () => {
	const SRC = join(import.meta.dir, "..", "..", "..", "src");
	const types = readFileSync(join(SRC, "types.ts"), "utf-8");
	const proxy = readFileSync(
		join(SRC, "core", "caching-embeddings-client.ts"),
		"utf-8",
	);

	/** Body of a named `interface` / `type` block, comments and all. */
	function block(source: string, header: RegExp): string {
		const start = source.search(header);
		expect(start).toBeGreaterThanOrEqual(0);
		const rest = source.slice(start);
		const end = rest.indexOf("\n}");
		expect(end).toBeGreaterThan(0);
		return rest.slice(0, end);
	}

	test("EmbedResult declares keys and cacheHits", () => {
		const body = block(types, /export interface EmbedResult \{/);
		expect(body).toContain("keys?: string[];");
		expect(body).toContain("cacheHits?: number;");
	});

	test("EmbeddingProgressCallback declares the 4th cachedHits parameter", () => {
		const body = block(types, /export type EmbeddingProgressCallback = \(/);
		expect(body).toContain("cachedHits?: number,");
		// Order matters: the new parameter is LAST and optional, which is what
		// keeps every existing 3-parameter callback assignable.
		expect(body.indexOf("inProgress?: number,")).toBeLessThan(
			body.indexOf("cachedHits?: number,"),
		);
	});

	test("GlobalConfig declares embedCache", () => {
		const body = block(types, /export interface GlobalConfig \{/);
		expect(body).toContain("embedCache?: boolean;");
	});

	test("ChunkWithEmbedding and CodeUnitWithEmbedding declare embedKey", () => {
		expect(
			block(types, /export interface ChunkWithEmbedding extends CodeChunk \{/),
		).toContain("embedKey?: string;");
		expect(
			block(
				types,
				/export interface CodeUnitWithEmbedding extends CodeUnit \{/,
			),
		).toContain("embedKey?: string;");
	});

	/**
	 * The Phase 2 names survive as ALIASES so no call site had to change. What
	 * must not survive is a second declaration of the fields: two places to edit
	 * is how the seam and the store column drift apart.
	 */
	test("the proxy aliases the Phase 2 names instead of re-declaring them", () => {
		expect(proxy).toContain("export type CachedEmbedResult = EmbedResult;");
		expect(proxy).toContain(
			"export type CacheAwareProgressCallback = EmbeddingProgressCallback;",
		);
		expect(proxy).not.toContain("interface CachedEmbedResult");
	});

	test("the proxy declares neither field body of its own", () => {
		// Comments in this module legitimately MENTION the field names, so the
		// match is on a declaration, not on the words.
		expect(proxy).not.toMatch(/^\s*keys\?: string\[\];\s*$/m);
		expect(proxy).not.toMatch(/^\s*cacheHits\?: number;\s*$/m);
		expect(proxy).not.toMatch(/^\s*cachedHits\?: number,\s*$/m);
	});
});
