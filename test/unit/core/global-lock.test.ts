/**
 * Unit tests for the MACHINE-GLOBAL single-indexer lock.
 *
 * The global lock reuses the SAME IndexLock machinery as the per-project lock
 * (heartbeat, lastProgressAt/recordProgress, setPhase, progress-based staleness,
 * inspectLock). What is new here is:
 *  - createGlobalIndexLock() points at a machine-global path (~/.mnemex/...),
 *    overridable via MNEMEX_GLOBAL_LOCK_PATH.
 *  - IndexLock takes an explicit absolute lock path, and the global lock uses
 *    that constructor directly (fromLockPath is gone now that it takes a path).
 *
 * These tests prove:
 *  - getGlobalLockPath honors the env override and defaults under the home dir.
 *  - acquire/release round-trips on the global lock.
 *  - a second try-acquire while held => not acquired (already_running).
 *  - a WEDGED global holder (stale lastProgressAt, fresh heartbeat) is RECLAIMED
 *    by the next acquire (mirrors the per-project reclaim test).
 *  - global + per-project locks are INDEPENDENT files, so holding one does not
 *    block the other — the basis for the deadlock-safe global-before-project order.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
	createGlobalIndexLock,
	createStoreLock,
	getGlobalLockPath,
	IndexLock,
} from "../../../src/core/lock.js";
import { resolveStoreLocation } from "../../../src/core/store-location.js";

const DEAD_PID = 2_000_000_000; // almost certainly not a live process
const tempDirs: string[] = [];
const savedEnv = process.env.MNEMEX_GLOBAL_LOCK_PATH;

/** Create an isolated temp dir and return the path to a global lock file inside it. */
function makeGlobalLockPath(): string {
	const dir = mkdtempSync(join(tmpdir(), "global-lock-test-"));
	tempDirs.push(dir);
	return join(dir, ".global-indexing.lock");
}

/** Read the raw global lock file JSON for assertions. */
function readLock(lockPath: string): {
	pid: number;
	startTime: number;
	heartbeat: number;
	lastProgressAt?: number;
	startedAt: string;
} {
	return JSON.parse(readFileSync(lockPath, "utf-8"));
}

beforeEach(() => {
	// Every test isolates the global lock to its own tmp file.
	process.env.MNEMEX_GLOBAL_LOCK_PATH = makeGlobalLockPath();
});

afterEach(() => {
	if (savedEnv === undefined) {
		delete process.env.MNEMEX_GLOBAL_LOCK_PATH;
	} else {
		process.env.MNEMEX_GLOBAL_LOCK_PATH = savedEnv;
	}
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

describe("getGlobalLockPath", () => {
	test("honors MNEMEX_GLOBAL_LOCK_PATH override", () => {
		const override = process.env.MNEMEX_GLOBAL_LOCK_PATH!;
		expect(getGlobalLockPath()).toBe(override);
	});

	test("defaults to ~/.mnemex/.global-indexing.lock when no override", () => {
		delete process.env.MNEMEX_GLOBAL_LOCK_PATH;
		expect(getGlobalLockPath()).toBe(
			join(homedir(), ".mnemex", ".global-indexing.lock"),
		);
	});

	test("treats an empty override as unset (falls back to default)", () => {
		process.env.MNEMEX_GLOBAL_LOCK_PATH = "";
		expect(getGlobalLockPath()).toBe(
			join(homedir(), ".mnemex", ".global-indexing.lock"),
		);
	});
});

describe("createGlobalIndexLock", () => {
	test("creates the parent directory if missing", async () => {
		// Point at a nested dir that does NOT exist yet.
		const nested = mkdtempSync(join(tmpdir(), "global-lock-nested-"));
		tempDirs.push(nested);
		const lockPath = join(nested, "deep", "sub", ".global-indexing.lock");
		process.env.MNEMEX_GLOBAL_LOCK_PATH = lockPath;

		const lock = createGlobalIndexLock();
		const result = await lock.acquire({ waitTimeout: 0 });
		try {
			expect(result.acquired).toBe(true);
			expect(existsSync(lockPath)).toBe(true);
		} finally {
			lock.release();
		}
	});

	test("acquire/release round-trips and writes to the global path", async () => {
		const lockPath = process.env.MNEMEX_GLOBAL_LOCK_PATH!;
		const lock = createGlobalIndexLock();

		const result = await lock.acquire({ waitTimeout: 0 });
		expect(result.acquired).toBe(true);
		// The lock file is written at the machine-global path (not any project dir).
		expect(existsSync(lockPath)).toBe(true);
		expect(readLock(lockPath).pid).toBe(process.pid);

		lock.release();
		// Release removes the file for the owning process.
		expect(existsSync(lockPath)).toBe(false);
	});

	test("recordProgress + setPhase work on the global lock", async () => {
		const lockPath = process.env.MNEMEX_GLOBAL_LOCK_PATH!;
		const lock = createGlobalIndexLock();
		await lock.acquire({ waitTimeout: 0 });
		try {
			const before = readLock(lockPath).lastProgressAt as number;
			await new Promise((r) => setTimeout(r, 5));
			lock.recordProgress();
			expect(readLock(lockPath).lastProgressAt as number).toBeGreaterThan(
				before,
			);

			lock.setPhase("writing:lance");
			expect((readLock(lockPath) as { phase?: string }).phase).toBe(
				"writing:lance",
			);
		} finally {
			lock.release();
		}
	});
});

describe("global lock: try-acquire-bail while held (--if-idle semantics)", () => {
	test("second try-acquire while held => already_running", async () => {
		const first = createGlobalIndexLock();
		const held = await first.acquire({ waitTimeout: 0 });
		expect(held.acquired).toBe(true);

		try {
			// A background reindexer would call this with waitTimeout:0 and bail.
			const second = createGlobalIndexLock();
			const result = await second.acquire({ waitTimeout: 0 });

			expect(result.acquired).toBe(false);
			expect(result.reason).toBe("already_running");
			expect(result.holderPid).toBe(process.pid);
		} finally {
			first.release();
		}
	});

	test("after the holder releases, a new try-acquire succeeds", async () => {
		const first = createGlobalIndexLock();
		await first.acquire({ waitTimeout: 0 });
		first.release();

		const second = createGlobalIndexLock();
		const result = await second.acquire({ waitTimeout: 0 });
		try {
			expect(result.acquired).toBe(true);
		} finally {
			second.release();
		}
	});
});

describe("global lock: wedged holder is auto-reclaimed", () => {
	// END-TO-END mirror of the per-project reclaim test, at the GLOBAL level: a
	// wedged global holder (fresh heartbeat, stalled progress) must be reclaimed by
	// the next acquire — this is the "reclaim + retry, never mark broken" recovery.
	test("reclaims a global lock held by a LIVE pid with stalled progress", async () => {
		const lockPath = process.env.MNEMEX_GLOBAL_LOCK_PATH!;
		const now = Date.now();
		// Forge a global lock owned by THIS (alive) process: heartbeat fresh, but no
		// forward progress for 10 min — exactly the LanceDB-wedge signature.
		writeFileSync(
			lockPath,
			JSON.stringify(
				{
					pid: process.pid,
					startTime: now - 700_000,
					heartbeat: now,
					lastProgressAt: now - 600_000,
					startedAt: new Date(now - 700_000).toISOString(),
				},
				null,
				2,
			),
		);

		const lock = createGlobalIndexLock();
		const result = await lock.acquire({ waitTimeout: 0 });
		try {
			// acquired:true proves the stale (wedged) lock was reclaimed then reacquired.
			expect(result.acquired).toBe(true);
			const reclaimed = readLock(lockPath);
			expect(reclaimed.pid).toBe(process.pid);
			expect(reclaimed.lastProgressAt as number).toBeGreaterThanOrEqual(
				now - 1000,
			);
		} finally {
			lock.release();
		}
	});

	test("does NOT reclaim a live, progressing global holder", async () => {
		const lockPath = process.env.MNEMEX_GLOBAL_LOCK_PATH!;
		writeFileSync(
			lockPath,
			JSON.stringify(
				{
					pid: process.pid,
					startTime: Date.now(),
					heartbeat: Date.now(),
					lastProgressAt: Date.now(),
					startedAt: new Date().toISOString(),
				},
				null,
				2,
			),
		);

		const lock = createGlobalIndexLock();
		const result = await lock.acquire({ waitTimeout: 0 });

		expect(result.acquired).toBe(false);
		expect(result.reason).toBe("already_running");
		// Lock file untouched.
		expect(existsSync(lockPath)).toBe(true);
	});
});

describe("IndexLock(lockPath) — the constructor the global lock uses", () => {
	test("builds a working lock from an explicit absolute path", async () => {
		const lockPath = makeGlobalLockPath();
		const lock = new IndexLock(lockPath);
		const result = await lock.acquire({ waitTimeout: 0 });
		try {
			expect(result.acquired).toBe(true);
			expect(existsSync(lockPath)).toBe(true);
		} finally {
			lock.release();
		}
	});

	test("the store lock still resolves under the project's index dir", async () => {
		// While the store scope is per-worktree, the store lock derived from the
		// resolved location lands under the project's own index dir.
		const projectPath = mkdtempSync(join(tmpdir(), "global-lock-proj-"));
		tempDirs.push(projectPath);
		mkdirSync(join(projectPath, ".mnemex"), { recursive: true });
		const lock = createStoreLock(resolveStoreLocation(projectPath));
		const result = await lock.acquire({ waitTimeout: 0 });
		try {
			expect(result.acquired).toBe(true);
			expect(existsSync(join(projectPath, ".mnemex", ".indexing.lock"))).toBe(
				true,
			);
		} finally {
			lock.release();
		}
	});
});

describe("deadlock-safety: global + per-project locks are independent", () => {
	// The indexer ALWAYS acquires global-before-project and releases
	// project-before-global. The correctness precondition tested here is that the
	// two locks are SEPARATE files that do not interfere: holding the global lock
	// must not block acquiring the (different) per-project lock, and vice versa.
	test("holding the global lock does not block the per-project lock", async () => {
		const projectPath = mkdtempSync(join(tmpdir(), "global-lock-order-"));
		tempDirs.push(projectPath);
		mkdirSync(join(projectPath, ".mnemex"), { recursive: true });

		const globalLock = createGlobalIndexLock();
		const projectLock = createStoreLock(resolveStoreLocation(projectPath));

		// Acquire in the SAME order the indexer uses: global first, then project.
		const g = await globalLock.acquire({ waitTimeout: 0 });
		const p = await projectLock.acquire({ waitTimeout: 0 });

		try {
			expect(g.acquired).toBe(true);
			// The per-project acquire succeeds even though the global lock is held —
			// they are distinct files, so there is no cross-blocking / deadlock.
			expect(p.acquired).toBe(true);

			// Distinct lock files.
			expect(getGlobalLockPath()).not.toBe(
				join(projectPath, ".mnemex", ".indexing.lock"),
			);
			expect(existsSync(getGlobalLockPath())).toBe(true);
			expect(existsSync(join(projectPath, ".mnemex", ".indexing.lock"))).toBe(
				true,
			);
		} finally {
			// Release in REVERSE order (project first, then global) — the indexer's
			// finally-block order.
			projectLock.release();
			globalLock.release();
		}

		// Both files removed after reverse release.
		expect(existsSync(join(projectPath, ".mnemex", ".indexing.lock"))).toBe(
			false,
		);
		expect(existsSync(getGlobalLockPath())).toBe(false);
	});
});
