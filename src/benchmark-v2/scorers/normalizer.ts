/**
 * Score Normalizer
 *
 * Normalizes raw scores to comparable scales.
 * Supports min-max normalization, z-score normalization, and percentile ranking.
 */

import type { AggregatedScore } from "../types.js";

// ============================================================================
// Types
// ============================================================================

export type NormalizationMethod = "min-max" | "z-score" | "percentile";

export interface NormalizationOptions {
	method: NormalizationMethod;
	targetMin?: number; // For min-max, default 0
	targetMax?: number; // For min-max, default 1
}

export interface NormalizedScores {
	modelId: string;
	judgeScore: number;
	contrastiveAccuracy: number;
	retrievalMRR: number;
	downstreamScore: number;
	overallScore: number;
	originalRank: number;
	normalizedRank: number;
}

// ============================================================================
// Score Normalizer
// ============================================================================

export class ScoreNormalizer {
	private options: NormalizationOptions;

	constructor(options: Partial<NormalizationOptions> = {}) {
		this.options = {
			method: options.method || "min-max",
			targetMin: options.targetMin ?? 0,
			targetMax: options.targetMax ?? 1,
		};
	}

	/**
	 * Normalize all scores across models
	 */
	normalize(scores: AggregatedScore[]): NormalizedScores[] {
		if (scores.length === 0) return [];

		// Extract score arrays for each metric
		const judgeScores = scores.map((s) => s.judgeScore);
		const contrastiveScores = scores.map((s) => s.contrastiveAccuracy);
		const retrievalScores = scores.map((s) => s.retrievalMRR);
		const downstreamScores = scores.map((s) => s.downstreamScore);
		const overallScores = scores.map((s) => s.overallScore);

		// Normalize each metric
		const normalizedJudge = this.normalizeArray(judgeScores);
		const normalizedContrastive = this.normalizeArray(contrastiveScores);
		const normalizedRetrieval = this.normalizeArray(retrievalScores);
		const normalizedDownstream = this.normalizeArray(downstreamScores);
		const normalizedOverall = this.normalizeArray(overallScores);

		// Build result
		const results: NormalizedScores[] = scores.map((score, i) => ({
			modelId: score.modelId,
			judgeScore: normalizedJudge[i],
			contrastiveAccuracy: normalizedContrastive[i],
			retrievalMRR: normalizedRetrieval[i],
			downstreamScore: normalizedDownstream[i],
			overallScore: normalizedOverall[i],
			originalRank: score.rank,
			normalizedRank: 0, // Calculated below
		}));

		// Calculate normalized rankings
		const sortedByNormalizedScore = [...results].sort(
			(a, b) => b.overallScore - a.overallScore,
		);
		sortedByNormalizedScore.forEach((result, index) => {
			result.normalizedRank = index + 1;
		});

		return results;
	}

	/**
	 * Normalize a single array of values
	 */
	normalizeArray(values: number[]): number[] {
		switch (this.options.method) {
			case "min-max":
				return this.minMaxNormalize(values);
			case "z-score":
				return this.zScoreNormalize(values);
			case "percentile":
				return this.percentileNormalize(values);
			default:
				return this.minMaxNormalize(values);
		}
	}

	/**
	 * Min-max normalization: scale to [targetMin, targetMax]
	 */
	private minMaxNormalize(values: number[]): number[] {
		if (values.length === 0) return [];
		if (values.length === 1) return [this.options.targetMax!];

		const min = Math.min(...values);
		const max = Math.max(...values);
		const range = max - min;

		if (range === 0) {
			// All values are the same
			return values.map(
				() => (this.options.targetMin! + this.options.targetMax!) / 2,
			);
		}

		const targetRange = this.options.targetMax! - this.options.targetMin!;

		return values.map(
			(v) => this.options.targetMin! + ((v - min) / range) * targetRange,
		);
	}

	/**
	 * Z-score normalization: (value - mean) / stdDev
	 */
	private zScoreNormalize(values: number[]): number[] {
		if (values.length === 0) return [];
		if (values.length === 1) return [0];

		const mean = values.reduce((a, b) => a + b, 0) / values.length;
		const squaredDiffs = values.map((v) => Math.pow(v - mean, 2));
		const variance = squaredDiffs.reduce((a, b) => a + b, 0) / values.length;
		const stdDev = Math.sqrt(variance);

		if (stdDev === 0) {
			return values.map(() => 0);
		}

		return values.map((v) => (v - mean) / stdDev);
	}

	/**
	 * Percentile normalization: rank-based percentile
	 */
	private percentileNormalize(values: number[]): number[] {
		if (values.length === 0) return [];
		if (values.length === 1) return [1];

		// Create sorted indices
		const indexed = values.map((v, i) => ({ value: v, index: i }));
		indexed.sort((a, b) => a.value - b.value);

		// Assign percentiles
		const result = new Array(values.length);
		indexed.forEach((item, rank) => {
			result[item.index] = (rank + 1) / values.length;
		});

		return result;
	}
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Calculate confidence interval for a score
 */
export function calculateConfidenceInterval(
	values: number[],
	confidence: number = 0.95,
): { lower: number; upper: number; margin: number } {
	if (values.length === 0) {
		return { lower: 0, upper: 0, margin: 0 };
	}

	const mean = values.reduce((a, b) => a + b, 0) / values.length;
	const squaredDiffs = values.map((v) => Math.pow(v - mean, 2));
	const variance = squaredDiffs.reduce((a, b) => a + b, 0) / values.length;
	const stdDev = Math.sqrt(variance);
	const stdError = stdDev / Math.sqrt(values.length);

	// Z-score for confidence level (approximate)
	const zScores: Record<number, number> = {
		0.9: 1.645,
		0.95: 1.96,
		0.99: 2.576,
	};
	const z = zScores[confidence] || 1.96;

	const margin = z * stdError;

	return {
		lower: mean - margin,
		upper: mean + margin,
		margin,
	};
}

/**
 * Calculate effect size (Cohen's d) between two groups
 */
export function calculateEffectSize(
	group1: number[],
	group2: number[],
): number {
	if (group1.length === 0 || group2.length === 0) return 0;

	const mean1 = group1.reduce((a, b) => a + b, 0) / group1.length;
	const mean2 = group2.reduce((a, b) => a + b, 0) / group2.length;

	const var1 =
		group1.map((v) => Math.pow(v - mean1, 2)).reduce((a, b) => a + b, 0) /
		group1.length;
	const var2 =
		group2.map((v) => Math.pow(v - mean2, 2)).reduce((a, b) => a + b, 0) /
		group2.length;

	// Pooled standard deviation
	const pooledStd = Math.sqrt((var1 + var2) / 2);

	if (pooledStd === 0) return 0;

	return (mean1 - mean2) / pooledStd;
}

// ============================================================================
// Factory Function
// ============================================================================

export function createScoreNormalizer(
	options?: Partial<NormalizationOptions>,
): ScoreNormalizer {
	return new ScoreNormalizer(options);
}
