/**
 * WeightOptimizer - Optimization algorithms for weight tuning.
 *
 * This module provides optimization strategies beyond simple EMA:
 * - Hill climbing for local optimization
 * - Validation to ensure weights are well-formed
 *
 * Currently a placeholder for future extensions.
 */

import type { LearnedWeights, LearningConfig } from "../types.js";
import { DEFAULT_LEARNING_CONFIG } from "../types.js";
import type { DocumentType } from "../../types.js";

// ============================================================================
// WeightOptimizer Class
// ============================================================================

export class WeightOptimizer {
	private config: LearningConfig;

	constructor(config: Partial<LearningConfig> = {}) {
		this.config = { ...DEFAULT_LEARNING_CONFIG, ...config };
	}

	/**
	 * Validate that weights are well-formed.
	 * - Vector + BM25 should sum to 1.0
	 * - All weights should be in valid range
	 * - File boosts should be in valid range
	 */
	validate(weights: LearnedWeights): ValidationResult {
		const errors: string[] = [];
		const warnings: string[] = [];

		// Check vector + BM25 sum
		const sum = weights.vectorWeight + weights.bm25Weight;
		if (Math.abs(sum - 1.0) > 0.01) {
			warnings.push(
				`Vector + BM25 weights sum to ${sum.toFixed(3)}, expected 1.0`,
			);
		}

		// Check weight ranges
		if (
			weights.vectorWeight < this.config.minWeight ||
			weights.vectorWeight > this.config.maxWeight
		) {
			errors.push(
				`Vector weight ${weights.vectorWeight} outside valid range [${this.config.minWeight}, ${this.config.maxWeight}]`,
			);
		}

		if (
			weights.bm25Weight < this.config.minWeight ||
			weights.bm25Weight > this.config.maxWeight
		) {
			errors.push(
				`BM25 weight ${weights.bm25Weight} outside valid range [${this.config.minWeight}, ${this.config.maxWeight}]`,
			);
		}

		// Check document type weights
		for (const [docType, weight] of Object.entries(
			weights.documentTypeWeights,
		)) {
			if (weight < 0 || weight > 1) {
				errors.push(
					`Document type weight for ${docType} is ${weight}, expected [0, 1]`,
				);
			}
		}

		// Check file boosts
		for (const [filePath, boost] of weights.fileBoosts) {
			if (
				boost < this.config.minFileBoost ||
				boost > this.config.maxFileBoost
			) {
				warnings.push(
					`File boost for ${filePath} is ${boost}, outside range [${this.config.minFileBoost}, ${this.config.maxFileBoost}]`,
				);
			}
		}

		return {
			valid: errors.length === 0,
			errors,
			warnings,
		};
	}

	/**
	 * Normalize weights to ensure they're well-formed.
	 */
	normalize(weights: LearnedWeights): LearnedWeights {
		// Normalize vector + BM25 to sum to 1.0
		const sum = weights.vectorWeight + weights.bm25Weight;
		const normalizedVector = sum > 0 ? weights.vectorWeight / sum : 0.6;
		const normalizedBM25 = sum > 0 ? weights.bm25Weight / sum : 0.4;

		// Clamp to valid range
		const clampedVector = this.clamp(normalizedVector);
		const clampedBM25 = 1.0 - clampedVector; // Ensure sum is exactly 1.0

		// Normalize document type weights (optional - they don't need to sum to 1)
		const normalizedDocWeights = { ...weights.documentTypeWeights };
		for (const [docType, weight] of Object.entries(normalizedDocWeights)) {
			normalizedDocWeights[docType as DocumentType] = Math.max(
				0,
				Math.min(1, weight),
			);
		}

		// Clamp file boosts
		const normalizedFileBoosts = new Map<string, number>();
		for (const [filePath, boost] of weights.fileBoosts) {
			normalizedFileBoosts.set(
				filePath,
				Math.max(
					this.config.minFileBoost,
					Math.min(this.config.maxFileBoost, boost),
				),
			);
		}

		return {
			...weights,
			vectorWeight: clampedVector,
			bm25Weight: clampedBM25,
			documentTypeWeights: normalizedDocWeights,
			fileBoosts: normalizedFileBoosts,
		};
	}

	/**
	 * Blend two weight sets based on confidence.
	 * Useful for cold start: blend learned weights with defaults.
	 */
	blend(
		learned: LearnedWeights,
		defaults: LearnedWeights,
		blendFactor: number,
	): LearnedWeights {
		const factor = Math.max(0, Math.min(1, blendFactor));

		// Blend vector/BM25 weights
		const vectorWeight =
			learned.vectorWeight * factor + defaults.vectorWeight * (1 - factor);
		const bm25Weight = 1.0 - vectorWeight;

		// Blend document type weights
		const documentTypeWeights: Partial<Record<DocumentType, number>> = {};
		const allTypes = new Set([
			...Object.keys(learned.documentTypeWeights),
			...Object.keys(defaults.documentTypeWeights),
		]) as Set<DocumentType>;

		for (const docType of allTypes) {
			const learnedVal = learned.documentTypeWeights[docType] ?? 0.1;
			const defaultVal = defaults.documentTypeWeights[docType] ?? 0.1;
			documentTypeWeights[docType] =
				learnedVal * factor + defaultVal * (1 - factor);
		}

		// For file boosts, prefer learned if factor > 0.5, otherwise use defaults
		const fileBoosts =
			factor > 0.5 ? new Map(learned.fileBoosts) : new Map(defaults.fileBoosts);

		return {
			vectorWeight,
			bm25Weight,
			documentTypeWeights,
			fileBoosts,
			queryPatterns:
				factor > 0.5 ? learned.queryPatterns : defaults.queryPatterns,
			lastUpdated: new Date(),
			feedbackCount: learned.feedbackCount,
			confidence: factor,
		};
	}

	private clamp(value: number): number {
		return Math.max(
			this.config.minWeight,
			Math.min(this.config.maxWeight, value),
		);
	}
}

// ============================================================================
// Types
// ============================================================================

export interface ValidationResult {
	valid: boolean;
	errors: string[];
	warnings: string[];
}

// ============================================================================
// Factory
// ============================================================================

export function createWeightOptimizer(
	config?: Partial<LearningConfig>,
): WeightOptimizer {
	return new WeightOptimizer(config);
}
