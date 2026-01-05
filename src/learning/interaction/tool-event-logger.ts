/**
 * ToolEventLogger - Captures and logs tool execution events.
 *
 * Responsibilities:
 * - Log tool invocations with timing
 * - Hash tool inputs for privacy
 * - Classify tool errors
 * - Track code changes for Correction Gap analysis
 */

import type { InteractionStore } from "./interaction-store.js";
import type { SessionTracker } from "./session-tracker.js";
import type {
	ToolEvent,
	CodeChange,
	ToolErrorType,
	CorrectionType,
	InteractionConfig,
} from "./types.js";
import { DEFAULT_INTERACTION_CONFIG } from "./types.js";
import { createHash } from "node:crypto";

// ============================================================================
// ToolEventLogger Class
// ============================================================================

export class ToolEventLogger {
	private store: InteractionStore;
	private sessionTracker: SessionTracker;
	private config: InteractionConfig;

	constructor(
		store: InteractionStore,
		sessionTracker: SessionTracker,
		config: Partial<InteractionConfig> = {},
	) {
		this.store = store;
		this.sessionTracker = sessionTracker;
		this.config = { ...DEFAULT_INTERACTION_CONFIG, ...config };
	}

	/**
	 * Log a tool execution event.
	 */
	logToolEvent(options: {
		sessionId: string;
		toolUseId: string;
		toolName: string;
		toolInput?: Record<string, unknown>;
		success: boolean;
		error?: string;
	}): number | undefined {
		if (!this.config.enabled) return undefined;

		// Get timing from session tracker
		const timing = this.sessionTracker.toolCompleted(
			options.sessionId,
			options.toolUseId,
		);

		const event: Omit<ToolEvent, "id"> = {
			sessionId: options.sessionId,
			toolUseId: options.toolUseId,
			toolName: options.toolName,
			toolInputHash: this.config.hashToolInputs
				? this.hashInput(options.toolInput)
				: undefined,
			success: options.success,
			errorType: options.success
				? undefined
				: this.classifyError(options.error),
			durationMs: timing?.durationMs,
			executionOrder: timing?.executionOrder || 0,
			timestamp: Date.now(),
		};

		const eventId = this.store.recordToolEvent(event);

		// Update session counters
		this.sessionTracker.incrementCounters(options.sessionId, {
			tools: 1,
		});

		return eventId;
	}

	/**
	 * Log a code change from agent or user.
	 */
	logCodeChange(options: {
		sessionId: string;
		filePath: string;
		author: "agent" | "user";
		diff?: string;
		linesAdded: number;
		linesRemoved: number;
	}): number | undefined {
		if (!this.config.enabled) return undefined;

		// Check for Correction Gap (user editing agent's recent work)
		let agentChangeId: number | undefined;
		let correctionType: CorrectionType | undefined;

		if (options.author === "user") {
			const recentAgentChanges = this.store.getRecentAgentChanges(
				options.sessionId,
				options.filePath,
				300000, // 5 minute window
			);

			if (recentAgentChanges.length > 0) {
				// User is modifying agent's recent work
				agentChangeId = recentAgentChanges[0].id;
				correctionType = this.classifyCorrectionType(
					recentAgentChanges[0],
					options,
				);

				// Record as intervention
				this.sessionTracker.incrementCounters(options.sessionId, {
					interventions: 1,
				});
			}
		}

		const change: Omit<CodeChange, "id"> = {
			sessionId: options.sessionId,
			filePath: options.filePath,
			author: options.author,
			diffHash: options.diff ? this.hashDiff(options.diff) : undefined,
			linesAdded: options.linesAdded,
			linesRemoved: options.linesRemoved,
			timestamp: Date.now(),
			agentChangeId,
			correctionType,
		};

		return this.store.recordCodeChange(change);
	}

	/**
	 * Log PreToolUse event (tool is about to execute).
	 */
	logToolStart(sessionId: string, toolUseId: string): void {
		if (!this.config.enabled) return;
		this.sessionTracker.toolStarted(sessionId, toolUseId);
	}

	/**
	 * Check if a file path indicates code (not config, etc.).
	 */
	isCodeFile(filePath: string): boolean {
		const codeExtensions = [
			".ts",
			".tsx",
			".js",
			".jsx",
			".py",
			".go",
			".rs",
			".java",
			".kt",
			".swift",
			".c",
			".cpp",
			".h",
			".hpp",
			".cs",
			".rb",
			".php",
			".vue",
			".svelte",
		];

		const lowerPath = filePath.toLowerCase();
		return codeExtensions.some((ext) => lowerPath.endsWith(ext));
	}

	/**
	 * Get tool event history for a session.
	 */
	getToolHistory(sessionId: string): ToolEvent[] {
		return this.store.getToolEventsBySession(sessionId);
	}

	/**
	 * Get tool sequence for a session.
	 */
	getToolSequence(sessionId: string): string[] {
		return this.store.getToolSequence(sessionId);
	}

	/**
	 * Get error rates by tool.
	 */
	getErrorRates(): Array<{
		toolName: string;
		total: number;
		failures: number;
		rate: number;
	}> {
		return this.store.getToolErrorRates();
	}

	// ========================================================================
	// Private Methods
	// ========================================================================

	/**
	 * Hash tool input for privacy.
	 */
	private hashInput(input?: Record<string, unknown>): string | undefined {
		if (!input) return undefined;

		// Remove potentially sensitive fields before hashing
		const sanitized = this.sanitizeInput(input);
		const json = JSON.stringify(sanitized, Object.keys(sanitized).sort());

		return createHash("sha256").update(json).digest("hex").substring(0, 16);
	}

	/**
	 * Hash a diff for privacy.
	 */
	private hashDiff(diff: string): string {
		return createHash("sha256").update(diff).digest("hex").substring(0, 16);
	}

	/**
	 * Sanitize tool input by removing sensitive patterns.
	 */
	private sanitizeInput(
		input: Record<string, unknown>,
	): Record<string, unknown> {
		const sensitiveKeys = [
			"password",
			"token",
			"secret",
			"key",
			"auth",
			"credential",
			"api_key",
			"apiKey",
			"bearer",
		];

		const sanitized: Record<string, unknown> = {};

		for (const [key, value] of Object.entries(input)) {
			const lowerKey = key.toLowerCase();

			// Skip sensitive keys
			if (sensitiveKeys.some((s) => lowerKey.includes(s))) {
				sanitized[key] = "[REDACTED]";
				continue;
			}

			// Recursively sanitize nested objects
			if (typeof value === "object" && value !== null && !Array.isArray(value)) {
				sanitized[key] = this.sanitizeInput(value as Record<string, unknown>);
			} else if (typeof value === "string") {
				// Redact values that look like tokens/keys
				sanitized[key] = this.redactSensitiveValue(value);
			} else {
				sanitized[key] = value;
			}
		}

		return sanitized;
	}

	/**
	 * Redact values that look like secrets.
	 */
	private redactSensitiveValue(value: string): string {
		// Patterns that look like tokens, API keys, etc.
		const sensitivePatterns = [
			/^sk-[a-zA-Z0-9-_]{20,}$/, // OpenAI-style keys
			/^sk-ant-[a-zA-Z0-9-_]{20,}$/, // Anthropic keys
			/^ghp_[a-zA-Z0-9]{36,}$/, // GitHub tokens
			/^gho_[a-zA-Z0-9]{36,}$/, // GitHub OAuth
			/^glpat-[a-zA-Z0-9-_]{20,}$/, // GitLab tokens
			/^xox[baprs]-[a-zA-Z0-9-]+$/, // Slack tokens
			/^[a-zA-Z0-9-_]{30,}$/, // Generic long tokens
		];

		for (const pattern of sensitivePatterns) {
			if (pattern.test(value)) {
				return "[REDACTED]";
			}
		}

		return value;
	}

	/**
	 * Classify error type from error message.
	 */
	private classifyError(error?: string): ToolErrorType {
		if (!error) return "unknown";

		const lowerError = error.toLowerCase();

		if (
			lowerError.includes("timeout") ||
			lowerError.includes("timed out") ||
			lowerError.includes("exceeded")
		) {
			return "timeout";
		}

		if (
			lowerError.includes("permission") ||
			lowerError.includes("access denied") ||
			lowerError.includes("eperm") ||
			lowerError.includes("eacces") ||
			lowerError.includes("forbidden")
		) {
			return "permission";
		}

		if (
			lowerError.includes("invalid") ||
			lowerError.includes("validation") ||
			lowerError.includes("schema") ||
			lowerError.includes("required") ||
			lowerError.includes("missing")
		) {
			return "validation";
		}

		if (
			lowerError.includes("not found") ||
			lowerError.includes("enoent") ||
			lowerError.includes("cannot find") ||
			lowerError.includes("does not exist")
		) {
			return "logic";
		}

		return "logic";
	}

	/**
	 * Classify correction type based on user changes.
	 */
	private classifyCorrectionType(
		agentChange: CodeChange,
		userChange: {
			linesAdded: number;
			linesRemoved: number;
		},
	): CorrectionType {
		// If user removed most of what agent added, it's an undo
		if (
			userChange.linesRemoved > 0 &&
			userChange.linesRemoved >= agentChange.linesAdded * 0.7
		) {
			return "undo";
		}

		// If user added significantly more, it's an enhancement
		if (userChange.linesAdded > agentChange.linesAdded * 0.5) {
			return "enhance";
		}

		// Otherwise it's independent
		return "independent";
	}
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a ToolEventLogger instance.
 */
export function createToolEventLogger(
	store: InteractionStore,
	sessionTracker: SessionTracker,
	config?: Partial<InteractionConfig>,
): ToolEventLogger {
	return new ToolEventLogger(store, sessionTracker, config);
}
