/**
 * Correctness Scorer
 *
 * Validates generated summaries against AST ground truth.
 * Measures: Are the mentioned elements (params, exports, etc.) correct?
 *
 * Weight: 30% of total score
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
// Correctness Scorer Implementation
// ============================================================================

export class CorrectnessScorer implements IScorer {
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
			const result = this.scoreFileSummaryCorrectness(fileSummary, groundTruth);
			score = result.score;
			details = result.details;
		} else {
			const symbolSummary = summary as SymbolSummary;
			const result = this.scoreSymbolSummaryCorrectness(
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
			name: "correctness",
			weight: 0.3,
			description:
				"Are the mentioned elements (params, exports, types) factually correct?",
		};
	}

	/**
	 * Score file summary correctness by checking exports and dependencies.
	 */
	private scoreFileSummaryCorrectness(
		summary: FileSummary,
		groundTruth: TestCase["groundTruth"],
	): { score: number; details: Record<string, unknown> } {
		const mentionedExports = summary.exports || [];
		const actualExports = groundTruth.exports || [];
		const mentionedDeps = summary.dependencies || [];
		const actualDeps = groundTruth.dependencies || [];

		// Calculate export correctness (60% weight)
		// What percentage of mentioned exports actually exist?
		let exportCorrectness = 100;
		if (mentionedExports.length > 0 && actualExports.length > 0) {
			const correctExports = mentionedExports.filter((exp) =>
				actualExports.some((actual) => fuzzyMatch(exp, actual)),
			);
			exportCorrectness =
				(correctExports.length / mentionedExports.length) * 100;
		} else if (mentionedExports.length > 0 && actualExports.length === 0) {
			// Mentioned exports that don't exist = hallucination
			exportCorrectness = 0;
		}

		// Calculate dependency correctness (40% weight)
		let depCorrectness = 100;
		if (mentionedDeps.length > 0 && actualDeps.length > 0) {
			const correctDeps = mentionedDeps.filter((dep) =>
				actualDeps.some((actual) => fuzzyMatch(dep, actual)),
			);
			depCorrectness = (correctDeps.length / mentionedDeps.length) * 100;
		} else if (mentionedDeps.length > 0 && actualDeps.length === 0) {
			depCorrectness = 0;
		}

		const score = Math.round(exportCorrectness * 0.6 + depCorrectness * 0.4);

		return {
			score,
			details: {
				mentionedExports: mentionedExports.length,
				actualExports: actualExports.length,
				exportCorrectness: Math.round(exportCorrectness),
				mentionedDependencies: mentionedDeps.length,
				actualDependencies: actualDeps.length,
				dependencyCorrectness: Math.round(depCorrectness),
			},
		};
	}

	/**
	 * Score symbol summary correctness by checking parameters.
	 */
	private scoreSymbolSummaryCorrectness(
		summary: SymbolSummary,
		groundTruth: TestCase["groundTruth"],
	): { score: number; details: Record<string, unknown> } {
		const mentionedParams = summary.parameters || [];
		const actualParams = groundTruth.parameters || [];

		// Calculate parameter name correctness (70% weight)
		let paramCorrectness = 100;
		if (mentionedParams.length > 0 && actualParams.length > 0) {
			const correctParams = mentionedParams.filter((param) =>
				actualParams.some((actual) => actual.name === param.name),
			);
			paramCorrectness = (correctParams.length / mentionedParams.length) * 100;
		} else if (mentionedParams.length > 0 && actualParams.length === 0) {
			// Mentioned params that don't exist = hallucination
			paramCorrectness = 0;
		}

		// Check async correctness (15% weight)
		let asyncCorrectness = 100;
		const mentionsAsync =
			summary.summary?.toLowerCase().includes("async") ||
			summary.returnDescription?.toLowerCase().includes("promise");
		if (groundTruth.isAsync !== mentionsAsync) {
			asyncCorrectness = mentionsAsync ? 50 : 80; // Saying async when not is worse than missing it
		}

		// Check return type correctness (15% weight)
		let returnCorrectness = 100;
		if (groundTruth.returnType) {
			const mentionsReturn = summary.returnDescription
				?.toLowerCase()
				.includes(
					groundTruth.returnType
						.toLowerCase()
						.replace("promise<", "")
						.replace(">", ""),
				);
			if (!mentionsReturn) {
				returnCorrectness = 60; // Missing return type is not as bad as wrong info
			}
		}

		const score = Math.round(
			paramCorrectness * 0.7 +
				asyncCorrectness * 0.15 +
				returnCorrectness * 0.15,
		);

		return {
			score,
			details: {
				mentionedParams: mentionedParams.map((p) => p.name),
				actualParams: actualParams.map((p) => p.name),
				paramCorrectness: Math.round(paramCorrectness),
				isAsync: groundTruth.isAsync,
				asyncCorrectness: Math.round(asyncCorrectness),
				returnType: groundTruth.returnType,
				returnCorrectness: Math.round(returnCorrectness),
			},
		};
	}
}
