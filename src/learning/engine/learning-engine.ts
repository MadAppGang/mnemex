/**
 * LearningEngine - Core learning logic for adaptive ranking.
 *
 * Responsibilities:
 * - Train weights from feedback data using EMA
 * - Compute optimal weights for different use cases
 * - Track confidence based on sample count
 * - Handle cold start with static defaults
 */

import type { FeedbackStore } from "../feedback/feedback-store.js";
import type {
	LearnedWeights,
	LearningConfig,
	SearchFeedbackEvent,
	QueryPatternMapping,
} from "../types.js";
import { DEFAULT_LEARNING_CONFIG } from "../types.js";
import type { DocumentType, SearchUseCase } from "../../types.js";

// ============================================================================
// Constants
// ============================================================================

/** Default static weights from store.ts */
const DEFAULT_VECTOR_WEIGHT = 0.6;
const DEFAULT_BM25_WEIGHT = 0.4;

/** Default document type weights (balanced) */
const DEFAULT_DOC_TYPE_WEIGHTS: Partial<Record<DocumentType, number>> = {
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
};

/** All document types for iteration */
const ALL_DOC_TYPES: DocumentType[] = [
	"code_chunk",
	"file_summary",
	"symbol_summary",
	"idiom",
	"usage_example",
	"anti_pattern",
	"project_doc",
	"framework_doc",
	"best_practice",
	"api_reference",
];

// ============================================================================
// LearningEngine Class
// ============================================================================

export class LearningEngine {
	private store: FeedbackStore;
	private config: LearningConfig;
	private cachedWeights: LearnedWeights | null = null;
	private lastTrainedAt: Date | null = null;

	constructor(store: FeedbackStore, config: Partial<LearningConfig> = {}) {
		this.store = store;
		this.config = { ...DEFAULT_LEARNING_CONFIG, ...config };
	}

	// ========================================================================
	// Weight Retrieval
	// ========================================================================

	/**
	 * Get current weights (learned or defaults).
	 * Returns cached weights if available and not stale.
	 */
	getWeights(useCase?: SearchUseCase): LearnedWeights {
		// Use cached weights if available
		if (this.cachedWeights) {
			return this.cachedWeights;
		}

		// Load weights from store
		return this.loadWeights(useCase);
	}

	/**
	 * Load weights from the feedback store.
	 */
	private loadWeights(useCase?: SearchUseCase): LearnedWeights {
		const allWeights = this.store.getAllWeights();

		// Vector/BM25 weights
		const vectorData = allWeights.get("vector_weight") || {
			value: DEFAULT_VECTOR_WEIGHT,
			sampleCount: 0,
		};
		const bm25Data = allWeights.get("bm25_weight") || {
			value: DEFAULT_BM25_WEIGHT,
			sampleCount: 0,
		};

		// Document type weights
		const documentTypeWeights: Partial<Record<DocumentType, number>> = {};
		for (const docType of ALL_DOC_TYPES) {
			const key = `doc_type:${docType}`;
			const data = allWeights.get(key);
			documentTypeWeights[docType] =
				data?.value ?? DEFAULT_DOC_TYPE_WEIGHTS[docType] ?? 0.1;
		}

		// File boosts
		const fileBoosts = this.store.getAllFileBoosts();

		// Query patterns (load all)
		const queryPatterns = new Map<string, QueryPatternMapping>();
		// Note: We'd need to add a method to FeedbackStore to get all patterns

		// Calculate confidence based on total samples
		const totalSamples = Math.max(
			vectorData.sampleCount,
			bm25Data.sampleCount,
			1,
		);
		const confidence = Math.min(1.0, totalSamples / 50); // 50 samples = full confidence

		// Calculate feedback count
		const stats = this.store.getStatistics();

		const weights: LearnedWeights = {
			vectorWeight: vectorData.value,
			bm25Weight: bm25Data.value,
			documentTypeWeights,
			fileBoosts,
			queryPatterns,
			lastUpdated: stats.lastTrainingAt || new Date(),
			feedbackCount: stats.totalFeedbackEvents,
			confidence,
		};

		this.cachedWeights = weights;
		return weights;
	}

	/**
	 * Check if we have enough data to trust learned weights.
	 */
	hasLearningData(useCase?: SearchUseCase): boolean {
		const weights = this.getWeights(useCase);
		return weights.feedbackCount >= this.config.minSamples;
	}

	// ========================================================================
	// Training
	// ========================================================================

	/**
	 * Train weights from feedback data.
	 * Uses Exponential Moving Average for smooth updates.
	 * Continues processing even if individual events fail.
	 */
	async train(): Promise<LearnedWeights> {
		const feedback = this.store.getRecentFeedback(this.config.maxSamples);

		if (feedback.length === 0) {
			return this.getWeights();
		}

		// Process each feedback event with error recovery
		let processedCount = 0;
		let errorCount = 0;

		for (const event of feedback) {
			try {
				this.processEvent(event);
				processedCount++;
			} catch (error) {
				errorCount++;
				console.error(
					`[LearningEngine] Failed to process event ${event.id ?? "unknown"}: ${error instanceof Error ? error.message : String(error)}`,
				);
				// Continue processing remaining events
			}
		}

		// Log summary if there were errors
		if (errorCount > 0) {
			console.warn(
				`[LearningEngine] Training completed with ${errorCount}/${feedback.length} errors, ${processedCount} events processed successfully`,
			);
		}

		// Fail only if ALL events failed and we had events to process
		if (processedCount === 0 && feedback.length > 0) {
			throw new Error(
				`All ${feedback.length} feedback events failed to process`,
			);
		}

		// Invalidate cache and reload
		this.cachedWeights = null;
		this.lastTrainedAt = new Date();

		// Prune old feedback
		this.store.pruneOldFeedback();

		return this.getWeights();
	}

	/**
	 * Process a single feedback event and update weights.
	 */
	private processEvent(event: SearchFeedbackEvent): void {
		const hasHelpful = event.acceptedIds.length > 0;
		const hasUnhelpful = event.rejectedIds.length > 0;

		if (!hasHelpful && !hasUnhelpful) {
			// Refinement events - slight nudge toward exploration
			if (event.feedbackType === "refinement") {
				this.nudgeTowardExploration();
			}
			return;
		}

		// Calculate acceptance ratio
		const totalResults = event.resultIds.length;
		const acceptedCount = event.acceptedIds.length;
		const acceptanceRatio = totalResults > 0 ? acceptedCount / totalResults : 0;

		// Update vector/BM25 weights based on acceptance
		// High acceptance = current strategy is working
		// Low acceptance = try different balance
		if (acceptanceRatio > 0.7) {
			// Good results - reinforce current weights
			this.reinforceCurrentWeights();
		} else if (acceptanceRatio < 0.3) {
			// Poor results - nudge toward exploration
			this.nudgeTowardExploration();
		}

		// Update file boosts based on accepted/rejected files
		this.updateFileBoostsFromEvent(event);

		// Update document type weights based on accepted/rejected types
		// Note: This requires chunk metadata which we may not have
		// For now, skip this until we have proper metadata linking
	}

	/**
	 * Reinforce current weights (small stability bonus).
	 */
	private reinforceCurrentWeights(): void {
		// No change - current weights are working
		// Could add small stability factor if needed
	}

	/**
	 * Nudge weights toward 50/50 exploration.
	 */
	private nudgeTowardExploration(): void {
		const currentVector = this.store.getWeight(
			"vector_weight",
			DEFAULT_VECTOR_WEIGHT,
		);
		const { sampleCount } = this.store.getWeightWithSamples(
			"vector_weight",
			DEFAULT_VECTOR_WEIGHT,
		);

		// Nudge toward 0.5 (balanced)
		const delta =
			currentVector > 0.5 ? -this.config.alpha * 0.5 : this.config.alpha * 0.5;

		const newVector = this.clamp(currentVector + delta);
		const newBM25 = 1.0 - newVector;

		this.store.updateWeight("vector_weight", newVector, sampleCount + 1);
		this.store.updateWeight("bm25_weight", newBM25, sampleCount + 1);
	}

	/**
	 * Update file boost factors from a feedback event.
	 */
	private updateFileBoostsFromEvent(event: SearchFeedbackEvent): void {
		// We need file paths from chunk IDs
		// For now, we'll assume chunk IDs contain file path hints
		// In practice, you'd look up metadata

		// Track files that were accepted/rejected
		const acceptedFiles = new Set<string>();
		const rejectedFiles = new Set<string>();

		// Extract file paths from chunk IDs (if embedded)
		// Format assumption: id contains filepath or we have metadata
		for (const id of event.acceptedIds) {
			const filePath = this.extractFilePathFromId(id);
			if (filePath) {
				acceptedFiles.add(filePath);
			}
		}

		for (const id of event.rejectedIds) {
			const filePath = this.extractFilePathFromId(id);
			if (filePath) {
				rejectedFiles.add(filePath);
			}
		}

		// Update boosts with proper sample count tracking
		for (const filePath of acceptedFiles) {
			const { boost: current, sampleCount } =
				this.store.getFileBoostWithSamples(filePath);
			const newBoost = current * (1 + this.config.alpha);
			const clamped = Math.min(newBoost, this.config.maxFileBoost);
			this.store.updateFileBoost(filePath, clamped, sampleCount + 1);
		}

		for (const filePath of rejectedFiles) {
			const { boost: current, sampleCount } =
				this.store.getFileBoostWithSamples(filePath);
			const newBoost = current * (1 - this.config.alpha);
			const clamped = Math.max(newBoost, this.config.minFileBoost);
			this.store.updateFileBoost(filePath, clamped, sampleCount + 1);
		}
	}

	/**
	 * Extract file path from chunk ID if embedded.
	 * Returns null if not extractable.
	 */
	private extractFilePathFromId(id: string): string | null {
		// Chunk IDs in mnemex are SHA256 hashes, not file paths
		// We'd need to look up the chunk in LanceDB to get the file path
		// For now, return null and handle metadata lookup separately
		return null;
	}

	// ========================================================================
	// Direct Weight Updates (for explicit feedback)
	// ========================================================================

	/**
	 * Learn from explicit feedback with chunk metadata.
	 */
	learnFromFeedback(
		event: SearchFeedbackEvent,
		chunkMetadata: Map<
			string,
			{ filePath: string; documentType: DocumentType }
		>,
	): void {
		const helpfulCount = event.acceptedIds.length;
		const unhelpfulCount = event.rejectedIds.length;

		if (helpfulCount === 0 && unhelpfulCount === 0) {
			return;
		}

		// Update file boosts with proper sample tracking
		for (const id of event.acceptedIds) {
			const meta = chunkMetadata.get(id);
			if (meta) {
				const { boost: current, sampleCount } =
					this.store.getFileBoostWithSamples(meta.filePath);
				const newBoost = current * (1 + this.config.alpha);
				this.store.updateFileBoost(
					meta.filePath,
					Math.min(newBoost, this.config.maxFileBoost),
					sampleCount + 1,
				);
			}
		}

		for (const id of event.rejectedIds) {
			const meta = chunkMetadata.get(id);
			if (meta) {
				const { boost: current, sampleCount } =
					this.store.getFileBoostWithSamples(meta.filePath);
				const newBoost = current * (1 - this.config.alpha);
				this.store.updateFileBoost(
					meta.filePath,
					Math.max(newBoost, this.config.minFileBoost),
					sampleCount + 1,
				);
			}
		}

		// Update document type weights
		const helpfulTypes = new Map<DocumentType, number>();
		const unhelpfulTypes = new Map<DocumentType, number>();

		for (const id of event.acceptedIds) {
			const meta = chunkMetadata.get(id);
			if (meta) {
				helpfulTypes.set(
					meta.documentType,
					(helpfulTypes.get(meta.documentType) || 0) + 1,
				);
			}
		}

		for (const id of event.rejectedIds) {
			const meta = chunkMetadata.get(id);
			if (meta) {
				unhelpfulTypes.set(
					meta.documentType,
					(unhelpfulTypes.get(meta.documentType) || 0) + 1,
				);
			}
		}

		// EMA update for document type weights
		for (const [docType, count] of helpfulTypes) {
			const key = `doc_type:${docType}`;
			const { value: current, sampleCount } = this.store.getWeightWithSamples(
				key,
				DEFAULT_DOC_TYPE_WEIGHTS[docType] ?? 0.1,
			);
			const delta = this.config.alpha * (1.0 - current);
			const newValue = this.clamp(current + delta);
			this.store.updateWeight(key, newValue, sampleCount + count);
		}

		for (const [docType, count] of unhelpfulTypes) {
			const key = `doc_type:${docType}`;
			const { value: current, sampleCount } = this.store.getWeightWithSamples(
				key,
				DEFAULT_DOC_TYPE_WEIGHTS[docType] ?? 0.1,
			);
			const delta = -this.config.alpha * current;
			const newValue = this.clamp(current + delta);
			this.store.updateWeight(key, newValue, sampleCount + count);
		}

		// Update overall acceptance signal for vector/BM25 balance
		const totalCount = helpfulCount + unhelpfulCount;
		if (totalCount > 0) {
			const acceptanceRatio = helpfulCount / totalCount;
			if (acceptanceRatio > 0.7) {
				this.reinforceCurrentWeights();
			} else if (acceptanceRatio < 0.3) {
				this.nudgeTowardExploration();
			}
		}

		// Invalidate cache
		this.cachedWeights = null;
	}

	// ========================================================================
	// Reset
	// ========================================================================

	/**
	 * Reset all learned weights to defaults.
	 */
	reset(): void {
		this.store.clearAll();
		this.cachedWeights = null;
		this.lastTrainedAt = null;
	}

	// ========================================================================
	// Helpers
	// ========================================================================

	/**
	 * Clamp a value to the configured weight range.
	 */
	private clamp(value: number): number {
		return Math.max(
			this.config.minWeight,
			Math.min(this.config.maxWeight, value),
		);
	}
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a LearningEngine instance.
 */
export function createLearningEngine(
	store: FeedbackStore,
	config?: Partial<LearningConfig>,
): LearningEngine {
	return new LearningEngine(store, config);
}
