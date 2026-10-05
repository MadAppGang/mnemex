/**
 * TEST-54 root cause: a symbol is not its own caller.
 *
 * ── WHERE THE SELF-EDGE CAME FROM ───────────────────────────────────────────
 * The TypeScript (and TSX, Go, Rust, C, C++, …) reference queries capture a BARE
 * `(type_identifier) @ref.type` (`src/parsers/parser-manager.ts`). That pattern
 * also matches the `name:` node of the declaration itself —
 * `export interface DeadShape {` yields `DeadShape -> DeadShape` at line 1,
 * because `findEnclosingSymbol` hands back the interface for its own first
 * line (`src/core/symbol-extractor.ts`, `extractReferences`).
 * `resolveReferencesByName` then resolves it to the interface whenever it is
 * exported. Every exported type therefore had `in_degree >= 1`,
 * listed itself under `callers`, and carried a self-loop that kept its PageRank
 * mass. Measured on this file's fixture: 0.2410 for the unreferenced interface
 * against 0.0361 for an unreferenced function, the 6.7x that kept it above the
 * `< 0.001` rule in TEST-54's fixture (0.0041 vs 0.0006).
 *
 * ── TWO FIXES, EACH PINNED SEPARATELY ───────────────────────────────────────
 *   1. `updateDegreeCounts` excludes self-edges from `in_degree`. Pinned by the
 *      self-recursive function, whose self-edge is a REAL call and survives the
 *      extractor fix. It is pinned by the raw-SQL test below as well, so it does
 *      not lean on the extractor.
 *   2. `extractReferences` does not record a declaration's own name node as a
 *      `type_usage` of itself. Pinned by `callers` and by PageRank parity.
 *      A genuine self-reference inside the body (`next?: ListNode`) is still
 *      recorded, and fix 1 is what keeps it out of `in_degree`.
 *
 * Falsifiers (all run during the fix):
 *   - Dropping `AND r.from_symbol_id <> symbols.id` turns 3 tests red: the type
 *     test (through `ListNode`'s body self-reference), the recursion test and
 *     the raw-SQL test.
 *   - Disabling the extractor guard turns 5 tests red: the `callers`,
 *     body-self-reference, PageRank-parity, `findDeadCode` and Rust tests.
 *   - Replacing declaration identity with the first version's span check
 *     ("parent spans the symbol's lines") turns 5 multi-language tests red:
 *     one-line declarations lost their same-named usages.
 *   - Dropping the identity check (any `name:` field qualifies) turns 7 red.
 *   - Dropping the "node IS the parent's `name:` field" comparison turns the
 *     Go same-named return type red.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodeAnalyzer } from "../../../src/core/analysis/analyzer.js";
import { createReferenceGraphManager } from "../../../src/core/reference-graph.js";
import { createSymbolExtractor } from "../../../src/core/symbol-extractor.js";
import { FileTracker } from "../../../src/core/tracker.js";
import type { SymbolDefinition, SymbolReference } from "../../../src/types.js";

const BRANCH = 1;
const FILE = "src/shapes.ts";
const NOW = "2026-01-01T00:00:00.000Z";

const SOURCE = [
	"export interface DeadShape {", // 1  referenced by nothing
	"  a: string;",
	"}",
	"export interface LiveShape {", // 4  referenced by useLive
	"  b: number;",
	"}",
	"export type DeadAlias = {", // 7  referenced by nothing
	"  c: boolean;",
	"};",
	"export interface ListNode {", // 10 references only itself, in its body
	"  next?: ListNode;",
	"}",
	"export function deadFn(): number {", // 13 referenced by nothing
	"  return 1;",
	"}",
	"export function recurse(n: number): number {", // 16 calls only itself
	"  return n <= 0 ? 0 : recurse(n - 1);",
	"}",
	"export function useLive(x: LiveShape): number {", // 19
	"  return x.b;",
	"}",
	"export class Tree<T> {", // 22 references only itself, through a generic
	"  v?: T;",
	"  kids?: Tree<T>[];",
	"}",
].join("\n");

const tempDirs: string[] = [];
const trackers: FileTracker[] = [];

afterEach(() => {
	for (const t of trackers.splice(0)) t.close();
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function openTracker(): FileTracker {
	const root = mkdtempSync(join(tmpdir(), "self-edge-degree-"));
	tempDirs.push(root);
	const tracker = new FileTracker(join(root, "index.db"), root);
	trackers.push(tracker);
	return tracker;
}

interface Indexed {
	readonly tracker: FileTracker;
	readonly references: SymbolReference[];
	readonly byName: (name: string) => SymbolDefinition;
	readonly callersOf: (name: string) => string[];
}

/** The indexer's own symbol-graph sequence (`extractSymbolGraph`), minus files. */
async function indexFixture(): Promise<Indexed> {
	const tracker = openTracker();
	const graph = tracker.graph(BRANCH);
	const extractor = createSymbolExtractor();
	const symbols = await extractor.extractSymbols(SOURCE, FILE, "typescript");
	graph.insertSymbols(symbols);
	const references = await extractor.extractReferences(
		SOURCE,
		FILE,
		"typescript",
		symbols,
	);
	graph.insertReferences(references);

	const manager = createReferenceGraphManager(tracker, BRANCH);
	await manager.resolveReferences();
	await manager.computeAndStorePageRank();

	const stored = graph.getAllSymbols();
	const byName = (name: string): SymbolDefinition => {
		const hit = stored.filter((s) => s.name === name);
		expect(hit.length).toBe(1);
		return hit[0] as SymbolDefinition;
	};
	const callersOf = (name: string): string[] =>
		manager.getCallers(byName(name).id).map((s) => s.name);
	return { tracker, references, byName, callersOf };
}

describe("in_degree excludes self-edges (updateDegreeCounts)", () => {
	test("a type with no other references has in_degree 0", async () => {
		const { byName } = await indexFixture();
		expect({
			DeadShape: byName("DeadShape").inDegree,
			DeadAlias: byName("DeadAlias").inDegree,
			ListNode: byName("ListNode").inDegree,
			Tree: byName("Tree").inDegree,
		}).toEqual({ DeadShape: 0, DeadAlias: 0, ListNode: 0, Tree: 0 });
	});

	test("a self-recursive function with no other callers has in_degree 0", async () => {
		const { byName, references } = await indexFixture();
		// Precondition: the recursive call IS recorded, so the SQL clause is what
		// keeps it out of in_degree.
		const recurseId = byName("recurse").id;
		expect(
			references.some(
				(r) => r.fromSymbolId === recurseId && r.toSymbolName === "recurse",
			),
		).toBe(true);
		expect(byName("recurse").inDegree).toBe(0);
	});

	test("a type referenced from another symbol keeps in_degree >= 1 (its real caller only)", async () => {
		const { byName } = await indexFixture();
		expect(byName("LiveShape").inDegree).toBe(1);
	});

	test("the SQL clause alone: a stored self-edge does not count, a real edge does", () => {
		const tracker = openTracker();
		const graph = tracker.graph(BRANCH);
		const sym = (id: string, name: string): SymbolDefinition => ({
			id,
			name,
			kind: "function",
			filePath: FILE,
			startLine: 1,
			endLine: 2,
			isExported: true,
			language: "typescript",
			pagerankScore: 0,
			createdAt: NOW,
			updatedAt: NOW,
		});
		const ref = (from: string, toName: string): SymbolReference => ({
			fromSymbolId: from,
			toSymbolName: toName,
			kind: "call",
			filePath: FILE,
			line: 1,
			isResolved: false,
			createdAt: NOW,
		});
		graph.insertSymbols([sym("s-self", "selfOnly"), sym("s-both", "both")]);
		graph.insertReferences([
			ref("s-self", "selfOnly"),
			ref("s-both", "both"),
			ref("s-self", "both"),
		]);
		graph.resolveReferencesByName();
		graph.updateDegreeCounts();
		const deg = new Map(
			graph.getAllSymbols().map((s) => [s.name, [s.inDegree, s.outDegree]]),
		);
		// out_degree is deliberately unchanged (no reader; see the log).
		expect(Object.fromEntries(deg)).toEqual({
			selfOnly: [0, 2],
			both: [1, 1],
		});
	});
});

describe("a declaration's own name is not a reference (extractReferences)", () => {
	test("callers of an unreferenced interface / type alias are empty, not itself", async () => {
		const { callersOf } = await indexFixture();
		expect({
			DeadShape: callersOf("DeadShape"),
			DeadAlias: callersOf("DeadAlias"),
			LiveShape: callersOf("LiveShape"),
		}).toEqual({ DeadShape: [], DeadAlias: [], LiveShape: ["useLive"] });
	});

	test("a genuine self-reference in the body is still recorded", async () => {
		const { references, byName } = await indexFixture();
		const selfLines = (name: string): number[] => {
			const id = byName(name).id;
			return references
				.filter((r) => r.fromSymbolId === id && r.toSymbolName === name)
				.map((r) => r.line);
		};
		// `Tree<T>` is a `generic_type` whose `name:` field is `Tree`. It is not
		// the declaration node, so the span check keeps it.
		expect({
			ListNode: selfLines("ListNode"),
			Tree: selfLines("Tree"),
		}).toEqual({ ListNode: [11], Tree: [24] });
	});

	test("an unreferenced interface scores what an unreferenced function scores", async () => {
		const { byName } = await indexFixture();
		// Self-loop inflation made this 6.7x: 0.2410 vs 0.0361.
		expect(byName("DeadShape").pagerankScore).toBeCloseTo(
			byName("deadFn").pagerankScore,
			10,
		);
		expect(byName("DeadAlias").pagerankScore).toBeCloseTo(
			byName("deadFn").pagerankScore,
			10,
		);
	});

	test("dead-code reports the unreferenced types, and not the referenced one", async () => {
		const { tracker, byName } = await indexFixture();
		// An 8-symbol graph cannot reach the production 0.001 threshold, so use the
		// unreferenced function's own score: whatever qualifies it qualifies them.
		const dead = createCodeAnalyzer(tracker, BRANCH)
			.findDeadCode({
				unexportedOnly: false,
				maxPageRank: byName("deadFn").pagerankScore + 1e-12,
			})
			.map((r) => r.symbol.name)
			.sort();
		// `recurse`, `ListNode` and `Tree` are ABSENT, and that is a recorded limitation,
		// not an oversight. Both carry a REAL self-reference. `findDeadCode` reads
		// `getCallers()`, which still lists the symbol itself, and the self-loop
		// still holds their PageRank above an unreferenced symbol's. Only the
		// `in_degree` column ignores self-edges.
		expect(dead).toEqual(["DeadAlias", "DeadShape", "deadFn", "useLive"]);
	});
});

/**
 * The guard must skip a declaration's OWN name node and nothing else, in every
 * grammar that captures a bare `type_identifier`. Asserted on the extracted
 * references (`from->to@line`), per language. Each case names the mutation
 * that turns it red (all executed; see the implementation log):
 *   SPAN  — the first version of the guard: "parent spans the symbol's lines"
 *           instead of declaration identity. Drops same-named usages on a
 *           ONE-LINE declaration.
 *   INDEX — identity check kept, but the "node IS the parent's `name:` field"
 *           comparison removed. Drops Go's same-named method return type.
 *   OFF   — guard disabled. Records the declaration self-edge again.
 */
describe("the guard skips the declaration's own name, and only it (multi-language)", () => {
	type Lang = "typescript" | "go" | "rust" | "cpp";
	async function refsOf(
		language: Lang,
		file: string,
		source: string,
	): Promise<string[]> {
		const extractor = createSymbolExtractor();
		const symbols = await extractor.extractSymbols(source, file, language);
		const refs = await extractor.extractReferences(
			source,
			file,
			language,
			symbols,
		);
		const nameOf = new Map(symbols.map((s) => [s.id, s.name]));
		return refs.map(
			(r) => `${nameOf.get(r.fromSymbolId)}->${r.toSymbolName}@${r.line}`,
		);
	}

	test("TS barrel re-export `export type User = api.User;` keeps its reference (SPAN)", async () => {
		const refs = await refsOf(
			"typescript",
			"src/index.ts",
			'import * as api from "./api";\nexport type User = api.User;\n',
		);
		expect(refs).toContain("User->User@2");
	});

	test("TS one-line `interface Props extends Base.Props {}` keeps its reference (SPAN)", async () => {
		const refs = await refsOf(
			"typescript",
			"src/props.ts",
			"export interface Props extends Base.Props {}\n",
		);
		expect(refs).toContain("Props->Props@1");
	});

	test("TS one-line recursive `type Tree<T> = { kids: Tree<T>[] }` keeps its self-usage (SPAN)", async () => {
		const refs = await refsOf(
			"typescript",
			"src/tree.ts",
			"export type Tree<T> = { kids: Tree<T>[] };\n",
		);
		expect(refs).toContain("Tree->Tree@1");
	});

	test("Go method returning its own name `func (s *S) Config() Config` keeps the return type (INDEX)", async () => {
		const refs = await refsOf(
			"go",
			"cfg.go",
			"package cfg\n\nfunc (s *S) Config() Config {\n\treturn s.cfg\n}\n",
		);
		expect(refs).toContain("Config->Config@3");
	});

	test("Rust: `struct Point` declaration dropped, `impl Point` kept; one-line tuple struct keeps `other::Foo` (OFF, SPAN)", async () => {
		const refs = await refsOf(
			"rust",
			"lib.rs",
			[
				"pub struct Point {", // 1 declaration: no self-edge
				"    x: i32,",
				"}",
				"impl Point {}", // 4 real usage
				"pub struct Foo(pub other::Foo);", // 5 real usage on a one-line declaration
			].join("\n"),
		);
		expect({
			declarationSelfEdge: refs.includes("Point->Point@1"),
			implUsage: refs.includes("impl_Point->Point@4"),
			tupleUsage: refs.includes("Foo->Foo@5"),
		}).toEqual({
			declarationSelfEdge: false,
			implUsage: true,
			tupleUsage: true,
		});
	});

	test("C++ one-line `struct Foo : ns::Foo {};` keeps its base-class reference (SPAN)", async () => {
		const refs = await refsOf("cpp", "foo.cpp", "struct Foo : ns::Foo {};\n");
		expect(refs).toContain("Foo->Foo@1");
	});
});
