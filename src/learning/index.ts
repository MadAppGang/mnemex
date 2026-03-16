/**
 * Adaptive Learning Module for mnemex
 *
 * This module provides adaptive ranking that learns from user feedback.
 *
 * Architecture:
 * - feedback/ - Captures and stores search feedback events
 * - engine/   - Core learning algorithms (EMA-based weight updates)
 * - ranking/  - Applies learned weights to search results
 *
 * Usage:
 * ```typescript
 * import { createLearningSystem } from "./learning/index.js";
 *
 * const learning = createLearningSystem(db);
 *
 * // Record feedback
 * learning.collector.captureExplicitFeedback({
 *   query: "authentication flow",
 *   resultIds: ["chunk1", "chunk2"],
 *   helpfulIds: ["chunk1"],
 * });
 *
 * // Get adapted weights for ranking
 * const weights = learning.ranker.getActiveWeights("search");
 * ```
 */

import type { SQLiteDatabase } from "../core/sqlite.js";
import type { LearningConfig } from "./types.js";
import { DEFAULT_LEARNING_CONFIG } from "./types.js";
import { FeedbackStore, createFeedbackStore } from "./feedback/index.js";
import {
	FeedbackCollector,
	createFeedbackCollector,
} from "./feedback/index.js";
import { LearningEngine, createLearningEngine } from "./engine/index.js";
import { WeightOptimizer, createWeightOptimizer } from "./engine/index.js";
import { AdaptiveRanker, createAdaptiveRanker } from "./ranking/index.js";

// ============================================================================
// Re-exports
// ============================================================================

// Types
export * from "./types.js";

// Feedback
export { FeedbackStore, createFeedbackStore } from "./feedback/index.js";
export {
	FeedbackCollector,
	createFeedbackCollector,
} from "./feedback/index.js";

// Engine
export { LearningEngine, createLearningEngine } from "./engine/index.js";
export { WeightOptimizer, createWeightOptimizer } from "./engine/index.js";

// Ranking
export { AdaptiveRanker, createAdaptiveRanker } from "./ranking/index.js";

// ============================================================================
// Convenience Factory
// ============================================================================

/**
 * Complete learning system with all components wired together.
 */
export interface LearningSystem {
	/** Feedback storage */
	store: FeedbackStore;
	/** Feedback collector (explicit + implicit) */
	collector: FeedbackCollector;
	/** Learning engine (EMA updates) */
	engine: LearningEngine;
	/** Weight optimizer (validation, normalization) */
	optimizer: WeightOptimizer;
	/** Adaptive ranker (applies weights) */
	ranker: AdaptiveRanker;
}

/**
 * Create a complete learning system.
 *
 * @param db - SQLite database instance
 * @param config - Optional configuration overrides
 * @returns Wired learning system components
 */
export function createLearningSystem(
	db: SQLiteDatabase,
	config: Partial<LearningConfig> = {},
): LearningSystem {
	const mergedConfig = { ...DEFAULT_LEARNING_CONFIG, ...config };

	// Create components in dependency order
	const store = createFeedbackStore(db, mergedConfig);
	const collector = createFeedbackCollector(store, mergedConfig);
	const engine = createLearningEngine(store, mergedConfig);
	const optimizer = createWeightOptimizer(mergedConfig);
	const ranker = createAdaptiveRanker(engine, optimizer, mergedConfig);

	return {
		store,
		collector,
		engine,
		optimizer,
		ranker,
	};
}
