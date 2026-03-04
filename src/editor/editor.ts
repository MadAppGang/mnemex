/**
 * Symbol Editor
 *
 * Orchestrates code edits: locate symbol → validate → backup → write → reindex.
 * Provides both symbol-level and line-level editing with per-file locking.
 */

import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";

import { SymbolLocator } from "./locator.js";
import { EditValidator } from "./validator.js";
import { EditHistory } from "./history.js";
import type { IndexCache } from "../mcp/cache.js";
import type { McpConfig } from "../mcp/config.js";
import type { LspManager } from "../lsp/manager.js";

export type InsertMode = "replace" | "before" | "after";

export interface EditOptions {
	/** Dry run mode — validate and report what would change without writing */
	dryRun?: boolean;
	/** Session ID for grouping edits (auto-generated if not provided) */
	sessionId?: string;
	/** Skip syntax validation (for speed when caller knows content is valid) */
	skipSyntaxCheck?: boolean;
}

export interface EditResult {
	filePath: string;
	startLine: number;
	endLine: number;
	linesChanged: number;
	dryRun: boolean;
	sessionId: string;
	symbolName?: string;
}

/** Per-file lock chain */
const fileLocks = new Map<string, Promise<void>>();

/**
 * Acquire a per-file lock. Returns a release function.
 * Uses a promise chain so concurrent edits to the same file are serialized.
 */
function acquireFileLock(filePath: string): Promise<() => void> {
	const current = fileLocks.get(filePath) ?? Promise.resolve();
	let release: () => void;
	const next = new Promise<void>((resolve) => {
		release = resolve;
	});
	fileLocks.set(filePath, next);
	return current.then(() => release!);
}

export class SymbolEditor {
	private locator: SymbolLocator;
	private validator: EditValidator;
	private history: EditHistory;

	constructor(
		private cache: IndexCache,
		private config: McpConfig,
		private lspManager: LspManager | null = null,
	) {
		this.validator = new EditValidator();
		this.history = new EditHistory(config.indexDir);
		// Locator is created lazily when cache is loaded
		this.locator = null!;
	}

	private async ensureLocator(): Promise<SymbolLocator> {
		if (this.locator) return this.locator;
		const { graphManager, tracker } = await this.cache.get();
		this.locator = new SymbolLocator(graphManager, tracker, this.lspManager);
		return this.locator;
	}

	/**
	 * Edit a symbol's body by name.
	 */
	async editSymbol(
		symbolName: string,
		newContent: string,
		mode: InsertMode = "replace",
		options: EditOptions = {},
	): Promise<EditResult> {
		const locator = await this.ensureLocator();
		const location = locator.locate(symbolName);
		if (!location) {
			throw new Error(`Symbol '${symbolName}' not found in index`);
		}

		const absPath = resolve(this.config.workspaceRoot, location.filePath);
		const result = await this.editLines(
			absPath,
			location.startLine,
			location.endLine,
			newContent,
			{ ...options, _mode: mode },
		);

		return { ...result, symbolName };
	}

	/**
	 * Edit specific lines in a file.
	 */
	async editLines(
		filePath: string,
		startLine: number,
		endLine: number,
		newContent: string,
		options: EditOptions & { _mode?: InsertMode } = {},
	): Promise<EditResult> {
		const absPath = resolve(this.config.workspaceRoot, filePath);
		const dryRun = options.dryRun ?? false;
		const sessionId = options.sessionId ?? randomBytes(8).toString("hex");
		const mode = options._mode ?? "replace";

		// Validation
		this.validator.preCheck(absPath, this.config.workspaceRoot);
		this.validator.sizeCheck(newContent);

		if (dryRun) {
			return {
				filePath,
				startLine,
				endLine,
				linesChanged: newContent.split("\n").length,
				dryRun: true,
				sessionId,
			};
		}

		// Acquire file lock
		const release = await acquireFileLock(absPath);
		try {
			// Read current content inside lock
			const currentContent = readFileSync(absPath, "utf-8");
			const lines = currentContent.split("\n");

			// Validate line range
			if (startLine < 1 || endLine > lines.length || startLine > endLine) {
				throw new Error(
					`Invalid line range ${startLine}-${endLine} for file with ${lines.length} lines`,
				);
			}

			// TOCTOU guard: verify hash inside lock
			const { tracker } = await this.cache.get();
			const state = tracker.getFileState(filePath);
			if (state) {
				const { createHash } = await import("node:crypto");
				const currentHash = createHash("sha256")
					.update(currentContent)
					.digest("hex");
				if (currentHash !== state.contentHash) {
					throw new Error(
						`File ${filePath} changed between validation and write (TOCTOU). Retry the edit.`,
					);
				}
			}

			// Build new content based on mode
			const newLines = newContent.split("\n");
			let resultLines: string[];

			switch (mode) {
				case "replace":
					resultLines = [
						...lines.slice(0, startLine - 1),
						...newLines,
						...lines.slice(endLine),
					];
					break;
				case "before":
					resultLines = [
						...lines.slice(0, startLine - 1),
						...newLines,
						...lines.slice(startLine - 1),
					];
					break;
				case "after":
					resultLines = [
						...lines.slice(0, endLine),
						...newLines,
						...lines.slice(endLine),
					];
					break;
			}

			const finalContent = resultLines.join("\n");

			// Syntax check (before writing)
			if (!options.skipSyntaxCheck) {
				await this.validator.syntaxCheck(finalContent, absPath);
			}

			// Backup original
			await this.history.backup(sessionId, absPath, currentContent);

			// Atomic write
			atomicWrite(absPath, finalContent);

			// Notify LSP if available
			if (this.lspManager) {
				this.lspManager.notifyFileSaved(absPath, finalContent);
			}

			// Trigger immediate reindex for this file
			this.triggerReindex(absPath);

			return {
				filePath,
				startLine,
				endLine,
				linesChanged: newLines.length,
				dryRun: false,
				sessionId,
			};
		} finally {
			release();
		}
	}

	/**
	 * Restore all files from an edit session.
	 */
	async restoreSession(sessionId?: string): Promise<string[]> {
		if (sessionId) {
			return this.history.restoreAll(sessionId);
		}
		const latest = this.history.getLatestSession();
		if (!latest) {
			throw new Error("No edit sessions to restore");
		}
		return this.history.restoreAll(latest.sessionId);
	}

	/**
	 * List edit sessions.
	 */
	listSessions() {
		return this.history.listSessions();
	}

	/**
	 * Get the EditHistory instance (for WorkspaceEditApplier).
	 */
	getHistory(): EditHistory {
		return this.history;
	}

	/**
	 * Trigger immediate reindex for a specific file.
	 * Spawns a background process to avoid blocking.
	 */
	private triggerReindex(filePath: string): void {
		try {
			const child = spawn("claudemem", ["index", "--quiet", "--files", filePath], {
				cwd: this.config.workspaceRoot,
				stdio: "ignore",
				detached: true,
			});
			child.unref();
		} catch {
			// Best-effort: if claudemem binary isn't available, skip
		}
	}
}

/**
 * Atomic write: write to temp file, then rename.
 * Uses crypto.randomBytes for unpredictable temp filenames.
 */
export function atomicWrite(filePath: string, content: string): void {
	const dir = dirname(filePath);
	const tmpName = `.claudemem-tmp-${randomBytes(8).toString("hex")}`;
	const tmpPath = join(dir, tmpName);

	try {
		writeFileSync(tmpPath, content, "utf-8");
		renameSync(tmpPath, filePath);
	} catch (err) {
		// Clean up temp file on failure
		try {
			const { unlinkSync } = require("node:fs");
			unlinkSync(tmpPath);
		} catch {
			// ignore cleanup error
		}
		throw err;
	}
}
