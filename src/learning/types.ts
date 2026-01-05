/**
 * Types for the adaptive learning system.
 *
 * This module defines interfaces for:
 * - Search feedback events (explicit and implicit)
 * - Learned weights and parameters
 * - Learning statistics and metrics
 */

import type { DocumentType, SearchUseCase } from "../types.js";

// ============================================================================
// Feedback Event Types
// ============================================================================

/** Type of feedback signal received */
export type FeedbackType = "explicit" | "refinement" | "implicit";

/** Source of feedback (which interface reported it) */
export type FeedbackSource = "mcp" | "cli" | "api";

/**
 * Explicit feedback event from agent/user.
 * Recorded when an agent calls report_search_feedback.
 */
export interface SearchFeedbackEvent {
	id?: number;
	/** The search query that was executed */
	query: string;
	/** Hash of query for pattern matching */
	queryHash: string;
	/** Session identifier to group related searches */
	sessionId: string;
	/** All chunk IDs that were returned */
	resultIds: string[];
	/** Chunk IDs marked as helpful/relevant */
	acceptedIds: string[];
	/** Chunk IDs marked as not helpful */
	rejectedIds: string[];
	/** Type of feedback signal */
	feedbackType: FeedbackType;
	/** Source of feedback */
	feedbackSource: FeedbackSource;
	/** Search use case if known */
	useCase?: SearchUseCase;
	/** Additional context (e.g., file being edited) */
	context?: Record<string, unknown>;
	/** When this feedback was recorded */
	createdAt: string;
}

/**
 * Query history entry for refinement detection.
 * Used to detect when user refines a query (implicit negative signal).
 */
export interface QueryHistoryEntry {
	id?: number;
	/** The search query */
	query: string;
	/** Session identifier */
	sessionId: string;
	/** Number of results returned */
	resultCount: number;
	/** Search use case */
	useCase?: SearchUseCase;
	/** When this query was executed */
	timestamp: string;
}

/**
 * Implicit feedback signal from query refinement.
 * Generated when we detect a refined query within a session.
 */
export interface ImplicitFeedbackEvent {
	/** Original query that may have had poor results */
	originalQuery: string;
	/** Refined/modified query */
	refinedQuery: string;
	/** Session in which refinement occurred */
	sessionId: string;
	/** Similarity score between queries (0-1) */
	querySimilarity: number;
	/** Time between queries in milliseconds */
	timeDeltaMs: number;
}

// ============================================================================
// Learned Weight Types
// ============================================================================

/**
 * Complete set of learned weights for search ranking.
 */
export interface LearnedWeights {
	/** Vector search weight (0-1, default 0.6) */
	vectorWeight: number;
	/** BM25 keyword search weight (0-1, default 0.4) */
	bm25Weight: number;
	/** Per-document-type weights */
	documentTypeWeights: Partial<Record<DocumentType, number>>;
	/** Per-file boost factors (filepath -> multiplier) */
	fileBoosts: Map<string, number>;
	/** Query pattern to intent mappings */
	queryPatterns: Map<string, QueryPatternMapping>;
	/** When these weights were last updated */
	lastUpdated: Date;
	/** Number of feedback events used to learn these weights */
	feedbackCount: number;
	/** Confidence level (0-1, based on sample count) */
	confidence: number;
}

/**
 * Mapping from query pattern to learned intent.
 */
export interface QueryPatternMapping {
	/** Normalized query pattern (lowercased, stopwords removed) */
	pattern: string;
	/** Learned intent for this pattern */
	intent: string;
	/** Confidence in this mapping */
	confidence: number;
	/** Number of samples supporting this mapping */
	sampleCount: number;
}

/**
 * Statistics about learning progress.
 */
export interface LearningStatistics {
	/** Total feedback events recorded */
	totalFeedbackEvents: number;
	/** Events by feedback type */
	eventsByType: Record<FeedbackType, number>;
	/** Events by use case */
	eventsByUseCase: Record<string, number>;
	/** Unique queries seen */
	uniqueQueries: number;
	/** Average acceptance rate (accepted / total results) */
	averageAcceptanceRate: number;
	/** Total result items across all feedback (for tests) */
	totalResults: number;
	/** Total accepted items across all feedback (for tests) */
	totalAccepted: number;
	/** Acceptance rate (alias for averageAcceptanceRate) */
	acceptanceRate: number;
	/** Most common queries */
	topQueries: Array<{ query: string; count: number }>;
	/** Files with highest boost */
	topBoostedFiles: Array<{ filePath: string; boost: number }>;
	/** When learning was last updated */
	lastFeedbackAt: Date | null;
	/** When weights were last recomputed */
	lastTrainingAt: Date | null;
}

// ============================================================================
// Learning Engine Configuration
// ============================================================================

/**
 * Configuration for the learning engine.
 */
export interface LearningConfig {
	/** EMA decay factor (higher = more weight to new data, default 0.1) */
	alpha: number;
	/** Minimum weight to prevent collapse (default 0.05) */
	minWeight: number;
	/** Maximum weight to prevent runaway (default 0.95) */
	maxWeight: number;
	/** Minimum samples before trusting learned weights (default 5) */
	minSamples: number;
	/** Maximum samples to consider (older are pruned, default 1000) */
	maxSamples: number;
	/** Query refinement window in milliseconds (default 60000) */
	refinementWindowMs: number;
	/** Query similarity threshold for refinement detection (default 0.5) */
	refinementSimilarityThreshold: number;
	/** Maximum file boost factor (default 2.0) */
	maxFileBoost: number;
	/** Minimum file boost factor (default 0.5) */
	minFileBoost: number;
}

/**
 * Default learning configuration.
 */
export const DEFAULT_LEARNING_CONFIG: LearningConfig = {
	alpha: 0.1,
	minWeight: 0.05,
	maxWeight: 0.95,
	minSamples: 5,
	maxSamples: 1000,
	refinementWindowMs: 60000,
	refinementSimilarityThreshold: 0.5,
	maxFileBoost: 2.0,
	minFileBoost: 0.5,
};

// ============================================================================
// Adaptive Ranker Types
// ============================================================================

/**
 * Input for re-ranking search results.
 */
export interface RerankInput {
	/** Original search query */
	query: string;
	/** Results to re-rank */
	results: Array<{
		id: string;
		filePath: string;
		documentType: DocumentType;
		score: number;
	}>;
	/** Search use case */
	useCase?: SearchUseCase;
}

/**
 * Output from re-ranking.
 */
export interface RerankOutput {
	/** Re-ranked results with adjusted scores */
	results: Array<{
		id: string;
		originalScore: number;
		adjustedScore: number;
		boostApplied: number;
	}>;
	/** Weights that were applied */
	weightsUsed: LearnedWeights;
}
