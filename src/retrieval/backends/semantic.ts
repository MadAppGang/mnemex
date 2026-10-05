/**
 * Semantic Backend
 *
 * Wraps `Indexer.searchScoped()` (vector + BM25 hybrid, plus the local dirty
 * overlay). Activated for: semantic, similarity, location
 *
 * `searchScoped`, not `search`: the response-level facts — the overlay report
 * (step 3, R3.9) and `branchUnknown` — are properties of the RESPONSE, and
 * `ISearchBackend.search()` returns rows only. They leave through the
 * per-request {@link SemanticBackendHooks.onScoped} sink (revision 1, HIGH 7),
 * so neither `ISearchBackend` nor the orchestrator changes and nothing is
 * module-level state: backends are constructed per request.
 */

import type { Indexer } from "../../core/indexer.js";
import type { SearchOverlayReport } from "../../core/overlay/types.js";
import type { QueryClassification } from "../../types.js";
import type {
	BackendName,
	BackendResult,
	ISearchBackend,
	SearchOptions,
} from "../pipeline/types.js";

/** What one semantic search learned about the response, for its caller. */
export interface SemanticScopedReport {
	readonly overlay: SearchOverlayReport;
	readonly branchUnknown: boolean;
}

export interface SemanticBackendHooks {
	/** Called once per search that reached `searchScoped` and returned. */
	readonly onScoped?: (report: SemanticScopedReport) => void;
}

/** The two members this backend uses: a narrow seam a test can satisfy. */
export type SemanticIndexer = Pick<Indexer, "searchScoped" | "close">;

export class SemanticBackend implements ISearchBackend {
	readonly name: BackendName = "semantic";

	constructor(
		private createIndexer: () => SemanticIndexer,
		private readonly hooks: SemanticBackendHooks = {},
	) {}

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
			const scoped = await indexer.searchScoped(query, {
				limit,
				useCase: "search",
			});
			const searchResults = scoped.results;

			if (signal.aborted) return [];

			// AFTER the abort check (review 1, LOW 9c): a report reaches the
			// response only with the rows it describes. An aborted backend
			// contributes no rows, so it reports nothing either, and the MCP
			// response says `unreported` rather than `on, files: N` over a
			// result list with no `source: "dirty"` row in it.
			this.hooks.onScoped?.({
				overlay: scoped.overlay,
				branchUnknown: scoped.branchUnknown,
			});

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

			// Observations are returned like any other result. `id` is the
			// chunk digest: merge uses it only for results with no usable code
			// anchor (observations, stored with startLine 0) — anchored results
			// key on file:startLine so they fuse with the other backends.
			return filtered.map((r): BackendResult => {
				return {
					id: r.chunk.id,
					file: r.chunk.filePath,
					startLine: r.chunk.startLine,
					endLine: r.chunk.endLine,
					symbol: r.chunk.name ?? undefined,
					snippet: r.chunk.content.slice(0, 800),
					score: r.score / normalizer,
					backend: backendName,
					documentType: r.documentType,
					observationMetadata: r.observationMetadata,
					// `"dirty"` only; the cloud's values never reach this backend.
					...(r.source === "dirty" ? { source: "dirty" as const } : {}),
				};
			});
		} finally {
			await indexer.close().catch(() => {});
		}
	}
}
