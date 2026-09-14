/**
 * Index Lock Manager
 *
 * One lock file serialises every writer of an index store, and stale locks left
 * by dead or hung processes are reclaimed so a crash never wedges the next run.
 *
 * WHERE THE FILE LIVES. `IndexLock` takes the lock-file PATH and nothing else.
 * The store lock's path comes from the store-location seam: `createStoreLock(loc)`
 * uses `getLockPathFor(loc)`, which is `<storeDir>/.indexing.lock`. So the lock
 * follows the data it guards, and two worktrees that resolve to one store contend
 * on one file. The path used to be rebuilt from `projectPath`, so two worktrees
 * took two files and both proceeded. The filename is declared ONCE, in
 * `store-location.ts`, and this module does not repeat it.
 *
 * HOW IT IS TAKEN. Atomically. `open(path, "wx")` (O_CREAT|O_EXCL) either creates
 * the file or fails with EEXIST, so exactly one contender wins. The old sequence
 * (read absent, write, read back to verify) let two processes each verify their
 * own write and both proceed.
 *
 * WHO MAY REMOVE IT. Every lock file carries an ownership token (`randomUUID()`).
 * `release()` and the stale-reclaim path remove a lock only after proving it is
 * the one they mean: they move it aside first and compare second. This is the
 * same three-layer shape as the credential lock (CLAUDE.md #25a). A holder whose
 * lock was reclaimed as stale therefore cannot unlink the new owner's file.
 *
 * HOW THE HOLDER UPDATES IT. Through the descriptor it created the file with,
 * never through the path. If the lock was reclaimed, the holder's heartbeat
 * lands in the detached inode, which nobody reads, instead of overwriting the
 * new owner's file.
 */

import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	fstatSync,
	linkSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getLockPathFor, type StoreLocation } from "./store-location.js";

/** Lock file data structure */
interface LockData {
	/** Process ID that holds the lock */
	pid: number;
	/** Timestamp when lock was acquired */
	startTime: number;
	/**
	 * Last heartbeat timestamp (updated periodically by a 1s timer).
	 * Means "the process is alive" — it advances even when indexing is hung,
	 * so it is NOT a reliable progress signal. See `lastProgressAt`.
	 */
	heartbeat: number;
	/**
	 * Last forward-progress timestamp. Advances ONLY when a genuine unit of
	 * indexing work completes (embed batch, addChunks, addCodeUnits), NEVER on
	 * a timer. A hung-but-alive indexer keeps stamping `heartbeat` but stops
	 * advancing this, which is how `isLockStale` detects the LanceDB write hang
	 * and reclaims the lock. Optional for backward compat: locks written by an
	 * older binary lack this field; readers fall back to `heartbeat`.
	 */
	lastProgressAt?: number;
	/**
	 * Short, stable label for WHAT the holder is currently doing
	 * (e.g. "discovering", "embedding", "writing:lance", "enriching",
	 * "finalizing"). Honest reporting only — it does NOT participate in the
	 * stale/hung DECISION (which is driven solely by `lastProgressAt`); it just
	 * lets the report SAY which phase a hung holder is wedged in. Set ONLY by
	 * `setPhase`. Optional for backward compat: locks written by an older binary
	 * lack this field; readers treat its absence as "unknown phase" (undefined).
	 */
	phase?: string;
	/**
	 * Epoch ms when the current `phase` began. Advanced ONLY by `setPhase` — NOT
	 * by the 1s heartbeat timer and NOT by `recordProgress`, so `now - phaseStartedAt`
	 * is an honest "stuck in this phase for N ms" measure. Optional for backward
	 * compat (absent on older locks => undefined, never an error).
	 */
	phaseStartedAt?: number;
	/** Human-readable start time for debugging */
	startedAt: string;
	/**
	 * Ownership token, a `randomUUID()` written by `acquire()`. It is the only
	 * thing that proves a lock file belongs to one particular holder: a pid can be
	 * reused, and two locks taken by one process in the same millisecond share a
	 * `startTime`. Optional for backward compat: a lock written by an older
	 * binary has none, and is identified by (pid, startTime) instead.
	 */
	token?: string;
}

/** Lock acquisition result */
export interface LockResult {
	/** Whether we acquired the lock */
	acquired: boolean;
	/** If not acquired, reason why */
	reason?: "already_running" | "timeout" | "error";
	/** If already running, PID of the holder */
	holderPid?: number;
	/** If already running, how long it's been running (ms) */
	runningFor?: number;
	/** When `reason` is "error": what failed, for the message shown to the user. */
	errorMessage?: string;
}

/** Options for lock acquisition */
export interface LockOptions {
	/** Maximum time to wait for existing lock (ms). Default: 0 (don't wait) */
	waitTimeout?: number;
	/** Interval to check if lock is released (ms). Default: 1000 */
	pollInterval?: number;
	/** Time after which a lock with a stale heartbeat is considered stale (ms). Default: 10000 */
	staleTimeout?: number;
	/**
	 * Time after which a lock that has made no forward progress is considered
	 * hung/stale and is reclaimed, even if its heartbeat is fresh and its pid is
	 * alive (ms). Default: DEFAULT_PROGRESS_TIMEOUT (300000 / 5 min).
	 */
	progressTimeout?: number;
	/** Callback when waiting for another process */
	onWaiting?: (holderPid: number, waitedMs: number) => void;
}

const DEFAULT_STALE_TIMEOUT = 10000; // 10 seconds without heartbeat = stale
/**
 * Generous window (ms) after which a lock that has made no forward progress is
 * treated as hung and reclaimed — even if the heartbeat is fresh and the pid is
 * alive. Deliberately MUCH larger than DEFAULT_STALE_TIMEOUT: indexing a large
 * repo (embed a batch + LanceDB write) can legitimately take minutes, so this is
 * the upper bound on "one unit of work" before we call the holder hung.
 */
export const DEFAULT_PROGRESS_TIMEOUT = 300000; // 5 minutes without progress = hung
const DEFAULT_POLL_INTERVAL = 1000; // Check every second
const HEARTBEAT_INTERVAL = 1000; // Update heartbeat every 1 second

/**
 * A lock file that exists but does not parse is either mid-write (the creator
 * has opened it and not yet written its record) or crash residue. It is re-read
 * this many times, this far apart, before it is judged, so a torn read is not
 * reported as a holder with no pid.
 */
const SETTLE_RETRIES = 3;
const SETTLE_DELAY_MS = 20;

/**
 * When another process is reclaiming the same stale lock, back off this long and
 * try again, at most this many times, before treating the lock as held.
 */
const RECLAIM_RETRY_DELAY_MS = 25;
const MAX_CONTESTED_RECLAIMS = 20;

/**
 * `open(wx)` said EEXIST and then the file was gone when read: the holder
 * released in between. That is normal, but a file that is always gone when read
 * and always present when created is not, so the loop is bounded.
 */
const MAX_VANISHED_RETRIES = 100;

/**
 * Check if a process is still running (cross-platform: Windows, Linux, macOS)
 */
function isProcessRunning(pid: number): boolean {
	try {
		// process.kill with signal 0 checks if process exists
		// Works on Windows, Linux, and macOS in Node.js
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// ESRCH = No such process (Linux/macOS)
		// EPERM = Permission denied (process exists but we can't signal it)
		// On Windows: ESRCH-like error when process doesn't exist
		const err = error as NodeJS.ErrnoException;
		if (err.code === "EPERM") {
			// Process exists but we don't have permission - it's running
			return true;
		}
		return false;
	}
}

/**
 * Parse a lock record. `null` for anything that is not a complete record,
 * including well-formed JSON missing the numeric fields (`{}`), which would
 * otherwise reach `process.kill(undefined, 0)`. Trailing whitespace is legal:
 * a holder pads a shrinking record rather than truncating (see `encodeRecord`).
 */
function parseLockData(text: string): LockData | null {
	try {
		const parsed = JSON.parse(text) as Partial<LockData> | null;
		if (
			parsed === null ||
			typeof parsed !== "object" ||
			typeof parsed.pid !== "number" ||
			typeof parsed.startTime !== "number" ||
			typeof parsed.heartbeat !== "number"
		) {
			return null;
		}
		return parsed as LockData;
	} catch {
		return null;
	}
}

/**
 * Read lock file data
 */
function readLockFile(lockPath: string): LockData | null {
	try {
		if (!existsSync(lockPath)) {
			return null;
		}
		return parseLockData(readFileSync(lockPath, "utf-8"));
	} catch {
		return null;
	}
}

/**
 * The record a holder writes, padded with spaces to at least `minBytes`.
 *
 * Padding instead of truncating is what lets the holder rewrite in place with
 * ONE positional write: a shorter record never leaves the tail of a longer one
 * behind, and there is no truncate-then-write window in which a reader sees an
 * empty file.
 */
function encodeRecord(data: LockData, minBytes: number): Buffer {
	const json = Buffer.from(JSON.stringify(data, null, 2), "utf8");
	if (json.length >= minBytes) return json;
	return Buffer.concat([json, Buffer.alloc(minBytes - json.length, 0x20)]);
}

/** What a lock file says and which inode says it: enough to name one lock exactly. */
interface LockObservation {
	/**
	 * Identity: `t:<token>`; `p:<pid>:<startTime>` for a lock written before
	 * tokens existed; `i:<inode>:<mtime>` for a file that does not parse.
	 */
	key: string;
	/** Parsed contents, or null when the file is empty, partial or corrupt. */
	data: LockData | null;
	mtimeMs: number;
}

function identityKey(
	data: LockData | null,
	ino: number,
	mtimeMs: number,
): string {
	if (data === null) return `i:${ino}:${Math.trunc(mtimeMs)}`;
	if (typeof data.token === "string" && data.token.length > 0) {
		return `t:${data.token}`;
	}
	return `p:${data.pid}:${data.startTime}`;
}

/** `null` when there is nothing at `path`. */
function observeLockAt(path: string): LockObservation | null {
	let text: string;
	let ino: number;
	let mtimeMs: number;
	try {
		const st = statSync(path);
		ino = st.ino;
		mtimeMs = st.mtimeMs;
		text = readFileSync(path, "utf8");
	} catch {
		return null;
	}
	const data = parseLockData(text);
	return { key: identityKey(data, ino, mtimeMs), data, mtimeMs };
}

/** Re-read a lock that does not parse, so a creator mid-write is not misjudged. */
async function observeSettled(path: string): Promise<LockObservation | null> {
	let observed = observeLockAt(path);
	for (
		let attempt = 0;
		attempt < SETTLE_RETRIES && observed !== null && observed.data === null;
		attempt++
	) {
		await new Promise((resolve) => setTimeout(resolve, SETTLE_DELAY_MS));
		observed = observeLockAt(path);
	}
	return observed;
}

/**
 * Whether a lock may be taken over. A parseable lock follows `isLockStale`. A
 * lock that does not parse is given `staleTimeout` of mtime age to finish being
 * written. Past that, it is residue from a process that died between creating
 * the file and writing its record.
 */
function isReclaimable(
	observed: LockObservation,
	staleTimeout: number,
	progressTimeout: number,
): boolean {
	if (observed.data !== null) {
		return isLockStale(observed.data, staleTimeout, progressTimeout);
	}
	return Date.now() - observed.mtimeMs > staleTimeout;
}

/**
 * Move the lock aside under a unique name, in one atomic `rename`, and say what
 * was moved. Whatever this returns was removed from the well-known name by us
 * alone, so comparing it cannot race with anyone.
 */
function detachLockFile(
	lockPath: string,
): { path: string; key: string } | null {
	const path = `${lockPath}.detached-${randomUUID()}`;
	try {
		renameSync(lockPath, path);
	} catch {
		return null;
	}
	return { path, key: observeLockAt(path)?.key ?? "" };
}

/**
 * Put back a lock we detached but were not entitled to remove.
 *
 * `link` rather than `rename`: it FAILS if the name is occupied instead of
 * overwriting, so restoring can never clobber a third process's lock.
 */
function restoreDetachedLock(lockPath: string, detachedPath: string): boolean {
	try {
		linkSync(detachedPath, lockPath);
	} catch {
		return false;
	}
	try {
		unlinkSync(detachedPath);
	} catch {}
	return true;
}

/** FNV-1a, for a short path-safe name derived from a lock identity. */
function shortHash(value: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < value.length; i++) {
		h ^= value.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(16).padStart(8, "0");
}

/** Outcome of trying to take over a lock judged stale. */
type Reclaim = "reclaimed" | "retry" | "ambiguous";

/**
 * Take over the lock identified by `observed`, or do nothing.
 *
 * THREE LAYERS, as for the credential lock (CLAUDE.md #25a, `src/config.ts`):
 *
 *  1. ELECTION. Only the process that wins `open(claim, "wx")` may touch the
 *     lock at all. The claim is named after the lock's identity, so every process
 *     that judged the same stale lock competes for the same claim. Without this,
 *     C and D both judge one lock stale; C removes it and takes a fresh one; D
 *     then removes C's LIVE lock.
 *  2. RE-VERIFICATION. The winner re-reads the lock while holding the right, so
 *     a takeover that completed since the judgement is seen.
 *  3. DETACH AND COMPARE. `rename` moves one specific inode out of the name in
 *     one step, and only then is its identity compared. If it was not ours to
 *     remove it is put back, and if that fails the outcome is "ambiguous" and
 *     the caller refuses rather than become a second holder.
 *
 * A process that dies holding the claim leaves a file named after a lock that is
 * itself stale. The next pass drops it once it is older than `staleTimeout`.
 */
function reclaimStaleLock(
	lockPath: string,
	observed: LockObservation,
	staleTimeout: number,
	stillReclaimable: (current: LockObservation) => boolean,
): Reclaim {
	const claim = `${lockPath}.reclaim-${shortHash(observed.key)}`;
	let claimFd: number;
	try {
		claimFd = openSync(claim, "wx");
	} catch {
		try {
			if (Date.now() - statSync(claim).mtimeMs > staleTimeout) {
				unlinkSync(claim);
			}
		} catch {}
		return "retry";
	}

	try {
		try {
			writeSync(claimFd, String(process.pid));
		} catch {}
		try {
			closeSync(claimFd);
		} catch {}

		// LAYER 2 — is the thing we judged still the thing that is there?
		const current = observeLockAt(lockPath);
		if (
			current === null ||
			current.key !== observed.key ||
			!stillReclaimable(current)
		) {
			return "retry";
		}

		// LAYER 3 — swap first, compare second.
		const detached = detachLockFile(lockPath);
		if (detached === null) return "retry";
		if (detached.key === observed.key) {
			try {
				unlinkSync(detached.path);
			} catch {}
			return "reclaimed";
		}
		return restoreDetachedLock(lockPath, detached.path) ? "retry" : "ambiguous";
	} finally {
		try {
			unlinkSync(claim);
		} catch {}
	}
}

/**
 * Check if a lock is stale, i.e. safe to reclaim. A lock is stale when ANY of:
 *  1. The holder process is dead.
 *  2. (PRIMARY hang signal) It has made no forward progress within
 *     `progressTimeout`. This catches a hung-but-alive indexer (e.g. wedged in a
 *     LanceDB write): its 1s heartbeat keeps stamping, but `lastProgressAt` —
 *     advanced only by real indexing work — stops, so the lock goes stale and is
 *     reclaimed by the next `acquire()`.
 *  3. (SECONDARY, legacy) Its heartbeat is older than `staleTimeout`.
 *
 * Backward compat: locks written by an older binary lack `lastProgressAt`. For
 * the progress check we fall back to `heartbeat` (via `?? heartbeat`) so a
 * pre-upgrade lock is NOT treated as instantly hung.
 */
export function isLockStale(
	lock: LockData,
	staleTimeout: number,
	progressTimeout: number = DEFAULT_PROGRESS_TIMEOUT,
): boolean {
	// Check if process is dead
	if (!isProcessRunning(lock.pid)) {
		return true;
	}

	const now = Date.now();

	// PRIMARY: no forward progress within progressTimeout => hung.
	// `?? heartbeat` keeps pre-upgrade locks (no lastProgressAt) from reading as
	// `now - undefined === NaN` (which would never trip) — they fall back to the
	// heartbeat timestamp instead.
	const progressMarker = lock.lastProgressAt ?? lock.heartbeat;
	if (now - progressMarker > progressTimeout) {
		return true;
	}

	// SECONDARY (legacy): heartbeat is too old.
	if (now - lock.heartbeat > staleTimeout) {
		return true;
	}

	return false;
}

// ============================================================================
// Read-only inspection
// ============================================================================

/**
 * Full read-only snapshot of the index lock. Does NOT mutate or remove the lock.
 *
 * Modeled as a discriminated union on `present` so callers can narrow once
 * (`if (!inspect.present) ... else { use fields }`) and access the holder fields
 * without `number | undefined` noise.
 */
export type LockInspection =
	| { present: false }
	| {
			/** A parseable, complete lock file is present. */
			present: true;
			/** Holder PID from the lock file. */
			pid: number;
			/** Human-readable start time string from the lock. */
			startedAt: string;
			/** Lock acquisition epoch ms. */
			startTime: number;
			/** Last heartbeat epoch ms. */
			heartbeat: number;
			/**
			 * Last forward-progress epoch ms. Falls back to `heartbeat` when the
			 * lock was written by an older binary (no `lastProgressAt` field), so
			 * the value is always a usable timestamp (never undefined / NaN-prone).
			 */
			lastProgressAt: number;
			/** ms since startTime (Date.now() - startTime). */
			elapsedMs: number;
			/** Whether the holder PID is alive (process.kill(pid, 0) liveness probe). */
			pidAlive: boolean;
			/** Whether the heartbeat is within staleTimeout of now. Informational only. */
			isHeartbeatFresh: boolean;
			/**
			 * Whether forward progress is within progressTimeout of now. A live pid
			 * with `isProgressing === false` is the hung-indexer signal. Read-only
			 * mirror of `isLockStale`'s progress check (same `?? heartbeat` fallback).
			 */
			isProgressing: boolean;
			/**
			 * Short label of what the holder was last doing (set by setPhase), or
			 * `undefined` for locks written by an older binary (NO fallback — unlike
			 * lastProgressAt, an unknown phase is reported as unknown, not coerced).
			 */
			phase?: string;
			/** Epoch ms the current phase began (setPhase), or undefined if absent. */
			phaseStartedAt?: number;
			/**
			 * Derived `now - phaseStartedAt` (ms stuck in the current phase). Present
			 * ONLY when `phaseStartedAt` is present; undefined otherwise (no fallback).
			 */
			phaseStuckMs?: number;
	  };

/**
 * Inspect the index lock WITHOUT mutating or removing it (distinct from acquire(),
 * whose stale-lock cleanup is intentionally left unchanged). Strictly read-only:
 * no unlink, no write, and only a `process.kill(pid, 0)` liveness probe — never a
 * real signal.
 *
 * @param lockPath      ABSOLUTE path to the lock file. For the store lock that is
 *                      `getLockPathFor(loc)`: the caller derives it from the
 *                      resolved store location, exactly as `createStoreLock` does,
 *                      so the inspector reads the file the holder writes.
 * @param staleTimeout  Window (ms) for the informational isHeartbeatFresh flag.
 *                      Default DEFAULT_STALE_TIMEOUT (10000); the sole caller
 *                      (index-state.ts) passes HEARTBEAT_FRESH_TIMEOUT (30000).
 * @param progressTimeout Window (ms) for the isProgressing flag. Default
 *                      DEFAULT_PROGRESS_TIMEOUT (300000 / 5 min) — matches the
 *                      hang window used by acquire()'s reclaim path.
 */
export function inspectLock(
	lockPath: string,
	staleTimeout: number = DEFAULT_STALE_TIMEOUT,
	progressTimeout: number = DEFAULT_PROGRESS_TIMEOUT,
): LockInspection {
	// readLockFile returns null for an absent file, corrupt/partial JSON, and
	// well-formed JSON missing the required numeric fields (e.g. `{}`), so the
	// classification decision tree is total.
	const lock = readLockFile(lockPath);
	if (!lock) {
		return { present: false };
	}

	const now = Date.now();
	// Same `?? heartbeat` fallback as isLockStale: a pre-upgrade lock without
	// lastProgressAt reads its heartbeat instead of NaN.
	const lastProgressAt = lock.lastProgressAt ?? lock.heartbeat;
	// Phase fields are reported as-is with NO fallback: a lock written by an older
	// binary (or before the first setPhase) simply has no phase. phaseStuckMs is
	// derived only when phaseStartedAt is present.
	const phaseStartedAt =
		typeof lock.phaseStartedAt === "number" ? lock.phaseStartedAt : undefined;
	return {
		present: true,
		pid: lock.pid,
		startedAt: lock.startedAt,
		startTime: lock.startTime,
		heartbeat: lock.heartbeat,
		lastProgressAt,
		elapsedMs: now - lock.startTime,
		pidAlive: isProcessRunning(lock.pid),
		isHeartbeatFresh: now - lock.heartbeat <= staleTimeout,
		isProgressing: now - lastProgressAt <= progressTimeout,
		phase: typeof lock.phase === "string" ? lock.phase : undefined,
		phaseStartedAt,
		phaseStuckMs:
			phaseStartedAt !== undefined ? now - phaseStartedAt : undefined,
	};
}

// ============================================================================
// IIndexLock Interface
// ============================================================================

/**
 * Interface for index lock implementations.
 * Allows swapping in alternative lock backends.
 */
export interface IIndexLock {
	acquire(options?: LockOptions): Promise<LockResult>;
	release(): void;
	/**
	 * Stamp forward progress on the lock. Call AFTER each genuine unit of
	 * indexing work completes (embed batch / addChunks / addCodeUnits). Advances
	 * `lastProgressAt`, which is the signal `isLockStale` uses to detect a hung
	 * holder. No-op unless this instance holds the lock.
	 */
	recordProgress(): void;
	/**
	 * Record WHICH phase the holder has entered (e.g. "writing:lance"). Updates
	 * `phase` and resets `phaseStartedAt` to now. Honest-reporting only: it does
	 * NOT advance `lastProgressAt`, so it does NOT affect the hung DECISION — it
	 * only lets the report attribute a hang to a phase. No-op unless this
	 * instance holds the lock.
	 */
	setPhase(phase: string): void;
	isLocked(
		staleTimeout?: number,
		progressTimeout?: number,
	): {
		locked: boolean;
		holderPid?: number;
		runningFor?: number;
	};
	forceRelease(): boolean;
}

/** What a holder keeps: the descriptor it created the file with, and its record. */
interface HeldLock {
	fd: number;
	/** The inode `fd` refers to, so `release()` can tell whether the name is still ours. */
	ino: number;
	data: LockData;
	/** Bytes currently in the file; a rewrite pads to at least this. */
	size: number;
}

type CreateAttempt =
	| { kind: "created"; held: HeldLock }
	| { kind: "exists" }
	| { kind: "error"; message: string };

function errorMessageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Index Lock Manager
 *
 * Usage:
 * ```typescript
 * const lock = createStoreLock(resolveStoreLocation(projectPath));
 *
 * const result = await lock.acquire({ waitTimeout: 30000 });
 * if (!result.acquired) {
 *   console.log(`Another process (PID ${result.holderPid}) is indexing`);
 *   return;
 * }
 *
 * try {
 *   // Do indexing work...
 * } finally {
 *   lock.release();
 * }
 * ```
 */
export class IndexLock implements IIndexLock {
	private readonly lockPath: string;
	private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
	/** Non-null exactly while this instance holds the lock. */
	private held: HeldLock | null = null;

	/**
	 * @param lockPath ABSOLUTE path of the lock file. For the store lock use
	 *                 `createStoreLock(loc)`, which derives it from the resolved
	 *                 store location; do not rebuild it from a project path.
	 */
	constructor(lockPath: string) {
		this.lockPath = lockPath;
	}

	/** The lock file this instance takes. */
	get path(): string {
		return this.lockPath;
	}

	/** The token in the file while this instance holds it; `null` otherwise. */
	get ownershipToken(): string | null {
		return this.held?.data.token ?? null;
	}

	/**
	 * Try to acquire the lock
	 *
	 * @param options Lock options
	 * @returns Result indicating if lock was acquired
	 */
	async acquire(options: LockOptions = {}): Promise<LockResult> {
		const {
			waitTimeout = 0,
			pollInterval = DEFAULT_POLL_INTERVAL,
			staleTimeout = DEFAULT_STALE_TIMEOUT,
			progressTimeout = DEFAULT_PROGRESS_TIMEOUT,
			onWaiting,
		} = options;

		if (this.held !== null) {
			// O_EXCL against our own file would say "held", which is true.
			return {
				acquired: false,
				reason: "already_running",
				holderPid: process.pid,
				runningFor: Date.now() - this.held.data.startTime,
			};
		}

		const startWait = Date.now();
		let contestedReclaims = 0;
		let vanished = 0;

		while (true) {
			const attempt = this.tryCreate();
			if (attempt.kind === "created") {
				this.held = attempt.held;
				this.startHeartbeat();
				return { acquired: true };
			}
			if (attempt.kind === "error") {
				return {
					acquired: false,
					reason: "error",
					errorMessage: attempt.message,
				};
			}

			// EEXIST: somebody holds it, or held it and died.
			const observed = await observeSettled(this.lockPath);
			if (observed === null) {
				// Released between our create and our read. Try again at once.
				if (++vanished > MAX_VANISHED_RETRIES) {
					return {
						acquired: false,
						reason: "error",
						errorMessage: `${this.lockPath} exists when created but cannot be read`,
					};
				}
				continue;
			}

			// A dead, hung or heartbeat-stale holder is reclaimed. Passing
			// progressTimeout here is what makes a hung-but-alive holder reclaimable
			// instead of blocking every other process forever.
			if (isReclaimable(observed, staleTimeout, progressTimeout)) {
				const outcome = reclaimStaleLock(
					this.lockPath,
					observed,
					staleTimeout,
					(current) => isReclaimable(current, staleTimeout, progressTimeout),
				);
				if (outcome === "reclaimed") continue;
				if (outcome === "ambiguous") {
					return {
						acquired: false,
						reason: "error",
						errorMessage:
							`could not put back a lock detached from ${this.lockPath}; ` +
							"refusing rather than become a second holder",
					};
				}
				// "retry": someone else is reclaiming this lock, or it changed.
				if (contestedReclaims++ < MAX_CONTESTED_RECLAIMS) {
					await this.sleep(RECLAIM_RETRY_DELAY_MS);
					continue;
				}
			}

			// Held by an active process.
			const waitedMs = Date.now() - startWait;
			if (waitTimeout > 0 && waitedMs < waitTimeout) {
				if (onWaiting && observed.data !== null) {
					onWaiting(observed.data.pid, waitedMs);
				}
				await this.sleep(pollInterval);
				continue;
			}

			return {
				acquired: false,
				reason: waitTimeout > 0 ? "timeout" : "already_running",
				holderPid: observed.data?.pid,
				runningFor:
					observed.data !== null
						? Date.now() - observed.data.startTime
						: undefined,
			};
		}
	}

	/**
	 * Release the lock, removing the file only if it is still ours.
	 */
	release(): void {
		this.stopHeartbeat();

		const held = this.held;
		if (held === null) {
			return;
		}
		this.held = null;

		try {
			// Cheap pre-check, made while `fd` still pins our inode so its number
			// cannot have been reused: if the name points elsewhere, our lock was
			// reclaimed (or force-released) and the file there is someone else's.
			let ours = true;
			try {
				ours = held.ino === 0 || statSync(this.lockPath).ino === held.ino;
			} catch {
				ours = false;
			}
			if (!ours) return;

			// Swap first, compare second (CLAUDE.md #25a). Reading the token and
			// then unlinking the PATH is check-then-act: if the lock was reclaimed in
			// between, that unlink would delete the new owner's lock.
			const detached = detachLockFile(this.lockPath);
			if (detached === null) return;
			if (detached.key === `t:${held.data.token}`) {
				try {
					unlinkSync(detached.path);
				} catch {}
				return;
			}
			restoreDetachedLock(this.lockPath, detached.path);
		} finally {
			try {
				closeSync(held.fd);
			} catch {}
		}
	}

	/**
	 * Check if another process is currently indexing
	 */
	isLocked(
		staleTimeout = DEFAULT_STALE_TIMEOUT,
		progressTimeout = DEFAULT_PROGRESS_TIMEOUT,
	): {
		locked: boolean;
		holderPid?: number;
		runningFor?: number;
	} {
		const lock = readLockFile(this.lockPath);

		if (!lock) {
			return { locked: false };
		}

		// A hung holder (fresh heartbeat, no progress) reads as NOT locked so
		// callers don't block behind it.
		if (isLockStale(lock, staleTimeout, progressTimeout)) {
			return { locked: false };
		}

		return {
			locked: true,
			holderPid: lock.pid,
			runningFor: Date.now() - lock.startTime,
		};
	}

	/**
	 * Force release a stale lock (use with caution)
	 */
	forceRelease(): boolean {
		try {
			if (existsSync(this.lockPath)) {
				unlinkSync(this.lockPath);
				return true;
			}
			return false;
		} catch {
			return false;
		}
	}

	/**
	 * Stamp forward progress on the lock. Call AFTER each genuine unit of
	 * indexing work completes (embed batch / addChunks / addCodeUnits) — never on
	 * a timer or in a tight loop. Advances `lastProgressAt`, the signal that lets
	 * a hung holder be detected and reclaimed. No-op unless this instance holds
	 * the lock.
	 */
	recordProgress(): void {
		this.rewrite((data) => {
			data.lastProgressAt = Date.now();
		});
	}

	/**
	 * Record the current indexing phase on the lock. Call at phase transitions
	 * (discover → embed → write → enrich → finalize). Sets `phase` and resets
	 * `phaseStartedAt = now`, the ONLY writer of both fields — the 1s heartbeat
	 * and recordProgress deliberately leave them untouched so `now - phaseStartedAt`
	 * stays an honest "stuck in this phase" measure. Does NOT advance
	 * `lastProgressAt` (phase is reporting, not the hung signal). No-op unless
	 * this instance holds the lock.
	 */
	setPhase(phase: string): void {
		this.rewrite((data) => {
			data.phase = phase;
			data.phaseStartedAt = Date.now();
		});
	}

	/**
	 * `mkdir -p` the lock's directory, then `open(wx)`. A fresh clone has no store
	 * directory yet, and without the mkdir its very first command would fail with
	 * ENOENT and report `reason: "error"`.
	 */
	private tryCreate(): CreateAttempt {
		try {
			mkdirSync(dirname(this.lockPath), { recursive: true });
		} catch (error) {
			return { kind: "error", message: errorMessageOf(error) };
		}

		let fd: number;
		try {
			fd = openSync(this.lockPath, "wx");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") {
				return { kind: "exists" };
			}
			return { kind: "error", message: errorMessageOf(error) };
		}

		const now = Date.now();
		const data: LockData = {
			pid: process.pid,
			startTime: now,
			heartbeat: now,
			lastProgressAt: now,
			startedAt: new Date(now).toISOString(),
			token: randomUUID(),
		};
		try {
			const record = encodeRecord(data, 0);
			writeSync(fd, record, 0, record.length, 0);
			const ino = fstatSync(fd).ino;
			return { kind: "created", held: { fd, ino, data, size: record.length } };
		} catch (error) {
			// A lock we cannot stamp is a lock we must not claim: nothing could
			// later prove it ours, so release would have to unlink blindly (#25a).
			try {
				closeSync(fd);
			} catch {}
			try {
				unlinkSync(this.lockPath);
			} catch {}
			return { kind: "error", message: errorMessageOf(error) };
		}
	}

	/**
	 * Apply `mutate` to our record and write it through OUR descriptor, at
	 * offset 0, in one call. Never through the path: after a reclaim the name
	 * belongs to someone else, and our write must land in our own (detached)
	 * inode rather than overwrite theirs.
	 */
	private rewrite(mutate: (data: LockData) => void): void {
		const held = this.held;
		if (held === null) return;
		mutate(held.data);
		try {
			const record = encodeRecord(held.data, held.size);
			writeSync(held.fd, record, 0, record.length, 0);
			held.size = record.length;
		} catch {
			// Ignore write errors; the next tick tries again.
		}
	}

	private startHeartbeat(): void {
		this.heartbeatInterval = setInterval(() => {
			this.rewrite((data) => {
				data.heartbeat = Date.now();
			});
		}, HEARTBEAT_INTERVAL);

		// Don't keep process alive just for heartbeat
		if (this.heartbeatInterval.unref) {
			this.heartbeatInterval.unref();
		}
	}

	private stopHeartbeat(): void {
		if (this.heartbeatInterval) {
			clearInterval(this.heartbeatInterval);
			this.heartbeatInterval = null;
		}
	}

	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}

/**
 * The store lock: one file, beside the data it guards (FR-2).
 *
 * It keys on the RESOLVED store directory, the same value the dataset resolves
 * from, so two worktrees that share a store necessarily contend on one file.
 * This is the only way production code obtains a store lock.
 */
export function createStoreLock(loc: StoreLocation): IndexLock {
	return new IndexLock(getLockPathFor(loc));
}

/** Filename of the machine-global indexing lock (lives under ~/.mnemex). */
const GLOBAL_LOCK_FILENAME = ".global-indexing.lock";

/**
 * Resolve the path to the MACHINE-GLOBAL indexing lock. There is exactly one per
 * machine (under the user's home dir), NOT one per project — this is precisely what
 * serializes indexers across DIFFERENT repos, so N Claude Code sessions cannot run
 * N concurrent detached indexers that compete for the one machine + one shared
 * embeddings API quota (OPENROUTER_API_KEY rate limit).
 *
 * Overridable via `MNEMEX_GLOBAL_LOCK_PATH` (used by tests for isolation).
 */
export function getGlobalLockPath(): string {
	const override = process.env.MNEMEX_GLOBAL_LOCK_PATH;
	if (override && override.length > 0) {
		return override;
	}
	return join(homedir(), ".mnemex", GLOBAL_LOCK_FILENAME);
}

/**
 * Create the machine-global index lock. Reuses the full IndexLock machinery
 * (heartbeat, lastProgressAt/recordProgress, setPhase, progress-based staleness,
 * inspectLock) exactly as the store lock — so a WEDGED global holder is
 * auto-reclaimed after DEFAULT_PROGRESS_TIMEOUT by the next acquire(), the same
 * "reclaim + retry, never mark broken" recovery as the store lock.
 *
 * `acquire()` creates the parent directory (~/.mnemex, or the override's) before
 * the first write, as it does for every lock.
 *
 * It is NOT what makes a shared store safe: its purpose is API-quota
 * serialisation across repos, and its scope may legitimately narrow. The store
 * lock is what serialises writers of one dataset.
 *
 * NOTE (v2, out of scope): this is the single-indexer MVP. A cross-session
 * coalescing queue (so waiters merge into one reindex instead of each running in
 * turn) is deliberately NOT built here.
 */
export function createGlobalIndexLock(): IIndexLock {
	return new IndexLock(getGlobalLockPath());
}
