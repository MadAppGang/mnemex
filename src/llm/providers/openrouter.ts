/**
 * OpenRouter LLM Provider
 *
 * Uses OpenRouter's chat completions API to access various models.
 * Reuses patterns from the embeddings OpenRouter client.
 *
 * Rate Limit Handling:
 * - Free models (:free suffix): 20 req/min, 50-1000 req/day based on credits
 * - Proactive limit checking via /api/v1/key endpoint
 * - Exponential backoff with jitter to prevent thundering herd
 * - Respects retry-after headers from 429 responses
 *
 * Error Categories:
 * - RateLimitError: 429 status, retry with backoff
 * - MaxTokensError: finish_reason=length with empty/truncated output
 * - ContentFilterError: Empty response from content filtering
 * - AuthError: 401/403, no retry
 * - PaymentError: 402, no retry
 */

import { BaseLLMClient, DEFAULT_LLM_MODELS } from "../client.js";
import { combineAbortSignals } from "../abort.js";
import type {
	LLMGenerateOptions,
	LLMMessage,
	LLMResponse,
} from "../../types.js";

// ============================================================================
// Types
// ============================================================================

interface OpenRouterOptions {
	/** API key for OpenRouter */
	apiKey?: string;
	/** Model to use */
	model?: string;
	/** Request timeout in ms */
	timeout?: number;
}

interface OpenRouterMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

interface OpenRouterResponse {
	id: string;
	choices: Array<{
		message: {
			role: "assistant";
			content: string;
		};
		finish_reason: string;
	}>;
	model: string;
	usage?: {
		prompt_tokens: number;
		completion_tokens: number;
		total_tokens: number;
	};
}

interface OpenRouterGenerationResponse {
	data: {
		total_cost: number;
		tokens_prompt: number;
		tokens_completion: number;
	};
}

/** Response from /api/v1/key endpoint for rate limit checking */
interface OpenRouterKeyInfo {
	data: {
		label?: string;
		limit?: number;
		limit_remaining?: number;
		is_free_tier?: boolean;
		rate_limit?: {
			requests: number;
			interval: string;
		};
	};
}

/** Model info from /api/v1/models endpoint */
interface OpenRouterModelInfo {
	id: string;
	name: string;
	description?: string;
	architecture?: {
		instruct_type?: string;
	};
	supported_parameters?: string[];
}

// ============================================================================
// Error Types for Better Categorization
// ============================================================================

/** Error thrown when max_tokens is exhausted (finish_reason: length) */
export class MaxTokensError extends Error {
	readonly model: string;
	readonly requestedTokens: number;

	constructor(model: string, requestedTokens: number, hasContent: boolean) {
		super(
			hasContent
				? `Response truncated for ${model} (hit max_tokens=${requestedTokens}). Consider increasing max_tokens.`
				: `${model} exhausted max_tokens=${requestedTokens} without producing output. ` +
						`This often happens with thinking models that use tokens for reasoning. ` +
						`Try increasing max_tokens significantly (e.g., 8192+).`,
		);
		this.name = "MaxTokensError";
		this.model = model;
		this.requestedTokens = requestedTokens;
	}
}

/** Error thrown when content is filtered by the provider */
export class ContentFilterError extends Error {
	readonly model: string;
	readonly finishReason: string;

	constructor(model: string, finishReason: string) {
		super(
			`Empty response from ${model} (finish_reason: ${finishReason}). ` +
				`Content was likely filtered by the model provider.`,
		);
		this.name = "ContentFilterError";
		this.model = model;
		this.finishReason = finishReason;
	}
}

/** Error thrown on rate limit (429) - retryable */
export class RateLimitError extends Error {
	readonly retryAfterMs?: number;
	readonly isFreeTier?: boolean;

	constructor(retryAfterMs?: number, isFreeTier?: boolean) {
		super(
			`OpenRouter rate limit exceeded` +
				(isFreeTier
					? ` (free tier - consider adding credits for higher limits)`
					: "") +
				(retryAfterMs
					? `. Retry after ${Math.ceil(retryAfterMs / 1000)}s`
					: ""),
		);
		this.name = "RateLimitError";
		this.retryAfterMs = retryAfterMs;
		this.isFreeTier = isFreeTier;
	}
}

// ============================================================================
// OpenRouter API Client
// ============================================================================

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/key";
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

// Rate limit retry settings (longer delays for free models)
const RATE_LIMIT_MAX_RETRIES = 5;
const RATE_LIMIT_BASE_DELAY_MS = 10000; // 10 seconds base delay for rate limits (was 5s)
const MAX_JITTER_FACTOR = 0.5; // Add up to 50% random jitter to prevent thundering herd

// Content filter retry settings (can be transient)
const CONTENT_FILTER_MAX_RETRIES = 2; // Only retry twice - if it's consistent, give up

// Thinking models need more tokens for reasoning
// These models use tokens for internal reasoning (chain-of-thought, <thinking> tags, etc.)
// before producing visible output

// Fallback patterns for when API metadata is unavailable
const THINKING_MODEL_FALLBACK_PATTERNS = [
	// Explicit thinking/reasoning models
	"thinking",
	"think",
	"reason",
	// Known reasoning models
	"kimi",
	"o1-",
	"o3-",
	"deepseek-r1",
	"qwq",
	// Models from error logs that use reasoning tokens
	"nemotron",
	"trinity",
	"olmo",
	// Super/large variants that often do extended reasoning
	"super",
	"ultra",
	// Other models known to use reasoning tokens
	"reflection",
	"cot", // chain-of-thought
];

// Known instruct types that indicate reasoning models
const REASONING_INSTRUCT_TYPES = ["deepseek-r1"];

// Thinking models need significantly more tokens - they use tokens for internal reasoning
// before producing visible output. 8192 was not enough for trinity-mini and nemotron-super.
const THINKING_MODEL_MIN_TOKENS = 16384; // 16K minimum for thinking models
const DEFAULT_MAX_TOKENS = 4096;

// Global cache for model metadata (shared across instances)
let cachedModelMetadata: Map<string, OpenRouterModelInfo> | null = null;
let modelMetadataFetchPromise: Promise<void> | null = null;
let modelMetadataLastFetch = 0;
const MODEL_METADATA_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // Cache for 24 hours

export class OpenRouterLLMClient extends BaseLLMClient {
	private apiKey: string;
	private cachedKeyInfo?: {
		data: OpenRouterKeyInfo["data"];
		fetchedAt: number;
	};
	private static readonly KEY_CACHE_TTL_MS = 60_000; // Cache key info for 1 minute

	constructor(options: OpenRouterOptions = {}) {
		super(
			"openrouter",
			options.model || DEFAULT_LLM_MODELS.openrouter,
			options.timeout || 120000,
		);

		const apiKey = options.apiKey || process.env.OPENROUTER_API_KEY;
		if (!apiKey) {
			throw new Error(
				"OpenRouter API key required. Set OPENROUTER_API_KEY environment variable or pass apiKey option.",
			);
		}
		this.apiKey = apiKey;
	}

	/**
	 * Fetch and cache model metadata from OpenRouter API.
	 * Called lazily on first thinking model check.
	 */
	private async fetchModelMetadata(): Promise<void> {
		// Check if cache is still valid
		if (
			cachedModelMetadata &&
			Date.now() - modelMetadataLastFetch < MODEL_METADATA_CACHE_TTL_MS
		) {
			return;
		}

		// Dedupe concurrent fetches
		if (modelMetadataFetchPromise) {
			return modelMetadataFetchPromise;
		}

		modelMetadataFetchPromise = (async () => {
			try {
				const response = await fetch(OPENROUTER_MODELS_URL);
				if (response.ok) {
					const data = (await response.json()) as {
						data: OpenRouterModelInfo[];
					};
					cachedModelMetadata = new Map();
					for (const model of data.data) {
						cachedModelMetadata.set(model.id, model);
					}
					modelMetadataLastFetch = Date.now();
					if (process.env.DEBUG_OPENROUTER) {
						console.log(
							`[OpenRouter] Cached metadata for ${cachedModelMetadata.size} models`,
						);
					}
				}
			} catch (error) {
				// Silently fail - we'll use fallback patterns
				if (process.env.DEBUG_OPENROUTER) {
					console.log(`[OpenRouter] Failed to fetch model metadata: ${error}`);
				}
			} finally {
				modelMetadataFetchPromise = null;
			}
		})();

		return modelMetadataFetchPromise;
	}

	/**
	 * Check if a model is a "thinking" model that needs more tokens.
	 * Uses OpenRouter API metadata when available, falls back to pattern matching.
	 *
	 * Detection methods (in order of reliability):
	 * 1. API metadata: supported_parameters includes "reasoning" or "include_reasoning"
	 * 2. API metadata: architecture.instruct_type is a known reasoning type
	 * 3. Fallback: model name matches known thinking model patterns
	 */
	private isThinkingModel(modelId: string): boolean {
		// Normalize model ID (remove provider prefix like "or/")
		const normalizedId = modelId.replace(/^or\//, "");

		// Check cached API metadata first
		if (cachedModelMetadata) {
			const modelInfo = cachedModelMetadata.get(normalizedId);
			if (modelInfo) {
				// Method 1: Check supported_parameters for reasoning
				if (
					modelInfo.supported_parameters?.some(
						(p) => p === "reasoning" || p === "include_reasoning",
					)
				) {
					return true;
				}

				// Method 2: Check instruct_type for known reasoning architectures
				if (
					modelInfo.architecture?.instruct_type &&
					REASONING_INSTRUCT_TYPES.includes(
						modelInfo.architecture.instruct_type,
					)
				) {
					return true;
				}

				// Model found in API but doesn't have reasoning indicators
				return false;
			}
		}

		// Method 3: Fallback to pattern matching
		const lowerModel = normalizedId.toLowerCase();
		return THINKING_MODEL_FALLBACK_PATTERNS.some((p) => lowerModel.includes(p));
	}

	/**
	 * Ensure model metadata is loaded (call before first request)
	 */
	private async ensureModelMetadata(): Promise<void> {
		if (!cachedModelMetadata) {
			await this.fetchModelMetadata();
		}
	}

	/**
	 * Get appropriate max_tokens for a model.
	 * For thinking models, enforces a minimum even if a lower value is requested,
	 * because thinking models use tokens for internal reasoning before producing output.
	 */
	private getMaxTokensForModel(
		modelId: string,
		requestedTokens?: number,
	): number {
		if (this.isThinkingModel(modelId)) {
			// Enforce minimum for thinking models - they need tokens for reasoning
			const minTokens = THINKING_MODEL_MIN_TOKENS;
			if (!requestedTokens || requestedTokens < minTokens) {
				if (process.env.DEBUG_OPENROUTER && requestedTokens) {
					console.log(
						`[OpenRouter] Bumping max_tokens from ${requestedTokens} to ${minTokens} ` +
							`for thinking model ${modelId}`,
					);
				}
				return minTokens;
			}
			return requestedTokens;
		}
		return requestedTokens || DEFAULT_MAX_TOKENS;
	}

	/**
	 * Proactively check rate limit status via /api/v1/key endpoint
	 * Caches result for 1 minute to avoid excessive API calls
	 */
	async checkRateLimitStatus(): Promise<{
		limitRemaining?: number;
		isFreeTier: boolean;
		rateLimit?: { requests: number; interval: string };
	}> {
		// Return cached info if still valid
		if (
			this.cachedKeyInfo &&
			Date.now() - this.cachedKeyInfo.fetchedAt <
				OpenRouterLLMClient.KEY_CACHE_TTL_MS
		) {
			return {
				limitRemaining: this.cachedKeyInfo.data.limit_remaining,
				isFreeTier: this.cachedKeyInfo.data.is_free_tier ?? true,
				rateLimit: this.cachedKeyInfo.data.rate_limit,
			};
		}

		try {
			const response = await fetch(OPENROUTER_KEY_URL, {
				headers: { Authorization: `Bearer ${this.apiKey}` },
			});

			if (response.ok) {
				const keyInfo = (await response.json()) as OpenRouterKeyInfo;
				this.cachedKeyInfo = { data: keyInfo.data, fetchedAt: Date.now() };
				return {
					limitRemaining: keyInfo.data.limit_remaining,
					isFreeTier: keyInfo.data.is_free_tier ?? true,
					rateLimit: keyInfo.data.rate_limit,
				};
			}
		} catch {
			// Silently fail - proactive check is optional
		}

		return { isFreeTier: true }; // Assume free tier if we can't check
	}

	async complete(
		messages: LLMMessage[],
		options?: LLMGenerateOptions,
	): Promise<LLMResponse> {
		const modelId = options?.model || this.model;

		// Ensure model metadata is loaded for thinking model detection
		await this.ensureModelMetadata();

		return this.withRateLimitRetry(async () => {
			// Convert messages to OpenRouter format
			const openRouterMessages = this.convertMessages(
				messages,
				options?.systemPrompt,
			);

			// Determine max_tokens - use higher value for thinking models
			const maxTokens = this.getMaxTokensForModel(modelId, options?.maxTokens);

			// Build request body
			const body = {
				model: modelId,
				messages: openRouterMessages,
				max_tokens: maxTokens,
				...(options?.temperature !== undefined && {
					temperature: options.temperature,
				}),
			};

			// Make API request
			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), this.timeout);
			const signal = combineAbortSignals(
				controller.signal,
				options?.abortSignal,
			);

			try {
				const response = await fetch(OPENROUTER_API_URL, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${this.apiKey}`,
						"HTTP-Referer": "https://github.com/mnemex",
						"X-Title": "mnemex",
					},
					body: JSON.stringify(body),
					signal,
				});

				clearTimeout(timeoutId);

				if (!response.ok) {
					const errorBody = await response.text();

					if (response.status === 401) {
						throw new Error("OpenRouter API key is invalid");
					} else if (response.status === 429) {
						// Parse retry-after header if available
						const retryAfter = response.headers.get("retry-after");
						const retryAfterMs = retryAfter
							? parseInt(retryAfter, 10) * 1000
							: undefined;
						// Check if we're on free tier for better error messaging
						const keyInfo = await this.checkRateLimitStatus();
						throw new RateLimitError(retryAfterMs, keyInfo.isFreeTier);
					} else if (response.status === 402) {
						throw new Error("OpenRouter payment required - check your credits");
					}

					// Extract message from JSON error body if possible
					let errorMsg = errorBody;
					try {
						const parsed = JSON.parse(errorBody);
						if (parsed?.error?.message) {
							errorMsg = parsed.error.message;
						}
					} catch {
						// Keep raw body if not JSON
					}
					throw new Error(
						`OpenRouter API error (${response.status}): ${errorMsg}`,
					);
				}

				const data = (await response.json()) as OpenRouterResponse;

				if (!data.choices || data.choices.length === 0) {
					throw new Error("OpenRouter returned empty response");
				}

				const content = data.choices[0].message.content;
				const finishReason = data.choices[0].finish_reason;

				// Categorize empty/truncated responses properly
				if (!content || content.trim() === "") {
					if (finishReason === "length") {
						// Model used all tokens on reasoning without producing output
						throw new MaxTokensError(body.model, maxTokens, false);
					} else {
						// Content was filtered by the provider
						throw new ContentFilterError(body.model, finishReason);
					}
				}

				// Check for truncation - throw specific error for better handling upstream
				if (finishReason === "length") {
					// Log but also provide structured error info
					console.warn(
						`[OpenRouter] Response truncated for ${body.model} ` +
							`(max_tokens=${maxTokens}). Output may be incomplete.`,
					);
					// Note: We still return the partial content - caller can decide what to do
				}

				// Fetch actual cost from OpenRouter's generation endpoint
				// Note: Data may not be immediately available, so we retry with delay
				let cost: number | undefined;
				let inputTokens = data.usage?.prompt_tokens;
				let outputTokens = data.usage?.completion_tokens;

				const fetchGenerationStats = async (
					retries = 3,
					delayMs = 300,
				): Promise<void> => {
					for (let attempt = 0; attempt < retries; attempt++) {
						if (attempt > 0) {
							await new Promise((resolve) => setTimeout(resolve, delayMs));
						}
						try {
							const genResponse = await fetch(
								`https://openrouter.ai/api/v1/generation?id=${data.id}`,
								{
									headers: {
										Authorization: `Bearer ${this.apiKey}`,
									},
								},
							);

							if (genResponse.ok) {
								const genData =
									(await genResponse.json()) as OpenRouterGenerationResponse;
								if (genData.data?.total_cost !== undefined) {
									cost = genData.data.total_cost;
									// Use native token counts from generation endpoint (more accurate)
									if (genData.data.tokens_prompt !== undefined) {
										inputTokens = genData.data.tokens_prompt;
									}
									if (genData.data.tokens_completion !== undefined) {
										outputTokens = genData.data.tokens_completion;
									}
									return; // Success, exit retry loop
								}
							}
						} catch {
							// Continue to next retry
						}
					}
				};

				await fetchGenerationStats();

				return {
					content,
					model: data.model,
					usage:
						inputTokens !== undefined && outputTokens !== undefined
							? {
									inputTokens,
									outputTokens,
									cost,
								}
							: undefined,
				};
			} catch (error) {
				clearTimeout(timeoutId);

				if (error instanceof Error && error.name === "AbortError") {
					throw new Error(
						`OpenRouter API request timed out after ${this.timeout}ms`,
					);
				}
				throw error;
			}
		});
	}

	/**
	 * Convert messages to OpenRouter format
	 */
	private convertMessages(
		messages: LLMMessage[],
		systemPrompt?: string,
	): OpenRouterMessage[] {
		const result: OpenRouterMessage[] = [];

		// Add system prompt if provided
		if (systemPrompt) {
			result.push({ role: "system", content: systemPrompt });
		}

		// Add all messages
		for (const msg of messages) {
			result.push({
				role: msg.role,
				content: msg.content,
			});
		}

		return result;
	}

	/**
	 * Add random jitter to a delay to prevent thundering herd
	 * Adds 0-50% additional delay randomly
	 */
	private addJitter(delayMs: number): number {
		const jitter = delayMs * MAX_JITTER_FACTOR * Math.random();
		return Math.floor(delayMs + jitter);
	}

	/**
	 * Retry with special handling for different error types.
	 *
	 * Retry strategy:
	 * - RateLimitError: 5 retries, 10s base delay with exponential backoff + jitter
	 * - ContentFilterError: 2 retries, 2s delay (can be transient, finish_reason: null)
	 * - MaxTokensError: NO retry (needs configuration change, not transient)
	 * - Auth/Payment errors: NO retry (configuration issue)
	 * - Other errors: 3 retries, 1s base delay with exponential backoff + jitter
	 */
	private async withRateLimitRetry<T>(fn: () => Promise<T>): Promise<T> {
		let lastError: Error | undefined;
		let contentFilterAttempts = 0;

		for (let attempt = 0; attempt < RATE_LIMIT_MAX_RETRIES; attempt++) {
			try {
				return await fn();
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error));

				// Don't retry on auth/payment errors (configuration issues)
				if (
					lastError.message.includes("401") ||
					lastError.message.includes("403") ||
					lastError.message.includes("invalid") ||
					lastError.message.includes("payment required")
				) {
					throw lastError;
				}

				// Don't retry MaxTokensError (needs configuration change)
				if (lastError instanceof MaxTokensError) {
					throw lastError;
				}

				// ContentFilterError: limited retries (can be transient with finish_reason: null)
				if (lastError instanceof ContentFilterError) {
					contentFilterAttempts++;
					if (contentFilterAttempts >= CONTENT_FILTER_MAX_RETRIES) {
						throw lastError; // Give up after limited retries
					}
					// Short delay before retry
					const delay = this.addJitter(2000);
					if (process.env.DEBUG_OPENROUTER) {
						console.log(
							`[OpenRouter] Content filter retry ${contentFilterAttempts}/${CONTENT_FILTER_MAX_RETRIES} ` +
								`after ${delay}ms: ${lastError.message.slice(0, 80)}`,
						);
					}
					await this.sleep(delay);
					continue;
				}

				// Check if it's a rate limit error
				const isRateLimit = lastError instanceof RateLimitError;

				if (attempt < RATE_LIMIT_MAX_RETRIES - 1) {
					// Use retry-after if available, otherwise exponential backoff with jitter
					const retryAfterMs = isRateLimit
						? (lastError as RateLimitError).retryAfterMs
						: undefined;

					const baseDelay = isRateLimit ? RATE_LIMIT_BASE_DELAY_MS : 1000;
					const exponentialDelay = baseDelay * Math.pow(2, attempt);
					const delay = this.addJitter(retryAfterMs || exponentialDelay);

					if (process.env.DEBUG_OPENROUTER) {
						console.log(
							`[OpenRouter] Retry ${attempt + 1}/${RATE_LIMIT_MAX_RETRIES} ` +
								`after ${delay}ms (${isRateLimit ? "rate limit" : "error"}): ` +
								`${lastError.message.slice(0, 80)}`,
						);
					}

					await this.sleep(delay);
				}
			}
		}

		throw lastError || new Error("Failed after retries");
	}

	/**
	 * Check rate limits before a batch operation.
	 * Returns true if we should proceed, false if we should wait.
	 */
	async shouldThrottle(): Promise<{
		throttle: boolean;
		waitMs?: number;
		reason?: string;
	}> {
		try {
			const status = await this.checkRateLimitStatus();

			// If credits are very low, warn
			if (status.limitRemaining !== undefined && status.limitRemaining < 0.01) {
				return {
					throttle: true,
					reason: "Credit balance is very low. Add credits to continue.",
				};
			}

			// Free tier has stricter limits
			if (status.isFreeTier && status.rateLimit) {
				// Free tier: 20 req/min max
				// If we're doing batch operations, suggest waiting between batches
				return {
					throttle: false,
					waitMs: 3000, // Suggest 3s between requests for free tier
					reason: "Free tier rate limits apply (20 req/min)",
				};
			}

			return { throttle: false };
		} catch {
			// If we can't check, proceed cautiously
			return { throttle: false };
		}
	}
}
