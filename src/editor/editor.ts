/**
 * Symbol Editor
 *
 * Orchestrates code edits: locate symbol → validate → backup → write → reindex.
 * Provides both symbol-level and line-level editing with per-file locking.
 */

import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { DetachedEntryPointLauncher } from "../core/entry-point-launcher.js";
import type { LspManager } from "../lsp/manager.js";
import type { IndexCache } from "../mcp/cache.js";
import type { McpConfig } from "../mcp/config.js";
import { EditHistory } from "./history.js";
import { SymbolLocator } from "./locator.js";
import { EditValidator } from "./validator.js";

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
		/**
		 * Who starts the follow-up reindex. REQUIRED, and third rather than last,
		 * so that no existing or future construction can silently fall back to the
		 * installed binary.
		 *
		 * Production passes `spawnMnemexDetached` (`src/mcp/server.ts`); tests pass
		 * a recorder (`test/helpers/test-workspace.ts`). Before this parameter
		 * existed, `triggerReindex` called `spawn("mnemex", …)` directly, and every
		 * `SymbolEditor` a test created — `test/e2e/editor/editor.e2e.test.ts`,
		 * `test/e2e/scenarios/edit-restore.e2e.test.ts` — launched the real entry
		 * point, which enables real keychain access in the child. An OPTIONAL
		 * parameter defaulting to the production launcher would have left every one
		 * of those call sites exactly as it was.
		 */
		private launchReindex: DetachedEntryPointLauncher,
		private lspManager: LspManager | null = null,
	) {
		this.validator = new EditValidator();
		this.history = new EditHistory(config.indexDir);
		// Locator is created lazily when cache is loaded
		this.locator = null!;
	}

	private async ensureLocator(): Promise<SymbolLocator> {
		if (this.locator) return this.locator;
		const { graphManager, tracker, branchId } = await this.cache.get();
		this.locator = new SymbolLocator(
			graphManager,
			tracker,
			branchId,
			this.lspManager,
		);
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
			const { tracker, branchId } = await this.cache.get();
			const state = tracker.getFileState(branchId, filePath);
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
	 * Trigger immediate reindex for a specific file, in the background.
	 *
	 * This used to be `spawn("mnemex", ["index", …])` — a BARE BINARY NAME
	 * resolved through `PATH`. On any machine with mnemex installed it resolved
	 * and ran the production entry point, whose first act is
	 * `enableRealKeychainAccess()`; from a test, that reached the developer's real
	 * login keychain. Nothing in the call looked like a path, so the static sweep
	 * over entry-point PATHS could not see it (round 4). The launcher is now
	 * injected: see the constructor, and `src/core/entry-point-launcher.ts` for
	 * why this class no longer names the binary at all.
	 */
	private triggerReindex(filePath: string): void {
		try {
			const child = this.launchReindex(
				["index", "--quiet", "--files", filePath],
				this.config.workspaceRoot,
			);
			// spawn() reports a missing executable ASYNCHRONOUSLY via an 'error'
			// event — it does not throw — so the catch below never sees ENOENT.
			// Without a listener Node re-raises it as an unhandled 'error' and
			// takes the process down, which defeats the best-effort intent: the
			// edit itself succeeded and only the follow-up reindex is missing.
			// Happens whenever mnemex is not on PATH (library use, npx, a dev
			// checkout without `npm link`, CI).
			child.on("error", () => {});
			child.unref();
		} catch {
			// Synchronous failures — an unusable cwd, or the launcher refusing
			// because this is a guarded (test) process. Also best-effort.
		}
	}
}

/**
 * Atomic write: write to temp file, then rename.
 * Uses crypto.randomBytes for unpredictable temp filenames.
 */
export function atomicWrite(filePath: string, content: string): void {
	const dir = dirname(filePath);
	const tmpName = `.mnemex-tmp-${randomBytes(8).toString("hex")}`;
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
