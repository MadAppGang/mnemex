/**
 * Benchmark Types
 *
 * Core type definitions for the LLM benchmark system.
 * Evaluates different LLM models for generating FileSummary and SymbolSummary.
 */

import type {
	CodeChunk,
	FileSummary,
	LLMProvider,
	SymbolSummary,
} from "../types.js";

// ============================================================================
// Generator Types
// ============================================================================

/** Information about a generator model */
export interface GeneratorInfo {
	/** LLM provider (anthropic, openrouter, ollama, local) */
	provider: LLMProvider;
	/** Model identifier (e.g., "claude-sonnet-4", "gpt-4o") */
	model: string;
	/** Human-readable display name */
	displayName: string;
	/** Custom API endpoint (for local providers like LM Studio) */
	endpoint?: string;
}

/** Result of generating a single summary */
export interface GenerationResult<T extends FileSummary | SymbolSummary> {
	/** The generated summary */
	result: T;
	/** Time taken to generate in milliseconds */
	durationMs: number;
	/** Token usage and cost */
	usage: {
		inputTokens: number;
		outputTokens: number;
		cost: number;
	};
}

/** Accumulated usage statistics for a generator */
export interface UsageStats {
	inputTokens: number;
	outputTokens: number;
	cost: number;
	calls: number;
}

/** Summary generator interface - implementations generate summaries using LLM */
export interface ISummaryGenerator {
	/** Generate FileSummary for a file */
	generateFileSummary(
		filePath: string,
		fileContent: string,
		language: string,
		codeChunks: CodeChunk[],
	): Promise<GenerationResult<FileSummary>>;

	/** Generate SymbolSummary for a code chunk */
	generateSymbolSummary(
		chunk: CodeChunk,
		fileContent: string,
		language: string,
	): Promise<GenerationResult<SymbolSummary>>;

	/** Get generator info */
	getInfo(): GeneratorInfo;

	/** Get accumulated usage stats */
	getUsage(): UsageStats;

	/** Reset usage tracking */
	resetUsage(): void;
}

// ============================================================================
// Judge Types
// ============================================================================

/** Information about a judge */
export interface JudgeInfo {
	/** Judge name/identifier */
	name: string;
	/** Model used (for LLM judges) */
	model?: string;
	/** Type of judge */
	type: "llm" | "consensus" | "blind";
}

/** Context provided to judges for evaluation */
export interface JudgeContext {
	/** Path to the source file */
	filePath: string;
	/** Full content of the source file */
	fileContent: string;
	/** Programming language */
	language: string;
	/** Code chunk being summarized (for symbol summaries) */
	codeChunk?: CodeChunk;
}

/** Result of judging a summary */
export interface JudgmentResult {
	/** Usefulness score (0-100) - does it help understand the code? */
	usefulness: number;
	/** Conciseness score (0-100) - is it information-dense? */
	conciseness: number;
	/** Clarity score (0-100) - is it clear and well-written? */
	clarity: number;
	/** Overall quality score (0-100) */
	qualityScore: number;
	/** Textual feedback/reasoning */
	feedback?: string;
	/** Which judge produced this result */
	judgedBy: string;
	/** Time taken to judge */
	durationMs: number;
}

/** Judge interface - implementations evaluate summary quality */
export interface IJudge {
	/** Judge a generated summary */
	judge(
		generated: FileSummary | SymbolSummary,
		context: JudgeContext,
	): Promise<JudgmentResult>;

	/** Get judge info */
	getInfo(): JudgeInfo;
}

// ============================================================================
// Scorer Types
// ============================================================================

/** Scoring criterion with name and weight */
export interface ScoringCriterion {
	/** Criterion name (e.g., "correctness", "completeness") */
	name: string;
	/** Weight for this criterion (0-1, all weights sum to 1) */
	weight: number;
	/** Description of what this criterion measures */
	description: string;
}

/** Result of scoring a single test case */
export interface ScoreResult {
	/** Criterion name */
	criterion: string;
	/** Raw score (0-100) */
	score: number;
	/** Weight from criterion */
	weight: number;
	/** Weighted score (score * weight) */
	weightedScore: number;
	/** Additional scoring details */
	details: Record<string, unknown>;
}

/** Scorer interface - implementations score based on specific criteria */
export interface IScorer {
	/** Score a generation result */
	score(
		testCase: TestCase,
		generation: GenerationResult<FileSummary | SymbolSummary>,
		judgment?: JudgmentResult,
	): Promise<ScoreResult>;

	/** Get the criterion this scorer evaluates */
	getCriterion(): ScoringCriterion;
}

// ============================================================================
// Test Case Types
// ============================================================================

/** Type of test case */
export type TestCaseType = "file_summary" | "symbol_summary";

/** Ground truth extracted from AST */
export interface ASTGroundTruth {
	/** Exported symbols (for file summaries) */
	exports: string[];
	/** Imported dependencies (for file summaries) */
	dependencies: string[];
	/** Parameters with names and optional types (for symbol summaries) */
	parameters: Array<{
		name: string;
		type?: string;
	}>;
	/** Return type (for symbol summaries) */
	returnType?: string;
	/** Whether the function is async */
	isAsync: boolean;
	/** Side effects detected from code patterns */
	sideEffects: string[];
}

/** A single test case for benchmarking */
export interface TestCase {
	/** Unique identifier */
	id: string;
	/** Type of summary to generate */
	type: TestCaseType;
	/** Path to the source file */
	filePath: string;
	/** Full file content */
	fileContent: string;
	/** Programming language */
	language: string;
	/** Code chunk (for symbol summaries) */
	codeChunk?: CodeChunk;
	/** All code chunks in the file (for file summaries) */
	codeChunks?: CodeChunk[];
	/** Ground truth extracted from AST */
	groundTruth: ASTGroundTruth;
}

// ============================================================================
// Benchmark Result Types
// ============================================================================

/** Result of evaluating a single test case */
export interface TestCaseResult {
	/** The test case */
	testCase: TestCase;
	/** Generation result from the model */
	generation: GenerationResult<FileSummary | SymbolSummary>;
	/** Judgment from the judge(s) */
	judgment?: JudgmentResult;
	/** Individual scores by criterion */
	scores: ScoreResult[];
	/** Overall weighted score */
	overallScore: number;
	/** Any errors during evaluation */
	error?: string;
}

/** Per-judge score breakdown */
export interface JudgeScoreBreakdown {
	/** Judge name/model */
	judge: string;
	/** Quality score from this judge */
	qualityScore: number;
	/** Usefulness score from this judge */
	usefulness: number;
	/** Conciseness score from this judge */
	conciseness: number;
}

/** Aggregate scores for a generator */
export interface AggregateScores {
	/** Overall weighted score (0-100) */
	overall: number;
	/** Correctness score (0-100) - AST validation */
	correctness: number;
	/** Completeness score (0-100) - all fields covered */
	completeness: number;
	/** Usefulness score (0-100) - from judge (median) */
	usefulness: number;
	/** Conciseness score (0-100) - from judge (median) */
	conciseness: number;
	/** Speed score (0-100) - normalized, fastest=100 */
	speed: number;
	/** Cost efficiency score (0-100) - normalized, cheapest=100 */
	cost: number;
	/** Per-judge score breakdown (for multi-judge runs) */
	judgeBreakdown?: JudgeScoreBreakdown[];
}

/** Performance metrics for a generator */
export interface PerformanceMetrics {
	/** Average generation time in milliseconds */
	avgDurationMs: number;
	/** Total cost in USD */
	totalCost: number;
	/** Total tokens used */
	totalTokens: number;
	/** Success rate (0-1) */
	successRate: number;
	/** Number of failures */
	failures: number;
	/** Actual error messages from failures */
	errors?: string[];
}

/** Complete results for a single generator */
export interface GeneratorResults {
	/** Generator info */
	info: GeneratorInfo;
	/** Aggregate scores */
	scores: AggregateScores;
	/** Performance metrics */
	metrics: PerformanceMetrics;
	/** Per-test-case results */
	testCaseResults: TestCaseResult[];
}

/** Rankings across all generators */
export interface Rankings {
	/** Ranked by overall score (best first) */
	byOverallScore: string[];
	/** Ranked by correctness */
	byCorrectness: string[];
	/** Ranked by speed */
	bySpeed: string[];
	/** Ranked by cost efficiency */
	byCost: string[];
}

/** Benchmark metadata */
export interface BenchmarkMetadata {
	/** Project path that was benchmarked */
	projectPath: string;
	/** When the benchmark was run */
	timestamp: string;
	/** Total number of test cases */
	totalTestCases: number;
	/** Test cases by type */
	testCaseTypes: Record<TestCaseType, number>;
	/** Judge models used */
	judges: string[];
	/** Scoring weights used */
	weights: Record<string, number>;
}

/** Complete benchmark results */
export interface BenchmarkResults {
	/** Benchmark metadata */
	metadata: BenchmarkMetadata;
	/** Results per generator */
	generators: GeneratorResults[];
	/** Rankings across generators */
	rankings: Rankings;
}

// ============================================================================
// Reporter Types
// ============================================================================

/** Output format for reports */
export type ReportFormat = "cli" | "json" | "detailed";

/** Reporter interface - implementations format and output results */
export interface IReporter {
	/** Generate report from benchmark results */
	report(results: BenchmarkResults): Promise<string>;

	/** Get the format this reporter produces */
	getFormat(): ReportFormat;
}

// ============================================================================
// Configuration Types
// ============================================================================

/** Default scoring weights */
export const DEFAULT_WEIGHTS: Record<string, number> = {
	correctness: 0.3,
	completeness: 0.2,
	usefulness: 0.2,
	conciseness: 0.1,
	speed: 0.1,
	cost: 0.1,
};

/** Benchmark configuration */
export interface BenchmarkConfig {
	/** Generator models to test */
	generators: GeneratorInfo[];
	/** Judge models (user-selected) */
	judges: string[];
	/** Number of test cases to run */
	testCaseCount: number;
	/** Types of summaries to test */
	testCaseTypes: TestCaseType[];
	/** Scoring weights (defaults to DEFAULT_WEIGHTS) */
	weights?: Record<string, number>;
	/** Path to the project to benchmark */
	projectPath: string;
	/** Output formats to generate */
	outputFormats: ReportFormat[];
	/** Progress callback */
	onProgress?: BenchmarkProgressCallback;
	/** Enable verbose/diagnostic logging to stderr */
	verbose?: boolean;
}

/** Progress callback for benchmark operations */
export type BenchmarkProgressCallback = (
	phase: BenchmarkPhase,
	completed: number,
	total: number,
	details?: string,
) => void;

/** Phases of the benchmark process */
export type BenchmarkPhase =
	| "preparing"
	| "generating"
	| "judging"
	| "scoring"
	| "reporting";
