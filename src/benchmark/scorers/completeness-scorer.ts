/**
 * Completeness Scorer
 *
 * Validates that summaries cover all important aspects.
 * Measures: Are all expected elements documented?
 *
 * Weight: 20% of total score
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
import { fuzzyMatch } from "./utils.js";

// ============================================================================
// Completeness Scorer Implementation
// ============================================================================

export class CompletenessScorer implements IScorer {
	async score(
		testCase: TestCase,
		generation: GenerationResult<FileSummary | SymbolSummary>,
		_judgment?: JudgmentResult,
	): Promise<ScoreResult> {
		const summary = generation.result;
		const groundTruth = testCase.groundTruth;

		let score: number;
		let details: Record<string, unknown>;

		if (testCase.type === "file_summary") {
			const fileSummary = summary as FileSummary;
			const result = this.scoreFileSummaryCompleteness(
				fileSummary,
				groundTruth,
			);
			score = result.score;
			details = result.details;
		} else {
			const symbolSummary = summary as SymbolSummary;
			const result = this.scoreSymbolSummaryCompleteness(
				symbolSummary,
				groundTruth,
			);
			score = result.score;
			details = result.details;
		}

		const criterion = this.getCriterion();

		return {
			criterion: criterion.name,
			score,
			weight: criterion.weight,
			weightedScore: score * criterion.weight,
			details,
		};
	}

	getCriterion(): ScoringCriterion {
		return {
			name: "completeness",
			weight: 0.2,
			description:
				"Are all important elements (params, exports, side effects) documented?",
		};
	}

	/**
	 * Score file summary completeness.
	 */
	private scoreFileSummaryCompleteness(
		summary: FileSummary,
		groundTruth: TestCase["groundTruth"],
	): { score: number; details: Record<string, unknown> } {
		const actualExports = groundTruth.exports || [];
		const actualDeps = groundTruth.dependencies || [];
		const mentionedExports = summary.exports || [];
		const mentionedDeps = summary.dependencies || [];

		// Calculate export coverage (40% weight)
		// What percentage of actual exports are mentioned?
		let exportCoverage = 100;
		if (actualExports.length > 0) {
			const coveredExports = actualExports.filter((actual) =>
				mentionedExports.some((mentioned) => fuzzyMatch(mentioned, actual)),
			);
			exportCoverage = (coveredExports.length / actualExports.length) * 100;
		}

		// Calculate dependency coverage (30% weight)
		let depCoverage = 100;
		if (actualDeps.length > 0) {
			const coveredDeps = actualDeps.filter((actual) =>
				mentionedDeps.some((mentioned) => fuzzyMatch(mentioned, actual)),
			);
			depCoverage = (coveredDeps.length / actualDeps.length) * 100;
		}

		// Check for essential fields (30% weight)
		let fieldCompleteness = 0;
		if (summary.summary && summary.summary.length > 20) fieldCompleteness += 50;
		if (summary.responsibilities && summary.responsibilities.length > 0)
			fieldCompleteness += 30;
		if (summary.patterns && summary.patterns.length > 0)
			fieldCompleteness += 20;

		const score = Math.round(
			exportCoverage * 0.4 + depCoverage * 0.3 + fieldCompleteness * 0.3,
		);

		return {
			score,
			details: {
				actualExports: actualExports.length,
				coveredExports: Math.round(exportCoverage),
				actualDependencies: actualDeps.length,
				coveredDependencies: Math.round(depCoverage),
				hasSummary: !!summary.summary && summary.summary.length > 20,
				hasResponsibilities: summary.responsibilities?.length > 0,
				hasPatterns: summary.patterns?.length > 0,
				fieldCompleteness,
			},
		};
	}

	/**
	 * Score symbol summary completeness.
	 */
	private scoreSymbolSummaryCompleteness(
		summary: SymbolSummary,
		groundTruth: TestCase["groundTruth"],
	): { score: number; details: Record<string, unknown> } {
		const actualParams = groundTruth.parameters || [];
		const mentionedParams = summary.parameters || [];
		const hasSideEffects =
			groundTruth.sideEffects && groundTruth.sideEffects.length > 0;

		// Calculate parameter coverage (50% weight)
		let paramCoverage = 100;
		if (actualParams.length > 0) {
			const coveredParams = actualParams.filter((actual) =>
				mentionedParams.some((mentioned) => mentioned.name === actual.name),
			);
			paramCoverage = (coveredParams.length / actualParams.length) * 100;
		}

		// Check for essential fields (50% weight)
		let fieldCompleteness = 0;

		// Summary is required (30%)
		if (summary.summary && summary.summary.length > 10) {
			fieldCompleteness += 30;
		}

		// Return description if function has return type (20%)
		if (groundTruth.returnType) {
			if (summary.returnDescription && summary.returnDescription.length > 0) {
				fieldCompleteness += 20;
			}
		} else {
			fieldCompleteness += 20; // No return type = full points for this
		}

		// Side effects documentation if applicable (25%)
		if (hasSideEffects) {
			if (summary.sideEffects && summary.sideEffects.length > 0) {
				fieldCompleteness += 25;
			}
		} else {
			fieldCompleteness += 25; // No side effects = full points
		}

		// Usage context is bonus (25%)
		if (summary.usageContext && summary.usageContext.length > 0) {
			fieldCompleteness += 25;
		}

		const score = Math.round(paramCoverage * 0.5 + fieldCompleteness * 0.5);

		return {
			score,
			details: {
				actualParams: actualParams.length,
				coveredParams: mentionedParams.length,
				paramCoverage: Math.round(paramCoverage),
				hasSummary: !!summary.summary && summary.summary.length > 10,
				hasReturnDescription: !!summary.returnDescription,
				hasSideEffects: (summary.sideEffects?.length ?? 0) > 0,
				hasUsageContext: !!summary.usageContext,
				fieldCompleteness,
			},
		};
	}
}
