/**
 * Index Cache
 *
 * Lazy-loads the index resources (FileTracker + ReferenceGraphManager + RepoMapGenerator)
 * for the single project workspace. Invalidated when a reindex completes so the next
 * tool call gets fresh data.
 */

import { existsSync } from "node:fs";
import { getIndexDbPath } from "../config.js";
import {
	type BranchScopeResolution,
	graphBranchIdForRead,
	resolveBranchScopeForProject,
} from "../core/branch-scope.js";
import {
	createReferenceGraphManager,
	type ReferenceGraphManager,
} from "../core/reference-graph.js";
import {
	createRepoMapGenerator,
	type RepoMapGenerator,
} from "../core/repo-map.js";
import { createFileTracker, type IFileTracker } from "../core/tracker.js";
import type { Logger } from "./logger.js";

export interface CachedIndex {
	tracker: IFileTracker;
	graphManager: ReferenceGraphManager;
	repoMapGen: RepoMapGenerator;
	loadedAt: number;
	/**
	 * The branch the graph manager and repo map were built for.
	 *
	 * `ReferenceGraphManager` and `RepoMapGenerator` hold a branch for ONE run
	 * (§4.4.1), and this server outlives a `git checkout`. Recording the id here
	 * is what lets `get()` notice the mismatch and rebuild instead of answering
	 * the previous branch for the rest of the process's life (V3.10).
	 */
	branchId: number;
	/** Resolved with `branchId`, so a caller can surface D1's flag (§4.4.2). */
	branch: BranchScopeResolution;
}

/**
 * Single-project lazy index cache.
 *
 * Call get() to obtain loaded resources; call invalidate() after reindex to
 * force a reload on the next get() call.
 */
export class IndexCache {
	private cache: CachedIndex | null = null;
	private loading: Promise<CachedIndex> | null = null;

	constructor(
		private projectPath: string,
		private indexDir: string,
		private maxMemoryMB: number,
		private logger: Logger,
	) {}

	/**
	 * Get cached index resources, loading them if not already loaded.
	 * Throws if no index exists at the project path.
	 */
	async get(): Promise<CachedIndex> {
		// Re-resolve HEAD on EVERY call: deliberately not memoized, because the
		// user switches branches underneath a long-lived server (§2.5).
		const branch = resolveBranchScopeForProject(this.projectPath);
		const branchId = graphBranchIdForRead(branch);

		if (this.cache) {
			if (this.cache.branchId === branchId) {
				// The registry snapshot is re-read per call, so a row indexed under
				// a branch since this entry was built is still attributed.
				this.cache.branch = branch;
				return this.cache;
			}
			this.logger.debug(
				`IndexCache: branch changed (${this.cache.branchId} -> ${branchId}); reloading`,
			);
			this.invalidate();
		}

		// Avoid concurrent loads - reuse an in-flight load promise
		if (this.loading) {
			return this.loading;
		}

		this.loading = this.load(branch, branchId);
		try {
			this.cache = await this.loading;
			return this.cache;
		} finally {
			this.loading = null;
		}
	}

	/**
	 * Invalidate the cached index. The next get() call will reload from disk.
	 */
	invalidate(): void {
		if (this.cache) {
			this.logger.debug("IndexCache: invalidating cached index");
			this.closeCache(this.cache);
			this.cache = null;
		}
	}

	/**
	 * Close all resources. Called on server shutdown.
	 */
	close(): void {
		this.invalidate();
	}

	private async load(
		branch: BranchScopeResolution,
		branchId: number,
	): Promise<CachedIndex> {
		const dbPath = getIndexDbPath(this.projectPath);
		if (!existsSync(dbPath)) {
			throw new Error(
				`No index found at ${this.projectPath}. Run 'mnemex index' first.`,
			);
		}

		this.logger.debug(`IndexCache: loading index from ${dbPath}`);

		const tracker = createFileTracker(dbPath, this.projectPath);
		const graphManager = createReferenceGraphManager(tracker, branchId);
		const repoMapGen = createRepoMapGenerator(tracker, branchId);

		this.logger.debug("IndexCache: index loaded successfully");

		return {
			tracker,
			graphManager,
			repoMapGen,
			loadedAt: Date.now(),
			branchId,
			branch,
		};
	}

	private closeCache(cached: CachedIndex): void {
		try {
			cached.tracker.close();
		} catch (err) {
			this.logger.warn("IndexCache: error closing tracker", err);
		}
	}
}
