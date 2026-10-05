/**
 * V3.21 (decision I-13) — the graph commands SAY when the branch is not indexed.
 *
 * ── THE DECISION THIS TESTS ─────────────────────────────────────────────────
 * D1 lets `search` answer an unknown branch with the SUPERSET, flagged, because
 * a search retrieves and every row it returns is real code. The graph commands
 * ANALYSE — `dead-code` asks which symbols have zero callers, `impact` walks
 * transitive callers, `map` ranks by PageRank — and pooling rows across branches
 * would not widen those answers, it would falsify them. So I-13 rules the
 * unknown-branch answer for the graph to be the EMPTY graph.
 *
 * Empty is truthful and INDISTINGUISHABLE from a clean repository, which is
 * D1's own invisible-failure argument pointed at the commands D1 did not cover.
 * The fix is not to change the answer; it is to say why it is empty.
 *
 * ── THE FALSIFIER, EXECUTED AS THE TEST ITSELF ──────────────────────────────
 * I-13: "neuter the surfacing and a fresh-branch `dead-code` must become
 * indistinguishable from a clean repository." So the test builds both: a
 * repository with no dead code, and a repository whose current branch has never
 * been indexed. It asserts that everything EXCEPT the branch lines is
 * byte-identical between them — and that the full outputs are not. The second
 * assertion is the one that goes red when `reportBranchState` is neutered, and
 * the first is what stops the test drifting into comparing two unrelated
 * outputs.
 *
 * `bun run build` is a precondition (CLAUDE.md #13).
 */

import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createGitSandbox } from "../../helpers/git-sandbox.js";
import {
	BM25_ONLY,
	runCli,
	runLifecycleChild,
	writeSource,
} from "../../helpers/v4-fixtures.js";

const TEST_TIMEOUT_MS = 300_000;

/** Every command I-13 names, with the arguments it needs. */
const GRAPH_COMMANDS: ReadonlyArray<readonly string[]> = [
	["map"],
	["symbol", "helper"],
	["callers", "helper"],
	["callees", "helper"],
	["context", "helper"],
	["dead-code"],
	["test-gaps"],
	["impact", "helper"],
	["status"],
];

interface Repo {
	project: string;
	scratch: string;
	cleanup: () => void;
	git: (cwd: string, ...args: string[]) => string;
}

function makeRepo(prefix: string): Repo {
	const sandbox = createGitSandbox(prefix);
	const project = join(sandbox.root, "repo");
	sandbox.git(sandbox.root, "init", "repo");
	writeFileSync(join(project, ".gitignore"), ".mnemex/\n");
	writeFileSync(
		join(project, "mnemex.json"),
		`${JSON.stringify(BM25_ONLY, null, 2)}\n`,
	);
	writeSource(project, "src/a.ts", 3, "a");
	sandbox.git(project, "add", "-A");
	sandbox.git(project, "commit", "-m", "initial");
	return {
		project,
		scratch: join(sandbox.root, "scratch"),
		cleanup: () => sandbox.cleanup(),
		git: sandbox.git,
	};
}

/** Output lines that are NOT the branch report. */
function withoutBranchLines(stdout: string): string {
	return stdout
		.split("\n")
		.filter(
			(line) =>
				!line.startsWith("branch_unknown=") &&
				!line.startsWith("branch=") &&
				!line.startsWith("branch_hint="),
		)
		.join("\n");
}

describe("V3.21 — an unindexed branch is never silently empty", () => {
	test(
		"a fresh branch's dead-code is distinguishable from a clean repository's",
		async () => {
			const clean = makeRepo("mnemex-v321-clean-");
			const fresh = makeRepo("mnemex-v321-fresh-");
			try {
				// A: indexed, nothing dead. `dead-code` prints a count of 0.
				let run = await runLifecycleChild(clean.project, 1, 0, clean.scratch);
				expect(run.exitCode, run.stderr).toBe(0);
				// B: indexed on `main`, then a branch nothing has ever indexed.
				run = await runLifecycleChild(fresh.project, 1, 0, fresh.scratch);
				expect(run.exitCode, run.stderr).toBe(0);
				fresh.git(fresh.project, "checkout", "-b", "brand-new");

				const cleanOut = await runCli(
					["--agent", "dead-code"],
					clean.scratch,
					clean.project,
				);
				const freshOut = await runCli(
					["--agent", "dead-code"],
					fresh.scratch,
					fresh.project,
				);
				expect(cleanOut.exitCode, cleanOut.stderr).toBe(0);
				expect(freshOut.exitCode, freshOut.stderr).toBe(0);

				// The two ANSWERS are the same, and that is the point: the answer is
				// not what tells them apart, so nothing but the report can.
				expect(withoutBranchLines(freshOut.stdout)).toBe(
					withoutBranchLines(cleanOut.stdout),
				);
				expect(cleanOut.stdout).toContain("dead_code_count=0");

				// I-13's FALSIFIER, as an assertion: remove the surfacing and these
				// two outputs are byte-identical.
				expect(freshOut.stdout).not.toBe(cleanOut.stdout);
				expect(freshOut.stdout).toContain("branch_unknown=1");
				expect(freshOut.stdout).toContain("branch=brand-new");
				// It must NAME THE COMMAND that fixes it, not merely flag a state.
				expect(freshOut.stdout).toMatch(/branch_hint=.*mnemex index/);
				expect(cleanOut.stdout).toContain("branch_unknown=0");
				expect(cleanOut.stdout).not.toContain("branch_hint=");
			} finally {
				clean.cleanup();
				fresh.cleanup();
			}
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"every command I-13 names carries the flag, in both states",
		async () => {
			const fx = makeRepo("mnemex-v321-all-");
			try {
				const run = await runLifecycleChild(fx.project, 1, 0, fx.scratch);
				expect(run.exitCode, run.stderr).toBe(0);

				// Known branch: the key is present and 0. Emitted ALWAYS, so a
				// consumer can rely on the key rather than on its absence.
				for (const command of GRAPH_COMMANDS) {
					const out = await runCli(
						["--agent", ...command],
						fx.scratch,
						fx.project,
					);
					expect(out.stdout, `${command.join(" ")} (known)`).toContain(
						"branch_unknown=0",
					);
				}

				fx.git(fx.project, "checkout", "-b", "brand-new");
				for (const command of GRAPH_COMMANDS) {
					const out = await runCli(
						["--agent", ...command],
						fx.scratch,
						fx.project,
					);
					const text = `${out.stdout}\n${out.stderr}`;
					expect(text, `${command.join(" ")} (unknown)`).toContain(
						"branch_unknown=1",
					);
					expect(text, `${command.join(" ")} (unknown)`).toMatch(
						/branch_hint=.*mnemex index/,
					);
				}
			} finally {
				fx.cleanup();
			}
		},
		TEST_TIMEOUT_MS,
	);
});
