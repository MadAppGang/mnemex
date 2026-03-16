/**
 * Status Tool
 *
 * Reports index health: whether an index exists, how many files are indexed,
 * when it was last updated, server uptime, and watcher state.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ToolDeps } from "./deps.js";
import { buildFreshness, errorResponse } from "./deps.js";

export function registerStatusTools(server: McpServer, deps: ToolDeps): void {
	const { cache, stateManager, config, serverStartTime, watcherActive } = deps;

	server.tool(
		"index_status",
		"Get the health and status of the mnemex index: file counts, last indexed time, watcher state, and freshness.",
		{},
		async () => {
			const startTime = Date.now();

			try {
				const indexDbPath = join(config.indexDir, "index.db");
				const initialized = existsSync(indexDbPath);

				let indexSizeBytes = 0;
				let indexedFileCount = 0;
				let indexDbLastIndexed: string | null = null;

				if (initialized) {
					try {
						indexSizeBytes = statSync(indexDbPath).size;
					} catch {
						// Ignore stat errors
					}

					try {
						const { tracker } = await cache.get();
						const stats = tracker.getStats();
						indexedFileCount = stats.totalFiles;
						indexDbLastIndexed = stats.lastIndexed;
					} catch {
						// Cache not loadable - index may be empty
					}
				}

				const freshness = buildFreshness(stateManager, startTime);

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								initialized,
								indexPath: config.indexDir,
								indexDbLastIndexed,
								indexSizeBytes,
								indexedFileCount,
								fileWatcherActive: watcherActive,
								serverUptime: Date.now() - serverStartTime,
								...freshness,
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
