/**
 * REG-1, statically (architecture §3.4, in V2.10's shape): `branches.json` is
 * mutated only by code that runs under the store lock.
 *
 * The runtime half is `RegistryNotLockedError` (`branch-registry.test.ts`). A
 * registry opened, or mutated, without the lock it was opened under throws.
 * This is the static half, over comment- and string-stripped `src/`:
 *
 *   1. `openRegistry(` and every registry MUTATOR call appear only inside a
 *      lock-held span. That is either `Indexer.indexInternal`, which only
 *      `index()` enters, after acquiring the store lock, or a `withStoreLock(`
 *      callback. The design names only the second. The indexer takes its lock
 *      with `createStoreLock(...).acquire()`, so its lock-held method is
 *      allowlisted BY NAME, with that reason.
 *   2. `src/core/branch-registry.ts` reads no clock except `./clock.js`: no
 *      `Date.now(` and no argument-less `new Date()` (§4.3).
 *   3. Only the registry module and the seam name the registry's path, so no
 *      second writer can reach the file around REG-1's handle.
 *
 * FALSIFIED by: adding `registry.resolveId(head)` to any other function in
 * `src/`, which rule 1 names; and by adding `Date.now()` to the registry, which
 * rule 2 names. The "guarding the guards" block runs both shapes on every run.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const REGISTRY_FILE = "src/core/branch-registry.ts";

/** Lock-held methods, by file, each with the reason it counts as lock-held. */
const LOCK_HELD_METHODS: Record<string, { method: string; reason: string }[]> =
	{
		"src/core/indexer.ts": [
			{
				method: "indexInternal",
				reason:
					"entered only from Indexer.index(), after createStoreLock(loc).acquire() succeeded, and left before release()",
			},
		],
		"src/core/branch-sweep.ts": [
			{
				method: "sweepTombstonedBranches",
				reason:
					"it does not OPEN a registry, it is HANDED one: the `registry: BranchRegistry` parameter can only come from `openRegistry`, which refuses unless the store lock is held, and every mutation on the handle re-checks that lock's ownership token at runtime (RegistryNotLockedError). Both of its callers pass a handle opened inside a lock — `Indexer.indexInternal` and `branches prune`'s `withStoreLock` callback, each of which this sweep checks independently. Pinned below: the function really does take a BranchRegistry parameter and really does call openRegistry nowhere",
			},
		],
	};

/**
 * A file+function allowlisted BECAUSE it receives a `BranchRegistry` must
 * actually do so, and must not open one of its own. Without this the entry
 * would be a hole: rename the parameter to something else, or add an
 * `openRegistry` call inside, and the reason above stops being true while the
 * sweep keeps passing.
 */
const HANDED_A_REGISTRY: ReadonlyArray<{ file: string; method: string }> = [
	{ file: "src/core/branch-sweep.ts", method: "sweepTombstonedBranches" },
];

/** Every mutation `BranchRegistry` has or will have (W-R1..W-R6). */
const MUTATOR_NAMES =
	"resolveId|flush|applyBranchDecisions|stamp|markNeedsReindex|finalizeTombstone|clearIndexStamp";

/**
 * Blank out comments and the CONTENTS of string and template literals, keeping
 * every newline and every other character's offset, so indices and brace
 * matching still line up with the original.
 *
 * A `'` OR `"` IS LINE-BOUNDED (Phase 3b-3). A JavaScript single- or
 * double-quoted string cannot contain a raw newline, but a REGEX LITERAL can
 * contain a quote — `store.ts:417` is `.replace(/'/g, "''")` — and a scanner
 * that pairs that apostrophe with the next one anywhere in the file runs off
 * the end of the line and blanks whatever it crosses. MEASURED on this tree:
 * the unbounded form blanked 1 178 of `store.ts`'s 3 136 code-bearing lines and
 * 1 155 of `cli.ts`'s 8 437, so every rule below was blind over them — a sweep
 * that passes by seeing nothing. Treating a partnerless quote as an ordinary
 * character bounds the damage to its own line. Backticks stay multi-line,
 * because template literals genuinely are.
 */
function codeOnly(source: string): string {
	const out = source.split("");
	let i = 0;
	const blank = (from: number, to: number) => {
		for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " ";
	};
	while (i < source.length) {
		const c = source[i];
		const next = source[i + 1];
		if (c === "/" && next === "/") {
			const end = source.indexOf("\n", i);
			const stop = end < 0 ? source.length : end;
			blank(i, stop);
			i = stop;
		} else if (c === "/" && next === "*") {
			const end = source.indexOf("*/", i + 2);
			const stop = end < 0 ? source.length : end + 2;
			blank(i, stop);
			i = stop;
		} else if (c === '"' || c === "'" || c === "`") {
			const close = closingQuote(source, i);
			if (close === null) {
				i++;
				continue;
			}
			blank(i + 1, close);
			i = close + 1;
		} else {
			i++;
		}
	}
	return out.join("");
}

/**
 * The index of the quote closing the one at `open`, or `null` when there is
 * none before the end of the line (a backtick may cross lines; the other two
 * may not).
 */
function closingQuote(source: string, open: number): number | null {
	const quote = source[open];
	for (let j = open + 1; j < source.length; j++) {
		const ch = source[j];
		if (ch === "\\") {
			j++;
			continue;
		}
		if (ch === quote) return j;
		if (ch === "\n" && quote !== "`") return null;
	}
	return null;
}

function matchingClose(code: string, openIndex: number): number {
	const open = code[openIndex];
	const close = open === "(" ? ")" : "}";
	let depth = 0;
	for (let i = openIndex; i < code.length; i++) {
		if (code[i] === open) depth++;
		else if (code[i] === close) {
			depth--;
			if (depth === 0) return i;
		}
	}
	return code.length;
}

/** [start, end) spans of `code` that run under the store lock. */
function lockHeldSpans(file: string, code: string): Array<[number, number]> {
	const spans: Array<[number, number]> = [];
	for (const { method } of LOCK_HELD_METHODS[file] ?? []) {
		// The DECLARATION, at the start of a line. The first `indexInternal(` in
		// indexer.ts is the CALL inside index(), and a span built from that is
		// the call's argument list, which holds nothing.
		const header = new RegExp(
			`^[ \\t]*(?:export )?(?:private |public |protected )?(?:async )?(?:function )?${method}\\s*\\(`,
			"m",
		).exec(code);
		if (header === null) continue;
		const params = code.indexOf("(", header.index);
		const body = code.indexOf("{", matchingClose(code, params));
		spans.push([body, matchingClose(code, body)]);
	}
	for (const call of code.matchAll(/\bwithStoreLock\s*\(/g)) {
		const open = (call.index ?? 0) + call[0].length - 1;
		spans.push([open, matchingClose(code, open)]);
	}
	return spans;
}

/** `file:line code` for every registry write outside a lock-held span. */
function reg1Violations(
	files: ReadonlyArray<{ file: string; source: string }>,
): string[] {
	const violations: string[] = [];
	for (const { file, source } of files) {
		if (file === REGISTRY_FILE) continue; // the implementation itself
		const code = codeOnly(source);
		const spans = lockHeldSpans(file, code);
		const inside = (at: number) => spans.some(([s, e]) => at > s && at < e);
		const calls = [
			...code.matchAll(/\bopenRegistry\s*\(/g),
			// `.resolveId(` on ANY receiver: the name is the registry's alone.
			...code.matchAll(/\.\s*resolveId\s*\(/g),
			// The other mutators on a receiver that says it is a registry.
			...code.matchAll(
				new RegExp(
					`\\b\\w*[Rr]egistry\\w*\\??\\.(?:${MUTATOR_NAMES})\\s*\\(`,
					"g",
				),
			),
		];
		for (const call of calls) {
			const at = call.index ?? 0;
			if (inside(at)) continue;
			const line = source.slice(0, at).split("\n").length;
			violations.push(`${file}:${line} ${source.split("\n")[line - 1].trim()}`);
		}
	}
	return [...new Set(violations)].sort();
}

function clockReads(source: string): string[] {
	const code = codeOnly(source);
	return [
		...code.matchAll(/\bDate\s*\.\s*now\s*\(/g),
		...code.matchAll(/\bnew\s+Date\s*\(\s*\)/g),
	].map((m) => m[0].replace(/\s+/g, ""));
}

function srcFiles(): Array<{ file: string; source: string }> {
	const out: Array<{ file: string; source: string }> = [];
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (/\.tsx?$/.test(entry.name)) {
				out.push({
					file: relative(REPO_ROOT, full),
					source: readFileSync(full, "utf8"),
				});
			}
		}
	};
	walk(join(REPO_ROOT, "src"));
	return out;
}

describe("REG-1, statically: branches.json is mutated only under the store lock", () => {
	test("rule 1: openRegistry and every registry mutator sit in a lock-held span", () => {
		expect(reg1Violations(srcFiles())).toEqual([]);
	});

	test("rule 1 is not vacuous: the indexer's lock-held method really does open the registry", () => {
		const indexer = srcFiles().find((f) => f.file === "src/core/indexer.ts");
		const code = codeOnly(indexer?.source ?? "");
		expect(code).toMatch(/\bopenRegistry\s*\(/);
		expect(code).toMatch(/\.\s*resolveId\s*\(/);
	});

	test("rule 2: the registry reads no clock but ./clock.js", () => {
		const registry = srcFiles().find((f) => f.file === REGISTRY_FILE);
		expect(registry).toBeDefined();
		expect(clockReads(registry?.source ?? "")).toEqual([]);
	});

	test("an allowlisted callee really is HANDED a registry, and opens none", () => {
		const files = srcFiles();
		for (const { file, method } of HANDED_A_REGISTRY) {
			const source = files.find((f) => f.file === file)?.source;
			expect(source, `${file} is not in src/`).toBeDefined();
			const code = codeOnly(source ?? "");
			const header = new RegExp(
				`^[ \\t]*(?:export )?(?:async )?(?:function )?${method}\\s*\\(`,
				"m",
			).exec(code);
			expect(header, `${file} has no ${method}`).not.toBeNull();
			const params = code.indexOf("(", header?.index ?? 0);
			const signature = code.slice(params, matchingClose(code, params) + 1);
			expect(signature).toContain("BranchRegistry");
			// It may not construct one: a callee that opens its own handle is not
			// "handed" anything and the reason on its entry would be false.
			const body = (() => {
				const open = code.indexOf("{", matchingClose(code, params));
				return code.slice(open, matchingClose(code, open));
			})();
			expect(body).not.toMatch(/\bopenRegistry\s*\(/);
		}
	});

	test("rule 3: only the registry module and the seam name the registry's path", () => {
		const naming = srcFiles()
			.filter((f) => /\bgetBranchRegistryPathFor\s*\(/.test(codeOnly(f.source)))
			.map((f) => f.file)
			.sort();
		expect(naming).toEqual([REGISTRY_FILE, "src/core/store-location.ts"]);
	});
});

describe("guarding the guards: each detector fires on the shape it exists to catch", () => {
	const at = (file: string, source: string) =>
		reg1Violations([{ file, source }]);

	test("a mutator in an ordinary function is named", () => {
		expect(
			at(
				"src/core/elsewhere.ts",
				"function f() {\n\tregistry.resolveId(head);\n}\n",
			),
		).toEqual(["src/core/elsewhere.ts:2 registry.resolveId(head);"]);
		expect(
			at("src/core/elsewhere.ts", "const r = openRegistry(loc, lock, rows);\n"),
		).toHaveLength(1);
		expect(
			at(
				"src/core/elsewhere.ts",
				"async function g() { branchRegistry?.flush(); }\n",
			),
		).toHaveLength(1);
		// A renamed receiver cannot hide resolveId.
		expect(at("src/core/elsewhere.ts", "x.resolveId(h);\n")).toHaveLength(1);
	});

	test("the same calls inside the allowlisted lock-held method are not", () => {
		const source =
			"class Indexer {\n" +
			"\tprivate async indexInternal(force: boolean): Promise<void> {\n" +
			"\t\tconst registry = openRegistry(loc, lock, rows);\n" +
			"\t\tregistry.resolveId(head);\n\t\tregistry?.flush();\n\t}\n" +
			"\tother() { registry.resolveId(head); }\n}\n";
		expect(at("src/core/indexer.ts", source)).toEqual([
			"src/core/indexer.ts:7 other() { registry.resolveId(head); }",
		]);
	});

	// The shape the real indexer has and the fixture above lacked: the method is
	// CALLED (from index()) before it is DECLARED. Built from the first match,
	// the span was the call's argument list, and every legitimate call "failed".
	test("a lock-held method called before its declaration is found by its declaration", () => {
		const source =
			"class Indexer {\n" +
			"\tasync index(): Promise<void> {\n\t\treturn await this.indexInternal(true);\n\t}\n" +
			"\tprivate async indexInternal(force: boolean): Promise<void> {\n" +
			"\t\tconst registry = openRegistry(loc, lock, rows);\n" +
			"\t\tregistry.resolveId(head);\n\t}\n}\n";
		expect(at("src/core/indexer.ts", source)).toEqual([]);
	});

	test("inside a withStoreLock callback they are allowed", () => {
		expect(
			at(
				"src/cli.ts",
				"await withStoreLock(loc, opts, async (lock) => {\n\tregistry.resolveId(h);\n});\n",
			),
		).toEqual([]);
	});

	test("comments and strings are not code", () => {
		expect(
			at(
				"src/core/elsewhere.ts",
				'// registry.resolveId(head)\nconst s = "registry.resolveId(head)";\n/* openRegistry( */\n',
			),
		).toEqual([]);
	});

	test("rule 2 sees both clock reads, and not an argument-bearing Date", () => {
		expect(
			clockReads("const a = Date.now();\nconst b = new Date();\n"),
		).toEqual(["Date.now(", "newDate()"]);
		expect(
			clockReads("const c = new Date(now()).toISOString(); // Date.now()\n"),
		).toEqual([]);
	});
});
