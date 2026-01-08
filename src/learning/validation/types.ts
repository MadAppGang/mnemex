/**
 * E2E Validation System Types
 *
 * Core type definitions for the validation system that tests
 * continuous learning improvements using synthetic agents.
 *
 * @module learning/validation/types
 */

// ============================================================================
// Scenario Types
// ============================================================================

export type ScenarioCategory =
	| "file_operations" // Create, edit, delete files
	| "code_search" // Find code, understand codebase
	| "refactoring" // Rename, restructure code
	| "debugging" // Find and fix bugs
	| "testing" // Write and run tests
	| "git_operations" // Commits, branches, PRs
	| "documentation" // Write docs, comments
	| "multi_step" // Complex multi-file changes
	| "error_recovery" // Handle failures gracefully
	| "ambiguous" // Unclear requirements
	| "security"; // Security-related tasks

export type ScenarioDifficulty = 1 | 2 | 3 | 4 | 5;

export interface ValidationScenario {
	id: string;
	name: string;
	description: string;
	difficulty: ScenarioDifficulty;
	category: ScenarioCategory;

	// Setup
	projectTemplate: string; // Path to template project
	initialPrompt: string; // User's opening request

	// User simulation
	persona: UserPersona;

	// Knowledge base for answering agent clarifying questions
	knowledgeBase: ScenarioKnowledgeBase;

	// Expected behavior
	expectedTools: string[]; // Tools that should be used
	forbiddenTools?: string[]; // Tools that should NOT be used
	maxToolCalls: number; // Efficiency bound
	maxCorrections: number; // Quality bound

	// Correction injection
	correctionPoints: CorrectionPoint[];

	// Success validation
	successCriteria: SuccessCriterion[];
}

// ============================================================================
// User Persona Types
// ============================================================================

export type ExpertiseLevel = "novice" | "intermediate" | "expert";
export type Verbosity = "terse" | "normal" | "verbose";
export type CorrectionStyle = "polite" | "direct" | "frustrated";

export interface UserPersona {
	expertiseLevel: ExpertiseLevel;
	verbosity: Verbosity;
	correctionStyle: CorrectionStyle;
	patience: number; // 0-1, how many failures before abandoning
}

// ============================================================================
// Knowledge Base Types
// ============================================================================

export type ProgrammingLanguage =
	| "typescript"
	| "javascript"
	| "python"
	| "go"
	| "rust";
export type PackageManager = "npm" | "yarn" | "pnpm" | "bun";
export type ComponentStyle = "functional" | "class";

export interface ScenarioKnowledgeBase {
	// Project preferences
	language?: ProgrammingLanguage;
	packageManager?: PackageManager;
	framework?: string; // e.g., "react", "vue", "express"
	testFramework?: string; // e.g., "jest", "vitest", "mocha"

	// Style preferences
	styleGuide?: string; // e.g., "airbnb", "standard"
	componentStyle?: ComponentStyle;
	stateManagement?: string; // e.g., "redux", "zustand", "context"

	// Environment
	nodeVersion?: string;
	targetBrowser?: string[];
	deployTarget?: string; // e.g., "vercel", "aws", "docker"

	// Custom Q&A for scenario-specific questions
	customAnswers?: Record<string, string>;
}

export const DEFAULT_KNOWLEDGE_BASE: ScenarioKnowledgeBase = {
	language: "typescript",
	packageManager: "npm",
	testFramework: "jest",
	componentStyle: "functional",
};

// ============================================================================
// Correction Types
// ============================================================================

export interface CorrectionPoint {
	trigger: CorrectionTrigger;
	correction: string;
	expectedRecovery: string[];
}

export type CorrectionTrigger =
	| { type: "tool_count"; threshold: number }
	| { type: "wrong_tool"; tool: string }
	| { type: "file_not_found"; pattern: string }
	| { type: "file_contains"; pattern: string }
	| { type: "error"; errorType: string }
	| { type: "random"; probability: number };

// ============================================================================
// Success Criteria Types
// ============================================================================

export type SuccessCriterion =
	| { type: "file_exists"; path: string }
	| { type: "file_contains"; path: string; pattern: string }
	| { type: "file_not_contains"; path: string; pattern: string }
	| { type: "no_matches"; pattern: string; excludePaths?: string[] }
	| { type: "tests_pass" }
	| { type: "response_mentions"; patterns: string[] }
	| { type: "files_read"; minCount: number }
	| { type: "asks_clarification" }
	| { type: "no_file_modifications" }
	| { type: "no_errors"; excludeTypes?: string[] };

// ============================================================================
// Session Types
// ============================================================================

export type SessionOutcome = "success" | "partial" | "failure" | "abandoned";
export type ExperimentGroup = "treatment" | "control";

export interface RecordedSession {
	sessionId: string;
	scenarioId: string;
	experimentId?: string;
	experimentGroup?: ExperimentGroup;

	// Timing
	startTime: number;
	endTime: number;
	durationMs: number;

	// Events
	toolEvents: ToolEvent[];
	corrections: RecordedCorrection[];
	userResponses: UserResponse[];

	// Aggregates
	metrics: SessionMetrics;

	// Outcome
	outcome: SessionOutcome;
	successCriteria: CriteriaResult[];
}

export interface ToolEvent {
	toolName: string;
	args: Record<string, unknown>;
	result?: unknown;
	success: boolean;
	errorMessage?: string;
	durationMs: number;
	timestamp: number;
}

export interface RecordedCorrection {
	trigger: CorrectionTrigger;
	correction: string;
	timestamp: number;
}

export interface UserResponse {
	type: "clarification" | "correction" | "acknowledgment";
	question?: string;
	answer: string;
	timestamp: number;
}

export interface CriteriaResult {
	criterion: SuccessCriterion;
	passed: boolean;
	details?: string;
}

export interface SessionMetrics {
	toolCount: number;
	correctionCount: number;
	errorCount: number;
	autonomousActions: number;

	// Derived rates
	correctionRate: number; // corrections / toolCount
	errorRate: number; // errors / toolCount
	autonomyRate: number; // autonomous / (autonomous + corrections)

	// Efficiency
	tokensUsed: number;
	avgToolDurationMs: number;
}

// ============================================================================
// Experiment Types
// ============================================================================

export type ExperimentStatus = "pending" | "running" | "complete" | "failed";
export type ExperimentDecisionAction =
	| "graduate"
	| "rollback"
	| "extend"
	| "continue";

export interface ValidationExperiment {
	experimentId: string;
	improvementIds: string[]; // Improvements being tested
	scenarios: string[]; // Scenario IDs to run
	runsPerScenario: number; // Statistical power
	status: ExperimentStatus;
	createdAt: number;
	updatedAt: number;
}

export interface ExperimentResults {
	experimentId: string;
	baseline: AggregateResults;
	treatment: AggregateResults;
	comparison: StatisticalComparison;
	decision: ExperimentDecision;
	completedAt: number;
}

export interface AggregateResults {
	totalRuns: number;
	successfulRuns: number;
	failedRuns: number;
	successRate: number;
	avgCorrectionRate: number;
	avgErrorRate: number;
	avgAutonomyRate: number;
	avgDurationMs: number;

	// Per-scenario breakdown
	byScenario: Map<string, ScenarioResults>;
}

export interface ScenarioResults {
	scenarioId: string;
	runs: number;
	successRate: number;
	avgCorrectionRate: number;
	avgDurationMs: number;
}

// ============================================================================
// Statistical Types
// ============================================================================

export interface StatisticalComparison {
	correctionRate: MetricComparison;
	successRate: MetricComparison;
	autonomyRate: MetricComparison;
	errorRate: MetricComparison;
	overallImproved: boolean;
}

export interface MetricComparison {
	baseline: number;
	treatment: number;
	relativeChange: number;
	pValue: number;
	confidenceInterval: [number, number];
	statisticallySignificant: boolean;
	practicallySignificant: boolean;
	improved: boolean;
}

export interface ExperimentDecision {
	action: ExperimentDecisionAction;
	confidence: number;
	reason: string;
	significantMetrics: string[];
}

// ============================================================================
// Statistical Config Types
// ============================================================================

export interface StatisticalConfig {
	alpha: number; // Base significance (0.05)
	power: number; // Target power (0.80)
	minEffectSize: number; // Minimum practical significance (0.05)
	confidenceLevel: number; // For confidence intervals (0.95)
	multipleTestingCorrection: "bonferroni" | "fdr" | "none";
}

export const DEFAULT_STATISTICAL_CONFIG: StatisticalConfig = {
	alpha: 0.05,
	power: 0.8,
	minEffectSize: 0.05,
	confidenceLevel: 0.95,
	multipleTestingCorrection: "bonferroni",
};

export interface PowerAnalysisConfig {
	alpha: number;
	power: number;
	minEffectSize: number;
	baselineRate: number;
}

// ============================================================================
// Validation Tier Types
// ============================================================================

export type ValidationTier = "smoke" | "standard" | "deep" | "release";

export interface TierConfig {
	name: ValidationTier;
	scenarios: string[] | "all";
	runsPerScenario: number;
	maxDurationMs: number;
	requiredForMerge: boolean;
}

export const VALIDATION_TIERS: Record<ValidationTier, TierConfig> = {
	smoke: {
		name: "smoke",
		scenarios: [
			"file-create-component",
			"code-search-auth",
			"error-recovery-bash",
		],
		runsPerScenario: 1,
		maxDurationMs: 10 * 60 * 1000, // 10 minutes
		requiredForMerge: true,
	},
	standard: {
		name: "standard",
		scenarios: [
			"file-create-component",
			"code-search-auth",
			"refactor-rename-function",
			"error-recovery-bash",
			"ambiguous-add-feature",
		],
		runsPerScenario: 5,
		maxDurationMs: 60 * 60 * 1000, // 1 hour
		requiredForMerge: false,
	},
	deep: {
		name: "deep",
		scenarios: "all",
		runsPerScenario: 20,
		maxDurationMs: 6 * 60 * 60 * 1000, // 6 hours
		requiredForMerge: false,
	},
	release: {
		name: "release",
		scenarios: "all",
		runsPerScenario: 50,
		maxDurationMs: 12 * 60 * 60 * 1000, // 12 hours
		requiredForMerge: false,
	},
};

// ============================================================================
// Execution Types
// ============================================================================

export interface ExecutionTask {
	scenarioId: string;
	runIndex: number;
	config: RunConfig;
}

export interface RunConfig {
	experimentId: string;
	group: ExperimentGroup;
	improvements: string[];
	retryCount?: number;
}

export type ExecutionStatus = "fulfilled" | "rejected" | "timeout";

export interface ExecutionResult {
	task: ExecutionTask;
	status: ExecutionStatus;
	session?: RecordedSession;
	error?: Error;
	durationMs: number;
}

// ============================================================================
// Agent Response Types
// ============================================================================

export interface AgentResponse {
	content: string;
	isQuestion: boolean;
	question?: string;
	toolCalls: ToolCall[];
	error?: AgentError;
	tokens: TokenUsage;
}

export interface ToolCall {
	id: string;
	name: string;
	args: Record<string, unknown>;
}

export interface AgentError {
	type: string;
	message: string;
	recoverable: boolean;
}

export interface TokenUsage {
	input: number;
	output: number;
}

export interface AgentConfig {
	model: string;
	improvements: string[];
	temperature: number;
	maxTokens: number;
}
