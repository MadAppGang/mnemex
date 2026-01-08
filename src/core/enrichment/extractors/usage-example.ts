/**
 * Usage Example Extractor
 *
 * Generates practical usage examples for functions, classes, and methods.
 * Extracts: example type, code snippet, description.
 */

import type {
	BaseDocument,
	CodeChunk,
	ExtractionContext,
	ILLMClient,
	UsageExample,
} from "../../../types.js";
import {
	buildUsageExamplePrompt,
	getSystemPrompt,
} from "../../../llm/prompts/enrichment.js";
import { BaseExtractor } from "./base.js";

// ============================================================================
// Types
// ============================================================================

interface UsageExampleLLMResponse {
	examples: Array<{
		exampleType:
			| "basic"
			| "with_options"
			| "error_case"
			| "in_context"
			| "test";
		code: string;
		description?: string;
	}>;
}

// ============================================================================
// Usage Example Extractor
// ============================================================================

export class UsageExampleExtractor extends BaseExtractor {
	constructor() {
		super("usage_example", ["code_chunk", "symbol_summary"]);
	}

	async extract(
		context: ExtractionContext,
		llmClient: ILLMClient,
	): Promise<BaseDocument[]> {
		const documents: BaseDocument[] = [];

		// Get exported/public symbols worth documenting
		const symbols = context.codeChunks.filter(
			(chunk) =>
				chunk.name &&
				(chunk.chunkType === "function" || chunk.chunkType === "class") &&
				// Skip private/internal symbols
				!chunk.name.startsWith("_") &&
				!chunk.name.startsWith("#"),
		);

		// Limit to avoid too many LLM calls
		const maxSymbols = 10;
		const selectedSymbols = symbols.slice(0, maxSymbols);

		for (const chunk of selectedSymbols) {
			try {
				const examples = await this.extractExamples(chunk, context, llmClient);
				documents.push(...examples);
			} catch (error) {
				console.warn(
					`Failed to extract usage examples for ${chunk.name}:`,
					error instanceof Error ? error.message : error,
				);
			}
		}

		return documents;
	}

	private async extractExamples(
		chunk: CodeChunk,
		context: ExtractionContext,
		llmClient: ILLMClient,
	): Promise<UsageExample[]> {
		// Get symbol summary if available
		const symbolSummary = context.existingDocs?.find(
			(doc) =>
				doc.documentType === "symbol_summary" &&
				(doc as any).symbolName === chunk.name,
		);

		// Build prompt
		const userPrompt = buildUsageExamplePrompt(
			chunk,
			symbolSummary ? (symbolSummary as any).summary : undefined,
		);

		// Call LLM
		const response = await llmClient.completeJSON<UsageExampleLLMResponse>(
			[{ role: "user", content: userPrompt }],
			{ systemPrompt: getSystemPrompt("usage_example") },
		);

		if (!response.examples || response.examples.length === 0) {
			return [];
		}

		// Create documents for each example
		const documents: UsageExample[] = [];

		for (const example of response.examples) {
			const content = this.buildContent(chunk.name || "symbol", example);
			const id = this.generateId(
				content,
				context.filePath,
				chunk.name || "",
				example.exampleType,
			);

			documents.push({
				id,
				content,
				documentType: "usage_example",
				filePath: context.filePath,
				fileHash: chunk.fileHash,
				createdAt: new Date().toISOString(),
				enrichedAt: new Date().toISOString(),
				sourceIds: [chunk.id],
				symbol: chunk.name || "anonymous",
				exampleType: example.exampleType,
				code: example.code,
				description: example.description,
			});
		}

		return documents;
	}

	/**
	 * Build searchable content from the example
	 */
	private buildContent(
		symbolName: string,
		example: UsageExampleLLMResponse["examples"][0],
	): string {
		const parts = [
			`Usage example for: ${symbolName}`,
			`Type: ${example.exampleType}`,
		];

		if (example.description) {
			parts.push(`\n${example.description}`);
		}

		parts.push(`\nCode:\n${example.code}`);

		return parts.join("\n");
	}
}

// ============================================================================
// Factory Function
// ============================================================================

export function createUsageExampleExtractor(): UsageExampleExtractor {
	return new UsageExampleExtractor();
}
