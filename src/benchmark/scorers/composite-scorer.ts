/**
 * Composite Scorer
 *
 * Combines multiple scorers into a single weighted score.
 * Allows customizing weights for different evaluation priorities.
 */

import type { FileSummary, SymbolSummary } from "../../types.js";
import type {
	GenerationResult,
	IScorer,
	JudgmentResult,
	ScoreResult,
	ScoringCriterion,
	TestCase,
} from "../types.js";

// ============================================================================
// Composite Scorer Implementation
// ============================================================================

export class CompositeScorer implements IScorer {
	private scorers: IScorer[];
	private weights: Record<string, number>;

	/**
	 * Create a composite scorer from multiple scorers.
	 *
	 * @param scorers - Individual scorers to combine
	 * @param weights - Optional weight overrides (keys match criterion names)
	 */
	constructor(scorers: IScorer[], weights?: Record<string, number>) {
		this.scorers = scorers;
		this.weights = weights || this.extractDefaultWeights();
	}

	async score(
		testCase: TestCase,
		generation: GenerationResult<FileSummary | SymbolSummary>,
		judgment?: JudgmentResult,
	): Promise<ScoreResult> {
		// Run all scorers
		const results = await Promise.all(
			this.scorers.map((scorer) =>
				scorer.score(testCase, generation, judgment),
			),
		);

		// Calculate weighted sum
		let totalWeightedScore = 0;
		let totalWeight = 0;

		for (const result of results) {
			const weight = this.weights[result.criterion] ?? result.weight;
			totalWeightedScore += result.score * weight;
			totalWeight += weight;
		}

		// Normalize if weights don't sum to 1
		const score =
			totalWeight > 0 ? Math.round(totalWeightedScore / totalWeight) : 50;

		const criterion = this.getCriterion();

		return {
			criterion: criterion.name,
			score,
			weight: 1.0, // Composite is the final score
			weightedScore: score,
			details: {
				componentScores: results.reduce(
					(acc, r) => {
						acc[r.criterion] = {
							score: r.score,
							weight: this.weights[r.criterion] ?? r.weight,
							weightedScore: r.score * (this.weights[r.criterion] ?? r.weight),
						};
						return acc;
					},
					{} as Record<
						string,
						{ score: number; weight: number; weightedScore: number }
					>,
				),
				totalWeight,
			},
		};
	}

	getCriterion(): ScoringCriterion {
		return {
			name: "overall",
			weight: 1.0,
			description: "Weighted composite of all scoring criteria",
		};
	}

	/**
	 * Score a test case and return all component results.
	 * More detailed than score() for reporting purposes.
	 */
	async scoreDetailed(
		testCase: TestCase,
		generation: GenerationResult<FileSummary | SymbolSummary>,
		judgment?: JudgmentResult,
	): Promise<{
		overall: number;
		components: ScoreResult[];
	}> {
		// Run all scorers
		const components = await Promise.all(
			this.scorers.map((scorer) =>
				scorer.score(testCase, generation, judgment),
			),
		);

		// Calculate weighted sum
		let totalWeightedScore = 0;
		let totalWeight = 0;

		for (const result of components) {
			const weight = this.weights[result.criterion] ?? result.weight;
			totalWeightedScore += result.score * weight;
			totalWeight += weight;
		}

		const overall =
			totalWeight > 0 ? Math.round(totalWeightedScore / totalWeight) : 50;

		return { overall, components };
	}

	/**
	 * Get the scorers in this composite.
	 */
	getScorers(): IScorer[] {
		return [...this.scorers];
	}

	/**
	 * Get the weight for a specific criterion.
	 */
	getWeight(criterion: string): number {
		return this.weights[criterion] ?? 0;
	}

	/**
	 * Get all weights.
	 */
	getWeights(): Record<string, number> {
		return { ...this.weights };
	}

	/**
	 * Extract default weights from scorers.
	 */
	private extractDefaultWeights(): Record<string, number> {
		const weights: Record<string, number> = {};
		for (const scorer of this.scorers) {
			const criterion = scorer.getCriterion();
			weights[criterion.name] = criterion.weight;
		}
		return weights;
	}
}

// ============================================================================
// Factory Function
// ============================================================================

import { CorrectnessScorer } from "./correctness-scorer.js";
import { CompletenessScorer } from "./completeness-scorer.js";
import { UsefulnessScorer, ConcisenessScorer } from "./quality-scorer.js";
import {
	PerformanceScorer,
	createPerformanceScorer,
} from "./performance-scorer.js";
import { CostScorer, createCostScorer } from "./cost-scorer.js";

/**
 * Create a default composite scorer with all criteria.
 * Requires duration and cost data for normalization.
 *
 * @param durations - All generation durations for normalization
 * @param costs - All generation costs for normalization
 * @param weights - Optional weight overrides
 */
export function createCompositeScorer(
	durations: number[],
	costs: number[],
	weights?: Record<string, number>,
): CompositeScorer {
	const scorers: IScorer[] = [
		new CorrectnessScorer(),
		new CompletenessScorer(),
		new UsefulnessScorer(),
		new ConcisenessScorer(),
		createPerformanceScorer(durations),
		createCostScorer(costs),
	];

	return new CompositeScorer(scorers, weights);
}

/**
 * Create a composite scorer without performance/cost normalization.
 * Useful for evaluating a single model.
 */
export function createBasicCompositeScorer(
	weights?: Record<string, number>,
): CompositeScorer {
	const scorers: IScorer[] = [
		new CorrectnessScorer(),
		new CompletenessScorer(),
		new UsefulnessScorer(),
		new ConcisenessScorer(),
	];

	return new CompositeScorer(scorers, weights);
}
