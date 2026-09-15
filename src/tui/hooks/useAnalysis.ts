/**
 * useAnalysis Hook
 *
 * Manages code analysis state: dead code, test gaps, and impact analysis.
 */

import { useCallback, useEffect, useState } from "react";
import {
	createCodeAnalyzer,
	type DeadCodeResult,
	type ImpactAnalysis,
	type TestGapResult,
} from "../../core/analysis/analyzer.js";
import type { FileTracker } from "../../core/tracker.js";

// ============================================================================
// Types
// ============================================================================

export type AnalysisTab = "dead-code" | "test-gaps" | "impact";

export interface UseAnalysisReturn {
	deadCode: DeadCodeResult[];
	testGaps: TestGapResult[];
	impact: ImpactAnalysis | null;
	activeTab: AnalysisTab;
	setActiveTab: (tab: AnalysisTab) => void;
	loading: boolean;
	error: string | null;
	analyzeImpact: (symbolName: string, maxDepth?: number) => void;
	refreshDeadCode: () => void;
	refreshTestGaps: () => void;
}

// ============================================================================
// Hook
// ============================================================================

export function useAnalysis(
	tracker: FileTracker,
	branchId: number,
): UseAnalysisReturn {
	const [deadCode, setDeadCode] = useState<DeadCodeResult[]>([]);
	const [testGaps, setTestGaps] = useState<TestGapResult[]>([]);
	const [impact, setImpact] = useState<ImpactAnalysis | null>(null);
	const [activeTab, setActiveTab] = useState<AnalysisTab>("dead-code");
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [deadCodeTick, setDeadCodeTick] = useState(0);
	const [testGapsTick, setTestGapsTick] = useState(0);

	// Load dead code on mount/refresh
	const loadDeadCode = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const analyzer = createCodeAnalyzer(tracker, branchId);
			const results = analyzer.findDeadCode({ limit: 100 });
			setDeadCode(results);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}, [tracker, deadCodeTick]);

	// Load test gaps on mount/refresh
	const loadTestGaps = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const analyzer = createCodeAnalyzer(tracker, branchId);
			const results = analyzer.findTestGaps({ limit: 50 });
			setTestGaps(results);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoading(false);
		}
	}, [tracker, testGapsTick]);

	useEffect(() => {
		if (activeTab === "dead-code") {
			loadDeadCode();
		} else if (activeTab === "test-gaps") {
			loadTestGaps();
		}
	}, [activeTab, loadDeadCode, loadTestGaps]);

	const analyzeImpact = useCallback(
		(symbolName: string, maxDepth = 10) => {
			setLoading(true);
			setError(null);
			try {
				const analyzer = createCodeAnalyzer(tracker, branchId);
				// Find the symbol first, then analyze impact
				const symbol = analyzer.findSymbolForImpact(symbolName);
				if (!symbol) {
					setError(`Symbol not found: ${symbolName}`);
					setLoading(false);
					return;
				}
				const result = analyzer.findImpact(symbol.id, { maxDepth });
				setImpact(result);
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			} finally {
				setLoading(false);
			}
		},
		[tracker],
	);

	const refreshDeadCode = useCallback(() => {
		setDeadCodeTick((n: number) => n + 1);
	}, []);

	const refreshTestGaps = useCallback(() => {
		setTestGapsTick((n: number) => n + 1);
	}, []);

	return {
		deadCode,
		testGaps,
		impact,
		activeTab,
		setActiveTab,
		loading,
		error,
		analyzeImpact,
		refreshDeadCode,
		refreshTestGaps,
	};
}
