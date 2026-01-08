/**
 * Detailed Reporter
 *
 * Produces a comprehensive CLI report with examples,
 * per-test-case breakdowns, and analysis.
 */

import type {
	BenchmarkResults,
	GeneratorResults,
	IReporter,
	ReportFormat,
	TestCaseResult,
} from "../types.js";

// ============================================================================
// Colors
// ============================================================================

const c = {
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	dim: "\x1b[2m",
	green: "\x1b[38;5;78m",
	yellow: "\x1b[33m",
	red: "\x1b[31m",
	cyan: "\x1b[36m",
	orange: "\x1b[38;5;209m",
};

// ============================================================================
// Detailed Reporter Implementation
// ============================================================================

export class DetailedReporter implements IReporter {
	async report(results: BenchmarkResults): Promise<string> {
		const lines: string[] = [];

		// Title
		lines.push("");
		lines.push(
			`${c.orange}${c.bold}═══════════════════════════════════════════════════════════════${c.reset}`,
		);
		lines.push(
			`${c.orange}${c.bold}                    LLM BENCHMARK REPORT${c.reset}`,
		);
		lines.push(
			`${c.orange}${c.bold}═══════════════════════════════════════════════════════════════${c.reset}`,
		);
		lines.push("");
		lines.push(`${c.dim}Generated: ${results.metadata.timestamp}${c.reset}`);
		lines.push("");

		// Executive Summary first - the most important info
		lines.push(`${c.cyan}${c.bold}▶ EXECUTIVE SUMMARY${c.reset}`);
		lines.push("─".repeat(50));
		lines.push(this.formatExecutiveSummary(results));
		lines.push("");

		// Results Table - key data
		lines.push(`${c.cyan}${c.bold}▶ RESULTS${c.reset}`);
		lines.push("─".repeat(50));
		lines.push(this.formatResultsTable(results));
		lines.push("");

		// Check for diagnostic issues
		const diagnostics = this.collectDiagnostics(results);
		if (diagnostics.hasIssues) {
			lines.push(`${c.red}${c.bold}▶ DIAGNOSTIC ISSUES${c.reset}`);
			lines.push("─".repeat(50));
			lines.push(this.formatDiagnostics(diagnostics));
			lines.push("");
		}

		// Methodology - detailed info at the bottom
		lines.push(`${c.cyan}${c.bold}▶ METHODOLOGY${c.reset}`);
		lines.push("─".repeat(50));
		lines.push(`  Project:      ${results.metadata.projectPath}`);
		lines.push(`  Test Cases:   ${results.metadata.totalTestCases} total`);
		lines.push(
			`                ├─ File summaries:   ${results.metadata.testCaseTypes.file_summary}`,
		);
		lines.push(
			`                └─ Symbol summaries: ${results.metadata.testCaseTypes.symbol_summary}`,
		);
		lines.push(
			`  Judges:       ${results.metadata.judges.length > 0 ? results.metadata.judges.join(", ") : "None (AST validation only)"}`,
		);
		lines.push("");
		lines.push(`  ${c.bold}Scoring Weights:${c.reset}`);
		lines.push(
			`    Correctness:  ${Math.round(results.metadata.weights.correctness * 100)}%  (AST validation)`,
		);
		lines.push(
			`    Completeness: ${Math.round(results.metadata.weights.completeness * 100)}%  (field coverage)`,
		);
		lines.push(
			`    Usefulness:   ${Math.round(results.metadata.weights.usefulness * 100)}%  (LLM judge)`,
		);
		lines.push(
			`    Conciseness:  ${Math.round(results.metadata.weights.conciseness * 100)}%  (LLM judge)`,
		);
		lines.push(
			`    Speed:        ${Math.round(results.metadata.weights.speed * 100)}%  (normalized)`,
		);
		lines.push(
			`    Cost:         ${Math.round(results.metadata.weights.cost * 100)}%  (normalized)`,
		);
		lines.push("");

		// Recommendations
		lines.push(`${c.cyan}${c.bold}▶ RECOMMENDATIONS${c.reset}`);
		lines.push("─".repeat(50));
		lines.push(this.formatRecommendations(results));

		return lines.join("\n");
	}

	getFormat(): ReportFormat {
		return "detailed";
	}

	/**
	 * Format executive summary.
	 */
	private formatExecutiveSummary(results: BenchmarkResults): string {
		// Filter out models with 0% (complete failures)
		const validModels = results.generators.filter((g) => g.scores.overall > 0);
		const sorted = [...validModels].sort(
			(a, b) => b.scores.overall - a.scores.overall,
		);
		const best = sorted[0];
		const worst = sorted[sorted.length - 1];
		const failedCount = results.generators.length - validModels.length;

		const lines: string[] = [];
		if (best) {
			lines.push(
				`  ${c.green}${c.bold}🏆 Winner: ${best.info.displayName}${c.reset} with ${c.bold}${best.scores.overall}%${c.reset} overall score`,
			);
		} else {
			lines.push(`  ${c.red}No models completed successfully${c.reset}`);
		}
		lines.push("");
		lines.push(
			`  Tested ${results.generators.length} models on ${results.metadata.totalTestCases} test cases`,
		);
		if (failedCount > 0) {
			lines.push(
				`  ${c.red}${failedCount} model(s) failed completely${c.reset}`,
			);
		}
		lines.push("");

		if (best && worst && best.scores.overall - worst.scores.overall > 10) {
			lines.push(
				`  Significant difference between best (${best.scores.overall}%) and worst (${worst.scores.overall}%)`,
			);
		} else if (best && worst) {
			lines.push(
				`  Models performed similarly (${worst.scores.overall}%-${best.scores.overall}% range)`,
			);
		}

		return lines.join("\n");
	}

	/**
	 * Format results table for CLI.
	 * Shows automated scores (Correct, Complete) + judge Quality + metrics (Speed, Time, Price).
	 */
	private formatResultsTable(results: BenchmarkResults): string {
		const lines: string[] = [];

		// Only consider non-failed models for ranking
		const validGens = results.generators.filter((g) => g.scores.overall > 0);

		// Check if we have valid judge evaluations
		const hasValidJudges =
			results.metadata.judges.length > 0 &&
			validGens.some((g) => g.scores.usefulness > 0);

		// Calculate rankings for each column (higher is better for scores, lower is better for price/time)
		const getRanks = (
			values: number[],
			higherIsBetter = true,
		): Map<number, "top" | "bottom" | null> => {
			const sorted = [...new Set(values)].sort((a, b) =>
				higherIsBetter ? b - a : a - b,
			);
			const top2 = new Set(sorted.slice(0, 2));
			const bottom2 = new Set(sorted.slice(-2));
			const ranks = new Map<number, "top" | "bottom" | null>();
			for (const v of values) {
				if (top2.has(v)) ranks.set(v, "top");
				else if (bottom2.has(v)) ranks.set(v, "bottom");
				else ranks.set(v, null);
			}
			return ranks;
		};

		// Pre-calculate rankings for all columns
		const correctRanks = getRanks(validGens.map((g) => g.scores.correctness));
		const completeRanks = getRanks(validGens.map((g) => g.scores.completeness));
		const qualityRanks = hasValidJudges
			? getRanks(validGens.map((g) => g.scores.usefulness))
			: new Map();
		const speedRanks = getRanks(validGens.map((g) => g.scores.speed)); // higher = faster = better
		const priceRanks = getRanks(
			validGens.map((g) => g.metrics.totalCost),
			false,
		); // lower is better
		const timeRanks = getRanks(
			validGens.map((g) => g.metrics.avgDurationMs),
			false,
		); // lower is better

		// Check if we have per-judge breakdowns
		const hasJudgeBreakdown = results.generators.some(
			(g) => g.scores.judgeBreakdown && g.scores.judgeBreakdown.length > 1,
		);

		// Calculate dynamic widths
		const maxModelLen = Math.max(
			24,
			...results.generators.map((g) => g.info.displayName.length),
		);
		const priceWidth =
			Math.max(
				7,
				...results.generators.map(
					(g) => this.formatPrice(g.metrics.totalCost).length,
				),
			) + 1;
		const qualityWidth = hasJudgeBreakdown
			? this.calculateUsefulWidth(results)
			: 10;

		// Build headers based on whether we have judges
		const headers = hasValidJudges
			? [
					"Model",
					"Correct",
					"Complete",
					"Quality",
					"Speed",
					"Time",
					"Price",
					"Status",
				]
			: ["Model", "Correct", "Complete", "Speed", "Time", "Price", "Status"];
		const widths = hasValidJudges
			? [
					Math.min(maxModelLen, 30) + 2,
					8,
					9,
					qualityWidth,
					6,
					8,
					priceWidth,
					12,
				]
			: [Math.min(maxModelLen, 30) + 2, 8, 9, 6, 8, priceWidth, 12];

		const headerRow =
			"  " + headers.map((h, i) => h.padEnd(widths[i])).join(" ");
		lines.push(`${c.bold}${headerRow}${c.reset}`);
		lines.push("  " + "─".repeat(headerRow.length - 2));

		// Helper to colorize based on rank
		const colorize = (str: string, rank: "top" | "bottom" | null): string => {
			if (rank === "top") return `${c.green}${str}${c.reset}`;
			if (rank === "bottom") return `${c.red}${str}${c.reset}`;
			return str;
		};

		// Data rows
		for (const gen of results.generators) {
			const s = gen.scores;
			const m = gen.metrics;
			const isFailed = m.failures === results.metadata.totalTestCases;

			const modelName = this.truncate(gen.info.displayName, widths[0] - 2);

			// Format quality with optional judge breakdown
			let qualityStr: string;
			if (isFailed || !hasValidJudges) {
				qualityStr = `${c.dim}-${c.reset}`;
			} else if (
				hasJudgeBreakdown &&
				s.judgeBreakdown &&
				s.judgeBreakdown.length > 1
			) {
				const breakdown = s.judgeBreakdown
					.map((jb) => jb.qualityScore)
					.join(",");
				qualityStr = `${s.usefulness}%(${breakdown})`;
			} else {
				qualityStr = `${s.usefulness}%`;
			}

			const statusStr = isFailed
				? `${c.red}FAILED${c.reset}`
				: m.failures > 0
					? `${c.yellow}${m.failures} err${c.reset}`
					: `${c.green}OK${c.reset}`;

			const values = hasValidJudges
				? [
						modelName,
						isFailed
							? `${c.dim}-${c.reset}`
							: colorize(
									`${s.correctness}%`,
									correctRanks.get(s.correctness) ?? null,
								),
						isFailed
							? `${c.dim}-${c.reset}`
							: colorize(
									`${s.completeness}%`,
									completeRanks.get(s.completeness) ?? null,
								),
						isFailed
							? `${c.dim}-${c.reset}`
							: colorize(qualityStr, qualityRanks.get(s.usefulness) ?? null),
						isFailed
							? `${c.dim}-${c.reset}`
							: colorize(`${s.speed}%`, speedRanks.get(s.speed) ?? null),
						isFailed
							? `${c.dim}-${c.reset}`
							: colorize(
									this.formatDuration(m.avgDurationMs),
									timeRanks.get(m.avgDurationMs) ?? null,
								),
						isFailed
							? `${c.dim}-${c.reset}`
							: colorize(
									this.formatPrice(m.totalCost),
									priceRanks.get(m.totalCost) ?? null,
								),
						statusStr,
					]
				: [
						modelName,
						isFailed
							? `${c.dim}-${c.reset}`
							: colorize(
									`${s.correctness}%`,
									correctRanks.get(s.correctness) ?? null,
								),
						isFailed
							? `${c.dim}-${c.reset}`
							: colorize(
									`${s.completeness}%`,
									completeRanks.get(s.completeness) ?? null,
								),
						isFailed
							? `${c.dim}-${c.reset}`
							: colorize(`${s.speed}%`, speedRanks.get(s.speed) ?? null),
						isFailed
							? `${c.dim}-${c.reset}`
							: colorize(
									this.formatDuration(m.avgDurationMs),
									timeRanks.get(m.avgDurationMs) ?? null,
								),
						isFailed
							? `${c.dim}-${c.reset}`
							: colorize(
									this.formatPrice(m.totalCost),
									priceRanks.get(m.totalCost) ?? null,
								),
						statusStr,
					];

			const row = values
				.map((v, i) => {
					const stripped = v.replace(/\x1b\[[0-9;]*m/g, "");
					const padding = widths[i] - stripped.length;
					return v + " ".repeat(Math.max(0, padding));
				})
				.join(" ");

			lines.push("  " + row);
		}

		// Add note if no judges configured
		if (!hasValidJudges && results.metadata.judges.length === 0) {
			lines.push("");
			lines.push(
				`  ${c.dim}Tip: Add --judges=claude-sonnet-4 for quality evaluation${c.reset}`,
			);
		}

		return lines.join("\n");
	}

	/**
	 * Calculate width needed for usefulness column with judge breakdown.
	 */
	private calculateUsefulWidth(results: BenchmarkResults): number {
		let maxLen = 8;
		for (const gen of results.generators) {
			if (gen.scores.judgeBreakdown && gen.scores.judgeBreakdown.length > 1) {
				const breakdown = gen.scores.judgeBreakdown
					.map((jb) => jb.qualityScore.toString())
					.join(",");
				const formatted = `${gen.scores.usefulness}%(${breakdown})`;
				maxLen = Math.max(maxLen, formatted.length + 1);
			}
		}
		return maxLen;
	}

	/**
	 * Format price in USD.
	 */
	private formatPrice(cost: number): string {
		if (cost === 0) return "free";
		if (cost < 0.001) return "<$0.001";
		if (cost < 0.01) return `$${cost.toFixed(4)}`;
		if (cost < 1) return `$${cost.toFixed(3)}`;
		return `$${cost.toFixed(2)}`;
	}

	/**
	 * Format per-model analysis.
	 */
	private formatModelAnalysis(gen: GeneratorResults): string {
		const lines: string[] = [];
		const s = gen.scores;
		const m = gen.metrics;

		// Skip detailed analysis for completely failed models
		if (s.overall === 0) {
			lines.push(
				`  ${c.bold}${gen.info.displayName}${c.reset} ${c.red}[FAILED]${c.reset}`,
			);
			lines.push(
				`    Provider: ${gen.info.provider} | Model: ${gen.info.model}`,
			);
			lines.push(`    ${c.red}All ${m.failures} test cases failed${c.reset}`);
			return lines.join("\n");
		}

		lines.push(`  ${c.bold}${gen.info.displayName}${c.reset}`);
		lines.push(`    Provider: ${gen.info.provider} | Model: ${gen.info.model}`);
		lines.push("");

		// Scores in compact format
		lines.push(`    ${c.bold}Scores:${c.reset}`);
		lines.push(
			`      Overall: ${c.bold}${s.overall}%${c.reset}  |  Correct: ${s.correctness}%  |  Complete: ${s.completeness}%`,
		);
		lines.push(
			`      Useful: ${s.usefulness}%  |  Concise: ${s.conciseness}%  |  Speed: ${s.speed}%  |  Cost: ${s.cost}%`,
		);
		lines.push("");

		// Performance
		lines.push(`    ${c.bold}Performance:${c.reset}`);
		lines.push(
			`      Avg time: ${this.formatDuration(m.avgDurationMs)}  |  Cost: ${this.formatCost(m.totalCost)}  |  Tokens: ${m.totalTokens.toLocaleString()}`,
		);
		const successPct = Math.round(m.successRate * 100);
		if (m.failures > 0) {
			lines.push(
				`      Success: ${c.yellow}${successPct}%${c.reset} (${m.failures} failures)`,
			);
		} else {
			lines.push(`      Success: ${c.green}${successPct}%${c.reset}`);
		}

		// Score distribution (compact)
		if (gen.testCaseResults.length > 0) {
			const distribution = this.getScoreDistribution(gen.testCaseResults);
			const distStr = Object.entries(distribution)
				.filter(([, count]) => count > 0)
				.map(([range, count]) => `${range}: ${count}`)
				.join(" | ");
			if (distStr) {
				lines.push(`      Score dist: ${distStr}`);
			}
		}

		return lines.join("\n");
	}

	/**
	 * Format example comparisons between models.
	 */
	private formatExampleComparisons(results: BenchmarkResults): string {
		const lines: string[] = [];

		// Find a test case where models differ significantly
		const firstGen = results.generators[0];
		const secondGen = results.generators[1];

		if (!firstGen || !secondGen) {
			return "Not enough models for comparison.";
		}

		// Find most different test case
		let maxDiff = 0;
		let diffTestCaseId = "";

		for (const tcr of firstGen.testCaseResults) {
			const otherTcr = secondGen.testCaseResults.find(
				(t) => t.testCase.id === tcr.testCase.id,
			);
			if (otherTcr) {
				const diff = Math.abs(tcr.overallScore - otherTcr.overallScore);
				if (diff > maxDiff) {
					maxDiff = diff;
					diffTestCaseId = tcr.testCase.id;
				}
			}
		}

		if (!diffTestCaseId) {
			return "No significant differences found between models.";
		}

		const tcr1 = firstGen.testCaseResults.find(
			(t) => t.testCase.id === diffTestCaseId,
		)!;
		const tcr2 = secondGen.testCaseResults.find(
			(t) => t.testCase.id === diffTestCaseId,
		)!;

		lines.push(
			`### Comparison: ${tcr1.testCase.type === "file_summary" ? "File" : "Symbol"} Summary`,
		);
		lines.push("");
		lines.push(`**Test Case**: ${tcr1.testCase.filePath}`);
		lines.push(`**Score Difference**: ${maxDiff} points`);
		lines.push("");

		lines.push(
			`#### ${firstGen.info.displayName} (Score: ${tcr1.overallScore}%)`,
		);
		lines.push("");
		lines.push("```");
		lines.push(this.formatSummary(tcr1.generation.result));
		lines.push("```");
		lines.push("");

		lines.push(
			`#### ${secondGen.info.displayName} (Score: ${tcr2.overallScore}%)`,
		);
		lines.push("");
		lines.push("```");
		lines.push(this.formatSummary(tcr2.generation.result));
		lines.push("```");

		return lines.join("\n");
	}

	/**
	 * Format recommendations based on results.
	 */
	private formatRecommendations(results: BenchmarkResults): string {
		const lines: string[] = [];

		// Filter out failed models (0% score)
		const validModels = results.generators.filter((g) => g.scores.overall > 0);

		if (validModels.length === 0) {
			lines.push(
				`  ${c.red}No models completed successfully - cannot make recommendations${c.reset}`,
			);
			return lines.join("\n");
		}

		const sorted = [...validModels].sort(
			(a, b) => b.scores.overall - a.scores.overall,
		);

		const best = sorted[0];

		// Find cheapest among valid models
		const cheapest = validModels.reduce((a, b) =>
			a.metrics.totalCost < b.metrics.totalCost ? a : b,
		);

		// Find fastest among valid models
		const fastest = validModels.reduce((a, b) =>
			a.metrics.avgDurationMs < b.metrics.avgDurationMs ? a : b,
		);

		lines.push(
			`  ${c.green}${c.bold}Best Overall: ${best.info.displayName}${c.reset}`,
		);
		lines.push(
			`    ${best.scores.overall}% overall score - best balance of quality and performance`,
		);
		lines.push("");

		if (cheapest !== best && cheapest.scores.overall > 0) {
			lines.push(
				`  ${c.cyan}Best Value: ${cheapest.info.displayName}${c.reset}`,
			);
			lines.push(
				`    ${this.formatCost(cheapest.metrics.totalCost)} cost with ${cheapest.scores.overall}% score`,
			);
			lines.push("");
		}

		if (
			fastest !== best &&
			fastest !== cheapest &&
			fastest.scores.overall > 0
		) {
			lines.push(`  ${c.yellow}Fastest: ${fastest.info.displayName}${c.reset}`);
			lines.push(
				`    ${this.formatDuration(fastest.metrics.avgDurationMs)} avg time`,
			);
			lines.push("");
		}

		// Use case recommendations
		lines.push(`  ${c.bold}Use Case Recommendations:${c.reset}`);
		lines.push(`    Production (quality): ${best.info.displayName}`);
		lines.push(`    Development (cost):   ${cheapest.info.displayName}`);
		lines.push(`    CI/CD (speed):        ${fastest.info.displayName}`);

		return lines.join("\n");
	}

	/**
	 * Get score distribution buckets.
	 */
	private getScoreDistribution(
		results: TestCaseResult[],
	): Record<string, number> {
		const buckets: Record<string, number> = {
			"90-100": 0,
			"80-89": 0,
			"70-79": 0,
			"60-69": 0,
			"50-59": 0,
			"0-49": 0,
		};

		for (const r of results) {
			const score = r.overallScore;
			if (score >= 90) buckets["90-100"]++;
			else if (score >= 80) buckets["80-89"]++;
			else if (score >= 70) buckets["70-79"]++;
			else if (score >= 60) buckets["60-69"]++;
			else if (score >= 50) buckets["50-59"]++;
			else buckets["0-49"]++;
		}

		return buckets;
	}

	/**
	 * Format a summary for display.
	 */
	private formatSummary(summary: any): string {
		if ("symbolName" in summary) {
			return `Symbol: ${summary.symbolName}\nSummary: ${summary.summary}\nParameters: ${summary.parameters?.map((p: any) => p.name).join(", ") || "none"}`;
		}
		return `File Summary: ${summary.summary}\nExports: ${summary.exports?.join(", ") || "none"}`;
	}

	/**
	 * Format duration.
	 */
	private formatDuration(ms: number): string {
		if (ms < 1000) return `${Math.round(ms)}ms`;
		return `${(ms / 1000).toFixed(1)}s`;
	}

	/**
	 * Format cost.
	 */
	private formatCost(cost: number): string {
		if (cost === 0) return "FREE";
		if (cost < 0.01) return `$${cost.toFixed(4)}`;
		return `$${cost.toFixed(3)}`;
	}

	/**
	 * Truncate string with ellipsis.
	 */
	private truncate(str: string, maxLen: number): string {
		if (str.length <= maxLen) return str;
		return str.slice(0, maxLen - 1) + "…";
	}

	// ============================================================================
	// Diagnostics
	// ============================================================================

	/**
	 * Diagnostic information collected from benchmark results.
	 */
	private collectDiagnostics(results: BenchmarkResults): DiagnosticInfo {
		const info: DiagnosticInfo = {
			hasIssues: false,
			noJudgeConfigured: results.metadata.judges.length === 0,
			failedGenerators: [],
			judgeFailures: [],
			allJudgesFailed: false,
		};

		// Check for generator failures (0% models)
		for (const gen of results.generators) {
			if (gen.scores.overall === 0) {
				info.failedGenerators.push({
					model: gen.info.displayName,
					failures: gen.metrics.failures,
					total: results.metadata.totalTestCases,
					errors: gen.metrics.errors || [],
				});
			}
		}

		// Check for judge failures by looking at feedback in test case results
		const judgeErrorPatterns = new Map<string, number>();
		let totalJudgments = 0;
		let failedJudgments = 0;
		let successfulJudgments = 0;

		for (const gen of results.generators) {
			for (const tcr of gen.testCaseResults) {
				if (tcr.judgment) {
					totalJudgments++;
					const feedback = tcr.judgment.feedback || "";
					if (feedback.startsWith("Judgment failed:")) {
						failedJudgments++;
						// Extract the error message
						const errorMsg = feedback.replace("Judgment failed: ", "").trim();
						// Normalize common errors
						const normalizedError = this.normalizeJudgeError(errorMsg);
						judgeErrorPatterns.set(
							normalizedError,
							(judgeErrorPatterns.get(normalizedError) || 0) + 1,
						);
					} else {
						successfulJudgments++;
					}
				}
			}
		}

		// Convert to array sorted by frequency
		for (const [error, count] of judgeErrorPatterns) {
			info.judgeFailures.push({ error, count });
		}
		info.judgeFailures.sort((a, b) => b.count - a.count);

		// Check if all judgments failed
		if (totalJudgments > 0 && failedJudgments === totalJudgments) {
			info.allJudgesFailed = true;
		}

		// Check for zero usefulness scores (indicates judge not producing results)
		const allUsefulnessScores = results.generators
			.filter((g) => g.scores.overall > 0)
			.map((g) => g.scores.usefulness);
		const allZero =
			allUsefulnessScores.length > 0 &&
			allUsefulnessScores.every((s) => s === 0);
		if (allZero && results.metadata.judges.length > 0) {
			info.allJudgesFailed = true;
		}

		info.hasIssues =
			info.noJudgeConfigured ||
			info.failedGenerators.length > 0 ||
			info.judgeFailures.length > 0 ||
			info.allJudgesFailed;

		return info;
	}

	/**
	 * Normalize judge error messages for grouping.
	 */
	private normalizeJudgeError(error: string): string {
		// Common patterns to normalize
		if (
			error.includes("401") ||
			error.includes("invalid_api_key") ||
			error.includes("Unauthorized")
		) {
			return "API key invalid or missing";
		}
		if (
			error.includes("429") ||
			error.includes("rate limit") ||
			error.includes("Rate limit")
		) {
			return "Rate limit exceeded";
		}
		if (
			error.includes("timeout") ||
			error.includes("Timeout") ||
			error.includes("ETIMEDOUT")
		) {
			return "Request timeout";
		}
		if (
			error.includes("500") ||
			error.includes("502") ||
			error.includes("503") ||
			error.includes("504")
		) {
			return "Server error (5xx)";
		}
		if (error.includes("Failed to parse") || error.includes("JSON")) {
			return "Invalid JSON response from LLM";
		}
		if (error.includes("model") && error.includes("not found")) {
			return "Model not found";
		}
		// Return full error - no truncation
		return error;
	}

	/**
	 * Format diagnostics section.
	 */
	private formatDiagnostics(diag: DiagnosticInfo): string {
		const lines: string[] = [];

		if (diag.noJudgeConfigured) {
			lines.push(`  ${c.yellow}⚠ No judge configured${c.reset}`);
			lines.push(`    Usefulness and Conciseness scores default to 50%`);
			lines.push(`    Add judges with: --judge anthropic/claude-sonnet-4`);
			lines.push("");
		}

		if (diag.allJudgesFailed && !diag.noJudgeConfigured) {
			lines.push(`  ${c.red}✖ All judge evaluations failed${c.reset}`);
			if (diag.judgeFailures.length > 0) {
				lines.push(`    ${c.dim}Errors:${c.reset}`);
				for (const { error, count } of diag.judgeFailures) {
					lines.push(
						`      ${c.red}→ ${error}${c.reset} ${c.dim}(${count}x)${c.reset}`,
					);
				}
			} else {
				lines.push(`    ${c.dim}Judges returned no valid scores${c.reset}`);
			}
			lines.push("");
		}

		if (diag.judgeFailures.length > 0 && !diag.allJudgesFailed) {
			lines.push(`  ${c.yellow}⚠ Judge errors encountered:${c.reset}`);
			for (const { error, count } of diag.judgeFailures) {
				lines.push(`    ${c.dim}(${count}x)${c.reset} ${error}`);
			}
			lines.push("");
		}

		if (diag.failedGenerators.length > 0) {
			lines.push(`  ${c.red}✖ Generator failures (0% score):${c.reset}`);
			for (const { model, failures, total, errors } of diag.failedGenerators) {
				lines.push(`    ${model}: ${failures}/${total} test cases failed`);
				// Show actual errors
				if (errors.length > 0) {
					const uniqueErrors = [...new Set(errors)];
					for (const error of uniqueErrors) {
						lines.push(`      ${c.dim}→ ${error}${c.reset}`);
					}
				}
			}
			lines.push("");
		}

		// Add tips based on issues
		if (diag.hasIssues) {
			const tips: string[] = [];
			if (diag.judgeFailures.some((f) => f.error.includes("API key"))) {
				tips.push(`Check ANTHROPIC_API_KEY or OPENROUTER_API_KEY env vars`);
			}
			if (diag.judgeFailures.some((f) => f.error.includes("Rate limit"))) {
				tips.push(`Reduce parallelism or add delays between requests`);
			}
			if (tips.length > 0) {
				lines.push(`  ${c.cyan}Tips:${c.reset}`);
				for (const tip of tips) {
					lines.push(`    • ${tip}`);
				}
			}
		}

		return lines.join("\n");
	}
}

// ============================================================================
// Types
// ============================================================================

interface DiagnosticInfo {
	hasIssues: boolean;
	noJudgeConfigured: boolean;
	failedGenerators: Array<{
		model: string;
		failures: number;
		total: number;
		errors: string[];
	}>;
	judgeFailures: Array<{ error: string; count: number }>;
	allJudgesFailed: boolean;
}
