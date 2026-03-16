/**
 * Symbol Graph Backend
 *
 * Searches the AST reference graph for symbol definitions.
 * Activated for: symbol_lookup, structural
 */

import type { ReferenceGraphManager } from "../../core/reference-graph.js";
import type { QueryClassification } from "../../types.js";
import type {
	BackendResult,
	ISearchBackend,
	SearchOptions,
} from "../pipeline/types.js";
import { readSymbolBody } from "./utils/read-body.js";

export class SymbolGraphBackend implements ISearchBackend {
	readonly name = "symbol-graph" as const;

	constructor(
		private graphManager: ReferenceGraphManager,
		private workspaceRoot: string,
	) {}

	async search(
		query: string,
		intent: QueryClassification,
		options: SearchOptions,
		signal: AbortSignal,
	): Promise<BackendResult[]> {
		if (signal.aborted) return [];

		const limit = options.limit ?? 10;
		const results: BackendResult[] = [];

		// Try to find the symbol by name (use extracted entities or query itself)
		const names =
			intent.extractedEntities.length > 0 ? intent.extractedEntities : [query];

		for (const name of names) {
			if (signal.aborted) break;

			const found = this.graphManager.findSymbol(name, {
				preferExported: true,
			});
			if (!found) continue;

			// Read body from disk
			const bodyResult = readSymbolBody(
				this.workspaceRoot,
				found.filePath,
				found.startLine,
				found.endLine,
			);

			const snippet = (found.signature ?? found.name).slice(0, 800);

			results.push({
				file: found.filePath,
				startLine: found.startLine,
				endLine: found.endLine,
				symbol: found.name,
				body: bodyResult.body ?? undefined,
				snippet,
				score:
					found.pagerankScore > 0
						? Math.min(found.pagerankScore * 100, 1)
						: 0.5,
				backend: this.name,
			});

			if (results.length >= limit) break;
		}

		return results;
	}
}
