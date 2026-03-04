#!/usr/bin/env bun
/**
 * Query Expansion Benchmark Report Generator
 *
 * Reads results from experiments/query-expansion/results/{base,finetuned}/*.json
 * and generates a comparison table.
 *
 * Usage:
 *   bun run experiments/query-expansion/bench/report.ts [options]
 *
 * Options:
 *   --format <md|csv|json>   Output format (default: md)
 *   --sort <field>           Sort by: total, format, keyword, semantic, hyde, speed, params
 *   --output <file>          Write to file instead of stdout
 *   --by-category            Show breakdown by query category
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";

// ============================================================================
// Types
// ============================================================================

interface ResultFile {
	model: {
		name: string;
		lmsKey: string;
		family: string;
		paramsB: number;
	};
	timestamp: string;
	summary: {
		format: number;
		keyword: number;
		semantic: number;
		hyde: number;
		latencyMs: number;
		total: number;
	};
	queryCount: number;
	successCount: number;
	failCount: number;
	scores: Array<{
		queryId: string;
		query: string;
		modelName: string;
		format: number;
		keyword: number;
		semantic: number;
		hyde: number;
		latencyMs: number;
		total: number;
	}>;
}

interface ReportRow {
	name: string;
	family: string;
	paramsB: number;
	format: number;
	keyword: number;
	semantic: number;
	hyde: number;
	latencyMs: number;
	total: number;
	successRate: number;
}

// ============================================================================
// CLI
// ============================================================================

const BENCH_DIR = dirname(new URL(import.meta.url).pathname);
const RESULTS_DIR = join(BENCH_DIR, "..", "results");

function parseArgs(): {
	format: "md" | "csv" | "json";
	sort: string;
	output: string | null;
	byCategory: boolean;
} {
	const args = process.argv.slice(2);
	let format: "md" | "csv" | "json" = "md";
	let sort = "total";
	let output: string | null = null;
	let byCategory = false;

	for (let i = 0; i < args.length; i++) {
		switch (args[i]) {
			case "--format":
				format = args[++i] as "md" | "csv" | "json";
				break;
			case "--sort":
				sort = args[++i];
				break;
			case "--output":
				output = args[++i];
				break;
			case "--by-category":
				byCategory = true;
				break;
		}
	}

	return { format, sort, output, byCategory };
}

// ============================================================================
// Data Loading
// ============================================================================

function loadResults(): ResultFile[] {
	if (!existsSync(RESULTS_DIR)) {
		console.error(`No results directory found: ${RESULTS_DIR}`);
		console.error("Run the benchmark first: bun run experiments/query-expansion/bench/run.ts");
		process.exit(1);
	}

	const results: ResultFile[] = [];
	const subdirs = ["base", "finetuned"];

	for (const subdir of subdirs) {
		const dir = join(RESULTS_DIR, subdir);
		if (!existsSync(dir)) continue;
		const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
		for (const f of files) {
			const content = readFileSync(join(dir, f), "utf-8");
			results.push(JSON.parse(content) as ResultFile);
		}
	}

	if (results.length === 0) {
		console.error("No result files found. Run the benchmark first.");
		process.exit(1);
	}

	return results;
}

function buildRows(results: ResultFile[], sort: string): ReportRow[] {
	const rows: ReportRow[] = results.map((r) => ({
		name: r.model.name,
		family: r.model.family,
		paramsB: r.model.paramsB,
		format: r.summary.format,
		keyword: r.summary.keyword,
		semantic: r.summary.semantic,
		hyde: r.summary.hyde,
		latencyMs: r.summary.latencyMs,
		total: r.summary.total,
		successRate: r.queryCount > 0 ? r.successCount / r.queryCount : 0,
	}));

	// Sort
	const sortFn = (a: ReportRow, b: ReportRow): number => {
		switch (sort) {
			case "params":
				return a.paramsB - b.paramsB;
			case "speed":
				return a.latencyMs - b.latencyMs;
			case "format":
				return b.format - a.format;
			case "keyword":
				return b.keyword - a.keyword;
			case "semantic":
				return b.semantic - a.semantic;
			case "hyde":
				return b.hyde - a.hyde;
			case "total":
			default:
				return b.total - a.total;
		}
	};

	return rows.sort(sortFn);
}

// ============================================================================
// Formatters
// ============================================================================

function formatMarkdown(rows: ReportRow[]): string {
	const lines: string[] = [];

	lines.push("# Query Expansion Model Benchmark Results");
	lines.push("");
	lines.push(`_Generated: ${new Date().toISOString()}_`);
	lines.push("");

	// Main comparison table
	lines.push("## Overall Comparison");
	lines.push("");
	lines.push(
		"| Rank | Model | Params | Format | Lex | Vec | HyDE | Speed | Total |",
	);
	lines.push(
		"|------|-------|--------|--------|-----|-----|------|-------|-------|",
	);

	rows.forEach((row, i) => {
		const rank = i + 1;
		const medal = rank === 1 ? " **" : rank === 2 ? " *" : "";
		const medalEnd = rank === 1 ? "**" : rank === 2 ? "*" : "";
		lines.push(
			`| ${rank} | ${medal}${row.name}${medalEnd} | ${row.paramsB}B | ${row.format.toFixed(2)} | ${row.keyword.toFixed(2)} | ${row.semantic.toFixed(2)} | ${row.hyde.toFixed(2)} | ${row.latencyMs.toFixed(0)}ms | ${row.total.toFixed(3)} |`,
		);
	});

	lines.push("");

	// Family comparison
	const families = new Map<string, ReportRow[]>();
	for (const row of rows) {
		if (!families.has(row.family)) families.set(row.family, []);
		families.get(row.family)!.push(row);
	}

	if (families.size > 1) {
		lines.push("## Family Comparison");
		lines.push("");

		for (const [family, familyRows] of families) {
			const avgTotal =
				familyRows.reduce((s, r) => s + r.total, 0) / familyRows.length;
			const avgLatency =
				familyRows.reduce((s, r) => s + r.latencyMs, 0) / familyRows.length;
			const best = familyRows.reduce((a, b) => (a.total > b.total ? a : b));

			lines.push(`### ${family.toUpperCase()}`);
			lines.push(`- Best model: **${best.name}** (${best.total.toFixed(3)})`);
			lines.push(`- Avg total: ${avgTotal.toFixed(3)}`);
			lines.push(`- Avg latency: ${avgLatency.toFixed(0)}ms`);
			lines.push(
				`- Size range: ${familyRows[0].paramsB}B - ${familyRows[familyRows.length - 1].paramsB}B`,
			);
			lines.push("");
		}
	}

	// Score distribution by dimension
	lines.push("## Score Dimensions");
	lines.push("");
	lines.push("### Format Compliance (weight: 0.20)");
	lines.push(
		"_Does the model output valid `lex:`, `vec:`, `hyde:` lines?_",
	);
	lines.push("");
	for (const row of rows) {
		const bar = "█".repeat(Math.round(row.format * 20));
		lines.push(`- ${row.name.padEnd(16)} ${bar} ${row.format.toFixed(2)}`);
	}

	lines.push("");
	lines.push("### Keyword Quality (weight: 0.20)");
	lines.push("_Are lex: terms relevant, diverse, and expanded?_");
	lines.push("");
	for (const row of rows) {
		const bar = "█".repeat(Math.round(row.keyword * 20));
		lines.push(`- ${row.name.padEnd(16)} ${bar} ${row.keyword.toFixed(2)}`);
	}

	lines.push("");
	lines.push("### Semantic Quality (weight: 0.20)");
	lines.push("_Is vec: a good natural language rephrasing?_");
	lines.push("");
	for (const row of rows) {
		const bar = "█".repeat(Math.round(row.semantic * 20));
		lines.push(`- ${row.name.padEnd(16)} ${bar} ${row.semantic.toFixed(2)}`);
	}

	lines.push("");
	lines.push("### HyDE Quality (weight: 0.25)");
	lines.push("_Is hyde: a plausible code snippet?_");
	lines.push("");
	for (const row of rows) {
		const bar = "█".repeat(Math.round(row.hyde * 20));
		lines.push(`- ${row.name.padEnd(16)} ${bar} ${row.hyde.toFixed(2)}`);
	}

	lines.push("");
	lines.push("### Speed (weight: 0.15)");
	lines.push("_Generation latency in milliseconds_");
	lines.push("");
	for (const row of rows) {
		lines.push(`- ${row.name.padEnd(16)} ${row.latencyMs.toFixed(0)}ms`);
	}

	lines.push("");

	// Recommendation
	if (rows.length > 0) {
		lines.push("## Recommendation");
		lines.push("");

		const best = rows[0];
		const bestSmall = rows.filter((r) => r.paramsB <= 2).sort((a, b) => b.total - a.total)[0];
		const fastest = [...rows].sort((a, b) => a.latencyMs - b.latencyMs)[0];

		lines.push(`- **Best overall**: ${best.name} (score: ${best.total.toFixed(3)})`);
		if (bestSmall && bestSmall.name !== best.name) {
			lines.push(
				`- **Best small (≤2B)**: ${bestSmall.name} (score: ${bestSmall.total.toFixed(3)})`,
			);
		}
		if (fastest.name !== best.name) {
			lines.push(
				`- **Fastest**: ${fastest.name} (${fastest.latencyMs.toFixed(0)}ms, score: ${fastest.total.toFixed(3)})`,
			);
		}
	}

	return lines.join("\n");
}

function formatCsv(rows: ReportRow[]): string {
	const header = "rank,model,family,params_b,format,keyword,semantic,hyde,latency_ms,total,success_rate";
	const lines = rows.map(
		(row, i) =>
			`${i + 1},${row.name},${row.family},${row.paramsB},${row.format.toFixed(3)},${row.keyword.toFixed(3)},${row.semantic.toFixed(3)},${row.hyde.toFixed(3)},${row.latencyMs.toFixed(0)},${row.total.toFixed(3)},${row.successRate.toFixed(3)}`,
	);
	return [header, ...lines].join("\n");
}

function formatJson(rows: ReportRow[]): string {
	return JSON.stringify(
		{
			generated: new Date().toISOString(),
			rankings: rows.map((row, i) => ({
				rank: i + 1,
				...row,
			})),
		},
		null,
		2,
	);
}

// ============================================================================
// Category Breakdown
// ============================================================================

function formatCategoryBreakdown(results: ResultFile[]): string {
	const lines: string[] = [];
	lines.push("");
	lines.push("## Score by Query Category");
	lines.push("");

	// Collect categories
	const categories = new Set<string>();
	for (const r of results) {
		for (const s of r.scores) {
			// Extract category from queryId (e.g., "sym-01" → "symbol")
			const prefix = s.queryId.split("-")[0];
			const catMap: Record<string, string> = {
				sym: "symbol",
				err: "error",
				con: "concept",
				fw: "framework",
				rev: "code_review",
			};
			categories.add(catMap[prefix] || prefix);
		}
	}

	for (const cat of categories) {
		lines.push(`### ${cat}`);
		lines.push("");

		const prefixMap: Record<string, string> = {
			symbol: "sym",
			error: "err",
			concept: "con",
			framework: "fw",
			code_review: "rev",
		};
		const prefix = prefixMap[cat] || cat;

		lines.push("| Model | Format | Lex | Vec | HyDE | Total |");
		lines.push("|-------|--------|-----|-----|------|-------|");

		for (const r of results) {
			const catScores = r.scores.filter((s) => s.queryId.startsWith(prefix));
			if (catScores.length === 0) continue;

			const avg = {
				format:
					catScores.reduce((s, x) => s + x.format, 0) / catScores.length,
				keyword:
					catScores.reduce((s, x) => s + x.keyword, 0) / catScores.length,
				semantic:
					catScores.reduce((s, x) => s + x.semantic, 0) / catScores.length,
				hyde:
					catScores.reduce((s, x) => s + x.hyde, 0) / catScores.length,
				total:
					catScores.reduce((s, x) => s + x.total, 0) / catScores.length,
			};

			lines.push(
				`| ${r.model.name} | ${avg.format.toFixed(2)} | ${avg.keyword.toFixed(2)} | ${avg.semantic.toFixed(2)} | ${avg.hyde.toFixed(2)} | ${avg.total.toFixed(3)} |`,
			);
		}

		lines.push("");
	}

	return lines.join("\n");
}

// ============================================================================
// Main
// ============================================================================

function main() {
	const config = parseArgs();
	const results = loadResults();

	console.error(`Loaded ${results.length} result files from ${RESULTS_DIR}`);

	const rows = buildRows(results, config.sort);

	let output: string;
	switch (config.format) {
		case "csv":
			output = formatCsv(rows);
			break;
		case "json":
			output = formatJson(rows);
			break;
		case "md":
		default:
			output = formatMarkdown(rows);
			if (config.byCategory) {
				output += formatCategoryBreakdown(results);
			}
			break;
	}

	if (config.output) {
		writeFileSync(config.output, output);
		console.error(`Report written to: ${config.output}`);
	} else {
		console.log(output);
	}
}

main();
