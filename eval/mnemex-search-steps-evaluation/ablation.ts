/**
 * Mnemex Search Steps Evaluation — Ablation Runner
 *
 * Runs ablation experiments over the code search pipeline.
 * Each condition toggles one or more pipeline components (router, expander,
 * reranker) while keeping the query set and retriever constant.
 *
 * Usage:
 *   bun eval/mnemex-search-steps-evaluation/ablation.ts --condition A --dataset hybrid --output runs/
 *
 * The harness is structured around pluggable function interfaces so that
 * the actual claudemem search logic can be wired in later without changing
 * the experiment structure.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import type { RouterLabel } from "../../src/benchmark-v2/types.js";
import type { HarnessQuery } from "./loader.js";

// ============================================================================
// Pluggable function interfaces
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

/** Options passed to the search function */
export interface SearchOptions {
	/** Maximum number of results to return */
	k: number;
	/** Router label to bias retrieval (when routing is enabled) */
	routerLabel?: RouterLabel;
	/** Expanded query terms / HyDE snippet */
	expandedQuery?: string;
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
 * Core retrieval function — always executes, is never disabled.
 * Implement this by calling into claudemem's search API.
 */
export type SearchFunction = (
	query: string,
	opts: SearchOptions,
) => Promise<SearchResult[]>;

/**
 * Router function — classifies a query into a RouterLabel.
 * When disabled, the harness falls back to classifyQueryType() from loader.
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
// Ablation condition definition
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
	routerMethod?: "regex" | "cnn" | "llm";
	/** Whether to run the query expander before retrieval */
	useExpander: boolean;
	/** Which expander model to use (only relevant if useExpander=true) */
	expanderModel?: string;
	/** Whether to run the reranker on the retrieved results */
	useReranker: boolean;
	/** Which dataset split this condition was designed for */
	dataset: "hybrid" | "cosqa" | "csn-python";
	/**
	 * When true AND useRouter is true, skip expansion for symbol_lookup queries.
	 * This prevents the expander from destroying keyword matches on symbol names.
	 */
	routeAwareExpansion?: boolean;
}

// ============================================================================
// STANDARD_CONDITIONS — the 10 ablation conditions from the spec
// ============================================================================

/**
 * Standard set of ablation conditions for the code search pipeline.
 *
 * | Name | Components enabled                    |
 * |------|---------------------------------------|
 * | A    | Retriever only (baseline)             |
 * | B1   | Retriever + regex router              |
 * | B2   | Retriever + CNN router                |
 * | B3   | Retriever + LLM router                |
 * | C1   | Retriever + tiny expander (LFM2-700M) |
 * | C2   | Retriever + medium expander (Qwen3-1.7B-FT) |
 * | C3   | Retriever + large expander (LFM2-2.6B) |
 * | D    | Retriever + reranker                  |
 * | E    | Full pipeline (best of each)           |
 * | F    | Router + expander + retriever          |
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
		description: "+CNN router",
		useRouter: true,
		routerMethod: "cnn",
		useExpander: false,
		useReranker: false,
		dataset: "hybrid",
	},
	{
		name: "B3",
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
		description: "+Medium expander (Qwen3-1.7B-FT)",
		useRouter: false,
		useExpander: true,
		expanderModel: "qwen3-1.7b-ft",
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
		description: "Full pipeline (best of each component)",
		useRouter: true,
		routerMethod: "regex",
		useExpander: true,
		expanderModel: "lfm2-2.6b",
		useReranker: true,
		dataset: "hybrid",
	},
	{
		name: "F",
		description: "Router + expander (no reranker)",
		useRouter: true,
		routerMethod: "regex",
		useExpander: true,
		expanderModel: "lfm2-2.6b",
		useReranker: false,
		dataset: "hybrid",
	},
	{
		name: "E-RA",
		description: "Full pipeline + route-aware expansion",
		useRouter: true,
		routerMethod: "regex",
		useExpander: true,
		expanderModel: "lfm2-2.6b",
		useReranker: true,
		dataset: "hybrid",
		routeAwareExpansion: true,
	},
	{
		name: "F-RA",
		description: "Router + expander (route-aware, no reranker)",
		useRouter: true,
		routerMethod: "regex",
		useExpander: true,
		expanderModel: "lfm2-2.6b",
		useReranker: false,
		dataset: "hybrid",
		routeAwareExpansion: true,
	},
	{
		name: "Q1",
		description: "QMD search (BM25 only)",
		useRouter: false,
		useExpander: false,
		useReranker: false,
		dataset: "hybrid",
	},
	{
		name: "Q2",
		description: "QMD query (expand + rerank)",
		useRouter: false,
		useExpander: false,
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
		recallAt100: number;
	};
	latency: {
		p50: number;
		p95: number;
		mean: number;
	};
}

// ============================================================================
// Config
// ============================================================================

/** Full configuration for an ablation run */
export interface AblationConfig {
	/** Which conditions to run (defaults to STANDARD_CONDITIONS) */
	conditions: AblationCondition[];
	/** The set of queries to evaluate */
	querySet: HarnessQuery[];
	/** Directory to write per-condition JSON results */
	outputDir: string;
	/** Path to a claudemem index (optional — for real search) */
	claudememPath?: string;
	/** K values to compute recall at */
	kValues: number[];
	/** Print progress for each query */
	verbose?: boolean;
	/** Pluggable search function (mock by default) */
	searchFn?: SearchFunction;
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
// Mock implementations (replaced when wired to real claudemem)
// ============================================================================

/**
 * Mock search function — returns empty results.
 * Replace with real claudemem API call to measure actual retrieval quality.
 */
export const mockSearchFn: SearchFunction = async (_query, _opts) => {
	return [];
};

/**
 * Mock router — returns "semantic_search" for all queries.
 * Replace with real router (regex rules, CNN, or LLM).
 */
export const mockRouterFn: RouterFunction = async (_query) => {
	return "semantic_search";
};

/**
 * Mock expander — returns the query unchanged.
 * Replace with real LLM-based query expansion.
 */
export const mockExpanderFn: ExpanderFunction = async (query) => {
	return { expanded: query };
};

/**
 * Mock reranker — returns results unchanged.
 * Replace with cross-encoder or other reranking model.
 */
export const mockRerankerFn: RerankerFunction = async (results, _query) => {
	return results;
};

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
		searchFn = mockSearchFn,
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
			routerLabel = await routerFn(hq.query);
		}

		// Step 2: Expander
		// When routeAwareExpansion is enabled, skip expansion for symbol_lookup
		// queries — expansion destroys keyword matches on symbol names (e.g.
		// "FastMCP" gets rewritten to "server implementation for MCP protocol").
		let expandedQuery: ExpandedQuery | undefined;
		const skipExpansion =
			condition.routeAwareExpansion && routerLabel === "symbol_lookup";
		if (condition.useExpander && !skipExpansion) {
			expandedQuery = await expanderFn(hq.query);
		}

		// Step 3: Retrieval
		const searchOpts: SearchOptions = {
			k: maxK,
			routerLabel: condition.useRouter ? routerLabel : undefined,
			expandedQuery: expandedQuery?.expanded,
		};
		let results = await searchFn(
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

	const mrrAt10 =
		n > 0 ? perQueryResults.reduce((s, r) => s + r.reciprocalRank, 0) / n : 0;
	const ndcgAt10 =
		n > 0 ? perQueryResults.reduce((s, r) => s + r.ndcgAt10, 0) / n : 0;
	const ndcgAt5 =
		n > 0 ? perQueryResults.reduce((s, r) => s + r.ndcgAt5, 0) / n : 0;
	const recallAt100 =
		n > 0
			? perQueryResults.reduce(
					(s, r) =>
						s + (r.recallAtK[100] ?? r.recallAtK[Math.max(...kValues)] ?? 0),
					0,
				) / n
			: 0;

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
		metrics: { mrrAt10, ndcgAt10, ndcgAt5, recallAt100 },
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
 *   bun eval/mnemex-search-steps-evaluation/ablation.ts \
 *     --condition A \
 *     --dataset hybrid \
 *     --output runs/
 *
 * If --condition is omitted, all STANDARD_CONDITIONS are run.
 */
if (import.meta.main) {
	const { values: args } = parseArgs({
		args: process.argv.slice(2),
		options: {
			condition: { type: "string" },
			dataset: { type: "string", default: "hybrid" },
			output: { type: "string", default: "runs" },
			verbose: { type: "boolean", default: false },
		},
	});

	const conditionArg = args.condition as string | undefined;
	const datasetArg =
		(args.dataset as "hybrid" | "cosqa" | "csn-python") ?? "hybrid";
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

	// Filter by dataset if specified
	const filtered = conditions.filter((c) => c.dataset === datasetArg);
	if (filtered.length === 0) {
		console.warn(
			`No conditions match dataset "${datasetArg}". Running all conditions.`,
		);
	}
	const toRun = filtered.length > 0 ? filtered : conditions;

	console.log(
		`Running ${toRun.length} condition(s) on dataset "${datasetArg}"...`,
	);
	console.log("NOTE: No query set loaded — using empty mock set.");
	console.log(
		"Pass a real query set via the runAblation() API for actual evaluation.\n",
	);

	await runAblation({
		conditions: toRun,
		querySet: [], // placeholder — wire in loadBeirDataset() or loadSwebenchQueries()
		outputDir,
		kValues: [1, 5, 10, 100],
		verbose,
	});

	console.log("Done.");
}
