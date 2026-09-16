/**
 * The lifecycle's `--agent` keys, and I-15's two small ones.
 *
 * ── WHY THESE ARE DATA AND NOT A PROGRESS LINE ─────────────────────────────
 * Two of the four entry points that call `index()` pass no `onProgress` at all
 * — the git post-commit hook and the MCP search tool's auto-reindex — so a
 * rendered notice reaches at most two of them. Anything a consumer has to act
 * on is a key.
 *
 * ── `branch_units_refreshed` IS I-14'S LIVE CHECK (I-15) ────────────────────
 * Since I-14 put the content hash into the code-unit id, a known id implies
 * known content, so the in-place refresh should never fire. Its expected value
 * is therefore 0 — and a counter that is only ever 0 is exactly the counter a
 * consumer needs, because a non-zero reading is a 64-bit id collision or a
 * crash between a refresh and the second transaction that registers its hash.
 * An internal counter cannot be read from a user's machine, which is the whole
 * reason it gets a key.
 *
 * `bun run build` is a precondition (CLAUDE.md #13).
 */

import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	BRANCH_CONFIRM_INTERVAL,
	BRANCH_SOFT_LIMIT,
} from "../../../src/core/branch-lifecycle.js";
import {
	MEMBERSHIP_INTEGRITY_REMEDY,
	MembershipIntegrityError,
} from "../../../src/core/branch-membership.js";
import { createGitSandbox } from "../../helpers/git-sandbox.js";
import {
	BM25_ONLY,
	runCli,
	runLifecycleChild,
	writeSource,
} from "../../helpers/v4-fixtures.js";

const TEST_TIMEOUT_MS = 300_000;

function pairs(stdout: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const line of stdout.split("\n")) {
		const eq = line.indexOf("=");
		if (eq > 0 && !line.includes(" "))
			out.set(line.slice(0, eq), line.slice(eq + 1));
	}
	return out;
}

describe("index --agent reports the branch lifecycle", () => {
	test(
		"every key is present on an ordinary run, including the zeros",
		async () => {
			const sandbox = createGitSandbox("mnemex-keys-");
			try {
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

				const run = await runCli(["--agent", "index"], scratch, project);
				expect(run.exitCode, run.stderr).toBe(0);
				const kv = pairs(run.stdout);

				// I-15's live check for I-14. Zero, and PRESENT: "0 was observed"
				// and "this build does not report it" must not look the same.
				expect(kv.get("branch_units_refreshed")).toBe("0");

				expect(kv.get("branch_count")).toBe("1");
				expect(Number(kv.get("branch_count"))).toBeLessThan(BRANCH_SOFT_LIMIT);
				expect(kv.get("branch_confirmation_ran")).toBe("0");
				expect(kv.get("branches_unconfirmed")).toBe("0");
				expect(kv.get("branches_tombstoned")).toBe("0");
				expect(kv.get("branch_sweep_rows_deleted")).toBe("0");
				expect(kv.get("branch_sweep_rows_narrowed")).toBe("0");
				expect(kv.get("branch_sweep_finalized")).toBe("0");
				expect(kv.get("branch_sweep_remaining")).toBe("0");
				// Absent until it happens, like every other "something went wrong"
				// key on this report.
				expect(run.stdout).not.toContain("branch_confirmation_deferred");
				expect(run.stdout).not.toContain("missing_branch_ref=");
			} finally {
				sandbox.cleanup();
			}
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"a vanished ref is REPORTED on the run whose confirmation pass sees it",
		async () => {
			const sandbox = createGitSandbox("mnemex-missing-ref-");
			try {
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

				// Run 1 on main, run 2 on the branch.
				let child = await runLifecycleChild(project, 1, 0, scratch);
				expect(child.exitCode, child.stderr).toBe(0);
				sandbox.git(project, "checkout", "-b", "doomed");
				writeSource(project, "src/b.ts", 2, "b");
				sandbox.git(project, "add", "-A");
				sandbox.git(project, "commit", "-m", "doomed");
				child = await runLifecycleChild(project, 1, 0, scratch);
				expect(child.exitCode, child.stderr).toBe(0);
				sandbox.git(project, "checkout", "main");
				sandbox.git(project, "branch", "-D", "doomed");

				// Land the OBSERVED run on the interval. The counter is at 2, so
				// `BRANCH_CONFIRM_INTERVAL - 3` more child runs put the CLI run at
				// exactly `BRANCH_CONFIRM_INTERVAL`.
				child = await runLifecycleChild(
					project,
					BRANCH_CONFIRM_INTERVAL - 3,
					0,
					scratch,
				);
				expect(child.exitCode, child.stderr).toBe(0);

				const run = await runCli(["--agent", "index"], scratch, project);
				expect(run.exitCode, run.stderr).toBe(0);
				const kv = pairs(run.stdout);
				expect(kv.get("branch_confirmation_ran")).toBe("1");
				// §4.3: "A ref vanishes mid-run — reported, never silently skipped."
				expect(run.stdout).toContain("missing_branch_ref=doomed");
				expect(kv.get("branches_unconfirmed")).toBe("1");
				// A tombstone is 24 h away, so nothing has been reclaimed yet.
				expect(kv.get("branches_tombstoned")).toBe("0");
				expect(kv.get("branch_sweep_rows_deleted")).toBe("0");
			} finally {
				sandbox.cleanup();
			}
		},
		TEST_TIMEOUT_MS,
	);
});

describe("MembershipIntegrityError names the remedy (I-15)", () => {
	test("the message says what to run, not only what disagreed", () => {
		const error = new MembershipIntegrityError(
			"widen",
			"the merge reported 3 updated rows; the read said 5",
		);
		// Aborting is right — I-7 says a mismatch is never ignored. But a store
		// that has genuinely diverged then cannot be indexed AT ALL, and the
		// counts alone leave the user to work out that `--force` is the way out.
		expect(error.message).toContain("the read said 5");
		expect(error.message).toContain("mnemex index --force");
		expect(error.message).toContain(MEMBERSHIP_INTEGRITY_REMEDY);
	});

	test("it does not advertise a flag this build does not have", () => {
		// `--force-all` is §4.5's, and §4.5 is not built. A remedy naming a flag
		// that does not exist is worse than no remedy: it sends the user to an
		// error message about an unknown option.
		expect(MEMBERSHIP_INTEGRITY_REMEDY).not.toContain("--force-all");
	});
});
