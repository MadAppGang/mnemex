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

import { appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createIndexer, IndexLockError } from "../../core/indexer.js";
import { createLearningSystem } from "../../learning/index.js";
import { discoverEmbeddingModels } from "../../models/model-discovery.js";
import { applyFileBoosts } from "../../retrieval/pipeline/learned-boosts.js";
import { buildIndexState, type IndexState } from "../index-state.js";
import type { FreshnessMetadata } from "../types.js";
import type { ToolDeps } from "./deps.js";
import {
	buildFreshness,
	errorResponse,
	getFileTracker,
	getLearnedFileBoosts,
	openToolSession,
	recordSearchInteraction,
} from "./deps.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Serialize an IndexState into a non-error MCP text response. Used by
 * index_codebase to return structured, actionable indexing state instead of
 * throwing when a live indexer holds the lock (or a stale lock is detected).
 */
function structuredIndexingResponse(
	state: IndexState,
	freshness: FreshnessMetadata,
): { content: Array<{ type: "text"; text: string }> } {
	return {
		content: [
			{
				type: "text" as const,
				text: JSON.stringify({
					status: state.status,
					message: state.message,
					indexing: state.indexing,
					index: state.index,
					canReturnCachedResults: state.canReturnCachedResults,
					recommendations: state.recommendations,
					...freshness,
				}),
			},
		],
	};
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
	const { stateManager, config } = deps;

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
				.describe(
					"Re-index every file of the CURRENT BRANCH, ignoring cached state. " +
						"Other branches of this repository keep their rows. There is no " +
						"whole-store rebuild here on purpose: that is `mnemex index " +
						"--force-all` at a terminal, because it empties every branch.",
				),
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

				// CRITICAL-1: buildIndexState inspects the SERVER workspace's lock
				// (config.indexDir / config.workspaceRoot), which is only meaningful for
				// THIS path when the caller omitted `path` or asked to index the server's
				// own workspace. For a different target path, an unguarded pre-check /
				// IndexLockError translate would wrongly refuse to index path B just
				// because workspace A is busy. So gate BOTH the pre-check and the catch
				// translate on this comparison; otherwise fall through untouched.
				const isWorkspacePath =
					!path || resolve(projectPath) === resolve(config.workspaceRoot);

				// Pre-check the live lock. Only short-circuit for a LIVE, PROGRESSING
				// indexer (indexing_in_progress). A stale_lock (dead pid) OR an
				// indexing_hung holder (alive but no forward progress) must fall through
				// so the indexer's own acquire() can reclaim the lock and proceed.
				if (isWorkspacePath) {
					const pre = await buildIndexState(deps, startTime);
					if (pre.status === "indexing_in_progress") {
						return structuredIndexingResponse(
							pre,
							buildFreshness(stateManager, startTime),
						);
					}
				}

				const indexer = createIndexer({
					projectPath,
					model,
					enableEnrichment: enableEnrichment !== false,
				});

				let result: Awaited<ReturnType<typeof indexer.index>>;
				try {
					result = await indexer.index(force ?? false);
				} catch (err) {
					// Race: a lock was acquired between the pre-check and index().
					// Translate a late IndexLockError into the same structured shape —
					// but ONLY for the server workspace (CRITICAL-1). For a different
					// target path the lock error refers to that path's own lock and must
					// surface untranslated.
					await indexer.close();
					if (isWorkspacePath && err instanceof IndexLockError) {
						const st = await buildIndexState(deps, startTime);
						return structuredIndexingResponse(
							st,
							buildFreshness(stateManager, startTime),
						);
					}
					throw err;
				}
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

				// `searchScoped`, not `search`: D1 requires `branch_unknown` to reach
				// THIS response, and the flag is a property of the response, not of
				// any row (§4.4.2, required item 2).
				const scoped = await indexer.searchScoped(query, {
					limit: limit ?? 10,
					language,
					useCase: useCase ?? "search",
				});
				let results = scoped.results;
				/** D1's two response fields, on every return path below. */
				const branchState = {
					branch_unknown: scoped.branchUnknown,
					branch: scoped.branchLabel,
				};

				// ONE index-db connection for this request, shared by the learning
				// system and activity recording. Learning goes through the same
				// opt-in gate and the same helpers as the `search` tool; when it
				// is off, no learning work happens on this connection.
				const session = openToolSession(projectPath, { requireTracker: true });
				const { tracker } = session;
				let adaptiveApplied = false;
				const chunkIds: string[] = [];

				if (tracker) {
					try {
						const sessionId = `mcp_${Date.now()}`;

						recordSearchInteraction(session, {
							query,
							sessionId,
							resultCount: results.length,
							useCase: useCase ?? "search",
						});

						const fileBoosts = getLearnedFileBoosts(
							session,
							useCase ?? "search",
						);
						if (fileBoosts) {
							// Shared with the pipeline path (search tool) so both
							// retrieval paths boost and rank identically.
							results = applyFileBoosts(
								results,
								fileBoosts,
								(r) => r.chunk.filePath,
								(r) => r.score,
								(r, score) => ({ ...r, score }),
							);
							adaptiveApplied = true;
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
						session.close();
					}
				}

				await indexer.close();

				if (results.length === 0) {
					// A10: every search_code path carries the structured state as ONE
					// trailing JSON object (buildFreshness + indexState merged), including
					// the no-results early return.
					const indexState = await buildIndexState(deps, startTime);
					const trailer = JSON.stringify({
						...buildFreshness(stateManager, startTime),
						...indexState,
						...branchState,
					});
					const emptyResponse = `No results found for "${query}". Make sure the codebase is indexed using \`index_codebase\`.\n${trailer}`;
					return {
						content: [
							{
								type: "text" as const,
								text: emptyResponse,
							},
						],
					};
				}

				let response = `## Search Results for "${query}"\n\n`;
				if (scoped.branchUnknown) {
					// Visible in the prose too, not only in the trailer: D1 chose the
					// superset BECAUSE it fails visibly, and a flag nobody renders is
					// the invisible failure it exists to avoid.
					response += `*Branch \`${scoped.branchLabel ?? "?"}\` is not in the index; showing results from every indexed branch. Each result lists the branches it belongs to.*\n\n`;
				}
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
					// D1's PER-ROW attribution. It is what lets an agent discount a
					// foreign row instead of discarding the whole response.
					if (r.branches && r.branches.length > 0) {
						response += `Branches: ${r.branches.join(", ")}\n`;
					}
					response += `ID: \`${chunk.id.slice(0, 12)}...\`\n\n`;
					response += `\`\`\`${chunk.language}\n`;
					response += chunk.content.slice(0, 1000);
					if (chunk.content.length > 1000) response += "\n// ... truncated";
					response += "\n```\n\n";
				}

				response += `---\n`;
				response += `*Chunk IDs: ${chunkIds.map((id) => id.slice(0, 8)).join(", ")}*\n`;
				// A10: ONE trailing JSON object combining freshness + structured state
				// (do not append two bare JSON lines).
				const indexState = await buildIndexState(deps, startTime);
				const trailer = JSON.stringify({
					...buildFreshness(stateManager, startTime),
					...indexState,
					...branchState,
					results: results.map((r) => ({
						id: r.chunk.id,
						file: r.chunk.filePath,
						branches: r.branches ?? [],
					})),
				});
				response += `\n${trailer}`;

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
			const startTime = Date.now();
			try {
				const projectPath = path ?? process.cwd();

				// buildIndexState inspects the SERVER workspace (config.indexDir /
				// config.workspaceRoot), so the structured block is only meaningful
				// when this tool targets that same workspace (path omitted or equal).
				// For a different caller `path`, omit it rather than report state for
				// the wrong directory — mirrors the index_codebase cross-path guard.
				const isWorkspacePath =
					!path || resolve(projectPath) === resolve(config.workspaceRoot);
				const indexState = isWorkspacePath
					? await buildIndexState(deps, startTime)
					: null;

				const indexer = createIndexer({ projectPath });
				const status = await indexer.getStatus();
				await indexer.close();

				if (!status.exists) {
					// Surface the structured state here too: "Files: 0, Chunks: 0" with
					// no index is exactly when the agent needs no_index + a recommendation
					// instead of a bare sentence.
					let noIndexText = `No index found for ${projectPath}. Run \`index_codebase\` to create one.`;
					if (indexState) {
						noIndexText += `\n${JSON.stringify(indexState)}`;
					}
					return {
						content: [{ type: "text" as const, text: noIndexText }],
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

				// Append the structured state block (when targeting the workspace) so
				// agents get freshness + indexing diagnostics without a second call.
				if (indexState) {
					response += `\n---\n${JSON.stringify(indexState)}`;
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
