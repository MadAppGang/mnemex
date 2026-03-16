/**
 * Shared Pattern Matcher
 *
 * Pure functions for checking file/directory exclude and include patterns.
 * Extracted from Indexer to be reusable across modules (indexer, pack, etc.).
 */

import { minimatch } from "minimatch";

// ============================================================================
// Constants
// ============================================================================

/**
 * Directories to always exclude (fast path, no glob matching needed).
 * These are checked first before any glob patterns.
 */
export const ALWAYS_EXCLUDE_DIRS = new Set([
	"node_modules",
	".git",
	".svn",
	".hg",
	"dist",
	"build",
	"out",
	".next",
	".nuxt",
	"coverage",
	"__pycache__",
	"venv",
	".venv",
	"target",
	"vendor",
	".idea",
	".vscode",
	".cache",
	".mnemex",
	".turbo",
	".expo",
]);

// ============================================================================
// Functions
// ============================================================================

/**
 * Check if a path should be excluded based on exclude patterns.
 *
 * @param relativePath - Path relative to project root
 * @param isDirectory - Whether the path is a directory
 * @param excludePatterns - Glob patterns to match against
 * @returns true if the path should be excluded
 */
export function shouldExclude(
	relativePath: string,
	isDirectory: boolean,
	excludePatterns: string[],
): boolean {
	// Fast path: check if any path segment is in the always-exclude list
	const segments = relativePath.split("/");
	for (const segment of segments) {
		if (ALWAYS_EXCLUDE_DIRS.has(segment)) {
			return true;
		}
	}

	// Slow path: check glob patterns
	const pathToCheck = isDirectory ? relativePath + "/" : relativePath;

	for (const pattern of excludePatterns) {
		if (minimatch(pathToCheck, pattern, { dot: true })) {
			return true;
		}
		// Also check without trailing slash
		if (minimatch(relativePath, pattern, { dot: true })) {
			return true;
		}
	}

	return false;
}

/**
 * Check if a path matches any of the include patterns.
 *
 * @param relativePath - Path relative to project root
 * @param includePatterns - Glob patterns to match against
 * @returns true if the path matches at least one include pattern
 */
export function shouldInclude(
	relativePath: string,
	includePatterns: string[],
): boolean {
	for (const pattern of includePatterns) {
		if (minimatch(relativePath, pattern, { dot: true })) {
			return true;
		}
	}
	return false;
}
