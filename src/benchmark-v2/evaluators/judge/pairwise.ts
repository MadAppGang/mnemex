/**
 * Pairwise Judge Evaluator
 *
 * Compares summaries head-to-head to determine relative quality.
 * Runs comparisons in both orders to mitigate position bias.
 */

import type { ILLMClient, LLMMessage } from "../../../types.js";
import type {
	BenchmarkCodeUnit,
	GeneratedSummary,
	PairwiseResult,
	EvaluatorContext,
	TournamentScore,
} from "../../types.js";
import { BaseEvaluator, selectJudges } from "../base.js";
import { JudgeError } from "../../errors.js";

// ============================================================================
// Prompts
// ============================================================================

const PAIRWISE_SYSTEM_PROMPT = `You are an expert evaluator comparing code summaries for use in RAG-based code search systems.

You will compare two summaries of the same code and determine which is more useful for:
1. Matching developer search queries to relevant code
2. Providing context to LLMs helping developers
3. Helping developers quickly understand unfamiliar code

Be decisive. You must pick a winner or declare a tie only if they are truly equivalent.`;

const PAIRWISE_USER_PROMPT = `Compare these two summaries of the same code.

## Original Code
\`\`\`{language}
{code}
\`\`\`

## Summary A
{summary_a}

## Summary B
{summary_b}

## Comparison Criteria
Consider:
- Accuracy: Which more correctly describes the code?
- Completeness: Which covers more important aspects?
- Searchability: Which would better match developer queries?
- Clarity: Which better captures intent vs implementation?
- Conciseness: Which is more appropriately sized?

## Response Format
Respond with a JSON object:
\`\`\`json
{
  "winner": "A" | "B" | "tie",
  "confidence": "high" | "medium" | "low",
  "reasoning": "<2-3 sentences explaining your decision>",
  "criteria_breakdown": {
    "accuracy": "A" | "B" | "tie",
    "completeness": "A" | "B" | "tie",
    "searchability": "A" | "B" | "tie",
    "clarity": "A" | "B" | "tie",
    "conciseness": "A" | "B" | "tie"
  }
}
\`\`\``;

// ============================================================================
// Batched Prompts (multiple comparisons per API call)
// ============================================================================

const BATCHED_PAIRWISE_SYSTEM_PROMPT = `You are an expert evaluator comparing code summaries for RAG-based code search systems.

You will evaluate MULTIPLE comparisons in a single response. Each comparison has two summaries (A and B) of the same code. Determine which summary is more useful for:
1. Matching developer search queries to relevant code
2. Providing context to LLMs helping developers
3. Helping developers quickly understand unfamiliar code

Be decisive. Pick a winner or declare a tie only if truly equivalent. Evaluate each comparison independently.`;

const BATCHED_PAIRWISE_USER_PROMPT = `Evaluate the following comparisons of code summaries.

## Original Code
\`\`\`{language}
{code}
\`\`\`

## Comparisons
{comparisons}

## Evaluation Criteria (apply to each comparison)
- Accuracy: Which more correctly describes the code?
- Completeness: Which covers more important aspects?
- Searchability: Which would better match developer queries?
- Clarity: Which better captures intent vs implementation?
- Conciseness: Which is more appropriately sized?

## Response Format
Respond with a JSON object containing results for ALL comparisons:
\`\`\`json
{
  "results": [
    {
      "id": 1,
      "winner": "A" | "B" | "tie",
      "confidence": "high" | "medium" | "low",
      "reasoning": "<1-2 sentences>",
      "criteria_breakdown": {
        "accuracy": "A" | "B" | "tie",
        "completeness": "A" | "B" | "tie",
        "searchability": "A" | "B" | "tie",
        "clarity": "A" | "B" | "tie",
        "conciseness": "A" | "B" | "tie"
      }
    }
  ]
}
\`\`\`

IMPORTANT: Return results for ALL {count} comparisons in order.`;

// ============================================================================
// Pairwise Evaluator
// ============================================================================

interface PairwiseResponse {
	winner: "A" | "B" | "tie";
	confidence: "high" | "medium" | "low";
	reasoning: string;
	criteria_breakdown: {
		accuracy: "A" | "B" | "tie";
		completeness: "A" | "B" | "tie";
		searchability: "A" | "B" | "tie";
		clarity: "A" | "B" | "tie";
		conciseness: "A" | "B" | "tie";
	};
}

interface BatchedPairwiseResponse {
	results: Array<{
		id: number;
		winner: "A" | "B" | "tie";
		confidence: "high" | "medium" | "low";
		reasoning: string;
		criteria_breakdown: {
			accuracy: "A" | "B" | "tie";
			completeness: "A" | "B" | "tie";
			searchability: "A" | "B" | "tie";
			clarity: "A" | "B" | "tie";
			conciseness: "A" | "B" | "tie";
		};
	}>;
}

/** Metadata for a single comparison in a batch */
interface ComparisonMetadata {
	summaryA: GeneratedSummary;
	summaryB: GeneratedSummary;
	swapped: boolean;
}

export class PairwiseJudgeEvaluator extends BaseEvaluator<PairwiseResult[]> {
	private judgeModelId: string;

	constructor(llmClient: ILLMClient, judgeModelId: string) {
		super(llmClient);
		this.judgeModelId = judgeModelId;
	}

	/**
	 * Compare two summaries for the same code unit
	 * Runs both orderings in parallel to mitigate position bias
	 */
	async compare(
		codeUnit: BenchmarkCodeUnit,
		summaryA: GeneratedSummary,
		summaryB: GeneratedSummary,
	): Promise<PairwiseResult[]> {
		if (!this.llmClient) {
			throw new JudgeError(this.judgeModelId, "No LLM client provided");
		}

		// Run both orderings in parallel (2x speedup per pair)
		const [result1, result2] = await Promise.all([
			this.runComparison(codeUnit, summaryA.summary, summaryB.summary, false),
			this.runComparison(codeUnit, summaryB.summary, summaryA.summary, true),
		]);

		// Swap the winner back to original perspective for result2
		let swappedWinner: "A" | "B" | "tie" = result2.winner;
		if (result2.winner === "A") {
			swappedWinner = "B";
		} else if (result2.winner === "B") {
			swappedWinner = "A";
		}

		return [
			{
				modelA: summaryA.modelId,
				modelB: summaryB.modelId,
				codeUnitId: codeUnit.id,
				judgeModel: this.judgeModelId,
				winner: result1.winner,
				confidence: result1.confidence,
				positionSwapped: false,
				reasoning: result1.reasoning,
				criteriaBreakdown: result1.criteria_breakdown,
			},
			{
				modelA: summaryA.modelId,
				modelB: summaryB.modelId,
				codeUnitId: codeUnit.id,
				judgeModel: this.judgeModelId,
				winner: swappedWinner,
				confidence: result2.confidence,
				positionSwapped: true,
				reasoning: result2.reasoning,
				criteriaBreakdown: this.swapCriteriaBreakdown(
					result2.criteria_breakdown,
				),
			},
		];
	}

	/**
	 * Required by IEvaluator interface
	 * For pairwise evaluation, use comparePairs() instead
	 */
	async evaluate(
		_summary: GeneratedSummary,
		_codeUnit: BenchmarkCodeUnit,
		_context: EvaluatorContext,
	): Promise<PairwiseResult[]> {
		throw new Error(
			"Pairwise evaluation requires two summaries. Use compare() or comparePairs() instead.",
		);
	}

	/**
	 * Compare all pairs of summaries for a code unit
	 * Uses batched API calls for efficiency (multiple comparisons per call)
	 * Runs batches in parallel for speed
	 */
	async comparePairs(
		codeUnit: BenchmarkCodeUnit,
		summaries: GeneratedSummary[],
		onProgress?: (completed: number, total: number, inProgress: number) => void,
	): Promise<PairwiseResult[]> {
		// Generate all pair combinations with both orderings (for position bias)
		const comparisons: ComparisonMetadata[] = [];
		for (let i = 0; i < summaries.length; i++) {
			for (let j = i + 1; j < summaries.length; j++) {
				// Original order: A vs B
				comparisons.push({
					summaryA: summaries[i],
					summaryB: summaries[j],
					swapped: false,
				});
				// Swapped order: B vs A (for position bias mitigation)
				comparisons.push({
					summaryA: summaries[j],
					summaryB: summaries[i],
					swapped: true,
				});
			}
		}

		const batchSize = 10; // Pack 10 comparisons per API call
		const concurrentBatches = 50; // Run 50 batches in parallel

		// Split into batches
		const batches: ComparisonMetadata[][] = [];
		for (let i = 0; i < comparisons.length; i += batchSize) {
			batches.push(comparisons.slice(i, i + batchSize));
		}

		const results: PairwiseResult[] = [];
		let completed = 0;

		// Track in-progress comparisons for animation
		const inProgressSet = new Set<number>(); // Track batch indices

		const getInProgressCount = () => {
			let count = 0;
			for (const batchIdx of inProgressSet) {
				count += batches[batchIdx]?.length || 0;
			}
			return count;
		};

		// Timeout for each batch - longer for Claude Code subprocess
		const DEFAULT_BATCH_TIMEOUT_MS = 120_000; // 2 minutes
		const CC_BATCH_TIMEOUT_MS = 300_000; // 5 minutes for cc/ models
		const BATCH_TIMEOUT_MS = this.judgeModelId.startsWith("cc/")
			? CC_BATCH_TIMEOUT_MS
			: DEFAULT_BATCH_TIMEOUT_MS;

		const withTimeout = <T>(
			promise: Promise<T>,
			timeoutMs: number,
		): Promise<T> => {
			return Promise.race([
				promise,
				new Promise<T>((_, reject) =>
					setTimeout(
						() => reject(new Error(`Batch timeout after ${timeoutMs}ms`)),
						timeoutMs,
					),
				),
			]);
		};

		// Process batches in parallel groups
		for (let i = 0; i < batches.length; i += concurrentBatches) {
			const batchGroup = batches.slice(i, i + concurrentBatches);
			const batchIndices = batchGroup.map((_, idx) => i + idx);

			// Mark batches as in progress
			batchIndices.forEach((idx) => inProgressSet.add(idx));
			onProgress?.(completed, comparisons.length, getInProgressCount());

			// Run batches in parallel, updating progress as each completes
			const batchPromises = batchGroup.map(async (batch, localIdx) => {
				const batchIdx = i + localIdx;
				try {
					const result = await withTimeout(
						this.runBatchedComparison(codeUnit, batch),
						BATCH_TIMEOUT_MS,
					);
					// Mark this batch as done and update progress
					inProgressSet.delete(batchIdx);
					completed += batch.length;
					onProgress?.(completed, comparisons.length, getInProgressCount());
					return result;
				} catch (error) {
					// Skip on timeout or error - don't block others (silent to not disrupt progress bar)
					inProgressSet.delete(batchIdx);
					completed += batch.length;
					onProgress?.(completed, comparisons.length, getInProgressCount());
					return [] as PairwiseResult[];
				}
			});

			// Use allSettled so one failure doesn't block others
			const settledResults = await Promise.allSettled(batchPromises);

			// Collect successful results
			for (const result of settledResults) {
				if (result.status === "fulfilled") {
					results.push(...result.value);
				}
			}
		}

		return results;
	}

	/**
	 * Run a batched comparison - multiple pairs in one API call
	 */
	private async runBatchedComparison(
		codeUnit: BenchmarkCodeUnit,
		batch: ComparisonMetadata[],
	): Promise<PairwiseResult[]> {
		if (!this.llmClient) {
			throw new JudgeError(this.judgeModelId, "No LLM client provided");
		}

		// Build comparisons text
		const comparisonsText = batch
			.map((comp, idx) => {
				return `### Comparison ${idx + 1}
**Summary A:**
${comp.summaryA.summary}

**Summary B:**
${comp.summaryB.summary}`;
			})
			.join("\n\n");

		const prompt = BATCHED_PAIRWISE_USER_PROMPT.replace(
			"{language}",
			codeUnit.language,
		)
			.replace("{code}", this.truncateCode(codeUnit.content))
			.replace("{comparisons}", comparisonsText)
			.replace("{count}", String(batch.length));

		const messages: LLMMessage[] = [
			{ role: "system", content: BATCHED_PAIRWISE_SYSTEM_PROMPT },
			{ role: "user", content: prompt },
		];

		try {
			// Gemini Pro models use internal "thinking" tokens that count against max_tokens
			const modelLower = this.judgeModelId.toLowerCase();
			const isGeminiPro =
				modelLower.includes("gemini") && modelLower.includes("pro");
			const isGemini = modelLower.includes("gemini");
			// Gemini Pro needs ~16000 tokens for thinking, allocate more per comparison
			const tokensPerComparison = isGeminiPro ? 8000 : isGemini ? 2000 : 300;

			const response = await this.llmClient.complete(messages, {
				temperature: 0.1,
				maxTokens: tokensPerComparison * batch.length,
			});

			const parsed = this.parseJSONResponse<BatchedPairwiseResponse>(
				response.content,
			);

			// Calculate cost per comparison (divide batch cost evenly)
			const batchCost = response.usage?.cost || 0;
			const costPerComparison = batch.length > 0 ? batchCost / batch.length : 0;

			// Map results back to PairwiseResult objects
			const results: PairwiseResult[] = [];
			for (let i = 0; i < batch.length; i++) {
				const comp = batch[i];
				const resultData = parsed.results[i];

				if (!resultData) {
					// Skip silently to not disrupt progress bar
					continue;
				}

				const result = this.buildResult(codeUnit, comp, {
					winner: resultData.winner,
					confidence: resultData.confidence,
					reasoning: resultData.reasoning,
					criteria_breakdown: resultData.criteria_breakdown,
				});
				result.cost = costPerComparison;
				results.push(result);
			}

			return results;
		} catch (error) {
			throw new JudgeError(
				this.judgeModelId,
				`Batched pairwise comparison failed: ${error instanceof Error ? error.message : String(error)}`,
				{ codeUnitId: codeUnit.id, batchSize: batch.length },
				error instanceof Error ? error : undefined,
			);
		}
	}

	/**
	 * Build a PairwiseResult from comparison metadata and response
	 */
	private buildResult(
		codeUnit: BenchmarkCodeUnit,
		comp: ComparisonMetadata,
		response: PairwiseResponse,
	): PairwiseResult {
		// For swapped comparisons, we need to swap the winner back
		let winner = response.winner;
		let criteriaBreakdown: PairwiseResult["criteriaBreakdown"] =
			response.criteria_breakdown;

		if (comp.swapped) {
			winner = this.swapWinner(response.winner);
			criteriaBreakdown = this.swapCriteriaBreakdown(
				response.criteria_breakdown,
			);
		}

		// Always store with original A/B order (non-swapped metadata)
		const originalA = comp.swapped ? comp.summaryB : comp.summaryA;
		const originalB = comp.swapped ? comp.summaryA : comp.summaryB;

		return {
			modelA: originalA.modelId,
			modelB: originalB.modelId,
			codeUnitId: codeUnit.id,
			judgeModel: this.judgeModelId,
			winner,
			confidence: response.confidence,
			positionSwapped: comp.swapped,
			reasoning: response.reasoning,
			criteriaBreakdown,
		};
	}

	private swapWinner(winner: "A" | "B" | "tie"): "A" | "B" | "tie" {
		if (winner === "A") return "B";
		if (winner === "B") return "A";
		return "tie";
	}

	getType() {
		return "judge" as const;
	}

	private async runComparison(
		codeUnit: BenchmarkCodeUnit,
		summaryTextA: string,
		summaryTextB: string,
		_swapped: boolean,
	): Promise<PairwiseResponse> {
		const prompt = PAIRWISE_USER_PROMPT.replace("{language}", codeUnit.language)
			.replace("{code}", this.truncateCode(codeUnit.content))
			.replace("{summary_a}", summaryTextA)
			.replace("{summary_b}", summaryTextB);

		const messages: LLMMessage[] = [
			{ role: "system", content: PAIRWISE_SYSTEM_PROMPT },
			{ role: "user", content: prompt },
		];

		try {
			// Gemini Pro models use internal "thinking" tokens that count against max_tokens
			const modelLower = this.judgeModelId.toLowerCase();
			const isGeminiPro =
				modelLower.includes("gemini") && modelLower.includes("pro");
			const isGemini = modelLower.includes("gemini");

			const response = await this.llmClient!.complete(messages, {
				temperature: 0.1,
				maxTokens: isGeminiPro ? 16000 : isGemini ? 4000 : 500,
			});

			return this.parseJSONResponse<PairwiseResponse>(response.content);
		} catch (error) {
			throw new JudgeError(
				this.judgeModelId,
				`Pairwise comparison failed: ${error instanceof Error ? error.message : String(error)}`,
				{ codeUnitId: codeUnit.id },
				error instanceof Error ? error : undefined,
			);
		}
	}

	private swapCriteriaBreakdown(
		breakdown: PairwiseResponse["criteria_breakdown"],
	): PairwiseResult["criteriaBreakdown"] {
		const swap = (v: "A" | "B" | "tie"): "A" | "B" | "tie" => {
			if (v === "A") return "B";
			if (v === "B") return "A";
			return "tie";
		};

		return {
			accuracy: swap(breakdown.accuracy),
			completeness: swap(breakdown.completeness),
			searchability: swap(breakdown.searchability),
			clarity: swap(breakdown.clarity),
			conciseness: swap(breakdown.conciseness),
		};
	}
}

// ============================================================================
// Tournament Aggregation
// ============================================================================

/**
 * Calculate tournament scores from pairwise results
 */
export function aggregateTournamentResults(
	results: PairwiseResult[],
	modelIds: string[],
): Map<string, TournamentScore> {
	const scores = new Map<string, TournamentScore>();

	// Initialize scores
	for (const modelId of modelIds) {
		scores.set(modelId, {
			wins: 0,
			losses: 0,
			ties: 0,
			winRate: 0,
			btScore: 0,
		});
	}

	// Count wins/losses/ties
	for (const result of results) {
		const scoreA = scores.get(result.modelA);
		const scoreB = scores.get(result.modelB);

		if (!scoreA || !scoreB) continue;

		if (result.winner === "A") {
			scoreA.wins++;
			scoreB.losses++;
		} else if (result.winner === "B") {
			scoreB.wins++;
			scoreA.losses++;
		} else {
			scoreA.ties++;
			scoreB.ties++;
		}
	}

	// Calculate win rates and Bradley-Terry scores
	for (const [modelId, score] of scores) {
		const total = score.wins + score.losses + score.ties;
		if (total > 0) {
			// Win rate: wins + 0.5 * ties / total
			score.winRate = (score.wins + 0.5 * score.ties) / total;

			// Simplified Bradley-Terry score (proportional to win rate)
			score.btScore = score.winRate;
		}
	}

	return scores;
}

// ============================================================================
// Factory Function
// ============================================================================

export function createPairwiseJudgeEvaluator(
	llmClient: ILLMClient,
	judgeModelId: string,
): PairwiseJudgeEvaluator {
	return new PairwiseJudgeEvaluator(llmClient, judgeModelId);
}
