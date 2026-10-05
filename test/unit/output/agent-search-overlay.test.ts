/**
 * R3.9 — the dirty overlay, said out loud under `--agent` (step 3, phase 6).
 *
 * R-2: the overlay header keys are emitted on EVERY search, one `key=value`
 * per line (the existing header grammar; revision 1 rejected a compound line,
 * LOW 8), so a consumer relies on the key and never on its absence — including
 * the cloud path, which never runs the overlay and says `overlay=unreported`.
 * Each overlay row carries ` source=dirty`, BEFORE ` summary=`: the VS Code
 * parser (`vscode-extension/src/parsers/search.ts`) reads the summary as the
 * free-text tail. Only `source === "dirty"` prints it — the cloud path's
 * `"cloud"`/`"overlay"` values are another mechanism (phase 5, decision 1).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { OVERLAY_ROW_GAP_TOKENS } from "../../../src/core/overlay/dirty-overlay.js";
import { agentOutput } from "../../../src/output/agent.js";
import type { SearchResult } from "../../../src/types.js";
import { parseSearchOutput } from "../../../vscode-extension/src/parsers/search.js";
import { stubOverlayReport } from "../../helpers/overlay-report-stub.js";

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
	extra: Partial<SearchResult> = {},
	summary?: string,
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
		score: 0.9,
		vectorScore: 0.9,
		keywordScore: 0,
		...(summary ? { summary: `Summary: ${summary}` } : {}),
		...extra,
	};
}

const KEYS = [
	"overlay",
	"overlay_reason",
	"overlay_files",
	"overlay_files_index_current",
	"overlay_files_deleted",
	"overlay_files_pending",
	"overlay_files_failed",
	"overlay_files_unclassified",
	"overlay_rebuilt",
	"overlay_embedded",
	"overlay_cache_hits",
	"overlay_suppressed_rows",
	"overlay_rebuild_ms",
	"overlay_gaps",
	"overlay_gap_details",
];

function headerValue(out: string, key: string): string | undefined {
	const line = out.split("\n").find((l) => l.startsWith(`${key}=`));
	return line?.slice(key.length + 1);
}

describe("R-2: overlay header keys, always", () => {
	test("every key, one per line, with the report's numbers", () => {
		const out = capture(() =>
			agentOutput.searchResults("q", [row("a")], {
				overlay: stubOverlayReport({
					state: "on",
					reason: "dirty",
					files: 2,
					filesIndexCurrent: 3,
					filesDeleted: 1,
					filesPending: 4,
					filesFailed: 1,
					filesUnclassified: 5,
					rebuilt: 2,
					embedded: 7,
					cacheHits: 9,
					rebuildMs: 12.6,
					suppressedRows: 11,
					// The CORE report carries R3.8's tokens (Phase 6); the
					// renderer prints the gaps it is given, joined, nothing added.
					// O4: a failed file is a TOKEN; its path and cause a DETAIL.
					gaps: ["file-failed-too-large", ...OVERLAY_ROW_GAP_TOKENS],
					gapDetails: [
						{
							token: "file-failed-too-large",
							path: "src/big.ts",
							message: "2000000 bytes > 1048576",
						},
					],
				}),
			}),
		);
		expect(KEYS.map((k) => [k, headerValue(out, k)])).toEqual([
			["overlay", "on"],
			["overlay_reason", "dirty"],
			["overlay_files", "2"],
			["overlay_files_index_current", "3"],
			["overlay_files_deleted", "1"],
			["overlay_files_pending", "4"],
			["overlay_files_failed", "1"],
			["overlay_files_unclassified", "5"],
			["overlay_rebuilt", "2"],
			["overlay_embedded", "7"],
			["overlay_cache_hits", "9"],
			["overlay_suppressed_rows", "11"],
			["overlay_rebuild_ms", "13"],
			[
				"overlay_gaps",
				"file-failed-too-large; no-symbol-graph; no-code-units; no-summaries; bm25-unchanged-chunks-only",
			],
			[
				"overlay_gap_details",
				"file-failed-too-large src/big.ts: 2000000 bytes > 1048576",
			],
		]);
	});

	test("present on an EMPTY result and with no meta at all (cloud): unreported, zeros", () => {
		const out = capture(() => agentOutput.searchResults("q", []));
		for (const key of KEYS) expect(headerValue(out, key)).toBeDefined();
		expect(headerValue(out, "overlay")).toBe("unreported");
		expect(headerValue(out, "overlay_reason")).toBe("not-run");
		expect(headerValue(out, "overlay_files")).toBe("0");
		expect(headerValue(out, "overlay_gaps")).toBe("");
		expect(headerValue(out, "overlay_gap_details")).toBe("");
	});

	test("off with its reason; R3.8's gaps only when rows were served", () => {
		const out = capture(() =>
			agentOutput.searchResults("q", [row("a")], {
				overlay: stubOverlayReport({ state: "off", reason: "config" }),
			}),
		);
		expect(headerValue(out, "overlay")).toBe("off");
		expect(headerValue(out, "overlay_reason")).toBe("config");
		expect(headerValue(out, "overlay_gaps")).toBe("");
	});

	test("a skip's cause rides in overlay_gaps as a token; its message in overlay_gap_details, newlines flattened", () => {
		const out = capture(() =>
			agentOutput.searchResults("q", [row("a")], {
				overlay: stubOverlayReport({
					state: "skipped",
					reason: "busy",
					gaps: ["busy"],
					gapDetails: [{ token: "busy", message: "held by\npid 42" }],
				}),
			}),
		);
		expect(headerValue(out, "overlay")).toBe("skipped");
		expect(headerValue(out, "overlay_gaps")).toBe("busy");
		expect(headerValue(out, "overlay_gap_details")).toBe(
			"busy: held by pid 42",
		);
	});

	test("O4-3: overlay_gaps is tokens only; overlay_gap_details is always present and the next line", () => {
		const out = capture(() =>
			agentOutput.searchResults("q", [row("a")], {
				overlay: stubOverlayReport({
					state: "on",
					reason: "dirty",
					files: 1,
					filesFailed: 2,
					gaps: [
						"file-failed-embed",
						"embed-deadline",
						...OVERLAY_ROW_GAP_TOKENS,
					],
					gapDetails: [
						{
							token: "file-failed-embed",
							path: "src/a.ts",
							message:
								'{"error":"model \\"x\\" not found; try pulling it first"}',
						},
						{
							token: "file-failed-embed",
							path: "src/b.ts",
							message: "refused",
						},
						{
							token: "embed-deadline",
							message: "rebuild budget 1500 ms reached, the rest is pending",
						},
					],
				}),
			}),
		);
		const lines = out.split("\n");
		const gapsLine = lines.findIndex((l) => l.startsWith("overlay_gaps="));
		expect(lines[gapsLine]).toMatch(
			/^overlay_gaps=([a-z0-9-]+(; [a-z0-9-]+)*)?$/,
		);
		expect(lines[gapsLine + 1]?.startsWith("overlay_gap_details=")).toBe(true);
		const details = headerValue(out, "overlay_gap_details") ?? "";
		expect(details).toContain('file-failed-embed src/a.ts: {"error"');
		expect(details).toContain("file-failed-embed src/b.ts: refused");
		expect(details).toContain("embed-deadline: rebuild budget 1500 ms reached");
		// The provider JSON is in the details line ONLY.
		expect(headerValue(out, "overlay_gaps")).not.toContain("error");
		// Both precede the result lines, and the VS Code parser still parses.
		expect(lines.findIndex((l) => l.startsWith("result "))).toBeGreaterThan(
			gapsLine + 1,
		);
		expect(parseSearchOutput(out)).toHaveLength(1);
	});
});

describe("per-row source=dirty", () => {
	test("printed for source==='dirty' only, BEFORE penalty= and summary=", () => {
		const out = capture(() =>
			agentOutput.searchResults(
				"q",
				[
					row("dirtyOne", { source: "dirty" }, "an uncommitted helper"),
					row("indexOne", { penalty: "dead" }, "an indexed helper"),
					row("cloudOne", { source: "cloud" }),
					row("cloudOverlay", { source: "overlay" }),
				],
				{
					overlay: stubOverlayReport({
						state: "on",
						reason: "dirty",
						files: 1,
					}),
				},
			),
		);
		const rows = out.split("\n").filter((l) => l.startsWith("result "));
		expect(rows).toHaveLength(4);
		expect(rows[0]).toMatch(
			/ name=dirtyOne source=dirty summary=an uncommitted helper$/,
		);
		expect(rows[1]).not.toContain("source=");
		expect(rows[1]).toMatch(/ penalty=dead summary=an indexed helper$/);
		expect(rows[2]).not.toContain("source=");
		expect(rows[3]).not.toContain("source=");
	});

	test("the VS Code parser still parses name and summary of a dirty row", () => {
		const out = capture(() =>
			agentOutput.searchResults(
				"q",
				[row("dirtyOne", { source: "dirty" }, "an uncommitted helper")],
				{
					overlay: stubOverlayReport({
						state: "on",
						reason: "dirty",
						files: 1,
					}),
				},
			),
		);
		const parsed = parseSearchOutput(out);
		expect(parsed).toHaveLength(1);
		expect(parsed[0].name).toBe("dirtyOne");
		expect(parsed[0].file).toBe("/abs/src/dirtyOne.ts");
		expect(parsed[0].summary).toBe("an uncommitted helper");
		// The overlay header lines are not mistaken for results.
		expect(out).toContain("\noverlay=on\n");
	});
});

/**
 * Outer review 2, LOW 4 — `overlay_gap_details` splits back into exactly one
 * entry per gap EVENT, whatever the path or message holds.
 *
 * The grammar, spelled out here rather than imported so a change in `src/`
 * cannot move the contract with it: entries are joined with `; `; an entry is
 * `token[ path]: message`; inside `path` the characters `%`, `;` and `:` are
 * percent-encoded, inside `message` `%` and `;` are; CR/LF runs become one
 * space. So a raw `; ` is always a separator, the first `:` after the token
 * always ends the path, and percent-decoding gives the text back.
 *
 * Shipped: only CR/LF were touched, so provider JSON, git stderr or a file
 * name containing `; ` gave more entries than events.
 */
function parseDetails(
	value: string,
): Array<{ token: string; path?: string; message: string }> {
	if (value === "") return [];
	return value.split("; ").map((entry) => {
		const head = /^([a-z0-9-]+)(?: ([^:]*))?: /.exec(entry);
		if (head === null) throw new Error(`unparseable entry: ${entry}`);
		const message = decodeURIComponent(entry.slice(head[0].length));
		return head[2] === undefined
			? { token: head[1] as string, message }
			: {
					token: head[1] as string,
					path: decodeURIComponent(head[2]),
					message,
				};
	});
}

describe("outer review 2, LOW 4: overlay_gap_details is unambiguously splittable", () => {
	test("separators, colons and percent signs inside paths and messages round-trip, one entry per event", () => {
		const events = [
			{
				token: "file-failed-embed" as const,
				path: "src/odd; name: v2 100%.ts",
				message: '{"error":"model \\"x\\" not found; try: ollama pull x"}',
			},
			{
				token: "busy" as const,
				message: "held by pid 42; retry: later (50% done, literal %3B)",
			},
			{
				token: "file-failed-read" as const,
				path: "C:/repo/a.ts",
				message: "EACCES: permission denied",
			},
		];
		const out = capture(() =>
			agentOutput.searchResults("q", [row("a")], {
				overlay: stubOverlayReport({
					state: "on",
					reason: "dirty",
					gaps: ["file-failed-embed", "busy", "file-failed-read"],
					gapDetails: events,
				}),
			}),
		);
		const value = headerValue(out, "overlay_gap_details") ?? "";
		expect(value.split("; ")).toHaveLength(events.length);
		expect(parseDetails(value)).toEqual(events);
		// Still readable: a message's own `:` is not encoded.
		expect(value).toContain("busy: held by pid 42%3B retry: later");
	});
});
