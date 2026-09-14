/**
 * Debounce Reindexer
 *
 * Schedules background reindex operations with debouncing so that rapid file
 * changes result in a single reindex. Spawns a detached child process running
 * `mnemex index --quiet` to avoid blocking the MCP stdio transport.
 */

import { spawnMnemexDetached } from "../core/entry-point-launcher.js";
import { createStoreLock } from "../core/lock.js";
import { resolveStoreLocation } from "../core/store-location.js";
import type { IndexCache } from "./cache.js";
import type { CompletionDetector } from "./completion-detector.js";
import type { Logger } from "./logger.js";
import type { IndexStateManager } from "./state-manager.js";

/** The bit of a child process this class uses. Keeps the seam one line wide. */
export interface ReindexProcess {
	pid?: number;
	on(event: "error", listener: (err: Error) => void): void;
	unref(): void;
}

/**
 * How a background reindex is started. See `spawnDetachedReindex` below.
 *
 * Deliberately `(args, cwd)` and NOT `(command, args, cwd)`: this file does
 * not get to choose WHAT is launched. Round 6 removed the command parameter
 * together with the exported constant that named the binary and fed it,
 * because a file that names the entry point and passes it to a generic
 * launcher is a second namer of the entry point, whatever the launcher does
 * with it. The purpose-specific `spawnMnemexDetached` owns the name.
 */
export type ReindexLauncher = (args: string[], cwd: string) => ReindexProcess;

/** The argv this class launches the entry point with, named once for tests. */
export const REINDEX_ARGS = ["index", "--quiet", "--if-idle"] as const;

/**
 * THE PRODUCTION LAUNCHER — the only thing in this file that starts a real
 * process, and the reason the launcher is injected at all.
 *
 * `mnemex` here is the INSTALLED ENTRY POINT. Its first act is
 * `enableRealKeychainAccess()` (`src/index.ts`), after which `mnemex index`
 * resolves embedding credentials, and that path ends at `/usr/bin/security`
 * against the developer's real login keychain. The child inherits this process's
 * environment, which is correct for the MCP server and catastrophic for a test:
 * `test/integration/mcp-server.test.ts` constructs this class nine times, and
 * with `mnemex` on PATH every one of those constructions used to launch the real
 * binary with no test-owned environment. External review (round 3) scored that
 * as a live entry-point bypass reached TRANSITIVELY — no test file names an
 * entry-point path, so no static sweep over spawn sites could ever see it.
 *
 * It was also the "pre-existing flake": those real children raced to create
 * `.mnemex/.indexing.lock` in the temp workspace, and a later `isLocked()` check
 * in the same test file then skipped its reindex, so "after reindex completes, a
 * new reindex can be triggered" failed roughly one run in eight. One root cause,
 * two symptoms.
 *
 * Injecting the launcher makes "this test does not start the real binary" a
 * property of construction rather than of the environment. The parameter is
 * REQUIRED for that reason: an optional one defaults back to this function at
 * every call site that forgets, which is the state we are leaving.
 */
export function spawnDetachedReindex(
	args: string[],
	cwd: string,
): ReindexProcess {
	// Delegates to the PURPOSE-SPECIFIC launcher (round 4 routed it through the
	// launcher module; round 6 took the command parameter away). The launcher
	// decides that the child is the installed `mnemex`; this file supplies only
	// the argv and the cwd, and the runtime veto covers the call.
	return spawnMnemexDetached(args, cwd);
}

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
		/** Who starts the child. Production passes `spawnDetachedReindex`. */
		private launch: ReindexLauncher,
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
		// The store lock, derived exactly as the spawned `mnemex index` derives it.
		const lock = createStoreLock(resolveStoreLocation(this.workspaceRoot));
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
			// --if-idle: request machine-global try-acquire-bail. If a machine-wide
			// index is already running (any repo, any session), this background
			// reindex exits cleanly instead of piling up as an idle waiter competing
			// for the one shared embeddings API quota. The next debounce trigger
			// re-fires later.
			const child = this.launch([...REINDEX_ARGS], this.workspaceRoot);

			// A missing `mnemex` on PATH surfaces as an async 'error' event, not a
			// throw. Unhandled, Node re-raises it and kills the MCP server over a
			// background reindex that is explicitly best-effort.
			child.on("error", (err) => {
				this.logger.debug(
					`DebounceReindexer: could not spawn mnemex (${err.message}) — skipping background reindex`,
				);
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
