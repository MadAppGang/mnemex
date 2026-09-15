/**
 * The WRITE side of the branch model, driven through the REAL `Indexer` in a
 * sandboxed child (architecture §4.1, §4.2; decision I-7 FINAL).
 *
 * WHAT IS ASSERTED, AND HOW. Every row count comes from an INDEPENDENT
 * `lancedb.connect()` and every membership fact from an INDEPENDENT
 * `better-sqlite3` connection; nothing here trusts a return value alone. The
 * child prints what it did as data and judges nothing (CLAUDE.md #24, #31).
 *
 * Runs are BM25-only (`vector: false`, `enrichment: false`) with docs off, so
 * no network and no keychain are reachable: the real parser, the real tracker
 * and the real LanceDB store run with the production `[0]` placeholder vector.
 * Two consequences are deliberate and named where they matter:
 *
 *   - the append phase is labelled `writing:lance` rather than `embedding`
 *     (nothing is embedded), so that is V3.6's first kill point here;
 *   - the `document` row class needs an LLM, so V3.5's third count is covered
 *     at the mechanism level in `branch-membership-merge.test.ts` instead. Said
 *     out loud rather than left to be discovered.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFileTracker } from "../../../src/core/tracker.js";
import { createGitSandbox } from "../../helpers/git-sandbox.js";
import {
	BM25_ONLY,
	runIndexChild,
	storeRows,
	writeSource,
} from "../../helpers/v4-fixtures.js";

const TEST_TIMEOUT_MS = 240_000;

/** Rows for one stored path, per row class. */
function classCounts(
	rows: Array<Record<string, unknown>>,
	storedPath: string,
): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const row of rows) {
		if (row.filePath !== storedPath) continue;
		const cls = String(row.documentType);
		counts[cls] = (counts[cls] ?? 0) + 1;
	}
	return counts;
}

/** Rows for one stored path, by id → its stored membership string. */
function membershipByPath(
	rows: Array<Record<string, unknown>>,
	storedPath: string,
): Map<string, string> {
	const byId = new Map<string, string>();
	for (const row of rows) {
		if (row.filePath !== storedPath) continue;
		byId.set(String(row.id), String(row.branchIds));
	}
	return byId;
}

/** One read through an independent SQLite connection. */
function withIndexDb<T>(indexDb: string, fn: (db: Database) => T): T {
	const db = new Database(indexDb, { readonly: true });
	try {
		return fn(db);
	} finally {
		db.close();
	}
}

function membershipRows(
	indexDb: string,
): Array<{ chunk_id: string; branch_id: number }> {
	return withIndexDb(
		indexDb,
		(db) =>
			db
				.prepare("SELECT chunk_id, branch_id FROM chunk_branches")
				.all() as Array<{ chunk_id: string; branch_id: number }>,
	);
}

function intentCount(indexDb: string, kind: string): number {
	return withIndexDb(indexDb, (db) => {
		const row = db
			.prepare("SELECT COUNT(*) AS n FROM chunk_write_intent WHERE kind = ?")
			.get(kind) as { n: number };
		return row.n;
	});
}

function registeredIds(indexDb: string): Set<string> {
	return withIndexDb(
		indexDb,
		(db) =>
			new Set(
				(
					db.prepare("SELECT chunk_id FROM chunk_index").all() as Array<{
						chunk_id: string;
					}>
				).map((r) => r.chunk_id),
			),
	);
}

/** `src/a.ts` at revision `n`: the same shape, different bodies. */
function revision(n: number): string {
	const parts: string[] = [];
	for (let i = 0; i < 3; i++) {
		parts.push(
			`/** a ${i} rev ${n} */\nexport function a_${i}(x: number): number {\n\treturn x * ${i + 1} + ${n};\n}\n`,
		);
	}
	return parts.join("\n");
}

// ════════════════════════════════════════════════════════════════════════════
// V3.5 — modify ONE file TWICE on ONE branch
// ════════════════════════════════════════════════════════════════════════════

describe("V3.5 — a file edited twice leaves exactly the current revision's rows", () => {
	test(
		"code_chunk and code_unit counts both equal a FRESH index of the same content",
		async () => {
			const sb = createGitSandbox("v35-");
			try {
				// The project under test, edited twice in place.
				const project = join(sb.root, "project");
				mkdirSync(project);
				writeFileSync(join(project, "mnemex.json"), JSON.stringify(BM25_ONLY));
				writeFileSync(join(project, "src-a.ts"), revision(1));
				writeSource(project, "keep.ts");
				const scratch = join(sb.root, "scratch");
				const vectors = join(project, ".mnemex", "vectors");
				const indexDb = join(project, ".mnemex", "index.db");

				const one = await runIndexChild("index", project, scratch, sb.root);
				expect(one.exitCode, one.stderr).toBe(0);
				const afterOne = classCounts(await storeRows(vectors), "src-a.ts");
				expect(afterOne.code_chunk).toBeGreaterThan(0);
				expect(afterOne.code_unit).toBeGreaterThan(0);

				writeFileSync(join(project, "src-a.ts"), revision(2));
				const two = await runIndexChild("index", project, scratch, sb.root);
				expect(two.exitCode, two.stderr).toBe(0);

				writeFileSync(join(project, "src-a.ts"), revision(3));
				const three = await runIndexChild("index", project, scratch, sb.root);
				expect(three.exitCode, three.stderr).toBe(0);

				// The reference: a store that has only ever seen revision 3. Its
				// counts ARE "the current revision's count", so nothing here
				// hardcodes a chunker or extractor detail that a later release may
				// legitimately change.
				const fresh = join(sb.root, "fresh");
				mkdirSync(fresh);
				writeFileSync(join(fresh, "mnemex.json"), JSON.stringify(BM25_ONLY));
				writeFileSync(join(fresh, "src-a.ts"), revision(3));
				writeSource(fresh, "keep.ts");
				const freshRun = await runIndexChild(
					"index",
					fresh,
					join(sb.root, "scratch-fresh"),
					sb.root,
				);
				expect(freshRun.exitCode, freshRun.stderr).toBe(0);
				const expected = classCounts(
					await storeRows(join(fresh, ".mnemex", "vectors")),
					"src-a.ts",
				);

				const actual = classCounts(await storeRows(vectors), "src-a.ts");
				// ONE assertion over both classes, so a failure shows which moved.
				// Without NARROW_CHUNKS the chunk count is the SUM over all three
				// revisions; without NARROW_UNITS the unit count is; with
				// NARROW_UNITS run before AST extraction the unit count is 0.
				expect(actual).toEqual(expected);

				// P1, both directions, over the whole store: every registered id
				// resolves to a live row, and no live row is unregistered.
				const rows = await storeRows(vectors);
				const liveIds = new Set(rows.map((r) => String(r.id)));
				const registered = registeredIds(indexDb);
				expect([...registered].filter((id) => !liveIds.has(id))).toEqual([]);
				expect([...liveIds].filter((id) => !registered.has(id))).toEqual([]);
				// The journal is empty in steady state.
				expect(intentCount(indexDb, "add")).toBe(0);
				expect(intentCount(indexDb, "remove")).toBe(0);
				expect(intentCount(indexDb, "widen")).toBe(0);
			} finally {
				sb.cleanup();
			}
		},
		TEST_TIMEOUT_MS,
	);
});

// ════════════════════════════════════════════════════════════════════════════
// Branch switching, end to end — the state decision I-10 named
// ════════════════════════════════════════════════════════════════════════════

describe("branch switching: a second worktree WIDENS instead of duplicating", () => {
	test(
		"unchanged files gain a membership id and no rows; the changed file gains rows for the new branch only",
		async () => {
			const sb = createGitSandbox("branch-switch-");
			try {
				const store = join(sb.root, "shared-store");
				const main = join(sb.root, "main");
				mkdirSync(main);
				sb.git(main, "init", "-q", "-b", "main");
				writeFileSync(join(main, "mnemex.json"), JSON.stringify(BM25_ONLY));
				writeFileSync(join(main, "src-a.ts"), revision(1));
				writeSource(main, "src/b.ts");
				writeSource(main, "src/c.ts");
				sb.git(main, "add", "-A");
				sb.git(main, "commit", "-q", "-m", "init");
				const scratch = join(sb.root, "scratch");
				const extra = { MNEMEX_INDEX_DIR: store };
				const vectors = join(store, "vectors");
				const indexDb = join(store, "index.db");

				const first = await runIndexChild("index", main, scratch, main, extra);
				expect(first.exitCode, first.stderr).toBe(0);
				const mainBranch = first.result?.branch as { branchId: number };
				expect(mainBranch.branchId).toBe(1);

				const rowsAfterMain = await storeRows(vectors);
				const mainRowCount = rowsAfterMain.length;
				expect(mainRowCount).toBeGreaterThan(0);
				// Everything main wrote carries main's id and nothing else.
				expect(new Set(rowsAfterMain.map((r) => String(r.branchIds)))).toEqual(
					new Set([",1,"]),
				);

				// ── A second worktree, one changed file ─────────────────────────
				const feat = join(sb.root, "feat");
				sb.git(main, "worktree", "add", "-q", "-b", "feat", feat);
				writeFileSync(join(feat, "src-a.ts"), revision(2));

				const second = await runIndexChild("index", feat, scratch, feat, extra);
				expect(second.exitCode, second.stderr).toBe(0);
				const featBranch = second.result?.branch as {
					branchId: number;
					label: string;
					idsWidened: number;
					rowsWidened: number;
					widenRemaining: number;
				};
				expect(featBranch.branchId).toBe(2);
				expect(featBranch.label).toBe("feat");
				// The backlog DRAINED inside the same run: a search from `feat`
				// sees the whole store, not a subset.
				expect(featBranch.widenRemaining).toBe(0);
				expect(featBranch.idsWidened).toBeGreaterThan(0);
				expect(featBranch.rowsWidened).toBe(featBranch.idsWidened);

				const rowsAfterFeat = await storeRows(vectors);
				// UNCHANGED files cost ZERO new rows. This is the whole point of
				// the tier-1 hit test: a second worktree of an indexed tree is a
				// membership write, not a copy of the store.
				const unchangedB = membershipByPath(rowsAfterFeat, "src/b.ts");
				const unchangedC = membershipByPath(rowsAfterFeat, "src/c.ts");
				expect(unchangedB.size).toBe(
					membershipByPath(rowsAfterMain, "src/b.ts").size,
				);
				expect([...unchangedB.values(), ...unchangedC.values()]).toEqual(
					Array(unchangedB.size + unchangedC.size).fill(",1,2,"),
				);

				// THE CHANGED FILE, by row class, because the two classes behave
				// DIFFERENTLY and the difference is a design defect worth pinning.
				//
				// `code_chunk` — an id hashes `filePath:startLine:endLine:content`,
				// so the two revisions cannot collide: main keeps its rows, feat
				// gets its own, and NOTHING is shared.
				const changedRows = rowsAfterFeat.filter(
					(r) => r.filePath === "src-a.ts",
				);
				const chunkMemberships = changedRows
					.filter((r) => r.documentType === "code_chunk")
					.map((r) => String(r.branchIds));
				expect(chunkMemberships).toContain(",1,");
				expect(chunkMemberships).toContain(",2,");
				expect(chunkMemberships).not.toContain(",1,2,");

				// `code_unit` — a FUNCTION unit's id is
				// `sha256(filePath:unitType:name:startRow)`, with NO content in it
				// (measured: `edc328f7f7d95751` before and after a body edit), so
				// two revisions of one function CANNOT have distinct rows. There is
				// one row, held by both branches, carrying the content of whichever
				// branch indexed LAST. Asserted rather than hidden: this is the
				// wart §4.1.1's "chunk ids are content+position addressed" does not
				// cover, and the durable fix is an id-scheme change.
				const sharedUnits = changedRows.filter(
					(r) => r.documentType === "code_unit" && r.branchIds === ",1,2,",
				);
				expect(sharedUnits.length).toBeGreaterThan(0);
				// The LAST writer's content, not a stale body: `refreshCodeUnits`
				// rewrote the row in place. Without it the shared rows would still
				// hold `+ 1`, and branch 2 would be served revision 1's source.
				for (const unit of sharedUnits) {
					expect(String(unit.content)).toContain("+ 2;");
					expect(String(unit.content)).not.toContain("+ 1;");
				}
				// A FILE unit's id hashes the file hash, so it does not collide.
				const fileUnits = changedRows.filter(
					(r) => r.documentType === "code_unit" && r.unitType === "file",
				);
				expect(fileUnits.map((r) => String(r.branchIds)).sort()).toEqual([
					",1,",
					",2,",
				]);

				// Growth is the CHANGED file's NEW rows only — the shared units add
				// nothing, because they were rewritten rather than appended.
				expect(rowsAfterFeat.length).toBe(
					mainRowCount +
						changedRows.filter((r) => r.branchIds === ",2,").length,
				);

				// Membership, read independently: a shared id really does have two
				// rows in `chunk_branches`, which is what the mirror mirrors.
				const membership = membershipRows(indexDb);
				const byChunk = new Map<string, number[]>();
				for (const row of membership) {
					const ids = byChunk.get(row.chunk_id);
					if (ids === undefined) byChunk.set(row.chunk_id, [row.branch_id]);
					else ids.push(row.branch_id);
				}
				for (const [id, mirror] of membershipByPath(
					rowsAfterFeat,
					"src/b.ts",
				)) {
					expect((byChunk.get(id) ?? []).sort()).toEqual([1, 2]);
					expect(mirror).toBe(",1,2,");
				}
				// Mirror and membership agree in BOTH directions, over every row.
				for (const row of rowsAfterFeat) {
					const stored = String(row.branchIds)
						.split(",")
						.filter((p) => p !== "")
						.map(Number)
						.sort();
					expect(stored).toEqual((byChunk.get(String(row.id)) ?? []).sort());
				}

				// ── Back to main: nothing to do ─────────────────────────────────
				const third = await runIndexChild("index", main, scratch, main, extra);
				expect(third.exitCode, third.stderr).toBe(0);
				const back = third.result?.branch as {
					branchId: number;
					rowsWidened: number;
					widenRemaining: number;
				};
				expect(back.branchId).toBe(1);
				expect(back.widenRemaining).toBe(0);
				const rowsAfterBack = await storeRows(vectors);
				expect(rowsAfterBack.length).toBe(rowsAfterFeat.length);
				expect(intentCount(indexDb, "widen")).toBe(0);
			} finally {
				sb.cleanup();
			}
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"a file deleted on one branch keeps the other branch's rows, and reports PER ROW CLASS",
		async () => {
			const sb = createGitSandbox("branch-delete-");
			try {
				const store = join(sb.root, "shared-store");
				const main = join(sb.root, "main");
				mkdirSync(main);
				sb.git(main, "init", "-q", "-b", "main");
				writeFileSync(join(main, "mnemex.json"), JSON.stringify(BM25_ONLY));
				writeSource(main, "src/shared.ts");
				writeSource(main, "src/doomed.ts");
				sb.git(main, "add", "-A");
				sb.git(main, "commit", "-q", "-m", "init");
				const scratch = join(sb.root, "scratch");
				const extra = { MNEMEX_INDEX_DIR: store };
				const vectors = join(store, "vectors");
				const indexDb = join(store, "index.db");

				expect(
					(await runIndexChild("index", main, scratch, main, extra)).exitCode,
				).toBe(0);

				const feat = join(sb.root, "feat");
				sb.git(main, "worktree", "add", "-q", "-b", "feat", feat);
				expect(
					(await runIndexChild("index", feat, scratch, feat, extra)).exitCode,
				).toBe(0);
				const shared = membershipByPath(
					await storeRows(vectors),
					"src/doomed.ts",
				);
				expect(shared.size).toBeGreaterThan(0);
				expect([...shared.values()]).toEqual(Array(shared.size).fill(",1,2,"));

				// Delete it on `feat` only.
				rmSync(join(feat, "src", "doomed.ts"));
				const run = await runIndexChild("index", feat, scratch, feat, extra);
				expect(run.exitCode, run.stderr).toBe(0);
				// A file another branch still holds is NARROWED, not deleted: the
				// partial-ghost warning must stay silent, and it is per CLASS, so
				// a class that removed nothing while another removed something
				// would fire it (3a-2 finding 2).
				expect(run.stderr).not.toContain("one row class removed");

				const after = membershipByPath(
					await storeRows(vectors),
					"src/doomed.ts",
				);
				// SAME rows, one id fewer in the mirror. Branch 1 can still find
				// the file it never deleted.
				expect(after.size).toBe(shared.size);
				expect([...after.values()]).toEqual(Array(after.size).fill(",1,"));
				// And the membership table agrees.
				const stillMembers = membershipRows(indexDb).filter((r) =>
					after.has(r.chunk_id),
				);
				expect(new Set(stillMembers.map((r) => r.branch_id))).toEqual(
					new Set([1]),
				);

				// Now delete it on main too: membership empties, so the ROWS go.
				rmSync(join(main, "src", "doomed.ts"));
				expect(
					(await runIndexChild("index", main, scratch, main, extra)).exitCode,
				).toBe(0);
				expect(
					membershipByPath(await storeRows(vectors), "src/doomed.ts").size,
				).toBe(0);
				// …and so do their `chunk_index` entries, in W1's order.
				const registered = registeredIds(indexDb);
				expect([...shared.keys()].filter((id) => registered.has(id))).toEqual(
					[],
				);
			} finally {
				sb.cleanup();
			}
		},
		TEST_TIMEOUT_MS,
	);
});

// ════════════════════════════════════════════════════════════════════════════
// §4.1.3b — the drain runs WHETHER OR NOT anything changed
// ════════════════════════════════════════════════════════════════════════════

describe("the widen drain is not gated on a change set", () => {
	test(
		"a run with NO file changes at all still drains a backlog left behind",
		async () => {
			const sb = createGitSandbox("drain-ungated-");
			try {
				const project = join(sb.root, "project");
				mkdirSync(project);
				writeFileSync(join(project, "mnemex.json"), JSON.stringify(BM25_ONLY));
				for (let i = 0; i < 4; i++) writeSource(project, `src/f${i}.ts`);
				const scratch = join(sb.root, "scratch");
				const indexDb = join(project, ".mnemex", "index.db");
				const vectors = join(project, ".mnemex", "vectors");

				const first = await runIndexChild("index", project, scratch, sb.root);
				expect(first.exitCode, first.stderr).toBe(0);

				// A backlog an earlier run left behind: membership for branch 2
				// committed, its mirror not yet written. This is what an exhausted
				// `WIDEN_BUDGET` leaves, and what a crash mid-drain leaves.
				const ids = (await storeRows(vectors)).map((r) => String(r.id));
				const tracker = createFileTracker(indexDb, project);
				tracker.commitAddBatch(2, {
					registered: [],
					memberIds: ids,
					widenIds: ids,
					files: [],
					clearAddIntentIds: [],
				});
				expect(tracker.countWidenIntents()).toBe(ids.length);
				tracker.close();

				// NOTHING on disk changed, so `getChanges` reports no work at all.
				const second = await runIndexChild("index", project, scratch, sb.root);
				expect(second.exitCode, second.stderr).toBe(0);
				expect(second.result?.filesIndexed).toBe(0);
				const branch = second.result?.branch as
					| { rowsWidened: number; widenRemaining: number }
					| undefined;

				// The backlog DRAINED anyway. Gating the pass on a non-empty change
				// set — V3.18's own falsifier — leaves `widenRemaining` at
				// `ids.length` and every one of those rows invisible from branch 2
				// until some unrelated edit happens to trigger a run.
				expect(branch?.widenRemaining).toBe(0);
				expect(branch?.rowsWidened).toBe(ids.length);
				const mirrors = new Set(
					(await storeRows(vectors)).map((r) => String(r.branchIds)),
				);
				expect([...mirrors]).toEqual([",0,2,"]);
			} finally {
				sb.cleanup();
			}
		},
		TEST_TIMEOUT_MS,
	);
});

// ════════════════════════════════════════════════════════════════════════════
// 3a-2's finding 4 — the `nextId` raise reaches the rows, not only `files`
// ════════════════════════════════════════════════════════════════════════════

describe("the nextId raise covers every store that carries a branch id", () => {
	test(
		"with index.db REPLACED and only LanceDB rows left, a new label is issued an id above them",
		async () => {
			const sb = createGitSandbox("raise-");
			try {
				const store = join(sb.root, "shared-store");
				const main = join(sb.root, "main");
				mkdirSync(main);
				sb.git(main, "init", "-q", "-b", "main");
				writeFileSync(join(main, "mnemex.json"), JSON.stringify(BM25_ONLY));
				writeSource(main, "src/a.ts");
				sb.git(main, "add", "-A");
				sb.git(main, "commit", "-q", "-m", "init");
				const scratch = join(sb.root, "scratch");
				const extra = { MNEMEX_INDEX_DIR: store };
				const registryPath = join(store, "branches.json");
				const indexDb = join(store, "index.db");

				// Three labels, so the rows carry ids 1..3.
				expect(
					(await runIndexChild("index", main, scratch, main, extra)).exitCode,
				).toBe(0);
				for (const label of ["two", "three"]) {
					const wt = join(sb.root, label);
					sb.git(main, "worktree", "add", "-q", "-b", label, wt);
					writeSource(wt, `src/${label}.ts`);
					expect(
						(await runIndexChild("index", wt, scratch, wt, extra)).exitCode,
					).toBe(0);
				}
				const rows = await storeRows(join(store, "vectors"));
				const highestInRows = Math.max(
					...rows.flatMap((r) =>
						String(r.branchIds)
							.split(",")
							.filter((p) => p !== "")
							.map(Number),
					),
				);
				expect(highestInRows).toBe(3);

				// THE RESIDUE FINDING 4 DESCRIBES, in its worst form: the registry
				// AND `index.db` are both lost while the rows keep their ids. Only
				// the rows can say what has been issued.
				rmSync(registryPath);
				rmSync(indexDb, { force: true });
				rmSync(`${indexDb}-wal`, { force: true });
				rmSync(`${indexDb}-shm`, { force: true });

				const four = join(sb.root, "four");
				sb.git(main, "worktree", "add", "-q", "-b", "four", four);
				writeSource(four, "src/four.ts");
				const run = await runIndexChild("index", four, scratch, four, extra);
				expect(run.exitCode, run.stderr).toBe(0);
				const registry = JSON.parse(readFileSync(registryPath, "utf8")) as {
					nextId: number;
					branches: Array<{ id: number; label: string }>;
				};
				const issued = registry.branches.find((b) => b.label === "four");
				// NOT 1. Without the LanceDB half of the raise the fresh registry
				// starts at 1 and the new label collides with `main`'s rows, which
				// are still in the table and would become visible from it.
				expect(issued?.id).toBeGreaterThan(highestInRows);
				expect(registry.nextId).toBeGreaterThan(issued?.id as number);
			} finally {
				sb.cleanup();
			}
		},
		TEST_TIMEOUT_MS,
	);
});
