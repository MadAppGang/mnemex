/**
 * S-R2 — every local fusion path collapses span twins before its `limit` cut
 * (R2.4). Model and limits: `test/helpers/span-collapse-sweep.ts`.
 *
 * Three kinds of evidence, in the order CLAUDE.md #32 requires them — SIGHT
 * before silence:
 *   1. the sweep SEES the whole real file: lines covered by the parse tree
 *      equal the file's real length, there are no ERROR nodes, and the
 *      fusion callers it found are exactly the three ranked paths;
 *   2. planted violations fire, including one placed AFTER the regex literal
 *      `/'/g` that blinded two earlier sweeps of this very file, and one
 *      appended to the END of the real `store.ts`;
 *   3. only then: the real file has no findings.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Parser } from "web-tree-sitter";
import {
	type SpanRule,
	sweepSpanCollapse,
} from "../../helpers/span-collapse-sweep.js";
import { typescriptParser } from "../../helpers/tracker-region-sweep.js";

const REPO = join(import.meta.dir, "..", "..", "..");
const STORE_SOURCE = join(REPO, "src", "core", "store.ts");

/**
 * The three local ranked-code paths R2.4 names, by the function that FUSES.
 * Step 3 phase 5 split `search` into `buildSearchFilters` →
 * `retrieveCandidates` → `applyOverlay` → `fuseAndHydrate`; the fusion, the
 * collapse and the cut moved together into `fuseAndHydrate`, which is the
 * caller this sweep must see now. Sorted, as the census reports them.
 */
const RANKED_PATHS = ["fuseAndHydrate", "searchCodeUnits", "searchDocuments"];

let parser: Parser;
let realSource: string;

beforeAll(async () => {
	parser = await typescriptParser();
	realSource = readFileSync(STORE_SOURCE, "utf8");
});

function rules(source: string): SpanRule[] {
	return sweepSpanCollapse(source, parser).findings.map((f) => f.rule);
}

/** A class method in store.ts's shape, with the cut supplied by the caller. */
const method = (name: string, body: string) => `
class VectorStore {
	async ${name}(limit: number) {
		const fused = typeAwareRRFFusion(vectorResults, bm25Results, 0.6, 0.4, weights);
${body}
	}
}
`;

describe("S-R2 — sight first (CLAUDE.md #32)", () => {
	test("the parse tree covers every line of store.ts, with no ERROR nodes", () => {
		const { census } = sweepSpanCollapse(realSource, parser);
		console.log(
			`S-R2 census: linesScanned=${census.linesScanned} fileLines=${census.fileLines} parseErrors=${census.parseErrors} functionsScanned=${census.functionsScanned} fusionCallers=${census.fusionCallers.join(",")}`,
		);
		expect(census.fileLines).toBeGreaterThan(3000);
		expect(census.linesScanned).toBe(census.fileLines);
		expect(census.parseErrors).toBe(0);
		expect(census.functionsScanned).toBeGreaterThan(100);
	});

	test("it finds exactly the three ranked paths as fusion callers", () => {
		expect(sweepSpanCollapse(realSource, parser).census.fusionCallers).toEqual(
			RANKED_PATHS,
		);
	});
});

describe("S-R2 — planted violations fire", () => {
	test("a fusion caller cutting the fused list by `limit` with no collapse", () => {
		expect(
			rules(method("searchPlanted", "\t\treturn fused.slice(0, limit);")),
		).toEqual(["R2-no-collapse", "R2-limit-slice"]);
	});

	test("a caller that collapses but ALSO cuts by `limit`", () => {
		expect(
			rules(
				method(
					"searchPlanted",
					"\t\tconst top = fused.slice(0, limit);\n\t\treturn collapseSpanTwins(top, limit, keyOf).kept;",
				),
			),
		).toEqual(["R2-limit-slice"]);
	});

	test("a collapse that runs BEFORE fusion is not a collapse of the fused list", () => {
		const source = `
class VectorStore {
	async searchPlanted(limit: number) {
		const early = collapseSpanTwins(vectorResults, limit, keyOf).kept;
		const fused = reciprocalRankFusion(early, bm25Results, 0.6, 0.4);
		return fused;
	}
}
`;
		expect(rules(source)).toEqual([
			"R2-no-collapse",
			"R2-collapse-before-fusion",
		]);
	});

	test("the cut inside a `.map` callback still belongs to its method", () => {
		const source = method(
			"searchPlanted",
			"\t\treturn [fused].map((f) => f.slice(0, limit));",
		);
		const { findings } = sweepSpanCollapse(source, parser);
		expect(findings.map((f) => [f.rule, f.caller])).toEqual([
			["R2-no-collapse", "searchPlanted"],
			["R2-limit-slice", "searchPlanted"],
		]);
	});

	test("NOT blinded by the regex literal that blinded two earlier sweeps", () => {
		// `store.ts`'s own escaper, then a template literal with `${}`, then the
		// violation. A quote-pairing stripper swallows everything after `/'/g`.
		const source = `
export function escapeSqlLiteral(value: string): string {
	return value.replace(/'/g, "''");
}
const t = \`it's \${"a"} template\`;
${method("searchPlanted", "\t\treturn fused.slice(0, limit);")}
`;
		const { findings, census } = sweepSpanCollapse(source, parser);
		expect(findings.map((f) => f.rule)).toEqual([
			"R2-no-collapse",
			"R2-limit-slice",
		]);
		expect(census.parseErrors).toBe(0);
		expect(census.linesScanned).toBe(census.fileLines);
	});

	test("a violation appended to the END of the real store.ts fires, by name", () => {
		const planted = `${realSource}\n${method("searchAppended", "\t\treturn fused.slice(0, limit);")}`;
		const { findings, census } = sweepSpanCollapse(planted, parser);
		expect(
			findings.filter((f) => f.caller === "searchAppended").map((f) => f.rule),
		).toEqual(["R2-no-collapse", "R2-limit-slice"]);
		expect(census.fusionCallers).toContain("searchAppended");
	});

	test("MUTATION: removing the collapse from the real file fires once per ranked path", () => {
		const mutated = realSource.replaceAll(
			"collapseSpanTwins(",
			"notTheCollapse(",
		);
		// Compared as a boolean: a failure must not print 3 000 lines.
		expect(mutated === realSource).toBe(false);
		const fired = sweepSpanCollapse(mutated, parser)
			.findings.filter((f) => f.rule === "R2-no-collapse")
			.map((f) => f.caller)
			.sort();
		expect(fired).toEqual(RANKED_PATHS);
	});

	test("clean shapes pass", () => {
		expect(
			rules(
				method(
					"searchClean",
					"\t\tconst { kept } = collapseSpanTwins(fused, limit, keyOf);\n\t\treturn kept.map((r) => r.id).slice(0, 3);",
				),
			),
		).toEqual([]);
	});
});

describe("S-R2 — the real file", () => {
	test("every ranked path collapses before its cut, and nothing else cuts by limit", () => {
		const { findings } = sweepSpanCollapse(realSource, parser);
		expect(findings).toEqual([]);
	});
});
