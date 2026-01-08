/**
 * LLM Judge
 *
 * Uses an LLM to evaluate the quality of generated summaries.
 * Scores: usefulness, conciseness, clarity.
 */

import type { FileSummary, ILLMClient, SymbolSummary } from "../../types.js";
import type {
	IJudge,
	JudgeContext,
	JudgeInfo,
	JudgmentResult,
} from "../types.js";

// ============================================================================
// Constants
// ============================================================================

const JUDGE_SYSTEM_PROMPT = `You are an expert code reviewer evaluating the quality of automatically generated code documentation.

Your task is to score a generated summary on three dimensions (0-100 each):

1. **USEFULNESS** (most important):
   - Does the summary help a developer understand the code?
   - Does it explain the PURPOSE, not just restate the code?
   - Does it cover key parameters, return values, and behavior?
   - HIGH (90-100): Excellent explanation of purpose, covers all key aspects, would help new developers
   - MEDIUM (50-89): Basic purpose explained, covers most aspects
   - LOW (0-49): Vague, obvious, or missing important information

2. **CONCISENESS**:
   - Is the summary information-dense without unnecessary verbosity?
   - Does every sentence add value?
   - HIGH (90-100): Tight, no redundancy, every word matters
   - MEDIUM (50-89): Mostly concise with minor verbosity
   - LOW (0-49): Wordy, repetitive, or states the obvious

3. **CLARITY**:
   - Is the summary well-written and easy to understand?
   - Does it use appropriate technical terminology?
   - HIGH (90-100): Crystal clear, professional quality
   - MEDIUM (50-89): Understandable with minor awkwardness
   - LOW (0-49): Confusing, poorly structured, or unclear

Be strict but fair. Most summaries should score between 50-85.
Perfect scores (95+) should be rare - only for exceptional quality.

IMPORTANT: Respond with ONLY valid JSON. No markdown, no explanation.`;

// ============================================================================
// LLM Judge Implementation
// ============================================================================

interface JudgeResponse {
	usefulness: number;
	conciseness: number;
	clarity: number;
	feedback: string;
}

export class LLMJudge implements IJudge {
	private llmClient: ILLMClient;
	private model: string;

	constructor(llmClient: ILLMClient) {
		this.llmClient = llmClient;
		this.model = llmClient.getModel();
	}

	async judge(
		generated: FileSummary | SymbolSummary,
		context: JudgeContext,
	): Promise<JudgmentResult> {
		const startTime = Date.now();

		try {
			const prompt = this.buildPrompt(generated, context);

			const response = await this.llmClient.completeJSON<JudgeResponse>(
				[{ role: "user", content: prompt }],
				{
					systemPrompt: JUDGE_SYSTEM_PROMPT,
					temperature: 0.1, // Low temperature for consistent scoring
					maxTokens: 500,
				},
			);

			const durationMs = Date.now() - startTime;

			// Clamp scores to 0-100
			const usefulness = clamp(response.usefulness, 0, 100);
			const conciseness = clamp(response.conciseness, 0, 100);
			const clarity = clamp(response.clarity, 0, 100);

			// Calculate overall quality score (weighted average)
			const qualityScore = Math.round(
				usefulness * 0.5 + conciseness * 0.25 + clarity * 0.25,
			);

			return {
				usefulness,
				conciseness,
				clarity,
				qualityScore,
				feedback: response.feedback || undefined,
				judgedBy: this.model,
				durationMs,
			};
		} catch (error) {
			const durationMs = Date.now() - startTime;

			// Return neutral scores on error
			return {
				usefulness: 50,
				conciseness: 50,
				clarity: 50,
				qualityScore: 50,
				feedback: `Judgment failed: ${error instanceof Error ? error.message : String(error)}`,
				judgedBy: this.model,
				durationMs,
			};
		}
	}

	getInfo(): JudgeInfo {
		return {
			name: `LLM Judge (${this.model})`,
			model: this.model,
			type: "llm",
		};
	}

	private buildPrompt(
		generated: FileSummary | SymbolSummary,
		context: JudgeContext,
	): string {
		const summaryType = "symbolName" in generated ? "symbol" : "file";
		const summaryContent = this.formatSummary(generated);
		const codeContent = context.codeChunk?.content || context.fileContent;

		// Truncate code if too long
		const maxCodeLength = 3000;
		const truncatedCode =
			codeContent.length > maxCodeLength
				? codeContent.slice(0, maxCodeLength) + "\n... (truncated)"
				: codeContent;

		return `Evaluate this ${summaryType} summary.

## SOURCE CODE
\`\`\`${context.language}
${truncatedCode}
\`\`\`

## GENERATED SUMMARY
${summaryContent}

## YOUR TASK
Score the summary on usefulness (0-100), conciseness (0-100), and clarity (0-100).
Also provide brief feedback explaining your scores.

Respond with JSON:
{
  "usefulness": <0-100>,
  "conciseness": <0-100>,
  "clarity": <0-100>,
  "feedback": "<brief explanation>"
}`;
	}

	private formatSummary(summary: FileSummary | SymbolSummary): string {
		if ("symbolName" in summary) {
			// SymbolSummary
			const parts = [
				`**Symbol:** ${summary.symbolName}`,
				`**Type:** ${summary.symbolType}`,
				`**Summary:** ${summary.summary}`,
			];

			if (summary.parameters && summary.parameters.length > 0) {
				parts.push(
					`**Parameters:**\n${summary.parameters
						.map((p) => `  - ${p.name}: ${p.description}`)
						.join("\n")}`,
				);
			}

			if (summary.returnDescription) {
				parts.push(`**Returns:** ${summary.returnDescription}`);
			}

			if (summary.sideEffects && summary.sideEffects.length > 0) {
				parts.push(`**Side Effects:** ${summary.sideEffects.join(", ")}`);
			}

			if (summary.usageContext) {
				parts.push(`**Usage:** ${summary.usageContext}`);
			}

			return parts.join("\n");
		} else {
			// FileSummary
			const parts = [
				`**File:** ${summary.filePath}`,
				`**Summary:** ${summary.summary}`,
			];

			if (summary.responsibilities && summary.responsibilities.length > 0) {
				parts.push(
					`**Responsibilities:**\n${summary.responsibilities
						.map((r) => `  - ${r}`)
						.join("\n")}`,
				);
			}

			if (summary.exports && summary.exports.length > 0) {
				parts.push(`**Exports:** ${summary.exports.join(", ")}`);
			}

			if (summary.dependencies && summary.dependencies.length > 0) {
				parts.push(`**Dependencies:** ${summary.dependencies.join(", ")}`);
			}

			if (summary.patterns && summary.patterns.length > 0) {
				parts.push(`**Patterns:** ${summary.patterns.join(", ")}`);
			}

			return parts.join("\n");
		}
	}
}

// ============================================================================
// Utility Functions
// ============================================================================

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}
