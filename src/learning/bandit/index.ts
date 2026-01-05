/**
 * Bandit Module - Adaptive tool selection via Thompson Sampling.
 *
 * This module provides:
 * - ToolBandit: Multi-armed bandit for exploration vs exploitation
 * - ContextEncoder: Extract task context for contextual bandits
 *
 * Usage:
 * ```typescript
 * import {
 *   createToolBandit,
 *   createContextEncoder
 * } from "./learning/bandit/index.js";
 *
 * const bandit = createToolBandit();
 * const encoder = createContextEncoder();
 *
 * // Get recommendation with context
 * function recommendTool(
 *   availableTools: string[],
 *   currentFile: string,
 *   recentTools: string[]
 * ) {
 *   const context = encoder.encode({
 *     currentFile,
 *     recentTools
 *   });
 *
 *   const recommendation = bandit.recommend(
 *     availableTools,
 *     context.features
 *   );
 *
 *   return recommendation;
 * }
 *
 * // Update with outcome
 * function recordOutcome(tool: string, success: boolean, context: string[]) {
 *   bandit.update(tool, success, context);
 * }
 * ```
 */

// Tool Bandit
export {
	ToolBandit,
	createToolBandit,
	DEFAULT_BANDIT_CONFIG,
	type ToolBanditConfig,
	type ToolArm,
	type ContextualArm,
	type BanditRecommendation,
	type BanditStatistics,
} from "./tool-bandit.js";

// Context Encoder
export {
	ContextEncoder,
	createContextEncoder,
	DEFAULT_ENCODER_CONFIG,
	type ContextEncoderConfig,
	type TaskContext,
	type EncodedContext,
	type ContextFeature,
} from "./context-encoder.js";
