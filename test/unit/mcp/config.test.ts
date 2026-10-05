/**
 * Unit tests for loadMcpConfig()
 *
 * Tests that environment variables are correctly parsed, that default values
 * are returned when env vars are absent, and that invalid values fall back
 * gracefully to defaults.
 *
 * Black-box: tests operate through the public loadMcpConfig() API only.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __resetStoreLocationCacheForTests } from "../../../src/core/store-location.js";
import { loadMcpConfig } from "../../../src/mcp/config.js";

// ---------------------------------------------------------------------------
// Helpers: save/restore env vars around each test
// ---------------------------------------------------------------------------

const ENV_KEYS = [
	"MNEMEX_INDEX_DIR",
	"MNEMEX_DEBOUNCE_MS",
	"MNEMEX_WATCH_PATTERNS",
	"MNEMEX_IGNORE_PATTERNS",
	"MNEMEX_MAX_MEMORY_MB",
	"MNEMEX_COMPLETION_POLL_MS",
	"MNEMEX_LOG_LEVEL",
] as const;

type EnvSnapshot = Partial<
	Record<(typeof ENV_KEYS)[number], string | undefined>
>;

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
		// The seam memoizes on (realpath, MNEMEX_INDEX_DIR). These tests change
		// the variable, and two of them reuse a fresh temp directory, so a stale
		// entry would answer for a previous test's environment.
		__resetStoreLocationCacheForTests();
	});

	afterEach(() => {
		restoreEnv(envSnapshot);
		__resetStoreLocationCacheForTests();
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

		test("indexDir is the STORE for a plain directory: <dir>/.mnemex", () => {
			// REWRITTEN IN 3c, and the old form is worth recording because it was
			// already fragile. It called `loadMcpConfig()` with no argument, so
			// `workspaceRoot` was `process.cwd()` — the DEVELOPER'S OWN CHECKOUT —
			// and asserted `indexDir` contained ".mnemex" and started with the
			// workspace root. From 3c both are false when the suite runs from
			// inside a git repository (the store is `<gitCommonDir>/mnemex`), and
			// they were false BEFORE 3c for anyone with `MNEMEX_INDEX_DIR` set,
			// because a store is not obliged to live under the workspace at all.
			//
			// A temp directory with no `.git` pins row 4 (FR-7), which the flip
			// does not touch: no non-git user's store moves.
			const dir = mkdtempSync(join(tmpdir(), "mnemex-mcp-config-"));
			try {
				const config = loadMcpConfig(dir);
				expect(config.indexDir).toBe(join(realpathSync(dir), ".mnemex"));
				// Outside a repository the store and the per-worktree directory
				// ARE the same path. Inside one they are not — the row below.
				expect(config.worktreeDir).toBe(config.indexDir);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		test("worktreeDir is per-worktree even when the store is elsewhere", () => {
			// The property §2.4 rests on, asserted without needing a git fixture:
			// an override moves the STORE and never the path convention, so the
			// two directories separate. This is the same separation the flip
			// creates for every repository user, reached through row 1.
			const dir = mkdtempSync(join(tmpdir(), "mnemex-mcp-config-"));
			const store = mkdtempSync(join(tmpdir(), "mnemex-mcp-store-"));
			try {
				process.env.MNEMEX_INDEX_DIR = store;
				const config = loadMcpConfig(dir);
				expect(config.indexDir).toBe(store);
				expect(config.worktreeDir).toBe(join(realpathSync(dir), ".mnemex"));
				expect(config.worktreeDir).not.toBe(config.indexDir);
			} finally {
				rmSync(dir, { recursive: true, force: true });
				rmSync(store, { recursive: true, force: true });
			}
		});

		test("workspaceRoot equals process.cwd()", () => {
			const config = loadMcpConfig();
			expect(config.workspaceRoot).toBe(process.cwd());
		});
	});

	// -------------------------------------------------------------------------
	// Numeric parsing
	// -------------------------------------------------------------------------

	describe("MNEMEX_DEBOUNCE_MS", () => {
		test("parses a valid integer", () => {
			process.env.MNEMEX_DEBOUNCE_MS = "5000";
			const config = loadMcpConfig();
			expect(config.debounceMs).toBe(5000);
		});

		test("falls back to default for non-numeric value 'abc'", () => {
			process.env.MNEMEX_DEBOUNCE_MS = "abc";
			const config = loadMcpConfig();
			expect(config.debounceMs).toBe(120_000);
		});

		test("falls back to default for empty string", () => {
			process.env.MNEMEX_DEBOUNCE_MS = "";
			const config = loadMcpConfig();
			expect(config.debounceMs).toBe(120_000);
		});
	});

	describe("MNEMEX_MAX_MEMORY_MB", () => {
		test("parses a valid integer", () => {
			process.env.MNEMEX_MAX_MEMORY_MB = "1024";
			const config = loadMcpConfig();
			expect(config.maxMemoryMB).toBe(1024);
		});

		test("falls back to default for non-numeric value", () => {
			process.env.MNEMEX_MAX_MEMORY_MB = "not-a-number";
			const config = loadMcpConfig();
			expect(config.maxMemoryMB).toBe(500);
		});
	});

	describe("MNEMEX_COMPLETION_POLL_MS", () => {
		test("parses a valid integer", () => {
			process.env.MNEMEX_COMPLETION_POLL_MS = "500";
			const config = loadMcpConfig();
			expect(config.completionPollMs).toBe(500);
		});

		test("falls back to default for non-numeric value", () => {
			process.env.MNEMEX_COMPLETION_POLL_MS = "bad";
			const config = loadMcpConfig();
			expect(config.completionPollMs).toBe(2000);
		});
	});

	// -------------------------------------------------------------------------
	// Comma-separated patterns
	// -------------------------------------------------------------------------

	describe("MNEMEX_WATCH_PATTERNS", () => {
		test("parses a single pattern", () => {
			process.env.MNEMEX_WATCH_PATTERNS = "**/*.ts";
			const config = loadMcpConfig();
			expect(config.watchPatterns).toEqual(["**/*.ts"]);
		});

		test("parses comma-separated patterns", () => {
			process.env.MNEMEX_WATCH_PATTERNS = "**/*.ts,**/*.go,**/*.py";
			const config = loadMcpConfig();
			expect(config.watchPatterns).toEqual(["**/*.ts", "**/*.go", "**/*.py"]);
		});

		test("trims whitespace from each pattern", () => {
			process.env.MNEMEX_WATCH_PATTERNS = " **/*.ts , **/*.go ";
			const config = loadMcpConfig();
			expect(config.watchPatterns).toEqual(["**/*.ts", "**/*.go"]);
		});

		test("falls back to default for empty string", () => {
			process.env.MNEMEX_WATCH_PATTERNS = "";
			const config = loadMcpConfig();
			// Should be the default array, not empty
			expect(config.watchPatterns.length).toBeGreaterThan(0);
		});
	});

	describe("MNEMEX_IGNORE_PATTERNS", () => {
		test("parses comma-separated ignore patterns", () => {
			process.env.MNEMEX_IGNORE_PATTERNS = "node_modules/**,dist/**";
			const config = loadMcpConfig();
			expect(config.ignorePatterns).toEqual(["node_modules/**", "dist/**"]);
		});

		test("falls back to default for empty string", () => {
			process.env.MNEMEX_IGNORE_PATTERNS = "";
			const config = loadMcpConfig();
			expect(config.ignorePatterns.length).toBeGreaterThan(0);
		});
	});

	// -------------------------------------------------------------------------
	// Log level
	// -------------------------------------------------------------------------

	describe("MNEMEX_LOG_LEVEL", () => {
		test("accepts 'debug'", () => {
			process.env.MNEMEX_LOG_LEVEL = "debug";
			const config = loadMcpConfig();
			expect(config.logLevel).toBe("debug");
		});

		test("accepts 'info'", () => {
			process.env.MNEMEX_LOG_LEVEL = "info";
			const config = loadMcpConfig();
			expect(config.logLevel).toBe("info");
		});

		test("accepts 'warn'", () => {
			process.env.MNEMEX_LOG_LEVEL = "warn";
			const config = loadMcpConfig();
			expect(config.logLevel).toBe("warn");
		});

		test("accepts 'error'", () => {
			process.env.MNEMEX_LOG_LEVEL = "error";
			const config = loadMcpConfig();
			expect(config.logLevel).toBe("error");
		});

		test("falls back to 'warn' for an unrecognised value", () => {
			process.env.MNEMEX_LOG_LEVEL = "verbose";
			const config = loadMcpConfig();
			expect(config.logLevel).toBe("warn");
		});
	});

	// -------------------------------------------------------------------------
	// MNEMEX_INDEX_DIR
	// -------------------------------------------------------------------------

	describe("MNEMEX_INDEX_DIR", () => {
		test("resolves relative path under workspaceRoot", () => {
			process.env.MNEMEX_INDEX_DIR = "custom-index";
			const config = loadMcpConfig();
			expect(config.indexDir).toBe(`${config.workspaceRoot}/custom-index`);
		});
	});
});
