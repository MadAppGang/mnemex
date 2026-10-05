/**
 * Unit tests for inspectLock — the read-only lock inspector.
 *
 * Proves: parsing (present/absent/corrupt/partial), liveness probe, and most
 * importantly that inspection NEVER mutates or removes the lock file (R5).
 *
 * Black-box: written against the public inspectLock contract only.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectLock } from "../../../src/core/lock.js";

const LOCK_FILENAME = ".indexing.lock";
const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "inspect-lock-test-"));
	tempDirs.push(dir);
	return dir;
}

/**
 * Write a lock file with the canonical
 * { pid, startTime, heartbeat, lastProgressAt, startedAt } shape. Pass
 * `omitLastProgressAt: true` to simulate a lock written by an OLDER binary.
 */
function writeLock(
	indexDir: string,
	overrides: Partial<{
		pid: number;
		startTime: number;
		heartbeat: number;
		lastProgressAt: number;
		startedAt: string;
		omitLastProgressAt: boolean;
	}> = {},
): string {
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
	const lockPath = join(indexDir, LOCK_FILENAME);
	writeFileSync(lockPath, JSON.stringify(data, null, 2));
	return lockPath;
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

describe("inspectLock", () => {
	// R1: no lock file => { present: false }
	test("R1: returns { present: false } when no lock file exists", () => {
		const dir = makeTempDir();
		const result = inspectLock(join(dir, LOCK_FILENAME));
		expect(result.present).toBe(false);
	});

	// R2: corrupt/partial JSON => { present: false }
	test("R2: returns { present: false } for corrupt JSON", () => {
		const dir = makeTempDir();
		writeFileSync(join(dir, LOCK_FILENAME), "{ this is not json");
		const result = inspectLock(join(dir, LOCK_FILENAME));
		expect(result.present).toBe(false);
	});

	// R2b: valid JSON missing required heartbeat field => { present: false } (A3)
	test("R2b: returns { present: false } for valid JSON missing heartbeat", () => {
		const dir = makeTempDir();
		writeFileSync(
			join(dir, LOCK_FILENAME),
			JSON.stringify({ pid: process.pid, startTime: Date.now() }),
		);
		const result = inspectLock(join(dir, LOCK_FILENAME));
		expect(result.present).toBe(false);
	});

	// R2c: empty object {} => { present: false } (A3 — no process.kill(undefined,0))
	test("R2c: returns { present: false } for empty object {}", () => {
		const dir = makeTempDir();
		writeFileSync(join(dir, LOCK_FILENAME), "{}");
		const result = inspectLock(join(dir, LOCK_FILENAME));
		expect(result.present).toBe(false);
	});

	// R3: valid lock with live pid + fresh heartbeat
	test("R3: live pid + fresh heartbeat => present, pidAlive, fresh, elapsed>=0", () => {
		const dir = makeTempDir();
		writeLock(dir, { pid: process.pid });
		const result = inspectLock(join(dir, LOCK_FILENAME));
		expect(result.present).toBe(true);
		if (result.present) {
			expect(result.pidAlive).toBe(true);
			expect(result.isHeartbeatFresh).toBe(true);
			expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
			expect(result.pid).toBe(process.pid);
		}
	});

	// R4: valid lock with dead pid
	test("R4: dead pid => pidAlive false", () => {
		const dir = makeTempDir();
		writeLock(dir, { pid: 2_000_000_000 });
		const result = inspectLock(join(dir, LOCK_FILENAME));
		expect(result.present).toBe(true);
		if (result.present) {
			expect(result.pidAlive).toBe(false);
		}
	});

	// R4b: old heartbeat => isHeartbeatFresh false (informational, independent of liveness)
	test("R4b: old heartbeat => isHeartbeatFresh false even with live pid", () => {
		const dir = makeTempDir();
		writeLock(dir, {
			pid: process.pid,
			heartbeat: Date.now() - 60_000, // 60s old
		});
		const result = inspectLock(join(dir, LOCK_FILENAME), 30_000);
		expect(result.present).toBe(true);
		if (result.present) {
			expect(result.pidAlive).toBe(true);
			expect(result.isHeartbeatFresh).toBe(false);
		}
	});

	// R7: exposes lastProgressAt + isProgressing for a fresh, progressing lock
	test("R7: exposes lastProgressAt + isProgressing=true for fresh progress", () => {
		const dir = makeTempDir();
		writeLock(dir, { pid: process.pid });
		const result = inspectLock(join(dir, LOCK_FILENAME));
		expect(result.present).toBe(true);
		if (result.present) {
			expect(typeof result.lastProgressAt).toBe("number");
			expect(result.lastProgressAt).toBeGreaterThan(0);
			expect(result.isProgressing).toBe(true);
		}
	});

	// R7b: stalled progress (fresh heartbeat) => isProgressing=false (the hang signal)
	test("R7b: old lastProgressAt + fresh heartbeat => isProgressing false", () => {
		const dir = makeTempDir();
		writeLock(dir, {
			pid: process.pid,
			heartbeat: Date.now(), // timer still stamping (looks alive)
			lastProgressAt: Date.now() - 600_000, // no real work for 10 min
		});
		const result = inspectLock(join(dir, LOCK_FILENAME), 30_000, 300_000);
		expect(result.present).toBe(true);
		if (result.present) {
			expect(result.pidAlive).toBe(true);
			expect(result.isHeartbeatFresh).toBe(true); // heartbeat masks the hang
			expect(result.isProgressing).toBe(false); // progress reveals it
		}
	});

	// R7c: backward compat — old-binary lock (no lastProgressAt) falls back to heartbeat
	test("R7c: missing lastProgressAt falls back to heartbeat (not Invalid Date / NaN)", () => {
		const dir = makeTempDir();
		const now = Date.now();
		writeLock(dir, {
			pid: process.pid,
			heartbeat: now,
			omitLastProgressAt: true,
		});
		const result = inspectLock(join(dir, LOCK_FILENAME));
		expect(result.present).toBe(true);
		if (result.present) {
			// lastProgressAt mirrors heartbeat, so it is a usable timestamp.
			expect(result.lastProgressAt).toBe(now);
			// Fresh heartbeat => treated as progressing (not instantly hung).
			expect(result.isProgressing).toBe(true);
			// ISO conversion of the fallback value must be valid (no Invalid Date).
			expect(new Date(result.lastProgressAt).toISOString()).not.toContain(
				"Invalid",
			);
		}
	});

	// R5: read-only proof — lock file STILL present after inspect
	test("R5: inspecting does NOT remove the lock file (read-only)", () => {
		const dir = makeTempDir();
		const lockPath = writeLock(dir, { pid: 2_000_000_000 }); // dead pid (stale-looking)
		expect(existsSync(lockPath)).toBe(true);
		inspectLock(join(dir, LOCK_FILENAME));
		// A naive cleanup would unlink a stale lock; inspectLock must not.
		expect(existsSync(lockPath)).toBe(true);
		// Inspect again to be sure repeated reads are non-destructive.
		inspectLock(join(dir, LOCK_FILENAME));
		expect(existsSync(lockPath)).toBe(true);
	});

	// R6: custom index dir (simulating MNEMEX_INDEX_DIR) — inspectLock reads the
	// exact lock path it is given (the caller derives it from the resolved store
	// location), with no double-join and no basename assumption.
	test("R6: resolves lock under a custom (non-.mnemex) index dir", () => {
		const dir = makeTempDir();
		const customIndexDir = join(dir, "custom-index-dir");
		require("node:fs").mkdirSync(customIndexDir, { recursive: true });
		writeLock(customIndexDir, { pid: process.pid });
		const result = inspectLock(join(customIndexDir, LOCK_FILENAME));
		expect(result.present).toBe(true);
		if (result.present) {
			expect(result.pid).toBe(process.pid);
		}
		// And the SAME basename under a different parent must NOT be found.
		const empty = inspectLock(join(dir, LOCK_FILENAME));
		expect(empty.present).toBe(false);
	});
});
