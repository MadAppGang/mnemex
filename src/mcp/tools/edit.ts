/**
 * Edit Tools
 *
 * MCP tools for editing code: edit_symbol, edit_lines, restore_edit.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolDeps } from "./deps.js";
import { buildFreshness, errorResponse } from "./deps.js";

export function registerEditTools(server: McpServer, deps: ToolDeps): void {
	const { stateManager } = deps;
	const editor = deps.editor;

	if (!editor) return;

	server.tool(
		"edit_symbol",
		"Replace, insert before, or insert after a symbol's body in source code. " +
		"Locates the symbol by name using the AST index, validates syntax, " +
		"backs up the original, and triggers reindex.",
		{
			symbol: z.string().describe("Symbol name to edit"),
			file: z
				.string()
				.optional()
				.describe("File path hint to disambiguate symbols with the same name"),
			newContent: z.string().describe("New source code content"),
			insertMode: z
				.enum(["replace", "before", "after"])
				.default("replace")
				.describe("How to apply the edit: replace the symbol body, insert before, or insert after"),
			dryRun: z
				.boolean()
				.default(false)
				.describe("If true, validate and report what would change without writing"),
		},
		async ({ symbol, file, newContent, insertMode, dryRun }) => {
			const startTime = Date.now();

			try {
				const result = await editor.editSymbol(symbol, newContent, insertMode, {
					dryRun,
				});

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								...result,
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
		"edit_lines",
		"Replace a range of lines in a file. Validates syntax, backs up the original, " +
		"and triggers reindex.",
		{
			file: z.string().describe("File path (relative to workspace root)"),
			startLine: z.number().int().min(1).describe("First line to replace (1-indexed)"),
			endLine: z.number().int().min(1).describe("Last line to replace (1-indexed, inclusive)"),
			newContent: z.string().describe("New source code content for the line range"),
			dryRun: z
				.boolean()
				.default(false)
				.describe("If true, validate and report what would change without writing"),
		},
		async ({ file, startLine, endLine, newContent, dryRun }) => {
			const startTime = Date.now();

			try {
				const result = await editor.editLines(file, startLine, endLine, newContent, {
					dryRun,
				});

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								...result,
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
		"restore_edit",
		"Restore files from a previous edit session backup. If no sessionId is provided, " +
		"restores the most recent session.",
		{
			sessionId: z
				.string()
				.optional()
				.describe("Session ID to restore (omit for most recent)"),
		},
		async ({ sessionId }) => {
			const startTime = Date.now();

			try {
				const restoredFiles = await editor.restoreSession(sessionId);

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								restored: restoredFiles,
								count: restoredFiles.length,
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
