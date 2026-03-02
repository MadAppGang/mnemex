/**
 * Unit tests for CompletionDetector
 *
 * CompletionDetector polls for two conditions simultaneously:
 *   1. Lock file (.indexing.lock) is absent
 *   2. index.db mtime is newer than when polling started
 *
 * Both must be true before onComplete fires.
 *
 * Tests use real temp directories with actual files.
 * Short poll intervals (50 ms) and timeouts (500 ms) keep tests fast.
 *
 * Black-box: tests are written against the public API only.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	unlinkSync,
	existsSync,
	utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CompletionDetector } from "../../../src/mcp/completion-detector.js";

// ---------------------------------------------------------------------------
// Constants matching the implementation (from src/mcp/completion-detector.ts)
// ---------------------------------------------------------------------------

const LOCK_FILENAME = ".indexing.lock";
// INDEX_DB_FILE = "index.db" (from src/config.ts)
const INDEX_DB_FILE = "index.db";

const POLL_MS = 50; // Fast polling for tests

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
	return mkdtempSync(join(tmpdir(), "mcp-detector-test-"));
}

function lockPath(dir: string): string {
	return join(dir, LOCK_FILENAME);
}

function dbPath(dir: string): string {
	return join(dir, INDEX_DB_FILE);
}

/** Create the lock file */
function createLock(dir: string): void {
	writeFileSync(lockPath(dir), "locked", "utf-8");
}

/** Remove the lock file */
function removeLock(dir: string): void {
	const p = lockPath(dir);
	if (existsSync(p)) unlinkSync(p);
}

/**
 * Write/touch index.db with a mtime at least 10 ms in the future
 * relative to the provided `since` timestamp.  We use utimesSync to
 * set an explicit mtime so tests are not dependent on wall-clock speed.
 */
function touchDb(dir: string, mtimeMs: number): void {
	const p = dbPath(dir);
	writeFileSync(p, "db-content", "utf-8");
	const t = new Date(mtimeMs);
	utimesSync(p, t, t);
}

/** Create index.db with a mtime anchored in the past */
function createOldDb(dir: string): number {
	const past = Date.now() - 5000; // 5 seconds ago
	touchDb(dir, past);
	return past;
}

/** Sleep for ms milliseconds */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CompletionDetector", () => {
	let indexDir: string;

	beforeEach(() => {
		indexDir = makeTempDir();
	});

	afterEach(() => {
		try {
			require("node:fs").rmSync(indexDir, { recursive: true, force: true });
		} catch {
			// Best effort
		}
	});

	// -------------------------------------------------------------------------
	// watch() - onComplete callback
	// -------------------------------------------------------------------------

	describe("watch() - onComplete callback", () => {
		test("fires onComplete when lock is removed AND mtime is newer", async () => {
			// Create an old db and a lock
			const oldMtime = createOldDb(indexDir);
			createLock(indexDir);

			const detector = new CompletionDetector(indexDir, POLL_MS);
			let fired = false;
			detector.watch(() => {
				fired = true;
			});

			// Simulate a reindex: remove lock then update db mtime
			await sleep(POLL_MS * 2);
			removeLock(indexDir);
			touchDb(indexDir, Date.now() + 100); // definitely newer

			// Wait long enough for at least two poll cycles
			await sleep(POLL_MS * 6);
			detector.stop();

			expect(fired).toBe(true);
		});

		test("does NOT fire if lock is still present", async () => {
			createOldDb(indexDir);
			createLock(indexDir);

			const detector = new CompletionDetector(indexDir, POLL_MS);
			let fired = false;
			detector.watch(() => {
				fired = true;
			});

			// Update mtime but keep lock
			await sleep(POLL_MS * 2);
			touchDb(indexDir, Date.now() + 100);

			await sleep(POLL_MS * 6);
			detector.stop();

			expect(fired).toBe(false);
		});

		test("does NOT fire if mtime is unchanged even after lock is removed", async () => {
			// Create db with a PAST mtime
			const past = Date.now() - 10_000;
			touchDb(indexDir, past);
			createLock(indexDir);

			// Start polling - startMtime is captured now
			const detector = new CompletionDetector(indexDir, POLL_MS);
			let fired = false;
			detector.watch(() => {
				fired = true;
			});

			await sleep(POLL_MS * 2);
			// Remove lock but do NOT update mtime - db still has old mtime
			removeLock(indexDir);
			// Re-set mtime to the same old value to be explicit
			utimesSync(dbPath(indexDir), new Date(past), new Date(past));

			await sleep(POLL_MS * 6);
			detector.stop();

			expect(fired).toBe(false);
		});

		test("fires onComplete only once for a single completion event", async () => {
			createOldDb(indexDir);
			createLock(indexDir);

			const detector = new CompletionDetector(indexDir, POLL_MS);
			let callCount = 0;
			detector.watch(() => {
				callCount++;
			});

			await sleep(POLL_MS * 2);
			removeLock(indexDir);
			touchDb(indexDir, Date.now() + 100);

			// Wait several extra cycles
			await sleep(POLL_MS * 10);
			detector.stop();

			expect(callCount).toBe(1);
		});
	});

	// -------------------------------------------------------------------------
	// watch() - lock-absent from the start AND newer mtime
	// -------------------------------------------------------------------------

	describe("watch() - already completed before polling starts", () => {
		test("fires onComplete if lock never existed and mtime becomes newer after watch() starts", async () => {
			// Sequence:
			// 1. Create db with OLD mtime
			// 2. Create detector (captures OLD mtime as startMtime)
			// 3. Start watching (no lock ever existed)
			// 4. Update db to NEWER mtime -> next poll should fire onComplete
			createOldDb(indexDir);

			const detector = new CompletionDetector(indexDir, POLL_MS);
			let fired = false;
			detector.watch(() => {
				fired = true;
			});

			// Now update mtime to be newer than what startMtime captured
			await sleep(POLL_MS); // let one poll fire with old mtime
			touchDb(indexDir, Date.now() + 100);

			await sleep(POLL_MS * 6);
			detector.stop();

			expect(fired).toBe(true);
		});
	});

	// -------------------------------------------------------------------------
	// stop()
	// -------------------------------------------------------------------------

	describe("stop()", () => {
		test("calling stop() prevents further callbacks", async () => {
			createOldDb(indexDir);
			createLock(indexDir);

			const detector = new CompletionDetector(indexDir, POLL_MS);
			let fired = false;
			detector.watch(() => {
				fired = true;
			});

			// Stop before completion conditions are met
			detector.stop();

			// Now simulate completion
			removeLock(indexDir);
			touchDb(indexDir, Date.now() + 100);

			await sleep(POLL_MS * 6);

			expect(fired).toBe(false);
		});
	});

	// -------------------------------------------------------------------------
	// waitForCompletion()
	// -------------------------------------------------------------------------

	describe("waitForCompletion()", () => {
		test("returns true when completion conditions are met within timeout", async () => {
			createOldDb(indexDir);
			createLock(indexDir);

			const detector = new CompletionDetector(indexDir, POLL_MS);

			// Trigger completion after a short delay
			setTimeout(() => {
				removeLock(indexDir);
				touchDb(indexDir, Date.now() + 100);
			}, POLL_MS * 3);

			const result = await detector.waitForCompletion(500);
			expect(result).toBe(true);
		}, 2000);

		test("returns false when timeout elapses before completion", async () => {
			createOldDb(indexDir);
			createLock(indexDir); // lock is never removed

			const detector = new CompletionDetector(indexDir, POLL_MS);

			// Very short timeout - lock stays, mtime unchanged
			const result = await detector.waitForCompletion(POLL_MS * 3);
			expect(result).toBe(false);
		}, 2000);

		test("returns true quickly when completion conditions are met shortly after call", async () => {
			// Sequence:
			// 1. Create db with OLD mtime
			// 2. Create detector (startMtime = old value)
			// 3. Call waitForCompletion
			// 4. Shortly after, remove lock and update mtime
			createOldDb(indexDir);
			createLock(indexDir);

			const detector = new CompletionDetector(indexDir, POLL_MS);

			// Trigger completion after 2 poll cycles
			setTimeout(() => {
				removeLock(indexDir);
				touchDb(indexDir, Date.now() + 100);
			}, POLL_MS * 2);

			const result = await detector.waitForCompletion(500);
			expect(result).toBe(true);
		}, 2000);
	});
});
