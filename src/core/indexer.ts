/**
 * Code Indexer
 *
 * Orchestrates the indexing process: file discovery, chunking,
 * embedding generation, and storage.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
	ensureProjectDir,
	getDocsConfig,
	getEmbeddingModel,
	getExcludePatterns,
	getIndexDbPath,
	getModelMismatchMode,
	getVectorStorePath,
	isDocsEnabled,
	isEnrichmentEnabled,
	isVectorEnabled,
	loadGlobalConfig,
	loadProjectConfig,
} from "../config.js";
import { createDocsFetcher, type DocsFetcher } from "../docs/index.js";
import { createLLMClient } from "../llm/client.js";
import { getParserManager } from "../parsers/parser-manager.js";
import {
	shouldExclude as sharedShouldExclude,
	shouldInclude as sharedShouldInclude,
} from "../shared/pattern-matcher.js";
import type {
	ChunkWithEmbedding,
	CodeChunk,
	CodeUnit,
	CodeUnitWithEmbedding,
	EmbeddingProvider,
	EmbedResult,
	EnrichedIndexResult,
	EnrichmentResult,
	IEmbeddingsClient,
	ILLMClient,
	IndexEmbedCacheStats,
	IndexResult,
	IndexStatus,
	SearchOptions,
	SearchResult,
	SupportedLanguage,
} from "../types.js";
import {
	type CodeUnitExtractor,
	createCodeUnitExtractor,
} from "./ast/code-unit-extractor.js";
import {
	CachingEmbeddingsClient,
	createCachingEmbeddingsClient,
} from "./caching-embeddings-client.js";
import { chunkFileByPath } from "./chunker.js";
import {
	type EmbedCacheLike,
	type EmbedCacheTier,
	openEmbedCache,
	resolveEmbedCacheMode,
} from "./embed-cache.js";
import {
	createEmbeddingsClient,
	embeddingTextFingerprint,
	testModelAvailability,
} from "./embeddings.js";
import {
	createEnricher,
	type Enricher,
	type FileToEnrich,
} from "./enrichment/index.js";
import {
	CURRENT_INDEX_VERSION,
	getIndexVersion,
	setIndexVersion,
} from "./index-version.js";
import {
	formatInvalidationCounts,
	invalidateForCommit,
} from "./invalidation.js";
import {
	createGlobalIndexLock,
	createIndexLock,
	type IIndexLock,
	type LockOptions,
} from "./lock.js";
import { createReferenceGraphManager } from "./reference-graph.js";
import { createRepoMapGenerator } from "./repo-map.js";
import { createVectorStore, type IVectorStore } from "./store.js";
import { createSymbolExtractor } from "./symbol-extractor.js";
import {
	computeFileHash,
	computeHash,
	createFileTracker,
	type IFileTracker,
} from "./tracker.js";

// ============================================================================
// Errors
// ============================================================================

/**
 * Error thrown when search uses a different embedding model than indexing
 */
export class EmbeddingModelMismatchError extends Error {
	constructor(
		public storedModel: string,
		public requestedModel: string,
	) {
		super(
			`Embedding model mismatch!\n` +
				`  Index was created with: ${storedModel}\n` +
				`  You're trying to use: ${requestedModel}\n\n` +
				`Solutions:\n` +
				`  1. Use the same model: mnemex search --model ${storedModel} "query"\n` +
				`  2. Reindex with new model: mnemex index --force --model ${requestedModel}\n` +
				`  3. Let mnemex auto-detect: mnemex search "query" (uses stored model)`,
		);
		this.name = "EmbeddingModelMismatchError";
	}
}

/**
 * Error thrown when the model an index was built with cannot be reached.
 *
 * Raised only under `onModelMismatch: "use-indexed"`, which keeps the stored
 * vectors and adopts the model that produced them. If that model cannot embed,
 * there is no honest way to continue: a query embedded by any other model
 * lands in a different vector space and the results would be noise. Failing
 * here leaves the index untouched, so both exits below stay open.
 */
export class IndexedModelUnavailableError extends Error {
	constructor(
		public storedModel: string,
		public providerError: string,
		public storedProvider?: EmbeddingProvider,
	) {
		// An index written before providers were recorded gives the reader a
		// second, likelier explanation than "the model is down": the request went
		// to whatever provider the config names today, which may never have heard
		// of this model. Saying so is the difference between a fixable error and
		// one whose stated remedies ("start the provider") change nothing.
		const provenance = storedProvider
			? `  Provider on record: ${storedProvider}\n`
			: `  This index predates provider recording, so the request used the provider your config names now.\n` +
				`  That is very likely the real problem, not the model being down.\n`;
		super(
			`The index was built with ${storedModel}, and that model is unavailable.\n` +
				provenance +
				`  Provider error: ${providerError}\n\n` +
				`Nothing was changed — the index is intact. Solutions:\n` +
				`  1. Make ${storedModel} reachable (start its provider, or pull the model)\n` +
				`  2. Rebuild with the model your config names:\n` +
				`     mnemex index --force   (or set "onModelMismatch": "force-model" in config)`,
		);
		this.name = "IndexedModelUnavailableError";
	}
}

/**
 * Narrow a provider name read back out of index metadata.
 *
 * Metadata is free-form text written by some earlier version of mnemex, so it
 * is not trustworthy as a union member. An unreadable value is dropped rather
 * than passed on, which lands on the same path as an index too old to have
 * recorded a provider at all — one behaviour to reason about, not two.
 */
function asEmbeddingProvider(
	value: string | null,
): EmbeddingProvider | undefined {
	const providers: EmbeddingProvider[] = [
		"openrouter",
		"ollama",
		"lmstudio",
		"local",
		"voyage",
	];
	return providers.find((p) => p === value);
}

/**
 * Error thrown when indexing is already in progress by another process.
 *
 * `scope` distinguishes the PER-PROJECT lock ("project", default) from the
 * MACHINE-GLOBAL single-indexer lock ("global"). The 4th constructor arg is
 * optional and defaults to "project" so existing 3-arg call sites/tests are
 * unaffected.
 */
export class IndexLockError extends Error {
	constructor(
		public holderPid: number | undefined,
		public runningFor: number | undefined,
		public reason: "already_running" | "timeout" | "error",
		public scope: "project" | "global" = "project",
	) {
		const runningForSec =
			runningFor !== undefined ? Math.round(runningFor / 1000) : 0;
		const isGlobal = scope === "global";
		let message: string;
		if (reason === "error") {
			message =
				`Failed to acquire ${isGlobal ? "the machine-wide" : "the"} index lock.\n` +
				`  There may be a filesystem error or permissions issue.\n` +
				`  Try running with --force-unlock to clear any stale locks.`;
		} else if (reason === "timeout") {
			message = isGlobal
				? `Timed out waiting for a machine-wide index to complete.\n` +
					`  Another indexer (PID ${holderPid}) has been running for ${runningForSec}s.\n` +
					`  If it is stuck, use --force-unlock in that repo to clear its lock.`
				: `Timed out waiting for indexing to complete.\n` +
					`  Another process (PID ${holderPid}) has been indexing for ${runningForSec}s.\n` +
					`  If the process is stuck, use --force-unlock to clear the lock.`;
		} else {
			message = isGlobal
				? `A machine-wide index (PID ${holderPid}) is already running.\n` +
					`  It has been running for ${runningForSec}s.\n` +
					`  Only one indexer runs at a time across all repos on this machine.`
				: `Another process (PID ${holderPid}) is currently indexing.\n` +
					`  It has been running for ${runningForSec}s.\n` +
					`  Use --wait to wait for it to finish, or --force-unlock if it's stuck.`;
		}
		super(message);
		this.name = "IndexLockError";
	}
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Default max time (ms) a FOREGROUND indexer waits for the machine-global lock
 * before giving up. Generous because a legitimately-running index of a large repo
 * (embed + LanceDB write, possibly rate-limited) can take many minutes. Background
 * reindexers override this with `{ waitTimeout: 0 }` (try-acquire-bail).
 */
const DEFAULT_GLOBAL_LOCK_WAIT = 15 * 60 * 1000; // 15 minutes

// ============================================================================
// Types
// ============================================================================

interface IndexerOptions {
	/** Project root path */
	projectPath: string;
	/** Embedding model to use */
	model?: string;
	/** Additional exclude patterns */
	excludePatterns?: string[];
	/** Include only these patterns */
	includePatterns?: string[];
	/** Progress callback (inProgress = items currently being processed, for animation) */
	onProgress?: (
		current: number,
		total: number,
		file: string,
		inProgress?: number,
	) => void;
	/** Force re-index all files */
	force?: boolean;
	/** Enable LLM enrichment (default: from config) */
	enableEnrichment?: boolean;
	/** Concurrency for LLM enrichment requests (default: 10) */
	enrichmentConcurrency?: number;
	/** Lock options for concurrent access control (the PER-PROJECT lock) */
	lockOptions?: LockOptions;
	/**
	 * Lock options for the MACHINE-GLOBAL single-indexer lock. Defaults to WAIT
	 * (up to DEFAULT_GLOBAL_LOCK_WAIT). Pass `{ waitTimeout: 0 }` for
	 * try-acquire-bail — background reindexers (spawned `mnemex index --if-idle`)
	 * use this so they don't pile up as idle waiters when a machine-wide index is
	 * already running; they exit cleanly and the next debounce trigger retries.
	 */
	globalLockOptions?: LockOptions;
	/** Callback when waiting for another process to finish indexing (per-project) */
	onWaitingForLock?: (holderPid: number, waitedMs: number) => void;
	/** Callback when waiting for the machine-global indexer to finish */
	onWaitingForGlobalLock?: (holderPid: number, waitedMs: number) => void;
}

// ============================================================================
// Indexer Class
// ============================================================================

export class Indexer {
	private projectPath: string;
	private model: string;
	private modelExplicitlySet: boolean;
	private excludePatterns: string[];
	private includePatterns: string[];
	private onProgress?: (
		current: number,
		total: number,
		file: string,
		inProgress?: number,
	) => void;
	private enableEnrichment: boolean;
	private enrichmentConcurrency: number;
	private vectorEnabled: boolean;
	private lockOptions?: LockOptions;
	private globalLockOptions?: LockOptions;
	private onWaitingForLock?: (holderPid: number, waitedMs: number) => void;
	private onWaitingForGlobalLock?: (
		holderPid: number,
		waitedMs: number,
	) => void;

	/**
	 * THE SEAM. On every non-search initialisation this is a
	 * `CachingEmbeddingsClient` wrapping `rawEmbeddingsClient`; on a search
	 * initialisation it IS `rawEmbeddingsClient`, so the read path is byte-for-byte
	 * what it was before the cache existed (NFR-1).
	 *
	 * Assigned in exactly ONE place: `installEmbeddingsClient()`.
	 */
	private embeddingsClient: IEmbeddingsClient | null = null;
	/**
	 * The concrete provider client, never wrapped. The enricher takes THIS one:
	 * its entries are LLM-generated summaries that can never hit a
	 * content-addressed cache, so wrapping it would only add lookups that always
	 * miss.
	 *
	 * Assigned in exactly ONE place: `installEmbeddingsClient()`. Keeping both
	 * fields under one assignment is what stops the seam and the raw client from
	 * ever describing two different models — which is what happens when only the
	 * first of the two `createEmbeddingsClient()` sites is converted, because the
	 * second one (the `use-indexed` adoption) replaces the client wholesale.
	 */
	private rawEmbeddingsClient: IEmbeddingsClient | null = null;
	/**
	 * The machine-global embedding cache, opened by `index()` BEFORE either lock
	 * and `null` on every other path — including `clear()`, which initialises a
	 * client and never embeds, and must not create and DDL a file it will not use.
	 */
	private embedCache: EmbedCacheLike | null = null;
	/**
	 * `GlobalConfig.embedCache`, resolved once per `index()` run. `undefined`
	 * means the user never set it, which is ON — read with `=== false`, never for
	 * falsiness.
	 */
	private embedCacheConfigEnabled: boolean | undefined;
	/**
	 * Set by the v2 -> v3 rebuild branch to the version being upgraded FROM, and
	 * surfaced on `IndexResult.upgradedFromIndexVersion`.
	 */
	private upgradedFromIndexVersion: number | undefined;
	private vectorStore: IVectorStore | null = null;
	private fileTracker: IFileTracker | null = null;
	private llmClient: ILLMClient | null = null;
	private enricher: Enricher | null = null;
	private indexLock: IIndexLock | null = null;
	private globalLock: IIndexLock | null = null;
	private docsFetcher: DocsFetcher | null = null;
	/**
	 * Resolved BEFORE the index lock is acquired, and never re-resolved inside it.
	 *
	 * `getDocsConfig` -> `getContext7ApiKey()` -> a `Bun.spawnSync` against the
	 * macOS Keychain, and `Bun.spawnSync` BLOCKS the event loop, so the index lock's
	 * 1 s heartbeat cannot fire while it is outstanding. `isLockStale`'s secondary
	 * rule reclaims a lock whose heartbeat is older than 10 s regardless of pid
	 * liveness, so a stalled keychain inside the locked region can put a SECOND
	 * indexer on the same LanceDB store.
	 *
	 * WHAT THIS DOES NOT DO, corrected from an earlier claim that said otherwise:
	 * it does NOT eliminate keychain access from the locked region. `initialize()`
	 * runs INSIDE the lock and still resolves credentials there —
	 * `createEmbeddingsClient` -> `getApiKey`/`getVoyageApiKey`, and
	 * `createLLMClient` -> `getAnthropicApiKey`/`getApiKey`/`getOllamaApiKey`. The
	 * property that actually holds the bound is `KEYCHAIN_PROCESS_BUDGET_MS`'s
	 * PRE-FLIGHT CLAMP (`runGuarded` in `keychain.ts`): the sum of all `deps.run`
	 * time in a process is <= 6000 ms by construction and the longest contiguous
	 * block is one `SPAWN_TIMEOUT_MS` (3000 ms), so worst-case heartbeat staleness
	 * stays at 1000 + 6000 = 7000 ms against `DEFAULT_STALE_TIMEOUT` of 10000.
	 *
	 * Anyone raising `SPAWN_TIMEOUT_MS` or `KEYCHAIN_PROCESS_BUDGET_MS` must redo
	 * that arithmetic. Hoisting is a bonus here, not the guarantee.
	 */
	private docsConfigPreLock: ReturnType<typeof getDocsConfig> | null = null;
	private codeUnitExtractor: CodeUnitExtractor | null = null;

	/**
	 * Set when a search would embed its query with a model the index was not
	 * built with — see initialize(). Held rather than thrown so that the callers
	 * which never embed anything (status, keyword-only search) keep working.
	 */
	private searchModelMismatch: { stored: string; configured: string } | null =
		null;

	/**
	 * Set when this indexer used the model recorded in the INDEX instead of the
	 * configured one. Carried as state so it can be returned as data: a progress
	 * notice reaches no surface reliably (--agent passes no callback, the TTY
	 * renderer overwrites detail with "done", the MCP tool passes no callback),
	 * and a silent model substitution is the exact class of behaviour this
	 * release removes.
	 */
	private modelAdoption: { model: string; configuredModel: string } | null =
		null;

	/**
	 * Model/provider pairs already proved reachable by this indexer. One CLI
	 * search calls initialize(true) more than once (getStatus, then search), and
	 * each call would otherwise pay for the same probe again. Only successes are
	 * remembered: a failure must stay re-checkable, or starting the provider
	 * would not fix anything until the process restarts.
	 */
	private probedModels = new Set<string>();

	// Smart incremental reindexing: cache of old chunk vectors by contentHash
	// Used to reuse embeddings for unchanged content, saving API costs
	private oldChunksCache: Map<string, Map<string, number[]>> = new Map();

	constructor(options: IndexerOptions) {
		this.projectPath = options.projectPath;
		this.modelExplicitlySet = !!options.model;
		this.model = options.model || getEmbeddingModel(options.projectPath);
		// Get exclude patterns from config (includes defaults, gitignore, etc.)
		this.excludePatterns = [
			...getExcludePatterns(options.projectPath),
			...(options.excludePatterns || []),
		];
		// Get config options
		const projectConfig = loadProjectConfig(options.projectPath);
		this.includePatterns =
			options.includePatterns || projectConfig?.includePatterns || [];

		this.onProgress = options.onProgress;

		// Enrichment enabled by default (from config), can be overridden
		this.enableEnrichment =
			options.enableEnrichment ?? isEnrichmentEnabled(options.projectPath);
		this.enrichmentConcurrency = options.enrichmentConcurrency ?? 10;

		// Vector embeddings enabled by default (from config)
		this.vectorEnabled = isVectorEnabled(options.projectPath);

		// Lock options for concurrent access control
		this.lockOptions = options.lockOptions;
		this.globalLockOptions = options.globalLockOptions;
		this.onWaitingForLock = options.onWaitingForLock;
		this.onWaitingForGlobalLock = options.onWaitingForGlobalLock;
	}

	/**
	 * The model this indexer actually used, and where it came from.
	 *
	 * `adopted` is true when it came from the index rather than from config.
	 * Callers that never run index() — a plain search — read it after search()
	 * or getStatus(), which is when the adoption on the retrieval path happens.
	 */
	getEffectiveModel(): {
		model: string;
		adopted: boolean;
		configuredModel?: string;
	} {
		if (this.modelAdoption) {
			return {
				model: this.modelAdoption.model,
				adopted: true,
				configuredModel: this.modelAdoption.configuredModel,
			};
		}
		return { model: this.model, adopted: false };
	}

	/** Remember that `model` was used in place of the configured `configuredModel`. */
	private recordModelAdoption(model: string, configuredModel: string): void {
		this.modelAdoption = { model, configuredModel };
	}

	/**
	 * Throw IndexedModelUnavailableError unless this exact model/provider pair
	 * can embed. Call ONLY on a detected mismatch — it costs a round-trip.
	 */
	private async assertModelAvailable(
		model: string,
		provider: EmbeddingProvider | undefined,
	): Promise<void> {
		const key = `${provider ?? "<unset>"}|${model}`;
		if (this.probedModels.has(key)) return;

		const availability = await testModelAvailability(model, provider);
		if (!availability.ok) {
			throw new IndexedModelUnavailableError(
				model,
				availability.error ?? "unknown error",
				provider,
			);
		}
		this.probedModels.add(key);
	}

	/**
	 * THE ONLY place either embeddings-client field is assigned.
	 *
	 * Both `createEmbeddingsClient()` sites go through it — the one in
	 * `initialize()` and the one in the `use-indexed` adoption branch of
	 * `indexInternal()` — so the raw client and the seam can never describe two
	 * different models. That failure is silent and expensive: the adoption branch
	 * replaces the client wholesale, so a proxy installed only in `initialize()`
	 * would either be destroyed there, or would keep embedding with the
	 * CONFIGURED model while the run records the ADOPTED one — writing vectors
	 * under the wrong model identity into a cache that is shared by every repo on
	 * the machine.
	 *
	 * `forSearch` leaves the seam UNWRAPPED. `search()` and `getStatus()` call
	 * `initialize(true)` and must keep today's read path byte-for-byte (NFR-1);
	 * `initialize()` is not memoised and `index()` always calls it with the
	 * default `false`, so an index run after a search re-wraps correctly.
	 *
	 * Enrichment stays outside the seam by taking `rawEmbeddingsClient`.
	 */
	private installEmbeddingsClient(
		raw: IEmbeddingsClient,
		forSearch: boolean,
	): void {
		this.rawEmbeddingsClient = raw;
		this.embeddingsClient = forSearch
			? raw
			: createCachingEmbeddingsClient(raw, {
					// `null` on every path but `index()`; the proxy then serves the
					// in-process L0 memo only, which costs nothing and creates no file.
					cache: this.embedCache,
					configEnabled: this.embedCacheConfigEnabled,
					// Computed HERE because the proxy may not import `embeddings.ts`.
					clientFingerprint: embeddingTextFingerprint(raw),
				});
	}

	/**
	 * The seam, narrowed to the three members the index path needs that are not
	 * on `IEmbeddingsClient` — `embedContentOf`, `keyFor` and `stats`.
	 *
	 * Non-null and a `CachingEmbeddingsClient` on every non-search
	 * initialisation, because `installEmbeddingsClient` wraps unconditionally
	 * when `forSearch` is false — including when the cache is off, where the
	 * proxy's mode is "off" and it passes straight through to the inner client.
	 *
	 * Throws rather than falling back, deliberately: a fallback would be a second
	 * embedding code path that no test exercises and that would silently bypass
	 * the NFR-2 assertion in `embedContentOf`. This throw is unreachable by
	 * construction and says so.
	 */
	private cachingSeam(): CachingEmbeddingsClient {
		const client = this.embeddingsClient;
		if (!(client instanceof CachingEmbeddingsClient)) {
			throw new Error("index path reached without the caching seam installed");
		}
		return client;
	}

	/** The RUNTIME tier — degradation moves this, never the user's mode. */
	private embedCacheTier(): EmbedCacheTier {
		return this.embeddingsClient instanceof CachingEmbeddingsClient
			? this.embeddingsClient.stats().tier
			: "none";
	}

	/** What the cache did this run, for `IndexResult`. Null when it never ran. */
	private embedCacheResultStats(): IndexEmbedCacheStats | undefined {
		if (!(this.embeddingsClient instanceof CachingEmbeddingsClient)) {
			return undefined;
		}
		const stats = this.embeddingsClient.stats();
		return {
			tier: stats.tier,
			hits: stats.hits,
			misses: stats.misses,
			writes: stats.writes,
		};
	}

	/**
	 * Initialize all components
	 * @param forSearch - If true, use stored embedding model (for retrieval consistency)
	 */
	private async initialize(forSearch = false): Promise<void> {
		// Ensure project directory exists
		ensureProjectDir(this.projectPath);

		// Initialize parser manager
		const parserManager = getParserManager();
		await parserManager.initialize();

		// Initialize code unit extractor (always available, falls back to file-level unit)
		this.codeUnitExtractor = createCodeUnitExtractor();

		// Create file tracker first (to read stored metadata)
		const indexDbPath = getIndexDbPath(this.projectPath);
		this.fileTracker = createFileTracker(indexDbPath, this.projectPath);

		// Create embeddings client only when vector mode is enabled
		if (this.vectorEnabled) {
			// For search operations, use the stored embedding model to ensure consistency
			let modelToUse = this.model;
			let providerToUse: EmbeddingProvider | undefined;
			// Cleared on every initialize(): this object is reused across an
			// auto-reindex and the search that follows it, and the reindex may have
			// resolved the very mismatch a previous pass recorded.
			this.searchModelMismatch = null;
			if (forSearch) {
				const storedModel = this.fileTracker.getMetadata("embeddingModel");
				if (storedModel) {
					// If user explicitly requested a different model, throw clear error
					if (this.modelExplicitlySet && this.model !== storedModel) {
						throw new EmbeddingModelMismatchError(storedModel, this.model);
					}
					// Otherwise `onModelMismatch` decides. 'use-indexed' adopts the
					// stored model — the only way to query vectors built by it — and
					// takes the provider from the index too, because a bare model name
					// resolves against today's config and would be sent to the wrong
					// provider (see the adopt path in indexInternal).
					if (getModelMismatchMode(this.projectPath) === "use-indexed") {
						modelToUse = storedModel;
						providerToUse = asEmbeddingProvider(
							this.fileTracker.getMetadata("embeddingProvider"),
						);
						// Prove the adopted model can embed BEFORE anything uses it.
						// index() probes on its own path, but a search does not always
						// run index(): --agent skips the auto-reindex, --no-reindex
						// skips it, and the MCP tool swallows its failure. Without this
						// the first sign of an unreachable model is whatever the query
						// layer says about the vector it got back — observed:
						// "No vector column found to match with the query vector
						// dimension: 0", which names neither the model nor the cause.
						//
						// Only on a real mismatch. When the two agree — the normal
						// search, every time — there is nothing to prove and no
						// network call is made.
						if (storedModel !== this.model) {
							await this.assertModelAvailable(storedModel, providerToUse);
							// A search adopts without ever calling index(), so this is
							// the only place the retrieval path can record the fact for
							// the CLI and the MCP tool to report.
							this.recordModelAdoption(storedModel, this.model);
						}
					} else if (storedModel !== this.model) {
						// 'force-model' asked for the configured model everywhere, and
						// the reindex normally rebuilds the index with it before any
						// search. When that reindex did NOT run — --agent skips it,
						// --no-reindex skips it, the MCP tool treats its failure as
						// non-fatal — embedding the query with the configured model
						// searches a different vector space than the table holds. If
						// the widths differ that is a LanceDB error; if they happen to
						// match (768 is common) it is silent nonsense. Record it and
						// let search() refuse; status and keyword-only search stay
						// usable because neither embeds a query.
						this.searchModelMismatch = {
							stored: storedModel,
							configured: this.model,
						};
					}
				}
			}

			// Create embeddings client with appropriate model.
			// Through installEmbeddingsClient, which is the ONLY assignment to
			// either client field — see its docstring.
			this.installEmbeddingsClient(
				createEmbeddingsClient({
					model: modelToUse,
					provider: providerToUse,
				}),
				forSearch,
			);
		}

		// Create vector store
		const vectorStorePath = getVectorStorePath(this.projectPath);
		this.vectorStore = createVectorStore(vectorStorePath);
		await this.vectorStore.initialize();

		// Initialize enrichment if enabled (requires vector mode for embeddings).
		//
		// NOT on the read paths. `search()` and `getStatus()` call
		// `initialize(true)` and never enrich, yet they were constructing the
		// default LLM client — which on darwin reads Claude Code's OAuth token out
		// of the login keychain. So `mnemex search` and `mnemex status` each paid a
		// credential read, and a provider that cannot be reached made them THROW
		// "Enrichment failed to initialize" for a query that needs no LLM at all.
		// External review flagged the construction; the read path not needing it is
		// the reason it should never have been there.
		if (!forSearch && this.enableEnrichment && this.vectorEnabled) {
			try {
				this.llmClient = await createLLMClient({}, this.projectPath);
				// The RAW client, not the seam. Enrichment embeds LLM-generated
				// summaries, which are new text every time and can never hit a
				// content-addressed cache, so wrapping it would buy a lookup that
				// always misses and a write that is never read.
				this.enricher = createEnricher(
					this.llmClient,
					this.rawEmbeddingsClient!,
					this.vectorStore,
					this.fileTracker,
				);
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				throw new Error(
					`Enrichment failed to initialize: ${msg}\n` +
						`LLM enrichment is enabled by default and requires a running LLM provider.\n` +
						`Either:\n` +
						`  • Start your LLM provider (e.g. LM Studio, Ollama)\n` +
						`  • Or run with --no-llm to skip enrichment`,
				);
			}
		}

		// Initialize docs fetcher if enabled. The pre-lock config is PASSED IN rather
		// than only stored: `createDocsFetcher(projectPath)` re-resolves it — a
		// second `getContext7ApiKey()`, inside the lock — so hoisting it and then not
		// using it here bought nothing.
		if (isDocsEnabled(this.projectPath) && this.vectorEnabled) {
			this.docsFetcher = createDocsFetcher(
				this.projectPath,
				this.docsConfigPreLock ?? undefined,
			);
		}
	}

	/** Maximum files to process per batch (limits memory usage) */
	private static readonly FILES_PER_BATCH = 500;

	/**
	 * Index the codebase
	 */
	async index(force = false): Promise<EnrichedIndexResult> {
		const startTime = Date.now();

		// Ensure project directory exists before acquiring lock
		ensureProjectDir(this.projectPath);

		// Resolve anything that can reach the macOS Keychain BEFORE acquiring a lock.
		// See `docsConfigPreLock`.
		//
		// GATED on docs actually being used. `getDocsConfig` calls
		// `getContext7ApiKey()`, so calling it unconditionally added a keychain
		// lookup — and, on a locked keychain, a stall — to every index run of every
		// project with docs or vectors disabled, which is work for a feature that is
		// switched off. The two predicates are plain config reads and cost nothing.
		this.docsConfigPreLock =
			this.vectorEnabled && isDocsEnabled(this.projectPath)
				? getDocsConfig(this.projectPath)
				: null;

		// Open the embedding cache BEFORE either lock, for the same reason the docs
		// config is resolved here: the open sequence is the one region of this
		// feature whose duration is not constant-bounded. It creates the directory,
		// opens the file, and takes a brief exclusive lock for the WAL pragma —
		// all before `busy_timeout` is set at all. Inside the locks that would be
		// unbounded blocking against `isLockStale`'s 10 s heartbeat rule; outside
		// them it is not in the budget at all.
		//
		// `null` on failure, always: the cache is an optimisation and the only
		// thing a failure of it may ever cost is a recompute. The config opt-out is
		// resolved first so a user who turned the cache off does not get a SQLite
		// file created and DDL'd for something that will never be read.
		this.embedCacheConfigEnabled = loadGlobalConfig().embedCache;
		this.embedCache =
			resolveEmbedCacheMode(this.embedCacheConfigEnabled) === "off"
				? null
				: openEmbedCache();

		// LOCK ORDERING (deadlock-safe): ALWAYS acquire the MACHINE-GLOBAL lock
		// FIRST, then the PER-PROJECT lock; release in REVERSE (project first, then
		// global). Because every indexer follows the same global-before-project
		// order, two indexers can never hold one lock while waiting on the other.
		//
		// The global lock serializes indexers across DIFFERENT repos on this machine
		// so N Claude Code sessions don't run N concurrent detached reindexers all
		// competing for the one machine + one shared embeddings API quota.
		this.globalLock = createGlobalIndexLock();
		const globalResult = await this.globalLock.acquire({
			waitTimeout: DEFAULT_GLOBAL_LOCK_WAIT,
			...this.globalLockOptions,
			onWaiting: this.onWaitingForGlobalLock,
		});

		if (!globalResult.acquired) {
			// Bail case (typically background --if-idle, waitTimeout:0): a machine-wide
			// index is already running. Do NOT proceed to index and do NOT hang.
			this.globalLock = null;
			throw new IndexLockError(
				globalResult.holderPid,
				globalResult.runningFor,
				globalResult.reason as "already_running" | "timeout" | "error",
				"global",
			);
		}

		// Acquire per-project lock to prevent concurrent indexing of THIS repo.
		this.indexLock = createIndexLock(this.projectPath);
		const lockResult = await this.indexLock.acquire({
			...this.lockOptions,
			onWaiting: this.onWaitingForLock,
		});

		if (!lockResult.acquired) {
			// Release the global lock we already hold before bailing (reverse order).
			this.indexLock = null;
			this.globalLock.release();
			this.globalLock = null;
			throw new IndexLockError(
				lockResult.holderPid,
				lockResult.runningFor,
				lockResult.reason as "already_running" | "timeout" | "error",
			);
		}

		try {
			return await this.indexInternal(force, startTime);
		} finally {
			// Always release locks when done, in REVERSE acquire order:
			// per-project first, then machine-global.
			this.indexLock.release();
			this.indexLock = null;
			this.globalLock.release();
			this.globalLock = null;
		}
	}

	/**
	 * Stamp forward progress on BOTH the per-project and machine-global locks.
	 * Keeping the global lock's `lastProgressAt` fresh while genuinely working stops
	 * it from being falsely reclaimed; when the indexer truly wedges, both stop
	 * advancing and the global holder is correctly reclaimed after the progress
	 * timeout. No-op on whichever lock this process does not own.
	 */
	private reportProgress(): void {
		for (const lock of [this.indexLock, this.globalLock]) {
			lock?.recordProgress();
		}
	}

	/**
	 * Record the current phase on BOTH the per-project and machine-global locks so
	 * a hang is attributable to a phase on either. Reporting only — does NOT affect
	 * the hung decision (which is driven by lastProgressAt / reportProgress).
	 */
	private reportPhase(phase: string): void {
		for (const lock of [this.indexLock, this.globalLock]) {
			lock?.setPhase(phase);
		}
	}

	/** Manifest files that trigger docs re-fetch when changed */
	private static readonly MANIFEST_FILES = new Set([
		"package.json",
		"requirements.txt",
		"pyproject.toml",
		"go.mod",
		"Cargo.toml",
	]);

	/**
	 * Internal indexing logic (called after lock acquired)
	 */
	private async indexInternal(
		force: boolean,
		startTime: number,
	): Promise<EnrichedIndexResult> {
		// What the CALLER asked for, captured before the corruption branch below
		// sets `force` for its own reasons. `--force` is an explicit instruction to
		// rebuild, so it decides the model the same way an explicit `--model` does
		// — and it is the escape hatch both mismatch errors advertise. Without
		// this, `mnemex index --force` on an unreachable stored model re-probes
		// that same model and throws the identical error: a documented remedy that
		// loops. A corruption-driven rebuild is NOT a caller instruction and must
		// not be read as one, which is why this is captured first.
		const forceRequested = force;

		await this.initialize();

		// Resolve the commit anchor ONCE for the whole run. Everything written
		// below (files via markIndexed, documents via the enricher) is stamped
		// with this SHA, so there is no per-file git subprocess.
		//
		// Non-git projects and git failures return null, which leaves the
		// provenance columns NULL — "unknown", which reads as valid. Provenance
		// is an enrichment on the index and is never a reason to fail a run.
		const head = await this.fileTracker!.recordHeadCommit();

		// Walk the diff of the commit that produced this state and invalidate the
		// memories it made wrong. This is the path a post-commit hook drives
		// (`mnemex index`), and it runs BEFORE enrichment so anything queued for
		// re-derivation is picked up by this same run.
		//
		// One `git diff` per run, not per file. Returns null and changes nothing
		// outside a git repository or on any git failure — never a new way for an
		// index run to fail.
		const invalidation = await invalidateForCommit(
			this.projectPath,
			this.fileTracker!,
			{ head },
		);
		if (invalidation) {
			this.fileTracker!.recordActivity("invalidation", {
				...invalidation,
			});
			this.onProgress?.(
				0,
				0,
				`[invalidating] ${formatInvalidationCounts(invalidation)}`,
			);
		}

		// Read the index's identity BEFORE anything can erase it. The corruption
		// branch below calls fileTracker.clear(), which does `DELETE FROM metadata`
		// — the row these two values live in. Reading them afterwards returns null
		// on every corrupt index, which would make the whole mismatch decision
		// below dead code on exactly the case that motivated it.
		const previousModel = this.fileTracker!.getMetadata("embeddingModel");
		const previousProvider = asEmbeddingProvider(
			this.fileTracker!.getMetadata("embeddingProvider"),
		);

		// An index whose vector column is FixedSizeList[0] answers no query at all,
		// so there is nothing to weigh: dropping it loses no capability, and
		// leaving it means every search fails. That is why it rebuilds without
		// asking, unlike a model change — there the stored vectors are valid, just
		// built by another model, so the rebuild is a real cost trade.
		const wasCorrupt = await this.vectorStore!.isUnqueryable();

		// The index records the model that built it (read above). When that is not
		// the model this run would use, `onModelMismatch` decides which one gives
		// way — see getModelMismatchMode() for why the default keeps the index.
		const mismatch = !!previousModel && previousModel !== this.model;
		// An explicit `--model` or `--force` is an instruction, not a preference:
		// it outranks the policy, exactly as `--model` does on the search path
		// (where initialize() turns the same disagreement into
		// EmbeddingModelMismatchError).
		const mode = !mismatch
			? undefined
			: this.modelExplicitlySet || forceRequested
				? "force-model"
				: getModelMismatchMode(this.projectPath);

		// DECIDE AND VALIDATE BEFORE MUTATING ANYTHING.
		//
		// The availability probe can throw IndexedModelUnavailableError, whose
		// message promises "Nothing was changed — the index is intact". That
		// promise is only true if nothing has been cleared yet — and the
		// corruption repair below clears both the store and the tracker. Running
		// the probe first keeps the message honest for every combination,
		// including corrupt-and-mismatched, rather than teaching the error to
		// describe damage it already did.
		//
		// The stored PROVIDER matters as much as the stored model.
		// createEmbeddingsClient() infers the provider from the model string and
		// falls back to the ambient config when nothing matches, so a bare name
		// like "nomic-embed-text" would be requested from whatever provider the
		// config names today — Voyage asked for an Ollama model. Indexes written
		// before this change have no provider on record; there is nothing to infer
		// from, so try the model alone and let the error say so.
		const willAdopt = mismatch && mode === "use-indexed";
		if (willAdopt) {
			await this.assertModelAvailable(previousModel!, previousProvider);
		}

		// ── From here on, mutations. ──────────────────────────────────────────
		// True once the store has been emptied by any branch below, so the
		// `if (force)` block does not empty it a second time. Keyed on "did we
		// clear", never on "was there a reason to" — adopting clears nothing, and
		// a `--force` run that skipped its clear would re-index into a non-empty
		// table.
		let alreadyCleared = false;

		if (wasCorrupt) {
			// onProgress, not console.log: the MCP search tool runs this same
			// index() in-process, and stdout there is the JSON-RPC stream.
			this.onProgress?.(
				0,
				0,
				"[repairing] the vector index had a 0-dimension vector column, so no query could read it — rebuilding it now",
			);
			await this.vectorStore!.clear();
			this.fileTracker!.clear();
			alreadyCleared = true;
			force = true;
		}

		if (mismatch && mode === "force-model") {
			// Reported through onProgress, never console.log: the MCP search tool
			// runs this same index() in-process and stdout there is the JSON-RPC
			// stream (see the `[invalidating]` notice above for the precedent).
			this.onProgress?.(
				0,
				0,
				`[model] ${previousModel} → ${this.model}: the stored vectors came from the old model, rebuilding the whole index`,
			);
			if (!alreadyCleared) {
				await this.vectorStore!.clear();
				this.fileTracker!.clear();
				alreadyCleared = true;
			}
			force = true; // Treat as force reindex
		}

		if (willAdopt) {
			// 'use-indexed': the stored vectors are fine, they just belong to
			// another model. Adopt that model; nothing is cleared for it.
			this.recordModelAdoption(previousModel!, this.model);
			this.model = previousModel!;
			// THE SECOND createEmbeddingsClient() SITE, and the one that is easy to
			// miss: this branch is the production default for a model mismatch and
			// it replaces the client wholesale. It goes through the same single
			// assignment point, with forSearch=false, so the seam and the raw client
			// both move to the adopted model together.
			this.installEmbeddingsClient(
				createEmbeddingsClient({
					model: this.model,
					provider: previousProvider,
				}),
				false,
			);
			// The enricher captured the OLD client by value in initialize(), so
			// without this it would keep embedding summaries with the configured
			// model and mix two vector spaces into one table.
			// `this.rawEmbeddingsClient` is in the condition rather than asserted:
			// the `installEmbeddingsClient` call directly above assigns it
			// unconditionally, so this is a narrowing, not a guard — and it is the
			// one non-null assertion this feature would have ADDED to a site that
			// had none (the pre-cache code passed `this.embeddingsClient` here,
			// which was already non-optional).
			if (this.enricher && this.llmClient && this.rawEmbeddingsClient) {
				this.enricher = createEnricher(
					this.llmClient,
					this.rawEmbeddingsClient,
					this.vectorStore!,
					this.fileTracker!,
				);
			}

			// One of FOUR channels for this fact, none of which reaches every
			// surface alone: --agent has no progress callback, the TTY renderer
			// truncates detail and then overwrites it with "done", and the MCP tool
			// passes no callback at all. The authoritative one is the result object
			// (see `embeddingModel` / `adoptedIndexedModel` on IndexResult).
			this.onProgress?.(
				0,
				0,
				`[model] using ${this.model}, the model this index was built with, instead of ${this.modelAdoption?.configuredModel} ` +
					`(set onModelMismatch: "force-model" to rebuild with ${this.modelAdoption?.configuredModel})`,
			);
		}

		// ── Index v2 -> v3: the table predates the embedKey column ────────────
		//
		// A v3 batch carries 23 fields; a live v2 table has 22 columns and LanceDB
		// 0.38 rejects the whole `add` with "Found field not in schema: embedKey".
		// So the table has to be rebuilt once. There is no seeding pass and no
		// in-place migration: this run re-embeds, and every run after it is served
		// from the cache the rebuild fills.
		//
		// Guarded by `!force` because everything above has already decided whether
		// the table survives — the corruption repair and the force-model rebuild
		// both set `force` AND `alreadyCleared`, and asking a cleared store about
		// its schema would answer for a table that no longer exists.
		if (!force) {
			const shape = await this.vectorStore!.hasEmbedKeyColumn();
			// `=== false`, never falsy: `null` means "no table to ask", which is a
			// fresh index and needs no migration.
			if (shape === false) {
				this.upgradedFromIndexVersion = getIndexVersion(this.projectPath);
				// onProgress, not console.log: the MCP search tool runs this same
				// index() in-process and stdout there is the JSON-RPC stream. It
				// reaches at most two of the four entry points, which is why
				// `upgradedFromIndexVersion` on the result is the authoritative
				// channel.
				this.onProgress?.(
					0,
					0,
					"[migrating] this index predates the embedding-cache key column. " +
						"Rebuilding it once — this run re-embeds; every run after it is served from the cache.",
				);
				force = true;
			}
		}

		// Discover files
		this.reportPhase("discovering");
		const allFiles = this.discoverFiles();

		// Get changes
		let filesToIndex: string[];
		let deletedFiles: string[] = [];
		let manifestFilesChanged = force; // Always refresh docs on force reindex

		if (force) {
			// Force re-index all files
			filesToIndex = allFiles;
			// Clear existing data (skip if the corruption or model-change branch
			// above already did it)
			if (!alreadyCleared) {
				await this.vectorStore!.clear();
				this.fileTracker!.clear();
			}
		} else {
			// Incremental indexing
			const changes = this.fileTracker!.getChanges(allFiles);
			filesToIndex = [...changes.newFiles, ...changes.modifiedFiles];
			deletedFiles = changes.deletedFiles;

			// Check if any manifest files changed (to decide if docs phase should run)
			for (const file of filesToIndex) {
				const basename = file.split("/").pop() || "";
				if (Indexer.MANIFEST_FILES.has(basename)) {
					manifestFilesChanged = true;
					break;
				}
			}

			// Remove deleted files from index
			for (const deletedFile of deletedFiles) {
				const chunkIds = this.fileTracker!.getChunkIds(deletedFile);
				if (chunkIds.length > 0) {
					await this.vectorStore!.deleteByFile(deletedFile);
				}
				this.fileTracker!.removeFile(deletedFile);
			}

			// SMART INCREMENTAL: Collect old chunks for modified files BEFORE deleting
			// This allows us to reuse embeddings for unchanged content
			//
			// ONLY THE POPULATION IS GATED. This loop does TWO things and the
			// second is a mutation: `deleteByFile` below is the only place in the
			// tree where a MODIFIED file's previous chunks are removed from
			// LanceDB (the deleted-files loop above covers a disjoint set), and
			// `addChunks` appends — no upsert, no primary key. Gating the whole
			// loop on the tier therefore skips the delete on the healthy path and
			// leaves every past edit's chunks in the table alongside the new ones:
			// unbounded duplicate accumulation, with retrieval returning ghost
			// chunks from every previous version of the file.
			//
			// Reused from LanceDB only when the persistent cache is NOT serving
			// this run. On the healthy path the cache covers the same reuse
			// across files and repos, and one seam is what makes the hit rate
			// measurable; on any degraded or off path this is the only reuse
			// there is, and it needs no cache file, no network call and no known
			// dimension. The tier is read once, before the loop.
			const reuseFromLance = this.embedCacheTier() !== "sqlite";
			for (const modifiedFile of changes.modifiedFiles) {
				if (reuseFromLance) {
					// Chunks are stored with absolute paths, so use absolute path for lookups
					const oldChunks =
						await this.vectorStore!.getChunksWithVectors(modifiedFile);
					if (oldChunks.length > 0) {
						// Store old chunks indexed by contentHash for O(1) lookup
						// Key by absolute path to match during embedding phase
						const oldChunksMap = new Map<string, number[]>();
						for (const chunk of oldChunks) {
							if (chunk.contentHash && chunk.vector.length > 1) {
								// >1 to exclude placeholder [0]
								oldChunksMap.set(chunk.contentHash, chunk.vector);
							}
						}
						this.oldChunksCache.set(modifiedFile, oldChunksMap);
					}
				}
				// Now delete old data (use absolute path to match stored chunks).
				// NEVER GATED — see above.
				await this.vectorStore!.deleteByFile(modifiedFile);
				this.fileTracker!.resetEnrichmentState(modifiedFile);
			}
		}

		// Process files in batches to limit memory usage
		// Each batch: parse → embed → store → release memory
		const skippedFiles: string[] = [];
		const errors: Array<{ file: string; error: string }> = [];
		/**
		 * Files whose tracker stamp was deferred and whose rows were removed
		 * again, so the next run redoes them. Relative paths, for the report.
		 */
		const deferredFiles = new Set<string>();
		let totalFilesIndexed = 0;
		let totalChunksCreated = 0;
		let totalCodeUnitsCreated = 0;
		let totalCost = 0;
		let totalTokens = 0;

		// Track files for enrichment (file -> chunks mapping)
		const fileChunksForEnrichment: FileToEnrich[] = [];

		// PARALLEL MODE: Run AST extraction and enrichment in parallel
		// Conditions: embedding is local (uses GPU/CPU) AND LLM is cloud (uses network)
		const canParallelizeEnrichment =
			this.enableEnrichment &&
			this.enricher &&
			this.vectorEnabled &&
			this.embeddingsClient?.isLocal() &&
			this.llmClient?.isCloud();

		const totalBatches = Math.ceil(
			filesToIndex.length / Indexer.FILES_PER_BATCH,
		);

		for (let batchNum = 0; batchNum < totalBatches; batchNum++) {
			const batchStart = batchNum * Indexer.FILES_PER_BATCH;
			const batchEnd = Math.min(
				batchStart + Indexer.FILES_PER_BATCH,
				filesToIndex.length,
			);
			const batchFiles = filesToIndex.slice(batchStart, batchEnd);

			// Phase 1: Parse and chunk batch of files
			const batchChunks: Array<{
				chunk: CodeChunk;
				filePath: string;
				fileHash: string;
			}> = [];

			for (let i = 0; i < batchFiles.length; i++) {
				const filePath = batchFiles[i];
				const relativePath = relative(this.projectPath, filePath);
				const globalIndex = batchStart + i + 1;

				// Report progress (parsing phase) - show "X/Y" with filename, or just "X/Y files" at completion
				if (this.onProgress) {
					const batchInfo =
						totalBatches > 1 ? ` [batch ${batchNum + 1}/${totalBatches}]` : "";
					const isLast = globalIndex === filesToIndex.length;
					const detail = isLast
						? `${globalIndex}/${filesToIndex.length} files`
						: `${globalIndex}/${filesToIndex.length} ${relativePath}`;
					this.onProgress(
						globalIndex,
						filesToIndex.length,
						`[parsing]${batchInfo} ${detail}`,
					);
				}

				try {
					const content = readFileSync(filePath, "utf-8");
					const fileHash = computeFileHash(filePath);
					const chunks = await chunkFileByPath(content, filePath, fileHash);

					if (chunks.length === 0) {
						skippedFiles.push(relativePath);
					} else {
						for (const chunk of chunks) {
							batchChunks.push({ chunk, filePath, fileHash });
						}
					}
				} catch (error) {
					const errorMsg =
						error instanceof Error ? error.message : String(error);
					errors.push({ file: relativePath, error: errorMsg });
				}
			}

			// Skip embedding/storing if no chunks in this batch
			if (batchChunks.length === 0) {
				continue;
			}

			// Phase 2: Embed batch chunks (skip if vector mode disabled)
			// SMART INCREMENTAL: Reuse vectors from cache for unchanged chunks
			const batchInfo =
				totalBatches > 1 ? ` [batch ${batchNum + 1}/${totalBatches}]` : "";
			let validChunks: Array<{
				chunk: CodeChunk;
				filePath: string;
				fileHash: string;
				vector: number[];
				embedKey: string;
			}>;

			/**
			 * Files in THIS batch that lost at least one chunk to an empty vector.
			 *
			 * Their tracker stamp is deferred and their rows are removed again, so
			 * the next run redoes them from scratch. Both halves are required: a
			 * deferral that skipped only `markIndexed` would leave rows in LanceDB
			 * and no row in the tracker, `getChanges` classifies a file with no
			 * tracker row as NEW, new files never reach the modified-files
			 * `deleteByFile`, and `addChunks` appends — so every later run would
			 * append another copy, permanently and per run.
			 */
			const filesWithMissingVectors = new Set<string>();

			if (this.vectorEnabled) {
				// Separate chunks into: cached (reuse vector) vs new (need embedding)
				const chunksNeedingEmbedding: Array<{
					chunk: CodeChunk;
					filePath: string;
					fileHash: string;
					originalIndex: number;
				}> = [];
				const cachedChunks: Array<{
					chunk: CodeChunk;
					filePath: string;
					fileHash: string;
					vector: number[];
					embedKey: string;
				}> = [];

				for (let i = 0; i < batchChunks.length; i++) {
					const { chunk, filePath, fileHash } = batchChunks[i];
					// Cache is keyed by absolute path (filePath is already absolute)
					const cachedVectors = this.oldChunksCache.get(filePath);

					if (
						cachedVectors &&
						chunk.contentHash &&
						cachedVectors.has(chunk.contentHash)
					) {
						// REUSE: Same content found in cache - skip embedding API call!
						const reusedVector = cachedVectors.get(chunk.contentHash)!;
						cachedChunks.push({
							chunk,
							filePath,
							fileHash,
							vector: reusedVector,
							// FR-2 holds on this path too: the row carries the key the
							// seam WOULD have computed for it, from the seam's own
							// formula, at the reused vector's actual width. The formula
							// still lives in exactly one file.
							embedKey: this.cachingSeam().keyFor(
								chunk.content,
								reusedVector.length,
							),
						});
					} else {
						// NEW: Content changed or new chunk - needs embedding
						chunksNeedingEmbedding.push({
							chunk,
							filePath,
							fileHash,
							originalIndex: i,
						});
					}
				}

				const reusedCount = cachedChunks.length;
				const newCount = chunksNeedingEmbedding.length;

				if (this.onProgress) {
					const reuseInfo = reusedCount > 0 ? ` (${reusedCount} reused)` : "";
					this.onProgress(
						0,
						batchChunks.length,
						`[embedding]${batchInfo} ${newCount} new${reuseInfo}...`,
					);
				}

				// Only call embedding API for chunks that actually need it
				let newlyEmbeddedChunks: Array<{
					chunk: CodeChunk;
					filePath: string;
					fileHash: string;
					vector: number[];
					embedKey: string;
				}> = [];

				if (chunksNeedingEmbedding.length > 0) {
					const items = chunksNeedingEmbedding.map((c) => c.chunk);
					let embedResult: EmbedResult;

					try {
						// Pass progress callback to track embedding progress
						this.reportPhase("embedding");
						// `embedContentOf`, not `embed(texts)`: the cache key is over
						// the chunk's OWN content, so the texts are derived inside the
						// seam and re-checked against the items at dispatch. A transform
						// inserted between the two would otherwise make every key
						// address a vector for text that was never embedded.
						embedResult = await this.cachingSeam().embedContentOf(
							items,
							"chunks",
							(completed, total, inProgress, cachedHits) => {
								// Stamp the lock per item, not just once per batch below.
								// A single batch against a network embedding provider can run
								// for minutes; stamping only at batch end left
								// `lastProgressAt` untouched past the 5-minute hung threshold
								// (measured: 363s) on a perfectly healthy run, making the
								// lock reclaimable mid-index.
								this.reportProgress();
								if (this.onProgress) {
									const reuseInfo =
										reusedCount > 0 ? ` (${reusedCount} reused)` : "";
									// `completed` counts every slot the seam RESOLVED, cache
									// hits included, so the word "new" becomes a false claim
									// the moment the cache serves anything: an all-hits batch
									// would report "500/500 new" for work that never reached
									// the provider. `(N cached)` is what makes a fast run
									// legible instead of looking free or stalled.
									//
									// `(N reused)` is the OTHER reuse path (LanceDB vectors,
									// §7.5's L1) and is only ever populated when the
									// persistent tier is off or degraded. Both can therefore
									// be non-zero at once on the degraded tier, and both are
									// shown, because they came from different places.
									const cached = cachedHits ?? 0;
									const origin = cached > 0 ? `(${cached} cached)` : "new";
									this.onProgress(
										completed + reusedCount,
										total + reusedCount,
										`[embedding]${batchInfo} ${completed}/${total} ${origin}${reuseInfo}`,
										inProgress,
									);
								}
							},
						);
					} catch (error) {
						const errorMsg =
							error instanceof Error ? error.message : String(error);
						throw new Error(`Embedding generation failed: ${errorMsg}`);
					}

					// Track cost and tokens
					if (embedResult.cost) totalCost += embedResult.cost;
					if (embedResult.totalTokens) totalTokens += embedResult.totalTokens;

					// Verify we got embeddings for all chunks
					if (embedResult.embeddings.length !== items.length) {
						throw new Error(
							`Embedding count mismatch: expected ${items.length}, got ${embedResult.embeddings.length}`,
						);
					}

					// Forward progress: an embed batch completed.
					this.reportProgress();

					// Map embeddings back to chunks
					newlyEmbeddedChunks = chunksNeedingEmbedding
						.map((c, i) => ({
							chunk: c.chunk,
							filePath: c.filePath,
							fileHash: c.fileHash,
							vector: embedResult.embeddings[i],
							embedKey: embedResult.keys?.[i] ?? "",
						}))
						.filter((c) => {
							// `=== 0`, never truthiness (CLAUDE.md #15).
							//
							// A chunk with no vector is still DROPPED, exactly as before,
							// but its file is now remembered. The seam can serve a batch
							// from cache and leave the failed misses empty rather than
							// throwing the whole run away — and stamping such a file at
							// its current hash would delete those chunks from the index
							// permanently, because no later incremental run looks at an
							// unchanged file again.
							if (c.vector.length === 0) {
								filesWithMissingVectors.add(c.filePath);
								return false;
							}
							return true;
						});
				}

				// Combine cached + newly embedded chunks
				validChunks = [...cachedChunks, ...newlyEmbeddedChunks];
			} else {
				// Vector mode disabled - store chunks with placeholder vector (BM25 only)
				// LanceDB requires non-empty vectors, so we use a single-element placeholder
				validChunks = batchChunks.map((c) => ({
					...c,
					vector: [0], // Placeholder - BM25 search only (vector search disabled)
					// Nothing was embedded, so there is no key. The placeholder never
					// reaches the cache — this branch is the `else` of the vector test
					// and calls no embeddings client at all.
					embedKey: "",
				}));
			}

			// Phase 3: Store batch chunks
			const chunksWithEmbeddings: ChunkWithEmbedding[] = validChunks.map(
				(c) => ({
					...c.chunk,
					vector: c.vector,
					embedKey: c.embedKey,
				}),
			);

			if (this.onProgress) {
				const batchInfo =
					totalBatches > 1 ? ` [batch ${batchNum + 1}/${totalBatches}]` : "";
				this.onProgress(
					0,
					chunksWithEmbeddings.length,
					`[storing]${batchInfo} ${chunksWithEmbeddings.length} chunks...`,
				);
			}
			// Phase marker placed IMMEDIATELY before the (un-cancellable) LanceDB
			// write so a hang here is attributable to "writing:lance" in the report.
			this.reportPhase("writing:lance");
			await this.vectorStore!.addChunks(chunksWithEmbeddings);

			// THE DEFERRAL MUST COVER THE WRITE, NOT ONLY THE TRACKER.
			//
			// `addChunks` above ran over `validChunks`, which still holds the
			// SUCCESSFUL chunks of a file that lost one. Skipping only
			// `markIndexed` further down would leave rows in LanceDB and no row in
			// the tracker: `getChanges` then classifies the file as NEW, new files
			// never enter the modified-files loop that deletes a file's previous
			// rows, and `addChunks` is a bare append with no upsert and no primary
			// key. Every subsequent run would append another copy, permanently.
			//
			// Deleting here leaves the file with no rows and no tracker entry — a
			// consistent state the next run redoes from scratch. Safe because
			// files are batched, not chunks, so a file's chunks are all in this
			// batch; and a previously-indexed file's prior rows were already
			// deleted by the modified-files loop.
			for (const deferredFile of filesWithMissingVectors) {
				await this.vectorStore!.deleteByFile(deferredFile);
			}

			// Forward progress: a batch of chunks was written to the vector store.
			this.reportProgress();

			// Report storing completion
			if (this.onProgress) {
				const total = chunksWithEmbeddings.length;
				this.onProgress(total, total, `[storing] ${total} chunks stored`);
			}

			// Check if vector store auto-cleared due to dimension mismatch
			// If so, we need to also clear file tracker for consistency
			if (this.vectorStore!.dimensionMismatchCleared) {
				this.fileTracker!.clear();
			}

			// Phase 2b: Extract code units with AST metadata (once per file, not per chunk)
			// Runs in same batch loop, produces code_unit records in addition to code_chunk records
			if (this.codeUnitExtractor) {
				// Re-label: this block does AST extraction and a second embedding pass.
				// It previously inherited the "writing:lance" label from the chunk write
				// above, which misattributed stalls here to the LanceDB write path.
				this.reportPhase("code-units");
				const filesProcessedForUnits = new Set<string>();
				const batchUnitsToEmbed: Array<{
					unit: CodeUnit;
					filePath: string;
					fileHash: string;
				}> = [];

				for (const { filePath, fileHash } of validChunks) {
					if (filesProcessedForUnits.has(filePath)) continue;
					// A deferred file's rows were just deleted and it will be redone
					// from scratch next run, so writing code units for it now would
					// re-create exactly the orphan rows the delete above removed —
					// `addCodeUnits` appends the same way `addChunks` does.
					if (filesWithMissingVectors.has(filePath)) continue;
					filesProcessedForUnits.add(filePath);

					const language = getParserManager().getLanguage(
						filePath,
					) as SupportedLanguage;
					if (!language) continue;

					try {
						const content = readFileSync(filePath, "utf-8");
						const units = await this.codeUnitExtractor.extractUnits(
							content,
							filePath,
							language,
							fileHash,
						);
						for (const unit of units) {
							batchUnitsToEmbed.push({ unit, filePath, fileHash });
						}
					} catch (error) {
						// Code unit extraction failure is non-fatal
						const relativePath = relative(this.projectPath, filePath);
						console.warn(
							`Warning: Code unit extraction failed for ${relativePath}: ` +
								`${error instanceof Error ? error.message : String(error)}`,
						);
					}
				}

				// Embed code units if any were extracted and vector mode is enabled
				if (
					batchUnitsToEmbed.length > 0 &&
					this.vectorEnabled &&
					this.embeddingsClient
				) {
					const unitBatchInfo =
						totalBatches > 1 ? ` [batch ${batchNum + 1}/${totalBatches}]` : "";
					if (this.onProgress) {
						this.onProgress(
							0,
							batchUnitsToEmbed.length,
							`[units]${unitBatchInfo} embedding ${batchUnitsToEmbed.length} code units...`,
						);
					}

					const unitItems = batchUnitsToEmbed.map(({ unit }) => unit);
					let unitEmbedResult: EmbedResult;

					try {
						// Same seam as the chunk pass, same reason: the key is over the
						// unit's own content, derived inside the seam.
						unitEmbedResult = await this.cachingSeam().embedContentOf(
							unitItems,
							"code-units",
							(completed, total, inProgress, cachedHits) => {
								// Same reason as the chunk embed above: this call runs while
								// the phase is still labelled "writing:lance", and without a
								// per-item stamp the lock sat untouched for 351s here on a
								// healthy run — past the 5-minute hung threshold.
								this.reportProgress();
								if (this.onProgress) {
									const cached = cachedHits ?? 0;
									const cachedInfo = cached > 0 ? ` (${cached} cached)` : "";
									this.onProgress(
										completed,
										total,
										`[units]${unitBatchInfo} ${completed}/${total} units${cachedInfo}`,
										inProgress,
									);
								}
							},
						);
					} catch (error) {
						// Unit embedding failure is non-fatal - code_chunk records already stored
						console.warn(
							`Warning: Code unit embedding failed: ` +
								`${error instanceof Error ? error.message : String(error)}`,
						);
						unitEmbedResult = { embeddings: [] };
					}

					if (unitEmbedResult.embeddings.length === unitItems.length) {
						if (unitEmbedResult.cost) totalCost += unitEmbedResult.cost;
						if (unitEmbedResult.totalTokens)
							totalTokens += unitEmbedResult.totalTokens;

						// Forward progress: a unit embed batch completed.
						this.reportProgress();

						const unitsWithEmbeddings: CodeUnitWithEmbedding[] =
							batchUnitsToEmbed
								.map(({ unit }, idx) => ({
									...unit,
									vector: unitEmbedResult.embeddings[idx],
									embedKey: unitEmbedResult.keys?.[idx] ?? "",
								}))
								// `> 0`, i.e. `=== 0` inverted: a unit with no vector is
								// dropped as before. Unit embedding is already non-fatal
								// (its failure is caught above), so there is nothing to
								// defer — the chunks for the file are stored either way.
								.filter((u) => u.vector.length > 0);

						if (unitsWithEmbeddings.length > 0) {
							this.reportPhase("writing:lance");
							await this.vectorStore!.addCodeUnits(unitsWithEmbeddings);
							totalCodeUnitsCreated += unitsWithEmbeddings.length;

							// Forward progress: code units were written to the vector store.
							this.reportProgress();

							if (this.onProgress) {
								this.onProgress(
									unitsWithEmbeddings.length,
									unitsWithEmbeddings.length,
									`[units]${unitBatchInfo} ${unitsWithEmbeddings.length} units stored`,
								);
							}
						}
					}
				} else if (batchUnitsToEmbed.length > 0 && !this.vectorEnabled) {
					// BM25-only mode: store units with placeholder vector
					const unitsWithPlaceholder: CodeUnitWithEmbedding[] =
						batchUnitsToEmbed.map(({ unit }) => ({
							...unit,
							vector: [0],
							embedKey: "",
						}));
					this.reportPhase("writing:lance");
					await this.vectorStore!.addCodeUnits(unitsWithPlaceholder);
					totalCodeUnitsCreated += unitsWithPlaceholder.length;

					// Forward progress: BM25-only code units were written.
					this.reportProgress();
				}
			}

			// Phase 4: Update file tracker for this batch (only for successfully stored chunks)
			const fileChunkMap = new Map<
				string,
				{ fileHash: string; chunkIds: string[] }
			>();
			for (const { chunk, filePath, fileHash } of validChunks) {
				if (!fileChunkMap.has(filePath)) {
					fileChunkMap.set(filePath, { fileHash, chunkIds: [] });
				}
				fileChunkMap.get(filePath)!.chunkIds.push(chunk.id);
			}

			let deferredInBatch = 0;
			for (const [filePath, { fileHash, chunkIds }] of fileChunkMap) {
				// DEFERRED: at least one chunk of this file came back with an empty
				// vector. Its rows were deleted above; leaving it unstamped is what
				// makes the next run redo it. Stamping it at its current hash would
				// drop those chunks from the index for good.
				if (filesWithMissingVectors.has(filePath)) {
					deferredFiles.add(relative(this.projectPath, filePath));
					deferredInBatch++;
					continue;
				}
				this.fileTracker!.markIndexed(filePath, fileHash, chunkIds);
			}

			totalFilesIndexed += fileChunkMap.size - deferredInBatch;
			// A deferred file's rows were deleted again, so counting its chunks
			// here would report an index the store does not hold.
			totalChunksCreated += validChunks.filter(
				(c) => !filesWithMissingVectors.has(c.filePath),
			).length;

			// Collect files for enrichment
			if (this.enableEnrichment && this.enricher) {
				// Group chunks by file for enrichment
				const fileChunksMap = new Map<
					string,
					{ content: string; chunks: CodeChunk[]; language: string }
				>();

				for (const { chunk, filePath } of validChunks) {
					if (!fileChunksMap.has(filePath)) {
						const content = readFileSync(filePath, "utf-8");
						fileChunksMap.set(filePath, {
							content,
							chunks: [],
							language: chunk.language,
						});
					}
					fileChunksMap.get(filePath)!.chunks.push(chunk);
				}

				for (const [filePath, { content, chunks, language }] of fileChunksMap) {
					fileChunksForEnrichment.push({
						filePath: relative(this.projectPath, filePath),
						fileContent: content,
						codeChunks: chunks,
						language,
					});
				}
			}

			// Memory is released when batchChunks, embeddings, chunksWithEmbeddings go out of scope
		}

		// Set index version after successful chunk + code unit indexing
		// Placed before enrichment so a partial enrichment failure doesn't prevent version write
		setIndexVersion(this.projectPath, CURRENT_INDEX_VERSION);

		// Collect previously-indexed files that still need enrichment
		if (this.enableEnrichment && this.enricher && this.fileTracker) {
			const alreadyQueued = new Set(
				fileChunksForEnrichment.map((f) => f.filePath),
			);
			const unenrichedPaths =
				this.fileTracker.getFilesNeedingEnrichment("file_summary");

			for (const relPath of unenrichedPaths) {
				if (alreadyQueued.has(relPath)) continue;
				const absPath = join(this.projectPath, relPath);
				if (!existsSync(absPath)) continue;

				try {
					const content = readFileSync(absPath, "utf-8");
					const fileHash = computeFileHash(absPath);
					const chunks = await chunkFileByPath(content, absPath, fileHash);
					if (chunks.length === 0) continue;

					fileChunksForEnrichment.push({
						filePath: relPath,
						fileContent: content,
						codeChunks: chunks,
						language: chunks[0].language,
					});
				} catch {
					// Skip files that can't be read/chunked
				}
			}
		}

		// Phase 4.5 & 5: AST Extraction and Enrichment
		// Run in parallel when embedding is local and LLM is cloud (no resource contention)
		let enrichmentResult: EnrichmentResult | undefined;

		const runEnrichment = async (): Promise<void> => {
			if (
				!this.enableEnrichment ||
				!this.enricher ||
				fileChunksForEnrichment.length === 0
			) {
				return;
			}
			try {
				enrichmentResult = await this.enricher.enrichFiles(
					fileChunksForEnrichment,
					{
						concurrency: this.enrichmentConcurrency,
						onProgress: (completed, total, phase, status, inProgress) => {
							// Stamp the lock as well as the UI. Without this the whole
							// enrichment phase advances `heartbeat` but never
							// `lastProgressAt`, so a long (but healthy) enrichment run
							// looks hung: past DEFAULT_PROGRESS_TIMEOUT (5 min) the next
							// acquire() reclaims the lock and a second indexer can run
							// concurrently against the same store.
							this.reportProgress();
							if (this.onProgress) {
								this.onProgress(
									completed,
									total,
									`[${phase}] ${status}`,
									inProgress,
								);
							}
						},
					},
				);
			} catch (error) {
				console.warn(
					"⚠️  Enrichment failed:",
					error instanceof Error ? error.message : error,
				);
			}
		};

		const runASTExtraction = async (): Promise<void> => {
			if (filesToIndex.length > 0) {
				await this.extractSymbolGraph(filesToIndex, force);
			}
		};

		// Label the phase for what actually runs. This block always does AST
		// extraction and only sometimes enrichment, so reporting "enriching"
		// unconditionally made a stall here look like an LLM problem even with
		// enrichment disabled.
		const enrichmentWillRun =
			this.enableEnrichment &&
			!!this.enricher &&
			fileChunksForEnrichment.length > 0;
		this.reportPhase(enrichmentWillRun ? "analyzing+enriching" : "analyzing");

		if (canParallelizeEnrichment) {
			// Parallel: AST extraction and enrichment run concurrently
			// AST uses CPU, enrichment uses cloud LLM - no contention
			await Promise.all([runASTExtraction(), runEnrichment()]);
		} else {
			// Sequential: AST first, then enrichment
			await runASTExtraction();
			await runEnrichment();
		}

		// Add enrichment cost to total
		if (enrichmentResult?.cost) {
			totalCost += enrichmentResult.cost;
		}

		// Phase 6: Fetch external documentation for dependencies
		// Only run if manifest files changed (or force reindex), to avoid unnecessary network calls
		if (this.docsFetcher?.isEnabled() && manifestFilesChanged) {
			try {
				this.reportPhase("fetching:docs");
				const docsResult = await this.fetchExternalDocs();
				if (docsResult.cost) {
					totalCost += docsResult.cost;
				}
			} catch (error) {
				console.warn(
					"⚠️  Documentation fetching failed:",
					error instanceof Error ? error.message : error,
				);
			}
		}

		// Save metadata
		this.reportPhase("finalizing");
		this.fileTracker!.setMetadata("embeddingModel", this.model);
		// The model name alone does not identify what produced these vectors:
		// createEmbeddingsClient() resolves a bare name like "nomic-embed-text"
		// against whatever provider the ambient config names at the time, so the
		// same string means Ollama today and Voyage after a config change. Record
		// the provider the client actually resolved to, so a later run can adopt
		// this index's model without guessing where to send it.
		const usedProvider = this.embeddingsClient?.getProvider();
		if (usedProvider) {
			this.fileTracker!.setMetadata("embeddingProvider", usedProvider);
		}
		this.fileTracker!.setMetadata("lastIndexed", new Date().toISOString());

		// Clean up: Release cached old chunks to free memory
		this.oldChunksCache.clear();

		// Keep the machine-global cache under its size cap, INSIDE both locks.
		//
		// Not after the `finally` that releases them: process B sits in the global
		// lock's poll loop and takes it the instant A releases, so A's DELETE
		// transactions and incremental vacuum would run concurrently with B's
		// indexing against the one shared cache file. B's first write would wait
		// the clamped busy_timeout, get SQLITE_BUSY, and latch its persistent tier
		// off for its whole run — the multi-worktree case this feature exists for,
		// switching itself off. Inside the lock the global lock is what serialises
		// indexers machine-wide, so there is no such contention.
		//
		// Bounded, yielding and deadline-capped by the cache itself; a run that
		// hits the deadline stops and the next one continues, because eviction is
		// idempotent and incremental. Never a reason to fail a run.
		if (this.embedCache) {
			try {
				this.reportPhase("embed-cache:evicting");
				await this.embedCache.enforceBudget();
				this.reportProgress();
			} catch (error) {
				console.warn(
					"⚠️  Embedding cache eviction failed:",
					error instanceof Error ? error.message : error,
				);
			}
		}

		const durationMs = Date.now() - startTime;

		return {
			filesIndexed: totalFilesIndexed,
			chunksCreated: totalChunksCreated,
			codeUnitsCreated: totalCodeUnitsCreated,
			durationMs,
			// The authoritative channel for "which model did this actually use".
			// Every surface renders from here; the onProgress notices above are a
			// convenience on top, not the record.
			embeddingModel: this.model,
			adoptedIndexedModel: !!this.modelAdoption,
			configuredModel: this.modelAdoption?.configuredModel,
			skippedFiles,
			errors,
			// Deferred files are DATA, not a progress line: --agent has no progress
			// callback and the MCP tool passes none at all, and a run that quietly
			// left files unindexed is exactly the thing a caller must be able to see.
			filesDeferred: deferredFiles.size > 0 ? [...deferredFiles] : undefined,
			upgradedFromIndexVersion: this.upgradedFromIndexVersion,
			embedCache: this.embedCacheResultStats(),
			cost: totalCost > 0 ? totalCost : undefined,
			totalTokens: totalTokens > 0 ? totalTokens : undefined,
			enrichment: enrichmentResult,
		};
	}

	/**
	 * Search the indexed codebase
	 * Uses the stored embedding model from indexing for consistency
	 */
	async search(
		query: string,
		options: SearchOptions = {},
	): Promise<SearchResult[]> {
		// Initialize with forSearch=true to use stored embedding model
		await this.initialize(true);

		// Force keyword-only mode when vector embeddings are disabled
		const useKeywordOnly = options.keywordOnly || !this.vectorEnabled;

		// Refuse to embed a query into a vector space the table does not hold.
		// Recorded by initialize() under 'force-model' when the rebuild that would
		// have reconciled the two did not run; a wrong-space query returns ranked
		// nonsense with no error whenever the dimensions happen to agree.
		if (!useKeywordOnly && this.searchModelMismatch) {
			throw new EmbeddingModelMismatchError(
				this.searchModelMismatch.stored,
				this.searchModelMismatch.configured,
			);
		}

		// Generate query embedding (skip if keyword-only mode or vector disabled)
		let queryVector: number[] | undefined;
		if (!useKeywordOnly && this.embeddingsClient) {
			queryVector = await this.embeddingsClient.embedOne(query);
		}

		// Search
		const results = await this.vectorStore!.search(query, queryVector, {
			...options,
			keywordOnly: useKeywordOnly,
		});

		// Dead code deprioritization: penalize symbols with 0 callers
		// This prevents agents from being directed to unused/dead code
		if (this.fileTracker && results.length > 1) {
			const DEAD_CODE_PENALTY = 0.6; // 40% score reduction
			for (const r of results) {
				if (!r.chunk.name) continue;
				const syms = this.fileTracker.getSymbolByName(r.chunk.name);
				// Find the symbol in the same file
				const sym =
					syms.find((s) => s.filePath === r.chunk.filePath) ?? syms[0];
				if (sym && sym.inDegree === 0 && sym.pagerankScore < 0.001) {
					r.score *= DEAD_CODE_PENALTY;
				}
			}
			// Re-sort after penalty
			results.sort((a, b) => b.score - a.score);
		}

		return results;
	}

	/**
	 * Get index status
	 */
	async getStatus(): Promise<IndexStatus> {
		const indexDbPath = getIndexDbPath(this.projectPath);

		if (!existsSync(indexDbPath)) {
			return {
				exists: false,
				totalFiles: 0,
				totalChunks: 0,
				languages: [],
			};
		}

		// Initialize with forSearch=true (not indexing, just reading status)
		await this.initialize(true);

		const trackerStats = this.fileTracker!.getStats();

		// A corrupt index must be REPORTED, not thrown, so the caller can route
		// to the repair in index() above. Throwing here would abort every
		// caller before it ever reached the code that fixes the problem.
		if (await this.vectorStore!.isUnqueryable()) {
			return {
				exists: true,
				corrupt: true,
				totalFiles: trackerStats.totalFiles,
				totalChunks: 0,
				embeddingModel:
					this.fileTracker!.getMetadata("embeddingModel") || undefined,
				languages: [],
			};
		}

		const storeStats = await this.vectorStore!.getStats();

		const embeddingModel = this.fileTracker!.getMetadata("embeddingModel");
		const lastIndexed = this.fileTracker!.getMetadata("lastIndexed");

		return {
			exists: true,
			totalFiles: trackerStats.totalFiles,
			totalChunks: storeStats.totalChunks,
			lastUpdated: lastIndexed ? new Date(lastIndexed) : undefined,
			embeddingModel: embeddingModel || undefined,
			languages: storeStats.languages,
		};
	}

	/**
	 * Clear the index
	 */
	async clear(): Promise<void> {
		await this.initialize();

		await this.vectorStore!.clear();
		this.fileTracker!.clear();
	}

	/**
	 * Check if another process is currently indexing this project
	 */
	isIndexingInProgress(): {
		inProgress: boolean;
		holderPid?: number;
		runningFor?: number;
	} {
		const lock = createIndexLock(this.projectPath);
		const status = lock.isLocked();
		return {
			inProgress: status.locked,
			holderPid: status.holderPid,
			runningFor: status.runningFor,
		};
	}

	/**
	 * Force release a stale lock (use when a previous indexing process died)
	 */
	forceUnlock(): boolean {
		const lock = createIndexLock(this.projectPath);
		return lock.forceRelease();
	}

	/**
	 * Get the stored embedding model for a project without full initialization.
	 * Useful for quick checks before search operations.
	 */
	static getStoredEmbeddingModel(projectPath: string): string | null {
		const indexDbPath = getIndexDbPath(projectPath);
		if (!existsSync(indexDbPath)) {
			return null;
		}
		const tracker = createFileTracker(indexDbPath, projectPath);
		const model = tracker.getMetadata("embeddingModel");
		tracker.close();
		return model;
	}

	/**
	 * Discover files to index
	 */
	private discoverFiles(): string[] {
		const files: string[] = [];
		const parserManager = getParserManager();
		const supportedExtensions = new Set(parserManager.getSupportedExtensions());

		const walk = (dir: string) => {
			const entries = readdirSync(dir, { withFileTypes: true });

			for (const entry of entries) {
				const fullPath = join(dir, entry.name);
				const relativePath = relative(this.projectPath, fullPath);

				// Check exclude patterns
				if (
					sharedShouldExclude(
						relativePath,
						entry.isDirectory(),
						this.excludePatterns,
					)
				) {
					continue;
				}

				if (entry.isDirectory()) {
					walk(fullPath);
				} else if (entry.isFile()) {
					// Check include patterns if specified
					if (
						this.includePatterns.length > 0 &&
						!sharedShouldInclude(relativePath, this.includePatterns)
					) {
						continue;
					}

					// Get file extension and check if supported by parser
					const ext = `.${entry.name.split(".").pop()?.toLowerCase()}`;
					if (supportedExtensions.has(ext)) {
						files.push(fullPath);
					}
				}
			}
		};

		walk(this.projectPath);
		return files;
	}

	/**
	 * Extract symbol graph from indexed files
	 * Phase 4.5 of the indexing pipeline
	 */
	private async extractSymbolGraph(
		filesToIndex: string[],
		force: boolean,
	): Promise<void> {
		const symbolExtractor = createSymbolExtractor();
		const graphManager = createReferenceGraphManager(this.fileTracker!);
		const parserManager = getParserManager();

		// Delete old symbols/references for files being re-indexed
		if (!force) {
			for (const filePath of filesToIndex) {
				this.fileTracker!.deleteSymbolsByFile(filePath);
			}
		} else {
			// Full reindex - clear all symbol data
			this.fileTracker!.clearSymbolGraph();
		}

		// Extract symbols and references from each file
		if (this.onProgress) {
			this.onProgress(
				0,
				filesToIndex.length,
				"[analyzing] extracting symbols...",
			);
		}

		let processedFiles = 0;
		for (const filePath of filesToIndex) {
			const language = parserManager.getLanguage(filePath);
			if (!language) {
				continue;
			}

			try {
				const content = readFileSync(filePath, "utf-8");
				const relativePath = relative(this.projectPath, filePath);

				// Extract symbols
				const symbols = await symbolExtractor.extractSymbols(
					content,
					relativePath,
					language as SupportedLanguage,
				);

				if (symbols.length > 0) {
					this.fileTracker!.insertSymbols(symbols);

					// Extract references
					const references = await symbolExtractor.extractReferences(
						content,
						relativePath,
						language as SupportedLanguage,
						symbols,
					);

					if (references.length > 0) {
						this.fileTracker!.insertReferences(references);
					}
				}
			} catch (error) {
				// Symbol extraction errors shouldn't fail indexing
				console.warn(
					`Warning: Failed to extract symbols from ${filePath}:`,
					error instanceof Error ? error.message : error,
				);
			}

			processedFiles++;
			if (processedFiles % 50 === 0) {
				// Keep `lastProgressAt` advancing through symbol extraction too — on a
				// large repo this loop alone can exceed the 5-minute hung threshold
				// and get the lock reclaimed out from under us.
				this.reportProgress();
				if (this.onProgress) {
					this.onProgress(
						processedFiles,
						filesToIndex.length,
						`[analyzing] ${processedFiles}/${filesToIndex.length} files`,
					);
				}
			}
		}

		// Resolve cross-file references
		this.reportProgress();
		if (this.onProgress) {
			this.onProgress(0, 1, "[analyzing] resolving references...");
		}
		const resolvedCount = await graphManager.resolveReferences();

		// Compute PageRank scores
		this.reportProgress();
		if (this.onProgress) {
			this.onProgress(0, 1, "[analyzing] computing importance scores...");
		}
		await graphManager.computeAndStorePageRank();
		this.reportProgress();

		// Generate and cache repo map
		const repoMapGen = createRepoMapGenerator(this.fileTracker!);
		const repoMap = repoMapGen.generate({ maxTokens: 4000 });
		this.fileTracker!.setMetadata("repoMap", repoMap);
		this.fileTracker!.setMetadata(
			"repoMapGeneratedAt",
			new Date().toISOString(),
		);

		// Store graph stats
		const stats = this.fileTracker!.getSymbolGraphStats();
		this.fileTracker!.setMetadata("symbolGraphStats", JSON.stringify(stats));

		if (this.onProgress) {
			this.onProgress(
				filesToIndex.length,
				filesToIndex.length,
				`[analyzing] ${stats.totalSymbols} symbols, ${resolvedCount} refs resolved`,
			);
		}
	}

	/**
	 * Fetch external documentation for project dependencies
	 * Phase 6 of the indexing pipeline
	 *
	 * Uses parallel fetching for better performance when fetching many libraries.
	 */
	private async fetchExternalDocs(): Promise<{
		librariesFetched: number;
		chunksAdded: number;
		cost?: number;
	}> {
		if (
			!this.docsFetcher ||
			!this.embeddingsClient ||
			!this.vectorStore ||
			!this.fileTracker
		) {
			return { librariesFetched: 0, chunksAdded: 0 };
		}

		// Pre-resolved outside the locked region on the `index()` path. The `??`
		// fallback covers the other three `initialize()` entry points, which do not
		// hold the lock, and is bounded by the keychain process budget either way.
		const config = this.docsConfigPreLock ?? getDocsConfig(this.projectPath);
		const cacheTTLMs = (config.cacheTTL || 24) * 60 * 60 * 1000;

		// Detect dependencies
		const deps = await this.docsFetcher.detectDependencies(this.projectPath);
		if (deps.length === 0) {
			return { librariesFetched: 0, chunksAdded: 0 };
		}

		// Filter to dependencies that need refresh
		const depsToFetch = deps.filter((dep) =>
			this.fileTracker!.needsDocsRefresh(
				dep.name,
				dep.majorVersion,
				cacheTTLMs,
			),
		);

		if (depsToFetch.length === 0) {
			if (this.onProgress) {
				this.onProgress(
					deps.length,
					deps.length,
					`[docs] ${deps.length} libraries up-to-date`,
				);
			}
			return { librariesFetched: 0, chunksAdded: 0 };
		}

		if (this.onProgress) {
			this.onProgress(
				0,
				depsToFetch.length,
				`[docs] fetching ${depsToFetch.length} libraries...`,
			);
		}

		// Thread-safe counters (JS is single-threaded for sync ops)
		let librariesFetched = 0;
		let totalChunksAdded = 0;
		let totalCost = 0;
		let completed = 0;
		const inProgress = new Set<string>();
		const concurrency = this.enrichmentConcurrency; // Use same concurrency as enrichment

		// Process a single dependency
		const processDep = async (dep: (typeof depsToFetch)[0]): Promise<void> => {
			inProgress.add(dep.name);

			// Report progress with active items
			if (this.onProgress) {
				const active = inProgress.size;
				const activeList = Array.from(inProgress).slice(0, 3).join(", ");
				const moreCount = active > 3 ? ` +${active - 3}` : "";
				this.onProgress(
					completed,
					depsToFetch.length,
					`[docs] ${completed}/${depsToFetch.length} (${active} active) ${activeList}${moreCount}`,
					active,
				);
			}

			try {
				// Fetch and chunk documentation
				const chunks = await this.docsFetcher!.fetchAndChunk(dep.name, {
					version: dep.majorVersion,
				});

				if (chunks.length === 0) {
					return;
				}

				// Virtual path for documentation chunks
				const docsPath = `docs:${dep.name}`;

				// Delete old chunks for this library first
				await this.vectorStore!.deleteByFile(docsPath);

				// Embed the chunks — through the seam's content-derived entry point,
				// like the chunk and code-unit passes. Docs are inside the cache
				// deliberately: a package's documentation is byte-identical for every
				// repo that depends on it, which is the case a machine-global cache
				// exists for.
				const embedResult = await this.cachingSeam().embedContentOf(
					chunks,
					"docs",
					// Per-item stamp so a long docs-embedding batch cannot outlast the
					// hung threshold; the batch-end stamp below alone is not enough.
					() => this.reportProgress(),
				);

				// Forward progress: a docs embed batch completed.
				this.reportProgress();

				if (embedResult.cost) {
					totalCost += embedResult.cost;
				}

				// Add chunks to vector store
				const fileHash = computeHash(chunks.map((c) => c.content).join(""));
				const chunksWithEmbeddings: import("../types.js").ChunkWithEmbedding[] =
					chunks.map((chunk, idx) => ({
						id: chunk.id,
						content: chunk.content,
						filePath: docsPath,
						startLine: 0,
						endLine: 0,
						language: "markdown",
						chunkType: "module" as const, // Use module for docs
						contentHash: computeHash(chunk.content),
						fileHash,
						vector: embedResult.embeddings[idx],
						// Docs chunks go through the same seam, so they carry the same
						// audit key. Their content is shared across every repo that
						// depends on the package, which is exactly where a
						// machine-global cache pays.
						embedKey: embedResult.keys?.[idx] ?? "",
						// Store doc-specific metadata in name field for now
						name: chunk.title,
						signature: chunk.sourceUrl,
					}));

				this.reportPhase("writing:lance");
				await this.vectorStore!.addChunks(chunksWithEmbeddings);

				// Forward progress: docs chunks were written to the vector store.
				this.reportProgress();

				// Mark as indexed in tracker
				this.fileTracker!.markDocsIndexed(
					dep.name,
					dep.majorVersion || null,
					chunks[0].provider,
					fileHash,
					chunks.map((c) => c.id),
				);

				librariesFetched++;
				totalChunksAdded += chunks.length;
			} catch (error) {
				console.warn(
					`  ⚠️  Failed to fetch docs for ${dep.name}:`,
					error instanceof Error ? error.message : error,
				);
			} finally {
				inProgress.delete(dep.name);
				completed++;
			}
		};

		// Process in parallel batches (same pattern as enricher)
		for (let i = 0; i < depsToFetch.length; i += concurrency) {
			const batch = depsToFetch.slice(i, i + concurrency);
			await Promise.all(batch.map(processDep));
		}

		if (this.onProgress) {
			this.onProgress(
				depsToFetch.length,
				depsToFetch.length,
				`[docs] ${librariesFetched} libraries, ${totalChunksAdded} chunks`,
			);
		}

		return {
			librariesFetched,
			chunksAdded: totalChunksAdded,
			cost: totalCost > 0 ? totalCost : undefined,
		};
	}

	/**
	 * Close all resources
	 */
	async close(): Promise<void> {
		if (this.vectorStore) {
			await this.vectorStore.close();
		}
		if (this.fileTracker) {
			this.fileTracker.close();
		}
	}
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create an indexer for a project
 */
export function createIndexer(options: IndexerOptions): Indexer {
	return new Indexer(options);
}

/**
 * Quick index function
 */
export async function indexProject(
	projectPath: string,
	options: Partial<IndexerOptions> = {},
): Promise<IndexResult> {
	const indexer = createIndexer({ projectPath, ...options });
	try {
		return await indexer.index(options.force !== false);
	} finally {
		await indexer.close();
	}
}

/**
 * Quick search function
 */
export async function searchProject(
	projectPath: string,
	query: string,
	options: SearchOptions = {},
): Promise<SearchResult[]> {
	const indexer = createIndexer({ projectPath });
	try {
		return await indexer.search(query, options);
	} finally {
		await indexer.close();
	}
}
