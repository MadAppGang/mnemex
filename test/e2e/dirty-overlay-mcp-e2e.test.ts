/**
 * The dirty overlay through the REAL MCP handlers (step 3, phase 6).
 *
 *   MCP-1  `search_code`: the trailer carries the `overlay` block, overlay rows
 *          are `source: "dirty"` in it and say "Source: uncommitted" in the
 *          prose, and the LEARNING record (the activity log's top result and
 *          count) names no overlay row (LOW 7).
 *          `search`: the response carries `overlay` from the semantic
 *          backend's per-request sink (HIGH 7); with the semantic backend
 *          disabled it is `state: "unreported"`.
 *   R-5    `dirtyOverlay: false` in the project config is honoured by BOTH
 *          MCP tools (`overlay.state === "off"`, reason `config`).
 *
 * The handlers run in a child (`overlay-mcp-child.ts`) with `sandboxEnv()`:
 * a sandbox HOME whose config points at this process's fake provider, a temp
 * embed cache and global lock, `keychainSafeChildEnv()` (CLAUDE.md #24, #31).
 * The index is built by the BUILT entry point (`bun run build` first).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
	type OverlayCliProject,
	overlayCliProject,
	tsFunctions,
} from "../helpers/overlay-cli-fixture.js";
import { type ChildRun, collect, sandboxEnv } from "../helpers/v4-fixtures.js";

const TIMEOUT_MS = 180_000;
const CHILD = join(import.meta.dir, "..", "helpers", "overlay-mcp-child.ts");

let current: OverlayCliProject | null = null;
afterEach(() => {
	current?.cleanup();
	current = null;
});

function runTool(
	p: OverlayCliProject,
	tool: "search_code" | "search",
	query: string,
	extra?: Record<string, string>,
): Promise<ChildRun> {
	return collect(
		Bun.spawn(
			[process.execPath, "--env-file=/dev/null", CHILD, tool, p.project, query],
			{
				cwd: p.project,
				env: sandboxEnv(p.scratch, extra),
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			},
		),
	);
}

/** The ONE trailing JSON object every `search_code` response ends with. */
function trailer(text: string): Record<string, unknown> {
	const last = text.trimEnd().split("\n").at(-1) ?? "";
	return JSON.parse(last);
}

const EDITED =
	tsFunctions("alpha", 2) +
	"export function walrusLanternRoutine(input: number[]): number {\n" +
	"\t// walrus lantern routine, uncommitted\n" +
	"\tlet total = 0;\n" +
	"\tfor (const value of input) {\n" +
	"\t\tif (value > 10) {\n\t\t\ttotal += value * 2;\n\t\t} else {\n\t\t\ttotal -= value;\n\t\t}\n" +
	"\t}\n" +
	'\tconst label = "walrus lantern routine";\n' +
	"\treturn total + label.length;\n" +
	"}\n";

async function dirtyProject(prefix: string): Promise<OverlayCliProject> {
	current = await overlayCliProject(prefix, {
		"src/alpha.ts": tsFunctions("alpha", 3),
		"src/beta.ts": tsFunctions("beta", 3),
	});
	current.write("src/alpha.ts", EDITED);
	return current;
}

describe("MCP-1: search_code", () => {
	test(
		"overlay block, source=dirty rows, and a learning record with no overlay id",
		async () => {
			const p = await dirtyProject("mcp1-code-");
			const run = await runTool(p, "search_code", "walrus lantern routine");
			expect(run.exitCode, run.stderr).toBe(0);
			const { text, activity } = run.result as {
				text: string;
				activity: {
					resultCount: number;
					topResult: { chunk: { id: string } } | null;
				} | null;
			};
			const t = trailer(text);
			const overlay = t.overlay as Record<string, unknown>;
			expect(overlay.state).toBe("on");
			expect(overlay.reason).toBe("dirty");
			expect(overlay.files).toBe(1);
			expect(Number(overlay.suppressedRows)).toBeGreaterThan(0);
			// R3.8's gaps as the SAME machine tokens `--agent` prints in
			// `overlay_gaps` (Phase 6, TEST-12/TEST-27): the core owns them.
			expect(overlay.gaps).toEqual(
				expect.arrayContaining([
					"no-symbol-graph",
					"no-code-units",
					"no-summaries",
					"bm25-unchanged-chunks-only",
				]),
			);
			// O4: tokens only; the free text rides beside them as objects.
			for (const gap of overlay.gaps as string[]) {
				expect(gap).toMatch(/^[a-z0-9-]+$/);
			}
			expect(Array.isArray(overlay.gapDetails)).toBe(true);
			const rows = t.results as Array<{ id: string; source?: string }>;
			const dirtyIds = rows
				.filter((r) => r.source === "dirty")
				.map((r) => r.id);
			expect(dirtyIds.length).toBeGreaterThan(0);
			expect(text).toContain("Source: uncommitted");
			expect(text).toContain("Including 1 uncommitted file(s)");
			// The LEARNING record names index rows only (LOW 7).
			expect(activity).not.toBeNull();
			expect(activity?.resultCount).toBe(rows.length - dirtyIds.length);
			if (activity?.topResult) {
				expect(dirtyIds).not.toContain(activity.topResult.chunk.id);
			}
			// Non-vacuous: the top result of the RESPONSE is an overlay row, so a
			// record of `results[0]` would have named it.
			expect(rows[0]?.source).toBe("dirty");
		},
		TIMEOUT_MS,
	);
});

describe("MCP-1: search (pipeline)", () => {
	test(
		"the response carries `overlay` from the semantic backend's sink",
		async () => {
			const p = await dirtyProject("mcp1-pipe-");
			const run = await runTool(p, "search", "walrus lantern routine");
			expect(run.exitCode, run.stderr).toBe(0);
			const payload = JSON.parse((run.result as { text: string }).text);
			// The tool auto-indexes first, so the edit is in the index by the time
			// the overlay classifies it: on, and nothing left to serve.
			expect(payload.overlay.state).toBe("on");
			expect(payload.overlay.reason).toBe("index-current");
			expect(payload.overlay.filesIndexCurrent).toBeGreaterThan(0);
		},
		TIMEOUT_MS,
	);

	test(
		"semantic backend disabled -> overlay state `unreported`",
		async () => {
			const p = await dirtyProject("mcp1-unrep-");
			const run = await runTool(p, "search", "walrus lantern routine", {
				MNEMEX_PIPELINE_SEMANTIC: "0",
			});
			expect(run.exitCode, run.stderr).toBe(0);
			const payload = JSON.parse((run.result as { text: string }).text);
			expect(payload.overlay).toEqual({
				state: "unreported",
				reason: "semantic-backend-not-run",
			});
		},
		TIMEOUT_MS,
	);
});

describe("R-5: the config key, through both MCP tools", () => {
	test(
		"project dirtyOverlay:false -> overlay off/config in search_code AND search",
		async () => {
			const p = await dirtyProject("mcp-r5-");
			p.projectConfig({ dirtyOverlay: false });
			const code = await runTool(p, "search_code", "walrus lantern routine");
			expect(code.exitCode, code.stderr).toBe(0);
			const t = trailer((code.result as { text: string }).text);
			expect(t.overlay).toMatchObject({ state: "off", reason: "config" });
			expect(
				(t.results as Array<{ source?: string }>).some(
					(r) => r.source === "dirty",
				),
			).toBe(false);

			const pipe = await runTool(p, "search", "walrus lantern routine");
			expect(pipe.exitCode, pipe.stderr).toBe(0);
			const payload = JSON.parse((pipe.result as { text: string }).text);
			expect(payload.overlay).toMatchObject({ state: "off", reason: "config" });
			expect(p.overlayDirs()).toEqual([]);
		},
		TIMEOUT_MS,
	);
});
