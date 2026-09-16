/**
 * Core types for mnemex
 */

import type { TeamConfig } from "./cloud/types.js";
// Type-only, so this leaves no runtime edge from types.ts back to config.ts.
import type { ModelMismatchMode } from "./config.js";

// ============================================================================
// Code Chunk Types
// ============================================================================

export type ChunkType =
	| "function"
	| "class"
	| "method"
	| "module"
	| "block"
	// NEW: Document types
	| "document-section"
	| "docstring"
	// NEW: Language-specific types
	| "stylesheet-rule"
	| "config-section"
	| "shell-function"
	| "query";

export interface CodeChunk {
	/** SHA256 hash of content + position (unique per location) */
	id: string;
	/** Content-addressable hash for diffing (stable across line shifts) */
	contentHash: string;
	/** Raw code content */
	content: string;
	/** Relative path from project root */
	filePath: string;
	/** Starting line number (1-indexed) */
	startLine: number;
	/** Ending line number (1-indexed) */
	endLine: number;
	/** Programming language */
	language: string;
	/** Type of code construct */
	chunkType: ChunkType;
	/** Name of function/class/method if available */
	name?: string;
	/** Enclosing class name for methods */
	parentName?: string;
	/** Function/method signature if extractable */
	signature?: string;
	/** Hash of the parent file for change tracking */
	fileHash: string;
	/** 1-based index within a multi-part group (for oversized nodes split into parts) */
	partIndex?: number;
	/** Total parts in the group */
	totalParts?: number;
}

// ============================================================================
// Code Unit Types (Hierarchical Model)
// ============================================================================

/** Code unit types in hierarchical order */
export type UnitType =
	| "file"
	| "class"
	| "interface"
	| "function"
	| "method"
	| "type"
	| "enum";

/** Visibility modifiers */
export type Visibility =
	| "public"
	| "private"
	| "protected"
	| "internal"
	| "exported";

/** AST metadata extracted from code units */
export interface ASTMetadata {
	/** Visibility modifier (public/private/protected/exported) */
	visibility?: Visibility;
	/** Whether the function/method is async */
	isAsync?: boolean;
	/** Whether the symbol is exported */
	isExported?: boolean;
	/** Decorators/attributes on the symbol */
	decorators?: string[];
	/** Parameters with names and types */
	parameters?: Array<{ name: string; type?: string }>;
	/** Return type if declared */
	returnType?: string;
	/** Import statements used within this unit */
	importsUsed?: string[];
	/** Functions/methods called within this unit */
	functionsCalled?: string[];
	/** Types referenced within this unit */
	typesReferenced?: string[];
	/** Generic type parameters if any */
	typeParameters?: string[];
	/** Whether this is a generator function */
	isGenerator?: boolean;
	/** Whether this is a static member */
	isStatic?: boolean;
	/** For Go: the receiver type */
	receiver?: string;
	/** Docstring/JSDoc comment if present */
	docstring?: string;
}

/**
 * Hierarchical code unit with parent-child relationships.
 * Replaces the flat CodeChunk model with proper hierarchy tracking.
 */
export interface CodeUnit {
	/** SHA256 hash of content + path + position */
	id: string;
	/** Parent unit ID (null for file-level units) */
	parentId: string | null;
	/** Type of code unit */
	unitType: UnitType;
	/** Relative path from project root */
	filePath: string;
	/** Starting line number (1-indexed) */
	startLine: number;
	/** Ending line number (1-indexed) */
	endLine: number;
	/** Programming language */
	language: string;
	/** Raw code content */
	content: string;
	/** Name of the unit (function/class/file name) */
	name?: string;
	/** Full signature including parameters and return type */
	signature?: string;
	/** Hash of the parent file for change tracking */
	fileHash: string;
	/** Hierarchy depth (0=file, 1=class/function, 2=method) */
	depth: number;
	/** Rich AST metadata */
	metadata?: ASTMetadata;
}

/** Code unit with embedding vector attached */
export interface CodeUnitWithEmbedding extends CodeUnit {
	/** Vector embedding */
	vector: number[];
	/**
	 * Embedding-cache key for `vector` — `EmbedResult.keys` at the same slot.
	 * `""`/absent when the vector did not come through the caching seam (BM25
	 * placeholder, cache off, dimension unknown). Stored as
	 * `StoredChunk.embedKey`; see index version 3.
	 */
	embedKey?: string;
}

// ============================================================================
// Query Types (for Query Router)
// ============================================================================

/** Query intent classification types */
export type QueryIntent =
	| "symbol_lookup" // Looking for a specific named entity
	| "structural" // Asking about code relationships or structure
	| "semantic" // Natural language question about functionality
	| "similarity" // Looking for code similar to an example
	| "location"; // Looking for code in a specific location

/** Result of query classification */
export interface QueryClassification {
	/** Detected query intent */
	intent: QueryIntent;
	/** Confidence score (0-1) */
	confidence: number;
	/** Extracted entity names from query */
	extractedEntities: string[];
	/** Brief reasoning for the classification */
	reasoning?: string;
	/** Filters to apply based on query type */
	filters?: {
		unitTypes?: UnitType[];
		visibility?: Visibility[];
		isExported?: boolean;
		pathPattern?: string;
	};
}

// ============================================================================
// Reranking Types
// ============================================================================

/** Result of LLM reranking */
export interface RerankResult {
	/** Index of the result in the original array */
	index: number;
	/** Relevance score from LLM (0-10) */
	score: number;
	/** Brief explanation of the relevance */
	reason: string;
}

/** Search result after reranking */
export interface RerankedSearchResult extends EnrichedSearchResult {
	/** Original score before reranking */
	originalScore: number;
	/** Score from LLM reranking (0-1 normalized) */
	rerankScore: number;
	/** Combined final score */
	finalScore: number;
	/** Reasoning from LLM reranker */
	rerankReason?: string;
}

// ============================================================================
// Context Composition Types
// ============================================================================

/** Formatted context for LLM consumption */
export interface FormattedContext {
	/** Primary results (placed at START for visibility) */
	primary: string;
	/** Supporting context (middle section) */
	supporting?: string;
	/** File summaries (placed at END for overview) */
	summaries: string;
	/** Metadata about the context */
	metadata: {
		resultCount: number;
		fileCount: number;
		queryIntent: QueryIntent;
		tokenEstimate?: number;
	};
}

export interface ChunkWithEmbedding extends CodeChunk {
	/** Vector embedding */
	vector: number[];
	/**
	 * Embedding-cache key for `vector` — `EmbedResult.keys` at the same slot.
	 * `""`/absent when the vector did not come through the caching seam (BM25
	 * placeholder, cache off, dimension unknown). Stored as
	 * `StoredChunk.embedKey`; see index version 3.
	 */
	embedKey?: string;
}

// ============================================================================
// Search Types
// ============================================================================

export interface SearchResult {
	/** The matched code chunk */
	chunk: CodeChunk;
	/** Combined relevance score (0-1) */
	score: number;
	/** Vector similarity score */
	vectorScore: number;
	/** BM25 keyword score */
	keywordScore: number;
	/** LLM-generated summary (from enrichment — symbol-level if available, else file-level) */
	summary?: string;
	/** File-level summary (from file_summary enrichment document) */
	fileSummary?: string;
	/** Unit type from AST hierarchy (function, class, method, etc.) */
	unitType?: string;
	/** Document type (defaults to code_chunk for backward compat) */
	documentType?: DocumentType;
	/** Observation metadata (only for session_observation results) */
	observationMetadata?: Record<string, unknown>;
	/**
	 * D1's per-row attribution (architecture §4.4.2), as stored: the branch ids
	 * this row is visible from. `0` is the shared marker (docs, observations).
	 *
	 * Set by `VectorStore.search`, which has no registry and so cannot name
	 * branches. Absent from stores and code paths that predate the branch model.
	 */
	branchIds?: number[];
	/**
	 * The same attribution as LABELS, resolved through the branch registry by
	 * `Indexer.searchScoped`. This is what D1 requires a caller to be able to
	 * show: per-row attribution is what lets an agent discount a foreign row
	 * instead of discarding the whole response.
	 */
	branches?: string[];
}

export interface SearchOptions {
	/** Maximum results to return */
	limit?: number;
	/** Filter by language */
	language?: string;
	/** Filter by chunk type */
	chunkType?: ChunkType;
	/** Filter by file path pattern */
	pathPattern?: string;
	/** Search use case for weight presets */
	useCase?: SearchUseCase;
	/** Use keyword search only (no embedding API call, faster but less semantic) */
	keywordOnly?: boolean;
}

// ============================================================================
// Indexing Types
// ============================================================================

export interface IndexResult {
	/** Number of files indexed */
	filesIndexed: number;
	/** Number of chunks created */
	chunksCreated: number;
	/** Time taken in milliseconds */
	durationMs: number;
	/** Files that were skipped */
	skippedFiles: string[];
	/** Any errors encountered */
	errors: Array<{ file: string; error: string }>;
	/** Total cost in USD (if reported by provider) */
	cost?: number;
	/** Total tokens used (if reported by provider) */
	totalTokens?: number;
	/** Embedding model the run actually used */
	embeddingModel?: string;
	/**
	 * True when that model came from the INDEX rather than from config —
	 * `onModelMismatch: "use-indexed"` adopting the model the index was built
	 * with. Carried as data so every surface can say so; a progress notice
	 * cannot, because --agent has no progress callback and the TTY renderer
	 * overwrites detail text.
	 */
	adoptedIndexedModel?: boolean;
	/** The configured model that was set aside (only when adoptedIndexedModel) */
	configuredModel?: string;
	/**
	 * Files whose tracker stamp was DEFERRED because at least one of their
	 * chunks came back with an empty vector, and whose rows were removed again
	 * so the next run redoes them from scratch.
	 *
	 * A provider outage mid-run used to be fatal for the whole batch; the
	 * embedding cache downgrades it to "serve the hits, skip the misses", which
	 * would otherwise stamp the file at its current hash and drop those chunks
	 * from the index permanently — no later incremental run looks at an
	 * unchanged file again.
	 */
	filesDeferred?: string[];
	/**
	 * The index version this run rebuilt FROM, when it rebuilt because the
	 * on-disk table predates the current schema.
	 *
	 * The authoritative channel, deliberately. `index()` is not always driven by
	 * a human: the git post-commit hook passes no `onProgress`, and neither does
	 * the MCP search tool's auto-reindex, so the `[migrating]` progress notice
	 * reaches at most two of the four entry points.
	 */
	upgradedFromIndexVersion?: number;
	/**
	 * WHERE this run wrote (architecture §6.3). Absolute, realpath spelling.
	 *
	 * Built in Phase 3c, because the flip is the moment a user can no longer
	 * guess it. Until 3c the store was `<project>/.mnemex` for everyone without
	 * an override, so "where is my index?" had an answer you could type; from 3c
	 * it is `<gitCommonDir>/mnemex`, which is inside `.git` and which nothing
	 * else would lead you to. §6.3 names it as the field V1.1 and the FR-3
	 * behavioural sweep assert on, and it was the one §6.3 field with no
	 * producer — `mnemex branches --agent` emitted `store_dir=` and `index` did
	 * not, so the command that MOVES a store could not say where it moved it.
	 *
	 * DATA, not a progress line, for the reason `upgradedFromIndexVersion` is:
	 * the git post-commit hook and the MCP search tool's auto-reindex pass no
	 * `onProgress`, so a rendered notice reaches at most two of four entry
	 * points.
	 */
	storeDir?: string;
	/** Which precedence row chose {@link storeDir} (§2.3's `StoreKind`). */
	storeKind?: string;
	/**
	 * The store this run REPLACED, when it was in a different directory —
	 * §6.1's migration report, and the half deferred to 3c because before the
	 * flip the probed directory and `storeDir` were always the same one.
	 *
	 * It is left exactly where it is: not moved, not merged, not deleted (§6.1;
	 * the finding's §6.2 proves an N-to-1 rename of non-portable rows has no
	 * correct form). Reported so the user can delete it themselves, and so
	 * "my index got smaller" has a visible cause.
	 */
	abandonedStoreDir?: string;
	/** Why the seam fell back inside something that looked like a repository. */
	degradedReason?: string;
	/** D2: `ProjectConfig.indexDir` held the literal `".mnemex"` and was ignored. */
	ignoredLegacyIndexDir?: boolean;
	/** What the embedding cache did this run. Absent when it never ran. */
	embedCache?: IndexEmbedCacheStats;
	/** Branch membership, when the store has a branch model (architecture §4.1). */
	branch?: IndexBranchResult;
}

/**
 * What one run did to branch membership.
 *
 * DATA, not a progress line, for the reason `upgradedFromIndexVersion` is: two
 * of the four entry points that call `index()` pass no `onProgress` at all
 * (the git post-commit hook and the MCP search tool's auto-reindex), so a
 * notice reaches at most two of them.
 */
export interface IndexBranchResult {
	/** The registry id this run's rows were written under. */
	branchId: number;
	/** The HEAD label that id belongs to, as read at the start of the run. */
	label: string | null;
	/**
	 * Ids this branch gained by MEMBERSHIP alone — a tier-1 hit test hit: no
	 * embedding request, no new row, one `chunk_branches` row and one drain
	 * intent. On a second worktree of an indexed tree this is nearly every id.
	 */
	idsWidened: number;
	/**
	 * LanceDB rows whose `branchIds` mirror the drain actually rewrote. Lower
	 * than `idsWidened` when a row's mirror was already exact (the conditional
	 * merge skips it) and higher when it drains an EARLIER run's backlog.
	 */
	rowsWidened: number;
	/**
	 * `'widen'` intents still outstanding when the run finished.
	 *
	 * Expected 0 on every completed run since the per-run budget became a FLOOR
	 * over the backlog read at drain entry (`WIDEN_BUDGET`). It used to read
	 * 5 614 after a second worktree's first index of this repository — 22 % of
	 * the store invisible from the new branch until another run happened — which
	 * is the defect that change closes. A non-zero reading now means a run
	 * crashed or aborted mid-drain; searches from this branch see a subset of the
	 * store until the next `mnemex index` finishes it.
	 */
	widenRemaining: number;
	/**
	 * The `'widen'` backlog the drain STARTED with: this run's own widened ids
	 * plus anything an earlier run left behind.
	 *
	 * Emitted so that a complete drain is a positive fact a consumer can read
	 * — `widenBacklog: 26288, widenRemaining: 0` — rather than an absence. The
	 * git post-commit hook and the MCP auto-reindex render no progress line, so
	 * an absence is all they would otherwise have to go on.
	 */
	widenBacklog?: number;
	/**
	 * What a crashed previous run left, and this run re-drove (§4.1.4).
	 * `added` rows were deleted (an interrupted append refers to nothing);
	 * `removed` removals were FINISHED (the decision to remove had been made).
	 */
	recoveredCrashResidue?: { added: number; removed: number };
	/**
	 * M2 (decision I-7): rows read beyond the distinct ids read. Non-zero means
	 * a crash left a DUPLICATE row for some id. It is reported, never repaired
	 * inline — recovery owns cleanup, and a delete-then-add repair here is the
	 * non-atomic shape that lost rows in `updateUnitSummary`.
	 */
	duplicateRows?: number;
	/**
	 * Ids the tracker had registered that LanceDB did not hold, demoted from
	 * WIDEN to INSERT by the existence projection. Non-zero means P1 had been
	 * broken and this run repaired it.
	 */
	idsDemoted?: number;
	/**
	 * §4.1.5: HEAD moved while this run was reading the tree, so the branch was
	 * NOT stamped as indexed and the registry entry carries `needsReindex`.
	 */
	headChangedDuringRun?: boolean;
	/**
	 * Code units whose id was known but whose stored content hash disagreed, so
	 * the row was rewritten in place instead of widened (I-15).
	 *
	 * EXPECTED 0 since I-14 put the content hash into the unit id, and that is
	 * what makes it useful: it is the cheapest live check that I-14 works on a
	 * real machine. A non-zero reading is a 64-bit id collision, or a crash
	 * between a refresh and the second transaction that registers its hash.
	 */
	unitsRefreshed: number;
	/**
	 * LIVE registry entries after this run (§4.3). Above `BRANCH_SOFT_LIMIT` the
	 * run warns; it never fails, because there is no ceiling.
	 */
	branchCount: number;
	/** The confirmation pass ran in this run (§4.3's interval or a size trigger). */
	confirmationRan: boolean;
	/**
	 * A ref source was over its cap, so the pass decided NOTHING. A partial ref
	 * set makes live branches look deleted, and the decision that follows from
	 * that is a tombstone.
	 */
	confirmationDeferred?: boolean;
	/** Entries this run marked `unconfirmedSince` — the first of the two passes to a tombstone. */
	branchesUnconfirmed: number;
	/** Entries this run tombstoned: the grace expired, or an ephemeral was evicted. */
	branchesTombstoned: number;
	/**
	 * Live branch labels whose ref is in NEITHER `refs/heads/**` nor
	 * `packed-refs` (§4.3). Reported whether or not a decision followed, because
	 * a vanished ref is a fact worth acting on before the grace expires.
	 */
	missingBranchRefs?: string[];
	/** Rows the sweep deleted because no branch pointed at them any more. */
	sweepRowsDeleted: number;
	/** Rows the sweep narrowed: another branch still holds them. */
	sweepRowsNarrowed: number;
	/** Tombstoned entries rule C dropped from `branches.json` this run. */
	sweepBranchesFinalized: number;
	/** Membership rows tombstoned branches still hold. Non-zero means another run is needed. */
	sweepRemaining: number;
	/**
	 * §4.5 / D3: what this run's force CLEARED, when it forced at all.
	 *
	 * - `"branch"` — `--force`: this branch's rows only, `narrowBranch`. A row
	 *   another branch still holds survived, narrowed rather than deleted.
	 * - `"store"` — every branch's rows: `--force-all`, or one of the three
	 *   repairs that are store-wide by nature (a 0-dimension or placeholder
	 *   vector column, a model change, an index-version upgrade).
	 * - absent — no force ran.
	 *
	 * It is DATA rather than a progress line for the reason
	 * `upgradedFromIndexVersion` is: the git post-commit hook and the MCP
	 * auto-reindex pass no `onProgress` at all, and "how much did that just
	 * destroy" is precisely what a caller must be able to read afterwards.
	 */
	forceScope?: "branch" | "store";
	/** Rows a branch-scoped force deleted because nobody else held them. */
	forceRowsDeleted?: number;
	/** Rows a branch-scoped force left in place for another branch, mirror rewritten. */
	forceRowsNarrowed?: number;
}

/** Embedding-cache accounting for one index run, as rendered by the CLI. */
export interface IndexEmbedCacheStats {
	/** `"sqlite"` persistent, `"l0"` in-process only (degraded), `"none"` off. */
	tier: "sqlite" | "l0" | "none";
	/** Slots served from the cache instead of the provider. */
	hits: number;
	/** Slots that reached the provider. */
	misses: number;
	/** Vectors handed to the cache to store. */
	writes: number;
}

export interface IndexStatus {
	/** Whether an index exists */
	exists: boolean;
	/** Total number of indexed files */
	totalFiles: number;
	/** Total number of chunks */
	totalChunks: number;
	/** Last index update timestamp */
	lastUpdated?: Date;
	/** Embedding model used */
	embeddingModel?: string;
	/** Languages indexed */
	languages: string[];
	/**
	 * True when the index exists on disk but cannot answer any query, because
	 * its vector column is typed `FixedSizeList[0]`. The next index run repairs
	 * it by rebuilding; see `UnqueryableVectorIndexError` in core/store.ts.
	 */
	corrupt?: boolean;
}

export interface FileState {
	/** File path relative to project root */
	path: string;
	/** SHA256 hash of file content */
	contentHash: string;
	/** File modification time */
	mtime: number;
	/** IDs of chunks from this file */
	chunkIds: string[];
}

// ============================================================================
// Embedding Types
// ============================================================================

/** Supported embedding providers */
export type EmbeddingProvider =
	| "openrouter"
	| "ollama"
	| "lmstudio"
	| "local"
	| "voyage";

/** Progress callback for embedding operations */
export type EmbeddingProgressCallback = (
	completed: number,
	total: number,
	/** Number of items currently being processed (for animation) */
	inProgress?: number,
	/**
	 * Slots served from the persistent embedding cache so far, so a renderer can
	 * say "(N cached)". Optional and last, so every existing 3-parameter callback
	 * stays assignable to this type — nothing has to change to be passed in.
	 *
	 * A caching proxy may skip the inner call entirely, so an all-hits run emits
	 * progress that no provider request corresponds to; this parameter is what
	 * makes that visible instead of looking like a stalled or free run.
	 */
	cachedHits?: number,
) => void;

/** Result of embedding operation with usage stats */
export interface EmbedResult {
	embeddings: number[][];
	/** Total tokens used (if reported by provider) */
	totalTokens?: number;
	/** Cost in USD (if reported by provider) */
	cost?: number;
	/** Warnings/errors that occurred during embedding (non-fatal) */
	warnings?: string[];
	/** Wall-clock time for this embed() call in milliseconds */
	latencyMs?: number;
	/** Throughput in tokens/second (totalTokens / latencyMs * 1000) */
	throughputTokensPerSec?: number;
	/**
	 * The embedding-cache key per input slot, in input order — the audit column
	 * stored as `StoredChunk.embedKey`.
	 *
	 * Present only when the embedding dimension was known or learned during the
	 * call; absent otherwise, because the key is `sha256(model \0 dimension \0
	 * text)` and a key computed without a dimension would address nothing.
	 * Producers that do not cache leave it undefined.
	 */
	keys?: string[];
	/**
	 * How many slots were served from the embedding cache rather than the
	 * provider. `cost` and `totalTokens` fall to 0 on a warm run, which looks
	 * like a bug; this is what says otherwise.
	 */
	cacheHits?: number;
}

/**
 * Embeddings client interface
 * All embedding providers must implement this interface
 */
export interface IEmbeddingsClient {
	/** Generate embeddings for multiple texts */
	embed(
		texts: string[],
		onProgress?: EmbeddingProgressCallback,
	): Promise<EmbedResult>;
	/** Generate embedding for a single text */
	embedOne(text: string): Promise<number[]>;
	/** Get the model being used */
	getModel(): string;
	/** Get the embedding dimension (discovered after first request) */
	getDimension(): number | undefined;
	/** Get the provider being used */
	getProvider(): EmbeddingProvider;
	/** Check if this is a local provider (ollama, lmstudio, local) */
	isLocal(): boolean;
}

export interface EmbeddingModel {
	/** Model ID (e.g., "qwen/qwen3-embedding-8b") */
	id: string;
	/** Human-readable name */
	name: string;
	/** Provider name */
	provider: string;
	/** Context window size */
	contextLength: number;
	/** Vector dimension */
	dimension?: number;
	/** Price per million tokens (input) */
	pricePerMillion: number;
	/** Whether model is free */
	isFree: boolean;
	/** Whether this is a top recommended model */
	isRecommended?: boolean;
}

export interface EmbeddingResponse {
	/** Array of embedding vectors */
	embeddings: number[][];
	/** Model used */
	model: string;
	/** Token usage and cost */
	usage?: {
		promptTokens: number;
		totalTokens: number;
		/** Cost in USD (if reported by provider) */
		cost?: number;
	};
}

// ============================================================================
// Configuration Types
// ============================================================================

export interface GlobalConfig {
	/**
	 * Default embedding model to use.
	 * IMPORTANT: Must use the same model for indexing and retrieval.
	 * Different models produce incompatible vector spaces.
	 */
	defaultModel?: string;
	/**
	 * What to do when an index was built with a different model (default: 'use-indexed').
	 * - 'use-indexed': keep the index and switch to the model that built it
	 * - 'force-model': clear the index and rebuild it with the configured model
	 */
	onModelMismatch?: ModelMismatchMode;
	/** OpenRouter API key */
	openrouterApiKey?: string;
	/** Voyage AI API key */
	voyageApiKey?: string;
	/**
	 * Ollama API key. Used for GENERATION only (Ollama Cloud `/v1/chat/completions`).
	 * Never sent on the embeddings path — see CLAUDE.md gotcha #18.
	 */
	ollamaApiKey?: string;
	/** Global exclude patterns */
	excludePatterns: string[];
	/** Embedding provider (openrouter, ollama, lmstudio, local, voyage) */
	embeddingProvider?: EmbeddingProvider;
	/** Ollama endpoint URL (default: http://localhost:11434) */
	ollamaEndpoint?: string;
	/** LM Studio endpoint URL (default: http://localhost:1234/v1) */
	lmstudioEndpoint?: string;
	/** Custom local endpoint URL */
	localEndpoint?: string;

	// ─── LLM Enrichment Settings ───
	/** Unified LLM spec (e.g., "a/sonnet", "or/openai/gpt-4o", "cc/sonnet") */
	llm?: string;
	/** LLM endpoint URL (for local providers) */
	llmEndpoint?: string;
	/** Anthropic API key (for direct Anthropic API calls) */
	anthropicApiKey?: string;
	/** Enable LLM enrichment during indexing (default: true) */
	enableEnrichment?: boolean;

	// ─── Cloud / Team Settings ───
	/** Cloud API key for authenticating with the shared index server */
	cloudApiKey?: string;
	/**
	 * Global team/org configuration for cloud shared index.
	 * Used when scope is "global" (no project config). Project-level
	 * team config in ProjectConfig.team takes precedence when present.
	 */
	team?: TeamConfig;

	// ─── External Documentation Settings ───
	/** Context7 API key for fetching framework documentation */
	context7ApiKey?: string;

	// ─── Self-Learning Settings ───
	/**
	 * Enable self-learning system (default: true).
	 * When enabled, mnemex tracks interactions and learns from user corrections
	 * to improve search quality over time.
	 */
	learning?: boolean;

	// ─── Secret Storage ───
	/**
	 * User-facing opt-out for the macOS Keychain secret backend (default: enabled
	 * on darwin). Set to `false` to keep every API key in this file instead.
	 * Equivalent to exporting `MNEMEX_DISABLE_KEYCHAIN=1`.
	 */
	keychain?: boolean;

	// ─── Embedding Cache ───
	/**
	 * User-facing opt-out for the machine-global persistent embedding cache
	 * (default: enabled). Set to `false` to recompute every vector.
	 * Equivalent to exporting `MNEMEX_DISABLE_EMBED_CACHE=1`.
	 *
	 * Read with `=== false`, never for falsiness, and never written unless the
	 * user set it — an absent field means "untouched", not "off".
	 */
	embedCache?: boolean;
}

export interface ProjectConfig {
	/**
	 * Enable vector embeddings (default: true).
	 * When false, only BM25 keyword search is used - no embedding API needed.
	 */
	vector?: boolean;
	/**
	 * Override embedding model for this project.
	 * IMPORTANT: Must use the same model for indexing and retrieval.
	 * Different models produce incompatible vector spaces.
	 * Only used when vector=true.
	 */
	embeddingModel?: string;
	/**
	 * What to do when this project's index was built with a different model
	 * (default: 'use-indexed'). Overrides the global setting.
	 * - 'use-indexed': keep the index and switch to the model that built it
	 * - 'force-model': clear the index and rebuild it with the configured model
	 */
	onModelMismatch?: ModelMismatchMode;
	/** Additional exclude patterns (glob patterns) */
	excludePatterns?: string[];
	/** Include only these patterns (glob patterns) */
	includePatterns?: string[];
	/** Use .gitignore patterns for exclusion (default: true) */
	useGitignore?: boolean;
	/** Enable auto-indexing on search (default: true) */
	autoIndex?: boolean;
	/** Custom index directory path (default: .mnemex) */
	indexDir?: string;

	// ─── Enrichment Settings ───
	/** Enable/disable enrichment for this project (overrides global) */
	enrichment?: boolean;
	/** Override LLM spec for this project (e.g., "a/sonnet", "or/openai/gpt-4o") */
	enrichmentModel?: string;

	// ─── External Documentation Settings ───
	/** Documentation fetching configuration */
	docs?: DocsConfig;

	// ─── Search Settings ───
	/**
	 * How to handle test files in search results (default: 'downrank').
	 * - 'downrank': Apply 0.3x weight to test files (lower in results)
	 * - 'exclude': Filter out test files entirely
	 * - 'include': Treat test files normally (no special handling)
	 */
	testFiles?: "downrank" | "exclude" | "include";

	// ─── Self-Learning Settings ───
	/**
	 * Enable/disable self-learning for this project (overrides global).
	 * When enabled, mnemex learns from interactions to improve search quality.
	 */
	learning?: boolean;

	// ─── Index Format ───
	/**
	 * Index format version. Used to detect when re-indexing is needed.
	 * v1 = basic code chunks (legacy/default)
	 * v2 = hierarchical code units with AST metadata
	 * Absence of this field is treated as v1.
	 */
	indexVersion?: number;

	// ─── Cloud / Team Settings ───
	/**
	 * Team/org configuration for the cloud shared index.
	 * When present, mnemex uploads to and queries the cloud index.
	 */
	team?: TeamConfig;
}

/** Configuration for external documentation fetching */
export interface DocsConfig {
	/** Enable/disable documentation fetching (default: true if any provider configured) */
	enabled?: boolean;
	/** Context7 API key (overrides global) */
	context7ApiKey?: string;
	/** Providers to use, in priority order (default: ["context7", "llms_txt", "devdocs"]) */
	providers?: DocProviderType[];
	/** Cache TTL in hours (default: 24) */
	cacheTTL?: number;
	/** Libraries to exclude from fetching */
	excludeLibraries?: string[];
	/** Max pages to fetch per library (default: 10) */
	maxPagesPerLibrary?: number;
}

export interface Config extends GlobalConfig {
	/** Project-specific overrides */
	project?: ProjectConfig;
}

// ============================================================================
// CLI Types
// ============================================================================

export interface CLIConfig {
	/** Embedding model to use */
	model?: string;
	/** OpenRouter API key */
	openrouterApiKey?: string;
	/** Show only free models */
	freeOnly: boolean;
	/** Force re-index all files */
	force: boolean;
	/** Run in MCP server mode */
	mcpMode: boolean;
	/** Search query */
	query?: string;
	/** Search result limit */
	limit: number;
	/** Target path */
	path: string;
	/** Show verbose output */
	verbose: boolean;
	/** Output in JSON format */
	jsonOutput: boolean;
}

// ============================================================================
// Language Support Types
// ============================================================================

export type SupportedLanguage =
	| "typescript"
	| "javascript"
	| "tsx"
	| "jsx"
	| "python"
	| "go"
	| "rust"
	| "c"
	| "cpp"
	| "java"
	// NEW: Web languages
	| "html"
	| "css"
	| "scss"
	// NEW: Shell scripts
	| "bash"
	| "fish"
	| "zsh"
	// NEW: Data languages
	| "graphql"
	// NEW: Config formats
	| "json"
	// NOTE: yaml, toml, markdown removed - no pre-built WASM grammars available
	// NEW: Document formats (limited support)
	| "rst"
	| "asciidoc"
	| "org"
	// NEW: Dingo (Go superset)
	| "dingo";

export interface LanguageConfig {
	/** Language identifier */
	id: SupportedLanguage;
	/** File extensions */
	extensions: string[];
	/** Tree-sitter grammar file */
	grammarFile: string;
	/** Tree-sitter query for extracting chunks */
	chunkQuery: string;
	/** Tree-sitter query for extracting symbol references (optional) */
	referenceQuery?: string;
}

// ============================================================================
// Parser Types
// ============================================================================

export interface ParsedChunk {
	/** Raw code content */
	content: string;
	/** Starting line (0-indexed from tree-sitter) */
	startLine: number;
	/** Ending line (0-indexed from tree-sitter) */
	endLine: number;
	/** Type of code construct */
	chunkType: ChunkType;
	/** Name if available */
	name?: string;
	/** Parent name for methods */
	parentName?: string;
	/** Signature if extractable */
	signature?: string;
	/** 1-based index within a multi-part group (for oversized nodes split into parts) */
	partIndex?: number;
	/** Total parts in the group */
	totalParts?: number;
}

// ============================================================================
// AST Symbol Types (Symbol Graph)
// ============================================================================

/** Symbol kinds for AST extraction */
export type SymbolKind =
	| "function"
	| "class"
	| "method"
	| "type"
	| "interface"
	| "enum"
	| "variable"
	| "struct"
	| "trait"
	| "impl";

/** Reference kinds for symbol graph edges */
export type ReferenceKind =
	| "call"
	| "type_usage"
	| "import"
	| "extends"
	| "implements"
	| "field_access";

/** Symbol definition extracted from AST */
export interface SymbolDefinition {
	/** Unique identifier (SHA256 hash) */
	id: string;
	/** Symbol name */
	name: string;
	/** Type of symbol */
	kind: SymbolKind;
	/** File path (relative to project root) */
	filePath: string;
	/** Starting line number (1-indexed) */
	startLine: number;
	/** Ending line number (1-indexed) */
	endLine: number;
	/** Full signature (e.g., "async function foo(x: number): Promise<void>") */
	signature?: string;
	/** Docstring/JSDoc comment */
	docstring?: string;
	/** Parent symbol ID (for methods inside classes) */
	parentId?: string;
	/** Whether symbol is exported/public */
	isExported: boolean;
	/** Programming language */
	language: string;
	/** PageRank importance score */
	pagerankScore: number;
	/** Number of incoming references */
	inDegree?: number;
	/** Number of outgoing references */
	outDegree?: number;
	/** When symbol was created */
	createdAt: string;
	/** When symbol was last updated */
	updatedAt: string;
}

/** Reference between symbols (edge in the graph) */
export interface SymbolReference {
	/** Auto-increment ID (optional, from database) */
	id?: number;
	/** Symbol making the reference */
	fromSymbolId: string;
	/** Name being referenced (always stored for fallback) */
	toSymbolName: string;
	/** Resolved symbol ID (null if unresolved) */
	toSymbolId?: string;
	/** Type of reference */
	kind: ReferenceKind;
	/** File where reference occurs */
	filePath: string;
	/** Line number of reference */
	line: number;
	/** Whether reference has been resolved to a symbol */
	isResolved: boolean;
	/** When reference was created */
	createdAt: string;
}

/** Options for repo map generation */
export interface RepoMapOptions {
	/** Maximum tokens for the map (default: 2000) */
	maxTokens?: number;
	/** Include full signatures (default: true) */
	includeSignatures?: boolean;
	/** Filter by file path pattern */
	pathPattern?: string;
	/** Include top N symbols by PageRank */
	topNByPagerank?: number;
}

/** Entry in structured repo map */
export interface RepoMapEntry {
	/** File path */
	filePath: string;
	/** Symbols in this file */
	symbols: Array<{
		name: string;
		kind: SymbolKind;
		signature?: string;
		line: number;
		pagerankScore: number;
	}>;
}

/** Symbol graph statistics */
export interface SymbolGraphStats {
	/** Total symbols in graph */
	totalSymbols: number;
	/** Total references in graph */
	totalReferences: number;
	/** Number of resolved references */
	resolvedReferences: number;
	/** Symbols by kind */
	symbolsByKind: Partial<Record<SymbolKind, number>>;
	/** References by kind */
	referencesByKind: Partial<Record<ReferenceKind, number>>;
	/** When PageRank was last computed */
	pagerankComputedAt?: string;
}

// ============================================================================
// Document Types (Enriched RAG)
// ============================================================================

/** All document types in the enriched index */
export type DocumentType =
	| "code_chunk"
	| "file_summary"
	| "symbol_summary"
	| "idiom"
	| "usage_example"
	| "anti_pattern"
	| "project_doc"
	// External documentation types
	| "framework_doc" // Official framework documentation
	| "best_practice" // Recommended patterns from docs
	| "api_reference" // API reference documentation
	| "session_observation"; // Cognitive memory: session observations

/** Provider types for external documentation */
export type DocProviderType = "context7" | "llms_txt" | "devdocs";

/** Metadata for externally fetched documentation */
export interface DocProviderMetadata {
	/** Which provider fetched this document */
	provider: DocProviderType;
	/** Library name (e.g., "react" or "facebook/react") */
	library: string;
	/** Version fetched (e.g., "v18") */
	version?: string;
	/** Original source URL */
	sourceUrl?: string;
	/** When this was fetched */
	fetchedAt: string;
}

/** Base interface for all document types */
export interface BaseDocument {
	/** Unique identifier (SHA256 hash) */
	id: string;
	/** Document content (for embedding and search) */
	content: string;
	/** Document type discriminator */
	documentType: DocumentType;
	/** File path this document relates to (optional for project docs) */
	filePath?: string;
	/** Hash of source file for change tracking */
	fileHash?: string;
	/** When this document was created */
	createdAt: string;
	/** When this document was enriched (if by LLM) */
	enrichedAt?: string;
	/** IDs of source code chunks this was derived from */
	sourceIds?: string[];
	/** Additional type-specific metadata (JSON) */
	metadata?: Record<string, unknown>;
}

/** Document with embedding vector attached */
export interface DocumentWithEmbedding extends BaseDocument {
	/** Vector embedding */
	vector: number[];
}

/** File-level summary document */
export interface FileSummary extends BaseDocument {
	documentType: "file_summary";
	filePath: string;
	/** Programming language */
	language: string;
	/** High-level purpose of the file */
	summary: string;
	/** Main responsibilities (2-3 bullet points) */
	responsibilities: string[];
	/** Exported functions/classes/types */
	exports: string[];
	/** Imported modules/dependencies */
	dependencies: string[];
	/** Notable patterns used (hooks, middleware, etc.) */
	patterns: string[];
}

/** Symbol-level summary (function, class, method) */
export interface SymbolSummary extends BaseDocument {
	documentType: "symbol_summary";
	filePath: string;
	/** Symbol name */
	symbolName: string;
	/** Type of symbol */
	symbolType: "function" | "class" | "method" | "module";
	/** What it does (one sentence) */
	summary: string;
	/** Key parameters and their purpose */
	parameters?: Array<{ name: string; description: string }>;
	/** What it returns and when */
	returnDescription?: string;
	/** Side effects (API calls, state mutations, etc.) */
	sideEffects?: string[];
	/** When/where to use this */
	usageContext?: string;
}

/** Project idiom/pattern document */
export interface Idiom extends BaseDocument {
	documentType: "idiom";
	/** Category (error_handling, async_patterns, naming, etc.) */
	category: string;
	/** Programming language */
	language: string;
	/** Pattern name/description */
	pattern: string;
	/** Code example showing the pattern */
	example: string;
	/** Why this pattern is used */
	rationale: string;
	/** Where this pattern applies */
	appliesTo: string[];
}

/** Usage example document */
export interface UsageExample extends BaseDocument {
	documentType: "usage_example";
	filePath: string;
	/** Symbol this example is for */
	symbol: string;
	/** Type of example */
	exampleType: "basic" | "with_options" | "error_case" | "in_context" | "test";
	/** The example code */
	code: string;
	/** Brief description of what this example shows */
	description?: string;
}

/** Anti-pattern document */
export interface AntiPattern extends BaseDocument {
	documentType: "anti_pattern";
	/** What to avoid */
	pattern: string;
	/** Bad code example */
	badExample: string;
	/** Why it's problematic */
	reason: string;
	/** What to do instead */
	alternative: string;
	/** Severity level */
	severity: "low" | "medium" | "high";
}

/** Project documentation document */
export interface ProjectDoc extends BaseDocument {
	documentType: "project_doc";
	/** Document title */
	title: string;
	/** Category of documentation */
	category:
		| "architecture"
		| "getting_started"
		| "api"
		| "contributing"
		| "standards";
	/** Document sections */
	sections: Array<{
		heading: string;
		content: string;
	}>;
}

/** Union type of all document types */
export type Document =
	| FileSummary
	| SymbolSummary
	| Idiom
	| UsageExample
	| AntiPattern
	| ProjectDoc;

// ============================================================================
// LLM Types (for Enrichment)
// ============================================================================

/** Supported LLM providers for enrichment */
export type LLMProvider =
	| "claude-code"
	| "anthropic"
	| "anthropic-batch"
	| "openrouter"
	| "local";

/** Message in LLM conversation */
export interface LLMMessage {
	role: "user" | "assistant" | "system";
	content: string;
}

/** Response from LLM */
export interface LLMResponse {
	/** Generated content */
	content: string;
	/** Model that generated the response */
	model: string;
	/** Usage statistics */
	usage?: {
		inputTokens: number;
		outputTokens: number;
		/** Cost in USD (if available) */
		cost?: number;
	};
}

/** Options for LLM generation */
export interface LLMGenerateOptions {
	/** Model to use (overrides default) */
	model?: string;
	/** Temperature for generation (0-1) */
	temperature?: number;
	/** Maximum tokens to generate */
	maxTokens?: number;
	/** System prompt */
	systemPrompt?: string;
	/** Abort signal for cancellation */
	abortSignal?: AbortSignal;
}

/**
 * LLM client interface
 * All LLM providers must implement this interface
 */
/** Accumulated LLM usage stats */
export interface LLMUsageStats {
	inputTokens: number;
	outputTokens: number;
	cost: number;
	calls: number;
}

export interface ILLMClient {
	/** Generate completion from messages */
	complete(
		messages: LLMMessage[],
		options?: LLMGenerateOptions,
	): Promise<LLMResponse>;
	/** Generate completion and parse as JSON */
	completeJSON<T>(
		messages: LLMMessage[],
		options?: LLMGenerateOptions,
	): Promise<T>;
	/** Get the provider being used */
	getProvider(): LLMProvider;
	/** Get the model being used */
	getModel(): string;
	/** Test connection to the provider */
	testConnection(): Promise<boolean>;
	/** Get accumulated usage since last reset */
	getAccumulatedUsage(): LLMUsageStats;
	/** Reset accumulated usage counter */
	resetAccumulatedUsage(): void;
	/** Check if this is a cloud provider (anthropic, openrouter, anthropic-batch) */
	isCloud(): boolean;
	/**
	 * Get model size in billions of parameters.
	 * For local models, queries the API (e.g., Ollama /api/show).
	 * Returns undefined for cloud providers or if size unknown.
	 */
	getModelSizeB(): Promise<number | undefined>;
}

/** Progress callback for enrichment operations */
export type EnrichmentProgressCallback = (
	completed: number,
	total: number,
	documentType: DocumentType,
	/** Status message (e.g., files being processed) */
	status?: string,
	/** Number of items currently in progress (for animation) */
	inProgress?: number,
) => void;

// ============================================================================
// Extractor Types (for Enrichment Pipeline)
// ============================================================================

/** Context passed to document extractors */
export interface ExtractionContext {
	/** Project root path */
	projectPath: string;
	/** Code chunks for the current file */
	codeChunks: CodeChunk[];
	/** File path being processed */
	filePath: string;
	/** Full file content */
	fileContent: string;
	/** Programming language */
	language: string;
	/** Existing documents for this file (for incremental updates) */
	existingDocs?: BaseDocument[];
	/** All files in project (for project-level extraction) */
	allFiles?: string[];
}

/** Enrichment state for a file */
export type EnrichmentState = "pending" | "in_progress" | "complete" | "failed";

/**
 * Document extractor interface
 * Each document type has its own extractor implementation
 */
export interface IDocumentExtractor {
	/** Get the document type this extractor produces */
	getDocumentType(): DocumentType;
	/** Extract documents from the given context */
	extract(
		context: ExtractionContext,
		llmClient: ILLMClient,
	): Promise<BaseDocument[]>;
	/** Check if extraction is needed (for incremental updates) */
	needsUpdate(context: ExtractionContext): boolean;
	/** Get document types this extractor depends on */
	getDependencies(): DocumentType[];
}

// ============================================================================
// Enriched Search Types
// ============================================================================

/** Search result with enriched document */
export interface EnrichedSearchResult {
	/** The matched document */
	document: BaseDocument;
	/** Combined relevance score (0-1) */
	score: number;
	/** Vector similarity score */
	vectorScore: number;
	/** BM25 keyword score */
	keywordScore: number;
	/** Document type for filtering/display */
	documentType: DocumentType;
}

/** Use case for search weight presets */
export type SearchUseCase = "fim" | "search" | "navigation";

/** Search options with enrichment support */
export interface EnrichedSearchOptions extends SearchOptions {
	/** Filter by document types */
	documentTypes?: DocumentType[];
	/** Custom weights per document type (overrides use case) */
	typeWeights?: Partial<Record<DocumentType, number>>;
	/** Use case preset for automatic weight configuration */
	useCase?: SearchUseCase;
	/** Include code chunks in results (default: true) */
	includeCodeChunks?: boolean;
}

/** Response from retriever with optional repo map context */
export interface RetrieverSearchResponse {
	/** Search results ranked by relevance */
	results: EnrichedSearchResult[];
	/** Token-budgeted repo map context relevant to the query */
	repoMapContext?: string;
	/** Search metadata */
	metadata?: {
		/** Total documents searched */
		totalDocuments?: number;
		/** Time taken in milliseconds */
		durationMs?: number;
		/** Whether repo map was included */
		includesRepoMap?: boolean;
	};
}

// ============================================================================
// Enrichment Result Types
// ============================================================================

/** Result of enrichment operation */
export interface EnrichmentResult {
	/** Number of documents created */
	documentsCreated: number;
	/** Number of documents updated */
	documentsUpdated: number;
	/** Time taken in milliseconds */
	durationMs: number;
	/** Errors encountered during enrichment */
	errors: Array<{ file: string; documentType: DocumentType; error: string }>;
	/** LLM provider used */
	llmProvider?: LLMProvider;
	/** Total LLM cost in USD (if available, undefined for subscription/local) */
	cost?: number;
	/** Cost breakdown by phase */
	costBreakdown?: {
		fileSummaries?: number;
		symbolSummaries?: number;
	};
	/** LLM call counts by phase */
	llmCalls?: {
		fileSummaries: number;
		symbolSummaries: number;
		total: number;
	};
	/** Total LLM tokens used */
	totalTokens?: number;
	/** What §4.6's content-keyed reuse decided this run. Always present. */
	reuse?: EnrichmentReuse;
}

/**
 * §4.6's reuse accounting, as DATA.
 *
 * It is reported rather than logged for the reason `upgradedFromIndexVersion`
 * is: two of the four entry points that call `index()` render no progress at
 * all. And it carries the REFUSALS as well as the hits, because a reuse path
 * that reuses everything is indistinguishable from one broken in the expensive
 * direction — the lesson CLAUDE.md #31's twice-deleted seeding pass left, where
 * a cheerful "seeded N vectors" line covered an index built from placeholders.
 */
export interface EnrichmentReuse {
	/** Files whose summaries were adopted from the store: no LLM call at all. */
	filesReused: number;
	/** Summary rows those files adopted — the ids this branch gained. */
	documentsReused: number;
	/** Files this pass sent to the LLM. */
	filesEnriched: number;
	/**
	 * Files that HAD a usable-looking record and were enriched anyway, because
	 * at least one summary row it named is no longer in LanceDB (P1's belt).
	 * Non-zero means the store and the record table disagreed and this run
	 * repaired it by paying for the summary again.
	 */
	filesRefused: number;
}

/** Extended index result with enrichment stats */
export interface EnrichedIndexResult extends IndexResult {
	/** Enrichment statistics */
	enrichment?: EnrichmentResult;
	/** Number of code units created (AST-aware hierarchical units) */
	codeUnitsCreated?: number;
}
