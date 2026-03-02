/**
 * Unit tests for IndexStateManager
 *
 * Tests freshness tracking, stale transition on file changes,
 * and state reset on reindex completion.
 *
 * Black-box: tests are written against the public API and
 * requirements only, not implementation internals.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IndexStateManager } from "../../../src/mcp/state-manager.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempIndexDir(): string {
	// IndexStateManager expects an indexDir, and its initialize() looks for
	// .reindex-timestamp inside that dir and an IndexLock at parent level.
	// We create a nested temp structure: <tmpRoot>/<indexDir> so that the
	// parent is the temp root (a valid directory for the lock).
	const root = mkdtempSync(join(tmpdir(), "mcp-state-test-"));
	const indexDir = join(root, ".claudemem");
	// mkdirSync not needed - IndexStateManager creates it on writeTimestamp
	return indexDir;
}

function rootOf(indexDir: string): string {
	return join(indexDir, "..");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("IndexStateManager", () => {
	let indexDir: string;
	let manager: IndexStateManager;

	beforeEach(async () => {
		indexDir = makeTempIndexDir();
		manager = new IndexStateManager(indexDir);
		// initialize() reads .reindex-timestamp and checks lock status.
		// On a fresh temp dir there is no timestamp or lock.
		await manager.initialize();
	});

	afterEach(() => {
		// Clean up the parent temp directory tree
		const root = rootOf(indexDir);
		try {
			// Remove recursively using bun's shell or rm -rf
			require("node:fs").rmSync(root, { recursive: true, force: true });
		} catch {
			// Best effort cleanup
		}
	});

	// -------------------------------------------------------------------------
	// getFreshness() - never indexed
	// -------------------------------------------------------------------------

	describe("getFreshness() when never indexed", () => {
		test("returns 'stale' when lastIndexed is null (never indexed)", () => {
			const result = manager.getFreshness();
			expect(result.freshness).toBe("stale");
		});

		test("lastIndexed is null when never indexed", () => {
			const result = manager.getFreshness();
			expect(result.lastIndexed).toBeNull();
		});

		test("staleSince is null when never indexed and no files changed", () => {
			const result = manager.getFreshness();
			// staleSince only records when a file change occurs after a fresh state;
			// it is not set just because we have never indexed.
			expect(result.staleSince).toBeNull();
		});

		test("filesChanged is empty when no changes recorded", () => {
			const result = manager.getFreshness();
			expect(result.filesChanged).toEqual([]);
		});

		test("reindexingInProgress is false initially", () => {
			const result = manager.getFreshness();
			expect(result.reindexingInProgress).toBe(false);
		});
	});

	// -------------------------------------------------------------------------
	// recordChange()
	// -------------------------------------------------------------------------

	describe("recordChange()", () => {
		test("adds file to filesChanged", () => {
			manager.recordChange("src/foo.ts");
			const result = manager.getFreshness();
			expect(result.filesChanged).toContain("src/foo.ts");
		});

		test("sets staleSince on FIRST call after fresh state", () => {
			const before = Date.now();
			manager.recordChange("src/foo.ts");
			const after = Date.now();

			const result = manager.getFreshness();
			expect(result.staleSince).not.toBeNull();

			const staleSinceMs = new Date(result.staleSince!).getTime();
			expect(staleSinceMs).toBeGreaterThanOrEqual(before);
			expect(staleSinceMs).toBeLessThanOrEqual(after);
		});

		test("does NOT reset staleSince on subsequent calls", () => {
			manager.recordChange("src/foo.ts");
			const firstResult = manager.getFreshness();
			const firstStaleSince = firstResult.staleSince;

			// Wait a moment to ensure any new Date() would differ
			// (at 1ms precision this may be tight, so record a second change
			// and confirm staleSince is the same object value)
			manager.recordChange("src/bar.ts");
			const secondResult = manager.getFreshness();

			expect(secondResult.staleSince).toBe(firstStaleSince);
		});

		test("accumulates multiple files", () => {
			manager.recordChange("src/a.ts");
			manager.recordChange("src/b.ts");
			manager.recordChange("src/c.ts");
			const result = manager.getFreshness();
			expect(result.filesChanged).toContain("src/a.ts");
			expect(result.filesChanged).toContain("src/b.ts");
			expect(result.filesChanged).toContain("src/c.ts");
		});

		test("de-duplicates the same file path", () => {
			manager.recordChange("src/a.ts");
			manager.recordChange("src/a.ts");
			const result = manager.getFreshness();
			const count = result.filesChanged.filter((f) => f === "src/a.ts").length;
			expect(count).toBe(1);
		});

		test("returns 'stale' after at least one change", () => {
			manager.recordChange("src/foo.ts");
			const result = manager.getFreshness();
			expect(result.freshness).toBe("stale");
		});
	});

	// -------------------------------------------------------------------------
	// onReindexComplete()
	// -------------------------------------------------------------------------

	describe("onReindexComplete()", () => {
		test("clears filesChangedSince so filesChanged is empty", () => {
			manager.recordChange("src/foo.ts");
			manager.recordChange("src/bar.ts");

			manager.onReindexComplete();

			const result = manager.getFreshness();
			expect(result.filesChanged).toEqual([]);
		});

		test("clears staleSince so it is null", () => {
			manager.recordChange("src/foo.ts");
			manager.onReindexComplete();

			const result = manager.getFreshness();
			expect(result.staleSince).toBeNull();
		});

		test("sets lastIndexed to a recent timestamp", () => {
			const before = Date.now();
			manager.onReindexComplete();
			const after = Date.now();

			const result = manager.getFreshness();
			expect(result.lastIndexed).not.toBeNull();

			const lastIndexedMs = new Date(result.lastIndexed!).getTime();
			expect(lastIndexedMs).toBeGreaterThanOrEqual(before);
			expect(lastIndexedMs).toBeLessThanOrEqual(after);
		});

		test("returns 'fresh' after onReindexComplete() with no subsequent changes", () => {
			// Simulate a full cycle: change -> reindex -> complete
			manager.recordChange("src/foo.ts");
			manager.onReindexComplete();

			const result = manager.getFreshness();
			expect(result.freshness).toBe("fresh");
		});

		test("reindexingInProgress becomes false after complete", () => {
			manager.onReindexStart();
			manager.onReindexComplete();

			const result = manager.getFreshness();
			expect(result.reindexingInProgress).toBe(false);
		});
	});

	// -------------------------------------------------------------------------
	// getFreshness() - fresh state
	// -------------------------------------------------------------------------

	describe("getFreshness() after indexing completes with no new changes", () => {
		beforeEach(() => {
			manager.onReindexComplete();
		});

		test("returns 'fresh'", () => {
			expect(manager.getFreshness().freshness).toBe("fresh");
		});

		test("filesChanged is empty", () => {
			expect(manager.getFreshness().filesChanged).toEqual([]);
		});

		test("lastIndexed is not null", () => {
			expect(manager.getFreshness().lastIndexed).not.toBeNull();
		});

		test("staleSince is null", () => {
			expect(manager.getFreshness().staleSince).toBeNull();
		});

		test("reindexingInProgress is false", () => {
			expect(manager.getFreshness().reindexingInProgress).toBe(false);
		});
	});

	// -------------------------------------------------------------------------
	// getFreshness() - reindex in progress
	// -------------------------------------------------------------------------

	describe("getFreshness() when reindexInProgress is true", () => {
		test("returns 'stale' when reindex is running", () => {
			// Complete one cycle first so lastIndexed is set, then start another
			manager.onReindexComplete();
			manager.onReindexStart();

			const result = manager.getFreshness();
			expect(result.freshness).toBe("stale");
		});

		test("reindexingInProgress is true during reindex", () => {
			manager.onReindexStart();
			expect(manager.getFreshness().reindexingInProgress).toBe(true);
		});
	});

	// -------------------------------------------------------------------------
	// Derived getters
	// -------------------------------------------------------------------------

	describe("changedFileCount getter", () => {
		test("returns 0 when no changes recorded", () => {
			expect(manager.changedFileCount).toBe(0);
		});

		test("returns correct count after changes", () => {
			manager.recordChange("a.ts");
			manager.recordChange("b.ts");
			expect(manager.changedFileCount).toBe(2);
		});

		test("returns 0 after onReindexComplete()", () => {
			manager.recordChange("a.ts");
			manager.onReindexComplete();
			expect(manager.changedFileCount).toBe(0);
		});
	});

	describe("isReindexing getter", () => {
		test("returns false initially", () => {
			expect(manager.isReindexing).toBe(false);
		});

		test("returns true after onReindexStart()", () => {
			manager.onReindexStart();
			expect(manager.isReindexing).toBe(true);
		});

		test("returns false after onReindexComplete()", () => {
			manager.onReindexStart();
			manager.onReindexComplete();
			expect(manager.isReindexing).toBe(false);
		});
	});
});
