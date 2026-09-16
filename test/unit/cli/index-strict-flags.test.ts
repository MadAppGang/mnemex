/**
 * `mnemex index` has a strict flag table (decision I-17 item 4, CLAUDE.md #30).
 *
 * ── THE FAILURE MODE THIS CLOSES, WHICH IS NOT HYPOTHETICAL ─────────────────
 * A boolean flag parsed by `args.includes("--x")` makes every TYPO of it mean
 * the OPPOSITE of what was typed, silently. `mnemex keychain migrate
 * --dry-runDD` fell through a membership test to the DESTRUCTIVE default and
 * ran a real migration on the maintainer's own machine one day after that
 * feature shipped; `~/.zsh_history` and the created keychain items' `cdat`
 * agree to the second.
 *
 * `--force` / `--force-all` is the same parse and a worse shape: a destructive
 * PAIR sharing a prefix. Phase 3b-3b measured which way each typo falls and
 * pinned it — and reported (its finding 6) that both directions failing safe is
 * luck of spelling rather than construction. This file is the construction.
 *
 * ── WHAT IS ASSERTED, AND WHAT IS DELIBERATELY NOT ──────────────────────────
 * "Nothing was written", on ROWS through an independent connection, never an
 * exit code alone: the pre-fix `keychain migrate` exited 0 WHILE writing, so an
 * exit code is exactly the evidence that could not see the bug.
 *
 * The second half matters as much as the first. The table was DERIVED BY SEARCH
 * over `src/`, not from the help text, because three internal callers pass
 * flags `handleIndex` never parsed — `--quiet` (the MCP server, the MCP
 * reindexer and the post-tool-use hook), `--if-idle` (the reindexer) and
 * `--files <path>` (the editor's post-edit reindex). A table built from the
 * documented flags would have turned every background reindex in the product
 * into a failure on the day it shipped. Those three are pinned as ACCEPTED here
 * so that a later tidy-up which drops them fails loudly.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	getIndexDbPathFor,
	resolveStoreLocation,
} from "../../../src/core/store-location.js";
import { REINDEX_ARGS } from "../../../src/mcp/reindexer.js";
import { createGitSandbox } from "../../helpers/git-sandbox.js";
import { BM25_ONLY, runCli, writeSource } from "../../helpers/v4-fixtures.js";

const TEST_TIMEOUT_MS = 300_000;

const open: Array<() => void> = [];
afterEach(() => {
	for (const close of open.splice(0)) close();
});

interface Repo {
	project: string;
	scratch: string;
	indexDb: string;
}

/** One branch, indexed, so "nothing was written" has something to be true of. */
async function indexedRepo(prefix: string): Promise<Repo> {
	const sandbox = createGitSandbox(prefix);
	open.push(() => sandbox.cleanup());
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
	if (first.exitCode !== 0) throw new Error(`index: ${first.stderr}`);
	return {
		project,
		scratch,
		indexDb: getIndexDbPathFor(resolveStoreLocation(project)),
	};
}

/** Store-wide row counts, INDEPENDENT connection. */
function storeCounts(indexDb: string): Record<string, number> {
	const db = new Database(indexDb, { readonly: true });
	try {
		const one = (sql: string) => (db.query(sql).get() as { n: number }).n;
		return {
			files: one("SELECT COUNT(*) AS n FROM files"),
			symbols: one("SELECT COUNT(*) AS n FROM symbols"),
			membership: one("SELECT COUNT(*) AS n FROM chunk_branches"),
		};
	} finally {
		db.close();
	}
}

describe("an unrecognised dash-argument refuses BEFORE anything destructive", () => {
	// Both directions of the --force-all typo, which is the pair the decision
	// names. `--force-al` is the truncation, `--force-alll` the overshoot.
	for (const typo of ["--force-al", "--force-alll", "--forceall"]) {
		test(
			`${typo} refuses, names --force-all, and writes NOTHING`,
			async () => {
				const fx = await indexedRepo("mnemex-index-typo-");
				const before = storeCounts(fx.indexDb);
				expect(before.files).toBeGreaterThan(0);

				const refused = await runCli(
					["--agent", "index", typo],
					fx.scratch,
					fx.project,
				);

				expect(refused.exitCode).not.toBe(0);
				expect(refused.stderr).toContain("error=unknown_flag");
				expect(refused.stderr).toContain("command=index");
				expect(refused.stderr).toContain("Did you mean --force-all?");
				// THE assertion. An exit code cannot see the bug this prevents.
				expect(storeCounts(fx.indexDb)).toEqual(before);
				// And no run happened at all: no index summary was emitted.
				expect(refused.stdout).not.toContain("indexed_files=");
			},
			TEST_TIMEOUT_MS,
		);
	}

	test(
		"a flag from another command is refused with no near-miss claimed",
		async () => {
			const fx = await indexedRepo("mnemex-index-alien-");
			const before = storeCounts(fx.indexDb);
			const refused = await runCli(
				["--agent", "index", "--dry-run"],
				fx.scratch,
				fx.project,
			);
			expect(refused.exitCode).not.toBe(0);
			expect(refused.stderr).toContain("error=unknown_flag");
			// `--dry-run` is nobody's near miss here, so the tool must NOT invent
			// one — a wrong suggestion is worse than none on a destructive command.
			expect(refused.stderr).not.toContain("Did you mean");
			expect(storeCounts(fx.indexDb)).toEqual(before);
		},
		TEST_TIMEOUT_MS,
	);
});

describe("every flag an internal caller passes is ACCEPTED", () => {
	// Derived by search over src/, not from the help text. Each entry names the
	// caller, so a later change that drops one has to argue with that caller.
	const INTERNAL: ReadonlyArray<{ args: string[]; who: string }> = [
		{
			args: ["index", "--quiet"],
			who: "mcp/server.ts, hooks/post-tool-use.ts",
		},
		{ args: [...REINDEX_ARGS], who: "mcp/reindexer.ts REINDEX_ARGS" },
		{
			args: ["index", "--quiet", "--files", "src/a.ts"],
			who: "editor/editor.ts",
		},
	];

	for (const { args, who } of INTERNAL) {
		test(
			`${args.join(" ")} still runs (${who})`,
			async () => {
				const fx = await indexedRepo("mnemex-index-internal-");
				const run = await runCli(["--agent", ...args], fx.scratch, fx.project);
				// It must not be refused by the flag table. Exit 0 and no
				// unknown_flag line: a strict table that broke these would have
				// silently killed every background reindex in the product.
				expect(run.stderr).not.toContain("error=unknown_flag");
				expect(run.exitCode, run.stderr).toBe(0);
			},
			TEST_TIMEOUT_MS,
		);
	}

	test(
		"the documented flags and the =value forms are accepted",
		async () => {
			const fx = await indexedRepo("mnemex-index-documented-");
			for (const args of [
				["index", "--no-llm"],
				["index", "--concurrency=2"],
				["index", "--wait", "--wait-timeout=30"],
				["index", "-f"],
				["index", "--force-all"],
			]) {
				const run = await runCli(["--agent", ...args], fx.scratch, fx.project);
				expect(run.stderr, `${args.join(" ")}: ${run.stderr}`).not.toContain(
					"error=unknown_flag",
				);
				expect(run.exitCode, `${args.join(" ")}: ${run.stderr}`).toBe(0);
			}
		},
		TEST_TIMEOUT_MS,
	);
});
