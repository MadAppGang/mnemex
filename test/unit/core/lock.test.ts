/**
 * Unit tests for the dual-liveness + progress hang detection on the index lock.
 *
 * The lock carries TWO timestamps:
 *  - `heartbeat` — stamped every 1s by a timer; means "process alive". Stays
 *    fresh even when indexing is wedged (the LanceDB write hang), so it CANNOT
 *    detect a hang.
 *  - `lastProgressAt` — stamped only when real indexing work completes
 *    (recordProgress()). Stops advancing when the indexer hangs, which is how a
 *    hung-but-alive holder is detected and reclaimed.
 *
 * These tests prove:
 *  - recordProgress() advances lastProgressAt (only for the owning pid).
 *  - isLockStale: live pid + fresh progress => NOT stale.
 *  - isLockStale: live pid + OLD progress (fresh heartbeat) => STALE (the hang).
 *  - backward compat: a lock with heartbeat but NO lastProgressAt falls back to
 *    heartbeat — it is NOT treated as instantly stale.
 *  - acquire() RECLAIMS a hung-but-alive lock (the end-to-end auto-reclaim).
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createStoreLock,
	DEFAULT_PROGRESS_TIMEOUT,
	inspectLock,
	isLockStale,
} from "../../../src/core/lock.js";
import { resolveStoreLocation } from "../../../src/core/store-location.js";

const LOCK_FILENAME = ".indexing.lock";
const DEAD_PID = 2_000_000_000; // almost certainly not a live process
const tempDirs: string[] = [];

/** Create a temp project root with a `.mnemex` index dir (the default IndexLock dir). */
function makeProject(): { projectPath: string; indexDir: string } {
	const projectPath = mkdtempSync(join(tmpdir(), "lock-test-"));
	tempDirs.push(projectPath);
	const indexDir = join(projectPath, ".mnemex");
	mkdirSync(indexDir, { recursive: true });
	return { projectPath, indexDir };
}

/** The project's store lock, derived exactly as production derives it. */
function lockAt(projectPath: string) {
	return createStoreLock(resolveStoreLocation(projectPath));
}

/** Read the raw lock file JSON for assertions. */
function readLock(indexDir: string): {
	pid: number;
	startTime: number;
	heartbeat: number;
	lastProgressAt?: number;
	phase?: string;
	phaseStartedAt?: number;
	startedAt: string;
} {
	return JSON.parse(readFileSync(join(indexDir, LOCK_FILENAME), "utf-8"));
}

/** Write a lock file directly (lets us forge specific timestamps / omit fields). */
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
		omitLastProgressAt: boolean;
	}> = {},
): void {
	const now = Date.now();
	const data: Record<string, unknown> = {
		pid: overrides.pid ?? process.pid,
		startTime: overrides.startTime ?? now,
		heartbeat: overrides.heartbeat ?? now,
		startedAt: overrides.startedAt ?? new Date(now).toISOString(),
	};
	if (!overrides.omitLastProgressAt) {
		data.lastProgressAt = overrides.lastProgressAt ?? now;
	}
	if (overrides.phase !== undefined) {
		data.phase = overrides.phase;
	}
	if (overrides.phaseStartedAt !== undefined) {
		data.phaseStartedAt = overrides.phaseStartedAt;
	}
	writeFileSync(join(indexDir, LOCK_FILENAME), JSON.stringify(data, null, 2));
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

describe("DEFAULT_PROGRESS_TIMEOUT", () => {
	test("is 5 minutes and much larger than the 10s stale window", () => {
		expect(DEFAULT_PROGRESS_TIMEOUT).toBe(300000);
	});
});

describe("recordProgress", () => {
	test("advances lastProgressAt when this process owns the lock", async () => {
		const { projectPath, indexDir } = makeProject();
		const lock = lockAt(projectPath);
		const acquired = await lock.acquire();
		expect(acquired.acquired).toBe(true);

		try {
			const before = readLock(indexDir).lastProgressAt as number;
			// Force the clock to move so the new timestamp is strictly greater.
			await new Promise((r) => setTimeout(r, 5));
			lock.recordProgress();
			const after = readLock(indexDir).lastProgressAt as number;

			expect(after).toBeGreaterThan(before);
			// Heartbeat is independent; recordProgress must not touch it.
			expect(typeof readLock(indexDir).heartbeat).toBe("number");
		} finally {
			lock.release();
		}
	});

	test("is a no-op when another pid owns the lock (does not steal it)", () => {
		const { projectPath, indexDir } = makeProject();
		// A lock owned by a different (dead) pid with an OLD progress timestamp.
		const old = Date.now() - 600_000;
		writeLock(indexDir, { pid: DEAD_PID, lastProgressAt: old });

		const lock = lockAt(projectPath);
		lock.recordProgress(); // we don't own it => must not write

		expect(readLock(indexDir).pid).toBe(DEAD_PID);
		expect(readLock(indexDir).lastProgressAt).toBe(old);
	});
});

describe("isLockStale", () => {
	const STALE = 10_000; // DEFAULT_STALE_TIMEOUT
	const PROGRESS = 300_000; // DEFAULT_PROGRESS_TIMEOUT

	test("live pid + fresh progress => NOT stale", () => {
		const now = Date.now();
		const lock = {
			pid: process.pid,
			startTime: now,
			heartbeat: now,
			lastProgressAt: now,
			startedAt: new Date(now).toISOString(),
		};
		expect(isLockStale(lock, STALE, PROGRESS)).toBe(false);
	});

	// THE KEY NEW TEST: the hang signature — fresh heartbeat, stalled progress.
	test("live pid + fresh heartbeat + OLD lastProgressAt => STALE (the hang)", () => {
		const now = Date.now();
		const lock = {
			pid: process.pid, // alive
			startTime: now - 700_000,
			heartbeat: now, // timer kept stamping => looks alive
			lastProgressAt: now - 600_000, // no real work for 10 min
			startedAt: new Date(now - 700_000).toISOString(),
		};
		// Heartbeat alone (the old logic) would say NOT stale; progress says STALE.
		expect(isLockStale(lock, STALE, PROGRESS)).toBe(true);
	});

	test("dead pid => STALE regardless of timestamps", () => {
		const now = Date.now();
		const lock = {
			pid: DEAD_PID,
			startTime: now,
			heartbeat: now,
			lastProgressAt: now,
			startedAt: new Date(now).toISOString(),
		};
		expect(isLockStale(lock, STALE, PROGRESS)).toBe(true);
	});

	// BACKWARD COMPAT: an old-binary lock has heartbeat but no lastProgressAt.
	test("no lastProgressAt + fresh heartbeat => NOT stale (falls back to heartbeat)", () => {
		const now = Date.now();
		const lock = {
			pid: process.pid,
			startTime: now,
			heartbeat: now, // fresh
			startedAt: new Date(now).toISOString(),
		} as {
			pid: number;
			startTime: number;
			heartbeat: number;
			startedAt: string;
		};
		// Must NOT be treated as instantly stale just because lastProgressAt is missing.
		expect(isLockStale(lock, STALE, PROGRESS)).toBe(false);
	});

	test("no lastProgressAt + OLD heartbeat => STALE via heartbeat fallback", () => {
		const now = Date.now();
		const lock = {
			pid: process.pid,
			startTime: now - 700_000,
			heartbeat: now - 600_000, // old heartbeat, no progress field at all
			startedAt: new Date(now - 700_000).toISOString(),
		};
		expect(isLockStale(lock, STALE, PROGRESS)).toBe(true);
	});

	test("secondary heartbeat check still trips when progress is fresh but heartbeat is old", () => {
		const now = Date.now();
		const lock = {
			pid: process.pid,
			startTime: now,
			heartbeat: now - 20_000, // older than 10s stale window
			lastProgressAt: now, // progress fresh
			startedAt: new Date(now).toISOString(),
		};
		expect(isLockStale(lock, STALE, PROGRESS)).toBe(true);
	});
});

describe("acquire() auto-reclaim", () => {
	// END-TO-END: the actual mission. A hung-but-alive holder must be reclaimed.
	test("reclaims a lock held by a LIVE pid with stalled progress", async () => {
		const { projectPath, indexDir } = makeProject();
		// Forge a lock owned by THIS (alive) process, fresh heartbeat, but no
		// progress for 10 min — exactly the hung-indexer signature.
		const now = Date.now();
		writeLock(indexDir, {
			pid: process.pid,
			heartbeat: now,
			lastProgressAt: now - 600_000,
			startTime: now - 700_000,
		});

		const lock = lockAt(projectPath);
		// Use the default 5-min progress timeout. With waitTimeout:0, a non-stale
		// live lock would return { acquired:false, reason:"already_running" }.
		const result = await lock.acquire({ waitTimeout: 0 });

		try {
			// acquired:true is clean proof that reclaim fired (stale lock removed,
			// then reacquired by us).
			expect(result.acquired).toBe(true);
			// The lock file is now owned by us with a FRESH progress timestamp.
			const reclaimed = readLock(indexDir);
			expect(reclaimed.pid).toBe(process.pid);
			expect(reclaimed.lastProgressAt).toBeGreaterThanOrEqual(now - 1000);
		} finally {
			lock.release();
		}
	});

	test("does NOT reclaim a live, progressing holder (returns already_running)", async () => {
		const { projectPath, indexDir } = makeProject();
		// Live pid, fresh progress => genuinely indexing => must NOT be reclaimed.
		writeLock(indexDir, { pid: process.pid, lastProgressAt: Date.now() });

		const lock = lockAt(projectPath);
		const result = await lock.acquire({ waitTimeout: 0 });

		expect(result.acquired).toBe(false);
		expect(result.reason).toBe("already_running");
		expect(result.holderPid).toBe(process.pid);
		// Lock file untouched.
		expect(existsSync(join(indexDir, LOCK_FILENAME))).toBe(true);
	});
});

describe("isLocked()", () => {
	test("reports a hung holder as NOT locked (so callers don't block behind it)", () => {
		const { projectPath, indexDir } = makeProject();
		writeLock(indexDir, {
			pid: process.pid,
			heartbeat: Date.now(),
			lastProgressAt: Date.now() - 600_000,
		});
		const lock = lockAt(projectPath);
		expect(lock.isLocked().locked).toBe(false);
	});

	test("reports a live, progressing holder as locked", () => {
		const { projectPath, indexDir } = makeProject();
		writeLock(indexDir, { pid: process.pid, lastProgressAt: Date.now() });
		const lock = lockAt(projectPath);
		const status = lock.isLocked();
		expect(status.locked).toBe(true);
		expect(status.holderPid).toBe(process.pid);
	});
});

describe("setPhase", () => {
	test("sets phase + phaseStartedAt when this process owns the lock", async () => {
		const { projectPath, indexDir } = makeProject();
		const lock = lockAt(projectPath);
		const acquired = await lock.acquire();
		expect(acquired.acquired).toBe(true);

		try {
			// A freshly-acquired lock has no phase yet.
			expect(readLock(indexDir).phase).toBeUndefined();
			expect(readLock(indexDir).phaseStartedAt).toBeUndefined();

			const before = Date.now();
			lock.setPhase("writing:lance");

			const after = readLock(indexDir);
			expect(after.phase).toBe("writing:lance");
			expect(typeof after.phaseStartedAt).toBe("number");
			expect(after.phaseStartedAt as number).toBeGreaterThanOrEqual(before);
		} finally {
			lock.release();
		}
	});

	test("advancing the phase resets phaseStartedAt (sole writer)", async () => {
		const { projectPath, indexDir } = makeProject();
		const lock = lockAt(projectPath);
		await lock.acquire();

		try {
			lock.setPhase("embedding");
			const firstStartedAt = readLock(indexDir).phaseStartedAt as number;

			// Move the clock so the next phase timestamp is strictly greater.
			await new Promise((r) => setTimeout(r, 5));
			lock.setPhase("writing:lance");

			const second = readLock(indexDir);
			expect(second.phase).toBe("writing:lance");
			expect(second.phaseStartedAt as number).toBeGreaterThan(firstStartedAt);
		} finally {
			lock.release();
		}
	});

	test("does NOT advance lastProgressAt (phase is reporting, not the hung signal)", async () => {
		const { projectPath, indexDir } = makeProject();
		const lock = lockAt(projectPath);
		await lock.acquire();

		try {
			const progressBefore = readLock(indexDir).lastProgressAt as number;
			await new Promise((r) => setTimeout(r, 5));
			lock.setPhase("writing:lance");
			const progressAfter = readLock(indexDir).lastProgressAt as number;

			// setPhase must leave the progress marker untouched.
			expect(progressAfter).toBe(progressBefore);
		} finally {
			lock.release();
		}
	});

	test("recordProgress does NOT reset phaseStartedAt (only setPhase does)", async () => {
		const { projectPath, indexDir } = makeProject();
		const lock = lockAt(projectPath);
		await lock.acquire();

		try {
			lock.setPhase("writing:lance");
			const phaseStartedAt = readLock(indexDir).phaseStartedAt as number;

			await new Promise((r) => setTimeout(r, 5));
			lock.recordProgress();

			// recordProgress advances progress but leaves the phase timestamp alone,
			// so phaseStuckMs keeps growing honestly across completed units.
			const after = readLock(indexDir);
			expect(after.phaseStartedAt).toBe(phaseStartedAt);
			expect(after.phase).toBe("writing:lance");
		} finally {
			lock.release();
		}
	});

	test("is a no-op when another pid owns the lock (does not steal it)", () => {
		const { projectPath, indexDir } = makeProject();
		writeLock(indexDir, { pid: DEAD_PID, phase: "embedding" });

		const lock = lockAt(projectPath);
		lock.setPhase("writing:lance"); // we don't own it => must not write

		const raw = readLock(indexDir);
		expect(raw.pid).toBe(DEAD_PID);
		expect(raw.phase).toBe("embedding"); // unchanged
	});
});

describe("inspectLock phase fields", () => {
	test("exposes phase, phaseStartedAt, and derived phaseStuckMs", () => {
		const { indexDir } = makeProject();
		const startedAt = Date.now() - 6 * 60_000; // stuck 6 min in this phase
		writeLock(indexDir, {
			pid: process.pid,
			phase: "writing:lance",
			phaseStartedAt: startedAt,
		});

		const inspect = inspectLock(join(indexDir, LOCK_FILENAME));
		expect(inspect.present).toBe(true);
		if (inspect.present) {
			expect(inspect.phase).toBe("writing:lance");
			expect(inspect.phaseStartedAt).toBe(startedAt);
			// phaseStuckMs ≈ now - phaseStartedAt (~6 min); allow slack for test timing.
			expect(inspect.phaseStuckMs as number).toBeGreaterThanOrEqual(
				6 * 60_000 - 1000,
			);
		}
	});

	// BACKWARD COMPAT: a lock written by an older binary has no phase fields.
	test("backward compat: missing phase fields => undefined, no throw", () => {
		const { indexDir } = makeProject();
		// No phase / phaseStartedAt written (older binary).
		writeLock(indexDir, { pid: process.pid });

		const inspect = inspectLock(join(indexDir, LOCK_FILENAME));
		expect(inspect.present).toBe(true);
		if (inspect.present) {
			expect(inspect.phase).toBeUndefined();
			expect(inspect.phaseStartedAt).toBeUndefined();
			// No fallback for phaseStuckMs (unlike lastProgressAt) — undefined.
			expect(inspect.phaseStuckMs).toBeUndefined();
		}
	});
});
