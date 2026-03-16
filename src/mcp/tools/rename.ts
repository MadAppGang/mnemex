/**
 * Rename Tool
 *
 * MCP tool for renaming symbols across the codebase.
 * Uses LSP textDocument/rename when available, falls back to text search.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ToolDeps } from "./deps.js";
import { buildFreshness, errorResponse } from "./deps.js";
import {
	LSP_METHODS,
	pathToUri,
	type WorkspaceEdit,
} from "../../lsp/protocol.js";
import { WorkspaceEditApplier } from "../../editor/workspace-edit.js";

export function registerRenameTools(server: McpServer, deps: ToolDeps): void {
	const { cache, stateManager, config, lspManager, editor } = deps;

	if (!editor) return;

	server.tool(
		"rename_symbol",
		"Rename a symbol across the codebase. Uses LSP textDocument/rename when available " +
			"for type-aware renaming. Falls back to text replacement with a warning.",
		{
			symbol: z.string().describe("Current symbol name"),
			newName: z.string().describe("New name for the symbol"),
			file: z
				.string()
				.optional()
				.describe("File containing the symbol (for LSP position-based rename)"),
			line: z.number().int().optional().describe("Line number (1-indexed)"),
			column: z.number().int().optional().describe("Column number (1-indexed)"),
			dryRun: z
				.boolean()
				.default(false)
				.describe("Preview changes without applying them"),
		},
		async ({ symbol: symbolName, newName, file, line, column, dryRun }) => {
			const startTime = Date.now();

			try {
				// Try LSP rename first
				if (lspManager && file && line !== undefined && column !== undefined) {
					const absPath = resolve(config.workspaceRoot, file);
					const lang = lspManager.detectServerLanguage(absPath);

					if (lang) {
						const client = await lspManager.getClient(lang);

						if (client) {
							const langId = lspManager.detectLanguageId(absPath) ?? lang;
							const content = readFileSync(absPath, "utf-8");
							client.openFile(absPath, langId, content);

							try {
								const wsEdit = await client.request<WorkspaceEdit | null>(
									LSP_METHODS.RENAME,
									{
										textDocument: { uri: pathToUri(absPath) },
										position: { line: line - 1, character: column - 1 },
										newName,
									},
								);

								if (wsEdit) {
									const applier = new WorkspaceEditApplier(
										config.workspaceRoot,
										editor.getHistory(),
									);

									const result = await applier.apply(wsEdit, { dryRun });

									return {
										content: [
											{
												type: "text" as const,
												text: JSON.stringify({
													renamed: symbolName,
													newName,
													method: "lsp",
													...result,
													...buildFreshness(stateManager, startTime),
												}),
											},
										],
									};
								}
							} catch {
								// Fall through to text-based rename
							}
						}
					}
				}

				// Fallback: text-based rename via AST index
				const { graphManager, tracker } = await cache.get();
				const found = graphManager.findSymbol(symbolName, {
					preferExported: true,
					fileHint: file,
				});

				if (!found) {
					throw new Error(`Symbol '${symbolName}' not found in index`);
				}

				// Get all callers to find reference locations
				const callers = graphManager.getCallers(found.id);
				const filesToEdit = new Set<string>();
				filesToEdit.add(found.filePath);
				for (const c of callers) {
					filesToEdit.add(c.filePath);
				}

				if (dryRun) {
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({
									renamed: symbolName,
									newName,
									method: "text-search",
									warning:
										"Text-based rename — may miss type-resolved references. Review changes carefully.",
									filesAffected: Array.from(filesToEdit),
									dryRun: true,
									...buildFreshness(stateManager, startTime),
								}),
							},
						],
					};
				}

				// Apply text replacements
				const changedFiles: string[] = [];
				const history = editor.getHistory();
				const sessionId = require("node:crypto").randomBytes(8).toString("hex");

				for (const relPath of filesToEdit) {
					const absPath = resolve(config.workspaceRoot, relPath);
					const content = readFileSync(absPath, "utf-8");

					// Word-boundary replacement to avoid partial matches
					const regex = new RegExp(`\\b${escapeRegex(symbolName)}\\b`, "g");
					const newContent = content.replace(regex, newName);

					if (newContent !== content) {
						await history.backup(sessionId, absPath, content);
						writeFileSync(absPath, newContent, "utf-8");
						changedFiles.push(relPath);
					}
				}

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								renamed: symbolName,
								newName,
								method: "text-search",
								warning: "Text-based rename — review changes carefully.",
								renamedFiles: changedFiles,
								totalEdits: changedFiles.length,
								sessionId,
								dryRun: false,
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

function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
