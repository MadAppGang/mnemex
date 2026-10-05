/**
 * V3.19 (architecture §4.5 / D3, decision I-16) — `--force` narrows THIS
 * branch, `--force-all` rebuilds the store.
 *
 * ── THE DEFECT THIS FILE EXISTS FOR ─────────────────────────────────────────
 * `indexInternal`'s `if (force)` used to call `vectorStore.clear()` (a
 * `dropTable`) plus `fileTracker.clear()`. Neither takes a branch, so a store
 * holding several branches lost ALL of them to a `--force` on any ONE of them.
 * It was silent: the destroyed branches are still in `branches.json`, so
 * `graphBranchIdForRead()` resolves a real id and `branchUnknown` never fires.
 * The user switches back and gets an empty result with no signal.
 *
 * It needs no second worktree. One worktree that has indexed two branches
 * already holds both, which is why I-16 ordered this phase before 3c.
 *
 * ── HOW IT IS ASSERTED ──────────────────────────────────────────────────────
 * Every row count comes from an INDEPENDENT `lancedb.connect()`, every
 * membership and tree-scoped fact from an INDEPENDENT `better-sqlite3`
 * connection, and every registry fact from an independent parse of
 * `branches.json`'s bytes. Nothing here trusts a return value (CLAUDE.md #24).
 *
 * The runs go through the BUILT entry point, as a user types them, because the
 * flag parsing is part of the surface the defect lives on. `bun run build` is a
 * precondition (CLAUDE.md #13).
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

interface Fixture {
	project: string;
	scratch: string;
	indexDb: string;
	vectors: string;
	storeDir: string;
	git: (cwd: string, ...args: string[]) => string;
	cleanup: () => void;
}

/**
 * A repository with `main` and `feat` BOTH indexed into the one store.
 *
 * `src/shared.ts` exists on both branches (so its rows are held by both) and
 * `src/only-feat.ts` exists only on `feat` (so its rows are held by `feat`
 * alone). The two together are what tells a narrow apart from a wipe: a wipe
 * destroys both, a narrow leaves both.
 */
async function twoIndexedBranches(prefix: string): Promise<Fixture> {
	const sandbox = createGitSandbox(prefix);
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
	if (first.exitCode !== 0) {
		throw new Error(`index on main failed: ${first.stderr}`);
	}

	sandbox.git(project, "checkout", "-q", "-b", "feat");
	writeSource(project, "src/only-feat.ts", 4, "feat");
	sandbox.git(project, "add", "-A");
	sandbox.git(project, "commit", "-m", "feat only");
	const second = await runCli(["index"], scratch, project);
	if (second.exitCode !== 0) {
		throw new Error(`index on feat failed: ${second.stderr}`);
	}

	const loc = resolveStoreLocation(project);
	return {
		project,
		scratch,
		indexDb: getIndexDbPathFor(loc),
		vectors: getVectorStorePathFor(loc),
		storeDir: loc.storeDir,
		git: sandbox.git,
		cleanup: () => sandbox.cleanup(),
	};
}

function withIndexDb<T>(indexDb: string, fn: (db: Database) => T): T {
	const db = new Database(indexDb, { readonly: true });
	try {
		return fn(db);
	} finally {
		db.close();
	}
}

function countWhereBranch(
	indexDb: string,
	table: string,
	column: string,
	branchId: number,
): number {
	return withIndexDb(indexDb, (db) => {
		const row = db
			.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`)
			.get(branchId) as { n: number };
		return row.n;
	});
}

/** The SQLite half of one branch's state, as four independent counts. */
function sqliteCounts(
	indexDb: string,
	branchId: number,
): Record<string, number> {
	return {
		membership: countWhereBranch(
			indexDb,
			"chunk_branches",
			"branch_id",
			branchId,
		),
		files: countWhereBranch(indexDb, "files", "branch_id", branchId),
		symbols: countWhereBranch(indexDb, "symbols", "branch_id", branchId),
		symbol_references: countWhereBranch(
			indexDb,
			"symbol_references",
			"branch_id",
			branchId,
		),
	};
}

interface RegistryEntry {
	id: number;
	label: string;
	lastIndexedAt: string | null;
	deletedAt: string | null;
}

/** `branches.json` parsed from its BYTES, never through the registry module. */
function registryEntries(storeDir: string): RegistryEntry[] {
	const parsed = JSON.parse(
		readFileSync(join(storeDir, "branches.json"), "utf8"),
	) as { branches: RegistryEntry[] };
	return parsed.branches;
}

function entryFor(storeDir: string, label: string): RegistryEntry | undefined {
	return registryEntries(storeDir).find((b) => b.label === label);
}

/** LanceDB rows whose stored path contains `needle`, through a fresh connection. */
async function rowsFor(
	vectors: string,
	needle: string,
): Promise<Array<Record<string, unknown>>> {
	const rows = await storeRows(vectors);
	return rows.filter((r) => String(r.filePath).includes(needle));
}

describe("V3.19 — `mnemex index --force` narrows only the branch it runs on", () => {
	test(
		"a second branch's rows, files and symbols survive a --force on the first",
		async () => {
			const fx = await twoIndexedBranches("mnemex-force-scope-");
			try {
				const main = entryFor(fx.storeDir, "main");
				const feat = entryFor(fx.storeDir, "feat");
				expect(main?.id).toBe(1);
				expect(feat?.id).toBe(2);
				const featId = feat?.id ?? -1;

				const featBefore = sqliteCounts(fx.indexDb, featId);
				expect(featBefore.membership).toBeGreaterThan(0);
				expect(featBefore.files).toBeGreaterThan(0);
				expect(featBefore.symbols).toBeGreaterThan(0);
				const onlyFeatBefore = await rowsFor(fx.vectors, "only-feat");
				expect(onlyFeatBefore.length).toBeGreaterThan(0);
				const allRowsBefore = (await storeRows(fx.vectors)).length;

				// ── `--force` on main, exactly as a user types it ────────────────
				fx.git(fx.project, "checkout", "-q", "main");
				const forced = await runCli(
					["--agent", "index", "--force"],
					fx.scratch,
					fx.project,
				);
				expect(forced.exitCode, forced.stderr).toBe(0);
				// The MECHANISM, not only the outcome: this run narrowed ONE branch
				// and said so in data, and it narrowed rather than deleted the rows
				// `feat` shares with it.
				expect(forced.stdout).toContain("force_scope=branch");
				expect(forced.stdout).toMatch(/force_rows_narrowed=[1-9]/);

				// THE ASSERTION THIS FILE EXISTS FOR. Before the fix these are all 0:
				// `vectorStore.clear()` dropped the table and `fileTracker.clear()`
				// emptied `files` and all three membership tables, for every branch.
				const featAfter = sqliteCounts(fx.indexDb, featId);
				expect(featAfter).toEqual(featBefore);

				const onlyFeatAfter = await rowsFor(fx.vectors, "only-feat");
				expect(onlyFeatAfter.length).toBe(onlyFeatBefore.length);
				// Every one of them still names `feat` in its mirror, and `main` —
				// which does not have the file — is not in it.
				for (const row of onlyFeatAfter) {
					expect(String(row.branchIds)).toContain(`,${featId},`);
				}
				expect(new Set(onlyFeatAfter.map((r) => String(r.id)))).toEqual(
					new Set(onlyFeatBefore.map((r) => String(r.id))),
				);

				// The shared file is held by both again: narrowed to `,2,` by the
				// force and widened back to `,1,2,` by the run that followed it.
				const sharedAfter = await rowsFor(fx.vectors, "shared");
				expect(sharedAfter.length).toBeGreaterThan(0);
				for (const row of sharedAfter) {
					expect(String(row.branchIds)).toBe(",1,2,");
				}
				// Nothing was duplicated by the rebuild.
				expect((await storeRows(fx.vectors)).length).toBe(allRowsBefore);

				// §4.5: the registry entry SURVIVES with the SAME id — `--force` is
				// not the tombstone path, and an id change would orphan every
				// `chunk_branches` row written before it.
				expect(entryFor(fx.storeDir, "feat")?.id).toBe(featId);
				expect(entryFor(fx.storeDir, "feat")?.deletedAt).toBeNull();
				const mainAfter = entryFor(fx.storeDir, "main");
				expect(mainAfter?.id).toBe(1);
				// W-R6 cleared `lastIndexedAt`; the run that followed re-stamped it.
				expect(mainAfter?.lastIndexedAt).not.toBeNull();
				expect(
					Date.parse(mainAfter?.lastIndexedAt ?? ""),
				).toBeGreaterThanOrEqual(Date.parse(main?.lastIndexedAt ?? ""));
			} finally {
				fx.cleanup();
			}
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"--force-all empties the whole store, every branch",
		async () => {
			const fx = await twoIndexedBranches("mnemex-force-all-");
			try {
				const featId = entryFor(fx.storeDir, "feat")?.id ?? -1;
				expect(sqliteCounts(fx.indexDb, featId).membership).toBeGreaterThan(0);

				fx.git(fx.project, "checkout", "-q", "main");
				const forced = await runCli(
					["--agent", "index", "--force-all"],
					fx.scratch,
					fx.project,
				);
				expect(forced.exitCode, forced.stderr).toBe(0);
				expect(forced.stdout).toContain("force_scope=store");
				expect(forced.stdout).not.toContain("force_rows_narrowed=");

				// Everything `feat` held is gone: this is the deliberate whole-store
				// rebuild, and it is what the old `--force` did to everyone.
				const featAfter = sqliteCounts(fx.indexDb, featId);
				expect(featAfter.membership).toBe(0);
				expect(featAfter.files).toBe(0);
				expect(featAfter.symbols).toBe(0);
				expect((await rowsFor(fx.vectors, "only-feat")).length).toBe(0);

				// The registry is NOT the store: `feat` keeps its entry and its id,
				// so the next index on it resolves the same id (and, per the
				// emptiness signal, says the branch holds no rows until then).
				expect(entryFor(fx.storeDir, "feat")?.id).toBe(featId);
			} finally {
				fx.cleanup();
			}
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"in a store with NO git layout, --force still rebuilds everything",
		async () => {
			// There is no branch to narrow: every row of such a store carries the
			// shared marker (§3.2.1), so "this branch" and "the whole store" are
			// the same set of rows and `--force` keeps its whole-store `clear()`.
			// Driven because it is the path every non-git user takes, and the
			// branch-scoped force is chosen by a condition that could exclude it.
			const sandbox = createGitSandbox("mnemex-force-nogit-");
			try {
				const project = join(sandbox.root, "plain");
				mkdirSync(project);
				writeFileSync(
					join(project, "mnemex.json"),
					`${JSON.stringify(BM25_ONLY, null, 2)}\n`,
				);
				writeSource(project, "src/a.ts", 3, "a");
				const scratch = join(sandbox.root, "scratch");
				const vectors = join(project, ".mnemex", "vectors");

				const first = await runCli(["index"], scratch, project);
				expect(first.exitCode, first.stderr).toBe(0);
				const before = (await storeRows(vectors)).length;
				expect(before).toBeGreaterThan(0);
				// No registry file at all, which is what makes this the other path.
				expect(existsSync(join(project, ".mnemex", "branches.json"))).toBe(
					false,
				);

				const forced = await runCli(
					["--agent", "index", "--force"],
					scratch,
					project,
				);
				expect(forced.exitCode, forced.stderr).toBe(0);
				expect(forced.stdout).toContain("force_scope=store");
				expect((await storeRows(vectors)).length).toBe(before);
			} finally {
				sandbox.cleanup();
			}
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"a MISSPELT --force-all writes nothing and forces nothing (CLAUDE.md #30)",
		async () => {
			const fx = await twoIndexedBranches("mnemex-force-typo-");
			try {
				const featId = entryFor(fx.storeDir, "feat")?.id ?? -1;
				const featBefore = sqliteCounts(fx.indexDb, featId);
				const allBefore = (await storeRows(fx.vectors)).length;

				fx.git(fx.project, "checkout", "-q", "main");
				// ── INVERTED IN PHASE 3c, deliberately ───────────────────────
				//
				// As written in 3b-3b this asserted `exitCode === 0`: neither
				// spelling matched either flag, so the run was an ordinary
				// incremental index that emptied nothing. 3b-3b's own decision 7
				// and finding 6 said exactly what was wrong with that — both typo
				// directions failed safe by LUCK OF SPELLING rather than by
				// construction, and "which way does the default point" is not a
				// property anyone should be relying on for a destructive pair.
				//
				// Decision I-17 item 4 gave `index` the same `ACCEPTED_FLAGS`
				// treatment `mnemex keychain` has. A typo is now an ERROR
				// before anything runs, and the near miss is named. The
				// "writes nothing" assertions below are UNCHANGED and are still
				// the ones that matter: the pre-fix `keychain migrate` exited 0
				// while writing, so an exit code alone never could have seen it.
				for (const typo of ["--force-alll", "--force-al"]) {
					const run = await runCli(
						["--agent", "index", typo],
						fx.scratch,
						fx.project,
					);
					expect(run.exitCode, `${typo}: ${run.stderr}`).not.toBe(0);
					expect(run.stderr, typo).toContain("error=unknown_flag");
					expect(run.stderr, typo).toContain("Did you mean --force-all?");
					expect(run.stdout, typo).not.toContain("force_scope=");
				}

				expect(sqliteCounts(fx.indexDb, featId)).toEqual(featBefore);
				expect((await storeRows(fx.vectors)).length).toBe(allBefore);
			} finally {
				fx.cleanup();
			}
		},
		TEST_TIMEOUT_MS,
	);
});
