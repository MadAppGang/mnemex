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
 * Every file in `src/` that drives tracker regions in a loop.
 *
 * `indexer.ts` was the only one when this sweep was written. It stopped being
 * so in Phase 3b-2, when `branch-membership.ts` took the widen drain, the
 * narrow and the recovery loops out of it — and that file's own header says it
 * "is swept by the same caller-side sweep that covers `indexer.ts`", which was
 * not true: nothing pointed the sweep at it. Phase 3b-3 makes it true, and adds
 * `branch-sweep.ts`, which has the same shape again.
 *
 * The rule for adding to this list: if a file calls a method on an
 * `IFileTracker` inside a loop, it belongs here. The sweep's own handle
 * recogniser (T1) sees a parameter typed `IFileTracker`, which is why these
 * modules are free functions taking the tracker explicitly rather than classes
 * holding a differently-named field — a field the recogniser does not know is
 * a handle would pass this sweep by being invisible to it.
 *
 * `enricher.ts` was THAT FILE, and it is the reason the sentence above could
 * not be trusted. It is a class holding `private tracker: IFileTracker`, it has
 * driven tracker regions in a loop since phase 3b-2 (`narrowSummaries`), and it
 * was never in this list. Adding it without touching the recogniser would have
 * been WORSE than leaving it out: measured before the fix, the sweep reported
 * `findings: 0` over the file with `regionLoops: 0, regionCallsInLoops: 0` —
 * a PASS over 1 100 lines it could not see. The recogniser now finds a field by
 * its declared TYPE, and the census test below is what keeps this honest: it
 * fails if any listed file reports no region loops at all.
 */
const REGION_DRIVING_SOURCES: readonly string[] = [
	INDEXER_SOURCE,
	join(REPO, "src", "core", "branch-membership.ts"),
	join(REPO, "src", "core", "branch-sweep.ts"),
	join(REPO, "src", "core", "enrichment", "enricher.ts"),
];

/**
 * Loops that may keep an unyielded shape. One line of reason each; an entry
 * that stops matching fails the suite, so this cannot rot into a blanket pass.
 */
export const INDEXER_LOOP_ALLOWANCES: readonly LoopAllowance[] = [
	{
		// Renamed in Phase 3b-1: the dead-code penalty moved into
		// `searchScoped`, which `search` now delegates to. Same loop, same
		// reason.
		method: "searchScoped",
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

	test("the membership and sweep modules are swept too, with NO allowances", () => {
		// They were written after this sweep existed, and each of them exists to
		// hold a loop that drives tracker regions. An allowance here would need
		// the same one-line reason the indexer's does; there is none, because
		// every loop in both files yields.
		for (const source of REGION_DRIVING_SOURCES.slice(1)) {
			const result = sweepIndexerLoops(
				readFileSync(source, "utf8"),
				parser,
				[],
			);
			expect(result.findings, source).toEqual([]);
		}
	});

	test("that is not vacuous: both modules really do drive regions in loops", () => {
		const callees = new Set<string>();
		let regionLoops = 0;
		for (const source of REGION_DRIVING_SOURCES.slice(1)) {
			const { census } = sweepIndexerLoops(
				readFileSync(source, "utf8"),
				parser,
				[],
			);
			for (const callee of census.calleesInLoops) callees.add(callee);
			regionLoops += census.regionLoops;
		}
		// `branch-membership.ts`'s narrow, drain and recovery; `branch-sweep.ts`'s
		// page loop and its tree-scoped tail; `enricher.ts`'s narrow, its
		// adoption batches and its per-file state writes (§4.6).
		for (const callee of [
			"beginRemoveIntents",
			"finishNarrowBatch",
			"takeWidenIntents",
			"clearWidenIntents",
			"pendingIntents",
			"membershipPage",
			"deleteBranchTreeRows",
			"chunkIdsForPath",
			"setEnrichmentState",
			"recordEnrichmentByContent",
		]) {
			expect([...callees]).toContain(callee);
		}
		expect(regionLoops).toBeGreaterThanOrEqual(5);
	});

	/**
	 * EVERY listed file must be VISIBLE to the sweep, one by one.
	 *
	 * The test above aggregates, so a file the recogniser cannot see contributes
	 * nothing and disappears into the others' numbers — which is exactly how
	 * `enricher.ts` would have been added: `findings: 0` over a file with
	 * `regionLoops: 0`, reported as a pass. A per-file floor is what makes
	 * "finds nothing" mean something.
	 */
	test("no listed file is INVISIBLE to the sweep", () => {
		for (const source of REGION_DRIVING_SOURCES) {
			const { census } = sweepIndexerLoops(
				readFileSync(source, "utf8"),
				parser,
				[],
			);
			expect(census.regionLoops, source).toBeGreaterThan(0);
			expect(census.regionCallsInLoops, source).toBeGreaterThan(0);
		}
	});

	test("is not vacuous: it recognised the loops the tracker residue named", () => {
		const { census } = sweepIndexerLoops(
			readFileSync(INDEXER_SOURCE, "utf8"),
			parser,
			INDEXER_LOOP_ALLOWANCES,
		);
		// Residue items 1-5, plus the modified-files loop and the docs loops.
		//
		// TWO NAMES CHANGED IN PHASE 3b-2, and neither loop went away.
		// `markIndexed` is no longer called per file: the `files` stamp rides in
		// R5b's transaction with the batch's membership (§4.1.4), so the loop's
		// tracker call is `commitAddBatch`. `getChunkIds` is no longer the
		// deleted-file work list: that list now comes from `chunk_index` through
		// `removeFileFromBranch`, because `files.chunk_ids` holds code chunks
		// only and a `chunk_ids`-driven removal leaves every code unit and every
		// enriched summary behind (N4). Both successors are asserted below, so
		// this list still fails if the loops stop being recognised.
		for (const callee of [
			"commitAddBatch",
			"removeFileFromBranch",
			"removeFile",
			"deleteSymbolsByFile",
			"insertSymbols",
			"insertReferences",
			"getChanges",
			"resetEnrichmentState",
			"needsDocsRefresh",
			"markDocsIndexed",
			// 3b-2's own loops: the two-tier hit test, the narrow steps and the
			// tier-2 vector lookups.
			"knownChunkRows",
			"chunkIdsForPath",
			"narrowIds",
			"findByContentKey",
		]) {
			expect(census.calleesInLoops).toContain(callee);
		}
		expect(census.regionLoops).toBeGreaterThanOrEqual(9);
		expect(census.yieldStatements).toBeGreaterThanOrEqual(10);
	});
});

describe("a tracker held under ANOTHER field name (the enricher's shape)", () => {
	/** `enricher.ts`: a class whose handle is `this.tracker`, typed. */
	const enricherShape = (body: string) =>
		`class Enricher {\n\tprivate tracker: IFileTracker;\n\tconstructor(tracker: IFileTracker) {\n\t\tthis.tracker = tracker;\n\t}\n${body}\n}`;

	test("THE BLIND SPOT: an unyielded loop on `this.tracker` is a finding", () => {
		// Before phase 3b-4 this returned [] — the handle was recognised by the
		// NAME `this.fileTracker`, so a class calling its own `this.tracker` was
		// invisible and the sweep reported PASS over every loop in it.
		expect(
			rulesOf(
				enricherShape(`
	async narrow(paths: string[]) {
		for (const p of paths) this.tracker.chunkIdsForPath(1, "repo", p);
	}`),
			),
		).toEqual(["SR-2-caller"]);
	});

	test("and it is satisfied by the same yield the other files use", () => {
		expect(
			rulesOf(
				enricherShape(`
	async narrow(paths: string[]) {
		for (const p of paths) {
			this.tracker.chunkIdsForPath(1, "repo", p);
			await yieldToEventLoop();
		}
	}`),
			),
		).toEqual([]);
	});

	test("the handle cannot escape into a position the analysis does not model", () => {
		// Into a container, where the analysis loses it. Passing it as a call
		// ARGUMENT is deliberately fine — T3 makes the callee a region-reaching
		// call — and this is the same rule `this.fileTracker` already lives
		// under, now applied to the other field names too.
		expect(
			rulesOf(
				enricherShape(`
	leak() {
		const bag = { held: this.tracker };
		return bag;
	}`),
			),
		).toEqual(["UNSUPPORTED"]);
	});

	test("a constructor PARAMETER named like the field is not itself a finding", () => {
		// The escape check covers `this.<field>` member expressions only. A bare
		// identifier `tracker` is the constructor parameter every one of these
		// classes has, and flagging it would make a false finding out of the
		// shape this rule exists to support.
		expect(rulesOf(enricherShape("\tnoop() {}"))).toEqual([]);
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

describe("labels: a labelled jump carries its pending state to the statement it names", () => {
	/**
	 * The top-level walk used to enter every loop with NO label, so a
	 * `continue outer;` aimed at the OUTERMOST loop found no jump target and the
	 * pending region it carried was dropped: a false negative. The same loop one
	 * level down was caught, because a nested loop is entered through the
	 * `labeled_statement` case, which did pass its label. A `break` out of a
	 * labelled BLOCK had no target at all, at any depth.
	 */
	const findings = (source: string) =>
		sweepIndexerLoops(source, parser).findings.map(
			(f) => `${f.rule} ${f.callee}`,
		);

	/** Region, labelled `continue` that skips the yield, then another region. */
	const labelledBatches = (jump: string) => `
		outer: for (const batch of batches) {
			this.fileTracker!.getChunkIds(batch[0] ?? "");
			await yieldToEventLoop();
			for (const f of batch) {
				this.fileTracker!.markIndexed(f, "h", []);
				${jump}
				await yieldToEventLoop();
			}
		}`;

	test("a labelled `continue` to the OUTERMOST loop skips the yield; the next region is reached pending", () => {
		expect(
			findings(
				cls(`
	async batches(batches: string[][]) {${labelledBatches(
		`if (f.endsWith(".md")) continue outer;`,
	)}
	}`),
			),
		).toEqual(["SR-2-caller getChunkIds"]);
	});

	test("the same labelled loop one level down: caught before and after the fix", () => {
		expect(
			findings(
				cls(`
	async runs(runs: string[][][]) {
		for (const batches of runs) {${labelledBatches(
			`if (f.endsWith(".md")) continue outer;`,
		)}
		}
	}`),
			),
		).toEqual(["SR-2-caller getChunkIds"]);
	});

	test("control: a yield BEFORE the labelled `continue` settles it", () => {
		expect(
			findings(
				cls(`
	async batches(batches: string[][]) {${labelledBatches(
		`if (f.endsWith(".md")) {
					await yieldToEventLoop();
					continue outer;
				}`,
	)}
	}`),
			),
		).toEqual([]);
	});

	test("two labels on one loop: a `continue` to the OUTER label lands on that loop", () => {
		expect(
			findings(
				cls(`
	async batches(batches: string[][]) {
		first: ${labelledBatches(`if (f.endsWith(".md")) continue first;`).trimStart()}
	}`),
			),
		).toEqual(["SR-2-caller getChunkIds"]);
	});

	test("a `break` out of a labelled BLOCK skips the yield inside it", () => {
		expect(
			findings(
				cls(`
	async stamp(files: string[]) {
		for (const f of files) {
			this.fileTracker!.markIndexed(f, "h", []);
			check: {
				if (f.endsWith(".md")) break check;
				await yieldToEventLoop();
			}
		}
	}`),
			),
		).toEqual(["SR-2-caller markIndexed"]);
		// An UNLABELLED `break` inside a labelled block leaves the loop, not
		// the block: the loop exits, so nothing reaches the next turn pending.
		expect(
			findings(
				cls(`
	async stamp(files: string[]) {
		for (const f of files) {
			this.fileTracker!.markIndexed(f, "h", []);
			check: {
				if (f.endsWith(".md")) break;
				await yieldToEventLoop();
			}
		}
	}`),
			),
		).toEqual([]);
	});
});

describe("a jump out of a `try` runs its `finally` on the way", () => {
	const findings = (source: string) =>
		sweepIndexerLoops(source, parser).findings.map(
			(f) => `${f.rule} ${f.callee}`,
		);

	test("a `continue` through a `finally` that runs a region lands on the next turn pending", () => {
		// Real flow: `.md` -> continue -> the finally's markIndexed -> the next
		// turn's markIndexed. The yield after the try is skipped every time.
		expect(
			findings(
				cls(`
	async stamp(files: string[]) {
		for (const f of files) {
			try {
				if (f.endsWith(".md")) continue;
			} finally {
				this.fileTracker!.markIndexed(f, "h", []);
			}
			await yieldToEventLoop();
		}
	}`),
			),
		).toEqual(["SR-2-caller markIndexed"]);
	});

	test("control: a `finally` with no region leaves the jump's state alone", () => {
		expect(
			findings(
				cls(`
	async stamp(files: string[]) {
		for (const f of files) {
			this.fileTracker!.markIndexed(f, "h", []);
			await yieldToEventLoop();
			try {
				if (f.endsWith(".md")) continue;
			} finally {
				console.log(f);
			}
		}
	}`),
			),
		).toEqual([]);
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
