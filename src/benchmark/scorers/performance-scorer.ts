/**
 * Performance Scorer
 *
 * Scores based on generation speed.
 * Fastest model gets 100, others scaled proportionally.
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
// Performance Scorer Implementation
// ============================================================================

export class PerformanceScorer implements IScorer {
	private fastestDurationMs: number;
	private slowestDurationMs: number;

	/**
	 * Create a performance scorer with known duration bounds.
	 *
	 * @param fastestDurationMs - Fastest generation time in the benchmark
	 * @param slowestDurationMs - Slowest generation time in the benchmark
	 */
	constructor(fastestDurationMs: number, slowestDurationMs: number) {
		this.fastestDurationMs = fastestDurationMs;
		this.slowestDurationMs = slowestDurationMs;
	}

	async score(
		_testCase: TestCase,
		generation: GenerationResult<FileSummary | SymbolSummary>,
		_judgment?: JudgmentResult,
	): Promise<ScoreResult> {
		const durationMs = generation.durationMs;

		// Normalize to 0-100 scale
		// Fastest = 100, slowest = 0
		let score: number;

		if (this.fastestDurationMs === this.slowestDurationMs) {
			// All same speed
			score = 100;
		} else {
			// Linear interpolation
			const range = this.slowestDurationMs - this.fastestDurationMs;
			const position = durationMs - this.fastestDurationMs;
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
				durationMs,
				fastestMs: this.fastestDurationMs,
				slowestMs: this.slowestDurationMs,
				normalizedPosition: score / 100,
			},
		};
	}

	getCriterion(): ScoringCriterion {
		return {
			name: "speed",
			weight: 0.1,
			description: "How fast is the generation? (fastest = 100)",
		};
	}
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a performance scorer from a list of durations.
 * Automatically determines fastest and slowest.
 */
export function createPerformanceScorer(
	durations: number[],
): PerformanceScorer {
	if (durations.length === 0) {
		return new PerformanceScorer(1000, 1000);
	}

	const fastest = Math.min(...durations);
	const slowest = Math.max(...durations);

	return new PerformanceScorer(fastest, slowest);
}
