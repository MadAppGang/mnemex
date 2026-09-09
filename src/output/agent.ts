/**
 * Agent Output Module
 *
 * Provides clean, machine-readable key=value output for all mnemex commands.
 * No ANSI codes, no animations, no colors. Structured for line-by-line parsing by AI agents.
 *
 * Format: `key=value` lines, one per field. Multi-item collections use repeated prefixed lines.
 *
 * Example:
 *   indexed_files=42
 *   chunks_created=310
 *   duration_ms=3200
 */

import type {
	EnrichedIndexResult,
	IndexStatus,
	RepoMapEntry,
	SearchResult,
	SymbolDefinition,
} from "../types.js";

// ============================================================================
// Agent Output Functions
// ============================================================================

/**
 * Output for the `index` command: completion summary.
 * No output during indexing progress - only the final result.
 */
function indexComplete(result: EnrichedIndexResult): void {
	console.log(`indexed_files=${result.filesIndexed}`);
	console.log(`chunks_created=${result.chunksCreated}`);
	console.log(`duration_ms=${result.durationMs}`);
	if (result.cost !== undefined) {
		console.log(`cost_usd=${result.cost.toFixed(6)}`);
	}
	if (result.enrichment) {
		console.log(`enrichment_docs=${result.enrichment.documentsCreated}`);
		if (result.enrichment.llmCalls) {
			console.log(`enrichment_llm_calls=${result.enrichment.llmCalls.total}`);
		}
		if (result.enrichment.cost !== undefined) {
			console.log(`enrichment_cost_usd=${result.enrichment.cost.toFixed(6)}`);
		}
	}
	if (result.embeddingModel) {
		console.log(`embedding_model=${result.embeddingModel}`);
	}
	// Emitted only when the model came from the index rather than from config,
	// so a machine consumer can tell "as configured" from "silently substituted"
	// without diffing against its own config.
	if (result.adoptedIndexedModel) {
		console.log("embedding_model_adopted=true");
		if (result.configuredModel) {
			console.log(`configured_model=${result.configuredModel}`);
		}
	}
	// The embedding cache's own accounting. Emitted whenever the seam ran at
	// all, INCLUDING `tier=none` (the user's opt-out) and `tier=l0` (degraded to
	// in-process only): a consumer comparing a cached run against a control run
	// has to be able to tell "the cache was off" from "the field is missing
	// because this build has no cache".
	//
	// Corroboration, never proof. A cache that wrongly reported a hit would
	// report it here too — the count that settles it is the provider's own
	// request log, plus `cost`/`total_tokens` above, which the cache cannot
	// fabricate.
	if (result.embedCache) {
		console.log(`embed_cache_tier=${result.embedCache.tier}`);
		console.log(`embed_cache_hits=${result.embedCache.hits}`);
		console.log(`embed_cache_misses=${result.embedCache.misses}`);
		console.log(`embed_cache_writes=${result.embedCache.writes}`);
	}
	// The AUTHORITATIVE upgrade channel (§5.3): two of the four entry points
	// that call index() render no progress at all, so the `[migrating]` notice
	// reaches nobody there. A machine consumer that sees this knows the run
	// rebuilt from scratch and re-embedded the whole repository once.
	if (result.upgradedFromIndexVersion !== undefined) {
		console.log(
			`upgraded_from_index_version=${result.upgradedFromIndexVersion}`,
		);
	}
	// Files whose rows were rolled back because at least one chunk came back
	// with no vector, and whose tracker stamp was withheld so the next run
	// redoes them. Silence here means every file that was indexed is in the
	// store.
	if (result.filesDeferred && result.filesDeferred.length > 0) {
		console.log(`files_deferred=${result.filesDeferred.length}`);
		for (const file of result.filesDeferred) {
			console.log(`deferred_file=${file}`);
		}
	}
	if (result.errors.length > 0) {
		console.log(`errors=${result.errors.length}`);
	}
}

/**
 * Output for the `search` command: results as structured key=value lines.
 * One header block followed by result lines.
 */
function searchResults(
	query: string,
	results: SearchResult[],
	meta?: { embeddingModel?: string; configuredModel?: string },
): void {
	console.log(`query=${query}`);
	console.log(`result_count=${results.length}`);
	// Only present when the query was embedded with the model the INDEX was
	// built with rather than the configured one. An agent that gets results back
	// otherwise has no way to know a different model answered.
	if (meta?.embeddingModel) {
		console.log(`embedding_model=${meta.embeddingModel}`);
		console.log("embedding_model_adopted=true");
		if (meta.configuredModel) {
			console.log(`configured_model=${meta.configuredModel}`);
		}
	}
	for (const r of results) {
		if (r.documentType === "session_observation") {
			const meta = r.observationMetadata || {};
			const files = (meta.affectedFiles as string[]) || [];
			console.log(
				`observation score=${r.score.toFixed(3)} type=${meta.observationType ?? "pattern"} confidence=${meta.confidence ?? 0.7} files=${files.join(",")} content=${r.chunk.content}`,
			);
		} else {
			let line = `result file=${r.chunk.filePath} line=${r.chunk.startLine} end_line=${r.chunk.endLine} score=${r.score.toFixed(3)} type=${r.chunk.chunkType} name=${r.chunk.name ?? ""}`;
			if (r.summary) {
				// Extract first sentence of summary for agent context
				const summaryMatch = r.summary.match(/Summary:\s*(.+?)(?:\n|$)/);
				if (summaryMatch) {
					line += ` summary=${summaryMatch[1].trim()}`;
				}
			}
			console.log(line);
		}
	}
}

/**
 * Output for the `map` command: repo structure as indented path lines.
 * Each file is a line followed by its symbols.
 */
function mapOutput(entries: RepoMapEntry[]): void {
	for (const entry of entries) {
		console.log(`file=${entry.filePath}`);
		for (const symbol of entry.symbols) {
			console.log(
				`symbol name=${symbol.name} kind=${symbol.kind} line=${symbol.line} rank=${symbol.pagerankScore.toFixed(4)}`,
			);
		}
	}
}

/**
 * Output for a single `symbol` lookup.
 */
function symbolOutput(symbol: SymbolDefinition): void {
	console.log(`symbol=${symbol.name}`);
	console.log(`file=${symbol.filePath}`);
	console.log(`line=${symbol.startLine}`);
	console.log(`end_line=${symbol.endLine}`);
	console.log(`type=${symbol.kind}`);
	console.log(`exported=${symbol.isExported}`);
	console.log(`pagerank=${symbol.pagerankScore.toFixed(4)}`);
	if (symbol.signature) {
		console.log(`signature=${symbol.signature}`);
	}
}

/**
 * Output for the `callers` command: list of symbols that call the target.
 */
function callersOutput(symbolName: string, callers: SymbolDefinition[]): void {
	console.log(`symbol=${symbolName}`);
	console.log(`caller_count=${callers.length}`);
	for (const caller of callers) {
		console.log(
			`caller name=${caller.name} file=${caller.filePath} line=${caller.startLine} kind=${caller.kind}`,
		);
	}
}

/**
 * Output for the `callees` command: list of symbols the target calls.
 */
function calleesOutput(symbolName: string, callees: SymbolDefinition[]): void {
	console.log(`symbol=${symbolName}`);
	console.log(`callee_count=${callees.length}`);
	for (const callee of callees) {
		console.log(
			`callee name=${callee.name} file=${callee.filePath} line=${callee.startLine} kind=${callee.kind}`,
		);
	}
}

/**
 * Output for the `context` command: symbol + callers + callees.
 */
function contextOutput(
	symbol: SymbolDefinition,
	callers: SymbolDefinition[],
	callees: SymbolDefinition[],
): void {
	console.log(`symbol=${symbol.name}`);
	console.log(`file=${symbol.filePath}`);
	console.log(`line=${symbol.startLine}`);
	console.log(`kind=${symbol.kind}`);
	console.log(`caller_count=${callers.length}`);
	for (const caller of callers) {
		console.log(
			`caller name=${caller.name} file=${caller.filePath} line=${caller.startLine}`,
		);
	}
	console.log(`callee_count=${callees.length}`);
	for (const callee of callees) {
		console.log(
			`callee name=${callee.name} file=${callee.filePath} line=${callee.startLine}`,
		);
	}
}

/**
 * Output for the `dead-code` command: list of potentially dead symbols.
 */
function deadCodeOutput(
	symbols: Array<{ symbol: SymbolDefinition; reason?: string }>,
): void {
	console.log(`dead_code_count=${symbols.length}`);
	for (const item of symbols) {
		console.log(
			`dead_symbol name=${item.symbol.name} file=${item.symbol.filePath} line=${item.symbol.startLine} kind=${item.symbol.kind} pagerank=${item.symbol.pagerankScore.toFixed(6)}`,
		);
	}
}

/**
 * Output for the `test-gaps` command: symbols needing test coverage.
 */
function testGapsOutput(
	results: Array<{ symbol: SymbolDefinition; callerCount: number }>,
): void {
	console.log(`test_gap_count=${results.length}`);
	for (const item of results) {
		console.log(
			`test_gap name=${item.symbol.name} file=${item.symbol.filePath} line=${item.symbol.startLine} kind=${item.symbol.kind} pagerank=${item.symbol.pagerankScore.toFixed(4)} callers=${item.callerCount}`,
		);
	}
}

/**
 * Output for the `impact` command: transitive callers of a symbol.
 */
function impactOutput(symbolName: string, affected: SymbolDefinition[]): void {
	console.log(`symbol=${symbolName}`);
	console.log(`affected_count=${affected.length}`);
	for (const sym of affected) {
		console.log(
			`affected name=${sym.name} file=${sym.filePath} line=${sym.startLine} kind=${sym.kind}`,
		);
	}
}

/**
 * Output for the `status` command: index status summary.
 */
function statusOutput(status: IndexStatus): void {
	console.log(`exists=${status.exists}`);
	if (status.exists) {
		console.log(`files=${status.totalFiles}`);
		console.log(`chunks=${status.totalChunks}`);
		console.log(`languages=${status.languages.join(",")}`);
		console.log(`model=${status.embeddingModel ?? "none"}`);
		if (status.lastUpdated) {
			console.log(`last_updated=${status.lastUpdated.toISOString()}`);
		}
	}
}

/**
 * Output for the `benchmark` command: embedding benchmark results.
 */
function benchmarkResults(
	results: Array<{
		model: string;
		speedMs: number;
		cost?: number;
		dimension: number;
		contextLength: number;
		chunks: number;
		ndcg: number;
		mrr: number;
		hitRate: { k1: number; k3: number; k5: number };
		error?: string;
	}>,
): void {
	console.log(`benchmark_count=${results.length}`);
	for (const r of results) {
		if (r.error) {
			console.log(`benchmark model=${r.model} error=${r.error}`);
		} else {
			console.log(
				`benchmark model=${r.model} speed_ms=${r.speedMs} cost=${r.model.startsWith("ollama/") || r.model.startsWith("lmstudio/") ? "FREE" : (r.cost?.toFixed(6) ?? "N/A")} dim=${r.dimension} ctx=${r.contextLength} ndcg=${r.ndcg.toFixed(1)} mrr=${r.mrr.toFixed(1)} hit_k5=${r.hitRate.k5.toFixed(1)}`,
			);
		}
	}
}

/**
 * Output for the `benchmark list` command: list of benchmark runs.
 */
function benchmarkList(
	runs: Array<{
		id: string;
		status: string;
		startedAt: string;
		completedAt?: string;
		totalModels: number;
	}>,
): void {
	console.log(`run_count=${runs.length}`);
	for (const run of runs) {
		console.log(
			`run id=${run.id} status=${run.status} started=${run.startedAt} models=${run.totalModels}`,
		);
	}
}

/**
 * Output for the `benchmark show` command: single benchmark run details.
 */
function benchmarkShow(run: {
	id: string;
	status: string;
	config: Record<string, unknown>;
	results: Array<Record<string, unknown>>;
}): void {
	console.log(`run_id=${run.id}`);
	console.log(`run_status=${run.status}`);
	console.log(`result_count=${run.results.length}`);
}

/**
 * Generic error output. Writes to stderr.
 */
function error(message: string): void {
	console.error(`error=${message}`);
}

/**
 * Generic success/info output.
 */
function success(message: string): void {
	console.log(`ok=${message}`);
}

// ============================================================================
// Exported Module
// ============================================================================

/**
 * Agent output functions for machine-readable CLI output.
 *
 * All functions write key=value lines to stdout (or stderr for errors).
 * No ANSI codes, no emoji, no animations. Designed for AI agent consumption.
 */
export const agentOutput = {
	indexComplete,
	searchResults,
	mapOutput,
	symbolOutput,
	callersOutput,
	calleesOutput,
	contextOutput,
	deadCodeOutput,
	testGapsOutput,
	impactOutput,
	statusOutput,
	benchmarkResults,
	benchmarkList,
	benchmarkShow,
	error,
	success,
};
