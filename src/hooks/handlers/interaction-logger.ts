/**
 * InteractionLogger - Hook handler integration for interaction monitoring.
 *
 * This module provides a singleton InteractionSystem that can be used by
 * hook handlers to log user-agent interactions. It lazily initializes
 * the database connection on first use.
 */

import { existsSync } from "node:fs";
import { getIndexDbPath } from "../../config.js";
import { createDatabaseSync, type SQLiteDatabase } from "../../core/sqlite.js";
import {
	createInteractionSystem,
	generateSessionId,
	type InteractionSystem,
} from "../../learning/interaction/index.js";
import type { HookInput, ToolInput, ToolResponse } from "../types.js";

// ============================================================================
// Singleton Management
// ============================================================================

/** Cached interaction systems by project path */
const systemCache: Map<string, InteractionSystem> = new Map();

/** Cached database connections by project path */
const dbCache: Map<string, SQLiteDatabase> = new Map();

/**
 * Get or create InteractionSystem for a project.
 */
function getInteractionSystem(projectPath: string): InteractionSystem | null {
	// Check if enabled
	const enabled = process.env.CLAUDE_LEARNING !== "off";
	if (!enabled) return null;

	// Return cached system
	if (systemCache.has(projectPath)) {
		return systemCache.get(projectPath)!;
	}

	// ── THE WRITER (phase-3b-inputs.md §6, item 1) ────────────────────────────
	//
	// This opens the store's `index.db` READ-WRITE and creates seven tables in
	// it. It built the path by hand — `join(projectPath, ".mnemex", "index.db")`
	// — and was the most dangerous of the four allowlist entries: under
	// `STORE_SCOPE_DEFAULT = "git-common-dir"` it would have kept writing the OLD
	// per-worktree location for EVERY user, silently, while every probe and every
	// reader looked at the new one. Not limited to override users, and invisible,
	// because this hook swallows every failure by design.
	//
	// It resolves through the seam now (FR-3, decision I-8), so it opens the same
	// file the store lock guards.
	//
	// WHY IT STILL TAKES NO STORE LOCK (§6's condition 2, the second half: "or is
	// shown to write nothing the lock guards"). The seven tables this system
	// creates and writes — `agent_sessions`, `tool_events`, `code_changes`,
	// `corrections`, `patterns`, `improvements`, `improvement_metrics`
	// (`src/learning/interaction/interaction-store.ts`) — are DISJOINT from every
	// table the store lock exists to serialise: the tracker's `files`,
	// `documents`, `symbols`, `symbol_references`, `graph_metadata`,
	// `indexed_docs`, `chunk_branches`, `chunk_index`, `chunk_write_intent`,
	// `enrichment_by_content`. None of them carries a `branch_id`, none is
	// dropped by `rebuildStore()`'s §3.5.1 pass, and none is read by the indexer.
	// So this writer cannot race the id algebra, cannot widen or narrow
	// membership, and cannot be torn by a rebuild of the tree-scoped schema.
	//
	// What it DOES share is the SQLite file, which is why it must not hold a
	// transaction open: a hook runs on every tool call, and a blocking writer
	// here would surface as `SQLITE_BUSY` in an index run. The tracker sets WAL
	// on the file, so a reader never blocks, and this system's writes are single
	// statements. Taking the store lock instead would be strictly worse: a hook
	// that waits on a 20-minute index run stalls the editor.
	//
	// A session row is worth nothing after the store it describes is rebuilt, but
	// it is also worth nothing to guard with a lock: losing one is free, and the
	// whole module already returns `null` on any failure.
	const dbPath = getIndexDbPath(projectPath);
	if (!existsSync(dbPath)) {
		return null;
	}

	let db = dbCache.get(projectPath);
	if (!db) {
		try {
			db = createDatabaseSync(dbPath);
			dbCache.set(projectPath, db);
		} catch {
			return null;
		}
	}

	// Create interaction system
	const system = createInteractionSystem(db);
	systemCache.set(projectPath, system);

	return system;
}

// ============================================================================
// Session Management
// ============================================================================

/** Active session IDs by project path */
const activeSessions: Map<string, string> = new Map();

/**
 * Get or create session ID for a project.
 */
function ensureSessionId(projectPath: string, hookSessionId: string): string {
	// Use hook's session_id if available
	if (hookSessionId) {
		activeSessions.set(projectPath, hookSessionId);
		return hookSessionId;
	}

	// Return existing session
	const existing = activeSessions.get(projectPath);
	if (existing) {
		return existing;
	}

	// Generate new session
	const newSessionId = generateSessionId(projectPath);
	activeSessions.set(projectPath, newSessionId);
	return newSessionId;
}

// ============================================================================
// Hook Handlers
// ============================================================================

/**
 * Handle SessionStart - Initialize session tracking.
 */
export function logSessionStart(input: HookInput): void {
	const system = getInteractionSystem(input.cwd);
	if (!system) return;

	const sessionId = ensureSessionId(input.cwd, input.session_id);
	system.tracker.startSession(sessionId, input.cwd);
}

/**
 * Handle PreToolUse - Record tool start time.
 */
export function logToolStart(input: HookInput): void {
	const system = getInteractionSystem(input.cwd);
	if (!system) return;
	if (!input.tool_use_id || !input.tool_name) return;

	const sessionId = ensureSessionId(input.cwd, input.session_id);

	// Ensure session exists
	system.tracker.ensureSession(sessionId, input.cwd);

	// Record tool start
	system.logger.logToolStart(sessionId, input.tool_use_id);
}

/**
 * Handle PostToolUse - Log tool completion and code changes.
 */
export function logToolCompletion(input: HookInput): void {
	const system = getInteractionSystem(input.cwd);
	if (!system) return;
	if (!input.tool_use_id || !input.tool_name) return;

	const sessionId = ensureSessionId(input.cwd, input.session_id);

	// Ensure session exists
	system.tracker.ensureSession(sessionId, input.cwd);

	// Determine success
	const success = !isToolError(input.tool_response);

	// Log tool event
	system.logger.logToolEvent({
		sessionId,
		toolUseId: input.tool_use_id,
		toolName: input.tool_name,
		toolInput: input.tool_input as Record<string, unknown> | undefined,
		success,
		error: extractErrorMessage(input.tool_response),
	});

	// Log code changes for Write/Edit tools
	if ((input.tool_name === "Write" || input.tool_name === "Edit") && success) {
		const filePath = extractFilePath(input.tool_input, input.tool_response);
		if (filePath && system.logger.isCodeFile(filePath)) {
			const { linesAdded, linesRemoved } = estimateChangeSize(
				input.tool_name,
				input.tool_input,
			);

			system.logger.logCodeChange({
				sessionId,
				filePath,
				author: "agent",
				linesAdded,
				linesRemoved,
			});
		}
	}
}

/**
 * Handle Stop/SubagentStop - End session.
 */
export function logSessionEnd(input: HookInput): void {
	const system = getInteractionSystem(input.cwd);
	if (!system) return;

	const sessionId = activeSessions.get(input.cwd);
	if (!sessionId) return;

	system.tracker.endSession(sessionId);
	activeSessions.delete(input.cwd);
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Check if tool response indicates an error.
 */
function isToolError(response?: ToolResponse): boolean {
	if (!response) return false;

	// Check explicit success flag
	if (response.success === false) return true;

	// Check for error patterns in response
	const responseStr = JSON.stringify(response).toLowerCase();
	const errorPatterns = [
		"error",
		"failed",
		"exception",
		"timeout",
		"denied",
		"not found",
		"invalid",
	];

	return errorPatterns.some((pattern) => responseStr.includes(pattern));
}

/**
 * Extract error message from tool response.
 */
function extractErrorMessage(response?: ToolResponse): string | undefined {
	if (!response) return undefined;

	// Try common error message fields
	const errorFields = ["error", "message", "stderr", "errorMessage"];
	for (const field of errorFields) {
		const value = (response as Record<string, unknown>)[field];
		if (typeof value === "string" && value.length > 0) {
			return value.substring(0, 500); // Truncate long errors
		}
	}

	return undefined;
}

/**
 * Extract file path from tool input/response.
 */
function extractFilePath(
	input?: ToolInput,
	response?: ToolResponse,
): string | undefined {
	// Try response first
	if (response?.filePath) return response.filePath as string;

	// Try input
	if (input?.file_path) return input.file_path as string;

	return undefined;
}

/**
 * Estimate change size from tool input.
 */
function estimateChangeSize(
	toolName: string,
	input?: ToolInput,
): { linesAdded: number; linesRemoved: number } {
	if (!input) {
		return { linesAdded: 0, linesRemoved: 0 };
	}

	if (toolName === "Write") {
		// Write replaces entire file
		const content = input.content as string | undefined;
		const linesAdded = content ? content.split("\n").length : 0;
		return { linesAdded, linesRemoved: 0 };
	}

	if (toolName === "Edit") {
		// Edit replaces old_string with new_string
		const oldStr = input.old_string as string | undefined;
		const newStr = input.new_string as string | undefined;
		const linesRemoved = oldStr ? oldStr.split("\n").length : 0;
		const linesAdded = newStr ? newStr.split("\n").length : 0;
		return { linesAdded, linesRemoved };
	}

	return { linesAdded: 0, linesRemoved: 0 };
}

// ============================================================================
// Statistics Access
// ============================================================================

/**
 * Get session statistics for a project.
 */
export function getSessionStatistics(projectPath: string) {
	const system = getInteractionSystem(projectPath);
	if (!system) return null;
	return system.store.getSessionStatistics();
}

/**
 * Get pattern statistics for a project.
 */
export function getPatternStatistics(projectPath: string) {
	const system = getInteractionSystem(projectPath);
	if (!system) return null;
	return system.store.getPatternStatistics();
}

/**
 * Get improvement statistics for a project.
 */
export function getImprovementStatistics(projectPath: string) {
	const system = getInteractionSystem(projectPath);
	if (!system) return null;
	return system.store.getImprovementStatistics();
}

/**
 * Get recent corrections for a project.
 */
export function getRecentCorrections(projectPath: string, minScore = 0.6) {
	const system = getInteractionSystem(projectPath);
	if (!system) return [];
	return system.store.getRecentCorrections(minScore);
}

/**
 * Get Correction Gap statistics for a project.
 */
export function getCorrectionGapStats(projectPath: string) {
	const system = getInteractionSystem(projectPath);
	if (!system) return [];
	return system.store.getCorrectionGapStats();
}

/**
 * Prune old interaction data.
 */
export function pruneOldData(projectPath: string) {
	const system = getInteractionSystem(projectPath);
	if (!system) return null;
	return system.store.pruneOldData();
}

/**
 * Cleanup stale sessions.
 */
export function cleanupStaleSessions(projectPath: string) {
	const system = getInteractionSystem(projectPath);
	if (!system) return 0;
	return system.tracker.cleanupStaleSessions();
}
