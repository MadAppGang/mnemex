/**
 * FeedbackCollector - Captures explicit and implicit feedback signals.
 *
 * Responsibilities:
 * - Capture explicit feedback from MCP tool calls
 * - Detect implicit feedback from query refinement patterns
 * - Generate query hashes for pattern matching
 * - Track search sessions
 */

import { createHash } from "crypto";
import type { FeedbackStore } from "./feedback-store.js";
import type {
	SearchFeedbackEvent,
	ImplicitFeedbackEvent,
	FeedbackSource,
	LearningConfig,
} from "../types.js";
import { DEFAULT_LEARNING_CONFIG } from "../types.js";
import type { SearchUseCase } from "../../types.js";

// ============================================================================
// FeedbackCollector Class
// ============================================================================

export class FeedbackCollector {
	private store: FeedbackStore;
	private config: LearningConfig;

	constructor(store: FeedbackStore, config: Partial<LearningConfig> = {}) {
		this.store = store;
		this.config = { ...DEFAULT_LEARNING_CONFIG, ...config };
	}

	// ========================================================================
	// Explicit Feedback Capture
	// ========================================================================

	/**
	 * Record explicit feedback from an agent or user.
	 * Called when report_search_feedback MCP tool is invoked.
	 */
	captureExplicitFeedback(params: {
		query: string;
		sessionId?: string;
		resultIds: string[];
		helpfulIds?: string[];
		unhelpfulIds?: string[];
		useCase?: SearchUseCase;
		source?: FeedbackSource;
		context?: Record<string, unknown>;
	}): void {
		const sessionId = params.sessionId || this.generateSessionId();
		const queryHash = this.computeQueryHash(params.query);

		this.store.recordFeedback({
			query: params.query,
			queryHash,
			sessionId,
			resultIds: params.resultIds,
			acceptedIds: params.helpfulIds || [],
			rejectedIds: params.unhelpfulIds || [],
			feedbackType: "explicit",
			feedbackSource: params.source || "mcp",
			useCase: params.useCase,
			context: params.context,
		});
	}

	/**
	 * Record a search execution (for refinement detection).
	 * Call this after every search.
	 */
	recordSearch(params: {
		query: string;
		sessionId: string;
		resultCount: number;
		useCase?: SearchUseCase;
	}): ImplicitFeedbackEvent | null {
		// First, check for refinement
		const refinement = this.detectRefinement(params.query, params.sessionId);

		// Record this query
		this.store.recordQuery(
			params.query,
			params.sessionId,
			params.resultCount,
			params.useCase,
		);

		// If refinement detected, record implicit feedback
		if (refinement) {
			this.captureRefinementFeedback(refinement, params.useCase);
		}

		return refinement;
	}

	// ========================================================================
	// Implicit Feedback Detection
	// ========================================================================

	/**
	 * Detect if a query is a refinement of a recent query.
	 * Refinement suggests previous results weren't satisfactory.
	 */
	detectRefinement(
		query: string,
		sessionId: string,
	): ImplicitFeedbackEvent | null {
		const recentQueries = this.store.getRecentQueriesInSession(
			sessionId,
			this.config.refinementWindowMs,
		);

		if (recentQueries.length === 0) {
			return null;
		}

		// Check similarity with most recent query
		const mostRecent = recentQueries[0];

		// Skip if it's the exact same query
		if (mostRecent.query === query) {
			return null;
		}

		const similarity = this.computeQuerySimilarity(query, mostRecent.query);

		if (similarity >= this.config.refinementSimilarityThreshold) {
			const timeDelta = Date.now() - new Date(mostRecent.timestamp).getTime();

			return {
				originalQuery: mostRecent.query,
				refinedQuery: query,
				sessionId,
				querySimilarity: similarity,
				timeDeltaMs: timeDelta,
			};
		}

		return null;
	}

	/**
	 * Record refinement as implicit negative feedback.
	 */
	private captureRefinementFeedback(
		refinement: ImplicitFeedbackEvent,
		useCase?: SearchUseCase,
	): void {
		const queryHash = this.computeQueryHash(refinement.originalQuery);

		this.store.recordFeedback({
			query: refinement.originalQuery,
			queryHash,
			sessionId: refinement.sessionId,
			resultIds: [], // We don't know exact results
			acceptedIds: [],
			rejectedIds: [], // Implicit rejection of all results
			feedbackType: "refinement",
			feedbackSource: "api", // Internal detection
			useCase,
			context: {
				refinedQuery: refinement.refinedQuery,
				querySimilarity: refinement.querySimilarity,
				timeDeltaMs: refinement.timeDeltaMs,
			},
		});
	}

	// ========================================================================
	// Query Pattern Utilities
	// ========================================================================

	/**
	 * Compute a hash for query pattern matching.
	 * Normalizes query for consistent grouping.
	 */
	computeQueryHash(query: string): string {
		const normalized = this.normalizeQuery(query);
		return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
	}

	/**
	 * Normalize a query for pattern matching.
	 * - Lowercase
	 * - Remove extra whitespace
	 * - Remove common stopwords
	 * - Sort words alphabetically
	 */
	normalizeQuery(query: string): string {
		const stopwords = new Set([
			"a",
			"an",
			"the",
			"is",
			"are",
			"was",
			"were",
			"be",
			"been",
			"being",
			"have",
			"has",
			"had",
			"do",
			"does",
			"did",
			"will",
			"would",
			"could",
			"should",
			"may",
			"might",
			"must",
			"shall",
			"can",
			"need",
			"to",
			"of",
			"in",
			"for",
			"on",
			"with",
			"at",
			"by",
			"from",
			"as",
			"into",
			"through",
			"during",
			"before",
			"after",
			"above",
			"below",
			"between",
			"under",
			"again",
			"further",
			"then",
			"once",
			"here",
			"there",
			"when",
			"where",
			"why",
			"how",
			"all",
			"each",
			"few",
			"more",
			"most",
			"other",
			"some",
			"such",
			"no",
			"nor",
			"not",
			"only",
			"own",
			"same",
			"so",
			"than",
			"too",
			"very",
			"just",
			"and",
			"but",
			"if",
			"or",
			"because",
			"until",
			"while",
			"although",
			"though",
			"what",
			"which",
			"who",
			"whom",
			"this",
			"that",
			"these",
			"those",
			"i",
			"me",
			"my",
			"myself",
			"we",
			"our",
			"ours",
			"you",
			"your",
			"yours",
			"he",
			"him",
			"his",
			"she",
			"her",
			"hers",
			"it",
			"its",
			"they",
			"them",
			"their",
		]);

		const words = query
			.toLowerCase()
			.split(/\s+/)
			.filter((word) => word.length > 1 && !stopwords.has(word))
			.sort();

		return words.join(" ");
	}

	/**
	 * Compute similarity between two queries.
	 * Uses Jaccard similarity on normalized word sets.
	 */
	computeQuerySimilarity(query1: string, query2: string): number {
		const words1 = new Set(this.normalizeQuery(query1).split(/\s+/));
		const words2 = new Set(this.normalizeQuery(query2).split(/\s+/));

		// Handle empty sets
		if (words1.size === 0 && words2.size === 0) {
			return 1.0;
		}
		if (words1.size === 0 || words2.size === 0) {
			return 0.0;
		}

		const intersection = new Set([...words1].filter((w) => words2.has(w)));
		const union = new Set([...words1, ...words2]);

		return intersection.size / union.size;
	}

	/**
	 * Extract pattern from query for intent learning.
	 * Returns a simplified pattern that can be matched.
	 */
	extractQueryPattern(query: string): string {
		return this.normalizeQuery(query);
	}

	// ========================================================================
	// Session Management
	// ========================================================================

	/**
	 * Generate a new session ID.
	 */
	generateSessionId(): string {
		return `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
	}

	/**
	 * Check if a session ID looks valid.
	 */
	isValidSessionId(sessionId: string): boolean {
		return (
			typeof sessionId === "string" &&
			sessionId.length > 0 &&
			sessionId.length < 100
		);
	}
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a FeedbackCollector instance.
 */
export function createFeedbackCollector(
	store: FeedbackStore,
	config?: Partial<LearningConfig>,
): FeedbackCollector {
	return new FeedbackCollector(store, config);
}
