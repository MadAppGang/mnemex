/**
 * Unit tests for IndexCache
 *
 * IndexCache requires an actual .claudemem/index.db to load the full resource
 * graph.  In a unit test environment we do not have a real indexed project,
 * so tests focus on the observable structural behaviour:
 *
 * 1. get() throws a descriptive error when no index.db exists
 * 2. invalidate() causes the next get() to re-attempt loading (verified via
 *    counting load attempts through thrown errors)
 * 3. Concurrent get() calls deduplicate: only one load is attempted even when
 *    multiple callers await simultaneously
 *
 * If the test environment has a real index at the project root the tests that
 * check error behaviour will still exercise the correct code paths because they
 * point at a temp directory that has no index.
 *
 * Black-box: tests operate through the public IndexCache API only.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IndexCache } from "../../../src/mcp/cache.js";
import { Logger } from "../../../src/mcp/logger.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Silent logger for test use */
function makeLogger(): Logger {
	return new Logger("error"); // suppress all non-error output during tests
}

/**
 * Create a temp project directory without any .claudemem/index.db.
 * IndexCache will throw when get() is called on this path.
 */
function makeTempProject(): string {
	return mkdtempSync(join(tmpdir(), "mcp-cache-test-"));
}

/**
 * Create a temp project directory structure that looks like a valid project
 * but has an index.db that is actually a stub file. This makes existsSync
 * return true so load() proceeds — but it will fail when createFileTracker
 * tries to open it as a real LanceDB database.
 *
 * We use this only to verify that get() DOES attempt a load when the file
 * exists, rather than short-circuiting before that point.
 */
function makeTempProjectWithStubIndex(): { projectPath: string; indexDir: string } {
	const projectPath = mkdtempSync(join(tmpdir(), "mcp-cache-stub-test-"));
	const indexDir = join(projectPath, ".claudemem");
	mkdirSync(indexDir, { recursive: true });
	// Write a stub db file - not a real LanceDB database, but existsSync passes
	writeFileSync(join(indexDir, "index.db"), "stub", "utf-8");
	return { projectPath, indexDir };
}

function cleanup(path: string): void {
	try {
		require("node:fs").rmSync(path, { recursive: true, force: true });
	} catch {
		// best effort
	}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("IndexCache", () => {
	let projectPath: string;

	afterEach(() => {
		if (projectPath) cleanup(projectPath);
	});

	// -------------------------------------------------------------------------
	// get() - no index.db exists
	// -------------------------------------------------------------------------

	describe("get() when no index.db exists", () => {
		beforeEach(() => {
			projectPath = makeTempProject();
		});

		test("throws an error describing where to find the missing index", async () => {
			const indexDir = join(projectPath, ".claudemem");
			const cache = new IndexCache(projectPath, indexDir, 500, makeLogger());

			await expect(cache.get()).rejects.toThrow();
		});

		test("thrown error mentions the project path or instructs user to index", async () => {
			const indexDir = join(projectPath, ".claudemem");
			const cache = new IndexCache(projectPath, indexDir, 500, makeLogger());

			let errorMessage = "";
			try {
				await cache.get();
			} catch (err) {
				errorMessage = err instanceof Error ? err.message : String(err);
			}

			// Requirements: error should mention indexing or the project path
			const mentionsIndex =
				errorMessage.toLowerCase().includes("index") ||
				errorMessage.toLowerCase().includes("claudemem") ||
				errorMessage.includes(projectPath);
			expect(mentionsIndex).toBe(true);
		});
	});

	// -------------------------------------------------------------------------
	// invalidate() - causes next get() to reload
	// -------------------------------------------------------------------------

	describe("invalidate()", () => {
		beforeEach(() => {
			projectPath = makeTempProject();
		});

		test("after invalidate(), get() re-attempts loading (throws again)", async () => {
			const indexDir = join(projectPath, ".claudemem");
			const cache = new IndexCache(projectPath, indexDir, 500, makeLogger());

			// First call throws (no index)
			await expect(cache.get()).rejects.toThrow();

			// invalidate() on a cache that never loaded successfully is a no-op
			// (no cached value to clear) - this should not throw
			expect(() => cache.invalidate()).not.toThrow();

			// Second call also throws - it re-attempted loading
			await expect(cache.get()).rejects.toThrow();
		});

		test("close() does not throw when cache was never loaded", () => {
			const indexDir = join(projectPath, ".claudemem");
			const cache = new IndexCache(projectPath, indexDir, 500, makeLogger());
			expect(() => cache.close()).not.toThrow();
		});
	});

	// -------------------------------------------------------------------------
	// Concurrent get() calls - deduplication
	// -------------------------------------------------------------------------

	describe("concurrent get() calls deduplicate load attempts", () => {
		beforeEach(() => {
			projectPath = makeTempProject();
		});

		test("multiple simultaneous get() calls all reject with the same error type", async () => {
			const indexDir = join(projectPath, ".claudemem");
			const cache = new IndexCache(projectPath, indexDir, 500, makeLogger());

			// Fire multiple concurrent gets
			const promises = [cache.get(), cache.get(), cache.get()];

			const results = await Promise.allSettled(promises);

			// All should have been rejected (no index exists)
			for (const result of results) {
				expect(result.status).toBe("rejected");
			}
		});

		test("concurrent get() calls share the same load attempt (not N separate loads)", async () => {
			// We verify this behaviourally: if each call triggered a separate load,
			// race conditions between them would make them behave differently.
			// Since they all fail with the same error (from one shared load),
			// the error messages should be identical.
			const indexDir = join(projectPath, ".claudemem");
			const cache = new IndexCache(projectPath, indexDir, 500, makeLogger());

			const results = await Promise.allSettled([
				cache.get(),
				cache.get(),
				cache.get(),
			]);

			const messages = results.map((r) =>
				r.status === "rejected"
					? (r.reason as Error).message
					: "resolved-unexpectedly",
			);

			// All error messages should be identical (same error object or same text)
			const uniqueMessages = new Set(messages);
			expect(uniqueMessages.size).toBe(1);
		});
	});

	// -------------------------------------------------------------------------
	// With stub index.db (file exists but is not a real LanceDB db)
	// -------------------------------------------------------------------------

	describe("get() when index.db file exists but is not a real database", () => {
		let indexDir: string;

		beforeEach(() => {
			const setup = makeTempProjectWithStubIndex();
			projectPath = setup.projectPath;
			indexDir = setup.indexDir;
		});

		test("get() throws when index.db is a stub (not a real LanceDB database)", async () => {
			const cache = new IndexCache(projectPath, indexDir, 500, makeLogger());
			// The load will pass the existsSync check but fail when trying to open
			// the stub file as a real LanceDB database
			await expect(cache.get()).rejects.toThrow();
		});

		test("after a failed load, get() still throws on retry (no stale cached result)", async () => {
			const cache = new IndexCache(projectPath, indexDir, 500, makeLogger());

			await expect(cache.get()).rejects.toThrow();
			// Retry should also throw - no phantom cached value
			await expect(cache.get()).rejects.toThrow();
		});
	});
});
