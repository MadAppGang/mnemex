/**
 * CLI Table Reporter
 *
 * Formats benchmark results as a pretty CLI table.
 * Shows full model names and detailed error information.
 */

import type {
	BenchmarkResults,
	GeneratorResults,
	IReporter,
	ReportFormat,
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
// CLI Reporter Implementation
// ============================================================================

export class CLIReporter implements IReporter {
	private useColors: boolean;

	constructor(useColors = true) {
		this.useColors = useColors;
	}

	async report(results: BenchmarkResults): Promise<string> {
		const lines: string[] = [];

		// Header
		lines.push("");
		lines.push(
			this.color(`${c.orange}${c.bold}🏁 LLM BENCHMARK RESULTS${c.reset}`),
		);
		lines.push("");

		// Metadata
		lines.push(
			this.color(`${c.dim}Project: ${results.metadata.projectPath}${c.reset}`),
		);
		lines.push(
			this.color(
				`${c.dim}Test cases: ${results.metadata.totalTestCases} (${results.metadata.testCaseTypes.file_summary} files, ${results.metadata.testCaseTypes.symbol_summary} symbols)${c.reset}`,
			),
		);
		lines.push(
			this.color(
				`${c.dim}Judges: ${results.metadata.judges.length > 0 ? results.metadata.judges.join(", ") : "none"}${c.reset}`,
			),
		);
		lines.push("");

		// Results table
		lines.push(this.formatResultsTable(results));

		// Failed models section (detailed errors)
		const failedGenerators = results.generators.filter(
			(g) => g.metrics.failures > 0 || g.scores.overall === 0,
		);
		if (failedGenerators.length > 0) {
			lines.push("");
			lines.push(this.color(`${c.red}${c.bold}⚠ FAILED MODELS${c.reset}`));
			for (const gen of failedGenerators) {
				lines.push(
					this.formatFailedGenerator(gen, results.metadata.totalTestCases),
				);
			}
		}

		// Rankings (only show models that didn't completely fail)
		const successfulModels = results.rankings.byOverallScore.filter((model) => {
			const gen = results.generators.find((g) => g.info.model === model);
			return gen && gen.scores.overall > 0;
		});

		if (successfulModels.length > 0) {
			lines.push("");
			lines.push(this.color(`${c.bold}Rankings:${c.reset}`));
			lines.push(
				this.color(
					`  ${c.cyan}Overall:${c.reset} ${this.formatRanking(successfulModels)}`,
				),
			);
			lines.push(
				this.color(
					`  ${c.cyan}Correctness:${c.reset} ${this.formatRanking(results.rankings.byCorrectness.filter((m) => successfulModels.includes(m)))}`,
				),
			);
			lines.push(
				this.color(
					`  ${c.cyan}Speed:${c.reset} ${this.formatRanking(results.rankings.bySpeed.filter((m) => successfulModels.includes(m)))}`,
				),
			);
			lines.push(
				this.color(
					`  ${c.cyan}Cost:${c.reset} ${this.formatRanking(results.rankings.byCost.filter((m) => successfulModels.includes(m)))}`,
				),
			);
		}

		// Weights legend
		lines.push("");
		lines.push(this.formatWeightsLegend(results.metadata.weights));

		return lines.join("\n");
	}

	getFormat(): ReportFormat {
		return "cli";
	}

	/**
	 * Format the main results table with dynamic column widths.
	 */
	private formatResultsTable(results: BenchmarkResults): string {
		const lines: string[] = [];

		// Calculate dynamic model name width (full names, no truncation)
		const maxModelLen = Math.max(
			5, // minimum "Model" header
			...results.generators.map((g) => g.info.displayName.length),
		);

		// Check if we have per-judge breakdowns (multi-judge mode)
		const hasJudgeBreakdown = results.generators.some(
			(g) => g.scores.judgeBreakdown && g.scores.judgeBreakdown.length > 1,
		);

		// Calculate width for usefulness column based on breakdown
		const usefulWidth = hasJudgeBreakdown
			? this.calculateBreakdownWidth(results, "usefulness")
			: 8;

		// Calculate price column width based on actual costs
		const priceWidth =
			Math.max(
				6,
				...results.generators.map(
					(g) => this.formatPrice(g.metrics.totalCost).length,
				),
			) + 1;

		// Headers and widths
		const headers = [
			"Model",
			"Overall",
			"Correct",
			"Complete",
			"Useful",
			"Speed",
			"Price",
			"Time",
			"Status",
		];
		const widths = [
			maxModelLen + 2,
			8,
			8,
			9,
			usefulWidth,
			6,
			priceWidth,
			8,
			12,
		];

		const headerRow = headers.map((h, i) => h.padEnd(widths[i])).join(" ");
		lines.push(this.color(`  ${c.bold}${headerRow}${c.reset}`));
		lines.push("  " + "─".repeat(headerRow.length));

		// Find best/worst for highlighting
		const validOverall = results.generators
			.filter((g) => g.scores.overall > 0)
			.map((g) => g.scores.overall);
		const maxOverall = validOverall.length > 0 ? Math.max(...validOverall) : 0;
		const minOverall = validOverall.length > 0 ? Math.min(...validOverall) : 0;

		// Data rows
		for (const gen of results.generators) {
			const row = this.formatGeneratorRow(
				gen,
				widths,
				maxOverall,
				minOverall,
				results.metadata.totalTestCases,
				hasJudgeBreakdown,
			);
			lines.push("  " + row);
		}

		return lines.join("\n");
	}

	/**
	 * Calculate width needed for breakdown column.
	 */
	private calculateBreakdownWidth(
		results: BenchmarkResults,
		_field: "usefulness" | "conciseness",
	): number {
		let maxLen = 8; // minimum width
		for (const gen of results.generators) {
			if (gen.scores.judgeBreakdown && gen.scores.judgeBreakdown.length > 1) {
				// Format: "75%(80,70,75)" - score + "(" + comma-separated + ")"
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
	 * Format a single generator row with full model name.
	 */
	private formatGeneratorRow(
		gen: GeneratorResults,
		widths: number[],
		maxOverall: number,
		minOverall: number,
		totalTestCases: number,
		hasJudgeBreakdown: boolean,
	): string {
		const scores = gen.scores;
		const metrics = gen.metrics;

		// Full model name (no truncation)
		const modelName = gen.info.displayName;

		// Check if completely failed
		const isFailed =
			scores.overall === 0 && metrics.failures === totalTestCases;
		const hasErrors = metrics.failures > 0 && !isFailed;

		// Format scores with color coding
		const formatScore = (score: number, isBest = false, isWorst = false) => {
			if (isFailed) return this.color(`${c.dim}-${c.reset}`);
			const str = `${score}%`;
			if (isBest && this.useColors) return `${c.green}${str}${c.reset}`;
			if (isWorst && score < 50 && this.useColors)
				return `${c.red}${str}${c.reset}`;
			return str;
		};

		const overallBest = scores.overall === maxOverall && maxOverall > 0;
		const overallWorst =
			scores.overall === minOverall &&
			maxOverall !== minOverall &&
			minOverall > 0;

		// Status column
		let status: string;
		if (isFailed) {
			status = this.color(`${c.red}FAILED${c.reset}`);
		} else if (hasErrors) {
			status = this.color(`${c.yellow}${metrics.failures} err${c.reset}`);
		} else {
			status = this.color(`${c.green}OK${c.reset}`);
		}

		// Format usefulness with optional judge breakdown
		let usefulStr: string;
		if (isFailed) {
			usefulStr = this.color(`${c.dim}-${c.reset}`);
		} else if (
			hasJudgeBreakdown &&
			scores.judgeBreakdown &&
			scores.judgeBreakdown.length > 1
		) {
			// Format: "75%(80,70,75)" showing aggregate and individual judge quality scores
			const breakdown = scores.judgeBreakdown
				.map((jb) => jb.qualityScore)
				.join(",");
			usefulStr = `${scores.usefulness}%(${breakdown})`;
		} else {
			usefulStr = `${scores.usefulness}%`;
		}

		const values = [
			modelName,
			formatScore(scores.overall, overallBest, overallWorst),
			formatScore(scores.correctness),
			formatScore(scores.completeness),
			usefulStr,
			formatScore(scores.speed),
			isFailed
				? this.color(`${c.dim}-${c.reset}`)
				: this.formatPrice(metrics.totalCost),
			isFailed
				? this.color(`${c.dim}-${c.reset}`)
				: this.formatDuration(metrics.avgDurationMs),
			status,
		];

		return values
			.map((v, i) => {
				// Strip ANSI codes for padding calculation
				const stripped = v.replace(/\x1b\[[0-9;]*m/g, "");
				const padding = widths[i] - stripped.length;
				return v + " ".repeat(Math.max(0, padding));
			})
			.join(" ");
	}

	/**
	 * Format detailed error info for a failed generator.
	 */
	private formatFailedGenerator(
		gen: GeneratorResults,
		totalTestCases: number,
	): string {
		const lines: string[] = [];
		const isTotalFailure = gen.scores.overall === 0;

		lines.push(
			this.color(
				`  ${c.red}✗${c.reset} ${c.bold}${gen.info.displayName}${c.reset}`,
			),
		);
		lines.push(
			this.color(
				`    ${c.dim}Provider: ${gen.info.provider} | Model: ${gen.info.model}${c.reset}`,
			),
		);

		if (isTotalFailure) {
			lines.push(
				this.color(
					`    ${c.red}All ${totalTestCases} test cases failed${c.reset}`,
				),
			);
		} else {
			lines.push(
				this.color(
					`    ${c.yellow}${gen.metrics.failures} of ${totalTestCases} test cases failed${c.reset}`,
				),
			);
		}

		// Show actual errors from metrics.errors (captured during generation)
		if (gen.metrics.errors && gen.metrics.errors.length > 0) {
			// Show all unique errors
			const uniqueErrors = [...new Set(gen.metrics.errors)];
			lines.push(
				this.color(
					`    ${c.red}Errors (${uniqueErrors.length} unique):${c.reset}`,
				),
			);
			for (const error of uniqueErrors) {
				lines.push(this.color(`    ${c.red}  • ${error}${c.reset}`));
			}
		} else {
			// Fallback to test case results
			const firstError = gen.testCaseResults.find((r) => r.error);
			if (firstError?.error) {
				lines.push(
					this.color(`    ${c.red}Error: ${firstError.error}${c.reset}`),
				);
			}
		}

		return lines.join("\n");
	}

	/**
	 * Format ranking list.
	 */
	private formatRanking(ranking: string[]): string {
		return ranking
			.slice(0, 5)
			.map((model, i) => {
				const prefix =
					i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}.`;
				// Show short model name for rankings
				const shortModel = model.split("/").pop() || model;
				return `${prefix} ${shortModel}`;
			})
			.join("  ");
	}

	/**
	 * Format weights legend.
	 */
	private formatWeightsLegend(weights: Record<string, number>): string {
		const parts = Object.entries(weights)
			.map(([k, v]) => `${k}: ${Math.round(v * 100)}%`)
			.join(", ");
		return this.color(`${c.dim}Weights: ${parts}${c.reset}`);
	}

	/**
	 * Format duration in human-readable form.
	 */
	private formatDuration(ms: number): string {
		if (ms < 1000) return `${Math.round(ms)}ms`;
		return `${(ms / 1000).toFixed(1)}s`;
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
	 * Apply colors if enabled.
	 */
	private color(str: string): string {
		if (!this.useColors) {
			return str.replace(/\x1b\[[0-9;]*m/g, "");
		}
		return str;
	}
}
