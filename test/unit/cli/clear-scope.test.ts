/**
 * `mnemex clear` — the fourth precondition for Phase 3c
 * (`briefs/phase-3b-inputs.md` §10, decision I-17 item 1).
 *
 * ── WHAT THIS COMMAND WAS, AND WHY IT GATED THE FLIP ────────────────────────
 * Four lines, one caller, ZERO tests:
 *
 *     await this.initialize();
 *     await this.vectorStore!.clear();   // dropTable — every branch
 *     this.fileTracker!.clear();         // DELETE FROM — seven tables
 *
 * No store lock, whole-store scope, and `FileTracker.clear()` does not include
 * `symbols`, `symbol_references` or `graph_metadata`. On a per-worktree store
 * each of those is a local mistake. The moment `STORE_SCOPE_DEFAULT` flips it
 * is an UNLOCKED, whole-store destructive command against a store another
 * worktree may be indexing — the exact hazard FR-2 exists to prevent, reached
 * through a command no phase had scoped.
 *
 * ── THE FOUR PROPERTIES, EACH ASSERTED ON ROWS ──────────────────────────────
 * Through INDEPENDENT connections — a second `lancedb.connect()` and a second
 * SQLite `Database` — never through the indexer that did the work and never
 * through a report object. Every claim of this class in this build that was
 * asserted on a report turned out to be invisible to it.
 *
 *   1. SCOPE: `clear` leaves the other branch's rows, `files` and `symbols`.
 *   2. `--all` empties everything, INCLUDING the symbol graph, which the old
 *      whole-store path did not.
 *   3. THE LOCK: a held store lock makes `clear` refuse and change nothing.
 *   4. STRICT FLAGS: a mistyped flag refuses and writes nothing (CLAUDE.md #30).
 *
 * `bun run build` is a precondition (CLAUDE.md #13). Every child gets its
 * environment from `sandboxEnv`, which is `keychainSafeChildEnv()` with HOME,
 * MNEMEX_EMBED_CACHE_PATH and MNEMEX_GLOBAL_LOCK_PATH inside the scratch tree.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	getIndexDbPathFor,
	getVectorStorePathFor,
	resolveStoreLocation,
} from "../../../src/core/store-location.js";
import { createGitSandbox } from "../../helpers/git-sandbox.js";
import {
	BM25_ONLY,
	runCli,
	storeRows,
	writeSource,
} from "../../helpers/v4-fixtures.js";

const TEST_TIMEOUT_MS = 300_000;

interface Repo {
	project: string;
	scratch: string;
	indexDb: string;
	vectorsDir: string;
	git: (cwd: string, ...args: string[]) => string;
	cleanup: () => void;
}

const open: Array<() => void> = [];
afterEach(() => {
	for (const close of open.splice(0)) close();
});

/** `main` and `feat` both indexed into ONE store, `feat` checked out. */
async function twoIndexedBranches(prefix: string): Promise<Repo> {
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
	writeSource(project, "src/shared.ts", 3, "shared");
	sandbox.git(project, "add", "-A");
	sandbox.git(project, "commit", "-m", "initial");
	const first = await runCli(["index"], scratch, project);
	if (first.exitCode !== 0) throw new Error(`index on main: ${first.stderr}`);

	sandbox.git(project, "checkout", "-q", "-b", "feat");
	writeSource(project, "src/only-feat.ts", 3, "feat");
	sandbox.git(project, "add", "-A");
	sandbox.git(project, "commit", "-m", "feat");
	const second = await runCli(["index"], scratch, project);
	if (second.exitCode !== 0) throw new Error(`index on feat: ${second.stderr}`);

	const loc = resolveStoreLocation(project);
	return {
		project,
		scratch,
		indexDb: getIndexDbPathFor(loc),
		vectorsDir: getVectorStorePathFor(loc),
		git: sandbox.git,
		cleanup: () => sandbox.cleanup(),
	};
}

/** Tree-scoped and membership counts for ONE branch id, INDEPENDENT connection. */
function countsFor(
	indexDb: string,
	branchId: number,
): { files: number; symbols: number; membership: number } {
	const db = new Database(indexDb, { readonly: true });
	try {
		const one = (sql: string): number =>
			(db.query(sql).get(branchId) as { n: number }).n;
		return {
			files: one("SELECT COUNT(*) AS n FROM files WHERE branch_id = ?"),
			symbols: one("SELECT COUNT(*) AS n FROM symbols WHERE branch_id = ?"),
			membership: one(
				"SELECT COUNT(*) AS n FROM chunk_branches WHERE branch_id = ?",
			),
		};
	} finally {
		db.close();
	}
}

/** The registry's id for a label, by an INDEPENDENT parse of `branches.json`. */
function branchIdOf(storeDir: string, label: string): number {
	const raw = JSON.parse(
		require("node:fs").readFileSync(join(storeDir, "branches.json"), "utf8"),
	) as { branches: Array<{ id: number; label: string; deletedAt?: unknown }> };
	const entry = raw.branches.find((b) => b.label === label);
	if (entry === undefined) throw new Error(`no registry entry for ${label}`);
	return entry.id;
}

describe("mnemex clear is branch-scoped by default (decision I-17 item 1)", () => {
	test(
		"clear on feat leaves main's rows, files and symbols untouched",
		async () => {
			const fx = await twoIndexedBranches("mnemex-clear-scope-");
			const storeDir = resolveStoreLocation(fx.project).storeDir;
			const mainId = branchIdOf(storeDir, "main");
			const featId = branchIdOf(storeDir, "feat");

			const mainBefore = countsFor(fx.indexDb, mainId);
			const featBefore = countsFor(fx.indexDb, featId);
			const rowsBefore = await storeRows(fx.vectorsDir);
			// The fixture is only meaningful if BOTH branches actually hold rows.
			expect(mainBefore.files).toBeGreaterThan(0);
			expect(featBefore.files).toBeGreaterThan(0);
			expect(featBefore.membership).toBeGreaterThan(0);

			const cleared = await runCli(
				["--agent", "clear", "--force"],
				fx.scratch,
				fx.project,
			);
			expect(cleared.exitCode, cleared.stderr).toBe(0);
			expect(cleared.stdout).toContain("clear_scope=branch");
			expect(cleared.stdout).toContain("branch=feat");

			// THE PROPERTY, on rows through independent connections.
			expect(countsFor(fx.indexDb, mainId)).toEqual(mainBefore);
			expect(countsFor(fx.indexDb, featId)).toEqual({
				files: 0,
				symbols: 0,
				membership: 0,
			});

			// Rows `main` still holds survive; rows only `feat` held are gone.
			const rowsAfter = await storeRows(fx.vectorsDir);
			expect(rowsAfter.length).toBeGreaterThan(0);
			expect(rowsAfter.length).toBeLessThan(rowsBefore.length);
			for (const row of rowsAfter) {
				expect(String(row.branchIds)).not.toContain(`,${featId},`);
			}

			// The registry entry SURVIVES with its id — the same rule V3.19 pins
			// for `--force`. A `clear` that reallocated the id would orphan every
			// cached memo that named it.
			expect(branchIdOf(storeDir, "feat")).toBe(featId);
			expect(branchIdOf(storeDir, "main")).toBe(mainId);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"a cleared branch then reports branch_empty, not branch_unknown",
		async () => {
			const fx = await twoIndexedBranches("mnemex-clear-empty-");
			const before = await runCli(
				["--agent", "search", "shared"],
				fx.scratch,
				fx.project,
			);
			expect(before.exitCode, before.stderr).toBe(0);
			expect(before.stdout).toContain("branch_empty=0");

			await runCli(["--agent", "clear", "--force"], fx.scratch, fx.project);

			// The registry still knows `feat`, so this is NOT `branch_unknown`.
			const after = await runCli(
				["--agent", "search", "shared"],
				fx.scratch,
				fx.project,
			);
			expect(after.exitCode, after.stderr).toBe(0);
			expect(after.stdout).toContain("branch_unknown=0");
			expect(after.stdout).toContain("branch_empty=1");
			expect(after.stdout).toContain("branch_hint=");
			expect(after.stdout).toContain("result_count=0");
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"clear --all empties every branch, symbol graph INCLUDED, and stamps storeRebuildAt",
		async () => {
			const fx = await twoIndexedBranches("mnemex-clear-all-");
			const storeDir = resolveStoreLocation(fx.project).storeDir;
			const mainId = branchIdOf(storeDir, "main");
			const featId = branchIdOf(storeDir, "feat");
			expect(countsFor(fx.indexDb, mainId).symbols).toBeGreaterThan(0);

			const cleared = await runCli(
				["--agent", "clear", "--all", "--force"],
				fx.scratch,
				fx.project,
			);
			expect(cleared.exitCode, cleared.stderr).toBe(0);
			expect(cleared.stdout).toContain("clear_scope=store");

			// `symbols` is the count the OLD whole-store path left behind
			// (3b-3b's finding 2): `FileTracker.clear()`'s DELETE FROM pass does
			// not include it, so a sibling branch kept a symbol graph whose chunks
			// were gone and `map` answered from rows `search` could not see.
			const empty = { files: 0, symbols: 0, membership: 0 };
			expect(countsFor(fx.indexDb, mainId)).toEqual(empty);
			expect(countsFor(fx.indexDb, featId)).toEqual(empty);
			expect(await storeRows(fx.vectorsDir)).toEqual([]);

			// V1.7's marker, on the BYTES of store.json.
			const meta = JSON.parse(
				require("node:fs").readFileSync(join(storeDir, "store.json"), "utf8"),
			) as Record<string, unknown>;
			expect(typeof meta.storeRebuildAt).toBe("string");
			expect(Date.parse(meta.storeRebuildAt as string)).toBeGreaterThan(0);
		},
		TEST_TIMEOUT_MS,
	);
});

describe("mnemex clear takes the store lock, and fails CLOSED", () => {
	test(
		"a held store lock makes clear refuse and change NOTHING",
		async () => {
			const fx = await twoIndexedBranches("mnemex-clear-lock-");
			const storeDir = resolveStoreLocation(fx.project).storeDir;
			const featId = branchIdOf(storeDir, "feat");
			const before = countsFor(fx.indexDb, featId);
			expect(before.membership).toBeGreaterThan(0);

			// Plant a live lock file the way `IndexLock` writes one: an O_EXCL
			// create whose holder pid is THIS process, which is alive, so the
			// stale-reclaim rules cannot take it.
			const lockPath = join(storeDir, ".indexing.lock");
			expect(existsSync(lockPath)).toBe(false);
			writeFileSync(
				lockPath,
				`${JSON.stringify({
					pid: process.pid,
					token: "clear-test",
					startedAt: new Date().toISOString(),
					heartbeat: Date.now(),
					lastProgressAt: Date.now(),
					phase: "embedding",
				})}\n`,
				{ flag: "wx" },
			);
			try {
				const refused = await runCli(
					["--agent", "clear", "--force"],
					fx.scratch,
					fx.project,
				);
				// NON-ZERO, and — the assertion that matters — the rows are intact.
				// Before this phase `clear` took no lock, so there was nothing to
				// refuse: it ran straight through a concurrent index run.
				expect(refused.exitCode).not.toBe(0);
				expect(countsFor(fx.indexDb, featId)).toEqual(before);
				expect(refused.stdout).not.toContain("cleared=1");
			} finally {
				require("node:fs").rmSync(lockPath, { force: true });
			}
		},
		TEST_TIMEOUT_MS,
	);
});

describe("mnemex clear has a strict flag table (CLAUDE.md #30)", () => {
	test(
		"a mistyped --all refuses, names the near miss, and writes NOTHING",
		async () => {
			const fx = await twoIndexedBranches("mnemex-clear-typo-");
			const storeDir = resolveStoreLocation(fx.project).storeDir;
			const mainId = branchIdOf(storeDir, "main");
			const featId = branchIdOf(storeDir, "feat");
			const mainBefore = countsFor(fx.indexDb, mainId);
			const featBefore = countsFor(fx.indexDb, featId);

			// `--alll` is the shape that cost real data on `keychain migrate`: a
			// membership test does not match it, so it used to fall through to the
			// command's default. `clear`'s default is DESTRUCTIVE, so falling
			// through means a branch-scoped clear the user did not ask for.
			const refused = await runCli(
				["--agent", "clear", "--alll", "--force"],
				fx.scratch,
				fx.project,
			);
			expect(refused.exitCode).not.toBe(0);
			expect(refused.stderr).toContain("error=unknown_flag");
			expect(refused.stderr).toContain("Did you mean --all?");

			// THE ASSERTION THAT MATTERS: not the exit code, which the pre-fix
			// `keychain migrate` also got right while it wrote. Nothing moved.
			expect(countsFor(fx.indexDb, mainId)).toEqual(mainBefore);
			expect(countsFor(fx.indexDb, featId)).toEqual(featBefore);
		},
		TEST_TIMEOUT_MS,
	);
});
