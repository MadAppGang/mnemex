/**
 * InteractionLogger - Hook handler integration for interaction monitoring.
 *
 * This module provides a singleton InteractionSystem that can be used by
 * hook handlers to log user-agent interactions. It lazily initializes
 * the database connection on first use.
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { HookInput, ToolInput, ToolResponse } from "../types.js";
import { createDatabaseSync, type SQLiteDatabase } from "../../core/sqlite.js";
import {
	createInteractionSystem,
	type InteractionSystem,
	generateSessionId,
} from "../../learning/interaction/index.js";

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

	// Check if project is indexed
	const indexDir = join(projectPath, ".claudemem");
	if (!existsSync(indexDir)) {
		return null;
	}

	// Open or create database
	const dbPath = join(indexDir, "index.db");
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
