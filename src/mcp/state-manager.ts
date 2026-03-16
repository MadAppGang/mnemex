/**
 * Index State Manager
 *
 * Single source of truth for index freshness state.
 * Tracks which files have changed since last index, when staleness began,
 * and whether a reindex is currently in progress.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { IndexLock } from "../core/lock.js";
import type { FreshnessMetadata } from "./types.js";

const REINDEX_TIMESTAMP_FILE = ".reindex-timestamp";

/**
 * Manages index freshness state for a single workspace.
 */
export class IndexStateManager {
	/** When the index was last successfully completed */
	private lastIndexed: Date | null = null;

	/** Files that changed since the last index completion */
	private filesChangedSince: Set<string> = new Set();

	/** When the first file change was recorded after a fresh state */
	private staleSince: Date | null = null;

	/** Whether a reindex is currently running */
	private reindexInProgress = false;

	constructor(private indexDir: string) {}

	/**
	 * Initialize state by reading existing timestamp file and checking for stale locks.
	 */
	async initialize(): Promise<void> {
		// Read last reindex timestamp
		const timestampPath = join(this.indexDir, REINDEX_TIMESTAMP_FILE);
		if (existsSync(timestampPath)) {
			try {
				const content = readFileSync(timestampPath, "utf-8").trim();
				const date = new Date(content);
				if (!isNaN(date.getTime())) {
					this.lastIndexed = date;
				}
			} catch {
				// Ignore parse errors - treat as never indexed
			}
		}

		// Check if a stale lock is present and clear reindexInProgress
		// The IndexLock isLocked() call checks heartbeat freshness
		const projectPath = join(this.indexDir, "..");
		const lock = new IndexLock(projectPath);
		const lockStatus = lock.isLocked();
		// If there's an active (non-stale) lock, a reindex was in progress
		// when we started. Mark it but it will resolve when completion-detector fires.
		this.reindexInProgress = lockStatus.locked;
	}

	/**
	 * Get the current freshness metadata.
	 * Caller is responsible for filling in responseTimeMs.
	 */
	getFreshness(): Omit<FreshnessMetadata, "responseTimeMs"> {
		// Stale when: files changed OR never indexed OR reindex running
		const isStale =
			this.filesChangedSince.size > 0 ||
			this.lastIndexed === null ||
			this.reindexInProgress;
		return {
			freshness: isStale ? "stale" : "fresh",
			lastIndexed: this.lastIndexed?.toISOString() ?? null,
			staleSince: this.staleSince?.toISOString() ?? null,
			filesChanged: Array.from(this.filesChangedSince),
			reindexingInProgress: this.reindexInProgress,
		};
	}

	/**
	 * Record a file change. Transitions to stale state on first change.
	 */
	recordChange(filePath: string): void {
		if (this.filesChangedSince.size === 0 && !this.reindexInProgress) {
			// First change - record when staleness began
			this.staleSince = new Date();
		}
		this.filesChangedSince.add(filePath);
	}

	/**
	 * Called when a reindex operation begins.
	 */
	onReindexStart(): void {
		this.reindexInProgress = true;
	}

	/**
	 * Called when a reindex operation completes successfully.
	 * Clears changed files, resets stale state, writes timestamp.
	 */
	onReindexComplete(): void {
		this.reindexInProgress = false;
		this.filesChangedSince.clear();
		this.staleSince = null;
		this.lastIndexed = new Date();
		this.writeTimestamp();
	}

	/**
	 * Write the current timestamp to the .reindex-timestamp file.
	 */
	private writeTimestamp(): void {
		try {
			if (!existsSync(this.indexDir)) {
				mkdirSync(this.indexDir, { recursive: true });
			}
			const timestampPath = join(this.indexDir, REINDEX_TIMESTAMP_FILE);
			writeFileSync(timestampPath, new Date().toISOString(), "utf-8");
		} catch {
			// Non-fatal: timestamp is used for informational display only
		}
	}

	/** Whether a reindex is currently in progress */
	get isReindexing(): boolean {
		return this.reindexInProgress;
	}

	/** Number of files changed since last index */
	get changedFileCount(): number {
		return this.filesChangedSince.size;
	}
}
