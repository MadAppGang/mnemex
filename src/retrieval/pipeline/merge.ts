/**
 * Result Fusion
 *
 * Merges results from multiple backends into a single ranked list.
 *
 * Two fusion methods are available (selected via `PipelineConfig.fusionMethod`):
 *
 *   - `rrf`   — Reciprocal Rank Fusion. Fuses on RANK only; score magnitude is
 *               discarded, so a backend that is overwhelmingly confident in its
 *               top hit contributes exactly what a backend that barely
 *               preferred its top hit contributes.
 *   - `tm2c2` — Theoretical Min-Max normalization + Convex Combination
 *               (Bruch, Gai & Ingber, TOIS 2023, arXiv:2210.11934). Fuses on
 *               NORMALIZED SCORE, preserving that margin, and needs one tuned
 *               parameter (the weights) rather than a per-retriever `k` whose
 *               tuned values are documented not to generalize.
 *
 * The default is `rrf`; the switch is gated on an eval.
 */

import type { PipelineConfig } from "./config.js";
import type { BackendName, BackendResult, MergedResult } from "./types.js";

// ============================================================================
// Shared helpers
// ============================================================================

/**
 * Merge key for a result.
 *
 * The rule: **a usable code anchor wins; otherwise the stable id.**
 *
 *   - A result with a usable anchor (non-empty `file` AND a 1-indexed
 *     `startLine`) keys on `file:startLine`. Every backend must agree on the key
 *     for one code location or cross-backend fusion silently stops happening:
 *     only the semantic backend carries an `id` (a sha256 chunk digest), so
 *     preferring the id there would make its hits unmergeable with the four
 *     backends that key on the anchor, emitting one location twice and losing
 *     the consensus boost fusion exists to give.
 *   - Anything else keys on `id` (falling back to `file:startLine` when absent).
 *     Enriched documents are stored with `startLine: 0` (`store.addDocuments`),
 *     so an observation is always in this branch — including one that DOES have
 *     a file, since `observe` sets `filePath` from `affectedFiles[0]` and every
 *     observation about the same file would otherwise collapse into one entry.
 *
 * The two branches cannot collide: real code anchors are 1-indexed everywhere
 * (chunker, tree-sitter, symbol graph, LSP, location), so an observation's
 * `file:0` can never equal a code result's key.
 */
function mergeKey(result: BackendResult): string {
	const anchored = result.file !== "" && result.startLine >= 1;
	if (!anchored && result.id !== undefined) return result.id;
	return `${result.file}:${result.startLine}`;
}

/** Build the backend → weight lookup from config. */
function buildWeightMap(
	config: Pick<PipelineConfig, "backendWeights">,
): Record<BackendName, number> {
	return {
		"symbol-graph": config.backendWeights.symbolGraph,
		lsp: config.backendWeights.lsp,
		"tree-sitter": config.backendWeights.treeSitter,
		semantic: config.backendWeights.semantic,
		location: config.backendWeights.location,
	};
}

/**
 * Add one backend's contribution for `result` into the merge map.
 *
 * Shared by every fusion method — only the `contribution` differs. Accumulates
 * the fused score, records the backend, and carries forward optional fields
 * that this backend knows about but an earlier one did not.
 *
 * NOTE: the field is named `rrfScore` for historical reasons (RRF was the only
 * fusion method when it was introduced). It now holds the FUSED SCORE whatever
 * the method — renaming it would ripple into every consumer of MergedResult.
 */
function accumulate(
	merged: Map<string, MergedResult>,
	name: BackendName,
	result: BackendResult,
	contribution: number,
): void {
	const key = mergeKey(result);
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
		if (!existing.documentType && result.documentType) {
			existing.documentType = result.documentType;
		}
		if (!existing.observationMetadata && result.observationMetadata) {
			existing.observationMetadata = result.observationMetadata;
		}
		// The dirty overlay's marker survives fusion: an uncommitted row merged
		// with another backend's hit at the same anchor is still uncommitted
		// text, and must still say so (step 3, R3.9).
		if (!existing.source && result.source) {
			existing.source = result.source;
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

/**
 * Force definitive matches to the top, then sort descending and truncate.
 *
 * `isDefinitive` (an exact LSP match) always outranks everything else, so its
 * fused score is forced to +Infinity regardless of fusion method.
 */
function finalize(
	merged: Map<string, MergedResult>,
	limit: number,
): MergedResult[] {
	for (const result of merged.values()) {
		if (result.isDefinitive) {
			result.rrfScore = Number.POSITIVE_INFINITY;
		}
	}

	const sorted = Array.from(merged.values()).sort(
		(a, b) => b.rrfScore - a.rrfScore,
	);

	return sorted.slice(0, limit);
}

// ============================================================================
// RRF Merge Function
// ============================================================================

/**
 * Merge results from multiple backends using Reciprocal Rank Fusion.
 *
 * Key by {@link mergeKey} (the code anchor when there is one, else the stable
 * id). Accumulate weighted RRF scores across backends.
 * isDefinitive override: force rrfScore = Infinity (always rank 0).
 */
export function rrfMerge(
	backendResults: Array<{ name: BackendName; results: BackendResult[] }>,
	config: Pick<PipelineConfig, "rrfK" | "backendWeights">,
	limit: number,
): MergedResult[] {
	const k = config.rrfK;
	const weightMap = buildWeightMap(config);

	// Map from merge key ("file:startLine" when anchored, else id) → MergedResult
	const merged = new Map<string, MergedResult>();

	for (const { name, results } of backendResults) {
		const weight = weightMap[name] ?? 1.0;

		for (let rank = 0; rank < results.length; rank++) {
			accumulate(merged, name, results[rank], weight / (k + rank));
		}
	}

	return finalize(merged, limit);
}

// ============================================================================
// TM2C2 Merge Function
// ============================================================================

/**
 * Clamp a backend score into the theoretical [0, 1] range.
 *
 * THEORETICAL, not observed, min-max: `BackendResult.score` is contractually
 * "Normalized score [0, 1] within this backend", so the bounds are known a
 * priori and we clamp rather than re-deriving them from the returned list.
 * Observed-range normalization ((s - min) / (max - min)) would map a
 * single-result list to 1.0 and the worst hit of every list to 0.0, which
 * destroys exactly the magnitude information TM2C2 exists to preserve — and
 * makes the fused score incomparable across queries.
 */
function normalizeScore(score: number): number {
	if (!Number.isFinite(score)) return 0;
	if (score <= 0) return 0;
	if (score >= 1) return 1;
	return score;
}

/**
 * Merge results from multiple backends using TM2C2: theoretical min-max
 * normalization followed by a convex combination of the normalized scores.
 *
 * `finalScore = Σ_b (ŵ_b * normalized(score_b))` where `ŵ` are the configured
 * backend weights renormalized to sum to 1 across the backends that actually
 * returned results. That renormalization is what makes the combination convex,
 * i.e. keeps the fused score in [0, 1] and comparable across queries — a
 * backend that returned nothing contributes 0 and is excluded from the weight
 * denominator so the surviving backends are not silently scaled down.
 *
 * Same keying, carry-forward and isDefinitive semantics as {@link rrfMerge}.
 */
export function tm2c2Merge(
	backendResults: Array<{ name: BackendName; results: BackendResult[] }>,
	config: Pick<PipelineConfig, "backendWeights">,
	limit: number,
): MergedResult[] {
	const weightMap = buildWeightMap(config);

	// Only backends that actually returned results participate in the convex
	// combination — an empty backend must not eat weight mass.
	const active = backendResults.filter(({ results }) => results.length > 0);
	const totalWeight = active.reduce(
		(sum, { name }) => sum + (weightMap[name] ?? 1.0),
		0,
	);

	// Map from merge key ("file:startLine" when anchored, else id) → MergedResult
	const merged = new Map<string, MergedResult>();

	for (const { name, results } of active) {
		// Degenerate config (all weights zero/negative) → fall back to uniform
		// weights so the combination stays convex instead of dividing by zero.
		const normalizedWeight =
			totalWeight > 0
				? (weightMap[name] ?? 1.0) / totalWeight
				: 1 / active.length;

		for (const result of results) {
			accumulate(
				merged,
				name,
				result,
				normalizedWeight * normalizeScore(result.score),
			);
		}
	}

	return finalize(merged, limit);
}
