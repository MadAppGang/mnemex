/**
 * User-Agent Interaction Monitoring Module
 *
 * This module provides continuous learning capabilities by tracking
 * user-agent interactions, detecting patterns, and generating improvements.
 *
 * Architecture:
 * - types.ts           - Type definitions for interaction data
 * - interaction-store.ts - SQLite storage for sessions, events, patterns
 * - session-tracker.ts   - Session lifecycle management
 * - tool-event-logger.ts - Tool execution logging with privacy
 *
 * Usage:
 * ```typescript
 * import { createInteractionSystem } from "./learning/interaction/index.js";
 *
 * const interaction = createInteractionSystem(db);
 *
 * // Track a session
 * interaction.tracker.startSession("sess_123", "/path/to/project");
 *
 * // Log tool events
 * interaction.logger.logToolEvent({
 *   sessionId: "sess_123",
 *   toolUseId: "tool_456",
 *   toolName: "Edit",
 *   success: true,
 * });
 *
 * // End session
 * interaction.tracker.endSession("sess_123", "success");
 *
 * // Get statistics
 * const stats = interaction.store.getSessionStatistics();
 * ```
 */

import type { SQLiteDatabase } from "../../core/sqlite.js";
import type { InteractionConfig } from "./types.js";
import { DEFAULT_INTERACTION_CONFIG } from "./types.js";
import { InteractionStore, createInteractionStore } from "./interaction-store.js";
import { SessionTracker, createSessionTracker } from "./session-tracker.js";
import { ToolEventLogger, createToolEventLogger } from "./tool-event-logger.js";

// ============================================================================
// Re-exports
// ============================================================================

// Types
export * from "./types.js";

// Store
export { InteractionStore, createInteractionStore } from "./interaction-store.js";

// Session Tracker
export {
	SessionTracker,
	createSessionTracker,
	type SessionState,
} from "./session-tracker.js";

// Tool Event Logger
export { ToolEventLogger, createToolEventLogger } from "./tool-event-logger.js";

// ============================================================================
// Convenience Factory
// ============================================================================

/**
 * Complete interaction monitoring system with all components wired together.
 */
export interface InteractionSystem {
	/** Interaction storage */
	store: InteractionStore;
	/** Session lifecycle tracker */
	tracker: SessionTracker;
	/** Tool event logger */
	logger: ToolEventLogger;
	/** Configuration */
	config: InteractionConfig;
}

/**
 * Create a complete interaction monitoring system.
 *
 * @param db - SQLite database instance
 * @param config - Optional configuration overrides
 * @returns Wired interaction system components
 */
export function createInteractionSystem(
	db: SQLiteDatabase,
	config: Partial<InteractionConfig> = {},
): InteractionSystem {
	const mergedConfig = { ...DEFAULT_INTERACTION_CONFIG, ...config };

	// Create components in dependency order
	const store = createInteractionStore(db, mergedConfig);
	const tracker = createSessionTracker(store, mergedConfig);
	const logger = createToolEventLogger(store, tracker, mergedConfig);

	return {
		store,
		tracker,
		logger,
		config: mergedConfig,
	};
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Generate a unique session ID.
 */
export function generateSessionId(projectPath: string): string {
	return SessionTracker.generateSessionId(projectPath);
}

/**
 * Format duration in milliseconds to human-readable string.
 */
export function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
	if (ms < 3600000) return `${(ms / 60000).toFixed(1)}m`;
	return `${(ms / 3600000).toFixed(1)}h`;
}

/**
 * Format session statistics for CLI display.
 */
export function formatSessionStats(
	stats: ReturnType<InteractionStore["getSessionStatistics"]>,
): string {
	const lines: string[] = [
		"Session Statistics",
		"─".repeat(40),
		`Total Sessions:     ${stats.totalSessions}`,
		`Total Tool Events:  ${stats.totalToolEvents}`,
		`Total Corrections:  ${stats.totalCorrections}`,
		`Avg Intervention:   ${(stats.avgInterventionRate * 100).toFixed(1)}%`,
		`Avg Duration:       ${formatDuration(stats.avgSessionDuration)}`,
		"",
		"Outcome Breakdown:",
		`  Success:    ${stats.outcomeBreakdown.success}`,
		`  Partial:    ${stats.outcomeBreakdown.partial}`,
		`  Failure:    ${stats.outcomeBreakdown.failure}`,
		`  Abandoned:  ${stats.outcomeBreakdown.abandoned}`,
	];

	if (stats.topToolsUsed.length > 0) {
		lines.push("", "Top Tools Used:");
		for (const tool of stats.topToolsUsed.slice(0, 5)) {
			lines.push(`  ${tool.toolName}: ${tool.count}`);
		}
	}

	return lines.join("\n");
}

/**
 * Format pattern statistics for CLI display.
 */
export function formatPatternStats(
	stats: ReturnType<InteractionStore["getPatternStatistics"]>,
): string {
	const lines: string[] = [
		"Pattern Statistics",
		"─".repeat(40),
		`Total Patterns: ${stats.totalPatterns}`,
		"",
		"By Type:",
		`  Error:       ${stats.patternsByType.error}`,
		`  Workflow:    ${stats.patternsByType.workflow}`,
		`  Misuse:      ${stats.patternsByType.misuse}`,
		`  Opportunity: ${stats.patternsByType.opportunity}`,
		"",
		"By Severity:",
		`  Critical: ${stats.patternsBySeverity.critical}`,
		`  Medium:   ${stats.patternsBySeverity.medium}`,
		`  Low:      ${stats.patternsBySeverity.low}`,
	];

	if (stats.topPatterns.length > 0) {
		lines.push("", "Top Patterns:");
		for (const pattern of stats.topPatterns.slice(0, 5)) {
			lines.push(
				`  [${pattern.patternType}] ${pattern.patternData.description} (${pattern.occurrenceCount}x)`,
			);
		}
	}

	return lines.join("\n");
}

/**
 * Format improvement statistics for CLI display.
 */
export function formatImprovementStats(
	stats: ReturnType<InteractionStore["getImprovementStatistics"]>,
): string {
	const lines: string[] = [
		"Improvement Statistics",
		"─".repeat(40),
		`Total Improvements: ${stats.totalImprovements}`,
		`Avg Safety Score:   ${(stats.avgSafetyScore * 100).toFixed(1)}%`,
		`Avg Impact Score:   ${(stats.avgImpactScore * 100).toFixed(1)}%`,
		"",
		"By Type:",
		`  Skill:    ${stats.improvementsByType.skill}`,
		`  Subagent: ${stats.improvementsByType.subagent}`,
		`  Prompt:   ${stats.improvementsByType.prompt}`,
		"",
		"By Status:",
		`  Proposed:    ${stats.improvementsByStatus.proposed}`,
		`  Testing:     ${stats.improvementsByStatus.testing}`,
		`  Approved:    ${stats.improvementsByStatus.approved}`,
		`  Deployed:    ${stats.improvementsByStatus.deployed}`,
		`  Rolled Back: ${stats.improvementsByStatus.rolled_back}`,
	];

	return lines.join("\n");
}

// ============================================================================
// CLI Statistics Wrappers
// ============================================================================

// Re-export statistics functions from hooks for CLI access
export {
	getSessionStatistics,
	getPatternStatistics,
	getImprovementStatistics,
	getRecentCorrections,
	getCorrectionGapStats,
	pruneOldData,
	cleanupStaleSessions,
} from "../../hooks/handlers/interaction-logger.js";
