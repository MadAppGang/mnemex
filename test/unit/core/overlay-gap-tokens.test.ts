/**
 * Iteration 2, O4 — `overlay_gaps` is machine tokens ONLY.
 *
 * Before: `report.gaps` mixed bare tokens with `path: failure (message)` lines
 * and free-text pass gaps — raw provider error JSON included — under a key
 * documented as machine tokens, and the CLI re-parsed the prose with a regex.
 * Now each gap is a token from the closed `OverlayGapToken` set and its free
 * text is an `OverlayGapDetail`.
 *
 *   O4-1  the vocabulary is closed and spelled `[a-z0-9-]+`; real passes over
 *         each kind of path (a skip with provider JSON, a too-large file, a
 *         refused file, a served pass) give `gaps ⊆ OVERLAY_GAP_TOKENS`; the
 *         provider JSON appears in `gapDetails` and nowhere in `gaps`
 *   O4-2  sweep: `dirty-overlay.ts` writes report gaps only through
 *         `GapRecorder` (tree-sitter, census asserted, planted writes fire)
 *   GR    `GapRecorder`: a token once, a detail per event
 */

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TotalEmbeddingFailureError } from "../../../src/core/embeddings-errors.js";
import {
	GapRecorder,
	OVERLAY_GAP_TOKENS,
	OVERLAY_ROW_GAP_TOKENS,
	prepareDirtyOverlay,
} from "../../../src/core/overlay/dirty-overlay.js";
import type { OverlayReport } from "../../../src/core/overlay/types.js";
import { overlayHeaderLines } from "../../../src/output/agent.js";
import {
	createOverlayFixture,
	indexAll,
	type OverlayFixture,
	tsSource,
} from "../../helpers/dirty-overlay-fixture.js";
import { sweepOverlayGaps } from "../../helpers/overlay-gap-sweep.js";
import { typescriptParser } from "../../helpers/tracker-region-sweep.js";

const REPO = join(import.meta.dir, "..", "..", "..");
const TOKEN = /^[a-z0-9-]+$/;
const GAPS_LINE = /^overlay_gaps=([a-z0-9-]+(; [a-z0-9-]+)*)?$/;

let fx: OverlayFixture | null = null;
afterEach(() => {
	fx?.cleanup();
	fx = null;
});

async function fixture(files: Record<string, string>): Promise<OverlayFixture> {
	fx = await createOverlayFixture(files);
	indexAll(fx, Object.keys(files));
	return fx;
}

/** Every O4 property of one report, as MCP and `--agent` would carry it. */
function expectTokensOnly(report: OverlayReport): void {
	for (const gap of report.gaps) {
		expect({ gap, token: TOKEN.test(gap) }).toEqual({ gap, token: true });
		expect(OVERLAY_GAP_TOKENS).toContain(gap);
	}
	expect(new Set(report.gaps).size).toBe(report.gaps.length); // each once
	for (const d of report.gapDetails) expect(report.gaps).toContain(d.token);
	const lines = overlayHeaderLines({ ...report, suppressedRows: 0 });
	const i = lines.findIndex((l) => l.startsWith("overlay_gaps="));
	expect(lines[i]).toMatch(GAPS_LINE);
	expect(lines[i + 1]?.startsWith("overlay_gap_details=")).toBe(true);
}

describe("O4-1 — the closed vocabulary", () => {
	test("29 tokens: 11 skip causes, 6 file failures, 8 pass events, 4 row gaps; all [a-z0-9-]+", () => {
		expect(OVERLAY_GAP_TOKENS).toHaveLength(29);
		expect(new Set(OVERLAY_GAP_TOKENS).size).toBe(29);
		for (const t of OVERLAY_GAP_TOKENS) expect(t).toMatch(TOKEN);
		expect(
			OVERLAY_GAP_TOKENS.filter((t) => t.startsWith("file-failed-")),
		).toEqual([
			"file-failed-read",
			"file-failed-too-large",
			"file-failed-chunk",
			"file-failed-embed",
			"file-failed-write",
			"file-failed-inconsistent",
		]);
		for (const t of OVERLAY_ROW_GAP_TOKENS) {
			expect(OVERLAY_GAP_TOKENS).toContain(t);
		}
	});
});

describe("O4-1 — real passes give tokens only; free text goes to gapDetails", () => {
	test("a provider error JSON body appears in gapDetails ONLY (skip: embed-failed)", async () => {
		const f = await fixture({ "src/a.ts": tsSource("a", 2) });
		f.write("src/a.ts", tsSource("a", 2, "edited"));
		const providerJson =
			'{"error":"model \\"nomic-embed-text\\" not found, try pulling it first"}';
		f.stub.embed = async (texts) => {
			throw new TotalEmbeddingFailureError(
				"Ollama",
				texts.length,
				`HTTP 404 ${providerJson}`,
			);
		};

		const result = await prepareDirtyOverlay(f.ctx());

		expect(result.report).toMatchObject({
			state: "skipped",
			reason: "embed-failed",
		});
		expect(result.report.gaps).toEqual(["embed-failed"]);
		expect(result.report.gaps.join(" ")).not.toContain("{");
		expect(result.report.gapDetails).toHaveLength(1);
		expect(result.report.gapDetails[0]?.token).toBe("embed-failed");
		expect(result.report.gapDetails[0]?.message).toContain(providerJson);
		expectTokensOnly(result.report);
		const lines = overlayHeaderLines({ ...result.report, suppressedRows: 0 });
		expect(lines.find((l) => l.startsWith("overlay_gaps="))).toBe(
			"overlay_gaps=embed-failed",
		);
		expect(lines.find((l) => l.startsWith("overlay_gap_details="))).toContain(
			providerJson,
		);
	});

	test("a too-large file and a refused file: file-failed-* tokens, one detail per file with its path", async () => {
		const f = await fixture({
			"src/a.ts": tsSource("a", 2),
			"src/b.ts": tsSource("b", 2),
		});
		f.write("src/a.ts", tsSource("a", 2, "edited"));
		f.write("src/b.ts", tsSource("b", 2, "edited"));
		f.write("src/c.ts", tsSource("c", 2, "edited"));
		f.write("src/big.ts", `${tsSource("big", 40)}\n`);
		// b.ts refused (per-file: a.ts and c.ts are accepted), big.ts too large.
		f.stub.emptyFor = (text) => text.includes("b function");

		const result = await prepareDirtyOverlay(
			f.ctx({ limits: { maxFileBytes: 4_000 } }),
		);

		expect(result.report.state).toBe("on");
		expect(result.report.gaps).toContain("file-failed-too-large");
		expect(result.report.gaps).toContain("file-failed-embed");
		expect(result.report.gapDetails).toContainEqual(
			expect.objectContaining({
				token: "file-failed-too-large",
				path: "src/big.ts",
			}),
		);
		expect(result.report.gapDetails).toContainEqual(
			expect.objectContaining({ token: "file-failed-embed", path: "src/b.ts" }),
		);
		// A served pass also states R3.8's row gaps, each once.
		for (const t of OVERLAY_ROW_GAP_TOKENS) {
			expect(result.report.gaps).toContain(t);
		}
		expectTokensOnly(result.report);
	});
});

describe("O4-2 — dirty-overlay.ts writes report gaps only through GapRecorder", () => {
	test("no raw push, no hand-built gaps literal; the sweep SAW the whole file", async () => {
		const parser = await typescriptParser();
		const source = readFileSync(
			join(REPO, "src/core/overlay/dirty-overlay.ts"),
			"utf8",
		);
		const result = sweepOverlayGaps(source, parser);
		expect(result.census.parseErrors).toBe(0);
		expect(result.census.linesCovered).toBe(result.census.fileLines);
		expect(result.census.fileLines).toBeGreaterThan(2000);
		expect(result.census.callsScanned).toBeGreaterThan(300); // 390 when written
		// Every sanctioned write site, counted: a site that stops calling
		// `noteGap` must turn this red rather than leave the sweep silent.
		expect(result.census.noteGapCalls).toBeGreaterThanOrEqual(10);
		expect(result.findings).toEqual([]);
	});

	test("planted raw writes fire; the recorder's own pushes and comments do not", async () => {
		const parser = await typescriptParser();
		const planted = [
			"// this.gaps.push(`a comment`) is fine",
			"class GapRecorder {",
			"\tprivate readonly tokens: string[] = [];",
			"\tnoteGap(t: string) { this.tokens.push(t); }",
			"\tfields() { return { gaps: [...this.tokens], gapDetails: [] }; }",
			"}",
			"class LockedSection {",
			"\tprivate readonly gaps: string[] = [];",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: planted SOURCE text for the sweep
			"\tfail(err: Error) { this.gaps.push(`add-failed: ${err.message}`); }",
			"}",
			"function skipped(reason: string, gap: string) {",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: planted SOURCE text for the sweep
			"\treturn { report: { gaps: [`${reason}: ${gap}`] } };",
			"}",
			"const passGaps: string[] = [];",
			"passGaps.push('unclassified: at least 3');",
			"",
		].join("\n");
		const result = sweepOverlayGaps(planted, parser);
		expect(result.census.parseErrors).toBe(0);
		expect(result.findings.map((f) => [f.rule, f.line])).toEqual([
			["raw-push", 9],
			["raw-literal", 12],
			["raw-push", 15],
		]);
	});
});

describe("GapRecorder — a token once, a detail per event", () => {
	test("first-occurrence order; details repeat a token; no detail without text or path", () => {
		const g = new GapRecorder();
		g.noteGap("file-failed-embed", "refused", "src/a.ts");
		g.noteGap("embed-deadline", "budget reached");
		g.noteGap("file-failed-embed", "refused", "src/b.ts");
		g.noteGap("no-summaries");
		const other = new GapRecorder();
		other.noteGap("embed-deadline", "second");
		other.noteGap("add-failed", "disk full");
		g.absorb(other);
		expect(g.fields()).toEqual({
			gaps: [
				"file-failed-embed",
				"embed-deadline",
				"no-summaries",
				"add-failed",
			],
			gapDetails: [
				{ token: "file-failed-embed", path: "src/a.ts", message: "refused" },
				{ token: "embed-deadline", message: "budget reached" },
				{ token: "file-failed-embed", path: "src/b.ts", message: "refused" },
				{ token: "embed-deadline", message: "second" },
				{ token: "add-failed", message: "disk full" },
			],
		});
		expect(g.has("no-summaries")).toBe(true);
		expect(g.has("busy")).toBe(false);
	});
});
