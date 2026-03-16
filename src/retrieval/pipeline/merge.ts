/**
 * RRF Merge
 *
 * Merges results from multiple backends using Reciprocal Rank Fusion.
 */

import type { PipelineConfig } from "./config.js";
import type { BackendName, BackendResult, MergedResult } from "./types.js";

// ============================================================================
// RRF Merge Function
// ============================================================================

/**
 * Merge results from multiple backends using Reciprocal Rank Fusion.
 *
 * Key by "file:startLine", accumulate weighted RRF scores across backends.
 * isDefinitive override: force rrfScore = Infinity (always rank 0).
 */
export function rrfMerge(
	backendResults: Array<{ name: BackendName; results: BackendResult[] }>,
	config: Pick<PipelineConfig, "rrfK" | "backendWeights">,
	limit: number,
): MergedResult[] {
	const k = config.rrfK;

	// Build weight lookup
	const weightMap: Record<BackendName, number> = {
		"symbol-graph": config.backendWeights.symbolGraph,
		lsp: config.backendWeights.lsp,
		"tree-sitter": config.backendWeights.treeSitter,
		semantic: config.backendWeights.semantic,
		location: config.backendWeights.location,
	};

	// Map from "file:startLine" → MergedResult
	const merged = new Map<string, MergedResult>();

	for (const { name, results } of backendResults) {
		const weight = weightMap[name] ?? 1.0;

		for (let rank = 0; rank < results.length; rank++) {
			const result = results[rank];
			const key = `${result.file}:${result.startLine}`;

			const contribution = weight / (k + rank);

			const existing = merged.get(key);
			if (existing) {
				// Accumulate score
				existing.rrfScore += contribution;
				// Add backend if not already present
				if (!existing.backends.includes(name)) {
					existing.backends.push(name);
				}
				// Merge optional fields from this backend if not already set
				if (!existing.endLine && result.endLine) {
					existing.endLine = result.endLine;
				}
				if (!existing.symbol && result.symbol) {
					existing.symbol = result.symbol;
				}
				if (!existing.body && result.body) {
					existing.body = result.body;
				}
				// isDefinitive override — if any backend says definitive, mark it
				if (result.isDefinitive) {
					existing.isDefinitive = true;
				}
			} else {
				// New entry
				merged.set(key, {
					...result,
					rrfScore: contribution,
					backends: [name],
				});
			}
		}
	}

	// Apply isDefinitive override: force rrfScore = Infinity
	for (const result of merged.values()) {
		if (result.isDefinitive) {
			result.rrfScore = Number.POSITIVE_INFINITY;
		}
	}

	// Sort descending by rrfScore
	const sorted = Array.from(merged.values()).sort(
		(a, b) => b.rrfScore - a.rrfScore,
	);

	return sorted.slice(0, limit);
}
