/**
 * Search Tool
 *
 * Semantic + BM25 hybrid code search.
 * Auto-indexes changed files incrementally before searching.
 * When cloud deps are available (deps.cloudClient), uses CloudAwareSearch
 * which merges cloud index results with local overlay results for dirty files.
 * Cloud errors are returned directly — no silent fallback to local search.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createIndexer } from "../../core/indexer.js";
import { createEmbeddingsClient } from "../../core/embeddings.js";
import {
	createGitDiffChangeDetector,
	createCloudAwareSearch,
} from "../../cloud/index.js";
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
							`${orgSlug}/${config.workspaceRoot
								.split("/")
								.filter(Boolean)
								.pop() ?? "repo"}`;

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

				// ── Local search (default path) ──────────────────────────────────
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
					logger.warn("search: auto-index failed, searching existing index", indexErr);
				}

				const results = await indexer.search(query, {
					limit: limit ?? 10,
					useCase: "search",
				});

				await indexer.close();

				// Apply file pattern filter if provided
				const filtered =
					filePattern
						? results.filter((r) => {
								const pat = filePattern.replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*");
								return new RegExp(pat).test(r.chunk.filePath);
							})
						: results;

				const resultItems = filtered.map((r) => {
					if (r.documentType === "session_observation") {
						const meta = r.observationMetadata || {};
						return {
							type: "observation" as const,
							content: r.chunk.content,
							observationType: meta.observationType ?? "pattern",
							confidence: meta.confidence ?? 0.7,
							affectedFiles: (meta.affectedFiles as string[]) || [],
							score: r.score,
						};
					}
					return {
						file: r.chunk.filePath,
						line: r.chunk.startLine,
						lineEnd: r.chunk.endLine,
						symbol: r.chunk.name ?? null,
						snippet: r.chunk.content.slice(0, 800),
						score: r.score,
						vectorScore: r.vectorScore,
						keywordScore: r.keywordScore,
					};
				});

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

