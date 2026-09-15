/**
 * The tracker's half of index version 4 (architecture §3.5, §3.5.1, §6.1):
 * `files` keyed on `(branch_id, path)`, the DROP-and-recreate pass, and the
 * two probes the indexer and the branch registry read.
 *
 * A property of the FILE is asserted through an INDEPENDENT sqlite connection,
 * never through the tracker that just wrote it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createDatabaseSync,
	type SQLiteDatabase,
} from "../../../src/core/sqlite.js";
import {
	BRANCH_ID_TABLES,
	FileTracker,
	resetTrackerSchemaCache,
} from "../../../src/core/tracker.js";

let dir: string;
let dbPath: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "tracker-branch-id-"));
	dbPath = join(dir, "index.db");
	resetTrackerSchemaCache();
});

afterEach(() => {
	resetTrackerSchemaCache();
	rmSync(dir, { recursive: true, force: true });
});

function independent<T>(fn: (db: SQLiteDatabase) => T): T {
	const db = createDatabaseSync(dbPath);
	try {
		return fn(db);
	} finally {
		db.close();
	}
}

interface ColumnInfo {
	name: string;
	notnull: number;
	pk: number;
}

function columnsOf(table: string): ColumnInfo[] {
	return independent(
		(db) => db.prepare(`PRAGMA table_info(${table})`).all() as ColumnInfo[],
	);
}

/**
 * A tracker database as index version 3 left it: `files` keyed on `path` alone
 * with no `branch_id`, plus rows in two REPO-scoped tables that must survive.
 */
function makeV3Database(): void {
	const db = createDatabaseSync(dbPath);
	try {
		for (const statement of [
			`CREATE TABLE files (
				path TEXT PRIMARY KEY, content_hash TEXT NOT NULL, mtime REAL NOT NULL,
				chunk_ids TEXT NOT NULL, indexed_at TEXT NOT NULL,
				enrichment_state TEXT DEFAULT '{}', enriched_at TEXT, indexed_at_commit TEXT
			)`,
			"CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
			"CREATE TABLE commits (sha TEXT PRIMARY KEY, ordinal INTEGER NOT NULL, committed_at TEXT)",
			"INSERT INTO files VALUES ('/abs/a.ts', 'h', 1, '[]', 't', '{}', NULL, NULL)",
			"INSERT INTO metadata VALUES ('embeddingModel', 'some-model')",
			`INSERT INTO commits VALUES ('${"a".repeat(40)}', 3, NULL)`,
		]) {
			db.exec(statement);
		}
	} finally {
		db.close();
	}
}

/** Insert two rows for ONE path under two branches, through an independent connection. */
function insertTwoBranches(): void {
	independent((db) => {
		const stmt = db.prepare(
			"INSERT INTO files (branch_id, path, content_hash, mtime, chunk_ids, indexed_at) VALUES (?, 'a.ts', 'h', 1, '[]', 't')",
		);
		stmt.run(1);
		stmt.run(2);
	});
}

describe("files at index version 4", () => {
	test("a fresh tracker creates branch_id NOT NULL, and the primary key (branch_id, path)", () => {
		new FileTracker(dbPath, dir).close();
		const columns = columnsOf("files");
		const branchId = columns.find((c) => c.name === "branch_id");
		expect(branchId?.notnull).toBe(1);
		const key = columns
			.filter((c) => c.pk > 0)
			.sort((a, b) => a.pk - b.pk)
			.map((c) => c.name);
		expect(key).toEqual(["branch_id", "path"]);
	});

	/**
	 * The registry's `nextId` raise reads every table named in BRANCH_ID_TABLES,
	 * and omitting one re-opens C1 for it. Falsified by a later phase adding
	 * `branch_id` to any other table without listing it.
	 */
	test("every table with a branch_id column is in BRANCH_ID_TABLES", () => {
		new FileTracker(dbPath, dir).close();
		const tables = independent(
			(db) =>
				db
					.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
					.all() as Array<{ name: string }>,
		).map((t) => t.name);
		const carrying = tables
			.filter((t) => columnsOf(t).some((c) => c.name === "branch_id"))
			.sort();
		expect(carrying).toEqual([...BRANCH_ID_TABLES].sort());
	});
});

describe("highestBranchId: the input to the registry's nextId raise", () => {
	test("null on a store no row of which carries an id", () => {
		const tracker = new FileTracker(dbPath, dir);
		expect(tracker.highestBranchId()).toBeNull();
		tracker.close();
	});

	test("the MAX over the rows, agreeing with an independent read", () => {
		const tracker = new FileTracker(dbPath, dir);
		tracker.markIndexed(3, join(dir, "a.ts"), "h", []);
		tracker.markIndexed(7, join(dir, "b.ts"), "h", []);
		tracker.markIndexed(5, join(dir, "c.ts"), "h", []);
		expect(tracker.highestBranchId()).toBe(7);
		tracker.close();
		expect(
			independent((db) =>
				db.prepare("SELECT MAX(branch_id) AS m FROM files").get(),
			),
		).toEqual({ m: 7 });
	});

	test("null on a pre-v4 files table, which carries no id at all", () => {
		makeV3Database();
		const tracker = new FileTracker(dbPath, dir);
		expect(tracker.highestBranchId()).toBeNull();
		tracker.close();
	});
});

describe("trackerNeedsV4Schema and the §3.5.1 DROP pass", () => {
	// Two tests, each with its own directory, not one that deletes and recreates
	// the database: a tracker closed in this process lingers until GC, holding
	// the old WAL's shared memory (see tracker-concurrency.test.ts), and a new
	// database at the same path then fails its first open with "disk I/O error".
	test("false on a fresh store", () => {
		const fresh = new FileTracker(dbPath, dir);
		expect(fresh.trackerNeedsV4Schema()).toBe(false);
		fresh.close();
	});

	test("true on a pre-v4 store, and false after the rebuild", () => {
		makeV3Database();
		const old = new FileTracker(dbPath, dir);
		expect(old.trackerNeedsV4Schema()).toBe(true);
		old.rebuildTreeScopedSchemaForV4();
		expect(old.trackerNeedsV4Schema()).toBe(false);
		old.close();
	});

	test("the rebuild empties and reshapes the tree-scoped tables, and keeps the repo-scoped rows", () => {
		makeV3Database();
		const tracker = new FileTracker(dbPath, dir);
		tracker.rebuildTreeScopedSchemaForV4();
		tracker.close();

		expect(columnsOf("files").map((c) => c.name)).toContain("branch_id");
		expect(
			independent((db) => db.prepare("SELECT count(*) AS n FROM files").get()),
		).toEqual({ n: 0 });
		expect(
			independent((db) => db.prepare("SELECT key, value FROM metadata").all()),
		).toEqual([{ key: "embeddingModel", value: "some-model" }]);
		expect(
			independent((db) => db.prepare("SELECT sha, ordinal FROM commits").all()),
		).toEqual([{ sha: "a".repeat(40), ordinal: 3 }]);
		// The other five tree-scoped tables exist again, in this build's shape.
		const tables = independent(
			(db) =>
				db
					.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
					.all() as Array<{ name: string }>,
		).map((t) => t.name);
		for (const table of [
			"documents",
			"indexed_docs",
			"symbols",
			"symbol_references",
			"graph_metadata",
		]) {
			expect(tables).toContain(table);
		}
	});

	test("after the rebuild, (1,'a.ts') and (2,'a.ts') coexist", () => {
		makeV3Database();
		const tracker = new FileTracker(dbPath, dir);
		tracker.rebuildTreeScopedSchemaForV4();
		tracker.close();

		insertTwoBranches();
		expect(
			independent((db) =>
				db
					.prepare(
						"SELECT branch_id FROM files WHERE path = 'a.ts' ORDER BY branch_id",
					)
					.all(),
			),
		).toEqual([{ branch_id: 1 }, { branch_id: 2 }]);
	});

	/**
	 * The control that keeps the assertion above honest. The file's own
	 * migration idiom, `ALTER TABLE … ADD COLUMN`, gives `files` a `branch_id`,
	 * but the key stays `(path)`, so the second branch's row is REFUSED here
	 * (and REPLACES the first under `INSERT OR REPLACE`, which is how that
	 * idiom would have shipped silent mass deletion).
	 */
	test("control: ADD COLUMN instead of the DROP pass keeps the key at (path) and refuses the second row", () => {
		makeV3Database();
		independent((db) =>
			db.exec(
				"ALTER TABLE files ADD COLUMN branch_id INTEGER NOT NULL DEFAULT 0",
			),
		);
		expect(() => insertTwoBranches()).toThrow(/UNIQUE constraint failed/);
	});
});

describe("markIndexed writes the branch id it is given, and nothing else is a branch id", () => {
	test("anything that is not a safe integer >= 0 is refused before any write", () => {
		const tracker = new FileTracker(dbPath, dir);
		const markAs = (branchId: unknown) => () =>
			tracker.markIndexed(branchId as number, join(dir, "a.ts"), "h", []);
		// A stale call site passing the old first argument, a path.
		expect(markAs(join(dir, "a.ts"))).toThrow(RangeError);
		expect(markAs(-1)).toThrow(RangeError);
		expect(markAs(1.5)).toThrow(RangeError);
		expect(markAs(Number.NaN)).toThrow(RangeError);
		tracker.close();
		expect(
			independent((db) => db.prepare("SELECT count(*) AS n FROM files").get()),
		).toEqual({ n: 0 });
	});

	test("the row carries the id, and an mtime refresh finds it by its own key", () => {
		const file = join(dir, "src", "a.ts");
		mkdirSync(join(dir, "src"));
		writeFileSync(file, "export const a = 1;\n");
		const tracker = new FileTracker(dbPath, dir);
		// The hash getChanges will compute, so the refresh branch is the one taken.
		const { createHash } =
			require("node:crypto") as typeof import("node:crypto");
		const hash = createHash("sha256")
			.update("export const a = 1;\n")
			.digest("hex");
		tracker.markIndexed(4, file, hash, ["c1"]);

		const later = statSync(file).mtimeMs / 1000 + 60;
		utimesSync(file, later, later);
		const changes = tracker.getChanges(4, [file]);
		tracker.close();

		expect(changes.unchangedFiles).toEqual([file]);
		const row = independent((db) =>
			db.prepare("SELECT branch_id, path, mtime FROM files").get(),
		) as { branch_id: number; path: string; mtime: number };
		expect(row.branch_id).toBe(4);
		expect(row.path).toBe("src/a.ts");
		expect(Math.round(row.mtime)).toBe(Math.round(statSync(file).mtimeMs));
	});
});

describe("stored paths do not depend on the caller's spelling or the process cwd", () => {
	test("a file is stored relative to the path root, and a missing one comes back as a stored path", () => {
		const tracker = new FileTracker(dbPath, dir);
		tracker.markIndexed(0, join(dir, "src", "a.ts"), "h", []);
		tracker.markIndexed(0, join(dir, "src", "gone.ts"), "h", []);
		const changes = tracker.getChanges(0, [join(dir, "src", "a.ts")]);
		tracker.close();

		expect(
			independent((db) =>
				db.prepare("SELECT path FROM files ORDER BY path").all(),
			),
		).toEqual([{ path: "src/a.ts" }, { path: "src/gone.ts" }]);
		expect(changes.deletedFiles).toEqual(["src/gone.ts"]);
	});

	/**
	 * `relative(root, "src/a.ts")` resolved a relative argument against the
	 * PROCESS cwd, so `getChunkIds(deletedFile)` returned [] whenever the cwd
	 * was not the project root, and the indexer's deleted-files loop then
	 * skipped the LanceDB delete altogether: a second road to the ghost-chunk
	 * defect. A stored (relative) argument is now taken as stored.
	 */
	test("a stored path argument works from another cwd", () => {
		const tracker = new FileTracker(dbPath, dir);
		tracker.markIndexed(0, join(dir, "src", "a.ts"), "h", ["c1", "c2"]);
		const elsewhere = mkdtempSync(join(tmpdir(), "tracker-branch-id-cwd-"));
		const cwd = process.cwd();
		process.chdir(elsewhere);
		try {
			expect(tracker.getChunkIds(0, "src/a.ts")).toEqual(["c1", "c2"]);
			tracker.removeFile(0, "src/a.ts");
		} finally {
			process.chdir(cwd);
			rmSync(elsewhere, { recursive: true, force: true });
		}
		tracker.close();
		expect(
			independent((db) => db.prepare("SELECT count(*) AS n FROM files").get()),
		).toEqual({ n: 0 });
	});
});
