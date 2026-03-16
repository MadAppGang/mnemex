/**
 * MockOverlayIndex — implements IOverlayIndex with pre-seeded results.
 *
 * For scenarios where the overlay is not involved (1, 3, 4), provides
 * a no-op overlay that avoids LanceDB disk I/O and speeds up tests.
 *
 * For Scenario 2 (dirty + cloud), setResults() pre-populates what
 * search() will return, bypassing LanceDB entirely.
 */

import type { IOverlayIndex, DirtyFile } from "../../../../src/cloud/types.js";
import type { SearchResult } from "../../../../src/types.js";

// ============================================================================
// MockOverlayIndex
// ============================================================================

export class MockOverlayIndex implements IOverlayIndex {
	private _results: SearchResult[] = [];

	/**
	 * Pre-populate results that search() will return.
	 * Call this before the test's search invocation for Scenario 2.
	 */
	setResults(results: SearchResult[]): void {
		this._results = results;
	}

	async isStale(_dirtyFiles: DirtyFile[]): Promise<boolean> {
		return false;
	}

	async rebuild(
		_dirtyFiles: DirtyFile[],
		_onProgress?: (msg: string) => void,
	): Promise<void> {
		// no-op
	}

	async search(
		_queryVector: number[],
		_queryText: string,
		limit?: number,
	): Promise<SearchResult[]> {
		const cap = limit ?? this._results.length;
		return this._results.slice(0, cap);
	}

	async getStats(): Promise<{ chunkCount: number; fileCount: number }> {
		const files = new Set(this._results.map((r) => r.chunk.filePath));
		return { chunkCount: this._results.length, fileCount: files.size };
	}

	async invalidate(): Promise<void> {
		// no-op
	}

	async close(): Promise<void> {
		// no-op
	}
}
