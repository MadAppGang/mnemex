/**
 * Mnemex Search Steps Evaluation — Results Reporter
 *
 * Formats ablation results into comparison tables, TREC run files,
 * delta analysis with statistical tests, and full markdown reports.
 *
 * Usage:
 *   import { generateReport } from "./reporter.js";
 *   await generateReport(results, "runs/report.md");
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { wilcoxonSignedRankTest } from "../../src/benchmark-v2/scorers/statistics.js";
import type { ConditionResult, PerQueryResult } from "./ablation.js";

// ============================================================================
// DeltaAnalysis
// ============================================================================

/** Statistical comparison of one condition vs the baseline */
export interface DeltaAnalysis {
	/** Short name of the condition being compared (e.g. "B1") */
	condition: string;
	/** Short name of the baseline condition (e.g. "A") */
	baselineCondition: string;
	/** Metric being compared (e.g. "mrrAt10") */
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

// ============================================================================
// Helpers
// ============================================================================

/**
 * Format a number as a fixed-decimal string, padded to a given width.
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
// generateComparisonTable
// ============================================================================

/**
 * Generate a markdown comparison table of all conditions × key metrics.
 *
 * Columns: Condition | Description | MRR@10 | NDCG@10 | NDCG@5 | Recall@100 | P95 Latency
 * When a baselineCondition is provided, the best non-baseline value per column is bolded.
 *
 * @param results - Array of condition results (one per ablation condition)
 * @param baselineCondition - Name of the baseline condition (e.g. "A")
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
	const bestMrr = Math.max(
		...nonBaseline.map((r) => r.metrics.mrrAt10),
		Number.NEGATIVE_INFINITY,
	);
	const bestNdcg10 = Math.max(
		...nonBaseline.map((r) => r.metrics.ndcgAt10),
		Number.NEGATIVE_INFINITY,
	);
	const bestNdcg5 = Math.max(
		...nonBaseline.map((r) => r.metrics.ndcgAt5),
		Number.NEGATIVE_INFINITY,
	);
	const bestRecall = Math.max(
		...nonBaseline.map((r) => r.metrics.recallAt100),
		Number.NEGATIVE_INFINITY,
	);

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

	const baselineRR = extractRRValues(baseline);
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

		// Wilcoxon test on aligned pairs
		const { pValue, effectSize } = wilcoxonSignedRankTest(condRR, bRR);

		const baselineValue =
			bRR.length > 0 ? bRR.reduce((a, b) => a + b, 0) / bRR.length : 0;
		const conditionValue =
			condRR.length > 0 ? condRR.reduce((a, b) => a + b, 0) / condRR.length : 0;

		analyses.push({
			condition: result.condition.name,
			baselineCondition,
			metric: "mrrAt10",
			baselineValue,
			conditionValue,
			delta: conditionValue - baselineValue,
			wilcoxonP: pValue,
			effectSizeR: effectSize,
			significant: pValue < 0.05 && Math.abs(effectSize) > 0.1,
		});
	}

	// Also add baseline RR summary (used internally by generateReport)
	void baselineRR; // referenced for context

	return analyses;
}

// ============================================================================
// writeTrecRunFile
// ============================================================================

/**
 * Write a TREC-format run file for compatibility with ranx / BEIR evaluation.
 *
 * Format per line:
 *   query_id  Q0  doc_id  rank  score  run_name
 *
 * @param result - A single condition's results
 * @param outputPath - Path to write the .trec file
 */
export async function writeTrecRunFile(
	result: ConditionResult,
	outputPath: string,
): Promise<void> {
	const runName = `condition_${result.condition.name.toLowerCase()}`;
	const lines: string[] = [];

	for (const pqr of result.perQueryResults) {
		pqr.retrievedDocs.forEach((docId, idx) => {
			const rank = idx + 1;
			// Score decreases linearly from 1.0 (rank 1) to 0.0 (rank N)
			const score = 1 - idx / Math.max(pqr.retrievedDocs.length, 1);
			lines.push(
				`${pqr.queryId}\tQ0\t${docId}\t${rank}\t${score.toFixed(6)}\t${runName}`,
			);
		});
	}

	await mkdir(dirname(outputPath), { recursive: true });
	await writeFile(outputPath, `${lines.join("\n")}\n`, "utf8");
}

// ============================================================================
// generateReport
// ============================================================================

/**
 * Generate a full markdown ablation report and write it to outputPath.
 *
 * The report includes:
 * 1. Summary table (all conditions × metrics)
 * 2. Delta analysis with Wilcoxon p-values
 * 3. Latency breakdown
 * 4. Key findings (auto-generated from the data)
 *
 * @param results - All condition results
 * @param outputPath - Path to write the markdown report
 */
export async function generateReport(
	results: ConditionResult[],
	outputPath: string,
): Promise<void> {
	if (results.length === 0) {
		await mkdir(dirname(outputPath), { recursive: true });
		await writeFile(outputPath, "# Ablation Report\n\n_No results._\n", "utf8");
		return;
	}

	// Determine baseline (first result or "A")
	const baselineCondition =
		results.find((r) => r.condition.name === "A")?.condition.name ??
		results[0].condition.name;

	const baseline = findCondition(results, baselineCondition);
	const deltaAnalyses = generateDeltaAnalysis(results, baselineCondition);

	const date = new Date().toISOString().split("T")[0];
	const nQueries = results[0]?.nQueries ?? 0;

	// --- Header ---
	const sections: string[] = [];
	sections.push("# Code Search Ablation Report\n");
	sections.push(`**Date**: ${date}  `);
	sections.push(`**Queries**: ${nQueries}  `);
	sections.push(
		`**Conditions**: ${results.map((r) => r.condition.name).join(", ")}  `,
	);
	sections.push(`**Baseline**: Condition ${baselineCondition}\n`);

	// --- Comparison table ---
	sections.push("## Results Summary\n");
	sections.push(generateComparisonTable(results, baselineCondition));

	// --- Delta analysis ---
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

	// --- Latency breakdown ---
	sections.push("## Latency Breakdown\n");
	const latencyHeader =
		"| Condition | Description | P50 (ms) | P95 (ms) | Mean (ms) |";
	const latencySep =
		"|-----------|-------------|----------|----------|-----------|";
	const latencyRows = results.map((r) => {
		return `| ${r.condition.name} | ${r.condition.description} | ${Math.round(r.latency.p50)} | ${Math.round(r.latency.p95)} | ${Math.round(r.latency.mean)} |`;
	});
	sections.push(`${[latencyHeader, latencySep, ...latencyRows].join("\n")}\n`);

	// --- Key findings ---
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

		// Validation note
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
	sections.push(
		"_Generated by eval/mnemex-search-steps-evaluation/reporter.ts_\n",
	);

	await mkdir(dirname(outputPath), { recursive: true });
	await writeFile(outputPath, sections.join("\n"), "utf8");
}
