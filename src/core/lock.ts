/**
 * Index Lock Manager
 *
 * Prevents race conditions when multiple processes try to index the same project.
 * Detects stale locks from dead processes to avoid infinite waits.
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Lock file data structure */
interface LockData {
	/** Process ID that holds the lock */
	pid: number;
	/** Timestamp when lock was acquired */
	startTime: number;
	/** Last heartbeat timestamp (updated periodically) */
	heartbeat: number;
	/** Human-readable start time for debugging */
	startedAt: string;
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
}

/** Options for lock acquisition */
export interface LockOptions {
	/** Maximum time to wait for existing lock (ms). Default: 0 (don't wait) */
	waitTimeout?: number;
	/** Interval to check if lock is released (ms). Default: 1000 */
	pollInterval?: number;
	/** Time after which a lock is considered stale (ms). Default: 60000 */
	staleTimeout?: number;
	/** Callback when waiting for another process */
	onWaiting?: (holderPid: number, waitedMs: number) => void;
}

const LOCK_FILENAME = ".indexing.lock";
const DEFAULT_STALE_TIMEOUT = 60000; // 60 seconds without heartbeat = stale
const DEFAULT_POLL_INTERVAL = 1000; // Check every second
const HEARTBEAT_INTERVAL = 5000; // Update heartbeat every 5 seconds

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
 * Read lock file data
 */
function readLockFile(lockPath: string): LockData | null {
	try {
		if (!existsSync(lockPath)) {
			return null;
		}
		const content = readFileSync(lockPath, "utf-8");
		return JSON.parse(content) as LockData;
	} catch {
		return null;
	}
}

/**
 * Write lock file data
 */
function writeLockFile(lockPath: string, data: LockData): void {
	writeFileSync(lockPath, JSON.stringify(data, null, 2));
}

/**
 * Check if a lock is stale (holder process died or stopped updating heartbeat)
 */
function isLockStale(lock: LockData, staleTimeout: number): boolean {
	// Check if process is dead
	if (!isProcessRunning(lock.pid)) {
		return true;
	}

	// Check if heartbeat is too old
	const now = Date.now();
	if (now - lock.heartbeat > staleTimeout) {
		return true;
	}

	return false;
}

/**
 * Index Lock Manager
 *
 * Usage:
 * ```typescript
 * const lock = new IndexLock(projectPath);
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
export class IndexLock {
	private lockPath: string;
	private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
	private acquired = false;

	constructor(projectPath: string, indexDir = ".claudemem") {
		this.lockPath = join(projectPath, indexDir, LOCK_FILENAME);
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
			onWaiting,
		} = options;

		const startWait = Date.now();

		while (true) {
			// Check for existing lock
			const existingLock = readLockFile(this.lockPath);

			if (existingLock) {
				// Check if it's stale (dead process or no heartbeat)
				if (isLockStale(existingLock, staleTimeout)) {
					// Clean up stale lock and continue to acquire
					try {
						unlinkSync(this.lockPath);
					} catch {
						// Ignore - another process may have cleaned it up
					}
				} else {
					// Lock is held by an active process
					const waitedMs = Date.now() - startWait;

					if (waitTimeout > 0 && waitedMs < waitTimeout) {
						// Wait and retry
						if (onWaiting) {
							onWaiting(existingLock.pid, waitedMs);
						}
						await this.sleep(pollInterval);
						continue;
					}

					// Timeout or no wait requested
					return {
						acquired: false,
						reason: waitTimeout > 0 ? "timeout" : "already_running",
						holderPid: existingLock.pid,
						runningFor: Date.now() - existingLock.startTime,
					};
				}
			}

			// Try to acquire lock
			const now = Date.now();
			const lockData: LockData = {
				pid: process.pid,
				startTime: now,
				heartbeat: now,
				startedAt: new Date(now).toISOString(),
			};

			try {
				writeLockFile(this.lockPath, lockData);

				// Verify we got the lock (another process might have won the race)
				const verifyLock = readLockFile(this.lockPath);
				if (verifyLock?.pid !== process.pid) {
					// Lost the race, retry
					continue;
				}

				// Successfully acquired
				this.acquired = true;
				this.startHeartbeat();

				return { acquired: true };
			} catch (error) {
				return {
					acquired: false,
					reason: "error",
				};
			}
		}
	}

	/**
	 * Release the lock
	 */
	release(): void {
		this.stopHeartbeat();

		if (!this.acquired) {
			return;
		}

		try {
			// Only delete if we own the lock
			const lock = readLockFile(this.lockPath);
			if (lock?.pid === process.pid) {
				unlinkSync(this.lockPath);
			}
		} catch {
			// Ignore errors during cleanup
		}

		this.acquired = false;
	}

	/**
	 * Check if another process is currently indexing
	 */
	isLocked(staleTimeout = DEFAULT_STALE_TIMEOUT): {
		locked: boolean;
		holderPid?: number;
		runningFor?: number;
	} {
		const lock = readLockFile(this.lockPath);

		if (!lock) {
			return { locked: false };
		}

		if (isLockStale(lock, staleTimeout)) {
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

	private startHeartbeat(): void {
		this.heartbeatInterval = setInterval(() => {
			try {
				const lock = readLockFile(this.lockPath);
				if (lock?.pid === process.pid) {
					lock.heartbeat = Date.now();
					writeLockFile(this.lockPath, lock);
				}
			} catch {
				// Ignore heartbeat errors
			}
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
 * Create an index lock for a project
 */
export function createIndexLock(
	projectPath: string,
	indexDir?: string,
): IndexLock {
	return new IndexLock(projectPath, indexDir);
}
