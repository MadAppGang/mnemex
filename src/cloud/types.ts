/**
 * Cloud/Team types for mnemex
 *
 * Defines interfaces for the cloud-based shared index feature,
 * including team configuration, change detection, and the cloud API client.
 */

import type { SearchResult } from "../types.js";

// ============================================================================
// Team Configuration
// ============================================================================

/**
 * Team/org configuration added to ProjectConfig.
 * When present, mnemex uploads to and queries the cloud index.
 */
export interface TeamConfig {
	/** Organization slug, e.g. "acme-corp" */
	orgSlug: string;
	/**
	 * Repository slug for cloud lookups.
	 * Auto-derived from git remote if not set:
	 *   "https://github.com/acme/my-repo.git" → "acme-corp/my-repo"
	 */
	repoSlug?: string;
	/** Cloud API endpoint (default: "https://api.mnemex.dev") */
	cloudEndpoint?: string;
	/**
	 * Cloud upload mode (default: "thin").
	 * - "thin": upload vectors alongside chunks — CI handles embeddings from text
	 * - "smart": upload raw text, cloud re-embeds with best model
	 */
	cloudMode?: "thin" | "smart";
	/**
	 * Whether to upload LLM-generated enrichment summaries (default: false).
	 * Summaries can be expensive to generate; disable if you want to save cost.
	 */
	uploadEnrichment?: boolean;
	/** Number of chunks to upload per API request (default: 50) */
	uploadBatchSize?: number;
}

// ============================================================================
// Change Detection
// ============================================================================

/** A file that changed between two commits */
export interface ChangedFile {
	/** Relative path from project root */
	filePath: string;
	/** How the file changed */
	status: "added" | "modified" | "deleted" | "renamed";
	/** Previous path (only set for renames) */
	oldPath?: string;
}

/** A file with uncommitted local changes */
export interface DirtyFile {
	/** Relative path from project root */
	filePath: string;
	/** How the file is dirty */
	status: "modified" | "added" | "untracked" | "deleted";
}

/**
 * Detects which files changed in a git repository.
 * Used to compute incremental index updates for cloud upload.
 */
export interface IChangeDetector {
	/**
	 * Get files changed between two commits.
	 * Pass null for fromSha to diff against the root (initial commit).
	 */
	getChangedFiles(
		fromSha: string | null,
		toSha: string,
	): Promise<ChangedFile[]>;
	/** Get files with uncommitted local changes (for the overlay index) */
	getDirtyFiles(): Promise<DirtyFile[]>;
	/** Get the current HEAD commit SHA */
	getHeadSha(): Promise<string>;
	/** Get the parent commit SHA(s) — merge commits have more than one */
	getParentShas(commitSha: string): Promise<string[]>;
}

// ============================================================================
// Cloud Index Client — Request / Response Types
// ============================================================================

/** Result of checking which content hashes the cloud already has */
export interface ChunkCheckResult {
	/** Content hashes already stored in the cloud (no need to re-upload) */
	existing: string[];
	/** Content hashes that must be uploaded */
	missing: string[];
}

/** A single chunk to upload (thin mode: include vector; smart mode: include text) */
export interface UploadChunk {
	/** SHA-256 content hash (stable, position-independent) */
	contentHash: string;
	/** Relative path from project root */
	filePath: string;
	/** Start line (1-indexed) */
	startLine: number;
	/** End line (1-indexed) */
	endLine: number;
	/** Language identifier */
	language: string;
	/** Chunk type (function, class, method, …) */
	chunkType: string;
	/** Symbol name if available */
	name?: string;
	/**
	 * Embedding vector (thin mode only).
	 * Omit in smart mode — the cloud will embed the text itself.
	 */
	vector?: number[];
	/**
	 * Raw source text (smart mode only).
	 * Omit in thin mode to save bandwidth.
	 */
	text?: string;
	/** LLM-generated summary (optional, requires uploadEnrichment: true) */
	summary?: string;
}

/** Request body for uploading an index for a commit */
export interface UploadIndexRequest {
	/** Organization slug */
	orgSlug: string;
	/** Repository slug */
	repoSlug: string;
	/** Full 40-char commit SHA */
	commitSha: string;
	/** Parent commit SHA(s) for incremental diffing */
	parentShas: string[];
	/** Chunks to upload (content-addressed — duplicates skipped server-side) */
	chunks: UploadChunk[];
	/**
	 * Paths of files deleted since the last indexed commit.
	 * Used by the server to purge stale chunks.
	 */
	deletedFiles?: string[];
	/** Upload mode (matches TeamConfig.cloudMode) */
	mode: "thin" | "smart";
	/**
	 * LLM-generated enrichment docs for changed files.
	 * Only included when teamConfig.uploadEnrichment === true.
	 */
	enrichmentDocs?: CloudEnrichmentDoc[];
}

/** Server response after uploading an index */
export interface UploadIndexResponse {
	/** Whether the upload was accepted */
	ok: boolean;
	/** Number of new chunks stored */
	chunksAdded: number;
	/** Number of chunks that were already present (deduped) */
	chunksDeduplicated: number;
	/** Commit status after the upload */
	status: CommitStatus["status"];
	/** Human-readable message */
	message?: string;
}

/** Readiness status of a commit in the cloud index */
export interface CommitStatus {
	/** Commit SHA */
	commitSha: string;
	/**
	 * Processing state:
	 * - "ready"     — fully indexed, safe to query
	 * - "pending"   — upload received, embeddings / processing in progress
	 * - "not_found" — no record for this commit
	 * - "error"     — processing failed
	 */
	status: "ready" | "pending" | "not_found" | "error";
	/** When the commit was fully indexed (ISO 8601) */
	indexedAt?: string;
	/** Total chunks available for this commit */
	chunkCount?: number;
	/** Error message if status is "error" */
	errorMessage?: string;
}

/** Request for a semantic search against the cloud index */
export interface CloudSearchRequest {
	/** Repository slug */
	repoSlug: string;
	/** Commit SHA to search at (must be "ready") */
	commitSha: string;
	/** Query text (used for BM25 / re-ranking) */
	queryText: string;
	/** Pre-computed query embedding vector (thin mode) */
	queryVector?: number[];
	/** Maximum number of results to return (default: 10) */
	limit?: number;
	/** Filter by programming language */
	language?: string;
	/** Filter by chunk type */
	chunkType?: string;
}

/** A single search result from the cloud index */
export interface CloudSearchResult {
	/** Content hash of the matched chunk */
	contentHash: string;
	/** Relative file path */
	filePath: string;
	/** Start line (1-indexed) */
	startLine: number;
	/** End line (1-indexed) */
	endLine: number;
	/** Language identifier */
	language: string;
	/** Chunk type */
	chunkType: string;
	/** Symbol name if available */
	name?: string;
	/** Combined relevance score (0–1) */
	score: number;
	/** LLM-generated summary if available */
	summary?: string;
}

/** Request to register a new repository */
export interface RegisterRepoRequest {
	/** Organization slug */
	orgSlug: string;
	/**
	 * Repository slug (unique within the org).
	 * Often derived from the GitHub repo name.
	 */
	repoSlug: string;
	/** Human-readable display name */
	displayName?: string;
	/** Git remote URL (e.g. https://github.com/acme/my-repo) */
	remoteUrl?: string;
	/** Preferred upload mode */
	mode?: "thin" | "smart";
}

/** Server response after registering a repository */
export interface RegisterRepoResponse {
	/** Whether registration succeeded */
	ok: boolean;
	/** Whether the repo was newly created (false = already existed) */
	created: boolean;
	/** The canonical repo slug (may differ from request if normalized) */
	repoSlug: string;
	/** Human-readable message */
	message?: string;
}

// ============================================================================
// Enrichment Docs
// ============================================================================

/**
 * An LLM-generated enrichment document uploaded alongside index chunks.
 * Matched to chunks by contentHash.
 */
export interface CloudEnrichmentDoc {
	/** SHA-256 content hash — matches the source chunk's contentHash */
	contentHash: string;
	/** Document type: "file_summary" | "symbol_summary" */
	docType: string;
	/** LLM-generated summary text */
	content: string;
	/** Model that generated the summary (e.g. "claude-3-5-haiku-20241022") */
	llmModel: string;
}

// ============================================================================
// Graph Types
// ============================================================================

/**
 * A symbol reference edge from the cloud symbol graph.
 */
export interface CloudSymbolReference {
	/** Name of the calling/referencing symbol */
	fromSymbolName: string;
	/** Name of the called/referenced symbol */
	toSymbolName: string;
	/** Reference kind (e.g. "call", "import", "extends") */
	kind: string;
	/** File where the reference occurs */
	filePath: string;
	/** Line number of the reference */
	line: number;
}

/**
 * Full symbol graph result downloaded from the cloud for offline use.
 */
export interface CloudGraphResult {
	/** Symbol definitions */
	symbols: CloudSymbol[];
	/** Symbol reference edges */
	references: CloudSymbolReference[];
	/** Pre-generated repo map text */
	repoMap: string;
}

/** A symbol definition from the cloud index */
export interface CloudSymbol {
	/** Symbol name */
	name: string;
	/** Symbol kind (function, class, method, etc.) */
	kind: string;
	/** Relative file path */
	filePath: string;
	/** Start line (1-indexed) */
	startLine: number;
	/** End line (1-indexed) */
	endLine: number;
	/** Full signature */
	signature?: string;
	/** Docstring / JSDoc comment */
	docstring?: string;
	/** PageRank importance score */
	pagerankScore: number;
}

/** Callers of a symbol from the cloud index */
export interface CloudCallerResult {
	/** The symbol that was queried */
	symbolName: string;
	/** Symbols / locations that call or reference this symbol */
	callers: Array<{
		name: string;
		kind: string;
		filePath: string;
		line: number;
	}>;
}

/** Callees (dependencies) of a symbol from the cloud index */
export interface CloudCalleeResult {
	/** The symbol that was queried */
	symbolName: string;
	/** Symbols that this symbol calls or references */
	callees: Array<{
		name: string;
		kind: string;
		filePath: string;
		line: number;
	}>;
}

// ============================================================================
// Cloud Index Client Interface
// ============================================================================

/**
 * HTTP client for the mnemex cloud API.
 * Implementations: ThinCloudClient (real HTTP), LocalCloudStub (in-memory testing).
 */
export interface ICloudIndexClient {
	/**
	 * Check which content hashes already exist in the cloud.
	 * Use this before uploading to skip already-stored chunks.
	 */
	checkChunks(
		repoSlug: string,
		hashes: string[],
		commitSha?: string,
	): Promise<ChunkCheckResult>;

	/**
	 * Upload an index for a specific commit.
	 * Handles both thin mode (with vectors) and smart mode (with text).
	 */
	uploadIndex(request: UploadIndexRequest): Promise<UploadIndexResponse>;

	/** Check the indexing status of a specific commit */
	getCommitStatus(repoSlug: string, commitSha: string): Promise<CommitStatus>;

	/**
	 * Poll until a commit reaches "ready" status.
	 * @param timeoutMs — maximum wait time in milliseconds (default: 60_000)
	 */
	waitForCommit(
		repoSlug: string,
		commitSha: string,
		timeoutMs?: number,
	): Promise<CommitStatus>;

	/** Run a semantic search against the cloud index */
	search(request: CloudSearchRequest): Promise<CloudSearchResult[]>;

	/** Register a repository with the cloud */
	registerRepo(request: RegisterRepoRequest): Promise<RegisterRepoResponse>;

	/** Look up a symbol definition by name */
	getSymbol(
		repoSlug: string,
		commitSha: string,
		name: string,
	): Promise<CloudSymbol[]>;

	/** Get everything that calls or references a symbol */
	getCallers(
		repoSlug: string,
		commitSha: string,
		name: string,
	): Promise<CloudCallerResult>;

	/** Get everything that the symbol itself calls or references */
	getCallees(
		repoSlug: string,
		commitSha: string,
		name: string,
	): Promise<CloudCalleeResult>;

	/**
	 * Get a text repo map for a commit.
	 * @param query — optional natural-language query to focus the map
	 * @param maxTokens — token budget (default: 2000)
	 */
	getMap(
		repoSlug: string,
		commitSha: string,
		query?: string,
		maxTokens?: number,
	): Promise<string>;

	/**
	 * Download the full symbol graph for a commit (for offline use).
	 * Returns symbols, reference edges, and a pre-generated repo map.
	 */
	getGraph(repoSlug: string, commitSha: string): Promise<CloudGraphResult>;
}

// ============================================================================
// Overlay Index Interface
// ============================================================================

/**
 * Local overlay index for uncommitted (dirty) files.
 * Layered on top of the cloud index to give up-to-date search results
 * for files that haven't been committed and uploaded yet.
 */
export interface IOverlayIndex {
	/** Check whether the overlay is stale given the current set of dirty files */
	isStale(dirtyFiles: DirtyFile[]): Promise<boolean>;
	/**
	 * Rebuild the overlay index from the provided dirty files.
	 * @param onProgress — optional progress callback for UI feedback
	 */
	rebuild(
		dirtyFiles: DirtyFile[],
		onProgress?: (msg: string) => void,
	): Promise<void>;
	/** Search the overlay index */
	search(
		queryVector: number[],
		queryText: string,
		limit?: number,
	): Promise<SearchResult[]>;
	/** Return stats about what's in the overlay */
	getStats(): Promise<{ chunkCount: number; fileCount: number }>;
	/** Clear the overlay (forces a rebuild on next use) */
	invalidate(): Promise<void>;
	/** Release resources held by the overlay */
	close(): Promise<void>;
}
