/**
 * Phase 0 characterisation pin (step 3, R1.5 / P-5): the PATH SPELLING each
 * `--agent` command prints, through the BUILT entry point.
 *
 * Recorded at baseline `1ff08c3`, before any R1 change, and required to stay
 * byte-for-byte the same spelling afterwards:
 *
 *   search                                   ABSOLUTE  (`output/agent.ts`
 *                                            searchResults: `r.chunk.filePath`,
 *                                            which leaves the store through
 *                                            `outputPath()` → `fromStoredPath()`)
 *   symbol, callers, callees, context, map,  REPO-RELATIVE (`SymbolDefinition
 *   dead-code, test-gaps, impact             .filePath` as stored; `rowToSymbol`
 *                                            returns it verbatim)
 *
 * WHY THIS IS A PIN AND NOT A DESIGN CHOICE. R1 fixes the dead-code penalty's
 * path comparison. The architecture's first option was to make symbols leave
 * the tracker absolute; the consumer census showed that flips `dead-code` /
 * `test-gaps` verdicts and changes `--agent` output on eight commands, so the
 * comparison moved INTO the tracker instead (orchestrator ruling 1). This file
 * is what makes "no output spelling changes" a checked statement.
 *
 * FALSIFIED BY making `rowToSymbol` (src/core/tracker.ts) return an absolute
 * path: every graph-command assertion below goes red. Executed during Phase 1;
 * the red output is in the session's implementation log.
 *
 * `bun run build` is a precondition (CLAUDE.md #13).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { isAbsolute, join } from "node:path";
import {
	APP_FILE,
	agentFileValues,
	HELPER_FILE,
	type IndexedProject,
	indexedSpellingProject,
	OTHER_HELPER_FILE,
} from "../../helpers/path-spelling-fixture.js";

const TIMEOUT_MS = 300_000;
const REPO_RELATIVE = new Set([HELPER_FILE, APP_FILE, OTHER_HELPER_FILE]);

/**
 * Each graph command, with the arguments that make it print at least one path.
 * The PageRank thresholds are widened because a three-file graph puts every
 * symbol near 1/N, above the defaults.
 */
const GRAPH_COMMANDS: ReadonlyArray<readonly string[]> = [
	["symbol", "helper"],
	["callers", "helper"],
	["callees", "main"],
	["context", "helper"],
	["map"],
	["dead-code", "--max-pagerank", "1"],
	["test-gaps", "--min-pagerank", "0"],
	["impact", "helper"],
];

let fx: IndexedProject;

beforeAll(async () => {
	fx = await indexedSpellingProject("mnemex-spelling-pin-");
}, TIMEOUT_MS);

afterAll(() => {
	fx?.cleanup();
});

describe("--agent path spelling (Phase 0 pin, R1.5)", () => {
	test(
		"search prints ABSOLUTE paths under the project root",
		async () => {
			const out = await fx.cli(["--agent", "search", "helper", "-n", "10"]);
			expect(out.exitCode, out.stderr).toBe(0);
			const files = agentFileValues(out.stdout);
			expect(files.length).toBeGreaterThan(0);
			for (const file of files) {
				expect(isAbsolute(file), file).toBe(true);
				expect(file.startsWith(`${fx.project}/`), file).toBe(true);
			}
			// The file that defines `helper` is among them, spelled absolutely.
			expect(files).toContain(join(fx.project, HELPER_FILE));
		},
		TIMEOUT_MS,
	);

	for (const command of GRAPH_COMMANDS) {
		test(
			`${command[0]} prints REPO-RELATIVE paths`,
			async () => {
				const out = await fx.cli(["--agent", ...command]);
				expect(out.exitCode, out.stderr).toBe(0);
				const files = agentFileValues(out.stdout);
				// Not vacuous: a command that printed no path pins nothing.
				expect(files.length, out.stdout).toBeGreaterThan(0);
				for (const file of files) {
					expect(isAbsolute(file), `${command[0]}: ${file}`).toBe(false);
					expect(REPO_RELATIVE.has(file), `${command[0]}: ${file}`).toBe(true);
				}
			},
			TIMEOUT_MS,
		);
	}

	test(
		"the graph answers themselves are the ones the fixture implies",
		async () => {
			// Spelling is only meaningful if the commands found the right symbols.
			const callers = await fx.cli(["--agent", "callers", "helper"]);
			expect(callers.stdout).toContain(
				`caller name=main file=${APP_FILE} line=3`,
			);
			const dead = await fx.cli([
				"--agent",
				"dead-code",
				"--max-pagerank",
				"1",
			]);
			expect(dead.stdout).toContain(
				`dead_symbol name=unusedLocal file=${HELPER_FILE}`,
			);
			const impact = await fx.cli(["--agent", "impact", "helper"]);
			expect(impact.stdout).toContain(`affected name=main file=${APP_FILE}`);
		},
		TIMEOUT_MS,
	);
});
