/**
 * Reference Graph Manager
 *
 * Builds and maintains the symbol reference graph.
 * Computes PageRank scores for symbol importance ranking.
 */

import type { SymbolDefinition } from "../types.js";
import type { BranchScopedGraph, IFileTracker } from "./tracker.js";

// ============================================================================
// Types
// ============================================================================

interface GraphNode {
	symbol: SymbolDefinition;
	outEdges: Set<string>; // IDs of symbols this symbol references
	inEdges: Set<string>; // IDs of symbols that reference this symbol
}

/**
 * Query-time personalization for {@link ReferenceGraphManager.computePageRank}.
 *
 * Replaces the uniform teleport vector with a seed-weighted one: the `(1 - d)`
 * restart mass returns only to the seed set instead of spreading evenly over
 * all N nodes, so "important" becomes important-RELATIVE-TO-THE-SEEDS rather
 * than important-in-the-repo.
 */
export interface PageRankPersonalization {
	/**
	 * Seed node id → weight. Weights need not sum to 1 (they are normalized
	 * internally) and need not exist in the graph (unknown ids are dropped).
	 */
	seeds: ReadonlyMap<string, number>;

	/**
	 * Stop early once the L1 delta between iterations falls below this.
	 * 0 (the default) disables the check entirely — the global index-time path
	 * must run its full iteration count with no extra arithmetic.
	 */
	tolerance?: number;

	/**
	 * Restrict propagation to nodes within this many hops of a seed (undirected:
	 * both callers and callees). 0/undefined propagates over the whole graph.
	 *
	 * A personalized walk with a high damping factor puts essentially all of its
	 * mass within a few hops of the seeds, so the far side of the graph costs
	 * time without changing the ranking.
	 */
	maxHops?: number;

	/** Hard cap on neighborhood size, applied breadth-first (undefined = no cap). */
	maxNodes?: number;
}

/**
 * Defaults for the query-time personalized run, chosen against the measured
 * cost on this repo's own graph (~5k symbols, ~10k resolved edges):
 * 0.14–5.5 ms median per walk across seed bands, p95 ≤ 14 ms.
 *
 * The iteration cap is a LATENCY bound, not a convergence guarantee. Measured
 * on the real graph, the early exit fires around iteration 10–25 and 30
 * iterations lands within L1 1.5e-6 of the fully-converged walk with an
 * identical top-20 — but a graph dominated by a short directed cycle is
 * periodic, and its error decays only at rate `dampingFactor` per iteration
 * (~70 iterations at d = 0.95 to settle a pure 2-cycle). A truncated run is
 * still a coherent k-step random-walk-with-restart, i.e. a slightly more LOCAL
 * proximity measure than the k→∞ limit, which is the direction this feature
 * wants anyway.
 */
export const DEFAULT_PPR_ITERATIONS = 30;

/**
 * Higher than the 0.85 used for global PageRank: a personalized walk wants to
 * STAY near its seeds, so it should restart less often.
 */
export const DEFAULT_PPR_DAMPING = 0.95;

export const DEFAULT_PPR_TOLERANCE = 1e-6;
export const DEFAULT_PPR_MAX_HOPS = 3;

/**
 * The binding cost control. Cost per iteration is the total IN-DEGREE of the
 * neighborhood, not its node count, so seeds adjacent to high-fan-in hubs are
 * an order of magnitude more expensive per node than seeds out in the leaves;
 * measured, this cap is what keeps the hub case at ~4 ms instead of ~26 ms.
 */
export const DEFAULT_PPR_MAX_NODES = 1000;

// ============================================================================
// Reference Graph Manager Class
// ============================================================================

export class ReferenceGraphManager {
	/**
	 * Every symbol-graph read and write this class makes, through ONE branch.
	 *
	 * The branch is taken at construction and held FOR THE DURATION OF ONE RUN
	 * ONLY — this is not one of §2.5's three long-lived objects. `mcp/cache.ts`
	 * and the TUI rebuild theirs when the resolved branch changes, which is what
	 * keeps a branch switch under a long-lived MCP server from being answered by
	 * the previous branch (V3.10).
	 */
	private readonly symbols: BranchScopedGraph;
	private graph: Map<string, GraphNode> | null = null;

	constructor(tracker: IFileTracker, branchId: number) {
		this.symbols = tracker.graph(branchId);
	}

	/** Which branch this manager was built for. Diagnostics and cache keys. */
	get branchId(): number {
		return this.symbols.scopedBranchId;
	}

	/**
	 * Build the reference graph from database
	 */
	async buildGraph(): Promise<void> {
		this.graph = this.loadGraph();
	}

	/**
	 * Read every symbol + resolved reference out of the tracker and materialize
	 * the in-memory adjacency structure.
	 */
	private loadGraph(): Map<string, GraphNode> {
		const symbols = this.symbols.getAllSymbols();
		const references = this.symbols.getAllReferences();

		const graph = new Map<string, GraphNode>();

		// Initialize nodes for all symbols
		for (const symbol of symbols) {
			graph.set(symbol.id, {
				symbol,
				outEdges: new Set(),
				inEdges: new Set(),
			});
		}

		// Build edges from resolved references
		for (const ref of references) {
			if (ref.isResolved && ref.toSymbolId) {
				const fromNode = graph.get(ref.fromSymbolId);
				const toNode = graph.get(ref.toSymbolId);

				if (fromNode && toNode) {
					fromNode.outEdges.add(ref.toSymbolId);
					toNode.inEdges.add(ref.fromSymbolId);
				}
			}
		}

		return graph;
	}

	/**
	 * Resolve unresolved references
	 * Attempts to match reference names to symbol names
	 * @returns Number of references resolved
	 */
	async resolveReferences(): Promise<number> {
		// Use bulk SQL resolution for efficiency
		const resolved = this.symbols.resolveReferencesByName();

		// Update degree counts after resolution
		this.symbols.updateDegreeCounts();

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
	 * With `personalization` the `(1-d)/N` term is replaced by `(1-d) * p(A)`
	 * for a seed-weighted distribution `p` — see {@link PageRankPersonalization}.
	 * WITHOUT it the arithmetic is unchanged, node for node and operation for
	 * operation, because index-time scores feed `map`, `dead-code`, `test-gaps`
	 * and every ranking that reads `pagerankScore`.
	 *
	 * @param iterations Number of iterations (default 20)
	 * @param dampingFactor Damping factor (default 0.85)
	 * @param personalization Optional query-time seeding (default: uniform teleport)
	 * @returns Map of symbol ID to PageRank score
	 */
	computePageRank(
		iterations: number = 20,
		dampingFactor: number = 0.85,
		personalization?: PageRankPersonalization,
	): Map<string, number> {
		// Build graph if not already built
		if (!this.graph) {
			this.graph = this.loadGraph();
		}

		if (!personalization) {
			return this.runPageRank(
				Array.from(this.graph.keys()),
				iterations,
				dampingFactor,
				null,
				0,
			);
		}

		const distribution = this.normalizeSeeds(personalization.seeds);

		// No seed survived (all unknown / non-positive / empty) — fall back to the
		// uniform teleport rather than dividing by zero or returning nothing.
		if (!distribution) {
			return this.runPageRank(
				Array.from(this.graph.keys()),
				iterations,
				dampingFactor,
				null,
				0,
			);
		}

		const nodeIds = personalization.maxHops
			? this.collectNeighborhood(
					distribution.keys(),
					personalization.maxHops,
					personalization.maxNodes,
				)
			: Array.from(this.graph.keys());

		return this.runPageRank(
			nodeIds,
			iterations,
			dampingFactor,
			distribution,
			personalization.tolerance ?? 0,
		);
	}

	/**
	 * Convenience entry point for the query-time personalized run.
	 *
	 * Same algorithm as {@link computePageRank} — only the defaults differ
	 * (fewer iterations, higher damping, early convergence exit, neighborhood
	 * restriction), because this one runs inside a search request.
	 */
	computePersonalizedPageRank(
		seeds: ReadonlyMap<string, number>,
		options: {
			iterations?: number;
			dampingFactor?: number;
			tolerance?: number;
			maxHops?: number;
			maxNodes?: number;
		} = {},
	): Map<string, number> {
		return this.computePageRank(
			options.iterations ?? DEFAULT_PPR_ITERATIONS,
			options.dampingFactor ?? DEFAULT_PPR_DAMPING,
			{
				seeds,
				tolerance: options.tolerance ?? DEFAULT_PPR_TOLERANCE,
				maxHops: options.maxHops ?? DEFAULT_PPR_MAX_HOPS,
				maxNodes: options.maxNodes ?? DEFAULT_PPR_MAX_NODES,
			},
		);
	}

	/**
	 * Drop seeds that are not in the graph or carry no usable weight, then
	 * normalize the survivors to sum to 1.
	 *
	 * @returns The normalized distribution, or null if nothing survived.
	 */
	private normalizeSeeds(
		seeds: ReadonlyMap<string, number>,
	): Map<string, number> | null {
		const graph = this.graph;
		if (!graph) return null;

		const kept = new Map<string, number>();
		let total = 0;

		for (const [id, weight] of seeds) {
			// Unknown ids are dropped: a seed with no node cannot receive restart
			// mass, and keeping it in the denominator would silently shrink every
			// surviving seed's share.
			if (!graph.has(id)) continue;
			if (!Number.isFinite(weight) || weight <= 0) continue;
			kept.set(id, weight);
			total += weight;
		}

		if (kept.size === 0 || !(total > 0)) return null;

		for (const [id, weight] of kept) {
			kept.set(id, weight / total);
		}

		return kept;
	}

	/**
	 * Breadth-first node set within `maxHops` of any seed, following edges in
	 * BOTH directions — a caller of a seed is as relevant to the question as a
	 * callee, and PageRank mass flows along out-edges into nodes we would never
	 * reach if we only walked out-edges from the seeds.
	 */
	private collectNeighborhood(
		seedIds: Iterable<string>,
		maxHops: number,
		maxNodes?: number,
	): string[] {
		const graph = this.graph;
		if (!graph) return [];

		const cap =
			maxNodes && maxNodes > 0 ? Math.min(maxNodes, graph.size) : graph.size;

		const visited = new Set<string>();
		let frontier: string[] = [];

		for (const id of seedIds) {
			if (visited.size >= cap) break;
			if (graph.has(id) && !visited.has(id)) {
				visited.add(id);
				frontier.push(id);
			}
		}

		for (let hop = 0; hop < maxHops && frontier.length > 0; hop++) {
			if (visited.size >= cap) break;
			const next: string[] = [];

			for (const id of frontier) {
				const node = graph.get(id);
				if (!node) continue;

				for (const neighborId of node.outEdges) {
					if (visited.size >= cap) break;
					if (visited.has(neighborId)) continue;
					visited.add(neighborId);
					next.push(neighborId);
				}
				for (const neighborId of node.inEdges) {
					if (visited.size >= cap) break;
					if (visited.has(neighborId)) continue;
					visited.add(neighborId);
					next.push(neighborId);
				}
			}

			frontier = next;
		}

		return Array.from(visited);
	}

	/**
	 * The one power-iteration implementation, shared by the global index-time
	 * run and the query-time personalized run.
	 *
	 * DANGLING NODES: a node with no out-edges never appears as a `sourceId` in
	 * anyone's `inEdges` (the two sets are built symmetrically in `loadGraph`),
	 * so its mass is simply dropped each iteration instead of being redistributed
	 * — the textbook treatment reinjects it through the teleport vector. The
	 * `|| 1` guard below is therefore dead code: any `sourceNode` reached from
	 * `node.inEdges` has at least one out-edge by construction. The consequence
	 * is that the running total is < 1 and the final normalization rescales
	 * everything back up, which preserves the ORDER but not the textbook
	 * magnitudes. That is pre-existing behavior on the global path and is left
	 * exactly as-is; the personalized path inherits it deliberately so the two
	 * cannot drift.
	 *
	 * @param nodeIds       Nodes to score. Out-degrees are still taken from the
	 *                      FULL graph, so mass flowing to a node outside a
	 *                      restricted neighborhood leaks (and is renormalized away).
	 * @param distribution  Normalized teleport distribution, or null for uniform.
	 * @param tolerance     L1 early-exit threshold; 0 disables the check.
	 */
	private runPageRank(
		nodeIds: string[],
		iterations: number,
		dampingFactor: number,
		distribution: Map<string, number> | null,
		tolerance: number,
	): Map<string, number> {
		const graph = this.graph;
		if (!graph) return new Map();

		const n = nodeIds.length;
		if (n === 0) {
			return new Map();
		}

		// Initialize PageRank scores uniformly — or, when personalized, AT the
		// seed distribution, which is strictly closer to the fixed point and so
		// can only reduce the number of iterations needed.
		//
		// MEASURED: at the default cap this is NOT observable. Both inits give
		// bit-identical results on the test fixture and L1-identical results on
		// this repo's real graph across hub/mid/tail seed bands, because the
		// early exit fires long before `d^iterations` of the initial vector
		// would still matter. It is kept because it is free and because the
		// guarantee stops holding on a slow-mixing graph with a lower cap — but
		// no test asserts a difference, because there is none to assert.
		const scores = new Map<string, number>();
		const initialScore = 1.0 / n;

		for (const id of nodeIds) {
			scores.set(id, distribution ? (distribution.get(id) ?? 0) : initialScore);
		}

		// Teleport probability (random jump)
		const teleportScore = (1 - dampingFactor) / n;

		// Iterative PageRank computation
		for (let iter = 0; iter < iterations; iter++) {
			const newScores = new Map<string, number>();

			for (const id of nodeIds) {
				const node = graph.get(id);
				if (!node) continue;

				let incomingScore = 0;

				// Sum contributions from all nodes that link to this one
				for (const sourceId of node.inEdges) {
					const sourceScore = scores.get(sourceId) || 0;
					// A zero-scored source contributes `0 / outDegree` — exactly 0, an
					// additive identity — so skipping it cannot change the result by
					// a single bit. It is skipped for SPEED: under a restricted
					// neighborhood most in-edges come from unscored outside nodes, and
					// this drops their graph lookup from the hot loop entirely.
					if (sourceScore === 0) continue;

					const sourceNode = graph.get(sourceId);
					if (sourceNode) {
						const sourceOutDegree = sourceNode.outEdges.size || 1; // Avoid division by zero
						incomingScore += sourceScore / sourceOutDegree;
					}
				}

				// PageRank formula — uniform teleport, or seed-weighted restart
				newScores.set(
					id,
					distribution
						? (1 - dampingFactor) * (distribution.get(id) ?? 0) +
								dampingFactor * incomingScore
						: teleportScore + dampingFactor * incomingScore,
				);
			}

			// Update scores for next iteration
			let delta = 0;
			for (const [id, score] of newScores) {
				if (tolerance > 0) delta += Math.abs(score - (scores.get(id) ?? 0));
				scores.set(id, score);
			}

			if (tolerance > 0 && delta < tolerance) break;
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
	 * Resolve a retrieval hit's `file:line` anchor to the graph node that most
	 * tightly encloses it.
	 *
	 * Retrieval backends return chunk locations, not symbol ids, so this is the
	 * bridge from "a result" to "a node that can seed a personalized walk".
	 * Smallest enclosing range wins (a method beats the class containing it);
	 * a matching `symbolName` breaks ties first.
	 */
	findSymbolIdAtLocation(
		filePath: string,
		line: number,
		symbolName?: string,
	): string | null {
		const symbols = this.symbols.getSymbolsByFile(filePath);
		if (symbols.length === 0) return null;

		let best: SymbolDefinition | null = null;
		let bestSpan = Number.POSITIVE_INFINITY;
		let bestNameMatch = false;

		for (const symbol of symbols) {
			if (symbol.startLine > line || symbol.endLine < line) continue;

			const nameMatch = symbolName !== undefined && symbol.name === symbolName;
			const span = symbol.endLine - symbol.startLine;

			// A name match outranks a tighter range; among equals, tighter wins.
			if (best && bestNameMatch && !nameMatch) continue;
			if (best && nameMatch === bestNameMatch && span >= bestSpan) continue;

			best = symbol;
			bestSpan = span;
			bestNameMatch = nameMatch;
		}

		return best?.id ?? null;
	}

	/**
	 * Compute PageRank and store in database
	 */
	async computeAndStorePageRank(
		iterations?: number,
		dampingFactor?: number,
	): Promise<void> {
		const scores = this.computePageRank(iterations, dampingFactor);
		this.symbols.updatePageRankScores(scores);
	}

	/**
	 * Get all symbols that call/reference a given symbol
	 */
	getCallers(symbolId: string): SymbolDefinition[] {
		const refs = this.symbols.getReferencesTo(symbolId);
		const callerIds = new Set(refs.map((r) => r.fromSymbolId));

		const callers: SymbolDefinition[] = [];
		for (const id of callerIds) {
			const symbol = this.symbols.getSymbol(id);
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
		const refs = this.symbols.getReferencesFrom(symbolId);
		const calleeIds = new Set(
			refs.filter((r) => r.toSymbolId).map((r) => r.toSymbolId!),
		);

		const callees: SymbolDefinition[] = [];
		for (const id of calleeIds) {
			const symbol = this.symbols.getSymbol(id);
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

		const symbol = this.symbols.getSymbol(symbolId);

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

		// Dot-path resolution: "Class.method" → find method scoped to class
		const dotIndex = name.indexOf(".");
		if (dotIndex > 0) {
			const className = name.slice(0, dotIndex);
			const memberName = name.slice(dotIndex + 1);

			// Find the parent class/interface/struct
			const classCandidates = this.symbols.getSymbolByName(className);
			const classSymbol =
				classCandidates.find(
					(s) =>
						s.kind === "class" || s.kind === "interface" || s.kind === "type",
				) ?? classCandidates[0];

			if (classSymbol) {
				// Find children of that class with matching name
				const memberCandidates = this.symbols.getSymbolByName(memberName);
				const scoped = memberCandidates.filter(
					(s) => s.parentId === classSymbol.id,
				);
				if (scoped.length === 1) return scoped[0];
				if (scoped.length > 1) {
					// Multiple matches — use existing disambiguation
					if (fileHint) {
						const fromFile = scoped.filter((c) =>
							c.filePath.includes(fileHint),
						);
						if (fromFile.length === 1) return fromFile[0];
					}
					return scoped.sort((a, b) => b.pagerankScore - a.pagerankScore)[0];
				}
				// Class found but member not scoped — fall through to flat search
			}
			// Class not found — fall through to flat search with the full dotted name
			// (which will likely return null, then try the member name alone)
		}

		const candidates = this.symbols.getSymbolByName(name);

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
	tracker: IFileTracker,
	branchId: number,
): ReferenceGraphManager {
	return new ReferenceGraphManager(tracker, branchId);
}
