/**
 * Callers Tool
 *
 * Traverse the call graph upward from a symbol, showing what depends on it,
 * ranked by PageRank importance.
 * When cloud deps are available (deps.cloudClient), uses cloudClient.getCallers()
 * which returns server-side call graph data. Cloud errors are returned directly.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolDeps } from "./deps.js";
import { buildFreshness, errorResponse } from "./deps.js";

export function registerCallersTools(server: McpServer, deps: ToolDeps): void {
	const { cache, stateManager, logger } = deps;

	server.tool(
		"callers",
		"Find all callers (dependents) of a symbol, traversed upward through the call graph, ranked by PageRank.",
		{
			symbol: z.string().describe("Symbol name to find callers of"),
			depth: z
				.number()
				.min(1)
				.max(5)
				.default(1)
				.describe("Traversal depth (default: 1, direct callers only)"),
			limit: z
				.number()
				.min(1)
				.max(100)
				.default(20)
				.describe("Maximum callers to return (default: 20)"),
		},
		async ({ symbol: symbolName, depth, limit }) => {
			const startTime = Date.now();

			try {
				// ── Cloud callers (when cloud deps are wired in) ─────────────────
				if (deps.cloudClient && deps.currentCommitSha && deps.teamConfig) {
					try {
						const orgSlug = deps.teamConfig.orgSlug;
						const repoSlug =
							deps.teamConfig.repoSlug ??
							`${orgSlug}/${
								deps.config.workspaceRoot.split("/").filter(Boolean).pop() ??
								"repo"
							}`;

						const callersResult = await deps.cloudClient.getCallers(
							repoSlug,
							deps.currentCommitSha,
							symbolName,
						);

						const callerItems = callersResult.callers
							.slice(0, limit ?? 20)
							.map((c) => ({
								symbol: c.name,
								file: c.filePath,
								line: c.line,
								kind: c.kind,
								depth: 1,
								pageRank: 0,
							}));

						return {
							content: [
								{
									type: "text" as const,
									text: JSON.stringify({
										totalDirectCallers: callersResult.callers.length,
										callers: callerItems,
										...buildFreshness(stateManager, startTime),
									}),
								},
							],
						};
					} catch (cloudErr) {
						return errorResponse(cloudErr);
					}
				}

				// ── Local callers (default path) ─────────────────────────────────
				const { graphManager } = await cache.get();

				const target = graphManager.findSymbol(symbolName, {
					preferExported: true,
				});

				if (!target) {
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({
									error: `Symbol "${symbolName}" not found in index.`,
									totalDirectCallers: 0,
									callers: [],
									...buildFreshness(stateManager, startTime),
								}),
							},
						],
					};
				}

				// BFS traversal up to `depth` levels
				const visited = new Set<string>([target.id]);
				const allCallers: Array<{
					symbol: string;
					file: string;
					line: number;
					pageRank: number;
					depth: number;
				}> = [];

				let frontier = [target.id];
				const directCallers = graphManager.getCallers(target.id);

				for (let d = 1; d <= (depth ?? 1); d++) {
					const nextFrontier: string[] = [];

					for (const id of frontier) {
						const callers =
							d === 1
								? id === target.id
									? directCallers
									: graphManager.getCallers(id)
								: graphManager.getCallers(id);
						for (const caller of callers) {
							if (!visited.has(caller.id)) {
								visited.add(caller.id);
								nextFrontier.push(caller.id);
								allCallers.push({
									symbol: caller.name,
									file: caller.filePath,
									line: caller.startLine,
									pageRank: caller.pagerankScore,
									depth: d,
								});
							}
						}
					}

					frontier = nextFrontier;
					if (frontier.length === 0) break;
				}

				// Sort by PageRank descending, then truncate
				allCallers.sort((a, b) => b.pageRank - a.pageRank);
				const truncated = allCallers.slice(0, limit ?? 20);

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								totalDirectCallers: directCallers.length,
								callers: truncated,
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
