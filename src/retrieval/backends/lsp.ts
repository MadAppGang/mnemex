/**
 * LSP Backend
 *
 * Uses the language server to find exact symbol definitions.
 * Sets isDefinitive=true for high-confidence results.
 * Activated for: symbol_lookup
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ReferenceGraphManager } from "../../core/reference-graph.js";
import type { LspManager } from "../../lsp/manager.js";
import {
	LSP_METHODS,
	type Location,
	pathToUri,
	uriToPath,
} from "../../lsp/protocol.js";
import type { QueryClassification } from "../../types.js";
import type {
	BackendResult,
	ISearchBackend,
	SearchOptions,
} from "../pipeline/types.js";
import { readSymbolBody } from "./utils/read-body.js";

export class LspBackend implements ISearchBackend {
	readonly name = "lsp" as const;

	constructor(
		private lspManager: LspManager,
		private graphManager: ReferenceGraphManager,
		private workspaceRoot: string,
	) {}

	async search(
		query: string,
		intent: QueryClassification,
		_options: SearchOptions,
		signal: AbortSignal,
	): Promise<BackendResult[]> {
		if (signal.aborted) return [];

		// Get candidate symbol names from extracted entities or query
		const names =
			intent.extractedEntities.length > 0 ? intent.extractedEntities : [query];

		for (const name of names) {
			if (signal.aborted) return [];

			// Find a starting position using graph manager
			const found = this.graphManager.findSymbol(name, {
				preferExported: true,
			});
			if (!found) continue;

			const absPath = resolve(this.workspaceRoot, found.filePath);
			const lang = this.lspManager.detectServerLanguage(absPath);
			if (!lang) continue;

			try {
				const client = await this.lspManager.getClient(lang);
				if (!client || signal.aborted) continue;

				// Open the file in LSP
				const langId = this.lspManager.detectLanguageId(absPath) ?? lang;
				const content = readFileSync(absPath, "utf-8");
				client.openFile(absPath, langId, content);

				if (signal.aborted) return [];

				// Issue textDocument/definition request
				// Use a Promise.race so we respect AbortSignal
				const lspPromise = client.request<Location | Location[] | null>(
					LSP_METHODS.DEFINITION,
					{
						textDocument: { uri: pathToUri(absPath) },
						// Use the symbol's known position (0-indexed for LSP)
						position: {
							line: found.startLine - 1,
							character: 0,
						},
					},
				);

				const abortPromise = new Promise<never>((_, reject) => {
					const onAbort = () => reject(new Error("AbortSignal fired"));
					if (signal.aborted) {
						reject(new Error("AbortSignal fired"));
					} else {
						signal.addEventListener("abort", onAbort, { once: true });
					}
				});

				let lspResult: Location | Location[] | null;
				try {
					lspResult = await Promise.race([lspPromise, abortPromise]);
				} catch {
					return [];
				}

				if (signal.aborted) return [];

				const loc = Array.isArray(lspResult) ? lspResult[0] : lspResult;
				if (!loc?.uri) continue;

				const defPath = uriToPath(loc.uri);
				const relPath = defPath.startsWith(`${this.workspaceRoot}/`)
					? defPath.slice(this.workspaceRoot.length + 1)
					: defPath;

				const defStartLine = loc.range.start.line + 1;
				const defEndLine = loc.range.end.line + 1;

				// Read body from disk at the LSP-resolved location
				const bodyResult = readSymbolBody(
					this.workspaceRoot,
					relPath,
					defStartLine,
					defEndLine,
				);

				const snippet = bodyResult.body
					? bodyResult.body.slice(0, 800)
					: (found.signature ?? found.name).slice(0, 800);

				const result: BackendResult = {
					file: relPath,
					startLine: defStartLine,
					endLine: defEndLine,
					symbol: found.name,
					body: bodyResult.body ?? undefined,
					snippet,
					score: 1.0,
					backend: this.name,
					isDefinitive: true,
				};

				return [result];
			} catch {}
		}

		return [];
	}
}
