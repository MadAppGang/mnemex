/**
 * LSP Query Tools
 *
 * MCP tools for LSP-powered code navigation: define, references, hover.
 * All tools fall back to tree-sitter when LSP is unavailable.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ToolDeps } from "./deps.js";
import { buildFreshness, errorResponse } from "./deps.js";
import {
	LSP_METHODS,
	pathToUri,
	uriToPath,
	type Location,
	type Hover,
	type MarkupContent,
} from "../../lsp/protocol.js";

export function registerLspTools(server: McpServer, deps: ToolDeps): void {
	const { cache, stateManager, config, lspManager } = deps;

	server.tool(
		"define",
		"Find the definition of a symbol. Uses LSP when available, falls back to tree-sitter AST index.",
		{
			symbol: z
				.string()
				.optional()
				.describe("Symbol name to look up (uses AST index)"),
			file: z
				.string()
				.optional()
				.describe("File path for position-based lookup (requires line/column)"),
			line: z
				.number()
				.int()
				.optional()
				.describe("Line number (1-indexed) for position-based lookup"),
			column: z
				.number()
				.int()
				.optional()
				.describe("Column number (1-indexed) for position-based lookup"),
		},
		async ({ symbol, file, line, column }) => {
			const startTime = Date.now();

			try {
				let result: {
					file: string;
					line: number;
					endLine?: number;
					kind?: string;
					name?: string;
					lspAvailable: boolean;
				} | null = null;

				// Position-based lookup via LSP
				if (file && line !== undefined && column !== undefined && lspManager) {
					const absPath = resolve(config.workspaceRoot, file);
					const lang = lspManager.detectServerLanguage(absPath);

					if (lang) {
						const client = await lspManager.getClient(lang);

						if (client) {
							// Ensure file is open
							const langId = lspManager.detectLanguageId(absPath) ?? lang;
							const content = readFileSync(absPath, "utf-8");
							client.openFile(absPath, langId, content);

							try {
								const lspResult = await client.request<
									Location | Location[] | null
								>(LSP_METHODS.DEFINITION, {
									textDocument: { uri: pathToUri(absPath) },
									position: { line: line - 1, character: column - 1 },
								});

								const loc = Array.isArray(lspResult) ? lspResult[0] : lspResult;
								if (loc?.uri) {
									const defPath = uriToPath(loc.uri);
									const relPath = defPath.startsWith(config.workspaceRoot)
										? defPath.slice(config.workspaceRoot.length + 1)
										: defPath;
									result = {
										file: relPath,
										line: loc.range.start.line + 1,
										endLine: loc.range.end.line + 1,
										lspAvailable: true,
									};
								}
							} catch {
								// LSP failed, fall through to tree-sitter
							}
						}
					}
				}

				// Fall back to tree-sitter AST index
				if (!result && symbol) {
					const { graphManager } = await cache.get();
					const found = graphManager.findSymbol(symbol, {
						preferExported: true,
					});
					if (found) {
						result = {
							file: found.filePath,
							line: found.startLine,
							endLine: found.endLine,
							kind: found.kind,
							name: found.name,
							lspAvailable: !!lspManager?.getClientForFile(
								resolve(config.workspaceRoot, found.filePath),
							),
						};
					}
				}

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								definition: result,
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

	server.tool(
		"references",
		"Find all references to a symbol. Uses LSP when available, falls back to the AST caller graph.",
		{
			symbol: z
				.string()
				.optional()
				.describe("Symbol name to look up (uses AST index)"),
			file: z
				.string()
				.optional()
				.describe("File path for position-based lookup"),
			line: z.number().int().optional().describe("Line number (1-indexed)"),
			column: z.number().int().optional().describe("Column number (1-indexed)"),
			includeDeclaration: z
				.boolean()
				.default(true)
				.describe("Include the declaration itself in results"),
		},
		async ({ symbol, file, line, column, includeDeclaration }) => {
			const startTime = Date.now();

			try {
				let refs: Array<{ file: string; line: number; context?: string }> = [];
				let lspAvailable = false;

				// Position-based lookup via LSP
				if (file && line !== undefined && column !== undefined && lspManager) {
					const absPath = resolve(config.workspaceRoot, file);
					const lang = lspManager.detectServerLanguage(absPath);

					if (lang) {
						const client = await lspManager.getClient(lang);
						if (client) {
							const langId = lspManager.detectLanguageId(absPath) ?? lang;
							const content = readFileSync(absPath, "utf-8");
							client.openFile(absPath, langId, content);

							try {
								const lspResult = await client.request<Location[] | null>(
									LSP_METHODS.REFERENCES,
									{
										textDocument: { uri: pathToUri(absPath) },
										position: { line: line - 1, character: column - 1 },
										context: { includeDeclaration },
									},
								);

								if (lspResult) {
									lspAvailable = true;
									refs = lspResult.map((loc) => {
										const refPath = uriToPath(loc.uri);
										const relPath = refPath.startsWith(config.workspaceRoot)
											? refPath.slice(config.workspaceRoot.length + 1)
											: refPath;
										return { file: relPath, line: loc.range.start.line + 1 };
									});
								}
							} catch {
								// Fall through to tree-sitter
							}
						}
					}
				}

				// Fall back to AST callers
				if (refs.length === 0 && symbol) {
					const { graphManager } = await cache.get();
					const found = graphManager.findSymbol(symbol, {
						preferExported: true,
					});
					if (found) {
						const callers = graphManager.getCallers(found.id);
						refs = callers.map((c) => ({
							file: c.filePath,
							line: c.startLine,
							context: c.signature ?? c.name,
						}));
					}
				}

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								references: refs,
								count: refs.length,
								lspAvailable,
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

	server.tool(
		"hover",
		"Get type signature and documentation for a symbol at a position. " +
			"LSP-only — no fallback when LSP is unavailable.",
		{
			file: z.string().describe("File path"),
			line: z.number().int().min(1).describe("Line number (1-indexed)"),
			column: z.number().int().min(1).describe("Column number (1-indexed)"),
		},
		async ({ file, line, column }) => {
			const startTime = Date.now();

			try {
				if (!lspManager) {
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({
									hover: null,
									lspAvailable: false,
									message:
										"LSP is not enabled. Set MNEMEX_LSP=true to enable.",
									...buildFreshness(stateManager, startTime),
								}),
							},
						],
					};
				}

				const absPath = resolve(config.workspaceRoot, file);
				const lang = lspManager.detectServerLanguage(absPath);

				if (!lang) {
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({
									hover: null,
									lspAvailable: false,
									message: `No language server available for ${file}`,
									...buildFreshness(stateManager, startTime),
								}),
							},
						],
					};
				}

				const client = await lspManager.getClient(lang);
				if (!client) {
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({
									hover: null,
									lspAvailable: false,
									message: `Language server for '${lang}' is not available`,
									...buildFreshness(stateManager, startTime),
								}),
							},
						],
					};
				}

				const langId = lspManager.detectLanguageId(absPath) ?? lang;
				const content = readFileSync(absPath, "utf-8");
				client.openFile(absPath, langId, content);

				const hoverResult = await client.request<Hover | null>(
					LSP_METHODS.HOVER,
					{
						textDocument: { uri: pathToUri(absPath) },
						position: { line: line - 1, character: column - 1 },
					},
				);

				let hoverText: string | null = null;
				if (hoverResult?.contents) {
					if (typeof hoverResult.contents === "string") {
						hoverText = hoverResult.contents;
					} else if ("value" in hoverResult.contents) {
						hoverText = (hoverResult.contents as MarkupContent).value;
					} else if (Array.isArray(hoverResult.contents)) {
						hoverText = hoverResult.contents
							.map((c) => (typeof c === "string" ? c : c.value))
							.join("\n");
					}
				}

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								hover: hoverText,
								range: hoverResult?.range
									? {
											startLine: hoverResult.range.start.line + 1,
											startColumn: hoverResult.range.start.character + 1,
											endLine: hoverResult.range.end.line + 1,
											endColumn: hoverResult.range.end.character + 1,
										}
									: null,
								lspAvailable: true,
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
