/**
 * SafetyScorer - Compute final safety score for auto-deploy gating.
 *
 * Combines multiple signals:
 * - Red team vulnerability score
 * - Blue team defense report
 * - Pattern confidence
 * - Historical performance
 *
 * Determines whether an improvement can be auto-deployed
 * or requires human review.
 */

import type { Improvement } from "../interaction/types.js";
import type { RedTeamReport } from "./red-team.js";
import type { DefenseReport } from "./blue-team.js";

// ============================================================================
// Types
// ============================================================================

export interface SafetyScorerConfig {
	/** Weight for red team score */
	redTeamWeight: number;
	/** Weight for blue team score */
	blueTeamWeight: number;
	/** Weight for pattern confidence */
	patternWeight: number;
	/** Weight for historical performance */
	historyWeight: number;
	/** Threshold for auto-deploy */
	autoDeployThreshold: number;
	/** Threshold for human review */
	humanReviewThreshold: number;
	/** Require all components for auto-deploy */
	requireAllComponents: boolean;
}

export const DEFAULT_SCORER_CONFIG: SafetyScorerConfig = {
	redTeamWeight: 0.3,
	blueTeamWeight: 0.35,
	patternWeight: 0.2,
	historyWeight: 0.15,
	autoDeployThreshold: 0.9,
	humanReviewThreshold: 0.7,
	requireAllComponents: true,
};

export type DeploymentDecision = "auto_deploy" | "human_review" | "reject";

export interface SafetyScoreResult {
	/** Overall safety score (0-1) */
	overallScore: number;
	/** Component scores */
	componentScores: {
		redTeam: number;
		blueTeam: number;
		pattern: number;
		history: number;
	};
	/** Deployment decision */
	decision: DeploymentDecision;
	/** Confidence in decision (0-1) */
	confidence: number;
	/** Factors that influenced the decision */
	factors: SafetyFactor[];
	/** Recommendations */
	recommendations: string[];
	/** Timestamp */
	timestamp: number;
}

export interface SafetyFactor {
	/** Factor name */
	name: string;
	/** Factor type */
	type: "positive" | "negative" | "neutral";
	/** Impact on score */
	impact: number;
	/** Description */
	description: string;
}

export interface HistoricalData {
	/** Previous deployments of similar improvements */
	similarDeployments: number;
	/** Success rate of similar deployments */
	successRate: number;
	/** Rollback rate */
	rollbackRate: number;
	/** Average time before rollback (if any) */
	avgTimeToRollbackMs?: number;
}

export interface ScoringContext {
	/** Red team report (if available) */
	redTeamReport?: RedTeamReport;
	/** Defense report (if available) */
	defenseReport?: DefenseReport;
	/** Historical data (if available) */
	historicalData?: HistoricalData;
	/** Additional context */
	context?: Record<string, unknown>;
}

// ============================================================================
// SafetyScorer Class
// ============================================================================

export class SafetyScorer {
	private config: SafetyScorerConfig;
	private scoringHistory: Array<{
		improvementId: string;
		score: number;
		decision: DeploymentDecision;
		timestamp: number;
	}>;

	constructor(config: Partial<SafetyScorerConfig> = {}) {
		this.config = { ...DEFAULT_SCORER_CONFIG, ...config };
		this.scoringHistory = [];
	}

	/**
	 * Score an improvement for deployment.
	 */
	score(improvement: Improvement, context: ScoringContext): SafetyScoreResult {
		const factors: SafetyFactor[] = [];
		const componentScores = {
			redTeam: 0,
			blueTeam: 0,
			pattern: 0,
			history: 0,
		};

		// Red team score
		if (context.redTeamReport) {
			componentScores.redTeam =
				1 - context.redTeamReport.vulnerabilityScore;
			factors.push(
				...this.analyzeRedTeamFactors(context.redTeamReport)
			);
		} else {
			componentScores.redTeam = 0.5; // Unknown = neutral
			factors.push({
				name: "No Red Team Testing",
				type: "neutral",
				impact: 0,
				description: "No adversarial testing performed",
			});
		}

		// Blue team score
		if (context.defenseReport) {
			componentScores.blueTeam = context.defenseReport.safetyScore;
			factors.push(
				...this.analyzeBlueTeamFactors(context.defenseReport)
			);
		} else {
			componentScores.blueTeam = 0.5;
			factors.push({
				name: "No Defense Validation",
				type: "neutral",
				impact: 0,
				description: "No defense validation performed",
			});
		}

		// Pattern confidence score
		componentScores.pattern = this.scorePatternConfidence(improvement);
		factors.push(...this.analyzePatternFactors(improvement));

		// Historical score
		if (context.historicalData) {
			componentScores.history = this.scoreHistoricalData(
				context.historicalData
			);
			factors.push(
				...this.analyzeHistoricalFactors(context.historicalData)
			);
		} else {
			componentScores.history = 0.5;
			factors.push({
				name: "No Historical Data",
				type: "neutral",
				impact: 0,
				description: "No historical data available",
			});
		}

		// Calculate weighted overall score
		const overallScore = this.calculateWeightedScore(componentScores);

		// Check if all components are present (if required)
		const allComponentsPresent =
			context.redTeamReport !== undefined &&
			context.defenseReport !== undefined &&
			context.historicalData !== undefined;

		// Determine decision
		const decision = this.determineDecision(
			overallScore,
			allComponentsPresent,
			factors
		);

		// Calculate confidence
		const confidence = this.calculateConfidence(
			componentScores,
			allComponentsPresent
		);

		// Generate recommendations
		const recommendations = this.generateRecommendations(
			decision,
			factors,
			componentScores
		);

		const result: SafetyScoreResult = {
			overallScore,
			componentScores,
			decision,
			confidence,
			factors,
			recommendations,
			timestamp: Date.now(),
		};

		// Record in history
		this.scoringHistory.push({
			improvementId: improvement.improvementId,
			score: overallScore,
			decision,
			timestamp: Date.now(),
		});

		return result;
	}

	/**
	 * Quick check if improvement can be auto-deployed.
	 */
	canAutoDeploy(improvement: Improvement, context: ScoringContext): boolean {
		const result = this.score(improvement, context);
		return result.decision === "auto_deploy";
	}

	/**
	 * Get required actions before deployment.
	 */
	getRequiredActions(
		improvement: Improvement,
		context: ScoringContext
	): string[] {
		const result = this.score(improvement, context);
		const actions: string[] = [];

		if (result.decision === "reject") {
			actions.push("Cannot deploy: too many safety concerns");
			actions.push(...result.recommendations);
			return actions;
		}

		if (result.decision === "human_review") {
			actions.push("Requires human review before deployment");
		}

		// Add specific actions based on missing components
		if (!context.redTeamReport) {
			actions.push("Run red team testing");
		}
		if (!context.defenseReport) {
			actions.push("Run blue team validation");
		}
		if (!context.historicalData) {
			actions.push("Consider A/B testing before full deployment");
		}

		return actions;
	}

	/**
	 * Get scoring statistics.
	 */
	getStatistics(): {
		totalScored: number;
		autoDeployed: number;
		humanReview: number;
		rejected: number;
		avgScore: number;
	} {
		const byDecision = {
			auto_deploy: 0,
			human_review: 0,
			reject: 0,
		};

		let totalScore = 0;

		for (const record of this.scoringHistory) {
			byDecision[record.decision]++;
			totalScore += record.score;
		}

		return {
			totalScored: this.scoringHistory.length,
			autoDeployed: byDecision.auto_deploy,
			humanReview: byDecision.human_review,
			rejected: byDecision.reject,
			avgScore:
				this.scoringHistory.length > 0
					? totalScore / this.scoringHistory.length
					: 0,
		};
	}

	/**
	 * Get scoring history.
	 */
	getHistory(limit: number = 20): typeof this.scoringHistory {
		return this.scoringHistory.slice(-limit);
	}

	// ========================================================================
	// Private Methods
	// ========================================================================

	/**
	 * Calculate weighted overall score.
	 */
	private calculateWeightedScore(scores: {
		redTeam: number;
		blueTeam: number;
		pattern: number;
		history: number;
	}): number {
		return (
			scores.redTeam * this.config.redTeamWeight +
			scores.blueTeam * this.config.blueTeamWeight +
			scores.pattern * this.config.patternWeight +
			scores.history * this.config.historyWeight
		);
	}

	/**
	 * Determine deployment decision.
	 */
	private determineDecision(
		score: number,
		allComponentsPresent: boolean,
		factors: SafetyFactor[]
	): DeploymentDecision {
		// Check for critical negative factors
		const hasCriticalNegative = factors.some(
			(f) => f.type === "negative" && f.impact < -0.3
		);

		if (hasCriticalNegative) {
			return score >= this.config.humanReviewThreshold
				? "human_review"
				: "reject";
		}

		// Require all components for auto-deploy if configured
		if (this.config.requireAllComponents && !allComponentsPresent) {
			return score >= this.config.humanReviewThreshold
				? "human_review"
				: "reject";
		}

		// Standard thresholds
		if (score >= this.config.autoDeployThreshold) {
			return "auto_deploy";
		}
		if (score >= this.config.humanReviewThreshold) {
			return "human_review";
		}
		return "reject";
	}

	/**
	 * Calculate confidence in decision.
	 */
	private calculateConfidence(
		scores: { redTeam: number; blueTeam: number; pattern: number; history: number },
		allComponentsPresent: boolean
	): number {
		// Base confidence from score consistency
		const values = Object.values(scores);
		const mean = values.reduce((a, b) => a + b, 0) / values.length;
		const variance =
			values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
		const stdDev = Math.sqrt(variance);

		// Lower variance = higher confidence
		const consistencyConfidence = 1 - stdDev;

		// Component presence affects confidence
		const presenceConfidence = allComponentsPresent ? 1 : 0.7;

		// Combine
		return consistencyConfidence * 0.6 + presenceConfidence * 0.4;
	}

	/**
	 * Score pattern confidence.
	 */
	private scorePatternConfidence(improvement: Improvement): number {
		// Use improvement's own safety and impact scores
		const safetyScore = improvement.safetyScore ?? 0.5;
		const impactScore = improvement.impactScore ?? 0.5;
		const evidenceConfidence =
			improvement.improvementData.evidence.confidence ?? 0.5;

		// Weighted combination
		return safetyScore * 0.5 + evidenceConfidence * 0.3 + impactScore * 0.2;
	}

	/**
	 * Score historical data.
	 */
	private scoreHistoricalData(data: HistoricalData): number {
		// More similar deployments = more data
		const dataScore = Math.min(1, data.similarDeployments / 10);

		// Higher success rate = better
		const successScore = data.successRate;

		// Lower rollback rate = better
		const rollbackScore = 1 - data.rollbackRate;

		// Combine
		return dataScore * 0.2 + successScore * 0.5 + rollbackScore * 0.3;
	}

	/**
	 * Analyze red team factors.
	 */
	private analyzeRedTeamFactors(report: RedTeamReport): SafetyFactor[] {
		const factors: SafetyFactor[] = [];

		// Critical vulnerabilities
		if (report.criticalVulnerabilities.length > 0) {
			factors.push({
				name: "Critical Vulnerabilities",
				type: "negative",
				impact: -0.5,
				description: `${report.criticalVulnerabilities.length} critical vulnerabilities found`,
			});
		}

		// Overall vulnerability score
		if (report.vulnerabilityScore < 0.2) {
			factors.push({
				name: "Low Vulnerability",
				type: "positive",
				impact: 0.2,
				description: "Very low vulnerability score",
			});
		} else if (report.vulnerabilityScore > 0.5) {
			factors.push({
				name: "High Vulnerability",
				type: "negative",
				impact: -0.3,
				description: "High vulnerability score",
			});
		}

		// Attack resistance
		if (report.resistant > report.vulnerabilitiesFound * 2) {
			factors.push({
				name: "Attack Resistant",
				type: "positive",
				impact: 0.1,
				description: "Resistant to most attacks",
			});
		}

		return factors;
	}

	/**
	 * Analyze blue team factors.
	 */
	private analyzeBlueTeamFactors(report: DefenseReport): SafetyFactor[] {
		const factors: SafetyFactor[] = [];

		// Defense pass/fail
		if (report.passed) {
			factors.push({
				name: "Passed Defense",
				type: "positive",
				impact: 0.2,
				description: "Passed blue team validation",
			});
		} else {
			factors.push({
				name: "Failed Defense",
				type: "negative",
				impact: -0.2,
				description: report.reason,
			});
		}

		// Mitigations applied
		const successfulMitigations = report.mitigationsApplied.filter(
			(m) => m.success
		).length;
		if (successfulMitigations > 0) {
			factors.push({
				name: "Mitigations Applied",
				type: "positive",
				impact: 0.1 * Math.min(successfulMitigations, 3),
				description: `${successfulMitigations} mitigations applied`,
			});
		}

		// Remaining vulnerabilities
		if (report.remainingVulnerabilities > 0) {
			factors.push({
				name: "Remaining Vulnerabilities",
				type: "negative",
				impact: -0.1 * report.remainingVulnerabilities,
				description: `${report.remainingVulnerabilities} vulnerabilities remain`,
			});
		}

		return factors;
	}

	/**
	 * Analyze pattern factors.
	 */
	private analyzePatternFactors(improvement: Improvement): SafetyFactor[] {
		const factors: SafetyFactor[] = [];
		const evidence = improvement.improvementData.evidence;

		// Occurrence count
		if (evidence.occurrences >= 20) {
			factors.push({
				name: "High Occurrence",
				type: "positive",
				impact: 0.1,
				description: `Based on ${evidence.occurrences} observations`,
			});
		} else if (evidence.occurrences < 5) {
			factors.push({
				name: "Low Occurrence",
				type: "negative",
				impact: -0.1,
				description: `Only ${evidence.occurrences} observations`,
			});
		}

		// Confidence
		if (evidence.confidence >= 0.9) {
			factors.push({
				name: "High Confidence Pattern",
				type: "positive",
				impact: 0.1,
				description: "Very high pattern confidence",
			});
		} else if (evidence.confidence < 0.5) {
			factors.push({
				name: "Low Confidence Pattern",
				type: "negative",
				impact: -0.1,
				description: "Low pattern confidence",
			});
		}

		return factors;
	}

	/**
	 * Analyze historical factors.
	 */
	private analyzeHistoricalFactors(data: HistoricalData): SafetyFactor[] {
		const factors: SafetyFactor[] = [];

		// Success rate
		if (data.successRate >= 0.9) {
			factors.push({
				name: "High Historical Success",
				type: "positive",
				impact: 0.15,
				description: `${(data.successRate * 100).toFixed(0)}% success rate historically`,
			});
		} else if (data.successRate < 0.7) {
			factors.push({
				name: "Low Historical Success",
				type: "negative",
				impact: -0.15,
				description: `Only ${(data.successRate * 100).toFixed(0)}% success rate`,
			});
		}

		// Rollback rate
		if (data.rollbackRate > 0.2) {
			factors.push({
				name: "High Rollback Rate",
				type: "negative",
				impact: -0.2,
				description: `${(data.rollbackRate * 100).toFixed(0)}% rollback rate`,
			});
		}

		// Sample size
		if (data.similarDeployments < 3) {
			factors.push({
				name: "Limited Historical Data",
				type: "neutral",
				impact: 0,
				description: `Only ${data.similarDeployments} similar deployments`,
			});
		}

		return factors;
	}

	/**
	 * Generate recommendations.
	 */
	private generateRecommendations(
		decision: DeploymentDecision,
		factors: SafetyFactor[],
		scores: { redTeam: number; blueTeam: number; pattern: number; history: number }
	): string[] {
		const recommendations: string[] = [];

		// Based on decision
		if (decision === "reject") {
			recommendations.push("Address critical safety concerns before deployment");
		}

		// Based on low component scores
		if (scores.redTeam < 0.6) {
			recommendations.push("Improve resistance to adversarial attacks");
		}
		if (scores.blueTeam < 0.6) {
			recommendations.push("Add more safety mitigations");
		}
		if (scores.pattern < 0.6) {
			recommendations.push(
				"Wait for more observations before deploying"
			);
		}
		if (scores.history < 0.6) {
			recommendations.push("Consider extended A/B testing first");
		}

		// Based on negative factors
		const negativeFactors = factors.filter((f) => f.type === "negative");
		for (const factor of negativeFactors.slice(0, 3)) {
			recommendations.push(`Address: ${factor.name}`);
		}

		return [...new Set(recommendations)];
	}
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a safety scorer with optional configuration.
 */
export function createSafetyScorer(
	config: Partial<SafetyScorerConfig> = {}
): SafetyScorer {
	return new SafetyScorer(config);
}
