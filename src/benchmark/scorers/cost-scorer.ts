/**
 * Cost Scorer
 *
 * Scores based on generation cost.
 * Cheapest model gets 100, others scaled proportionally.
 * Free models (local) get 100.
 *
 * Weight: 10% of total score
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
// Cost Scorer Implementation
// ============================================================================

export class CostScorer implements IScorer {
	private cheapestCost: number;
	private mostExpensiveCost: number;

	/**
	 * Create a cost scorer with known cost bounds.
	 *
	 * @param cheapestCost - Lowest cost in the benchmark (excluding free)
	 * @param mostExpensiveCost - Highest cost in the benchmark
	 */
	constructor(cheapestCost: number, mostExpensiveCost: number) {
		this.cheapestCost = cheapestCost;
		this.mostExpensiveCost = mostExpensiveCost;
	}

	async score(
		_testCase: TestCase,
		generation: GenerationResult<FileSummary | SymbolSummary>,
		_judgment?: JudgmentResult,
	): Promise<ScoreResult> {
		const cost = generation.usage.cost;

		// Free models get perfect score
		if (cost === 0) {
			return {
				criterion: this.getCriterion().name,
				score: 100,
				weight: this.getCriterion().weight,
				weightedScore: 100 * this.getCriterion().weight,
				details: {
					cost: 0,
					isFree: true,
					cheapestCost: this.cheapestCost,
					mostExpensiveCost: this.mostExpensiveCost,
				},
			};
		}

		// Normalize to 0-100 scale
		// Cheapest = 100, most expensive = 0
		let score: number;

		if (this.cheapestCost === this.mostExpensiveCost) {
			// All same cost
			score = 100;
		} else if (this.cheapestCost === 0) {
			// Has free models - use ratio to most expensive
			score = Math.round(100 - (cost / this.mostExpensiveCost) * 100);
		} else {
			// Linear interpolation
			const range = this.mostExpensiveCost - this.cheapestCost;
			const position = cost - this.cheapestCost;
			score = Math.round(100 - (position / range) * 100);
		}

		// Clamp to 0-100
		score = Math.max(0, Math.min(100, score));

		const criterion = this.getCriterion();

		return {
			criterion: criterion.name,
			score,
			weight: criterion.weight,
			weightedScore: score * criterion.weight,
			details: {
				cost,
				isFree: false,
				cheapestCost: this.cheapestCost,
				mostExpensiveCost: this.mostExpensiveCost,
				normalizedPosition: score / 100,
			},
		};
	}

	getCriterion(): ScoringCriterion {
		return {
			name: "cost",
			weight: 0.1,
			description:
				"How cost-effective is the generation? (cheapest/free = 100)",
		};
	}
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a cost scorer from a list of costs.
 * Automatically determines cheapest and most expensive.
 */
export function createCostScorer(costs: number[]): CostScorer {
	if (costs.length === 0) {
		return new CostScorer(0, 0);
	}

	// Filter out zeros for cheapest (unless all are zero)
	const nonZeroCosts = costs.filter((c) => c > 0);
	const cheapest = nonZeroCosts.length > 0 ? Math.min(...nonZeroCosts) : 0;
	const mostExpensive = Math.max(...costs);

	return new CostScorer(cheapest, mostExpensive);
}
