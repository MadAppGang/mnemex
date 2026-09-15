/**
 * V3.11 — the symbol graph, through one branch at a time.
 *
 * Symbol ids are `sha256(filePath:name:kind:line)` (`symbol-extractor.ts`), and
 * paths became repo-relative in Phase 3a-2 — so the SAME symbol on two branches
 * produces the SAME id. Under a single-column key `INSERT OR REPLACE` therefore
 * overwrote the other branch's row, silently. That is why the v4 key is
 * `(branch_id, id)` (I-12 Ruling 1, first case).
 *
 * ── THE THREE PARTS, all asserted through an INDEPENDENT SQLite connection ──
 *   1. COEXISTENCE. Two branches, the same relative path, the same symbol name:
 *      `SELECT count(*) … WHERE name = ?` is 2, and the two rows differ ONLY in
 *      `branch_id`.
 *   2. AN INCREMENTAL RE-INDEX ON BRANCH 2 DOES NOT TOUCH BRANCH 1. This is the
 *      assertion N3 was raised CRITICAL over. `extractSymbolGraph` calls
 *      `deleteSymbolsByFile` PER FILE on every non-force run, so unscoped it was
 *      live cross-branch data loss, not a theoretical one. Driven here by
 *      calling that member directly rather than by spawning `mnemex index`:
 *      membership writes do not exist until 3b-2, and the criterion is about the
 *      statement, which is the same statement either way.
 *   3. FORCE-REBUILD AND RANK WRITES STAY SCOPED. `clearSymbolGraph(2)` leaves
 *      branch 1's rows — and its stored `pagerank` / `in_degree` / `out_degree`
 *      values — BIT-IDENTICAL, compared as the full row set before and after.
 *
 * ── FALSIFIERS, ALL EXECUTED ────────────────────────────────────────────────
 *   part 2: drop `branch_id = ?` from either DELETE of `deleteSymbolsByFile` —
 *           branch 1's count goes to 0.
 *   part 3: drop it from the three DELETEs of `clearSymbolGraph` (count → 0),
 *           or from `updatePageRankScores` / `updateDegreeCounts` (branch 1's
 *           pagerank and degree values change).
 * Each falsifier runs the equivalent RAW statement against the same fixture, so
 * what is shown red is the statement itself and not a paraphrase of it.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabaseSync } from "../../../src/core/sqlite.js";
import { FileTracker } from "../../../src/core/tracker.js";
import type { SymbolDefinition, SymbolReference } from "../../../src/types.js";

const MAIN = 1;
const FEAT = 2;
const NOW = "2026-01-01T00:00:00.000Z";
const SHARED_PATH = "src/shared.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

interface Fixture {
	readonly tracker: FileTracker;
	readonly dbPath: string;
}

function openFixture(): Fixture {
	const root = mkdtempSync(join(tmpdir(), "branch-scoped-graph-"));
	tempDirs.push(root);
	const dbPath = join(root, "index.db");
	return { tracker: new FileTracker(dbPath, root), dbPath };
}

function symbol(
	id: string,
	name: string,
	filePath: string,
	isExported = true,
): SymbolDefinition {
	return {
		id,
		name,
		kind: "function",
		filePath,
		startLine: 1,
		endLine: 2,
		isExported,
		language: "typescript",
		pagerankScore: 0,
		createdAt: NOW,
		updatedAt: NOW,
	};
}

function reference(
	from: string,
	toName: string,
	filePath: string,
): SymbolReference {
	return {
		fromSymbolId: from,
		toSymbolName: toName,
		kind: "call",
		filePath,
		line: 1,
		isResolved: false,
		createdAt: NOW,
	};
}

/**
 * Both branches hold the same file, with the same symbol id — which is what a
 * content-derived id over a repo-relative path really produces.
 */
function seedBothBranches(tracker: FileTracker): void {
	for (const branch of [MAIN, FEAT]) {
		const graph = tracker.graph(branch);
		graph.insertSymbols([
			symbol("sym-shared", "shared", SHARED_PATH),
			symbol("sym-caller", "caller", `src/caller-${branch}.ts`),
		]);
		graph.insertReferences([
			reference("sym-caller", "shared", `src/caller-${branch}.ts`),
			reference("sym-shared", "shared", SHARED_PATH),
		]);
		graph.resolveReferencesByName();
		graph.updateDegreeCounts();
		graph.updatePageRankScores(
			new Map([
				["sym-shared", branch === MAIN ? 0.75 : 0.25],
				["sym-caller", branch === MAIN ? 0.11 : 0.22],
			]),
		);
	}
}

/** Read through a SECOND connection, never through the tracker under test. */
function independent<T>(
	dbPath: string,
	read: (db: ReturnType<typeof createDatabaseSync>) => T,
): T {
	const db = createDatabaseSync(dbPath);
	try {
		return read(db);
	} finally {
		db.close();
	}
}

interface SymbolRow {
	branch_id: number;
	id: string;
	name: string;
	file_path: string;
	pagerank: number;
	in_degree: number;
	out_degree: number;
}

function symbolRows(dbPath: string, branchId: number): SymbolRow[] {
	return independent(
		dbPath,
		(db) =>
			db
				.prepare(
					"SELECT branch_id, id, name, file_path, pagerank, in_degree, out_degree FROM symbols WHERE branch_id = ? ORDER BY id",
				)
				.all(branchId) as SymbolRow[],
	);
}

function countWhere(dbPath: string, sql: string, ...params: unknown[]): number {
	return independent(
		dbPath,
		(db) => (db.prepare(sql).get(...params) as { n: number }).n,
	);
}

// ════════════════════════════════════════════════════════════════════════════
// Part 1 — coexistence
// ════════════════════════════════════════════════════════════════════════════

describe("V3.11 part 1 — two branches hold the same symbol", () => {
	test("both rows exist, and they differ ONLY in branch_id", () => {
		const { tracker, dbPath } = openFixture();
		seedBothBranches(tracker);
		tracker.close();

		expect(
			countWhere(
				dbPath,
				"SELECT count(*) AS n FROM symbols WHERE name = ?",
				"shared",
			),
		).toBe(2);

		const rows = independent(
			dbPath,
			(db) =>
				db
					.prepare("SELECT * FROM symbols WHERE id = ? ORDER BY branch_id")
					.all("sym-shared") as Array<Record<string, unknown>>,
		);
		expect(rows).toHaveLength(2);
		const differing = Object.keys(rows[0]).filter(
			(k) => rows[0][k] !== rows[1][k],
		);
		// `pagerank` differs too, because the fixture gave the two branches
		// different scores on purpose — which is itself the point: the rows are
		// independent, not one row seen twice.
		expect(differing.sort()).toEqual(["branch_id", "pagerank"]);
	});

	test("graph_metadata coexists too: one pagerank stamp per branch", () => {
		const { tracker, dbPath } = openFixture();
		seedBothBranches(tracker);
		tracker.close();

		expect(
			countWhere(
				dbPath,
				"SELECT count(*) AS n FROM graph_metadata WHERE key = ?",
				"pagerank_last_computed",
			),
		).toBe(2);
	});

	test("without the composite key this fixture would hold ONE row", () => {
		// The premise, shown rather than asserted: an `INSERT OR REPLACE` keyed
		// on `id` alone collapses the two rows. Run on a throwaway table with the
		// PRE-v4 key, so the claim is measured and not argued.
		const { dbPath } = openFixture();
		independent(dbPath, (db) => {
			db.exec("CREATE TABLE v3_symbols (id TEXT PRIMARY KEY, name TEXT)");
			const stmt = db.prepare(
				"INSERT OR REPLACE INTO v3_symbols (id, name) VALUES (?, ?)",
			);
			stmt.run("sym-shared", "shared");
			stmt.run("sym-shared", "shared");
			expect(
				(
					db.prepare("SELECT count(*) AS n FROM v3_symbols").get() as {
						n: number;
					}
				).n,
			).toBe(1);
		});
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Part 2 — an incremental re-index on branch 2 leaves branch 1 alone
// ════════════════════════════════════════════════════════════════════════════

describe("V3.11 part 2 — deleteSymbolsByFile is per branch (N3)", () => {
	test("branch 1's counts for the shared path are unchanged", () => {
		const { tracker, dbPath } = openFixture();
		seedBothBranches(tracker);

		const symbolsBefore = countWhere(
			dbPath,
			"SELECT count(*) AS n FROM symbols WHERE branch_id = ? AND file_path = ?",
			MAIN,
			SHARED_PATH,
		);
		const refsBefore = countWhere(
			dbPath,
			"SELECT count(*) AS n FROM symbol_references WHERE branch_id = ? AND file_path = ?",
			MAIN,
			SHARED_PATH,
		);
		expect(symbolsBefore).toBe(1);
		expect(refsBefore).toBe(1);

		// What `extractSymbolGraph` does per file on a non-force run.
		tracker.graph(FEAT).deleteSymbolsByFile(SHARED_PATH);
		tracker.close();

		expect(
			countWhere(
				dbPath,
				"SELECT count(*) AS n FROM symbols WHERE branch_id = ? AND file_path = ?",
				MAIN,
				SHARED_PATH,
			),
		).toBe(symbolsBefore);
		expect(
			countWhere(
				dbPath,
				"SELECT count(*) AS n FROM symbol_references WHERE branch_id = ? AND file_path = ?",
				MAIN,
				SHARED_PATH,
			),
		).toBe(refsBefore);

		// Not vacuous: branch 2's own rows for that path DID go.
		expect(
			countWhere(
				dbPath,
				"SELECT count(*) AS n FROM symbols WHERE branch_id = ? AND file_path = ?",
				FEAT,
				SHARED_PATH,
			),
		).toBe(0);
	});

	test("FALSIFIER: the unpredicated DELETEs take branch 1 with them", () => {
		const { tracker, dbPath } = openFixture();
		seedBothBranches(tracker);
		tracker.close();

		// `deleteSymbolsByFile` exactly as it stood before the branch model.
		independent(dbPath, (db) => {
			db.prepare("DELETE FROM symbol_references WHERE file_path = ?").run(
				SHARED_PATH,
			);
			db.prepare("DELETE FROM symbols WHERE file_path = ?").run(SHARED_PATH);
		});

		expect(
			countWhere(
				dbPath,
				"SELECT count(*) AS n FROM symbols WHERE branch_id = ? AND file_path = ?",
				MAIN,
				SHARED_PATH,
			),
		).toBe(0);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Part 3 — force-rebuild and rank writes stay scoped
// ════════════════════════════════════════════════════════════════════════════

describe("V3.11 part 3 — clearSymbolGraph and the rank writes are per branch", () => {
	test("clearSymbolGraph(2) leaves branch 1's rows bit-identical", () => {
		const { tracker, dbPath } = openFixture();
		seedBothBranches(tracker);
		const before = symbolRows(dbPath, MAIN);
		expect(before).toHaveLength(2);

		tracker.graph(FEAT).clearSymbolGraph();
		tracker.close();

		expect(symbolRows(dbPath, MAIN)).toEqual(before);
		// Branch 2 really was cleared, in all three tables.
		expect(
			countWhere(
				dbPath,
				"SELECT count(*) AS n FROM symbols WHERE branch_id = ?",
				FEAT,
			),
		).toBe(0);
		expect(
			countWhere(
				dbPath,
				"SELECT count(*) AS n FROM symbol_references WHERE branch_id = ?",
				FEAT,
			),
		).toBe(0);
		expect(
			countWhere(
				dbPath,
				"SELECT count(*) AS n FROM graph_metadata WHERE branch_id = ?",
				FEAT,
			),
		).toBe(0);
	});

	test("re-ranking branch 2 leaves branch 1's pagerank and degrees untouched", () => {
		const { tracker, dbPath } = openFixture();
		seedBothBranches(tracker);
		const before = symbolRows(dbPath, MAIN);

		const feat = tracker.graph(FEAT);
		feat.updatePageRankScores(
			new Map([
				["sym-shared", 0.99],
				["sym-caller", 0.98],
			]),
		);
		feat.updateDegreeCounts();
		tracker.close();

		expect(symbolRows(dbPath, MAIN)).toEqual(before);
		// Not vacuous: branch 2's values moved.
		expect(
			symbolRows(dbPath, FEAT)
				.map((r) => r.pagerank)
				.sort(),
		).toEqual([0.98, 0.99]);
	});

	test("FALSIFIER: the unpredicated clear and rank writes cross branches", () => {
		const { tracker, dbPath } = openFixture();
		seedBothBranches(tracker);
		const before = symbolRows(dbPath, MAIN);
		tracker.close();

		// `updatePageRankScores` as it stood before the branch model.
		independent(dbPath, (db) => {
			db.prepare("UPDATE symbols SET pagerank = ? WHERE id = ?").run(
				0.99,
				"sym-shared",
			);
		});
		expect(symbolRows(dbPath, MAIN)).not.toEqual(before);

		// `clearSymbolGraph` as it stood before the branch model.
		independent(dbPath, (db) => {
			db.exec("DELETE FROM symbol_references");
			db.exec("DELETE FROM symbols");
			db.exec("DELETE FROM graph_metadata");
		});
		expect(symbolRows(dbPath, MAIN)).toEqual([]);
	});

	test("resolveReferencesByName resolves within a branch, never across", () => {
		const { tracker, dbPath } = openFixture();
		// Branch 1 has the DEFINITION; branch 2 only a reference to that name.
		tracker
			.graph(MAIN)
			.insertSymbols([symbol("def", "onlyOnMain", "src/only-main.ts")]);
		const feat = tracker.graph(FEAT);
		feat.insertReferences([
			reference("feat-caller", "onlyOnMain", "src/feat.ts"),
		]);

		expect(feat.resolveReferencesByName()).toBe(0);
		tracker.close();

		expect(
			countWhere(
				dbPath,
				"SELECT count(*) AS n FROM symbol_references WHERE branch_id = ? AND is_resolved = 1",
				FEAT,
			),
		).toBe(0);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// The other five tree-scoped tables, keyed the same way
// ════════════════════════════════════════════════════════════════════════════

describe("documents coexist per branch, and path-keyed writes stay scoped", () => {
	const doc = (id: string, filePath: string) => ({
		id,
		documentType: "file_summary" as const,
		filePath,
		sourceIds: ["c1"],
		createdAt: NOW,
	});

	test("the same document id exists on two branches", () => {
		const { tracker, dbPath } = openFixture();
		tracker.trackDocument(MAIN, doc("doc-shared", SHARED_PATH));
		tracker.trackDocument(FEAT, doc("doc-shared", SHARED_PATH));
		tracker.close();

		expect(
			countWhere(
				dbPath,
				"SELECT count(*) AS n FROM documents WHERE id = ?",
				"doc-shared",
			),
		).toBe(2);
	});

	test("markDocumentsInvalidated on one branch leaves the other valid", () => {
		const { tracker, dbPath } = openFixture();
		tracker.trackDocument(MAIN, doc("doc-shared", SHARED_PATH));
		tracker.trackDocument(FEAT, doc("doc-shared", SHARED_PATH));

		// The statement `invalidation.ts` drives on EVERY commit.
		expect(
			tracker.markDocumentsInvalidated(
				FEAT,
				[SHARED_PATH],
				["file_summary"],
				"c".repeat(40),
			),
		).toBe(1);
		tracker.close();

		expect(
			countWhere(
				dbPath,
				"SELECT count(*) AS n FROM documents WHERE branch_id = ? AND invalidated_at_commit IS NULL",
				MAIN,
			),
		).toBe(1);
		expect(
			countWhere(
				dbPath,
				"SELECT count(*) AS n FROM documents WHERE branch_id = ? AND invalidated_at_commit IS NOT NULL",
				FEAT,
			),
		).toBe(1);
	});
});

describe("files coexist per branch (the 3a-2 key, re-checked through the scoped members)", () => {
	test("the same path on two branches is two rows, and each member sees one", () => {
		const { tracker, dbPath } = openFixture();
		tracker.markIndexed(MAIN, SHARED_PATH, "hash-main", ["c1"]);
		tracker.markIndexed(FEAT, SHARED_PATH, "hash-feat", ["c2"]);

		expect(tracker.getChunkIds(MAIN, SHARED_PATH)).toEqual(["c1"]);
		expect(tracker.getChunkIds(FEAT, SHARED_PATH)).toEqual(["c2"]);
		expect(tracker.getAllFiles(MAIN)).toHaveLength(1);
		expect(tracker.getStats(MAIN).totalFiles).toBe(1);

		tracker.removeFile(FEAT, SHARED_PATH);
		tracker.close();

		expect(
			countWhere(
				dbPath,
				"SELECT count(*) AS n FROM files WHERE branch_id = ?",
				MAIN,
			),
		).toBe(1);
		expect(
			countWhere(
				dbPath,
				"SELECT count(*) AS n FROM files WHERE branch_id = ?",
				FEAT,
			),
		).toBe(0);
	});
});

describe("BRANCH_ID_TABLES and the C1 raise cover every table that carries a branch id", () => {
	test("highestBranchId reads the highest id in ANY of them", () => {
		const { tracker } = openFixture();
		tracker.markIndexed(1, "src/a.ts", "h", []);
		expect(tracker.highestBranchId()).toBe(1);

		// A symbol on a HIGHER branch: before `BRANCH_ID_TABLES` was extended
		// past `files`, the raise could not see this and would re-issue id 9 to
		// a second label while these rows still carried it (C1).
		tracker.graph(9).insertSymbols([symbol("s", "s", "src/b.ts")]);
		expect(tracker.highestBranchId()).toBe(9);

		tracker.graph(11).setGraphMetadata("k", "v");
		expect(tracker.highestBranchId()).toBe(11);

		tracker.trackDocument(12, {
			id: "d",
			documentType: "file_summary",
			filePath: "src/a.ts",
			sourceIds: [],
			createdAt: NOW,
		});
		expect(tracker.highestBranchId()).toBe(12);

		tracker.graph(13).insertReferences([reference("f", "t", "src/a.ts")]);
		expect(tracker.highestBranchId()).toBe(13);

		tracker.close();
	});

	test("trackerNeedsV4Schema sees a table that is still at the old shape", () => {
		const { tracker, dbPath } = openFixture();
		expect(tracker.trackerNeedsV4Schema()).toBe(false);
		tracker.close();

		// A store written at Phase 3a-2: `files` has `branch_id`, `symbols` does
		// not. Probing `files` alone would call this store current and leave five
		// tables where `INSERT OR REPLACE` overwrites another branch's row.
		independent(dbPath, (db) => {
			db.exec("DROP TABLE symbols");
			db.exec("CREATE TABLE symbols (id TEXT PRIMARY KEY, name TEXT)");
		});

		const reopened = new FileTracker(dbPath, join(dbPath, ".."));
		expect(reopened.trackerNeedsV4Schema()).toBe(true);
		reopened.close();
	});
});
