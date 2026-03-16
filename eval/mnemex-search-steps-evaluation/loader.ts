/**
 * Mnemex Search Steps Evaluation — Data Loader
 *
 * Loads benchmark data from multiple sources (BEIR JSONL, SWE-bench instances)
 * into a unified format compatible with benchmark-v2 GeneratedQuery.
 *
 * Usage:
 *   import { loadBeirDataset, loadSwebenchQueries } from "./loader.js";
 */

import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import type {
	GeneratedQuery,
	QueryType,
	RouterLabel,
} from "../../src/benchmark-v2/types.js";

// ============================================================================
// HarnessQuery — unified query format
// ============================================================================

/** Extended query format used throughout the code search harness */
export interface HarnessQuery extends GeneratedQuery {
	routerLabel?: RouterLabel;
	groundTruthFiles?: string[];
}

// ============================================================================
// BEIR dataset types
// ============================================================================

interface BeirCorpusEntry {
	_id: string;
	title: string;
	text: string;
}

interface BeirQueryEntry {
	_id: string;
	text: string;
	routerLabel?: RouterLabel;
}

// ============================================================================
// SWE-bench instance type
// ============================================================================

interface SwebenchInstance {
	instance_id: string;
	problem_statement: string;
	patch?: string;
	[key: string]: unknown;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Read a file line-by-line and parse each line as JSON.
 */
async function readJsonl<T>(filePath: string): Promise<T[]> {
	const results: T[] = [];
	const rl = createInterface({
		input: createReadStream(filePath, { encoding: "utf8" }),
		crlfDelay: Number.POSITIVE_INFINITY,
	});
	for await (const line of rl) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		results.push(JSON.parse(trimmed) as T);
	}
	return results;
}

/**
 * Extract modified file paths from a unified diff patch string.
 * Returns de-duplicated list of paths (strips the `b/` prefix).
 */
function extractFilesFromPatch(patch: string): string[] {
	const seen = new Set<string>();
	const lines = patch.split("\n");
	for (const line of lines) {
		// Match "+++ b/path/to/file.py" lines
		const match = line.match(/^\+\+\+ b\/(.+)$/);
		if (match) {
			seen.add(match[1]);
		}
	}
	return [...seen];
}

// ============================================================================
// classifyQueryType
// ============================================================================

/**
 * Classify a natural-language query into one of the 4 RouterLabel classes
 * using fast heuristic regex rules.  No model required — ~0ms overhead.
 *
 * Rules (in priority order):
 * 1. Backtick-quoted identifiers OR CamelCase/snake_case tokens → symbol_lookup
 * 2. Relationship queries ("callers of", "where is X called", etc.) → structural
 * 3. Bug / error descriptions → semantic_search
 * 4. Feature requests / how-to → exploratory
 * 5. Default → semantic_search
 */
export function classifyQueryType(query: string): RouterLabel {
	// 1. Symbol lookup — backtick identifiers or camelCase/snake_case names
	if (
		/`[^`]+`/.test(query) ||
		/\b[A-Z][a-z]+[A-Z]\w*\b/.test(query) || // CamelCase
		/\b[a-z]+_[a-z_]+\b/.test(query) // snake_case
	) {
		return "symbol_lookup";
	}

	// 2. Structural — relationship queries
	if (
		/callers?\s+of\b/i.test(query) ||
		/where\s+is\b.+called/i.test(query) ||
		/\bdepends?\s+on\b/i.test(query) ||
		/\bimports?\s+from\b/i.test(query) ||
		/\bused\s+by\b/i.test(query) ||
		/\bextends?\b/i.test(query) ||
		/\binherits?\s+from\b/i.test(query)
	) {
		return "structural";
	}

	// 3. Bug / error descriptions → semantic_search
	if (
		/\braises?\b/i.test(query) ||
		/\breturns?\s+wrong\b/i.test(query) ||
		/\bdoesn'?t\s+work\b/i.test(query) ||
		/\berror\b/i.test(query) ||
		/\bfail(s|ing|ure)?\b/i.test(query) ||
		/\bcrash(es)?\b/i.test(query) ||
		/\bexception\b/i.test(query) ||
		/\bbug\b/i.test(query)
	) {
		return "semantic_search";
	}

	// 4. Feature requests / how-to → exploratory
	if (
		/\badd\s+support\b/i.test(query) ||
		/\bimplement\b/i.test(query) ||
		/\bhow\s+to\b/i.test(query) ||
		/\bbest\s+(way|practice)\b/i.test(query) ||
		/\brecommended\b/i.test(query) ||
		/\bexample\s+of\b/i.test(query)
	) {
		return "exploratory";
	}

	// 5. Default
	return "semantic_search";
}

// ============================================================================
// mapQueryTypeToRouterLabel
// ============================================================================

/**
 * Map the 8-type QueryType enum to the 4-class RouterLabel.
 *
 * Mapping:
 * - doc_api_lookup → symbol_lookup
 * - specific_behavior, problem_based, wrong_terminology → semantic_search
 * - integration → structural
 * - vague, doc_conceptual, doc_best_practice → exploratory
 */
export function mapQueryTypeToRouterLabel(type: QueryType): RouterLabel {
	switch (type) {
		case "doc_api_lookup":
			return "symbol_lookup";
		case "specific_behavior":
		case "problem_based":
		case "wrong_terminology":
			return "semantic_search";
		case "integration":
			return "structural";
		case "vague":
		case "doc_conceptual":
		case "doc_best_practice":
			return "exploratory";
		default:
			return type satisfies never as RouterLabel;
	}
}

// ============================================================================
// loadBeirDataset
// ============================================================================

export interface BeirDataset {
	queries: HarnessQuery[];
	/** Map from doc _id to the document text used for retrieval */
	corpus: Map<string, string>;
	/** Map from query_id → Map<doc_id, relevance> */
	qrels: Map<string, Map<string, number>>;
}

/**
 * Load a BEIR-formatted dataset from a directory.
 *
 * Expected directory layout:
 * ```
 * <dir>/corpus.jsonl        — {"_id": "...", "title": "...", "text": "..."}
 * <dir>/queries.jsonl       — {"_id": "...", "text": "...", "routerLabel"?: "..."}
 * <dir>/qrels/test.tsv      — query_id\tdoc_id\trelevance (tab-separated)
 * ```
 *
 * @param dir - Path to the BEIR dataset directory
 */
export async function loadBeirDataset(dir: string): Promise<BeirDataset> {
	const corpusPath = `${dir}/corpus.jsonl`;
	const queriesPath = `${dir}/queries.jsonl`;
	const qrelsPath = `${dir}/qrels/test.tsv`;

	// Load corpus
	const corpusEntries = await readJsonl<BeirCorpusEntry>(corpusPath);
	const corpus = new Map<string, string>();
	for (const entry of corpusEntries) {
		corpus.set(entry._id, entry.text);
	}

	// Load qrels
	const qrelsTsv = await readFile(qrelsPath, "utf8");
	const qrels = new Map<string, Map<string, number>>();
	for (const line of qrelsTsv.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("query-id")) continue; // skip header
		const [queryId, docId, relevanceStr] = trimmed.split("\t");
		if (!queryId || !docId) continue;
		const relevance = Number.parseInt(relevanceStr ?? "1", 10);
		if (!qrels.has(queryId)) {
			qrels.set(queryId, new Map());
		}
		qrels.get(queryId)?.set(docId, relevance);
	}

	// Load queries and convert to HarnessQuery
	const queryEntries = await readJsonl<BeirQueryEntry>(queriesPath);
	const queries: HarnessQuery[] = queryEntries.map((entry) => {
		const routerLabel = entry.routerLabel ?? classifyQueryType(entry.text);
		return {
			id: entry._id,
			codeUnitId: entry._id, // BEIR doesn't have codeUnitId; use query id as proxy
			type: "vague" as QueryType, // BEIR queries are untyped; assign generic type
			query: entry.text,
			shouldFind: true,
			routerLabel,
			groundTruthFiles: qrels.has(entry._id)
				? [...(qrels.get(entry._id) as Map<string, number>).keys()]
				: [],
		};
	});

	return { queries, corpus, qrels };
}

// ============================================================================
// loadSwebenchQueries
// ============================================================================

/**
 * Load SWE-bench instances from a JSONL file and convert to HarnessQuery.
 *
 * The problem_statement becomes the query text.
 * Ground-truth files are extracted from the patch diff.
 *
 * @param path - Path to the SWE-bench JSONL file
 */
export async function loadSwebenchQueries(
	path: string,
): Promise<HarnessQuery[]> {
	const instances = await readJsonl<SwebenchInstance>(path);
	return instances.map((instance) => {
		const groundTruthFiles = instance.patch
			? extractFilesFromPatch(instance.patch)
			: [];
		const query = instance.problem_statement.trim();
		return {
			id: instance.instance_id,
			codeUnitId: instance.instance_id,
			type: "problem_based" as QueryType,
			query,
			shouldFind: true,
			routerLabel: classifyQueryType(query),
			groundTruthFiles,
		};
	});
}

// ============================================================================
// splitDataset
// ============================================================================

export interface DatasetSplitConfig {
	/** Number of queries to hold out for router evaluation */
	routerTestSize: number;
	/** Number of queries to use for retrieval evaluation */
	retrievalEvalSize: number;
}

export interface DatasetSplit {
	routerTestSet: HarnessQuery[];
	retrievalEvalSet: HarnessQuery[];
}

/**
 * Split a query set into a router test set and a retrieval eval set.
 *
 * Uses stratified sampling by routerLabel so each label class is
 * proportionally represented in both splits.
 *
 * @param queries - Full query set
 * @param config - Split sizes
 */
export function splitDataset(
	queries: HarnessQuery[],
	config: DatasetSplitConfig,
): DatasetSplit {
	const { routerTestSize, retrievalEvalSize } = config;

	// Group by routerLabel
	const byLabel = new Map<RouterLabel | "unknown", HarnessQuery[]>();
	for (const q of queries) {
		const label: RouterLabel | "unknown" = q.routerLabel ?? "unknown";
		if (!byLabel.has(label)) byLabel.set(label, []);
		byLabel.get(label)?.push(q);
	}

	const total = queries.length;
	const routerFraction = routerTestSize / total;

	const routerTestSet: HarnessQuery[] = [];
	const retrievalEvalSet: HarnessQuery[] = [];

	for (const [, group] of byLabel) {
		// Deterministic shuffle using index-based interleaving (no random seed needed)
		const shuffled = group.slice().sort((a, b) => a.id.localeCompare(b.id));
		const routerCount = Math.round(shuffled.length * routerFraction);
		routerTestSet.push(...shuffled.slice(0, routerCount));
		retrievalEvalSet.push(...shuffled.slice(routerCount));
	}

	// Trim to requested sizes if over
	return {
		routerTestSet: routerTestSet.slice(0, routerTestSize),
		retrievalEvalSet: retrievalEvalSet.slice(0, retrievalEvalSize),
	};
}
