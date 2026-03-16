/**
 * Legacy Tools
 *
 * Backward-compatible tool registrations matching the old mcp-server.ts
 * tool names. Claude Code installations that already use these tool names
 * will continue to work without modification.
 *
 * Tools preserved:
 *   index_codebase       - Index a project
 *   search_code          - Semantic search (old format)
 *   clear_index          - Clear the index
 *   get_status           - Old-format status
 *   list_embedding_models - List available models
 *   report_search_feedback - Learning system feedback
 *   get_learning_stats   - Learning system stats
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { createIndexer } from "../../core/indexer.js";
import { FileTracker } from "../../core/tracker.js";
import { existsSync } from "node:fs";
import { discoverEmbeddingModels } from "../../models/model-discovery.js";
import { createLearningSystem } from "../../learning/index.js";
import type { ToolDeps } from "./deps.js";
import { buildFreshness, errorResponse } from "./deps.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getFileTracker(projectPath: string): FileTracker | null {
	const dbPath = join(projectPath, ".mnemex", "index.db");
	if (!existsSync(dbPath)) {
		return null;
	}
	return new FileTracker(dbPath, projectPath);
}

function appendActivityNotification(
	projectPath: string,
	activityId: number,
	type: string,
): void {
	try {
		const jsonlPath = join(projectPath, ".mnemex", "activity.jsonl");
		const notification = JSON.stringify({
			id: activityId,
			type,
			ts: new Date().toISOString(),
		});
		appendFileSync(jsonlPath, `${notification}\n`);
	} catch {
		// Silent — notification file is optional
	}
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerLegacyTools(server: McpServer, deps: ToolDeps): void {
	const { stateManager } = deps;

	// =========================================================================
	// index_codebase
	// =========================================================================
	server.tool(
		"index_codebase",
		"Index a codebase for semantic code search. Creates vector embeddings of code chunks and optionally generates LLM-powered enrichments.",
		{
			path: z
				.string()
				.optional()
				.describe("Project root path to index (default: current directory)"),
			force: z
				.boolean()
				.optional()
				.describe("Force re-index all files, ignoring cached state"),
			model: z.string().optional().describe("Embedding model to use"),
			enableEnrichment: z
				.boolean()
				.optional()
				.describe("Enable LLM enrichment (default: true)"),
		},
		async ({ path, force, model, enableEnrichment }) => {
			const startTime = Date.now();

			try {
				const projectPath = path ?? process.cwd();

				const indexer = createIndexer({
					projectPath,
					model,
					enableEnrichment: enableEnrichment !== false,
				});

				const result = await indexer.index(force ?? false);
				await indexer.close();

				// Activity recording
				const tracker = getFileTracker(projectPath);
				if (tracker) {
					try {
						const activityId = tracker.recordActivity("index_codebase", {
							filesIndexed: result.filesIndexed,
							chunksCreated: result.chunksCreated,
						});
						appendActivityNotification(
							projectPath,
							activityId,
							"index_codebase",
						);
					} catch {
						// Silent
					} finally {
						tracker.close();
					}
				}

				let response = `## Indexing Complete\n\n`;
				response += `- **Files indexed**: ${result.filesIndexed}\n`;
				response += `- **Chunks created**: ${result.chunksCreated}\n`;
				response += `- **Duration**: ${(result.durationMs / 1000).toFixed(2)}s\n`;

				if ("enrichment" in result && result.enrichment) {
					const enrichment = result.enrichment;
					const totalDocs =
						enrichment.documentsCreated + enrichment.documentsUpdated;
					response += `- **Enriched documents**: ${totalDocs}`;
					if (enrichment.documentsUpdated > 0) {
						response += ` (${enrichment.documentsCreated} new, ${enrichment.documentsUpdated} updated)`;
					}
					response += `\n`;
				}

				if (result.errors.length > 0) {
					response += `\n### Errors (${result.errors.length})\n`;
					for (const err of result.errors.slice(0, 5)) {
						response += `- \`${err.file}\`: ${err.error}\n`;
					}
					if (result.errors.length > 5) {
						response += `- ... and ${result.errors.length - 5} more\n`;
					}
				}

				response += `\n---\n`;
				response += JSON.stringify(buildFreshness(stateManager, startTime));

				return { content: [{ type: "text" as const, text: response }] };
			} catch (err) {
				return errorResponse(err);
			}
		},
	);

	// =========================================================================
	// search_code
	// =========================================================================
	server.tool(
		"search_code",
		"Search indexed code using natural language. Automatically indexes new/modified files before searching.",
		{
			query: z.string().describe("Natural language search query"),
			limit: z
				.number()
				.optional()
				.describe("Maximum results to return (default: 10)"),
			language: z
				.string()
				.optional()
				.describe("Filter by programming language"),
			path: z
				.string()
				.optional()
				.describe("Project path (default: current directory)"),
			autoIndex: z
				.boolean()
				.optional()
				.describe("Auto-index changed files before search (default: true)"),
			useCase: z
				.enum(["fim", "search", "navigation"])
				.optional()
				.describe("Search preset"),
		},
		async ({ query, limit, language, path, autoIndex, useCase }) => {
			const startTime = Date.now();

			try {
				const projectPath = path ?? process.cwd();
				const indexer = createIndexer({ projectPath });

				// Auto-index changed files before search
				let autoIndexed = 0;
				if (autoIndex !== false) {
					try {
						const indexResult = await indexer.index(false);
						autoIndexed = indexResult.filesIndexed;
					} catch {
						// Non-fatal
					}
				}

				let results = await indexer.search(query, {
					limit: limit ?? 10,
					language,
					useCase: useCase ?? "search",
				});

				// Apply learning system if available
				const tracker = getFileTracker(projectPath);
				let adaptiveApplied = false;
				const chunkIds: string[] = [];

				if (tracker) {
					try {
						const learning = createLearningSystem(tracker.getDatabase());
						const sessionId = `mcp_${Date.now()}`;

						learning.collector.recordSearch({
							query,
							sessionId,
							resultCount: results.length,
							useCase: useCase ?? "search",
						});

						if (learning.ranker.isActive(useCase ?? "search")) {
							const fileBoosts = learning.ranker.getAllFileBoosts();
							if (fileBoosts.size > 0) {
								results = results.map((r) => ({
									...r,
									score: r.score * (fileBoosts.get(r.chunk.filePath) ?? 1.0),
								}));
								results.sort((a, b) => b.score - a.score);
								adaptiveApplied = true;
							}
						}

						// Record activity
						const activityId = tracker.recordActivity("search_code", {
							query,
							resultCount: results.length,
							topScore: results[0]?.score ?? 0,
							topResult: results[0]
								? {
										chunk: results[0].chunk,
										score: results[0].score,
										vectorScore: results[0].vectorScore,
										keywordScore: results[0].keywordScore,
										summary: results[0].summary,
										fileSummary: results[0].fileSummary,
									}
								: null,
						});
						appendActivityNotification(projectPath, activityId, "search_code");
					} catch {
						// Learning system error - continue without it
					} finally {
						tracker.close();
					}
				}

				await indexer.close();

				if (results.length === 0) {
					return {
						content: [
							{
								type: "text" as const,
								text: `No results found for "${query}". Make sure the codebase is indexed using \`index_codebase\`.`,
							},
						],
					};
				}

				let response = `## Search Results for "${query}"\n\n`;
				if (autoIndexed > 0) {
					response += `*Auto-indexed ${autoIndexed} changed file(s)*\n\n`;
				}
				if (adaptiveApplied) {
					response += `*Adaptive ranking applied*\n\n`;
				}
				response += `Found ${results.length} result(s):\n\n`;

				for (let i = 0; i < results.length; i++) {
					const r = results[i];
					const chunk = r.chunk;
					chunkIds.push(chunk.id);

					response += `### ${i + 1}. \`${chunk.filePath}\`:${chunk.startLine}-${chunk.endLine}\n`;
					response += `**${chunk.chunkType}**`;
					if (chunk.name) response += `: \`${chunk.name}\``;
					if (chunk.parentName) response += ` (in \`${chunk.parentName}\`)`;
					response += `\n`;
					response += `Score: ${(r.score * 100).toFixed(1)}% (vector: ${(r.vectorScore * 100).toFixed(0)}%, keyword: ${(r.keywordScore * 100).toFixed(0)}%)\n`;
					response += `ID: \`${chunk.id.slice(0, 12)}...\`\n\n`;
					response += "```" + chunk.language + "\n";
					response += chunk.content.slice(0, 1000);
					if (chunk.content.length > 1000) response += "\n// ... truncated";
					response += "\n```\n\n";
				}

				response += `---\n`;
				response += `*Chunk IDs: ${chunkIds.map((id) => id.slice(0, 8)).join(", ")}*\n`;
				response +=
					`\n` + JSON.stringify(buildFreshness(stateManager, startTime));

				return { content: [{ type: "text" as const, text: response }] };
			} catch (err) {
				return errorResponse(err);
			}
		},
	);

	// =========================================================================
	// clear_index
	// =========================================================================
	server.tool(
		"clear_index",
		"Clear the code index for a project. Removes all indexed chunks and file state.",
		{
			path: z
				.string()
				.optional()
				.describe("Project path (default: current directory)"),
		},
		async ({ path }) => {
			try {
				const projectPath = path ?? process.cwd();
				const indexer = createIndexer({ projectPath });
				await indexer.clear();
				await indexer.close();

				return {
					content: [
						{
							type: "text" as const,
							text: `Index cleared for ${projectPath}`,
						},
					],
				};
			} catch (err) {
				return errorResponse(err);
			}
		},
	);

	// =========================================================================
	// get_status
	// =========================================================================
	server.tool(
		"get_status",
		"Get the status of the code index for a project.",
		{
			path: z
				.string()
				.optional()
				.describe("Project path (default: current directory)"),
		},
		async ({ path }) => {
			try {
				const projectPath = path ?? process.cwd();
				const indexer = createIndexer({ projectPath });
				const status = await indexer.getStatus();
				await indexer.close();

				if (!status.exists) {
					return {
						content: [
							{
								type: "text" as const,
								text: `No index found for ${projectPath}. Run \`index_codebase\` to create one.`,
							},
						],
					};
				}

				let response = `## Index Status\n\n`;
				response += `- **Path**: ${projectPath}\n`;
				response += `- **Files**: ${status.totalFiles}\n`;
				response += `- **Chunks**: ${status.totalChunks}\n`;
				response += `- **Languages**: ${status.languages.join(", ") || "none"}\n`;
				if (status.embeddingModel) {
					response += `- **Embedding model**: ${status.embeddingModel}\n`;
				}
				if (status.lastUpdated) {
					response += `- **Last updated**: ${status.lastUpdated.toISOString()}\n`;
				}

				// Activity recording
				const statusTracker = getFileTracker(projectPath);
				if (statusTracker) {
					try {
						const activityId = statusTracker.recordActivity("get_status", {
							totalFiles: status.totalFiles,
							totalChunks: status.totalChunks,
						});
						appendActivityNotification(projectPath, activityId, "get_status");
					} catch {
						// Silent
					} finally {
						statusTracker.close();
					}
				}

				return { content: [{ type: "text" as const, text: response }] };
			} catch (err) {
				return errorResponse(err);
			}
		},
	);

	// =========================================================================
	// list_embedding_models
	// =========================================================================
	server.tool(
		"list_embedding_models",
		"List available embedding models from OpenRouter for code indexing.",
		{
			freeOnly: z.boolean().optional().describe("Show only free models"),
		},
		async ({ freeOnly }) => {
			try {
				const models = await discoverEmbeddingModels();
				const filtered = freeOnly ? models.filter((m) => m.isFree) : models;

				let response = `## Available Embedding Models\n\n`;
				response += `| Model | Provider | Price | Context |\n`;
				response += `|-------|----------|-------|----------|\n`;

				for (const model of filtered.slice(0, 15)) {
					const price = model.isFree
						? "FREE"
						: `$${model.pricePerMillion.toFixed(3)}/1M`;
					const context = `${Math.round(model.contextLength / 1000)}K`;
					response += `| ${model.id} | ${model.provider} | ${price} | ${context} |\n`;
				}

				if (filtered.length > 15) {
					response += `\n*... and ${filtered.length - 15} more models*\n`;
				}

				response += `\n**Recommended for code**: \`qwen/qwen3-embedding-8b\`\n`;

				return { content: [{ type: "text" as const, text: response }] };
			} catch (err) {
				return errorResponse(err);
			}
		},
	);

	// =========================================================================
	// report_search_feedback
	// =========================================================================
	server.tool(
		"report_search_feedback",
		"Report feedback on search results to improve future rankings.",
		{
			query: z.string().describe("The search query that was executed"),
			allResultIds: z
				.array(z.string())
				.describe("All chunk IDs returned from the search"),
			helpfulIds: z
				.array(z.string())
				.optional()
				.describe("Chunk IDs that were helpful"),
			unhelpfulIds: z
				.array(z.string())
				.optional()
				.describe("Chunk IDs that were not helpful"),
			sessionId: z.string().optional().describe("Session identifier"),
			useCase: z
				.enum(["fim", "search", "navigation"])
				.optional()
				.describe("Search use case"),
			path: z
				.string()
				.optional()
				.describe("Project path (default: current directory)"),
		},
		async ({
			query,
			allResultIds,
			helpfulIds,
			unhelpfulIds,
			sessionId,
			useCase,
			path,
		}) => {
			try {
				const projectPath = path ?? process.cwd();
				const tracker = getFileTracker(projectPath);

				if (!tracker) {
					return {
						content: [
							{
								type: "text" as const,
								text: "No index found. Run `index_codebase` first to enable feedback collection.",
							},
						],
						isError: true as const,
					};
				}

				const learning = createLearningSystem(tracker.getDatabase());

				learning.collector.captureExplicitFeedback({
					query,
					sessionId,
					resultIds: allResultIds,
					helpfulIds: helpfulIds ?? [],
					unhelpfulIds: unhelpfulIds ?? [],
					useCase,
					source: "mcp",
				});

				const stats = learning.store.getStatistics();
				tracker.close();

				let response = `## Feedback Recorded\n\n`;
				response += `- **Helpful results**: ${helpfulIds?.length ?? 0}\n`;
				response += `- **Unhelpful results**: ${unhelpfulIds?.length ?? 0}\n`;
				response += `- **Total feedback events**: ${stats.totalFeedbackEvents}\n`;

				return { content: [{ type: "text" as const, text: response }] };
			} catch (err) {
				return errorResponse(err);
			}
		},
	);

	// =========================================================================
	// get_learning_stats
	// =========================================================================
	server.tool(
		"get_learning_stats",
		"Get statistics about the adaptive learning system.",
		{
			path: z
				.string()
				.optional()
				.describe("Project path (default: current directory)"),
		},
		async ({ path }) => {
			try {
				const projectPath = path ?? process.cwd();
				const tracker = getFileTracker(projectPath);

				if (!tracker) {
					return {
						content: [
							{
								type: "text" as const,
								text: "No index found. Run `index_codebase` first.",
							},
						],
						isError: true as const,
					};
				}

				const learning = createLearningSystem(tracker.getDatabase());
				const stats = learning.store.getStatistics();
				const diagnostics = learning.ranker.getDiagnostics();

				tracker.close();

				let response = `## Adaptive Learning Statistics\n\n`;
				response += `### Feedback Data\n`;
				response += `- **Total feedback events**: ${stats.totalFeedbackEvents}\n`;
				response += `- **Unique queries**: ${stats.uniqueQueries}\n`;
				response += `- **Average acceptance rate**: ${(stats.averageAcceptanceRate * 100).toFixed(1)}%\n`;
				if (stats.lastFeedbackAt) {
					response += `- **Last feedback**: ${stats.lastFeedbackAt.toISOString()}\n`;
				}
				response += `\n### Current Weights\n`;
				response += `- **Adaptive ranking active**: ${diagnostics.isActive ? "Yes" : "No"}\n`;
				response += `- **Confidence**: ${(diagnostics.confidence * 100).toFixed(1)}%\n`;
				response += `- **Vector weight**: ${diagnostics.vectorWeight.toFixed(3)}\n`;
				response += `- **BM25 weight**: ${diagnostics.bm25Weight.toFixed(3)}\n`;
				response += `- **Files with custom boosts**: ${diagnostics.fileBoostCount}\n`;

				if (diagnostics.topBoostedFiles.length > 0) {
					response += `\n### Top Boosted Files\n`;
					for (const { filePath, boost } of diagnostics.topBoostedFiles) {
						response += `- \`${filePath.split("/").pop()}\`: ${boost.toFixed(2)}x\n`;
					}
				}

				if (stats.topQueries.length > 0) {
					response += `\n### Most Common Queries\n`;
					for (const { query, count } of stats.topQueries.slice(0, 5)) {
						response += `- "${query}" (${count} times)\n`;
					}
				}

				return { content: [{ type: "text" as const, text: response }] };
			} catch (err) {
				return errorResponse(err);
			}
		},
	);
}
