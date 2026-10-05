/**
 * S-Y — every work loop in `src/core/overlay/**` ends with a real yield and has
 * no `continue` (NFR-5). Model and limits: `test/helpers/overlay-yield-sweep.ts`.
 *
 * Evidence in CLAUDE.md #32's order — SIGHT before silence:
 *   1. the census: every line of every overlay file is covered by the parse
 *      tree, no ERROR nodes, and the work loops the sweep found are counted;
 *   2. planted violations fire (a loop with no yield, a yield that is not
 *      last, a `continue`, a loop whose only work is a sync filesystem call,
 *      a `yieldIfDue` that never yields), and one appended to the END of the
 *      real `dirty-overlay.ts` fires by line;
 *   3. only then: the real files have no findings.
 *
 * And the clock itself: `YieldClock.yieldIfDue()` really lets a due timer run
 * — the sweep can only see that the call is there.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Parser } from "web-tree-sitter";
import { YieldClock } from "../../../src/core/overlay/dirty-overlay.js";
import {
	type SweepFile,
	sweepOverlayYields,
} from "../../helpers/overlay-yield-sweep.js";
import { typescriptParser } from "../../helpers/tracker-region-sweep.js";

const REPO = join(import.meta.dir, "..", "..", "..");
const OVERLAY_DIR = join(REPO, "src", "core", "overlay");

let parser: Parser;
let real: SweepFile[];

beforeAll(async () => {
	parser = await typescriptParser();
	real = readdirSync(OVERLAY_DIR)
		.filter((n) => n.endsWith(".ts"))
		.map((n) => ({
			path: relative(REPO, join(OVERLAY_DIR, n)),
			source: readFileSync(join(OVERLAY_DIR, n), "utf8"),
		}));
});

const rules = (source: string) =>
	sweepOverlayYields(
		[{ path: "src/core/overlay/planted.ts", source }],
		parser,
	).findings.map((f) => f.rule);

describe("S-Y — sight first", () => {
	test("the parse covers every line of every overlay file, no ERROR nodes", () => {
		const { census } = sweepOverlayYields(real, parser);
		console.log(
			`S-Y census: files=${census.files} linesScanned=${census.linesScanned} fileLines=${census.fileLines} parseErrors=${census.parseErrors} loops=${census.loops} workLoops=${census.workLoops} clocks=${census.clocks}`,
		);
		expect(census.files).toBeGreaterThanOrEqual(3);
		expect(census.linesScanned).toBe(census.fileLines);
		expect(census.parseErrors).toBe(0);
		// dirty-overlay.ts has well over a dozen work loops; a sweep that saw
		// none would pass in silence.
		expect(census.workLoops).toBeGreaterThanOrEqual(12);
		expect(census.clocks).toBe(1);
	});
});

describe("S-Y — planted violations fire", () => {
	test("an awaiting loop with no yield", () => {
		expect(
			rules("async function f(xs) { for (const x of xs) { await g(x); } }"),
		).toEqual(["SY-no-yield"]);
	});

	test("a yield that is not the LAST statement", () => {
		expect(
			rules(
				"async function f(xs) { for (const x of xs) { await this.clock.yieldIfDue(); await g(x); } }",
			),
		).toEqual(["SY-no-yield"]);
	});

	test("a `continue` that skips the trailing yield", () => {
		expect(
			rules(
				"async function f(xs) { for (const x of xs) { if (x) continue; await g(x); await this.clock.yieldIfDue(); } }",
			),
		).toEqual(["SY-continue"]);
	});

	test("a loop whose only work is a SYNC filesystem call", () => {
		expect(
			rules("function f(xs) { for (const x of xs) { readFileSync(x); } }"),
		).toEqual(["SY-no-yield"]);
	});

	test("a `while` and a `do` loop count too", () => {
		expect(
			rules(
				"async function f() { while (a) { await g(); } do { statSync(p); } while (b); }",
			),
		).toEqual(["SY-no-yield", "SY-no-yield"]);
	});

	test("a yieldIfDue that never yields", () => {
		expect(rules("class C { async yieldIfDue() { return; } }")).toEqual([
			"SY-fake-clock",
		]);
	});

	test("NOT flagged: a pure loop, and a continue inside a nested loop", () => {
		expect(
			rules(
				"async function f(xs) { for (const x of xs) s.add(x); for (const y of ys) { for (const z of y) { if (z) continue; } await g(y); await yieldToEventLoop(); } }",
			),
		).toEqual([]);
	});

	test("a violation appended to the END of the real dirty-overlay.ts fires by line", () => {
		const file = real.find((f) => f.path.endsWith("dirty-overlay.ts"));
		if (!file) throw new Error("dirty-overlay.ts not found");
		const lines = file.source.split("\n").length;
		const planted = {
			...file,
			source: `${file.source}\nasync function late(xs) { for (const x of xs) { await g(x); } }\n`,
		};
		const { findings } = sweepOverlayYields([planted], parser);
		expect(findings.map((f) => f.rule)).toEqual(["SY-no-yield"]);
		expect(findings[0].line).toBeGreaterThan(lines);
	});

	test("removing ONE real yield is named", () => {
		const file = real.find((f) => f.path.endsWith("dirty-overlay.ts"));
		if (!file) throw new Error("dirty-overlay.ts not found");
		const marker = "\t\t\tawait this.pass.yieldClock.yieldIfDue();\n";
		const at = file.source.indexOf(marker);
		expect(at).toBeGreaterThan(0);
		const broken =
			file.source.slice(0, at) + file.source.slice(at + marker.length);
		const { findings } = sweepOverlayYields(
			[{ ...file, source: broken }],
			parser,
		);
		expect(findings.map((f) => f.rule)).toEqual(["SY-no-yield"]);
	});
});

describe("S-Y — the real overlay", () => {
	test("no findings", () => {
		expect(sweepOverlayYields(real, parser).findings).toEqual([]);
	});
});

describe("YieldClock — the yield is real", () => {
	test("past the slice, a due timer runs before yieldIfDue resolves", async () => {
		const clock = new YieldClock(5);
		let fired = false;
		setTimeout(() => {
			fired = true;
		}, 0);
		const until = Date.now() + 10;
		while (Date.now() < until) {
			// busy: the event loop cannot run here
		}
		await clock.yieldIfDue();
		expect(fired).toBe(true);
	});

	test("inside the slice it does not pay for a timer", async () => {
		const clock = new YieldClock(10_000);
		let fired = false;
		setTimeout(() => {
			fired = true;
		}, 0);
		await clock.yieldIfDue();
		expect(fired).toBe(false);
		await Bun.sleep(1);
		expect(fired).toBe(true);
	});
});
