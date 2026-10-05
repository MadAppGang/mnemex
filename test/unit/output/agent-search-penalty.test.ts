/**
 * R1 — the dead-code penalty, said out loud under `--agent`.
 *
 * The defect this replaces (I-23) stayed invisible for a whole build because
 * nothing reported what the penalty did: its comparison matched 0 of 217 times
 * and no output said "0". So `search --agent` now carries three header keys —
 * `penalty_lookups`, `penalty_same_file`, `penalty_applied` — emitted on EVERY
 * search (a consumer relies on the key, never on its absence), and each demoted
 * row carries ` penalty=dead`.
 *
 * ORDER MATTERS on the row: ` penalty=dead` goes BEFORE ` summary=`. The VS Code
 * extension's parser (`vscode-extension/src/parsers/search.ts`) treats
 * everything after `summary=` up to the next key as the summary; a key written
 * after it would sit inside a free-text field. The parser is run below on the
 * real output.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { agentOutput } from "../../../src/output/agent.js";
import type { SearchResult } from "../../../src/types.js";
import { parseSearchOutput } from "../../../vscode-extension/src/parsers/search.js";

const realLog = console.log;
afterEach(() => {
	console.log = realLog;
});

function capture(fn: () => void): string {
	let out = "";
	console.log = (...args: unknown[]) => {
		out += `${args.join(" ")}\n`;
	};
	try {
		fn();
	} finally {
		console.log = realLog;
	}
	return out;
}

function row(
	name: string,
	score: number,
	extra: Partial<SearchResult> = {},
): SearchResult {
	return {
		chunk: {
			id: name,
			content: "",
			filePath: `/abs/src/${name}.ts`,
			startLine: 1,
			endLine: 5,
			language: "typescript",
			chunkType: "function",
			name,
			fileHash: "h",
		},
		score,
		vectorScore: 0,
		keywordScore: score,
		...extra,
	};
}

describe("search --agent: penalty header keys", () => {
	test("emitted with the counts the search reported", () => {
		const out = capture(() =>
			agentOutput.searchResults("q", [row("a", 0.9)], {
				penalty: { lookups: 7, sameFile: 5, applied: 2, labelled: 0 },
			}),
		);
		expect(out).toContain("\npenalty_lookups=7\n");
		expect(out).toContain("\npenalty_same_file=5\n");
		expect(out).toContain("\npenalty_applied=2\n");
	});

	test("emitted as zeros when no penalty ran, and on an empty result", () => {
		const out = capture(() => agentOutput.searchResults("q", []));
		expect(out).toContain("\npenalty_lookups=0\n");
		expect(out).toContain("\npenalty_same_file=0\n");
		expect(out).toContain("\npenalty_applied=0\n");
	});
});

describe("search --agent: the per-row marker", () => {
	test("` penalty=dead` on demoted rows only, BEFORE ` summary=`", () => {
		const out = capture(() =>
			agentOutput.searchResults(
				"q",
				[
					row("dead", 0.5, {
						penalty: "dead",
						branches: ["main"],
						summary: "Summary: an unused helper",
					}),
					row("live", 0.4, { summary: "Summary: the real one" }),
				],
				{ penalty: { lookups: 2, sameFile: 2, applied: 1, labelled: 0 } },
			),
		);
		const lines = out.split("\n").filter((l) => l.startsWith("result "));
		expect(lines).toHaveLength(2);
		expect(lines[0]).toEndWith(
			" name=dead branches=main penalty=dead summary=an unused helper",
		);
		expect(lines[1]).not.toContain("penalty=");

		// The VS Code parser still reads every field, summary included.
		const parsed = parseSearchOutput(out);
		expect(parsed.map((p) => [p.name, p.summary])).toEqual([
			["dead", "an unused helper"],
			["live", "the real one"],
		]);
	});
});
