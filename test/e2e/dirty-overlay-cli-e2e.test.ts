/**
 * The local dirty overlay through the BUILT entry point (step 3, phase 6:
 * reachability and contracts). `bun run build` first (CLAUDE.md #13).
 *
 * Every child is `dist/index.js` with `keychainSafeChildEnv()`, a sandbox
 * HOME, `MNEMEX_EMBED_CACHE_PATH` and `MNEMEX_GLOBAL_LOCK_PATH` in the scratch
 * directory (`runCli`). The embedding provider is the in-process counting
 * fake, so request counts and model names are read off the WIRE, from outside
 * the child — never from the child's own report.
 *
 *   E-1   clean -> modify -> untracked -> delete -> second-worktree isolation ->
 *         overlay embedding refused AFTER the query, one project, in order.
 *   M-4   a planted new function is in the top `limit`, `source=dirty`,
 *         without `mnemex index` (pass-blocking, ruling 4's clarification).
 *   I-1   (step 6 of E-1) the provider answers the query, then refuses:
 *         index results, `overlay=skipped overlay_reason=embed-failed`, the
 *         stale index row visible again (count).
 *   BUDGET-1 the provider answers the query, then STALLS: the search returns
 *         within the overlay's 8 s rebuild budget + 2 s of the same search with
 *         `--no-dirty`, exit 0, `overlay_reason=dirty`, the file pending, the
 *         gap named (code review 1, HIGH 1: the budget bounds wall time)
 *   I-2   the endpoint fully down: the search fails exactly as it did BEFORE
 *         phase 6 (characterisation; captured against the pre-phase-6 build).
 *   MOD-1 index built with model A, config names model B, `use-indexed`: every
 *         overlay embed request names A ON THE WIRE; the manifest says A; a
 *         manifest stamped with B is wiped and rebuilt as A.
 *   R-1   `overlay=on` + `source=dirty` with no cloud config at all.
 *   R-3   `--no-dirtyy` exits 1 and NOTHING ran: no `dirty-overlay` directory
 *         exists afterwards and the fake provider saw ZERO requests.
 *   R-4   `search -- -foo`: `--` ends flags; `-- --no-dirty` is query text.
 *   R-5   config `dirtyOverlay: false` (project, and global) turns it off;
 *         a project `true` beats a global `false`.
 *   R-6   `branch_empty=1` while the only rows are overlay rows.
 *   GATE-1 `vector: false` without `--keyword`: `overlay=off
 *         overlay_reason=keyword-only`, no throw.
 *   FLAGS every flag a real caller passes (ruling 5's derivation) is accepted.
 *   ZC-2  code review 2, MEDIUM 2, through the REAL indexer: an empty
 *         `pkg/__init__.py` (zero chunks, so `mnemex index` stamps no tracker
 *         row for it) is served while untracked; once committed and indexed,
 *         a clean worktree reports `overlay_reason=index-current`
 *         `overlay_files=0` on every search, not `dirty` forever.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	agentHeader,
	agentRows,
	findOverlayDirs,
	type OverlayCliProject,
	overlayCliProject,
	tsFunctions,
} from "../helpers/overlay-cli-fixture.js";

const TIMEOUT_MS = 180_000;

let current: OverlayCliProject | null = null;
afterEach(() => {
	current?.cleanup();
	current = null;
});

async function project(
	prefix: string,
	files: Record<string, string>,
	options?: Parameters<typeof overlayCliProject>[2],
): Promise<OverlayCliProject> {
	current = await overlayCliProject(prefix, files, options);
	return current;
}

const BASE_FILES = {
	"src/alpha.ts": tsFunctions("alpha", 3),
	"src/beta.ts": tsFunctions("beta", 3),
	"src/gamma.ts": tsFunctions("gamma", 2),
};

/**
 * A function long enough (> the chunker's 50-token floor) to be its own NAMED
 * `function` chunk. A shorter one becomes a nameless gap chunk, and an overlay
 * row has no code-unit twin to lend it a name (R3.8), so `name=` would be empty.
 */
function bigFunction(name: string, phrase: string): string {
	return (
		`export function ${name}(input: number[]): number {\n` +
		`\t// ${phrase}\n` +
		"\tlet total = 0;\n" +
		"\tfor (const value of input) {\n" +
		"\t\tif (value > 10) {\n" +
		"\t\t\ttotal += value * 2;\n" +
		"\t\t} else {\n" +
		"\t\t\ttotal -= value;\n" +
		"\t\t}\n" +
		"\t}\n" +
		`\tconst label = "${phrase}";\n` +
		"\treturn total + label.length;\n" +
		"}\n"
	);
}

/** alpha.ts with `alpha_2` REMOVED and a distinctive new function planted. */
const ALPHA_EDITED =
	tsFunctions("alpha", 2) +
	bigFunction("zebraQuokkaFeature", "zebra quokka feature planted here");

const DELTA_UNTRACKED = bigFunction(
	"ocelotPangolinRoutine",
	"ocelot pangolin routine",
);

function rowsNamed(stdout: string, name: string): string[] {
	return agentRows(stdout).filter(
		(r) => r.includes(` name=${name} `) || r.endsWith(` name=${name}`),
	);
}

function dirtyRows(stdout: string): string[] {
	return agentRows(stdout).filter((r) => r.includes(" source=dirty"));
}

describe("E-1: the overlay end to end, through dist/index.js", () => {
	test(
		"clean -> modify -> untracked -> delete -> second worktree -> embed refused after the query",
		async () => {
			const p = await project("e1-", BASE_FILES);
			const search = (q: string, ...extra: string[]) =>
				p.cli(["search", q, "--agent", "-n", "10", ...extra]);

			// ── 1. clean: a no-op, and the results equal the overlay-off results (NFR-2)
			const clean = await search("alpha helper number");
			expect(clean.exitCode, clean.stderr).toBe(0);
			const h1 = agentHeader(clean.stdout);
			expect(h1.get("overlay")).toBe("on");
			expect(h1.get("overlay_reason")).toBe("index-current");
			expect(h1.get("overlay_files")).toBe("0");
			expect(dirtyRows(clean.stdout)).toEqual([]);
			const off = await search("alpha helper number", "--no-dirty");
			expect(off.exitCode, off.stderr).toBe(0);
			expect(agentHeader(off.stdout).get("overlay")).toBe("off");
			expect(agentHeader(off.stdout).get("overlay_reason")).toBe("flag");
			expect(agentRows(clean.stdout).length).toBeGreaterThan(0);
			expect(agentRows(clean.stdout)).toEqual(agentRows(off.stdout));

			// ── 2. modify: the planted function appears, marked; the removed one is gone
			p.write("src/alpha.ts", ALPHA_EDITED);
			p.server.resetCounts();
			const modified = await search("zebra quokka feature planted");
			expect(modified.exitCode, modified.stderr).toBe(0);
			const h2 = agentHeader(modified.stdout);
			expect(h2.get("overlay")).toBe("on");
			expect(h2.get("overlay_reason")).toBe("dirty");
			expect(h2.get("overlay_files")).toBe("1");
			expect(Number(h2.get("overlay_suppressed_rows"))).toBeGreaterThan(0);
			expect(Number(h2.get("overlay_rebuilt"))).toBe(1);
			expect(Number(h2.get("overlay_embedded"))).toBeGreaterThan(0);
			const planted = rowsNamed(modified.stdout, "zebraQuokkaFeature");
			expect(planted.length).toBe(1);
			expect(planted[0]).toContain(` file=${join(p.project, "src/alpha.ts")} `);
			expect(planted[0]).toContain(" source=dirty");
			// Overlay rows belong to no branch: never labelled.
			expect(planted[0]).not.toContain(" branches=");
			// `alpha_2` exists only in the index now: suppressed, never shown.
			const gone = await search("alpha helper number 2");
			expect(rowsNamed(gone.stdout, "alpha_2")).toEqual([]);
			expect(rowsNamed(off.stdout, "alpha_2").length).toBe(1); // it was there before

			// ── 3. untracked: searchable
			p.write("src/delta.ts", DELTA_UNTRACKED);
			const untracked = await search("ocelot pangolin routine");
			expect(untracked.exitCode, untracked.stderr).toBe(0);
			const ocelot = rowsNamed(untracked.stdout, "ocelotPangolinRoutine");
			expect(ocelot.length).toBe(1);
			expect(ocelot[0]).toContain(" source=dirty");
			expect(agentHeader(untracked.stdout).get("overlay_files")).toBe("2");

			// ── 4. delete: none of its index rows appear
			p.remove("src/beta.ts");
			const deleted = await search("beta helper number");
			expect(deleted.exitCode, deleted.stderr).toBe(0);
			expect(agentHeader(deleted.stdout).get("overlay_files_deleted")).toBe(
				"1",
			);
			expect(
				agentRows(deleted.stdout).filter((r) => r.includes("/src/beta.ts ")),
			).toEqual([]);
			// ...and they WERE in the index (the clean run's control).
			const betaClean = await search("beta helper number", "--no-dirty");
			expect(
				agentRows(betaClean.stdout).filter((r) => r.includes("/src/beta.ts "))
					.length,
			).toBeGreaterThan(0);

			// ── 5. a second worktree sees none of worktree A's dirty work
			const wt2 = join(p.sandbox.root, "wt2");
			p.sandbox.git(p.project, "worktree", "add", "-q", "-b", "other", wt2);
			const other = await p.cli(
				["search", "zebra quokka feature planted", "--agent", "-n", "10"],
				wt2,
			);
			expect(other.exitCode, other.stderr).toBe(0);
			expect(dirtyRows(other.stdout)).toEqual([]);
			expect(rowsNamed(other.stdout, "zebraQuokkaFeature")).toEqual([]);
			expect(agentHeader(other.stdout).get("overlay_files")).toBe("0");
			// One overlay per worktree, each inside its own worktree; none in the
			// shared git-common-dir store (R3.6/R3.7).
			const dirs = findOverlayDirs(p.sandbox.root);
			expect(dirs.length).toBe(2);
			expect(dirs.filter((d) => d.startsWith(`${wt2}/`)).length).toBe(1);
			expect(dirs.filter((d) => d.startsWith(`${p.project}/`)).length).toBe(1);
			expect(dirs.some((d) => d.includes(`${join(".git", "mnemex")}`))).toBe(
				false,
			);

			// ── 6. the provider answers the QUERY, then refuses (I-1, re-scoped R3.11)
			p.write("src/alpha.ts", `${ALPHA_EDITED}\n// one more edit\n`);
			p.server.resetCounts();
			p.server.refuseAfterNext(1);
			const refused = await search("alpha helper number 2");
			p.server.refuseAfterNext(null);
			expect(refused.exitCode, refused.stderr).toBe(0);
			const h6 = agentHeader(refused.stdout);
			expect(h6.get("overlay")).toBe("skipped");
			expect(h6.get("overlay_reason")).toBe("embed-failed");
			expect(h6.get("overlay_suppressed_rows")).toBe("0");
			expect(p.server.embedRequests()).toBe(1); // the query, answered
			expect(p.server.refused()).toBeGreaterThan(0); // the overlay, refused
			// Nothing is suppressed, so the STALE index row is visible again.
			expect(rowsNamed(refused.stdout, "alpha_2").length).toBe(1);
			expect(dirtyRows(refused.stdout)).toEqual([]);
		},
		TIMEOUT_MS,
	);
});

describe("ZC-2: a committed zero-chunk file, through the REAL indexer", () => {
	test(
		"empty __init__.py: served untracked; committed + indexed → index-current on every search",
		async () => {
			const p = await project("zc2-", BASE_FILES);
			const search = () =>
				p.cli(["search", "alpha helper number", "--agent", "-n", "5"]);
			p.write("pkg/__init__.py", "");
			const untracked = await search();
			expect(untracked.exitCode, untracked.stderr).toBe(0);
			expect(agentHeader(untracked.stdout).get("overlay_reason")).toBe("dirty");

			p.sandbox.git(p.project, "add", "-A");
			p.sandbox.git(p.project, "commit", "-q", "-m", "add pkg");
			const indexed = await p.cli(["index", "--agent", "--no-llm"]);
			expect(indexed.exitCode, indexed.stderr).toBe(0);
			// Outside the racy window: the save was not made during a search.
			const when = (Date.now() - 10_000) / 1000;
			utimesSync(join(p.project, "pkg/__init__.py"), when, when);

			for (const n of [1, 2]) {
				const clean = await search();
				expect(clean.exitCode, clean.stderr).toBe(0);
				const h = agentHeader(clean.stdout);
				expect(`${n}: ${h.get("overlay")}/${h.get("overlay_reason")}`).toBe(
					`${n}: on/index-current`,
				);
				expect(h.get("overlay_files")).toBe("0");
				expect(dirtyRows(clean.stdout)).toEqual([]);
			}
		},
		TIMEOUT_MS,
	);
});

describe("BUDGET-1: a stalled provider cannot hold a search past the budget", () => {
	test(
		"answered query, stalled overlay → back within 8 s + 2 s of the --no-dirty search",
		async () => {
			const p = await project("budget1-", BASE_FILES);
			const search = (...extra: string[]) =>
				p.cli([
					"search",
					"alpha helper number",
					"--agent",
					"-n",
					"10",
					...extra,
				]);
			p.write("src/alpha.ts", ALPHA_EDITED);

			const t0 = Date.now();
			const baseline = await search("--no-dirty");
			const baselineMs = Date.now() - t0;
			expect(baseline.exitCode, baseline.stderr).toBe(0);

			p.server.resetCounts();
			p.server.failAfterNext(1, "stall"); // the query, then nothing
			const t1 = Date.now();
			const stalled = await search();
			const stalledMs = Date.now() - t1;
			p.server.failAfterNext(null);
			console.log(
				`BUDGET-1: --no-dirty ${baselineMs} ms, stalled provider ${stalledMs} ms`,
			);

			expect(stalled.exitCode, stalled.stderr).toBe(0);
			expect(p.server.embedRequests()).toBe(1); // the query, answered
			expect(p.server.refused()).toBeGreaterThan(0); // the overlay, stalled
			const h = agentHeader(stalled.stdout);
			expect(h.get("overlay")).toBe("on");
			expect(h.get("overlay_reason")).toBe("dirty");
			expect(h.get("overlay_files")).toBe("0");
			expect(h.get("overlay_files_pending")).toBe("1");
			expect(h.get("overlay_gaps")).toContain("embed-deadline");
			// Pending is not served: the index rows are what the user sees.
			expect(dirtyRows(stalled.stdout)).toEqual([]);
			// THE bound: one rebuild budget plus a stated 2 s margin.
			expect(stalledMs - baselineMs).toBeLessThan(8000 + 2000);
		},
		TIMEOUT_MS,
	);
});

describe("M-4 / R-1: a planted function, through the built binary, no cloud", () => {
	test(
		"in the top `limit`, source=dirty, without `mnemex index`",
		async () => {
			const p = await project("m4-", {
				...BASE_FILES,
				"src/epsilon.ts": tsFunctions("epsilon", 6),
			});
			p.write(
				"src/gamma.ts",
				tsFunctions("gamma", 2) +
					bigFunction("plantedNewFeature", "planted new feature"),
			);
			const run = await p.cli([
				"search",
				"planted new feature",
				"--agent",
				"-n",
				"5",
			]);
			expect(run.exitCode, run.stderr).toBe(0);
			const rows = agentRows(run.stdout);
			expect(rows.length).toBeLessThanOrEqual(5);
			const planted = rows.filter((r) => r.includes(" name=plantedNewFeature"));
			expect(planted.length).toBe(1);
			expect(planted[0]).toContain(" source=dirty");
			expect(agentHeader(run.stdout).get("overlay")).toBe("on");
			// No cloud: nothing in the project or HOME config names a team.
			expect(
				readFileSync(join(p.project, "mnemex.json"), "utf8"),
			).not.toContain("team");
		},
		TIMEOUT_MS,
	);
});

describe("I-2: the endpoint fully down fails the search exactly as before", () => {
	test(
		"exit 1, nothing on stdout, the provider's own all-texts-failed error",
		async () => {
			const p = await project("i2-", {
				"src/alpha.ts": tsFunctions("alpha", 3),
			});
			p.write("src/alpha.ts", ALPHA_EDITED); // dirty, so the overlay WOULD run
			p.server.stop();
			const run = await p.cli(["search", "alpha helper", "--agent", "-n", "3"]);
			// Captured against the pre-phase-6 build (no overlay wired): identical.
			expect(run.exitCode).toBe(1);
			expect(run.stdout).toBe("");
			expect(run.stderr).toBe(
				"\nOllama embeddings failed for all 1 texts, so this is not a per-text problem.\n" +
					"  First failure: Chunk 1: Unable to connect. Is the computer able to access the url?\n",
			);
			// The query failed first, so no overlay pass ever started.
			expect(p.overlayDirs()).toEqual([]);
		},
		TIMEOUT_MS,
	);
});

describe("MOD-1: the overlay embeds with the model the INDEX was built with", () => {
	test(
		"index A, config B, use-indexed: every overlay request names A on the wire; a B manifest is wiped",
		async () => {
			const p = await project("mod1-", BASE_FILES); // indexed with ollama/fake-embed (A)
			p.globalConfig({ defaultModel: "ollama/other-embed" }); // B
			p.write("src/alpha.ts", ALPHA_EDITED);
			p.server.resetCounts();
			const run = await p.cli([
				"search",
				"zebra quokka feature",
				"--agent",
				"-n",
				"5",
			]);
			expect(run.exitCode, run.stderr).toBe(0);
			const header = agentHeader(run.stdout);
			expect(header.get("overlay")).toBe("on");
			expect(header.get("overlay_reason")).toBe("dirty");
			expect(header.get("embedding_model")).toBe("ollama/fake-embed");
			const models = p.server.models();
			// The query plus the overlay's chunks, and every one of them is A.
			expect(models.length).toBeGreaterThan(1);
			expect(new Set(models)).toEqual(new Set(["fake-embed"]));
			const [dir] = p.overlayDirs();
			const manifestPath = join(dir, "manifest.json");
			const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
			expect(manifest.embedding.model).toBe("ollama/fake-embed");
			expect(manifest.embedding.provider).toBe("ollama");

			// A manifest stamped with B is not served: wiped and rebuilt as A.
			manifest.embedding.model = "ollama/other-embed";
			writeFileSync(manifestPath, JSON.stringify(manifest));
			p.server.resetCounts();
			const again = await p.cli([
				"search",
				"zebra quokka feature",
				"--agent",
				"-n",
				"5",
			]);
			expect(again.exitCode, again.stderr).toBe(0);
			expect(agentHeader(again.stdout).get("overlay_rebuilt")).toBe("1");
			expect(new Set(p.server.models())).toEqual(new Set(["fake-embed"]));
			expect(
				JSON.parse(readFileSync(manifestPath, "utf8")).embedding.model,
			).toBe("ollama/fake-embed");
		},
		TIMEOUT_MS,
	);
});

describe("R-3 / R-4: strict search flags", () => {
	test(
		"`--no-dirtyy` exits 1, names --no-dirty, and NOTHING ran (no overlay dir, 0 requests)",
		async () => {
			const p = await project("r3-", BASE_FILES);
			p.write("src/alpha.ts", ALPHA_EDITED); // a real search WOULD build an overlay
			p.server.resetCounts();
			const run = await p.cli([
				"search",
				"zebra quokka",
				"--agent",
				"--no-dirtyy",
			]);
			expect(run.exitCode).toBe(1);
			expect(run.stderr).toContain("value=--no-dirtyy");
			expect(run.stderr).toContain("Did you mean --no-dirty?");
			expect(run.stdout).toBe("");
			// Bytes and counts, not the exit code alone.
			expect(p.overlayDirs()).toEqual([]);
			expect(p.server.requests()).toBe(0);

			// Control: the same search without the typo DOES both.
			const real = await p.cli(["search", "zebra quokka", "--agent"]);
			expect(real.exitCode, real.stderr).toBe(0);
			expect(p.overlayDirs().length).toBe(1);
			expect(p.server.requests()).toBeGreaterThan(0);
		},
		TIMEOUT_MS,
	);

	test(
		"`--` ends flags: `search -- -foo` searches for -foo; `-- --no-dirty` is query text",
		async () => {
			const p = await project("r4-", BASE_FILES);
			p.write("src/alpha.ts", ALPHA_EDITED);
			const dashed = await p.cli(["search", "--agent", "--", "-foo"]);
			expect(dashed.exitCode, dashed.stderr).toBe(0);
			expect(dashed.stdout).toContain("query=-foo\n");
			const literal = await p.cli([
				"search",
				"zebra",
				"--agent",
				"--",
				"--no-dirty",
			]);
			expect(literal.exitCode, literal.stderr).toBe(0);
			expect(literal.stdout).toContain("query=zebra --no-dirty\n");
			expect(agentHeader(literal.stdout).get("overlay")).toBe("on");
		},
		TIMEOUT_MS,
	);

	test(
		"every flag a real caller passes is accepted (ruling 5's derived set)",
		async () => {
			const p = await project("flags-", BASE_FILES);
			const forms: string[][] = [
				["-n", "3"],
				["--limit", "3"],
				["-l", "typescript"],
				["--language", "typescript"],
				["-p", p.project],
				["--path", p.project],
				["-m", "ollama/fake-embed"],
				["--model", "ollama/fake-embed"],
				["--no-reindex"],
				["-y"],
				["--yes"],
				["--use-case", "navigation"],
				["-k"],
				["--keyword"],
				["--no-dirty"],
				// Tolerated no-ops, passed by real callers (see the phase-6 log).
				["--map"],
				["--page-size", "20", "--page", "1"],
				["--raw"],
			];
			for (const form of forms) {
				const run = await p.cli(["search", "alpha", "--agent", ...form]);
				expect({
					form: form.join(" "),
					exit: run.exitCode,
					stderr: run.stderr,
				}).toEqual({ form: form.join(" "), exit: 0, stderr: "" });
			}
		},
		TIMEOUT_MS,
	);
});

describe("`mnemex rg` never runs the overlay (CLAUDE.md #14)", () => {
	test(
		"a dirty worktree: rg's semantic half passes overlay off — no overlay dir, only the query embedded",
		async () => {
			const p = await project("rg-", BASE_FILES);
			p.write("src/alpha.ts", ALPHA_EDITED);
			p.server.resetCounts();
			const run = await p.cli(["rg", "zebraQuokkaFeature", "src"]);
			expect(run.exitCode, run.stderr).toBe(0);
			expect(run.stdout).toContain("zebraQuokkaFeature");
			expect(p.overlayDirs()).toEqual([]);
			// The augmentation embeds its query once; an overlay pass would embed
			// the edited file's chunks too.
			expect(p.server.embedRequests()).toBeLessThanOrEqual(1);
		},
		TIMEOUT_MS,
	);
});

describe("R-5: the config key turns it off, project over global", () => {
	test(
		"project false -> off/config; global false -> off/config; project true beats global false",
		async () => {
			const p = await project("r5-", BASE_FILES);
			p.write("src/alpha.ts", ALPHA_EDITED);
			const state = async () => {
				const run = await p.cli(["search", "zebra quokka", "--agent"]);
				expect(run.exitCode, run.stderr).toBe(0);
				const h = agentHeader(run.stdout);
				return {
					overlay: h.get("overlay"),
					reason: h.get("overlay_reason"),
					dirty: dirtyRows(run.stdout).length > 0,
				};
			};
			p.projectConfig({ dirtyOverlay: false });
			expect(await state()).toEqual({
				overlay: "off",
				reason: "config",
				dirty: false,
			});
			expect(p.overlayDirs()).toEqual([]);
			p.projectConfig({});
			p.globalConfig({ dirtyOverlay: false });
			expect(await state()).toEqual({
				overlay: "off",
				reason: "config",
				dirty: false,
			});
			p.projectConfig({ dirtyOverlay: true });
			expect(await state()).toEqual({
				overlay: "on",
				reason: "dirty",
				dirty: true,
			});
		},
		TIMEOUT_MS,
	);
});

describe("GATE-1 / R-6", () => {
	test(
		"vector:false without --keyword -> overlay=off overlay_reason=keyword-only, no throw",
		async () => {
			const p = await project("gate1-", BASE_FILES, {
				projectConfig: { vector: false },
			});
			p.write("src/alpha.ts", ALPHA_EDITED);
			p.server.resetCounts();
			const run = await p.cli(["search", "alpha", "--agent"]);
			expect(run.exitCode, run.stderr).toBe(0);
			expect(agentHeader(run.stdout).get("overlay")).toBe("off");
			expect(agentHeader(run.stdout).get("overlay_reason")).toBe(
				"keyword-only",
			);
			expect(p.server.requests()).toBe(0);
			expect(p.overlayDirs()).toEqual([]);
		},
		TIMEOUT_MS,
	);

	test(
		"branch_empty=1 when the branch holds no rows, even though overlay rows came back",
		async () => {
			const p = await project("r6-", BASE_FILES);
			const cleared = await p.cli(["clear", "-f"]);
			expect(cleared.exitCode, cleared.stderr).toBe(0);
			p.write("src/delta.ts", DELTA_UNTRACKED);
			const run = await p.cli(["search", "ocelot pangolin", "--agent"]);
			expect(run.exitCode, run.stderr).toBe(0);
			const rows = agentRows(run.stdout);
			expect(rows.length).toBeGreaterThan(0);
			expect(rows.every((r) => r.includes(" source=dirty"))).toBe(true);
			expect(agentHeader(run.stdout).get("branch_empty")).toBe("1");
		},
		TIMEOUT_MS,
	);
});
