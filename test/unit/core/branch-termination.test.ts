/**
 * V3.8 — branch deletion TERMINATES without a human, in a repository whose refs
 * are PACKED (architecture §4.3, G2).
 *
 * ── WHAT G2 IS ──────────────────────────────────────────────────────────────
 * Revision 0's only automatic trigger was
 * `existsSync(<commonDir>/refs/heads/<label>)`. `gc` and `pack-refs` move loose
 * refs into `packed-refs` routinely, so in a packed repository that probe misses
 * EVERY branch — the live ones as well as the deleted one. Revision 0 answered a
 * miss by marking the entry `unconfirmed` and doing nothing else, so nothing was
 * ever tombstoned and the sweep had no work list: FR-5's "does it terminate" was
 * no. Reading `packed-refs` too is what makes it yes.
 *
 * ── THE ARGUMENT IS NOT RESTATED HERE; IT IS EXECUTED ───────────────────────
 * A real git repository, a real branch, `git pack-refs --all` so no loose ref
 * survives, real `mnemex index` runs in a sandboxed child, and an injected clock
 * to cross `BRANCH_DELETE_GRACE_MS`. Every assertion reads the STORE — an
 * independent JSON parse of `branches.json`'s bytes, an independent
 * `better-sqlite3` connection, an independent `lancedb.connect()`. Nothing
 * trusts a report object (CLAUDE.md #24).
 *
 * ── THE DESIGN'S STATED FALSIFIER DOES NOT FIRE, AND A STRONGER ONE DOES ────
 * §4.3 says reverting to `existsSync`-only detection is "falsified by
 * checkpoint 1 never reaching a non-null `unconfirmedSince`". Measured, twice:
 *
 *   1. It DOES reach one. Revision 0 marked a MISS as unconfirmed, and in a
 *      packed repository the deleted branch misses exactly like every other, so
 *      checkpoint 1 passes under the broken detector.
 *   2. The obvious replacement — "then `main` gets tombstoned instead" — does
 *      not fire either, and the reason is worth knowing: `main` is the label
 *      THIS run resolved, so D7's `pinnedThisRun` drops every decision about
 *      it unconditionally (§4.3 item 3). The pinned branch is immune to a
 *      broken detector by accident.
 *
 * So the fixture carries a THIRD branch, `keeper`: it exists, it is indexed, and
 * it is NOT checked out. That is the branch a loose-refs-only detector destroys
 * in a packed repository, and asserting its survival is what makes reading
 * `packed-refs` load-bearing in this suite. The falsification run is in the
 * implementation log.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	BRANCH_CONFIRM_INTERVAL,
	BRANCH_DELETE_GRACE_MS,
} from "../../../src/core/branch-lifecycle.js";
import { createGitSandbox } from "../../helpers/git-sandbox.js";
import {
	BM25_ONLY,
	mainCheckoutStoreDir,
	runLifecycleChild,
	storeRows,
	writeSource,
} from "../../helpers/v4-fixtures.js";

const TEST_TIMEOUT_MS = 600_000;

interface RegistryFile {
	nextId: number;
	branches: Array<{
		id: number;
		label: string;
		deletedAt: string | null;
		unconfirmedSince: string | null;
	}>;
}

/** `branches.json`'s BYTES, parsed independently of the registry module. */
function registryBytes(storeDir: string): RegistryFile {
	return JSON.parse(readFileSync(join(storeDir, "branches.json"), "utf8"));
}

function entryFor(file: RegistryFile, label: string) {
	return file.branches.find((b) => b.label === label);
}

/** `chunk_branches` rows for one branch, through an independent connection. */
function membershipCount(indexDb: string, branchId: number): number {
	const db = new Database(indexDb, { readonly: true });
	try {
		const row = db
			.prepare("SELECT COUNT(*) AS n FROM chunk_branches WHERE branch_id = ?")
			.get(branchId) as { n: number };
		return row.n;
	} finally {
		db.close();
	}
}

function fileRowCount(indexDb: string, branchId: number): number {
	const db = new Database(indexDb, { readonly: true });
	try {
		const row = db
			.prepare("SELECT COUNT(*) AS n FROM files WHERE branch_id = ?")
			.get(branchId) as { n: number };
		return row.n;
	} finally {
		db.close();
	}
}

interface Fixture {
	root: string;
	project: string;
	scratch: string;
	storeDir: string;
	indexDb: string;
	vectorsDir: string;
	cleanup: () => void;
	git: (cwd: string, ...args: string[]) => string;
}

/**
 * A repository with `main`, a branch `doomed`, one file each branch has and one
 * only `doomed` has — so checkpoint 3 can tell a NARROW (a row another branch
 * still holds) from a DELETE (a row nobody holds).
 */
async function makeFixture(): Promise<Fixture> {
	const sandbox = createGitSandbox("mnemex-terminate-");
	const project = join(sandbox.root, "repo");
	const scratch = join(sandbox.root, "scratch");
	sandbox.git(sandbox.root, "init", "repo");
	// The store lives at `<project>/.mnemex` under `STORE_SCOPE_DEFAULT =
	// "worktree"`, so without this a `git checkout` refuses to switch branches
	// over the index's own files.
	writeFileSync(join(project, ".gitignore"), ".mnemex/\n");
	writeFileSync(
		join(project, "mnemex.json"),
		`${JSON.stringify(BM25_ONLY, null, 2)}\n`,
	);
	writeSource(project, "src/shared.ts", 3, "shared");
	sandbox.git(project, "add", "-A");
	sandbox.git(project, "commit", "-m", "initial");
	return {
		root: sandbox.root,
		project,
		scratch,
		storeDir: mainCheckoutStoreDir(project),
		indexDb: join(mainCheckoutStoreDir(project), "index.db"),
		vectorsDir: join(mainCheckoutStoreDir(project), "vectors"),
		cleanup: () => sandbox.cleanup(),
		git: sandbox.git,
	};
}

describe("V3.8 — a deleted branch is reclaimed without a human, under packed refs", () => {
	test(
		"three ordered checkpoints: unconfirmed, tombstoned, swept",
		async () => {
			const fx = await makeFixture();
			try {
				// ── Set-up: index main, then a branch with a file of its own ─────
				let run = await runLifecycleChild(fx.project, 1, 0, fx.scratch);
				expect(run.exitCode, run.stderr).toBe(0);

				fx.git(fx.project, "checkout", "-b", "doomed");
				writeSource(fx.project, "src/only-doomed.ts", 2, "doomed");
				fx.git(fx.project, "add", "-A");
				fx.git(fx.project, "commit", "-m", "doomed only");
				run = await runLifecycleChild(fx.project, 1, 0, fx.scratch);
				expect(run.exitCode, run.stderr).toBe(0);

				// `keeper`: a branch that EXISTS, is indexed, and is not the one any
				// later run has checked out. D7's `pinnedThisRun` cannot protect it,
				// so it is the branch a detector that cannot read `packed-refs`
				// destroys — which is what makes the assertions about it the real
				// falsifier for G2.
				fx.git(fx.project, "checkout", "main");
				fx.git(fx.project, "checkout", "-b", "keeper");
				writeSource(fx.project, "src/only-keeper.ts", 2, "keeper");
				fx.git(fx.project, "add", "-A");
				fx.git(fx.project, "commit", "-m", "keeper only");
				run = await runLifecycleChild(fx.project, 1, 0, fx.scratch);
				expect(run.exitCode, run.stderr).toBe(0);
				fx.git(fx.project, "checkout", "doomed");

				const afterIndex = registryBytes(fx.storeDir);
				const doomed = entryFor(afterIndex, "doomed");
				const main = entryFor(afterIndex, "main");
				expect(
					doomed,
					"the branch was indexed, so it has an entry",
				).toBeDefined();
				expect(main).toBeDefined();
				const keeper = entryFor(afterIndex, "keeper");
				expect(keeper).toBeDefined();
				const doomedId = doomed?.id ?? -1;
				const mainId = main?.id ?? -1;
				const keeperId = keeper?.id ?? -1;
				const nextIdBefore = afterIndex.nextId;
				expect(membershipCount(fx.indexDb, doomedId)).toBeGreaterThan(0);
				expect(membershipCount(fx.indexDb, keeperId)).toBeGreaterThan(0);

				// Rows only `doomed` has, and rows BOTH branches have. The second set
				// is what proves a narrow rather than a delete at checkpoint 3.
				const rowsBefore = await storeRows(fx.vectorsDir);
				const doomedOnly = rowsBefore
					.filter((r) => String(r.filePath).includes("only-doomed"))
					.map((r) => String(r.id));
				const shared = rowsBefore.filter(
					(r) =>
						String(r.filePath).includes("shared") &&
						String(r.branchIds).includes(`,${doomedId},`),
				);
				expect(doomedOnly.length).toBeGreaterThan(0);
				expect(shared.length).toBeGreaterThan(0);

				// ── Delete the branch and PACK the refs ──────────────────────────
				// `pack-refs --all` is the whole point: after it, `refs/heads/main`
				// is a file that no longer exists, so a detector that looks only
				// there cannot tell `main` from `doomed`.
				fx.git(fx.project, "checkout", "main");
				fx.git(fx.project, "branch", "-D", "doomed");
				fx.git(fx.project, "pack-refs", "--all");
				expect(
					readFileSync(join(fx.project, ".git", "packed-refs"), "utf8"),
				).toContain("refs/heads/main");

				// ── CHECKPOINT 1 ────────────────────────────────────────────────
				run = await runLifecycleChild(
					fx.project,
					BRANCH_CONFIRM_INTERVAL,
					0,
					fx.scratch,
				);
				expect(run.exitCode, run.stderr).toBe(0);

				const at1 = registryBytes(fx.storeDir);
				expect(entryFor(at1, "doomed")?.unconfirmedSince).not.toBeNull();
				expect(entryFor(at1, "doomed")?.deletedAt).toBeNull();
				// The branches that still exist are untouched. THIS is what reading
				// `packed-refs` buys: without it every live branch is
				// indistinguishable from the deleted one. `keeper` is the load-
				// bearing one — `main` is the resolved label, so D7's
				// `pinnedThisRun` would spare it even under a broken detector.
				expect(entryFor(at1, "keeper")?.unconfirmedSince).toBeNull();
				expect(entryFor(at1, "keeper")?.deletedAt).toBeNull();
				expect(entryFor(at1, "main")?.unconfirmedSince).toBeNull();
				expect(entryFor(at1, "main")?.deletedAt).toBeNull();
				// Nothing has been removed yet: a tombstone is a decision, not a
				// deletion.
				expect(membershipCount(fx.indexDb, doomedId)).toBeGreaterThan(0);

				// ── CHECKPOINT 1b: the grace is about TIME, not about passes ────
				//
				// §4.3's stated falsifier for the grace — "remove the grace check
				// and checkpoint 1 fails, because `deletedAt` is stamped on the
				// first pass" — does NOT fire. The first pass cannot reach the
				// `deletedAt` branch at all: it sets `unconfirmedSince` and
				// `continue`s, and only a LATER pass consults the grace. Measured;
				// the run is in the implementation log.
				//
				// So the grace is pinned by its real property instead: a SECOND
				// confirmation pass, with the clock unmoved, must still not
				// tombstone. That assertion is what goes red when the comparison is
				// removed.
				run = await runLifecycleChild(
					fx.project,
					BRANCH_CONFIRM_INTERVAL,
					0,
					fx.scratch,
				);
				expect(run.exitCode, run.stderr).toBe(0);
				const at1b = registryBytes(fx.storeDir);
				expect(entryFor(at1b, "doomed")?.deletedAt).toBeNull();
				expect(entryFor(at1b, "doomed")?.unconfirmedSince).toBe(
					entryFor(at1, "doomed")?.unconfirmedSince ?? "",
				);
				expect(membershipCount(fx.indexDb, doomedId)).toBeGreaterThan(0);

				// ── CHECKPOINT 2 ────────────────────────────────────────────────
				// The clock moves; the grace is measured from `unconfirmedSince`, so
				// this is the second pass that can reach a tombstone. "Grace 0" on
				// one pass can never tombstone — `now - now > 0` is false (N29).
				run = await runLifecycleChild(
					fx.project,
					BRANCH_CONFIRM_INTERVAL,
					BRANCH_DELETE_GRACE_MS + 60_000,
					fx.scratch,
				);
				expect(run.exitCode, run.stderr).toBe(0);

				const at2 = registryBytes(fx.storeDir);
				// Either still tombstoned, or already swept away by rule C in the
				// same batch of runs — both are "reached a tombstone". Which one it
				// is, is asserted below.
				const stillThere = entryFor(at2, "doomed");
				if (stillThere !== undefined) {
					expect(stillThere.deletedAt).not.toBeNull();
				}
				expect(entryFor(at2, "main")?.deletedAt).toBeNull();
				expect(entryFor(at2, "main")?.unconfirmedSince).toBeNull();
				expect(entryFor(at2, "keeper")?.deletedAt).toBeNull();
				expect(entryFor(at2, "keeper")?.unconfirmedSince).toBeNull();

				// ── CHECKPOINT 3 ────────────────────────────────────────────────
				// The sweep runs on every index run, bounded; this fixture is far
				// under one budget, so one more run drains whatever is left.
				run = await runLifecycleChild(
					fx.project,
					2,
					BRANCH_DELETE_GRACE_MS + 120_000,
					fx.scratch,
				);
				expect(run.exitCode, run.stderr).toBe(0);

				// (a) membership is empty, through an independent connection
				expect(membershipCount(fx.indexDb, doomedId)).toBe(0);
				// (b) the tree-scoped rows went with it
				expect(fileRowCount(fx.indexDb, doomedId)).toBe(0);
				// (c) rule C dropped the entry and `nextId` did NOT move: "ids are
				//     never reused" is a property of `nextId` alone.
				const at3 = registryBytes(fx.storeDir);
				expect(entryFor(at3, "doomed")).toBeUndefined();
				expect(at3.nextId).toBe(nextIdBefore);
				// (d) the live branches survive, WITH their rows. `keeper` is the
				//     one that matters: it is not pinned by any run here.
				expect(entryFor(at3, "main")?.deletedAt).toBeNull();
				expect(entryFor(at3, "keeper")?.deletedAt).toBeNull();
				expect(membershipCount(fx.indexDb, mainId)).toBeGreaterThan(0);
				expect(membershipCount(fx.indexDb, keeperId)).toBeGreaterThan(0);
				expect(fileRowCount(fx.indexDb, keeperId)).toBeGreaterThan(0);

				// (e) the ROWS, through an independent LanceDB connection: the
				//     branch's exclusive rows are gone, the shared ones survive with
				//     the dead id removed from the mirror.
				const rowsAfter = await storeRows(fx.vectorsDir);
				const survivingIds = new Set(rowsAfter.map((r) => String(r.id)));
				for (const id of doomedOnly) expect(survivingIds.has(id)).toBe(false);
				for (const row of shared) {
					const now = rowsAfter.find((r) => String(r.id) === String(row.id));
					expect(now, "a row main still holds must survive").toBeDefined();
					expect(String(now?.branchIds)).not.toContain(`,${doomedId},`);
					expect(String(now?.branchIds)).toContain(`,${mainId},`);
				}
			} finally {
				fx.cleanup();
			}
		},
		TEST_TIMEOUT_MS,
	);
});
