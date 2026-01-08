/**
 * Refinement Types
 *
 * Core type definitions for the iterative refinement system.
 * These types are shared between benchmark evaluation and production indexing.
 */

import type { ILLMClient, IEmbeddingsClient } from "../../../types.js";

// ============================================================================
// Quality Test Types
// ============================================================================

/**
 * Result of testing a summary's quality (e.g., retrieval ranking)
 */
export interface QualityTestResult {
	/** Whether the summary passed the quality threshold */
	passed: boolean;
	/** Rank in the result set (1 = best), null if not found */
	rank: number | null;
	/** Normalized score (0-1), higher is better */
	score: number;
	/** Additional details about the test */
	details: {
		/** Total candidates in the test pool */
		totalCandidates?: number;
		/** The best-performing summary (for feedback) */
		winningSummary?: string;
		/** Query used for testing (if applicable) */
		query?: string;
		/** Model that produced the winning summary */
		winningModelId?: string;
		/** Effective target rank (may be lower than configured if candidate pool is small) */
		effectiveTargetRank?: number;
	};
}

// ============================================================================
// Refinement Context Types
// ============================================================================

/**
 * Context for a single refinement operation
 */
export interface RefinementContext {
	/** The summary text to refine */
	summary: string;
	/** Pre-computed embedding for the initial summary (avoids re-embedding) */
	summaryEmbedding?: number[];
	/** The source code being summarized */
	codeContent: string;
	/** Programming language of the code */
	language: string;
	/** Metadata about the code unit */
	metadata: {
		filePath?: string;
		symbolName?: string;
		symbolType?: string;
		codeUnitId?: string;
	};
	/** Other summaries to compete against (for cross-model testing) */
	competitors?: Array<{
		summary: string;
		modelId: string;
		embedding?: number[];
	}>;
	/** Pre-generated queries for retrieval testing */
	queries?: string[];
}

// ============================================================================
// Refinement Result Types
// ============================================================================

/**
 * A single refinement attempt
 */
export interface RefinementAttempt {
	/** Round number (1-based) */
	round: number;
	/** The summary generated in this round */
	summary: string;
	/** Result of quality testing this summary */
	testResult: QualityTestResult;
	/** Feedback shown to the model for the next round */
	feedback: string;
	/** Time taken for this round in milliseconds */
	durationMs: number;
}

/**
 * Complete result of an iterative refinement process
 */
export interface RefinementResult {
	/** The final (best) summary */
	finalSummary: string;
	/** Number of rounds executed (0 if initial was good enough) */
	rounds: number;
	/** Whether refinement achieved the success criterion */
	success: boolean;
	/** History of all refinement attempts */
	history: RefinementAttempt[];
	/** Summary metrics */
	metrics: {
		/** Rank of the initial summary */
		initialRank: number | null;
		/** Rank of the final summary */
		finalRank: number | null;
		/** Improvement in rank (positive = better) */
		rankImprovement: number;
		/** Brokk-style score: 1.0 / log2(rounds + 2) */
		refinementScore: number;
		/** Total time spent on refinement */
		totalDurationMs: number;
	};
}

// ============================================================================
// Strategy Interface
// ============================================================================

/**
 * Strategy interface for refinement quality testing.
 *
 * Implementations define:
 * - How to test summary quality (e.g., retrieval ranking, BLEU score)
 * - How to generate feedback for the model
 * - What constitutes "success"
 */
export interface IRefinementStrategy {
	/**
	 * Test the quality of a summary
	 * @param summary - The summary to test
	 * @param context - Context including code, competitors, queries
	 * @returns Quality test result with rank/score/details
	 */
	testQuality(
		summary: string,
		context: RefinementContext,
	): Promise<QualityTestResult>;

	/**
	 * Generate feedback for the model to improve the summary
	 * @param result - The quality test result
	 * @param context - Original refinement context
	 * @returns Feedback string to prepend to next refinement prompt
	 */
	generateFeedback(
		result: QualityTestResult,
		context: RefinementContext,
	): Promise<string>;

	/**
	 * Determine if the quality test result meets the success criterion
	 * @param result - The quality test result
	 * @returns true if no further refinement is needed
	 */
	isSuccess(result: QualityTestResult): boolean;

	/**
	 * Get the strategy name for logging/reporting
	 */
	getName(): string;
}

// ============================================================================
// Engine Options
// ============================================================================

/**
 * Options for the refinement engine
 */
export interface RefinementOptions {
	/** Maximum number of refinement rounds (default: 3) */
	maxRounds: number;
	/** Quality testing strategy */
	strategy: IRefinementStrategy;
	/** LLM client for generating refined summaries */
	llmClient: ILLMClient;
	/** Optional: callback for progress updates */
	onProgress?: (round: number, result: QualityTestResult) => void;
	/** Optional: abort signal for cancellation */
	abortSignal?: AbortSignal;
}

// ============================================================================
// Scoring Types
// ============================================================================

/**
 * Calculate Brokk-style refinement penalty score
 *
 * Formula: 1.0 / log2(rounds + 2)
 * - Round 0 (initial success): 1.0 / log2(2) = 1.0
 * - Round 1: 1.0 / log2(3) ≈ 0.63
 * - Round 2: 1.0 / log2(4) = 0.5
 * - Round 3: 1.0 / log2(5) ≈ 0.43
 *
 * @param rounds - Number of refinement rounds (0 = initial was good)
 * @returns Score between 0 and 1
 */
export function calculateRefinementScore(rounds: number): number {
	return 1.0 / Math.log2(rounds + 2);
}

// ============================================================================
// Configuration Types
// ============================================================================

/**
 * Configuration for iterative refinement in benchmark
 */
export interface IterativeRefinementConfig {
	/** Enable iterative refinement evaluation */
	enabled: boolean;
	/** Maximum refinement rounds per summary */
	maxRounds: number;
	/** Target rank for success (e.g., 3 = top-3) */
	targetRank: number;
	/** Strategy to use for quality testing */
	strategy: "retrieval" | "bleu" | "llm-judge";
	/** Apply Brokk-style scoring penalty based on rounds */
	applyRoundsPenalty: boolean;
}

/**
 * Default configuration
 */
export const DEFAULT_ITERATIVE_CONFIG: IterativeRefinementConfig = {
	enabled: false,
	maxRounds: 3,
	targetRank: 3,
	strategy: "retrieval",
	applyRoundsPenalty: true,
};

// ============================================================================
// Evaluation Result Types (for benchmark integration)
// ============================================================================

/**
 * Results from iterative refinement evaluation
 */
export interface IterativeRefinementResults {
	/** The model that generated the summary */
	modelId: string;
	/** Code unit this summary is for */
	codeUnitId: string;
	/** Number of refinement rounds executed */
	rounds: number;
	/** Whether target rank was achieved */
	success: boolean;
	/** Initial summary quality rank */
	initialRank: number | null;
	/** Final summary quality rank */
	finalRank: number | null;
	/** Brokk-style score (penalized by rounds) */
	refinementScore: number;
	/** History of all refinement attempts */
	history: Array<{
		round: number;
		rank: number | null;
		passed: boolean;
	}>;
	/** Strategy used for quality testing */
	strategyName: string;
}
