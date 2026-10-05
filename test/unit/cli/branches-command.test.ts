/**
 * `mnemex branches` and `mnemex branches prune`, through the BUILT entry point.
 *
 * ── WHY THE COMMAND EXISTS ──────────────────────────────────────────────────
 * Everything the branch model does is invisible from outside the store: the
 * ids, the tombstones, the widen backlog, D1's unknown-branch fallback. Before
 * this command, "which branches does this store hold?" could only be answered by
 * opening `branches.json` by hand.
 *
 * ── WHAT IS ASSERTED, AND HOW ───────────────────────────────────────────────
 * Through `dist/index.js`, as a user runs it, in a git sandbox with
 * `keychainSafeChildEnv()` and HOME / `MNEMEX_EMBED_CACHE_PATH` /
 * `MNEMEX_GLOBAL_LOCK_PATH` inside `mkdtemp` (CLAUDE.md #24, #25, #31). Every
 * "nothing was written" claim is asserted on the BYTES of `branches.json`,
 * never on an exit code alone — CLAUDE.md #30's `keychain migrate --dry-runDD`
 * exited 0 WHILE writing, and that is the failure this class of test exists for.
 *
 * ── WHY THE HUMAN RENDERER IS DRIVEN IN-PROCESS ────────────────────────────
 * `isAgentMode()` returns true whenever stdout is not a TTY, so a spawned child
 * with a pipe is ALWAYS in agent mode and the human branch is unreachable
 * through `runCli`. The prose half is therefore called directly, with the
 * working directory moved to the fixture and `console.log` captured. The
 * routing itself (`--agent` reaches the handler as `{ agent: true }`) is what
 * the spawned tests exercise.
 *
 * `bun run build` is a precondition (CLAUDE.md #13).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { handleBranchesCommand } from "../../../src/cli/commands/branches.js";
import { __resetStoreLocationCacheForTests } from "../../../src/core/store-location.js";
import { createGitSandbox } from "../../helpers/git-sandbox.js";
import {
	BM25_ONLY,
	mainCheckoutStoreDir,
	runCli,
	runLifecycleChild,
	writeSource,
} from "../../helpers/v4-fixtures.js";

const TEST_TIMEOUT_MS = 300_000;

interface Fixture {
	project: string;
	scratch: string;
	storeDir: string;
	registryPath: string;
	cleanup: () => void;
	git: (cwd: string, ...args: string[]) => string;
}

function makeRepo(prefix: string): Fixture {
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
		storeDir: mainCheckoutStoreDir(project),
		registryPath: join(mainCheckoutStoreDir(project), "branches.json"),
		cleanup: () => sandbox.cleanup(),
		git: sandbox.git,
	};
}

const originalCwd = process.cwd();
afterEach(() => {
	process.chdir(originalCwd);
	__resetStoreLocationCacheForTests();
});

/**
 * The handler's HUMAN output, with the working directory moved to `project`.
 *
 * `console.log` is captured rather than piped, because a pipe is exactly what
 * makes `isAgentMode()` true and the human branch unreachable.
 */
async function humanRun(
	project: string,
	args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
	process.chdir(project);
	__resetStoreLocationCacheForTests();
	const out: string[] = [];
	const err: string[] = [];
	const log = console.log;
	const error = console.error;
	console.log = (...parts: unknown[]) => out.push(parts.join(" "));
	console.error = (...parts: unknown[]) => err.push(parts.join(" "));
	try {
		const code = await handleBranchesCommand(args, { agent: false });
		return { code, stdout: out.join("\n"), stderr: err.join("\n") };
	} finally {
		console.log = log;
		console.error = error;
	}
}

/** `key=value` lines as a map; repeated keys keep the LAST value. */
function agentPairs(stdout: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const line of stdout.split("\n")) {
		const eq = line.indexOf("=");
		if (eq > 0 && !line.includes(" ")) {
			out.set(line.slice(0, eq), line.slice(eq + 1));
		}
	}
	return out;
}

describe("mnemex branches — the listing", () => {
	test(
		"lists every entry, marks the current one, and counts its rows",
		async () => {
			const fx = makeRepo("mnemex-branches-list-");
			try {
				let run = await runLifecycleChild(fx.project, 1, 0, fx.scratch);
				expect(run.exitCode, run.stderr).toBe(0);
				fx.git(fx.project, "checkout", "-b", "second");
				writeSource(fx.project, "src/b.ts", 2, "b");
				fx.git(fx.project, "add", "-A");
				fx.git(fx.project, "commit", "-m", "second");
				run = await runLifecycleChild(fx.project, 1, 0, fx.scratch);
				expect(run.exitCode, run.stderr).toBe(0);

				const agent = await runCli(
					["--agent", "branches"],
					fx.scratch,
					fx.project,
				);
				expect(agent.exitCode, agent.stderr).toBe(0);
				const pairs = agentPairs(agent.stdout);
				expect(pairs.get("branch_count")).toBe("2");
				expect(pairs.get("branch")).toBe("second");
				expect(pairs.get("branch_unknown")).toBe("0");

				const rows = agent.stdout
					.split("\n")
					.filter((l) => l.startsWith("branch id="));
				expect(rows).toHaveLength(2);
				const current = rows.find((l) => l.includes("label=second"));
				expect(current).toContain("current=1");
				expect(current).toContain("state=live");
				// Counted from the store, not asserted as a constant: the point is
				// that the number is real, not what it happens to be.
				const chunkRows = Number(
					/chunk_rows=(\d+)/.exec(current ?? "")?.[1] ?? "0",
				);
				expect(chunkRows).toBeGreaterThan(0);
				expect(rows.find((l) => l.includes("label=main"))).toContain(
					"current=0",
				);

				const human = await humanRun(fx.project, []);
				expect(human.code, human.stderr).toBe(0);
				expect(human.stdout).toContain("second");
				expect(human.stdout).toContain("chunk row(s)");
			} finally {
				fx.cleanup();
			}
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"a HEAD with no entry is reported as unknown, not as an empty store",
		async () => {
			const fx = makeRepo("mnemex-branches-unknown-");
			try {
				const run = await runLifecycleChild(fx.project, 1, 0, fx.scratch);
				expect(run.exitCode, run.stderr).toBe(0);
				fx.git(fx.project, "checkout", "-b", "never-indexed");

				const agent = await runCli(
					["--agent", "branches"],
					fx.scratch,
					fx.project,
				);
				const pairs = agentPairs(agent.stdout);
				expect(pairs.get("branch_unknown")).toBe("1");
				expect(pairs.get("branch")).toBe("never-indexed");
				// The store is NOT empty — it holds main's rows. The distinction is
				// the whole point: "this branch has nothing" is not "nothing is
				// indexed".
				expect(pairs.get("branch_count")).toBe("1");

				const human = await humanRun(fx.project, []);
				expect(human.stdout).toContain("never-indexed");
				expect(human.stdout).toContain("has no entry");
				expect(human.stdout).toContain("mnemex index");
			} finally {
				fx.cleanup();
			}
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"the soft limit warns and does not fail",
		async () => {
			const fx = makeRepo("mnemex-branches-soft-");
			try {
				// One real run first, so the store directory (and its tracker) exist.
				const indexed = await runLifecycleChild(fx.project, 1, 0, fx.scratch);
				expect(indexed.exitCode, indexed.stderr).toBe(0);
				// A registry written by hand: reaching 257 branches through real
				// index runs would cost 257 checkouts to assert one line. The FILE is
				// the command's input, and this is a real file in the real format —
				// the registry parser validates every field of it.
				const stamp = new Date().toISOString();
				const branches = Array.from({ length: 257 }, (_, i) => ({
					id: i + 1,
					label: `branch-${i}`,
					kind: "branch",
					ephemeral: false,
					headSha: null,
					firstSeen: stamp,
					lastSeen: stamp,
					lastIndexedAt: null,
					deletedAt: null,
					unconfirmedSince: null,
					needsReindex: false,
				}));
				writeFileSync(
					fx.registryPath,
					`${JSON.stringify({ formatVersion: 1, nextId: 258, branches }, null, 2)}\n`,
				);

				const human = await humanRun(fx.project, []);
				// A WARNING, never a failure: §4.3 says there is no ceiling.
				expect(human.code, human.stderr).toBe(0);
				expect(human.stdout).toContain("above the soft limit");
				expect(human.stdout).toContain("mnemex branches prune");
			} finally {
				fx.cleanup();
			}
		},
		TEST_TIMEOUT_MS,
	);
});

describe("mnemex branches — strict flags (CLAUDE.md #30)", () => {
	test(
		"a mistyped --dry-run REFUSES and writes nothing",
		async () => {
			const fx = makeRepo("mnemex-branches-typo-");
			try {
				const run = await runLifecycleChild(fx.project, 1, 0, fx.scratch);
				expect(run.exitCode, run.stderr).toBe(0);
				const before = readFileSync(fx.registryPath, "utf8");

				const typo = await runCli(
					["branches", "prune", "--dry-runDD"],
					fx.scratch,
					fx.project,
				);
				// `mnemex keychain migrate --dry-runDD` exited 0 and ran a REAL
				// migration, because the flag was parsed by `includes()`. Both halves
				// are asserted: the refusal, and the bytes.
				expect(typo.exitCode).toBe(1);
				expect(typo.stderr).toContain("unknown_flag");
				expect(typo.stderr).toContain("Did you mean --dry-run?");
				expect(readFileSync(fx.registryPath, "utf8")).toBe(before);
			} finally {
				fx.cleanup();
			}
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"the listing takes no flags at all",
		async () => {
			const fx = makeRepo("mnemex-branches-noflag-");
			try {
				const run = await runCli(
					["branches", "--dry-run"],
					fx.scratch,
					fx.project,
				);
				expect(run.exitCode).toBe(1);
				expect(run.stderr).toContain("unknown_flag");
				expect(run.stderr).toContain("takes no flags");
			} finally {
				fx.cleanup();
			}
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"an unknown subcommand refuses rather than silently listing",
		async () => {
			const fx = makeRepo("mnemex-branches-sub-");
			try {
				const run = await runCli(["branches", "prne"], fx.scratch, fx.project);
				expect(run.exitCode).toBe(1);
				expect(run.stderr).toContain("unknown_subcommand");
			} finally {
				fx.cleanup();
			}
		},
		TEST_TIMEOUT_MS,
	);
});

describe("mnemex branches prune — W-R7", () => {
	test(
		"--dry-run reports the decision and changes nothing on disk",
		async () => {
			const fx = makeRepo("mnemex-prune-dry-");
			try {
				let run = await runLifecycleChild(fx.project, 1, 0, fx.scratch);
				expect(run.exitCode, run.stderr).toBe(0);
				fx.git(fx.project, "checkout", "-b", "doomed");
				writeSource(fx.project, "src/doomed.ts", 2, "doomed");
				fx.git(fx.project, "add", "-A");
				fx.git(fx.project, "commit", "-m", "doomed");
				run = await runLifecycleChild(fx.project, 1, 0, fx.scratch);
				expect(run.exitCode, run.stderr).toBe(0);
				fx.git(fx.project, "checkout", "main");
				fx.git(fx.project, "branch", "-D", "doomed");
				fx.git(fx.project, "pack-refs", "--all");
				const before = readFileSync(fx.registryPath, "utf8");

				const dry = await runCli(
					["--agent", "branches", "prune", "--dry-run"],
					fx.scratch,
					fx.project,
				);
				expect(dry.exitCode, dry.stderr).toBe(0);
				const pairs = agentPairs(dry.stdout);
				expect(pairs.get("dry_run")).toBe("1");
				expect(pairs.get("would_unconfirm")).toBe("1");
				expect(dry.stdout).toContain("would label=doomed");
				expect(dry.stdout).toContain("missing_branch_ref=doomed");
				expect(readFileSync(fx.registryPath, "utf8")).toBe(before);
			} finally {
				fx.cleanup();
			}
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"a real prune marks the branch unconfirmed and SAYS it is waiting on the grace",
		async () => {
			const fx = makeRepo("mnemex-prune-real-");
			try {
				let run = await runLifecycleChild(fx.project, 1, 0, fx.scratch);
				expect(run.exitCode, run.stderr).toBe(0);
				fx.git(fx.project, "checkout", "-b", "doomed");
				writeSource(fx.project, "src/doomed.ts", 2, "doomed");
				fx.git(fx.project, "add", "-A");
				fx.git(fx.project, "commit", "-m", "doomed");
				run = await runLifecycleChild(fx.project, 1, 0, fx.scratch);
				expect(run.exitCode, run.stderr).toBe(0);
				fx.git(fx.project, "checkout", "main");
				fx.git(fx.project, "branch", "-D", "doomed");
				fx.git(fx.project, "pack-refs", "--all");

				const human = await humanRun(fx.project, ["prune"]);
				expect(human.code, human.stderr).toBe(0);
				// IMMEDIATE means "now rather than on the 20th index run". It does
				// NOT mean "skip the grace" — a mid-rebase instant is a real state.
				// A command that silently did nothing would be worse than useless,
				// so it says what it is waiting for.
				expect(human.stdout).toContain("marked unconfirmed");
				expect(human.stdout).toContain("tombstoned by a later prune");

				const file = JSON.parse(readFileSync(fx.registryPath, "utf8")) as {
					branches: Array<{
						label: string;
						unconfirmedSince: string | null;
						deletedAt: string | null;
					}>;
				};
				const doomed = file.branches.find((b) => b.label === "doomed");
				expect(doomed?.unconfirmedSince).not.toBeNull();
				expect(doomed?.deletedAt).toBeNull();
				// `main` is present in packed-refs, so it is untouched — the same
				// property V3.8 pins, through the manual command.
				expect(
					file.branches.find((b) => b.label === "main")?.unconfirmedSince,
				).toBeNull();
			} finally {
				fx.cleanup();
			}
		},
		TEST_TIMEOUT_MS,
	);
});
