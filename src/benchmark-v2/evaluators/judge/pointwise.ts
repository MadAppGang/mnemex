/**
 * Pointwise Judge Evaluator
 *
 * Evaluates summaries using a rubric-based scoring system.
 * Each summary is evaluated independently on 5 criteria (1-5 scale).
 */

import { randomUUID } from "crypto";
import type { ILLMClient, LLMMessage } from "../../../types.js";
import type {
	BenchmarkCodeUnit,
	GeneratedSummary,
	EvaluationResult,
	JudgeResults,
	JudgeScores,
	EvaluatorContext,
} from "../../types.js";
import { BaseEvaluator } from "../base.js";
import { JudgeError } from "../../errors.js";
import { JUDGE_SCORE_WEIGHTS } from "../../types.js";

// ============================================================================
// Prompts
// ============================================================================

const JUDGE_SYSTEM_PROMPT = `You are an expert evaluator assessing the quality of code summaries for use in RAG-based code search systems.

You will evaluate summaries on 5 criteria, scoring each from 1-5.

The summaries will be used to:
1. Match developer search queries to relevant code
2. Provide context to LLMs helping developers
3. Help developers quickly understand unfamiliar code

Be strict but fair. A score of 3 is average/acceptable. Reserve 5 for exceptional summaries and 1 for summaries that would actively harm retrieval or understanding.`;

const JUDGE_USER_PROMPT = `Evaluate this code summary.

## Original Code
\`\`\`{language}
{code}
\`\`\`

## Summary to Evaluate
{summary}

## Evaluation Criteria

### 1. Accuracy (1-5)
Does the summary correctly describe what the code does?
- 1: Fundamentally wrong, misleading, or describes different functionality
- 2: Major errors or significant misunderstandings
- 3: Mostly correct with some inaccuracies or ambiguities
- 4: Accurate with only minor issues or omissions
- 5: Completely accurate representation of the code's functionality

### 2. Completeness (1-5)
Does the summary cover the important aspects?
- 1: Missing most key information (inputs, outputs, purpose, side effects)
- 2: Missing several important aspects
- 3: Covers main functionality but misses some relevant details
- 4: Covers all important aspects with minor omissions
- 5: Comprehensively covers all relevant aspects without being verbose

### 3. Semantic Richness (1-5)
Would this summary help match natural language queries to this code?
- 1: Uses only generic terms, wouldn't match relevant searches
- 2: Limited vocabulary, would miss many relevant queries
- 3: Decent terminology, would match obvious queries
- 4: Good use of domain terms, would match most relevant queries
- 5: Excellent vocabulary coverage, would match diverse query phrasings

### 4. Abstraction Level (1-5)
Does it describe WHAT/WHY rather than HOW?
- 1: Just restates code in English, line-by-line description
- 2: Mostly implementation details with some purpose
- 3: Mix of implementation and intent
- 4: Focuses on purpose with minimal implementation details
- 5: Clearly captures intent and purpose, implementation only when essential

### 5. Conciseness (1-5)
Is it appropriately brief without losing important information?
- 1: Extremely verbose OR so brief it's useless
- 2: Notably too long OR missing key information due to brevity
- 3: Acceptable length but could be tighter OR slightly more detailed
- 4: Well-balanced length, minor room for improvement
- 5: Optimal length - complete yet concise

## Response Format
Respond with a JSON object:
\`\`\`json
{
  "scores": {
    "accuracy": <1-5>,
    "completeness": <1-5>,
    "semantic_richness": <1-5>,
    "abstraction": <1-5>,
    "conciseness": <1-5>
  },
  "reasoning": "<Brief explanation of scores, 2-3 sentences>",
  "weighted_average": <calculated weighted average>
}
\`\`\`

Weights for weighted_average: accuracy=0.25, completeness=0.20, semantic_richness=0.25, abstraction=0.15, conciseness=0.15`;

// ============================================================================
// Pointwise Evaluator
// ============================================================================

interface JudgeResponse {
	scores: {
		accuracy: number;
		completeness: number;
		semantic_richness: number;
		abstraction: number;
		conciseness: number;
	};
	reasoning: string;
	weighted_average: number;
}

export class PointwiseJudgeEvaluator extends BaseEvaluator<EvaluationResult> {
	private judgeModelId: string;

	constructor(llmClient: ILLMClient, judgeModelId: string) {
		super(llmClient);
		this.judgeModelId = judgeModelId;
	}

	async evaluate(
		summary: GeneratedSummary,
		codeUnit: BenchmarkCodeUnit,
		_context: EvaluatorContext,
	): Promise<EvaluationResult> {
		if (!this.llmClient) {
			throw new JudgeError(this.judgeModelId, "No LLM client provided");
		}

		const prompt = JUDGE_USER_PROMPT.replace("{language}", codeUnit.language)
			.replace("{code}", this.truncateCode(codeUnit.content))
			.replace("{summary}", summary.summary);

		const messages: LLMMessage[] = [
			{ role: "system", content: JUDGE_SYSTEM_PROMPT },
			{ role: "user", content: prompt },
		];

		try {
			// Gemini Pro models use internal "thinking" tokens that count against max_tokens
			// They need significantly more tokens (16000+) to complete responses
			const modelLower = this.judgeModelId.toLowerCase();
			const isGeminiPro =
				modelLower.includes("gemini") && modelLower.includes("pro");
			const isGemini = modelLower.includes("gemini");

			const response = await this.llmClient.complete(messages, {
				temperature: 0.1, // Low temperature for consistent judging
				maxTokens: isGeminiPro ? 16000 : isGemini ? 4000 : 1000,
			});

			const parsed = this.parseJSONResponse<JudgeResponse>(response.content);

			// Validate scores
			const scores = this.validateScores(parsed.scores);

			// Calculate weighted average
			const weightedAverage = this.calculateWeightedAverage(scores);

			const judgeResults: JudgeResults = {
				judgeModelId: this.judgeModelId,
				scores,
				reasoning: parsed.reasoning,
				weightedAverage,
				cost: response.usage?.cost,
			};

			return {
				id: randomUUID(),
				summaryId: summary.id,
				evaluationType: "judge",
				judgeResults,
				evaluatedAt: new Date().toISOString(),
			};
		} catch (error) {
			throw new JudgeError(
				this.judgeModelId,
				error instanceof Error ? error.message : String(error),
				{ summaryId: summary.id, codeUnitId: codeUnit.id },
				error instanceof Error ? error : undefined,
			);
		}
	}

	getType() {
		return "judge" as const;
	}

	private validateScores(raw: JudgeResponse["scores"]): JudgeScores {
		const clamp = (n: number) => Math.max(1, Math.min(5, Math.round(n)));

		return {
			accuracy: clamp(raw.accuracy),
			completeness: clamp(raw.completeness),
			semanticRichness: clamp(raw.semantic_richness),
			abstraction: clamp(raw.abstraction),
			conciseness: clamp(raw.conciseness),
		};
	}

	private calculateWeightedAverage(scores: JudgeScores): number {
		return (
			scores.accuracy * JUDGE_SCORE_WEIGHTS.accuracy +
			scores.completeness * JUDGE_SCORE_WEIGHTS.completeness +
			scores.semanticRichness * JUDGE_SCORE_WEIGHTS.semanticRichness +
			scores.abstraction * JUDGE_SCORE_WEIGHTS.abstraction +
			scores.conciseness * JUDGE_SCORE_WEIGHTS.conciseness
		);
	}
}

// ============================================================================
// Factory Function
// ============================================================================

export function createPointwiseJudgeEvaluator(
	llmClient: ILLMClient,
	judgeModelId: string,
): PointwiseJudgeEvaluator {
	return new PointwiseJudgeEvaluator(llmClient, judgeModelId);
}
