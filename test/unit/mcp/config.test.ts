/**
 * Unit tests for loadMcpConfig()
 *
 * Tests that environment variables are correctly parsed, that default values
 * are returned when env vars are absent, and that invalid values fall back
 * gracefully to defaults.
 *
 * Black-box: tests operate through the public loadMcpConfig() API only.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { loadMcpConfig } from "../../../src/mcp/config.js";

// ---------------------------------------------------------------------------
// Helpers: save/restore env vars around each test
// ---------------------------------------------------------------------------

const ENV_KEYS = [
	"CLAUDEMEM_INDEX_DIR",
	"CLAUDEMEM_DEBOUNCE_MS",
	"CLAUDEMEM_WATCH_PATTERNS",
	"CLAUDEMEM_IGNORE_PATTERNS",
	"CLAUDEMEM_MAX_MEMORY_MB",
	"CLAUDEMEM_COMPLETION_POLL_MS",
	"CLAUDEMEM_LOG_LEVEL",
] as const;

type EnvSnapshot = Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>;

function saveEnv(): EnvSnapshot {
	const snap: EnvSnapshot = {};
	for (const key of ENV_KEYS) {
		snap[key] = process.env[key];
	}
	return snap;
}

function restoreEnv(snap: EnvSnapshot): void {
	for (const key of ENV_KEYS) {
		if (snap[key] === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = snap[key];
		}
	}
}

function clearMcpEnv(): void {
	for (const key of ENV_KEYS) {
		delete process.env[key];
	}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("loadMcpConfig()", () => {
	let envSnapshot: EnvSnapshot;

	beforeEach(() => {
		envSnapshot = saveEnv();
		clearMcpEnv();
	});

	afterEach(() => {
		restoreEnv(envSnapshot);
	});

	// -------------------------------------------------------------------------
	// Default values
	// -------------------------------------------------------------------------

	describe("default values when no env vars are set", () => {
		test("debounceMs defaults to 120000", () => {
			const config = loadMcpConfig();
			expect(config.debounceMs).toBe(120_000);
		});

		test("maxMemoryMB defaults to 500", () => {
			const config = loadMcpConfig();
			expect(config.maxMemoryMB).toBe(500);
		});

		test("completionPollMs defaults to 2000", () => {
			const config = loadMcpConfig();
			expect(config.completionPollMs).toBe(2000);
		});

		test("logLevel defaults to 'warn'", () => {
			const config = loadMcpConfig();
			expect(config.logLevel).toBe("warn");
		});

		test("watchPatterns defaults to a non-empty array", () => {
			const config = loadMcpConfig();
			expect(Array.isArray(config.watchPatterns)).toBe(true);
			expect(config.watchPatterns.length).toBeGreaterThan(0);
		});

		test("ignorePatterns defaults to a non-empty array", () => {
			const config = loadMcpConfig();
			expect(Array.isArray(config.ignorePatterns)).toBe(true);
			expect(config.ignorePatterns.length).toBeGreaterThan(0);
		});

		test("indexDir defaults to .claudemem under workspaceRoot", () => {
			const config = loadMcpConfig();
			// workspaceRoot is process.cwd()
			expect(config.indexDir).toContain(".claudemem");
			expect(config.indexDir.startsWith(config.workspaceRoot)).toBe(true);
		});

		test("workspaceRoot equals process.cwd()", () => {
			const config = loadMcpConfig();
			expect(config.workspaceRoot).toBe(process.cwd());
		});
	});

	// -------------------------------------------------------------------------
	// Numeric parsing
	// -------------------------------------------------------------------------

	describe("CLAUDEMEM_DEBOUNCE_MS", () => {
		test("parses a valid integer", () => {
			process.env.CLAUDEMEM_DEBOUNCE_MS = "5000";
			const config = loadMcpConfig();
			expect(config.debounceMs).toBe(5000);
		});

		test("falls back to default for non-numeric value 'abc'", () => {
			process.env.CLAUDEMEM_DEBOUNCE_MS = "abc";
			const config = loadMcpConfig();
			expect(config.debounceMs).toBe(120_000);
		});

		test("falls back to default for empty string", () => {
			process.env.CLAUDEMEM_DEBOUNCE_MS = "";
			const config = loadMcpConfig();
			expect(config.debounceMs).toBe(120_000);
		});
	});

	describe("CLAUDEMEM_MAX_MEMORY_MB", () => {
		test("parses a valid integer", () => {
			process.env.CLAUDEMEM_MAX_MEMORY_MB = "1024";
			const config = loadMcpConfig();
			expect(config.maxMemoryMB).toBe(1024);
		});

		test("falls back to default for non-numeric value", () => {
			process.env.CLAUDEMEM_MAX_MEMORY_MB = "not-a-number";
			const config = loadMcpConfig();
			expect(config.maxMemoryMB).toBe(500);
		});
	});

	describe("CLAUDEMEM_COMPLETION_POLL_MS", () => {
		test("parses a valid integer", () => {
			process.env.CLAUDEMEM_COMPLETION_POLL_MS = "500";
			const config = loadMcpConfig();
			expect(config.completionPollMs).toBe(500);
		});

		test("falls back to default for non-numeric value", () => {
			process.env.CLAUDEMEM_COMPLETION_POLL_MS = "bad";
			const config = loadMcpConfig();
			expect(config.completionPollMs).toBe(2000);
		});
	});

	// -------------------------------------------------------------------------
	// Comma-separated patterns
	// -------------------------------------------------------------------------

	describe("CLAUDEMEM_WATCH_PATTERNS", () => {
		test("parses a single pattern", () => {
			process.env.CLAUDEMEM_WATCH_PATTERNS = "**/*.ts";
			const config = loadMcpConfig();
			expect(config.watchPatterns).toEqual(["**/*.ts"]);
		});

		test("parses comma-separated patterns", () => {
			process.env.CLAUDEMEM_WATCH_PATTERNS = "**/*.ts,**/*.go,**/*.py";
			const config = loadMcpConfig();
			expect(config.watchPatterns).toEqual(["**/*.ts", "**/*.go", "**/*.py"]);
		});

		test("trims whitespace from each pattern", () => {
			process.env.CLAUDEMEM_WATCH_PATTERNS = " **/*.ts , **/*.go ";
			const config = loadMcpConfig();
			expect(config.watchPatterns).toEqual(["**/*.ts", "**/*.go"]);
		});

		test("falls back to default for empty string", () => {
			process.env.CLAUDEMEM_WATCH_PATTERNS = "";
			const config = loadMcpConfig();
			// Should be the default array, not empty
			expect(config.watchPatterns.length).toBeGreaterThan(0);
		});
	});

	describe("CLAUDEMEM_IGNORE_PATTERNS", () => {
		test("parses comma-separated ignore patterns", () => {
			process.env.CLAUDEMEM_IGNORE_PATTERNS = "node_modules/**,dist/**";
			const config = loadMcpConfig();
			expect(config.ignorePatterns).toEqual(["node_modules/**", "dist/**"]);
		});

		test("falls back to default for empty string", () => {
			process.env.CLAUDEMEM_IGNORE_PATTERNS = "";
			const config = loadMcpConfig();
			expect(config.ignorePatterns.length).toBeGreaterThan(0);
		});
	});

	// -------------------------------------------------------------------------
	// Log level
	// -------------------------------------------------------------------------

	describe("CLAUDEMEM_LOG_LEVEL", () => {
		test("accepts 'debug'", () => {
			process.env.CLAUDEMEM_LOG_LEVEL = "debug";
			const config = loadMcpConfig();
			expect(config.logLevel).toBe("debug");
		});

		test("accepts 'info'", () => {
			process.env.CLAUDEMEM_LOG_LEVEL = "info";
			const config = loadMcpConfig();
			expect(config.logLevel).toBe("info");
		});

		test("accepts 'warn'", () => {
			process.env.CLAUDEMEM_LOG_LEVEL = "warn";
			const config = loadMcpConfig();
			expect(config.logLevel).toBe("warn");
		});

		test("accepts 'error'", () => {
			process.env.CLAUDEMEM_LOG_LEVEL = "error";
			const config = loadMcpConfig();
			expect(config.logLevel).toBe("error");
		});

		test("falls back to 'warn' for an unrecognised value", () => {
			process.env.CLAUDEMEM_LOG_LEVEL = "verbose";
			const config = loadMcpConfig();
			expect(config.logLevel).toBe("warn");
		});
	});

	// -------------------------------------------------------------------------
	// CLAUDEMEM_INDEX_DIR
	// -------------------------------------------------------------------------

	describe("CLAUDEMEM_INDEX_DIR", () => {
		test("resolves relative path under workspaceRoot", () => {
			process.env.CLAUDEMEM_INDEX_DIR = "custom-index";
			const config = loadMcpConfig();
			expect(config.indexDir).toBe(`${config.workspaceRoot}/custom-index`);
		});
	});
});
