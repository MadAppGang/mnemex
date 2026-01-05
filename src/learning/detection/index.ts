/**
 * Detection Module - Implicit feedback signal detection.
 *
 * This module provides:
 * - CorrectionScorer: Multi-signal correction detection from user messages
 * - CodeChangeTracker: "Correction Gap" analysis from code modifications
 *
 * Usage:
 * ```typescript
 * import { createCorrectionScorer, createCodeChangeTracker } from "./learning/detection/index.js";
 *
 * // Score potential corrections
 * const scorer = createCorrectionScorer();
 * const result = scorer.score({
 *   userMessage: "No, that's wrong. It should use async/await",
 *   previousTool: "Edit",
 *   previousToolFailed: false,
 * });
 * if (scorer.isCorrection(result.correctionScore)) {
 *   console.log("Correction detected:", result.signals);
 * }
 *
 * // Track code changes
 * const tracker = createCodeChangeTracker(store);
 * tracker.trackAgentEdit({ sessionId, filePath, contentHash, linesAdded: 10, linesRemoved: 0 });
 * const { correction } = tracker.trackUserEdit({ sessionId, filePath, contentHash, linesAdded: 5, linesRemoved: 8 });
 * if (correction) {
 *   console.log("Correction Gap detected:", correction.correctionType);
 * }
 * ```
 */

// Correction Scorer
export {
	CorrectionScorer,
	createCorrectionScorer,
	DEFAULT_CORRECTION_WEIGHTS,
	DEFAULT_SCORER_CONFIG,
	LEXICAL_CORRECTION_KEYWORDS,
	STRONG_CORRECTION_KEYWORDS,
	type CorrectionScorerConfig,
	type ScoringContext,
} from "./correction-scorer.js";

// Code Change Tracker
export {
	CodeChangeTracker,
	createCodeChangeTracker,
	hashContent,
	DEFAULT_TRACKER_CONFIG,
	type CodeChangeTrackerConfig,
	type TrackedEdit,
	type CorrectionGapResult,
	type CorrectionGapStats,
} from "./code-change-tracker.js";
