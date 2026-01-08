/**
 * Reference Graph Manager
 *
 * Builds and maintains the symbol reference graph.
 * Computes PageRank scores for symbol importance ranking.
 */

import type { FileTracker } from "./tracker.js";
import type { SymbolDefinition, SymbolReference } from "../types.js";

// ============================================================================
// Types
// ============================================================================

interface GraphNode {
	symbol: SymbolDefinition;
	outEdges: Set<string>; // IDs of symbols this symbol references
	inEdges: Set<string>; // IDs of symbols that reference this symbol
}

// ============================================================================
// Reference Graph Manager Class
// ============================================================================

export class ReferenceGraphManager {
	private tracker: FileTracker;
	private graph: Map<string, GraphNode> | null = null;

	constructor(tracker: FileTracker) {
		this.tracker = tracker;
	}

	/**
	 * Build the reference graph from database
	 */
	async buildGraph(): Promise<void> {
		const symbols = this.tracker.getAllSymbols();
		const references = this.tracker.getAllReferences();

		this.graph = new Map();

		// Initialize nodes for all symbols
		for (const symbol of symbols) {
			this.graph.set(symbol.id, {
				symbol,
				outEdges: new Set(),
				inEdges: new Set(),
			});
		}

		// Build edges from resolved references
		for (const ref of references) {
			if (ref.isResolved && ref.toSymbolId) {
				const fromNode = this.graph.get(ref.fromSymbolId);
				const toNode = this.graph.get(ref.toSymbolId);

				if (fromNode && toNode) {
					fromNode.outEdges.add(ref.toSymbolId);
					toNode.inEdges.add(ref.fromSymbolId);
				}
			}
		}
	}

	/**
	 * Resolve unresolved references
	 * Attempts to match reference names to symbol names
	 * @returns Number of references resolved
	 */
	async resolveReferences(): Promise<number> {
		// Use bulk SQL resolution for efficiency
		const resolved = this.tracker.resolveReferencesByName();

		// Update degree counts after resolution
		this.tracker.updateDegreeCounts();

		return resolved;
	}

	/**
	 * Compute PageRank scores for all symbols
	 *
	 * Uses the standard PageRank algorithm:
	 * PR(A) = (1-d)/N + d * Σ(PR(B)/L(B)) for all B → A
	 *
	 * Where:
	 * - d = damping factor (default 0.85)
	 * - N = total number of symbols
	 * - L(B) = number of outgoing links from B
	 *
	 * @param iterations Number of iterations (default 20)
	 * @param dampingFactor Damping factor (default 0.85)
	 * @returns Map of symbol ID to PageRank score
	 */
	computePageRank(
		iterations: number = 20,
		dampingFactor: number = 0.85,
	): Map<string, number> {
		// Build graph if not already built
		if (!this.graph) {
			const symbols = this.tracker.getAllSymbols();
			const references = this.tracker.getAllReferences();

			this.graph = new Map();

			for (const symbol of symbols) {
				this.graph.set(symbol.id, {
					symbol,
					outEdges: new Set(),
					inEdges: new Set(),
				});
			}

			for (const ref of references) {
				if (ref.isResolved && ref.toSymbolId) {
					const fromNode = this.graph.get(ref.fromSymbolId);
					const toNode = this.graph.get(ref.toSymbolId);

					if (fromNode && toNode) {
						fromNode.outEdges.add(ref.toSymbolId);
						toNode.inEdges.add(ref.fromSymbolId);
					}
				}
			}
		}

		const n = this.graph.size;
		if (n === 0) {
			return new Map();
		}

		// Initialize PageRank scores uniformly
		const scores = new Map<string, number>();
		const initialScore = 1.0 / n;

		for (const id of this.graph.keys()) {
			scores.set(id, initialScore);
		}

		// Teleport probability (random jump)
		const teleportScore = (1 - dampingFactor) / n;

		// Iterative PageRank computation
		for (let iter = 0; iter < iterations; iter++) {
			const newScores = new Map<string, number>();

			for (const [id, node] of this.graph) {
				let incomingScore = 0;

				// Sum contributions from all nodes that link to this one
				for (const sourceId of node.inEdges) {
					const sourceNode = this.graph.get(sourceId);
					if (sourceNode) {
						const sourceScore = scores.get(sourceId) || 0;
						const sourceOutDegree = sourceNode.outEdges.size || 1; // Avoid division by zero
						incomingScore += sourceScore / sourceOutDegree;
					}
				}

				// PageRank formula
				newScores.set(id, teleportScore + dampingFactor * incomingScore);
			}

			// Update scores for next iteration
			for (const [id, score] of newScores) {
				scores.set(id, score);
			}
		}

		// Normalize scores to sum to 1
		const totalScore = Array.from(scores.values()).reduce(
			(sum, s) => sum + s,
			0,
		);
		if (totalScore > 0) {
			for (const [id, score] of scores) {
				scores.set(id, score / totalScore);
			}
		}

		return scores;
	}

	/**
	 * Compute PageRank and store in database
	 */
	async computeAndStorePageRank(
		iterations?: number,
		dampingFactor?: number,
	): Promise<void> {
		const scores = this.computePageRank(iterations, dampingFactor);
		this.tracker.updatePageRankScores(scores);
	}

	/**
	 * Get all symbols that call/reference a given symbol
	 */
	getCallers(symbolId: string): SymbolDefinition[] {
		const refs = this.tracker.getReferencesTo(symbolId);
		const callerIds = new Set(refs.map((r) => r.fromSymbolId));

		const callers: SymbolDefinition[] = [];
		for (const id of callerIds) {
			const symbol = this.tracker.getSymbol(id);
			if (symbol) {
				callers.push(symbol);
			}
		}

		return callers.sort((a, b) => b.pagerankScore - a.pagerankScore);
	}

	/**
	 * Get all symbols that a given symbol calls/references
	 */
	getCallees(symbolId: string): SymbolDefinition[] {
		const refs = this.tracker.getReferencesFrom(symbolId);
		const calleeIds = new Set(
			refs.filter((r) => r.toSymbolId).map((r) => r.toSymbolId!),
		);

		const callees: SymbolDefinition[] = [];
		for (const id of calleeIds) {
			const symbol = this.tracker.getSymbol(id);
			if (symbol) {
				callees.push(symbol);
			}
		}

		return callees.sort((a, b) => b.pagerankScore - a.pagerankScore);
	}

	/**
	 * Get symbol context: the symbol plus its direct dependencies
	 * Useful for providing context to LLMs
	 */
	getSymbolContext(
		symbolId: string,
		options: {
			includeCallers?: boolean;
			includeCallees?: boolean;
			maxCallers?: number;
			maxCallees?: number;
		} = {},
	): {
		symbol: SymbolDefinition | null;
		callers: SymbolDefinition[];
		callees: SymbolDefinition[];
	} {
		const {
			includeCallers = false,
			includeCallees = true,
			maxCallers = 5,
			maxCallees = 10,
		} = options;

		const symbol = this.tracker.getSymbol(symbolId);

		return {
			symbol,
			callers: includeCallers
				? this.getCallers(symbolId).slice(0, maxCallers)
				: [],
			callees: includeCallees
				? this.getCallees(symbolId).slice(0, maxCallees)
				: [],
		};
	}

	/**
	 * Find symbol by name with optional disambiguation
	 */
	findSymbol(
		name: string,
		options: {
			preferExported?: boolean;
			fileHint?: string;
		} = {},
	): SymbolDefinition | null {
		const { preferExported = true, fileHint } = options;

		const candidates = this.tracker.getSymbolByName(name);

		if (candidates.length === 0) {
			return null;
		}

		if (candidates.length === 1) {
			return candidates[0];
		}

		// Multiple candidates, try to disambiguate

		// If file hint provided, prefer symbols from that file
		if (fileHint) {
			const fromFile = candidates.filter((c) => c.filePath.includes(fileHint));
			if (fromFile.length === 1) {
				return fromFile[0];
			}
		}

		// Prefer exported symbols
		if (preferExported) {
			const exported = candidates.filter((c) => c.isExported);
			if (exported.length === 1) {
				return exported[0];
			}
			if (exported.length > 0) {
				// Among exported, prefer highest PageRank
				return exported.sort((a, b) => b.pagerankScore - a.pagerankScore)[0];
			}
		}

		// Fall back to highest PageRank
		return candidates.sort((a, b) => b.pagerankScore - a.pagerankScore)[0];
	}

	/**
	 * Clear the in-memory graph (force rebuild on next operation)
	 */
	clearGraph(): void {
		this.graph = null;
	}
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a reference graph manager
 */
export function createReferenceGraphManager(
	tracker: FileTracker,
): ReferenceGraphManager {
	return new ReferenceGraphManager(tracker);
}
