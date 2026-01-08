/**
 * Base Strategy
 *
 * Abstract base class and utilities for refinement strategies.
 */

import type {
	IRefinementStrategy,
	QualityTestResult,
	RefinementContext,
} from "../types.js";

// ============================================================================
// Abstract Base Strategy
// ============================================================================

/**
 * Abstract base class for refinement strategies.
 * Provides common utilities and default implementations.
 */
export abstract class BaseRefinementStrategy implements IRefinementStrategy {
	protected targetRank: number;

	constructor(targetRank: number = 3) {
		this.targetRank = targetRank;
	}

	/**
	 * Test the quality of a summary - must be implemented by subclasses
	 */
	abstract testQuality(
		summary: string,
		context: RefinementContext,
	): Promise<QualityTestResult>;

	/**
	 * Generate feedback based on test result - must be implemented by subclasses
	 */
	abstract generateFeedback(
		result: QualityTestResult,
		context: RefinementContext,
	): Promise<string>;

	/**
	 * Default success check: use the passed flag from testQuality
	 * The passed flag already accounts for effective target rank adjustments
	 * (e.g., with 2 candidates, must be #1 even if configured targetRank is 3)
	 */
	isSuccess(result: QualityTestResult): boolean {
		return result.passed;
	}

	/**
	 * Get the strategy name - must be implemented by subclasses
	 */
	abstract getName(): string;

	/**
	 * Get the target rank for this strategy
	 */
	getTargetRank(): number {
		return this.targetRank;
	}
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * Calculate cosine similarity between two vectors
 */
export function cosineSimilarity(a: number[], b: number[]): number {
	if (a.length !== b.length) {
		throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
	}

	let dot = 0;
	let normA = 0;
	let normB = 0;

	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}

	const denom = Math.sqrt(normA) * Math.sqrt(normB);
	return denom > 0 ? dot / denom : 0;
}

/**
 * Rank items by similarity to a query
 * Returns items sorted by similarity (descending) with their ranks
 */
export function rankBySimilarity<T>(
	queryEmbedding: number[],
	items: Array<{ embedding: number[]; item: T }>,
): Array<{ rank: number; score: number; item: T }> {
	const scored = items.map(({ embedding, item }) => ({
		score: cosineSimilarity(queryEmbedding, embedding),
		item,
	}));

	// Sort by score descending
	scored.sort((a, b) => b.score - a.score);

	// Assign ranks (1-indexed)
	return scored.map((s, i) => ({
		rank: i + 1,
		score: s.score,
		item: s.item,
	}));
}

/**
 * Truncate text for display in feedback
 */
export function truncateForFeedback(
	text: string,
	maxLength: number = 200,
): string {
	if (text.length <= maxLength) {
		return text;
	}
	return text.slice(0, maxLength - 3) + "...";
}
