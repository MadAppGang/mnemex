/**
 * Symbol Summary Extractor
 *
 * Generates summaries for functions, classes, and methods.
 * Extracts: purpose, parameters, return value, side effects, usage context.
 */

import type {
	BaseDocument,
	CodeChunk,
	ExtractionContext,
	ILLMClient,
	SymbolSummary,
} from "../../../types.js";
import {
	buildSymbolSummaryPrompt,
	buildBatchedSymbolSummaryPrompt,
	BATCHED_SYMBOL_SUMMARY_SYSTEM_PROMPT,
	getSystemPrompt,
	type BatchSymbolInfo,
} from "../../../llm/prompts/enrichment.js";
import { BaseExtractor } from "./base.js";

// ============================================================================
// Types
// ============================================================================

interface SymbolSummaryLLMResponse {
	summary: string;
	parameters?: Array<{ name: string; description: string }>;
	returnDescription?: string;
	sideEffects?: string[];
	usageContext?: string;
}

/** Response format for batched symbol summaries */
interface BatchedSymbolSummaryResponse extends SymbolSummaryLLMResponse {
	name: string;
}

// ============================================================================
// Symbol Summary Extractor
// ============================================================================

export class SymbolSummaryExtractor extends BaseExtractor {
	constructor() {
		super("symbol_summary", ["code_chunk"]);
	}

	async extract(
		context: ExtractionContext,
		llmClient: ILLMClient,
	): Promise<BaseDocument[]> {
		// Get extractable symbols (functions, classes, methods)
		const symbols = context.codeChunks.filter(
			(chunk) =>
				chunk.name &&
				(chunk.chunkType === "function" ||
					chunk.chunkType === "class" ||
					chunk.chunkType === "method"),
		);

		if (symbols.length === 0) {
			return [];
		}

		// Limit symbols per file
		const maxSymbols = 20;
		const selectedSymbols = symbols.slice(0, maxSymbols);

		// For single symbol, use regular extraction
		if (selectedSymbols.length === 1) {
			try {
				const doc = await this.extractSymbolSingle(
					selectedSymbols[0],
					context,
					llmClient,
				);
				return doc ? [doc] : [];
			} catch (error) {
				// Re-throw with context so caller sees the actual error
				throw new Error(
					`LLM error: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}

		// Batch all symbols into single LLM call
		try {
			return await this.extractSymbolsBatch(
				selectedSymbols,
				context,
				llmClient,
			);
		} catch (error) {
			// Re-throw with context so caller sees the actual error
			throw new Error(
				`LLM error: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	/**
	 * Extract summaries for multiple symbols in a single LLM call
	 */
	private async extractSymbolsBatch(
		chunks: CodeChunk[],
		context: ExtractionContext,
		llmClient: ILLMClient,
	): Promise<SymbolSummary[]> {
		// Build batch info
		const batchInfo: BatchSymbolInfo[] = chunks.map((chunk) => ({
			name: chunk.name || "anonymous",
			symbolType: chunk.chunkType,
			content: chunk.content,
			language: chunk.language,
			parentName: chunk.parentName,
		}));

		const userPrompt = buildBatchedSymbolSummaryPrompt(batchInfo);

		// Call LLM with batched prompt
		const responses = await llmClient.completeJSON<
			BatchedSymbolSummaryResponse[]
		>([{ role: "user", content: userPrompt }], {
			systemPrompt: BATCHED_SYMBOL_SUMMARY_SYSTEM_PROMPT,
		});

		// Convert responses to documents
		const documents: SymbolSummary[] = [];

		for (let i = 0; i < chunks.length; i++) {
			const chunk = chunks[i];
			// Match response by name or index
			const response =
				responses.find((r) => r.name === chunk.name) || responses[i];

			if (!response) {
				console.warn(`No summary returned for ${chunk.name}`);
				continue;
			}

			const content = this.buildContent(chunk, response);
			const id = this.generateId(content, context.filePath, chunk.name || "");

			const symbolType =
				chunk.chunkType === "method"
					? "method"
					: chunk.chunkType === "class"
						? "class"
						: "function";

			documents.push({
				id,
				content,
				documentType: "symbol_summary",
				filePath: context.filePath,
				fileHash: chunk.fileHash,
				createdAt: new Date().toISOString(),
				enrichedAt: new Date().toISOString(),
				sourceIds: [chunk.id],
				symbolName: chunk.name || "anonymous",
				symbolType,
				summary: response.summary,
				parameters: response.parameters,
				returnDescription: response.returnDescription,
				sideEffects: response.sideEffects,
				usageContext: response.usageContext,
			});
		}

		return documents;
	}

	/**
	 * Extract summary for a single symbol (fallback method)
	 */
	private async extractSymbolSingle(
		chunk: CodeChunk,
		context: ExtractionContext,
		llmClient: ILLMClient,
	): Promise<SymbolSummary | null> {
		// Build prompt with surrounding context
		const fileContext = this.getSurroundingContext(chunk, context.fileContent);
		const userPrompt = buildSymbolSummaryPrompt(chunk, fileContext);

		// Call LLM
		const response = await llmClient.completeJSON<SymbolSummaryLLMResponse>(
			[{ role: "user", content: userPrompt }],
			{ systemPrompt: getSystemPrompt("symbol_summary") },
		);

		// Build searchable content
		const content = this.buildContent(chunk, response);
		const id = this.generateId(content, context.filePath, chunk.name || "");

		const symbolType =
			chunk.chunkType === "method"
				? "method"
				: chunk.chunkType === "class"
					? "class"
					: "function";

		return {
			id,
			content,
			documentType: "symbol_summary",
			filePath: context.filePath,
			fileHash: chunk.fileHash,
			createdAt: new Date().toISOString(),
			enrichedAt: new Date().toISOString(),
			sourceIds: [chunk.id],
			symbolName: chunk.name || "anonymous",
			symbolType,
			summary: response.summary,
			parameters: response.parameters,
			returnDescription: response.returnDescription,
			sideEffects: response.sideEffects,
			usageContext: response.usageContext,
		};
	}

	/**
	 * Get surrounding context for a chunk
	 */
	private getSurroundingContext(chunk: CodeChunk, fileContent: string): string {
		const lines = fileContent.split("\n");
		const startLine = Math.max(0, chunk.startLine - 10);
		const endLine = Math.min(lines.length, chunk.endLine + 5);

		// Get lines before and after the chunk (excluding the chunk itself)
		const before = lines.slice(startLine, chunk.startLine - 1).join("\n");
		const after = lines.slice(chunk.endLine, endLine).join("\n");

		return [before, after].filter(Boolean).join("\n...\n");
	}

	/**
	 * Build searchable content from the summary
	 */
	private buildContent(
		chunk: CodeChunk,
		response: SymbolSummaryLLMResponse,
	): string {
		const parts = [
			`${chunk.chunkType}: ${chunk.name || "anonymous"}`,
			chunk.signature ? `Signature: ${chunk.signature}` : "",
			`\nSummary: ${response.summary}`,
		].filter(Boolean);

		if (response.parameters && response.parameters.length > 0) {
			parts.push(
				`\nParameters:\n${response.parameters.map((p) => `- ${p.name}: ${p.description}`).join("\n")}`,
			);
		}

		if (response.returnDescription) {
			parts.push(`\nReturns: ${response.returnDescription}`);
		}

		if (response.sideEffects && response.sideEffects.length > 0) {
			parts.push(`\nSide effects: ${response.sideEffects.join(", ")}`);
		}

		if (response.usageContext) {
			parts.push(`\nUsage: ${response.usageContext}`);
		}

		return parts.join("\n");
	}
}

// ============================================================================
// Factory Function
// ============================================================================

export function createSymbolSummaryExtractor(): SymbolSummaryExtractor {
	return new SymbolSummaryExtractor();
}
