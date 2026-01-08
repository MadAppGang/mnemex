/**
 * Summary Generator Base
 *
 * Wraps the existing enrichment extractors to provide benchmark-friendly
 * generation with timing and usage tracking.
 */

import type {
	CodeChunk,
	FileSummary,
	ILLMClient,
	SymbolSummary,
} from "../../types.js";
import type {
	GenerationResult,
	GeneratorInfo,
	ISummaryGenerator,
	UsageStats,
} from "../types.js";
import { FileSummaryExtractor } from "../../core/enrichment/extractors/file-summary.js";
import { SymbolSummaryExtractor } from "../../core/enrichment/extractors/symbol-summary.js";

// ============================================================================
// Summary Generator Implementation
// ============================================================================

/**
 * Summary generator that wraps existing extractors.
 * Tracks timing and usage for benchmark purposes.
 */
export class SummaryGenerator implements ISummaryGenerator {
	private llmClient: ILLMClient;
	private info: GeneratorInfo;
	private fileSummaryExtractor: FileSummaryExtractor;
	private symbolSummaryExtractor: SymbolSummaryExtractor;
	private accumulatedUsage: UsageStats;

	constructor(llmClient: ILLMClient, info: GeneratorInfo) {
		this.llmClient = llmClient;
		this.info = info;
		this.fileSummaryExtractor = new FileSummaryExtractor();
		this.symbolSummaryExtractor = new SymbolSummaryExtractor();
		this.accumulatedUsage = {
			inputTokens: 0,
			outputTokens: 0,
			cost: 0,
			calls: 0,
		};
	}

	async generateFileSummary(
		filePath: string,
		fileContent: string,
		language: string,
		codeChunks: CodeChunk[],
	): Promise<GenerationResult<FileSummary>> {
		// Reset LLM client usage tracking
		this.llmClient.resetAccumulatedUsage();
		const startTime = Date.now();

		try {
			// Use existing extractor
			const docs = await this.fileSummaryExtractor.extract(
				{
					filePath,
					fileContent,
					language,
					codeChunks,
					projectPath: "",
				},
				this.llmClient,
			);

			const durationMs = Date.now() - startTime;
			const usage = this.llmClient.getAccumulatedUsage();

			// Accumulate stats
			this.accumulateUsage(usage);

			if (docs.length === 0) {
				throw new Error("No file summary generated");
			}

			const result = docs[0] as FileSummary;

			return {
				result,
				durationMs,
				usage: {
					inputTokens: usage.inputTokens,
					outputTokens: usage.outputTokens,
					cost: usage.cost,
				},
			};
		} catch (error) {
			const durationMs = Date.now() - startTime;
			const usage = this.llmClient.getAccumulatedUsage();
			this.accumulateUsage(usage);

			throw new Error(
				`Failed to generate file summary for ${filePath}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}

	async generateSymbolSummary(
		chunk: CodeChunk,
		fileContent: string,
		language: string,
	): Promise<GenerationResult<SymbolSummary>> {
		// Reset LLM client usage tracking
		this.llmClient.resetAccumulatedUsage();
		const startTime = Date.now();

		try {
			// Use existing extractor with single chunk
			const docs = await this.symbolSummaryExtractor.extract(
				{
					filePath: chunk.filePath,
					fileContent,
					language,
					codeChunks: [chunk],
					projectPath: "",
				},
				this.llmClient,
			);

			const durationMs = Date.now() - startTime;
			const usage = this.llmClient.getAccumulatedUsage();

			// Accumulate stats
			this.accumulateUsage(usage);

			if (docs.length === 0) {
				throw new Error(`No symbol summary generated for ${chunk.name}`);
			}

			const result = docs[0] as SymbolSummary;

			return {
				result,
				durationMs,
				usage: {
					inputTokens: usage.inputTokens,
					outputTokens: usage.outputTokens,
					cost: usage.cost,
				},
			};
		} catch (error) {
			const durationMs = Date.now() - startTime;
			const usage = this.llmClient.getAccumulatedUsage();
			this.accumulateUsage(usage);

			throw new Error(
				`Failed to generate symbol summary for ${chunk.name}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}

	getInfo(): GeneratorInfo {
		return { ...this.info };
	}

	getUsage(): UsageStats {
		return { ...this.accumulatedUsage };
	}

	resetUsage(): void {
		this.accumulatedUsage = {
			inputTokens: 0,
			outputTokens: 0,
			cost: 0,
			calls: 0,
		};
	}

	private accumulateUsage(usage: {
		inputTokens: number;
		outputTokens: number;
		cost: number;
		calls: number;
	}): void {
		this.accumulatedUsage.inputTokens += usage.inputTokens;
		this.accumulatedUsage.outputTokens += usage.outputTokens;
		this.accumulatedUsage.cost += usage.cost;
		this.accumulatedUsage.calls += usage.calls;
	}
}
