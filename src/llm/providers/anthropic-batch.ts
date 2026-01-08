/**
 * Anthropic Batch API LLM Provider
 *
 * Uses Anthropic's Message Batches API for high-volume, asynchronous processing.
 * 50% cheaper than regular API, ideal for benchmarks.
 *
 * @see https://docs.anthropic.com/en/docs/build-with-claude/batch-processing
 */

import { BaseLLMClient, DEFAULT_LLM_MODELS } from "../client.js";
import type {
	LLMGenerateOptions,
	LLMMessage,
	LLMResponse,
} from "../../types.js";

// ============================================================================
// Types
// ============================================================================

interface AnthropicBatchOptions {
	/** API key for Anthropic */
	apiKey?: string;
	/** Model to use */
	model?: string;
	/** Polling interval in ms (default: 5000) */
	pollInterval?: number;
	/** Maximum wait time in ms (default: 3600000 = 1 hour) */
	maxWaitTime?: number;
}

interface BatchRequest {
	custom_id: string;
	params: {
		model: string;
		max_tokens: number;
		messages: Array<{ role: "user" | "assistant"; content: string }>;
		system?: string;
		temperature?: number;
	};
}

interface BatchResponse {
	id: string;
	type: "message_batch";
	processing_status: "in_progress" | "canceling" | "ended";
	request_counts: {
		processing: number;
		succeeded: number;
		errored: number;
		canceled: number;
		expired: number;
	};
	ended_at?: string;
	created_at: string;
	expires_at: string;
	results_url?: string;
}

interface BatchResult {
	custom_id: string;
	result: {
		type: "succeeded" | "errored" | "canceled" | "expired";
		message?: {
			id: string;
			type: "message";
			role: "assistant";
			content: Array<{ type: "text"; text: string }>;
			model: string;
			stop_reason: string;
			usage: {
				input_tokens: number;
				output_tokens: number;
			};
		};
		error?: {
			type: string;
			message: string;
		};
	};
}

// ============================================================================
// Anthropic Batch API Client
// ============================================================================

const ANTHROPIC_BATCH_URL = "https://api.anthropic.com/v1/messages/batches";
const ANTHROPIC_VERSION = "2023-06-01";

export class AnthropicBatchLLMClient extends BaseLLMClient {
	private apiKey: string;
	private pollInterval: number;
	private maxWaitTime: number;

	// Queue of requests to be batched
	private requestQueue: Map<
		string,
		{
			messages: LLMMessage[];
			options?: LLMGenerateOptions;
			resolve: (response: LLMResponse) => void;
			reject: (error: Error) => void;
		}
	> = new Map();

	// Results cache
	private resultsCache: Map<string, LLMResponse> = new Map();

	constructor(options: AnthropicBatchOptions = {}) {
		super(
			"anthropic-batch",
			options.model || DEFAULT_LLM_MODELS.anthropic,
			600000, // 10 minute timeout for batch operations
		);

		const apiKey = options.apiKey || process.env.ANTHROPIC_API_KEY;
		if (!apiKey) {
			throw new Error(
				"Anthropic API key required. Set ANTHROPIC_API_KEY environment variable or pass apiKey option.",
			);
		}
		this.apiKey = apiKey;
		this.pollInterval = options.pollInterval || 5000;
		this.maxWaitTime = options.maxWaitTime || 3600000; // 1 hour
	}

	/**
	 * Queue a request for batch processing.
	 * Actual processing happens when flushBatch() is called.
	 */
	async complete(
		messages: LLMMessage[],
		options?: LLMGenerateOptions,
	): Promise<LLMResponse> {
		const customId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

		return new Promise((resolve, reject) => {
			this.requestQueue.set(customId, { messages, options, resolve, reject });
		});
	}

	/**
	 * Get the number of queued requests.
	 */
	getQueueSize(): number {
		return this.requestQueue.size;
	}

	/**
	 * Submit all queued requests as a batch and wait for results.
	 */
	async flushBatch(): Promise<Map<string, LLMResponse | Error>> {
		if (this.requestQueue.size === 0) {
			return new Map();
		}

		const results = new Map<string, LLMResponse | Error>();

		try {
			// Build batch requests
			const batchRequests: BatchRequest[] = [];
			for (const [customId, { messages, options }] of this.requestQueue) {
				const systemPrompt = this.extractSystemPrompt(
					messages,
					options?.systemPrompt,
				);
				const conversationMessages = this.convertMessages(messages);

				batchRequests.push({
					custom_id: customId,
					params: {
						model: options?.model || this.model,
						max_tokens: options?.maxTokens || 4096,
						messages: conversationMessages,
						...(systemPrompt && { system: systemPrompt }),
						...(options?.temperature !== undefined && {
							temperature: options.temperature,
						}),
					},
				});
			}

			// Submit batch
			const batch = await this.createBatch(batchRequests);

			// Poll for completion
			const completedBatch = await this.pollBatchCompletion(batch.id);

			// Retrieve results
			if (completedBatch.results_url) {
				const batchResults = await this.retrieveResults(
					completedBatch.results_url,
				);

				// Process results and resolve promises
				for (const result of batchResults) {
					const queuedRequest = this.requestQueue.get(result.custom_id);
					if (!queuedRequest) continue;

					if (result.result.type === "succeeded" && result.result.message) {
						const message = result.result.message;
						const content = message.content
							.filter((block) => block.type === "text")
							.map((block) => block.text)
							.join("");

						const response: LLMResponse = {
							content,
							model: message.model,
							usage: {
								inputTokens: message.usage.input_tokens,
								outputTokens: message.usage.output_tokens,
								// Batch API is 50% cheaper
								cost:
									this.calculateCost(
										message.usage.input_tokens,
										message.usage.output_tokens,
										message.model,
									) * 0.5,
							},
						};

						this.accumulateUsage(response.usage);
						queuedRequest.resolve(response);
						results.set(result.custom_id, response);
					} else {
						const error = new Error(
							result.result.error?.message ||
								`Batch request ${result.result.type}: ${result.custom_id}`,
						);
						queuedRequest.reject(error);
						results.set(result.custom_id, error);
					}
				}
			}
		} catch (error) {
			// Reject all pending requests
			const err = error instanceof Error ? error : new Error(String(error));
			for (const [customId, { reject }] of this.requestQueue) {
				reject(err);
				results.set(customId, err);
			}
		} finally {
			this.requestQueue.clear();
		}

		return results;
	}

	/**
	 * Create a new batch.
	 */
	private async createBatch(requests: BatchRequest[]): Promise<BatchResponse> {
		const response = await fetch(ANTHROPIC_BATCH_URL, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-api-key": this.apiKey,
				"anthropic-version": ANTHROPIC_VERSION,
				"anthropic-beta": "message-batches-2024-09-24",
			},
			body: JSON.stringify({ requests }),
		});

		if (!response.ok) {
			const errorBody = await response.text();
			throw new Error(
				`Failed to create batch (${response.status}): ${errorBody}`,
			);
		}

		return response.json() as Promise<BatchResponse>;
	}

	/**
	 * Poll for batch completion.
	 */
	private async pollBatchCompletion(batchId: string): Promise<BatchResponse> {
		const startTime = Date.now();

		while (Date.now() - startTime < this.maxWaitTime) {
			const response = await fetch(`${ANTHROPIC_BATCH_URL}/${batchId}`, {
				headers: {
					"x-api-key": this.apiKey,
					"anthropic-version": ANTHROPIC_VERSION,
					"anthropic-beta": "message-batches-2024-09-24",
				},
			});

			if (!response.ok) {
				const errorBody = await response.text();
				throw new Error(
					`Failed to get batch status (${response.status}): ${errorBody}`,
				);
			}

			const batch = (await response.json()) as BatchResponse;

			if (batch.processing_status === "ended") {
				return batch;
			}

			// Wait before next poll
			await this.sleep(this.pollInterval);
		}

		throw new Error(
			`Batch ${batchId} did not complete within ${this.maxWaitTime}ms`,
		);
	}

	/**
	 * Retrieve batch results from the results URL.
	 */
	private async retrieveResults(resultsUrl: string): Promise<BatchResult[]> {
		const response = await fetch(resultsUrl, {
			headers: {
				"x-api-key": this.apiKey,
				"anthropic-version": ANTHROPIC_VERSION,
				"anthropic-beta": "message-batches-2024-09-24",
			},
		});

		if (!response.ok) {
			const errorBody = await response.text();
			throw new Error(
				`Failed to retrieve results (${response.status}): ${errorBody}`,
			);
		}

		// Results are returned as JSONL (one JSON object per line)
		const text = await response.text();
		const results: BatchResult[] = [];

		for (const line of text.split("\n")) {
			if (line.trim()) {
				results.push(JSON.parse(line) as BatchResult);
			}
		}

		return results;
	}

	/**
	 * Extract system prompt from messages and options.
	 */
	private extractSystemPrompt(
		messages: LLMMessage[],
		optionsSystemPrompt?: string,
	): string | undefined {
		const parts: string[] = [];

		if (optionsSystemPrompt) {
			parts.push(optionsSystemPrompt);
		}

		for (const msg of messages) {
			if (msg.role === "system") {
				parts.push(msg.content);
			}
		}

		return parts.length > 0 ? parts.join("\n\n") : undefined;
	}

	/**
	 * Convert messages to Anthropic format.
	 */
	private convertMessages(
		messages: LLMMessage[],
	): Array<{ role: "user" | "assistant"; content: string }> {
		return messages
			.filter((msg) => msg.role !== "system")
			.map((msg) => ({
				role: msg.role as "user" | "assistant",
				content: msg.content,
			}));
	}

	/**
	 * Calculate cost for Anthropic models (before 50% batch discount).
	 */
	private calculateCost(
		inputTokens: number,
		outputTokens: number,
		model: string,
	): number {
		// Pricing per 1M tokens (as of 2025)
		const pricing: Record<string, { input: number; output: number }> = {
			// Latest model aliases
			"claude-opus-4-5": { input: 15, output: 75 },
			"claude-sonnet-4-5": { input: 3, output: 15 },
			"claude-haiku-4-5": { input: 0.8, output: 4 },
			// Legacy dated versions (for compatibility)
			"claude-opus-4-20250514": { input: 15, output: 75 },
			"claude-sonnet-4-20250514": { input: 3, output: 15 },
			"claude-3-5-sonnet-20241022": { input: 3, output: 15 },
			"claude-3-5-haiku-20241022": { input: 0.8, output: 4 },
			"claude-3-opus-20240229": { input: 15, output: 75 },
			"claude-3-sonnet-20240229": { input: 3, output: 15 },
			"claude-3-haiku-20240307": { input: 0.25, output: 1.25 },
		};

		const modelPricing = pricing[model] || pricing["claude-sonnet-4-5"];
		const inputCost = (inputTokens / 1_000_000) * modelPricing.input;
		const outputCost = (outputTokens / 1_000_000) * modelPricing.output;

		return inputCost + outputCost;
	}
}
