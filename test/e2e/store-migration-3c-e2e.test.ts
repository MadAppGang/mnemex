/**
 * V4 — THE MIGRATION USERS ACTUALLY FEEL: a real store, in the pre-3c place,
 * moving to the shared one on the next `mnemex index`.
 *
 * This is the half V4.1 and V4.8 could not assert before the flip, and 3a-2
 * deferred here for that reason: `abandoned_store_dir` is set only when the
 * probed directory DIFFERS from `storeDir` (§6.1), and until 3c they were the
 * same directory for every user. The upgrade fixtures that existed planted a
 * v3 schema in the directory the run was about to use, which is a state that
 * never occurs in production.
 *
 * ── THE TWO CLAIMS ──────────────────────────────────────────────────────────
 *   1. A REAL store moves. Not a hand-planted fixture: the store is built by a
 *      real `mnemex index` run at the OLD location (via `ProjectConfig.indexDir`
 *      pointing at `<project>/.mnemex`, which is byte-for-byte where a pre-3c
 *      build put it), then the override is removed and the next run migrates.
 *   2. The OLD store is LEFT WHERE IT WAS. Not moved, not merged, not deleted
 *      (§6.1) — asserted on the BYTES of the old `index.db`, which must be
 *      unchanged, and on the old vectors table, which must still hold its rows.
 *      §6.2 proves an N-worktrees-to-1 rename of non-portable rows has no
 *      correct form, so leaving it is the design, and a user who is not told
 *      would find a directory nothing cleans up.
 *
 * ── WHY THE OVERRIDE IS THE RIGHT WAY TO BUILD "THE OLD PLACE" ──────────────
 * The alternative is to flip `STORE_SCOPE_DEFAULT` from a test, and there is
 * deliberately no setter for it (CLAUDE.md #24: a test seam able to write a
 * production default was a bypass once already). `ProjectConfig.indexDir` set
 * to an ABSOLUTE `<project>/.mnemex` produces the identical directory by a
 * supported route. The literal `".mnemex"` would NOT work — D2 treats it as
 * unset — which is itself pinned below, because it is how the same user's
 * config behaves after the flip.
 *
 * `bun run build` is a precondition (CLAUDE.md #13). Every child's env comes
 * from `sandboxEnv`.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createGitSandbox } from "../helpers/git-sandbox.js";
import {
	BM25_ONLY,
	mainCheckoutStoreDir,
	runCli,
	storeRows,
	writeSource,
} from "../helpers/v4-fixtures.js";

const TEST_TIMEOUT_MS = 300_000;

const open: Array<() => void> = [];
afterEach(() => {
	for (const close of open.splice(0)) close();
});

interface Migrating {
	project: string;
	scratch: string;
	/** `<project>/.mnemex` — byte-for-byte where a pre-3c build put the store. */
	oldStore: string;
	/** `<project>/.git/mnemex` — where 3c puts it. */
	newStore: string;
}

function agentValue(stdout: string, key: string): string | null {
	const line = stdout.split("\n").find((l) => l.startsWith(`${key}=`));
	return line === undefined ? null : line.slice(key.length + 1);
}

function sha256(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function fileCount(indexDb: string): number {
	const db = new Database(indexDb, { readonly: true });
	try {
		return (db.query("SELECT COUNT(*) AS n FROM files").get() as { n: number })
			.n;
	} finally {
		db.close();
	}
}

/** A repository whose store was built, for real, at the PRE-3c location. */
async function storeAtOldLocation(prefix: string): Promise<Migrating> {
	const sandbox = createGitSandbox(prefix);
	open.push(() => sandbox.cleanup());
	const project = join(sandbox.root, "repo");
	const scratch = join(sandbox.root, "scratch");
	sandbox.git(sandbox.root, "init", "repo");
	const oldStore = join(project, ".mnemex");

	// An ABSOLUTE indexDir naming the pre-3c directory. Row 2, a supported
	// route, producing the exact bytes a pre-3c build would have left.
	writeFileSync(
		join(project, "mnemex.json"),
		`${JSON.stringify({ ...BM25_ONLY, indexDir: oldStore }, null, 2)}\n`,
	);
	writeSource(project, "src/alpha.ts", 4, "alpha");
	writeSource(project, "src/beta.ts", 3, "beta");
	sandbox.git(project, "add", "-A");
	sandbox.git(project, "commit", "-m", "initial");

	const built = await runCli(["--agent", "index"], scratch, project);
	if (built.exitCode !== 0) throw new Error(`seed index: ${built.stderr}`);
	if (agentValue(built.stdout, "store_dir") !== oldStore) {
		throw new Error(
			`seed did not land at the old location: ${agentValue(built.stdout, "store_dir")}`,
		);
	}
	return {
		project,
		scratch,
		oldStore,
		newStore: mainCheckoutStoreDir(project),
	};
}

describe("V4 — a real store moves, and the old one is left where it was", () => {
	test(
		"the next index migrates, reports abandoned_store_dir, and does not touch the old bytes",
		async () => {
			const fx = await storeAtOldLocation("mnemex-migrate-");

			// The old store, as it really is before the migration.
			const oldDb = join(fx.oldStore, "index.db");
			expect(existsSync(oldDb)).toBe(true);
			const oldFiles = fileCount(oldDb);
			const oldRows = await storeRows(join(fx.oldStore, "vectors"));
			const oldDbHash = sha256(oldDb);
			expect(oldFiles).toBeGreaterThan(0);
			expect(oldRows.length).toBeGreaterThan(0);
			expect(existsSync(fx.newStore)).toBe(false);

			// Remove the override. Nothing else changes; this is the shape of a
			// user upgrading to the build that flipped the constant.
			writeFileSync(
				join(fx.project, "mnemex.json"),
				`${JSON.stringify(BM25_ONLY, null, 2)}\n`,
			);

			const migrated = await runCli(
				["--agent", "index"],
				fx.scratch,
				fx.project,
			);
			expect(migrated.exitCode, migrated.stderr).toBe(0);

			// CLAIM 1 — it moved, and it SAYS so, in the data channel. §6.3 puts
			// this in data precisely because two of the four entry points that
			// call index() render no progress at all.
			expect(agentValue(migrated.stdout, "store_dir")).toBe(fx.newStore);
			expect(agentValue(migrated.stdout, "store_kind")).toBe("git-common-dir");
			expect(agentValue(migrated.stdout, "abandoned_store_dir")).toBe(
				fx.oldStore,
			);
			// It is a real store at the new location, not an empty directory.
			expect(fileCount(join(fx.newStore, "index.db"))).toBe(oldFiles);
			expect(
				(await storeRows(join(fx.newStore, "vectors"))).length,
			).toBeGreaterThan(0);

			// CLAIM 2 — THE OLD STORE IS STILL THERE, BYTE FOR BYTE. Asserted on a
			// sha256 of the file, not on `existsSync`: "not deleted" is the weak
			// half; "not modified" is what makes it a store the user could still
			// open, and what rules out a migration that drained it in place.
			expect(existsSync(oldDb)).toBe(true);
			expect(sha256(oldDb)).toBe(oldDbHash);
			expect(fileCount(oldDb)).toBe(oldFiles);
			const oldAfter = await storeRows(join(fx.oldStore, "vectors"));
			expect(oldAfter.length).toBe(oldRows.length);
			expect(oldAfter.map((r) => String(r.id)).sort()).toEqual(
				oldRows.map((r) => String(r.id)).sort(),
			);

			// A SECOND run reports neither field: the migration happened once.
			const again = await runCli(["--agent", "index"], fx.scratch, fx.project);
			expect(again.exitCode, again.stderr).toBe(0);
			expect(again.stdout).not.toContain("abandoned_store_dir=");
			expect(again.stdout).not.toContain("upgraded_from_index_version=");
			expect(agentValue(again.stdout, "store_dir")).toBe(fx.newStore);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"the migration costs ZERO embedding requests — and a search from the new store works",
		async () => {
			// The fixture is BM25-only, so "zero embedding requests" is trivially
			// true here and the external-counter version of that claim lives in
			// `index-v4-paths-e2e.test.ts` (V4.3). What this asserts instead is the
			// property a user checks first: after the move, search still answers.
			const fx = await storeAtOldLocation("mnemex-migrate-search-");
			writeFileSync(
				join(fx.project, "mnemex.json"),
				`${JSON.stringify(BM25_ONLY, null, 2)}\n`,
			);
			const migrated = await runCli(
				["--agent", "index"],
				fx.scratch,
				fx.project,
			);
			expect(migrated.exitCode, migrated.stderr).toBe(0);

			const found = await runCli(
				["--agent", "search", "--no-reindex", "-k", "src_alpha_ts"],
				fx.scratch,
				fx.project,
			);
			expect(found.exitCode, found.stderr).toBe(0);
			const hits = found.stdout
				.split("\n")
				.filter((l) => l.startsWith("result file="));
			expect(hits.length).toBeGreaterThan(0);
			// Absolute, on disk, rehydrated against this worktree (V1.6).
			const path = hits[0].slice("result file=".length).split(" ")[0];
			expect(path.startsWith(fx.project)).toBe(true);
			expect(existsSync(path)).toBe(true);
			// And the branch is NOT reported empty: the rows came across.
			expect(found.stdout).toContain("branch_empty=0");
		},
		TEST_TIMEOUT_MS,
	);

	test(
		'D2: indexDir ".mnemex" is ignored, so that user migrates too, and is told',
		async () => {
			// The case D2 exists for, end to end. A user who copied the DOCUMENTED
			// default into `mnemex.json` almost certainly recorded a default rather
			// than an intent to pin storage per worktree, so the literal is treated
			// as unset — and `ignored_legacy_index_dir=1` is how they can find out
			// why their store moved anyway.
			const sandbox = createGitSandbox("mnemex-migrate-d2-");
			open.push(() => sandbox.cleanup());
			const project = join(sandbox.root, "repo");
			const scratch = join(sandbox.root, "scratch");
			sandbox.git(sandbox.root, "init", "repo");
			writeFileSync(
				join(project, "mnemex.json"),
				`${JSON.stringify({ ...BM25_ONLY, indexDir: ".mnemex" }, null, 2)}\n`,
			);
			writeSource(project, "src/alpha.ts", 3, "alpha");
			sandbox.git(project, "add", "-A");
			sandbox.git(project, "commit", "-m", "initial");

			const run = await runCli(["--agent", "index"], scratch, project);
			expect(run.exitCode, run.stderr).toBe(0);
			expect(agentValue(run.stdout, "store_dir")).toBe(
				mainCheckoutStoreDir(project),
			);
			expect(agentValue(run.stdout, "store_kind")).toBe("git-common-dir");
			expect(run.stdout).toContain("ignored_legacy_index_dir=1");
			// The escape hatch still works: ANY other value is honoured.
			const pinned = join(sandbox.root, "pinned-store");
			writeFileSync(
				join(project, "mnemex.json"),
				`${JSON.stringify({ ...BM25_ONLY, indexDir: pinned }, null, 2)}\n`,
			);
			const honoured = await runCli(["--agent", "index"], scratch, project);
			expect(honoured.exitCode, honoured.stderr).toBe(0);
			expect(agentValue(honoured.stdout, "store_dir")).toBe(pinned);
			expect(honoured.stdout).not.toContain("ignored_legacy_index_dir=");
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"a repository indexed FRESH on this build reports no migration at all",
		async () => {
			// V4.6, at the new default: `abandoned_store_dir` and
			// `upgraded_from_index_version` must both be ABSENT on a first index,
			// not `1`. §6.1's false positive — `getIndexVersion` returning 1 when
			// the config is missing — would make every clone's first run claim an
			// upgrade for ever.
			const sandbox = createGitSandbox("mnemex-migrate-fresh-");
			open.push(() => sandbox.cleanup());
			const project = join(sandbox.root, "repo");
			const scratch = join(sandbox.root, "scratch");
			sandbox.git(sandbox.root, "init", "repo");
			writeFileSync(
				join(project, "mnemex.json"),
				`${JSON.stringify(BM25_ONLY, null, 2)}\n`,
			);
			writeSource(project, "src/alpha.ts", 3, "alpha");
			sandbox.git(project, "add", "-A");
			sandbox.git(project, "commit", "-m", "initial");
			// No `.mnemex` anywhere: nothing to migrate FROM.
			expect(existsSync(join(project, ".mnemex"))).toBe(false);

			const run = await runCli(["--agent", "index"], scratch, project);
			expect(run.exitCode, run.stderr).toBe(0);
			expect(run.stdout).not.toContain("abandoned_store_dir=");
			expect(run.stdout).not.toContain("upgraded_from_index_version=");
			expect(agentValue(run.stdout, "store_dir")).toBe(
				mainCheckoutStoreDir(project),
			);
			// And the pre-3c directory was not created as a side effect.
			expect(existsSync(join(project, ".mnemex", "index.db"))).toBe(false);
		},
		TEST_TIMEOUT_MS,
	);
});
