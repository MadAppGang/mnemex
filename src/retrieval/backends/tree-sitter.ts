/**
 * Tree-Sitter Structural Backend
 *
 * Parses source files at search time to find structural patterns.
 * Activated for: structural, symbol_lookup
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Query } from "web-tree-sitter";
import type { IFileTracker } from "../../core/tracker.js";
import type { ParserManager } from "../../parsers/parser-manager.js";
import type { QueryClassification } from "../../types.js";
import type {
	BackendResult,
	ISearchBackend,
	SearchOptions,
} from "../pipeline/types.js";
import {
	buildStructuralQuery,
	detectLanguageFromPath,
} from "./utils/structural-query-builder.js";

export class TreeSitterBackend implements ISearchBackend {
	readonly name = "tree-sitter" as const;

	constructor(
		private parserManager: ParserManager,
		private tracker: IFileTracker,
		private workspaceRoot: string,
		private maxFilesToScan: number,
	) {}

	async search(
		_query: string,
		intent: QueryClassification,
		options: SearchOptions,
		signal: AbortSignal,
	): Promise<BackendResult[]> {
		if (signal.aborted) return [];

		const limit = options.limit ?? 10;

		// Need at least one entity name to build a structural query
		if (intent.extractedEntities.length === 0) return [];

		const entityName = intent.extractedEntities[0];

		// Get all indexed files
		const allFiles = this.tracker.getAllFiles();
		if (signal.aborted) return [];

		// Apply filePattern filter if provided
		let filesToScan = allFiles.map((f) => f.path);
		if (options.filePattern) {
			const pat = options.filePattern
				.replace(/\*\*/g, ".*")
				.replace(/\*/g, "[^/]*");
			const regex = new RegExp(pat, "i");
			filesToScan = filesToScan.filter((p) => regex.test(p));
		}

		// Limit to maxFilesToScan
		filesToScan = filesToScan.slice(0, this.maxFilesToScan);

		const results: BackendResult[] = [];

		for (const relPath of filesToScan) {
			if (signal.aborted) break;
			if (results.length >= limit) break;

			const lang = detectLanguageFromPath(relPath);
			if (!lang) continue;

			// Build structural query for this language
			const queryStr = buildStructuralQuery(intent.intent, entityName, lang);
			if (!queryStr) continue;

			try {
				const absPath = resolve(this.workspaceRoot, relPath);
				let source: string;
				try {
					source = readFileSync(absPath, "utf-8");
				} catch {
					continue;
				}

				const tree = await this.parserManager.parse(source, lang);
				if (!tree || signal.aborted) continue;

				const langObj = await this.parserManager.getLanguageObject(lang);
				if (!langObj || signal.aborted) continue;

				let tsQuery: Query;
				try {
					tsQuery = new Query(langObj, queryStr);
				} catch {
					// Invalid query for this language version — skip
					continue;
				}

				const captures = tsQuery.captures(tree.rootNode);
				if (captures.length === 0) continue;

				// Group captures by the outermost node (the @decl or @call or @class capture)
				// We want the node that wraps the match, not just the name node
				const outerCaptures = captures.filter(
					(c) =>
						c.name === "decl" ||
						c.name === "call" ||
						c.name === "class" ||
						c.name === "chunk",
				);

				// If no outer captures, use all captures as fallback
				const matchCaptures =
					outerCaptures.length > 0 ? outerCaptures : captures;

				for (const capture of matchCaptures) {
					if (results.length >= limit) break;

					const node = capture.node;
					const startLine = node.startPosition.row + 1;
					const endLine = node.endPosition.row + 1;
					const snippet = node.text.slice(0, 800);

					results.push({
						file: relPath,
						startLine,
						endLine,
						symbol: entityName,
						snippet,
						score: 1.0,
						backend: this.name,
					});
				}
			} catch {}
		}

		// Normalize scores
		if (results.length > 1) {
			results.forEach((r, idx) => {
				r.score = 1 - idx / results.length;
			});
		}

		return results;
	}
}
