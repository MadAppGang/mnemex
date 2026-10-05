/**
 * Iteration 2, F1 — the ONE chunk-label grammar.
 *
 * The chunker names two kinds of chunk with a LABEL: `X (part n/m)` and
 * `X (fields)`. The dead-code penalty resolves a label back to `X`
 * (`symbolNameOfChunkLabel`) so the chunk is judged by its symbol. That is
 * safe only while the builders and the parser agree, and while nothing else
 * spells a label.
 *
 *   P-7   round trip: every builder output parses back to its base; near
 *         misses parse to null
 *   P-8   sweep: `chunker.ts` spells `(part ` / `(fields)` only inside the two
 *         builders (tree-sitter, census asserted, planted fixture must fire)
 *   CH-1  a fixture file's chunk names, ids and `contentHash` are byte-identical
 *         to a snapshot frozen BEFORE the builder refactor
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	chunkFile,
	fieldsLabel,
	partLabel,
	symbolNameOfChunkLabel,
} from "../../../src/core/chunker.js";
import { sweepChunkLabels } from "../../helpers/chunk-label-sweep.js";
import { typescriptParser } from "../../helpers/tracker-region-sweep.js";

const REPO = join(import.meta.dir, "..", "..", "..");
const TESTDATA = join(REPO, "test", "testdata", "chunk-labels");

describe("P-7 — the label grammar round-trips", () => {
	test("every builder output parses back to its base", () => {
		const bases = [
			"get",
			"SearchResult",
			"handleSearch",
			"Foo.bar",
			"weird (name)",
			"a (part 1/2)", // a base that itself LOOKS like a label: one suffix stripped
		];
		for (const base of bases) {
			expect(symbolNameOfChunkLabel(fieldsLabel(base))).toBe(base);
			for (const [p, t] of [
				[1, 1],
				[2, 3],
				[11, 15],
				[100, 100],
			] as const) {
				expect(symbolNameOfChunkLabel(partLabel(base, p, t))).toBe(base);
			}
		}
	});

	test("the builders spell exactly what the chunker always wrote", () => {
		expect(partLabel("handleSearch", 11, 15)).toBe("handleSearch (part 11/15)");
		expect(fieldsLabel("SearchResult")).toBe("SearchResult (fields)");
	});

	test("near misses and plain names parse to null", () => {
		for (const name of [
			"get",
			"X (part)",
			"X (part 0/2)",
			"X (part 1/0)",
			"X (part 01/2)",
			"X (fieldz)",
			"(fields)",
			" (fields)",
			"X(fields)",
			"X (fields) ",
			"X (part 1/2) tail",
			"",
		]) {
			expect({ name, base: symbolNameOfChunkLabel(name) }).toEqual({
				name,
				base: null,
			});
		}
	});
});

describe("P-8 — chunker.ts spells a label only inside its builder", () => {
	test("no third spelling; the sweep SAW the whole file", async () => {
		const parser = await typescriptParser();
		const source = readFileSync(join(REPO, "src/core/chunker.ts"), "utf8");
		const result = sweepChunkLabels(source, parser);

		// Census first (CLAUDE.md #32): silence is evidence only once sight is.
		expect(result.census.parseErrors).toBe(0);
		expect(result.census.linesCovered).toBe(result.census.fileLines);
		expect(result.census.fileLines).toBeGreaterThan(700);
		expect(result.census.stringNodesScanned).toBeGreaterThan(20);
		// Each builder holds its one spelling.
		expect(result.inBuilders).toBe(2);
		expect(result.findings).toEqual([]);
	});

	test("a planted third spelling fires; prose in comments does not", async () => {
		const parser = await typescriptParser();
		const planted = [
			"// a comment about `X (fields)` and `X (part 1/2)` is fine",
			"/** so is `Y (fields)` in a block comment */",
			"export function partLabel(n: string, p: number, t: number): string {",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: planted SOURCE text for the sweep
			"\treturn `${n} (part ${p}/${t})`;",
			"}",
			"export function fieldsLabel(c: string): string {",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: planted SOURCE text for the sweep
			"\treturn `${c} (fields)`;",
			"}",
			"function flushGap(containerName: string) {",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: planted SOURCE text for the sweep
			"\treturn { name: `${containerName} (fields)` };",
			"}",
			"const other = (n: string) => n + ' (part ' + 1 + '/2)';",
			"",
		].join("\n");
		const result = sweepChunkLabels(planted, parser);
		expect(result.census.parseErrors).toBe(0);
		expect(result.inBuilders).toBe(2);
		expect(result.findings.map((f) => [f.caller, f.line])).toEqual([
			["flushGap", 10],
			["other", 12],
		]);
	});
});

describe("CH-1 — chunk names, ids and contentHash are unchanged by the refactor", () => {
	test("byte-identical to the snapshot frozen before the builders existed", async () => {
		const source = readFileSync(join(TESTDATA, "labels.fixture.txt"), "utf8");
		const expected = JSON.parse(
			readFileSync(join(TESTDATA, "expected-chunks.json"), "utf8"),
		);
		const chunks = await chunkFile(
			source,
			"src/labels-fixture.ts",
			"typescript",
			"fixture-file-hash",
		);
		const actual = chunks.map((c) => ({
			name: c.name ?? null,
			id: c.id,
			contentHash: c.contentHash,
			startLine: c.startLine,
			endLine: c.endLine,
			chunkType: c.chunkType,
		}));
		expect(actual).toEqual(expected);
		// The fixture exercises BOTH labels, so the equality covers them.
		const names = actual.map((c) => c.name);
		expect(names).toContain("ConfigHolder (fields)");
		expect(names).toContain("handleEverything (part 2/3)");
	});
});
