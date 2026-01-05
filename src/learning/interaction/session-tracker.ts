/**
 * SessionTracker - Manages agent session lifecycle.
 *
 * Responsibilities:
 * - Track session start/end
 * - Maintain active session state
 * - Update session counters
 * - Detect session outcomes
 */

import type { InteractionStore } from "./interaction-store.js";
import type {
	AgentSession,
	SessionOutcome,
	InteractionConfig,
} from "./types.js";
import { DEFAULT_INTERACTION_CONFIG } from "./types.js";
import { createHash } from "node:crypto";

// ============================================================================
// SessionTracker Class
// ============================================================================

export class SessionTracker {
	private store: InteractionStore;
	private config: InteractionConfig;
	private activeSessions: Map<string, SessionState> = new Map();

	constructor(store: InteractionStore, config: Partial<InteractionConfig> = {}) {
		this.store = store;
		this.config = { ...DEFAULT_INTERACTION_CONFIG, ...config };
	}

	/**
	 * Start tracking a new session.
	 */
	startSession(sessionId: string, projectPath: string): void {
		if (!this.config.enabled) return;

		const session: AgentSession = {
			sessionId,
			timestamp: Date.now(),
			projectPath,
			toolCount: 0,
			interventionCount: 0,
			autonomousCount: 0,
		};

		this.store.upsertSession(session);

		this.activeSessions.set(sessionId, {
			session,
			startTime: Date.now(),
			lastActivity: Date.now(),
			toolExecutionOrder: 0,
			pendingTools: new Map(),
		});
	}

	/**
	 * Check if a session is active.
	 */
	isSessionActive(sessionId: string): boolean {
		return this.activeSessions.has(sessionId);
	}

	/**
	 * Get active session state.
	 */
	getSessionState(sessionId: string): SessionState | undefined {
		return this.activeSessions.get(sessionId);
	}

	/**
	 * Record tool start (for duration tracking).
	 */
	toolStarted(sessionId: string, toolUseId: string): void {
		const state = this.activeSessions.get(sessionId);
		if (!state) return;

		state.pendingTools.set(toolUseId, {
			startTime: Date.now(),
			executionOrder: ++state.toolExecutionOrder,
		});
		state.lastActivity = Date.now();
	}

	/**
	 * Record tool completion.
	 */
	toolCompleted(
		sessionId: string,
		toolUseId: string,
	): { durationMs: number; executionOrder: number } | undefined {
		const state = this.activeSessions.get(sessionId);
		if (!state) return undefined;

		const pending = state.pendingTools.get(toolUseId);
		if (!pending) {
			return {
				durationMs: 0,
				executionOrder: ++state.toolExecutionOrder,
			};
		}

		state.pendingTools.delete(toolUseId);
		state.lastActivity = Date.now();

		return {
			durationMs: Date.now() - pending.startTime,
			executionOrder: pending.executionOrder,
		};
	}

	/**
	 * Increment session counters.
	 */
	incrementCounters(
		sessionId: string,
		options: {
			tools?: number;
			interventions?: number;
			autonomous?: number;
		},
	): void {
		if (!this.config.enabled) return;

		const state = this.activeSessions.get(sessionId);
		if (state) {
			state.session.toolCount += options.tools || 0;
			state.session.interventionCount += options.interventions || 0;
			state.session.autonomousCount += options.autonomous || 0;
			state.lastActivity = Date.now();
		}

		this.store.incrementSessionCounters(
			sessionId,
			options.tools || 0,
			options.interventions || 0,
			options.autonomous || 0,
		);
	}

	/**
	 * End a session.
	 */
	endSession(
		sessionId: string,
		outcome?: SessionOutcome,
	): AgentSession | undefined {
		if (!this.config.enabled) return undefined;

		const state = this.activeSessions.get(sessionId);
		if (!state) {
			// Try to update stored session anyway
			if (outcome) {
				this.store.updateSessionOutcome(sessionId, outcome);
			}
			return this.store.getSession(sessionId) || undefined;
		}

		// Calculate duration
		const duration = Date.now() - state.startTime;
		state.session.duration = duration;

		// Determine outcome if not provided
		const finalOutcome = outcome || this.inferOutcome(state);
		state.session.outcome = finalOutcome;

		// Update store
		this.store.upsertSession(state.session);

		// Remove from active sessions
		this.activeSessions.delete(sessionId);

		return state.session;
	}

	/**
	 * Get or create session for a project.
	 * Useful when hooks fire without explicit session start.
	 */
	ensureSession(sessionId: string, projectPath: string): SessionState {
		let state = this.activeSessions.get(sessionId);
		if (!state) {
			this.startSession(sessionId, projectPath);
			state = this.activeSessions.get(sessionId)!;
		}
		return state;
	}

	/**
	 * Get all active sessions.
	 */
	getActiveSessions(): Map<string, SessionState> {
		return new Map(this.activeSessions);
	}

	/**
	 * Clean up stale sessions (no activity for specified duration).
	 */
	cleanupStaleSessions(maxInactiveMs = 3600000): number {
		const now = Date.now();
		let cleaned = 0;

		for (const [sessionId, state] of this.activeSessions) {
			if (now - state.lastActivity > maxInactiveMs) {
				this.endSession(sessionId, "abandoned");
				cleaned++;
			}
		}

		return cleaned;
	}

	/**
	 * Generate a session ID from project path and timestamp.
	 */
	static generateSessionId(projectPath: string): string {
		const timestamp = Date.now();
		const random = Math.random().toString(36).substring(2, 8);
		const hash = createHash("sha256")
			.update(`${projectPath}-${timestamp}-${random}`)
			.digest("hex")
			.substring(0, 12);
		return `sess_${hash}`;
	}

	// ========================================================================
	// Private Methods
	// ========================================================================

	/**
	 * Infer session outcome from state.
	 */
	private inferOutcome(state: SessionState): SessionOutcome {
		const { session } = state;

		// No tools used = abandoned
		if (session.toolCount === 0) {
			return "abandoned";
		}

		// High intervention rate = failure
		const interventionRate =
			session.interventionCount / session.toolCount;
		if (interventionRate > 0.5) {
			return "failure";
		}

		// Some interventions = partial
		if (session.interventionCount > 0) {
			return "partial";
		}

		// No interventions = success
		return "success";
	}
}

// ============================================================================
// Supporting Types
// ============================================================================

/**
 * Active session state (in-memory).
 */
export interface SessionState {
	session: AgentSession;
	startTime: number;
	lastActivity: number;
	toolExecutionOrder: number;
	pendingTools: Map<string, PendingTool>;
}

/**
 * Tool execution in progress.
 */
interface PendingTool {
	startTime: number;
	executionOrder: number;
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a SessionTracker instance.
 */
export function createSessionTracker(
	store: InteractionStore,
	config?: Partial<InteractionConfig>,
): SessionTracker {
	return new SessionTracker(store, config);
}
