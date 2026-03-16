/**
 * Symbol Tool
 *
 * Find symbol definitions and usages using the AST reference graph.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readSymbolBody } from "../../retrieval/backends/utils/read-body.js";
import type { ToolDeps } from "./deps.js";
import { buildFreshness, errorResponse } from "./deps.js";

export function registerSymbolTools(server: McpServer, deps: ToolDeps): void {
	const { cache, stateManager, config } = deps;

	server.tool(
		"symbol",
		"Find a symbol definition and its usages (callers) using the AST reference graph.",
		{
			symbol: z.string().describe("Symbol name to look up"),
			kind: z
				.enum(["function", "class", "interface", "type", "variable", "any"])
				.default("any")
				.describe("Symbol kind filter (default: any)"),
			includeUsages: z
				.boolean()
				.default(true)
				.describe("Include caller/usage locations (default: true)"),
			includeBody: z
				.boolean()
				.default(true)
				.describe("Include function/class body source code (default: true)"),
		},
		async ({ symbol: symbolName, kind, includeUsages, includeBody }) => {
			const startTime = Date.now();

			try {
				const { graphManager } = await cache.get();

				const found = graphManager.findSymbol(symbolName, {
					preferExported: true,
				});

				// Filter by kind if specified
				const definition =
					found && (kind === "any" || found.kind === kind) ? found : null;

				let usages: Array<{
					file: string;
					line: number;
					context: string;
					enclosingSymbol: string | null;
				}> = [];

				if (definition && includeUsages) {
					const callers = graphManager.getCallers(definition.id);
					usages = callers.map((c) => ({
						file: c.filePath,
						line: c.startLine,
						context: c.signature ?? c.name,
						enclosingSymbol: c.parentId ? c.name : null,
					}));
				}

				// Read body from disk if requested
				let body: string | null = null;
				let bodyStale = false;
				if (includeBody && definition) {
					const bodyResult = readSymbolBody(
						config.workspaceRoot,
						definition.filePath,
						definition.startLine,
						definition.endLine,
					);
					body = bodyResult.body;
					bodyStale = bodyResult.stale;
				}

				const definitionPayload = definition
					? {
							file: definition.filePath,
							line: definition.startLine,
							endLine: definition.endLine,
							kind: definition.kind,
							name: definition.name,
							signature: definition.signature ?? null,
							isExported: definition.isExported,
							pageRank: definition.pagerankScore,
							...(includeBody ? { body, bodyStale } : {}),
						}
					: null;

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								definition: definitionPayload,
								usages,
								usageCount: usages.length,
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
