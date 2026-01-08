/**
 * LLM Resolver
 *
 * Central registry for model spec parsing, provider detection, alias resolution,
 * and LLM client creation. Used by both judges and generators for consistent
 * handling of model specifications.
 */

import type { ILLMClient, LLMProvider } from "../types.js";
import { createLLMClient, type LLMClientOptions } from "./client.js";

// ============================================================================
// Types
// ============================================================================

/**
 * Parsed LLM specification with all resolved values
 */
export interface LLMSpec {
	/** Canonical provider */
	provider: LLMProvider;
	/** Resolved model ID (with aliases expanded) */
	model: string;
	/** Custom endpoint (for local providers) */
	endpoint?: string;
	/** Human-readable display name */
	displayName: string;
}

// ============================================================================
// Constants
// ============================================================================

/** Provider aliases - short names to canonical providers */
const PROVIDER_ALIASES: Record<string, LLMProvider> = {
	anthropic: "anthropic",
	claude: "anthropic",
	a: "anthropic",
	"anthropic-batch": "anthropic-batch",
	abatch: "anthropic-batch",
	batch: "anthropic-batch",
	openrouter: "openrouter",
	or: "openrouter",
	ollama: "local",
	local: "local",
	lmstudio: "local",
	"claude-code": "claude-code",
	cc: "claude-code",
};

/** Claude model aliases */
const CLAUDE_ALIASES: Record<string, string> = {
	opus: "claude-opus-4-5",
	"opus-4": "claude-opus-4-5",
	"opus-4.5": "claude-opus-4-5",
	sonnet: "claude-sonnet-4-5",
	"sonnet-4": "claude-sonnet-4-5",
	"sonnet-4.5": "claude-sonnet-4-5",
	haiku: "claude-haiku-4-5",
	"haiku-4": "claude-haiku-4-5",
	"haiku-4.5": "claude-haiku-4-5",
};

/** Local provider endpoints */
const LOCAL_ENDPOINTS: Record<string, string> = {
	ollama: "http://localhost:11434/v1",
	lmstudio: "http://localhost:1234/v1",
};

/** Provider display names */
const PROVIDER_DISPLAY_NAMES: Record<LLMProvider, string> = {
	anthropic: "Anthropic",
	"anthropic-batch": "Batch",
	openrouter: "OpenRouter",
	local: "Local",
	"claude-code": "Claude Code",
};

/** Custom user-defined aliases */
const customAliases = new Map<
	string,
	{ provider: LLMProvider; model: string }
>();

// ============================================================================
// LLM Resolver Class
// ============================================================================

/**
 * Central registry for LLM model specs and client creation.
 *
 * Handles:
 * - Model spec parsing (e.g., "a/opus" → anthropic/claude-opus-4-5)
 * - Provider detection and normalization
 * - Model alias resolution
 * - Display name formatting
 * - Client creation convenience method
 */
export class LLMResolver {
	// ========== Model Spec Parsing ==========

	/**
	 * Parse a model specification string into provider, model, and endpoint.
	 *
	 * Supported formats:
	 * - "a/sonnet" → { provider: "anthropic", model: "claude-sonnet-4-5" }
	 * - "cc/sonnet" → { provider: "claude-code", model: "claude-sonnet-4-5" }
	 * - "batch/opus" → { provider: "anthropic-batch", model: "claude-opus-4-5" }
	 * - "or/openai/gpt-4o" → { provider: "openrouter", model: "openai/gpt-4o" }
	 * - "ollama/llama3.2" → { provider: "local", endpoint: "localhost:11434" }
	 * - "claude-sonnet-4-5" → Auto-detect provider as anthropic
	 */
	static parseSpec(spec: string): LLMSpec {
		// Check custom aliases first
		const customAlias = customAliases.get(spec.toLowerCase());
		if (customAlias) {
			return {
				provider: customAlias.provider,
				model: customAlias.model,
				displayName: this.formatDisplayName(
					customAlias.provider,
					customAlias.model,
				),
			};
		}

		const parts = spec.split("/");
		const prefix = parts[0].toLowerCase();

		// Handle explicit provider prefixes
		if (prefix === "batch" || prefix === "abatch") {
			const modelAlias = parts.slice(1).join("/") || "sonnet";
			const model = this.resolveModelAlias(modelAlias, "anthropic-batch");
			return {
				provider: "anthropic-batch",
				model,
				displayName: this.formatDisplayName("anthropic-batch", model),
			};
		}

		if (prefix === "a") {
			const modelAlias = parts.slice(1).join("/") || "sonnet";
			const model = this.resolveModelAlias(modelAlias, "anthropic");
			return {
				provider: "anthropic",
				model,
				displayName: this.formatDisplayName("anthropic", model),
			};
		}

		if (prefix === "cc") {
			const modelAlias = parts.slice(1).join("/") || "sonnet";
			const model = this.resolveModelAlias(modelAlias, "claude-code");
			return {
				provider: "claude-code",
				model,
				displayName: this.formatDisplayName("claude-code", model),
			};
		}

		if (prefix === "or") {
			const model = parts.slice(1).join("/");
			return {
				provider: "openrouter",
				model,
				displayName: this.formatDisplayName("openrouter", model),
			};
		}

		if (prefix === "ollama") {
			const model = parts.length > 1 ? parts.slice(1).join("/") : "llama3.2";
			return {
				provider: "local",
				model,
				endpoint: LOCAL_ENDPOINTS.ollama,
				displayName: this.formatDisplayName("local", model),
			};
		}

		if (prefix === "lmstudio") {
			const model = parts.length > 1 ? parts.slice(1).join("/") : undefined;
			return {
				provider: "local",
				model: model || "default",
				endpoint: LOCAL_ENDPOINTS.lmstudio,
				displayName: this.formatDisplayName("local", model || "default"),
			};
		}

		// Check if first part is a known provider alias
		if (PROVIDER_ALIASES[prefix]) {
			const provider = PROVIDER_ALIASES[prefix];
			const model = parts.slice(1).join("/") || this.getDefaultModel(provider);
			const resolvedModel = this.resolveModelAlias(model, provider);
			return {
				provider,
				model: resolvedModel,
				displayName: this.formatDisplayName(provider, resolvedModel),
			};
		}

		// No explicit provider prefix - try to detect from model name
		if (parts.length === 1) {
			const provider = this.detectProvider(spec);
			const model = this.resolveModelAlias(spec, provider);
			return {
				provider,
				model,
				displayName: this.formatDisplayName(provider, model),
			};
		}

		// provider/model format (e.g., "openai/gpt-4o" for OpenRouter)
		const provider = this.normalizeProvider(parts[0]);
		const model = parts.slice(1).join("/");
		return {
			provider,
			model: parts.join("/"), // Keep full path for OpenRouter models
			displayName: this.formatDisplayName(provider, model),
		};
	}

	// ========== Provider Detection ==========

	/**
	 * Detect provider from model name using pattern matching.
	 * Used as fallback when no explicit prefix is provided.
	 */
	static detectProvider(modelOrSpec: string): LLMProvider {
		const normalized = modelOrSpec.toLowerCase();

		// Check explicit provider prefixes first
		if (
			normalized.startsWith("openai/") ||
			normalized.startsWith("google/") ||
			normalized.startsWith("meta-llama/")
		) {
			return "openrouter";
		}

		// Check for Anthropic models
		if (normalized.includes("claude")) {
			return "anthropic";
		}

		// Check for Claude model short names - default to claude-code for subscription usage
		if (
			normalized === "opus" ||
			normalized.startsWith("opus-") ||
			normalized === "sonnet" ||
			normalized.startsWith("sonnet-") ||
			normalized === "haiku" ||
			normalized.startsWith("haiku-")
		) {
			return "claude-code";
		}

		// Check for OpenAI models via OpenRouter
		if (
			normalized.includes("gpt") ||
			normalized.includes("o1-") ||
			normalized.startsWith("o1")
		) {
			return "openrouter";
		}

		// Check for Gemini
		if (normalized.includes("gemini")) {
			return "openrouter";
		}

		// Check for local models
		if (
			normalized.includes("llama") ||
			normalized.includes("mistral") ||
			normalized.includes("codellama") ||
			normalized.includes("qwen")
		) {
			return "local";
		}

		// Default to OpenRouter for unknown models
		return "openrouter";
	}

	/**
	 * Normalize provider name to canonical LLMProvider type.
	 */
	static normalizeProvider(name: string): LLMProvider {
		const normalized = name.toLowerCase();
		return PROVIDER_ALIASES[normalized] || "openrouter";
	}

	// ========== Model Alias Resolution ==========

	/**
	 * Resolve model alias to full model ID.
	 * E.g., "sonnet" → "claude-sonnet-4-5" for anthropic provider
	 * For claude-code provider, returns short names (haiku, sonnet, opus) - the provider resolves to full IDs
	 */
	static resolveModelAlias(alias: string, provider: LLMProvider): string {
		const normalized = alias.toLowerCase();

		// Claude Code uses short names - the provider itself resolves to full API model IDs
		if (provider === "claude-code") {
			if (normalized.includes("haiku")) return "haiku";
			if (normalized.includes("opus")) return "opus";
			if (normalized.includes("sonnet")) return "sonnet";
			return alias;
		}

		// Check Claude aliases for Anthropic providers
		if (provider === "anthropic" || provider === "anthropic-batch") {
			if (CLAUDE_ALIASES[normalized]) {
				return CLAUDE_ALIASES[normalized];
			}
		}

		// No alias found, return as-is
		return alias;
	}

	/**
	 * Register a custom alias for user-defined shortcuts.
	 * E.g., registerAlias("fast", "anthropic", "claude-haiku-4-5")
	 */
	static registerAlias(
		alias: string,
		provider: LLMProvider,
		model: string,
	): void {
		customAliases.set(alias.toLowerCase(), { provider, model });
	}

	/**
	 * Clear all custom aliases.
	 */
	static clearCustomAliases(): void {
		customAliases.clear();
	}

	// ========== Display Name Formatting ==========

	/**
	 * Format a human-readable display name.
	 * E.g., ("anthropic", "claude-sonnet-4-5") → "claude-sonnet-4-5 (Anthropic)"
	 */
	static formatDisplayName(provider: LLMProvider, model: string): string {
		const providerName = PROVIDER_DISPLAY_NAMES[provider] || provider;
		const shortModel = model.split("/").pop() || model;
		return `${shortModel} (${providerName})`;
	}

	// ========== Client Creation ==========

	/**
	 * Parse spec and create LLM client in one call.
	 *
	 * @example
	 * const client = await LLMResolver.createClient("a/opus");
	 * const client = await LLMResolver.createClient("cc/sonnet");
	 * const client = await LLMResolver.createClient("or/openai/gpt-4o");
	 */
	static async createClient(
		spec: string,
		options?: Partial<LLMClientOptions>,
	): Promise<ILLMClient> {
		const parsed = this.parseSpec(spec);

		return createLLMClient({
			provider: options?.provider || parsed.provider,
			model: options?.model || parsed.model,
			endpoint: options?.endpoint || parsed.endpoint,
			...options,
		});
	}

	// ========== Batch Operations ==========

	/**
	 * Parse multiple specs at once.
	 * Useful for consensus judges or multi-generator benchmarks.
	 */
	static parseSpecs(specs: string[]): LLMSpec[] {
		return specs.map((spec) => this.parseSpec(spec));
	}

	/**
	 * Create multiple clients from specs.
	 */
	static async createClients(
		specs: string[],
		options?: Partial<LLMClientOptions>,
	): Promise<ILLMClient[]> {
		return Promise.all(specs.map((spec) => this.createClient(spec, options)));
	}

	// ========== Utility Methods ==========

	/**
	 * Get default model for a provider.
	 */
	private static getDefaultModel(provider: LLMProvider): string {
		const defaults: Record<LLMProvider, string> = {
			anthropic: "claude-sonnet-4-5",
			"anthropic-batch": "claude-sonnet-4-5",
			"claude-code": "sonnet", // Short name - provider resolves to full API model ID
			openrouter: "anthropic/claude-sonnet-4",
			local: "llama3.2",
		};
		return defaults[provider] || "claude-sonnet-4-5";
	}

	/**
	 * Check if a spec represents a local provider.
	 */
	static isLocalProvider(spec: string): boolean {
		const parsed = this.parseSpec(spec);
		return parsed.provider === "local";
	}

	/**
	 * Check if a spec represents a cloud provider.
	 */
	static isCloudProvider(spec: string): boolean {
		return !this.isLocalProvider(spec);
	}
}
