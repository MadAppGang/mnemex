/**
 * Unit tests for query-seeded Personalized PageRank.
 *
 * Three claims are under test:
 *
 *   A. Adding personalization must not perturb the GLOBAL run by one bit.
 *      Index-time PageRank feeds `map`, `dead-code`, `test-gaps` and every
 *      ranking that reads `pagerankScore`; a drift there is a silent regression
 *      across the whole product. The golden test below re-implements the
 *      pre-change algorithm verbatim and demands exact (===) equality, not
 *      approximate.
 *
 *   B. A personalized run concentrates mass near its seeds — a node adjacent to
 *      a seed must outrank a structurally identical node far from any seed.
 *      That is the entire point: "important" becomes relative to the question.
 *
 *   C. Degenerate seeding (unnormalized weights, unknown ids, no ids at all)
 *      must never throw, divide by zero, or return an empty ranking.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReferenceGraphManager } from "../../../src/core/reference-graph.js";
import { FileTracker } from "../../../src/core/tracker.js";
import type { SymbolDefinition, SymbolReference } from "../../../src/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = "2026-01-01T00:00:00.000Z";

/** A directed edge, written as "from->to". */
type Edge = `${string}->${string}`;

function makeSymbol(id: string, index: number): SymbolDefinition {
	return {
		id,
		name: id,
		kind: "function",
		filePath: `src/${id}.ts`,
		startLine: index * 10 + 1,
		endLine: index * 10 + 9,
		isExported: true,
		language: "typescript",
		pagerankScore: 0,
		inDegree: 0,
		outDegree: 0,
		createdAt: NOW,
		updatedAt: NOW,
	};
}

function makeReference(
	from: string,
	to: string,
	line: number,
): SymbolReference {
	return {
		fromSymbolId: from,
		toSymbolName: to,
		toSymbolId: to,
		kind: "call",
		filePath: `src/${from}.ts`,
		line,
		isResolved: true,
		createdAt: NOW,
	};
}

/** The one branch every fixture in this file lives on. */
const BRANCH = 1;

interface Fixture {
	manager: ReferenceGraphManager;
	symbols: SymbolDefinition[];
	edges: Array<[string, string]>;
	cleanup: () => void;
}

/**
 * Build a real tracker-backed graph from a node list and "a->b" edge list.
 *
 * A real `FileTracker` rather than a stub: the graph the manager walks is the
 * one it reads out of SQLite, and insertion order there is what fixes Map
 * iteration order — which is exactly what the golden comparison depends on.
 */
function makeGraph(nodes: string[], edgeSpecs: Edge[]): Fixture {
	const dir = mkdtempSync(join(tmpdir(), "mnemex-ppr-test-"));
	const tracker = new FileTracker(join(dir, "index.db"), dir);

	// One branch: every symbol-graph statement is scoped, and the handle is the
	// only way to reach one (§4.4.1).
	const graph = tracker.graph(BRANCH);
	const symbols = nodes.map((id, i) => makeSymbol(id, i));
	graph.insertSymbols(symbols);

	const edges = edgeSpecs.map(
		(spec) => spec.split("->") as unknown as [string, string],
	);
	graph.insertReferences(
		edges.map(([from, to], i) => makeReference(from, to, i + 1)),
	);

	return {
		manager: new ReferenceGraphManager(tracker, BRANCH),
		symbols,
		edges,
		cleanup: () => {
			try {
				tracker.close();
			} catch {
				// best effort
			}
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				// best effort
			}
		},
	};
}

// ---------------------------------------------------------------------------
// Golden reference: the algorithm EXACTLY as it stood before personalization
// ---------------------------------------------------------------------------

/**
 * Verbatim transcription of `computePageRank` prior to this change, operating
 * on the same node/edge data. Any divergence in the new implementation's
 * uniform path — a reordered addition, a different init, an early exit — shows
 * up as an exact-equality failure.
 */
function goldenPageRank(
	symbols: SymbolDefinition[],
	edges: Array<[string, string]>,
	iterations = 20,
	dampingFactor = 0.85,
): Map<string, number> {
	const graph = new Map<
		string,
		{ outEdges: Set<string>; inEdges: Set<string> }
	>();
	for (const symbol of symbols) {
		graph.set(symbol.id, { outEdges: new Set(), inEdges: new Set() });
	}
	for (const [from, to] of edges) {
		const fromNode = graph.get(from);
		const toNode = graph.get(to);
		if (fromNode && toNode) {
			fromNode.outEdges.add(to);
			toNode.inEdges.add(from);
		}
	}

	const n = graph.size;
	if (n === 0) return new Map();

	const scores = new Map<string, number>();
	const initialScore = 1.0 / n;
	for (const id of graph.keys()) scores.set(id, initialScore);

	const teleportScore = (1 - dampingFactor) / n;

	for (let iter = 0; iter < iterations; iter++) {
		const newScores = new Map<string, number>();
		for (const [id, node] of graph) {
			let incomingScore = 0;
			for (const sourceId of node.inEdges) {
				const sourceNode = graph.get(sourceId);
				if (sourceNode) {
					const sourceScore = scores.get(sourceId) || 0;
					const sourceOutDegree = sourceNode.outEdges.size || 1;
					incomingScore += sourceScore / sourceOutDegree;
				}
			}
			newScores.set(id, teleportScore + dampingFactor * incomingScore);
		}
		for (const [id, score] of newScores) scores.set(id, score);
	}

	const totalScore = Array.from(scores.values()).reduce((sum, s) => sum + s, 0);
	if (totalScore > 0) {
		for (const [id, score] of scores) scores.set(id, score / totalScore);
	}

	return scores;
}

/**
 * A graph with hubs, a dangling node, a cycle and two symmetric arms.
 *
 * The arms (`left*` / `right*`) are structurally identical to each other, so
 * global PageRank is forced to tie them and only the seeding can separate them.
 */
const NODES = [
	"hub",
	"leftA",
	"leftB",
	"leftC",
	"rightA",
	"rightB",
	"rightC",
	"cycle1",
	"cycle2",
	"cycle3",
	"dangling",
	"orphan",
];

const EDGES: Edge[] = [
	// hub feeds both arms symmetrically
	"hub->leftA",
	"hub->rightA",
	// left arm
	"leftA->leftB",
	"leftB->leftC",
	"leftC->dangling",
	// right arm (mirror image)
	"rightA->rightB",
	"rightB->rightC",
	"rightC->dangling",
	// a 3-cycle, unreachable from the arms
	"cycle1->cycle2",
	"cycle2->cycle3",
	"cycle3->cycle1",
];

// ---------------------------------------------------------------------------
// A. The uniform path is untouched
// ---------------------------------------------------------------------------

describe("computePageRank without personalization is byte-identical", () => {
	let cleanup = () => {};
	afterEach(() => cleanup());

	it("matches the pre-change implementation exactly, score for score", () => {
		const fixture = makeGraph(NODES, EDGES);
		cleanup = fixture.cleanup;

		const actual = fixture.manager.computePageRank();
		const golden = goldenPageRank(fixture.symbols, fixture.edges);

		expect(actual.size).toBe(golden.size);
		expect([...actual.keys()]).toEqual([...golden.keys()]);
		for (const [id, score] of golden) {
			// Exact equality — toBeCloseTo would hide a real drift in the ranking
			// that index-time consumers read.
			expect(actual.get(id)).toBe(score);
		}
	});

	it("matches exactly at non-default iteration counts and damping factors", () => {
		const fixture = makeGraph(NODES, EDGES);
		cleanup = fixture.cleanup;

		for (const [iterations, damping] of [
			[1, 0.85],
			[5, 0.5],
			[20, 0.99],
			[50, 0.85],
		] as const) {
			const actual = fixture.manager.computePageRank(iterations, damping);
			const golden = goldenPageRank(
				fixture.symbols,
				fixture.edges,
				iterations,
				damping,
			);
			for (const [id, score] of golden) {
				expect(actual.get(id)).toBe(score);
			}
		}
	});

	it("an explicitly undefined personalization is still the uniform path", () => {
		const fixture = makeGraph(NODES, EDGES);
		cleanup = fixture.cleanup;

		const actual = fixture.manager.computePageRank(20, 0.85, undefined);
		for (const [id, score] of goldenPageRank(fixture.symbols, fixture.edges)) {
			expect(actual.get(id)).toBe(score);
		}
	});

	it("scores every node and sums to 1", () => {
		const fixture = makeGraph(NODES, EDGES);
		cleanup = fixture.cleanup;

		const scores = fixture.manager.computePageRank();
		expect(scores.size).toBe(NODES.length);
		expect([...scores.values()].reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
	});

	it("an empty graph returns an empty ranking", () => {
		const fixture = makeGraph([], []);
		cleanup = fixture.cleanup;
		expect(fixture.manager.computePageRank().size).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// B. Personalization concentrates mass near the seeds
// ---------------------------------------------------------------------------

describe("personalized PageRank concentrates mass near the seeds", () => {
	let cleanup = () => {};
	afterEach(() => cleanup());

	it("global PageRank ties the two symmetric arms", () => {
		const fixture = makeGraph(NODES, EDGES);
		cleanup = fixture.cleanup;

		const global = fixture.manager.computePageRank();
		// Structurally identical arms — the global run cannot tell them apart,
		// which is precisely the limitation personalization removes.
		expect(global.get("leftB")).toBeCloseTo(global.get("rightB") ?? -1, 15);
		expect(global.get("leftC")).toBeCloseTo(global.get("rightC") ?? -1, 15);
	});

	it("a node adjacent to a seed outranks its equally-connected mirror", () => {
		const fixture = makeGraph(NODES, EDGES);
		cleanup = fixture.cleanup;

		const scores = fixture.manager.computePersonalizedPageRank(
			new Map([["leftA", 1]]),
		);

		// leftB is one hop from the seed; rightB is its structural twin on the
		// far side of the hub.
		expect(scores.get("leftB") ?? 0).toBeGreaterThan(scores.get("rightB") ?? 0);
		expect(scores.get("leftC") ?? 0).toBeGreaterThan(scores.get("rightC") ?? 0);
		// And the disconnected cycle gets essentially nothing.
		expect(scores.get("leftB") ?? 0).toBeGreaterThan(scores.get("cycle1") ?? 0);
	});

	it("moving the seed to the other arm mirrors the ranking", () => {
		const fixture = makeGraph(NODES, EDGES);
		cleanup = fixture.cleanup;

		const left = fixture.manager.computePersonalizedPageRank(
			new Map([["leftA", 1]]),
		);
		const right = fixture.manager.computePersonalizedPageRank(
			new Map([["rightA", 1]]),
		);

		expect(left.get("leftB") ?? 0).toBeCloseTo(right.get("rightB") ?? -1, 12);
		expect(right.get("rightB") ?? 0).toBeGreaterThan(right.get("leftB") ?? 0);
	});

	it("the seed itself outranks everything reachable from it", () => {
		const fixture = makeGraph(NODES, EDGES);
		cleanup = fixture.cleanup;

		const scores = fixture.manager.computePersonalizedPageRank(
			new Map([["leftA", 1]]),
		);
		const seedScore = scores.get("leftA") ?? 0;
		for (const id of ["leftB", "leftC", "rightA", "rightB", "hub"]) {
			expect(seedScore).toBeGreaterThan(scores.get(id) ?? 0);
		}
	});

	it("relative seed weights move the ranking proportionally", () => {
		const fixture = makeGraph(NODES, EDGES);
		cleanup = fixture.cleanup;

		const leftHeavy = fixture.manager.computePersonalizedPageRank(
			new Map([
				["leftA", 9],
				["rightA", 1],
			]),
		);
		const rightHeavy = fixture.manager.computePersonalizedPageRank(
			new Map([
				["leftA", 1],
				["rightA", 9],
			]),
		);

		expect(leftHeavy.get("leftB") ?? 0).toBeGreaterThan(
			leftHeavy.get("rightB") ?? 0,
		);
		expect(rightHeavy.get("rightB") ?? 0).toBeGreaterThan(
			rightHeavy.get("leftB") ?? 0,
		);
	});
});

// ---------------------------------------------------------------------------
// B'. Weight normalization
// ---------------------------------------------------------------------------

describe("seed weights are normalized", () => {
	let cleanup = () => {};
	afterEach(() => cleanup());

	it("seed weights are load-bearing: unequal weights beat equal ones", () => {
		const fixture = makeGraph(NODES, EDGES);
		cleanup = fixture.cleanup;

		// Guards the scale-invariance tests below from being vacuous: if seed
		// weights were ignored entirely, those would still pass.
		const weighted = fixture.manager.computePersonalizedPageRank(
			new Map([
				["leftA", 99],
				["rightA", 1],
			]),
		);
		const equal = fixture.manager.computePersonalizedPageRank(
			new Map([
				["leftA", 1],
				["rightA", 1],
			]),
		);

		expect(equal.get("leftB")).toBeCloseTo(equal.get("rightB") ?? -1, 15);
		expect(weighted.get("leftB") ?? 0).toBeGreaterThan(
			(weighted.get("rightB") ?? 0) * 10,
		);
	});

	it("unnormalized weights give the same result as their normalized form", () => {
		const fixture = makeGraph(NODES, EDGES);
		cleanup = fixture.cleanup;

		const raw = fixture.manager.computePersonalizedPageRank(
			new Map([
				["leftA", 30],
				["rightA", 10],
			]),
		);
		const normalized = fixture.manager.computePersonalizedPageRank(
			new Map([
				["leftA", 0.75],
				["rightA", 0.25],
			]),
		);

		expect([...raw.keys()]).toEqual([...normalized.keys()]);
		for (const [id, score] of normalized) {
			expect(raw.get(id)).toBeCloseTo(score, 15);
		}
	});

	it("scaling every weight by the same factor changes nothing", () => {
		const fixture = makeGraph(NODES, EDGES);
		cleanup = fixture.cleanup;

		const base = fixture.manager.computePersonalizedPageRank(
			new Map([
				["leftA", 1],
				["cycle1", 2],
			]),
		);
		const scaled = fixture.manager.computePersonalizedPageRank(
			new Map([
				["leftA", 1000],
				["cycle1", 2000],
			]),
		);

		for (const [id, score] of base) {
			expect(scaled.get(id)).toBeCloseTo(score, 15);
		}
	});
});

// ---------------------------------------------------------------------------
// C. Degenerate seeding
// ---------------------------------------------------------------------------

describe("degenerate seed sets fall back instead of failing", () => {
	let cleanup = () => {};
	afterEach(() => cleanup());

	it("unknown seed ids are dropped, and the known ones still steer the walk", () => {
		const fixture = makeGraph(NODES, EDGES);
		cleanup = fixture.cleanup;

		const withGhosts = fixture.manager.computePersonalizedPageRank(
			new Map([
				["leftA", 1],
				["does-not-exist", 5],
				["also-missing", 100],
			]),
		);
		const clean = fixture.manager.computePersonalizedPageRank(
			new Map([["leftA", 1]]),
		);

		expect(withGhosts.has("does-not-exist")).toBe(false);
		// The ghosts ate no restart mass: dropping them must not merely shrink
		// leftA's share, it must leave the distribution identical.
		for (const [id, score] of clean) {
			expect(withGhosts.get(id)).toBeCloseTo(score, 15);
		}
	});

	it("all-unknown seeds fall back to the uniform teleport", () => {
		const fixture = makeGraph(NODES, EDGES);
		cleanup = fixture.cleanup;

		const scores = fixture.manager.computePersonalizedPageRank(
			new Map([
				["nope", 1],
				["nada", 2],
			]),
			{ iterations: 20, dampingFactor: 0.85, tolerance: 0, maxHops: 0 },
		);

		// Uniform teleport over the whole graph == the global run.
		for (const [id, score] of goldenPageRank(fixture.symbols, fixture.edges)) {
			expect(scores.get(id)).toBe(score);
		}
	});

	it("an empty seed set does not divide by zero", () => {
		const fixture = makeGraph(NODES, EDGES);
		cleanup = fixture.cleanup;

		const scores = fixture.manager.computePersonalizedPageRank(new Map());
		expect(scores.size).toBe(NODES.length);
		for (const score of scores.values()) {
			expect(Number.isFinite(score)).toBe(true);
		}
	});

	it("zero, negative and non-finite weights are dropped", () => {
		const fixture = makeGraph(NODES, EDGES);
		cleanup = fixture.cleanup;

		const scores = fixture.manager.computePersonalizedPageRank(
			new Map([
				["leftA", 1],
				["rightA", 0],
				["cycle1", -5],
				["hub", Number.NaN],
				["leftB", Number.POSITIVE_INFINITY],
			]),
		);

		for (const score of scores.values()) {
			expect(Number.isFinite(score)).toBe(true);
		}
		// Only leftA seeded, so the left arm still wins.
		expect(scores.get("leftB") ?? 0).toBeGreaterThan(scores.get("rightB") ?? 0);
	});

	it("an all-zero-weight seed set falls back to uniform", () => {
		const fixture = makeGraph(NODES, EDGES);
		cleanup = fixture.cleanup;

		const scores = fixture.manager.computePersonalizedPageRank(
			new Map([
				["leftA", 0],
				["rightA", 0],
			]),
			{ iterations: 20, dampingFactor: 0.85, tolerance: 0, maxHops: 0 },
		);
		for (const [id, score] of goldenPageRank(fixture.symbols, fixture.edges)) {
			expect(scores.get(id)).toBe(score);
		}
	});

	it("seeding an isolated node with no edges stays finite", () => {
		const fixture = makeGraph(NODES, EDGES);
		cleanup = fixture.cleanup;

		const scores = fixture.manager.computePersonalizedPageRank(
			new Map([["orphan", 1]]),
		);
		expect(scores.get("orphan")).toBeGreaterThan(0);
		for (const score of scores.values()) {
			expect(Number.isFinite(score)).toBe(true);
		}
	});
});

// ---------------------------------------------------------------------------
// Convergence and cost controls
// ---------------------------------------------------------------------------

describe("convergence", () => {
	let cleanup = () => {};
	afterEach(() => cleanup());

	it("converges on a graph with a cycle, and the early exit detects it", () => {
		const fixture = makeGraph(NODES, EDGES);
		cleanup = fixture.cleanup;

		const seeds = new Map([["cycle1", 1]]);
		// The 3-cycle is the hard case: mass circulates instead of draining, and
		// a directed cycle is PERIODIC, so the iterate oscillates on its way to
		// the fixed point rather than approaching it monotonically. Given room,
		// the walk must still settle.
		const converged = fixture.manager.computePersonalizedPageRank(seeds, {
			iterations: 5000,
			tolerance: 0,
		});
		const early = fixture.manager.computePersonalizedPageRank(seeds, {
			iterations: 5000,
			tolerance: 1e-9,
		});

		for (const [id, score] of converged) {
			expect(early.get(id)).toBeCloseTo(score, 8);
			expect(Number.isFinite(score)).toBe(true);
		}
		// Every cycle member ends up with a share of the circulating mass.
		for (const id of ["cycle1", "cycle2", "cycle3"]) {
			expect(converged.get(id) ?? 0).toBeGreaterThan(0);
		}
		expect([...converged.values()].reduce((a, b) => a + b, 0)).toBeCloseTo(
			1,
			12,
		);
	});

	it("the default iteration cap already gives the converged ORDER", () => {
		const fixture = makeGraph(NODES, EDGES);
		cleanup = fixture.cleanup;

		// The default cap is a latency bound, not a convergence guarantee (see
		// DEFAULT_PPR_ITERATIONS). What re-ranking consumes is the order, and on
		// a graph with a cycle in it the capped run must already agree with the
		// converged one on that.
		const seeds = new Map([["leftA", 1]]);
		const capped = fixture.manager.computePersonalizedPageRank(seeds);
		const converged = fixture.manager.computePersonalizedPageRank(seeds, {
			iterations: 5000,
			tolerance: 0,
		});

		const order = (scores: Map<string, number>) =>
			[...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);

		expect(order(capped)).toEqual(order(converged));
	});

	it("a pure 2-cycle stays finite and normalized under the default cap", () => {
		const fixture = makeGraph(["a", "b"], ["a->b", "b->a"]);
		cleanup = fixture.cleanup;

		// A GRAPH THAT IS NOTHING BUT A 2-CYCLE is the pathological case: it is
		// perfectly periodic, so the iterate flips between the two nodes and its
		// error decays only at rate d (~70 iterations at d = 0.95 to settle).
		// Under the default cap the ranking is therefore a truncated k-step
		// walk, not the fixed point — what must hold regardless is that it stays
		// finite and normalized.
		const capped = fixture.manager.computePersonalizedPageRank(
			new Map([["a", 1]]),
		);
		expect((capped.get("a") ?? 0) + (capped.get("b") ?? 0)).toBeCloseTo(1, 12);
		for (const score of capped.values()) {
			expect(Number.isFinite(score)).toBe(true);
			expect(score).toBeGreaterThan(0);
		}

		// Given the room it needs, the seed does win.
		const converged = fixture.manager.computePersonalizedPageRank(
			new Map([["a", 1]]),
			{ iterations: 5000, tolerance: 0 },
		);
		expect(converged.get("a")).toBeGreaterThan(converged.get("b") ?? 0);
		// Fixed point of x_a = 0.05 + 0.95 x_b, x_b = 0.95 x_a.
		expect(converged.get("a")).toBeCloseTo(0.05 / 0.0975, 6);
	});

	it("the early exit does not change the converged answer", () => {
		const fixture = makeGraph(NODES, EDGES);
		cleanup = fixture.cleanup;

		const seeds = new Map([["leftA", 1]]);
		const withExit = fixture.manager.computePersonalizedPageRank(seeds, {
			tolerance: 1e-6,
			iterations: 200,
		});
		const withoutExit = fixture.manager.computePersonalizedPageRank(seeds, {
			tolerance: 0,
			iterations: 200,
		});

		for (const [id, score] of withoutExit) {
			expect(withExit.get(id)).toBeCloseTo(score, 9);
		}
	});
});

describe("neighborhood restriction", () => {
	let cleanup = () => {};
	afterEach(() => cleanup());

	it("hop-limiting confines the walk to the seed's neighborhood", () => {
		const fixture = makeGraph(NODES, EDGES);
		cleanup = fixture.cleanup;

		const oneHop = fixture.manager.computePersonalizedPageRank(
			new Map([["leftA", 1]]),
			{ maxHops: 1 },
		);

		// leftA's undirected 1-hop neighborhood is {leftA, hub, leftB}.
		expect([...oneHop.keys()].sort()).toEqual(["hub", "leftA", "leftB"]);
		// Nothing outside it is scored at all.
		expect(oneHop.has("cycle1")).toBe(false);
		expect(oneHop.has("rightB")).toBe(false);
	});

	it("maxHops 0 walks the whole graph", () => {
		const fixture = makeGraph(NODES, EDGES);
		cleanup = fixture.cleanup;

		const scores = fixture.manager.computePersonalizedPageRank(
			new Map([["leftA", 1]]),
			{ maxHops: 0 },
		);
		expect(scores.size).toBe(NODES.length);
	});

	it("maxNodes caps the neighborhood breadth-first", () => {
		const fixture = makeGraph(NODES, EDGES);
		cleanup = fixture.cleanup;

		const scores = fixture.manager.computePersonalizedPageRank(
			new Map([["leftA", 1]]),
			{ maxHops: 5, maxNodes: 3 },
		);
		expect(scores.size).toBeLessThanOrEqual(3);
		// The seed is admitted before any neighbor.
		expect(scores.has("leftA")).toBe(true);
	});

	it("a generous hop limit reproduces the unrestricted ranking order", () => {
		const fixture = makeGraph(NODES, EDGES);
		cleanup = fixture.cleanup;

		const seeds = new Map([["leftA", 1]]);
		const restricted = fixture.manager.computePersonalizedPageRank(seeds, {
			maxHops: 10,
		});
		const full = fixture.manager.computePersonalizedPageRank(seeds, {
			maxHops: 0,
		});

		const order = (scores: Map<string, number>) =>
			[...scores.entries()]
				.filter(([id]) => restricted.has(id))
				.sort((a, b) => b[1] - a[1])
				.map(([id]) => id);

		expect(order(restricted)).toEqual(order(full));
	});
});

// ---------------------------------------------------------------------------
// Location → node resolution (the bridge from a retrieval hit to a seed)
// ---------------------------------------------------------------------------

describe("findSymbolIdAtLocation", () => {
	let cleanup = () => {};
	afterEach(() => cleanup());

	it("returns the node whose range encloses the line", () => {
		const fixture = makeGraph(NODES, EDGES);
		cleanup = fixture.cleanup;

		// leftA is symbol index 1 → src/leftA.ts lines 11..19
		expect(fixture.manager.findSymbolIdAtLocation("src/leftA.ts", 11)).toBe(
			"leftA",
		);
		expect(fixture.manager.findSymbolIdAtLocation("src/leftA.ts", 15)).toBe(
			"leftA",
		);
		expect(fixture.manager.findSymbolIdAtLocation("src/leftA.ts", 99)).toBe(
			null,
		);
		expect(fixture.manager.findSymbolIdAtLocation("src/nope.ts", 1)).toBe(null);
	});
});
