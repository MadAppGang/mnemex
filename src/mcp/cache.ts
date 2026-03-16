/**
 * Index Cache
 *
 * Lazy-loads the index resources (FileTracker + ReferenceGraphManager + RepoMapGenerator)
 * for the single project workspace. Invalidated when a reindex completes so the next
 * tool call gets fresh data.
 */

import { join } from "node:path";
import { existsSync } from "node:fs";
import { type IFileTracker, createFileTracker } from "../core/tracker.js";
import {
	ReferenceGraphManager,
	createReferenceGraphManager,
} from "../core/reference-graph.js";
import { RepoMapGenerator, createRepoMapGenerator } from "../core/repo-map.js";
import { getIndexDbPath } from "../config.js";
import type { Logger } from "./logger.js";

export interface CachedIndex {
	tracker: IFileTracker;
	graphManager: ReferenceGraphManager;
	repoMapGen: RepoMapGenerator;
	loadedAt: number;
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
		if (this.cache) {
			return this.cache;
		}

		// Avoid concurrent loads - reuse an in-flight load promise
		if (this.loading) {
			return this.loading;
		}

		this.loading = this.load();
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

	private async load(): Promise<CachedIndex> {
		const dbPath = getIndexDbPath(this.projectPath);
		if (!existsSync(dbPath)) {
			throw new Error(
				`No index found at ${this.projectPath}. Run 'mnemex index' first.`,
			);
		}

		this.logger.debug(`IndexCache: loading index from ${dbPath}`);

		const tracker = createFileTracker(dbPath, this.projectPath);
		const graphManager = createReferenceGraphManager(tracker);
		const repoMapGen = createRepoMapGenerator(tracker);

		this.logger.debug("IndexCache: index loaded successfully");

		return {
			tracker,
			graphManager,
			repoMapGen,
			loadedAt: Date.now(),
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
