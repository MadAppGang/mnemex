/**
 * Anti-Pattern Extractor
 *
 * Identifies code smells, anti-patterns, and potential issues.
 * Extracts: pattern description, bad example, reason, alternative, severity.
 */

import type {
	AntiPattern,
	BaseDocument,
	ExtractionContext,
	ILLMClient,
} from "../../../types.js";
import {
	buildAntiPatternPrompt,
	getSystemPrompt,
} from "../../../llm/prompts/enrichment.js";
import { BaseExtractor } from "./base.js";

// ============================================================================
// Types
// ============================================================================

interface AntiPatternLLMResponse {
	antiPatterns: Array<{
		pattern: string;
		badExample: string;
		reason: string;
		alternative: string;
		severity: "low" | "medium" | "high";
	}>;
}

// ============================================================================
// Anti-Pattern Extractor
// ============================================================================

export class AntiPatternExtractor extends BaseExtractor {
	constructor() {
		super("anti_pattern", ["code_chunk"]);
	}

	async extract(
		context: ExtractionContext,
		llmClient: ILLMClient,
	): Promise<BaseDocument[]> {
		// Skip if too few chunks
		if (context.codeChunks.length === 0) {
			return [];
		}

		try {
			// Build prompt with code chunks
			const userPrompt = buildAntiPatternPrompt(
				context.codeChunks,
				context.language,
			);

			// Call LLM
			const response = await llmClient.completeJSON<AntiPatternLLMResponse>(
				[{ role: "user", content: userPrompt }],
				{ systemPrompt: getSystemPrompt("anti_pattern") },
			);

			if (!response.antiPatterns || response.antiPatterns.length === 0) {
				return [];
			}

			// Create documents for each anti-pattern
			const documents: AntiPattern[] = [];

			for (const antiPattern of response.antiPatterns) {
				const content = this.buildContent(antiPattern);
				const id = this.generateId(
					content,
					context.filePath,
					antiPattern.pattern,
				);

				documents.push({
					id,
					content,
					documentType: "anti_pattern",
					filePath: context.filePath,
					fileHash: context.codeChunks[0]?.fileHash,
					createdAt: new Date().toISOString(),
					enrichedAt: new Date().toISOString(),
					sourceIds: context.codeChunks.map((c) => c.id),
					pattern: antiPattern.pattern,
					badExample: antiPattern.badExample,
					reason: antiPattern.reason,
					alternative: antiPattern.alternative,
					severity: antiPattern.severity,
				});
			}

			return documents;
		} catch (error) {
			console.warn(
				`Failed to extract anti-patterns for ${context.filePath}:`,
				error instanceof Error ? error.message : error,
			);
			return [];
		}
	}

	/**
	 * Build searchable content from the anti-pattern
	 */
	private buildContent(
		antiPattern: AntiPatternLLMResponse["antiPatterns"][0],
	): string {
		return [
			`Anti-pattern: ${antiPattern.pattern}`,
			`Severity: ${antiPattern.severity}`,
			`\nProblem: ${antiPattern.reason}`,
			`\nBad example:\n${antiPattern.badExample}`,
			`\nBetter approach: ${antiPattern.alternative}`,
		].join("\n");
	}
}

// ============================================================================
// Factory Function
// ============================================================================

export function createAntiPatternExtractor(): AntiPatternExtractor {
	return new AntiPatternExtractor();
}
