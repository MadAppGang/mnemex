/**
 * "Dirty" is relative to the INDEX, not to git (step 3, phase 6; CLAUDE.md
 * #33). The three CLI forms phase 4 handed on, through the BUILT entry point
 * (`bun run build` first) with `sandboxEnv()` children (CLAUDE.md #24, #31):
 *
 *   SET-1  git-dirty but index-current (the edit was indexed): the index's
 *          rows are served, nothing suppressed, no overlay rows (HIGH 8).
 *   HW-1   after the overlay's manifest exists, `mnemex index` runs while the
 *          file is dirty, then the file is restored to HEAD: git now calls it
 *          clean, yet the index holds the dirty text. The tracker high-water
 *          set (T) catches it: the HEAD body is served, the dirty-only
 *          function is gone (HIGH 9).
 *   W-1    the dirty text is indexed by an MCP `search` (which auto-indexes and
 *          then runs the overlay), the file is restored, then `--agent search`
 *          (which never auto-indexes): the watch set (W) catches it (HIGH 9).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
	agentHeader,
	agentRows,
	type OverlayCliProject,
	overlayCliProject,
	tsFunctions,
} from "../helpers/overlay-cli-fixture.js";
import { collect, sandboxEnv } from "../helpers/v4-fixtures.js";

const TIMEOUT_MS = 180_000;
const MCP_CHILD = join(
	import.meta.dir,
	"..",
	"helpers",
	"overlay-mcp-child.ts",
);

let current: OverlayCliProject | null = null;
afterEach(() => {
	current?.cleanup();
	current = null;
});

/** Long enough to be its own NAMED function chunk (see the CLI e2e file). */
const TEMPORARY =
	"export function temporaryWombatHelper(input: number[]): number {\n" +
	"\t// temporary wombat helper that only ever existed uncommitted\n" +
	"\tlet total = 0;\n" +
	"\tfor (const value of input) {\n" +
	"\t\tif (value > 10) {\n\t\t\ttotal += value * 2;\n\t\t} else {\n\t\t\ttotal -= value;\n\t\t}\n" +
	"\t}\n" +
	'\tconst label = "temporary wombat helper";\n' +
	"\treturn total + label.length;\n" +
	"}\n";

const HEAD_ALPHA = tsFunctions("alpha", 3);
const DIRTY_ALPHA = HEAD_ALPHA + TEMPORARY;

async function project(prefix: string): Promise<OverlayCliProject> {
	current = await overlayCliProject(prefix, {
		"src/alpha.ts": HEAD_ALPHA,
		"src/beta.ts": tsFunctions("beta", 3),
	});
	return current;
}

const search = (p: OverlayCliProject, q: string) =>
	p.cli(["search", q, "--agent", "-n", "10"]);

function named(stdout: string, name: string): string[] {
	return agentRows(stdout).filter((r) => r.includes(` name=${name}`));
}

describe("SET-1: git-dirty but index-current", () => {
	test(
		"index rows served, overlay_suppressed_rows=0, no overlay rows (A)",
		async () => {
			const p = await project("set1-");
			p.write("src/alpha.ts", DIRTY_ALPHA);
			const indexed = await p.cli(["index", "--agent", "--no-llm"]);
			expect(indexed.exitCode, indexed.stderr).toBe(0);
			const run = await search(p, "temporary wombat helper");
			expect(run.exitCode, run.stderr).toBe(0);
			const h = agentHeader(run.stdout);
			expect(h.get("overlay")).toBe("on");
			expect(h.get("overlay_reason")).toBe("index-current");
			expect(Number(h.get("overlay_files_index_current"))).toBeGreaterThan(0);
			expect(h.get("overlay_files")).toBe("0");
			expect(h.get("overlay_suppressed_rows")).toBe("0");
			const rows = named(run.stdout, "temporaryWombatHelper");
			expect(rows.length).toBe(1);
			expect(rows[0]).not.toContain("source=dirty"); // the INDEX's row
		},
		TIMEOUT_MS,
	);
});

describe("HW-1: indexed while dirty, restored to HEAD, caught via the high-water set", () => {
	test(
		"the dirty-only function is gone and the HEAD body is served (A)",
		async () => {
			const p = await project("hw1-");
			// A first pass creates the manifest and its high-water mark.
			const first = await search(p, "alpha helper");
			expect(agentHeader(first.stdout).get("overlay_reason")).toBe(
				"index-current",
			);
			p.write("src/alpha.ts", DIRTY_ALPHA);
			const indexed = await p.cli(["index", "--agent", "--no-llm"]);
			expect(indexed.exitCode, indexed.stderr).toBe(0);
			p.sandbox.git(p.project, "checkout", "--", "src/alpha.ts");
			expect(p.sandbox.git(p.project, "status", "--porcelain")).toBe("");

			const run = await search(p, "temporary wombat helper");
			expect(run.exitCode, run.stderr).toBe(0);
			const h = agentHeader(run.stdout);
			expect(h.get("overlay_reason")).toBe("dirty");
			expect(h.get("overlay_files")).toBe("1");
			expect(Number(h.get("overlay_suppressed_rows"))).toBeGreaterThan(0);
			expect(named(run.stdout, "temporaryWombatHelper")).toEqual([]);
			expect(
				agentRows(run.stdout).some(
					(r) => r.includes("/src/alpha.ts ") && r.includes(" source=dirty"),
				),
			).toBe(true);
		},
		TIMEOUT_MS,
	);
});

describe("W-1: indexed by an MCP search, restored, caught via the watch set", () => {
	test(
		"`--agent search` after the restore: the dirty-only function is gone (A)",
		async () => {
			const p = await project("w1-");
			p.write("src/alpha.ts", DIRTY_ALPHA);
			// MCP `search` auto-indexes (the dirty text enters the index), then
			// runs the overlay, which records the git-dirty path in its watch set.
			const mcp = await collect(
				Bun.spawn(
					[
						process.execPath,
						"--env-file=/dev/null",
						MCP_CHILD,
						"search",
						p.project,
						"temporary wombat helper",
					],
					{
						cwd: p.project,
						env: sandboxEnv(p.scratch),
						stdin: "ignore",
						stdout: "pipe",
						stderr: "pipe",
					},
				),
			);
			expect(mcp.exitCode, mcp.stderr).toBe(0);
			const payload = JSON.parse((mcp.result as { text: string }).text);
			expect(payload.overlay.reason).toBe("index-current");
			p.sandbox.git(p.project, "checkout", "--", "src/alpha.ts");

			const run = await search(p, "temporary wombat helper");
			expect(run.exitCode, run.stderr).toBe(0);
			expect(agentHeader(run.stdout).get("overlay_files")).toBe("1");
			expect(named(run.stdout, "temporaryWombatHelper")).toEqual([]);
		},
		TIMEOUT_MS,
	);
});
