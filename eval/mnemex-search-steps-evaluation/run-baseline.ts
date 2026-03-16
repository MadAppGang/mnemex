/**
 * Mnemex Search Steps Evaluation — Baseline Runner
 *
 * Runs Condition A (baseline: pure hybrid retrieval, no router/expander/reranker)
 * against a single claudemem-indexed eval repo.
 *
 * Queries are generated from the top-N symbols in the index by PageRank score.
 * Each symbol's name becomes the query text; the file it lives in is ground truth.
 *
 * Usage:
 *   bun eval/mnemex-search-steps-evaluation/run-baseline.ts \
 *     --repo jlowin_fastmcp \
 *     --limit 30 \
 *     --output eval/mnemex-search-steps-evaluation/runs/first-run \
 *     --verbose
 */

import { mkdir } from "node:fs/promises";
import { parseArgs } from "node:util";
import { createIndexer } from "../../src/core/indexer.js";
import { createFileTracker } from "../../src/core/tracker.js";
import { getIndexDbPath } from "../../src/config.js";
import type { QueryType } from "../../src/benchmark-v2/types.js";
import type { HarnessQuery } from "./loader.js";
import type { SearchFunction } from "./ablation.js";
import { STANDARD_CONDITIONS, runCondition } from "./ablation.js";
import { generateReport } from "./reporter.js";

// ============================================================================
// CLI argument parsing
// ============================================================================

const { values: args } = parseArgs({
	args: process.argv.slice(2),
	options: {
		repo: { type: "string", default: "jlowin_fastmcp" },
		limit: { type: "string", default: "30" },
		output: {
			type: "string",
			default: "eval/mnemex-search-steps-evaluation/runs/first-run",
		},
		"eval-repos-dir": {
			type: "string",
			default: "/Users/jack/mag/agentbench/data/eval-repos",
		},
		verbose: { type: "boolean", default: false },
	},
});

const repoName = args.repo as string;
const symbolLimit = Number.parseInt(args.limit as string, 10);
const outputDir = args.output as string;
const evalReposDir = args["eval-repos-dir"] as string;
const verbose = Boolean(args.verbose);

const repoPath = `${evalReposDir}/${repoName}`;

// ============================================================================
// Step 1: Load top symbols from the index via FileTracker
// ============================================================================

console.log(`Repo:    ${repoPath}`);
console.log(`Symbols: top ${symbolLimit} by PageRank`);
console.log(`Output:  ${outputDir}`);
console.log();

const indexDbPath = getIndexDbPath(repoPath);
const fileTracker = createFileTracker(indexDbPath, repoPath);

const topSymbols = fileTracker.getTopSymbols(symbolLimit);
fileTracker.close();

if (topSymbols.length === 0) {
	console.error(
		`No symbols found in index at: ${indexDbPath}\n` +
			"Run `claudemem index` on the repo first.",
	);
	process.exit(1);
}

console.log(`Loaded ${topSymbols.length} symbols from index.`);

// ============================================================================
// Step 2: Build HarnessQuery[] from symbols
//
// Query text  = symbol name (e.g. "FastMCP", "create_server", "Client")
// Ground truth = the file path where the symbol lives (file-level matching)
// codeUnitId  = filePath::symbolName (used as fallback if groundTruthFiles missing)
// routerLabel = "symbol_lookup" (we're searching by symbol name)
// ============================================================================

const queries: HarnessQuery[] = topSymbols.map((sym, idx) => {
	const queryId = `sym-${String(idx + 1).padStart(3, "0")}-${sym.name}`;
	return {
		id: queryId,
		// codeUnitId is the fallback ground truth when groundTruthFiles is empty
		codeUnitId: `${sym.filePath}::${sym.name}`,
		type: "doc_api_lookup" as QueryType,
		query: sym.name,
		shouldFind: true,
		routerLabel: "symbol_lookup",
		// File-level ground truth: the result is correct if it mentions sym.filePath
		groundTruthFiles: [sym.filePath],
	};
});

if (verbose) {
	console.log("\nSample queries:");
	for (const q of queries.slice(0, 5)) {
		console.log(`  [${q.id}] "${q.query}"  ->  ${q.groundTruthFiles?.[0]}`);
	}
	console.log();
}

// ============================================================================
// Step 3: Create indexer and wire up the real search function
// ============================================================================

const indexer = createIndexer({ projectPath: repoPath });

// The index stores relative paths in symbols (e.g. "src/fastmcp/server.py") but
// the search API returns absolute paths.  Strip the repo prefix so retrieved
// docIds match the relative paths stored as groundTruthFiles.
const repoPrefixWithSlash = repoPath.endsWith("/") ? repoPath : `${repoPath}/`;

const searchFn: SearchFunction = async (query, opts) => {
	const results = await indexer.search(query, {
		limit: opts.k,
		useCase: "search",
	});
	return results.map((r) => {
		// Normalize to relative path for consistent matching against ground truth
		const filePath = r.chunk.filePath.startsWith(repoPrefixWithSlash)
			? r.chunk.filePath.slice(repoPrefixWithSlash.length)
			: r.chunk.filePath;
		return {
			// File-level docId so it matches groundTruthFiles (relative file path)
			docId: filePath,
			score: r.score,
			snippet: r.chunk.content.slice(0, 200),
		};
	});
};

// ============================================================================
// Step 4: Find Condition A and run it
// ============================================================================

const conditionA = STANDARD_CONDITIONS.find((c) => c.name === "A");
if (!conditionA) {
	console.error(
		"Condition A not found in STANDARD_CONDITIONS — check ablation.ts",
	);
	process.exit(1);
}

await mkdir(outputDir, { recursive: true });

console.log(`Running Condition A: "${conditionA.description}" ...`);
console.log(`  Queries: ${queries.length}`);

const conditionResult = await runCondition(conditionA, {
	conditions: [conditionA],
	querySet: queries,
	outputDir,
	kValues: [1, 5, 10, 100],
	verbose,
	searchFn,
});

// ============================================================================
// Step 5: Generate the markdown report
// ============================================================================

const reportPath = `${outputDir}/report.md`;
await generateReport([conditionResult], reportPath);

// ============================================================================
// Step 6: Print summary and close
// ============================================================================

const m = conditionResult.metrics;
const l = conditionResult.latency;

console.log("\n=== Condition A Results ===");
console.log(`  Queries:    ${conditionResult.nQueries}`);
console.log(`  MRR@10:     ${m.mrrAt10.toFixed(3)}`);
console.log(`  NDCG@10:    ${m.ndcgAt10.toFixed(3)}`);
console.log(`  NDCG@5:     ${m.ndcgAt5.toFixed(3)}`);
console.log(`  Recall@100: ${m.recallAt100.toFixed(3)}`);
console.log(`  P50 lat:    ${Math.round(l.p50)}ms`);
console.log(`  P95 lat:    ${Math.round(l.p95)}ms`);
console.log(`\nReport:  ${reportPath}`);
console.log(`Results: ${outputDir}/condition_A.json`);

await indexer.close();
