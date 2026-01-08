/**
 * Quality Scorer
 *
 * Uses LLM judge results to score subjective quality aspects.
 * Extracts usefulness and conciseness from judgment.
 *
 * Weight: 20% usefulness + 10% conciseness = 30% total
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
// Usefulness Scorer
// ============================================================================

/**
 * Scores how useful the summary is for understanding the code.
 * Based on LLM judge evaluation.
 */
export class UsefulnessScorer implements IScorer {
	async score(
		_testCase: TestCase,
		_generation: GenerationResult<FileSummary | SymbolSummary>,
		judgment?: JudgmentResult,
	): Promise<ScoreResult> {
		// If no judgment available, return 0 (not fake 50%)
		const hasJudgment =
			judgment !== undefined && judgment.judgedBy !== "no judge";
		const score = hasJudgment ? judgment.usefulness : 0;

		const criterion = this.getCriterion();

		return {
			criterion: criterion.name,
			score,
			weight: criterion.weight,
			weightedScore: score * criterion.weight,
			details: {
				judgedBy: judgment?.judgedBy || "no judge",
				feedback: judgment?.feedback,
				hasValidJudgment: hasJudgment,
			},
		};
	}

	getCriterion(): ScoringCriterion {
		return {
			name: "usefulness",
			weight: 0.2,
			description: "Does the summary help a developer understand the code?",
		};
	}
}

// ============================================================================
// Conciseness Scorer
// ============================================================================

/**
 * Scores how concise and information-dense the summary is.
 * Based on LLM judge evaluation.
 */
export class ConcisenessScorer implements IScorer {
	async score(
		_testCase: TestCase,
		_generation: GenerationResult<FileSummary | SymbolSummary>,
		judgment?: JudgmentResult,
	): Promise<ScoreResult> {
		// If no judgment available, return 0 (not fake 50%)
		const hasJudgment =
			judgment !== undefined && judgment.judgedBy !== "no judge";
		const score = hasJudgment ? judgment.conciseness : 0;

		const criterion = this.getCriterion();

		return {
			criterion: criterion.name,
			score,
			weight: criterion.weight,
			weightedScore: score * criterion.weight,
			details: {
				judgedBy: judgment?.judgedBy || "no judge",
				clarity: judgment?.clarity,
				hasValidJudgment: hasJudgment,
			},
		};
	}

	getCriterion(): ScoringCriterion {
		return {
			name: "conciseness",
			weight: 0.1,
			description:
				"Is the summary information-dense without unnecessary verbosity?",
		};
	}
}

// ============================================================================
// Combined Quality Scorer
// ============================================================================

/**
 * Combines usefulness and conciseness into a single quality score.
 * Useful when you want to treat all judge-based scores as one criterion.
 */
export class QualityScorer implements IScorer {
	async score(
		_testCase: TestCase,
		_generation: GenerationResult<FileSummary | SymbolSummary>,
		judgment?: JudgmentResult,
	): Promise<ScoreResult> {
		// If no judgment available, return 0 (not fake 50%)
		const hasJudgment =
			judgment !== undefined && judgment.judgedBy !== "no judge";

		const usefulness = hasJudgment ? judgment.usefulness : 0;
		const conciseness = hasJudgment ? judgment.conciseness : 0;
		const clarity = hasJudgment ? judgment.clarity : 0;

		// Weighted combination: usefulness is most important
		const score = hasJudgment
			? Math.round(usefulness * 0.5 + conciseness * 0.25 + clarity * 0.25)
			: 0;

		const criterion = this.getCriterion();

		return {
			criterion: criterion.name,
			score,
			weight: criterion.weight,
			weightedScore: score * criterion.weight,
			details: {
				usefulness,
				conciseness,
				clarity,
				judgedBy: judgment?.judgedBy || "no judge",
				feedback: judgment?.feedback,
				hasValidJudgment: hasJudgment,
			},
		};
	}

	getCriterion(): ScoringCriterion {
		return {
			name: "quality",
			weight: 0.3, // Combined weight of usefulness (20%) + conciseness (10%)
			description:
				"Overall subjective quality from LLM judge (usefulness, conciseness, clarity)",
		};
	}
}
