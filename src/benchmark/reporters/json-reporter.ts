/**
 * JSON Reporter
 *
 * Outputs benchmark results as machine-readable JSON.
 * Useful for automation, further analysis, or integrations.
 */

import type { BenchmarkResults, IReporter, ReportFormat } from "../types.js";

// ============================================================================
// JSON Reporter Implementation
// ============================================================================

export class JSONReporter implements IReporter {
	private pretty: boolean;

	constructor(pretty = true) {
		this.pretty = pretty;
	}

	async report(results: BenchmarkResults): Promise<string> {
		// Clean up results for JSON output
		const cleanResults = this.cleanResults(results);

		if (this.pretty) {
			return JSON.stringify(cleanResults, null, 2);
		}
		return JSON.stringify(cleanResults);
	}

	getFormat(): ReportFormat {
		return "json";
	}

	/**
	 * Clean results for JSON serialization.
	 * Removes circular references and simplifies nested structures.
	 */
	private cleanResults(results: BenchmarkResults): object {
		return {
			metadata: results.metadata,
			rankings: results.rankings,
			generators: results.generators.map((gen) => ({
				info: gen.info,
				scores: gen.scores,
				metrics: gen.metrics,
				testCaseCount: gen.testCaseResults.length,
				// Summarize test case results instead of including full content
				testCaseSummary: {
					avgOverallScore: this.avg(
						gen.testCaseResults.map((r) => r.overallScore),
					),
					scoreDistribution: this.scoreDistribution(
						gen.testCaseResults.map((r) => r.overallScore),
					),
					failedCount: gen.metrics.failures,
				},
			})),
			// Include full test case results as separate section
			testCaseDetails: results.generators.map((gen) => ({
				generator: gen.info.model,
				results: gen.testCaseResults.map((tcr) => ({
					testCaseId: tcr.testCase.id,
					type: tcr.testCase.type,
					filePath: tcr.testCase.filePath,
					overallScore: tcr.overallScore,
					scores: tcr.scores.reduce(
						(acc, s) => ({ ...acc, [s.criterion]: s.score }),
						{} as Record<string, number>,
					),
					judgment: tcr.judgment
						? {
								usefulness: tcr.judgment.usefulness,
								conciseness: tcr.judgment.conciseness,
								clarity: tcr.judgment.clarity,
								judgedBy: tcr.judgment.judgedBy,
							}
						: null,
					generation: {
						durationMs: tcr.generation.durationMs,
						cost: tcr.generation.usage.cost,
						tokens:
							tcr.generation.usage.inputTokens +
							tcr.generation.usage.outputTokens,
					},
				})),
			})),
		};
	}

	/**
	 * Calculate average.
	 */
	private avg(values: number[]): number {
		if (values.length === 0) return 0;
		return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
	}

	/**
	 * Calculate score distribution buckets.
	 */
	private scoreDistribution(scores: number[]): Record<string, number> {
		const buckets = {
			"90-100": 0,
			"80-89": 0,
			"70-79": 0,
			"60-69": 0,
			"50-59": 0,
			"0-49": 0,
		};

		for (const score of scores) {
			if (score >= 90) buckets["90-100"]++;
			else if (score >= 80) buckets["80-89"]++;
			else if (score >= 70) buckets["70-79"]++;
			else if (score >= 60) buckets["60-69"]++;
			else if (score >= 50) buckets["50-59"]++;
			else buckets["0-49"]++;
		}

		return buckets;
	}
}
