/**
 * Refinement Engine
 *
 * Core engine for iterative refinement of code summaries.
 * Uses a pluggable strategy pattern for quality testing.
 *
 * Flow:
 * 1. Test initial summary quality
 * 2. If quality insufficient, generate feedback
 * 3. Ask model to refine summary based on feedback
 * 4. Repeat until success or max rounds reached
 */

import type { ILLMClient } from "../../../types.js";
import type {
	RefinementContext,
	RefinementResult,
	RefinementAttempt,
	RefinementOptions,
	QualityTestResult,
} from "./types.js";
import { calculateRefinementScore } from "./types.js";

// ============================================================================
// Prompts
// ============================================================================

const REFINEMENT_SYSTEM_PROMPT = `You are an expert at writing concise, searchable code summaries.
Your task is to refine a code summary based on feedback about its quality.

Guidelines:
- Focus on WHAT the code does, not HOW it does it
- Include key terms developers would search for
- Be concise but complete (1-3 sentences)
- Avoid implementation details unless critical
- Emphasize the code's purpose and use cases`;

function buildRefinementPrompt(
	context: RefinementContext,
	feedback: string,
	previousSummary: string,
): string {
	return `## Previous Summary
${previousSummary}

## Feedback
${feedback}

## Original Code
\`\`\`${context.language}
${context.codeContent.slice(0, 2000)}${context.codeContent.length > 2000 ? "\n// ... (truncated)" : ""}
\`\`\`

## Task
Write an improved summary that addresses the feedback. Output ONLY the summary text, nothing else.`;
}

// ============================================================================
// Refinement Engine
// ============================================================================

export class RefinementEngine {
	/**
	 * Execute iterative refinement on a summary
	 *
	 * @param initialSummary - The initial summary to refine
	 * @param context - Context including code, competitors, queries
	 * @param options - Engine options including strategy and LLM client
	 * @returns Complete refinement result with history
	 */
	async refine(
		initialSummary: string,
		context: RefinementContext,
		options: RefinementOptions,
	): Promise<RefinementResult> {
		const { strategy, llmClient, maxRounds, onProgress, abortSignal } = options;
		const startTime = Date.now();
		const history: RefinementAttempt[] = [];

		let currentSummary = initialSummary;
		let finalResult: QualityTestResult | null = null;

		// Test initial summary
		const initialResult = await strategy.testQuality(currentSummary, context);
		finalResult = initialResult;

		onProgress?.(0, initialResult);

		// Check if initial summary is already good enough
		if (strategy.isSuccess(initialResult)) {
			if (process.env.DEBUG_ITERATIVE) {
				console.log(`[ENGINE] Initial summary passed, returning rounds=0`);
			}
			return this.buildResult(
				currentSummary,
				0,
				true,
				history,
				initialResult.rank,
				initialResult.rank,
				startTime,
			);
		}

		if (process.env.DEBUG_ITERATIVE) {
			console.log(
				`[ENGINE] Initial summary FAILED (rank=${initialResult.rank}), entering refinement loop (maxRounds=${maxRounds})`,
			);
		}

		// Iterative refinement loop
		for (let round = 1; round <= maxRounds; round++) {
			// Check for abort
			if (abortSignal?.aborted) {
				break;
			}

			const roundStart = Date.now();

			// Generate feedback from the test result
			const feedback = await strategy.generateFeedback(finalResult!, context);

			// Ask the model to refine the summary
			const refinedSummary = await this.generateRefinedSummary(
				context,
				feedback,
				currentSummary,
				llmClient,
			);

			// Test the refined summary
			const testResult = await strategy.testQuality(refinedSummary, context);
			finalResult = testResult;

			// Record this attempt
			history.push({
				round,
				summary: refinedSummary,
				testResult,
				feedback,
				durationMs: Date.now() - roundStart,
			});

			onProgress?.(round, testResult);

			// Update current summary
			currentSummary = refinedSummary;

			// Check if we've achieved success
			if (strategy.isSuccess(testResult)) {
				if (process.env.DEBUG_ITERATIVE) {
					console.log(
						`[ENGINE] Refinement succeeded at round ${round}, new rank=${testResult.rank}`,
					);
				}
				return this.buildResult(
					currentSummary,
					round,
					true,
					history,
					initialResult.rank,
					testResult.rank,
					startTime,
				);
			}
		}

		// Max rounds reached without success
		if (process.env.DEBUG_ITERATIVE) {
			console.log(
				`[ENGINE] Max rounds (${maxRounds}) reached without success, returning rounds=${history.length}`,
			);
		}
		return this.buildResult(
			currentSummary,
			history.length,
			false,
			history,
			initialResult.rank,
			finalResult?.rank ?? null,
			startTime,
		);
	}

	/**
	 * Generate a refined summary using the LLM
	 */
	private async generateRefinedSummary(
		context: RefinementContext,
		feedback: string,
		previousSummary: string,
		llmClient: ILLMClient,
	): Promise<string> {
		const prompt = buildRefinementPrompt(context, feedback, previousSummary);

		const response = await llmClient.complete(
			[{ role: "user", content: prompt }],
			{
				systemPrompt: REFINEMENT_SYSTEM_PROMPT,
				maxTokens: 500,
				temperature: 0.3, // Lower temperature for focused refinement
			},
		);

		// Clean up the response (remove quotes, extra whitespace)
		return response.content.trim().replace(/^["']|["']$/g, "");
	}

	/**
	 * Build the final refinement result
	 */
	private buildResult(
		finalSummary: string,
		rounds: number,
		success: boolean,
		history: RefinementAttempt[],
		initialRank: number | null,
		finalRank: number | null,
		startTime: number,
	): RefinementResult {
		// Calculate rank improvement (positive = better)
		const rankImprovement =
			initialRank !== null && finalRank !== null ? initialRank - finalRank : 0;

		return {
			finalSummary,
			rounds,
			success,
			history,
			metrics: {
				initialRank,
				finalRank,
				rankImprovement,
				refinementScore: calculateRefinementScore(rounds),
				totalDurationMs: Date.now() - startTime,
			},
		};
	}
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a refinement engine instance
 */
export function createRefinementEngine(): RefinementEngine {
	return new RefinementEngine();
}
