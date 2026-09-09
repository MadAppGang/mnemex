/**
 * What the indexer actually WRITES once the embedding cache is wired in.
 *
 * Run by ../indexer-embed-cache.test.ts in its own process — see that file for
 * why (`mock.module` replaces the module registry for the whole process and
 * outlives the file that called it).
 *
 * Everything here is REAL except the embeddings provider: a real LanceDB store,
 * a real SQLite file tracker, the real tree-sitter chunker, the real
 * `EmbedCache` on a redirected path, and the real `CachingEmbeddingsClient`.
 * That is deliberate — every assertion below is about ROWS IN THE STORE, and a
 * faked store cannot answer that question. CLAUDE.md's standing rule is that a
 * report object cannot show what happened; `filesDeferred` and
 * `stats().hits` are reports, and each one of these properties has a shape
 * where the report can be right while the disk is wrong.
 *
 * The provider is faked because it is the only thing that would otherwise need
 * a network, and because two of these tests need it to fail on command.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import { exitUnlessSandboxed } from "../../../helpers/sandbox-guard.js";

// The global config is read by `index()` to resolve `GlobalConfig.embedCache`.
// A real `~/.mnemex/config.json` with `embedCache: false` would silently turn
// this whole suite into a no-cache run that still passed some of it, so the
// child refuses to start unless HOME is provably a temp directory.
exitUnlessSandboxed(homedir(), process.env.MNEMEX_TEST_SANDBOX_HOME, tmpdir());

import type {
	EmbeddingProvider,
	EmbedResult,
	IEmbeddingsClient,
} from "../../../../src/types.js";

// ── The fake provider, and the switches the tests drive it with ─────────────

/** Vector width every fake embedding has. */
const DIM = 8;

/** Deterministic, so the same text always yields the same vector. */
function vectorFor(text: string): number[] {
	let h = 2166136261;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	const out: number[] = [];
	for (let i = 0; i < DIM; i++) {
		h = Math.imul(h ^ (h >>> 15), 2246822519);
		out.push(((h >>> 8) % 20000) / 10000 - 1);
	}
	return out;
}

/** Every batch the fake provider was asked to embed, in order. */
let embedBatches: string[][] = [];
/** "ok" embeds; "total-failure" throws the class the seam recognises. */
let providerMode: "ok" | "total-failure" = "ok";
/** Every (model, provider) a client was built for. */
let clientsBuiltFor: Array<{ model?: string; provider?: EmbeddingProvider }> =
	[];

const realEmbeddings = await import("../../../../src/core/embeddings.js");
const { TotalEmbeddingFailureError } = await import(
	"../../../../src/core/embeddings-errors.js"
);

mock.module("../../../../src/core/embeddings.js", () => ({
	...realEmbeddings,
	// `embeddingTextFingerprint` is deliberately NOT faked: the indexer computes
	// the cache's third veto with it, and a stubbed one would make the veto
	// vacuous in exactly the tests meant to exercise it.
	createEmbeddingsClient: (options?: {
		model?: string;
		provider?: EmbeddingProvider;
	}): IEmbeddingsClient => {
		clientsBuiltFor.push({
			model: options?.model,
			provider: options?.provider,
		});
		const model = options?.model ?? "fake-model";
		const provider: EmbeddingProvider = options?.provider ?? "openrouter";
		return {
			getModel: () => model,
			getProvider: () => provider,
			// Undefined, like a real client that has not made a call yet — which is
			// what forces the dimension to come from the cache's `model_dims` row
			// on a warm run, with no network call at all.
			getDimension: () => undefined,
			isLocal: () => false,
			async embed(texts, onProgress): Promise<EmbedResult> {
				embedBatches.push([...texts]);
				if (providerMode === "total-failure") {
					throw new TotalEmbeddingFailureError(
						provider,
						texts.length,
						"simulated provider outage",
					);
				}
				onProgress?.(texts.length, texts.length);
				return { embeddings: texts.map(vectorFor) };
			},
			async embedOne(text): Promise<number[]> {
				embedBatches.push([text]);
				return vectorFor(text);
			},
		};
	},
	testModelAvailability: async () => ({ ok: true }),
}));

// Imported AFTER the mock so the indexer binds the fake.
const { createIndexer } = await import("../../../../src/core/indexer.js");
const { CachingEmbeddingsClient } = await import(
	"../../../../src/core/caching-embeddings-client.js"
);
const { embedCacheKey, openEmbedCache } = await import(
	"../../../../src/core/embed-cache.js"
);
const { chunkFileByPath } = await import("../../../../src/core/chunker.js");
const { getParserManager } = await import(
	"../../../../src/parsers/parser-manager.js"
);
const { createVectorStore } = await import("../../../../src/core/store.js");
const { getVectorStorePath } = await import("../../../../src/config.js");

// ── Fixture ─────────────────────────────────────────────────────────────────

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

/** A source file of `count` independent functions — one chunk each. */
function sourceWithFunctions(count: number, salt = ""): string {
	const parts: string[] = [];
	for (let i = 0; i < count; i++) {
		parts.push(
			`export function fn${i}${salt}(a: number, b: number): number {\n` +
				`\tconst r${i} = a * ${i} + b;\n` +
				`\treturn r${i};\n}\n`,
		);
	}
	return parts.join("\n");
}

/** A project directory containing one file, returned with its absolute path. */
function makeProject(
	prefix: string,
	source: string,
): {
	projectPath: string;
	filePath: string;
} {
	const projectPath = makeTempDir(prefix);
	const filePath = join(projectPath, "big.ts");
	writeFileSync(filePath, source, "utf-8");
	return { projectPath, filePath };
}

function writeProjectConfig(
	projectPath: string,
	config: Record<string, unknown>,
): void {
	mkdirSync(join(projectPath, ".mnemex"), { recursive: true });
	writeFileSync(
		join(projectPath, ".mnemex", "config.json"),
		JSON.stringify(config),
		"utf-8",
	);
}

/** Rows the store actually holds for one file. The subject of most of these. */
async function storedChunkCount(
	projectPath: string,
	filePath: string,
): Promise<number> {
	const store = createVectorStore(getVectorStorePath(projectPath));
	await store.initialize();
	try {
		return (await store.getChunksWithVectors(filePath)).length;
	} finally {
		await store.close();
	}
}

async function runIndex(
	projectPath: string,
	options: {
		model?: string;
		force?: boolean;
		onProgress?: (
			current: number,
			total: number,
			detail?: string,
			inProgress?: number,
		) => void;
	} = {},
) {
	const indexer = createIndexer({
		projectPath,
		model: options.model,
		// Enrichment would need a live LLM provider.
		enableEnrichment: false,
		onProgress: options.onProgress,
	});
	try {
		return {
			result: await indexer.index(options.force ?? false),
			indexer,
		};
	} finally {
		await indexer.close();
	}
}

let cacheDir: string;

beforeEach(() => {
	embedBatches = [];
	providerMode = "ok";
	clientsBuiltFor = [];
	cacheDir = makeTempDir("mnemex-embed-cache-");
	process.env.MNEMEX_EMBED_CACHE_PATH = join(cacheDir, "embed-cache.db");
	delete process.env.MNEMEX_DISABLE_EMBED_CACHE;
	process.env.MNEMEX_MODEL = "fake-model";
	process.env.MNEMEX_DOCS_ENABLED = "false";
	process.env.MNEMEX_GLOBAL_LOCK_PATH = join(cacheDir, "global.lock");
	delete process.env.MNEMEX_ON_MODEL_MISMATCH;
});

afterAll(() => {
	delete process.env.MNEMEX_EMBED_CACHE_PATH;
	delete process.env.MNEMEX_DISABLE_EMBED_CACHE;
	delete process.env.MNEMEX_MODEL;
	delete process.env.MNEMEX_DOCS_ENABLED;
	delete process.env.MNEMEX_GLOBAL_LOCK_PATH;
	for (const dir of tempDirs) {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ════════════════════════════════════════════════════════════════════════════
// CONSTRAINT 1 — the deferral must cover the WRITE, not only the tracker
// ════════════════════════════════════════════════════════════════════════════

describe("a deferred file leaves NO rows behind", () => {
	test("450 hits + 50 misses, provider dies, NEW file: run 2 stores 500 rows, not 950", async () => {
		// ── Setup: a 500-chunk file, 450 of whose chunks are already cached ──
		//
		// Seeded through the cache's own API with the production key formula, so
		// the hits are the ones the seam would compute — not an approximation of
		// them. The remaining 50 are the miss set the provider will fail on.
		await getParserManager().initialize();
		const source = sourceWithFunctions(500);
		const { projectPath, filePath } = makeProject("mnemex-deferral-", source);
		const chunks = await chunkFileByPath(source, filePath, "seed-hash");
		expect(chunks).toHaveLength(500);

		const cache = openEmbedCache(process.env.MNEMEX_EMBED_CACHE_PATH);
		expect(cache).not.toBeNull();
		const seeded = chunks.slice(0, 450);
		cache?.putMany(
			seeded.map((chunk) => ({
				key: embedCacheKey("fake-model", DIM, chunk.content),
				model: "fake-model",
				provider: "openrouter",
				dimension: DIM,
				// The fake provider is not ollama, so it transforms nothing.
				fingerprint: "",
				vector: vectorFor(chunk.content),
			})),
			[],
			{ model: "fake-model", provider: "openrouter", dimension: DIM },
		);

		// ── Run 1: the provider is down for the whole miss set ──────────────
		providerMode = "total-failure";
		const run1 = await runIndex(projectPath);
		providerMode = "ok";

		// Exactly one provider call, of exactly 50 texts: 450 came from the
		// cache. If this is 500 the seeding missed and the rest of the test is
		// measuring something else.
		expect(embedBatches).toHaveLength(1);
		expect(embedBatches[0]).toHaveLength(50);

		// The run SURVIVED (the old behaviour was a fatal throw for the batch)…
		expect(run1.result.filesDeferred).toEqual([
			relative(projectPath, filePath),
		]);
		// …and it left NOTHING on disk for that file. THIS is the assertion the
		// constraint is about: deferring only `markIndexed` would leave the 450
		// successful chunks here with no tracker row, and a file with no tracker
		// row is classified NEW, never reaches `deleteByFile`, and is appended to
		// on every run for ever.
		expect(await storedChunkCount(projectPath, filePath)).toBe(0);

		// ── Run 2: the provider is back. The file is still NEW. ─────────────
		embedBatches = [];
		const run2 = await runIndex(projectPath);

		// 450 hits again, 50 misses that now succeed. (The second batch is the
		// code units, which are different text and always miss.)
		expect(embedBatches[0]).toHaveLength(50);
		expect(run2.result.filesDeferred).toBeUndefined();

		// THE ROW COUNT IN THE STORE. Equal to the chunk count — not twice it,
		// and not 950.
		expect(await storedChunkCount(projectPath, filePath)).toBe(500);
	}, 300_000);
});

// ════════════════════════════════════════════════════════════════════════════
// The cache file's lifecycle belongs to index(), and to nothing else
// ════════════════════════════════════════════════════════════════════════════

describe("only index() opens the cache", () => {
	test("clear() does not create the cache file; index() does", async () => {
		// `Indexer.clear()` calls `initialize()` and never embeds. Opening the
		// cache there would create and DDL a machine-global SQLite file for a
		// command that cannot use it — and would do it INSIDE nothing, on a path
		// with no lock discipline at all. The open lives in `index()`, before both
		// locks, and nowhere else.
		const cachePath = process.env.MNEMEX_EMBED_CACHE_PATH as string;
		expect(existsSync(cachePath)).toBe(false);

		const { projectPath } = makeProject(
			"mnemex-clear-",
			sourceWithFunctions(2),
		);
		const indexer = createIndexer({ projectPath, enableEnrichment: false });
		try {
			await indexer.clear();
		} finally {
			await indexer.close();
		}
		expect(existsSync(cachePath)).toBe(false);

		await runIndex(projectPath);
		expect(existsSync(cachePath)).toBe(true);
	}, 120_000);

	test("the env opt-out means no cache file at all", async () => {
		process.env.MNEMEX_DISABLE_EMBED_CACHE = "1";
		const cachePath = process.env.MNEMEX_EMBED_CACHE_PATH as string;
		const { projectPath } = makeProject("mnemex-off-", sourceWithFunctions(2));
		const run = await runIndex(projectPath);
		expect(run.result.embedCache?.tier).toBe("none");
		expect(existsSync(cachePath)).toBe(false);
	}, 120_000);

	test("the CONFIG opt-out means no cache file either", async () => {
		// `GlobalConfig.embedCache: false` is a separate switch from the env var,
		// and `openEmbedCache()` cannot see it — it reads the environment only, by
		// design, because the cache module may not import `config.ts`. So the
		// config leg is resolved by the indexer BEFORE the open. Without that,
		// a user who turned the cache off in `~/.mnemex/config.json` still gets a
		// machine-global SQLite file created and DDL'd for something no run will
		// ever read.
		//
		// Written to the sandboxed HOME this child refused to start without.
		const home = process.env.MNEMEX_TEST_SANDBOX_HOME as string;
		mkdirSync(join(home, ".mnemex"), { recursive: true });
		writeFileSync(
			join(home, ".mnemex", "config.json"),
			JSON.stringify({ embedCache: false }),
			"utf-8",
		);
		try {
			const cachePath = process.env.MNEMEX_EMBED_CACHE_PATH as string;
			const { projectPath } = makeProject(
				"mnemex-cfgoff-",
				sourceWithFunctions(2),
			);
			const run = await runIndex(projectPath);
			expect(run.result.embedCache?.tier).toBe("none");
			expect(existsSync(cachePath)).toBe(false);
		} finally {
			rmSync(join(home, ".mnemex"), { recursive: true, force: true });
		}
	}, 120_000);
});

// ════════════════════════════════════════════════════════════════════════════
// §5.3 — an index that predates the embedKey column rebuilds, once
// ════════════════════════════════════════════════════════════════════════════

/**
 * A table in the shape every existing user has on disk: 22 columns, no
 * `embedKey`. Written through a RAW LanceDB connection because nothing in
 * `src/` can produce it any more — which is the point. The vector width matches
 * the fake provider's, so the dimension-mismatch auto-clear cannot fire and
 * rebuild the table for an unrelated reason.
 */
async function replaceWithV2Table(projectPath: string): Promise<void> {
	const db = await lancedb.connect(getVectorStorePath(projectPath));
	await db.dropTable("code_chunks");
	await db.createTable(
		"code_chunks",
		[
			{
				id: "legacy-1",
				contentHash: "legacy-hash",
				content: "function legacy() {}",
				filePath: join(projectPath, "legacy.ts"),
				startLine: 1,
				endLine: 3,
				language: "typescript",
				chunkType: "function",
				name: "legacy",
				parentName: "",
				signature: "",
				fileHash: "legacy-file",
				vector: new Array(DIM).fill(0.5),
				documentType: "code_chunk",
				sourceIds: "[]",
				metadata: "{}",
				createdAt: new Date().toISOString(),
				enrichedAt: "",
				parentId: "",
				unitType: "",
				depth: -1,
				summary: "",
			},
		],
		{ mode: "create" },
	);
}

describe("index v2 -> v3", () => {
	test("a table with no embedKey column is rebuilt, and the run says so", async () => {
		const { projectPath, filePath } = makeProject(
			"mnemex-v2-",
			sourceWithFunctions(3),
		);
		await runIndex(projectPath);
		expect(await storedChunkCount(projectPath, filePath)).toBe(3);

		// Put a v2-shaped table where the v3 one was, and declare the index v2.
		await replaceWithV2Table(projectPath);
		writeProjectConfig(projectPath, { indexVersion: 2 });

		// A second file, so the run has something to write. Without the rebuild,
		// LanceDB rejects the 23-field batch outright — "Found field not in
		// schema: embedKey" — and the whole run throws.
		writeFileSync(
			join(projectPath, "second.ts"),
			sourceWithFunctions(2, "b"),
			"utf-8",
		);

		const upgraded = await runIndex(projectPath);

		// The authoritative channel, because the `[migrating]` progress notice
		// reaches at most two of the four entry points.
		expect(upgraded.result.upgradedFromIndexVersion).toBe(2);
		// ON DISK: the legacy row is gone (the table was rebuilt from scratch)…
		const store = createVectorStore(getVectorStorePath(projectPath));
		await store.initialize();
		try {
			const legacy = await store.getChunksWithVectors(
				join(projectPath, "legacy.ts"),
			);
			expect(legacy).toHaveLength(0);
		} finally {
			await store.close();
		}
		// …and BOTH files were re-indexed, including the one the tracker already
		// considered up to date.
		expect(await storedChunkCount(projectPath, filePath)).toBe(3);
		expect(
			await storedChunkCount(projectPath, join(projectPath, "second.ts")),
		).toBe(2);
	}, 300_000);

	test("a fresh index is not reported as an upgrade", async () => {
		// `hasEmbedKeyColumn()` answers `null` when there is no table to ask, and
		// `=== false` is the only value that triggers a rebuild.
		const { projectPath } = makeProject(
			"mnemex-fresh-",
			sourceWithFunctions(2),
		);
		const first = await runIndex(projectPath);
		expect(first.result.upgradedFromIndexVersion).toBeUndefined();
		const second = await runIndex(projectPath);
		expect(second.result.upgradedFromIndexVersion).toBeUndefined();
	}, 120_000);
});

// ════════════════════════════════════════════════════════════════════════════
// §7.5 — the two lines inside the modified-files loop that are never gated
// ════════════════════════════════════════════════════════════════════════════

describe("the modified-files loop still deletes, on the healthy cache path", () => {
	test("editing a file replaces its rows instead of adding to them", async () => {
		// `reuseFromLance` is FALSE here (the persistent tier is serving this
		// run), which is exactly the configuration where gating the whole loop
		// would skip `deleteByFile` — leaving every past edit's chunks in the
		// table beside the new ones, for ever, on the default happy path.
		const { projectPath, filePath } = makeProject(
			"mnemex-modified-",
			sourceWithFunctions(3),
		);

		await runIndex(projectPath);
		expect(await storedChunkCount(projectPath, filePath)).toBe(3);

		// Edit one function body; the file stays at 3 chunks.
		writeFileSync(
			filePath,
			sourceWithFunctions(3).replace("a * 1 + b", "a * 1 + b + 99"),
			"utf-8",
		);
		const run2 = await runIndex(projectPath);
		expect(run2.result.embedCache?.tier).toBe("sqlite");

		expect(await storedChunkCount(projectPath, filePath)).toBe(3);
	}, 120_000);

	test("a [0] placeholder from a --no-vector run is never reused as a vector", async () => {
		// The `> 1` guard at the L1 population, which excludes the BM25
		// placeholder. Without it the placeholder is handed back as if it were an
		// embedding, and every unchanged chunk of the file gets a 1-wide vector.
		//
		// The cache is switched OFF for this one, because L1 is only populated
		// when the persistent tier is NOT serving the run.
		process.env.MNEMEX_DISABLE_EMBED_CACHE = "1";
		const { projectPath, filePath } = makeProject(
			"mnemex-placeholder-",
			sourceWithFunctions(3),
		);
		writeProjectConfig(projectPath, { vector: false });

		await runIndex(projectPath);
		// BM25-only: nothing was embedded at all.
		expect(embedBatches).toEqual([]);

		// Turn vectors on and edit the file, so it is MODIFIED and the L1
		// population runs over the placeholder rows.
		writeProjectConfig(projectPath, { vector: true });
		writeFileSync(filePath, sourceWithFunctions(4), "utf-8");
		embedBatches = [];
		await runIndex(projectPath);

		// All FOUR chunks were embedded. If the placeholder were reused, only the
		// one new function would have been — and the other three rows would carry
		// a 1-element "vector".
		expect(embedBatches[0]).toHaveLength(4);
	}, 120_000);
});

// ════════════════════════════════════════════════════════════════════════════
// The progress line says WHERE the vectors came from
// ════════════════════════════════════════════════════════════════════════════

describe("(N cached) in the embedding progress", () => {
	test("a warm run reports cached slots; a cold one reports new ones", async () => {
		// `completed` counts every slot the seam RESOLVED, hits included, so once
		// the cache serves a batch "200/200 new" is a claim about work that never
		// happened. A run that embeds nothing and says "new" is indistinguishable
		// from a stalled one — this is the only place the difference is visible
		// while the run is happening.
		const { projectPath } = makeProject(
			"mnemex-progress-",
			sourceWithFunctions(200),
		);

		/** Only the per-item lines: the pre-batch notice has no counter. */
		const perItem = (lines: string[]) =>
			lines.filter((d) => d.startsWith("[embedding]") && /\d+\/\d+/.test(d));

		// ── Run 1, cold cache: every vector comes from the provider ──────────
		const cold: string[] = [];
		await runIndex(projectPath, {
			onProgress: (_c, _t, detail) => {
				if (detail) cold.push(detail);
			},
		});
		const coldLines = perItem(cold);
		expect(coldLines.length).toBeGreaterThan(0);
		expect(coldLines.some((d) => d.includes(" new"))).toBe(true);
		expect(coldLines.some((d) => d.includes("cached"))).toBe(false);

		// ── Run 2, same texts, warm cache, forced so all of them re-embed ────
		embedBatches = [];
		const warm: string[] = [];
		const run2 = await runIndex(projectPath, {
			force: true,
			onProgress: (_c, _t, detail) => {
				if (detail) warm.push(detail);
			},
		});

		// The provider was not called at all — the fact the text is claiming.
		// Asserted on the fake's own record, not on the progress text and not on
		// `stats()`.
		expect(embedBatches).toEqual([]);
		expect(run2.result.embedCache?.tier).toBe("sqlite");
		expect(run2.result.embedCache?.misses).toBe(0);

		const warmLines = perItem(warm);
		expect(warmLines.length).toBeGreaterThan(0);
		expect(warmLines.some((d) => /\(\d+ cached\)/.test(d))).toBe(true);
		// And the word that would have been a lie is gone from every one of them.
		expect(warmLines.filter((d) => d.includes(" new"))).toEqual([]);

		// The code-unit pass is a second embedding site with its own line, and
		// its vectors come from the same cache.
		const warmUnits = warm.filter((d) => d.startsWith("[units]"));
		expect(warmUnits.length).toBeGreaterThan(0);
		expect(warmUnits.some((d) => /\(\d+ cached\)/.test(d))).toBe(true);
	}, 300_000);
});

// ════════════════════════════════════════════════════════════════════════════
// C1 proof obligations 2 and 3 — the seam is installed, and survives adoption
// ════════════════════════════════════════════════════════════════════════════

describe("the seam is installed on index paths and absent on search paths", () => {
	test("initialize(false) wraps; initialize(true) does not", async () => {
		// Obligation 2. This is what catches the leak a source-level check
		// cannot see: a future caller passing forSearch:true on an index path.
		const { projectPath } = makeProject("mnemex-seam-", sourceWithFunctions(2));
		const indexer = createIndexer({ projectPath, enableEnrichment: false });
		type Internals = {
			initialize(forSearch?: boolean): Promise<void>;
			embeddingsClient: unknown;
			rawEmbeddingsClient: unknown;
		};
		const internals = indexer as unknown as Internals;

		await internals.initialize(false);
		expect(internals.embeddingsClient).toBeInstanceOf(CachingEmbeddingsClient);
		expect(internals.rawEmbeddingsClient).not.toBeInstanceOf(
			CachingEmbeddingsClient,
		);

		await internals.initialize(true);
		// NFR-1: the read path is the bare client, byte-for-byte what it was.
		expect(internals.embeddingsClient).not.toBeInstanceOf(
			CachingEmbeddingsClient,
		);
		expect(internals.embeddingsClient).toBe(
			internals.rawEmbeddingsClient as object,
		);

		// And it re-wraps: initialize() is not memoised, so an index run after a
		// search gets the seam back.
		await internals.initialize(false);
		expect(internals.embeddingsClient).toBeInstanceOf(CachingEmbeddingsClient);

		await indexer.close();
	}, 120_000);

	test("a use-indexed adoption moves BOTH clients to the adopted model", async () => {
		// Obligation 3, and the reason `installEmbeddingsClient` exists: this
		// branch replaces the client wholesale. If it did not go through the sole
		// writer, either the seam would be destroyed (not a CachingEmbeddingsClient
		// below) or the seam and the raw client would name two different models.
		const { projectPath } = makeProject(
			"mnemex-adopt-",
			sourceWithFunctions(2),
		);

		process.env.MNEMEX_MODEL = "model-a";
		await runIndex(projectPath);

		process.env.MNEMEX_MODEL = "model-b";
		const indexer = createIndexer({ projectPath, enableEnrichment: false });
		try {
			await indexer.index(false);
			const internals = indexer as unknown as {
				embeddingsClient: IEmbeddingsClient;
				rawEmbeddingsClient: IEmbeddingsClient;
				model: string;
			};

			expect(internals.model).toBe("model-a");
			expect(internals.embeddingsClient).toBeInstanceOf(
				CachingEmbeddingsClient,
			);
			expect(internals.embeddingsClient.getModel()).toBe("model-a");
			expect(internals.embeddingsClient.getProvider()).toBe("openrouter");
			// The raw client — what the enricher is handed — agrees.
			expect(internals.rawEmbeddingsClient).not.toBeInstanceOf(
				CachingEmbeddingsClient,
			);
			expect(internals.rawEmbeddingsClient.getModel()).toBe("model-a");
		} finally {
			await indexer.close();
		}
	}, 120_000);
});

// ════════════════════════════════════════════════════════════════════════════
// NFR-1 — search behaviour does not change
// ════════════════════════════════════════════════════════════════════════════

describe("NFR-1: search behaviour does not change", () => {
	/** One search, reported so the vector side and the fused side are separable. */
	async function rank(projectPath: string, query: string) {
		const indexer = createIndexer({ projectPath, enableEnrichment: false });
		try {
			const results = await indexer.search(query, { limit: 6 });
			return {
				ids: results.map((r) => r.chunk.id),
				vectorScores: results.map((r) => (r.vectorScore ?? 0).toFixed(9)),
				fused: results.map((r) => `${r.chunk.id}@${r.score.toFixed(9)}`),
			};
		} finally {
			await indexer.close();
		}
	}

	const QUERY = "function that multiplies a by three";

	test("cache-served vectors are numerically identical to provider-served ones", async () => {
		// ONE project, one store path, one set of file paths. The only thing that
		// differs between the two runs is where the vectors came from: run 1 takes
		// them from the provider (and fills the cache), run 2 is a force rebuild
		// whose every chunk is a cache HIT and therefore a float32 round-trip.
		// LanceDB narrows a JS float64 to float32 on write anyway (measured: a
		// written 0.1234567890123456 reads back as Math.fround of itself), so the
		// round-trip is expected to be invisible — and this is what checks it.
		//
		// ASSERTED: result order, and the VECTOR score per slot, exactly.
		// NOT asserted: the fused score. BM25 reshuffles tied documents across a
		// table rebuild — these six functions differ only by a digit, so their
		// full-text scores tie and the tie is broken by row order in a freshly
		// written FTS index. Measured on this fixture: the six `vectorScore`s were
		// bit-identical across the rebuild while `keywordScore` moved, which is
		// what says the wobble is the FTS index's and not the cache's. The
		// cache-on-versus-off comparison below holds the table still and asserts
		// the fused score too.
		const { projectPath } = makeProject("mnemex-nfr1-", sourceWithFunctions(6));

		const cold = await runIndex(projectPath);
		expect(cold.result.embedCache?.tier).toBe("sqlite");
		// Cold: nothing to hit yet, so every vector came from the provider.
		expect(cold.result.embedCache?.hits).toBe(0);
		const coldRanking = await rank(projectPath, QUERY);
		expect(coldRanking.ids).toHaveLength(6);

		const warm = await runIndex(projectPath, { force: true });
		// Warm: served from the cache.
		expect(warm.result.embedCache?.hits).toBeGreaterThan(0);
		const warmRanking = await rank(projectPath, QUERY);

		expect(warmRanking.ids).toEqual(coldRanking.ids);
		expect(warmRanking.vectorScores).toEqual(coldRanking.vectorScores);
	}, 300_000);

	test("the cache setting cannot reach the search path", async () => {
		// The seam is never installed on a read path (`initialize(true)` leaves
		// the client unwrapped), so ranking, fusion and result order cannot depend
		// on whether the cache is on. Same store, same rows, same FTS index — only
		// the setting changes — so this one asserts the FUSED score too.
		const { projectPath } = makeProject(
			"mnemex-nfr1-setting-",
			sourceWithFunctions(6),
		);
		// Index warm, so the rows under test were themselves served by the cache.
		await runIndex(projectPath);
		const warm = await runIndex(projectPath, { force: true });
		expect(warm.result.embedCache?.hits).toBeGreaterThan(0);

		const withCache = await rank(projectPath, QUERY);
		process.env.MNEMEX_DISABLE_EMBED_CACHE = "1";
		const withoutCache = await rank(projectPath, QUERY);

		expect(withCache.fused).toHaveLength(6);
		expect(withoutCache.fused).toEqual(withCache.fused);
	}, 300_000);
});
