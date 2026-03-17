/**
 * Code Search Harness — Ablation Runner
 *
 * Runs ablation experiments over the code search pipeline.
 * Each condition toggles one or more pipeline components (router, expander,
 * reranker) while keeping the query set and retriever constant.
 *
 * Usage:
 *   bun eval/code-search-harness/ablation.ts --condition A --dataset hybrid \
 *     --data-dir eval/code-search-harness/data
 *
 * If --condition is omitted, all STANDARD_CONDITIONS are run.
 * Results are written to eval/code-search-harness/results/condition_{name}.json
 *
 * The SearchExecutor interface makes the search backend mockable for testing.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import type { RouterLabel } from "../../src/benchmark-v2/types.js";
import {
	classify_query_type_heuristic,
	loadBeirDataset,
	loadJsonQueries,
} from "./loader.js";
import type { HarnessQuery } from "./loader.js";

// ============================================================================
// SearchExecutor interface — mockable for testing
// ============================================================================

/** A single search result returned by the retriever */
export interface SearchResult {
	/** Document / chunk identifier */
	docId: string;
	/** Similarity or relevance score */
	score: number;
	/** Optional snippet of the matched content */
	snippet?: string;
}

/** Options passed to the search executor */
export interface SearchOptions {
	/** Maximum number of results to return */
	k: number;
	/** Router label to bias retrieval (when routing is enabled) */
	routerLabel?: RouterLabel;
	/** Expanded query terms / HyDE snippet */
	expandedQuery?: string;
}

/**
 * Abstraction over the mnemex search backend.
 * Implement this to wire in real claudemem search; use MockSearchExecutor in tests.
 */
export interface SearchExecutor {
	search(query: string, options: SearchOptions): Promise<SearchResult[]>;
}

/** Expanded query produced by the expander model */
export interface ExpandedQuery {
	/** Rewritten / expanded query string */
	expanded: string;
	/** HyDE (Hypothetical Document Embedding) snippet when available */
	hyde?: string;
	/** Lexical keywords extracted from the query */
	keywords?: string[];
}

/**
 * Router function — classifies a query into a RouterLabel.
 * When disabled, the harness falls back to classify_query_type_heuristic() from loader.
 */
export type RouterFunction = (query: string) => Promise<RouterLabel>;

/**
 * Query expander — rewrites a query into expanded terms or a HyDE snippet.
 */
export type ExpanderFunction = (query: string) => Promise<ExpandedQuery>;

/**
 * Reranker — reorders search results by relevance to the original query.
 */
export type RerankerFunction = (
	results: SearchResult[],
	query: string,
) => Promise<SearchResult[]>;

// ============================================================================
// Mock implementations (replaced when wired to real claudemem)
// ============================================================================

/** Mock executor — returns empty results. Replace with real claudemem search. */
export class MockSearchExecutor implements SearchExecutor {
	async search(
		_query: string,
		_options: SearchOptions,
	): Promise<SearchResult[]> {
		return [];
	}
}

/** Mock router — returns "semantic_search" for all queries. */
export const mockRouterFn: RouterFunction = async (_query) => "semantic_search";

/** Mock expander — returns the query unchanged. */
export const mockExpanderFn: ExpanderFunction = async (query) => ({
	expanded: query,
});

/** Mock reranker — returns results unchanged. */
export const mockRerankerFn: RerankerFunction = async (results, _query) =>
	results;

// ============================================================================
// AblationCondition definition
// ============================================================================

/** Definition of one ablation condition (one row in the results table) */
export interface AblationCondition {
	/** Short identifier: "A", "B1", "B2", etc. */
	name: string;
	/** Human-readable description shown in reports */
	description: string;
	/** Whether to run the query router before retrieval */
	useRouter: boolean;
	/** Which router implementation to use (only relevant if useRouter=true) */
	routerMethod?: "regex" | "llm";
	/** Whether to run the query expander before retrieval */
	useExpander: boolean;
	/** Which expander model to use (only relevant if useExpander=true) */
	expanderModel?: string;
	/** Whether to run the reranker on the retrieved results */
	useReranker: boolean;
	/** Which dataset split this condition was designed for */
	dataset: "hybrid" | "cosqa" | "csn-python" | "custom";
}

// ============================================================================
// STANDARD_CONDITIONS
// ============================================================================

/**
 * Standard set of ablation conditions for the code search pipeline.
 *
 * | Name | Components enabled                        |
 * |------|-------------------------------------------|
 * | A    | Retriever only (baseline)                 |
 * | B1   | Retriever + regex router                  |
 * | B2   | Retriever + LLM router                    |
 * | C1   | Retriever + tiny expander (LFM2-700M)     |
 * | C2   | Retriever + medium expander (Qwen3-1.7B)  |
 * | C3   | Retriever + large expander (LFM2-2.6B)    |
 * | D    | Retriever + reranker only                 |
 * | E    | Full pipeline (router + expander + reranker) |
 * | F    | Best subset (determined after A-E)        |
 */
export const STANDARD_CONDITIONS: AblationCondition[] = [
	{
		name: "A",
		description: "Baseline — pure hybrid retrieval",
		useRouter: false,
		useExpander: false,
		useReranker: false,
		dataset: "hybrid",
	},
	{
		name: "B1",
		description: "+Regex router",
		useRouter: true,
		routerMethod: "regex",
		useExpander: false,
		useReranker: false,
		dataset: "hybrid",
	},
	{
		name: "B2",
		description: "+LLM router",
		useRouter: true,
		routerMethod: "llm",
		useExpander: false,
		useReranker: false,
		dataset: "hybrid",
	},
	{
		name: "C1",
		description: "+Tiny expander (LFM2-700M)",
		useRouter: false,
		useExpander: true,
		expanderModel: "lfm2-700m",
		useReranker: false,
		dataset: "hybrid",
	},
	{
		name: "C2",
		description: "+Medium expander (Qwen3-1.7B)",
		useRouter: false,
		useExpander: true,
		expanderModel: "qwen3-1.7b",
		useReranker: false,
		dataset: "hybrid",
	},
	{
		name: "C3",
		description: "+Large expander (LFM2-2.6B)",
		useRouter: false,
		useExpander: true,
		expanderModel: "lfm2-2.6b",
		useReranker: false,
		dataset: "hybrid",
	},
	{
		name: "D",
		description: "+Reranker only",
		useRouter: false,
		useExpander: false,
		useReranker: true,
		dataset: "hybrid",
	},
	{
		name: "E",
		description: "Full pipeline (router + expander + reranker)",
		useRouter: true,
		routerMethod: "regex",
		useExpander: true,
		expanderModel: "lfm2-2.6b",
		useReranker: true,
		dataset: "hybrid",
	},
	{
		name: "F",
		description: "Best subset (determined after A-E)",
		useRouter: true,
		routerMethod: "regex",
		useExpander: true,
		expanderModel: "lfm2-2.6b",
		useReranker: false,
		dataset: "hybrid",
	},
];

// ============================================================================
// Result types
// ============================================================================

/** Per-query metrics for a single condition run */
export interface PerQueryResult {
	queryId: string;
	query: string;
	routerLabel?: RouterLabel;
	/** MRR: 1/rank of the first relevant doc, or 0 */
	reciprocalRank: number;
	ndcgAt5: number;
	ndcgAt10: number;
	/** Recall at each K value */
	recallAtK: Record<number, number>;
	/** Wall-clock latency for this query (ms) */
	latencyMs: number;
	/** Top-K doc IDs returned by the pipeline */
	retrievedDocs: string[];
	/** Expected relevant doc IDs from qrels / groundTruth */
	groundTruth: string[];
}

/** Aggregated results for one ablation condition */
export interface ConditionResult {
	condition: AblationCondition;
	dataset: string;
	nQueries: number;
	perQueryResults: PerQueryResult[];
	metrics: {
		mrrAt10: number;
		ndcgAt10: number;
		ndcgAt5: number;
		recallAt1: number;
		recallAt5: number;
		recallAt10: number;
		recallAt100: number;
	};
	latency: {
		p50: number;
		p95: number;
		mean: number;
	};
}

// ============================================================================
// AblationConfig
// ============================================================================

/** Full configuration for an ablation run */
export interface AblationConfig {
	/** Which conditions to run (defaults to STANDARD_CONDITIONS) */
	conditions: AblationCondition[];
	/** The set of queries to evaluate */
	querySet: HarnessQuery[];
	/** Directory to write per-condition JSON results */
	outputDir: string;
	/** K values to compute recall at */
	kValues: number[];
	/** Print progress for each query */
	verbose?: boolean;
	/** Search backend (mock by default) */
	executor?: SearchExecutor;
	/** Pluggable router function (mock by default) */
	routerFn?: RouterFunction;
	/** Pluggable expander function (mock by default) */
	expanderFn?: ExpanderFunction;
	/** Pluggable reranker function (mock by default) */
	rerankerFn?: RerankerFunction;
}

// ============================================================================
// Metric helpers
// ============================================================================

/**
 * Compute Reciprocal Rank: 1/rank of the first relevant doc, or 0.
 */
export function computeReciprocalRank(
	retrieved: string[],
	relevant: Set<string>,
): number {
	for (let i = 0; i < retrieved.length; i++) {
		if (relevant.has(retrieved[i])) {
			return 1 / (i + 1);
		}
	}
	return 0;
}

/**
 * Compute NDCG@K with binary relevance.
 * DCG@K = sum(rel_i / log2(i+2)) for i in [0, K).
 * IDCG@K = 1 (ideal: first doc is relevant).
 */
export function computeNdcgAtK(
	retrieved: string[],
	relevant: Set<string>,
	k: number,
): number {
	const topK = retrieved.slice(0, k);
	let dcg = 0;
	for (let i = 0; i < topK.length; i++) {
		if (relevant.has(topK[i])) {
			dcg += 1 / Math.log2(i + 2); // i+2 because log2(1) = 0
		}
	}
	// IDCG@K = 1/log2(2) = 1 when there is at least one relevant doc
	const idcg = relevant.size > 0 ? 1 / Math.log2(2) : 0;
	return idcg > 0 ? dcg / idcg : 0;
}

/**
 * Compute Recall@K: fraction of relevant docs found in top-K.
 */
export function computeRecallAtK(
	retrieved: string[],
	relevant: Set<string>,
	k: number,
): number {
	if (relevant.size === 0) return 0;
	const topK = new Set(retrieved.slice(0, k));
	let hits = 0;
	for (const docId of relevant) {
		if (topK.has(docId)) hits++;
	}
	return hits / relevant.size;
}

/**
 * Compute percentile value from a sorted array.
 */
function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	if (sorted.length === 1) return sorted[0];
	const index = p * (sorted.length - 1);
	const lower = Math.floor(index);
	const upper = Math.ceil(index);
	const weight = index - lower;
	return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

// ============================================================================
// runCondition
// ============================================================================

/**
 * Run a single ablation condition against the full query set.
 *
 * For each query, the pipeline executes in order:
 *   1. [optional] Route → produce RouterLabel
 *   2. [optional] Expand → produce ExpandedQuery
 *   3. Retrieve (always) → produce SearchResult[]
 *   4. [optional] Rerank → reorder SearchResult[]
 *   5. Compute per-query metrics vs ground truth
 *
 * Results are written to `{outputDir}/condition_{name}.json`.
 */
export async function runCondition(
	condition: AblationCondition,
	config: AblationConfig,
): Promise<ConditionResult> {
	const {
		querySet,
		outputDir,
		kValues,
		verbose,
		executor = new MockSearchExecutor(),
		routerFn = mockRouterFn,
		expanderFn = mockExpanderFn,
		rerankerFn = mockRerankerFn,
	} = config;

	const maxK = Math.max(...kValues, 10);
	const perQueryResults: PerQueryResult[] = [];

	if (verbose) {
		console.log(`\n[condition ${condition.name}] ${condition.description}`);
		console.log(`  Queries: ${querySet.length}`);
	}

	for (const hq of querySet) {
		const start = performance.now();

		// Step 1: Router
		let routerLabel: RouterLabel | undefined = hq.routerLabel;
		if (condition.useRouter) {
			if (condition.routerMethod === "regex") {
				routerLabel = classify_query_type_heuristic(hq.query);
			} else {
				routerLabel = await routerFn(hq.query);
			}
		}

		// Step 2: Expander
		let expandedQuery: ExpandedQuery | undefined;
		if (condition.useExpander) {
			expandedQuery = await expanderFn(hq.query);
		}

		// Step 3: Retrieval
		const searchOpts: SearchOptions = {
			k: maxK,
			routerLabel: condition.useRouter ? routerLabel : undefined,
			expandedQuery: expandedQuery?.expanded,
		};
		let results = await executor.search(
			expandedQuery?.expanded ?? hq.query,
			searchOpts,
		);

		// Step 4: Reranker
		if (condition.useReranker && results.length > 0) {
			results = await rerankerFn(results, hq.query);
		}

		const latencyMs = performance.now() - start;

		// Step 5: Compute metrics
		const retrievedDocs = results.map((r) => r.docId);
		const groundTruth: string[] = [
			...(hq.groundTruthFiles ?? []),
			// If no groundTruthFiles, fall back to codeUnitId as the single relevant doc
			...(hq.groundTruthFiles && hq.groundTruthFiles.length > 0
				? []
				: [hq.codeUnitId]),
		];
		const relevantSet = new Set(groundTruth);

		const recallAtK: Record<number, number> = {};
		for (const k of kValues) {
			recallAtK[k] = computeRecallAtK(retrievedDocs, relevantSet, k);
		}

		const pqr: PerQueryResult = {
			queryId: hq.id,
			query: hq.query,
			routerLabel,
			reciprocalRank: computeReciprocalRank(retrievedDocs, relevantSet),
			ndcgAt5: computeNdcgAtK(retrievedDocs, relevantSet, 5),
			ndcgAt10: computeNdcgAtK(retrievedDocs, relevantSet, 10),
			recallAtK,
			latencyMs,
			retrievedDocs,
			groundTruth,
		};

		perQueryResults.push(pqr);

		if (verbose) {
			const rr = pqr.reciprocalRank.toFixed(3);
			console.log(`  [${hq.id}] RR=${rr}  latency=${latencyMs.toFixed(1)}ms`);
		}
	}

	// Aggregate metrics
	const n = perQueryResults.length;
	const mean = (getter: (r: PerQueryResult) => number) =>
		n > 0 ? perQueryResults.reduce((s, r) => s + getter(r), 0) / n : 0;

	const mrrAt10 = mean((r) => r.reciprocalRank);
	const ndcgAt10 = mean((r) => r.ndcgAt10);
	const ndcgAt5 = mean((r) => r.ndcgAt5);
	const recallAt1 = mean((r) => r.recallAtK[1] ?? 0);
	const recallAt5 = mean((r) => r.recallAtK[5] ?? 0);
	const recallAt10 = mean((r) => r.recallAtK[10] ?? 0);
	const recallAt100 = mean(
		(r) => r.recallAtK[100] ?? r.recallAtK[Math.max(...kValues)] ?? 0,
	);

	const latencies = perQueryResults
		.map((r) => r.latencyMs)
		.sort((a, b) => a - b);
	const latency = {
		p50: percentile(latencies, 0.5),
		p95: percentile(latencies, 0.95),
		mean: n > 0 ? latencies.reduce((a, b) => a + b, 0) / n : 0,
	};

	const conditionResult: ConditionResult = {
		condition,
		dataset: condition.dataset,
		nQueries: n,
		perQueryResults,
		metrics: {
			mrrAt10,
			ndcgAt10,
			ndcgAt5,
			recallAt1,
			recallAt5,
			recallAt10,
			recallAt100,
		},
		latency,
	};

	// Persist results
	await mkdir(outputDir, { recursive: true });
	const outPath = `${outputDir}/condition_${condition.name}.json`;
	await writeFile(outPath, JSON.stringify(conditionResult, null, 2), "utf8");

	if (verbose) {
		console.log(
			`  MRR@10=${mrrAt10.toFixed(3)}  NDCG@10=${ndcgAt10.toFixed(3)}  P95=${latency.p95.toFixed(0)}ms`,
		);
		console.log(`  Written: ${outPath}`);
	}

	return conditionResult;
}

// ============================================================================
// runAblation
// ============================================================================

/**
 * Run all ablation conditions sequentially and return aggregated results.
 *
 * Conditions are run in the order specified by config.conditions.
 * Results are written to `{outputDir}/condition_{name}.json` after each run.
 */
export async function runAblation(
	config: AblationConfig,
): Promise<ConditionResult[]> {
	const results: ConditionResult[] = [];
	for (const condition of config.conditions) {
		const result = await runCondition(condition, config);
		results.push(result);
	}

	// Also write a combined summary
	await mkdir(config.outputDir, { recursive: true });
	const summaryPath = `${config.outputDir}/summary.json`;
	await writeFile(
		summaryPath,
		JSON.stringify(
			results.map((r) => ({
				condition: r.condition.name,
				description: r.condition.description,
				nQueries: r.nQueries,
				metrics: r.metrics,
				latency: r.latency,
			})),
			null,
			2,
		),
		"utf8",
	);

	if (config.verbose) {
		console.log(`\nSummary written to ${summaryPath}`);
	}

	return results;
}

// ============================================================================
// CLI entry point
// ============================================================================

/**
 * CLI usage:
 *   bun eval/code-search-harness/ablation.ts \
 *     --condition A \
 *     --dataset hybrid \
 *     --data-dir eval/code-search-harness/data
 *
 * Options:
 *   --condition  Condition name (A, B1, B2, ...). Omit to run all.
 *   --dataset    Dataset name (default: hybrid)
 *   --data-dir   Directory containing BEIR-format data files
 *   --output     Output directory (default: eval/code-search-harness/results)
 *   --verbose    Print per-query progress
 *   --help       Show this help message
 */
if (import.meta.main) {
	const { values: args } = parseArgs({
		args: process.argv.slice(2),
		options: {
			condition: { type: "string" },
			dataset: { type: "string", default: "hybrid" },
			"data-dir": { type: "string" },
			output: {
				type: "string",
				default: "eval/code-search-harness/results",
			},
			verbose: { type: "boolean", default: false },
			help: { type: "boolean", default: false },
		},
	});

	if (args.help) {
		console.log(`Usage: bun eval/code-search-harness/ablation.ts [options]

Options:
  --condition  Condition name (${STANDARD_CONDITIONS.map((c) => c.name).join(", ")})
               Omit to run all conditions.
  --dataset    Dataset: hybrid | cosqa | csn-python | custom (default: hybrid)
  --data-dir   Directory with BEIR data (corpus.jsonl, queries.jsonl, qrels/test.tsv)
  --output     Output directory (default: eval/code-search-harness/results)
  --verbose    Print per-query progress
  --help       Show this help message
`);
		process.exit(0);
	}

	const conditionArg = args.condition as string | undefined;
	const datasetArg =
		(args.dataset as "hybrid" | "cosqa" | "csn-python" | "custom") ?? "hybrid";
	const dataDir = args["data-dir"] as string | undefined;
	const outputDir = args.output as string;
	const verbose = Boolean(args.verbose);

	let conditions: AblationCondition[];
	if (conditionArg) {
		const found = STANDARD_CONDITIONS.find((c) => c.name === conditionArg);
		if (!found) {
			console.error(`Unknown condition: ${conditionArg}`);
			console.error(
				`Available: ${STANDARD_CONDITIONS.map((c) => c.name).join(", ")}`,
			);
			process.exit(1);
		}
		conditions = [found];
	} else {
		conditions = STANDARD_CONDITIONS;
	}

	// Load queries if data-dir is provided, otherwise run with empty set
	let querySet: HarnessQuery[] = [];
	if (dataDir) {
		try {
			const dataset = await loadBeirDataset(dataDir);
			querySet = dataset.queries;
			console.log(`Loaded ${querySet.length} queries from ${dataDir}`);
		} catch {
			// Try loading as a JSON array file
			try {
				querySet = await loadJsonQueries(dataDir);
				console.log(`Loaded ${querySet.length} queries from ${dataDir}`);
			} catch {
				console.error(`Failed to load data from: ${dataDir}`);
				process.exit(1);
			}
		}
	} else {
		console.log("NOTE: No --data-dir provided — running with empty query set.");
		console.log(
			"Pass --data-dir <path> pointing to a BEIR dataset directory for actual evaluation.\n",
		);
	}

	const toRun = conditions.filter(
		(c) => c.dataset === datasetArg || datasetArg === "custom",
	);
	const conditionsToRun = toRun.length > 0 ? toRun : conditions;

	console.log(
		`Running ${conditionsToRun.length} condition(s) on dataset "${datasetArg}"...`,
	);

	await runAblation({
		conditions: conditionsToRun,
		querySet,
		outputDir,
		kValues: [1, 5, 10, 100],
		verbose,
	});

	console.log("Done.");
}
