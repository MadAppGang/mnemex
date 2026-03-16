/**
 * Edit Validator
 *
 * Pre-flight checks before any file edit: path traversal, hash freshness,
 * size limits, and syntax validation via tree-sitter.
 */

import { realpathSync, readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import type { IFileTracker } from "../core/tracker.js";
import { getParserManager } from "../parsers/parser-manager.js";
import type { SupportedLanguage } from "../types.js";
import { createHash } from "node:crypto";

const MAX_EDIT_SIZE = 1_000_000; // 1MB

/** Extension → SupportedLanguage for syntax checking */
const EXT_TO_LANG: Record<string, SupportedLanguage> = {
	".ts": "typescript",
	".mts": "typescript",
	".cts": "typescript",
	".tsx": "tsx",
	".js": "javascript",
	".mjs": "javascript",
	".cjs": "javascript",
	".jsx": "jsx",
	".py": "python",
	".go": "go",
	".rs": "rust",
	".c": "c",
	".h": "c",
	".cpp": "cpp",
	".java": "java",
};

export class EditValidator {
	/**
	 * Guard against path traversal and symlink escape.
	 * Uses fs.realpathSync to resolve symlinks before checking containment.
	 */
	preCheck(filePath: string, workspaceRoot: string): void {
		let resolvedPath: string;
		let resolvedRoot: string;
		try {
			resolvedPath = realpathSync(filePath);
			resolvedRoot = realpathSync(workspaceRoot);
		} catch {
			throw new Error(`Path resolution failed: ${filePath}`);
		}

		if (
			!resolvedPath.startsWith(resolvedRoot + "/") &&
			resolvedPath !== resolvedRoot
		) {
			throw new Error(
				`Path traversal blocked: ${filePath} resolves outside workspace`,
			);
		}
	}

	/**
	 * Compare current file hash with tracked hash to detect stale edits.
	 * Returns the current content hash for TOCTOU re-verification inside locks.
	 */
	hashCheck(filePath: string, tracker: IFileTracker): string {
		const state = tracker.getFileState(filePath);
		if (!state) {
			// File not indexed yet — allow edit but warn
			return "";
		}

		const currentContent = readFileSync(filePath, "utf-8");
		const currentHash = createHash("sha256")
			.update(currentContent)
			.digest("hex");

		if (currentHash !== state.contentHash) {
			throw new Error(
				`File ${filePath} has been modified since last index. ` +
					`Run 'mnemex index' or wait for auto-reindex.`,
			);
		}

		return currentHash;
	}

	/**
	 * Reject edits that would create files larger than 1MB.
	 */
	sizeCheck(newContent: string): void {
		const bytes = Buffer.byteLength(newContent, "utf-8");
		if (bytes > MAX_EDIT_SIZE) {
			throw new Error(
				`Edit result too large: ${bytes} bytes exceeds ${MAX_EDIT_SIZE} byte limit`,
			);
		}
	}

	/**
	 * Parse the new content with tree-sitter to verify syntax validity.
	 * Returns true if valid, throws on syntax errors for known languages.
	 * Silently returns true for unsupported languages.
	 */
	async syntaxCheck(content: string, filePath: string): Promise<boolean> {
		const ext = extname(filePath);
		const lang = EXT_TO_LANG[ext];
		if (!lang) return true; // Unknown language, skip check

		const pm = getParserManager();
		const tree = await pm.parse(content, lang);
		if (!tree) return true; // Parser not available

		// Check for ERROR nodes in the tree
		const hasError = tree.rootNode.hasError;
		if (hasError) {
			throw new Error(
				`Syntax error in edited content for ${filePath}. ` +
					`The edit would produce invalid ${lang} code.`,
			);
		}

		return true;
	}
}
