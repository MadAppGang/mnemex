/**
 * Code Search Harness — Data Loader
 *
 * Loads benchmark queries from BEIR JSONL format and simple JSON array files
 * into a unified format compatible with benchmark-v2 GeneratedQuery.
 *
 * Supported input formats:
 *   BEIR layout:
 *     <dir>/corpus.jsonl        — {"_id": "...", "title": "...", "text": "..."}
 *     <dir>/queries.jsonl       — {"_id": "...", "text": "...", "routerLabel"?: "..."}
 *     <dir>/qrels/test.tsv      — query_id\tdoc_id\trelevance (tab-separated)
 *   JSON array:
 *     <file>.json               — HarnessQuery[] (internal format)
 *
 * Usage:
 *   import { loadBeirDataset, loadJsonQueries } from "./loader.js";
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
// BEIR dataset types (internal)
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

// ============================================================================
// classify_query_type_heuristic
// ============================================================================

/**
 * Classify a natural-language query into one of the 4 RouterLabel classes
 * using fast heuristic regex rules.  No model required — ~0ms overhead.
 *
 * Rules (in priority order):
 * 1. Backtick-quoted identifiers OR CamelCase names → symbol_lookup
 * 2. Relationship queries ("callers of", "where is X called", etc.) → structural
 * 3. Bug / error descriptions ("raises", "returns wrong", "doesn't work") → semantic_search
 * 4. Feature requests ("add support", "implement") → exploratory
 * 5. Default → semantic_search
 */
export function classify_query_type_heuristic(query: string): RouterLabel {
	// 1. Symbol lookup — backtick identifiers or CamelCase names
	if (
		/`[^`]+`/.test(query) ||
		/\b[A-Z][a-z]+[A-Z]\w*\b/.test(query) // CamelCase (e.g. QueryRouter, FastMCP)
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
// BeirDataset
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
		const routerLabel =
			entry.routerLabel ?? classify_query_type_heuristic(entry.text);
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
// loadJsonQueries
// ============================================================================

/**
 * Load queries from a simple JSON array file (internal format).
 *
 * The file must contain a JSON array of HarnessQuery objects.
 * Missing routerLabel fields are auto-classified using the heuristic.
 *
 * @param filePath - Path to the JSON file
 */
export async function loadJsonQueries(
	filePath: string,
): Promise<HarnessQuery[]> {
	const raw = await readFile(filePath, "utf8");
	const parsed = JSON.parse(raw) as HarnessQuery[];
	return parsed.map((q) => ({
		...q,
		routerLabel: q.routerLabel ?? classify_query_type_heuristic(q.query),
	}));
}
