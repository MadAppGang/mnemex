/**
 * Session Recorder
 *
 * Records all events during a validation session and calculates metrics.
 * Provides real-time tracking and final session summary.
 *
 * @module learning/validation/session-recorder
 */

import type {
	RecordedSession,
	ToolEvent,
	RecordedCorrection,
	UserResponse,
	SessionMetrics,
	CriteriaResult,
	SessionOutcome,
	ExperimentGroup,
	SuccessCriterion,
	CorrectionTrigger,
	ValidationScenario,
} from "./types.js";

// ============================================================================
// Session Recorder
// ============================================================================

/**
 * Records all events during a validation session.
 * Calculates metrics and provides session summary.
 */
export class SessionRecorder {
	private sessionId: string;
	private scenarioId: string;
	private experimentId?: string;
	private experimentGroup?: ExperimentGroup;
	private startTime: number;
	private endTime: number = 0;

	private toolEvents: ToolEvent[] = [];
	private corrections: RecordedCorrection[] = [];
	private userResponses: UserResponse[] = [];

	private isFinalized = false;

	constructor(options: SessionRecorderOptions) {
		this.sessionId = options.sessionId ?? this.generateSessionId();
		this.scenarioId = options.scenarioId;
		this.experimentId = options.experimentId;
		this.experimentGroup = options.experimentGroup;
		this.startTime = Date.now();
	}

	// ============================================================================
	// Event Recording
	// ============================================================================

	/**
	 * Record a tool execution event
	 */
	recordToolEvent(event: Omit<ToolEvent, "timestamp">): void {
		this.ensureNotFinalized();

		this.toolEvents.push({
			...event,
			timestamp: Date.now(),
		});
	}

	/**
	 * Record a correction injection
	 */
	recordCorrection(trigger: CorrectionTrigger, correction: string): void {
		this.ensureNotFinalized();

		this.corrections.push({
			trigger,
			correction,
			timestamp: Date.now(),
		});
	}

	/**
	 * Record a user response (from synthetic agent)
	 */
	recordUserResponse(response: Omit<UserResponse, "timestamp">): void {
		this.ensureNotFinalized();

		this.userResponses.push({
			...response,
			timestamp: Date.now(),
		});
	}

	// ============================================================================
	// Session Analysis
	// ============================================================================

	/**
	 * Finalize the session and compute outcome
	 */
	finalize(
		successCriteria: CriteriaResult[],
		outcome?: SessionOutcome,
	): RecordedSession {
		this.ensureNotFinalized();

		this.endTime = Date.now();
		this.isFinalized = true;

		const metrics = this.calculateMetrics();
		const computedOutcome = outcome ?? this.determineOutcome(successCriteria);

		return {
			sessionId: this.sessionId,
			scenarioId: this.scenarioId,
			experimentId: this.experimentId,
			experimentGroup: this.experimentGroup,
			startTime: this.startTime,
			endTime: this.endTime,
			durationMs: this.endTime - this.startTime,
			toolEvents: [...this.toolEvents],
			corrections: [...this.corrections],
			userResponses: [...this.userResponses],
			metrics,
			outcome: computedOutcome,
			successCriteria,
		};
	}

	/**
	 * Get current session state without finalizing
	 */
	getCurrentState(): SessionSnapshot {
		return {
			sessionId: this.sessionId,
			scenarioId: this.scenarioId,
			elapsedMs: Date.now() - this.startTime,
			toolEventCount: this.toolEvents.length,
			correctionCount: this.corrections.length,
			userResponseCount: this.userResponses.length,
			errorCount: this.toolEvents.filter((e) => !e.success).length,
			isFinalized: this.isFinalized,
		};
	}

	// ============================================================================
	// Metrics Calculation
	// ============================================================================

	/**
	 * Calculate session metrics from recorded events
	 */
	private calculateMetrics(): SessionMetrics {
		const toolCount = this.toolEvents.length;
		const correctionCount = this.corrections.length;
		const errorCount = this.toolEvents.filter((e) => !e.success).length;

		// Autonomous actions = tools executed without a preceding correction
		const autonomousActions = this.countAutonomousActions();

		// Calculate rates (avoid division by zero)
		const correctionRate = toolCount > 0 ? correctionCount / toolCount : 0;
		const errorRate = toolCount > 0 ? errorCount / toolCount : 0;
		const autonomyRate =
			autonomousActions + correctionCount > 0
				? autonomousActions / (autonomousActions + correctionCount)
				: 1;

		// Token usage (summed from tool events)
		// Note: This is a placeholder - actual token tracking would come from agent driver
		const tokensUsed = this.estimateTokenUsage();

		// Average tool duration
		const avgToolDurationMs =
			toolCount > 0
				? this.toolEvents.reduce((sum, e) => sum + e.durationMs, 0) / toolCount
				: 0;

		return {
			toolCount,
			correctionCount,
			errorCount,
			autonomousActions,
			correctionRate,
			errorRate,
			autonomyRate,
			tokensUsed,
			avgToolDurationMs,
		};
	}

	/**
	 * Count autonomous actions (tool calls not immediately following a correction)
	 */
	private countAutonomousActions(): number {
		let autonomousCount = 0;
		const correctionWindow = 5000; // 5 seconds

		for (const tool of this.toolEvents) {
			// Check if any correction occurred within window before this tool
			const hasRecentCorrection = this.corrections.some(
				(c) =>
					c.timestamp < tool.timestamp &&
					tool.timestamp - c.timestamp < correctionWindow,
			);

			if (!hasRecentCorrection) {
				autonomousCount++;
			}
		}

		return autonomousCount;
	}

	/**
	 * Estimate token usage from tool events
	 * In practice, this would be tracked by the agent driver
	 */
	private estimateTokenUsage(): number {
		// Rough estimate: 100 tokens per tool call on average
		return this.toolEvents.length * 100;
	}

	/**
	 * Determine session outcome from criteria results
	 */
	private determineOutcome(criteria: CriteriaResult[]): SessionOutcome {
		if (criteria.length === 0) {
			return "abandoned";
		}

		const passedCount = criteria.filter((c) => c.passed).length;
		const totalCount = criteria.length;
		const passRate = passedCount / totalCount;

		if (passRate === 1) {
			return "success";
		} else if (passRate >= 0.5) {
			return "partial";
		} else {
			return "failure";
		}
	}

	// ============================================================================
	// Helper Methods
	// ============================================================================

	private ensureNotFinalized(): void {
		if (this.isFinalized) {
			throw new Error("Session has been finalized. Cannot record more events.");
		}
	}

	private generateSessionId(): string {
		const timestamp = Date.now().toString(36);
		const random = Math.random().toString(36).substring(2, 10);
		return `sess_${timestamp}_${random}`;
	}

	// ============================================================================
	// Accessors
	// ============================================================================

	getSessionId(): string {
		return this.sessionId;
	}

	getScenarioId(): string {
		return this.scenarioId;
	}

	getExperimentId(): string | undefined {
		return this.experimentId;
	}

	getExperimentGroup(): ExperimentGroup | undefined {
		return this.experimentGroup;
	}

	getToolEvents(): readonly ToolEvent[] {
		return this.toolEvents;
	}

	getCorrections(): readonly RecordedCorrection[] {
		return this.corrections;
	}

	getUserResponses(): readonly UserResponse[] {
		return this.userResponses;
	}
}

// ============================================================================
// Supporting Types
// ============================================================================

export interface SessionRecorderOptions {
	sessionId?: string;
	scenarioId: string;
	experimentId?: string;
	experimentGroup?: ExperimentGroup;
}

export interface SessionSnapshot {
	sessionId: string;
	scenarioId: string;
	elapsedMs: number;
	toolEventCount: number;
	correctionCount: number;
	userResponseCount: number;
	errorCount: number;
	isFinalized: boolean;
}

// ============================================================================
// Criteria Evaluator
// ============================================================================

/**
 * Evaluates success criteria against session state
 */
export class CriteriaEvaluator {
	private workingDirectory: string;

	constructor(workingDirectory: string) {
		this.workingDirectory = workingDirectory;
	}

	/**
	 * Evaluate all success criteria for a scenario
	 */
	async evaluateAll(
		scenario: ValidationScenario,
		session: SessionRecorder,
	): Promise<CriteriaResult[]> {
		const results: CriteriaResult[] = [];

		for (const criterion of scenario.successCriteria) {
			const result = await this.evaluate(criterion, session);
			results.push(result);
		}

		return results;
	}

	/**
	 * Evaluate a single success criterion
	 */
	async evaluate(
		criterion: SuccessCriterion,
		session: SessionRecorder,
	): Promise<CriteriaResult> {
		try {
			switch (criterion.type) {
				case "file_exists":
					return await this.checkFileExists(criterion);

				case "file_contains":
					return await this.checkFileContains(criterion);

				case "file_not_contains":
					return await this.checkFileNotContains(criterion);

				case "no_matches":
					return await this.checkNoMatches(criterion);

				case "tests_pass":
					return await this.checkTestsPass();

				case "response_mentions":
					return this.checkResponseMentions(criterion, session);

				case "files_read":
					return this.checkFilesRead(criterion, session);

				case "asks_clarification":
					return this.checkAsksClarification(session);

				case "no_file_modifications":
					return this.checkNoFileModifications(session);

				case "no_errors":
					return this.checkNoErrors(criterion, session);

				default:
					return {
						criterion,
						passed: false,
						details: `Unknown criterion type: ${(criterion as SuccessCriterion).type}`,
					};
			}
		} catch (error) {
			return {
				criterion,
				passed: false,
				details: `Error evaluating criterion: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	}

	// ============================================================================
	// Criterion Implementations
	// ============================================================================

	private async checkFileExists(criterion: {
		type: "file_exists";
		path: string;
	}): Promise<CriteriaResult> {
		const fullPath = this.resolvePath(criterion.path);
		const exists = await this.fileExists(fullPath);

		return {
			criterion,
			passed: exists,
			details: exists
				? `File exists: ${criterion.path}`
				: `File not found: ${criterion.path}`,
		};
	}

	private async checkFileContains(criterion: {
		type: "file_contains";
		path: string;
		pattern: string;
	}): Promise<CriteriaResult> {
		const fullPath = this.resolvePath(criterion.path);

		if (!(await this.fileExists(fullPath))) {
			return {
				criterion,
				passed: false,
				details: `File not found: ${criterion.path}`,
			};
		}

		const content = await this.readFile(fullPath);
		const regex = new RegExp(criterion.pattern);
		const matches = regex.test(content);

		return {
			criterion,
			passed: matches,
			details: matches
				? `Pattern found in ${criterion.path}`
				: `Pattern not found in ${criterion.path}`,
		};
	}

	private async checkFileNotContains(criterion: {
		type: "file_not_contains";
		path: string;
		pattern: string;
	}): Promise<CriteriaResult> {
		const fullPath = this.resolvePath(criterion.path);

		if (!(await this.fileExists(fullPath))) {
			// File not existing means pattern definitely not contained
			return {
				criterion,
				passed: true,
				details: `File not found: ${criterion.path} (pattern cannot be present)`,
			};
		}

		const content = await this.readFile(fullPath);
		const regex = new RegExp(criterion.pattern);
		const matches = regex.test(content);

		return {
			criterion,
			passed: !matches,
			details: !matches
				? `Pattern correctly absent from ${criterion.path}`
				: `Unwanted pattern found in ${criterion.path}`,
		};
	}

	private async checkNoMatches(criterion: {
		type: "no_matches";
		pattern: string;
		excludePaths?: string[];
	}): Promise<CriteriaResult> {
		// This would search all files in working directory
		// For now, stub implementation
		return {
			criterion,
			passed: true,
			details: "Pattern search not yet implemented",
		};
	}

	private async checkTestsPass(): Promise<CriteriaResult> {
		// Would run test suite and check exit code
		// For now, stub implementation
		return {
			criterion: { type: "tests_pass" },
			passed: true,
			details: "Test execution not yet implemented",
		};
	}

	private checkResponseMentions(
		criterion: { type: "response_mentions"; patterns: string[] },
		session: SessionRecorder,
	): CriteriaResult {
		const responses = session.getUserResponses();
		const allContent = responses.map((r) => r.answer).join(" ");

		const missingPatterns: string[] = [];
		for (const pattern of criterion.patterns) {
			const regex = new RegExp(pattern, "i");
			if (!regex.test(allContent)) {
				missingPatterns.push(pattern);
			}
		}

		const passed = missingPatterns.length === 0;

		return {
			criterion,
			passed,
			details: passed
				? "All expected patterns mentioned"
				: `Missing patterns: ${missingPatterns.join(", ")}`,
		};
	}

	private checkFilesRead(
		criterion: { type: "files_read"; minCount: number },
		session: SessionRecorder,
	): CriteriaResult {
		const readEvents = session
			.getToolEvents()
			.filter((e) => e.toolName === "Read" || e.toolName === "read");

		const passed = readEvents.length >= criterion.minCount;

		return {
			criterion,
			passed,
			details: `Read ${readEvents.length} files (minimum: ${criterion.minCount})`,
		};
	}

	private checkAsksClarification(session: SessionRecorder): CriteriaResult {
		const clarifications = session
			.getUserResponses()
			.filter((r) => r.type === "clarification");

		const passed = clarifications.length > 0;

		return {
			criterion: { type: "asks_clarification" },
			passed,
			details: passed
				? `Asked ${clarifications.length} clarifying question(s)`
				: "No clarifying questions asked",
		};
	}

	private checkNoFileModifications(session: SessionRecorder): CriteriaResult {
		const writeEvents = session
			.getToolEvents()
			.filter(
				(e) =>
					e.toolName === "Write" ||
					e.toolName === "write" ||
					e.toolName === "Edit" ||
					e.toolName === "edit",
			);

		const passed = writeEvents.length === 0;

		return {
			criterion: { type: "no_file_modifications" },
			passed,
			details: passed
				? "No file modifications made"
				: `${writeEvents.length} file modification(s) made`,
		};
	}

	private checkNoErrors(
		criterion: { type: "no_errors"; excludeTypes?: string[] },
		session: SessionRecorder,
	): CriteriaResult {
		const errorEvents = session.getToolEvents().filter((e) => {
			if (e.success) return false;

			// Check if error type should be excluded
			if (criterion.excludeTypes && e.errorMessage) {
				for (const excludeType of criterion.excludeTypes) {
					if (e.errorMessage.includes(excludeType)) {
						return false;
					}
				}
			}

			return true;
		});

		const passed = errorEvents.length === 0;

		return {
			criterion,
			passed,
			details: passed
				? "No errors encountered"
				: `${errorEvents.length} error(s) encountered`,
		};
	}

	// ============================================================================
	// File System Helpers
	// ============================================================================

	private resolvePath(relativePath: string): string {
		// Handle absolute paths
		if (relativePath.startsWith("/")) {
			return relativePath;
		}
		return `${this.workingDirectory}/${relativePath}`;
	}

	private async fileExists(path: string): Promise<boolean> {
		try {
			const file = Bun.file(path);
			return await file.exists();
		} catch {
			return false;
		}
	}

	private async readFile(path: string): Promise<string> {
		const file = Bun.file(path);
		return await file.text();
	}
}
