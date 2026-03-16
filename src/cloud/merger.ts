/**
 * OverlayMerger — merges cloud search results with local overlay results
 *
 * The merge strategy:
 *  1. Convert CloudSearchResult → SearchResult (with synthetic CodeChunk)
 *  2. Filter cloud results whose filePath is in dirtyFilePaths (belt-and-suspenders,
 *     since the cloud API should already have suppressed those paths)
 *  3. Normalise cloud scores and overlay scores independently to [0, 1]
 *     using min-max normalisation
 *  4. Tag each result with source: "cloud" | "overlay"
 *  5. Merge, sort by normalised score descending, slice to limit
 */

import type { SearchResult } from "../types.js";
import type { CloudSearchResult } from "./types.js";

// ============================================================================
// Types
// ============================================================================

export interface MergedSearchResult extends SearchResult {
	/** Whether this result came from the cloud index or the local overlay */
	source: "cloud" | "overlay";
}

// ============================================================================
// OverlayMerger
// ============================================================================

export class OverlayMerger {
	/**
	 * Merge cloud and overlay results into a single ranked list.
	 *
	 * @param cloudResults    Results from the cloud API (may already exclude dirty paths)
	 * @param overlayResults  Results from the local overlay index (dirty files only)
	 * @param dirtyFilePaths  Paths of dirty files (for belt-and-suspenders filtering)
	 * @param limit           Maximum number of results to return (default: 10)
	 */
	static merge(
		cloudResults: CloudSearchResult[],
		overlayResults: SearchResult[],
		dirtyFilePaths: string[],
		limit = 10,
	): MergedSearchResult[] {
		const dirtySet = new Set(dirtyFilePaths);

		// ── Step 1: Filter cloud results for dirty files ────────────────────
		const filteredCloud = cloudResults.filter((r) => !dirtySet.has(r.filePath));

		// ── Step 2: Convert cloud results → SearchResult ────────────────────
		const cloudAsSearchResults: Array<{
			result: SearchResult;
			rawScore: number;
		}> = filteredCloud.map((r) => ({
			result: cloudResultToSearchResult(r),
			rawScore: r.score,
		}));

		const overlayAsSearchResults: Array<{
			result: SearchResult;
			rawScore: number;
		}> = overlayResults.map((r) => ({
			result: r,
			rawScore: r.score,
		}));

		// ── Step 3: Handle fully empty case ──────────────────────────────────
		if (
			cloudAsSearchResults.length === 0 &&
			overlayAsSearchResults.length === 0
		) {
			return [];
		}

		// ── Step 4: Normalise scores independently ───────────────────────────
		//
		// Always normalise — even in single-source cases — so that:
		//  - A single result normalises to score 1.0
		//  - Identical scores all normalise to 1.0
		//  - Results are always sorted by normalised score
		const normaliseScores = (
			items: Array<{ result: SearchResult; rawScore: number }>,
		): number[] => {
			if (items.length === 0) return [];
			const scores = items.map((i) => i.rawScore);
			const min = Math.min(...scores);
			const max = Math.max(...scores);
			if (max === min) {
				// All identical (or single item) — normalise to 1.0
				return scores.map(() => 1.0);
			}
			return scores.map((s) => (s - min) / (max - min));
		};

		const cloudNormalised = normaliseScores(cloudAsSearchResults);
		const overlayNormalised = normaliseScores(overlayAsSearchResults);

		// ── Step 5: Tag and combine ──────────────────────────────────────────
		const tagged: MergedSearchResult[] = [];

		for (let i = 0; i < cloudAsSearchResults.length; i++) {
			tagged.push({
				...cloudAsSearchResults[i].result,
				score: cloudNormalised[i],
				source: "cloud",
			});
		}

		for (let i = 0; i < overlayAsSearchResults.length; i++) {
			tagged.push({
				...overlayAsSearchResults[i].result,
				score: overlayNormalised[i],
				source: "overlay",
			});
		}

		// ── Step 6: Sort by normalised score descending and slice ────────────
		tagged.sort((a, b) => b.score - a.score);
		return tagged.slice(0, limit);
	}
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Convert a CloudSearchResult into a SearchResult, constructing a synthetic
 * CodeChunk from the available metadata.
 *
 * Cloud results do not carry the full source text — the CodeChunk.content
 * is left empty. Callers that need source text should fetch it separately.
 */
function cloudResultToSearchResult(r: CloudSearchResult): SearchResult {
	return {
		chunk: {
			// Use contentHash as a stable ID (no position ambiguity for cloud chunks)
			id: r.contentHash,
			contentHash: r.contentHash,
			content: "", // Source text not available from cloud search response
			filePath: r.filePath,
			startLine: r.startLine,
			endLine: r.endLine,
			language: r.language,
			chunkType: r.chunkType as import("../types.js").ChunkType,
			name: r.name,
			fileHash: "", // Not available from cloud
		},
		score: r.score,
		vectorScore: r.score, // Cloud returns a combined score; use it for both
		keywordScore: 0,
		summary: r.summary,
	};
}
