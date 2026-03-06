/**
 * Statistical Analysis
 *
 * Provides statistical tests and analysis for benchmark results.
 * Includes significance testing, correlation analysis, and ranking stability.
 */

import type { AggregatedScore, PairwiseResult } from "../types.js";
import type { ModelAggregation } from "./aggregator.js";

// ============================================================================
// Types
// ============================================================================

export interface StatisticalSummary {
	metric: string;
	mean: number;
	median: number;
	stdDev: number;
	variance: number;
	skewness: number;
	kurtosis: number;
	min: number;
	max: number;
	range: number;
	iqr: number;
	q1: number;
	q3: number;
}

export interface CorrelationMatrix {
	metrics: string[];
	values: number[][];
}

export interface SignificanceTest {
	modelA: string;
	modelB: string;
	metric: string;
	difference: number;
	pValue: number;
	significant: boolean;
	effectSize: number;
}

export interface RankingStability {
	modelId: string;
	ranks: number[];
	meanRank: number;
	rankVariance: number;
	isStable: boolean;
}

export interface InterRaterAgreement {
	judgeModels: string[];
	kappa: number;
	agreement: number;
	interpretation: string;
}

// ============================================================================
// Statistical Functions
// ============================================================================

/**
 * Calculate comprehensive statistics for a metric
 */
export function calculateStatistics(values: number[]): StatisticalSummary {
	if (values.length === 0) {
		return {
			metric: "",
			mean: 0,
			median: 0,
			stdDev: 0,
			variance: 0,
			skewness: 0,
			kurtosis: 0,
			min: 0,
			max: 0,
			range: 0,
			iqr: 0,
			q1: 0,
			q3: 0,
		};
	}

	const sorted = [...values].sort((a, b) => a - b);
	const n = values.length;

	// Basic stats
	const mean = values.reduce((a, b) => a + b, 0) / n;
	const median =
		n % 2 === 0
			? (sorted[n / 2 - 1] + sorted[n / 2]) / 2
			: sorted[Math.floor(n / 2)];

	// Variance and standard deviation
	const squaredDiffs = values.map((v) => Math.pow(v - mean, 2));
	const variance = squaredDiffs.reduce((a, b) => a + b, 0) / n;
	const stdDev = Math.sqrt(variance);

	// Quartiles
	const q1 = percentile(sorted, 0.25);
	const q3 = percentile(sorted, 0.75);
	const iqr = q3 - q1;

	// Skewness (Fisher's)
	let skewness = 0;
	if (stdDev > 0) {
		const cubedDiffs = values.map((v) => Math.pow((v - mean) / stdDev, 3));
		skewness = cubedDiffs.reduce((a, b) => a + b, 0) / n;
	}

	// Kurtosis (excess kurtosis)
	let kurtosis = 0;
	if (stdDev > 0) {
		const fourthDiffs = values.map((v) => Math.pow((v - mean) / stdDev, 4));
		kurtosis = fourthDiffs.reduce((a, b) => a + b, 0) / n - 3;
	}

	return {
		metric: "",
		mean,
		median,
		stdDev,
		variance,
		skewness,
		kurtosis,
		min: sorted[0],
		max: sorted[n - 1],
		range: sorted[n - 1] - sorted[0],
		iqr,
		q1,
		q3,
	};
}

/**
 * Calculate percentile value
 */
function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	if (sorted.length === 1) return sorted[0];

	const index = p * (sorted.length - 1);
	const lower = Math.floor(index);
	const upper = Math.ceil(index);
	const weight = index - lower;

	return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

/**
 * Calculate Pearson correlation between two arrays
 */
export function pearsonCorrelation(x: number[], y: number[]): number {
	if (x.length !== y.length || x.length === 0) return 0;

	const n = x.length;
	const meanX = x.reduce((a, b) => a + b, 0) / n;
	const meanY = y.reduce((a, b) => a + b, 0) / n;

	let numerator = 0;
	let sumSqX = 0;
	let sumSqY = 0;

	for (let i = 0; i < n; i++) {
		const dx = x[i] - meanX;
		const dy = y[i] - meanY;
		numerator += dx * dy;
		sumSqX += dx * dx;
		sumSqY += dy * dy;
	}

	const denominator = Math.sqrt(sumSqX * sumSqY);
	return denominator === 0 ? 0 : numerator / denominator;
}

/**
 * Calculate Spearman rank correlation
 */
export function spearmanCorrelation(x: number[], y: number[]): number {
	if (x.length !== y.length || x.length === 0) return 0;

	// Convert to ranks
	const rankX = toRanks(x);
	const rankY = toRanks(y);

	return pearsonCorrelation(rankX, rankY);
}

/**
 * Convert values to ranks
 */
function toRanks(values: number[]): number[] {
	const indexed = values.map((v, i) => ({ value: v, index: i }));
	indexed.sort((a, b) => a.value - b.value);

	const ranks = new Array(values.length);
	for (let i = 0; i < indexed.length; i++) {
		ranks[indexed[i].index] = i + 1;
	}

	return ranks;
}

/**
 * Calculate correlation matrix between multiple metrics
 */
export function calculateCorrelationMatrix(
	aggregations: Map<string, ModelAggregation>,
): CorrelationMatrix {
	const metrics = ["judge", "contrastive", "retrieval", "downstream"];
	const modelIds = [...aggregations.keys()];

	// Extract metric values for each model
	const judgeScores = modelIds.map(
		(id) => aggregations.get(id)!.judge.pointwise.overall.mean / 5,
	);
	const contrastiveScores = modelIds.map(
		(id) => aggregations.get(id)!.contrastive.combined,
	);
	const retrievalScores = modelIds.map((id) => {
		const ret = aggregations.get(id)!.retrieval;
		return ret.winRate > 0 ? ret.winRate : ret.mrr;
	});
	const downstreamScores = modelIds.map(
		(id) => aggregations.get(id)!.downstream.overall,
	);

	const allScores = [
		judgeScores,
		contrastiveScores,
		retrievalScores,
		downstreamScores,
	];

	// Calculate pairwise correlations
	const values: number[][] = [];
	for (let i = 0; i < metrics.length; i++) {
		const row: number[] = [];
		for (let j = 0; j < metrics.length; j++) {
			if (i === j) {
				row.push(1);
			} else {
				row.push(pearsonCorrelation(allScores[i], allScores[j]));
			}
		}
		values.push(row);
	}

	return { metrics, values };
}

/**
 * Perform paired t-test (simplified)
 */
export function pairedTTest(
	group1: number[],
	group2: number[],
): { tStatistic: number; pValue: number } {
	if (group1.length !== group2.length || group1.length === 0) {
		return { tStatistic: 0, pValue: 1 };
	}

	const n = group1.length;
	const differences = group1.map((v, i) => v - group2[i]);
	const meanDiff = differences.reduce((a, b) => a + b, 0) / n;

	if (n === 1) {
		return { tStatistic: 0, pValue: 1 };
	}

	const squaredDiffs = differences.map((d) => Math.pow(d - meanDiff, 2));
	const variance = squaredDiffs.reduce((a, b) => a + b, 0) / (n - 1);
	const stdError = Math.sqrt(variance / n);

	if (stdError === 0) {
		return { tStatistic: 0, pValue: 1 };
	}

	const tStatistic = meanDiff / stdError;

	// Approximate p-value using normal distribution (for large n)
	// For small n, this is an approximation
	const pValue = 2 * (1 - normalCDF(Math.abs(tStatistic)));

	return { tStatistic, pValue };
}

/**
 * Standard normal CDF approximation
 */
function normalCDF(x: number): number {
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
		1.0 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

	return 0.5 * (1.0 + sign * y);
}

/**
 * Paired Wilcoxon signed-rank test.
 * Non-parametric alternative to paired t-test. Suitable for small n and
 * non-normal distributions (MRR scores are bounded [0,1] and right-skewed).
 *
 * Uses normal approximation (valid for n >= 6 with continuity correction).
 *
 * @param group1 - Per-query scores for model A (e.g., reciprocalRank values)
 * @param group2 - Per-query scores for model B (same queries, same order)
 * @returns { wStatistic, pValue, effectSize }
 */
export function wilcoxonSignedRankTest(
	group1: number[],
	group2: number[],
): { wStatistic: number; pValue: number; effectSize: number } {
	if (group1.length !== group2.length || group1.length === 0) {
		return { wStatistic: 0, pValue: 1, effectSize: 0 };
	}

	const differences = group1.map((v, i) => v - group2[i]);

	// Remove zero differences
	const nonZero = differences.filter((d) => d !== 0);
	const n = nonZero.length;

	if (n === 0) {
		return { wStatistic: 0, pValue: 1, effectSize: 0 };
	}

	// Rank absolute differences
	const absWithSign = nonZero.map((d) => ({ abs: Math.abs(d), sign: Math.sign(d) }));
	absWithSign.sort((a, b) => a.abs - b.abs);

	// Assign ranks (handle ties with average rank)
	const ranks = new Array(n);
	let i = 0;
	while (i < n) {
		let j = i;
		while (j < n - 1 && absWithSign[j + 1].abs === absWithSign[j].abs) j++;
		const avgRank = (i + j) / 2 + 1; // 1-indexed average rank
		for (let k = i; k <= j; k++) ranks[k] = avgRank;
		i = j + 1;
	}

	// W+ (sum of ranks for positive differences)
	let wPlus = 0;
	for (let k = 0; k < n; k++) {
		if (absWithSign[k].sign > 0) wPlus += ranks[k];
	}

	const wStatistic = wPlus;

	// Normal approximation (valid for n >= 10; acceptable for n >= 6 with continuity correction)
	const meanW = (n * (n + 1)) / 4;
	const varW = (n * (n + 1) * (2 * n + 1)) / 24;
	const stdW = Math.sqrt(varW);

	// Apply continuity correction
	const z = stdW > 0 ? (Math.abs(wStatistic - meanW) - 0.5) / stdW : 0;
	const pValue = 2 * (1 - normalCDF(z)); // Two-tailed

	// Effect size: r = Z / sqrt(N)
	const effectSize = n > 0 ? z / Math.sqrt(n) : 0;

	return { wStatistic, pValue, effectSize };
}

/**
 * Calculate Cohen's Kappa for inter-rater agreement
 */
export function calculateKappa(
	ratings1: string[],
	ratings2: string[],
	categories: string[],
): number {
	if (ratings1.length !== ratings2.length || ratings1.length === 0) return 0;

	const n = ratings1.length;

	// Calculate observed agreement
	let observedAgreement = 0;
	for (let i = 0; i < n; i++) {
		if (ratings1[i] === ratings2[i]) observedAgreement++;
	}
	const po = observedAgreement / n;

	// Calculate expected agreement
	let pe = 0;
	for (const category of categories) {
		const count1 = ratings1.filter((r) => r === category).length;
		const count2 = ratings2.filter((r) => r === category).length;
		pe += (count1 / n) * (count2 / n);
	}

	// Kappa
	if (pe === 1) return 1;
	return (po - pe) / (1 - pe);
}

/**
 * Analyze inter-rater agreement between judges
 */
export function analyzeInterRaterAgreement(
	pairwiseResults: PairwiseResult[],
): InterRaterAgreement {
	// Group results by code unit and model pair
	const resultsByPair = new Map<string, Map<string, string>>();

	for (const result of pairwiseResults) {
		const pairKey = `${result.modelA}:${result.modelB}:${result.codeUnitId}`;
		if (!resultsByPair.has(pairKey)) {
			resultsByPair.set(pairKey, new Map());
		}
		resultsByPair.get(pairKey)!.set(result.judgeModel, result.winner);
	}

	// Find pairs judged by multiple judges
	const judgeModels = [...new Set(pairwiseResults.map((r) => r.judgeModel))];

	if (judgeModels.length < 2) {
		return {
			judgeModels,
			kappa: 1,
			agreement: 1,
			interpretation: "Only one judge - perfect agreement by definition",
		};
	}

	// Calculate pairwise agreement between first two judges
	const judge1 = judgeModels[0];
	const judge2 = judgeModels[1];

	const ratings1: string[] = [];
	const ratings2: string[] = [];

	for (const [_, judgeRatings] of resultsByPair) {
		if (judgeRatings.has(judge1) && judgeRatings.has(judge2)) {
			ratings1.push(judgeRatings.get(judge1)!);
			ratings2.push(judgeRatings.get(judge2)!);
		}
	}

	const kappa = calculateKappa(ratings1, ratings2, ["A", "B", "tie"]);
	const agreement =
		ratings1.filter((r, i) => r === ratings2[i]).length / ratings1.length;

	let interpretation: string;
	if (kappa > 0.8) interpretation = "Almost perfect agreement";
	else if (kappa > 0.6) interpretation = "Substantial agreement";
	else if (kappa > 0.4) interpretation = "Moderate agreement";
	else if (kappa > 0.2) interpretation = "Fair agreement";
	else interpretation = "Slight agreement";

	return { judgeModels, kappa, agreement, interpretation };
}

/**
 * Analyze ranking stability across different evaluation methods
 */
export function analyzeRankingStability(
	aggregations: Map<string, ModelAggregation>,
): RankingStability[] {
	const results: RankingStability[] = [];

	for (const [modelId, agg] of aggregations) {
		// Get ranks for each evaluation method
		const ranks: number[] = [];

		// We need to calculate ranks per method
		// For now, use the variation in scores as a proxy
		const retrievalScore =
			agg.retrieval.winRate > 0 ? agg.retrieval.winRate : agg.retrieval.mrr;
		const scores = [
			agg.judge.pointwise.overall.mean / 5,
			agg.contrastive.combined,
			retrievalScore,
			agg.downstream.overall,
		];

		// Calculate score variance
		const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
		const variance =
			scores.map((s) => Math.pow(s - mean, 2)).reduce((a, b) => a + b, 0) /
			scores.length;

		results.push({
			modelId,
			ranks: [], // Would need per-method rankings
			meanRank: agg.overall.rank,
			rankVariance: variance,
			isStable: variance < 0.1, // Threshold for stability
		});
	}

	return results;
}
