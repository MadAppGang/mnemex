/**
 * Claude Code LLM Provider
 *
 * Makes direct API calls using your Claude subscription OAuth token.
 * Reads the token from Claude Code's stored credentials (Keychain on Mac,
 * ~/.claude/.credentials.json on Linux/Windows).
 *
 * This is faster than spawning the CLI as a subprocess.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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

interface ClaudeCodeOptions {
	/** Model to use (short names: haiku, sonnet, opus) */
	model?: string;
	/** Request timeout in ms */
	timeout?: number;
	/** Override token (optional - normally auto-detected) */
	accessToken?: string;
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
// Model Name Mapping
// ============================================================================

/** Map short model names to full API model IDs */
const MODEL_MAP: Record<string, string> = {
	opus: "claude-opus-4-5-20251101",
	"opus-4": "claude-opus-4-5-20251101",
	"opus-4.5": "claude-opus-4-5-20251101",
	sonnet: "claude-sonnet-4-5-20250929",
	"sonnet-4": "claude-sonnet-4-5-20250929",
	"sonnet-4.5": "claude-sonnet-4-5-20250929",
	haiku: "claude-haiku-4-5-20251001",
	"haiku-4": "claude-haiku-4-5-20251001",
	"haiku-4.5": "claude-haiku-4-5-20251001",
};

function resolveModel(model: string): string {
	const normalized = model.toLowerCase();
	return MODEL_MAP[normalized] || model;
}

// ============================================================================
// Token Retrieval
// ============================================================================

/**
 * Get Claude OAuth token from Claude Code's stored credentials.
 * Tries Keychain (Mac) first, then falls back to credentials file.
 */
function getClaudeOAuthToken(): string {
	// Try Mac Keychain first
	if (process.platform === "darwin") {
		try {
			const keychainData = execSync(
				'security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null',
				{ encoding: "utf-8", timeout: 5000 },
			).trim();

			if (keychainData) {
				const parsed = JSON.parse(keychainData);
				const token = parsed?.claudeAiOauth?.accessToken;
				if (token) return token;
			}
		} catch {
			// Keychain access failed, try file fallback
		}
	}

	// Try credentials file (Linux/Windows/fallback)
	const credentialsPath = join(homedir(), ".claude", ".credentials.json");
	if (existsSync(credentialsPath)) {
		try {
			const data = JSON.parse(readFileSync(credentialsPath, "utf-8"));
			const token = data?.claudeAiOauth?.accessToken;
			if (token) return token;
		} catch {
			// File parsing failed
		}
	}

	// Also try alternate path
	const altPath = join(homedir(), ".claude", "credentials.json");
	if (existsSync(altPath)) {
		try {
			const data = JSON.parse(readFileSync(altPath, "utf-8"));
			const token = data?.claudeAiOauth?.accessToken || data?.accessToken;
			if (token) return token;
		} catch {
			// File parsing failed
		}
	}

	throw new Error(
		"Could not find Claude OAuth token. Make sure Claude Code is installed and authenticated.\n" +
			"Run: claude auth login",
	);
}

// ============================================================================
// Claude Code API Client
// ============================================================================

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
// Required beta header for OAuth tokens from Claude Code
const ANTHROPIC_BETA =
	"claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,fine-grained-tool-streaming-2025-05-14";

// Required system prompt prefix for Claude Code OAuth authentication
// Without this prefix, Anthropic rejects Sonnet/Opus requests with OAuth tokens
const CLAUDE_CODE_SYSTEM_PREFIX =
	"You are Claude Code, Anthropic's official CLI for Claude.";

export class ClaudeCodeLLMClient extends BaseLLMClient {
	private accessToken: string;

	constructor(options: ClaudeCodeOptions = {}) {
		// Resolve short model names to full API model IDs
		const model = resolveModel(
			options.model || DEFAULT_LLM_MODELS["claude-code"],
		);

		super(
			"claude-code",
			model,
			options.timeout || 180000, // 3 minute default timeout
		);

		// Get token from options or auto-detect
		this.accessToken = options.accessToken || getClaudeOAuthToken();
	}

	async complete(
		messages: LLMMessage[],
		options?: LLMGenerateOptions,
	): Promise<LLMResponse> {
		return this.withRetry(async () => {
			// Build system prompt array (Claude Code prefix must be first for OAuth)
			const systemBlocks = this.buildSystemPrompt(
				messages,
				options?.systemPrompt,
			);
			const conversationMessages = this.convertMessages(messages);

			// Resolve model name if provided in options
			const model = options?.model ? resolveModel(options.model) : this.model;

			// Build request body (Anthropic format)
			const body = {
				model,
				max_tokens: options?.maxTokens || 4096,
				messages: conversationMessages,
				system: systemBlocks, // Array of text blocks with Claude Code prefix first
				...(options?.temperature !== undefined && {
					temperature: options.temperature,
				}),
			};

			// Make API request directly to Anthropic with OAuth token
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
						Authorization: `Bearer ${this.accessToken}`,
						"anthropic-version": ANTHROPIC_VERSION,
						"anthropic-beta": ANTHROPIC_BETA,
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

					if (response.status === 401 || response.status === 403) {
						throw new Error(
							"Claude OAuth token invalid or expired. Re-authenticate with: claude auth login",
						);
					} else if (response.status === 429) {
						throw new Error("Rate limit exceeded (subscription limit reached)");
					} else if (response.status >= 500) {
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

				if (error instanceof Error) {
					if (error.name === "AbortError") {
						throw new Error(`Request timed out after ${this.timeout}ms`);
					}
				}
				throw error;
			}
		});
	}

	/**
	 * Build system prompt array for OAuth authentication.
	 * The Claude Code prefix MUST be the first element for OAuth to work.
	 * Returns an array of text objects as required by Anthropic's API.
	 */
	private buildSystemPrompt(
		messages: LLMMessage[],
		optionsSystemPrompt?: string,
	): Array<{ type: "text"; text: string }> {
		// Claude Code prefix must be first - this is validated by Anthropic
		const systemBlocks: Array<{ type: "text"; text: string }> = [
			{ type: "text", text: CLAUDE_CODE_SYSTEM_PREFIX },
		];

		// Add options system prompt if provided
		if (optionsSystemPrompt) {
			systemBlocks.push({ type: "text", text: optionsSystemPrompt });
		}

		// Add system messages from the messages array
		for (const msg of messages) {
			if (msg.role === "system") {
				systemBlocks.push({ type: "text", text: msg.content });
			}
		}

		return systemBlocks;
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

	/**
	 * Test if we can authenticate with the stored token
	 */
	async testConnection(): Promise<boolean> {
		try {
			const result = await this.complete(
				[{ role: "user", content: "Reply with only: ok" }],
				{ maxTokens: 10 },
			);
			return result.content.toLowerCase().includes("ok");
		} catch {
			return false;
		}
	}
}
