/**
 * SR-2 — "no loop runs two tracker regions without a yield between them" — at
 * the standard `indexer-loop-sweep.ts` already holds: ONLY the statement
 * `await yieldToEventLoop();` is a yield.
 *
 * WHY. An `await` on an already-resolved promise continues as a MICROTASK, and
 * timers never run between microtasks, so the lock heartbeat's 1 s
 * `setInterval` stays starved across it. Measured
 * (`implementation-log-indexer-regions.md`, Finding A): 400 files of the real
 * `extractSymbols`/`extractReferences` loop took 2 377 ms with ZERO ticks of a
 * 20 ms `setInterval`, through a loop full of `await`s. The previous SR-2
 * accepted any `await` lexically between two regions, which is exactly that
 * loop's shape. The first two tests below are the brief's pair: a microtask
 * await FIRES, a `yieldToEventLoop()` await is SILENT.
 *
 * The rule's original fixtures (no await at all, wrap-around, nested-function
 * await, iterator callback) stay in `tracker-regions.test.ts` and must keep
 * passing unchanged; this file adds the shapes the stricter rule exists for.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Parser } from "web-tree-sitter";
import {
	type RegionFinding,
	regionCensus,
	sweepRegionSource,
	typescriptParser,
} from "../../helpers/tracker-region-sweep.js";

const REPO = join(import.meta.dir, "..", "..", "..");
const TRACKER_SOURCE = join(REPO, "src", "core", "tracker.ts");

let parser: Parser;

beforeAll(async () => {
	parser = await typescriptParser();
});

const MACHINERY = `
	private withRegion<T>(region: unknown, fn: () => T): T {
		this.db.exec("PRAGMA busy_timeout = 1");
		try { return fn(); } finally { this.db.exec("PRAGMA busy_timeout = 0"); }
	}
	write(x: string) { this.withRegion(W, () => this.db.prepare("W").run(x)); }`;

const cls = (body: string) => `class T {${MACHINERY}\n${body}\n}`;

function sr2(source: string): RegionFinding[] {
	return sweepRegionSource(source, parser).filter((f) => f.rule === "SR-2");
}

/** The first line of each SR-2 finding: WHICH region was reached pending. */
function sr2Texts(source: string): string[] {
	return sr2(source).map((f) => f.text);
}

/**
 * No trailing `;`: a finding's `text` is the CALL node's first line, and the
 * statement's semicolon is not part of the call. The fixtures rely on ASI.
 */
const REGION_A = `this.withRegion(A, () => this.db.prepare("S").run(x))`;
const REGION_B = `this.withRegion(B, () => this.db.prepare("T").run(x))`;

/** A loop whose ONLY thing between region A and region B is `between`. */
const twoRegions = (between: string) =>
	cls(`
	async twice(xs: string[]) {
		for (const x of xs) {
			await yieldToEventLoop();
			${REGION_A}
			${between}
			${REGION_B}
		}
	}`);

describe("SR-2 — only `await yieldToEventLoop();` is a yield", () => {
	test("FIRES when the only await between two regions is a microtask await", () => {
		expect(sr2Texts(twoRegions("await Promise.resolve();"))).toEqual([
			REGION_B,
		]);
	});

	test("is SILENT when that await is yieldToEventLoop()", () => {
		expect(sr2Texts(twoRegions("await yieldToEventLoop();"))).toEqual([]);
	});

	test.each([
		["an await on a method call (a cached parser)", "await this.parse(x);"],
		["an await on a value", "await x;"],
		["an await on Promise.all", "await Promise.all([this.parse(x)]);"],
		["a yield whose promise is not awaited", "void yieldToEventLoop();"],
		["a yield that is not awaited at all", "yieldToEventLoop();"],
		["an await on a different helper", "await yieldSomehow();"],
		["an awaited yield with an argument", "await yieldToEventLoop(1);"],
		[
			"a yield inside a nested function",
			"const later = async () => { await yieldToEventLoop(); };",
		],
	])("FIRES on %s", (_label, between) => {
		expect(sr2Texts(twoRegions(between))).toEqual([REGION_B]);
	});

	test("Finding A's shape — parse, insert, extract, insert, every await a microtask — fires twice, both regions", () => {
		const source = cls(`
	async symbols(files: string[]) {
		for (const x of files) {
			const tree = await this.parser.parse(x);
			${REGION_A}
			const refs = await extractReferences(tree);
			${REGION_B}
		}
	}`);
		// B is reached with A pending; A is reached with B pending on the
		// wrap-around. The previous SR-2 accepted this loop.
		expect(sr2Texts(source).sort()).toEqual([REGION_A, REGION_B].sort());
	});
});

describe("SR-2 — the walk follows control flow, not source order", () => {
	test("a yield in ONE branch of an if does not settle the other", () => {
		expect(sr2Texts(twoRegions("if (x) await yieldToEventLoop();"))).toEqual([
			REGION_B,
		]);
	});

	test("a yield in BOTH branches does", () => {
		expect(
			sr2Texts(
				twoRegions(
					"if (x) { await yieldToEventLoop(); } else { await yieldToEventLoop(); }",
				),
			),
		).toEqual([]);
	});

	test("a continue that skips the yield reaches the next turn pending", () => {
		const source = cls(`
	async each(xs: string[]) {
		for (const x of xs) {
			${REGION_A}
			if (x === "") continue;
			await yieldToEventLoop();
		}
	}`);
		expect(sr2Texts(source)).toEqual([REGION_A]);
	});

	test("a region that throws into a catch which continues skips the yield after the try", () => {
		const source = cls(`
	async each(xs: string[]) {
		for (const x of xs) {
			try {
				${REGION_A}
			} catch {
				continue;
			}
			await yieldToEventLoop();
		}
	}`);
		expect(sr2Texts(source)).toEqual([REGION_A]);
	});

	test("a labelled continue to the OUTER loop skips the inner yield", () => {
		const source = cls(`
	async grid(rows: string[][]) {
		outer: for (const row of rows) {
			for (const x of row) {
				${REGION_A}
				if (x === "") continue outer;
				await yieldToEventLoop();
			}
		}
	}`);
		expect(sr2Texts(source)).toEqual([REGION_A]);
	});

	test("the clean shapes stay clean: yield after each region, and yield at the top of each turn", () => {
		expect(
			sr2Texts(
				cls(`
	async a(xs: string[]) {
		for (const x of xs) {
			${REGION_A}
			await yieldToEventLoop();
			${REGION_B}
			await yieldToEventLoop();
		}
	}
	async b(xs: string[]) {
		let i = 0;
		while (i < xs.length) {
			await yieldToEventLoop();
			const x = xs[i++];
			try { ${REGION_A} } finally { await yieldToEventLoop(); }
		}
	}`),
			),
		).toEqual([]);
	});
});

describe("SR-2 — calls that REACH a region count as regions", () => {
	test("a method that opens a region, called in a loop without a yield", () => {
		expect(
			sr2Texts(
				cls(`
	drain(xs: string[]) {
		for (const x of xs) this.write(x);
	}`),
			),
		).toEqual(["this.write(x)"]);
	});

	test("...through a chain of methods, to a fixpoint", () => {
		expect(
			sr2Texts(
				cls(`
	stamp(x: string) { this.write(x); }
	outer(x: string) { this.stamp(x); }
	async drain(xs: string[]) {
		for (const x of xs) {
			this.outer(x);
			await Promise.resolve();
		}
	}`),
			),
		).toEqual(["this.outer(x)"]);
	});

	test("...and the same loop with a real yield is clean", () => {
		expect(
			sr2Texts(
				cls(`
	async drain(xs: string[]) {
		for (const x of xs) {
			this.write(x);
			await yieldToEventLoop();
		}
	}`),
			),
		).toEqual([]);
	});

	test("a local function that opens a region", () => {
		expect(
			sr2Texts(
				cls(`
	drain(xs: string[]) {
		const put = (x: string) => this.withRegion(W, () => this.db.prepare("P").run(x));
		for (const x of xs) put(x);
	}`),
			),
		).toEqual(["put(x)"]);
	});

	test("a region-reaching method inside an array iterator's callback, or handed to one by name", () => {
		expect(
			sr2Texts(
				cls(`
	a(xs: string[]) { xs.map((x) => this.write(x)); }
	b(xs: string[]) { xs.forEach(this.write); }`),
			),
		).toEqual(["this.write(x)", "xs.forEach(this.write)"]);
	});

	test("a method that does NOT reach a region is not one", () => {
		expect(
			sr2Texts(
				cls(`
	hash(x: string) { return x.length; }
	sum(xs: string[]) {
		let n = 0;
		for (const x of xs) n += this.hash(x);
		return n;
	}`),
			),
		).toEqual([]);
	});

	test("withRegion used as anything but a callee is itself a finding: the walk could not see its regions", () => {
		expect(
			sr2Texts(
				cls(`
	drain(xs: string[]) {
		const open = this.withRegion.bind(this);
		for (const x of xs) open(W, () => this.db.prepare("P").run(x));
	}`),
			),
		).toEqual(["this.withRegion"]);
	});
});

describe("SR-2 over src/core/tracker.ts", () => {
	test("finds nothing", () => {
		expect(sr2(readFileSync(TRACKER_SOURCE, "utf8"))).toEqual([]);
	});

	test("the recogniser is not vacuous: it sees the tracker's region-reaching methods", () => {
		const census = regionCensus(readFileSync(TRACKER_SOURCE, "utf8"), parser);
		console.log(`tracker.ts SR-2 census ${JSON.stringify(census)}`);
		// Every public method is one region; the recogniser must see them all,
		// or a loop calling one would pass unseen.
		expect(census.reachingMethods).toBeGreaterThanOrEqual(60);
		// Pinned: tracker.ts has NO loop that reaches a region — every per-row
		// loop runs INSIDE a region's callback, on one prepared statement. If
		// this count moves, a loop was added or removed, and the findings test
		// above is what decides whether it yields.
		expect(census.regionLoops).toBe(0);
	});
});
