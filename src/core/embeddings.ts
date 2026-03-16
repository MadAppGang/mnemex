/**
 * Embeddings Client
 *
 * Multi-provider embedding generation supporting:
 * - OpenRouter (cloud API)
 * - Voyage AI (cloud API for code/legal/finance)
 * - Ollama (local)
 * - Custom endpoints (local HTTP servers)
 */

import {
	DEFAULT_EMBEDDING_MODEL,
	OPENROUTER_EMBEDDINGS_URL,
	OPENROUTER_HEADERS,
	VOYAGE_EMBEDDINGS_URL,
	getApiKey,
	getVoyageApiKey,
	loadGlobalConfig,
} from "../config.js";
import type {
	EmbeddingProgressCallback,
	EmbeddingProvider,
	EmbeddingResponse,
	EmbedResult,
	IEmbeddingsClient,
} from "../types.js";

/** Local embedding providers (no network API call to cloud) */
const LOCAL_EMBEDDING_PROVIDERS: Set<EmbeddingProvider> = new Set([
	"ollama",
	"lmstudio",
	"local",
]);

// ============================================================================
// Constants
// ============================================================================

/** Maximum texts per batch request (OpenRouter) - smaller = more granular progress */
const MAX_BATCH_SIZE = 20;

/** Maximum retries for failed requests */
const MAX_RETRIES = 3;

/** Base delay for exponential backoff (ms) */
const BASE_RETRY_DELAY = 1000;

/** Default embedding model per provider */
const DEFAULT_MODELS: Record<EmbeddingProvider, string> = {
	openrouter: "qwen/qwen3-embedding-8b",
	ollama: "nomic-embed-text",
	lmstudio: "text-embedding-nomic-embed-text-v1.5",
	local: "all-minilm-l6-v2",
	voyage: "voyage-code-3",
};

/** Default endpoints */
const DEFAULT_OLLAMA_ENDPOINT = "http://localhost:11434";
const DEFAULT_LOCAL_ENDPOINT = "http://localhost:8000";

/** Known context lengths (in tokens) for common models */
const MODEL_CONTEXT_LENGTHS: Record<string, number> = {
	// Voyage models - 32K context
	"voyage-code-3": 32000,
	"voyage-3-large": 32000,
	"voyage-3.5": 32000,
	"voyage-3.5-lite": 32000,
	"voyage-finance-2": 32000,
	"voyage-law-2": 16000,
	"voyage-code-2": 16000,
	// OpenAI via OpenRouter - 8K context
	"openai/text-embedding-3-small": 8191,
	"openai/text-embedding-3-large": 8191,
	"text-embedding-3-small": 8191,
	"text-embedding-3-large": 8191,
	// Mistral
	"mistralai/mistral-embed-2312": 8192,
	// Google
	"google/gemini-embedding-001": 2048,
	// Sentence Transformers - small context
	"sentence-transformers/all-minilm-l6-v2": 512,
	"all-minilm-l6-v2": 512,
	// Ollama models
	"nomic-embed-text": 8192,
	"mxbai-embed-large": 512,
	"snowflake-arctic-embed": 512,
	"snowflake-arctic-embed2": 8192,
	"bge-m3": 8192,
	"bge-large": 512,
	embeddinggemma: 2048,
	"all-minilm": 512,
	"granite-embedding": 512,
	"paraphrase-multilingual": 512,
	"qwen3-embedding": 8192,
	"nomic-embed-text-v2-moe": 8192,
};

// ============================================================================
// Types
// ============================================================================

interface OpenRouterEmbeddingResponse {
	data: Array<{
		embedding: number[];
		index: number;
	}>;
	model: string;
	usage?: {
		prompt_tokens: number;
		total_tokens: number;
		/** Cost in USD (OpenRouter provides this directly) */
		cost?: number;
	};
}

interface OllamaEmbeddingResponse {
	embedding: number[];
}

interface OllamaEmbedResponse {
	model: string;
	embeddings: number[][];
}

export interface EmbeddingsClientOptions {
	/** Embedding provider */
	provider?: EmbeddingProvider;
	/** Model to use for embeddings */
	model?: string;
	/** API key (for OpenRouter) */
	apiKey?: string;
	/** Endpoint URL (for Ollama/local) */
	endpoint?: string;
	/** Request timeout in ms */
	timeout?: number;
}

// ============================================================================
// Base Client Class
// ============================================================================

abstract class BaseEmbeddingsClient implements IEmbeddingsClient {
	protected model: string;
	protected timeout: number;
	protected dimension?: number;
	protected provider: EmbeddingProvider;

	constructor(model: string, provider: EmbeddingProvider, timeout = 60000) {
		this.model = model;
		this.provider = provider;
		this.timeout = timeout;
	}

	getModel(): string {
		return this.model;
	}

	getDimension(): number | undefined {
		return this.dimension;
	}

	getProvider(): EmbeddingProvider {
		return this.provider;
	}

	isLocal(): boolean {
		return LOCAL_EMBEDDING_PROVIDERS.has(this.provider);
	}

	abstract embed(
		texts: string[],
		onProgress?: EmbeddingProgressCallback,
	): Promise<EmbedResult>;

	async embedOne(text: string): Promise<number[]> {
		const result = await this.embed([text]);
		return result.embeddings[0];
	}

	protected sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}

// ============================================================================
// OpenRouter Client
// ============================================================================

export class OpenRouterEmbeddingsClient extends BaseEmbeddingsClient {
	private apiKey: string;

	constructor(options: EmbeddingsClientOptions = {}) {
		super(
			options.model || DEFAULT_MODELS.openrouter,
			"openrouter",
			options.timeout,
		);

		const apiKey = options.apiKey || getApiKey();
		if (!apiKey) {
			throw new Error(
				"OpenRouter API key required. Set OPENROUTER_API_KEY environment variable or run 'mnemex init'",
			);
		}
		this.apiKey = apiKey;
	}

	async embed(
		texts: string[],
		onProgress?: EmbeddingProgressCallback,
	): Promise<EmbedResult> {
		if (texts.length === 0) return { embeddings: [] };

		// Split into batches
		const batches: string[][] = [];
		for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
			batches.push(texts.slice(i, i + MAX_BATCH_SIZE));
		}

		// Process batches in parallel (5 at a time for speed)
		const PARALLEL_BATCHES = 5;
		const results: number[][] = new Array(texts.length);
		let resultIndex = 0;
		let completedTexts = 0;
		let totalTokens = 0;
		let totalCost = 0;

		let failedCount = 0;
		const warnings: string[] = [];

		for (let i = 0; i < batches.length; i += PARALLEL_BATCHES) {
			const batchGroup = batches.slice(i, i + PARALLEL_BATCHES);
			const inProgressCount = batchGroup.reduce((sum, b) => sum + b.length, 0);

			// Report "starting to process" with in-progress count (for animation)
			if (onProgress) {
				onProgress(completedTexts, texts.length, inProgressCount);
			}

			// Wrap each batch in try-catch to continue on failure
			const batchPromises = batchGroup.map(async (batch) => {
				try {
					return await this.embedBatch(batch);
				} catch (error) {
					// Return empty embeddings for failed batch
					const msg = error instanceof Error ? error.message : String(error);
					// Auth errors should fail fast
					if (msg.includes("401") || msg.includes("403")) {
						throw error;
					}
					warnings.push(msg);
					failedCount += batch.length;
					return { embeddings: batch.map(() => [] as number[]) };
				}
			});
			const batchResults = await Promise.all(batchPromises);

			for (const batchResult of batchResults) {
				for (const embedding of batchResult.embeddings) {
					results[resultIndex++] = embedding;
				}
				completedTexts += batchResult.embeddings.length;
				if (batchResult.totalTokens) totalTokens += batchResult.totalTokens;
				if (batchResult.cost) totalCost += batchResult.cost;
			}
		}

		if (failedCount > 0) {
			warnings.push(`${failedCount}/${texts.length} chunks skipped`);
		}

		// Final progress report (all complete)
		if (onProgress) {
			onProgress(completedTexts, texts.length, 0);
		}

		return {
			embeddings: results,
			totalTokens: totalTokens > 0 ? totalTokens : undefined,
			cost: totalCost > 0 ? totalCost : undefined,
			warnings: warnings.length > 0 ? warnings : undefined,
		};
	}

	private async embedBatch(texts: string[]): Promise<EmbedResult> {
		let lastError: Error | undefined;
		const maxRetries = MAX_RETRIES + 3; // Extra retries for transient JSON parse errors

		for (let attempt = 0; attempt < maxRetries; attempt++) {
			try {
				const response = await this.makeRequest(texts);

				if (response.embeddings.length > 0 && !this.dimension) {
					this.dimension = response.embeddings[0].length;
				}

				return {
					embeddings: response.embeddings,
					totalTokens: response.usage?.totalTokens,
					cost: response.usage?.cost,
				};
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error));

				// Don't retry on authentication errors
				if (
					lastError.message.includes("401") ||
					lastError.message.includes("403")
				) {
					throw lastError;
				}

				if (attempt < maxRetries - 1) {
					const delay = lastError.message.includes("JSON")
						? 2000 // Longer delay for parse errors
						: BASE_RETRY_DELAY * Math.pow(2, attempt);
					await this.sleep(delay);
				}
			}
		}

		throw lastError || new Error("Failed to generate embeddings");
	}

	private async makeRequest(texts: string[]): Promise<EmbeddingResponse> {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), this.timeout);

		try {
			const response = await fetch(OPENROUTER_EMBEDDINGS_URL, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${this.apiKey}`,
					"Content-Type": "application/json",
					...OPENROUTER_HEADERS,
				},
				body: JSON.stringify({
					model: this.model,
					input: texts,
				}),
				signal: controller.signal,
			});

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(
					`OpenRouter API error: ${response.status} - ${errorText}`,
				);
			}

			// Use text() + JSON.parse() instead of json() for better error handling
			// Bun's response.json() can corrupt data under concurrent fetch load
			const responseText = await response.text();
			const data: OpenRouterEmbeddingResponse = JSON.parse(responseText);
			const sorted = [...data.data].sort((a, b) => a.index - b.index);

			return {
				embeddings: sorted.map((item) => item.embedding),
				model: data.model,
				usage: data.usage
					? {
							promptTokens: data.usage.prompt_tokens,
							totalTokens: data.usage.total_tokens,
							cost: data.usage.cost,
						}
					: undefined,
			};
		} finally {
			clearTimeout(timeoutId);
		}
	}
}

// ============================================================================
// Ollama Client
// ============================================================================

export class OllamaEmbeddingsClient extends BaseEmbeddingsClient {
	private endpoint: string;

	constructor(options: EmbeddingsClientOptions = {}) {
		super(options.model || DEFAULT_MODELS.ollama, "ollama", options.timeout);
		this.endpoint = options.endpoint || DEFAULT_OLLAMA_ENDPOINT;
	}

	async embed(
		texts: string[],
		onProgress?: EmbeddingProgressCallback,
	): Promise<EmbedResult> {
		if (texts.length === 0) return { embeddings: [] };

		// Warmup: trigger model loading before processing the batch
		await this.warmup();

		// Pre-truncate texts client-side to avoid context length errors
		// Ollama's truncate:true helps but some models still reject long inputs
		const maxTokens = getModelContextLength(this.model);
		const truncatedTexts = texts.map((t) => truncateToTokenLimit(t, maxTokens));

		// Ollama processes one text at a time
		const results: number[][] = [];
		let failedCount = 0;
		const warnings: string[] = [];

		for (let i = 0; i < truncatedTexts.length; i++) {
			// Report "starting to process" (1 item at a time)
			if (onProgress) {
				onProgress(i, truncatedTexts.length, 1);
			}

			try {
				const embedding = await this.embedSingle(truncatedTexts[i]);
				results.push(embedding);

				// Store dimension on first result
				if (!this.dimension && embedding.length > 0) {
					this.dimension = embedding.length;
				}
			} catch (error) {
				// Skip failed chunks instead of stopping entire process
				// Return empty embedding - caller should filter these out
				results.push([]);
				failedCount++;

				// Connection errors should fail fast
				const msg = error instanceof Error ? error.message : String(error);
				if (msg.includes("ECONNREFUSED") || msg.includes("Cannot connect")) {
					throw error;
				}
				warnings.push(`Chunk ${i + 1}: ${msg}`);
			}
		}

		// Final progress report
		if (onProgress) {
			onProgress(truncatedTexts.length, truncatedTexts.length, 0);
		}

		if (failedCount > 0) {
			warnings.push(`${failedCount}/${truncatedTexts.length} chunks skipped`);
		}

		// Ollama doesn't report cost (local model)
		return {
			embeddings: results,
			warnings: warnings.length > 0 ? warnings : undefined,
		};
	}

	private useNewApi = true;
	private warmedUp = false;

	/**
	 * Warmup: trigger model loading and wait for valid response.
	 * Ollama unloads the previous model and loads the new one on first request,
	 * which can return garbage JSON during the transition.
	 */
	private async warmup(): Promise<void> {
		if (this.warmedUp) return;

		const maxWarmupAttempts = 8; // Up to ~20s total with backoff
		for (let attempt = 0; attempt < maxWarmupAttempts; attempt++) {
			try {
				const controller = new AbortController();
				const timeoutId = setTimeout(() => controller.abort(), 30000);
				try {
					const response = await fetch(`${this.endpoint}/api/embed`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							model: this.model,
							input: "test",
							truncate: true,
						}),
						signal: controller.signal,
					});

					if (response.status === 404) {
						// /api/embed not available, use legacy
						this.useNewApi = false;
						this.warmedUp = true;
						return;
					}

					if (response.ok) {
						const data = (await response.json()) as OllamaEmbedResponse;
						if (
							data.embeddings &&
							Array.isArray(data.embeddings) &&
							data.embeddings[0]?.length > 0
						) {
							// Model loaded — let it stabilize in GPU memory before real requests
							await this.sleep(500);
							this.warmedUp = true;
							return;
						}
					}
				} finally {
					clearTimeout(timeoutId);
				}
			} catch {
				// JSON parse error or network issue — model still loading
			}
			// Wait with backoff: 2s, 3s, 4s, 5s...
			await this.sleep(Math.min(2000 + 1000 * attempt, 5000));
		}
		// If warmup fails after all attempts, proceed anyway — embed will handle errors
		this.warmedUp = true;
	}

	private async embedSingle(text: string): Promise<number[]> {
		let lastError: Error | undefined;
		// More retries for model-loading race conditions
		const maxRetries = MAX_RETRIES + 3;

		for (let attempt = 0; attempt < maxRetries; attempt++) {
			try {
				const controller = new AbortController();
				const timeoutId = setTimeout(() => controller.abort(), this.timeout);

				try {
					if (this.useNewApi) {
						// Try newer /api/embed endpoint (supports truncate)
						const response = await fetch(`${this.endpoint}/api/embed`, {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({
								model: this.model,
								input: text,
								truncate: true,
							}),
							signal: controller.signal,
						});

						if (!response.ok) {
							const errorText = await response.text();
							// Only fall back to legacy on 404 (endpoint truly not available)
							if (response.status === 404) {
								this.useNewApi = false;
								return this.embedSingleLegacy(text);
							}
							throw new Error(
								`Ollama API error: ${response.status} - ${errorText}`,
							);
						}

						const responseText = await response.text();
						const data = JSON.parse(responseText) as OllamaEmbedResponse;
						if (
							!data.embeddings ||
							!Array.isArray(data.embeddings) ||
							data.embeddings[0]?.length === 0
						) {
							// Transient bad response (model still loading) — retry, don't permanently fall back
							throw new Error(
								"Ollama returned empty/invalid embeddings (model may still be loading)",
							);
						}
						return data.embeddings[0];
					} else {
						return await this.embedSingleLegacy(text);
					}
				} finally {
					clearTimeout(timeoutId);
				}
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error));

				// Check if Ollama is not running
				if (lastError.message.includes("ECONNREFUSED")) {
					throw new Error(
						`Cannot connect to Ollama at ${this.endpoint}. Is Ollama running? Try: ollama serve`,
					);
				}

				// JSON parse errors during model loading are transient — retry with delay
				// Only fall back to legacy on persistent 404 (handled above)
				if (attempt < maxRetries - 1) {
					const delay = lastError.message.includes("JSON Parse error")
						? 3000 // Longer delay for model-loading race condition
						: BASE_RETRY_DELAY * Math.pow(2, attempt);
					await this.sleep(delay);
				}
			}
		}

		throw lastError || new Error("Failed to generate embeddings");
	}

	private async embedSingleLegacy(text: string): Promise<number[]> {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), this.timeout);

		try {
			const response = await fetch(`${this.endpoint}/api/embeddings`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: this.model,
					prompt: text,
				}),
				signal: controller.signal,
			});

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(`Ollama API error: ${response.status} - ${errorText}`);
			}

			const responseText = await response.text();
			const data: OllamaEmbeddingResponse = JSON.parse(responseText);
			return data.embedding;
		} finally {
			clearTimeout(timeoutId);
		}
	}
}

// ============================================================================
// Local/Custom Endpoint Client
// ============================================================================

export class LocalEmbeddingsClient extends BaseEmbeddingsClient {
	private endpoint: string;
	private warmedUp = false;
	// Smaller batch size for local models to show progress more frequently
	private static readonly LOCAL_BATCH_SIZE = 10;

	constructor(
		options: EmbeddingsClientOptions = {},
		provider: "local" | "lmstudio" = "local",
	) {
		super(options.model || DEFAULT_MODELS[provider], provider, options.timeout);
		this.endpoint = options.endpoint || DEFAULT_LOCAL_ENDPOINT;
	}

	/**
	 * Warmup: trigger model loading and wait for valid response.
	 * LM Studio may need time to load a model when switching between them.
	 */
	private async warmup(): Promise<void> {
		if (this.warmedUp) return;

		const maxWarmupAttempts = 8;
		for (let attempt = 0; attempt < maxWarmupAttempts; attempt++) {
			try {
				const controller = new AbortController();
				const timeoutId = setTimeout(() => controller.abort(), 30000);
				try {
					const response = await fetch(`${this.endpoint}/embeddings`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ model: this.model, input: "test" }),
						signal: controller.signal,
					});
					if (response.ok) {
						const data: OpenRouterEmbeddingResponse = await response.json();
						if (data.data?.[0]?.embedding?.length > 0) {
							this.warmedUp = true;
							return;
						}
					}
				} finally {
					clearTimeout(timeoutId);
				}
			} catch {
				// Model still loading — retry
			}
			await this.sleep(Math.min(1000 * (attempt + 1), 3000));
		}
		this.warmedUp = true;
	}

	async embed(
		texts: string[],
		onProgress?: EmbeddingProgressCallback,
	): Promise<EmbedResult> {
		if (texts.length === 0) return { embeddings: [] };

		// Warmup: trigger model loading before processing the batch
		await this.warmup();

		// Split into batches for progress reporting
		const batches: string[][] = [];
		for (
			let i = 0;
			i < texts.length;
			i += LocalEmbeddingsClient.LOCAL_BATCH_SIZE
		) {
			batches.push(texts.slice(i, i + LocalEmbeddingsClient.LOCAL_BATCH_SIZE));
		}

		const results: number[][] = [];
		let completedTexts = 0;

		for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
			const batch = batches[batchIdx];

			// Report progress before processing this batch
			if (onProgress) {
				onProgress(completedTexts, texts.length, batch.length);
			}

			const batchResult = await this.embedBatch(batch);
			results.push(...batchResult);
			completedTexts += batch.length;
		}

		// Final progress report
		if (onProgress) {
			onProgress(texts.length, texts.length, 0);
		}

		return { embeddings: results };
	}

	/**
	 * Embed a single batch of texts
	 */
	private async embedBatch(texts: string[]): Promise<number[][]> {
		let lastError: Error | undefined;
		// More retries for model-loading race conditions
		const maxRetries = MAX_RETRIES + 3;

		for (let attempt = 0; attempt < maxRetries; attempt++) {
			try {
				const controller = new AbortController();
				const timeoutId = setTimeout(() => controller.abort(), this.timeout);

				try {
					// OpenAI-compatible format
					const response = await fetch(`${this.endpoint}/embeddings`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							model: this.model,
							input: texts,
						}),
						signal: controller.signal,
					});

					if (!response.ok) {
						const errorText = await response.text();
						throw new Error(
							`Local API error: ${response.status} - ${errorText}`,
						);
					}

					const responseText = await response.text();
					const data: OpenRouterEmbeddingResponse = JSON.parse(responseText);
					const sorted = [...data.data].sort((a, b) => a.index - b.index);
					const embeddings = sorted.map((item) => item.embedding);

					if (embeddings.length > 0 && !this.dimension) {
						this.dimension = embeddings[0].length;
					}

					return embeddings;
				} finally {
					clearTimeout(timeoutId);
				}
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error));

				if (lastError.message.includes("ECONNREFUSED")) {
					throw new Error(
						`Cannot connect to local embedding server at ${this.endpoint}. Is it running?`,
					);
				}

				if (attempt < maxRetries - 1) {
					const delay = lastError.message.includes("JSON Parse error")
						? 3000 // Longer delay for model-loading race condition
						: BASE_RETRY_DELAY * Math.pow(2, attempt);
					await this.sleep(delay);
				}
			}
		}

		throw lastError || new Error("Failed to generate embeddings");
	}
}

// ============================================================================
// Voyage AI Client
// ============================================================================

/** Voyage model pricing per million tokens (USD) */
const VOYAGE_PRICING: Record<string, number> = {
	"voyage-3-large": 0.18,
	"voyage-context-3": 0.18,
	"voyage-3.5": 0.06,
	"voyage-3.5-lite": 0.02,
	"voyage-code-3": 0.18,
	"voyage-finance-2": 0.12,
	"voyage-law-2": 0.12,
	"voyage-code-2": 0.12,
	"voyage-multilingual-2": 0.12,
	"voyage-3": 0.06,
	"voyage-3-lite": 0.02,
	// Older models
	"voyage-large-2": 0.12,
	"voyage-2": 0.1,
};

export class VoyageEmbeddingsClient extends BaseEmbeddingsClient {
	private apiKey: string;

	constructor(options: EmbeddingsClientOptions = {}) {
		super(options.model || DEFAULT_MODELS.voyage, "voyage", options.timeout);

		const apiKey = options.apiKey || getVoyageApiKey();
		if (!apiKey) {
			throw new Error(
				"Voyage API key required. Set VOYAGE_API_KEY environment variable or get one at:\nhttps://dashboard.voyageai.com/organization/api-keys",
			);
		}
		this.apiKey = apiKey;
	}

	async embed(
		texts: string[],
		onProgress?: EmbeddingProgressCallback,
	): Promise<EmbedResult> {
		if (texts.length === 0) return { embeddings: [] };

		// Voyage supports batching up to 128 texts, use smaller batches for progress
		const batches: string[][] = [];
		for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
			batches.push(texts.slice(i, i + MAX_BATCH_SIZE));
		}

		// Process batches in parallel (5 at a time)
		const PARALLEL_BATCHES = 5;
		const results: number[][] = new Array(texts.length);
		let resultIndex = 0;
		let completedTexts = 0;
		let totalTokens = 0;

		let failedCount = 0;
		const warnings: string[] = [];

		for (let i = 0; i < batches.length; i += PARALLEL_BATCHES) {
			const batchGroup = batches.slice(i, i + PARALLEL_BATCHES);
			const inProgressCount = batchGroup.reduce((sum, b) => sum + b.length, 0);

			if (onProgress) {
				onProgress(completedTexts, texts.length, inProgressCount);
			}

			// Wrap each batch in try-catch to continue on failure
			const batchPromises = batchGroup.map(async (batch) => {
				try {
					return await this.embedBatch(batch);
				} catch (error) {
					const msg = error instanceof Error ? error.message : String(error);
					// Auth errors should fail fast
					if (msg.includes("401") || msg.includes("403")) {
						throw error;
					}
					warnings.push(msg);
					failedCount += batch.length;
					return { embeddings: batch.map(() => [] as number[]) };
				}
			});
			const batchResults = await Promise.all(batchPromises);

			for (const batchResult of batchResults) {
				for (const embedding of batchResult.embeddings) {
					results[resultIndex++] = embedding;
				}
				completedTexts += batchResult.embeddings.length;
				if (batchResult.totalTokens) totalTokens += batchResult.totalTokens;
			}
		}

		if (failedCount > 0) {
			warnings.push(`${failedCount}/${texts.length} chunks skipped`);
		}

		if (onProgress) {
			onProgress(completedTexts, texts.length, 0);
		}

		// Calculate cost from tokens using pricing table
		const cost = totalTokens > 0 ? this.calculateCost(totalTokens) : undefined;

		return {
			embeddings: results,
			totalTokens: totalTokens > 0 ? totalTokens : undefined,
			cost,
			warnings: warnings.length > 0 ? warnings : undefined,
		};
	}

	/** Calculate cost in USD from token count */
	private calculateCost(tokens: number): number {
		const pricePerMillion = VOYAGE_PRICING[this.model] ?? 0.12; // Default to $0.12/M
		return (tokens / 1_000_000) * pricePerMillion;
	}

	private async embedBatch(texts: string[]): Promise<EmbedResult> {
		let lastError: Error | undefined;
		const maxRetries = MAX_RETRIES + 3;

		for (let attempt = 0; attempt < maxRetries; attempt++) {
			try {
				const controller = new AbortController();
				const timeoutId = setTimeout(() => controller.abort(), this.timeout);

				try {
					const response = await fetch(VOYAGE_EMBEDDINGS_URL, {
						method: "POST",
						headers: {
							Authorization: `Bearer ${this.apiKey}`,
							"Content-Type": "application/json",
						},
						body: JSON.stringify({
							model: this.model,
							input: texts,
						}),
						signal: controller.signal,
					});

					if (!response.ok) {
						const errorText = await response.text();
						throw new Error(
							`Voyage API error: ${response.status} - ${errorText}`,
						);
					}

					const responseText = await response.text();
					const data = JSON.parse(responseText) as {
						data: Array<{ embedding: number[]; index: number }>;
						usage?: { total_tokens: number };
					};

					const sorted = [...data.data].sort((a, b) => a.index - b.index);
					const embeddings = sorted.map((item) => item.embedding);

					if (embeddings.length > 0 && !this.dimension) {
						this.dimension = embeddings[0].length;
					}

					return {
						embeddings,
						totalTokens: data.usage?.total_tokens,
					};
				} finally {
					clearTimeout(timeoutId);
				}
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error));

				// Don't retry on authentication errors
				if (
					lastError.message.includes("401") ||
					lastError.message.includes("403")
				) {
					throw lastError;
				}

				if (attempt < maxRetries - 1) {
					const delay = lastError.message.includes("JSON")
						? 2000
						: BASE_RETRY_DELAY * Math.pow(2, attempt);
					await this.sleep(delay);
				}
			}
		}

		throw lastError || new Error("Failed to generate embeddings");
	}
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Check if a model ID is a Voyage model
 */
export function isVoyageModel(modelId: string): boolean {
	return modelId.startsWith("voyage-");
}

/**
 * Check if a model ID is an Ollama model (ollama/ prefix)
 */
export function isOllamaModel(modelId: string): boolean {
	return modelId.startsWith("ollama/");
}

/**
 * Extract actual model name from prefixed model ID
 * e.g., "ollama/nomic-embed-code" -> "nomic-embed-code"
 */
function extractModelName(modelId: string): string {
	if (modelId.includes("/")) {
		const parts = modelId.split("/");
		// For ollama/model, return just the model part
		if (parts[0] === "ollama") {
			return parts.slice(1).join("/");
		}
	}
	return modelId;
}

/**
 * Create an embeddings client based on provider
 * Auto-detects:
 * - Voyage models (voyage-*) -> Voyage provider
 * - Ollama models (ollama/*) -> Ollama provider
 */
export function createEmbeddingsClient(
	options?: EmbeddingsClientOptions,
): IEmbeddingsClient {
	// Determine provider from options or config
	const config = loadGlobalConfig();
	let provider = options?.provider || config.embeddingProvider;
	// Use config default model (voyage-3.5-lite) if not specified
	let model = options?.model || config.defaultModel || DEFAULT_EMBEDDING_MODEL;

	// Auto-detect provider from model prefix (overrides config provider)
	if (isVoyageModel(model)) {
		provider = "voyage";
	} else if (isOllamaModel(model)) {
		provider = "ollama";
		model = extractModelName(model); // Strip "ollama/" prefix
	} else if (model.startsWith("lmstudio/")) {
		provider = "lmstudio";
		model = model.slice("lmstudio/".length);
	} else if (model.includes("/")) {
		// Models with provider/name format (e.g. openai/text-embedding-3-small) -> OpenRouter
		provider = "openrouter";
	} else if (!provider) {
		// Fall back to openrouter only if no provider detected
		provider = "openrouter";
	}

	switch (provider) {
		case "ollama":
			return new OllamaEmbeddingsClient({
				...options,
				model,
				endpoint: options?.endpoint || config.ollamaEndpoint,
			});

		case "lmstudio":
			// LM Studio uses OpenAI-compatible API
			return new LocalEmbeddingsClient(
				{
					...options,
					model,
					endpoint:
						options?.endpoint ||
						config.lmstudioEndpoint ||
						"http://localhost:1234/v1",
				},
				"lmstudio",
			);

		case "local":
			return new LocalEmbeddingsClient(
				{
					...options,
					model,
					endpoint: options?.endpoint || config.localEndpoint,
				},
				"local",
			);

		case "voyage":
			return new VoyageEmbeddingsClient({ ...options, model });

		case "openrouter":
		default:
			return new OpenRouterEmbeddingsClient({ ...options, model });
	}
}

// ============================================================================
// Latency Tracking Wrapper
// ============================================================================

/**
 * Wrap an embeddings client to add latency tracking to EmbedResult.
 * Non-invasive: wraps the public embed() method without modifying concrete classes.
 */
export function withLatencyTracking(
	client: IEmbeddingsClient,
): IEmbeddingsClient {
	const originalEmbed = client.embed.bind(client);
	client.embed = async (
		texts: string[],
		onProgress?: EmbeddingProgressCallback,
	): Promise<EmbedResult> => {
		const startMs = Date.now();
		const result = await originalEmbed(texts, onProgress);
		const latencyMs = Date.now() - startMs;
		const throughputTokensPerSec =
			result.totalTokens && latencyMs > 0
				? Math.round((result.totalTokens / latencyMs) * 1000)
				: undefined;
		return { ...result, latencyMs, throughputTokensPerSec };
	};
	return client;
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Estimate the number of tokens in a text
 * Conservative approximation: ~3 characters per token for code
 * (code has more special chars/keywords that tokenize individually)
 */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 3);
}

/**
 * Check if a text is too long for the model's context window
 */
export function isTextTooLong(text: string, maxTokens: number): boolean {
	return estimateTokens(text) > maxTokens;
}

/**
 * Truncate text to fit within token limit
 * Uses 2 chars per token as a safe estimate for code (tokenizers vary)
 */
export function truncateToTokenLimit(text: string, maxTokens: number): string {
	const maxChars = maxTokens * 2; // Safe: 2 chars per token for code
	if (text.length <= maxChars) {
		return text;
	}
	return text.slice(0, maxChars - 3) + "...";
}

/**
 * Get the context length (in tokens) for a model
 * Returns default of 8192 if unknown
 */
export function getModelContextLength(modelId: string): number {
	// Check direct match
	if (MODEL_CONTEXT_LENGTHS[modelId]) {
		return MODEL_CONTEXT_LENGTHS[modelId];
	}
	// Check without provider prefix (e.g., "ollama/nomic-embed-text" -> "nomic-embed-text")
	const modelName = modelId.includes("/") ? modelId.split("/").pop()! : modelId;
	if (MODEL_CONTEXT_LENGTHS[modelName]) {
		return MODEL_CONTEXT_LENGTHS[modelName];
	}
	// Strip Ollama size/tag suffix (e.g., "bge-large:335m" -> "bge-large", "all-minilm:22m" -> "all-minilm")
	const baseName = modelName.includes(":")
		? modelName.split(":")[0]
		: modelName;
	if (baseName !== modelName && MODEL_CONTEXT_LENGTHS[baseName]) {
		return MODEL_CONTEXT_LENGTHS[baseName];
	}
	// Default context length
	return 8192;
}

/**
 * Truncate texts to fit within model's context window
 */
export function truncateForModel(texts: string[], modelId: string): string[] {
	const maxTokens = getModelContextLength(modelId);
	return texts.map((text) => truncateToTokenLimit(text, maxTokens));
}

/**
 * Test connection to an embedding provider
 */
export async function testProviderConnection(
	provider: EmbeddingProvider,
	endpoint?: string,
): Promise<{ ok: boolean; error?: string }> {
	try {
		const client = createEmbeddingsClient({
			provider,
			endpoint,
		});
		await client.embedOne("test");
		return { ok: true };
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}
