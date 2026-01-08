/**
 * Local LLM Provider
 *
 * Uses OpenAI-compatible API endpoints for local models.
 * Supports Ollama, LM Studio, and other local inference servers.
 */

import { BaseLLMClient, DEFAULT_LLM_MODELS } from "../client.js";
import { combineAbortSignals } from "../abort.js";
import type {
	LLMGenerateOptions,
	LLMMessage,
	LLMResponse,
} from "../../types.js";

// ============================================================================
// LMStudio Model Contention Handler
// ============================================================================

/** Errors that indicate LMStudio model swapping - should retry */
const RETRYABLE_ERRORS = [
	"Model unloaded",
	"Model is unloaded",
	"Model has unloaded",
	"Model does not exist",
	"Operation canceled",
];

/** Check if error is due to LMStudio model contention */
function isModelContentionError(message: string): boolean {
	return RETRYABLE_ERRORS.some((err) => message.includes(err));
}

/** Retry delays for model contention (give LMStudio time to load model) */
const MODEL_RETRY_DELAYS = [2000, 4000, 8000]; // 2s, 4s, 8s

// ============================================================================
// Model Info API (Ollama + LM Studio)
// ============================================================================

/**
 * Model information from local provider APIs
 */
export interface LocalModelInfo {
	/** Model name/key */
	name: string;
	/** Parameter size string (e.g., "70B", "7.6B") */
	parameterSize?: string;
	/** Parameter size in billions (parsed) */
	parameterSizeB?: number;
	/** Quantization level (e.g., "Q4_K_M") */
	quantizationLevel?: string;
	/** Model format (e.g., "gguf") */
	format?: string;
	/** Model family/architecture (e.g., "llama", "qwen") */
	family?: string;
}

/** Cache for model info to avoid repeated API calls */
const modelInfoCache = new Map<string, LocalModelInfo>();

/** Cache for LM Studio SDK model list */
let lmsModelsCache: Map<string, string> | null = null;
let lmsCacheTime = 0;
const LMS_CACHE_TTL = 60000; // 1 minute TTL

/**
 * Parse parameter size string to number in billions.
 * E.g., "70B" → 70, "7.6B" → 7.6, "400M" → 0.4
 */
export function parseParameterSize(sizeStr: string): number | undefined {
	const normalized = sizeStr.toUpperCase().trim();

	// Match patterns like "70B", "7.6B", "400M"
	const match = normalized.match(/^(\d+(?:\.\d+)?)\s*([BM])$/);
	if (!match) return undefined;

	const value = parseFloat(match[1]);
	const unit = match[2];

	if (unit === "M") {
		return value / 1000; // Convert millions to billions
	}
	return value; // Already in billions
}

/**
 * Get model information from Ollama's /api/show endpoint.
 */
async function getOllamaModelInfo(
	modelName: string,
	baseEndpoint: string,
): Promise<LocalModelInfo | undefined> {
	try {
		const response = await fetch(`${baseEndpoint}/api/show`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: modelName }),
			signal: AbortSignal.timeout(5000),
		});

		if (!response.ok) return undefined;

		const data = await response.json();
		const details = data.details || {};

		const info: LocalModelInfo = {
			name: modelName,
			parameterSize: details.parameter_size,
			quantizationLevel: details.quantization_level,
			format: details.format,
			family: details.family,
		};

		if (info.parameterSize) {
			info.parameterSizeB = parseParameterSize(info.parameterSize);
		}

		return info;
	} catch {
		return undefined;
	}
}

/**
 * Build a map of modelKey → paramsString using LM Studio SDK.
 * This is the authoritative source for model parameter counts.
 */
async function getLMStudioModelSizeMap(): Promise<Map<string, string>> {
	const now = Date.now();

	// Return cached if still valid
	if (lmsModelsCache && now - lmsCacheTime < LMS_CACHE_TTL) {
		return lmsModelsCache;
	}

	try {
		const { LMStudioClient } = await import("@lmstudio/sdk");
		const client = new LMStudioClient({ baseUrl: "ws://127.0.0.1:1234" });

		const downloadedModels = await client.system.listDownloadedModels();

		// Build map: modelKey → paramsString
		const map = new Map<string, string>();
		for (const m of downloadedModels) {
			if (m.type === "llm" && m.modelKey && m.paramsString) {
				map.set(m.modelKey, m.paramsString);
			}
		}

		lmsModelsCache = map;
		lmsCacheTime = now;

		return map;
	} catch (e) {
		if (process.env.DEBUG_MODEL_SIZE) {
			console.error(`[getLMStudioModelSizeMap] SDK error: ${e}`);
		}
		return new Map();
	}
}

/**
 * Get model information from LM Studio using the SDK.
 *
 * Strategy: Get all downloaded models from SDK and find the best match
 * for the requested model name using progressively looser matching.
 */
async function getLMStudioModelInfo(
	modelName: string,
	_baseEndpoint: string,
): Promise<LocalModelInfo | undefined> {
	try {
		const { LMStudioClient } = await import("@lmstudio/sdk");
		const client = new LMStudioClient({ baseUrl: "ws://127.0.0.1:1234" });

		const downloadedModels = await client.system.listDownloadedModels();
		const llmModels = downloadedModels.filter((m) => m.type === "llm");

		const debug = process.env.DEBUG_MODEL_SIZE === "1";
		if (debug) {
			console.error(`[getLMStudioModelInfo] Looking for: ${modelName}`);
			console.error(
				`[getLMStudioModelInfo] Available models: ${llmModels.map((m) => m.modelKey).join(", ")}`,
			);
		}

		// Normalize the input model name for matching
		const normalizedInput = modelName.toLowerCase();

		// Try progressively looser matching strategies
		let match = llmModels.find((m) => m.modelKey === modelName);

		if (!match) {
			// Try: modelKey ends with /modelName (e.g., "qwen/qwq-32b" matches "qwq-32b")
			match = llmModels.find((m) => m.modelKey.endsWith(`/${modelName}`));
		}

		if (!match) {
			// Try: modelKey contains the modelName (case-insensitive)
			match = llmModels.find((m) =>
				m.modelKey.toLowerCase().includes(normalizedInput),
			);
		}

		if (!match) {
			// Try: Extract base name and match (handles quantization suffixes)
			// e.g., "qwq-32b" should match "qwen/qwq-32b-instruct-q4_k_m"
			const baseName = normalizedInput
				.replace(/-q\d.*$/, "")
				.replace(/-instruct.*$/, "");
			match = llmModels.find((m) =>
				m.modelKey.toLowerCase().includes(baseName),
			);
		}

		if (!match) {
			if (debug)
				console.error(`[getLMStudioModelInfo] No match found for ${modelName}`);
			return undefined;
		}

		if (debug) {
			console.error(
				`[getLMStudioModelInfo] Matched: ${match.modelKey} → ${match.paramsString}`,
			);
		}

		const info: LocalModelInfo = {
			name: match.modelKey,
			parameterSize: match.paramsString,
			format: match.format,
			family: match.architecture,
		};

		if (info.parameterSize) {
			info.parameterSizeB = parseParameterSize(info.parameterSize);
		}

		return info;
	} catch (e) {
		if (process.env.DEBUG_MODEL_SIZE === "1") {
			console.error(`[getLMStudioModelInfo] Error: ${e}`);
		}
		return undefined;
	}
}

/**
 * Get model information from local provider (Ollama or LM Studio).
 *
 * Detects provider by endpoint port and queries only that provider:
 * - Port 1234: LM Studio → `lms ls --json` CLI
 * - Port 11434: Ollama → /api/show endpoint
 *
 * Results are cached for the session.
 */
export async function getLocalModelInfo(
	modelName: string,
	endpoint = "http://localhost:11434",
): Promise<LocalModelInfo | undefined> {
	// Check cache first
	const cacheKey = `${endpoint}:${modelName}`;
	if (modelInfoCache.has(cacheKey)) {
		return modelInfoCache.get(cacheKey);
	}

	// Strip /v1 suffix if present
	const baseEndpoint = endpoint.replace(/\/v1\/?$/, "");

	// Detect provider by port: 1234 = LM Studio, 11434 = Ollama
	const isLMStudio = endpoint.includes(":1234");

	const info = isLMStudio
		? await getLMStudioModelInfo(modelName, baseEndpoint)
		: await getOllamaModelInfo(modelName, baseEndpoint);

	if (info) {
		modelInfoCache.set(cacheKey, info);
	}

	return info;
}

/**
 * Clear the model info cache (useful for testing)
 */
export function clearModelInfoCache(): void {
	modelInfoCache.clear();
}

// ============================================================================
// Types
// ============================================================================

interface LocalOptions {
	/** Endpoint URL (default: http://localhost:11434/v1 for Ollama) */
	endpoint?: string;
	/** Model to use */
	model?: string;
	/** Request timeout in ms */
	timeout?: number;
}

interface OpenAIMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

interface OpenAIResponse {
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

// ============================================================================
// Local LLM Client (OpenAI-compatible)
// ============================================================================

const DEFAULT_ENDPOINT = "http://localhost:11434/v1";

export class LocalLLMClient extends BaseLLMClient {
	private endpoint: string;

	constructor(options: LocalOptions = {}) {
		super(
			"local",
			options.model || DEFAULT_LLM_MODELS.local,
			options.timeout || 300000, // Longer timeout for local models
		);

		this.endpoint = options.endpoint || DEFAULT_ENDPOINT;

		// Ensure endpoint ends without slash
		if (this.endpoint.endsWith("/")) {
			this.endpoint = this.endpoint.slice(0, -1);
		}
	}

	async complete(
		messages: LLMMessage[],
		options?: LLMGenerateOptions,
	): Promise<LLMResponse> {
		return this.withRetry(async () => {
			return this.completeWithModelRetry(messages, options, 0);
		});
	}

	/**
	 * Complete with model contention retry
	 * LMStudio may need to swap models - retry with increasing delays
	 */
	private async completeWithModelRetry(
		messages: LLMMessage[],
		options: LLMGenerateOptions | undefined,
		attempt: number,
	): Promise<LLMResponse> {
		// Convert messages to OpenAI format
		const openAIMessages = this.convertMessages(
			messages,
			options?.systemPrompt,
		);

		// Build request body
		const body = {
			model: options?.model || this.model,
			messages: openAIMessages,
			...(options?.maxTokens && { max_tokens: options.maxTokens }),
			...(options?.temperature !== undefined && {
				temperature: options.temperature,
			}),
			stream: false,
		};

		// Make API request
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), this.timeout);
		const signal = combineAbortSignals(controller.signal, options?.abortSignal);

		try {
			const url = `${this.endpoint}/chat/completions`;
			const response = await fetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body),
				signal,
			});

			clearTimeout(timeoutId);

			if (!response.ok) {
				const errorBody = await response.text();

				// Check for model contention errors (LMStudio swapping models)
				if (
					isModelContentionError(errorBody) &&
					attempt < MODEL_RETRY_DELAYS.length
				) {
					const delay = MODEL_RETRY_DELAYS[attempt];
					await new Promise((r) => setTimeout(r, delay));
					return this.completeWithModelRetry(messages, options, attempt + 1);
				}

				if (response.status === 404) {
					throw new Error(
						`Local model "${this.model}" not found. Make sure it's available on your local server.`,
					);
				}

				throw new Error(
					`Local LLM API error (${response.status}): ${errorBody}`,
				);
			}

			const data = (await response.json()) as OpenAIResponse;

			if (!data.choices || data.choices.length === 0) {
				throw new Error("Local LLM returned empty response");
			}

			const content = data.choices[0].message.content;

			return {
				content,
				model: data.model || this.model,
				usage: data.usage
					? {
							inputTokens: data.usage.prompt_tokens,
							outputTokens: data.usage.completion_tokens,
						}
					: undefined,
			};
		} catch (error) {
			clearTimeout(timeoutId);

			if (error instanceof Error) {
				if (error.name === "AbortError") {
					throw new Error(
						`Local LLM request timed out after ${this.timeout}ms`,
					);
				}
				// Connection refused - server not running
				if (error.message.includes("ECONNREFUSED")) {
					throw new Error(
						`Cannot connect to local LLM at ${this.endpoint}. ` +
							"Make sure Ollama or LM Studio is running.",
					);
				}
				// Check for model contention in thrown errors too
				if (
					isModelContentionError(error.message) &&
					attempt < MODEL_RETRY_DELAYS.length
				) {
					const delay = MODEL_RETRY_DELAYS[attempt];
					await new Promise((r) => setTimeout(r, delay));
					return this.completeWithModelRetry(messages, options, attempt + 1);
				}
			}
			throw error;
		}
	}

	/**
	 * Test if local server is available
	 */
	async testConnection(): Promise<boolean> {
		try {
			// Try a minimal completion
			const response = await this.complete(
				[{ role: "user", content: "Say 'ok'" }],
				{ maxTokens: 10 },
			);
			return response.content.length > 0;
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			if (msg.includes("ECONNREFUSED")) {
				console.warn(`Local LLM server not running at ${this.endpoint}`);
			} else if (msg.includes("not found")) {
				console.warn(`Local model "${this.model}" not available`);
			}
			return false;
		}
	}

	/**
	 * Get model size in billions of parameters.
	 * Queries local provider API (Ollama or LM Studio) for authoritative size info.
	 */
	async getModelSizeB(): Promise<number | undefined> {
		const info = await getLocalModelInfo(this.model, this.endpoint);
		if (process.env.DEBUG_MODEL_SIZE) {
			console.error(
				`[getModelSizeB] model=${this.model} endpoint=${this.endpoint} → ${info?.parameterSizeB ?? "unknown"}B`,
			);
		}
		return info?.parameterSizeB;
	}

	/**
	 * Convert messages to OpenAI format
	 */
	private convertMessages(
		messages: LLMMessage[],
		systemPrompt?: string,
	): OpenAIMessage[] {
		const result: OpenAIMessage[] = [];

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
}
