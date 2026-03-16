/**
 * File Watcher
 *
 * Watches the workspace for code file changes using Node's fs.watch.
 * Filters by configurable watch/ignore glob patterns (via minimatch).
 * Deduplicates events on the same file within a 1000ms window.
 */

import { watch, type FSWatcher } from "node:fs";
import { relative, resolve } from "node:path";
import { minimatch } from "minimatch";
import type { Logger } from "./logger.js";

/**
 * Watches a workspace directory for file changes matching the given patterns.
 */
export class FileWatcher {
	private watcher: FSWatcher | null = null;
	/** Map from absolute file path to timestamp of last event (for dedup) */
	private recentEvents: Map<string, number> = new Map();
	private readonly dedupeWindowMs = 1000;

	constructor(
		private workspaceRoot: string,
		private watchPatterns: string[],
		private ignorePatterns: string[],
		private onFileChange: (filePath: string) => void,
		private logger: Logger,
	) {}

	/**
	 * Start watching the workspace.
	 */
	start(): void {
		if (this.watcher) {
			this.logger.warn("FileWatcher: already started");
			return;
		}

		this.logger.info(`FileWatcher: watching ${this.workspaceRoot}`);

		try {
			this.watcher = watch(
				this.workspaceRoot,
				{ recursive: true },
				(eventType, filename) => {
					if (!filename) return;
					this.handleEvent(filename);
				},
			);

			this.watcher.on("error", (err: NodeJS.ErrnoException) => {
				if (err.code === "ENOSPC") {
					this.logger.error(
						"FileWatcher: inotify limit reached (ENOSPC). " +
							"Increase fs.inotify.max_user_watches: " +
							"echo fs.inotify.max_user_watches=524288 | sudo tee -a /etc/sysctl.conf && sudo sysctl -p",
					);
				} else {
					this.logger.warn("FileWatcher: watcher error", err.message);
				}
			});
		} catch (err: unknown) {
			const nodeErr = err as NodeJS.ErrnoException;
			// On Linux, recursive fs.watch is not supported
			if (
				nodeErr.code === "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM" ||
				nodeErr.code === "EINVAL"
			) {
				this.logger.warn(
					"FileWatcher: recursive fs.watch not supported on this platform (Linux). " +
						"File watching is disabled. Run 'mnemex index' manually to update.",
				);
			} else {
				this.logger.warn(
					"FileWatcher: failed to start watcher",
					nodeErr.message,
				);
			}
		}
	}

	/**
	 * Stop the file watcher.
	 */
	stop(): void {
		if (this.watcher) {
			this.watcher.close();
			this.watcher = null;
			this.logger.debug("FileWatcher: stopped");
		}
	}

	private handleEvent(filename: string): void {
		// Resolve to absolute path and back to relative for consistent matching
		const absolutePath = resolve(this.workspaceRoot, filename);
		const relativePath = relative(this.workspaceRoot, absolutePath);

		// Deduplicate events within the window
		const now = Date.now();
		const lastSeen = this.recentEvents.get(absolutePath);
		if (lastSeen !== undefined && now - lastSeen < this.dedupeWindowMs) {
			return;
		}
		this.recentEvents.set(absolutePath, now);

		// Clean up old entries periodically to avoid memory leak
		if (this.recentEvents.size > 1000) {
			const cutoff = now - this.dedupeWindowMs * 2;
			for (const [path, ts] of this.recentEvents) {
				if (ts < cutoff) this.recentEvents.delete(path);
			}
		}

		// Check ignore patterns first (fast reject)
		for (const pattern of this.ignorePatterns) {
			if (minimatch(relativePath, pattern, { dot: true })) {
				this.logger.debug(
					`FileWatcher: ignoring ${relativePath} (matches ${pattern})`,
				);
				return;
			}
		}

		// Must match at least one watch pattern
		const matched = this.watchPatterns.some((pattern) =>
			minimatch(relativePath, pattern, { dot: true }),
		);
		if (!matched) {
			return;
		}

		this.logger.debug(`FileWatcher: changed ${relativePath}`);
		this.onFileChange(relativePath);
	}
}
