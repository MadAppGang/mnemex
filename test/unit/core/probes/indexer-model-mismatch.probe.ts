/**
 * What an index run does when the index's embedding model is not the one the
 * config asks for. Run by ../indexer-model-mismatch.test.ts — see the note at
 * the bottom of this comment for why this file is not itself a `.test.ts`.
 *
 * The destructive answer used to be the only one: `mnemex <query>` triggers an
 * auto-reindex, the reindex saw a model change, cleared the index and started
 * paying to rebuild 4,825 chunks against a different provider — from a query.
 * `onModelMismatch` now decides, and these tests pin both branches by counting
 * the calls that actually destroy data:
 *
 *   - 'force-model'  → clears the store and the tracker, exactly once
 *   - 'use-indexed'  → clears NOTHING, adopts the stored model AND the stored
 *                      provider, and only after proving that pair can embed
 *   - an explicit `--model` outranks the setting in either direction
 *
 * Everything below the decision is faked (store, tracker, embeddings) because
 * the decision is the subject; the project directory is real but empty, so the
 * run reaches the end with zero files and the counters mean only one thing.
 *
 * NOT a `.test.ts`: bun's `mock.module` replaces the module registry for the
 * whole PROCESS and outlives the file that called it — `mock.restore()` does
 * not undo it, and neither does re-registering the real module, because every
 * importer evaluated in the meantime has already bound the fake. Left in the
 * main run, the fake tracker below answered `getSymbolByName` for the editor
 * e2e suite and failed 24 tests in files that never asked for a mock. So this
 * file is excluded from discovery and run in its own process instead.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	EmbeddingProvider,
	IEmbeddingsClient,
} from "../../../../src/types.js";

// ── Mutable state the fakes read and record ─────────────────────────────────

/** Metadata the index has on record, i.e. what `getMetadata` returns. */
let storedMetadata: Record<string, string> = {};
/** Metadata written back by the run. */
let writtenMetadata: Record<string, string> = {};
/** How many times the vector store / tracker were emptied. */
let storeClears = 0;
let trackerClears = 0;
/** Whether the store reports a 0-dimension (unqueryable) vector column. */
let storeIsCorrupt = false;
/** Every (model, provider) an embeddings client was built for, in order. */
let clientsBuiltFor: Array<{ model?: string; provider?: EmbeddingProvider }> =
	[];
/** Every (model, provider) whose availability was probed, in order. */
let availabilityProbes: Array<{
	model: string;
	provider?: EmbeddingProvider;
}> = [];
/** What the availability probe answers. */
let availabilityAnswer: { ok: boolean; error?: string } = { ok: true };
/** Progress lines the run reported (the seam the notices must use). */
let progressLines: string[] = [];

/**
 * Object that answers every method call, so a fake only has to spell out the
 * calls a test actually cares about. Anything else is a no-op returning
 * undefined — which is what the indexer needs from an empty run.
 */
function noopExcept<T extends object>(overrides: T): unknown {
	return new Proxy(overrides as Record<string, unknown>, {
		get(target, prop) {
			if (prop in target) return target[prop as string];
			return () => undefined;
		},
	});
}

// ── Module mocks (registered before the indexer is imported) ────────────────

const realStore = await import("../../../../src/core/store.js");
mock.module("../../../../src/core/store.js", () => ({
	...realStore,
	createVectorStore: () =>
		noopExcept({
			initialize: async () => {},
			isUnqueryable: async () => storeIsCorrupt,
			clear: async () => {
				storeClears++;
			},
			search: async () => [],
			close: async () => {},
		}),
}));

const realTracker = await import("../../../../src/core/tracker.js");
mock.module("../../../../src/core/tracker.js", () => ({
	...realTracker,
	createFileTracker: () =>
		noopExcept({
			getMetadata: (key: string) => storedMetadata[key] ?? null,
			setMetadata: (key: string, value: string) => {
				writtenMetadata[key] = value;
			},
			clear: () => {
				trackerClears++;
				// The real FileTracker.clear() does `DELETE FROM metadata`, which is
				// where embeddingModel lives. Faking that faithfully is the point of
				// the corrupt-index case below.
				storedMetadata = {};
			},
			// Null HEAD keeps commit invalidation out of the way (no git repo here).
			recordHeadCommit: async () => null,
			getChanges: () => ({
				newFiles: [],
				modifiedFiles: [],
				deletedFiles: [],
				unchangedFiles: [],
			}),
			getFilesNeedingEnrichment: () => [],
			close: () => {},
		}),
}));

const realEmbeddings = await import("../../../../src/core/embeddings.js");
mock.module("../../../../src/core/embeddings.js", () => ({
	...realEmbeddings,
	createEmbeddingsClient: (options?: {
		model?: string;
		provider?: EmbeddingProvider;
	}) => {
		clientsBuiltFor.push({
			model: options?.model,
			provider: options?.provider,
		});
		return noopExcept({
			isLocal: () => true,
			getModel: () => options?.model,
			// The real client resolves this itself; the fake reports back what it
			// was asked for so the run has a provider to record.
			getProvider: () => options?.provider ?? "openrouter",
			embedOne: async () => [0.1, 0.2, 0.3],
		}) as IEmbeddingsClient;
	},
	testModelAvailability: async (
		model: string,
		provider?: EmbeddingProvider,
	) => {
		availabilityProbes.push({ model, provider });
		return availabilityAnswer;
	},
}));

// Imported AFTER the mocks so the Indexer picks up the fakes.
const {
	createIndexer,
	EmbeddingModelMismatchError,
	IndexedModelUnavailableError,
} = await import("../../../../src/core/indexer.js");

// ── Fixture ─────────────────────────────────────────────────────────────────

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

let projectPath: string;

beforeEach(() => {
	projectPath = makeTempDir("mnemex-mismatch-index-");
	storedMetadata = {
		embeddingModel: "stored-model",
		embeddingProvider: "ollama",
	};
	writtenMetadata = {};
	storeClears = 0;
	trackerClears = 0;
	storeIsCorrupt = false;
	clientsBuiltFor = [];
	availabilityProbes = [];
	availabilityAnswer = { ok: true };
	progressLines = [];

	// The configured model, set through the env so `modelExplicitlySet` stays
	// false — passing it as an option would mean "the user typed --model", which
	// is a different case (covered separately below).
	process.env.MNEMEX_MODEL = "configured-model";
	// Keep the run off the network and out of the developer's global lock file.
	process.env.MNEMEX_DOCS_ENABLED = "false";
	process.env.MNEMEX_GLOBAL_LOCK_PATH = join(projectPath, "global.lock");
	// …and out of the developer's real embedding cache. `index()` opens
	// `~/.mnemex/embed-cache.db` by default, which is MACHINE-GLOBAL (CLAUDE.md
	// #31): every repo on the machine shares that one file. This probe is about
	// the model-mismatch decision, not the cache, but it runs the real
	// `Indexer.index()` and is therefore a writer of it — which is how a
	// 36,864-byte cache appeared in a real user's home directory, written by the
	// committed test suite. Without this line `openEmbedCache()` now REFUSES and
	// this probe fails loudly, which is the point of the guard.
	process.env.MNEMEX_EMBED_CACHE_PATH = join(projectPath, "embed-cache.db");
	delete process.env.MNEMEX_ON_MODEL_MISMATCH;
});

afterAll(() => {
	delete process.env.MNEMEX_MODEL;
	delete process.env.MNEMEX_DOCS_ENABLED;
	delete process.env.MNEMEX_GLOBAL_LOCK_PATH;
	delete process.env.MNEMEX_EMBED_CACHE_PATH;
	delete process.env.MNEMEX_ON_MODEL_MISMATCH;
	for (const dir of tempDirs) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function makeIndexer(options: { model?: string } = {}) {
	return createIndexer({
		projectPath,
		model: options.model,
		// Enrichment would need a live LLM provider.
		enableEnrichment: false,
		onProgress: (_c, _t, file) => {
			progressLines.push(file);
		},
	});
}

/** Run one index pass. */
async function runIndex(options: { model?: string; force?: boolean } = {}) {
	const indexer = makeIndexer(options);
	try {
		return await indexer.index(options.force ?? false);
	} finally {
		await indexer.close();
	}
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("onModelMismatch: use-indexed (the default)", () => {
	test("clears nothing and adopts the stored model", async () => {
		await runIndex();

		expect(storeClears).toBe(0);
		expect(trackerClears).toBe(0);
		expect(writtenMetadata.embeddingModel).toBe("stored-model");
	});

	test("adopts the stored PROVIDER too, not just the model name", async () => {
		// Without this, createEmbeddingsClient() resolves the bare stored name
		// against the ambient config: an Ollama model requested from Voyage,
		// which fails 100% of the time and blames the model for it.
		await runIndex();

		expect(availabilityProbes).toEqual([
			{ model: "stored-model", provider: "ollama" },
		]);
		expect(clientsBuiltFor).toContainEqual({
			model: "stored-model",
			provider: "ollama",
		});
	});

	test("records the provider it used, so the next run can adopt it", async () => {
		await runIndex();

		expect(writtenMetadata.embeddingProvider).toBe("ollama");
	});

	test("announces the switch through onProgress, never stdout", async () => {
		// The MCP search tool runs this same index() in-process, where stdout is
		// the JSON-RPC stream (CLAUDE.md gotcha #14).
		await runIndex();

		const notice = progressLines.find((line) => line.startsWith("[model]"));
		expect(notice).toContain("stored-model");
		expect(notice).toContain("configured-model");
	});

	test("fails loudly, and non-destructively, when the stored model is gone", async () => {
		availabilityAnswer = {
			ok: false,
			error: "connect ECONNREFUSED 127.0.0.1:11434",
		};

		const error = await runIndex().then(
			() => null,
			(e: unknown) => e,
		);

		expect(error).toBeInstanceOf(IndexedModelUnavailableError);
		const message = (error as Error).message;
		// Which model, on which provider, why it failed, and both ways out —
		// anything missing leaves the user guessing.
		expect(message).toContain("stored-model");
		expect(message).toContain("ollama");
		expect(message).toContain("ECONNREFUSED");
		expect(message).toContain("mnemex index --force");
		expect(message).toContain("force-model");

		// Nothing was destroyed on the way to the error.
		expect(storeClears).toBe(0);
		expect(trackerClears).toBe(0);
	});

	test("says so when the index predates provider recording", async () => {
		// Older indexes stored only the model name. There is nothing to infer a
		// provider from, so the attempt goes out on today's config — and when it
		// fails, that is the likeliest reason, not the model being down.
		storedMetadata = { embeddingModel: "stored-model" };
		availabilityAnswer = { ok: false, error: "model not found" };

		const error = await runIndex().then(
			() => null,
			(e: unknown) => e,
		);

		expect(error).toBeInstanceOf(IndexedModelUnavailableError);
		expect((error as Error).message).toContain("predates provider recording");
		expect(availabilityProbes).toEqual([
			{ model: "stored-model", provider: undefined },
		]);
	});

	test("--force is an instruction: rebuild with the CONFIGURED model", async () => {
		// This is the escape hatch both mismatch errors advertise. If --force kept
		// adopting the stored model, `mnemex index --force` against an unreachable
		// one would re-probe it and throw the identical error — a documented
		// remedy that loops, leaving no exit but hand-editing a config file.
		await runIndex({ force: true });

		expect(writtenMetadata.embeddingModel).toBe("configured-model");
		// Exactly one clear. The guard that skips the second clear must key on
		// "did the mismatch branch clear", never on "was there a mismatch", or a
		// --force run silently re-indexes into a non-empty table.
		expect(storeClears).toBe(1);
		expect(trackerClears).toBe(1);
	});

	test("--force does not probe the model it is replacing", async () => {
		// The stored model being unreachable is the reason to run this command;
		// probing it would fail the run for the exact condition it repairs.
		availabilityAnswer = { ok: false, error: "model not found" };

		await runIndex({ force: true });

		expect(availabilityProbes).toEqual([]);
		expect(writtenMetadata.embeddingModel).toBe("configured-model");
	});
});

describe("onModelMismatch: force-model", () => {
	beforeEach(() => {
		process.env.MNEMEX_ON_MODEL_MISMATCH = "force-model";
	});

	test("clears the index and rebuilds with the configured model", async () => {
		await runIndex();

		expect(storeClears).toBe(1);
		expect(trackerClears).toBe(1);
		expect(writtenMetadata.embeddingModel).toBe("configured-model");
	});

	test("does not spend a round-trip probing the stored model", async () => {
		await runIndex();

		expect(availabilityProbes).toEqual([]);
	});

	test("announces the rebuild through onProgress, never stdout", async () => {
		await runIndex();

		expect(progressLines.some((line) => line.startsWith("[model]"))).toBe(true);
	});

	test("clears exactly once when --force is also given", async () => {
		await runIndex({ force: true });

		expect(storeClears).toBe(1);
		expect(trackerClears).toBe(1);
	});

	test("a search refuses rather than querying the wrong vector space", async () => {
		// force-model does not adopt, and the reindex that would reconcile the two
		// is skipped in --agent mode, under --no-reindex, and whenever the MCP
		// path swallows its failure. Embedding the query with the configured model
		// then searches a space the table does not hold — an error if the widths
		// differ, silent nonsense if they happen to match.
		const indexer = makeIndexer();
		try {
			await expect(indexer.search("anything")).rejects.toBeInstanceOf(
				EmbeddingModelMismatchError,
			);
		} finally {
			await indexer.close();
		}
	});

	test("keyword-only search still works — it embeds nothing", async () => {
		const indexer = makeIndexer();
		try {
			expect(await indexer.search("anything", { keywordOnly: true })).toEqual(
				[],
			);
		} finally {
			await indexer.close();
		}
	});
});

describe("the adopted model is proved on the SEARCH path too", () => {
	// index() probes on its own path, but a search does not always run index():
	// --agent skips the auto-reindex, --no-reindex skips it, and the MCP tool
	// treats its failure as non-fatal. Without a probe here the first symptom is
	// whatever the query layer says about the vector it got back — observed
	// live: "No vector column found to match with the query vector dimension: 0".

	test("an unavailable stored model raises IndexedModelUnavailableError", async () => {
		availabilityAnswer = {
			ok: false,
			error: "model not found, try pulling it first",
		};

		const indexer = makeIndexer();
		try {
			const error = await indexer.search("anything").then(
				() => null,
				(e: unknown) => e,
			);

			expect(error).toBeInstanceOf(IndexedModelUnavailableError);
			expect((error as Error).message).toContain("stored-model");
			expect(availabilityProbes).toEqual([
				{ model: "stored-model", provider: "ollama" },
			]);
		} finally {
			await indexer.close();
		}
	});

	test("a reachable stored model is probed once, not once per initialize", async () => {
		// One CLI search calls initialize(true) twice — getStatus, then search.
		const indexer = makeIndexer();
		try {
			await indexer.getStatus();
			await indexer.search("anything");

			expect(availabilityProbes).toEqual([
				{ model: "stored-model", provider: "ollama" },
			]);
		} finally {
			await indexer.close();
		}
	});

	test("no probe at all when the models already agree", async () => {
		// The normal search: the check must never appear on it.
		storedMetadata = { embeddingModel: "configured-model" };

		const indexer = makeIndexer();
		try {
			await indexer.search("anything");
			expect(availabilityProbes).toEqual([]);
		} finally {
			await indexer.close();
		}
	});
});

describe("the adoption is reported as DATA, not only as a notice", () => {
	// The onProgress notice reaches no surface on its own: --agent passes no
	// callback (cli.ts), the TTY renderer truncates detail and then overwrites it
	// with "done", and the MCP search tool passes no callback at all. A silent
	// model substitution is the exact behaviour this release removes, so the fact
	// has to travel on the result object every surface already reads.

	test("the result names the model actually used and says it was adopted", async () => {
		const result = await runIndex();

		expect(result.embeddingModel).toBe("stored-model");
		expect(result.adoptedIndexedModel).toBe(true);
		expect(result.configuredModel).toBe("configured-model");
	});

	test("a search adopts without index(), so the indexer itself can be asked", async () => {
		// --agent skips the auto-reindex entirely: getEffectiveModel() is the only
		// way that path can learn which model answered.
		const indexer = makeIndexer();
		try {
			await indexer.search("anything");

			expect(indexer.getEffectiveModel()).toEqual({
				model: "stored-model",
				adopted: true,
				configuredModel: "configured-model",
			});
		} finally {
			await indexer.close();
		}
	});

	test("an ordinary run reports the configured model and claims no adoption", async () => {
		storedMetadata = { embeddingModel: "configured-model" };

		const result = await runIndex();

		expect(result.embeddingModel).toBe("configured-model");
		expect(result.adoptedIndexedModel).toBe(false);
		expect(result.configuredModel).toBeUndefined();
	});

	test("a force-model rebuild reports the configured model, not an adoption", async () => {
		process.env.MNEMEX_ON_MODEL_MISMATCH = "force-model";

		const result = await runIndex();

		expect(result.embeddingModel).toBe("configured-model");
		expect(result.adoptedIndexedModel).toBe(false);
	});
});

describe("a corrupt index still consults the policy", () => {
	test("decides on the model recorded before the repair wiped it", async () => {
		// The corruption branch calls fileTracker.clear() — `DELETE FROM metadata`,
		// which is where embeddingModel lives. Read after it, the stored model is
		// always null and the whole policy is dead code on exactly the case that
		// motivated it: a corrupt index rebuilt silently against the config's
		// model, which is the reported incident.
		storeIsCorrupt = true;

		await runIndex();

		expect(availabilityProbes).toEqual([
			{ model: "stored-model", provider: "ollama" },
		]);
		// A corrupt index has no vectors worth keeping, so this rebuilds — but
		// with the model the index was built with, not the one config drifted to.
		expect(writtenMetadata.embeddingModel).toBe("stored-model");
		expect(storeClears).toBe(1);
	});

	test("keeps its 'nothing was changed' promise when it is also corrupt", async () => {
		// The repair clears the store and the tracker. If it ran before the
		// availability probe, IndexedModelUnavailableError would still say
		// "Nothing was changed — the index is intact" with the index already
		// emptied. An error that has to describe damage it already did is worse
		// than one that avoided it, so the check runs first.
		storeIsCorrupt = true;
		availabilityAnswer = { ok: false, error: "model not found" };

		const error = await runIndex().then(
			() => null,
			(e: unknown) => e,
		);

		expect(error).toBeInstanceOf(IndexedModelUnavailableError);
		expect((error as Error).message).toContain("the index is intact");
		expect(storeClears).toBe(0);
		expect(trackerClears).toBe(0);
	});
});

describe("an explicit --model outranks the setting", () => {
	test("rebuilds even under use-indexed", async () => {
		process.env.MNEMEX_ON_MODEL_MISMATCH = "use-indexed";

		await runIndex({ model: "explicit-model" });

		expect(storeClears).toBe(1);
		expect(trackerClears).toBe(1);
		expect(availabilityProbes).toEqual([]);
		expect(writtenMetadata.embeddingModel).toBe("explicit-model");
	});
});

describe("no mismatch", () => {
	test("costs nothing extra when the models already agree", async () => {
		storedMetadata = { embeddingModel: "configured-model" };

		await runIndex();

		expect(availabilityProbes).toEqual([]);
		expect(storeClears).toBe(0);
		expect(trackerClears).toBe(0);
		expect(writtenMetadata.embeddingModel).toBe("configured-model");
	});

	test("a first-ever index has no stored model to disagree with", async () => {
		storedMetadata = {};

		await runIndex();

		expect(availabilityProbes).toEqual([]);
		expect(storeClears).toBe(0);
		expect(writtenMetadata.embeddingModel).toBe("configured-model");
	});
});
