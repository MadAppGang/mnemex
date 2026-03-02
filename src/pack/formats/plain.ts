/**
 * Plain Text Format
 *
 * Produces a plain text document with:
 * - 64-char = section separators
 * - "File: path" headers
 * - File content
 * - "End of Codebase" sentinel at the end
 */

import type { FileEntry, PackMeta } from "../types.js";

// ============================================================================
// Constants
// ============================================================================

/** Section separator: 64 equals signs */
const SEPARATOR = "=".repeat(64);

// ============================================================================
// Functions
// ============================================================================

/**
 * Format pack output as plain text.
 *
 * Structure:
 * ```
 * ================================================================
 * claudemem pack - Codebase: {name}
 * Generated: {date} | Files: {N} | Tokens (est.): {N}
 * ================================================================
 *
 * Directory Structure:
 * ----------------------------------------------------------------
 * {tree}
 *
 * ================================================================
 * File: src/cli.ts
 * ================================================================
 * {content}
 *
 * ================================================================
 * End of Codebase
 * ================================================================
 * ```
 *
 * @param entries - File entries to include
 * @param tree - Pre-built directory tree string
 * @param meta - Pack metadata
 * @returns Formatted plain text string
 */
export function formatPlain(
	entries: FileEntry[],
	tree: string,
	meta: PackMeta,
): string {
	const textFiles = entries.filter((e) => !e.isBinary);
	const parts: string[] = [];

	// Header
	parts.push(SEPARATOR);
	parts.push(`claudemem pack - Codebase: ${meta.projectName}`);
	parts.push(
		`Generated: ${meta.generatedAt} | Files: ${meta.fileCount} | Tokens (est.): ${meta.estimatedTokens}`,
	);
	parts.push(SEPARATOR);
	parts.push("");

	// Directory structure
	parts.push("Directory Structure:");
	parts.push("-".repeat(64));
	parts.push(tree);
	parts.push("");

	// Per-file sections
	for (const entry of textFiles) {
		parts.push(SEPARATOR);
		parts.push(`File: ${entry.relativePath}`);
		parts.push(SEPARATOR);
		parts.push(entry.content ?? "");
		parts.push("");
	}

	// End sentinel
	parts.push(SEPARATOR);
	parts.push("End of Codebase");
	parts.push(SEPARATOR);

	return parts.join("\n");
}
