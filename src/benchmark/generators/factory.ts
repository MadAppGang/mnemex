/**
 * Generator Factory
 *
 * Creates summary generators for different LLM providers.
 * Uses LLMResolver for consistent model spec parsing.
 */

import { createLLMClient, DEFAULT_LLM_MODELS } from "../../llm/client.js";
import { LLMResolver } from "../../llm/resolver.js";
import type { LLMProvider } from "../../types.js";
import type { GeneratorInfo, ISummaryGenerator } from "../types.js";
import { SummaryGenerator } from "./base.js";

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create a summary generator for the specified provider and model.
 *
 * @param provider - LLM provider (anthropic, anthropic-batch, openrouter, ollama, local)
 * @param model - Model identifier (defaults to provider's default)
 * @param displayName - Human-readable name (auto-generated if not provided)
 * @param endpoint - Custom API endpoint (for local providers like LM Studio)
 */
export async function createGenerator(
	provider: LLMProvider,
	model?: string,
	displayName?: string,
	endpoint?: string,
): Promise<ISummaryGenerator> {
	const resolvedModel = model || DEFAULT_LLM_MODELS[provider];
	const resolvedDisplayName =
		displayName || LLMResolver.formatDisplayName(provider, resolvedModel);

	const info: GeneratorInfo = {
		provider,
		model: resolvedModel,
		displayName: resolvedDisplayName,
	};

	// Special handling for batch provider
	if (provider === "anthropic-batch") {
		const { AnthropicBatchLLMClient } = await import(
			"../../llm/providers/anthropic-batch.js"
		);
		const { BatchSummaryGenerator } = await import("./batch.js");

		const batchClient = new AnthropicBatchLLMClient({ model: resolvedModel });
		return new BatchSummaryGenerator(batchClient, info);
	}

	// Standard provider
	const llmClient = await createLLMClient({
		provider,
		model: resolvedModel,
		endpoint,
	});

	return new SummaryGenerator(llmClient, info);
}

/**
 * Create a summary generator from a spec string.
 * Convenience method that parses the spec and creates the generator.
 *
 * @param spec - Model specification (e.g., "a/opus", "cc/sonnet", "or/openai/gpt-4o")
 * @param displayName - Optional display name override
 */
export async function createGeneratorFromSpec(
	spec: string,
	displayName?: string,
): Promise<ISummaryGenerator> {
	const parsed = LLMResolver.parseSpec(spec);
	return createGenerator(
		parsed.provider,
		parsed.model,
		displayName || parsed.displayName,
		parsed.endpoint,
	);
}

/**
 * Create multiple generators from a list of configurations.
 */
export async function createGenerators(
	configs: Array<{
		provider: LLMProvider;
		model?: string;
		displayName?: string;
		endpoint?: string;
	}>,
): Promise<ISummaryGenerator[]> {
	const generators = await Promise.all(
		configs.map((config) =>
			createGenerator(
				config.provider,
				config.model,
				config.displayName,
				config.endpoint,
			),
		),
	);
	return generators;
}

/**
 * Create multiple generators from spec strings.
 */
export async function createGeneratorsFromSpecs(
	specs: string[],
): Promise<ISummaryGenerator[]> {
	return Promise.all(specs.map((spec) => createGeneratorFromSpec(spec)));
}

/**
 * Parse generator specification string into provider and model.
 *
 * @deprecated Use LLMResolver.parseSpec() instead for full LLMSpec with displayName
 *
 * Supports formats:
 * - "anthropic" or "a" -> anthropic provider, default model (sonnet)
 * - "a/sonnet" -> anthropic provider, claude-sonnet-4-5
 * - "a/opus" -> anthropic provider, claude-opus-4-5
 * - "a/haiku" -> anthropic provider, claude-haiku-4-5
 * - "abatch/sonnet" or "batch/sonnet" -> anthropic-batch provider
 * - "cc/sonnet" -> claude-code provider with model
 * - "openrouter/openai/gpt-4o" or "or/openai/gpt-4o" -> openrouter provider
 * - "ollama/llama3.2" -> local provider with Ollama endpoint
 * - "lmstudio/model" -> local provider with LM Studio endpoint
 */
export function parseGeneratorSpec(spec: string): {
	provider: LLMProvider;
	model?: string;
	endpoint?: string;
} {
	const parsed = LLMResolver.parseSpec(spec);
	return {
		provider: parsed.provider,
		model: parsed.model,
		endpoint: parsed.endpoint,
	};
}

// ============================================================================
// Predefined Generator Configurations
// ============================================================================

/** Default generators for quick benchmarking */
export const DEFAULT_GENERATORS: Array<{
	provider: LLMProvider;
	model?: string;
	displayName?: string;
}> = [
	{
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		displayName: "Claude Sonnet 4.5",
	},
];

/** Popular model configurations for comprehensive benchmarking */
export const POPULAR_GENERATORS: Array<{
	provider: LLMProvider;
	model?: string;
	displayName?: string;
}> = [
	{
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		displayName: "Claude Sonnet 4.5",
	},
	{
		provider: "anthropic",
		model: "claude-haiku-4-5",
		displayName: "Claude Haiku 4.5",
	},
	{ provider: "openrouter", model: "openai/gpt-4o", displayName: "GPT-4o" },
	{
		provider: "openrouter",
		model: "openai/gpt-4o-mini",
		displayName: "GPT-4o Mini",
	},
	{
		provider: "openrouter",
		model: "google/gemini-pro-1.5",
		displayName: "Gemini Pro 1.5",
	},
	{
		provider: "openrouter",
		model: "meta-llama/llama-3.3-70b-instruct",
		displayName: "Llama 3.3 70B",
	},
	{ provider: "local", model: "llama3.2", displayName: "Llama 3.2 (Local)" },
];
