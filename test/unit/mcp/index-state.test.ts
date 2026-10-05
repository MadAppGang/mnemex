/**
 * Unit tests for buildIndexState — the structured, read-only index-state builder.
 *
 * Exercises the 5-case validation matrix + amendments:
 *  - cases 1, 2a, 2b, 3, 4, 5 (validation-criteria.md)
 *  - A4: live lock + no index.db => indexing_in_progress, canReturnCachedResults false
 *  - chunkCount/languages fallbacks; tracker-unloadable branch
 *
 * Uses a REAL IndexStateManager (recordChange() for stale, onReindexComplete()
 * for fresh) and a stub cache.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveStoreLocation } from "../../../src/core/store-location.js";
import {
	buildIndexState,
	HEARTBEAT_FRESH_TIMEOUT,
} from "../../../src/mcp/index-state.js";
import { IndexStateManager } from "../../../src/mcp/state-manager.js";
import type { ToolDeps } from "../../../src/mcp/tools/deps.js";

const LOCK_FILENAME = ".indexing.lock";
const tempDirs: string[] = [];

function makeIndexDir(): string {
	const root = mkdtempSync(join(tmpdir(), "index-state-test-"));
	tempDirs.push(root);
	const indexDir = join(root, ".mnemex");
	mkdirSync(indexDir, { recursive: true });
	return indexDir;
}

function writeIndexDb(indexDir: string): void {
	writeFileSync(join(indexDir, "index.db"), "fake sqlite bytes");
}

function writeLock(
	indexDir: string,
	overrides: Partial<{
		pid: number;
		startTime: number;
		heartbeat: number;
		lastProgressAt: number;
		phase: string;
		phaseStartedAt: number;
		startedAt: string;
		includeProgress: boolean;
	}> = {},
): void {
	const now = Date.now();
	const data: Record<string, unknown> = {
		pid: overrides.pid ?? process.pid,
		startTime: overrides.startTime ?? now,
		heartbeat: overrides.heartbeat ?? now,
		startedAt: overrides.startedAt ?? new Date(now).toISOString(),
	};
	// Only emit lastProgressAt when asked; by default these locks OMIT it, which
	// exercises the backward-compat (heartbeat-fallback) path on purpose.
	if (overrides.includeProgress || overrides.lastProgressAt !== undefined) {
		data.lastProgressAt = overrides.lastProgressAt ?? now;
	}
	// Phase fields are likewise opt-in: omitted by default so existing cases
	// exercise the no-phase (older-binary) report path.
	if (overrides.phase !== undefined) {
		data.phase = overrides.phase;
	}
	if (overrides.phaseStartedAt !== undefined) {
		data.phaseStartedAt = overrides.phaseStartedAt;
	}
	writeFileSync(join(indexDir, LOCK_FILENAME), JSON.stringify(data, null, 2));
}

/**
 * Build a minimal ToolDeps sufficient for buildIndexState. Only config.indexDir,
 * stateManager, and cache.get() are consulted.
 */
function makeDeps(
	indexDir: string,
	stateManager: IndexStateManager,
	cacheBehavior:
		| { kind: "stats"; totalFiles: number; lastIndexed: string | null }
		| { kind: "throw" }
		| { kind: "noindex" } = { kind: "stats", totalFiles: 7, lastIndexed: null },
): ToolDeps {
	const cache = {
		get: async () => {
			if (cacheBehavior.kind === "throw") {
				throw new Error("tracker unloadable");
			}
			if (cacheBehavior.kind === "noindex") {
				throw new Error("No index found");
			}
			return {
				tracker: {
					getStats: () => ({
						totalFiles: cacheBehavior.totalFiles,
						lastIndexed: cacheBehavior.lastIndexed,
					}),
				},
			};
		},
	};

	return {
		// biome-ignore lint/suspicious/noExplicitAny: minimal test double
		cache: cache as any,
		stateManager,
		// biome-ignore lint/suspicious/noExplicitAny: only indexDir/workspaceRoot used
		config: { indexDir, workspaceRoot: join(indexDir, "..") } as any,
		// biome-ignore lint/suspicious/noExplicitAny: logger unused by builder
		logger: {} as any,
		serverStartTime: Date.now(),
		watcherActive: false,
	};
}

async function freshManager(indexDir: string): Promise<IndexStateManager> {
	const m = new IndexStateManager(
		indexDir,
		resolveStoreLocation(dirname(indexDir)),
	);
	await m.initialize();
	return m;
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) {
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				// best effort
			}
		}
	}
});

describe("buildIndexState", () => {
	test("HEARTBEAT_FRESH_TIMEOUT is 30s (larger than acquisition's 10s window)", () => {
		expect(HEARTBEAT_FRESH_TIMEOUT).toBe(30000);
	});

	// Case 1: live lock, fresh heartbeat, index.db present
	test("case 1: live pid + fresh heartbeat + index.db => indexing_in_progress", async () => {
		const indexDir = makeIndexDir();
		writeIndexDb(indexDir);
		writeLock(indexDir, { pid: process.pid });
		const m = await freshManager(indexDir);
		const state = await buildIndexState(makeDeps(indexDir, m), Date.now());

		expect(state.status).toBe("indexing_in_progress");
		expect(state.indexing).not.toBeNull();
		expect(state.indexing?.pidAlive).toBe(true);
		expect(state.indexing?.isHeartbeatFresh).toBe(true);
		expect(state.indexing?.command).toBeNull();
		expect(state.canReturnCachedResults).toBe(true);
	});

	// Case 2a: dead pid, index.db present => stale_lock, NOT removed
	test("case 2a: dead pid => stale_lock, informational recommendation, lock not removed", async () => {
		const indexDir = makeIndexDir();
		writeIndexDb(indexDir);
		writeLock(indexDir, { pid: 2_000_000_000 });
		const m = await freshManager(indexDir);
		const state = await buildIndexState(makeDeps(indexDir, m), Date.now());

		expect(state.status).toBe("stale_lock");
		expect(state.indexing?.pidAlive).toBe(false);
		expect(state.recommendations.some((r) => r.includes("appears stale"))).toBe(
			true,
		);
		// Read-only proof at the builder level.
		expect(existsSync(join(indexDir, LOCK_FILENAME))).toBe(true);
	});

	// Case 2b: live pid, heartbeat 60s old => still indexing_in_progress (conservative)
	test("case 2b: live pid + 60s-old heartbeat => indexing_in_progress, isHeartbeatFresh false", async () => {
		const indexDir = makeIndexDir();
		writeIndexDb(indexDir);
		writeLock(indexDir, { pid: process.pid, heartbeat: Date.now() - 60_000 });
		const m = await freshManager(indexDir);
		const state = await buildIndexState(makeDeps(indexDir, m), Date.now());

		expect(state.status).toBe("indexing_in_progress");
		expect(state.indexing?.isHeartbeatFresh).toBe(false);
	});

	// HUNG: live pid, fresh heartbeat, but lastProgressAt older than progress
	// timeout => indexing_hung (the LanceDB write-hang case). This is the key new
	// classification: heartbeat looks fresh, but no real work has happened.
	test("hung: live pid + fresh heartbeat + stalled lastProgressAt => indexing_hung", async () => {
		const indexDir = makeIndexDir();
		writeIndexDb(indexDir);
		writeLock(indexDir, {
			pid: process.pid,
			heartbeat: Date.now(), // timer kept stamping => looks alive
			lastProgressAt: Date.now() - 600_000, // no progress for 10 min (> 5 min timeout)
			startTime: Date.now() - 700_000,
		});
		const m = await freshManager(indexDir);
		const state = await buildIndexState(makeDeps(indexDir, m), Date.now());

		expect(state.status).toBe("indexing_hung");
		expect(state.indexing?.pidAlive).toBe(true);
		expect(state.indexing?.isProgressing).toBe(false);
		// Heartbeat can still read fresh — that's exactly why heartbeat alone misses it.
		expect(state.indexing?.isHeartbeatFresh).toBe(true);
		// Cached results remain usable; the hung holder will be auto-reclaimed.
		expect(state.canReturnCachedResults).toBe(true);
		expect(
			state.recommendations.some((r) => r.toLowerCase().includes("hung")),
		).toBe(true);
		expect(
			state.recommendations.some((r) => r.includes("reclaimed automatically")),
		).toBe(true);
	});

	// HUNG + PHASE: when the lock carries a phase, the hung report attributes the
	// hang to it (both in the structured field AND a recommendation), WITHOUT
	// changing the decision logic or dropping the required substrings.
	test("hung: phase is surfaced in the structured output AND the recommendation", async () => {
		const indexDir = makeIndexDir();
		writeIndexDb(indexDir);
		writeLock(indexDir, {
			pid: process.pid,
			heartbeat: Date.now(), // looks alive
			lastProgressAt: Date.now() - 600_000, // no progress for 10 min
			startTime: Date.now() - 700_000,
			phase: "writing:lance",
			phaseStartedAt: Date.now() - 360_000, // stuck ~6 min in this phase
		});
		const m = await freshManager(indexDir);
		const state = await buildIndexState(makeDeps(indexDir, m), Date.now());

		expect(state.status).toBe("indexing_hung");
		// Structured field carries the phase + a stuck duration.
		expect(state.indexing?.phase).toBe("writing:lance");
		expect(state.indexing?.phaseStuckMs).toBeGreaterThanOrEqual(360_000 - 2000);
		// The recommendation names the phase…
		expect(state.recommendations.some((r) => r.includes("writing:lance"))).toBe(
			true,
		);
		// …while STILL preserving the required hung/auto-reclaim substrings.
		expect(
			state.recommendations.some((r) => r.toLowerCase().includes("hung")),
		).toBe(true);
		expect(
			state.recommendations.some((r) => r.includes("reclaimed automatically")),
		).toBe(true);
		// And the one-line message mentions the phase too.
		expect(state.message).toContain("writing:lance");
	});

	// HUNG without phase (older binary): phase undefined, report unchanged from
	// the pre-phase behaviour (substrings preserved, no phase mentioned).
	test("hung: no phase => phase undefined and report omits a phase clause", async () => {
		const indexDir = makeIndexDir();
		writeIndexDb(indexDir);
		writeLock(indexDir, {
			pid: process.pid,
			heartbeat: Date.now(),
			lastProgressAt: Date.now() - 600_000,
			startTime: Date.now() - 700_000,
			// no phase / phaseStartedAt
		});
		const m = await freshManager(indexDir);
		const state = await buildIndexState(makeDeps(indexDir, m), Date.now());

		expect(state.status).toBe("indexing_hung");
		expect(state.indexing?.phase).toBeUndefined();
		expect(state.indexing?.phaseStuckMs).toBeUndefined();
		// Required substrings still present on the no-phase path.
		expect(
			state.recommendations.some((r) => r.toLowerCase().includes("hung")),
		).toBe(true);
		expect(
			state.recommendations.some((r) => r.includes("reclaimed automatically")),
		).toBe(true);
		// No "in phase '...'" clause leaks in.
		expect(state.message).not.toContain("in phase");
	});

	// BACKWARD COMPAT: a lock written by an OLDER binary has no lastProgressAt.
	// With a fresh heartbeat it must classify as indexing_in_progress (NOT hung):
	// the progress check falls back to heartbeat.
	test("backward compat: live pid + fresh heartbeat + NO lastProgressAt => indexing_in_progress", async () => {
		const indexDir = makeIndexDir();
		writeIndexDb(indexDir);
		// includeProgress omitted => no lastProgressAt field on disk.
		writeLock(indexDir, { pid: process.pid });
		const m = await freshManager(indexDir);
		const state = await buildIndexState(makeDeps(indexDir, m), Date.now());

		expect(state.status).toBe("indexing_in_progress");
		expect(state.indexing?.isProgressing).toBe(true);
		// lastProgressAt is surfaced (mirrors heartbeat) and is a valid ISO string.
		expect(state.indexing?.lastProgressAt).toBeTruthy();
		expect(state.indexing?.lastProgressAt).not.toContain("Invalid");
	});

	// Case 3: no index.db, no lock => no_index
	test("case 3: no index.db + no lock => no_index, canReturnCachedResults false", async () => {
		const indexDir = makeIndexDir();
		const m = await freshManager(indexDir);
		const state = await buildIndexState(
			makeDeps(indexDir, m, { kind: "noindex" }),
			Date.now(),
		);

		expect(state.status).toBe("no_index");
		expect(state.canReturnCachedResults).toBe(false);
		expect(state.indexing).toBeNull();
		expect(state.recommendations.length).toBeGreaterThan(0);
	});

	// Case 4: index.db present, stateManager stale, no lock => stale
	test("case 4: index.db + stale stateManager + no lock => stale, caveat present", async () => {
		const indexDir = makeIndexDir();
		writeIndexDb(indexDir);
		const m = await freshManager(indexDir);
		m.recordChange("src/foo.ts"); // => stale
		const state = await buildIndexState(makeDeps(indexDir, m), Date.now());

		expect(state.status).toBe("stale");
		expect(state.canReturnCachedResults).toBe(true);
		expect(state.recommendations.length).toBeGreaterThan(0);
		expect(state.indexing).toBeNull();
	});

	// Case 5: index.db present, stateManager fresh, no lock => fresh
	test("case 5: index.db + fresh stateManager + no lock => fresh, no caveat", async () => {
		const indexDir = makeIndexDir();
		writeIndexDb(indexDir);
		const m = await freshManager(indexDir);
		m.onReindexComplete(); // => fresh (only public path)
		const state = await buildIndexState(makeDeps(indexDir, m), Date.now());

		expect(state.status).toBe("fresh");
		expect(state.canReturnCachedResults).toBe(true);
		expect(state.recommendations).toEqual([]);
		expect(state.indexing).toBeNull();
	});

	// A4: live lock + NO index.db => indexing_in_progress AND canReturnCachedResults false
	test("A4: live lock without index.db => indexing_in_progress + canReturnCachedResults false", async () => {
		const indexDir = makeIndexDir();
		// no index.db
		writeLock(indexDir, { pid: process.pid });
		const m = await freshManager(indexDir);
		const state = await buildIndexState(
			makeDeps(indexDir, m, { kind: "noindex" }),
			Date.now(),
		);

		expect(state.status).toBe("indexing_in_progress");
		expect(state.canReturnCachedResults).toBe(false);
	});

	// chunkCount/languages fallbacks always 0 / []
	test("chunkCount is 0 and languages is [] (read-only fallbacks)", async () => {
		const indexDir = makeIndexDir();
		writeIndexDb(indexDir);
		const m = await freshManager(indexDir);
		m.onReindexComplete();
		const state = await buildIndexState(makeDeps(indexDir, m), Date.now());

		expect(state.index.chunkCount).toBe(0);
		expect(state.index.languages).toEqual([]);
	});

	// tracker-unloadable branch: index.db present but cache.get() throws
	test("tracker unloadable => indexedFileCount 0 but canReturnCachedResults true", async () => {
		const indexDir = makeIndexDir();
		writeIndexDb(indexDir);
		const m = await freshManager(indexDir);
		m.onReindexComplete();
		const state = await buildIndexState(
			makeDeps(indexDir, m, { kind: "throw" }),
			Date.now(),
		);

		expect(state.index.indexedFileCount).toBe(0);
		expect(state.canReturnCachedResults).toBe(true);
		// indexSizeBytes still read from disk (statSync) even when tracker fails.
		expect(state.index.indexSizeBytes).toBeGreaterThan(0);
	});

	// stats path: indexedFileCount comes from tracker.getStats().totalFiles
	test("indexedFileCount reflects tracker.getStats().totalFiles", async () => {
		const indexDir = makeIndexDir();
		writeIndexDb(indexDir);
		const m = await freshManager(indexDir);
		m.onReindexComplete();
		const state = await buildIndexState(
			makeDeps(indexDir, m, {
				kind: "stats",
				totalFiles: 42,
				lastIndexed: null,
			}),
			Date.now(),
		);

		expect(state.index.indexedFileCount).toBe(42);
	});
});
