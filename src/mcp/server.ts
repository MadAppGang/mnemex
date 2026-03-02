/**
 * MCP Server Entry Point
 *
 * Wires together all MCP infrastructure components and registers all tools.
 * Launched when claudemem is started with --mcp flag.
 *
 * Startup sequence:
 * 1. Parse env vars → loadMcpConfig()
 * 2. Create logger
 * 3. Initialize IndexStateManager
 * 4. Check index existence — run blocking initial index if missing
 * 5. Create IndexCache
 * 6. Create CompletionDetector
 * 7. Create DebounceReindexer
 * 8. Start FileWatcher
 * 9. Register all MCP tools
 * 10. Connect stdio transport
 * 11. Register SIGTERM/SIGINT shutdown handlers
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

import { loadMcpConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { IndexStateManager } from "./state-manager.js";
import { IndexCache } from "./cache.js";
import { CompletionDetector } from "./completion-detector.js";
import { DebounceReindexer } from "./reindexer.js";
import { FileWatcher } from "./watcher.js";
import { getIndexDbPath } from "../config.js";

import {
	registerSearchTools,
	registerSymbolTools,
	registerCallersTools,
	registerCalleesTools,
	registerMapTools,
	registerContextTools,
	registerAnalysisTools,
	registerStatusTools,
	registerReindexTools,
	registerLegacyTools,
	type ToolDeps,
} from "./tools/index.js";

const SERVER_VERSION = "0.20.0";

/**
 * Run a blocking initial index when no index.db exists yet.
 * Spawns `claudemem index --quiet` and waits for it to complete.
 */
async function runBlockingIndex(
	workspaceRoot: string,
	logger: ReturnType<typeof createLogger>,
): Promise<void> {
	return new Promise((resolve, reject) => {
		logger.info("No index found — running initial index before starting server");

		const child = spawn("claudemem", ["index", "--quiet"], {
			cwd: workspaceRoot,
			stdio: "ignore",
		});

		child.on("exit", (code) => {
			if (code === 0) {
				logger.info("Initial index complete");
				resolve();
			} else {
				// Non-zero exit: warn but don't hard-fail — tools will report "no index" gracefully
				logger.warn(`Initial index exited with code ${code ?? "null"}, continuing`);
				resolve();
			}
		});

		child.on("error", (err) => {
			// If claudemem binary is not found, warn and continue rather than crashing
			logger.warn(`Could not run initial index: ${err.message}`);
			resolve();
		});
	});
}

/**
 * Start the MCP server.
 * Called from src/index.ts when --mcp flag is present.
 */
export async function startMcpServer(): Promise<void> {
	// -------------------------------------------------------------------------
	// Step 1: Load config from environment variables
	// -------------------------------------------------------------------------
	const config = loadMcpConfig();

	// -------------------------------------------------------------------------
	// Step 2: Create logger
	// -------------------------------------------------------------------------
	const logger = createLogger(config.logLevel);

	logger.debug("MCP server starting", { workspaceRoot: config.workspaceRoot });

	// -------------------------------------------------------------------------
	// Step 3: Initialize IndexStateManager
	// -------------------------------------------------------------------------
	const stateManager = new IndexStateManager(config.indexDir);
	await stateManager.initialize();

	// -------------------------------------------------------------------------
	// Step 4: Check index existence — run blocking initial index if missing
	// -------------------------------------------------------------------------
	const indexDbPath = getIndexDbPath(config.workspaceRoot);
	if (!existsSync(indexDbPath)) {
		await runBlockingIndex(config.workspaceRoot, logger);
	}

	// -------------------------------------------------------------------------
	// Step 5: Create IndexCache
	// -------------------------------------------------------------------------
	const cache = new IndexCache(
		config.workspaceRoot,
		config.indexDir,
		config.maxMemoryMB,
		logger,
	);

	// -------------------------------------------------------------------------
	// Step 6: Create CompletionDetector
	// -------------------------------------------------------------------------
	const completionDetector = new CompletionDetector(
		config.indexDir,
		config.completionPollMs,
	);

	// -------------------------------------------------------------------------
	// Step 7: Create DebounceReindexer
	// -------------------------------------------------------------------------
	const reindexer = new DebounceReindexer(
		config.workspaceRoot,
		config.indexDir,
		config.debounceMs,
		stateManager,
		cache,
		completionDetector,
		logger,
	);

	// -------------------------------------------------------------------------
	// Step 8: Start FileWatcher
	// -------------------------------------------------------------------------
	const watcher = new FileWatcher(
		config.workspaceRoot,
		config.watchPatterns,
		config.ignorePatterns,
		(filePath: string) => {
			stateManager.recordChange(filePath);
			reindexer.scheduleReindex();
		},
		logger,
	);

	watcher.start();
	const watcherActive = true;

	// -------------------------------------------------------------------------
	// Step 9: Build ToolDeps and create McpServer
	// -------------------------------------------------------------------------
	const serverStartTime = Date.now();

	const deps: ToolDeps = {
		cache,
		stateManager,
		config,
		logger,
		reindexer,
		completionDetector,
		serverStartTime,
		watcherActive,
	};

	const server = new McpServer({
		name: "claudemem",
		version: SERVER_VERSION,
	});

	// -------------------------------------------------------------------------
	// Step 10: Register all tools
	// -------------------------------------------------------------------------

	// New structured tools (11 tools)
	registerSearchTools(server, deps);
	registerSymbolTools(server, deps);
	registerCallersTools(server, deps);
	registerCalleesTools(server, deps);
	registerContextTools(server, deps);
	registerMapTools(server, deps);
	registerAnalysisTools(server, deps);
	registerStatusTools(server, deps);
	registerReindexTools(server, deps);

	// Legacy backward-compatible tools (7 tools: index_codebase, search_code,
	// clear_index, get_status, list_embedding_models, report_search_feedback,
	// get_learning_stats)
	registerLegacyTools(server, deps);

	// -------------------------------------------------------------------------
	// Step 11: Connect stdio transport
	// -------------------------------------------------------------------------
	const transport = new StdioServerTransport();
	await server.connect(transport);

	logger.info("MCP server ready", { version: SERVER_VERSION });

	// -------------------------------------------------------------------------
	// Step 12: Register shutdown handlers
	// -------------------------------------------------------------------------
	const shutdown = (signal: string) => {
		logger.info(`Received ${signal}, shutting down`);
		reindexer.cancelPending();
		watcher.stop();
		completionDetector.stop();
		cache.close();
		process.exit(0);
	};

	process.on("SIGTERM", () => shutdown("SIGTERM"));
	process.on("SIGINT", () => shutdown("SIGINT"));
}
