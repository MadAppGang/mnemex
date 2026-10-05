/**
 * M-5 — no `OverlayMerger` on the local search path (R3.2). Model and limits:
 * `test/helpers/overlay-merger-sweep.ts`.
 *
 * Sight before silence (CLAUDE.md #32): the census must cover every line of
 * every file under the three roots, the parser must have found the import
 * specifiers those files really have, and planted violations — each import
 * form, the re-export chain, a namespace member, one inside a parse-error
 * span, one appended to a real file — must fire. Only then does an empty
 * findings list over the real tree count.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Parser } from "web-tree-sitter";
import { getParserManager } from "../../../src/parsers/parser-manager.js";
import {
	LOCAL_SEARCH_ROOTS,
	type MergerRule,
	resolvesToMerger,
	type SweepFile,
	sweepOverlayMerger,
} from "../../helpers/overlay-merger-sweep.js";

const REPO = join(import.meta.dir, "..", "..", "..");

function localSearchFiles(): SweepFile[] {
	const out: SweepFile[] = [];
	const walk = (dir: string) => {
		for (const e of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, e.name);
			if (e.isDirectory()) walk(full);
			else if (/\.tsx?$/.test(e.name) && !e.name.endsWith(".d.ts")) {
				out.push({
					path: relative(REPO, full),
					source: readFileSync(full, "utf8"),
				});
			}
		}
	};
	for (const root of LOCAL_SEARCH_ROOTS) walk(join(REPO, root));
	return out;
}

let tsParser: Parser;
let tsxParser: Parser;
const parserFor = (path: string) =>
	path.endsWith(".tsx") ? tsxParser : tsParser;

beforeAll(async () => {
	const manager = getParserManager();
	await manager.initialize();
	const ts = await manager.getParser("typescript");
	const tsx = await manager.getParser("tsx");
	if (!ts || !tsx)
		throw new Error("grammars missing: bun run download-grammars");
	tsParser = ts;
	tsxParser = tsx;
});

function rulesOf(path: string, source: string): MergerRule[] {
	return sweepOverlayMerger([{ path, source }], parserFor).findings.map(
		(f) => f.rule,
	);
}

describe("M-5 — sight first (CLAUDE.md #32)", () => {
	test("every file under the three roots is parsed and every line covered", () => {
		const files = localSearchFiles();
		const { census } = sweepOverlayMerger(files, parserFor);
		console.log(
			`M-5 census: files=${census.files} linesScanned=${census.linesScanned} fileLines=${census.fileLines} parseErrors=${census.parseErrors} errorLines=${census.errorLines} specifiers=${census.specifiers}`,
		);
		expect(census.files).toBe(files.length);
		expect(census.files).toBeGreaterThan(100);
		expect(census.linesScanned).toBe(census.fileLines);
		expect(census.errorLines).toBeLessThan(200);
		// Non-vacuous: the import specifiers the tree really has were seen.
		const rawImports = files.reduce(
			(n, f) => n + (f.source.match(/^import [^;]*? from "/gm)?.length ?? 0),
			0,
		);
		expect(census.specifiers).toBeGreaterThanOrEqual(rawImports);
	});

	test("the real search tool's cloud import IS seen (and is allowed: it names no merger)", () => {
		const search = localSearchFiles().find(
			(f) => f.path === "src/mcp/tools/search.ts",
		);
		expect(search?.source).toContain('from "../../cloud/index.js"');
		expect(rulesOf("src/mcp/tools/search.ts", search?.source ?? "")).toEqual(
			[],
		);
	});
});

describe("M-5 — planted violations fire", () => {
	test("each import form that resolves to cloud/merger", () => {
		expect(
			rulesOf("src/core/x.ts", 'import { mergeX } from "../cloud/merger.js";'),
		).toEqual(["M5-import"]);
		expect(
			rulesOf("src/mcp/tools/x.ts", 'export { y } from "../../cloud/merger";'),
		).toEqual(["M5-import"]);
		expect(
			rulesOf(
				"src/retrieval/a/x.ts",
				'const m = await import("../../cloud/merger.ts");',
			),
		).toEqual(["M5-import"]);
		expect(
			rulesOf(
				"src/core/overlay/x.ts",
				'const m = require("../../cloud/merger.js");',
			),
		).toEqual(["M5-import"]);
		expect(
			rulesOf(
				"src/core/x.ts",
				'import type { MergedSearchResult } from "../cloud/merger.js";',
			),
		).toEqual(["M5-import"]);
	});

	test("the re-export chain: importing the class from cloud/index.js names it", () => {
		expect(
			rulesOf(
				"src/mcp/tools/x.ts",
				'import { OverlayMerger } from "../../cloud/index.js";\nnew OverlayMerger();',
			),
		).toEqual(["M5-name", "M5-name"]);
	});

	test("a namespace member and a type position both fire", () => {
		expect(
			rulesOf(
				"src/core/x.ts",
				'import * as cloud from "../cloud/index.js";\nconst m = new cloud.OverlayMerger();\nlet t: OverlayMerger;',
			),
		).toEqual(["M5-name", "M5-name"]);
	});

	test("comments and strings do not fire; another merger module does not resolve", () => {
		expect(
			rulesOf(
				"src/core/x.ts",
				'// OverlayMerger is never used here\nconst s = "OverlayMerger";\nimport { mergeResults } from "../rg/merger.js";',
			),
		).toEqual([]);
		expect(resolvesToMerger("src/core/x.ts", "../rg/merger.js")).toBe(false);
		expect(resolvesToMerger("src/core/x.ts", "../cloud/merger.js")).toBe(true);
		expect(
			resolvesToMerger("src/core/overlay/x.ts", "../cloud/merger.js"),
		).toBe(false);
	});

	test("planted INSIDE a parse-error span still fires (the raw fallback)", () => {
		const source =
			'const = = ;\nimport { a } from "../cloud/merger.js"; const = ;\n';
		const { findings, census } = sweepOverlayMerger(
			[{ path: "src/core/x.ts", source }],
			parserFor,
		);
		expect(census.parseErrors).toBeGreaterThan(0);
		expect(findings.map((f) => f.rule)).toContain("M5-import");
	});

	test("appended to the END of a real file, it fires by file and line", () => {
		const real = readFileSync(join(REPO, "src/core/store.ts"), "utf8");
		const planted = `${real}\nimport { OverlayMerger } from "../cloud/merger.js";\n`;
		const { findings } = sweepOverlayMerger(
			[{ path: "src/core/store.ts", source: planted }],
			parserFor,
		);
		const lastLine = planted.split("\n").length - 1;
		expect(findings.map((f) => [f.rule, f.line])).toEqual([
			["M5-import", lastLine],
			["M5-name", lastLine],
		]);
	});
});

describe("M-5 — the real tree", () => {
	test("nothing under src/core, src/mcp/tools or src/retrieval reaches OverlayMerger", () => {
		expect(sweepOverlayMerger(localSearchFiles(), parserFor).findings).toEqual(
			[],
		);
	});
});
