/**
 * useGraph Hook
 *
 * Manages the symbol reference graph state.
 * Supports drill-in navigation with history (back/forward).
 */

import { useCallback, useState } from "react";
import { createReferenceGraphManager } from "../../core/reference-graph.js";
import type { FileTracker } from "../../core/tracker.js";
import type { SymbolDefinition } from "../../types.js";

// ============================================================================
// Types
// ============================================================================

export interface UseGraphReturn {
	focusedSymbol: SymbolDefinition | null;
	callers: SymbolDefinition[];
	callees: SymbolDefinition[];
	loading: boolean;
	error: string | null;
	/** Navigate to a symbol by name */
	focusSymbol: (name: string) => Promise<void>;
	/** Go back in history */
	goBack: () => void;
	/** Go forward in history */
	goForward: () => void;
	canGoBack: boolean;
	canGoForward: boolean;
	historyLength: number;
}

// ============================================================================
// Hook
// ============================================================================

export function useGraph(
	tracker: FileTracker,
	branchId: number,
): UseGraphReturn {
	const [navHistory, setNavHistory] = useState<SymbolDefinition[]>([]);
	const [navIndex, setNavIndex] = useState(-1);
	const [callers, setCallers] = useState<SymbolDefinition[]>([]);
	const [callees, setCallees] = useState<SymbolDefinition[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const loadSymbolInfo = useCallback(
		async (symbol: SymbolDefinition) => {
			setLoading(true);
			setError(null);
			try {
				const graphManager = createReferenceGraphManager(tracker, branchId);
				await graphManager.buildGraph();

				// Get callers and callees by symbol ID
				const callerSymbols = graphManager.getCallers(symbol.id);
				const calleeSymbols = graphManager.getCallees(symbol.id);

				setCallers(callerSymbols);
				setCallees(calleeSymbols);
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			} finally {
				setLoading(false);
			}
		},
		[tracker],
	);

	const focusedSymbol = navIndex >= 0 ? (navHistory[navIndex] ?? null) : null;

	const focusSymbol = useCallback(
		async (name: string) => {
			setLoading(true);
			setError(null);

			try {
				const graphManager = createReferenceGraphManager(tracker, branchId);
				await graphManager.buildGraph();
				const found = graphManager.findSymbol(name);

				if (!found) {
					setError(`Symbol not found: ${name}`);
					setLoading(false);
					return;
				}

				// Truncate forward history when navigating to a new symbol
				setNavHistory((prev: SymbolDefinition[]) => {
					const newHistory = prev.slice(0, navIndex + 1);
					return [...newHistory, found];
				});
				setNavIndex((prev: number) => prev + 1);

				await loadSymbolInfo(found);
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
				setLoading(false);
			}
		},
		[navIndex, loadSymbolInfo, tracker],
	);

	const goBack = useCallback(() => {
		if (navIndex <= 0) return;
		const newIndex = navIndex - 1;
		setNavIndex(newIndex);
		const symbol = navHistory[newIndex];
		if (symbol) {
			loadSymbolInfo(symbol);
		}
	}, [navIndex, navHistory, loadSymbolInfo]);

	const goForward = useCallback(() => {
		if (navIndex >= navHistory.length - 1) return;
		const newIndex = navIndex + 1;
		setNavIndex(newIndex);
		const symbol = navHistory[newIndex];
		if (symbol) {
			loadSymbolInfo(symbol);
		}
	}, [navIndex, navHistory, loadSymbolInfo]);

	return {
		focusedSymbol,
		callers,
		callees,
		loading,
		error,
		focusSymbol,
		goBack,
		goForward,
		canGoBack: navIndex > 0,
		canGoForward: navIndex < navHistory.length - 1,
		historyLength: navHistory.length,
	};
}
