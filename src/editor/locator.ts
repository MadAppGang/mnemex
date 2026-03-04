/**
 * Symbol Locator
 *
 * Finds symbol definitions by name using the AST reference graph and file tracker.
 * Supports optional LSP position refinement when an LspManager is available.
 */

import type { ReferenceGraphManager } from "../core/reference-graph.js";
import type { IFileTracker } from "../core/tracker.js";
import type { SymbolDefinition } from "../types.js";
import type { LspManager } from "../lsp/manager.js";

export interface SymbolLocation {
	filePath: string;
	startLine: number;
	endLine: number;
	source: "tree-sitter" | "lsp";
	symbol: SymbolDefinition;
}

/**
 * Convert a UTF-16 offset (LSP standard) to a byte offset in a string.
 * LSP uses UTF-16 code units for character positions; tree-sitter uses bytes.
 */
export function utf16ToByteOffset(line: string, utf16Offset: number): number {
	let utf16Count = 0;
	let byteCount = 0;
	for (const codePoint of line) {
		if (utf16Count >= utf16Offset) break;
		const charCode = codePoint.codePointAt(0)!;
		// Surrogate pairs count as 2 UTF-16 code units
		utf16Count += charCode > 0xffff ? 2 : 1;
		byteCount += Buffer.byteLength(codePoint, "utf-8");
	}
	return byteCount;
}

/**
 * Convert a byte offset to a UTF-16 offset (LSP standard).
 */
export function byteToUtf16Offset(line: string, byteOffset: number): number {
	let utf16Count = 0;
	let byteCount = 0;
	for (const codePoint of line) {
		if (byteCount >= byteOffset) break;
		const charCode = codePoint.codePointAt(0)!;
		utf16Count += charCode > 0xffff ? 2 : 1;
		byteCount += Buffer.byteLength(codePoint, "utf-8");
	}
	return utf16Count;
}

export class SymbolLocator {
	constructor(
		private graphManager: ReferenceGraphManager,
		private tracker: IFileTracker,
		private lspManager: LspManager | null = null,
	) {}

	/**
	 * Find a symbol by name, optionally scoped to a file.
	 */
	locate(
		symbolName: string,
		options: { file?: string; kind?: string } = {},
	): SymbolLocation | null {
		// Try reference graph first (most common path)
		const found = this.graphManager.findSymbol(symbolName, {
			preferExported: true,
			fileHint: options.file,
		});

		if (!found) return null;
		if (options.kind && options.kind !== "any" && found.kind !== options.kind) {
			return null;
		}

		return {
			filePath: found.filePath,
			startLine: found.startLine,
			endLine: found.endLine,
			source: "tree-sitter",
			symbol: found,
		};
	}

	/**
	 * Find all symbols in a file.
	 */
	locateByFile(filePath: string): SymbolLocation[] {
		const symbols = this.tracker.getSymbolsByFile(filePath);
		return symbols.map((s) => ({
			filePath: s.filePath,
			startLine: s.startLine,
			endLine: s.endLine,
			source: "tree-sitter" as const,
			symbol: s,
		}));
	}
}
