/**
 * Completion Detector
 *
 * Detects when a background reindex has finished by polling for:
 * 1. Lock file absence (indexing.lock removed)
 * 2. index.db mtime is newer than when polling started
 *
 * Used both for event-driven notification (watch) and blocking wait (waitForCompletion).
 */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { INDEX_DB_FILE } from "../config.js";

const MAX_WAIT_MS = 300_000; // 5 minutes

/**
 * Polls for the completion of a background reindex.
 */
export class CompletionDetector {
	private pollTimer: ReturnType<typeof setInterval> | null = null;

	/**
	 * @param indexDir        where `index.db` is watched for a newer mtime.
	 * @param pollIntervalMs  how often to look.
	 * @param lockPath        the STORE lock, `getLockPathFor(loc)`: the file the
	 *                        spawned `mnemex index` actually holds. Rebuilding it
	 *                        from `indexDir` watched the wrong file for any store
	 *                        whose location is overridden.
	 */
	constructor(
		private indexDir: string,
		private pollIntervalMs: number,
		private lockPath: string,
	) {}

	/**
	 * Start polling and call onComplete when done.
	 * Automatically stops after MAX_WAIT_MS even if lock persists.
	 */
	watch(onComplete: () => void): void {
		// Stop any existing poll
		this.stop();

		const lockPath = this.lockPath;
		const dbPath = join(this.indexDir, INDEX_DB_FILE);
		const startMtime = this.getMtime(dbPath);
		const deadline = Date.now() + MAX_WAIT_MS;

		this.pollTimer = setInterval(() => {
			const isComplete = this.checkComplete(lockPath, dbPath, startMtime);
			const timedOut = Date.now() >= deadline;

			if (isComplete || timedOut) {
				this.stop();
				onComplete();
			}
		}, this.pollIntervalMs);

		// Don't keep process alive just for polling
		if (this.pollTimer.unref) {
			this.pollTimer.unref();
		}
	}

	/**
	 * Stop polling.
	 */
	stop(): void {
		if (this.pollTimer !== null) {
			clearInterval(this.pollTimer);
			this.pollTimer = null;
		}
	}

	/**
	 * Block until reindex completes or timeout elapses.
	 * Returns true if completed, false if timed out.
	 */
	async waitForCompletion(timeoutMs = MAX_WAIT_MS): Promise<boolean> {
		const lockPath = this.lockPath;
		const dbPath = join(this.indexDir, INDEX_DB_FILE);
		const startMtime = this.getMtime(dbPath);
		const deadline = Date.now() + timeoutMs;

		while (Date.now() < deadline) {
			if (this.checkComplete(lockPath, dbPath, startMtime)) {
				return true;
			}
			await sleep(this.pollIntervalMs);
		}

		return false;
	}

	/**
	 * Completion condition: lock absent AND db mtime newer than start.
	 */
	private checkComplete(
		lockPath: string,
		dbPath: string,
		startMtime: number,
	): boolean {
		if (existsSync(lockPath)) {
			return false;
		}
		const currentMtime = this.getMtime(dbPath);
		return currentMtime > startMtime;
	}

	private getMtime(path: string): number {
		try {
			return statSync(path).mtimeMs;
		} catch {
			return 0;
		}
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
