/**
 * Reindex Tool
 *
 * Triggers a background or blocking reindex of the workspace.
 * Does NOT include freshness metadata in its response (it changes the index state).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolDeps } from "./deps.js";
import { errorResponse } from "./deps.js";

export function registerReindexTools(server: McpServer, deps: ToolDeps): void {
	const { reindexer, completionDetector, logger } = deps;

	server.tool(
		"reindex",
		"Trigger a reindex of the workspace. Can be debounced (default) or forced immediately. Optionally block until complete.",
		{
			force: z
				.boolean()
				.default(false)
				.describe(
					"Skip debounce and reindex immediately (default: false)",
				),
			blocking: z
				.boolean()
				.default(false)
				.describe(
					"Wait until reindex completes before returning (default: false)",
				),
		},
		async ({ force, blocking }) => {
			const startTime = Date.now();

			try {
				if (!reindexer) {
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({
									status: "failed",
									message: "Reindexer not configured. The MCP server may not have been started with --watch mode.",
								}),
							},
						],
					};
				}

				// Check if already running (in-memory flag OR disk lock from any process)
				if (reindexer.isRunning()) {
					if (blocking && completionDetector) {
						logger.info("reindex: lock held, waiting for completion");
						const completed = await completionDetector.waitForCompletion();
						return {
							content: [
								{
									type: "text" as const,
									text: JSON.stringify({
										status: completed ? "completed" : "failed",
										durationMs: Date.now() - startTime,
										message: completed
											? "Reindex completed (was already in progress)"
											: "Timed out waiting for reindex",
									}),
								},
							],
						};
					}

					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({
									status: "already_running",
									message: "A reindex is already in progress.",
								}),
							},
						],
					};
				}

				if (force) {
					await reindexer.forceReindex();
				} else {
					reindexer.scheduleReindex();
				}

				if (blocking && completionDetector) {
					logger.info("reindex: waiting for completion");
					const completed = await completionDetector.waitForCompletion();
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({
									status: completed ? "completed" : "failed",
									durationMs: Date.now() - startTime,
									message: completed
										? "Reindex completed successfully"
										: "Timed out waiting for reindex to complete",
								}),
							},
						],
					};
				}

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								status: "started",
								message: force
									? "Reindex started immediately."
									: "Reindex scheduled (debounced).",
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
