/**
 * Summary Generator
 *
 * Generates code summaries using LLM models for benchmark evaluation.
 * Uses prompts from /docs/prompts.md for consistency.
 */

import { randomUUID } from "crypto";
import type { ILLMClient, LLMMessage, LLMUsageStats } from "../../types.js";
import {
	GenerationError,
	ModelTimeoutError,
	InvalidResponseError,
} from "../errors.js";
import type {
	BenchmarkCodeUnit,
	GeneratedSummary,
	GenerationMetadata,
	ModelConfig,
	ISummaryGenerator,
} from "../types.js";

// ============================================================================
// Prompt Templates (from /docs/prompts.md)
// ============================================================================

const SYSTEM_PROMPT = `You are a senior software engineer writing documentation for a code search and retrieval system. Your summaries will be:

1. **Embedded as vectors** for semantic search - use terminology developers would search for
2. **Shown to AI coding assistants** as context - be precise about behavior and contracts
3. **Read by developers** to quickly understand unfamiliar code - prioritize clarity

## Writing Guidelines

**DO:**
- Describe WHAT the code does and WHY (purpose, intent, business logic)
- Mention inputs, outputs, return values, and their meanings
- Note important side effects (database writes, API calls, file I/O, state mutations)
- Include error conditions and edge cases when significant
- Use domain terminology that matches how developers think about the problem
- Mention relationships to other code when it aids understanding

**DON'T:**
- Describe HOW the code works (implementation details, algorithms used)
- Start with "This function..." or "This class..." - just describe what it does
- Be vague ("handles various operations", "processes data")
- Include obvious information derivable from the signature
- Repeat parameter names without adding meaning
- Add unnecessary qualifiers ("basically", "essentially", "simply")

## Length Guidelines
- Functions/Methods: 2-4 sentences
- Classes/Interfaces: 3-6 sentences
- Files/Modules: 4-8 sentences

## Output Format
Provide ONLY the summary text. No markdown formatting, no labels, no additional commentary.`;

const FUNCTION_PROMPT = `Write a summary for this {language} {unit_type}.

**Name:** {name}
**Signature:** {signature}
**File:** {file_path}
{visibility}
{async_marker}
{decorator_info}

\`\`\`{language}
{code}
\`\`\`

Summary:`;

const CLASS_PROMPT = `Write a summary for this {language} class.

**Name:** {name}
**File:** {file_path}
{inheritance_info}

\`\`\`{language}
{code}
\`\`\`

Summary:`;

const FILE_PROMPT = `Write a summary for this {language} file.

**Path:** {file_path}
{exports_info}

Summary:`;

// ============================================================================
// Summary Generator Class
// ============================================================================

export interface SummaryGeneratorOptions {
	/** LLM client for generation */
	llmClient: ILLMClient;
	/** Model configuration */
	modelConfig: ModelConfig;
	/** Prompt version identifier */
	promptVersion?: string;
	/** Timeout in milliseconds */
	timeout?: number;
}

export class SummaryGenerator implements ISummaryGenerator {
	private llmClient: ILLMClient;
	private modelConfig: ModelConfig;
	private promptVersion: string;
	private timeout: number;
	private usageStats: LLMUsageStats;

	constructor(options: SummaryGeneratorOptions) {
		this.llmClient = options.llmClient;
		this.modelConfig = options.modelConfig;
		this.promptVersion = options.promptVersion ?? "v1.0";
		this.timeout = options.timeout ?? 30000;
		this.usageStats = {
			inputTokens: 0,
			outputTokens: 0,
			cost: 0,
			calls: 0,
		};
	}

	/**
	 * Generate a summary for a code unit
	 */
	async generateSummary(
		codeUnit: BenchmarkCodeUnit,
		promptVersion?: string,
	): Promise<GeneratedSummary> {
		const startTime = Date.now();
		const prompt = this.buildPrompt(codeUnit);

		const messages: LLMMessage[] = [
			{ role: "system", content: SYSTEM_PROMPT },
			{ role: "user", content: prompt },
		];

		try {
			const response = await this.llmClient.complete(messages, {
				temperature: this.modelConfig.temperature,
				maxTokens: this.modelConfig.maxTokens,
			});

			const latencyMs = Date.now() - startTime;

			// Validate response
			const summary = response.content.trim();
			if (!summary || summary.length < 10) {
				throw new InvalidResponseError(
					this.modelConfig.id,
					"Summary too short or empty",
					summary,
				);
			}

			// Update usage stats
			if (response.usage) {
				this.usageStats.inputTokens += response.usage.inputTokens;
				this.usageStats.outputTokens += response.usage.outputTokens;
				this.usageStats.cost += response.usage.cost ?? 0;
			}
			this.usageStats.calls++;

			// Build generation metadata
			const metadata: GenerationMetadata = {
				modelName: this.modelConfig.modelName,
				modelVersion: this.modelConfig.id,
				promptVersion: promptVersion ?? this.promptVersion,
				temperature: this.modelConfig.temperature,
				maxTokens: this.modelConfig.maxTokens,
				generatedAt: new Date().toISOString(),
				latencyMs,
				inputTokens: response.usage?.inputTokens ?? 0,
				outputTokens: response.usage?.outputTokens ?? 0,
				cost: response.usage?.cost,
			};

			return {
				id: randomUUID(),
				codeUnitId: codeUnit.id,
				modelId: this.modelConfig.id,
				summary,
				generationMetadata: metadata,
			};
		} catch (error) {
			if (error instanceof GenerationError) {
				throw error;
			}

			const message = error instanceof Error ? error.message : String(error);

			// Check for timeout
			if (message.includes("timeout") || message.includes("ETIMEDOUT")) {
				throw new ModelTimeoutError(this.modelConfig.id, this.timeout);
			}

			throw new GenerationError(
				`Failed to generate summary: ${message}`,
				{ modelId: this.modelConfig.id, codeUnitId: codeUnit.id },
				error instanceof Error ? error : undefined,
			);
		}
	}

	/**
	 * Get model info
	 */
	getModelInfo(): ModelConfig {
		return { ...this.modelConfig };
	}

	/**
	 * Get accumulated usage stats
	 */
	getUsageStats(): LLMUsageStats {
		return { ...this.usageStats };
	}

	/**
	 * Reset usage tracking
	 */
	resetUsage(): void {
		this.usageStats = {
			inputTokens: 0,
			outputTokens: 0,
			cost: 0,
			calls: 0,
		};
	}

	// ==========================================================================
	// Prompt Building
	// ==========================================================================

	private buildPrompt(codeUnit: BenchmarkCodeUnit): string {
		switch (codeUnit.type) {
			case "function":
			case "method":
				return this.buildFunctionPrompt(codeUnit);
			case "class":
				return this.buildClassPrompt(codeUnit);
			case "file":
			case "module":
				return this.buildFilePrompt(codeUnit);
			default:
				return this.buildFunctionPrompt(codeUnit);
		}
	}

	private buildFunctionPrompt(codeUnit: BenchmarkCodeUnit): string {
		let prompt = FUNCTION_PROMPT.replace(/{language}/g, codeUnit.language)
			.replace("{unit_type}", codeUnit.type)
			.replace("{name}", codeUnit.name)
			.replace("{file_path}", codeUnit.path)
			.replace("{code}", this.truncateCode(codeUnit.content));

		// Signature
		if (codeUnit.metadata.signature) {
			prompt = prompt.replace("{signature}", codeUnit.metadata.signature);
		} else {
			prompt = prompt.replace("**Signature:** {signature}\n", "");
		}

		// Visibility
		if (codeUnit.metadata.visibility) {
			prompt = prompt.replace(
				"{visibility}",
				`**Visibility:** ${codeUnit.metadata.visibility}`,
			);
		} else {
			prompt = prompt.replace("{visibility}\n", "");
		}

		// Async marker
		if (codeUnit.metadata.isAsync) {
			prompt = prompt.replace("{async_marker}", "**Async:** Yes");
		} else {
			prompt = prompt.replace("{async_marker}\n", "");
		}

		// Decorators
		if (
			codeUnit.metadata.decorators &&
			codeUnit.metadata.decorators.length > 0
		) {
			prompt = prompt.replace(
				"{decorator_info}",
				`**Decorators:** ${codeUnit.metadata.decorators.join(", ")}`,
			);
		} else {
			prompt = prompt.replace("{decorator_info}\n", "");
		}

		return prompt;
	}

	private buildClassPrompt(codeUnit: BenchmarkCodeUnit): string {
		let prompt = CLASS_PROMPT.replace(/{language}/g, codeUnit.language)
			.replace("{name}", codeUnit.name)
			.replace("{file_path}", codeUnit.path)
			.replace("{code}", this.truncateCode(codeUnit.content));

		// Inheritance info (would need to be extracted from AST)
		prompt = prompt.replace("{inheritance_info}\n", "");

		return prompt;
	}

	private buildFilePrompt(codeUnit: BenchmarkCodeUnit): string {
		let prompt = FILE_PROMPT.replace(/{language}/g, codeUnit.language).replace(
			"{file_path}",
			codeUnit.path,
		);

		// Exports info
		if (codeUnit.metadata.exports && codeUnit.metadata.exports.length > 0) {
			prompt = prompt.replace(
				"{exports_info}",
				`**Exports:** ${codeUnit.metadata.exports.join(", ")}`,
			);
		} else {
			prompt = prompt.replace("{exports_info}\n", "");
		}

		return prompt;
	}

	private truncateCode(code: string): string {
		const maxLength = 4000;
		if (code.length > maxLength) {
			return code.slice(0, maxLength) + "\n// ... (truncated)";
		}
		return code;
	}
}

// ============================================================================
// Factory Function
// ============================================================================

export function createSummaryGenerator(
	options: SummaryGeneratorOptions,
): SummaryGenerator {
	return new SummaryGenerator(options);
}
