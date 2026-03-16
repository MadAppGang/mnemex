/**
 * Tool Dependencies
 *
 * Common dependency injection interface passed to all tool registration
 * functions, reducing boilerplate and centralizing infrastructure access.
 */

import type { IndexCache } from "../cache.js";
import type { IndexStateManager } from "../state-manager.js";
import type { McpConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { DebounceReindexer } from "../reindexer.js";
import type { CompletionDetector } from "../completion-detector.js";
import type { FreshnessMetadata } from "../types.js";
import type {
	ICloudIndexClient,
	IOverlayIndex,
	TeamConfig,
} from "../../cloud/types.js";
import type { LspManager } from "../../lsp/manager.js";
import type { SymbolEditor } from "../../editor/editor.js";
import type { MemoryStore } from "../../memory/store.js";

export interface ToolDeps {
	cache: IndexCache;
	stateManager: IndexStateManager;
	config: McpConfig;
	logger: Logger;
	reindexer?: DebounceReindexer;
	completionDetector?: CompletionDetector;
	serverStartTime: number;
	watcherActive: boolean;
	/** Cloud API client (present when cloud/team mode is enabled) */
	cloudClient?: ICloudIndexClient;
	/** Local overlay index for dirty files (present when cloud mode is enabled) */
	overlayIndex?: IOverlayIndex;
	/** Current HEAD commit SHA (present when cloud mode is enabled) */
	currentCommitSha?: string;
	/** Team configuration (present when cloud mode is enabled) */
	teamConfig?: TeamConfig;
	/** LSP manager (null when MNEMEX_LSP=false) */
	lspManager?: LspManager | null;
	/** Symbol editor (always available) */
	editor?: SymbolEditor;
	/** Project memory store (always available) */
	memoryStore?: MemoryStore;
}

/**
 * Build freshness metadata with the elapsed response time filled in.
 */
export function buildFreshness(
	stateManager: IndexStateManager,
	startTime: number,
): FreshnessMetadata {
	return {
		...stateManager.getFreshness(),
		responseTimeMs: Date.now() - startTime,
	};
}

/**
 * Format an error for MCP tool response.
 */
export function errorResponse(err: unknown): {
	content: Array<{ type: "text"; text: string }>;
	isError: true;
} {
	const message = err instanceof Error ? err.message : String(err);
	return {
		content: [{ type: "text", text: `Error: ${message}` }],
		isError: true,
	};
}
