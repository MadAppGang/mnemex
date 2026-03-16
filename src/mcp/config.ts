/**
 * MCP Server Configuration
 *
 * Reads environment variables on startup. No hot-reload.
 */

import { join } from "node:path";
import {
	DEFAULT_PIPELINE_CONFIG,
	type PipelineConfig,
	loadPipelineConfig,
} from "../retrieval/pipeline/config.js";
import type { LogLevel } from "./logger.js";

export type { PipelineConfig };
export { DEFAULT_PIPELINE_CONFIG };

export interface McpConfig {
	/** Workspace root (CWD at startup) */
	workspaceRoot: string;
	/** Pipeline configuration */
	pipeline: PipelineConfig;
	/** Index directory (MNEMEX_INDEX_DIR relative to workspaceRoot, or ".mnemex") */
	indexDir: string;
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
 * Parse environment variables and return an McpConfig.
 * Invalid numeric values fall back to defaults.
 */
export function loadMcpConfig(): McpConfig {
	const workspaceRoot = process.cwd();

	const indexDirEnv = process.env.MNEMEX_INDEX_DIR;
	const indexDir = indexDirEnv
		? join(workspaceRoot, indexDirEnv)
		: join(workspaceRoot, ".mnemex");

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
