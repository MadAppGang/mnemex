/**
 * A/B Testing Framework - Test improvements before full deployment.
 *
 * Provides controlled rollout of auto-generated improvements:
 * - Traffic splitting (e.g., 10% to treatment)
 * - Statistical significance testing
 * - Automatic graduation or rollback
 *
 * Metrics tracked:
 * - Correction rate (should decrease)
 * - Error rate (should decrease)
 * - Autonomy rate (should increase)
 * - User satisfaction (if available)
 */

import type { Improvement } from "../interaction/types.js";

// ============================================================================
// Types
// ============================================================================

export interface ABTestConfig {
	/** Percentage of sessions to receive treatment (0-100) */
	trafficPercent: number;
	/** Minimum sessions before significance test */
	minSessions: number;
	/** Minimum duration in ms before graduation */
	minDurationMs: number;
	/** Maximum duration in ms (auto-conclude) */
	maxDurationMs: number;
	/** Significance level (default 0.05) */
	significanceLevel: number;
	/** Minimum improvement required (e.g., 0.1 = 10% better) */
	minImprovementPercent: number;
}

export const DEFAULT_AB_CONFIG: ABTestConfig = {
	trafficPercent: 10,
	minSessions: 100,
	minDurationMs: 7 * 24 * 60 * 60 * 1000, // 7 days
	maxDurationMs: 30 * 24 * 60 * 60 * 1000, // 30 days
	significanceLevel: 0.05,
	minImprovementPercent: 0.1,
};

export type ExperimentStatus =
	| "pending"
	| "running"
	| "graduated"
	| "rolled_back"
	| "inconclusive";

export interface Experiment {
	/** Unique experiment identifier */
	experimentId: string;
	/** Improvement being tested */
	improvementId: string;
	/** Experiment name */
	name: string;
	/** Description */
	description: string;
	/** Current status */
	status: ExperimentStatus;
	/** Traffic allocation */
	trafficPercent: number;
	/** When experiment started */
	startedAt: number;
	/** When experiment ended (if concluded) */
	endedAt?: number;
	/** Control group metrics */
	controlMetrics: ExperimentMetrics;
	/** Treatment group metrics */
	treatmentMetrics: ExperimentMetrics;
	/** Statistical results */
	statisticalResult?: StatisticalResult;
	/** Conclusion reason */
	conclusionReason?: string;
}

export interface ExperimentMetrics {
	/** Number of sessions */
	sessions: number;
	/** Total corrections */
	corrections: number;
	/** Total errors */
	errors: number;
	/** Total autonomous completions */
	autonomousCompletions: number;
	/** Average session duration (ms) */
	avgSessionDurationMs: number;
	/** Custom metrics */
	custom: Record<string, number>;
}

export interface StatisticalResult {
	/** Is the result statistically significant? */
	isSignificant: boolean;
	/** P-value from test */
	pValue: number;
	/** Confidence interval (95%) */
	confidenceInterval: [number, number];
	/** Relative improvement (e.g., 0.15 = 15% better) */
	relativeImprovement: number;
	/** Absolute improvement */
	absoluteImprovement: number;
	/** Test used */
	testType: "chi_squared" | "t_test" | "proportion_z";
}

export interface ExperimentDecision {
	/** Recommended action */
	action: "graduate" | "rollback" | "continue" | "extend";
	/** Confidence in decision */
	confidence: number;
	/** Reasoning */
	reason: string;
}

// ============================================================================
// ABTestManager Class
// ============================================================================

export class ABTestManager {
	private config: ABTestConfig;
	private experiments: Map<string, Experiment>;
	private sessionAssignments: Map<string, string>; // sessionId -> experimentId (treatment)

	constructor(config: Partial<ABTestConfig> = {}) {
		this.config = { ...DEFAULT_AB_CONFIG, ...config };
		this.experiments = new Map();
		this.sessionAssignments = new Map();
	}

	/**
	 * Create a new experiment for an improvement.
	 */
	createExperiment(
		improvement: Improvement,
		name?: string,
		trafficPercent?: number
	): Experiment {
		const experimentId = `exp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

		const experiment: Experiment = {
			experimentId,
			improvementId: improvement.improvementId,
			name: name ?? `Test: ${improvement.improvementData.name}`,
			description: improvement.improvementData.description,
			status: "pending",
			trafficPercent: trafficPercent ?? this.config.trafficPercent,
			startedAt: 0,
			controlMetrics: this.createEmptyMetrics(),
			treatmentMetrics: this.createEmptyMetrics(),
		};

		this.experiments.set(experimentId, experiment);
		return experiment;
	}

	/**
	 * Start an experiment.
	 */
	startExperiment(experimentId: string): boolean {
		const experiment = this.experiments.get(experimentId);
		if (!experiment || experiment.status !== "pending") {
			return false;
		}

		experiment.status = "running";
		experiment.startedAt = Date.now();
		return true;
	}

	/**
	 * Assign a session to an experiment (treatment or control).
	 */
	assignSession(sessionId: string, experimentId: string): "treatment" | "control" {
		const experiment = this.experiments.get(experimentId);
		if (!experiment || experiment.status !== "running") {
			return "control";
		}

		// Deterministic assignment based on session ID hash
		const hash = this.hashString(sessionId);
		const inTreatment = (hash % 100) < experiment.trafficPercent;

		if (inTreatment) {
			this.sessionAssignments.set(sessionId, experimentId);
			return "treatment";
		}

		return "control";
	}

	/**
	 * Check if session is in treatment group for any experiment.
	 */
	isInTreatment(sessionId: string): boolean {
		return this.sessionAssignments.has(sessionId);
	}

	/**
	 * Get experiment for session (if in treatment).
	 */
	getSessionExperiment(sessionId: string): Experiment | undefined {
		const experimentId = this.sessionAssignments.get(sessionId);
		if (!experimentId) return undefined;
		return this.experiments.get(experimentId);
	}

	/**
	 * Record session metrics.
	 */
	recordSessionMetrics(
		experimentId: string,
		group: "treatment" | "control",
		metrics: Partial<ExperimentMetrics>
	): void {
		const experiment = this.experiments.get(experimentId);
		if (!experiment || experiment.status !== "running") {
			return;
		}

		const targetMetrics =
			group === "treatment"
				? experiment.treatmentMetrics
				: experiment.controlMetrics;

		targetMetrics.sessions += 1;
		targetMetrics.corrections += metrics.corrections ?? 0;
		targetMetrics.errors += metrics.errors ?? 0;
		targetMetrics.autonomousCompletions += metrics.autonomousCompletions ?? 0;

		// Update average duration (rolling average)
		if (metrics.avgSessionDurationMs) {
			const totalDuration =
				targetMetrics.avgSessionDurationMs * (targetMetrics.sessions - 1) +
				metrics.avgSessionDurationMs;
			targetMetrics.avgSessionDurationMs = totalDuration / targetMetrics.sessions;
		}

		// Update custom metrics
		for (const [key, value] of Object.entries(metrics.custom ?? {})) {
			targetMetrics.custom[key] = (targetMetrics.custom[key] ?? 0) + value;
		}
	}

	/**
	 * Evaluate experiment and get decision.
	 */
	evaluateExperiment(experimentId: string): ExperimentDecision {
		const experiment = this.experiments.get(experimentId);
		if (!experiment) {
			return {
				action: "continue",
				confidence: 0,
				reason: "Experiment not found",
			};
		}

		// Check if minimum requirements met
		const duration = Date.now() - experiment.startedAt;
		const totalSessions =
			experiment.controlMetrics.sessions + experiment.treatmentMetrics.sessions;

		// Not enough data yet
		if (
			totalSessions < this.config.minSessions ||
			duration < this.config.minDurationMs
		) {
			return {
				action: "continue",
				confidence: 0.5,
				reason: `Insufficient data: ${totalSessions}/${this.config.minSessions} sessions, ${Math.round(duration / 86400000)}/${Math.round(this.config.minDurationMs / 86400000)} days`,
			};
		}

		// Run statistical test
		const result = this.runStatisticalTest(experiment);
		experiment.statisticalResult = result;

		// Make decision
		if (result.isSignificant) {
			if (result.relativeImprovement >= this.config.minImprovementPercent) {
				return {
					action: "graduate",
					confidence: 1 - result.pValue,
					reason: `Significant improvement: ${(result.relativeImprovement * 100).toFixed(1)}% better (p=${result.pValue.toFixed(4)})`,
				};
			} else if (result.relativeImprovement <= -this.config.minImprovementPercent) {
				return {
					action: "rollback",
					confidence: 1 - result.pValue,
					reason: `Significant regression: ${(result.relativeImprovement * 100).toFixed(1)}% worse (p=${result.pValue.toFixed(4)})`,
				};
			}
		}

		// Check max duration
		if (duration >= this.config.maxDurationMs) {
			return {
				action: "rollback",
				confidence: 0.7,
				reason: `Max duration reached without significant improvement`,
			};
		}

		return {
			action: "continue",
			confidence: 0.5,
			reason: `Not yet significant: p=${result.pValue.toFixed(4)}, improvement=${(result.relativeImprovement * 100).toFixed(1)}%`,
		};
	}

	/**
	 * Conclude an experiment.
	 */
	concludeExperiment(
		experimentId: string,
		status: "graduated" | "rolled_back" | "inconclusive",
		reason?: string
	): boolean {
		const experiment = this.experiments.get(experimentId);
		if (!experiment || experiment.status !== "running") {
			return false;
		}

		experiment.status = status;
		experiment.endedAt = Date.now();
		experiment.conclusionReason = reason;

		// Clean up session assignments
		for (const [sessionId, expId] of this.sessionAssignments) {
			if (expId === experimentId) {
				this.sessionAssignments.delete(sessionId);
			}
		}

		return true;
	}

	/**
	 * Get all experiments.
	 */
	getAllExperiments(): Experiment[] {
		return Array.from(this.experiments.values());
	}

	/**
	 * Get running experiments.
	 */
	getRunningExperiments(): Experiment[] {
		return this.getAllExperiments().filter((e) => e.status === "running");
	}

	/**
	 * Get experiment by ID.
	 */
	getExperiment(experimentId: string): Experiment | undefined {
		return this.experiments.get(experimentId);
	}

	/**
	 * Load experiments from storage (e.g., SQLite).
	 */
	loadExperiments(experiments: Experiment[]): void {
		for (const exp of experiments) {
			this.experiments.set(exp.experimentId, exp);
		}
	}

	/**
	 * Export experiments for storage.
	 */
	exportExperiments(): Experiment[] {
		return this.getAllExperiments();
	}

	// ========================================================================
	// Private Methods
	// ========================================================================

	/**
	 * Create empty metrics object.
	 */
	private createEmptyMetrics(): ExperimentMetrics {
		return {
			sessions: 0,
			corrections: 0,
			errors: 0,
			autonomousCompletions: 0,
			avgSessionDurationMs: 0,
			custom: {},
		};
	}

	/**
	 * Simple string hash for deterministic assignment.
	 */
	private hashString(str: string): number {
		let hash = 0;
		for (let i = 0; i < str.length; i++) {
			const char = str.charCodeAt(i);
			hash = (hash << 5) - hash + char;
			hash = hash & hash;
		}
		return Math.abs(hash);
	}

	/**
	 * Run statistical significance test.
	 */
	private runStatisticalTest(experiment: Experiment): StatisticalResult {
		const control = experiment.controlMetrics;
		const treatment = experiment.treatmentMetrics;

		// Use correction rate as primary metric
		const controlRate = control.sessions > 0 ? control.corrections / control.sessions : 0;
		const treatmentRate = treatment.sessions > 0 ? treatment.corrections / treatment.sessions : 0;

		// Calculate relative improvement (negative = better for corrections)
		const absoluteImprovement = controlRate - treatmentRate;
		const relativeImprovement = controlRate > 0 ? absoluteImprovement / controlRate : 0;

		// Two-proportion z-test
		const { pValue, confidenceInterval } = this.proportionZTest(
			treatment.corrections,
			treatment.sessions,
			control.corrections,
			control.sessions
		);

		return {
			isSignificant: pValue < this.config.significanceLevel,
			pValue,
			confidenceInterval,
			relativeImprovement,
			absoluteImprovement,
			testType: "proportion_z",
		};
	}

	/**
	 * Two-proportion z-test.
	 */
	private proportionZTest(
		successes1: number,
		n1: number,
		successes2: number,
		n2: number
	): { pValue: number; confidenceInterval: [number, number] } {
		// Handle edge cases
		if (n1 === 0 || n2 === 0) {
			return { pValue: 1, confidenceInterval: [0, 0] };
		}

		const p1 = successes1 / n1;
		const p2 = successes2 / n2;
		const pPooled = (successes1 + successes2) / (n1 + n2);

		// Standard error
		const se = Math.sqrt(pPooled * (1 - pPooled) * (1 / n1 + 1 / n2));

		if (se === 0) {
			return { pValue: 1, confidenceInterval: [p1 - p2, p1 - p2] };
		}

		// Z-score
		const z = (p1 - p2) / se;

		// Two-tailed p-value (using normal approximation)
		const pValue = 2 * (1 - this.normalCDF(Math.abs(z)));

		// 95% confidence interval
		const seUnpooled = Math.sqrt(
			(p1 * (1 - p1)) / n1 + (p2 * (1 - p2)) / n2
		);
		const marginOfError = 1.96 * seUnpooled;
		const diff = p1 - p2;
		const confidenceInterval: [number, number] = [
			diff - marginOfError,
			diff + marginOfError,
		];

		return { pValue, confidenceInterval };
	}

	/**
	 * Normal cumulative distribution function (approximation).
	 */
	private normalCDF(x: number): number {
		// Approximation using error function
		const a1 = 0.254829592;
		const a2 = -0.284496736;
		const a3 = 1.421413741;
		const a4 = -1.453152027;
		const a5 = 1.061405429;
		const p = 0.3275911;

		const sign = x < 0 ? -1 : 1;
		x = Math.abs(x) / Math.sqrt(2);

		const t = 1.0 / (1.0 + p * x);
		const y =
			1.0 -
			((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

		return 0.5 * (1.0 + sign * y);
	}
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create an A/B test manager with optional configuration.
 */
export function createABTestManager(
	config: Partial<ABTestConfig> = {}
): ABTestManager {
	return new ABTestManager(config);
}
