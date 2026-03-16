/**
 * Callees Tool
 *
 * Traverse the call graph downward from a symbol, showing what it depends on.
 * When cloud deps are available (deps.cloudClient), uses cloudClient.getCallees()
 * which returns server-side call graph data. Cloud errors are returned directly.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolDeps } from "./deps.js";
import { buildFreshness, errorResponse } from "./deps.js";

export function registerCalleesTools(server: McpServer, deps: ToolDeps): void {
	const { cache, stateManager, logger } = deps;

	server.tool(
		"callees",
		"Find all dependencies (callees) of a symbol, traversed downward through the call graph.",
		{
			symbol: z.string().describe("Symbol name to find dependencies of"),
			depth: z
				.number()
				.min(1)
				.max(5)
				.default(1)
				.describe("Traversal depth (default: 1, direct callees only)"),
			excludeExternal: z
				.boolean()
				.default(false)
				.describe("Exclude symbols from external packages (default: false)"),
		},
		async ({ symbol: symbolName, depth, excludeExternal }) => {
			const startTime = Date.now();

			try {
				// ── Cloud callees (when cloud deps are wired in) ─────────────────
				if (deps.cloudClient && deps.currentCommitSha && deps.teamConfig) {
					try {
						const orgSlug = deps.teamConfig.orgSlug;
						const repoSlug =
							deps.teamConfig.repoSlug ??
							`${orgSlug}/${
								deps.config.workspaceRoot.split("/").filter(Boolean).pop() ??
								"repo"
							}`;

						const calleesResult = await deps.cloudClient.getCallees(
							repoSlug,
							deps.currentCommitSha,
							symbolName,
						);

						const calleeItems = calleesResult.callees.map((c) => ({
							symbol: c.name,
							file: c.filePath,
							line: c.line,
							kind: c.kind,
							isExternal: false,
							depth: 1,
						}));

						const filtered = excludeExternal
							? calleeItems.filter((c) => !c.isExternal)
							: calleeItems;

						return {
							content: [
								{
									type: "text" as const,
									text: JSON.stringify({
										callees: filtered,
										...buildFreshness(stateManager, startTime),
									}),
								},
							],
						};
					} catch (cloudErr) {
						return errorResponse(cloudErr);
					}
				}

				// ── Local callees (default path) ─────────────────────────────────
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
									callees: [],
									...buildFreshness(stateManager, startTime),
								}),
							},
						],
					};
				}

				// BFS traversal downward up to `depth` levels
				const visited = new Set<string>([target.id]);
				const allCallees: Array<{
					symbol: string;
					file: string;
					line: number;
					isExternal: boolean;
					depth: number;
				}> = [];

				let frontier = [target.id];

				for (let d = 1; d <= (depth ?? 1); d++) {
					const nextFrontier: string[] = [];

					for (const id of frontier) {
						const callees = graphManager.getCallees(id);
						for (const callee of callees) {
							if (!visited.has(callee.id)) {
								visited.add(callee.id);
								nextFrontier.push(callee.id);

								// Heuristic: symbols from node_modules or without filePath are external
								const isExternal =
									callee.filePath.includes("node_modules") ||
									callee.filePath.startsWith("external:");

								if (excludeExternal && isExternal) {
									continue;
								}

								allCallees.push({
									symbol: callee.name,
									file: callee.filePath,
									line: callee.startLine,
									isExternal,
									depth: d,
								});
							}
						}
					}

					frontier = nextFrontier;
					if (frontier.length === 0) break;
				}

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								callees: allCallees,
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
