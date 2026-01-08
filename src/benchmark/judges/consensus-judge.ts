/**
 * Consensus Judge
 *
 * Runs multiple judges and aggregates their scores using median or mean.
 * Provides more robust evaluation than a single judge.
 */

import type { FileSummary, SymbolSummary } from "../../types.js";
import type {
	IJudge,
	JudgeContext,
	JudgeInfo,
	JudgmentResult,
} from "../types.js";

// ============================================================================
// Types
// ============================================================================

export type AggregationMethod = "median" | "mean";

// ============================================================================
// Consensus Judge Implementation
// ============================================================================

export class ConsensusJudge implements IJudge {
	private judges: IJudge[];
	private aggregationMethod: AggregationMethod;

	constructor(
		judges: IJudge[],
		aggregationMethod: AggregationMethod = "median",
	) {
		if (judges.length === 0) {
			throw new Error("ConsensusJudge requires at least one judge");
		}
		this.judges = judges;
		this.aggregationMethod = aggregationMethod;
	}

	async judge(
		generated: FileSummary | SymbolSummary,
		context: JudgeContext,
	): Promise<JudgmentResult> {
		const startTime = Date.now();

		// Run all judges in parallel
		const results = await Promise.all(
			this.judges.map((judge) => judge.judge(generated, context)),
		);

		// Filter out failed judgments (those with default scores due to errors)
		const validResults = results.filter(
			(r) => !r.feedback?.startsWith("Judgment failed:"),
		);

		// If all failed, return the first result
		if (validResults.length === 0) {
			return results[0];
		}

		// Aggregate scores
		const usefulness = this.aggregate(validResults.map((r) => r.usefulness));
		const conciseness = this.aggregate(validResults.map((r) => r.conciseness));
		const clarity = this.aggregate(validResults.map((r) => r.clarity));

		// Calculate overall quality score
		const qualityScore = Math.round(
			usefulness * 0.5 + conciseness * 0.25 + clarity * 0.25,
		);

		// Combine feedback from all judges
		const feedbackParts = validResults
			.map((r) => r.feedback)
			.filter((f): f is string => !!f);
		const feedback =
			feedbackParts.length > 0 ? feedbackParts.join(" | ") : undefined;

		const durationMs = Date.now() - startTime;
		const judgeNames = this.judges
			.map((j) => j.getInfo().model || j.getInfo().name)
			.join(", ");

		return {
			usefulness,
			conciseness,
			clarity,
			qualityScore,
			feedback,
			judgedBy: `Consensus (${judgeNames})`,
			durationMs,
		};
	}

	getInfo(): JudgeInfo {
		const judgeModels = this.judges
			.map((j) => j.getInfo().model || j.getInfo().name)
			.join(", ");

		return {
			name: `Consensus Judge (${this.aggregationMethod})`,
			model: judgeModels,
			type: "consensus",
		};
	}

	/**
	 * Aggregate values using the configured method.
	 */
	private aggregate(values: number[]): number {
		if (values.length === 0) return 0;
		if (values.length === 1) return values[0];

		if (this.aggregationMethod === "median") {
			return median(values);
		} else {
			return mean(values);
		}
	}
}

// ============================================================================
// Utility Functions
// ============================================================================

function mean(values: number[]): number {
	if (values.length === 0) return 0;
	const sum = values.reduce((a, b) => a + b, 0);
	return Math.round(sum / values.length);
}

function median(values: number[]): number {
	if (values.length === 0) return 0;
	if (values.length === 1) return values[0];

	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);

	if (sorted.length % 2 === 0) {
		return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
	} else {
		return sorted[mid];
	}
}
