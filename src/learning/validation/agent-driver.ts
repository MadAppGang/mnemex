/**
 * Agent Driver Interface
 *
 * Defines how the synthetic user communicates with the agent under test.
 * Supports both local (embedded) and HTTP-based agent communication.
 *
 * @module learning/validation/agent-driver
 */

import type {
	AgentResponse,
	AgentConfig,
	ToolCall,
	AgentError,
	TokenUsage,
} from "./types.js";

// ============================================================================
// Agent Driver Interface
// ============================================================================

/**
 * Interface for communicating with an agent under test.
 * Implementations handle the specifics of message transport.
 */
export interface AgentDriver {
	/**
	 * Initialize the driver with configuration
	 */
	initialize(config: AgentConfig): Promise<void>;

	/**
	 * Send a message to the agent and receive a response
	 */
	sendMessage(message: string): Promise<AgentResponse>;

	/**
	 * Execute a tool call made by the agent
	 */
	executeTool(tool: ToolCall): Promise<ToolExecutionResult>;

	/**
	 * Reset the agent's conversation state
	 */
	reset(): Promise<void>;

	/**
	 * Clean up resources
	 */
	dispose(): Promise<void>;

	/**
	 * Get current session statistics
	 */
	getStats(): DriverStats;
}

// ============================================================================
// Supporting Types
// ============================================================================

export interface ToolExecutionResult {
	success: boolean;
	result?: unknown;
	error?: string;
	durationMs: number;
}

export interface DriverStats {
	messagesExchanged: number;
	toolCallsExecuted: number;
	totalTokensUsed: TokenUsage;
	errorCount: number;
	avgResponseTimeMs: number;
}

export interface LocalDriverConfig {
	workingDirectory: string;
	allowedTools: string[];
	blockedTools?: string[];
	timeout: number;
	maxTokens: number;
}

export interface HttpDriverConfig {
	baseUrl: string;
	apiKey: string;
	timeout: number;
	retryCount: number;
	headers?: Record<string, string>;
}

// ============================================================================
// Local Agent Driver (Embedded)
// ============================================================================

/**
 * Driver for local/embedded agent execution.
 * Runs the agent in the same process with direct tool access.
 */
export class LocalAgentDriver implements AgentDriver {
	private config: AgentConfig | null = null;
	private localConfig: LocalDriverConfig;
	private conversationHistory: ConversationMessage[] = [];
	private stats: DriverStats;

	constructor(localConfig: LocalDriverConfig) {
		this.localConfig = localConfig;
		this.stats = this.createInitialStats();
	}

	async initialize(config: AgentConfig): Promise<void> {
		this.config = config;
		this.conversationHistory = [];
		this.stats = this.createInitialStats();
	}

	async sendMessage(message: string): Promise<AgentResponse> {
		if (!this.config) {
			throw new Error("Driver not initialized. Call initialize() first.");
		}

		const startTime = Date.now();

		// Add user message to history
		this.conversationHistory.push({
			role: "user",
			content: message,
			timestamp: startTime,
		});

		try {
			// In a real implementation, this would invoke the actual agent
			// For now, we define the interface and stub the implementation
			const response = await this.invokeAgent(message);

			// Track stats
			this.stats.messagesExchanged++;
			this.stats.totalTokensUsed.input += response.tokens.input;
			this.stats.totalTokensUsed.output += response.tokens.output;

			const responseTime = Date.now() - startTime;
			this.stats.avgResponseTimeMs = this.calculateRunningAverage(
				this.stats.avgResponseTimeMs,
				responseTime,
				this.stats.messagesExchanged,
			);

			// Add assistant response to history
			this.conversationHistory.push({
				role: "assistant",
				content: response.content,
				timestamp: Date.now(),
				toolCalls: response.toolCalls,
			});

			return response;
		} catch (error) {
			this.stats.errorCount++;
			throw error;
		}
	}

	async executeTool(tool: ToolCall): Promise<ToolExecutionResult> {
		const startTime = Date.now();

		// Validate tool is allowed
		if (!this.isToolAllowed(tool.name)) {
			return {
				success: false,
				error: `Tool "${tool.name}" is not allowed in this validation context`,
				durationMs: Date.now() - startTime,
			};
		}

		try {
			// Execute the tool in a sandboxed environment
			const result = await this.executeToolSandboxed(tool);

			this.stats.toolCallsExecuted++;

			return {
				success: true,
				result,
				durationMs: Date.now() - startTime,
			};
		} catch (error) {
			this.stats.errorCount++;
			return {
				success: false,
				error: error instanceof Error ? error.message : String(error),
				durationMs: Date.now() - startTime,
			};
		}
	}

	async reset(): Promise<void> {
		this.conversationHistory = [];
		// Stats are preserved across resets for aggregate tracking
	}

	async dispose(): Promise<void> {
		this.conversationHistory = [];
		this.config = null;
	}

	getStats(): DriverStats {
		return { ...this.stats };
	}

	// Private helper methods

	private createInitialStats(): DriverStats {
		return {
			messagesExchanged: 0,
			toolCallsExecuted: 0,
			totalTokensUsed: { input: 0, output: 0 },
			errorCount: 0,
			avgResponseTimeMs: 0,
		};
	}

	private calculateRunningAverage(
		currentAvg: number,
		newValue: number,
		count: number,
	): number {
		return currentAvg + (newValue - currentAvg) / count;
	}

	private isToolAllowed(toolName: string): boolean {
		// Check blocked list first
		if (this.localConfig.blockedTools?.includes(toolName)) {
			return false;
		}

		// If allowedTools is empty, all tools are allowed (except blocked)
		if (this.localConfig.allowedTools.length === 0) {
			return true;
		}

		return this.localConfig.allowedTools.includes(toolName);
	}

	private async invokeAgent(message: string): Promise<AgentResponse> {
		// Stub implementation - actual agent invocation would happen here
		// This is where we'd integrate with Claude SDK or similar

		// For now, return a placeholder that indicates no implementation
		throw new Error(
			"LocalAgentDriver.invokeAgent() not yet implemented. " +
				"Requires integration with Claude SDK or agent framework.",
		);
	}

	private async executeToolSandboxed(tool: ToolCall): Promise<unknown> {
		// Stub implementation - actual tool execution would happen here
		// This is where we'd integrate with the tool execution framework

		throw new Error(
			"LocalAgentDriver.executeToolSandboxed() not yet implemented. " +
				"Requires integration with tool execution framework.",
		);
	}
}

// ============================================================================
// HTTP Agent Driver
// ============================================================================

/**
 * Driver for HTTP-based agent communication.
 * Communicates with an agent over HTTP/REST API.
 */
export class HttpAgentDriver implements AgentDriver {
	private config: AgentConfig | null = null;
	private httpConfig: HttpDriverConfig;
	private sessionId: string | null = null;
	private stats: DriverStats;

	constructor(httpConfig: HttpDriverConfig) {
		this.httpConfig = httpConfig;
		this.stats = this.createInitialStats();
	}

	async initialize(config: AgentConfig): Promise<void> {
		this.config = config;
		this.stats = this.createInitialStats();

		// Create a new session with the agent
		const response = await this.httpRequest<SessionResponse>(
			"POST",
			"/sessions",
			{
				model: config.model,
				improvements: config.improvements,
				temperature: config.temperature,
				maxTokens: config.maxTokens,
			},
		);

		this.sessionId = response.sessionId;
	}

	async sendMessage(message: string): Promise<AgentResponse> {
		if (!this.sessionId) {
			throw new Error("No active session. Call initialize() first.");
		}

		const startTime = Date.now();

		try {
			const response = await this.httpRequest<AgentResponse>(
				"POST",
				`/sessions/${this.sessionId}/messages`,
				{ content: message },
			);

			// Track stats
			this.stats.messagesExchanged++;
			this.stats.totalTokensUsed.input += response.tokens.input;
			this.stats.totalTokensUsed.output += response.tokens.output;

			const responseTime = Date.now() - startTime;
			this.stats.avgResponseTimeMs = this.calculateRunningAverage(
				this.stats.avgResponseTimeMs,
				responseTime,
				this.stats.messagesExchanged,
			);

			return response;
		} catch (error) {
			this.stats.errorCount++;
			throw error;
		}
	}

	async executeTool(tool: ToolCall): Promise<ToolExecutionResult> {
		if (!this.sessionId) {
			throw new Error("No active session. Call initialize() first.");
		}

		const startTime = Date.now();

		try {
			const response = await this.httpRequest<ToolExecutionResult>(
				"POST",
				`/sessions/${this.sessionId}/tools/${tool.id}`,
				{ args: tool.args },
			);

			this.stats.toolCallsExecuted++;

			return {
				...response,
				durationMs: Date.now() - startTime,
			};
		} catch (error) {
			this.stats.errorCount++;
			return {
				success: false,
				error: error instanceof Error ? error.message : String(error),
				durationMs: Date.now() - startTime,
			};
		}
	}

	async reset(): Promise<void> {
		if (this.sessionId) {
			await this.httpRequest("POST", `/sessions/${this.sessionId}/reset`, {});
		}
	}

	async dispose(): Promise<void> {
		if (this.sessionId) {
			try {
				await this.httpRequest("DELETE", `/sessions/${this.sessionId}`, {});
			} catch {
				// Ignore cleanup errors
			}
			this.sessionId = null;
		}
		this.config = null;
	}

	getStats(): DriverStats {
		return { ...this.stats };
	}

	// Private helper methods

	private createInitialStats(): DriverStats {
		return {
			messagesExchanged: 0,
			toolCallsExecuted: 0,
			totalTokensUsed: { input: 0, output: 0 },
			errorCount: 0,
			avgResponseTimeMs: 0,
		};
	}

	private calculateRunningAverage(
		currentAvg: number,
		newValue: number,
		count: number,
	): number {
		return currentAvg + (newValue - currentAvg) / count;
	}

	private async httpRequest<T>(
		method: string,
		path: string,
		body: unknown,
	): Promise<T> {
		const url = `${this.httpConfig.baseUrl}${path}`;
		const controller = new AbortController();
		const timeoutId = setTimeout(
			() => controller.abort(),
			this.httpConfig.timeout,
		);

		try {
			const response = await fetch(url, {
				method,
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${this.httpConfig.apiKey}`,
					...this.httpConfig.headers,
				},
				body: JSON.stringify(body),
				signal: controller.signal,
			});

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(`HTTP ${response.status}: ${errorText}`);
			}

			return response.json() as Promise<T>;
		} finally {
			clearTimeout(timeoutId);
		}
	}
}

// ============================================================================
// Mock Agent Driver (for testing)
// ============================================================================

/**
 * Mock driver for testing the validation system itself.
 * Returns predefined responses based on configured scenarios.
 */
export class MockAgentDriver implements AgentDriver {
	private config: AgentConfig | null = null;
	private responses: MockResponse[] = [];
	private responseIndex = 0;
	private stats: DriverStats;

	constructor(responses: MockResponse[] = []) {
		this.responses = responses;
		this.stats = this.createInitialStats();
	}

	async initialize(config: AgentConfig): Promise<void> {
		this.config = config;
		this.responseIndex = 0;
		this.stats = this.createInitialStats();
	}

	async sendMessage(message: string): Promise<AgentResponse> {
		this.stats.messagesExchanged++;

		// Return next mock response, or default if exhausted
		if (this.responseIndex < this.responses.length) {
			const mockResponse = this.responses[this.responseIndex++];
			return this.convertMockResponse(mockResponse);
		}

		// Default response when no more mocks
		return {
			content: "Mock response: no more configured responses",
			isQuestion: false,
			toolCalls: [],
			tokens: { input: 100, output: 50 },
		};
	}

	async executeTool(tool: ToolCall): Promise<ToolExecutionResult> {
		this.stats.toolCallsExecuted++;
		return {
			success: true,
			result: { mock: true, toolName: tool.name },
			durationMs: 10,
		};
	}

	async reset(): Promise<void> {
		this.responseIndex = 0;
	}

	async dispose(): Promise<void> {
		this.config = null;
		this.responses = [];
	}

	getStats(): DriverStats {
		return { ...this.stats };
	}

	// Allow adding responses dynamically
	addResponse(response: MockResponse): void {
		this.responses.push(response);
	}

	private createInitialStats(): DriverStats {
		return {
			messagesExchanged: 0,
			toolCallsExecuted: 0,
			totalTokensUsed: { input: 0, output: 0 },
			errorCount: 0,
			avgResponseTimeMs: 0,
		};
	}

	private convertMockResponse(mock: MockResponse): AgentResponse {
		return {
			content: mock.content,
			isQuestion: mock.isQuestion ?? false,
			question: mock.question,
			toolCalls: mock.toolCalls ?? [],
			error: mock.error,
			tokens: mock.tokens ?? { input: 100, output: 50 },
		};
	}
}

export interface MockResponse {
	content: string;
	isQuestion?: boolean;
	question?: string;
	toolCalls?: ToolCall[];
	error?: AgentError;
	tokens?: TokenUsage;
}

// ============================================================================
// Helper Types
// ============================================================================

interface ConversationMessage {
	role: "user" | "assistant" | "system";
	content: string;
	timestamp: number;
	toolCalls?: ToolCall[];
}

interface SessionResponse {
	sessionId: string;
	createdAt: number;
}

// ============================================================================
// Factory Function
// ============================================================================

export type DriverType = "local" | "http" | "mock";

export interface CreateDriverOptions {
	type: DriverType;
	localConfig?: LocalDriverConfig;
	httpConfig?: HttpDriverConfig;
	mockResponses?: MockResponse[];
}

/**
 * Factory function to create the appropriate agent driver
 */
export function createAgentDriver(options: CreateDriverOptions): AgentDriver {
	switch (options.type) {
		case "local":
			if (!options.localConfig) {
				throw new Error("localConfig required for local driver");
			}
			return new LocalAgentDriver(options.localConfig);

		case "http":
			if (!options.httpConfig) {
				throw new Error("httpConfig required for http driver");
			}
			return new HttpAgentDriver(options.httpConfig);

		case "mock":
			return new MockAgentDriver(options.mockResponses ?? []);

		default:
			throw new Error(`Unknown driver type: ${options.type}`);
	}
}
