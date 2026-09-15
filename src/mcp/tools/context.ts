/**
 * Context Tool
 *
 * Provides rich context for a symbol or file location:
 * enclosing symbol, imports, related symbols via the reference graph.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readSymbolBody } from "../../retrieval/backends/utils/read-body.js";
import type { ToolDeps } from "./deps.js";
import { buildFreshness, errorResponse } from "./deps.js";

export function registerContextTools(server: McpServer, deps: ToolDeps): void {
	const { cache, stateManager, config } = deps;

	server.tool(
		"context",
		"Get rich context for a file location: enclosing symbol with source body, imports, and related symbols via the reference graph.",
		{
			file: z
				.string()
				.describe("File path (relative to workspace root) to get context for"),
			line: z.coerce
				.number()
				.default(1)
				.describe("Line number within the file (default: 1)"),
			radius: z.coerce
				.number()
				.min(1)
				.max(10)
				.default(2)
				.describe("Number of related symbols to include (default: 2)"),
			includeBody: z
				.boolean()
				.default(true)
				.describe(
					"Include source code body of the enclosing symbol (default: true)",
				),
		},
		async ({ file, line, radius, includeBody }) => {
			const startTime = Date.now();

			try {
				const { graphManager, tracker, branchId } = await cache.get();

				// Find which symbol contains the given file:line, on THIS branch.
				const allSymbols = tracker.graph(branchId).getAllSymbols();
				const atLocation = allSymbols.filter(
					(s) =>
						(s.filePath === file || s.filePath.endsWith(`/${file}`)) &&
						s.startLine <= (line ?? 1) &&
						s.endLine >= (line ?? 1),
				);

				// Pick the most specific (innermost) symbol
				atLocation.sort(
					(a, b) => b.startLine - a.startLine || a.endLine - b.endLine,
				);
				const enclosing = atLocation[0] ?? null;

				let callers: Array<{ name: string; file: string; line: number }> = [];
				let callees: Array<{ name: string; file: string; line: number }> = [];

				if (enclosing) {
					const ctx = graphManager.getSymbolContext(enclosing.id, {
						includeCallers: true,
						includeCallees: true,
						maxCallers: radius ?? 2,
						maxCallees: radius ?? 2,
					});
					callers = ctx.callers.map((s) => ({
						name: s.name,
						file: s.filePath,
						line: s.startLine,
					}));
					callees = ctx.callees.map((s) => ({
						name: s.name,
						file: s.filePath,
						line: s.startLine,
					}));
				}

				// Gather file-level imports by collecting callees from file symbols
				const fileSymbols = allSymbols.filter(
					(s) => s.filePath === file || s.filePath.endsWith(`/${file}`),
				);
				const importSet = new Set<string>();
				for (const sym of fileSymbols) {
					const symCallees = graphManager.getCallees(sym.id);
					for (const callee of symCallees) {
						if (
							callee.filePath !== file &&
							!callee.filePath.endsWith(`/${file}`)
						) {
							importSet.add(callee.filePath);
						}
					}
				}

				// Read body from disk if requested
				let body: string | null = null;
				let bodyStale = false;
				if (includeBody && enclosing) {
					const bodyResult = readSymbolBody(
						config.workspaceRoot,
						enclosing.filePath,
						enclosing.startLine,
						enclosing.endLine,
					);
					body = bodyResult.body;
					bodyStale = bodyResult.stale;
				}

				const enclosingPayload = enclosing
					? {
							name: enclosing.name,
							kind: enclosing.kind,
							file: enclosing.filePath,
							startLine: enclosing.startLine,
							endLine: enclosing.endLine,
							signature: enclosing.signature ?? null,
							...(includeBody ? { body, bodyStale } : {}),
						}
					: null;

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								enclosingSymbol: enclosingPayload,
								imports: Array.from(importSet),
								relatedSymbols: { callers, callees },
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
