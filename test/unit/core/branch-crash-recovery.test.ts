/**
 * V3.6 — `kill -9` mid-run, at BOTH kill points, plus the belt row
 * (architecture §4.1.4).
 *
 * Revision 0 of the design said a crash between the LanceDB write and the
 * SQLite one "redoes idempotently (the chunk id is deterministic, so the
 * re-write is a no-op in content)". The tree documents that as FALSE in exactly
 * this shape: `addChunks` is `table.add`, a plain append with no primary key
 * and no merge, so a file with rows and no tracker row is classified NEW, new
 * files never reached the modified-files delete, "and `addChunks` appends — so
 * every later run would append another copy, permanently and per run"
 * (`indexer.ts`'s own comment). The replacement is the write-intent journal,
 * and this is the test that it works.
 *
 * TWO assertions at every kill point, because the two failures are opposite:
 *
 *   A — NO GHOSTS. The row count equals a clean run's.
 *   B — NO INVISIBLE CHUNKS. Every id `chunk_index` names resolves to a live
 *       row. An id the tracker believes indexed with no row behind it is
 *       permanently unsearchable content that every other probe calls healthy,
 *       and it is the direction revision 1 of the journal had no way to see.
 *
 * At the `"branch-membership"` kill both directions of the MIRROR are asserted
 * as well: no row whose `branchIds` names a branch `chunk_branches` does not,
 * and no `chunk_branches (id, b)` whose row's `branchIds` omits `b`.
 *
 * Runs are BM25-only, so the append phase is labelled `writing:lance` rather
 * than `embedding` — nothing is embedded. That is this suite's first kill
 * point, and it is the same region of the same loop.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import { createVectorStore } from "../../../src/core/store.js";
import { createFileTracker } from "../../../src/core/tracker.js";
import { createGitSandbox } from "../../helpers/git-sandbox.js";
import {
	BM25_ONLY,
	collect,
	runIndexChild,
	spawnIndexChild,
	storeRows,
	writeSource,
} from "../../helpers/v4-fixtures.js";

const TEST_TIMEOUT_MS = 300_000;
/** Enough files that a kill lands mid-run rather than after it. */
const FILES = 60;

interface StoreState {
	rows: number;
	/** Ids in `chunk_index` with no live LanceDB row (assertion B). */
	invisible: string[];
	/** Ids whose mirror and membership disagree, in either direction. */
	mirrorDisagreements: string[];
	intents: Record<string, number>;
}

async function readState(store: string): Promise<StoreState> {
	const rows = await storeRows(join(store, "vectors"));
	const live = new Set(rows.map((r) => String(r.id)));
	const db = new Database(join(store, "index.db"), { readonly: true });
	try {
		const registered = (
			db.prepare("SELECT chunk_id FROM chunk_index").all() as Array<{
				chunk_id: string;
			}>
		).map((r) => r.chunk_id);
		const membership = new Map<string, Set<number>>();
		for (const row of db
			.prepare("SELECT chunk_id, branch_id FROM chunk_branches")
			.all() as Array<{ chunk_id: string; branch_id: number }>) {
			const ids = membership.get(row.chunk_id) ?? new Set<number>();
			ids.add(row.branch_id);
			membership.set(row.chunk_id, ids);
		}
		const intents: Record<string, number> = { add: 0, remove: 0, widen: 0 };
		for (const row of db
			.prepare(
				"SELECT kind, COUNT(*) AS n FROM chunk_write_intent GROUP BY kind",
			)
			.all() as Array<{ kind: string; n: number }>) {
			intents[row.kind] = row.n;
		}

		const mirrorDisagreements: string[] = [];
		for (const row of rows) {
			const id = String(row.id);
			const stored = new Set(
				String(row.branchIds)
					.split(",")
					.filter((p) => p !== "")
					.map(Number),
			);
			const held = membership.get(id) ?? new Set<number>();
			const sameSize = stored.size === held.size;
			const sameMembers = [...stored].every((b) => held.has(b));
			if (!sameSize || !sameMembers) mirrorDisagreements.push(id);
		}
		return {
			rows: rows.length,
			invisible: registered.filter((id) => !live.has(id)),
			mirrorDisagreements,
			intents,
		};
	} finally {
		db.close();
	}
}

function lockPhase(lockPath: string): string | null {
	try {
		const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as {
			phase?: string;
		};
		return parsed.phase ?? null;
	} catch {
		return null;
	}
}

interface Fixture {
	sb: ReturnType<typeof createGitSandbox>;
	project: string;
	store: string;
	scratch: string;
	extra: Record<string, string>;
}

function makeFixture(prefix: string): Fixture {
	const sb = createGitSandbox(prefix);
	const project = join(sb.root, "project");
	mkdirSync(project);
	sb.git(project, "init", "-q", "-b", "main");
	writeFileSync(join(project, "mnemex.json"), JSON.stringify(BM25_ONLY));
	for (let i = 0; i < FILES; i++) writeSource(project, `src/f${i}.ts`, 4);
	sb.git(project, "add", "-A");
	sb.git(project, "commit", "-q", "-m", "init");
	const store = join(sb.root, "store");
	return {
		sb,
		project,
		store,
		scratch: join(sb.root, "scratch"),
		extra: { MNEMEX_INDEX_DIR: store },
	};
}

/**
 * Spawn an index run and SIGKILL it the moment the store lock says it reached
 * `phase`. Returns false when the run finished before the phase was seen — the
 * caller then has nothing to assert and says so rather than passing quietly.
 */
async function killAtPhase(
	fx: Fixture,
	cwd: string,
	phase: string,
): Promise<boolean> {
	const lockPath = join(fx.store, ".indexing.lock");
	const child = spawnIndexChild("index", cwd, fx.scratch, cwd, fx.extra);
	const collected = collect(child);
	let killed = false;
	while (!killed && child.exitCode === null) {
		if (existsSync(lockPath) && lockPhase(lockPath) === phase) {
			child.kill("SIGKILL");
			killed = true;
		} else {
			await Bun.sleep(1);
		}
	}
	await collected;
	return killed;
}

describe("V3.6 — a killed run leaves no ghosts and no invisible chunks", () => {
	test(
		"kill at the APPEND phase: the next run recovers, and the store matches a clean one",
		async () => {
			const fx = makeFixture("v36-append-");
			try {
				// The reference: the same tree, indexed once, never interrupted.
				const cleanFx = makeFixture("v36-clean-");
				const clean = await runIndexChild(
					"index",
					cleanFx.project,
					cleanFx.scratch,
					cleanFx.project,
					cleanFx.extra,
				);
				expect(clean.exitCode, clean.stderr).toBe(0);
				const cleanState = await readState(cleanFx.store);
				expect(cleanState.rows).toBeGreaterThan(0);
				cleanFx.sb.cleanup();

				const killed = await killAtPhase(fx, fx.project, "writing:lance");
				expect(killed).toBe(true);

				// The residue is REAL: rows were appended and never registered, so
				// `'add'` intents survive. Without them there would be nothing for
				// recovery to find and the next run would append a second copy.
				const afterKill = await readState(fx.store);
				expect(afterKill.intents.add).toBeGreaterThan(0);

				const finish = await runIndexChild(
					"index",
					fx.project,
					fx.scratch,
					fx.project,
					fx.extra,
				);
				expect(finish.exitCode, finish.stderr).toBe(0);
				const after = await readState(fx.store);
				// A — no ghosts. FIRST, so a falsifier that deletes the recovery
				// shows THIS number rather than a missing report field.
				expect(after.rows).toBe(cleanState.rows);
				const finishBranch = finish.result?.branch as
					| { recoveredCrashResidue?: { added: number; removed: number } }
					| undefined;
				expect(finishBranch?.recoveredCrashResidue?.added).toBeGreaterThan(0);
				// B — no invisible chunks.
				expect(after.invisible).toEqual([]);
				expect(after.mirrorDisagreements).toEqual([]);
				expect(after.intents).toEqual({ add: 0, remove: 0, widen: 0 });
			} finally {
				fx.sb.cleanup();
			}
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"kill at the BRANCH-MEMBERSHIP phase: the mirror and the membership agree in both directions afterwards",
		async () => {
			const fx = makeFixture("v36-widen-");
			try {
				// Branch 1 first, to completion.
				const first = await runIndexChild(
					"index",
					fx.project,
					fx.scratch,
					fx.project,
					fx.extra,
				);
				expect(first.exitCode, first.stderr).toBe(0);
				const baseline = await readState(fx.store);

				// A second worktree: every file is a tier-1 hit, so the whole tree
				// is a widen backlog and the drain has real work to be killed in.
				const feat = join(fx.sb.root, "feat");
				fx.sb.git(fx.project, "worktree", "add", "-q", "-b", "feat", feat);
				const killed = await killAtPhase(fx, feat, "branch-membership");
				expect(killed).toBe(true);

				// The backlog is a SET of committed rows, so the kill leaves it
				// behind rather than losing it — this is what a high-water-mark
				// cursor could not do.
				const afterKill = await readState(fx.store);
				expect(afterKill.intents.widen).toBeGreaterThan(0);

				const finish = await runIndexChild(
					"index",
					feat,
					fx.scratch,
					feat,
					fx.extra,
				);
				expect(finish.exitCode, finish.stderr).toBe(0);

				const after = await readState(fx.store);
				// A — no ghosts: widening adds no rows, so the count is the
				// single-branch baseline.
				expect(after.rows).toBe(baseline.rows);
				// B — and the mirror agrees with the membership IN BOTH
				// DIRECTIONS. A `chunk_branches (id, 2)` row whose mirror omits 2
				// is a chunk branch 2 cannot see; a mirror naming a branch that
				// holds nothing is a chunk branch 2 sees and must not.
				expect(after.invisible).toEqual([]);
				expect(after.mirrorDisagreements).toEqual([]);
				expect(after.intents.widen).toBe(0);
			} finally {
				fx.sb.cleanup();
			}
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"APPENDED-BUT-UNREGISTERED rows are deleted by the next run, not left as ghosts",
		async () => {
			const fx = makeFixture("v36-residue-");
			try {
				const first = await runIndexChild(
					"index",
					fx.project,
					fx.scratch,
					fx.project,
					fx.extra,
				);
				expect(first.exitCode, first.stderr).toBe(0);
				const before = await readState(fx.store);

				// THE EXACT STATE THE APPEND WINDOW PRODUCES, constructed rather
				// than raced for. The window between `table.add` resolving and
				// R5b's transaction is SYNCHRONOUS — microseconds — so a SIGKILL
				// from another process lands in it about never, and the kill test
				// above therefore exercises the intents-only half. This is the
				// other half, and it is the half assertion A is about: rows in
				// LanceDB that no `chunk_index` row refers to, with the `'add'`
				// intents that name them.
				//
				// The ids belong to a file that does not exist, so nothing in the
				// ordinary run re-creates them: what recovery deletes stays
				// deleted, and the row count is an exact expectation.
				const ghostIds = Array.from({ length: 5 }, (_, i) =>
					`f${i}`.padStart(64, "e"),
				);
				const store = createVectorStore({
					vectorsDir: join(fx.store, "vectors"),
					pathRoot: fx.project,
				});
				await store.initialize();
				await store.addChunks(
					ghostIds.map((id, i) => ({
						id,
						contentHash: `ghost-${i}`,
						content: `export function ghost${i}() { return ${i}; }`,
						filePath: "src/ghost.ts",
						startLine: i * 10 + 1,
						endLine: i * 10 + 9,
						language: "typescript",
						chunkType: "function" as const,
						fileHash: "ghost-file",
						vector: [0],
					})),
					{ pathKind: "repo", branchId: 1 },
				);
				await store.close();
				const tracker = createFileTracker(
					join(fx.store, "index.db"),
					fx.project,
				);
				tracker.beginAddIntents(1, ghostIds);
				tracker.close();

				const seeded = await readState(fx.store);
				expect(seeded.rows).toBe(before.rows + ghostIds.length);
				expect(seeded.intents.add).toBe(ghostIds.length);

				const recover = await runIndexChild(
					"index",
					fx.project,
					fx.scratch,
					fx.project,
					fx.extra,
				);
				expect(recover.exitCode, recover.stderr).toBe(0);

				const after = await readState(fx.store);
				// A — NO GHOSTS: exactly the rows the clean run left.
				expect(after.rows).toBe(before.rows);
				const rows = await storeRows(join(fx.store, "vectors"));
				expect(rows.filter((r) => ghostIds.includes(String(r.id)))).toEqual([]);
				// B — and nothing became invisible on the way.
				expect(after.invisible).toEqual([]);
				expect(after.intents.add).toBe(0);
				const branch = recover.result?.branch as
					| { recoveredCrashResidue?: { added: number } }
					| undefined;
				expect(branch?.recoveredCrashResidue?.added).toBe(ghostIds.length);
			} finally {
				fx.sb.cleanup();
			}
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"an interrupted REMOVAL is FINISHED by the next run, never undone",
		async () => {
			const fx = makeFixture("v36-remove-");
			try {
				const first = await runIndexChild(
					"index",
					fx.project,
					fx.scratch,
					fx.project,
					fx.extra,
				);
				expect(first.exitCode, first.stderr).toBe(0);
				const before = await readState(fx.store);

				// A narrow that got as far as M1 and no further: `'remove'`
				// intents naming real rows, with the rows and the membership still
				// present and CONSISTENT. That is the state §4.1.1's crash table
				// calls "between M1 and M3".
				const rows = await storeRows(join(fx.store, "vectors"));
				const doomed = rows
					.filter((r) => r.filePath === "src/f3.ts")
					.map((r) => String(r.id));
				expect(doomed.length).toBeGreaterThan(0);
				const tracker = createFileTracker(
					join(fx.store, "index.db"),
					fx.project,
				);
				tracker.beginRemoveIntents(1, doomed);
				tracker.close();

				const recover = await runIndexChild(
					"index",
					fx.project,
					fx.scratch,
					fx.project,
					fx.extra,
				);
				expect(recover.exitCode, recover.stderr).toBe(0);

				const after = await readState(fx.store);
				// FINISHED, not undone. Undoing would resurrect exactly the ghost
				// chunks a removal exists to delete — the file's new id set was
				// already authoritative when the intent was written. The file
				// itself is unchanged on disk, so `getChanges` does not revisit it
				// and nothing re-creates the rows: the count is exact.
				expect(after.rows).toBe(before.rows - doomed.length);
				const left = await storeRows(join(fx.store, "vectors"));
				expect(left.filter((r) => doomed.includes(String(r.id)))).toEqual([]);
				// W1's order held: the `chunk_index` entries went with the rows.
				expect(after.invisible).toEqual([]);
				expect(after.intents.remove).toBe(0);
				const branch = recover.result?.branch as
					| { recoveredCrashResidue?: { removed: number } }
					| undefined;
				expect(branch?.recoveredCrashResidue?.removed).toBe(doomed.length);
			} finally {
				fx.sb.cleanup();
			}
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"THE BELT — a hand-deleted row whose id stays in chunk_index is re-inserted, exactly once",
		async () => {
			const fx = makeFixture("v36-belt-");
			try {
				const first = await runIndexChild(
					"index",
					fx.project,
					fx.scratch,
					fx.project,
					fx.extra,
				);
				expect(first.exitCode, first.stderr).toBe(0);
				const before = await readState(fx.store);

				// P1 broken by hand, through an INDEPENDENT connection: the row is
				// gone while `chunk_index` still names it. This is the case where
				// the journal itself is lost — a corrupted `index.db`, a
				// hand-deleted row — and the tier-1 existence check is the belt.
				const rows = await storeRows(join(fx.store, "vectors"));
				const victim = rows.find(
					(r) => r.filePath === "src/f7.ts" && r.documentType === "code_chunk",
				);
				expect(victim).toBeDefined();
				const victimId = String(victim?.id);
				const db = await lancedb.connect(join(fx.store, "vectors"));
				const table = await db.openTable("code_chunks");
				await table.delete(`id = '${victimId}'`);
				const broken = await readState(fx.store);
				expect(broken.invisible).toEqual([victimId]);

				// Index a BRANCH WHOSE TREE CONTAINS IT — §4.1.4's own wording. A
				// re-index of the SAME branch would not reach the file at all:
				// nothing on disk changed, so `getChanges` calls it unchanged and
				// it is never chunked. A second worktree chunks every file, because
				// every one of them is new FOR THAT BRANCH ID, so the hit test runs
				// over the broken id and only the existence check can save it.
				const feat = join(fx.sb.root, "feat");
				fx.sb.git(fx.project, "worktree", "add", "-q", "-b", "feat", feat);
				const repair = await runIndexChild(
					"index",
					feat,
					fx.scratch,
					feat,
					fx.extra,
				);
				expect(repair.exitCode, repair.stderr).toBe(0);

				const after = await readState(fx.store);
				// The deleted id resolves to a live row again…
				expect(after.invisible).toEqual([]);
				// …EXACTLY ONE row for it, and no other id in its batch gained a
				// second one. A scalar `countRows` in place of the projection would
				// fail here: a short count says how many are missing and never
				// which, so acting on it either re-appends every live row of the
				// batch or leaves the missing one invisible.
				const repaired = await storeRows(join(fx.store, "vectors"));
				expect(repaired.filter((r) => String(r.id) === victimId).length).toBe(
					1,
				);
				expect(repaired.length).toBe(before.rows);
				// AND the re-inserted row's mirror keeps the branch that was
				// already holding it. A demoted id is written with this run's
				// `,<id>,` alone, so without a `'widen'` intent for it branch 1
				// would lose sight of a chunk `chunk_branches` still says it holds.
				expect(after.mirrorDisagreements).toEqual([]);
				expect(
					String(repaired.find((r) => String(r.id) === victimId)?.branchIds),
				).toBe(",1,2,");
				const repairBranch = repair.result?.branch as
					| { idsDemoted?: number }
					| undefined;
				expect(repairBranch?.idsDemoted).toBe(1);
			} finally {
				fx.sb.cleanup();
			}
		},
		TEST_TIMEOUT_MS,
	);
});
