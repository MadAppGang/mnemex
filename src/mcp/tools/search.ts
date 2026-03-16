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
import { createEmbeddingsClient } from "../../core/embeddings.js";
import { createIndexer } from "../../core/indexer.js";
import { getParserManager } from "../../parsers/parser-manager.js";
import { LocationBackend } from "../../retrieval/backends/location.js";
import { LspBackend } from "../../retrieval/backends/lsp.js";
import { SemanticBackend } from "../../retrieval/backends/semantic.js";
import { SymbolGraphBackend } from "../../retrieval/backends/symbol-graph.js";
import { TreeSitterBackend } from "../../retrieval/backends/tree-sitter.js";
import { loadPipelineConfig } from "../../retrieval/pipeline/config.js";
import { PipelineOrchestrator } from "../../retrieval/pipeline/orchestrator.js";
import { QueryRouter } from "../../retrieval/routing/query-router.js";
import type { ToolDeps } from "./deps.js";
import { buildFreshness, errorResponse } from "./deps.js";

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

						return {
							content: [
								{
									type: "text" as const,
									text: JSON.stringify({
										results: resultItems,
										totalMatches: resultItems.length,
										autoIndexed: 0,
										...buildFreshness(stateManager, startTime),
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
				} catch (indexErr) {
					// Non-fatal: proceed with existing index
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
						const { tracker } = await deps.cache.get();
						backends.push(new LocationBackend(tracker));
					} catch {
						// Tracker not available — skip
					}
				}

				// Tree-sitter backend (requires tracker from cache)
				if (pipelineConfig.backends.treeSitter) {
					try {
						const { tracker } = await deps.cache.get();
						const parserManager = getParserManager();
						backends.push(
							new TreeSitterBackend(
								parserManager,
								tracker,
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

				const orchestrator = new PipelineOrchestrator(
					router,
					backends,
					pipelineConfig,
				);

				const mergedResults = await orchestrator.search(query, {
					limit: limit ?? 10,
					filePattern,
				});

				await indexer.close();

				const resultItems = mergedResults.map((r) => ({
					file: r.file,
					line: r.startLine,
					lineEnd: r.endLine,
					symbol: r.symbol ?? null,
					snippet: r.snippet,
					score: r.rrfScore === Number.POSITIVE_INFINITY ? 1.0 : r.rrfScore,
					backend: r.backends.join("+"),
				}));

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								results: resultItems,
								totalMatches: resultItems.length,
								autoIndexed,
								...buildFreshness(stateManager, startTime),
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
