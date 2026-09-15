/**
 * useRepoMap Hook
 *
 * Loads and manages the structured repository map.
 * Supports filtering and expanding/collapsing file paths.
 */

import { useCallback, useEffect, useState } from "react";
import { createRepoMapGenerator } from "../../core/repo-map.js";
import type { FileTracker } from "../../core/tracker.js";
import type { RepoMapEntry } from "../../types.js";

// ============================================================================
// Types
// ============================================================================

export interface UseRepoMapReturn {
	entries: RepoMapEntry[];
	filter: string;
	setFilter: (f: string) => void;
	expandedPaths: Set<string>;
	togglePath: (path: string) => void;
	loading: boolean;
	error: string | null;
	refresh: () => void;
}

// ============================================================================
// Hook
// ============================================================================

export function useRepoMap(
	tracker: FileTracker,
	branchId: number,
): UseRepoMapReturn {
	const [entries, setEntries] = useState<RepoMapEntry[]>([]);
	const [filter, setFilter] = useState("");
	const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [refreshTick, setRefreshTick] = useState(0);

	const loadMap = useCallback(async () => {
		setLoading(true);
		setError(null);

		try {
			const generator = createRepoMapGenerator(tracker, branchId);
			const allEntries = generator.generateStructured({
				pathPattern: filter || undefined,
				topNByPagerank: 5000,
			});
			setEntries(allEntries);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}, [tracker, filter, refreshTick]);

	useEffect(() => {
		loadMap();
	}, [loadMap]);

	const togglePath = useCallback((path: string) => {
		setExpandedPaths((prev: Set<string>) => {
			const next = new Set(prev);
			if (next.has(path)) {
				next.delete(path);
			} else {
				next.add(path);
			}
			return next;
		});
	}, []);

	const refresh = useCallback(() => {
		setRefreshTick((n: number) => n + 1);
	}, []);

	return {
		entries,
		filter,
		setFilter,
		expandedPaths,
		togglePath,
		loading,
		error,
		refresh,
	};
}
