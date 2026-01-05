/**
 * Shadow Agent Module - Predict and detect deviations.
 *
 * This module provides:
 * - ShadowPredictor: N-gram model predicting next tool
 * - DeviationDetector: Warns when actual differs from expected
 *
 * The "shadow" agent runs alongside the main agent, building
 * expectations without interfering with execution.
 *
 * Usage:
 * ```typescript
 * import {
 *   createShadowPredictor,
 *   createDeviationDetector
 * } from "./learning/shadow/index.js";
 *
 * // Create predictor and train on history
 * const predictor = createShadowPredictor();
 * predictor.train(historicalToolEvents);
 *
 * // Create deviation detector
 * const detector = createDeviationDetector(predictor);
 *
 * // On each tool use
 * function onToolUse(toolName: string) {
 *   const analysis = detector.analyze(toolName);
 *
 *   if (analysis.isDeviation) {
 *     console.log("Deviation:", analysis.deviation);
 *   }
 *
 *   if (analysis.alert) {
 *     console.warn("Alert:", analysis.alert.message);
 *   }
 * }
 * ```
 */

// Shadow Predictor
export {
	ShadowPredictor,
	createShadowPredictor,
	DEFAULT_SHADOW_CONFIG,
	type ShadowPredictorConfig,
	type ToolPrediction,
	type PredictionResult,
	type NGramModel,
} from "./shadow-predictor.js";

// Deviation Detector
export {
	DeviationDetector,
	createDeviationDetector,
	DEFAULT_DEVIATION_CONFIG,
	type DeviationDetectorConfig,
	type Deviation,
	type DeviationAlert,
	type DeviationAnalysis,
	type DeviationStatistics,
	type DeviationType,
	type DeviationSeverity,
} from "./deviation-detector.js";
