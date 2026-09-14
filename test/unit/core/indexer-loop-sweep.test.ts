/**
 * The caller-side SR-2 sweep over `src/core/indexer.ts` — the static half of
 * V2.4 (see `test/helpers/indexer-loop-sweep.ts` for the model and its limits,
 * and `indexer-heartbeat.test.ts` for the runtime half).
 *
 * Four kinds of evidence, none of them a self-report:
 *   1. the real source is clean, with each allowance named and justified;
 *   2. the sweep is NOT vacuous — it recognised the loops the residue named;
 *   3. fixtures show every rule firing on the shape it exists for, and the
 *      clean shapes passing;
 *   4. MUTATION over the real file: deleting ANY ONE `await yieldToEventLoop();`
 *      from `indexer.ts` makes the sweep fire. A yield whose removal changed
 *      nothing would be either redundant or invisible to the sweep; neither is
 *      allowed to pass quietly.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Parser } from "web-tree-sitter";
import {
	type LoopAllowance,
	type LoopRule,
	sweepIndexerLoops,
} from "../../helpers/indexer-loop-sweep.js";
import { typescriptParser } from "../../helpers/tracker-region-sweep.js";

const REPO = join(import.meta.dir, "..", "..", "..");
const INDEXER_SOURCE = join(REPO, "src", "core", "indexer.ts");

/**
 * Loops that may keep an unyielded shape. One line of reason each; an entry
 * that stops matching fails the suite, so this cannot rot into a blanket pass.
 */
export const INDEXER_LOOP_ALLOWANCES: readonly LoopAllowance[] = [
	{
		method: "search",
		callee: "getSymbolByName",
		reason:
			"the dead-code penalty loop: search() never runs inside index(), is bounded by the result limit, and a per-result yield would add ~1 ms of setTimeout(0) per result to every query. The durable fix is one batched tracker read (residue, tracker.ts).",
	},
];

let parser: Parser;

beforeAll(async () => {
	parser = await typescriptParser();
});

function rulesOf(
	source: string,
	allow: readonly LoopAllowance[] = [],
): LoopRule[] {
	return sweepIndexerLoops(source, parser, allow).findings.map((f) => f.rule);
}

/** A minimal class with a tracker field, so fixtures read like indexer.ts. */
const cls = (body: string) =>
	`class Indexer {\n\tprivate fileTracker: IFileTracker | null = null;\n${body}\n}`;

describe("the caller-side SR-2 sweep over src/core/indexer.ts", () => {
	test("finds nothing outside the named allowances, and every allowance is used", () => {
		const result = sweepIndexerLoops(
			readFileSync(INDEXER_SOURCE, "utf8"),
			parser,
			INDEXER_LOOP_ALLOWANCES,
		);
		expect(result.findings).toEqual([]);
		expect(result.unusedAllowances).toEqual([]);
	});

	test("is not vacuous: it recognised the loops the tracker residue named", () => {
		const { census } = sweepIndexerLoops(
			readFileSync(INDEXER_SOURCE, "utf8"),
			parser,
			INDEXER_LOOP_ALLOWANCES,
		);
		// Residue items 1-5, plus the modified-files loop and the docs loops.
		for (const callee of [
			"markIndexed",
			"getChunkIds",
			"removeFile",
			"deleteSymbolsByFile",
			"insertSymbols",
			"insertReferences",
			"getChanges",
			"resetEnrichmentState",
			"needsDocsRefresh",
			"markDocsIndexed",
		]) {
			expect(census.calleesInLoops).toContain(callee);
		}
		expect(census.regionLoops).toBeGreaterThanOrEqual(9);
		expect(census.yieldStatements).toBeGreaterThanOrEqual(10);
	});
});

describe("the rules fire on the shapes they exist for", () => {
	test("clean: one region, then a yield, per turn", () => {
		expect(
			rulesOf(
				cls(`
	async stamp(files: string[]) {
		for (const f of files) {
			this.fileTracker!.markIndexed(f, "h", []);
			await yieldToEventLoop();
		}
	}`),
			),
		).toEqual([]);
	});

	test("a region in a loop with no yield at all", () => {
		expect(
			rulesOf(
				cls(`
	stamp(files: string[]) {
		for (const f of files) this.fileTracker!.markIndexed(f, "h", []);
	}`),
			),
		).toEqual(["SR-2-caller"]);
	});

	test("an `await` that is not `yieldToEventLoop()` does not count — it may be a microtask", () => {
		expect(
			rulesOf(
				cls(`
	async stamp(files: string[]) {
		for (const f of files) {
			this.fileTracker!.markIndexed(f, "h", []);
			await Promise.resolve();
		}
	}`),
			),
		).toEqual(["SR-2-caller"]);
	});

	test("two regions per turn with one yield between them: the wrap-around is unyielded", () => {
		expect(
			rulesOf(
				cls(`
	async drop(files: string[]) {
		for (const f of files) {
			this.fileTracker!.getChunkIds(f);
			await yieldToEventLoop();
			this.fileTracker!.removeFile(f);
		}
	}`),
			),
		).toEqual(["SR-2-caller"]);
	});

	test("a CONDITIONAL await between two regions settles only one path (the deleted-files shape)", () => {
		expect(
			rulesOf(
				cls(`
	async drop(files: string[]) {
		for (const f of files) {
			const ids = this.fileTracker!.getChunkIds(f);
			if (ids.length > 0) {
				await yieldToEventLoop();
			}
			this.fileTracker!.removeFile(f);
			await yieldToEventLoop();
		}
	}`),
			),
		).toEqual(["SR-2-caller"]);
	});

	test("a `continue` between a region and its yield skips the yield", () => {
		expect(
			rulesOf(
				cls(`
	async stamp(files: string[]) {
		for (const f of files) {
			this.fileTracker!.markIndexed(f, "h", []);
			if (f.endsWith(".md")) continue;
			await yieldToEventLoop();
		}
	}`),
			),
		).toEqual(["SR-2-caller"]);
	});

	test("a region that throws into a catch without a yield reaches the next turn pending", () => {
		expect(
			rulesOf(
				cls(`
	async graph(files: string[]) {
		for (const f of files) {
			try {
				this.fileTracker!.insertSymbols([]);
				await yieldToEventLoop();
			} catch {
				console.warn(f);
			}
		}
	}`),
			),
		).toEqual(["SR-2-caller"]);
		// With a yield after the try/catch, every path settles.
		expect(
			rulesOf(
				cls(`
	async graph(files: string[]) {
		for (const f of files) {
			try {
				this.fileTracker!.insertSymbols([]);
			} catch {
				console.warn(f);
			}
			await yieldToEventLoop();
		}
	}`),
			),
		).toEqual([]);
	});

	test("a nested loop that ends settled does not need a second yield; one that ends pending does", () => {
		expect(
			rulesOf(
				cls(`
	async batches(batches: string[][]) {
		for (const batch of batches) {
			for (const f of batch) {
				this.fileTracker!.markIndexed(f, "h", []);
				await yieldToEventLoop();
			}
		}
	}`),
			),
		).toEqual([]);
		// Two findings, both real: `clear()` then the first `markIndexed` with
		// no yield between; and, for an EMPTY batch (the inner loop runs zero
		// times), `clear()` straight into the next turn's `clear()`.
		expect(
			rulesOf(
				cls(`
	async batches(batches: string[][]) {
		for (const batch of batches) {
			this.fileTracker!.clear();
			for (const f of batch) {
				this.fileTracker!.markIndexed(f, "h", []);
				await yieldToEventLoop();
			}
		}
	}`),
			),
		).toEqual(["SR-2-caller", "SR-2-caller"]);
	});

	test("T1: an alias of the tracker is a tracker", () => {
		expect(
			rulesOf(
				cls(`
	stamp(files: string[]) {
		const tracker = this.fileTracker!;
		for (const f of files) tracker.markIndexed(f, "h", []);
	}`),
			),
		).toEqual(["SR-2-caller"]);
	});

	test("T2: a handle derived from the tracker is a tracker", () => {
		expect(
			rulesOf(
				cls(`
	resolve(names: string[]) {
		const graph = createReferenceGraphManager(this.fileTracker!);
		for (const n of names) graph.resolve(n);
	}`),
			),
		).toEqual(["SR-2-caller"]);
	});

	test("T3: a call HANDED the tracker may run regions", () => {
		expect(
			rulesOf(
				cls(`
	walk(commits: string[]) {
		for (const c of commits) invalidateForCommit(c, this.fileTracker!);
	}`),
			),
		).toEqual(["SR-2-caller"]);
	});

	test("T4: a method or local function that reaches a region is a region", () => {
		expect(
			rulesOf(
				cls(`
	private stampOne(f: string) { this.fileTracker!.markIndexed(f, "h", []); }
	stamp(files: string[]) {
		for (const f of files) this.stampOne(f);
	}`),
			),
		).toEqual(["SR-2-caller"]);
		expect(
			rulesOf(
				cls(`
	stamp(files: string[]) {
		const one = (f: string) => this.fileTracker!.markIndexed(f, "h", []);
		for (const f of files) one(f);
	}`),
			),
		).toEqual(["SR-2-caller"]);
	});

	test("T5: an array-iterator callback is a loop that cannot yield", () => {
		expect(
			rulesOf(
				cls(`
	stale(deps: string[]) {
		return deps.filter((d) => this.fileTracker!.needsDocsRefresh(d, null, 1));
	}`),
			),
		).toEqual(["SR-2-caller"]);
		// An async callback passed by name starts pending too.
		expect(
			rulesOf(
				cls(`
	async fetch(deps: string[]) {
		const one = async (d: string) => {
			await download(d);
			this.fileTracker!.markDocsIndexed(d, null, "p", "h", []);
		};
		await Promise.all(deps.map(one));
	}`),
			),
		).toEqual(["SR-2-caller"]);
	});

	test("UNSUPPORTED: the tracker escaping by destructuring or subscript is a finding, not a pass", () => {
		expect(
			rulesOf(
				cls(`
	stamp(files: string[]) {
		const { fileTracker } = this;
		for (const f of files) fileTracker!.markIndexed(f, "h", []);
	}`),
			),
		).toContain("UNSUPPORTED");
		expect(
			rulesOf(
				cls(`
	stamp(files: string[]) {
		for (const f of files) this["fileTracker"]!.markIndexed(f, "h", []);
	}`),
			),
		).toContain("UNSUPPORTED");
	});

	test("comments and strings are not calls", () => {
		expect(
			rulesOf(
				cls(`
	stamp(files: string[]) {
		for (const f of files) {
			// this.fileTracker!.markIndexed(f, "h", []);
			console.log("this.fileTracker!.markIndexed(f)");
		}
	}`),
			),
		).toEqual([]);
	});

	test("an allowance moves a finding aside by name, and a stale one is reported", () => {
		const source = cls(`
	search(results: string[]) {
		for (const r of results) this.fileTracker!.getSymbolByName(r);
	}`);
		const allow: LoopAllowance[] = [
			{ method: "search", callee: "getSymbolByName", reason: "fixture" },
			{ method: "search", callee: "markIndexed", reason: "stale" },
		];
		const result = sweepIndexerLoops(source, parser, allow);
		expect(result.findings).toEqual([]);
		expect(result.allowed.map((a) => a.callee)).toEqual(["getSymbolByName"]);
		expect(result.unusedAllowances.map((a) => a.callee)).toEqual([
			"markIndexed",
		]);
	});
});

describe("mutation over the real indexer.ts", () => {
	test("deleting ANY ONE `await yieldToEventLoop();` makes the sweep fire", () => {
		const source = readFileSync(INDEXER_SOURCE, "utf8");
		const pattern = /^[ \t]*await yieldToEventLoop\(\);[ \t]*$/gm;
		const sites = [...source.matchAll(pattern)];
		expect(sites.length).toBeGreaterThanOrEqual(10);

		const silent: number[] = [];
		for (const site of sites) {
			const start = site.index ?? 0;
			const mutated =
				source.slice(0, start) + source.slice(start + site[0].length);
			const findings = sweepIndexerLoops(
				mutated,
				parser,
				INDEXER_LOOP_ALLOWANCES,
			).findings.filter((f) => f.rule === "SR-2-caller");
			if (findings.length === 0) {
				silent.push(source.slice(0, start).split("\n").length);
			}
		}
		// Lines whose yield could be removed without the sweep noticing.
		expect(silent).toEqual([]);
	});
});
