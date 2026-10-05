/**
 * Tool Dependencies
 *
 * Common dependency injection interface passed to all tool registration
 * functions, reducing boilerplate and centralizing infrastructure access.
 */

import { existsSync } from "node:fs";
import type {
	ICloudIndexClient,
	IOverlayIndex,
	TeamConfig,
} from "../../cloud/types.js";
import { getIndexDbPath, isLearningEnabled } from "../../config.js";
import { FileTracker } from "../../core/tracker.js";
import type { SymbolEditor } from "../../editor/editor.js";
import {
	createLearningSystem,
	type LearningSystem,
} from "../../learning/index.js";
import type { LspManager } from "../../lsp/manager.js";
import type { MemoryStore } from "../../memory/store.js";
import type { SearchUseCase } from "../../types.js";
import type { IndexCache } from "../cache.js";
import type { CompletionDetector } from "../completion-detector.js";
import type { McpConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { DebounceReindexer } from "../reindexer.js";
import type { IndexStateManager } from "../state-manager.js";
import type { FreshnessMetadata } from "../types.js";

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
 * Open the project's file tracker, or null when the project has no index db.
 * Caller owns the handle and must `close()` it.
 *
 * The path comes from `getIndexDbPath`, i.e. the store-location seam, so it is
 * the store the lock guards (decision I-8). It used to be a hardcoded
 * `<projectPath>/.mnemex/index.db`, which ignored both index-dir overrides.
 */
export function getFileTracker(projectPath: string): FileTracker | null {
	const dbPath = getIndexDbPath(projectPath);
	if (!existsSync(dbPath)) {
		return null;
	}
	return new FileTracker(dbPath, projectPath);
}

// ---------------------------------------------------------------------------
// Per-request tool session
// ---------------------------------------------------------------------------

/**
 * One index-database connection for the duration of a single tool call.
 * Both the tracker and the learning system share it, so a request opens
 * sqlite at most once.
 */
export interface ToolSession {
	/** Open tracker, or null when there is nothing to open. */
	readonly tracker: FileTracker | null;
	/** Learning system on the tracker's connection, or null when learning is off. */
	readonly learning: LearningSystem | null;
	/** Close the connection. Idempotent — safe to call from a `finally`. */
	close(): void;
}

/** Shared no-op session: nothing open, nothing to close. */
const CLOSED_SESSION: ToolSession = {
	tracker: null,
	learning: null,
	close() {},
};

/**
 * Open (at most) one index-db connection for a tool call.
 *
 * Whether learning runs is decided by `isLearningEnabled` (src/config.ts) —
 * the SAME predicate the CLI uses, so one config state cannot mean "learning"
 * here and "no learning" there.
 *
 * When learning is turned off and the caller does not need a tracker of its
 * own, no database is opened at all — no connection, no schema DDL.
 * Never throws: an unavailable index yields an empty session.
 *
 * @param projectPath Project root
 * @param options.requireTracker Open the tracker even when learning is off
 *   (callers that record activity independently of learning)
 */
export function openToolSession(
	projectPath: string,
	options: { requireTracker?: boolean } = {},
): ToolSession {
	const wantLearning = isLearningEnabled(projectPath);
	if (!wantLearning && !options.requireTracker) {
		return CLOSED_SESSION;
	}

	let tracker: FileTracker | null = null;
	try {
		tracker = getFileTracker(projectPath);
	} catch {
		tracker = null;
	}
	if (!tracker) return CLOSED_SESSION;
	const openTracker = tracker;

	let learning: LearningSystem | null = null;
	if (wantLearning) {
		try {
			learning = createLearningSystem(openTracker.getDatabase());
		} catch {
			learning = null;
		}
	}

	let closed = false;
	return {
		tracker: openTracker,
		learning,
		close() {
			if (closed) return;
			closed = true;
			try {
				openTracker.close();
			} catch {
				// Ignore close failures
			}
		},
	};
}

/**
 * Learned per-file boost multipliers for this session, or null when learning
 * is turned off, has no data yet, or errors. Shared by the pipeline (`search`)
 * and legacy (`search_code`) paths so both rank identically.
 */
export function getLearnedFileBoosts(
	session: ToolSession,
	useCase: SearchUseCase,
): Map<string, number> | null {
	const learning = session.learning;
	if (!learning) return null;
	try {
		if (!learning.ranker.isActive(useCase)) return null;
		const fileBoosts = learning.ranker.getAllFileBoosts();
		return fileBoosts.size > 0 ? fileBoosts : null;
	} catch {
		return null;
	}
}

/**
 * Feed a search into the learning loop. No-op when learning is turned off, so
 * both search tools contribute to one feedback history without either of them
 * paying for it when it is off.
 */
export function recordSearchInteraction(
	session: ToolSession,
	params: {
		query: string;
		sessionId: string;
		resultCount: number;
		useCase: SearchUseCase;
	},
): void {
	if (!session.learning) return;
	try {
		session.learning.collector.recordSearch(params);
	} catch {
		// Learning must never fail a search
	}
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
