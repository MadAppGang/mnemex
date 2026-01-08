/**
 * File Watcher
 *
 * Watches for file changes and triggers incremental re-indexing.
 * Uses Node.js built-in fs.watch for cross-platform support.
 */

import { watch, type FSWatcher } from "node:fs";
import { stat, readdir } from "node:fs/promises";
import { join, relative, extname } from "node:path";
import { createIndexer } from "../indexer.js";

// ============================================================================
// Types
// ============================================================================

export interface WatcherOptions {
	/** Debounce time in milliseconds (default: 1000) */
	debounceMs?: number;
	/** File extensions to watch (default: common code extensions) */
	extensions?: string[];
	/** Directories to ignore */
	ignoreDirs?: string[];
	/** Callback when a file is re-indexed */
	onReindex?: (filePath: string, success: boolean) => void;
	/** Callback when dependency files change (triggers docs refresh) */
	onDependencyChange?: (filePath: string) => void;
}

interface PendingChange {
	filePath: string;
	timer: NodeJS.Timeout;
}

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_EXTENSIONS = new Set([
	".ts",
	".tsx",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".py",
	".go",
	".rs",
	".java",
	".c",
	".cpp",
	".cc",
	".h",
	".hpp",
]);

const DEFAULT_IGNORE_DIRS = new Set([
	"node_modules",
	".git",
	"dist",
	"build",
	".claudemem",
	"__pycache__",
	".next",
	".nuxt",
	"coverage",
	".cache",
]);

/** Dependency manifest files that trigger docs refresh */
const DEPENDENCY_FILES = new Set([
	"package.json",
	"requirements.txt",
	"pyproject.toml",
	"go.mod",
	"Cargo.toml",
]);

// ============================================================================
// File Watcher Class
// ============================================================================

export class FileWatcher {
	private projectPath: string;
	private debounceMs: number;
	private extensions: Set<string>;
	private ignoreDirs: Set<string>;
	private onReindex?: (filePath: string, success: boolean) => void;
	private onDependencyChange?: (filePath: string) => void;

	private watchers: Map<string, FSWatcher> = new Map();
	private pendingChanges: Map<string, PendingChange> = new Map();
	private pendingDependencyRefresh: NodeJS.Timeout | null = null;
	private isRunning = false;

	/** Longer debounce for dependency files (package managers may write multiple times) */
	private static readonly DEPENDENCY_DEBOUNCE_MS = 5000;

	constructor(projectPath: string, options: WatcherOptions = {}) {
		this.projectPath = projectPath;
		this.debounceMs = options.debounceMs ?? 1000;
		this.extensions = options.extensions
			? new Set(options.extensions)
			: DEFAULT_EXTENSIONS;
		this.ignoreDirs = options.ignoreDirs
			? new Set(options.ignoreDirs)
			: DEFAULT_IGNORE_DIRS;
		this.onReindex = options.onReindex;
		this.onDependencyChange = options.onDependencyChange;
	}

	/**
	 * Start watching for file changes
	 */
	async start(): Promise<void> {
		if (this.isRunning) {
			return;
		}

		this.isRunning = true;

		// Watch the project directory recursively
		await this.watchDirectory(this.projectPath);

		console.log(`  Started watching ${this.watchers.size} directories`);
	}

	/**
	 * Stop watching for file changes
	 */
	stop(): void {
		this.isRunning = false;

		// Close all watchers
		for (const watcher of this.watchers.values()) {
			watcher.close();
		}
		this.watchers.clear();

		// Clear pending changes
		for (const pending of this.pendingChanges.values()) {
			clearTimeout(pending.timer);
		}
		this.pendingChanges.clear();

		// Clear pending dependency refresh
		if (this.pendingDependencyRefresh) {
			clearTimeout(this.pendingDependencyRefresh);
			this.pendingDependencyRefresh = null;
		}
	}

	/**
	 * Check if watcher is running
	 */
	isActive(): boolean {
		return this.isRunning;
	}

	// ========================================================================
	// Private Methods
	// ========================================================================

	/**
	 * Recursively watch a directory
	 */
	private async watchDirectory(dirPath: string): Promise<void> {
		if (!this.isRunning) return;

		const dirName = dirPath.split("/").pop() || "";
		if (this.ignoreDirs.has(dirName)) {
			return;
		}

		try {
			// Watch this directory
			const watcher = watch(dirPath, (eventType, filename) => {
				if (filename) {
					const fullPath = join(dirPath, filename);
					this.handleChange(fullPath, eventType);
				}
			});

			watcher.on("error", (error) => {
				console.error(`Watcher error for ${dirPath}:`, error.message);
			});

			this.watchers.set(dirPath, watcher);

			// Recursively watch subdirectories
			const entries = await readdir(dirPath, { withFileTypes: true });
			for (const entry of entries) {
				if (entry.isDirectory() && !this.ignoreDirs.has(entry.name)) {
					await this.watchDirectory(join(dirPath, entry.name));
				}
			}
		} catch (error) {
			// Directory might not exist or not accessible
			console.error(`Failed to watch ${dirPath}:`, (error as Error).message);
		}
	}

	/**
	 * Handle a file change event
	 */
	private handleChange(filePath: string, eventType: string): void {
		// Get filename from path
		const fileName = filePath.split("/").pop() || "";

		// Check if this is a dependency file
		if (DEPENDENCY_FILES.has(fileName)) {
			this.scheduleDependencyRefresh(filePath);
			return;
		}

		// Check if this is a file we care about
		const ext = extname(filePath).toLowerCase();
		if (!this.extensions.has(ext)) {
			return;
		}

		// Check if file is in an ignored directory
		const relativePath = relative(this.projectPath, filePath);
		const parts = relativePath.split("/");
		for (const part of parts) {
			if (this.ignoreDirs.has(part)) {
				return;
			}
		}

		// Debounce: cancel existing timer if any
		const existing = this.pendingChanges.get(filePath);
		if (existing) {
			clearTimeout(existing.timer);
		}

		// Set new debounce timer
		const timer = setTimeout(() => {
			this.pendingChanges.delete(filePath);
			this.reindexFile(filePath);
		}, this.debounceMs);

		this.pendingChanges.set(filePath, { filePath, timer });
	}

	/**
	 * Schedule a dependency refresh with longer debounce
	 */
	private scheduleDependencyRefresh(filePath: string): void {
		// Cancel existing timer
		if (this.pendingDependencyRefresh) {
			clearTimeout(this.pendingDependencyRefresh);
		}

		// Set new timer with longer debounce
		this.pendingDependencyRefresh = setTimeout(() => {
			this.pendingDependencyRefresh = null;

			const relativePath = relative(this.projectPath, filePath);
			console.log(`  Dependencies changed: ${relativePath}`);

			// Notify callback if provided
			if (this.onDependencyChange) {
				this.onDependencyChange(filePath);
			} else {
				// Default behavior: trigger full reindex (includes docs refresh)
				console.log(`  Triggering docs refresh...`);
				this.triggerDocsRefresh();
			}
		}, FileWatcher.DEPENDENCY_DEBOUNCE_MS);
	}

	/**
	 * Trigger documentation refresh
	 */
	private async triggerDocsRefresh(): Promise<void> {
		try {
			const indexer = createIndexer({
				projectPath: this.projectPath,
				enableEnrichment: false, // Skip enrichment for speed
			});

			// Run incremental index - will detect deps and refresh docs
			await indexer.index(false);
			await indexer.close();

			console.log(`  ✓ Documentation refreshed`);
		} catch (error) {
			console.error(`  ✗ Docs refresh failed:`, (error as Error).message);
		}
	}

	/**
	 * Re-index a single file
	 */
	private async reindexFile(filePath: string): Promise<void> {
		const relativePath = relative(this.projectPath, filePath);

		try {
			// Check if file still exists
			await stat(filePath);

			console.log(`  Re-indexing: ${relativePath}`);

			const indexer = createIndexer({
				projectPath: this.projectPath,
				enableEnrichment: false, // Skip enrichment for speed
			});

			// Run incremental index (will pick up the changed file)
			await indexer.index(false);
			await indexer.close();

			console.log(`  ✓ Indexed: ${relativePath}`);
			this.onReindex?.(filePath, true);
		} catch (error) {
			// File might have been deleted
			const err = error as NodeJS.ErrnoException;
			if (err.code === "ENOENT") {
				console.log(`  ✗ Deleted: ${relativePath}`);
			} else {
				console.error(`  ✗ Error indexing ${relativePath}:`, err.message);
			}
			this.onReindex?.(filePath, false);
		}
	}
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a file watcher instance
 */
export function createFileWatcher(
	projectPath: string,
	debounceMs?: number,
): FileWatcher {
	return new FileWatcher(projectPath, { debounceMs });
}
