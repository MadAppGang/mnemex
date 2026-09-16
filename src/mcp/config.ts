/**
 * MCP Server Configuration
 *
 * Reads environment variables on startup. No hot-reload.
 */

import { join } from "node:path";
import { PROJECT_CONFIG_DIR } from "../core/project-config.js";
import {
	getWorktreeDirFor,
	resolveStoreLocation,
	type StoreLocation,
} from "../core/store-location.js";
import {
	DEFAULT_PIPELINE_CONFIG,
	loadPipelineConfig,
	type PipelineConfig,
} from "../retrieval/pipeline/config.js";
import type { LogLevel } from "./logger.js";

export type { PipelineConfig };
export { DEFAULT_PIPELINE_CONFIG };

export interface McpConfig {
	/** Workspace root (CWD at startup) */
	workspaceRoot: string;
	/** Pipeline configuration */
	pipeline: PipelineConfig;
	/**
	 * The index STORE directory: `resolveStoreLocation(workspaceRoot).storeDir`,
	 * the function the store lock derives its path from. Honours
	 * MNEMEX_INDEX_DIR (absolute as-is, relative to the worktree root) and
	 * ProjectConfig.indexDir. Realpath spelling.
	 */
	indexDir: string;
	/** Where the memory store keeps `memories/`. NOT always `indexDir`: see {@link memoryDirFor}. */
	memoryDir: string;
	/**
	 * `<pathRoot>/.mnemex`, the PER-WORKTREE directory (§2.4). NOT the store.
	 *
	 * Added in Phase 3c, for `edit-history/`. `SymbolEditor` built its
	 * `EditHistory` on `indexDir`, which is the STORE — so the flip to
	 * `git-common-dir` would have relocated every user's edit backups into
	 * `<gitCommonDir>/mnemex/edit-history` and made one backup set shared by
	 * every worktree of the repository. §2.4 puts `edit-history/` per-worktree
	 * for the same reason it puts `memories/` there: it is authored data that
	 * cannot be rebuilt, so "abandon the old store and rebuild" — the migration
	 * strategy the whole flip rests on — does not cover it.
	 */
	worktreeDir: string;
	/** Debounce delay for reindexing in ms (MNEMEX_DEBOUNCE_MS, default 120000) */
	debounceMs: number;
	/** Glob patterns for files to watch (MNEMEX_WATCH_PATTERNS, comma-separated) */
	watchPatterns: string[];
	/** Glob patterns to ignore (MNEMEX_IGNORE_PATTERNS, comma-separated) */
	ignorePatterns: string[];
	/** Max memory usage in MB (MNEMEX_MAX_MEMORY_MB, default 500) */
	maxMemoryMB: number;
	/** Polling interval for completion detection in ms (MNEMEX_COMPLETION_POLL_MS, default 2000) */
	completionPollMs: number;
	/** Minimum log level (MNEMEX_LOG_LEVEL, default "warn") */
	logLevel: LogLevel;
	/** LSP configuration */
	lsp: LspConfig;
}

export interface LspConfig {
	/** Whether LSP integration is enabled (MNEMEX_LSP, default false) */
	enabled: boolean;
	/** Request timeout in ms (MNEMEX_LSP_TIMEOUT_MS, default 10000) */
	timeoutMs: number;
	/** Maximum concurrent language servers (MNEMEX_LSP_MAX_SERVERS, default 2) */
	maxServers: number;
	/** Languages to disable (MNEMEX_LSP_DISABLE, comma-separated) */
	disabledLanguages: string[];
	/** Per-language command overrides */
	tsCommand?: string;
	pyCommand?: string;
	goCommand?: string;
	rsCommand?: string;
}

const DEFAULT_WATCH_PATTERNS = [
	"**/*.{ts,tsx,js,jsx,go,py,rs,java,kt,swift,rb,php,c,cpp,h}",
];

const DEFAULT_IGNORE_PATTERNS = [
	"node_modules/**",
	".git/**",
	"dist/**",
	"build/**",
	".next/**",
	"coverage/**",
];

const DEFAULT_DEBOUNCE_MS = 120000;
const DEFAULT_MAX_MEMORY_MB = 500;
const DEFAULT_COMPLETION_POLL_MS = 2000;
const DEFAULT_LOG_LEVEL: LogLevel = "warn";

/**
 * Where the MCP memory store lives. Deliberately NOT always the store directory.
 *
 * Memories are authored and cannot be rebuilt, so they are per-worktree data,
 * not store data (architecture §2.4), and the store lock does not guard them.
 * Before decision I-8 they lived in this file's own resolver's directory,
 * `join(workspaceRoot, MNEMEX_INDEX_DIR ?? ".mnemex")`. Binding them to the
 * seam's `storeDir` would silently move the memories of every user with
 * `ProjectConfig.indexDir` (which that resolver ignored), and from Phase 3c
 * everyone's, into the shared store. So they keep today's rule:
 *
 *   MNEMEX_INDEX_DIR set   the store directory: memories always followed the
 *                          variable. An ABSOLUTE value now lands where it names,
 *                          not double-joined onto the workspace root.
 *   otherwise              `<workspaceRoot>/.mnemex`, wherever the store is.
 *
 * Phase 3c moves them to `worktreeDir`, with the other per-worktree files.
 */
export function memoryDirFor(
	loc: StoreLocation,
	workspaceRoot: string,
): string {
	return loc.kind === "env-override"
		? loc.storeDir
		: join(workspaceRoot, PROJECT_CONFIG_DIR);
}

/**
 * Parse environment variables and return an McpConfig.
 * Invalid numeric values fall back to defaults.
 *
 * @param workspaceRoot defaults to the CWD at startup, which is what the server
 *   passes; tests pass a fixture directory instead of changing the CWD.
 */
export function loadMcpConfig(
	workspaceRoot: string = process.cwd(),
): McpConfig {
	// ONE resolver (decision I-8): the store directory comes from the seam, the
	// same function `createStoreLock` derives the lock from. This used to read
	// MNEMEX_INDEX_DIR itself, ignoring ProjectConfig.indexDir and double-joining
	// an absolute value onto the workspace root, so the MCP server's state files
	// and the lock it inspected could name two different stores.
	const storeLocation = resolveStoreLocation(workspaceRoot);
	const indexDir = storeLocation.storeDir;
	const memoryDir = memoryDirFor(storeLocation, workspaceRoot);
	const worktreeDir = getWorktreeDirFor(storeLocation);

	const debounceMs = parseIntWithDefault(
		process.env.MNEMEX_DEBOUNCE_MS,
		DEFAULT_DEBOUNCE_MS,
	);

	const watchPatterns = parsePatterns(
		process.env.MNEMEX_WATCH_PATTERNS,
		DEFAULT_WATCH_PATTERNS,
	);

	const ignorePatterns = parsePatterns(
		process.env.MNEMEX_IGNORE_PATTERNS,
		DEFAULT_IGNORE_PATTERNS,
	);

	const maxMemoryMB = parseIntWithDefault(
		process.env.MNEMEX_MAX_MEMORY_MB,
		DEFAULT_MAX_MEMORY_MB,
	);

	const completionPollMs = parseIntWithDefault(
		process.env.MNEMEX_COMPLETION_POLL_MS,
		DEFAULT_COMPLETION_POLL_MS,
	);

	const logLevel = parseLogLevel(process.env.MNEMEX_LOG_LEVEL);

	const lsp: LspConfig = {
		enabled: parseBool(process.env.MNEMEX_LSP, false),
		timeoutMs: parseIntWithDefault(process.env.MNEMEX_LSP_TIMEOUT_MS, 10000),
		maxServers: parseIntWithDefault(process.env.MNEMEX_LSP_MAX_SERVERS, 2),
		disabledLanguages: parsePatterns(process.env.MNEMEX_LSP_DISABLE, []),
		tsCommand: process.env.MNEMEX_LSP_TS_CMD,
		pyCommand: process.env.MNEMEX_LSP_PY_CMD,
		goCommand: process.env.MNEMEX_LSP_GO_CMD,
		rsCommand: process.env.MNEMEX_LSP_RS_CMD,
	};

	return {
		workspaceRoot,
		indexDir,
		memoryDir,
		worktreeDir,
		debounceMs,
		watchPatterns,
		ignorePatterns,
		maxMemoryMB,
		completionPollMs,
		logLevel,
		lsp,
		pipeline: loadPipelineConfig(),
	};
}

function parseIntWithDefault(
	value: string | undefined,
	defaultValue: number,
): number {
	if (value === undefined || value === "") return defaultValue;
	const parsed = Number.parseInt(value, 10);
	return Number.isNaN(parsed) ? defaultValue : parsed;
}

function parsePatterns(
	value: string | undefined,
	defaultValue: string[],
): string[] {
	if (!value || value.trim() === "") return defaultValue;
	const patterns = value
		.split(",")
		.map((p) => p.trim())
		.filter((p) => p.length > 0);
	return patterns.length > 0 ? patterns : defaultValue;
}

function parseBool(value: string | undefined, defaultValue: boolean): boolean {
	if (value === undefined || value === "") return defaultValue;
	return value === "true" || value === "1";
}

function parseLogLevel(value: string | undefined): LogLevel {
	const validLevels: LogLevel[] = ["debug", "info", "warn", "error"];
	if (value && validLevels.includes(value as LogLevel)) {
		return value as LogLevel;
	}
	return DEFAULT_LOG_LEVEL;
}
