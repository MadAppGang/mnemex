/**
 * Mnemex Search Steps Evaluation — Full Ablation Runner
 *
 * Runs all ablation conditions (A, B1, C1, C2, C3, D, E, F) against a single
 * claudemem-indexed eval repo, then generates a comparison report.
 *
 * Skipped conditions:
 *   - B2 (CNN router): no trained model available
 *   - B3 (LLM router/planner): decided not to build
 *
 * Expander conditions (C1, C2, C3, E, F) call LM Studio at http://localhost:1234.
 * The reranker (D, E) also calls LM Studio using qwen/qwen3-1.7b.
 *
 * Each condition is run in a separate subprocess to avoid LanceDB memory
 * accumulation that causes Bun to segfault after ~60-90 queries.
 *
 * Usage:
 *   bun eval/mnemex-search-steps-evaluation/run-all.ts \
 *     --repo jlowin_fastmcp \
 *     --limit 30 \
 *     --output eval/mnemex-search-steps-evaluation/runs/full-run \
 *     --conditions A,B1,C1,C2,C3,D,E,F \
 *     --verbose
 *
 * Single-condition mode (used internally by the orchestrator):
 *   bun eval/mnemex-search-steps-evaluation/run-all.ts \
 *     --single-condition A \
 *     --repo jlowin_fastmcp \
 *     --limit 30 \
 *     --output eval/mnemex-search-steps-evaluation/runs/full-run \
 *     --verbose
 */

import { mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { createIndexer } from "../../src/core/indexer.js";
import { createFileTracker } from "../../src/core/tracker.js";
import { getIndexDbPath } from "../../src/config.js";
import type { QueryType } from "../../src/benchmark-v2/types.js";
import type { HarnessQuery } from "./loader.js";
import { classifyQueryType } from "./loader.js";
import type {
	SearchFunction,
	RouterFunction,
	ExpanderFunction,
	RerankerFunction,
	SearchResult,
	ConditionResult,
} from "./ablation.js";
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
			default: "eval/mnemex-search-steps-evaluation/runs/full-run",
		},
		"eval-repos-dir": {
			type: "string",
			default: "/Users/jack/mag/agentbench/data/eval-repos",
		},
		conditions: {
			type: "string",
			default: "A,B1,C1,C2,C3,D,E,F,E-RA,F-RA,Q1,Q2",
		},
		"qmd-collection": { type: "string", default: "fastmcp" },
		"query-mode": { type: "string", default: "symbols" }, // "symbols" or "mixed"
		/** Internal flag: run exactly one condition in-process */
		"single-condition": { type: "string" },
		verbose: { type: "boolean", default: false },
	},
});

const repoName = args.repo as string;
const symbolLimit = Number.parseInt(args.limit as string, 10);
const outputDir = args.output as string;
const evalReposDir = args["eval-repos-dir"] as string;
const verbose = Boolean(args.verbose);
const singleCondition = args["single-condition"] as string | undefined;
const queryMode = args["query-mode"] as string;

// Conditions we deliberately skip (no model available / decided not to build)
const SKIP_CONDITIONS = new Set(["B2", "B3"]);

// QMD collection name for the eval repo
const QMD_COLLECTION = args["qmd-collection"] as string;

const repoPath = `${evalReposDir}/${repoName}`;

// ============================================================================
// LM Studio constants
// ============================================================================

const LM_STUDIO_URL = "http://localhost:1234/v1/chat/completions";

/** Model IDs as loaded in LM Studio */
const EXPANDER_MODELS: Record<string, string> = {
	"lfm2-700m": "lfm2-700m",
	"qwen3-1.7b-ft": "qwen/qwen3-1.7b",
	"lfm2-2.6b": "lfm2-2.6b",
};

const RERANKER_MODEL = "qwen/qwen3-1.7b";

// ============================================================================
// Expander implementation
// ============================================================================

const EXPANDER_SYSTEM_PROMPT = `You expand search queries for code search. Given a query, output exactly three lines:
lex: comma-separated keywords and identifiers for keyword search
vec: natural language rephrasing (10-20 words) for semantic search
hyde: a hypothetical 3-8 line code snippet that would be the ideal search result

Output ONLY the three lines. No markdown, no explanation.`;

async function callExpander(
	query: string,
	model: string,
): Promise<{ expanded: string; keywords: string[]; hyde?: string }> {
	let response: Response;
	try {
		response = await fetch(LM_STUDIO_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model,
				messages: [
					{ role: "system", content: EXPANDER_SYSTEM_PROMPT },
					{ role: "user", content: `Query: ${query}` },
				],
				temperature: 0.3,
				max_tokens: 300,
			}),
		});
	} catch (err) {
		console.warn(`  [expander] LM Studio unreachable (${model}): ${err}`);
		return { expanded: query, keywords: [], hyde: undefined };
	}

	if (!response.ok) {
		console.warn(
			`  [expander] LM Studio HTTP ${response.status} for model ${model}`,
		);
		return { expanded: query, keywords: [], hyde: undefined };
	}

	const data = (await response.json()) as {
		choices?: Array<{ message?: { content?: string } }>;
	};
	const text = data.choices?.[0]?.message?.content ?? "";

	const lexMatch = text.match(/^lex:\s*(.+)$/m);
	const vecMatch = text.match(/^vec:\s*(.+)$/m);
	const hydeMatch = text.match(/^hyde:\s*([\s\S]+?)(?=\n(?:lex|vec):|$)/m);

	return {
		expanded: vecMatch?.[1]?.trim() ?? query,
		keywords: lexMatch?.[1]?.split(",").map((k) => k.trim()) ?? [],
		hyde: hydeMatch?.[1]?.trim(),
	};
}

/** Build an ExpanderFunction for a given condition's expanderModel field. */
function makeExpanderFn(expanderModel: string): ExpanderFunction {
	const modelId = EXPANDER_MODELS[expanderModel] ?? expanderModel;
	return async (query: string) => callExpander(query, modelId);
}

// ============================================================================
// Reranker implementation
// ============================================================================

async function rerank(
	results: SearchResult[],
	query: string,
): Promise<SearchResult[]> {
	if (results.length <= 1) return results;

	const toRerank = results.slice(0, 20);
	const rest = results.slice(20);

	const candidateText = toRerank
		.map((r, i) => `[${i + 1}] ${r.docId}\n${r.snippet?.slice(0, 150) ?? ""}`)
		.join("\n\n");

	let response: Response;
	try {
		response = await fetch(LM_STUDIO_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: RERANKER_MODEL,
				messages: [
					{
						role: "system",
						content:
							"Rate each code search result's relevance to the query. Output ONLY a JSON array of numbers from 0-10, one per candidate, in order. Example: [8, 3, 7, 1, 5]",
					},
					{
						role: "user",
						content: `Query: "${query}"\n\nCandidates:\n${candidateText}`,
					},
				],
				temperature: 0.0,
				max_tokens: 100,
			}),
		});
	} catch (err) {
		console.warn(`  [reranker] LM Studio unreachable: ${err}`);
		return results;
	}

	if (!response.ok) {
		console.warn(`  [reranker] LM Studio HTTP ${response.status}`);
		return results;
	}

	const data = (await response.json()) as {
		choices?: Array<{ message?: { content?: string } }>;
	};
	const text = data.choices?.[0]?.message?.content ?? "[]";

	const scoresMatch = text.match(/\[[\d,\s.]+\]/);
	const scores: number[] = scoresMatch
		? (JSON.parse(scoresMatch[0]) as number[])
		: [];

	const reranked = toRerank.map((r, i) => ({
		...r,
		// 70% LLM score, 30% original retrieval score
		score: r.score * 0.3 + ((scores[i] ?? 5) / 10) * 0.7,
	}));

	reranked.sort((a, b) => b.score - a.score);
	return [...reranked, ...rest];
}

const rerankerFn: RerankerFunction = rerank;

// ============================================================================
// Regex router implementation
// ============================================================================

const regexRouterFn: RouterFunction = async (query) => {
	return classifyQueryType(query);
};

// ============================================================================
// QMD search functions (calls `qmd` CLI as subprocess)
// ============================================================================

/**
 * Convert QMD virtual path to real filesystem relative path.
 *
 * QMD normalizes paths: underscores → hyphens, __init__.py → init.py.
 * We reverse those transformations so the docId matches groundTruthFiles.
 */
function qmdPathToRelative(qmdPath: string, repoDir: string): string {
	// Strip qmd://collection/ prefix
	const match = qmdPath.match(/^qmd:\/\/[^/]+\/(.+)$/);
	const virtualPath = match ? match[1] : qmdPath;

	// QMD converts _ to - and __init__ to init in paths.
	// We need to reverse this to match filesystem paths.
	// Strategy: split into segments, for each segment try hyphen→underscore,
	// and for "init.py" try "__init__.py".
	const segments = virtualPath.split("/");
	const resolved: string[] = [];

	for (let i = 0; i < segments.length; i++) {
		let seg = segments[i];
		const isLast = i === segments.length - 1;

		// For the filename, check if "init.py" should be "__init__.py"
		if (isLast && seg === "init.py") {
			const candidatePath = [...resolved, "__init__.py"].join("/");
			if (existsSync(`${repoDir}/${candidatePath}`)) {
				seg = "__init__.py";
			}
		}

		// Replace hyphens with underscores if the underscore version exists on disk
		if (seg.includes("-")) {
			const underscored = seg.replace(/-/g, "_");
			const candidatePath = [...resolved, underscored].join("/");
			if (existsSync(`${repoDir}/${candidatePath}`)) {
				seg = underscored;
			}
		}

		resolved.push(seg);
	}

	return resolved.join("/");
}

/** Parse QMD JSON output into SearchResult[] */
function parseQmdResults(jsonStr: string, repoDir: string): SearchResult[] {
	const items = JSON.parse(jsonStr) as Array<{
		docid: string;
		score: number;
		file: string;
		title: string;
		snippet: string;
	}>;
	return items.map((item) => ({
		docId: qmdPathToRelative(item.file, repoDir),
		score: item.score,
		snippet: item.snippet?.slice(0, 200),
	}));
}

// QMD CLI path — resolve once so we can call via `node` directly.
// QMD's launcher script detects $BUN_INSTALL and runs under Bun, which
// breaks sqlite-vec (Bun's SQLite lacks loadExtension on macOS).
// Running via Node uses better-sqlite3 which supports extensions.
const QMD_CLI_PATH = (() => {
	try {
		const whichProc = Bun.spawnSync(["which", "qmd"], { stdout: "pipe" });
		const qmdBin = new TextDecoder().decode(whichProc.stdout).trim();
		if (!qmdBin) return null;
		// Follow symlinks to find the real package dir
		const realBin = Bun.spawnSync(["readlink", "-f", qmdBin], { stdout: "pipe" });
		const realPath = new TextDecoder().decode(realBin.stdout).trim();
		// The bin script is at .../bin/qmd, the JS entry is at .../dist/cli/qmd.js
		const pkgDir = realPath.replace(/\/bin\/qmd$/, "");
		const jsPath = `${pkgDir}/dist/cli/qmd.js`;
		if (existsSync(jsPath)) return jsPath;
		// Fallback: check common npm global install path
		return null;
	} catch {
		return null;
	}
})();

/** Create a QMD search function (BM25-only or hybrid query) */
function makeQmdSearchFn(mode: "search" | "query"): SearchFunction {
	return async (query, opts) => {
		const cmd = mode === "search" ? "search" : "query";

		let spawnCmd: string[];
		if (QMD_CLI_PATH) {
			// Run via Node to get sqlite-vec support (better-sqlite3 + loadExtension)
			spawnCmd = ["node", QMD_CLI_PATH, cmd, query, "--json", "-n", String(opts.k), "-c", QMD_COLLECTION];
		} else {
			// Fallback: use qmd wrapper (may run under Bun without sqlite-vec)
			spawnCmd = ["qmd", cmd, query, "--json", "-n", String(opts.k), "-c", QMD_COLLECTION];
		}
		// Limit reranking candidates for query mode to keep latency reasonable
		if (mode === "query") spawnCmd.push("-C", "10");
		const proc = Bun.spawn(spawnCmd, { stdout: "pipe", stderr: "pipe" });
		const stdout = await new Response(proc.stdout).text();
		const stderr = await new Response(proc.stderr).text();
		const exitCode = await proc.exited;

		if (exitCode !== 0) {
			if (verbose)
				console.warn(
					`  [qmd ${cmd}] exit ${exitCode}: ${stderr.slice(0, 200)}`,
				);
			return [];
		}

		// QMD may print warnings before the JSON array; find the JSON part
		const jsonStart = stdout.indexOf("[");
		if (jsonStart === -1) return [];

		try {
			return parseQmdResults(stdout.slice(jsonStart), repoPath);
		} catch {
			if (verbose) console.warn(`  [qmd ${cmd}] failed to parse JSON`);
			return [];
		}
	};
}

const QMD_CONDITIONS = new Set(["Q1", "Q2"]);

// ============================================================================
// SINGLE-CONDITION MODE  (called by orchestrator subprocess)
// ============================================================================

if (singleCondition !== undefined) {
	// Find the condition definition
	const condition = STANDARD_CONDITIONS.find((c) => c.name === singleCondition);
	if (!condition) {
		console.error(`Unknown condition: ${singleCondition}`);
		process.exit(1);
	}

	// Load symbols for both modes (used as basis + for symbol queries in mixed mode)
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

	// Build queries based on query mode
	let queries: HarnessQuery[];

	if (queryMode === "mixed") {
		// Mixed queries: 10 symbol_lookup + 10 semantic_search + 10 exploratory
		// Use top symbols for symbol queries, generate realistic natural-language
		// queries for semantic and exploratory types
		const symbolQueries: HarnessQuery[] = topSymbols
			.slice(0, 10)
			.map((sym, idx) => ({
				id: `sym-${String(idx + 1).padStart(3, "0")}-${sym.name}`,
				codeUnitId: `${sym.filePath}::${sym.name}`,
				type: "doc_api_lookup" as QueryType,
				query: sym.name,
				shouldFind: true,
				routerLabel: "symbol_lookup" as const,
				groundTruthFiles: [sym.filePath],
			}));

		// Semantic queries: realistic bug-report / behavior questions using top symbols
		const semanticTemplates = [
			{
				q: "how does error handling work in the server",
				gt: "src/fastmcp/server/server.py",
			},
			{
				q: "authentication middleware implementation",
				gt: "src/fastmcp/server/middleware/__init__.py",
			},
			{
				q: "how are tools registered and called",
				gt: "src/fastmcp/tools/tool_manager.py",
			},
			{
				q: "resource template URI matching logic",
				gt: "src/fastmcp/resources/template.py",
			},
			{
				q: "client session and connection handling",
				gt: "src/fastmcp/client/client.py",
			},
			{ q: "prompt message rendering", gt: "src/fastmcp/prompts/prompt.py" },
			{
				q: "how does the CLI parse server arguments",
				gt: "src/fastmcp/cli/run.py",
			},
			{ q: "exception types and error codes", gt: "src/fastmcp/exceptions.py" },
			{
				q: "openapi schema conversion to json schema",
				gt: "src/fastmcp/experimental/utilities/openapi/__init__.py",
			},
			{
				q: "background task execution and progress tracking",
				gt: "src/fastmcp/server/server.py",
			},
		];

		const semanticQueries: HarnessQuery[] = semanticTemplates.map((t, idx) => ({
			id: `sem-${String(idx + 1).padStart(3, "0")}`,
			codeUnitId: t.gt,
			type: "specific_behavior" as QueryType,
			query: t.q,
			shouldFind: true,
			routerLabel: "semantic_search" as const,
			groundTruthFiles: [t.gt],
		}));

		// Exploratory queries: conceptual "how to" questions
		const exploratoryTemplates = [
			{
				q: "how to create a custom MCP server with FastMCP",
				gt: "src/fastmcp/server/server.py",
			},
			{
				q: "best practices for defining tools",
				gt: "src/fastmcp/tools/tool.py",
			},
			{
				q: "setting up OAuth authentication",
				gt: "src/fastmcp/server/auth/__init__.py",
			},
			{
				q: "configuring server middleware",
				gt: "src/fastmcp/server/middleware/__init__.py",
			},
			{
				q: "working with resources and templates",
				gt: "src/fastmcp/resources/__init__.py",
			},
			{ q: "how to mount sub-servers", gt: "src/fastmcp/server/server.py" },
			{ q: "setting up SSE transport", gt: "src/fastmcp/server/http.py" },
			{
				q: "implementing sampling handlers",
				gt: "src/fastmcp/experimental/sampling/__init__.py",
			},
			{
				q: "using providers pattern in server",
				gt: "src/fastmcp/server/providers/__init__.py",
			},
			{ q: "dependency injection in tools", gt: "src/fastmcp/dependencies.py" },
		];

		const exploratoryQueries: HarnessQuery[] = exploratoryTemplates.map(
			(t, idx) => ({
				id: `exp-${String(idx + 1).padStart(3, "0")}`,
				codeUnitId: t.gt,
				type: "doc_conceptual" as QueryType,
				query: t.q,
				shouldFind: true,
				routerLabel: "exploratory" as const,
				groundTruthFiles: [t.gt],
			}),
		);

		queries = [...symbolQueries, ...semanticQueries, ...exploratoryQueries];
		if (verbose) {
			console.log(
				`Mixed query set: ${symbolQueries.length} symbol + ${semanticQueries.length} semantic + ${exploratoryQueries.length} exploratory = ${queries.length} total`,
			);
		}
	} else {
		// Default: symbol-only queries from PageRank
		queries = topSymbols.map((sym, idx) => {
			const queryId = `sym-${String(idx + 1).padStart(3, "0")}-${sym.name}`;
			return {
				id: queryId,
				codeUnitId: `${sym.filePath}::${sym.name}`,
				type: "doc_api_lookup" as QueryType,
				query: sym.name,
				shouldFind: true,
				routerLabel: "symbol_lookup" as const,
				groundTruthFiles: [sym.filePath],
			};
		});
	}

	// QMD conditions use QMD CLI — no claudemem indexer needed
	const isQmd = QMD_CONDITIONS.has(condition.name);

	let searchFn: SearchFunction;
	let indexer: Awaited<ReturnType<typeof createIndexer>> | undefined;

	// Cap search limit to reduce LanceDB memory pressure.
	// LanceDB's Rust NAPI bindings accumulate ~15MB RSS per search; at k=100
	// with 30 queries the process hits ~0.6GB and gets SIGKILL.
	// k=20 is sufficient for MRR@10/NDCG@10 and keeps RSS manageable.
	const SEARCH_LIMIT = 20;

	if (isQmd) {
		const mode = condition.name === "Q1" ? "search" : "query";
		searchFn = makeQmdSearchFn(mode as "search" | "query");
	} else {
		indexer = createIndexer({ projectPath: repoPath });
		const repoPrefixWithSlash = repoPath.endsWith("/")
			? repoPath
			: `${repoPath}/`;

		const baseSearchFn: SearchFunction = async (query, opts) => {
			const results = await indexer!.search(query, {
				limit: Math.min(opts.k, SEARCH_LIMIT),
				useCase: "search",
			});
			return results.map((r) => {
				const filePath = r.chunk.filePath.startsWith(repoPrefixWithSlash)
					? r.chunk.filePath.slice(repoPrefixWithSlash.length)
					: r.chunk.filePath;
				return {
					docId: filePath,
					score: r.score,
					snippet: r.chunk.content.slice(0, 200),
				};
			});
		};

		const routerAwareSearchFn: SearchFunction = async (query, opts) => {
			const useKeyword = opts.routerLabel === "symbol_lookup";
			const results = await indexer!.search(query, {
				limit: Math.min(opts.k, SEARCH_LIMIT),
				useCase: "search",
				keywordOnly: useKeyword,
			});
			return results.map((r) => {
				const filePath = r.chunk.filePath.startsWith(repoPrefixWithSlash)
					? r.chunk.filePath.slice(repoPrefixWithSlash.length)
					: r.chunk.filePath;
				return {
					docId: filePath,
					score: r.score,
					snippet: r.chunk.content.slice(0, 200),
				};
			});
		};

		searchFn = condition.useRouter ? routerAwareSearchFn : baseSearchFn;
	}

	const routerFnForCondition: RouterFunction | undefined = condition.useRouter
		? regexRouterFn
		: undefined;
	const expanderFnForCondition: ExpanderFunction | undefined =
		condition.useExpander && condition.expanderModel
			? makeExpanderFn(condition.expanderModel)
			: undefined;
	const rerankerFnForCondition: RerankerFunction | undefined =
		condition.useReranker ? rerankerFn : undefined;

	await mkdir(outputDir, { recursive: true });

	const result = await runCondition(condition, {
		conditions: [condition],
		querySet: queries,
		outputDir,
		kValues: [1, 5, 10, 20],
		verbose,
		searchFn,
		...(routerFnForCondition !== undefined
			? { routerFn: routerFnForCondition }
			: {}),
		...(expanderFnForCondition !== undefined
			? { expanderFn: expanderFnForCondition }
			: {}),
		...(rerankerFnForCondition !== undefined
			? { rerankerFn: rerankerFnForCondition }
			: {}),
	});

	if (indexer) await indexer.close();

	// Print summary line for orchestrator to parse
	const m = result.metrics;
	const l = result.latency;
	console.log(
		`CONDITION_DONE ${condition.name} MRR=${m.mrrAt10.toFixed(3)} NDCG10=${m.ndcgAt10.toFixed(3)} RECALL=${m.recallAt100.toFixed(3)} P95=${Math.round(l.p95)}`,
	);

	process.exit(0);
}

// ============================================================================
// ORCHESTRATOR MODE  (default — spawns one subprocess per condition)
// ============================================================================

// Parse --conditions flag
const conditionsArg = (args.conditions as string)
	.split(",")
	.map((s) => s.trim());

const conditionsToRun = conditionsArg
	.map((name) => {
		if (SKIP_CONDITIONS.has(name)) {
			console.log(
				`Skipping condition ${name} (not available — ${name === "B2" ? "no CNN model" : "not built"})`,
			);
			return null;
		}
		const cond = STANDARD_CONDITIONS.find((c) => c.name === name);
		if (!cond) {
			console.warn(`Unknown condition "${name}" — skipping.`);
			return null;
		}
		return cond;
	})
	.filter((c) => c !== null);

if (conditionsToRun.length === 0) {
	console.error("No valid conditions to run.");
	process.exit(1);
}

await mkdir(outputDir, { recursive: true });

// Resolve the script path for subprocess invocation
const scriptPath = new URL(import.meta.url).pathname;

console.log(`Repo:       ${repoPath}`);
console.log(`Symbols:    top ${symbolLimit} by PageRank`);
console.log(`Output:     ${outputDir}`);
console.log(`Conditions: ${conditionsToRun.map((c) => c.name).join(", ")}`);
console.log();
console.log(
	`Running ${conditionsToRun.length} condition(s) sequentially (each in a fresh subprocess):`,
);
console.log();

const allResults: ConditionResult[] = [];

for (const condition of conditionsToRun) {
	console.log(`[${condition.name}] ${condition.description} ...`);

	// Build subprocess arguments
	const subArgs = [
		scriptPath,
		"--single-condition",
		condition.name,
		"--repo",
		repoName,
		"--limit",
		String(symbolLimit),
		"--output",
		outputDir,
		"--eval-repos-dir",
		evalReposDir,
		"--qmd-collection",
		QMD_COLLECTION,
		"--query-mode",
		queryMode,
	];
	if (verbose) subArgs.push("--verbose");

	// Spawn the subprocess
	const proc = Bun.spawn(["bun", ...subArgs], {
		stdout: "pipe",
		stderr: "pipe",
	});

	const stdout = await new Response(proc.stdout).text();
	const stderr = await new Response(proc.stderr).text();
	const exitCode = await proc.exited;

	if (exitCode !== 0) {
		console.error(
			`  ERROR: condition ${condition.name} exited with code ${exitCode}`,
		);
		if (stderr) console.error(`  stderr: ${stderr.slice(0, 500)}`);
		console.error(`  stdout: ${stdout.slice(0, 500)}`);
		continue;
	}

	// Print subprocess output (verbose lines from inner process)
	if (verbose) {
		for (const line of stdout.split("\n")) {
			if (!line.startsWith("CONDITION_DONE")) {
				process.stdout.write(`  ${line}\n`);
			}
		}
	}

	// Parse the summary line
	const summaryLine = stdout
		.split("\n")
		.find((l) => l.startsWith("CONDITION_DONE"));
	if (summaryLine) {
		const mrrMatch = summaryLine.match(/MRR=([\d.]+)/);
		const ndcg10Match = summaryLine.match(/NDCG10=([\d.]+)/);
		const recallMatch = summaryLine.match(/RECALL=([\d.]+)/);
		const p95Match = summaryLine.match(/P95=(\d+)/);
		const mrr = Number.parseFloat(mrrMatch?.[1] ?? "0");
		const ndcg10 = Number.parseFloat(ndcg10Match?.[1] ?? "0");
		const recall = Number.parseFloat(recallMatch?.[1] ?? "0");
		const p95 = Number.parseInt(p95Match?.[1] ?? "0", 10);
		console.log(
			`  -> MRR@10=${mrr.toFixed(3)}  NDCG@10=${ndcg10.toFixed(3)}  Recall@100=${recall.toFixed(3)}  P95=${p95}ms`,
		);
	}

	// Load the condition result JSON written by the subprocess
	const conditionJsonPath = `${outputDir}/condition_${condition.name}.json`;
	if (existsSync(conditionJsonPath)) {
		const raw = await readFile(conditionJsonPath, "utf8");
		const result = JSON.parse(raw) as ConditionResult;
		allResults.push(result);
		console.log(`     Loaded: ${conditionJsonPath}`);
	} else {
		console.warn(
			`  WARNING: ${conditionJsonPath} not found after subprocess completed`,
		);
	}

	console.log();
}

// ============================================================================
// Generate the full comparison report from all loaded results
// ============================================================================

if (allResults.length > 0) {
	const reportPath = `${outputDir}/report.md`;
	await generateReport(allResults, reportPath);

	// Print final summary table
	console.log("=== Full Ablation Results ===\n");
	console.log(
		`${"Condition".padEnd(10)}${"Description".padEnd(36)}${"MRR@10".padEnd(10)}${"NDCG@10".padEnd(10)}${"Recall@100".padEnd(12)}P95`,
	);
	console.log("-".repeat(84));

	for (const r of allResults) {
		const m = r.metrics;
		const l = r.latency;
		console.log(
			`${r.condition.name.padEnd(10)}${r.condition.description.slice(0, 34).padEnd(36)}${m.mrrAt10.toFixed(3).padEnd(10)}${m.ndcgAt10.toFixed(3).padEnd(10)}${m.recallAt100.toFixed(3).padEnd(12)}${Math.round(l.p95)}ms`,
		);
	}

	console.log(`\nReport:  ${reportPath}`);
	console.log(`Results: ${outputDir}/`);
} else {
	console.error("No conditions completed successfully.");
	process.exit(1);
}
