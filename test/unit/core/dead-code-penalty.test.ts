/**
 * R1 — the dead-code penalty judges the symbol in the result's OWN file.
 *
 * ── THE DEFECT (I-23, step3-scope.md §1.1 D-DEAD) ───────────────────────────
 * `searchScoped` looked the symbol up by NAME and then picked the one whose
 * `filePath` equalled the result's:
 *
 *     syms.find((s) => s.filePath === r.chunk.filePath) ?? syms[0]
 *
 * A result's path leaves the store ABSOLUTE (`outputPath()`); a symbol's path
 * is stored and returned REPO-RELATIVE. The comparison matched 0 of 217 times on
 * the rig, and `?? syms[0]` then judged an arbitrary same-named symbol from
 * ANOTHER file — `get` in `embed-cache.ts` (371 callers) was demoted for a
 * same-named test helper with none, and the genuinely dead `SearchResult`
 * escaped because a namesake had 56.
 *
 * ── THE FIX UNDER TEST ──────────────────────────────────────────────────────
 * `BranchScopedGraph.getSymbolsByNameInFiles` takes `(name, filePath)` pairs —
 * absolute or stored — converts each path with the handle's own stored-path
 * mapper and compares IN STORED FORM, inside the tracker, in one batched,
 * branch-scoped read. `pickSameFileSymbol` chooses among same-file candidates
 * by line overlap and returns null when it cannot decide; null means NO
 * penalty. There is no fallback to another file.
 *
 * Every fixture here is a REAL `FileTracker` on a real SQLite file. The result
 * rows carry ABSOLUTE paths under the tracker's path root, exactly as
 * `VectorStore.search` hands them to `searchScoped`.
 *
 * Ids follow the architecture's verification table: P-1..P-4 and G-1.
 * Falsifiers are recorded, red then green, in the session implementation log.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	applyDeadCodePenalty,
	DEAD_CODE_PENALTY,
	pickSameFileSymbol,
} from "../../../src/core/indexer.js";
import { FileTracker } from "../../../src/core/tracker.js";
import type { SearchResult, SymbolDefinition } from "../../../src/types.js";

const MAIN = 1;
const FEAT = 2;
const NOW = "2026-01-01T00:00:00.000Z";

const tempDirs: string[] = [];
const trackers: FileTracker[] = [];

afterEach(() => {
	for (const t of trackers.splice(0)) t.close();
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

interface Fixture {
	readonly root: string;
	readonly tracker: FileTracker;
}

function openFixture(): Fixture {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "dead-code-penalty-")));
	tempDirs.push(root);
	const tracker = new FileTracker(join(root, "index.db"), root);
	trackers.push(tracker);
	return { root, tracker };
}

let nextId = 0;

/** A stored symbol: repo-relative path, as the indexer writes it. */
function sym(
	name: string,
	filePath: string,
	opts: {
		start?: number;
		end?: number;
		inDegree?: number;
		pagerank?: number;
	} = {},
): SymbolDefinition {
	nextId++;
	return {
		id: `sym-${nextId}`,
		name,
		kind: "function",
		filePath,
		startLine: opts.start ?? 1,
		endLine: opts.end ?? 10,
		isExported: true,
		language: "typescript",
		pagerankScore: opts.pagerank ?? 0,
		inDegree: opts.inDegree ?? 0,
		outDegree: 0,
		createdAt: NOW,
		updatedAt: NOW,
	};
}

const LIVE = { inDegree: 371, pagerank: 0.007 } as const;
const DEAD = { inDegree: 0, pagerank: 0 } as const;

/** A search result as `VectorStore.search` returns it: ABSOLUTE path. */
function result(
	root: string,
	relPath: string,
	name: string | undefined,
	score: number,
	start = 1,
	end = 10,
): SearchResult {
	return {
		chunk: {
			id: `chunk-${relPath}-${name ?? "anon"}-${start}`,
			content: "",
			filePath: join(root, relPath),
			startLine: start,
			endLine: end,
			language: "typescript",
			chunkType: "function",
			name,
			fileHash: "h",
		},
		score,
		vectorScore: 0,
		keywordScore: score,
	};
}

// ════════════════════════════════════════════════════════════════════════════
// P-1 / P-2 — the same-file match, and the verdict it drives
// ════════════════════════════════════════════════════════════════════════════

describe("P-1: a duplicated name resolves to the symbol in the result's own file", () => {
	test("every resolvable result matches in its own file (A)", () => {
		const { root, tracker } = openFixture();
		// The DEAD namesake is inserted FIRST, so it is what an arbitrary
		// `syms[0]` would hand back — the order the rig's test files sorted in.
		tracker
			.graph(MAIN)
			.insertSymbols([
				sym("get", "test/unit/caching.test.ts", DEAD),
				sym("get", "src/core/embed-cache.ts", LIVE),
			]);
		const results = [
			result(root, "src/core/embed-cache.ts", "get", 0.9),
			result(root, "test/unit/caching.test.ts", "get", 0.8),
		];

		const stats = applyDeadCodePenalty(results, tracker.graph(MAIN));

		// ABSOLUTE: both results have a namesake in their own file, so both
		// lookups must succeed. The shipped comparison scored 0 here.
		expect(stats).toEqual({ lookups: 2, sameFile: 2, applied: 1, labelled: 0 });
	});
});

describe("P-2: live is never penalised for a dead namesake, and dead is", () => {
	test("live `get` keeps its score; dead `get` is demoted (A)", () => {
		const { root, tracker } = openFixture();
		tracker
			.graph(MAIN)
			.insertSymbols([
				sym("get", "test/unit/caching.test.ts", DEAD),
				sym("get", "src/core/embed-cache.ts", LIVE),
			]);
		const live = result(root, "src/core/embed-cache.ts", "get", 0.9);
		const dead = result(root, "test/unit/caching.test.ts", "get", 0.8);

		applyDeadCodePenalty([live, dead], tracker.graph(MAIN));

		expect(live.score).toBe(0.9);
		expect(live.penalty).toBeUndefined();
		expect(dead.score).toBeCloseTo(0.8 * DEAD_CODE_PENALTY, 10);
		expect(dead.penalty).toBe("dead");
	});

	test("dead `deadFn` in C is penalised while live `deadFn` in D is not (A)", () => {
		const { root, tracker } = openFixture();
		// LIVE first this time: the shipped fallback would let the dead one in
		// C escape by borrowing D's callers.
		tracker
			.graph(MAIN)
			.insertSymbols([
				sym("deadFn", "src/d.ts", LIVE),
				sym("deadFn", "src/c.ts", DEAD),
			]);
		const inC = result(root, "src/c.ts", "deadFn", 0.7);
		const inD = result(root, "src/d.ts", "deadFn", 0.6);

		const stats = applyDeadCodePenalty([inC, inD], tracker.graph(MAIN));

		expect(inC.penalty).toBe("dead");
		expect(inC.score).toBeCloseTo(0.7 * DEAD_CODE_PENALTY, 10);
		expect(inD.penalty).toBeUndefined();
		expect(inD.score).toBe(0.6);
		expect(stats).toEqual({ lookups: 2, sameFile: 2, applied: 1, labelled: 0 });
	});
});

// ════════════════════════════════════════════════════════════════════════════
// P-3 / P-4 — when the subject cannot be found, NOTHING happens
// ════════════════════════════════════════════════════════════════════════════

describe("P-3: a name that exists only in OTHER files is not penalised", () => {
	test("no same-file symbol -> no penalty, even with a dead namesake elsewhere (A)", () => {
		const { root, tracker } = openFixture();
		tracker.graph(MAIN).insertSymbols([sym("orphan", "src/b.ts", DEAD)]);
		const r = result(root, "src/a.ts", "orphan", 0.5);
		const other = result(root, "src/x.ts", undefined, 0.4);

		const stats = applyDeadCodePenalty([r, other], tracker.graph(MAIN));

		expect(r.score).toBe(0.5);
		expect(r.penalty).toBeUndefined();
		// The unnamed row is not a lookup at all.
		expect(stats).toEqual({ lookups: 1, sameFile: 0, applied: 0, labelled: 0 });
	});
});

describe("P-4: two same-name symbols in ONE file — the chunk's span decides", () => {
	test("overlap picks the right one; no overlap -> no penalty (A)", () => {
		const { root, tracker } = openFixture();
		tracker
			.graph(MAIN)
			.insertSymbols([
				sym("handler", "src/h.ts", { ...DEAD, start: 1, end: 5 }),
				sym("handler", "src/h.ts", { ...LIVE, start: 10, end: 20 }),
			]);
		const onLive = result(root, "src/h.ts", "handler", 0.9, 10, 20);
		const onDead = result(root, "src/h.ts", "handler", 0.8, 1, 5);
		const onNeither = result(root, "src/h.ts", "handler", 0.7, 30, 40);

		const stats = applyDeadCodePenalty(
			[onLive, onDead, onNeither],
			tracker.graph(MAIN),
		);

		expect(onLive.penalty).toBeUndefined();
		expect(onDead.penalty).toBe("dead");
		expect(onNeither.penalty).toBeUndefined();
		expect(onNeither.score).toBe(0.7);
		expect(stats).toEqual({ lookups: 3, sameFile: 2, applied: 1, labelled: 0 });
	});

	test("pickSameFileSymbol: one -> it; several -> largest overlap; none -> null", () => {
		const a = sym("f", "src/f.ts", { start: 1, end: 5 });
		const b = sym("f", "src/f.ts", { start: 4, end: 20 });
		expect(pickSameFileSymbol([], 1, 5)).toBeNull();
		// One candidate is the subject, whatever its lines say.
		expect(pickSameFileSymbol([a], 100, 200)).toBe(a);
		// Overlap with 3..6: a covers 3 lines (3-5), b covers 3 lines (4-6) —
		// a tie, broken by the TIGHTER span (a is 5 lines, b 17).
		expect(pickSameFileSymbol([b, a], 3, 6)).toBe(a);
		// Overlap with 4..20: a 2 lines, b 17 lines.
		expect(pickSameFileSymbol([a, b], 4, 20)).toBe(b);
		// Several, none overlapping: undecidable -> null.
		expect(pickSameFileSymbol([a, b], 30, 40)).toBeNull();
	});
});

// ════════════════════════════════════════════════════════════════════════════
// G-1 — the graph read: stored-form comparison, branch-scoped, batched
// ════════════════════════════════════════════════════════════════════════════

describe("G-1: getSymbolsByNameInFiles", () => {
	test("absolute and stored arguments give the SAME answer, in stored spelling", () => {
		const { root, tracker } = openFixture();
		tracker.graph(MAIN).insertSymbols([sym("get", "src/core/embed-cache.ts")]);
		const graph = tracker.graph(MAIN);

		const [byAbs, byStored] = graph.getSymbolsByNameInFiles([
			{ name: "get", filePath: join(root, "src/core/embed-cache.ts") },
			{ name: "get", filePath: "src/core/embed-cache.ts" },
		]);

		expect(byAbs.map((s) => s.id)).toEqual(byStored.map((s) => s.id));
		expect(byAbs).toHaveLength(1);
		// NO output spelling change: symbols still leave the tracker stored.
		expect(byAbs[0].filePath).toBe("src/core/embed-cache.ts");
	});

	test("another branch's symbol is never returned", () => {
		const { root, tracker } = openFixture();
		tracker.graph(FEAT).insertSymbols([sym("onlyOnFeat", "src/f.ts", DEAD)]);
		const key = { name: "onlyOnFeat", filePath: join(root, "src/f.ts") };

		expect(tracker.graph(MAIN).getSymbolsByNameInFiles([key])).toEqual([[]]);
		expect(tracker.graph(FEAT).getSymbolsByNameInFiles([key])[0]).toHaveLength(
			1,
		);

		// And so the penalty on MAIN does nothing with FEAT's dead symbol.
		const r = result(root, "src/f.ts", "onlyOnFeat", 0.5);
		const r2 = result(root, "src/g.ts", undefined, 0.4);
		expect(applyDeadCodePenalty([r, r2], tracker.graph(MAIN))).toEqual({
			lookups: 1,
			sameFile: 0,
			applied: 0,
			labelled: 0,
		});
		expect(r.score).toBe(0.5);
	});

	test("answers align with the keys, across several statements (> 64 pairs)", () => {
		const { root, tracker } = openFixture();
		const symbols: SymbolDefinition[] = [];
		for (let i = 0; i < 150; i++) {
			symbols.push(sym(`fn${i}`, `src/m${i % 7}.ts`, { start: i, end: i }));
		}
		tracker.graph(MAIN).insertSymbols(symbols);

		const keys = symbols.map((s) => ({
			name: s.name,
			filePath: join(root, s.filePath),
		}));
		// A miss, a path outside the tree, and a duplicate key, interleaved.
		keys.splice(10, 0, { name: "fn3", filePath: join(root, "src/m0.ts") });
		keys.splice(20, 0, { name: "fn1", filePath: "/elsewhere/src/m1.ts" });
		keys.push({ ...keys[0] });

		const answers = tracker.graph(MAIN).getSymbolsByNameInFiles(keys);

		expect(answers).toHaveLength(keys.length);
		for (let i = 0; i < keys.length; i++) {
			if (i === 10 || i === 20) {
				expect(answers[i], `key ${i}`).toEqual([]);
				continue;
			}
			expect(answers[i], `key ${i}`).toHaveLength(1);
			expect(answers[i][0].name).toBe(keys[i].name);
			expect(join(root, answers[i][0].filePath)).toBe(keys[i].filePath);
		}
	});

	test("an empty key list issues no statement and returns []", () => {
		const { tracker } = openFixture();
		expect(tracker.graph(MAIN).getSymbolsByNameInFiles([])).toEqual([]);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// R3.8 — overlay rows have no symbol graph, so the penalty never judges them
// ════════════════════════════════════════════════════════════════════════════

describe("R3.8: a dirty-overlay row is never looked up or penalised", () => {
	test("source=dirty is skipped even when its file holds a DEAD namesake in the graph (A)", () => {
		const { root, tracker } = openFixture();
		// The graph describes the INDEXED revision of src/c.ts, where `deadFn`
		// is dead. The overlay row is the uncommitted revision: the graph says
		// nothing about it, so judging it by that symbol would be a guess.
		tracker
			.graph(MAIN)
			.insertSymbols([
				sym("deadFn", "src/c.ts", DEAD),
				sym("liveFn", "src/d.ts", DEAD),
			]);
		const dirtyRow: SearchResult = {
			...result(root, "src/c.ts", "deadFn", 0.7),
			source: "dirty",
		};
		const indexRow = result(root, "src/d.ts", "liveFn", 0.6);

		const stats = applyDeadCodePenalty(
			[dirtyRow, indexRow],
			tracker.graph(MAIN),
		);

		expect(dirtyRow.score).toBe(0.7);
		expect(dirtyRow.penalty).toBeUndefined();
		expect(indexRow.penalty).toBe("dead");
		expect(stats).toEqual({ lookups: 1, sameFile: 1, applied: 1, labelled: 0 });
	});

	test("the cloud path's `source` values are NOT the local overlay and are judged as before", () => {
		const { root, tracker } = openFixture();
		tracker.graph(MAIN).insertSymbols([sym("deadFn", "src/c.ts", DEAD)]);
		const cloudRow: SearchResult = {
			...result(root, "src/c.ts", "deadFn", 0.7),
			source: "overlay",
		};
		const stats = applyDeadCodePenalty([cloudRow], tracker.graph(MAIN));
		expect(cloudRow.penalty).toBe("dead");
		expect(stats).toEqual({ lookups: 1, sameFile: 1, applied: 1, labelled: 0 });
	});
});

// ════════════════════════════════════════════════════════════════════════════
// P-6 — a chunk named with a LABEL is judged by the symbol the label names
// (iteration 2, F1). Before: `X (fields)` / `X (part n/m)` was looked up
// verbatim, found nothing, and escaped — `SearchResult (fields)` in
// `src/types.ts` among 16 dead escapes on the rig.
// ════════════════════════════════════════════════════════════════════════════

describe("P-6: a label-named chunk is judged by the symbol its label names", () => {
	/** A `SearchResult`-shaped row, as `VectorStore.search` returns one. */
	function labelled(
		root: string,
		relPath: string,
		name: string,
		start: number,
		end: number,
		chunkType: SearchResult["chunk"]["chunkType"],
	): SearchResult {
		const r = result(root, relPath, name, 0.5, start, end);
		return { ...r, chunk: { ...r.chunk, chunkType } };
	}

	test("`X (fields)` over a dead interface X in the same file -> dead; the display name is unchanged (A)", () => {
		const { root, tracker } = openFixture();
		tracker.graph(MAIN).insertSymbols([
			{
				...sym("SearchResult", "src/types.ts", { start: 40, end: 90, ...DEAD }),
				kind: "interface",
			},
		]);
		const row = labelled(
			root,
			"src/types.ts",
			"SearchResult (fields)",
			44,
			60,
			"module",
		);

		const stats = applyDeadCodePenalty([row], tracker.graph(MAIN));

		expect(row.penalty).toBe("dead");
		expect(row.score).toBeCloseTo(0.5 * DEAD_CODE_PENALTY, 12);
		// `--agent name=` prints the row's own name, byte for byte.
		expect(row.chunk.name).toBe("SearchResult (fields)");
		expect(stats).toEqual({
			lookups: 1,
			sameFile: 1,
			applied: 1,
			labelled: 1,
		});
	});

	test("`X (part 2/3)` inside a dead function X -> dead", () => {
		const { root, tracker } = openFixture();
		tracker
			.graph(MAIN)
			.insertSymbols([
				sym("handleSearch", "src/cli.ts", { start: 100, end: 190, ...DEAD }),
			]);
		const row = labelled(
			root,
			"src/cli.ts",
			"handleSearch (part 2/3)",
			130,
			159,
			"function",
		);
		applyDeadCodePenalty([row], tracker.graph(MAIN));
		expect(row.penalty).toBe("dead");
		expect(row.chunk.name).toBe("handleSearch (part 2/3)");
	});

	test("a LIVE X: no penalty", () => {
		const { root, tracker } = openFixture();
		tracker.graph(MAIN).insertSymbols([
			{
				...sym("SearchResult", "src/types.ts", { start: 40, end: 90, ...LIVE }),
				kind: "interface",
			},
		]);
		const row = labelled(
			root,
			"src/types.ts",
			"SearchResult (fields)",
			44,
			60,
			"module",
		);
		const stats = applyDeadCodePenalty([row], tracker.graph(MAIN));
		expect(row.penalty).toBeUndefined();
		expect(row.score).toBe(0.5);
		expect(stats).toEqual({
			lookups: 1,
			sameFile: 1,
			applied: 0,
			labelled: 1,
		});
	});

	test("the label's base exists only in ANOTHER file: no penalty (R1.2)", () => {
		const { root, tracker } = openFixture();
		tracker
			.graph(MAIN)
			.insertSymbols([
				sym("SearchResult", "src/other.ts", { start: 40, end: 90, ...DEAD }),
			]);
		const row = labelled(
			root,
			"src/types.ts",
			"SearchResult (fields)",
			44,
			60,
			"module",
		);
		const stats = applyDeadCodePenalty([row], tracker.graph(MAIN));
		expect(row.penalty).toBeUndefined();
		expect(stats).toEqual({
			lookups: 1,
			sameFile: 0,
			applied: 0,
			labelled: 1,
		});
	});

	test("a single same-file base that does NOT overlap the span: no penalty (the label is not about it)", () => {
		const { root, tracker } = openFixture();
		tracker
			.graph(MAIN)
			.insertSymbols([
				sym("SearchResult", "src/types.ts", { start: 1, end: 20, ...DEAD }),
			]);
		const row = labelled(
			root,
			"src/types.ts",
			"SearchResult (fields)",
			44,
			60,
			"module",
		);
		const stats = applyDeadCodePenalty([row], tracker.graph(MAIN));
		expect(row.penalty).toBeUndefined();
		expect(stats.sameFile).toBe(0);
	});

	test("an UNLABELLED name keeps today's rule byte for byte: a single same-file candidate is its subject even without overlap", () => {
		const { root, tracker } = openFixture();
		tracker
			.graph(MAIN)
			.insertSymbols([
				sym("helper", "src/h.ts", { start: 1, end: 10, ...DEAD }),
			]);
		const row = result(root, "src/h.ts", "helper", 0.5, 200, 210);
		const stats = applyDeadCodePenalty([row], tracker.graph(MAIN));
		expect(row.penalty).toBe("dead");
		expect(stats).toEqual({
			lookups: 1,
			sameFile: 1,
			applied: 1,
			labelled: 0,
		});
	});

	test("one batch: labelled and plain rows together, stats count each", () => {
		const { root, tracker } = openFixture();
		tracker
			.graph(MAIN)
			.insertSymbols([
				sym("deadA", "src/a.ts", { start: 1, end: 100, ...DEAD }),
				sym("liveB", "src/b.ts", { start: 1, end: 50, ...LIVE }),
			]);
		const rows = [
			labelled(root, "src/a.ts", "deadA (part 1/2)", 1, 50, "function"),
			labelled(root, "src/a.ts", "deadA (part 2/2)", 51, 100, "function"),
			labelled(root, "src/b.ts", "liveB (fields)", 5, 9, "module"),
			result(root, "src/b.ts", "liveB", 0.5, 1, 50),
		];
		const stats = applyDeadCodePenalty(rows, tracker.graph(MAIN));
		expect(rows.map((r) => r.penalty ?? null)).toEqual([
			"dead",
			"dead",
			null,
			null,
		]);
		expect(stats).toEqual({
			lookups: 4,
			sameFile: 4,
			applied: 2,
			labelled: 3,
		});
	});
});

describe("pickSameFileSymbol — requireOverlap", () => {
	test("one candidate: returned without the option, null with it unless it overlaps", () => {
		const a = sym("x", "src/x.ts", { start: 1, end: 10 });
		expect(pickSameFileSymbol([a], 20, 30)).toBe(a);
		expect(pickSameFileSymbol([a], 20, 30, { requireOverlap: true })).toBe(
			null,
		);
		expect(pickSameFileSymbol([a], 5, 30, { requireOverlap: true })).toBe(a);
		expect(pickSameFileSymbol([], 5, 30, { requireOverlap: true })).toBe(null);
	});
});
