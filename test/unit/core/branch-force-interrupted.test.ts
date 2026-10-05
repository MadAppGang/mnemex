/**
 * A `--force` KILLED MID-NARROW must leave the branch REBUILDABLE.
 *
 * ── WHY THIS FILE EXISTS, AND WHY IT DEVIATES FROM §4.5's PSEUDOCODE ────────
 * §4.5 writes `narrowBranch` with the tree-scoped deletes (`files`,
 * `documents`, `symbols`, `symbol_references`, `graph_metadata`) AFTER the
 * membership loop, which is the order `sweepTombstonedBranches` uses. For the
 * sweep that order is right: a tombstoned branch has no run of its own coming,
 * and rule R's `completeInterruptedSweep` consumes the surviving `files` rows
 * to decide what to rebuild.
 *
 * For a FORCE it is the defect phase 3b-3 found for the sweep, arriving through
 * the other door. A run killed between two membership pages would leave `files`
 * rows whose `content_hash` still matches the working tree — so the next
 * ordinary `mnemex index` sees nothing to do, and the chunk rows the force had
 * already removed never come back. Nothing revisits an unchanged file, so the
 * branch stays short for ever.
 *
 * `narrowBranch` therefore deletes the tree-scoped rows FIRST. That is safe
 * because W1's reason for the sweep's order is about `chunk_branches` (the work
 * list) and not about `files`: this function never finds a row through a `files`
 * row.
 *
 * ── HOW THE INTERRUPTION IS REACHED ─────────────────────────────────────────
 * CONSTRUCTED, not raced for: `narrowBranch` is driven directly with
 * `pageSize: 1` and an `onProgress` that throws as soon as the first membership
 * page is gone — the exact state a `kill -9` between two pages leaves. The
 * REPAIR is then the real `Indexer`, in a sandboxed child, and every count is
 * read through an independent connection.
 *
 * ── THE FALSIFIER ───────────────────────────────────────────────────────────
 * Swap the two loops in `narrowBranch` so the tree-scoped deletes run last, as
 * §4.5 words it, and the final assertion goes red: the membership count comes
 * back one row short and stays there. Executed; the numbers are in
 * `implementation-log.md`.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { narrowBranch } from "../../../src/core/branch-sweep.js";
import { createStoreLock } from "../../../src/core/lock.js";
import { createVectorStore } from "../../../src/core/store.js";
import {
	getIndexDbPathFor,
	getVectorStorePathFor,
	resolveStoreLocation,
} from "../../../src/core/store-location.js";
import { createFileTracker } from "../../../src/core/tracker.js";
import { createGitSandbox } from "../../helpers/git-sandbox.js";
import {
	BM25_ONLY,
	runCli,
	storeRows,
	writeSource,
} from "../../helpers/v4-fixtures.js";

const TEST_TIMEOUT_MS = 300_000;

/** Thrown by the progress callback to stand in for a `kill -9`. */
class Interrupted extends Error {}

function countIn(indexDb: string, sql: string, branchId: number): number {
	const db = new Database(indexDb, { readonly: true });
	try {
		const row = db.prepare(sql).get(branchId) as { n: number };
		return row.n;
	} finally {
		db.close();
	}
}

const MEMBERSHIP =
	"SELECT COUNT(*) AS n FROM chunk_branches WHERE branch_id = ?";
const FILES = "SELECT COUNT(*) AS n FROM files WHERE branch_id = ?";

describe("an interrupted --force leaves the branch rebuildable", () => {
	test(
		"the next ordinary index restores every row the narrow had removed",
		async () => {
			const sandbox = createGitSandbox("mnemex-force-interrupt-");
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
				writeSource(project, "src/b.ts", 3, "b");
				sandbox.git(project, "add", "-A");
				sandbox.git(project, "commit", "-m", "initial");

				const first = await runCli(["index"], scratch, project);
				expect(first.exitCode, first.stderr).toBe(0);

				const loc = resolveStoreLocation(project);
				const indexDb = getIndexDbPathFor(loc);
				const vectorsDir = getVectorStorePathFor(loc);
				const membershipBefore = countIn(indexDb, MEMBERSHIP, 1);
				const filesBefore = countIn(indexDb, FILES, 1);
				const rowsBefore = (await storeRows(vectorsDir)).length;
				expect(membershipBefore).toBeGreaterThan(2);
				expect(filesBefore).toBeGreaterThan(1);

				// ── A force that dies after its first membership page ────────────
				const lock = createStoreLock(loc);
				expect((await lock.acquire({ waitTimeout: 0 })).acquired).toBe(true);
				const tracker = createFileTracker(indexDb, loc.pathRoot);
				const store = createVectorStore({
					vectorsDir,
					pathRoot: loc.pathRoot,
				});
				let interrupted = false;
				try {
					await store.initialize();
					await narrowBranch(tracker, store, 1, {
						pageSize: 1,
						onProgress: (rows) => {
							// The tree-scoped loop reports 0; the first membership page
							// is the first report above it, and is where the process
							// dies.
							if (rows > 0) throw new Interrupted("kill -9");
						},
					});
				} catch (error) {
					interrupted = error instanceof Interrupted;
				} finally {
					tracker.close();
					await store.close();
					lock.release();
				}
				expect(interrupted).toBe(true);

				// Half-done, and the two halves are what decide the outcome: some
				// membership is gone, and — because the tree-scoped rows go FIRST —
				// no `files` row survives to tell the next run there is nothing to do.
				const membershipMid = countIn(indexDb, MEMBERSHIP, 1);
				expect(membershipMid).toBeLessThan(membershipBefore);
				expect(countIn(indexDb, FILES, 1)).toBe(0);

				// ── An ORDINARY index run, with no --force at all ────────────────
				const repair = await runCli(["index"], scratch, project);
				expect(repair.exitCode, repair.stderr).toBe(0);

				// THE ASSERTION THIS FILE EXISTS FOR. With the tree-scoped deletes
				// last (as §4.5 words it), `files` survives the interruption,
				// `getChanges` reports nothing to do, and this count stays below
				// `membershipBefore` for ever.
				expect(countIn(indexDb, MEMBERSHIP, 1)).toBe(membershipBefore);
				expect(countIn(indexDb, FILES, 1)).toBe(filesBefore);
				expect((await storeRows(vectorsDir)).length).toBe(rowsBefore);
			} finally {
				sandbox.cleanup();
			}
		},
		TEST_TIMEOUT_MS,
	);
});
