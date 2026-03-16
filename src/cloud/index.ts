/**
 * Cloud module barrel export
 *
 * Re-exports all public cloud API symbols for convenient import:
 *   import { GitDiffChangeDetector, LocalCloudStub, isCloudEnabled } from "./cloud/index.js"
 */

// Types
export type {
	TeamConfig,
	ChangedFile,
	DirtyFile,
	IChangeDetector,
	ChunkCheckResult,
	UploadChunk,
	UploadIndexRequest,
	UploadIndexResponse,
	CommitStatus,
	CloudSearchRequest,
	CloudSearchResult,
	RegisterRepoRequest,
	RegisterRepoResponse,
	CloudSymbol,
	CloudCallerResult,
	CloudCalleeResult,
	CloudEnrichmentDoc,
	CloudGraphResult,
	CloudSymbolReference,
	ICloudIndexClient,
	IOverlayIndex,
} from "./types.js";

// Git diff change detector
export {
	GitDiffChangeDetector,
	createGitDiffChangeDetector,
} from "./git-diff.js";

// Cloud configuration helpers
export {
	DEFAULT_CLOUD_ENDPOINT,
	isCloudEnabled,
	getCloudMode,
	getTeamConfig,
	getCloudEndpoint,
	getRepoSlug,
	parseRepoNameFromUrl,
	createCloudClientFromConfig,
} from "./config.js";

// In-memory stub for testing
export { LocalCloudStub, createLocalCloudStub } from "./stub.js";

// Real HTTP client — thin mode (client computes embeddings locally)
export {
	ThinCloudClient,
	CloudApiError,
	createThinCloudClient,
} from "./thin-client.js";
export type { ThinCloudClientOptions } from "./thin-client.js";

// Real HTTP client — smart mode (cloud computes embeddings server-side)
export {
	SmartCloudClient,
	createSmartCloudClient,
} from "./smart-client.js";

// Cloud-aware indexer
export {
	CloudAwareIndexer,
	createCloudIndexer,
} from "./indexer.js";
export type { CloudIndexResult, CloudIndexerOptions } from "./indexer.js";

// Auth manager
export {
	CloudAuthManager,
	createCloudAuthManager,
	getDefaultAuthManager,
} from "./auth.js";

// Overlay index for dirty files
export {
	OverlayIndex,
	createOverlayIndex,
} from "./overlay.js";
export type { OverlayIndexOptions } from "./overlay.js";

// Overlay merger
export { OverlayMerger } from "./merger.js";
export type { MergedSearchResult } from "./merger.js";

// Cloud-aware search
export {
	CloudAwareSearch,
	createCloudAwareSearch,
} from "./search.js";
export type { CloudSearchOptions } from "./search.js";

// Graph sync
export {
	GraphSyncer,
	createGraphSyncer,
} from "./graph-sync.js";
export type { GraphSyncOptions, GraphSyncResult } from "./graph-sync.js";
