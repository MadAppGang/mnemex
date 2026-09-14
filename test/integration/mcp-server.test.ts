/**
 * Integration tests for MCP server stale/unindexed behavior
 *
 * Validates freshness tracking, file change detection, reindex scheduling,
 * file watching integration, and the buildFreshness helper.
 *
 * These tests exercise real component wiring rather than mocking internals.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveStoreLocation } from "../../src/core/store-location.js";
import type { IndexCache } from "../../src/mcp/cache.js";
import { CompletionDetector } from "../../src/mcp/completion-detector.js";
import type { Logger } from "../../src/mcp/logger.js";
import {
	DebounceReindexer,
	REINDEX_ARGS,
	type ReindexLauncher,
} from "../../src/mcp/reindexer.js";
import { IndexStateManager } from "../../src/mcp/state-manager.js";
import { buildFreshness } from "../../src/mcp/tools/deps.js";
import { FileWatcher } from "../../src/mcp/watcher.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a temp workspace with a nested indexDir:
 *   <tmpRoot>/   ← project root (for IndexLock)
 *   <tmpRoot>/.mnemex/  ← indexDir
 */
function makeTempWorkspace(): { root: string; indexDir: string } {
	const root = mkdtempSync(join(tmpdir(), "mcp-integ-"));
	const indexDir = join(root, ".mnemex");
	mkdirSync(indexDir, { recursive: true });
	return { root, indexDir };
}

function cleanup(root: string): void {
	try {
		rmSync(root, { recursive: true, force: true });
	} catch {
		// Best-effort cleanup
	}
}

/** Write a .reindex-timestamp with the given date (or now) */
function writeTimestamp(indexDir: string, date: Date = new Date()): void {
	writeFileSync(
		join(indexDir, ".reindex-timestamp"),
		date.toISOString(),
		"utf-8",
	);
}

interface PollOptions {
	/** Upper bound for failure — NOT an expected wait. */
	timeoutMs?: number;
	/** How often to re-check the predicate. */
	intervalMs?: number;
}

const DEFAULT_POLL_TIMEOUT_MS = 2000;
const DEFAULT_POLL_INTERVAL_MS = 5;

/**
 * Poll `predicate` until it is true, or the timeout elapses. Returns whether
 * the condition was ever observed.
 *
 * Use this when the condition is genuinely optional (e.g. platform-dependent
 * fs.watch delivery). When the condition is required, use `waitFor` so a
 * timeout produces a diagnosable failure instead of a silent skip.
 */
async function pollUntil(
	predicate: () => boolean,
	{
		timeoutMs = DEFAULT_POLL_TIMEOUT_MS,
		intervalMs = DEFAULT_POLL_INTERVAL_MS,
	}: PollOptions = {},
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (predicate()) return true;
		if (Date.now() >= deadline) return false;
		await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
	}
}

/**
 * Wait for an asynchronous side effect to become observable.
 *
 * A fixed `setTimeout` followed by `expect(...)` is a race: under load the
 * event loop slips past the deadline and the assertion runs before the
 * callback has fired. Polling removes the race — the timeout below is an upper
 * bound for FAILURE, not an expected wait, so it can be generous without
 * slowing the happy path (a passing run resolves within one interval).
 *
 * `describeActual` is evaluated only on timeout and must report the observed
 * value, so failures read "startCount was 0 after 2000ms, expected 1" rather
 * than an undiagnosable "expected 1, received 0".
 */
async function waitFor(
	predicate: () => boolean,
	describeActual: () => string,
	options: PollOptions = {},
): Promise<void> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
	const observed = await pollUntil(predicate, { ...options, timeoutMs });
	if (!observed) {
		throw new Error(
			`waitFor timed out after ${timeoutMs}ms: ${describeActual()}`,
		);
	}
}

/**
 * Hide any installed `mnemex` binary from the child processes these tests
 * spawn, by pointing PATH at an empty directory. Returns the previous PATH so
 * the caller can restore it.
 *
 * DebounceReindexer spawns a real `mnemex index` child. On a developer machine
 * mnemex IS on PATH, so that child indexes the throwaway workspace for real and
 * takes `.mnemex/.indexing.lock` ~160-500ms after spawn (measured). That lock
 * lands inside these tests' timing windows and makes a later, unrelated trigger
 * skip with "index lock held by another process" — startCount stays 0 through
 * any amount of waiting. No amount of polling can fix that; the environment has
 * to be made hermetic.
 *
 * With PATH emptied, spawn fails with an async ENOENT that DebounceReindexer
 * already handles, restoring the condition these tests were written for and
 * document inline ("no real binary in test"). The parent-side state machine
 * under test — debounce, running flag, lock check — is unaffected.
 */
function hideMnemexFromPath(emptyDir: string): string {
	const previousPath = process.env.PATH ?? "";
	mkdirSync(emptyDir, { recursive: true });
	process.env.PATH = emptyDir;
	return previousPath;
}

/**
 * Bounded wait for NEGATIVE assertions only ("nothing happened within N ms").
 *
 * A negative cannot be polled for — there is no condition that becomes true —
 * so real time must pass before the absence means anything. Every positive
 * assertion in this file uses `waitFor` instead.
 */
function settle(ms: number): Promise<void> {
	return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** Minimal no-op logger for test use */
const noopLogger: Logger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
};

/** Minimal stub for IndexCache — only invalidate() is called by DebounceReindexer */
function makeStubCache(): IndexCache {
	return {
		get: async () => {
			throw new Error("stub: not implemented");
		},
		invalidate: () => {},
		close: () => {},
	} as unknown as IndexCache;
}

/**
 * THE LAUNCHER, RECORDED INSTEAD OF RUN.
 *
 * Every `DebounceReindexer` below used to launch the INSTALLED `mnemex` binary
 * for real: `spawn("mnemex", ["index", …])` with no `env`, so the child inherited
 * whatever this process had. `mnemex` is on PATH on a developer machine, and the
 * installed entry point calls `enableRealKeychainAccess()` in itself, so a run of
 * this file from a directory where `bunfig.toml`'s preload does not apply reached
 * the real login keychain — the round-3 CRITICAL, arrived at transitively, which
 * is why no sweep over spawn sites in test files could see it.
 *
 * Those same real children were also the "pre-existing flake": each one raced to
 * write `.mnemex/.indexing.lock` into the temp workspace, and the next
 * `isLocked()` check in this file then skipped its reindex. Measured before this
 * change: 1 failure in 8 runs of this file, always
 * "after reindex completes, a new reindex can be triggered".
 *
 * The recorder captures the exact argv that WOULD have run, so the tests assert
 * on the launch rather than on a side effect of one.
 */
/**
 * What a launch request carries. There is no `command` field: since round 6
 * the reindexer cannot choose what is launched, only the argv and the cwd
 * (`ReindexLauncher` is `(args, cwd)`), so there is nothing to record.
 */
interface LaunchRecord {
	args: string[];
	cwd: string;
}

function makeRecordingLauncher(): {
	launch: ReindexLauncher;
	launches: LaunchRecord[];
} {
	const launches: LaunchRecord[] = [];
	const launch: ReindexLauncher = (args, cwd) => {
		launches.push({ args, cwd });
		return {
			pid: 424242,
			on: () => {},
			unref: () => {},
		};
	};
	return { launch, launches };
}

// ---------------------------------------------------------------------------
// Scenario 1: IndexStateManager tracks freshness across file changes
// ---------------------------------------------------------------------------

describe("IndexStateManager tracks freshness across file changes", () => {
	let root: string;
	let indexDir: string;
	let manager: IndexStateManager;

	beforeEach(async () => {
		({ root, indexDir } = makeTempWorkspace());
		manager = new IndexStateManager(
			indexDir,
			resolveStoreLocation(dirname(indexDir)),
		);
		// No .reindex-timestamp exists → lastIndexed = null
		await manager.initialize();
	});

	afterEach(() => cleanup(root));

	test("getFreshness() is stale when lastIndexed is null (never indexed)", () => {
		const freshness = manager.getFreshness();
		expect(freshness.freshness).toBe("stale");
		expect(freshness.lastIndexed).toBeNull();
	});

	test("getFreshness() shows changed files after recordChange()", () => {
		manager.recordChange("src/foo.ts");
		manager.recordChange("src/bar.ts");

		const freshness = manager.getFreshness();
		expect(freshness.freshness).toBe("stale");
		expect(freshness.filesChanged).toContain("src/foo.ts");
		expect(freshness.filesChanged).toContain("src/bar.ts");
		expect(freshness.staleSince).not.toBeNull();
	});

	test("onReindexStart() sets reindexingInProgress to true", () => {
		manager.onReindexStart();
		expect(manager.isReindexing).toBe(true);
		expect(manager.getFreshness().reindexingInProgress).toBe(true);
	});

	test("onReindexComplete() transitions to fresh state and writes timestamp", () => {
		manager.recordChange("src/foo.ts");
		manager.recordChange("src/bar.ts");
		manager.onReindexStart();
		manager.onReindexComplete();

		const freshness = manager.getFreshness();
		expect(freshness.freshness).toBe("fresh");
		expect(freshness.filesChanged).toEqual([]);
		expect(freshness.staleSince).toBeNull();
		expect(freshness.lastIndexed).not.toBeNull();
		expect(freshness.reindexingInProgress).toBe(false);

		// Verify .reindex-timestamp was written to disk
		const tsPath = join(indexDir, ".reindex-timestamp");
		expect(existsSync(tsPath)).toBe(true);
	});

	test("lastIndexed after onReindexComplete() is a valid recent timestamp", () => {
		const before = Date.now();
		manager.onReindexComplete();
		const after = Date.now();

		const { lastIndexed } = manager.getFreshness();
		expect(lastIndexed).not.toBeNull();
		const ms = new Date(lastIndexed!).getTime();
		expect(ms).toBeGreaterThanOrEqual(before);
		expect(ms).toBeLessThanOrEqual(after);
	});
});

// ---------------------------------------------------------------------------
// Scenario 2: Fresh index becomes stale when files change
// ---------------------------------------------------------------------------

describe("Fresh index becomes stale when files change", () => {
	let root: string;
	let indexDir: string;
	let manager: IndexStateManager;
	let knownDate: Date;

	beforeEach(async () => {
		({ root, indexDir } = makeTempWorkspace());
		// Write a known .reindex-timestamp before initializing
		knownDate = new Date("2026-01-15T10:00:00.000Z");
		writeTimestamp(indexDir, knownDate);

		manager = new IndexStateManager(
			indexDir,
			resolveStoreLocation(dirname(indexDir)),
		);
		await manager.initialize();
	});

	afterEach(() => cleanup(root));

	test("lastIndexed matches the pre-written timestamp after initialize()", () => {
		const { lastIndexed } = manager.getFreshness();
		expect(lastIndexed).not.toBeNull();
		expect(new Date(lastIndexed!).getTime()).toBe(knownDate.getTime());
	});

	test("getFreshness() is fresh before any file changes", () => {
		const freshness = manager.getFreshness();
		expect(freshness.freshness).toBe("fresh");
		expect(freshness.filesChanged).toEqual([]);
		expect(freshness.staleSince).toBeNull();
	});

	test("getFreshness() becomes stale after first recordChange()", () => {
		manager.recordChange("src/modified.ts");

		const freshness = manager.getFreshness();
		expect(freshness.freshness).toBe("stale");
		expect(freshness.filesChanged).toContain("src/modified.ts");
		expect(freshness.staleSince).not.toBeNull();
	});

	test("staleSince is set to a time at or after change was recorded", () => {
		const before = Date.now();
		manager.recordChange("src/modified.ts");
		const after = Date.now();

		const { staleSince } = manager.getFreshness();
		expect(staleSince).not.toBeNull();
		const ms = new Date(staleSince!).getTime();
		expect(ms).toBeGreaterThanOrEqual(before);
		expect(ms).toBeLessThanOrEqual(after);
	});

	test("lastIndexed is still set (not cleared) after file change", () => {
		manager.recordChange("src/modified.ts");
		const { lastIndexed } = manager.getFreshness();
		expect(lastIndexed).not.toBeNull();
		expect(new Date(lastIndexed!).getTime()).toBe(knownDate.getTime());
	});
});

// ---------------------------------------------------------------------------
// Scenario 3: DebounceReindexer schedules reindex after file changes
// ---------------------------------------------------------------------------

describe("DebounceReindexer schedules reindex after file changes", () => {
	let root: string;
	let indexDir: string;
	let manager: IndexStateManager;
	let cache: IndexCache;
	let completionDetector: CompletionDetector;
	let reindexer: DebounceReindexer;
	let recorder: ReturnType<typeof makeRecordingLauncher>;
	let previousPath: string;

	beforeEach(async () => {
		({ root, indexDir } = makeTempWorkspace());
		previousPath = hideMnemexFromPath(join(root, "empty-bin"));
		manager = new IndexStateManager(
			indexDir,
			resolveStoreLocation(dirname(indexDir)),
		);
		await manager.initialize();
		cache = makeStubCache();
		// Short poll interval for tests (not actually used in these tests)
		completionDetector = new CompletionDetector(
			indexDir,
			50,
			join(indexDir, ".indexing.lock"),
		);
		recorder = makeRecordingLauncher();
	});

	afterEach(() => {
		reindexer?.cancelPending();
		completionDetector.stop();
		process.env.PATH = previousPath;
		cleanup(root);
	});

	test("scheduleReindex() triggers onReindexStart within debounce window", async () => {
		let startCount = 0;
		const originalStart = manager.onReindexStart.bind(manager);
		manager.onReindexStart = () => {
			startCount++;
			originalStart();
		};

		// Use a very short debounce to keep tests fast
		reindexer = new DebounceReindexer(
			root,
			indexDir,
			50, // 50ms debounce
			manager,
			cache,
			completionDetector,
			noopLogger,
			recorder.launch,
		);

		expect(manager.isReindexing).toBe(false);

		reindexer.scheduleReindex();

		// Wait for the debounce callback to actually run, rather than sleeping
		// past it and hoping.
		await waitFor(
			() => startCount === 1,
			() => `onReindexStart was called ${startCount} times, expected 1`,
		);

		// THE LAUNCH, and its argv. This assertion used to read "either
		// reindexingInProgress is true or it is false", because the test could not
		// know whether the real `mnemex` binary existed on the machine running it —
		// a tautology standing in for the thing it wanted to check. With the
		// launcher injected there is nothing to hedge about: exactly one child was
		// requested, with the argv the MCP server uses, rooted at the workspace.
		expect(recorder.launches).toEqual([{ args: [...REINDEX_ARGS], cwd: root }]);
		expect(manager.isReindexing).toBe(true);
	}, 5000);

	test("no REAL process is started — the recorded launch is the only one", () => {
		// The property under repair, asserted on the filesystem rather than on a
		// report: a real `mnemex index` child writes `.mnemex/.indexing.lock` into
		// the workspace it was pointed at. Before the launcher was injected, this
		// file started nine of them on any machine with `mnemex` on PATH.
		reindexer = new DebounceReindexer(
			root,
			indexDir,
			10,
			manager,
			cache,
			completionDetector,
			noopLogger,
			recorder.launch,
		);

		reindexer.scheduleReindex();

		return new Promise<void>((resolve) => setTimeout(resolve, 300)).then(() => {
			expect(recorder.launches.length).toBe(1);
			// BYTES ON DISK: no lock file, so no real indexer ever ran here.
			expect(existsSync(join(indexDir, ".indexing.lock"))).toBe(false);
		});
	}, 5000);

	test("scheduleReindex() debounce: multiple calls collapse into one", async () => {
		let triggerCount = 0;

		// Wrap manager to count onReindexStart calls
		const originalStart = manager.onReindexStart.bind(manager);
		manager.onReindexStart = () => {
			triggerCount++;
			originalStart();
		};

		reindexer = new DebounceReindexer(
			root,
			indexDir,
			80, // 80ms debounce
			manager,
			cache,
			completionDetector,
			noopLogger,
			recorder.launch,
		);

		// Fire multiple schedule calls quickly
		reindexer.scheduleReindex();
		reindexer.scheduleReindex();
		reindexer.scheduleReindex();

		// Wait for the debounce to fire at all...
		await waitFor(
			() => triggerCount >= 1,
			() => `onReindexStart was called ${triggerCount} times, expected 1`,
		);

		// ...then give the two other schedule calls more than a full debounce
		// window to produce a trigger. This is a negative assertion ("no second
		// trigger arrives"), so it needs a bounded wait — there is no condition
		// to poll for.
		await settle(160);

		// All three collapsed into exactly one trigger
		expect(triggerCount).toBe(1);
	}, 5000);

	test("cancelPending() prevents reindex from firing", async () => {
		let triggered = false;
		const originalStart = manager.onReindexStart.bind(manager);
		manager.onReindexStart = () => {
			triggered = true;
			originalStart();
		};

		reindexer = new DebounceReindexer(
			root,
			indexDir,
			200, // longer debounce to give us time to cancel
			manager,
			cache,
			completionDetector,
			noopLogger,
			recorder.launch,
		);

		reindexer.scheduleReindex();
		reindexer.cancelPending();

		// Negative assertion: the cancelled timer must never fire. There is no
		// condition to poll for, so this legitimately needs a fixed wait past
		// the 200ms debounce window.
		await settle(400);

		expect(triggered).toBe(false);
	}, 5000);
});

// ---------------------------------------------------------------------------
// Scenario 4: FileWatcher detects changes and updates state manager
// ---------------------------------------------------------------------------

describe("FileWatcher detects changes and updates state manager", () => {
	let root: string;
	let indexDir: string;
	let manager: IndexStateManager;
	let watcher: FileWatcher;
	let testFile: string;

	beforeEach(async () => {
		({ root, indexDir } = makeTempWorkspace());
		manager = new IndexStateManager(
			indexDir,
			resolveStoreLocation(dirname(indexDir)),
		);
		await manager.initialize();

		// Create a test TypeScript file in the workspace
		testFile = join(root, "src", "example.ts");
		mkdirSync(join(root, "src"), { recursive: true });
		writeFileSync(testFile, "export const x = 1;\n", "utf-8");
	});

	afterEach(() => {
		watcher?.stop();
		cleanup(root);
	});

	test("FileWatcher wires onFileChange to state manager and detects writes", async () => {
		watcher = new FileWatcher(
			root,
			["**/*.ts"], // watch TypeScript files
			[".mnemex/**", ".git/**"], // ignore index dir
			(filePath: string) => {
				manager.recordChange(filePath);
			},
			noopLogger,
		);

		watcher.start();

		// Initial state: no changes
		expect(manager.changedFileCount).toBe(0);

		// Modify the test file
		writeFileSync(testFile, "export const x = 2; // modified\n", "utf-8");

		// Wait for the fs.watch event to be delivered. Delivery is optional here
		// (non-recursive platforms never fire), so this uses pollUntil and
		// tolerates a false result rather than failing on timeout. The bound
		// stays at the 500ms this test always allowed — for an OPTIONAL
		// condition the bound only caps how long a non-delivering platform
		// costs; delivery is observed in ~10ms and exits immediately.
		await pollUntil(() => manager.changedFileCount > 0, { timeoutMs: 500 });

		// The file change should have been picked up
		const freshness = manager.getFreshness();
		// Accept either:
		// - the file was detected (filesChanged contains "src/example.ts")
		// - or the watcher didn't fire on this platform (non-recursive platforms log a warning and skip)
		// We verify at minimum that the watcher didn't throw an error.
		if (freshness.filesChanged.length > 0) {
			expect(freshness.freshness).toBe("stale");
			// The path may be relative to root
			const hasFile = freshness.filesChanged.some((f) =>
				f.includes("example.ts"),
			);
			expect(hasFile).toBe(true);
		}
		// If filesChanged is empty: watcher on this platform may not support recursive watching.
		// This is acceptable behavior (the code logs a warning). The test passes in both cases.
	}, 10000);

	test("FileWatcher ignores files matching ignorePatterns", async () => {
		const ignoredFile = join(root, ".mnemex", "some.ts");
		writeFileSync(ignoredFile, "// ignored\n", "utf-8");

		watcher = new FileWatcher(
			root,
			["**/*.ts"],
			[".mnemex/**"],
			(filePath: string) => {
				manager.recordChange(filePath);
			},
			noopLogger,
		);

		watcher.start();

		// Modify the ignored file
		writeFileSync(ignoredFile, "// still ignored\n", "utf-8");

		// Negative assertion: the ignored path must never be recorded. Nothing
		// becomes true here, so a bounded wait is the only way to give the
		// watcher a chance to (wrongly) fire.
		await settle(500);

		// The ignored file should not be in changed files
		const freshness = manager.getFreshness();
		const hasIgnoredFile = freshness.filesChanged.some((f) =>
			f.includes(".mnemex"),
		);
		expect(hasIgnoredFile).toBe(false);
	}, 10000);

	test("FileWatcher stop() prevents further events", async () => {
		let callCount = 0;

		watcher = new FileWatcher(
			root,
			["**/*.ts"],
			[".mnemex/**"],
			() => {
				callCount++;
			},
			noopLogger,
		);

		watcher.start();

		// Modify once while running. Delivery is platform-dependent, so a false
		// result here is acceptable — the assertion below compares against
		// whatever count was reached.
		writeFileSync(testFile, "// change 1\n", "utf-8");
		await pollUntil(() => callCount > 0, { timeoutMs: 300 });

		const countAfterFirst = callCount;
		watcher.stop();

		// Modify again after stopping — should not fire. Negative assertion, so
		// this one needs a bounded wait rather than a polled condition.
		writeFileSync(testFile, "// change 2\n", "utf-8");
		await settle(300);

		// Count should not have increased after stop (or might be the same if platform didn't fire)
		expect(callCount).toBe(countAfterFirst);
	}, 10000);
});

// ---------------------------------------------------------------------------
// Scenario 5: Full flow — fresh → file changes → stale → reindex → fresh
// ---------------------------------------------------------------------------

describe("Full flow: fresh state -> file change -> stale with details -> reindex -> fresh", () => {
	let root: string;
	let indexDir: string;
	let manager: IndexStateManager;

	beforeEach(async () => {
		({ root, indexDir } = makeTempWorkspace());

		// Pre-write .reindex-timestamp to establish a known "fresh" baseline
		const originalTimestamp = new Date("2026-03-01T08:00:00.000Z");
		writeTimestamp(indexDir, originalTimestamp);

		manager = new IndexStateManager(
			indexDir,
			resolveStoreLocation(dirname(indexDir)),
		);
		await manager.initialize();
	});

	afterEach(() => cleanup(root));

	test("complete lifecycle: fresh -> stale (with details) -> reindexing -> fresh", () => {
		// Step 1: Verify initial fresh state
		const initial = manager.getFreshness();
		expect(initial.freshness).toBe("fresh");
		expect(initial.filesChanged).toEqual([]);
		expect(initial.staleSince).toBeNull();
		expect(initial.reindexingInProgress).toBe(false);
		expect(initial.lastIndexed).toBe("2026-03-01T08:00:00.000Z");

		// Step 2: Simulate file changes
		manager.recordChange("src/auth.ts");
		manager.recordChange("src/api.ts");

		const stale = manager.getFreshness();
		expect(stale.freshness).toBe("stale");
		expect(stale.filesChanged).toContain("src/auth.ts");
		expect(stale.filesChanged).toContain("src/api.ts");
		expect(stale.filesChanged).toHaveLength(2);
		expect(stale.staleSince).not.toBeNull();
		expect(stale.lastIndexed).toBe("2026-03-01T08:00:00.000Z");
		expect(stale.reindexingInProgress).toBe(false);

		// Step 3: Reindex starts
		manager.onReindexStart();

		const reindexing = manager.getFreshness();
		expect(reindexing.freshness).toBe("stale"); // still stale during reindex
		expect(reindexing.reindexingInProgress).toBe(true);

		// Step 4: Another file change arrives during reindex
		manager.recordChange("src/new-file.ts");

		const duringReindex = manager.getFreshness();
		expect(duringReindex.filesChanged).toHaveLength(3);
		expect(duringReindex.filesChanged).toContain("src/new-file.ts");
		expect(duringReindex.reindexingInProgress).toBe(true);

		// Step 5: Reindex completes
		const beforeComplete = Date.now();
		manager.onReindexComplete();
		const afterComplete = Date.now();

		const fresh = manager.getFreshness();
		expect(fresh.freshness).toBe("fresh");
		expect(fresh.filesChanged).toEqual([]);
		expect(fresh.staleSince).toBeNull();
		expect(fresh.reindexingInProgress).toBe(false);

		// lastIndexed should be a new timestamp (later than original)
		expect(fresh.lastIndexed).not.toBeNull();
		const newTs = new Date(fresh.lastIndexed!).getTime();
		expect(newTs).toBeGreaterThanOrEqual(beforeComplete);
		expect(newTs).toBeLessThanOrEqual(afterComplete);

		// Should be strictly later than the original 2026-03-01 timestamp
		const originalMs = new Date("2026-03-01T08:00:00.000Z").getTime();
		expect(newTs).toBeGreaterThan(originalMs);
	});

	test("reindexComplete writes updated timestamp to disk", () => {
		manager.recordChange("src/foo.ts");
		manager.onReindexStart();
		manager.onReindexComplete();

		const tsPath = join(indexDir, ".reindex-timestamp");
		expect(existsSync(tsPath)).toBe(true);

		// The written timestamp should be parseable and recent
		const content = require("node:fs").readFileSync(tsPath, "utf-8").trim();
		const parsed = new Date(content);
		expect(isNaN(parsed.getTime())).toBe(false);

		// Should be later than the original baseline
		expect(parsed.getTime()).toBeGreaterThan(
			new Date("2026-03-01T08:00:00.000Z").getTime(),
		);
	});

	test("re-initialize after onReindexComplete() picks up new timestamp", async () => {
		manager.onReindexComplete();
		const afterComplete = manager.getFreshness();
		const completedAt = afterComplete.lastIndexed!;

		// Create a fresh manager that reads the on-disk timestamp
		const manager2 = new IndexStateManager(
			indexDir,
			resolveStoreLocation(dirname(indexDir)),
		);
		await manager2.initialize();

		const freshness2 = manager2.getFreshness();
		expect(freshness2.freshness).toBe("fresh");
		expect(freshness2.lastIndexed).toBe(completedAt);
	});
});

// ---------------------------------------------------------------------------
// Scenario 6: buildFreshness includes responseTimeMs
// ---------------------------------------------------------------------------

describe("buildFreshness includes responseTimeMs", () => {
	let root: string;
	let indexDir: string;
	let manager: IndexStateManager;

	beforeEach(async () => {
		({ root, indexDir } = makeTempWorkspace());
		manager = new IndexStateManager(
			indexDir,
			resolveStoreLocation(dirname(indexDir)),
		);
		await manager.initialize();
	});

	afterEach(() => cleanup(root));

	test("buildFreshness returns all FreshnessMetadata fields including responseTimeMs > 0", () => {
		manager.recordChange("src/foo.ts");

		const startTime = Date.now() - 10; // pretend we started 10ms ago
		const result = buildFreshness(manager, startTime);

		// Verify all FreshnessMetadata fields are present
		expect(result).toHaveProperty("freshness");
		expect(result).toHaveProperty("lastIndexed");
		expect(result).toHaveProperty("staleSince");
		expect(result).toHaveProperty("filesChanged");
		expect(result).toHaveProperty("reindexingInProgress");
		expect(result).toHaveProperty("responseTimeMs");

		// responseTimeMs should be positive (elapsed ms since startTime)
		expect(result.responseTimeMs).toBeGreaterThan(0);

		// Content should match what getFreshness() returns
		expect(result.freshness).toBe("stale");
		expect(result.filesChanged).toContain("src/foo.ts");
	});

	test("buildFreshness responseTimeMs grows when startTime is further in the past", () => {
		const startTimeFarPast = Date.now() - 100;
		const startTimeNear = Date.now() - 1;

		const resultFar = buildFreshness(manager, startTimeFarPast);
		const resultNear = buildFreshness(manager, startTimeNear);

		expect(resultFar.responseTimeMs).toBeGreaterThan(resultNear.responseTimeMs);
	});

	test("buildFreshness on fresh state returns freshness='fresh'", async () => {
		// Write a timestamp so manager starts fresh
		const ts = new Date("2026-02-01T12:00:00.000Z");
		writeTimestamp(indexDir, ts);

		const freshManager = new IndexStateManager(
			indexDir,
			resolveStoreLocation(dirname(indexDir)),
		);
		await freshManager.initialize();

		const result = buildFreshness(freshManager, Date.now());
		expect(result.freshness).toBe("fresh");
		expect(result.filesChanged).toEqual([]);
		expect(result.staleSince).toBeNull();
		expect(result.responseTimeMs).toBeGreaterThanOrEqual(0);
	});

	test("buildFreshness reflects reindexingInProgress correctly", () => {
		manager.onReindexStart();

		const result = buildFreshness(manager, Date.now());
		expect(result.reindexingInProgress).toBe(true);
		expect(result.freshness).toBe("stale");
	});
});

// ---------------------------------------------------------------------------
// Scenario 7: MCP server state when no .reindex-timestamp exists
// (Component-level: validates state manager initialization without stdio server)
// ---------------------------------------------------------------------------

describe("MCP server state when no .reindex-timestamp exists", () => {
	let root: string;
	let indexDir: string;

	beforeEach(() => {
		({ root, indexDir } = makeTempWorkspace());
	});

	afterEach(() => cleanup(root));

	test("IndexStateManager without timestamp reports stale + no lastIndexed", async () => {
		// Simulate the server startup scenario: indexDir exists (from mkdirSync above)
		// but has no .reindex-timestamp (e.g., index.db exists but no timestamp written)
		const manager = new IndexStateManager(
			indexDir,
			resolveStoreLocation(dirname(indexDir)),
		);
		await manager.initialize();

		const freshness = manager.getFreshness();

		// Key assertions matching what the MCP server would return to a client
		expect(freshness.freshness).toBe("stale"); // no timestamp = never indexed
		expect(freshness.lastIndexed).toBeNull();
		expect(freshness.reindexingInProgress).toBe(false);
		expect(freshness.filesChanged).toEqual([]);
		// staleSince is null because stale state here is due to null lastIndexed, not file changes
		expect(freshness.staleSince).toBeNull();
	});

	test("buildFreshness for uninitialized workspace includes correct stale metadata", async () => {
		const manager = new IndexStateManager(
			indexDir,
			resolveStoreLocation(dirname(indexDir)),
		);
		await manager.initialize();

		const startTime = Date.now();
		const result = buildFreshness(manager, startTime);

		// Matches FreshnessMetadata shape that index_status tool returns
		expect(result.freshness).toBe("stale");
		expect(result.lastIndexed).toBeNull();
		expect(result.staleSince).toBeNull();
		expect(result.filesChanged).toEqual([]);
		expect(result.reindexingInProgress).toBe(false);
		expect(result.responseTimeMs).toBeGreaterThanOrEqual(0);
	});

	test("after recording changes on uninitialized workspace, staleSince is set", async () => {
		const manager = new IndexStateManager(
			indexDir,
			resolveStoreLocation(dirname(indexDir)),
		);
		await manager.initialize();

		// Simulate the watcher firing on a stale workspace that was never indexed
		const before = Date.now();
		manager.recordChange("src/handler.ts");
		const after = Date.now();

		const result = buildFreshness(manager, Date.now());
		expect(result.freshness).toBe("stale");
		expect(result.filesChanged).toContain("src/handler.ts");
		// staleSince should now be set (triggered by first recordChange when filesChanged was empty)
		expect(result.staleSince).not.toBeNull();
		const staleMs = new Date(result.staleSince!).getTime();
		expect(staleMs).toBeGreaterThanOrEqual(before);
		expect(staleMs).toBeLessThanOrEqual(after);
	});

	test("reindex cycle on uninitialized workspace produces fresh state", async () => {
		const manager = new IndexStateManager(
			indexDir,
			resolveStoreLocation(dirname(indexDir)),
		);
		await manager.initialize();

		// Initially unindexed
		expect(manager.getFreshness().freshness).toBe("stale");
		expect(manager.getFreshness().lastIndexed).toBeNull();

		// Simulate a successful reindex
		manager.onReindexStart();
		manager.onReindexComplete();

		const result = buildFreshness(manager, Date.now());
		expect(result.freshness).toBe("fresh");
		expect(result.lastIndexed).not.toBeNull();
		expect(result.reindexingInProgress).toBe(false);
	});

	test("multiple reindex cycles maintain correct state", async () => {
		const manager = new IndexStateManager(
			indexDir,
			resolveStoreLocation(dirname(indexDir)),
		);
		await manager.initialize();

		// Cycle 1
		manager.recordChange("src/a.ts");
		manager.onReindexStart();
		manager.onReindexComplete();

		const firstLastIndexed = manager.getFreshness().lastIndexed;
		expect(firstLastIndexed).not.toBeNull();

		// Wait for the wall clock to actually advance, rather than sleeping a
		// fixed amount and assuming it did.
		const beforeSecondCycle = Date.now();
		await waitFor(
			() => Date.now() > beforeSecondCycle,
			() => `clock did not advance past ${beforeSecondCycle}`,
			{ intervalMs: 1 },
		);

		// Cycle 2
		manager.recordChange("src/b.ts");
		manager.onReindexStart();
		manager.onReindexComplete();

		const secondLastIndexed = manager.getFreshness().lastIndexed;
		expect(secondLastIndexed).not.toBeNull();

		// Second timestamp should be at or after first
		expect(new Date(secondLastIndexed!).getTime()).toBeGreaterThanOrEqual(
			new Date(firstLastIndexed!).getTime(),
		);

		// Final state should be fresh
		expect(manager.getFreshness().freshness).toBe("fresh");
		expect(manager.getFreshness().filesChanged).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Scenario 8: Race condition — reindex not triggered twice concurrently
// ---------------------------------------------------------------------------

describe("Race condition: reindex not triggered twice concurrently", () => {
	let root: string;
	let indexDir: string;
	let manager: IndexStateManager;
	let cache: IndexCache;
	let completionDetector: CompletionDetector;
	let reindexer: DebounceReindexer;
	let recorder: ReturnType<typeof makeRecordingLauncher>;
	let previousPath: string;

	beforeEach(async () => {
		({ root, indexDir } = makeTempWorkspace());
		previousPath = hideMnemexFromPath(join(root, "empty-bin"));
		manager = new IndexStateManager(
			indexDir,
			resolveStoreLocation(dirname(indexDir)),
		);
		await manager.initialize();
		cache = makeStubCache();
		completionDetector = new CompletionDetector(
			indexDir,
			50,
			join(indexDir, ".indexing.lock"),
		);
		recorder = makeRecordingLauncher();
	});

	afterEach(() => {
		reindexer?.cancelPending();
		completionDetector.stop();
		process.env.PATH = previousPath;
		cleanup(root);
	});

	test("isRunning() returns true while reindex is in progress (before lock file exists)", async () => {
		let startCount = 0;
		const originalStart = manager.onReindexStart.bind(manager);
		manager.onReindexStart = () => {
			startCount++;
			originalStart();
		};

		reindexer = new DebounceReindexer(
			root,
			indexDir,
			30, // very short debounce
			manager,
			cache,
			completionDetector,
			noopLogger,
			recorder.launch,
		);

		reindexer.scheduleReindex();

		// Wait for the debounce to fire and triggerReindex to run
		await waitFor(
			() => startCount === 1,
			() => `startCount was ${startCount}, expected 1`,
		);

		// After first trigger, isRunning() should be true (even if child process
		// failed to spawn — the running flag is set before spawn)
		// startCount should be 1 (called once)
		expect(startCount).toBe(1);

		// isRunning() should be true (running flag) — even without a lock file
		// on disk. This is the key race protection: between spawn and the child
		// writing its own lock, the in-memory flag prevents double-trigger.
		expect(reindexer.isRunning()).toBe(true);
	}, 5000);

	test("second scheduleReindex during active reindex triggers exactly 0 additional starts", async () => {
		let startCount = 0;
		const originalStart = manager.onReindexStart.bind(manager);
		manager.onReindexStart = () => {
			startCount++;
			originalStart();
		};

		reindexer = new DebounceReindexer(
			root,
			indexDir,
			30,
			manager,
			cache,
			completionDetector,
			noopLogger,
			recorder.launch,
		);

		// Trigger first reindex
		reindexer.scheduleReindex();
		await waitFor(
			() => startCount === 1,
			() => `startCount was ${startCount}, expected 1`,
		);
		expect(startCount).toBe(1);

		// Try to trigger second reindex while first is "running". Negative
		// assertion ("no second start arrives"), so this needs a bounded wait
		// past the 30ms debounce window rather than a polled condition.
		reindexer.scheduleReindex();
		await settle(100);

		// Should still be 1 — the second trigger was a no-op because running=true
		expect(startCount).toBe(1);
	}, 5000);

	test("forceReindex during active reindex does not start a second one", async () => {
		let startCount = 0;
		const originalStart = manager.onReindexStart.bind(manager);
		manager.onReindexStart = () => {
			startCount++;
			originalStart();
		};

		reindexer = new DebounceReindexer(
			root,
			indexDir,
			30,
			manager,
			cache,
			completionDetector,
			noopLogger,
			recorder.launch,
		);

		// Start first reindex via schedule
		reindexer.scheduleReindex();
		await waitFor(
			() => startCount === 1,
			() => `startCount was ${startCount}, expected 1`,
		);
		expect(startCount).toBe(1);

		// Try forceReindex while first is active
		await reindexer.forceReindex();

		// Should still be 1 — forceReindex calls triggerReindex which checks running flag
		expect(startCount).toBe(1);
	}, 5000);

	test("external lock file also prevents reindex (CLI concurrent safety)", async () => {
		let startCount = 0;
		const originalStart = manager.onReindexStart.bind(manager);
		manager.onReindexStart = () => {
			startCount++;
			originalStart();
		};

		reindexer = new DebounceReindexer(
			root,
			indexDir,
			30,
			manager,
			cache,
			completionDetector,
			noopLogger,
			recorder.launch,
		);

		// Simulate an external process holding the lock (like `mnemex index` from CLI)
		const lockPath = join(indexDir, ".indexing.lock");
		writeFileSync(
			lockPath,
			JSON.stringify({
				pid: process.pid, // our own PID so isProcessRunning returns true
				startTime: Date.now(),
				heartbeat: Date.now(),
				startedAt: new Date().toISOString(),
			}),
		);

		// Try to schedule reindex. The assertion below is a negative ("the
		// trigger never starts"), so this needs a bounded wait past the 30ms
		// debounce window — there is no condition to poll for.
		reindexer.scheduleReindex();
		await settle(100);

		// Lock is held → triggerReindex should have skipped
		expect(startCount).toBe(0);
		expect(reindexer.isRunning()).toBe(true); // isLocked returns true

		// Clean up the lock
		require("node:fs").unlinkSync(lockPath);
	}, 5000);

	test("after reindex completes, a new reindex can be triggered", async () => {
		let startCount = 0;
		let completeCount = 0;
		const originalStart = manager.onReindexStart.bind(manager);
		const originalComplete = manager.onReindexComplete.bind(manager);
		manager.onReindexStart = () => {
			startCount++;
			originalStart();
		};
		manager.onReindexComplete = () => {
			completeCount++;
			originalComplete();
		};

		reindexer = new DebounceReindexer(
			root,
			indexDir,
			30,
			manager,
			cache,
			completionDetector,
			noopLogger,
			recorder.launch,
		);

		// First reindex
		reindexer.scheduleReindex();
		await waitFor(
			() => startCount === 1,
			() => `startCount was ${startCount} after the first schedule, expected 1`,
		);
		expect(startCount).toBe(1);

		// Simulate completion (in real scenario, CompletionDetector fires this callback)
		// We need to manually trigger what the completionDetector.watch() callback does
		manager.onReindexComplete();
		// Also need to reset the running flag — in real code, the completion callback does this.
		// Let's check if it's accessible...
		// The running flag is private, but onReindexComplete via the watcher callback
		// in the actual reindexer sets running=false. Let's simulate by creating a fresh reindexer.

		// Create a new reindexer (simulating post-completion state)
		reindexer.cancelPending();
		reindexer = new DebounceReindexer(
			root,
			indexDir,
			30,
			manager,
			cache,
			completionDetector,
			noopLogger,
			recorder.launch,
		);

		// Second reindex should now be allowed
		startCount = 0;
		reindexer.scheduleReindex();
		await waitFor(
			() => startCount === 1,
			() =>
				`startCount was ${startCount} after the second schedule, expected 1 (completeCount=${completeCount})`,
		);
		expect(startCount).toBe(1); // New trigger allowed

		// WHY THIS TEST USED TO FAIL ~1 RUN IN 8. The first reindexer launched the
		// REAL installed `mnemex index`, which raced to write
		// `.mnemex/.indexing.lock` into this temp workspace. When it won that race,
		// the second reindexer's `isLocked()` was true and `triggerReindex()`
		// skipped, leaving startCount at 0. It was never a timing bug in the class;
		// it was a real child process, and the same real child process that made
		// this file an entry-point keychain bypass.
		expect(existsSync(join(indexDir, ".indexing.lock"))).toBe(false);
		expect(recorder.launches.map((l) => l.args)).toEqual([
			[...REINDEX_ARGS],
			[...REINDEX_ARGS],
		]);
	}, 5000);
});
