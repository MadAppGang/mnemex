/**
 * Symbol Body Reader
 *
 * Reads symbol source code from disk given a file path and line range.
 * Shared between the symbol tool and search pipeline backends.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Read the body of a symbol from disk.
 *
 * Returns `{ body: string, stale: false }` on success or
 * `{ body: null, stale: true }` if the file cannot be read.
 *
 * Throws on path traversal attempts.
 */
export function readSymbolBody(
	workspaceRoot: string,
	filePath: string,
	startLine: number,
	endLine: number,
): { body: string; stale: false } | { body: null; stale: true } {
	const absPath = resolve(workspaceRoot, filePath);
	if (!absPath.startsWith(`${workspaceRoot}/`)) {
		throw new Error(`Path traversal attempt: ${filePath}`);
	}

	try {
		const content = readFileSync(absPath, "utf-8");
		const lines = content.split("\n");
		// startLine and endLine are 1-indexed
		const body = lines.slice(startLine - 1, endLine).join("\n");
		return { body, stale: false };
	} catch {
		return { body: null, stale: true };
	}
}
