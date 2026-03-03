/**
 * TraceCollector — post-processes MergedSearchResult[] for test assertions.
 *
 * Pure in-process data structure. No async, no I/O.
 * Receives the final MergedSearchResult[] after the full search pipeline
 * completes and indexes/summarizes it for per-result assertions.
 */

import type { MergedSearchResult } from "../../../../src/cloud/merger.js";

// ============================================================================
// Types
// ============================================================================

export interface TraceSummary {
	total: number;
	cloudCount: number;
	overlayCount: number;
	/** filePath → source of the last-recorded result for that file */
	byFile: Record<string, "cloud" | "overlay">;
}

// ============================================================================
// TraceCollector
// ============================================================================

export class TraceCollector {
	private _results: MergedSearchResult[] = [];
	private _byFile: Map<string, "cloud" | "overlay"> = new Map();

	/**
	 * Append results to the collector.
	 * Updates the per-file attribution map (last result for a file wins).
	 */
	record(results: MergedSearchResult[]): void {
		for (const r of results) {
			this._results.push(r);
			this._byFile.set(r.chunk.filePath, r.source);
		}
	}

	/** Cloud results only */
	getCloudResults(): MergedSearchResult[] {
		return this._results.filter((r) => r.source === "cloud");
	}

	/** Overlay results only */
	getOverlayResults(): MergedSearchResult[] {
		return this._results.filter((r) => r.source === "overlay");
	}

	/** All results matching a specific file path */
	getByFile(filePath: string): MergedSearchResult[] {
		return this._results.filter((r) => r.chunk.filePath === filePath);
	}

	/** The source attribution for a specific file (last recorded result wins) */
	getSourceForFile(filePath: string): "cloud" | "overlay" | undefined {
		return this._byFile.get(filePath);
	}

	/** Full summary of all recorded results */
	get summary(): TraceSummary {
		const byFileRecord: Record<string, "cloud" | "overlay"> = {};
		for (const [k, v] of this._byFile) {
			byFileRecord[k] = v;
		}
		return {
			total: this._results.length,
			cloudCount: this._results.filter((r) => r.source === "cloud").length,
			overlayCount: this._results.filter((r) => r.source === "overlay").length,
			byFile: byFileRecord,
		};
	}

	/** All raw results in record order */
	get allResults(): MergedSearchResult[] {
		return [...this._results];
	}

	/** Per-file attribution map */
	get byFile(): Map<string, "cloud" | "overlay"> {
		return new Map(this._byFile);
	}

	/** Clear all state (call between sub-searches within a single test) */
	reset(): void {
		this._results = [];
		this._byFile = new Map();
	}
}
