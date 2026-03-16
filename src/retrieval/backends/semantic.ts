/**
 * Semantic Backend
 *
 * Wraps the existing Indexer.search() (vector + BM25 hybrid) call.
 * Activated for: semantic, similarity, location
 */

import type { Indexer } from "../../core/indexer.js";
import type { QueryClassification } from "../../types.js";
import type {
	BackendName,
	BackendResult,
	ISearchBackend,
	SearchOptions,
} from "../pipeline/types.js";

export class SemanticBackend implements ISearchBackend {
	readonly name: BackendName = "semantic";

	constructor(private createIndexer: () => Indexer) {}

	async search(
		query: string,
		_intent: QueryClassification,
		options: SearchOptions,
		signal: AbortSignal,
	): Promise<BackendResult[]> {
		if (signal.aborted) return [];

		const limit = options.limit ?? 10;
		const indexer = this.createIndexer();
		const backendName = this.name;

		try {
			const searchResults = await indexer.search(query, {
				limit,
				useCase: "search",
			});

			if (signal.aborted) return [];

			// Filter by filePattern if provided
			const filePattern = options.filePattern;
			const filtered = filePattern
				? searchResults.filter((r) => {
						const pat = filePattern
							.replace(/\*\*/g, ".*")
							.replace(/\*/g, "[^/]*");
						return new RegExp(pat).test(r.chunk.filePath);
					})
				: searchResults;

			if (filtered.length === 0) return [];

			// Normalize scores to [0, 1] by dividing by max score
			const maxScore = Math.max(...filtered.map((r) => r.score));
			const normalizer = maxScore > 0 ? maxScore : 1;

			return filtered
				.map((r): BackendResult | null => {
					if (r.documentType === "session_observation") {
						// Skip observation results — they have no file location
						return null;
					}
					return {
						file: r.chunk.filePath,
						startLine: r.chunk.startLine,
						endLine: r.chunk.endLine,
						symbol: r.chunk.name ?? undefined,
						snippet: r.chunk.content.slice(0, 800),
						score: r.score / normalizer,
						backend: backendName,
					};
				})
				.filter((r): r is BackendResult => r !== null);
		} finally {
			await indexer.close().catch(() => {});
		}
	}
}
