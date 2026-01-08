/**
 * Blind Judge
 *
 * Wrapper that ensures the judge cannot see which model generated the summary.
 * This helps prevent bias in evaluation.
 *
 * Note: In practice, the LLM judge doesn't know which model generated the summary
 * anyway (we don't include that in the prompt). This wrapper is primarily useful
 * for batch evaluation where we want to randomize the order of candidates.
 */

import type { FileSummary, SymbolSummary } from "../../types.js";
import type {
	IJudge,
	JudgeContext,
	JudgeInfo,
	JudgmentResult,
} from "../types.js";

// ============================================================================
// Blind Judge Implementation
// ============================================================================

export class BlindJudge implements IJudge {
	private innerJudge: IJudge;

	constructor(innerJudge: IJudge) {
		this.innerJudge = innerJudge;
	}

	async judge(
		generated: FileSummary | SymbolSummary,
		context: JudgeContext,
	): Promise<JudgmentResult> {
		// Create a copy of the summary without any identifying information
		const anonymizedSummary = this.anonymize(generated);

		// Create a copy of the context without any identifying information
		const anonymizedContext: JudgeContext = {
			...context,
			// Remove file path from context to prevent bias based on file name
			filePath: "source_file",
		};

		// Delegate to inner judge
		const result = await this.innerJudge.judge(
			anonymizedSummary,
			anonymizedContext,
		);

		// Mark as blind judgment
		return {
			...result,
			judgedBy: `Blind(${result.judgedBy})`,
		};
	}

	getInfo(): JudgeInfo {
		const innerInfo = this.innerJudge.getInfo();
		return {
			name: `Blind ${innerInfo.name}`,
			model: innerInfo.model,
			type: "blind",
		};
	}

	/**
	 * Remove any identifying information from the summary.
	 */
	private anonymize(
		summary: FileSummary | SymbolSummary,
	): FileSummary | SymbolSummary {
		if ("symbolName" in summary) {
			// SymbolSummary - keep symbol name as it's needed for understanding
			return {
				...summary,
				// Remove enrichedAt timestamp which could identify the model
				enrichedAt: undefined,
				// Remove source IDs
				sourceIds: [],
			};
		} else {
			// FileSummary - anonymize file path
			return {
				...summary,
				filePath: "source_file",
				enrichedAt: undefined,
				sourceIds: [],
			};
		}
	}
}

// ============================================================================
// Batch Blind Evaluation
// ============================================================================

/**
 * Candidate summary for batch evaluation
 */
export interface EvaluationCandidate {
	/** Anonymous identifier (e.g., "A", "B", "C") */
	id: string;
	/** The generated summary */
	summary: FileSummary | SymbolSummary;
	/** Original generator identifier (hidden from judge) */
	generatorId: string;
}

/**
 * Result of batch blind evaluation
 */
export interface BatchBlindResult {
	/** Candidate ID */
	candidateId: string;
	/** Generator ID (revealed after evaluation) */
	generatorId: string;
	/** Judgment result */
	judgment: JudgmentResult;
}

/**
 * Shuffle an array using Fisher-Yates algorithm
 */
function shuffle<T>(array: T[]): T[] {
	const result = [...array];
	for (let i = result.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[result[i], result[j]] = [result[j], result[i]];
	}
	return result;
}

/**
 * Evaluate multiple candidates blindly.
 * Shuffles the order and assigns anonymous IDs before evaluation.
 */
export async function evaluateBlindly(
	candidates: Array<{
		summary: FileSummary | SymbolSummary;
		generatorId: string;
	}>,
	context: JudgeContext,
	judge: IJudge,
): Promise<BatchBlindResult[]> {
	// Assign anonymous IDs and shuffle
	const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
	const evaluationCandidates: EvaluationCandidate[] = candidates.map(
		(c, i) => ({
			id: letters[i % letters.length],
			summary: c.summary,
			generatorId: c.generatorId,
		}),
	);

	const shuffled = shuffle(evaluationCandidates);

	// Create blind judge
	const blindJudge = new BlindJudge(judge);

	// Evaluate each candidate
	const results: BatchBlindResult[] = [];
	for (const candidate of shuffled) {
		const judgment = await blindJudge.judge(candidate.summary, context);
		results.push({
			candidateId: candidate.id,
			generatorId: candidate.generatorId,
			judgment,
		});
	}

	return results;
}
