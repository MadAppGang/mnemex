/**
 * RollbackManager - Revert improvements that cause regressions.
 *
 * Provides:
 * - Manual rollback capability
 * - Automatic rollback on detected regression
 * - Rollback history and audit trail
 * - Partial rollback (revert specific improvements)
 */

import type { Improvement, ImprovementStatus } from "../interaction/types.js";
import type { MetricAnomaly } from "./metrics-tracker.js";

// ============================================================================
// Types
// ============================================================================

export interface RollbackManagerConfig {
	/** Maximum rollback history to retain */
	maxHistorySize: number;
	/** Auto-rollback on anomaly severity threshold */
	autoRollbackThreshold: number;
	/** Cooldown period after rollback (ms) before re-deploy */
	rollbackCooldownMs: number;
	/** Require confirmation for auto-rollback */
	requireConfirmation: boolean;
}

export const DEFAULT_ROLLBACK_CONFIG: RollbackManagerConfig = {
	maxHistorySize: 100,
	autoRollbackThreshold: 3.0, // z-score
	rollbackCooldownMs: 24 * 60 * 60 * 1000, // 24 hours
	requireConfirmation: false,
};

export type RollbackReason =
	| "manual"
	| "regression"
	| "anomaly"
	| "experiment_failed"
	| "safety_issue"
	| "user_request";

export interface RollbackEvent {
	/** Unique rollback ID */
	rollbackId: string;
	/** Improvement that was rolled back */
	improvementId: string;
	/** Improvement data snapshot */
	improvementSnapshot: Improvement;
	/** Why rollback occurred */
	reason: RollbackReason;
	/** Detailed reason description */
	description: string;
	/** Metrics at time of rollback */
	metricsSnapshot?: RollbackMetrics;
	/** Anomaly that triggered rollback (if applicable) */
	triggerAnomaly?: MetricAnomaly;
	/** When rollback was initiated */
	initiatedAt: number;
	/** When rollback was completed */
	completedAt?: number;
	/** Who/what initiated rollback */
	initiatedBy: "system" | "user" | "experiment";
	/** Whether rollback succeeded */
	success: boolean;
	/** Error message if failed */
	error?: string;
}

export interface RollbackMetrics {
	/** Correction rate at rollback time */
	correctionRate: number;
	/** Error rate at rollback time */
	errorRate: number;
	/** Comparison to baseline */
	vsBaseline: {
		correctionRateChange: number;
		errorRateChange: number;
	};
}

export interface RollbackCandidate {
	/** Improvement to potentially rollback */
	improvement: Improvement;
	/** Reason for candidacy */
	reason: RollbackReason;
	/** Severity score */
	severity: number;
	/** Recommended action */
	recommendation: "rollback" | "monitor" | "ignore";
	/** Evidence supporting rollback */
	evidence: string[];
}

export interface RollbackStatus {
	/** Currently rolled back improvement IDs */
	rolledBackIds: Set<string>;
	/** Improvements in cooldown (cannot be re-deployed yet) */
	inCooldown: Map<string, number>; // improvementId -> cooldownEndsAt
	/** Recent rollback events */
	recentEvents: RollbackEvent[];
}

// ============================================================================
// RollbackManager Class
// ============================================================================

export class RollbackManager {
	private config: RollbackManagerConfig;
	private history: RollbackEvent[];
	private rolledBackIds: Set<string>;
	private cooldowns: Map<string, number>;
	private pendingRollbacks: Map<string, RollbackCandidate>;

	constructor(config: Partial<RollbackManagerConfig> = {}) {
		this.config = { ...DEFAULT_ROLLBACK_CONFIG, ...config };
		this.history = [];
		this.rolledBackIds = new Set();
		this.cooldowns = new Map();
		this.pendingRollbacks = new Map();
	}

	/**
	 * Initiate a rollback for an improvement.
	 */
	initiateRollback(
		improvement: Improvement,
		reason: RollbackReason,
		description: string,
		initiatedBy: RollbackEvent["initiatedBy"] = "system",
		metrics?: RollbackMetrics,
		anomaly?: MetricAnomaly
	): RollbackEvent {
		const rollbackId = `rb_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

		const event: RollbackEvent = {
			rollbackId,
			improvementId: improvement.improvementId,
			improvementSnapshot: { ...improvement },
			reason,
			description,
			metricsSnapshot: metrics,
			triggerAnomaly: anomaly,
			initiatedAt: Date.now(),
			initiatedBy,
			success: false,
		};

		// Add to pending
		this.pendingRollbacks.delete(improvement.improvementId);

		// Perform rollback
		try {
			this.executeRollback(improvement);
			event.success = true;
			event.completedAt = Date.now();

			// Track rollback
			this.rolledBackIds.add(improvement.improvementId);

			// Set cooldown
			this.cooldowns.set(
				improvement.improvementId,
				Date.now() + this.config.rollbackCooldownMs
			);
		} catch (error) {
			event.success = false;
			event.error = error instanceof Error ? error.message : String(error);
		}

		// Add to history
		this.history.push(event);
		this.pruneHistory();

		return event;
	}

	/**
	 * Check if an improvement can be deployed (not in cooldown).
	 */
	canDeploy(improvementId: string): { allowed: boolean; reason?: string } {
		// Check if currently rolled back
		if (this.rolledBackIds.has(improvementId)) {
			return {
				allowed: false,
				reason: "Improvement is currently rolled back",
			};
		}

		// Check cooldown
		const cooldownEnd = this.cooldowns.get(improvementId);
		if (cooldownEnd && Date.now() < cooldownEnd) {
			const remaining = Math.ceil((cooldownEnd - Date.now()) / 3600000);
			return {
				allowed: false,
				reason: `In cooldown for ${remaining} more hours`,
			};
		}

		return { allowed: true };
	}

	/**
	 * Evaluate if an improvement should be rolled back.
	 */
	evaluateForRollback(
		improvement: Improvement,
		currentMetrics: RollbackMetrics,
		anomalies: MetricAnomaly[]
	): RollbackCandidate {
		const evidence: string[] = [];
		let severity = 0;

		// Check for related anomalies
		const relatedAnomalies = anomalies.filter(
			(a) =>
				a.detectedAt > improvement.deployedAt! &&
				(a.metricName.includes("correction") || a.metricName.includes("error"))
		);

		for (const anomaly of relatedAnomalies) {
			if (anomaly.severity >= this.config.autoRollbackThreshold) {
				severity = Math.max(severity, anomaly.severity);
				evidence.push(
					`Anomaly detected: ${anomaly.metricName} ${anomaly.type} (severity: ${anomaly.severity.toFixed(2)})`
				);
			}
		}

		// Check for regression vs baseline
		if (currentMetrics.vsBaseline.correctionRateChange > 0.2) {
			severity = Math.max(severity, 2);
			evidence.push(
				`Correction rate increased ${(currentMetrics.vsBaseline.correctionRateChange * 100).toFixed(1)}%`
			);
		}

		if (currentMetrics.vsBaseline.errorRateChange > 0.3) {
			severity = Math.max(severity, 2.5);
			evidence.push(
				`Error rate increased ${(currentMetrics.vsBaseline.errorRateChange * 100).toFixed(1)}%`
			);
		}

		// Determine recommendation
		let recommendation: RollbackCandidate["recommendation"];
		let reason: RollbackReason;

		if (severity >= this.config.autoRollbackThreshold) {
			recommendation = "rollback";
			reason = relatedAnomalies.length > 0 ? "anomaly" : "regression";
		} else if (severity >= this.config.autoRollbackThreshold * 0.7) {
			recommendation = "monitor";
			reason = "regression";
		} else {
			recommendation = "ignore";
			reason = "regression";
		}

		const candidate: RollbackCandidate = {
			improvement,
			reason,
			severity,
			recommendation,
			evidence,
		};

		// Track as pending if rollback recommended
		if (recommendation === "rollback") {
			this.pendingRollbacks.set(improvement.improvementId, candidate);
		}

		return candidate;
	}

	/**
	 * Process pending rollbacks.
	 */
	processPendingRollbacks(): RollbackEvent[] {
		const events: RollbackEvent[] = [];

		for (const [improvementId, candidate] of this.pendingRollbacks) {
			if (candidate.recommendation === "rollback") {
				if (this.config.requireConfirmation) {
					// Skip - requires manual confirmation
					continue;
				}

				const event = this.initiateRollback(
					candidate.improvement,
					candidate.reason,
					candidate.evidence.join("; "),
					"system"
				);
				events.push(event);
			}
		}

		return events;
	}

	/**
	 * Confirm a pending rollback.
	 */
	confirmRollback(improvementId: string): RollbackEvent | undefined {
		const candidate = this.pendingRollbacks.get(improvementId);
		if (!candidate) {
			return undefined;
		}

		return this.initiateRollback(
			candidate.improvement,
			candidate.reason,
			candidate.evidence.join("; "),
			"user"
		);
	}

	/**
	 * Cancel a pending rollback.
	 */
	cancelPendingRollback(improvementId: string): boolean {
		return this.pendingRollbacks.delete(improvementId);
	}

	/**
	 * Re-enable a rolled back improvement (after fixes).
	 */
	reenable(improvementId: string): boolean {
		if (!this.rolledBackIds.has(improvementId)) {
			return false;
		}

		this.rolledBackIds.delete(improvementId);
		this.cooldowns.delete(improvementId);
		return true;
	}

	/**
	 * Get current rollback status.
	 */
	getStatus(): RollbackStatus {
		// Clean up expired cooldowns
		const now = Date.now();
		for (const [id, endTime] of this.cooldowns) {
			if (endTime <= now) {
				this.cooldowns.delete(id);
			}
		}

		return {
			rolledBackIds: new Set(this.rolledBackIds),
			inCooldown: new Map(this.cooldowns),
			recentEvents: this.history.slice(-10),
		};
	}

	/**
	 * Get rollback history.
	 */
	getHistory(limit?: number): RollbackEvent[] {
		const events = [...this.history].reverse();
		return limit ? events.slice(0, limit) : events;
	}

	/**
	 * Get rollback statistics.
	 */
	getStatistics(): {
		totalRollbacks: number;
		byReason: Record<RollbackReason, number>;
		successRate: number;
		avgTimeToRollback: number;
		currentlyRolledBack: number;
	} {
		const byReason: Record<RollbackReason, number> = {
			manual: 0,
			regression: 0,
			anomaly: 0,
			experiment_failed: 0,
			safety_issue: 0,
			user_request: 0,
		};

		let successCount = 0;
		let totalTime = 0;
		let timeCount = 0;

		for (const event of this.history) {
			byReason[event.reason]++;
			if (event.success) successCount++;
			if (event.completedAt) {
				totalTime += event.completedAt - event.initiatedAt;
				timeCount++;
			}
		}

		return {
			totalRollbacks: this.history.length,
			byReason,
			successRate: this.history.length > 0 ? successCount / this.history.length : 1,
			avgTimeToRollback: timeCount > 0 ? totalTime / timeCount : 0,
			currentlyRolledBack: this.rolledBackIds.size,
		};
	}

	/**
	 * Get pending rollback candidates.
	 */
	getPendingRollbacks(): RollbackCandidate[] {
		return Array.from(this.pendingRollbacks.values());
	}

	/**
	 * Export state for persistence.
	 */
	export(): {
		history: RollbackEvent[];
		rolledBackIds: string[];
		cooldowns: Array<[string, number]>;
	} {
		return {
			history: this.history,
			rolledBackIds: Array.from(this.rolledBackIds),
			cooldowns: Array.from(this.cooldowns.entries()),
		};
	}

	/**
	 * Import state from persistence.
	 */
	import(data: {
		history: RollbackEvent[];
		rolledBackIds: string[];
		cooldowns: Array<[string, number]>;
	}): void {
		this.history = data.history;
		this.rolledBackIds = new Set(data.rolledBackIds);
		this.cooldowns = new Map(data.cooldowns);
	}

	// ========================================================================
	// Private Methods
	// ========================================================================

	/**
	 * Execute the actual rollback.
	 */
	private executeRollback(improvement: Improvement): void {
		// In a real implementation, this would:
		// 1. Disable the skill/subagent/prompt modification
		// 2. Update the improvement status in storage
		// 3. Notify relevant systems
		// 4. Clear any cached data

		// For now, we just update the status
		improvement.status = "rolled_back" as ImprovementStatus;

		// Log for debugging
		console.log(
			`[RollbackManager] Rolled back improvement: ${improvement.improvementId}`
		);
	}

	/**
	 * Prune history to max size.
	 */
	private pruneHistory(): void {
		while (this.history.length > this.config.maxHistorySize) {
			this.history.shift();
		}
	}
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a rollback manager with optional configuration.
 */
export function createRollbackManager(
	config: Partial<RollbackManagerConfig> = {}
): RollbackManager {
	return new RollbackManager(config);
}
