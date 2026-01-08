/**
 * Code Analyzer
 *
 * High-level code analysis operations:
 * - Dead code detection
 * - Test coverage gaps
 * - Change impact analysis
 */

import type { FileTracker } from "../tracker.js";
import type { SymbolDefinition } from "../../types.js";
import {
	createReferenceGraphManager,
	type ReferenceGraphManager,
} from "../reference-graph.js";
import {
	createTestFileDetector,
	type TestFileDetector,
} from "./test-detector.js";

// ============================================================================
// Types
// ============================================================================

export interface DeadCodeResult {
	symbol: SymbolDefinition;
	reason: "no_callers" | "low_pagerank" | "both";
}

export interface TestGapResult {
	symbol: SymbolDefinition;
	callerCount: number;
	testCallerCount: number;
}

export interface ImpactResult {
	symbol: SymbolDefinition;
	depth: number;
}

export interface ImpactAnalysis {
	target: SymbolDefinition;
	directCallers: SymbolDefinition[];
	transitiveCallers: ImpactResult[];
	byFile: Map<string, ImpactResult[]>;
	totalAffected: number;
}

export interface DeadCodeOptions {
	/** Maximum PageRank score to consider as dead (default: 0.001) */
	maxPageRank?: number;
	/** Only include unexported symbols (default: true) */
	unexportedOnly?: boolean;
	/** Exclude test files from results (default: true) */
	excludeTestFiles?: boolean;
	/** Maximum results to return (default: 100) */
	limit?: number;
}

export interface TestGapOptions {
	/** Minimum PageRank score to consider (default: 0.01) */
	minPageRank?: number;
	/** Maximum results to return (default: 50) */
	limit?: number;
	/** Symbol kinds to include (default: all) */
	kinds?: string[];
}

export interface ImpactOptions {
	/** Maximum depth for transitive analysis (default: 10) */
	maxDepth?: number;
	/** Include test files in impact (default: true) */
	includeTestFiles?: boolean;
	/** Group results by file (default: true) */
	groupByFile?: boolean;
}

// ============================================================================
// Code Analyzer Class
// ============================================================================

export class CodeAnalyzer {
	private tracker: FileTracker;
	private graphManager: ReferenceGraphManager;
	private testDetector: TestFileDetector;

	constructor(tracker: FileTracker) {
		this.tracker = tracker;
		this.graphManager = createReferenceGraphManager(tracker);
		this.testDetector = createTestFileDetector();
	}

	// ========================================================================
	// Dead Code Detection
	// ========================================================================

	/**
	 * Find dead code: unexported symbols with zero callers and low PageRank
	 */
	findDeadCode(options: DeadCodeOptions = {}): DeadCodeResult[] {
		const {
			maxPageRank = 0.001,
			unexportedOnly = true,
			excludeTestFiles = true,
			limit = 100,
		} = options;

		const allSymbols = this.tracker.getAllSymbols();
		const results: DeadCodeResult[] = [];

		for (const symbol of allSymbols) {
			// Skip exported symbols if unexportedOnly is set
			if (unexportedOnly && symbol.isExported) {
				continue;
			}

			// Skip test files if requested
			if (excludeTestFiles && this.testDetector.isTestFile(symbol.filePath)) {
				continue;
			}

			const callers = this.graphManager.getCallers(symbol.id);
			const hasNoCallers = callers.length === 0;
			const hasLowPageRank = symbol.pagerankScore <= maxPageRank;

			// Must have both: zero callers AND low PageRank
			if (hasNoCallers && hasLowPageRank) {
				results.push({
					symbol,
					reason: "both",
				});
			}
		}

		// Sort by PageRank (lowest first - most likely dead)
		results.sort((a, b) => a.symbol.pagerankScore - b.symbol.pagerankScore);

		return results.slice(0, limit);
	}

	// ========================================================================
	// Test Coverage Gap Detection
	// ========================================================================

	/**
	 * Find test gaps: high PageRank symbols not called by any test file
	 */
	findTestGaps(options: TestGapOptions = {}): TestGapResult[] {
		const { minPageRank = 0.01, limit = 50, kinds } = options;

		const allSymbols = this.tracker.getAllSymbols();
		const results: TestGapResult[] = [];

		for (const symbol of allSymbols) {
			// Skip low PageRank symbols
			if (symbol.pagerankScore < minPageRank) {
				continue;
			}

			// Skip symbols in test files (they don't need tests themselves)
			if (this.testDetector.isTestFile(symbol.filePath)) {
				continue;
			}

			// Skip if kind filter is set and doesn't match
			if (kinds && !kinds.includes(symbol.kind)) {
				continue;
			}

			const callers = this.graphManager.getCallers(symbol.id);
			const testCallers = callers.filter((c) =>
				this.testDetector.isTestFile(c.filePath),
			);

			// Only include symbols with NO test callers
			if (testCallers.length === 0) {
				results.push({
					symbol,
					callerCount: callers.length,
					testCallerCount: 0,
				});
			}
		}

		// Sort by PageRank (highest first - most important gaps)
		results.sort((a, b) => b.symbol.pagerankScore - a.symbol.pagerankScore);

		return results.slice(0, limit);
	}

	// ========================================================================
	// Impact Analysis
	// ========================================================================

	/**
	 * Analyze the impact of changing a symbol
	 * Returns direct callers, transitive callers, and file grouping
	 */
	findImpact(
		symbolId: string,
		options: ImpactOptions = {},
	): ImpactAnalysis | null {
		const {
			maxDepth = 10,
			includeTestFiles = true,
			groupByFile = true,
		} = options;

		const target = this.tracker.getSymbol(symbolId);
		if (!target) {
			return null;
		}

		// Get direct callers
		const directCallers = this.graphManager.getCallers(symbolId);

		// Get transitive callers via BFS
		const transitiveCallers = this.getTransitiveCallers(symbolId, maxDepth);

		// Filter out test files if requested
		let filteredCallers = transitiveCallers;
		if (!includeTestFiles) {
			filteredCallers = transitiveCallers.filter(
				(r) => !this.testDetector.isTestFile(r.symbol.filePath),
			);
		}

		// Group by file
		const byFile = new Map<string, ImpactResult[]>();
		if (groupByFile) {
			for (const result of filteredCallers) {
				const filePath = result.symbol.filePath;
				if (!byFile.has(filePath)) {
					byFile.set(filePath, []);
				}
				byFile.get(filePath)!.push(result);
			}

			// Sort symbols within each file by line number
			for (const results of byFile.values()) {
				results.sort((a, b) => a.symbol.startLine - b.symbol.startLine);
			}
		}

		return {
			target,
			directCallers,
			transitiveCallers: filteredCallers,
			byFile,
			totalAffected: filteredCallers.length,
		};
	}

	/**
	 * Find a symbol by name for impact analysis
	 */
	findSymbolForImpact(
		name: string,
		fileHint?: string,
	): SymbolDefinition | null {
		return this.graphManager.findSymbol(name, {
			preferExported: true,
			fileHint,
		});
	}

	// ========================================================================
	// Statistics
	// ========================================================================

	/**
	 * Get analysis statistics
	 */
	getStats(): {
		totalSymbols: number;
		totalTestSymbols: number;
		totalProductionSymbols: number;
		avgPageRank: number;
		symbolsWithNoCallers: number;
	} {
		const allSymbols = this.tracker.getAllSymbols();
		let testSymbols = 0;
		let symbolsWithNoCallers = 0;
		let totalPageRank = 0;

		for (const symbol of allSymbols) {
			if (this.testDetector.isTestFile(symbol.filePath)) {
				testSymbols++;
			}
			totalPageRank += symbol.pagerankScore;

			const callers = this.graphManager.getCallers(symbol.id);
			if (callers.length === 0) {
				symbolsWithNoCallers++;
			}
		}

		return {
			totalSymbols: allSymbols.length,
			totalTestSymbols: testSymbols,
			totalProductionSymbols: allSymbols.length - testSymbols,
			avgPageRank:
				allSymbols.length > 0 ? totalPageRank / allSymbols.length : 0,
			symbolsWithNoCallers,
		};
	}

	// ========================================================================
	// Private Methods
	// ========================================================================

	/**
	 * Get all transitive callers using BFS
	 */
	private getTransitiveCallers(
		symbolId: string,
		maxDepth: number,
	): ImpactResult[] {
		const results: ImpactResult[] = [];
		const visited = new Set<string>();
		const queue: Array<{ id: string; depth: number }> = [];

		// Start with direct callers
		const directCallers = this.graphManager.getCallers(symbolId);
		for (const caller of directCallers) {
			queue.push({ id: caller.id, depth: 1 });
			visited.add(caller.id);
			results.push({ symbol: caller, depth: 1 });
		}

		// BFS traversal
		while (queue.length > 0) {
			const current = queue.shift()!;

			if (current.depth >= maxDepth) {
				continue;
			}

			const callers = this.graphManager.getCallers(current.id);
			for (const caller of callers) {
				if (!visited.has(caller.id)) {
					visited.add(caller.id);
					const newDepth = current.depth + 1;
					queue.push({ id: caller.id, depth: newDepth });
					results.push({ symbol: caller, depth: newDepth });
				}
			}
		}

		// Sort by depth, then PageRank
		results.sort((a, b) => {
			if (a.depth !== b.depth) {
				return a.depth - b.depth;
			}
			return b.symbol.pagerankScore - a.symbol.pagerankScore;
		});

		return results;
	}
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a code analyzer instance
 */
export function createCodeAnalyzer(tracker: FileTracker): CodeAnalyzer {
	return new CodeAnalyzer(tracker);
}
