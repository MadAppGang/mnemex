/**
 * File Summary Extractor
 *
 * Generates high-level summaries of source files.
 * Extracts: purpose, responsibilities, exports, dependencies, patterns.
 * Supports both single-file and batched extraction for efficiency.
 */

import type {
	BaseDocument,
	ExtractionContext,
	FileSummary,
	ILLMClient,
	CodeChunk,
} from "../../../types.js";
import {
	buildFileSummaryPrompt,
	buildBatchedFileSummaryPrompt,
	BATCHED_FILE_SUMMARY_SYSTEM_PROMPT,
	getSystemPrompt,
	type BatchFileInfo,
} from "../../../llm/prompts/enrichment.js";
import { BaseExtractor } from "./base.js";

// ============================================================================
// Types
// ============================================================================

interface FileSummaryLLMResponse {
	summary: string;
	responsibilities: string[];
	exports: string[];
	dependencies: string[];
	patterns: string[];
}

/** Response format for batched file summaries */
interface BatchedFileSummaryResponse extends FileSummaryLLMResponse {
	filePath: string;
}

// ============================================================================
// File Summary Extractor
// ============================================================================

export class FileSummaryExtractor extends BaseExtractor {
	constructor() {
		super("file_summary", ["code_chunk"]);
	}

	async extract(
		context: ExtractionContext,
		llmClient: ILLMClient,
	): Promise<BaseDocument[]> {
		// Skip if no code chunks
		if (context.codeChunks.length === 0) {
			return [];
		}

		try {
			// Build prompt
			const userPrompt = buildFileSummaryPrompt(
				context.filePath,
				context.fileContent,
				context.language,
			);

			// Call LLM
			const response = await llmClient.completeJSON<FileSummaryLLMResponse>(
				[{ role: "user", content: userPrompt }],
				{ systemPrompt: getSystemPrompt("file_summary") },
			);

			// Create document
			const content = this.buildContent(context.filePath, response);
			const id = this.generateId(content, context.filePath);

			const doc: FileSummary = {
				id,
				content,
				documentType: "file_summary",
				filePath: context.filePath,
				fileHash: context.codeChunks[0]?.fileHash,
				createdAt: new Date().toISOString(),
				enrichedAt: new Date().toISOString(),
				sourceIds: context.codeChunks.map((c) => c.id),
				language: context.language,
				summary: response.summary,
				responsibilities: response.responsibilities || [],
				exports: response.exports || [],
				dependencies: response.dependencies || [],
				patterns: response.patterns || [],
			};

			return [doc];
		} catch (error) {
			// Re-throw with context so caller sees the actual error
			throw new Error(
				`LLM error: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	/**
	 * Extract file summaries for multiple files in a single LLM call.
	 * Much more efficient than calling extract() for each file separately.
	 *
	 * @param files - Array of file info with content and chunks
	 * @param llmClient - LLM client for generation
	 * @returns Array of FileSummary documents for all files
	 */
	async extractBatch(
		files: Array<{
			filePath: string;
			fileContent: string;
			language: string;
			codeChunks: CodeChunk[];
		}>,
		llmClient: ILLMClient,
	): Promise<FileSummary[]> {
		if (files.length === 0) {
			return [];
		}

		// For single file, use regular extraction
		if (files.length === 1) {
			const file = files[0];
			const docs = await this.extract(
				{
					filePath: file.filePath,
					fileContent: file.fileContent,
					language: file.language,
					codeChunks: file.codeChunks,
					projectPath: "",
				},
				llmClient,
			);
			return docs as FileSummary[];
		}

		try {
			// Build batched prompt
			const batchInfo: BatchFileInfo[] = files.map((f) => ({
				filePath: f.filePath,
				fileContent: f.fileContent,
				language: f.language,
			}));

			const userPrompt = buildBatchedFileSummaryPrompt(batchInfo);

			// Call LLM with batched prompt
			const responses = await llmClient.completeJSON<
				BatchedFileSummaryResponse[]
			>([{ role: "user", content: userPrompt }], {
				systemPrompt: BATCHED_FILE_SUMMARY_SYSTEM_PROMPT,
			});

			// Convert responses to documents
			const documents: FileSummary[] = [];

			for (let i = 0; i < files.length; i++) {
				const file = files[i];
				// Match response by filePath or index
				const response =
					responses.find((r) => r.filePath === file.filePath) || responses[i];

				if (!response) {
					console.warn(`No summary returned for ${file.filePath}`);
					continue;
				}

				const content = this.buildContent(file.filePath, response);
				const id = this.generateId(content, file.filePath);

				documents.push({
					id,
					content,
					documentType: "file_summary",
					filePath: file.filePath,
					fileHash: file.codeChunks[0]?.fileHash,
					createdAt: new Date().toISOString(),
					enrichedAt: new Date().toISOString(),
					sourceIds: file.codeChunks.map((c) => c.id),
					language: file.language,
					summary: response.summary,
					responsibilities: response.responsibilities || [],
					exports: response.exports || [],
					dependencies: response.dependencies || [],
					patterns: response.patterns || [],
				});
			}

			return documents;
		} catch (error) {
			// Re-throw with context so caller sees the actual error
			throw new Error(
				`LLM error: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	/**
	 * Build searchable content from the summary
	 */
	private buildContent(
		filePath: string,
		response: FileSummaryLLMResponse,
	): string {
		const parts = [`File: ${filePath}`, `\nSummary: ${response.summary}`];

		if (response.responsibilities?.length > 0) {
			parts.push(
				`\nResponsibilities:\n${response.responsibilities.map((r) => `- ${r}`).join("\n")}`,
			);
		}

		if (response.exports?.length > 0) {
			parts.push(`\nExports: ${response.exports.join(", ")}`);
		}

		if (response.dependencies?.length > 0) {
			parts.push(`\nDependencies: ${response.dependencies.join(", ")}`);
		}

		if (response.patterns?.length > 0) {
			parts.push(`\nPatterns: ${response.patterns.join(", ")}`);
		}

		return parts.join("\n");
	}
}

// ============================================================================
// Factory Function
// ============================================================================

export function createFileSummaryExtractor(): FileSummaryExtractor {
	return new FileSummaryExtractor();
}
