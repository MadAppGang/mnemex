/**
 * An overlay report for test stand-ins of `Indexer.searchScoped` (step 3,
 * phase 6). `BranchScopedSearch.overlay` is ALWAYS present, so a stub that
 * omits it describes a search the real indexer can never return.
 */

import type { SearchOverlayReport } from "../../src/core/overlay/types.js";

export function stubOverlayReport(
	overrides: Partial<SearchOverlayReport> = {},
): SearchOverlayReport {
	return {
		state: "off",
		reason: "flag",
		files: 0,
		filesIndexCurrent: 0,
		filesDeleted: 0,
		filesPending: 0,
		filesFailed: 0,
		filesUnclassified: 0,
		rebuilt: 0,
		embedded: 0,
		cacheHits: 0,
		rebuildMs: 0,
		gaps: [],
		gapDetails: [],
		suppressedRows: 0,
		...overrides,
	};
}
