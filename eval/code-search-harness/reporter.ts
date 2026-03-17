/**
 * Code Search Harness — Results Reporter
 *
 * Generates comparison reports from ablation condition result files.
 * Loads all condition_*.json files from the results directory,
 * computes Wilcoxon signed-rank tests vs baseline, and outputs
 * both JSON and markdown formats.
 *
 * Usage:
 *   bun eval/code-search-harness/reporter.ts \
 *     --results eval/code-search-harness/results \
 *     --output eval/code-search-harness/report.md
 *
 * Or as a module:
 *   import { generateReport, loadConditionResults } from "./reporter.js";
 */

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { wilcoxonSignedRankTest } from "../../src/benchmark-v2/scorers/statistics.js";
import type { ConditionResult, PerQueryResult } from "./ablation.js";

// ============================================================================
// Types
// ============================================================================

/** Statistical comparison of one condition vs the baseline */
export interface DeltaAnalysis {
	/** Short name of the condition being compared (e.g. "B1") */
	condition: string;
	/** Short name of the baseline condition (e.g. "A") */
	baselineCondition: string;
	/** Metric being compared (e.g. "mrr_at_10") */
	metric: string;
	/** Baseline mean value */
	baselineValue: number;
	/** Condition mean value */
	conditionValue: number;
	/** conditionValue - baselineValue */
	delta: number;
	/** Two-tailed Wilcoxon p-value */
	wilcoxonP: number;
	/** Effect size r = Z / sqrt(N) */
	effectSizeR: number;
	/** True when p < 0.05 AND |r| > 0.1 */
	significant: boolean;
}

/** Machine-readable comparison report */
export interface ComparisonReport {
	generatedAt: string;
	baselineCondition: string;
	nQueries: number;
	comparison: {
		conditions: string[];
		metrics: {
			mrr_at_10: Record<string, number>;
			ndcg_at_10: Record<string, number>;
			ndcg_at_5: Record<string, number>;
			recall_at_1: Record<string, number>;
			recall_at_5: Record<string, number>;
			recall_at_10: Record<string, number>;
			recall_at_100: Record<string, number>;
		};
		latency_p50_ms: Record<string, number>;
		latency_p95_ms: Record<string, number>;
		deltas_vs_baseline: Record<
			string,
			{
				mrr_at_10: number;
				ndcg_at_10: number;
				p_value: number;
				effect_size: number;
				significant: boolean;
			}
		>;
	};
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Format a number as a fixed-decimal string.
 */
function fmt(value: number, decimals = 3): string {
	return value.toFixed(decimals);
}

/**
 * Pad a string to a minimum width with trailing spaces.
 */
function pad(s: string, width: number): string {
	return s.length >= width ? s : s + " ".repeat(width - s.length);
}

/**
 * Look up a condition result by name.
 */
function findCondition(
	results: ConditionResult[],
	name: string,
): ConditionResult | undefined {
	return results.find((r) => r.condition.name === name);
}

/**
 * Extract the per-query reciprocal rank values for a condition.
 */
function extractRRValues(result: ConditionResult): number[] {
	return result.perQueryResults.map((r: PerQueryResult) => r.reciprocalRank);
}

// ============================================================================
// loadConditionResults
// ============================================================================

/**
 * Load all condition_*.json files from a results directory.
 *
 * @param resultsDir - Directory containing condition result JSON files
 */
export async function loadConditionResults(
	resultsDir: string,
): Promise<ConditionResult[]> {
	const entries = await readdir(resultsDir);
	const conditionFiles = entries
		.filter((f) => f.startsWith("condition_") && f.endsWith(".json"))
		.sort(); // alphabetical order → A, B1, B2, C1, ...

	const results: ConditionResult[] = [];
	for (const file of conditionFiles) {
		const raw = await readFile(`${resultsDir}/${file}`, "utf8");
		results.push(JSON.parse(raw) as ConditionResult);
	}

	return results;
}

// ============================================================================
// generateDeltaAnalysis
// ============================================================================

/**
 * Generate statistical delta analysis for all conditions vs the baseline.
 *
 * Uses the Wilcoxon signed-rank test (non-parametric, paired) on per-query
 * reciprocal rank values.  Effect size r = Z / sqrt(N).
 *
 * Significance threshold: p < 0.05 AND |r| > 0.1.
 *
 * @param results - All condition results
 * @param baselineCondition - Name of the baseline to compare against
 */
export function generateDeltaAnalysis(
	results: ConditionResult[],
	baselineCondition: string,
): DeltaAnalysis[] {
	const baseline = findCondition(results, baselineCondition);
	if (!baseline) return [];

	const analyses: DeltaAnalysis[] = [];

	for (const result of results) {
		if (result.condition.name === baselineCondition) continue;

		// Align per-query results by queryId
		const baselineById = new Map(
			baseline.perQueryResults.map((r) => [r.queryId, r]),
		);
		const paired: Array<{ baseline: number; condition: number }> = [];

		for (const pqr of result.perQueryResults) {
			const bpqr = baselineById.get(pqr.queryId);
			if (bpqr) {
				paired.push({
					baseline: bpqr.reciprocalRank,
					condition: pqr.reciprocalRank,
				});
			}
		}

		const condRR = paired.map((p) => p.condition);
		const bRR = paired.map((p) => p.baseline);

		const { pValue, effectSize } = wilcoxonSignedRankTest(condRR, bRR);

		const baselineValue =
			bRR.length > 0 ? bRR.reduce((a, b) => a + b, 0) / bRR.length : 0;
		const conditionValue =
			condRR.length > 0 ? condRR.reduce((a, b) => a + b, 0) / condRR.length : 0;

		analyses.push({
			condition: result.condition.name,
			baselineCondition,
			metric: "mrr_at_10",
			baselineValue,
			conditionValue,
			delta: conditionValue - baselineValue,
			wilcoxonP: pValue,
			effectSizeR: effectSize,
			significant: pValue < 0.05 && Math.abs(effectSize) > 0.1,
		});
	}

	// Reference baseline RR for jsdoc context
	void extractRRValues(baseline);

	return analyses;
}

// ============================================================================
// generateComparisonTable (markdown)
// ============================================================================

/**
 * Generate a markdown comparison table of all conditions × key metrics.
 *
 * @param results - Array of condition results
 * @param baselineCondition - Name of the baseline condition (best values bolded)
 */
export function generateComparisonTable(
	results: ConditionResult[],
	baselineCondition = "A",
): string {
	if (results.length === 0) return "_No results._\n";

	// Column widths
	const COL = {
		cond: 9,
		desc: 35,
		mrr: 8,
		ndcg10: 9,
		ndcg5: 7,
		recall: 12,
		latency: 13,
	};

	const header = `| ${pad("Condition", COL.cond)} | ${pad("Description", COL.desc)} | ${pad("MRR@10", COL.mrr)} | ${pad("NDCG@10", COL.ndcg10)} | ${pad("NDCG@5", COL.ndcg5)} | ${pad("Recall@100", COL.recall)} | ${pad("P95 Latency", COL.latency)} |`;
	const separator = `|${"-".repeat(COL.cond + 2)}|${"-".repeat(COL.desc + 2)}|${"-".repeat(COL.mrr + 2)}|${"-".repeat(COL.ndcg10 + 2)}|${"-".repeat(COL.ndcg5 + 2)}|${"-".repeat(COL.recall + 2)}|${"-".repeat(COL.latency + 2)}|`;

	// Find best values per metric (excluding baseline for bolding)
	const nonBaseline = results.filter(
		(r) => r.condition.name !== baselineCondition,
	);
	const bestMrr =
		nonBaseline.length > 0
			? Math.max(...nonBaseline.map((r) => r.metrics.mrrAt10))
			: Number.NEGATIVE_INFINITY;
	const bestNdcg10 =
		nonBaseline.length > 0
			? Math.max(...nonBaseline.map((r) => r.metrics.ndcgAt10))
			: Number.NEGATIVE_INFINITY;
	const bestNdcg5 =
		nonBaseline.length > 0
			? Math.max(...nonBaseline.map((r) => r.metrics.ndcgAt5))
			: Number.NEGATIVE_INFINITY;
	const bestRecall =
		nonBaseline.length > 0
			? Math.max(...nonBaseline.map((r) => r.metrics.recallAt100))
			: Number.NEGATIVE_INFINITY;

	const rows = results.map((r) => {
		const isBaseline = r.condition.name === baselineCondition;
		const mrrStr = fmt(r.metrics.mrrAt10);
		const ndcg10Str = fmt(r.metrics.ndcgAt10);
		const ndcg5Str = fmt(r.metrics.ndcgAt5);
		const recallStr = fmt(r.metrics.recallAt100);
		const latencyStr = `${Math.round(r.latency.p95)}ms`;

		return (
			`| ${pad(r.condition.name, COL.cond)} ` +
			`| ${pad(r.condition.description, COL.desc)} ` +
			`| ${pad(!isBaseline && r.metrics.mrrAt10 === bestMrr ? `**${mrrStr}**` : mrrStr, COL.mrr)} ` +
			`| ${pad(!isBaseline && r.metrics.ndcgAt10 === bestNdcg10 ? `**${ndcg10Str}**` : ndcg10Str, COL.ndcg10)} ` +
			`| ${pad(!isBaseline && r.metrics.ndcgAt5 === bestNdcg5 ? `**${ndcg5Str}**` : ndcg5Str, COL.ndcg5)} ` +
			`| ${pad(!isBaseline && r.metrics.recallAt100 === bestRecall ? `**${recallStr}**` : recallStr, COL.recall)} ` +
			`| ${pad(latencyStr, COL.latency)} |`
		);
	});

	return `${[header, separator, ...rows].join("\n")}\n`;
}

// ============================================================================
// buildComparisonReport (JSON)
// ============================================================================

/**
 * Build a machine-readable ComparisonReport from ablation results.
 *
 * Output structure example:
 * ```json
 * {
 *   "comparison": {
 *     "conditions": ["A", "B1", "C1", "E"],
 *     "metrics": {
 *       "mrr_at_10": {"A": 0.47, "B1": 0.52, "C1": 0.54, "E": 0.61},
 *       "ndcg_at_10": {"A": 0.55, "B1": 0.58, "C1": 0.61, "E": 0.68}
 *     },
 *     "deltas_vs_baseline": {
 *       "B1": {"mrr_at_10": 0.05, "p_value": 0.03, "effect_size": 0.15}
 *     }
 *   }
 * }
 * ```
 */
export function buildComparisonReport(
	results: ConditionResult[],
	baselineCondition = "A",
): ComparisonReport {
	const conditions = results.map((r) => r.condition.name);
	const deltaAnalyses = generateDeltaAnalysis(results, baselineCondition);
	const deltaByCondition = new Map(deltaAnalyses.map((d) => [d.condition, d]));

	const metricValues = <K extends keyof ConditionResult["metrics"]>(
		key: K,
	): Record<string, number> =>
		Object.fromEntries(
			results.map((r) => [r.condition.name, r.metrics[key] as number]),
		);

	const deltasVsBaseline: ComparisonReport["comparison"]["deltas_vs_baseline"] =
		{};
	for (const cond of conditions) {
		if (cond === baselineCondition) continue;
		const d = deltaByCondition.get(cond);
		if (d) {
			deltasVsBaseline[cond] = {
				mrr_at_10: d.delta,
				ndcg_at_10:
					(findCondition(results, cond)?.metrics.ndcgAt10 ?? 0) -
					(findCondition(results, baselineCondition)?.metrics.ndcgAt10 ?? 0),
				p_value: d.wilcoxonP,
				effect_size: d.effectSizeR,
				significant: d.significant,
			};
		}
	}

	return {
		generatedAt: new Date().toISOString(),
		baselineCondition,
		nQueries: results[0]?.nQueries ?? 0,
		comparison: {
			conditions,
			metrics: {
				mrr_at_10: metricValues("mrrAt10"),
				ndcg_at_10: metricValues("ndcgAt10"),
				ndcg_at_5: metricValues("ndcgAt5"),
				recall_at_1: metricValues("recallAt1"),
				recall_at_5: metricValues("recallAt5"),
				recall_at_10: metricValues("recallAt10"),
				recall_at_100: metricValues("recallAt100"),
			},
			latency_p50_ms: Object.fromEntries(
				results.map((r) => [r.condition.name, r.latency.p50]),
			),
			latency_p95_ms: Object.fromEntries(
				results.map((r) => [r.condition.name, r.latency.p95]),
			),
			deltas_vs_baseline: deltasVsBaseline,
		},
	};
}

// ============================================================================
// generateReport
// ============================================================================

/**
 * Generate a full markdown ablation report and write it to outputPath.
 *
 * Also writes a companion JSON report at the same path with .json extension.
 *
 * The report includes:
 * 1. Summary table (all conditions × metrics)
 * 2. Delta analysis with Wilcoxon p-values
 * 3. Latency breakdown (P50/P95 per condition)
 * 4. Key findings (auto-generated from the data)
 *
 * @param results - All condition results
 * @param outputPath - Path to write the markdown report
 */
export async function generateReport(
	results: ConditionResult[],
	outputPath: string,
	baselineOverride?: string,
): Promise<void> {
	await mkdir(dirname(outputPath), { recursive: true });

	if (results.length === 0) {
		await writeFile(
			outputPath,
			"# Code Search Ablation Report\n\n_No results._\n",
			"utf8",
		);
		return;
	}

	// Determine baseline (CLI override > condition "A" > first)
	const baselineCondition =
		baselineOverride ??
		results.find((r) => r.condition.name === "A")?.condition.name ??
		results[0].condition.name;

	const baseline = findCondition(results, baselineCondition);
	const deltaAnalyses = generateDeltaAnalysis(results, baselineCondition);
	const jsonReport = buildComparisonReport(results, baselineCondition);

	// Write JSON report
	const jsonPath = outputPath.replace(/\.md$/, ".json");
	await writeFile(jsonPath, JSON.stringify(jsonReport, null, 2), "utf8");

	const date = new Date().toISOString().split("T")[0];
	const nQueries = results[0]?.nQueries ?? 0;

	const sections: string[] = [];
	sections.push("# Code Search Ablation Report\n");
	sections.push(`**Date**: ${date}  `);
	sections.push(`**Queries**: ${nQueries}  `);
	sections.push(
		`**Conditions**: ${results.map((r) => r.condition.name).join(", ")}  `,
	);
	sections.push(`**Baseline**: Condition ${baselineCondition}\n`);

	// Comparison table
	sections.push("## Results Summary\n");
	sections.push(generateComparisonTable(results, baselineCondition));

	// Delta analysis
	sections.push(`## Delta vs Baseline (Condition ${baselineCondition})\n`);

	if (deltaAnalyses.length === 0) {
		sections.push("_Only one condition — no delta analysis available._\n");
	} else {
		const deltaHeader =
			"| Condition | Description | MRR@10 | Delta | p-value | Effect r | Sig? |";
		const deltaSep =
			"|-----------|-------------|--------|-------|---------|----------|------|";
		const deltaRows = deltaAnalyses.map((d) => {
			const cond = findCondition(results, d.condition);
			const desc = cond?.condition.description ?? "";
			const sigMark = d.significant ? "**YES**" : "no";
			const deltaStr = (d.delta >= 0 ? "+" : "") + fmt(d.delta);
			return `| ${d.condition} | ${desc} | ${fmt(d.conditionValue)} | ${deltaStr} | ${fmt(d.wilcoxonP, 4)} | ${fmt(d.effectSizeR, 3)} | ${sigMark} |`;
		});
		sections.push(`${[deltaHeader, deltaSep, ...deltaRows].join("\n")}\n`);
	}

	// Latency breakdown
	sections.push("## Latency Breakdown (P50 / P95)\n");
	const latencyHeader =
		"| Condition | Description | P50 (ms) | P95 (ms) | Mean (ms) |";
	const latencySep =
		"|-----------|-------------|----------|----------|-----------|";
	const latencyRows = results.map((r) => {
		return `| ${r.condition.name} | ${r.condition.description} | ${Math.round(r.latency.p50)} | ${Math.round(r.latency.p95)} | ${Math.round(r.latency.mean)} |`;
	});
	sections.push(`${[latencyHeader, latencySep, ...latencyRows].join("\n")}\n`);

	// Key findings
	sections.push("## Key Findings\n");
	if (baseline && deltaAnalyses.length > 0) {
		const significant = deltaAnalyses.filter((d) => d.significant);
		const bestDelta = deltaAnalyses.reduce((best, d) =>
			d.delta > best.delta ? d : best,
		);

		if (significant.length > 0) {
			sections.push(
				`- ${significant.length} condition(s) show statistically significant improvement over baseline (p < 0.05, |r| > 0.1).`,
			);
		} else {
			sections.push(
				"- No condition shows statistically significant improvement over baseline.",
			);
		}
		sections.push(
			`- Best delta: Condition **${bestDelta.condition}** (+${fmt(bestDelta.delta)} MRR@10).`,
		);
		sections.push(
			`- Baseline MRR@10: ${fmt(baseline.metrics.mrrAt10)} (Condition ${baselineCondition}).`,
		);

		const baselineMrr = baseline.metrics.mrrAt10;
		if (baselineMrr > 0.7) {
			sections.push(
				"\n> WARNING: Baseline MRR@10 > 0.7 — dataset may be too easy.",
			);
		} else if (baselineMrr < 0.3 && nQueries > 0) {
			sections.push(
				"\n> WARNING: Baseline MRR@10 < 0.3 — check index / retrieval setup.",
			);
		}
	} else {
		sections.push("_Insufficient data for key findings._");
	}

	sections.push("\n---\n");
	sections.push("_Generated by eval/code-search-harness/reporter.ts_\n");

	await writeFile(outputPath, sections.join("\n"), "utf8");
}

// ============================================================================
// CLI entry point
// ============================================================================

/**
 * CLI usage:
 *   bun eval/code-search-harness/reporter.ts \
 *     --results eval/code-search-harness/results \
 *     --output eval/code-search-harness/report.md
 *
 * Options:
 *   --results  Directory containing condition_*.json files
 *   --output   Output path for the markdown report (default: <results>/report.md)
 *   --baseline Baseline condition name (default: A)
 *   --help     Show this help message
 */
if (import.meta.main) {
	const { values: args } = parseArgs({
		args: process.argv.slice(2),
		options: {
			results: {
				type: "string",
				default: "eval/code-search-harness/results",
			},
			output: { type: "string" },
			baseline: { type: "string", default: "A" },
			help: { type: "boolean", default: false },
		},
	});

	if (args.help) {
		console.log(`Usage: bun eval/code-search-harness/reporter.ts [options]

Options:
  --results   Directory with condition_*.json files
              (default: eval/code-search-harness/results)
  --output    Output path for the markdown report
              (default: <results>/report.md)
  --baseline  Baseline condition name (default: A)
  --help      Show this help message
`);
		process.exit(0);
	}

	const resultsDir = args.results as string;
	const outputPath =
		(args.output as string | undefined) ?? `${resultsDir}/report.md`;
	const baselineName = (args.baseline as string) ?? "A";

	console.log(`Loading results from: ${resultsDir}`);
	let results: ConditionResult[];
	try {
		results = await loadConditionResults(resultsDir);
	} catch (err) {
		console.error(`Failed to load results: ${err}`);
		process.exit(1);
	}

	if (results.length === 0) {
		console.warn("No condition result files found.");
		process.exit(0);
	}

	console.log(
		`Loaded ${results.length} condition(s): ${results.map((r) => r.condition.name).join(", ")}`,
	);
	await generateReport(results, outputPath, baselineName);

	console.log(`Markdown report written to: ${outputPath}`);
	console.log(
		`JSON report written to:     ${outputPath.replace(/\.md$/, ".json")}`,
	);
}
