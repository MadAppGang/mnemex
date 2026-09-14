/**
 * MCP Server Entry Point
 *
 * Wires together all MCP infrastructure components and registers all tools.
 * Launched when mnemex is started with --mcp flag.
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

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { getIndexDbPath } from "../config.js";
import {
	type AwaitedEntryPointLauncher,
	spawnMnemexAwaited,
	spawnMnemexDetached,
} from "../core/entry-point-launcher.js";
import { primeSecrets } from "../core/secrets.js";
import {
	getLockPathFor,
	resolveStoreLocation,
} from "../core/store-location.js";
import { SymbolEditor } from "../editor/editor.js";
import { LspManager } from "../lsp/manager.js";
import { MemoryStore } from "../memory/store.js";
import { IndexCache } from "./cache.js";
import { CompletionDetector } from "./completion-detector.js";
import { loadMcpConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { DebounceReindexer, spawnDetachedReindex } from "./reindexer.js";
import { IndexStateManager } from "./state-manager.js";
import {
	registerAnalysisTools,
	registerCalleesTools,
	registerCallersTools,
	registerContextTools,
	registerEditTools,
	registerLegacyTools,
	registerLspTools,
	registerMapTools,
	registerMemoryTools,
	registerObserveTools,
	registerReadFileTools,
	registerReindexTools,
	registerRenameTools,
	registerSearchPatternTools,
	registerSearchTools,
	registerStatusTools,
	registerSymbolTools,
	registerThinkTools,
	type ToolDeps,
} from "./tools/index.js";
import { FileWatcher } from "./watcher.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function readVersion(): string {
	for (const rel of ["../package.json", "../../package.json"]) {
		const p = join(__dirname, rel);
		if (existsSync(p)) {
			try {
				return JSON.parse(readFileSync(p, "utf-8")).version;
			} catch {}
		}
	}
	return "0.0.0";
}

const SERVER_VERSION: string = readVersion();

/**
 * Run a blocking initial index when no index.db exists yet.
 * Spawns `mnemex index --quiet` and waits for it to complete.
 */
async function runBlockingIndex(
	workspaceRoot: string,
	logger: ReturnType<typeof createLogger>,
	/**
	 * Who starts the child. The literal `spawn("mnemex", …)` that used to sit
	 * here was the same bare-binary-name bypass found in `src/editor/editor.ts`
	 * (round 4): a name with no path in it, resolved through `PATH`, running the
	 * production entry point and therefore enabling real keychain access inside
	 * the child. See `src/core/entry-point-launcher.ts`.
	 */
	launch: AwaitedEntryPointLauncher,
): Promise<void> {
	return new Promise((resolve) => {
		logger.info(
			"No index found — running initial index before starting server",
		);

		let child: ReturnType<AwaitedEntryPointLauncher>;
		try {
			child = launch(["index", "--quiet"], workspaceRoot);
		} catch (err) {
			// The launcher refuses outright in a guarded (test) process. Same
			// best-effort contract as the 'error' path below: tools report "no
			// index" gracefully rather than the server failing to start.
			logger.warn(
				`Could not run initial index: ${err instanceof Error ? err.message : String(err)}`,
			);
			resolve();
			return;
		}

		child.on("exit", (code) => {
			if (code === 0) {
				logger.info("Initial index complete");
				resolve();
			} else {
				// Non-zero exit: warn but don't hard-fail — tools will report "no index" gracefully
				logger.warn(
					`Initial index exited with code ${code ?? "null"}, continuing`,
				);
				resolve();
			}
		});

		child.on("error", (err) => {
			// If mnemex binary is not found, warn and continue rather than crashing
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
	// Step 2b: Prime API keys ONCE into a session cache (long-lived process only)
	// -------------------------------------------------------------------------
	// Search and observe construct an embeddings client PER REQUEST, so without
	// this an interactive user pays a fresh Bun.spawnSync on most requests and a
	// locked keychain freezes the whole server once per request.
	//
	// If priming FAILS the cache is left EMPTY — never negatively populated. A
	// negatively populated cache would make the server permanently believe nothing
	// is stored; an empty one falls through to the normal read path, where the
	// circuit breaker suppresses the follow-on spawns anyway.
	//
	// The trade: a user who edits the keychain in Keychain Access.app while this
	// server runs is not picked up until it restarts. That applies ONLY here; the
	// CLI, the wizard and the indexer keep the 3 s burst window.
	const primed = primeSecrets();
	logger.debug("Primed secrets", {
		primed: primed.primed,
		failed: primed.failed,
	});

	// -------------------------------------------------------------------------
	// Step 3: Initialize IndexStateManager
	// -------------------------------------------------------------------------
	// The resolved store: where the spawned `mnemex index` takes its lock.
	const storeLocation = resolveStoreLocation(config.workspaceRoot);
	const stateManager = new IndexStateManager(config.indexDir, storeLocation);
	await stateManager.initialize();

	// -------------------------------------------------------------------------
	// Step 4: Check index existence — run blocking initial index if missing
	// -------------------------------------------------------------------------
	const indexDbPath = getIndexDbPath(config.workspaceRoot);
	if (!existsSync(indexDbPath)) {
		await runBlockingIndex(config.workspaceRoot, logger, spawnMnemexAwaited);
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
		getLockPathFor(storeLocation),
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
		// The real one. This is the ONE place that launches the installed entry
		// point in the background; see `spawnDetachedReindex` for why it is a
		// parameter and not a hard-coded `spawn`.
		spawnDetachedReindex,
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
	// Step 8a: Create LspManager (lazy — no servers spawned yet)
	// -------------------------------------------------------------------------
	const lspManager = config.lsp.enabled
		? new LspManager({
				enabled: true,
				timeoutMs: config.lsp.timeoutMs,
				maxServers: config.lsp.maxServers,
				disabledLanguages: config.lsp.disabledLanguages,
				workspaceRoot: config.workspaceRoot,
				commandOverrides: {
					...(config.lsp.tsCommand ? { typescript: config.lsp.tsCommand } : {}),
					...(config.lsp.pyCommand ? { python: config.lsp.pyCommand } : {}),
					...(config.lsp.goCommand ? { go: config.lsp.goCommand } : {}),
					...(config.lsp.rsCommand ? { rust: config.lsp.rsCommand } : {}),
				},
			})
		: null;

	if (lspManager) {
		logger.debug("LSP manager created (lazy initialization)");
	}

	// -------------------------------------------------------------------------
	// Step 8b: Create SymbolEditor
	// -------------------------------------------------------------------------
	const editor = new SymbolEditor(
		cache,
		config,
		// The production reindex launcher, supplied explicitly. See
		// `src/core/entry-point-launcher.ts` for why it is injected.
		spawnMnemexDetached,
		lspManager,
	);

	// -------------------------------------------------------------------------
	// Step 8c: Create MemoryStore
	// -------------------------------------------------------------------------
	const memoryStore = new MemoryStore(config.indexDir);

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
		lspManager,
		editor,
		memoryStore,
	};

	const server = new McpServer({
		name: "mnemex",
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

	// Editor, LSP, rename, memory, and think tools
	registerEditTools(server, deps);
	registerLspTools(server, deps);
	registerRenameTools(server, deps);
	registerMemoryTools(server, deps);
	registerObserveTools(server, deps);
	registerThinkTools(server);

	// File reading and pattern search tools
	registerReadFileTools(server, deps);
	registerSearchPatternTools(server, deps);

	// -------------------------------------------------------------------------
	// Step 11: Connect stdio transport
	// -------------------------------------------------------------------------
	const transport = new StdioServerTransport();
	await server.connect(transport);

	logger.info("MCP server ready", { version: SERVER_VERSION });

	// -------------------------------------------------------------------------
	// Step 12: Register shutdown handlers
	// -------------------------------------------------------------------------
	const shutdown = async (signal: string) => {
		logger.info(`Received ${signal}, shutting down`);
		reindexer.cancelPending();
		watcher.stop();
		completionDetector.stop();
		// Shut down LSP servers before exiting (review fix: async shutdown before process.exit)
		if (lspManager) {
			await lspManager.shutdown();
		}
		cache.close();
		process.exit(0);
	};

	process.on("SIGTERM", () => shutdown("SIGTERM"));
	process.on("SIGINT", () => shutdown("SIGINT"));
}
