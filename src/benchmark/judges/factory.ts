/**
 * Judge Factory
 *
 * Creates judge instances for evaluating summary quality.
 * Uses LLMResolver for consistent model spec parsing.
 */

import { LLMResolver } from "../../llm/resolver.js";
import type { LLMProvider } from "../../types.js";
import type { IJudge } from "../types.js";
import { LLMJudge } from "./llm-judge.js";
import { ConsensusJudge, type AggregationMethod } from "./consensus-judge.js";
import { BlindJudge } from "./blind-judge.js";

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create an LLM judge for the specified model.
 *
 * @param model - Model identifier (e.g., "claude-sonnet-4", "openai/gpt-4o", "a/opus", "cc/sonnet")
 * @param provider - Optional provider override (auto-detected from model if not specified)
 */
export async function createJudge(
	model: string,
	provider?: LLMProvider,
): Promise<IJudge> {
	// Use LLMResolver for consistent spec parsing
	const client = await LLMResolver.createClient(
		model,
		provider ? { provider } : undefined,
	);
	return new LLMJudge(client);
}

/**
 * Create a consensus judge from multiple models.
 *
 * @param models - Array of model identifiers
 * @param aggregation - Aggregation method (default: "median")
 */
export async function createConsensusJudge(
	models: string[],
	aggregation: AggregationMethod = "median",
): Promise<IJudge> {
	const judges = await Promise.all(models.map((model) => createJudge(model)));

	return new ConsensusJudge(judges, aggregation);
}

/**
 * Create a blind judge wrapper.
 *
 * @param model - Model identifier for the underlying judge
 */
export async function createBlindJudge(model: string): Promise<IJudge> {
	const innerJudge = await createJudge(model);
	return new BlindJudge(innerJudge);
}

/**
 * Parse judge specification and create appropriate judge.
 * Supports formats:
 * - "claude-sonnet-4" -> Single LLM judge
 * - "a/opus" -> Single LLM judge with Anthropic provider
 * - "cc/sonnet" -> Single LLM judge with Claude Code provider
 * - "claude-sonnet-4,gpt-4o" -> Consensus judge
 * - "blind:claude-sonnet-4" -> Blind judge
 * - "consensus:median:claude-sonnet-4,gpt-4o" -> Consensus with method
 */
export async function parseAndCreateJudge(spec: string): Promise<IJudge> {
	// Check for blind prefix
	if (spec.startsWith("blind:")) {
		const model = spec.slice(6);
		return createBlindJudge(model);
	}

	// Check for consensus prefix
	if (spec.startsWith("consensus:")) {
		const rest = spec.slice(10);
		const parts = rest.split(":");

		if (parts.length === 2) {
			// consensus:method:models
			const method = parts[0] as AggregationMethod;
			const models = parts[1].split(",").map((m) => m.trim());
			return createConsensusJudge(models, method);
		} else {
			// consensus:models (default method)
			const models = parts[0].split(",").map((m) => m.trim());
			return createConsensusJudge(models);
		}
	}

	// Check for comma-separated models (implicit consensus)
	if (spec.includes(",")) {
		const models = spec.split(",").map((m) => m.trim());
		return createConsensusJudge(models);
	}

	// Single model
	return createJudge(spec);
}

// ============================================================================
// Predefined Judge Configurations
// ============================================================================

/** Default judge model (Claude Sonnet 4) */
export const DEFAULT_JUDGE_MODEL = "claude-sonnet-4-20250514";

/** Popular judge configurations */
export const POPULAR_JUDGES = {
	claudeSonnet: "claude-sonnet-4-20250514",
	claudeHaiku: "claude-3-5-haiku-20241022",
	gpt4o: "openai/gpt-4o",
	gemini: "google/gemini-pro-1.5",
};
