/**
 * Status Tool
 *
 * Reports index health: whether an index exists, how many files are indexed,
 * when it was last updated, server uptime, and watcher state.
 */

import { existsSync, statSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
	getIndexDbPathFor,
	resolveStoreLocation,
} from "../../core/store-location.js";
import { buildIndexState } from "../index-state.js";
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
				// The store the lock guards, from the one resolver (decision I-8).
				const indexDbPath = getIndexDbPathFor(
					resolveStoreLocation(config.workspaceRoot),
				);
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
				const indexState = await buildIndexState(deps, startTime);

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								initialized,
								indexPath: config.indexDir,
								// CONTRACT (A9): index.lastIndexed (from stateManager, in the
								// spread ...indexState) is authoritative. indexDbLastIndexed is
								// the legacy tracker-derived value, retained for back-compat; it
								// may diverge from index.lastIndexed (tracker vs stateManager).
								indexDbLastIndexed,
								indexSizeBytes,
								indexedFileCount,
								fileWatcherActive: watcherActive,
								serverUptime: Date.now() - serverStartTime,
								...freshness,
								...indexState,
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
