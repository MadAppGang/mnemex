/**
 * Anthropic API LLM Provider
 *
 * Direct integration with Anthropic's Messages API for Claude models.
 * Supports structured outputs and proper error handling.
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

interface AnthropicOptions {
	/** API key for Anthropic */
	apiKey?: string;
	/** Model to use */
	model?: string;
	/** Request timeout in ms */
	timeout?: number;
}

interface AnthropicMessage {
	role: "user" | "assistant";
	content: string;
}

interface AnthropicResponse {
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
}

interface AnthropicError {
	type: "error";
	error: {
		type: string;
		message: string;
	};
}

// ============================================================================
// Anthropic API Client
// ============================================================================

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

export class AnthropicLLMClient extends BaseLLMClient {
	private apiKey: string;

	constructor(options: AnthropicOptions = {}) {
		super(
			"anthropic",
			options.model || DEFAULT_LLM_MODELS.anthropic,
			options.timeout || 120000,
		);

		const apiKey = options.apiKey || process.env.ANTHROPIC_API_KEY;
		if (!apiKey) {
			throw new Error(
				"Anthropic API key required. Set ANTHROPIC_API_KEY environment variable or pass apiKey option.",
			);
		}
		this.apiKey = apiKey;
	}

	async complete(
		messages: LLMMessage[],
		options?: LLMGenerateOptions,
	): Promise<LLMResponse> {
		return this.withRetry(async () => {
			// Separate system message from conversation
			const systemPrompt = this.extractSystemPrompt(
				messages,
				options?.systemPrompt,
			);
			const conversationMessages = this.convertMessages(messages);

			// Build request body
			const body = {
				model: options?.model || this.model,
				max_tokens: options?.maxTokens || 4096,
				messages: conversationMessages,
				...(systemPrompt && { system: systemPrompt }),
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
				const response = await fetch(ANTHROPIC_API_URL, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"x-api-key": this.apiKey,
						"anthropic-version": ANTHROPIC_VERSION,
					},
					body: JSON.stringify(body),
					signal,
				});

				clearTimeout(timeoutId);

				if (!response.ok) {
					const errorBody = await response.text();
					let errorMessage: string;

					try {
						const errorJson = JSON.parse(errorBody) as AnthropicError;
						errorMessage = errorJson.error?.message || errorBody;
					} catch {
						errorMessage = errorBody;
					}

					if (response.status === 401) {
						throw new Error("Anthropic API key is invalid");
					} else if (response.status === 429) {
						throw new Error("Anthropic rate limit exceeded");
					} else if (response.status === 500 || response.status === 503) {
						throw new Error(`Anthropic API error: ${errorMessage}`);
					}

					throw new Error(
						`Anthropic API error (${response.status}): ${errorMessage}`,
					);
				}

				const data = (await response.json()) as AnthropicResponse;

				// Extract text content
				const content = data.content
					.filter((block) => block.type === "text")
					.map((block) => block.text)
					.join("");

				return {
					content,
					model: data.model,
					usage: {
						inputTokens: data.usage.input_tokens,
						outputTokens: data.usage.output_tokens,
					},
				};
			} catch (error) {
				clearTimeout(timeoutId);

				if (error instanceof Error && error.name === "AbortError") {
					throw new Error(
						`Anthropic API request timed out after ${this.timeout}ms`,
					);
				}
				throw error;
			}
		});
	}

	/**
	 * Extract system prompt from messages and options
	 */
	private extractSystemPrompt(
		messages: LLMMessage[],
		optionsSystemPrompt?: string,
	): string | undefined {
		const parts: string[] = [];

		// Add options system prompt first
		if (optionsSystemPrompt) {
			parts.push(optionsSystemPrompt);
		}

		// Add system messages from the conversation
		for (const msg of messages) {
			if (msg.role === "system") {
				parts.push(msg.content);
			}
		}

		return parts.length > 0 ? parts.join("\n\n") : undefined;
	}

	/**
	 * Convert messages to Anthropic format (excluding system messages)
	 */
	private convertMessages(messages: LLMMessage[]): AnthropicMessage[] {
		return messages
			.filter((msg) => msg.role !== "system")
			.map((msg) => ({
				role: msg.role as "user" | "assistant",
				content: msg.content,
			}));
	}
}
