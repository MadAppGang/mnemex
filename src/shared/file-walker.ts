/**
 * Shared File Walker
 *
 * Recursive file discovery with exclude/include pattern support.
 * Extracted from Indexer to be reusable across modules (indexer, pack, etc.).
 */

import { readdirSync, statSync, type Dirent } from "node:fs";
import { join, relative } from "node:path";
import { shouldExclude, shouldInclude } from "./pattern-matcher.js";

// ============================================================================
// Types
// ============================================================================

/**
 * A single file or directory entry discovered during walking.
 */
export interface WalkEntry {
	/** Absolute path to the file/directory */
	path: string;
	/** Path relative to the root directory */
	relativePath: string;
	/** Whether this entry is a directory */
	isDirectory: boolean;
	/** File size in bytes (0 for directories) */
	size: number;
}

/**
 * Options for the file walker.
 */
export interface WalkOptions {
	/** Glob patterns for paths to exclude */
	excludePatterns: string[];
	/** Glob patterns for paths to include (if empty, all non-excluded paths are included) */
	includePatterns?: string[];
	/**
	 * File extensions to include (e.g., [".ts", ".js"]).
	 * If not provided, all non-binary files are included.
	 * Each extension must start with a dot.
	 */
	onlyExtensions?: Set<string>;
}

// ============================================================================
// Functions
// ============================================================================

/**
 * Walk a directory tree and return all matching file entries.
 *
 * Directories that match exclude patterns are pruned entirely.
 * Files must pass exclude check and (if configured) include check and extension check.
 *
 * @param root - Absolute path to the root directory to walk
 * @param opts - Walk options
 * @returns Array of WalkEntry objects for matching files (not directories)
 */
export function walkFiles(root: string, opts: WalkOptions): WalkEntry[] {
	const entries: WalkEntry[] = [];
	const {
		excludePatterns,
		includePatterns = [],
		onlyExtensions,
	} = opts;

	const walk = (dir: string): void => {
		let dirEntries: Dirent[];
		try {
			dirEntries = readdirSync(dir, { withFileTypes: true }) as Dirent[];
		} catch {
			// Skip unreadable directories
			return;
		}

		for (const entry of dirEntries) {
			const fullPath = join(dir, entry.name as string);
			const relativePath = relative(root, fullPath);

			// Check exclude patterns
			if (shouldExclude(relativePath, entry.isDirectory(), excludePatterns)) {
				continue;
			}

			if (entry.isDirectory()) {
				walk(fullPath);
			} else if (entry.isFile()) {
				// Check include patterns if specified
				if (
					includePatterns.length > 0 &&
					!shouldInclude(relativePath, includePatterns)
				) {
					continue;
				}

				// Check extension filter if specified
				if (onlyExtensions !== undefined) {
					const ext =
						"." + (entry.name as string).split(".").pop()?.toLowerCase();
					if (!onlyExtensions.has(ext)) {
						continue;
					}
				}

				let size = 0;
				try {
					size = statSync(fullPath).size;
				} catch {
					// Use 0 for inaccessible files
				}

				entries.push({
					path: fullPath,
					relativePath,
					isDirectory: false,
					size,
				});
			}
		}
	};

	walk(root);
	return entries;
}
