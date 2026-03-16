/**
 * Workspace Edit Applier
 *
 * Applies LSP WorkspaceEdit objects atomically to disk.
 * Two-phase approach: backup all files, then apply all edits.
 * Rolls back on any failure.
 */

import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { atomicWrite } from "./editor.js";
import type { EditHistory } from "./history.js";
import type {
	WorkspaceEdit,
	TextEdit,
	TextDocumentEdit,
} from "../lsp/protocol.js";
import { uriToPath } from "../lsp/protocol.js";

export interface ApplyResult {
	filesChanged: string[];
	totalEdits: number;
	sessionId: string;
}

export class WorkspaceEditApplier {
	constructor(
		private workspaceRoot: string,
		private history: EditHistory,
	) {}

	/**
	 * Apply a WorkspaceEdit atomically.
	 * Handles both `changes` and `documentChanges` forms.
	 */
	async apply(
		edit: WorkspaceEdit,
		options: { dryRun?: boolean; sessionId?: string } = {},
	): Promise<ApplyResult> {
		const sessionId = options.sessionId ?? randomBytes(8).toString("hex");

		// Normalize both forms into a single map of filePath → TextEdit[]
		const editsByFile = this.normalizeEdits(edit);

		if (editsByFile.size === 0) {
			return { filesChanged: [], totalEdits: 0, sessionId };
		}

		const filePaths = Array.from(editsByFile.keys());
		let totalEdits = 0;

		for (const edits of editsByFile.values()) {
			totalEdits += edits.length;
		}

		if (options.dryRun) {
			return { filesChanged: filePaths, totalEdits, sessionId };
		}

		// Phase 1: Backup all files
		const backups: Array<{ filePath: string; content: string }> = [];
		for (const filePath of filePaths) {
			const content = readFileSync(filePath, "utf-8");
			backups.push({ filePath, content });
		}

		await this.history.backupAll(
			sessionId,
			backups.map((b) => ({ filePath: b.filePath, content: b.content })),
		);

		// Phase 2: Apply all edits
		try {
			for (const [filePath, edits] of editsByFile) {
				const original = readFileSync(filePath, "utf-8");
				const modified = applyTextEdits(original, edits);
				atomicWrite(filePath, modified);
			}

			return { filesChanged: filePaths, totalEdits, sessionId };
		} catch (err) {
			// Rollback: restore all files from backup
			try {
				await this.history.restoreAll(sessionId);
			} catch {
				// Rollback failure is catastrophic — nothing we can do
			}
			throw err;
		}
	}

	/**
	 * Normalize WorkspaceEdit into filePath → TextEdit[] map.
	 */
	private normalizeEdits(edit: WorkspaceEdit): Map<string, TextEdit[]> {
		const result = new Map<string, TextEdit[]>();

		// Handle `documentChanges` form (preferred, versioned)
		if (edit.documentChanges) {
			for (const docEdit of edit.documentChanges) {
				const te = docEdit as TextDocumentEdit;
				if (te.textDocument?.uri && te.edits) {
					const filePath = this.resolvePath(te.textDocument.uri);
					const existing = result.get(filePath) ?? [];
					existing.push(...te.edits);
					result.set(filePath, existing);
				}
			}
		}

		// Handle `changes` form (simple)
		if (edit.changes) {
			for (const [uri, edits] of Object.entries(edit.changes)) {
				const filePath = this.resolvePath(uri);
				const existing = result.get(filePath) ?? [];
				existing.push(...edits);
				result.set(filePath, existing);
			}
		}

		return result;
	}

	private resolvePath(uri: string): string {
		const path = uriToPath(uri);
		return resolve(this.workspaceRoot, path);
	}
}

/**
 * Apply a list of TextEdits to source text.
 * Edits are applied in reverse order (bottom-to-top) so line numbers stay valid.
 */
function applyTextEdits(source: string, edits: TextEdit[]): string {
	const lines = source.split("\n");

	// Sort edits by position, descending (apply from bottom to top)
	const sorted = [...edits].sort((a, b) => {
		if (a.range.start.line !== b.range.start.line) {
			return b.range.start.line - a.range.start.line;
		}
		return b.range.start.character - a.range.start.character;
	});

	for (const edit of sorted) {
		const startLine = edit.range.start.line;
		const startChar = edit.range.start.character;
		const endLine = edit.range.end.line;
		const endChar = edit.range.end.character;

		// Handle the edit
		const prefix = (lines[startLine] ?? "").substring(0, startChar);
		const suffix = (lines[endLine] ?? "").substring(endChar);
		const newText = prefix + edit.newText + suffix;

		const newLines = newText.split("\n");
		lines.splice(startLine, endLine - startLine + 1, ...newLines);
	}

	return lines.join("\n");
}
