/**
 * DeviationDetector - Warn when agent behavior deviates from expectations.
 *
 * Works with ShadowPredictor to identify:
 * - Unexpected tool selections
 * - Unusual tool sequences
 * - Potential errors or mistakes
 * - Novel behaviors (might be good or bad)
 *
 * Deviation detection helps:
 * - Catch mistakes early
 * - Identify learning opportunities
 * - Track behavioral changes
 */

import type { ShadowPredictor, PredictionResult } from "./shadow-predictor.js";

// ============================================================================
// Types
// ============================================================================

export interface DeviationDetectorConfig {
	/** Probability threshold for low-probability warning */
	lowProbabilityThreshold: number;
	/** Entropy threshold for high-uncertainty warning */
	highEntropyThreshold: number;
	/** Consecutive deviations to trigger alert */
	consecutiveDeviationsThreshold: number;
	/** Time window for deviation rate calculation (ms) */
	deviationWindowMs: number;
	/** Maximum deviations per window before alert */
	maxDeviationsPerWindow: number;
}

export const DEFAULT_DEVIATION_CONFIG: DeviationDetectorConfig = {
	lowProbabilityThreshold: 0.1,
	highEntropyThreshold: 2.5,
	consecutiveDeviationsThreshold: 3,
	deviationWindowMs: 10 * 60 * 1000, // 10 minutes
	maxDeviationsPerWindow: 5,
};

export type DeviationType =
	| "low_probability"
	| "unexpected"
	| "sequence_break"
	| "novel"
	| "high_entropy";

export type DeviationSeverity = "info" | "warning" | "alert";

export interface Deviation {
	/** Unique deviation ID */
	deviationId: string;
	/** Type of deviation */
	type: DeviationType;
	/** Severity level */
	severity: DeviationSeverity;
	/** The tool that was actually used */
	actualTool: string;
	/** The tool that was expected */
	expectedTool: string | null;
	/** Probability of actual tool */
	actualProbability: number;
	/** Probability of expected tool */
	expectedProbability: number;
	/** Context at time of deviation */
	context: string[];
	/** Description of the deviation */
	description: string;
	/** When deviation occurred */
	timestamp: number;
	/** Session ID (if available) */
	sessionId?: string;
}

export interface DeviationAlert {
	/** Alert ID */
	alertId: string;
	/** Alert type */
	alertType: "consecutive" | "rate" | "pattern";
	/** Severity */
	severity: DeviationSeverity;
	/** Related deviations */
	deviations: Deviation[];
	/** Alert message */
	message: string;
	/** When alert was triggered */
	timestamp: number;
	/** Recommended action */
	recommendation: string;
}

export interface DeviationAnalysis {
	/** Is this a deviation? */
	isDeviation: boolean;
	/** Deviation details (if applicable) */
	deviation: Deviation | null;
	/** Alert triggered (if applicable) */
	alert: DeviationAlert | null;
	/** Raw prediction result */
	prediction: PredictionResult;
	/** Probability of the actual tool */
	actualProbability: number;
}

export interface DeviationStatistics {
	/** Total deviations detected */
	totalDeviations: number;
	/** Deviations by type */
	byType: Record<DeviationType, number>;
	/** Deviations by severity */
	bySeverity: Record<DeviationSeverity, number>;
	/** Deviation rate (per session) */
	deviationRate: number;
	/** Most common unexpected tools */
	commonUnexpectedTools: Array<{ tool: string; count: number }>;
	/** Most common expected tools that were skipped */
	commonSkippedTools: Array<{ tool: string; count: number }>;
}

// ============================================================================
// DeviationDetector Class
// ============================================================================

export class DeviationDetector {
	private config: DeviationDetectorConfig;
	private predictor: ShadowPredictor;
	private deviations: Deviation[];
	private alerts: DeviationAlert[];
	private consecutiveDeviations: number;
	private recentDeviationTimestamps: number[];
	private deviationCounter: number;
	private alertCounter: number;

	constructor(
		predictor: ShadowPredictor,
		config: Partial<DeviationDetectorConfig> = {}
	) {
		this.config = { ...DEFAULT_DEVIATION_CONFIG, ...config };
		this.predictor = predictor;
		this.deviations = [];
		this.alerts = [];
		this.consecutiveDeviations = 0;
		this.recentDeviationTimestamps = [];
		this.deviationCounter = 0;
		this.alertCounter = 0;
	}

	/**
	 * Analyze a tool selection for deviations.
	 */
	analyze(actualTool: string, sessionId?: string): DeviationAnalysis {
		// Get prediction
		const prediction = this.predictor.predict();

		// Calculate probability of actual tool
		const actualProbability = this.predictor.getProbability(actualTool);

		// Check for deviation
		const deviation = this.checkForDeviation(
			actualTool,
			prediction,
			actualProbability,
			sessionId
		);

		// Check for alerts
		let alert: DeviationAlert | null = null;
		if (deviation) {
			this.deviations.push(deviation);
			this.consecutiveDeviations++;
			this.recentDeviationTimestamps.push(Date.now());

			// Clean old timestamps
			const cutoff = Date.now() - this.config.deviationWindowMs;
			this.recentDeviationTimestamps = this.recentDeviationTimestamps.filter(
				(t) => t > cutoff
			);

			alert = this.checkForAlert(deviation);
		} else {
			this.consecutiveDeviations = 0;
		}

		// Update predictor with actual tool
		this.predictor.observe(actualTool);

		return {
			isDeviation: deviation !== null,
			deviation,
			alert,
			prediction,
			actualProbability,
		};
	}

	/**
	 * Get deviation statistics.
	 */
	getStatistics(): DeviationStatistics {
		const byType: Record<DeviationType, number> = {
			low_probability: 0,
			unexpected: 0,
			sequence_break: 0,
			novel: 0,
			high_entropy: 0,
		};

		const bySeverity: Record<DeviationSeverity, number> = {
			info: 0,
			warning: 0,
			alert: 0,
		};

		const unexpectedCounts = new Map<string, number>();
		const skippedCounts = new Map<string, number>();

		for (const deviation of this.deviations) {
			byType[deviation.type]++;
			bySeverity[deviation.severity]++;

			unexpectedCounts.set(
				deviation.actualTool,
				(unexpectedCounts.get(deviation.actualTool) ?? 0) + 1
			);

			if (deviation.expectedTool) {
				skippedCounts.set(
					deviation.expectedTool,
					(skippedCounts.get(deviation.expectedTool) ?? 0) + 1
				);
			}
		}

		// Convert to sorted arrays
		const commonUnexpectedTools = Array.from(unexpectedCounts.entries())
			.map(([tool, count]) => ({ tool, count }))
			.sort((a, b) => b.count - a.count)
			.slice(0, 10);

		const commonSkippedTools = Array.from(skippedCounts.entries())
			.map(([tool, count]) => ({ tool, count }))
			.sort((a, b) => b.count - a.count)
			.slice(0, 10);

		// Calculate deviation rate
		const stats = this.predictor.getStatistics();
		const deviationRate =
			stats.totalSequences > 0
				? this.deviations.length / stats.totalSequences
				: 0;

		return {
			totalDeviations: this.deviations.length,
			byType,
			bySeverity,
			deviationRate,
			commonUnexpectedTools,
			commonSkippedTools,
		};
	}

	/**
	 * Get recent deviations.
	 */
	getRecentDeviations(limit: number = 20): Deviation[] {
		return this.deviations.slice(-limit);
	}

	/**
	 * Get active alerts.
	 */
	getAlerts(since?: number): DeviationAlert[] {
		if (since) {
			return this.alerts.filter((a) => a.timestamp >= since);
		}
		return [...this.alerts];
	}

	/**
	 * Clear deviation history.
	 */
	clearHistory(): void {
		this.deviations = [];
		this.alerts = [];
		this.consecutiveDeviations = 0;
		this.recentDeviationTimestamps = [];
	}

	/**
	 * Reset for new session.
	 */
	resetSession(): void {
		this.consecutiveDeviations = 0;
		this.predictor.resetContext();
	}

	/**
	 * Check if current behavior is unusual.
	 */
	isUnusualBehavior(): boolean {
		return (
			this.consecutiveDeviations >= this.config.consecutiveDeviationsThreshold ||
			this.recentDeviationTimestamps.length >= this.config.maxDeviationsPerWindow
		);
	}

	/**
	 * Export state for persistence.
	 */
	export(): {
		deviations: Deviation[];
		alerts: DeviationAlert[];
	} {
		return {
			deviations: this.deviations,
			alerts: this.alerts,
		};
	}

	/**
	 * Import state from persistence.
	 */
	import(data: { deviations: Deviation[]; alerts: DeviationAlert[] }): void {
		this.deviations = data.deviations;
		this.alerts = data.alerts;
	}

	// ========================================================================
	// Private Methods
	// ========================================================================

	/**
	 * Check if tool selection is a deviation.
	 */
	private checkForDeviation(
		actualTool: string,
		prediction: PredictionResult,
		actualProbability: number,
		sessionId?: string
	): Deviation | null {
		const expected = prediction.topPrediction;

		// No prediction = novel behavior
		if (!expected) {
			return this.createDeviation(
				"novel",
				"info",
				actualTool,
				null,
				actualProbability,
				0,
				prediction.predictions.map((p) => p.tool),
				`Novel tool usage: ${actualTool} with no prior context`,
				sessionId
			);
		}

		// High entropy = uncertain prediction
		if (prediction.entropy > this.config.highEntropyThreshold) {
			// Not really a deviation if entropy is high
			return null;
		}

		// Check if actual was expected
		if (actualTool === expected.tool) {
			return null; // No deviation
		}

		// Low probability deviation
		if (actualProbability < this.config.lowProbabilityThreshold) {
			const severity: DeviationSeverity =
				actualProbability < 0.01 ? "warning" : "info";

			return this.createDeviation(
				"low_probability",
				severity,
				actualTool,
				expected.tool,
				actualProbability,
				expected.probability,
				expected.context,
				`Low probability tool: ${actualTool} (${(actualProbability * 100).toFixed(1)}%) instead of ${expected.tool} (${(expected.probability * 100).toFixed(1)}%)`,
				sessionId
			);
		}

		// Unexpected but not super low probability
		if (prediction.isHighConfidence && actualTool !== expected.tool) {
			return this.createDeviation(
				"unexpected",
				"info",
				actualTool,
				expected.tool,
				actualProbability,
				expected.probability,
				expected.context,
				`Unexpected tool: ${actualTool} instead of highly expected ${expected.tool}`,
				sessionId
			);
		}

		return null;
	}

	/**
	 * Create a deviation object.
	 */
	private createDeviation(
		type: DeviationType,
		severity: DeviationSeverity,
		actualTool: string,
		expectedTool: string | null,
		actualProbability: number,
		expectedProbability: number,
		context: string[],
		description: string,
		sessionId?: string
	): Deviation {
		return {
			deviationId: `dev_${Date.now()}_${++this.deviationCounter}`,
			type,
			severity,
			actualTool,
			expectedTool,
			actualProbability,
			expectedProbability,
			context,
			description,
			timestamp: Date.now(),
			sessionId,
		};
	}

	/**
	 * Check if alert should be triggered.
	 */
	private checkForAlert(latestDeviation: Deviation): DeviationAlert | null {
		// Check consecutive deviations
		if (
			this.consecutiveDeviations >= this.config.consecutiveDeviationsThreshold
		) {
			const recentDeviations = this.deviations.slice(
				-this.consecutiveDeviations
			);

			return this.createAlert(
				"consecutive",
				"warning",
				recentDeviations,
				`${this.consecutiveDeviations} consecutive deviations detected`,
				"Consider pausing to review agent behavior"
			);
		}

		// Check deviation rate
		if (
			this.recentDeviationTimestamps.length >=
			this.config.maxDeviationsPerWindow
		) {
			const recentDeviations = this.deviations.filter(
				(d) => d.timestamp > Date.now() - this.config.deviationWindowMs
			);

			return this.createAlert(
				"rate",
				"alert",
				recentDeviations,
				`High deviation rate: ${recentDeviations.length} in ${Math.round(this.config.deviationWindowMs / 60000)} minutes`,
				"Agent behavior may be unstable or task may be outside training distribution"
			);
		}

		return null;
	}

	/**
	 * Create an alert object.
	 */
	private createAlert(
		alertType: DeviationAlert["alertType"],
		severity: DeviationSeverity,
		deviations: Deviation[],
		message: string,
		recommendation: string
	): DeviationAlert {
		const alert: DeviationAlert = {
			alertId: `alert_${Date.now()}_${++this.alertCounter}`,
			alertType,
			severity,
			deviations,
			message,
			timestamp: Date.now(),
			recommendation,
		};

		this.alerts.push(alert);

		// Keep only recent alerts
		const oneHourAgo = Date.now() - 60 * 60 * 1000;
		this.alerts = this.alerts.filter((a) => a.timestamp > oneHourAgo);

		return alert;
	}
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a deviation detector with a predictor and optional configuration.
 */
export function createDeviationDetector(
	predictor: ShadowPredictor,
	config: Partial<DeviationDetectorConfig> = {}
): DeviationDetector {
	return new DeviationDetector(predictor, config);
}
