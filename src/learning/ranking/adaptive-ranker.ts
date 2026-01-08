/**
 * AdaptiveRanker - Applies learned weights to search results.
 *
 * Responsibilities:
 * - Apply learned weights to RRF fusion
 * - Apply file boost factors to scores
 * - Fallback to static weights when no learned data
 * - Provide weight information for debugging
 */

import type { LearningEngine } from "../engine/learning-engine.js";
import type { WeightOptimizer } from "../engine/weight-optimizer.js";
import type { LearnedWeights, LearningConfig } from "../types.js";
import { DEFAULT_LEARNING_CONFIG } from "../types.js";
import type { DocumentType, SearchUseCase } from "../../types.js";

// ============================================================================
// Constants
// ============================================================================

/** Default static weights (fallback) */
const DEFAULT_WEIGHTS: LearnedWeights = {
	vectorWeight: 0.6,
	bm25Weight: 0.4,
	documentTypeWeights: {
		code_chunk: 0.25,
		file_summary: 0.12,
		symbol_summary: 0.15,
		idiom: 0.12,
		usage_example: 0.08,
		anti_pattern: 0.03,
		project_doc: 0.05,
		framework_doc: 0.1,
		best_practice: 0.05,
		api_reference: 0.05,
	},
	fileBoosts: new Map(),
	queryPatterns: new Map(),
	lastUpdated: new Date(),
	feedbackCount: 0,
	confidence: 0,
};

// ============================================================================
// Types
// ============================================================================

export interface RankingResult {
	id: string;
	originalScore: number;
	adjustedScore: number;
	fileBoost: number;
	typeBoost: number;
}

export interface RankingContext {
	query: string;
	useCase?: SearchUseCase;
	results: Array<{
		id: string;
		filePath: string;
		documentType: DocumentType;
		score: number;
	}>;
}

// ============================================================================
// AdaptiveRanker Class
// ============================================================================

export class AdaptiveRanker {
	private engine: LearningEngine;
	private optimizer: WeightOptimizer | null;
	private config: LearningConfig;

	constructor(
		engine: LearningEngine,
		optimizer?: WeightOptimizer,
		config: Partial<LearningConfig> = {},
	) {
		this.engine = engine;
		this.optimizer = optimizer || null;
		this.config = { ...DEFAULT_LEARNING_CONFIG, ...config };
	}

	// ========================================================================
	// Weight Retrieval
	// ========================================================================

	/**
	 * Get active weights for ranking.
	 * Returns learned weights if available, otherwise static defaults.
	 */
	getActiveWeights(useCase?: SearchUseCase): LearnedWeights {
		const learned = this.engine.getWeights(useCase);

		// If we have enough samples, use learned weights
		if (learned.feedbackCount >= this.config.minSamples) {
			// Optionally blend with defaults based on confidence
			if (this.optimizer && learned.confidence < 1.0) {
				return this.optimizer.blend(
					learned,
					DEFAULT_WEIGHTS,
					learned.confidence,
				);
			}
			return learned;
		}

		// Fall back to static defaults
		return DEFAULT_WEIGHTS;
	}

	/**
	 * Get RRF weights (vector and BM25).
	 */
	getRRFWeights(useCase?: SearchUseCase): {
		vectorWeight: number;
		bm25Weight: number;
	} {
		const weights = this.getActiveWeights(useCase);
		return {
			vectorWeight: weights.vectorWeight,
			bm25Weight: weights.bm25Weight,
		};
	}

	/**
	 * Get document type weights for a use case.
	 */
	getDocumentTypeWeights(
		useCase?: SearchUseCase,
	): Partial<Record<DocumentType, number>> {
		const weights = this.getActiveWeights(useCase);
		return weights.documentTypeWeights;
	}

	/**
	 * Get file boost factor for a specific file.
	 */
	getFileBoost(filePath: string): number {
		const weights = this.getActiveWeights();
		return weights.fileBoosts.get(filePath) ?? 1.0;
	}

	/**
	 * Get all file boosts.
	 */
	getAllFileBoosts(): Map<string, number> {
		const weights = this.getActiveWeights();
		return weights.fileBoosts;
	}

	// ========================================================================
	// Ranking Operations
	// ========================================================================

	/**
	 * Re-rank search results using learned weights.
	 * Applies file boosts and document type adjustments.
	 */
	rerank(context: RankingContext): RankingResult[] {
		const weights = this.getActiveWeights(context.useCase);

		const results: RankingResult[] = context.results.map((result) => {
			// Get file boost
			const fileBoost = weights.fileBoosts.get(result.filePath) ?? 1.0;

			// Get document type boost (relative to default)
			const defaultTypeWeight =
				DEFAULT_WEIGHTS.documentTypeWeights[result.documentType] ?? 0.1;
			const learnedTypeWeight =
				weights.documentTypeWeights[result.documentType] ?? 0.1;
			const typeBoost = learnedTypeWeight / defaultTypeWeight;

			// Calculate adjusted score
			const adjustedScore = result.score * fileBoost * typeBoost;

			return {
				id: result.id,
				originalScore: result.score,
				adjustedScore,
				fileBoost,
				typeBoost,
			};
		});

		// Sort by adjusted score (descending)
		results.sort((a, b) => b.adjustedScore - a.adjustedScore);

		return results;
	}

	/**
	 * Apply file boosts to a list of results in place.
	 * Returns the modified results.
	 */
	applyFileBoosts<T extends { filePath: string; fusedScore: number }>(
		results: T[],
	): T[] {
		const weights = this.getActiveWeights();

		for (const result of results) {
			const boost = weights.fileBoosts.get(result.filePath) ?? 1.0;
			result.fusedScore *= boost;
		}

		// Re-sort by fused score
		results.sort((a, b) => b.fusedScore - a.fusedScore);

		return results;
	}

	// ========================================================================
	// Diagnostics
	// ========================================================================

	/**
	 * Check if adaptive ranking is active (has learned data).
	 */
	isActive(useCase?: SearchUseCase): boolean {
		return this.engine.hasLearningData(useCase);
	}

	/**
	 * Get ranking diagnostics for debugging.
	 */
	getDiagnostics(useCase?: SearchUseCase): RankingDiagnostics {
		const weights = this.getActiveWeights(useCase);
		const isActive = this.isActive(useCase);

		return {
			isActive,
			usingLearned: weights.feedbackCount >= this.config.minSamples,
			confidence: weights.confidence,
			feedbackCount: weights.feedbackCount,
			lastUpdated: weights.lastUpdated,
			vectorWeight: weights.vectorWeight,
			bm25Weight: weights.bm25Weight,
			fileBoostCount: weights.fileBoosts.size,
			topBoostedFiles: this.getTopBoostedFiles(weights, 5),
		};
	}

	private getTopBoostedFiles(
		weights: LearnedWeights,
		limit: number,
	): Array<{ filePath: string; boost: number }> {
		const entries = Array.from(weights.fileBoosts.entries());
		entries.sort((a, b) => b[1] - a[1]);
		return entries
			.slice(0, limit)
			.map(([filePath, boost]) => ({ filePath, boost }));
	}
}

// ============================================================================
// Types
// ============================================================================

export interface RankingDiagnostics {
	isActive: boolean;
	usingLearned: boolean;
	confidence: number;
	feedbackCount: number;
	lastUpdated: Date;
	vectorWeight: number;
	bm25Weight: number;
	fileBoostCount: number;
	topBoostedFiles: Array<{ filePath: string; boost: number }>;
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create an AdaptiveRanker instance.
 */
export function createAdaptiveRanker(
	engine: LearningEngine,
	optimizer?: WeightOptimizer,
	config?: Partial<LearningConfig>,
): AdaptiveRanker {
	return new AdaptiveRanker(engine, optimizer, config);
}
