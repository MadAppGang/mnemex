/**
 * "Registered but EMPTY" is said out loud (decision I-16's related gap).
 *
 * ── THE STATE NOTHING COULD REPORT ──────────────────────────────────────────
 * `branchUnknown` answers "the registry has never seen this branch". After a
 * whole-store rebuild — `mnemex index --force-all`, a model change, an index
 * version upgrade, a corruption repair — every OTHER branch is still in
 * `branches.json`, so `graphBranchIdForRead()` resolves a real id,
 * `branchUnknown` is FALSE, and the branch answers every graph command with
 * nothing at all. I-16: "the user switches back to that branch and gets an
 * empty search with no signal whatsoever".
 *
 * Before this phase a `--force` on ANY branch produced the same state for every
 * other branch. That path is now narrowed (`branch-force-scope.test.ts`), but
 * `--force-all` produces it deliberately and by design, which is what this file
 * drives.
 *
 * ── THE FALSIFIER, EXECUTED AS THE TEST ITSELF ──────────────────────────────
 * I-13's shape, reused: the same command on the same branch of the same
 * repository, indexed and then emptied, must not produce the same bytes. Every
 * line EXCEPT the branch report is asserted byte-identical — which is what
 * stops the test drifting into comparing two unrelated outputs — and the full
 * outputs are asserted to differ. Neuter the surfacing and the second
 * assertion goes red.
 *
 * `bun run build` is a precondition (CLAUDE.md #13).
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveStoreLocation } from "../../../src/core/store-location.js";
import { createGitSandbox } from "../../helpers/git-sandbox.js";
import { BM25_ONLY, runCli, writeSource } from "../../helpers/v4-fixtures.js";

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

/** Output lines that are NOT the branch report. */
function withoutBranchLines(stdout: string): string {
	return stdout
		.split("\n")
		.filter(
			(line) =>
				!line.startsWith("branch_unknown=") &&
				!line.startsWith("branch_empty=") &&
				!line.startsWith("branch=") &&
				!line.startsWith("branch_hint=") &&
				// V1.7, added in Phase 3c. The list is what counts as "the branch
				// REPORT" rather than "the answer", and this line is report: it
				// says WHY the branch is empty. It is filtered here and asserted
				// present below, so widening the filter cannot hide it.
				!line.startsWith("store_rebuilt_elsewhere="),
		)
		.join("\n");
}

interface Repo {
	project: string;
	scratch: string;
	storeDir: string;
	git: (cwd: string, ...args: string[]) => string;
	cleanup: () => void;
}

/** `main` and `feat` both indexed into one store, `feat` checked out. */
async function twoIndexedBranches(prefix: string): Promise<Repo> {
	const sandbox = createGitSandbox(prefix);
	const project = join(sandbox.root, "repo");
	const scratch = join(sandbox.root, "scratch");
	sandbox.git(sandbox.root, "init", "repo");
	writeFileSync(join(project, ".gitignore"), ".mnemex/\n");
	writeFileSync(
		join(project, "mnemex.json"),
		`${JSON.stringify(BM25_ONLY, null, 2)}\n`,
	);
	writeSource(project, "src/a.ts", 3, "a");
	sandbox.git(project, "add", "-A");
	sandbox.git(project, "commit", "-m", "initial");
	const first = await runCli(["index"], scratch, project);
	if (first.exitCode !== 0) throw new Error(`index on main: ${first.stderr}`);

	sandbox.git(project, "checkout", "-q", "-b", "feat");
	writeSource(project, "src/b.ts", 3, "b");
	sandbox.git(project, "add", "-A");
	sandbox.git(project, "commit", "-m", "feat");
	const second = await runCli(["index"], scratch, project);
	if (second.exitCode !== 0) throw new Error(`index on feat: ${second.stderr}`);

	return {
		project,
		scratch,
		storeDir: resolveStoreLocation(project).storeDir,
		git: sandbox.git,
		cleanup: () => sandbox.cleanup(),
	};
}

describe("a branch that is registered and holds no rows says so", () => {
	test(
		"the same branch, indexed and then emptied, does not print the same bytes",
		async () => {
			const fx = await twoIndexedBranches("mnemex-empty-");
			try {
				const indexed = await runCli(
					["--agent", "dead-code"],
					fx.scratch,
					fx.project,
				);
				expect(indexed.exitCode, indexed.stderr).toBe(0);
				expect(indexed.stdout).toContain("branch_unknown=0");
				expect(indexed.stdout).toContain("branch_empty=0");
				expect(indexed.stdout).not.toContain("branch_hint=");

				// ── Another worktree rebuilds the whole store ───────────────────
				fx.git(fx.project, "checkout", "-q", "main");
				const rebuilt = await runCli(
					["index", "--force-all"],
					fx.scratch,
					fx.project,
				);
				expect(rebuilt.exitCode, rebuilt.stderr).toBe(0);
				fx.git(fx.project, "checkout", "-q", "feat");

				const emptied = await runCli(
					["--agent", "dead-code"],
					fx.scratch,
					fx.project,
				);
				expect(emptied.exitCode, emptied.stderr).toBe(0);

				// The registry still knows this branch — which is exactly why
				// `branch_unknown` cannot carry this state.
				expect(emptied.stdout).toContain("branch_unknown=0");
				expect(
					JSON.parse(
						readFileSync(join(fx.storeDir, "branches.json"), "utf8"),
					) as { branches: Array<{ label: string }> },
				).toHaveProperty("branches");

				// The ANSWERS are identical, and that is the point: the answer is
				// not what tells them apart, so nothing but the report can.
				expect(withoutBranchLines(emptied.stdout)).toBe(
					withoutBranchLines(indexed.stdout),
				);
				expect(indexed.stdout).toContain("dead_code_count=0");

				// THE FALSIFIER, as an assertion.
				expect(emptied.stdout).not.toBe(indexed.stdout);
				expect(emptied.stdout).toContain("branch_empty=1");
				expect(emptied.stdout).toContain("branch=feat");
				// It must NAME THE COMMAND that fixes it, not merely flag a state.
				expect(emptied.stdout).toMatch(/branch_hint=.*mnemex index/);
				// V1.7 (§4.5, Phase 3c): the store-wide rebuild that emptied this
				// branch was stamped, so the report says WHY and not only THAT.
				// Asserted here because `withoutBranchLines` now filters it out.
				expect(emptied.stdout).toContain("store_rebuilt_elsewhere=1");
				expect(indexed.stdout).not.toContain("store_rebuilt_elsewhere=");
			} finally {
				fx.cleanup();
			}
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"every command I-13 names carries the flag, in both states",
		async () => {
			const fx = await twoIndexedBranches("mnemex-empty-all-");
			try {
				// Indexed: the key is present and 0. Emitted ALWAYS, so a consumer
				// can rely on the key rather than on its absence.
				for (const command of GRAPH_COMMANDS) {
					const out = await runCli(
						["--agent", ...command],
						fx.scratch,
						fx.project,
					);
					expect(out.stdout, `${command.join(" ")} (indexed)`).toContain(
						"branch_empty=0",
					);
				}

				fx.git(fx.project, "checkout", "-q", "main");
				const rebuilt = await runCli(
					["index", "--force-all"],
					fx.scratch,
					fx.project,
				);
				expect(rebuilt.exitCode, rebuilt.stderr).toBe(0);
				fx.git(fx.project, "checkout", "-q", "feat");

				for (const command of GRAPH_COMMANDS) {
					const out = await runCli(
						["--agent", ...command],
						fx.scratch,
						fx.project,
					);
					const text = `${out.stdout}\n${out.stderr}`;
					expect(text, `${command.join(" ")} (emptied)`).toContain(
						"branch_empty=1",
					);
					expect(text, `${command.join(" ")} (emptied)`).toContain(
						"branch_unknown=0",
					);
					expect(text, `${command.join(" ")} (emptied)`).toMatch(
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

/**
 * THE HUMAN-MODE NOTICE IS NOT COVERED HERE, AND THAT IS NOT AN OVERSIGHT.
 *
 * `isAgentMode()` (`cli.ts`) turns agent mode on whenever stdout is not a TTY,
 * so EVERY child a test can spawn is in agent mode and the human branch of
 * `reportBranchState` is unreachable from this harness — measured: a
 * `runCli(["dead-code"])` with no `--agent` still prints `branch_unknown=0`.
 * The same limit applies to phase 3b-3's V3.21 notice, whose human half was
 * never driven either. Reaching it needs a pty, which no helper in this tree
 * provides. Reported in `implementation-log.md` rather than papered over with a
 * test that asserts on source text.
 */
