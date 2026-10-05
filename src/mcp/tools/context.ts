/**
 * Context Tool
 *
 * Provides rich context for a symbol or file location:
 * enclosing symbol, imports, related symbols via the reference graph.
 */

import { isAbsolute, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BranchScopedGraph } from "../../core/tracker.js";
import { readSymbolBody } from "../../retrieval/backends/utils/read-body.js";
import type { SymbolDefinition } from "../../types.js";
import type { ToolDeps } from "./deps.js";
import { buildFreshness, errorResponse } from "./deps.js";

/**
 * How a `context` file argument was matched to an indexed file. Reported in
 * every response, so a suffix match is never a silent narrowing.
 */
export interface ContextFileResolution {
	/**
	 * `exact`: the argument, resolved against the workspace root if relative,
	 * named an indexed file. `suffix`: it did not, and exactly ONE indexed file
	 * ends with `/<argument>`. `ambiguous`: several do; nothing is answered.
	 * `none`: no match at all.
	 */
	readonly match: "exact" | "suffix" | "ambiguous" | "none";
	/** The matched file, in stored (repo-relative) spelling; null unless matched. */
	readonly file: string | null;
	/** `ambiguous` only: every indexed file the argument could mean, sorted. */
	readonly candidates?: readonly string[];
}

/**
 * The symbols of the file a `context` argument names (R1.4, orchestrator
 * ruling 2).
 *
 * EXACT FIRST: `getSymbolsByFile` converts an absolute path to stored form
 * itself, so an absolute argument and a repo-relative one reach the same rows.
 * The old hedge (`s.filePath === file || s.filePath.endsWith("/" + file)`)
 * compared a stored path with the raw argument, so an ABSOLUTE argument found
 * nothing, and an ambiguous bare filename silently merged every file with that
 * name.
 *
 * SUFFIX ONLY AS A FALLBACK, and only when it is unambiguous. `listFiles` is
 * the branch's indexed files in stored spelling; a file EQUAL to a relative
 * argument also counts, which keeps a repo-relative argument working when the
 * workspace is a subdirectory of the repository (it resolves under the
 * subdirectory and misses the exact lookup). An absolute argument never falls
 * back: it already said exactly which file it meant.
 */
export function resolveContextFile(
	file: string,
	workspaceRoot: string,
	graph: Pick<BranchScopedGraph, "getSymbolsByFile">,
	listFiles: () => readonly string[],
): { symbols: SymbolDefinition[]; resolution: ContextFileResolution } {
	const exact = graph.getSymbolsByFile(
		isAbsolute(file) ? file : resolve(workspaceRoot, file),
	);
	if (exact.length > 0) {
		return {
			symbols: exact,
			resolution: { match: "exact", file: exact[0].filePath },
		};
	}
	if (isAbsolute(file)) {
		return { symbols: [], resolution: { match: "none", file: null } };
	}

	const arg = file.replace(/^(\.\/)+/, "");
	const candidates = [
		...new Set(listFiles().filter((p) => p === arg || p.endsWith(`/${arg}`))),
	].sort();
	if (candidates.length === 1) {
		return {
			symbols: graph.getSymbolsByFile(candidates[0]),
			resolution: { match: "suffix", file: candidates[0] },
		};
	}
	if (candidates.length > 1) {
		return {
			symbols: [],
			resolution: { match: "ambiguous", file: null, candidates },
		};
	}
	return { symbols: [], resolution: { match: "none", file: null } };
}

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

				// The file's symbols, on THIS branch, and how the argument matched.
				const { symbols: fileSymbols, resolution } = resolveContextFile(
					file,
					config.workspaceRoot,
					tracker.graph(branchId),
					() => tracker.getAllFiles(branchId).map((f) => f.path),
				);

				// Find which symbol contains the given file:line.
				const atLocation = fileSymbols.filter(
					(s) => s.startLine <= (line ?? 1) && s.endLine >= (line ?? 1),
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

				// Gather file-level imports by collecting callees from file symbols.
				// Stored spelling on both sides: `resolution.file` and every
				// `SymbolDefinition.filePath` are repo-relative.
				const importSet = new Set<string>();
				for (const sym of fileSymbols) {
					const symCallees = graphManager.getCallees(sym.id);
					for (const callee of symCallees) {
						if (callee.filePath !== resolution.file) {
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
								fileResolution: resolution,
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
