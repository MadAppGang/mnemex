/**
 * FileTracker schema memo.
 *
 * A FileTracker is constructed per MCP tool request, and its constructor used to
 * re-issue the entire schema pass every time: 5 `CREATE TABLE IF NOT EXISTS` +
 * 9 `CREATE INDEX IF NOT EXISTS` + the migration's `PRAGMA table_info` probes.
 * All idempotent, so the only cost was time — ~315 µs warm, against a ~31 µs
 * sqlite open.
 *
 * These tests count actual DDL statements (createDatabaseSync is module-mocked
 * with a counting pass-through, the same device the learning-gate tests use) and
 * assert the contract of the memo:
 *   - same database file  => the schema pass runs ONCE per process
 *   - different files     => each gets its own pass
 *   - in-memory databases => NEVER memoized, each gets its own pass, both work
 *   - an old-schema database still migrates, even after another database was
 *     already opened in this process
 *   - the memo is resettable, restoring from-scratch behaviour
 *
 * The optimization must be invisible except in timing: every assertion below is
 * about a database ending up correctly schema'd.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Module mock ─────────────────────────────────────────────────────────────
// The real opener is captured by value BEFORE the mock is registered, so the
// counting wrapper delegates to it instead of recursing into itself.
const realCreateDatabaseSync = (await import("../../../src/core/sqlite.js"))
	.createDatabaseSync;

/** Every `exec`'d SQL string since the last reset, paired with its db path. */
let sqliteExecs: Array<{ path: string; sql: string }> = [];

/** Every `prepare`'d SQL string since the last reset, paired with its db path. */
let sqlitePrepares: Array<{ path: string; sql: string }> = [];

mock.module("../../../src/core/sqlite.js", () => ({
	createDatabaseSync: (path: string) => {
		const db = realCreateDatabaseSync(path);
		return {
			...db,
			exec: (sql: string) => {
				sqliteExecs.push({ path, sql });
				return db.exec(sql);
			},
			prepare: (sql: string) => {
				sqlitePrepares.push({ path, sql });
				return db.prepare(sql);
			},
		};
	},
}));

// Imported AFTER the mock so it picks up the counting sqlite opener.
const { FileTracker, resetTrackerSchemaCache } = await import(
	"../../../src/core/tracker.js"
);

// ── Helpers ─────────────────────────────────────────────────────────────────

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "tracker-schema-memo-"));
	tempDirs.push(dir);
	return dir;
}

/**
 * How many times the core schema pass was issued against this path.
 *
 * Counts `exec`s, not tables: the whole `files`/`metadata`/`documents`/
 * `indexed_docs`/`commits` block goes out as one statement batch, so 1 means
 * "applied once".
 */
function tableDdlCount(path: string): number {
	return sqliteExecs.filter(
		(e) =>
			e.path === path && e.sql.includes("CREATE TABLE IF NOT EXISTS files"),
	).length;
}

/** How many times the symbol-graph schema pass was issued against this path. */
function symbolDdlCount(path: string): number {
	return sqliteExecs.filter(
		(e) =>
			e.path === path && e.sql.includes("CREATE TABLE IF NOT EXISTS symbols"),
	).length;
}

/** How many times the migration probed columns against this path. */
function migrationProbeCount(path: string): number {
	return sqlitePrepares.filter(
		(p) => p.path === path && p.sql.startsWith("PRAGMA table_info"),
	).length;
}

/** Column names of a table, read through a fresh raw connection. */
function columnsOf(dbPath: string, table: string): string[] {
	const db = realCreateDatabaseSync(dbPath);
	try {
		const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
			name: string;
		}>;
		return rows.map((r) => r.name);
	} finally {
		db.close();
	}
}

/** Table names present in a database, read through a fresh raw connection. */
function tablesOf(dbPath: string): string[] {
	const db = realCreateDatabaseSync(dbPath);
	try {
		const rows = db
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
			.all() as Array<{ name: string }>;
		return rows.map((r) => r.name);
	} finally {
		db.close();
	}
}

/**
 * A database as an older mnemex left it: `files` and `documents` without any of
 * the columns later migrations add, and no symbol graph at all.
 */
function makeOldSchemaDatabase(dbPath: string): void {
	const db = realCreateDatabaseSync(dbPath);
	try {
		db.exec(`
			CREATE TABLE files (
				path TEXT PRIMARY KEY,
				content_hash TEXT NOT NULL,
				mtime REAL NOT NULL,
				chunk_ids TEXT NOT NULL,
				indexed_at TEXT NOT NULL
			);

			CREATE TABLE metadata (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			);

			CREATE TABLE documents (
				id TEXT PRIMARY KEY,
				document_type TEXT NOT NULL,
				file_path TEXT,
				source_ids TEXT NOT NULL DEFAULT '[]',
				created_at TEXT NOT NULL,
				enriched_at TEXT
			);
		`);
	} finally {
		db.close();
	}
}

beforeEach(() => {
	sqliteExecs = [];
	sqlitePrepares = [];
	resetTrackerSchemaCache();
});

afterEach(() => {
	resetTrackerSchemaCache();
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) {
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				// best effort
			}
		}
	}
});

// ── The memo ────────────────────────────────────────────────────────────────

describe("FileTracker schema memo", () => {
	test("two trackers over the SAME database file run the DDL once", () => {
		const root = makeTempDir();
		const dbPath = join(root, "index.db");

		const first = new FileTracker(dbPath, root);
		expect(tableDdlCount(dbPath)).toBe(1);
		expect(symbolDdlCount(dbPath)).toBe(1);
		expect(migrationProbeCount(dbPath)).toBeGreaterThan(0);
		first.close();

		const probesAfterFirst = migrationProbeCount(dbPath);

		const second = new FileTracker(dbPath, root);
		expect(tableDdlCount(dbPath)).toBe(1);
		expect(symbolDdlCount(dbPath)).toBe(1);
		expect(migrationProbeCount(dbPath)).toBe(probesAfterFirst);

		// Invisible except in timing: the second tracker is fully usable.
		second.setMetadata("k", "v");
		expect(second.getMetadata("k")).toBe("v");
		second.close();
	});

	test("a tracker opened by a relative path shares the memo with the absolute one", () => {
		const root = makeTempDir();
		const dbPath = join(root, "index.db");

		const first = new FileTracker(dbPath, root);
		first.close();
		expect(tableDdlCount(dbPath)).toBe(1);

		// sqlite reports the canonical path for `main`, so an alternative spelling
		// of the same file resolves onto the same memo entry.
		const cwd = process.cwd();
		process.chdir(root);
		try {
			const second = new FileTracker("./index.db", root);
			second.setMetadata("k", "v");
			expect(second.getMetadata("k")).toBe("v");
			second.close();
		} finally {
			process.chdir(cwd);
		}

		expect(tableDdlCount("./index.db")).toBe(0);
	});

	test("two trackers over DIFFERENT database files each run their own DDL", () => {
		const rootA = makeTempDir();
		const rootB = makeTempDir();
		const dbA = join(rootA, "index.db");
		const dbB = join(rootB, "index.db");

		const a = new FileTracker(dbA, rootA);
		const b = new FileTracker(dbB, rootB);

		expect(tableDdlCount(dbA)).toBe(1);
		expect(tableDdlCount(dbB)).toBe(1);
		expect(symbolDdlCount(dbA)).toBe(1);
		expect(symbolDdlCount(dbB)).toBe(1);

		a.setMetadata("k", "a");
		b.setMetadata("k", "b");
		expect(a.getMetadata("k")).toBe("a");
		expect(b.getMetadata("k")).toBe("b");

		a.close();
		b.close();
	});

	test("every :memory: tracker runs its own DDL, and both databases work", () => {
		const root = makeTempDir();

		const first = new FileTracker(":memory:", root);
		const second = new FileTracker(":memory:", root);

		// Asserted BEFORE the counts because this is the hazard the exclusion
		// exists for: each in-memory database is a distinct, private, empty
		// database, so memoizing them would hand the second one an unschema'd
		// database and this line would throw "no such table: metadata".
		first.setMetadata("k", "first");
		second.setMetadata("k", "second");
		expect(first.getMetadata("k")).toBe("first");
		expect(second.getMetadata("k")).toBe("second");

		expect(tableDdlCount(":memory:")).toBe(2);
		expect(symbolDdlCount(":memory:")).toBe(2);

		// ...and they really are separate databases, not one shared one.
		expect(first.getMetadata("k")).not.toBe(second.getMetadata("k"));

		first.close();
		second.close();
	});

	test("a third :memory: tracker still gets a schema after a file-backed one", () => {
		const root = makeTempDir();
		const dbPath = join(root, "index.db");

		const onDisk = new FileTracker(dbPath, root);
		onDisk.close();

		const inMemory = new FileTracker(":memory:", root);
		expect(tableDdlCount(":memory:")).toBe(1);
		inMemory.setMetadata("k", "v");
		expect(inMemory.getMetadata("k")).toBe("v");
		inMemory.close();
	});

	// ── Correctness bar ───────────────────────────────────────────────────────

	test("a brand-new database file ends up fully schema'd", () => {
		const root = makeTempDir();
		const dbPath = join(root, "index.db");

		const tracker = new FileTracker(dbPath, root);
		tracker.close();

		const tables = tablesOf(dbPath);
		for (const expected of [
			"files",
			"metadata",
			"documents",
			"indexed_docs",
			"commits",
			"activity_log",
			"symbols",
			"symbol_references",
			"graph_metadata",
		]) {
			expect(tables).toContain(expected);
		}
		expect(columnsOf(dbPath, "files")).toContain("indexed_at_commit");
		expect(columnsOf(dbPath, "documents")).toContain("stale_at_commit");
	});

	test("an existing current-schema database is unchanged by a second open", () => {
		const root = makeTempDir();
		const dbPath = join(root, "index.db");

		const first = new FileTracker(dbPath, root);
		first.setMetadata("k", "v");
		first.close();

		const before = tablesOf(dbPath).sort();

		const second = new FileTracker(dbPath, root);
		expect(second.getMetadata("k")).toBe("v");
		second.close();

		expect(tablesOf(dbPath).sort()).toEqual(before);
	});

	test("an OLD-schema database still migrates after another database was opened", () => {
		const otherRoot = makeTempDir();
		const oldRoot = makeTempDir();
		const otherDb = join(otherRoot, "index.db");
		const oldDb = join(oldRoot, "index.db");

		// Prime the memo with a completely different database first.
		const other = new FileTracker(otherDb, otherRoot);
		other.close();

		makeOldSchemaDatabase(oldDb);
		expect(columnsOf(oldDb, "files")).not.toContain("enrichment_state");
		expect(columnsOf(oldDb, "documents")).not.toContain("valid_from_commit");

		const migrated = new FileTracker(oldDb, oldRoot);

		// The memo must not have skipped the migration for a database this process
		// had not seen.
		expect(tableDdlCount(oldDb)).toBe(1);
		expect(migrationProbeCount(oldDb)).toBeGreaterThan(0);

		const fileColumns = columnsOf(oldDb, "files");
		expect(fileColumns).toContain("enrichment_state");
		expect(fileColumns).toContain("enriched_at");
		expect(fileColumns).toContain("indexed_at_commit");

		const documentColumns = columnsOf(oldDb, "documents");
		expect(documentColumns).toContain("valid_from_commit");
		expect(documentColumns).toContain("invalidated_at_commit");
		expect(documentColumns).toContain("stale_at_commit");

		// Tables the old database never had are created too.
		expect(tablesOf(oldDb)).toContain("commits");
		expect(tablesOf(oldDb)).toContain("symbols");

		// It is usable once it has the index-v4 shape. A pre-v4 `files` has no
		// `branch_id` and no ALTER can give it the v4 primary key, so every v4
		// write goes through the §3.5.1 DROP pass first. That is what the indexer
		// does on this signal, and the memo must not hide the signal either.
		expect(migrated.trackerNeedsV4Schema()).toBe(true);
		migrated.rebuildTreeScopedSchemaForV4();
		expect(migrated.trackerNeedsV4Schema()).toBe(false);
		migrated.setCurrentCommit("a".repeat(40));
		migrated.markIndexed(0, join(oldRoot, "src.ts"), "hash-1", ["chunk-1"]);
		expect(migrated.getFileIndexedCommit(0, "src.ts")).toBe("a".repeat(40));
		migrated.close();
	});

	// ── Reset ─────────────────────────────────────────────────────────────────

	test("resetTrackerSchemaCache restores from-scratch behaviour", () => {
		const root = makeTempDir();
		const dbPath = join(root, "index.db");

		new FileTracker(dbPath, root).close();
		new FileTracker(dbPath, root).close();
		expect(tableDdlCount(dbPath)).toBe(1);

		resetTrackerSchemaCache();

		new FileTracker(dbPath, root).close();
		expect(tableDdlCount(dbPath)).toBe(2);
		expect(symbolDdlCount(dbPath)).toBe(2);
	});

	test("a database deleted and recreated at the same path is re-schema'd", () => {
		const root = makeTempDir();
		const dbPath = join(root, "index.db");

		new FileTracker(dbPath, root).close();
		expect(tableDdlCount(dbPath)).toBe(1);

		// The inode is part of the memo key, so a genuinely new file at the same
		// path is a different database.
		rmSync(dbPath, { force: true });

		const rebuilt = new FileTracker(dbPath, root);
		expect(tableDdlCount(dbPath)).toBe(2);
		expect(tablesOf(dbPath)).toContain("files");
		rebuilt.setMetadata("k", "v");
		expect(rebuilt.getMetadata("k")).toBe("v");
		rebuilt.close();
	});
});
