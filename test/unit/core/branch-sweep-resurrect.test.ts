/**
 * Rule R against a HALF-SWEPT branch — the case §3.4 says is safe and, as the
 * sweep is ordered in §4.3, was not.
 *
 * ── THE GAP, IN THE DESIGN'S OWN WORDS ──────────────────────────────────────
 * §3.4: "The sweep may already have deleted rows for that id; that is an
 * incremental-work problem, not a correctness one, because the run that just
 * resolved the id rebuilds exactly what was swept (a branch whose `files` rows
 * were deleted reports every file NEW from `getChanges`)."
 *
 * The parenthesis assumes the sweep deletes `files` rows as it goes. §4.3
 * orders it the other way round, and for a good reason: `chunk_branches` is the
 * work list (W1), so the tree-scoped tables are cleared only once membership has
 * drained. A branch swept HALFWAY therefore still has `files` rows whose
 * `content_hash` matches the working tree — so `getChanges` reports nothing to
 * do, and the chunk rows the sweep already deleted never come back. The branch
 * is silently half-empty and no later run repairs it, because nothing revisits
 * an unchanged file.
 *
 * ── WHAT CLOSES IT ──────────────────────────────────────────────────────────
 * `Indexer.indexInternal` finishes the interrupted operation when — and only
 * when — the `store.json` cursor names the branch rule R just resurrected:
 * `completeInterruptedSweep` drops its tree-scoped rows, so the ordinary diff
 * rebuilds exactly what was removed. A tombstone the sweep never reached costs
 * nothing, because no cursor names it.
 *
 * ── HOW THE HALF-SWEPT STATE IS REACHED ─────────────────────────────────────
 * CONSTRUCTED, not raced for: the sweep is driven directly with `budget: 1` so
 * it removes one membership row and stops, exactly as an exhausted
 * `ORPHAN_SWEEP_BUDGET` would. The REPAIR is then driven by the real `Indexer`
 * in a sandboxed child, and every assertion reads rows through an independent
 * connection.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openRegistry } from "../../../src/core/branch-registry.js";
import { sweepTombstonedBranches } from "../../../src/core/branch-sweep.js";
import { createStoreLock } from "../../../src/core/lock.js";
import { createVectorStore } from "../../../src/core/store.js";
import {
	getIndexDbPathFor,
	getVectorStorePathFor,
	resolveStoreLocation,
} from "../../../src/core/store-location.js";
import {
	readStoreState,
	writeStoreState,
} from "../../../src/core/store-meta.js";
import { createFileTracker } from "../../../src/core/tracker.js";
import { createGitSandbox } from "../../helpers/git-sandbox.js";
import {
	BM25_ONLY,
	runLifecycleChild,
	storeRows,
	writeSource,
} from "../../helpers/v4-fixtures.js";

const TEST_TIMEOUT_MS = 300_000;

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

function registryBytes(storeDir: string): {
	branches: Array<{
		id: number;
		label: string;
		deletedAt: string | null;
		lastSeen: string;
	}>;
} {
	return JSON.parse(readFileSync(join(storeDir, "branches.json"), "utf8"));
}

describe("rule R against a half-swept branch", () => {
	test(
		"the rows the sweep removed come back on the next index run",
		async () => {
			const sandbox = createGitSandbox("mnemex-resurrect-");
			try {
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

				let run = await runLifecycleChild(project, 1, 0, scratch);
				expect(run.exitCode, run.stderr).toBe(0);

				sandbox.git(project, "checkout", "-b", "away");
				writeSource(project, "src/only-away.ts", 4, "away");
				sandbox.git(project, "add", "-A");
				sandbox.git(project, "commit", "-m", "away only");
				run = await runLifecycleChild(project, 1, 0, scratch);
				expect(run.exitCode, run.stderr).toBe(0);

				const loc = resolveStoreLocation(project);
				const indexDb = getIndexDbPathFor(loc);
				const vectorsDir = getVectorStorePathFor(loc);
				const before = registryBytes(loc.storeDir);
				const away = before.branches.find((b) => b.label === "away");
				expect(away).toBeDefined();
				const awayId = away?.id ?? -1;
				const membershipBefore = membershipCount(indexDb, awayId);
				expect(membershipBefore).toBeGreaterThan(2);
				const awayRowsBefore = (await storeRows(vectorsDir)).filter((r) =>
					String(r.filePath).includes("only-away"),
				).length;
				expect(awayRowsBefore).toBeGreaterThan(0);

				// ── Tombstone it, then sweep ONE row and stop ────────────────────
				const lock = createStoreLock(loc);
				expect((await lock.acquire({ waitTimeout: 0 })).acquired).toBe(true);
				const tracker = createFileTracker(indexDb, loc.pathRoot);
				const store = createVectorStore({
					vectorsDir,
					pathRoot: loc.pathRoot,
				});
				try {
					await store.initialize();
					const first = openRegistry(loc, lock, tracker);
					first.applyBranchDecisions([
						{
							id: awayId,
							label: "away",
							set: "unconfirmedSince",
							observedLastSeen: away?.lastSeen ?? "",
							reason: "ref-absent",
						},
					]);
					first.flush();
					const seen =
						registryBytes(loc.storeDir).branches.find((b) => b.id === awayId)
							?.lastSeen ?? "";
					const second = openRegistry(loc, lock, tracker);
					second.applyBranchDecisions([
						{
							id: awayId,
							label: "away",
							set: "deletedAt",
							observedLastSeen: seen,
							reason: "grace-expired",
						},
					]);
					// `budget: 1` is exactly what an exhausted ORPHAN_SWEEP_BUDGET
					// leaves behind: some rows gone, a cursor naming the branch, the
					// entry still tombstoned.
					const partial = await sweepTombstonedBranches(
						tracker,
						store,
						second,
						{ budget: 1, pageSize: 1 },
					);
					second.flush();
					expect(partial.membershipRowsRemoved).toBe(1);
					expect(partial.budgetExhausted).toBe(true);
					expect(partial.cursor?.branchId).toBe(awayId);
					expect(partial.branchesFinalized).toEqual([]);
					writeStoreState(loc, {
						confirmRunCounter: readStoreState(loc).confirmRunCounter,
						sweep: partial.cursor,
					});
				} finally {
					tracker.close();
					await store.close();
					lock.release();
				}

				// Half-swept: one row fewer than before, the entry tombstoned.
				expect(membershipCount(indexDb, awayId)).toBe(membershipBefore - 1);
				expect(
					registryBytes(loc.storeDir).branches.find((b) => b.id === awayId)
						?.deletedAt,
				).not.toBeNull();
				expect(readStoreState(loc).sweep?.branchId).toBe(awayId);

				// ── The branch is checked out again, and indexed ─────────────────
				run = await runLifecycleChild(project, 1, 0, scratch);
				expect(run.exitCode, run.stderr).toBe(0);

				// Rule R: same id, live again, cursor gone.
				const after = registryBytes(loc.storeDir);
				const revived = after.branches.find((b) => b.label === "away");
				expect(revived?.id).toBe(awayId);
				expect(revived?.deletedAt).toBeNull();
				expect(readStoreState(loc).sweep).toBeNull();

				// THE ASSERTION THIS FILE EXISTS FOR. Without the interrupted-sweep
				// completion, `files` rows survive, `getChanges` reports nothing
				// changed, and the membership stays one row short for ever.
				expect(membershipCount(indexDb, awayId)).toBe(membershipBefore);
				const awayRowsAfter = (await storeRows(vectorsDir)).filter((r) =>
					String(r.filePath).includes("only-away"),
				).length;
				expect(awayRowsAfter).toBe(awayRowsBefore);
			} finally {
				sandbox.cleanup();
			}
		},
		TEST_TIMEOUT_MS,
	);
});
