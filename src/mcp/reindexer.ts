/**
 * Debounce Reindexer
 *
 * Schedules background reindex operations with debouncing so that rapid file
 * changes result in a single reindex. Spawns a detached child process running
 * `mnemex index --quiet` to avoid blocking the MCP stdio transport.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { IndexLock } from "../core/lock.js";
import type { Logger } from "./logger.js";
import type { IndexStateManager } from "./state-manager.js";
import type { IndexCache } from "./cache.js";
import type { CompletionDetector } from "./completion-detector.js";

/**
 * Schedules and executes background reindex operations.
 */
export class DebounceReindexer {
	private timer: ReturnType<typeof setTimeout> | null = null;
	private running = false;

	constructor(
		private workspaceRoot: string,
		private indexDir: string,
		private debounceMs: number,
		private stateManager: IndexStateManager,
		private cache: IndexCache,
		private completionDetector: CompletionDetector,
		private logger: Logger,
	) {}

	/**
	 * Schedule a reindex. Multiple calls within the debounce window
	 * collapse into a single reindex.
	 */
	scheduleReindex(): void {
		if (this.timer !== null) {
			clearTimeout(this.timer);
		}
		this.timer = setTimeout(() => {
			this.timer = null;
			void this.triggerReindex();
		}, this.debounceMs);
		this.logger.debug(
			`DebounceReindexer: reindex scheduled in ${this.debounceMs}ms`,
		);
	}

	/**
	 * Cancel any pending scheduled reindex.
	 */
	cancelPending(): void {
		if (this.timer !== null) {
			clearTimeout(this.timer);
			this.timer = null;
			this.logger.debug("DebounceReindexer: pending reindex cancelled");
		}
	}

	/**
	 * Trigger an immediate reindex and wait for it to complete.
	 */
	async forceReindex(): Promise<void> {
		this.cancelPending();
		await this.triggerReindex();
	}

	/**
	 * Check whether a reindex is already running — either our own in-memory
	 * flag or an external process holding the disk lock.
	 */
	isRunning(): boolean {
		return this.running || this.isLocked();
	}

	/**
	 * Check whether an indexing lock is currently held (by any process).
	 */
	isLocked(): boolean {
		const lock = new IndexLock(this.workspaceRoot);
		return lock.isLocked().locked;
	}

	private async triggerReindex(): Promise<void> {
		if (this.running) {
			this.logger.debug(
				"DebounceReindexer: reindex already in progress, skipping",
			);
			return;
		}

		if (this.isLocked()) {
			this.logger.info(
				"DebounceReindexer: index lock held by another process, skipping",
			);
			return;
		}

		this.running = true;
		this.stateManager.onReindexStart();
		this.cache.invalidate();

		this.logger.info("DebounceReindexer: starting background reindex");

		try {
			const child = spawn("mnemex", ["index", "--quiet"], {
				cwd: this.workspaceRoot,
				detached: true,
				stdio: "ignore",
			});

			child.unref();

			this.logger.debug(
				`DebounceReindexer: spawned mnemex index (pid ${child.pid})`,
			);

			// Start polling for completion - when done, update state and invalidate cache
			this.completionDetector.watch(() => {
				this.logger.info("DebounceReindexer: reindex complete");
				this.stateManager.onReindexComplete();
				this.cache.invalidate();
				this.running = false;
			});
		} catch (err) {
			this.logger.error(
				"DebounceReindexer: failed to spawn reindex process",
				err,
			);
			this.running = false;
			this.stateManager.onReindexComplete();
		}
	}
}
