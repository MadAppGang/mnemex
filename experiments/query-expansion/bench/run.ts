#!/usr/bin/env bun
/**
 * Query Expansion Benchmark Runner
 *
 * For each model in the registry:
 *   1. Load model in LM Studio (lms load)
 *   2. Run all 50 queries via OpenAI-compatible API
 *   3. Score outputs
 *   4. Unload model (lms unload)
 *   5. Save results to experiments/query-expansion/results/base/<model>.json
 *
 * Usage:
 *   bun run experiments/query-expansion/bench/run.ts [options]
 *
 * Options:
 *   --model <name>     Run a single model only (partial match)
 *   --family <name>    Run all models in a family (qwen3.5 | lfm2)
 *   --dry-run          Parse queries and show plan without running
 *   --skip-load        Skip lms load/unload (model already loaded)
 *   --port <n>         LM Studio port (default: 1234)
 *   --timeout <ms>     Per-query timeout (default: 60000)
 *   --retries <n>      Retries per query (default: 2)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { execSync } from "child_process";
import { BENCH_MODELS, findModel, getFamily, type BenchModel } from "./models.js";
import {
	scoreExpansion,
	aggregateModelScores,
	type QueryScore,
	type ModelScores,
} from "./scorer.js";

// ============================================================================
// Types
// ============================================================================

interface Query {
	id: string;
	category: string;
	query: string;
	description: string;
}

interface QuerySet {
	version: string;
	description: string;
	queries: Query[];
}

interface RunConfig {
	models: BenchModel[];
	dryRun: boolean;
	skipLoad: boolean;
	port: number;
	timeout: number;
	retries: number;
}

interface RawResult {
	queryId: string;
	query: string;
	output: string;
	latencyMs: number;
	tokenCount?: number;
	error?: string;
}

// ============================================================================
// Constants
// ============================================================================

const BENCH_DIR = dirname(new URL(import.meta.url).pathname);
const RESULTS_DIR = join(BENCH_DIR, "..", "results", "base");
const QUERIES_PATH = join(BENCH_DIR, "queries.json");

const SYSTEM_PROMPT = `You are a code search query expansion engine. Given a search query, expand it into three types:
- lex: keyword variants for BM25 search (technical terms, synonyms, related identifiers)
- vec: a natural language rephrasing for semantic vector search
- hyde: a short hypothetical code snippet that would match this query

Respond with exactly 3 lines, no other text:
lex: ...
vec: ...
hyde: ...`;

const MODEL_LOAD_WAIT_MS = 5000;
const MODEL_LOAD_SETTLE_MS = 2000;

// ============================================================================
// CLI Parsing
// ============================================================================

function parseArgs(): RunConfig {
	const args = process.argv.slice(2);
	let models = [...BENCH_MODELS];
	let dryRun = false;
	let skipLoad = false;
	let port = 1234;
	let timeout = 60000;
	let retries = 2;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		switch (arg) {
			case "--model": {
				const name = args[++i];
				const model = findModel(name);
				if (!model) {
					console.error(`Model not found: ${name}`);
					console.error(
						`Available: ${BENCH_MODELS.map((m) => m.name).join(", ")}`,
					);
					process.exit(1);
				}
				models = [model];
				break;
			}
			case "--family": {
				const family = args[++i] as BenchModel["family"];
				const familyModels = getFamily(family);
				if (familyModels.length === 0) {
					console.error(`Unknown family: ${family}. Use qwen3.5 or lfm2`);
					process.exit(1);
				}
				models = familyModels;
				break;
			}
			case "--dry-run":
				dryRun = true;
				break;
			case "--skip-load":
				skipLoad = true;
				break;
			case "--port":
				port = parseInt(args[++i], 10);
				break;
			case "--timeout":
				timeout = parseInt(args[++i], 10);
				break;
			case "--retries":
				retries = parseInt(args[++i], 10);
				break;
			default:
				console.error(`Unknown option: ${arg}`);
				process.exit(1);
		}
	}

	return { models, dryRun, skipLoad, port, timeout, retries };
}

// ============================================================================
// LM Studio Model Management
// ============================================================================

function loadModel(model: BenchModel): void {
	console.log(`  Loading ${model.name} (${model.lmsKey})...`);
	try {
		execSync(`lms load "${model.lmsKey}" --yes`, {
			stdio: "pipe",
			timeout: 120000,
		});
		// Wait for model to settle in memory
		console.log(`  Waiting ${MODEL_LOAD_WAIT_MS}ms for model to settle...`);
		execSync(`sleep ${MODEL_LOAD_WAIT_MS / 1000}`);
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to load model ${model.lmsKey}: ${msg}`);
	}
}

function unloadModel(): void {
	try {
		execSync("lms unload --all", { stdio: "pipe", timeout: 30000 });
		// Brief pause between models
		execSync(`sleep ${MODEL_LOAD_SETTLE_MS / 1000}`);
	} catch {
		// Ignore unload errors
	}
}

function getLoadedModel(): string | null {
	try {
		const output = execSync("lms ps", { encoding: "utf-8", timeout: 10000 });
		// Parse the ps output to find loaded model
		const lines = output.split("\n").filter((l) => l.trim() && !l.includes("IDENTIFIER"));
		if (lines.length > 0) {
			// First non-header line contains the model
			const match = lines[0].trim().split(/\s+/);
			return match[0] || null;
		}
	} catch {
		// Ignore
	}
	return null;
}

// ============================================================================
// API Interaction
// ============================================================================

async function queryModel(
	query: string,
	modelKey: string,
	port: number,
	timeout: number,
	retries: number,
): Promise<{ output: string; latencyMs: number; tokenCount?: number }> {
	const url = `http://localhost:${port}/v1/chat/completions`;

	for (let attempt = 0; attempt <= retries; attempt++) {
		const start = performance.now();

		try {
			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), timeout);

			const response = await fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: modelKey,
					messages: [
						{ role: "system", content: SYSTEM_PROMPT },
						{ role: "user", content: `Query: ${query}` },
					],
					temperature: 0.3,
					max_tokens: 300,
					stream: false,
				}),
				signal: controller.signal,
			});

			clearTimeout(timeoutId);
			const latencyMs = Math.round(performance.now() - start);

			if (!response.ok) {
				const body = await response.text();
				throw new Error(`API error ${response.status}: ${body}`);
			}

			const data = await response.json();
			const output = data.choices?.[0]?.message?.content || "";
			const tokenCount = data.usage?.completion_tokens;

			return { output, latencyMs, tokenCount };
		} catch (error) {
			const latencyMs = Math.round(performance.now() - start);
			const msg = error instanceof Error ? error.message : String(error);

			if (attempt < retries) {
				console.log(
					`    Retry ${attempt + 1}/${retries} after error: ${msg.slice(0, 80)}`,
				);
				await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
				continue;
			}

			throw new Error(`Query failed after ${retries + 1} attempts: ${msg}`);
		}
	}

	throw new Error("Unreachable");
}

// ============================================================================
// Benchmark Execution
// ============================================================================

async function benchmarkModel(
	model: BenchModel,
	queries: Query[],
	config: RunConfig,
): Promise<ModelScores> {
	console.log(`\n${"=".repeat(60)}`);
	console.log(`Benchmarking: ${model.name} (${model.paramsB}B, ${model.family})`);
	console.log(`${"=".repeat(60)}`);

	// Load model — always unload first to avoid "multiple models" error
	if (!config.skipLoad) {
		unloadModel();
		loadModel(model);
	} else {
		// Even with --skip-load, unload others to avoid ambiguity
		console.log(`  --skip-load: ensuring only target model is loaded...`);
		try {
			execSync("lms unload --all", { stdio: "pipe", timeout: 30000 });
			execSync(`sleep 1`);
			execSync(`lms load "${model.lmsKey}" --yes`, { stdio: "pipe", timeout: 120000 });
			execSync(`sleep ${MODEL_LOAD_WAIT_MS / 1000}`);
		} catch {
			console.log(`  Warning: could not reload model, continuing anyway`);
		}
	}

	// Run all queries
	const scores: QueryScore[] = [];
	const rawResults: RawResult[] = [];
	let successCount = 0;
	let failCount = 0;

	for (let i = 0; i < queries.length; i++) {
		const q = queries[i];
		const progress = `[${i + 1}/${queries.length}]`;

		try {
			const { output, latencyMs, tokenCount } = await queryModel(
				q.query,
				model.lmsKey,
				config.port,
				config.timeout,
				config.retries,
			);

			const score = scoreExpansion(q.id, q.query, model.name, output, latencyMs);
			scores.push(score);
			rawResults.push({
				queryId: q.id,
				query: q.query,
				output,
				latencyMs,
				tokenCount,
			});

			successCount++;
			const fmt = score.format.toFixed(2);
			const tot = score.total.toFixed(2);
			console.log(
				`  ${progress} "${q.query.slice(0, 40)}..." → fmt=${fmt} total=${tot} ${latencyMs}ms`,
			);
		} catch (error) {
			failCount++;
			const msg = error instanceof Error ? error.message : String(error);
			console.log(`  ${progress} "${q.query.slice(0, 40)}..." → FAILED: ${msg.slice(0, 60)}`);
			rawResults.push({
				queryId: q.id,
				query: q.query,
				output: "",
				latencyMs: 0,
				error: msg,
			});
		}
	}

	// Aggregate
	const modelScores = aggregateModelScores(model.name, model.paramsB, scores);

	console.log(`\n  Results: ${successCount} ok, ${failCount} failed`);
	if (scores.length > 0) {
		console.log(
			`  Avg scores: format=${modelScores.avg.format.toFixed(3)} ` +
			`kw=${modelScores.avg.keyword.toFixed(3)} ` +
			`sem=${modelScores.avg.semantic.toFixed(3)} ` +
			`hyde=${modelScores.avg.hyde.toFixed(3)} ` +
			`speed=${modelScores.avg.latencyMs.toFixed(0)}ms ` +
			`total=${modelScores.avg.total.toFixed(3)}`,
		);
	}

	// Save results
	const safeName = model.lmsKey.replace(/\//g, "_").replace(/\s+/g, "_");
	const resultFile = join(RESULTS_DIR, `${safeName}.json`);
	const resultData = {
		model: {
			name: model.name,
			lmsKey: model.lmsKey,
			family: model.family,
			paramsB: model.paramsB,
		},
		timestamp: new Date().toISOString(),
		config: {
			port: config.port,
			timeout: config.timeout,
			retries: config.retries,
		},
		summary: modelScores.avg,
		queryCount: queries.length,
		successCount,
		failCount,
		scores: modelScores.scores,
		rawResults,
	};

	writeFileSync(resultFile, JSON.stringify(resultData, null, 2));
	console.log(`  Saved: ${resultFile}`);

	// Unload if we loaded
	if (!config.skipLoad) {
		unloadModel();
	}

	return modelScores;
}

// ============================================================================
// Main
// ============================================================================

async function main() {
	const config = parseArgs();

	// Load queries
	if (!existsSync(QUERIES_PATH)) {
		console.error(`Queries file not found: ${QUERIES_PATH}`);
		process.exit(1);
	}

	const querySet: QuerySet = JSON.parse(readFileSync(QUERIES_PATH, "utf-8"));
	const queries = querySet.queries;

	console.log(`Query Expansion Benchmark`);
	console.log(`========================`);
	console.log(`Queries: ${queries.length} (${querySet.version})`);
	console.log(
		`Models:  ${config.models.length} (${config.models.map((m) => m.name).join(", ")})`,
	);
	console.log(`Port:    localhost:${config.port}`);
	console.log(`Timeout: ${config.timeout}ms, Retries: ${config.retries}`);

	if (config.dryRun) {
		console.log(`\n[DRY RUN] Would benchmark these models:`);
		for (const model of config.models) {
			console.log(`  - ${model.name} (${model.lmsKey}, ${model.paramsB}B)`);
		}
		console.log(`\nWith ${queries.length} queries across categories:`);
		const categories = new Set(queries.map((q) => q.category));
		for (const cat of categories) {
			const count = queries.filter((q) => q.category === cat).length;
			console.log(`  - ${cat}: ${count} queries`);
		}
		return;
	}

	// Ensure results directory exists
	mkdirSync(RESULTS_DIR, { recursive: true });

	// Check LM Studio is running
	try {
		const response = await fetch(`http://localhost:${config.port}/v1/models`, {
			signal: AbortSignal.timeout(5000),
		});
		if (!response.ok) {
			console.error(
				`\nLM Studio API not responding on port ${config.port}. Is LM Studio running?`,
			);
			process.exit(1);
		}
	} catch {
		console.error(
			`\nCannot connect to LM Studio on port ${config.port}. Start LM Studio first.`,
		);
		process.exit(1);
	}

	// Run benchmarks
	const allResults: ModelScores[] = [];
	const startTime = Date.now();

	for (const model of config.models) {
		try {
			const result = await benchmarkModel(model, queries, config);
			allResults.push(result);
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			console.error(`\nFATAL: Model ${model.name} failed: ${msg}`);
			// Continue with next model
		}
	}

	const totalTime = Math.round((Date.now() - startTime) / 1000);

	// Print summary
	console.log(`\n${"=".repeat(60)}`);
	console.log(`Benchmark Complete (${totalTime}s total)`);
	console.log(`${"=".repeat(60)}`);
	console.log(
		`\nRun report.ts to generate comparison table:`,
	);
	console.log(`  bun run experiments/query-expansion/bench/report.ts`);
}

main().catch((error) => {
	console.error("Fatal error:", error);
	process.exit(1);
});
