/**
 * Search Tool
 *
 * Semantic + BM25 hybrid code search.
 * Auto-indexes changed files incrementally before searching.
 * When cloud deps are available (deps.cloudClient), uses CloudAwareSearch
 * which merges cloud index results with local overlay results for dirty files.
 * Cloud errors are returned directly — no silent fallback to local search.
 *
 * Local search uses PipelineOrchestrator: parallel backends (symbol-graph,
 * semantic, location, tree-sitter, LSP) merged via RRF.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
	createCloudAwareSearch,
	createGitDiffChangeDetector,
} from "../../cloud/index.js";
import { resolveBranchScopeForProject } from "../../core/branch-scope.js";
import { createEmbeddingsClient } from "../../core/embeddings.js";
import {
	createIndexer,
	IndexedModelUnavailableError,
} from "../../core/indexer.js";
import { getParserManager } from "../../parsers/parser-manager.js";
import { LocationBackend } from "../../retrieval/backends/location.js";
import { LspBackend } from "../../retrieval/backends/lsp.js";
import { SemanticBackend } from "../../retrieval/backends/semantic.js";
import { SymbolGraphBackend } from "../../retrieval/backends/symbol-graph.js";
import { TreeSitterBackend } from "../../retrieval/backends/tree-sitter.js";
import { loadPipelineConfig } from "../../retrieval/pipeline/config.js";
import type { SymbolGraphProvider } from "../../retrieval/pipeline/graph-ppr.js";
import type { FileBoostProvider } from "../../retrieval/pipeline/learned-boosts.js";
import { PipelineOrchestrator } from "../../retrieval/pipeline/orchestrator.js";
import type { MergedResult } from "../../retrieval/pipeline/types.js";
import { QueryRouter } from "../../retrieval/routing/query-router.js";
import { buildIndexState } from "../index-state.js";
import type { ToolDeps } from "./deps.js";
import {
	buildFreshness,
	errorResponse,
	getLearnedFileBoosts,
	openToolSession,
	recordSearchInteraction,
} from "./deps.js";

export function registerSearchTools(server: McpServer, deps: ToolDeps): void {
	const { stateManager, config, logger } = deps;

	server.tool(
		"search",
		"Semantic + BM25 hybrid code search. Auto-indexes changed files before searching.",
		{
			query: z
				.string()
				.min(2)
				.max(500)
				.describe("Natural language or code search query"),
			limit: z
				.number()
				.min(1)
				.max(50)
				.default(10)
				.describe("Maximum number of results (default: 10)"),
			filePattern: z
				.string()
				.optional()
				.describe("Glob pattern to filter results by file path"),
		},
		async ({ query, limit, filePattern }) => {
			const startTime = Date.now();

			try {
				// ── Cloud-aware search (when cloud deps are wired in) ───────────
				if (
					deps.cloudClient &&
					deps.overlayIndex &&
					deps.currentCommitSha &&
					deps.teamConfig
				) {
					try {
						const embeddingsClient = createEmbeddingsClient();
						const changeDetector = createGitDiffChangeDetector(
							config.workspaceRoot,
						);

						// Derive repo slug from teamConfig
						const orgSlug = deps.teamConfig.orgSlug;
						const repoSlug =
							deps.teamConfig.repoSlug ??
							`${orgSlug}/${
								config.workspaceRoot.split("/").filter(Boolean).pop() ?? "repo"
							}`;

						const cloudSearch = createCloudAwareSearch({
							projectPath: config.workspaceRoot,
							cloudClient: deps.cloudClient,
							overlayIndex: deps.overlayIndex,
							changeDetector,
							embeddingsClient,
							repoSlug,
							commitSha: deps.currentCommitSha,
						});

						const results = await cloudSearch.search(query, {
							limit: limit ?? 10,
						});

						// Apply file pattern filter if provided
						const filtered = filePattern
							? results.filter((r) => {
									const pat = filePattern
										.replace(/\*\*/g, ".*")
										.replace(/\*/g, "[^/]*");
									return new RegExp(pat).test(r.chunk.filePath);
								})
							: results;

						const resultItems = filtered.map((r) => ({
							file: r.chunk.filePath,
							line: r.chunk.startLine,
							lineEnd: r.chunk.endLine,
							symbol: r.chunk.name ?? null,
							snippet: r.chunk.content.slice(0, 800),
							score: r.score,
							source: (r as { source?: string }).source ?? "cloud",
						}));

						// Compute index state at the return point (A2), after any
						// state-mutating work above, immediately before stringify.
						const indexState = await buildIndexState(deps, startTime);

						return {
							content: [
								{
									type: "text" as const,
									text: JSON.stringify({
										results: resultItems,
										totalMatches: resultItems.length,
										autoIndexed: 0,
										...buildFreshness(stateManager, startTime),
										...indexState,
									}),
								},
							],
						};
					} catch (cloudErr) {
						return errorResponse(cloudErr);
					}
				}

				// ── Local search (pipeline path) ──────────────────────────────────
				const indexer = createIndexer({
					projectPath: config.workspaceRoot,
				});

				// Incremental auto-index of changed files
				let autoIndexed = 0;
				try {
					const indexResult = await indexer.index(false);
					autoIndexed = indexResult.filesIndexed;
					if (autoIndexed > 0) {
						logger.info(`search: auto-indexed ${autoIndexed} changed files`);
					}
					// The tool passes no onProgress, so the indexer's own notice goes
					// nowhere. Say it here instead — via the logger, which writes to
					// stderr; stdout is the JSON-RPC stream.
					if (indexResult.adoptedIndexedModel) {
						logger.warn(
							`search: using ${indexResult.embeddingModel} — the model this index was built with — ` +
								`instead of the configured ${indexResult.configuredModel}. ` +
								`Run 'mnemex index --force' to rebuild with the configured model.`,
						);
					}
				} catch (indexErr) {
					// One auto-index failure is NOT non-fatal: when the index was
					// built by a model that cannot be reached, there is no vector
					// space to search. Falling through would embed the query with a
					// different model and return ranked nonsense — silently, whenever
					// the two dimensions happen to agree. Surface it instead.
					if (indexErr instanceof IndexedModelUnavailableError) {
						throw indexErr;
					}
					// Everything else: proceed with the existing index.
					logger.warn(
						"search: auto-index failed, searching existing index",
						indexErr,
					);
				}

				// Build pipeline
				const pipelineConfig = loadPipelineConfig();

				// Use no-LLM router (rule-based only, <1ms)
				const router = new QueryRouter(null, { useLLM: false });

				// Build backends
				const backends = [];

				// Symbol-graph backend (requires graph manager from cache)
				if (pipelineConfig.backends.symbolGraph) {
					try {
						const { graphManager } = await deps.cache.get();
						backends.push(
							new SymbolGraphBackend(graphManager, config.workspaceRoot),
						);
					} catch {
						// Graph not available — skip
					}
				}

				// Semantic backend (wraps indexer)
				if (pipelineConfig.backends.semantic) {
					backends.push(
						new SemanticBackend(() =>
							createIndexer({ projectPath: config.workspaceRoot }),
						),
					);
				}

				// Location backend (requires tracker from cache)
				if (pipelineConfig.backends.location) {
					try {
						const { tracker, branchId } = await deps.cache.get();
						backends.push(new LocationBackend(tracker, branchId));
					} catch {
						// Tracker not available — skip
					}
				}

				// Tree-sitter backend (requires tracker from cache)
				if (pipelineConfig.backends.treeSitter) {
					try {
						const { tracker, branchId } = await deps.cache.get();
						const parserManager = getParserManager();
						backends.push(
							new TreeSitterBackend(
								parserManager,
								tracker,
								branchId,
								config.workspaceRoot,
								pipelineConfig.treeSitterConfig.maxFilesToScan,
							),
						);
					} catch {
						// Not available — skip
					}
				}

				// LSP backend (optional — only when lspManager is available)
				if (pipelineConfig.backends.lsp && deps.lspManager) {
					try {
						const { graphManager } = await deps.cache.get();
						backends.push(
							new LspBackend(
								deps.lspManager,
								graphManager,
								config.workspaceRoot,
							),
						);
					} catch {
						// Not available — skip
					}
				}

				// Symbol graph for query-seeded Personalized PageRank.
				//
				// GATED FIRST, FETCHED SECOND: the walk is off by default, and a
				// feature that is off must cost nothing — so the config decides
				// before `cache.get()` is ever reached. Same discipline as the
				// learning gate, which opens no database when learning is off.
				//
				// `ReferenceGraphManager` satisfies `SymbolGraphView` structurally;
				// the pipeline never imports it. Acquisition failures degrade to
				// "no provider" exactly like the optional backends above — a
				// missing or unbuilt symbol graph must never fail a search.
				let graphProvider: SymbolGraphProvider | undefined;
				if (pipelineConfig.personalizedPageRank.enabled) {
					try {
						const { graphManager } = await deps.cache.get();
						graphProvider = () => graphManager;
					} catch {
						// Graph not available — search runs without the walk
					}
				}

				// Learned per-file boosts and feedback recording — same source as
				// the legacy search_code tool so both retrieval paths rank
				// identically. Learning is opt-in and off by default: when it is
				// off `openToolSession` opens no database at all, and the boost
				// provider stays silently null.
				//
				// ONE session for the whole request: the boost provider (during
				// the search) and recordSearch (after it) share a single
				// connection, closed exactly once in the finally below.
				const learningSession = openToolSession(config.workspaceRoot);
				let mergedResults: MergedResult[];
				try {
					const boostProvider: FileBoostProvider = () =>
						getLearnedFileBoosts(learningSession, "search");

					const orchestrator = new PipelineOrchestrator(
						router,
						backends,
						pipelineConfig,
						boostProvider,
						graphProvider,
					);

					mergedResults = await orchestrator.search(query, {
						limit: limit ?? 10,
						filePattern,
					});

					await indexer.close();

					// Feed the same learning loop as search_code so both tools
					// contribute to (and benefit from) one feedback history.
					recordSearchInteraction(learningSession, {
						query,
						sessionId: `mcp_${Date.now()}`,
						resultCount: mergedResults.length,
						useCase: "search",
					});
				} finally {
					learningSession.close();
				}

				const resultItems = mergedResults.map((r) => ({
					file: r.file,
					line: r.startLine,
					lineEnd: r.endLine,
					symbol: r.symbol ?? null,
					snippet: r.snippet,
					score: r.rrfScore === Number.POSITIVE_INFINITY ? 1.0 : r.rrfScore,
					backend: r.backends.join("+"),
				}));

				// D1's response-level flag on the pipeline path too (§4.4.2).
				//
				// Resolved DIRECTLY, not through `deps.cache`: this is a HEAD read
				// plus a `branches.json` read, and routing it through the cache
				// would open `index.db` on every search even when no backend needs
				// it — the cost `buildIndexState` already avoids, and the thing
				// `ppr-wiring.test.ts` attributes `cache.get()` counts by.
				//
				// Per-ROW attribution is not available on this path: `MergedResult`
				// is the backends' common shape and carries no branch ids — the
				// semantic backend has them, the tree-sitter and location backends
				// read files rather than rows. The `search_code` tool, which D1
				// names, carries both.
				const branch = resolveBranchScopeForProject(config.workspaceRoot);
				const branchState = {
					branch_unknown: branch.branchUnknown,
					branch: branch.label,
				};

				// Compute index state AFTER the indexer.index(false) auto-index above,
				// at the return point (A2) — auto-index can change freshness.
				const indexState = await buildIndexState(deps, startTime);

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								results: resultItems,
								totalMatches: resultItems.length,
								autoIndexed,
								...buildFreshness(stateManager, startTime),
								...indexState,
								...branchState,
							}),
						},
					],
				};
			} catch (err) {
				return errorResponse(err);
			}
		},
	);
}
