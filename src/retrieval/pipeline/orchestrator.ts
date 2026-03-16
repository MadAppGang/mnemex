/**
 * Pipeline Orchestrator
 *
 * Routes queries to appropriate backends, fans out in parallel,
 * and merges results using Reciprocal Rank Fusion.
 */

import type { QueryIntent } from "../../types.js";
import type { QueryRouter } from "../routing/query-router.js";
import type { PipelineConfig } from "./config.js";
import { rrfMerge } from "./merge.js";
import type {
	BackendName,
	BackendResult,
	ISearchBackend,
	MergedResult,
	SearchOptions,
} from "./types.js";

// ============================================================================
// Backend → Intent Mapping
// ============================================================================

/** Which backends to activate for each query intent */
const INTENT_BACKENDS: Record<QueryIntent, BackendName[]> = {
	symbol_lookup: ["symbol-graph", "lsp", "semantic"],
	structural: ["symbol-graph", "tree-sitter", "semantic"],
	semantic: ["semantic"],
	similarity: ["semantic"],
	location: ["location", "semantic"],
};

// ============================================================================
// Orchestrator
// ============================================================================

export class PipelineOrchestrator {
	constructor(
		private router: QueryRouter,
		private backends: ISearchBackend[],
		private config: PipelineConfig,
	) {}

	async search(
		query: string,
		options: SearchOptions = {},
	): Promise<MergedResult[]> {
		const limit = options.limit ?? 10;

		// 1. Route query to classify intent
		const { classification } = await this.router.route(query);

		// 2. Select backends based on intent + config
		const intentBackendNames = INTENT_BACKENDS[classification.intent] ?? [
			"semantic",
		];

		// Only activate backends that are both in the intent set and enabled in config
		const selectedBackends = this.backends.filter((b) => {
			if (!intentBackendNames.includes(b.name)) return false;
			return this.isBackendEnabled(b.name);
		});

		if (selectedBackends.length === 0) return [];

		// 3. Create abort controller for short-circuit
		const controller = new AbortController();
		const { signal } = controller;

		// 4. LSP short-circuit logic
		const lspBackend = selectedBackends.find((b) => b.name === "lsp");
		const otherBackends = selectedBackends.filter((b) => b.name !== "lsp");

		const settled: Array<{ name: BackendName; results: BackendResult[] }> = [];

		if (
			lspBackend &&
			this.config.lspShortCircuit &&
			otherBackends.length > 0 &&
			classification.confidence >= this.config.routerMinConfidence
		) {
			// Race: LSP vs. all others
			const lspPromise = lspBackend
				.search(query, classification, options, signal)
				.then((results) => ({ name: lspBackend.name as BackendName, results }))
				.catch(() => ({
					name: lspBackend.name as BackendName,
					results: [] as BackendResult[],
				}));

			const othersPromise = Promise.allSettled(
				otherBackends.map((b) =>
					b.search(query, classification, options, signal).then((results) => ({
						name: b.name,
						results,
					})),
				),
			);

			// Use a manual race: if LSP resolves with definitive first, abort others
			let lspResolved = false;
			let othersResolved = false;
			let lspResult: { name: BackendName; results: BackendResult[] } | null =
				null;
			let othersResult: typeof othersPromise extends Promise<infer T>
				? T
				: never = [] as never;

			await Promise.race([
				lspPromise.then((r) => {
					lspResolved = true;
					lspResult = r;
					const hasDefinitive = r.results.some((res) => res.isDefinitive);
					if (hasDefinitive) {
						controller.abort();
					}
				}),
				othersPromise.then((r) => {
					othersResolved = true;
					othersResult = r;
				}),
			]);

			// Wait for both to complete (one may have finished via race already)
			if (!lspResolved) {
				lspResult = await lspPromise;
			}
			if (!othersResolved) {
				othersResult = await othersPromise;
			}

			// Collect all results
			if (lspResult) {
				settled.push(lspResult);
			}

			for (const settledItem of othersResult) {
				if (settledItem.status === "fulfilled") {
					settled.push(settledItem.value);
				}
				// Rejected backends are silently dropped
			}
		} else {
			// No LSP short-circuit: run all backends in parallel
			const allResults = await Promise.allSettled(
				selectedBackends.map((b) =>
					b.search(query, classification, options, signal).then((results) => ({
						name: b.name as BackendName,
						results,
					})),
				),
			);

			for (const item of allResults) {
				if (item.status === "fulfilled") {
					settled.push(item.value);
				}
			}
		}

		// Abort any still-running backends (no-op if already done)
		controller.abort();

		// 5. RRF merge
		if (settled.length === 0) return [];

		const merged = rrfMerge(settled, this.config, limit);

		// 6. Apply file pattern filter on final merged results (in case some backends didn't)
		if (options.filePattern) {
			const pat = options.filePattern
				.replace(/\*\*/g, ".*")
				.replace(/\*/g, "[^/]*");
			const regex = new RegExp(pat, "i");
			return merged.filter((r) => !r.file || regex.test(r.file));
		}

		return merged;
	}

	private isBackendEnabled(name: BackendName): boolean {
		switch (name) {
			case "symbol-graph":
				return this.config.backends.symbolGraph;
			case "lsp":
				return this.config.backends.lsp;
			case "tree-sitter":
				return this.config.backends.treeSitter;
			case "semantic":
				return this.config.backends.semantic;
			case "location":
				return this.config.backends.location;
			default:
				return false;
		}
	}
}
