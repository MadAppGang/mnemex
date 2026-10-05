/**
 * Tests for commit provenance in the file tracker.
 *
 * The index has no anchor to the commit it describes, so nothing can answer
 * "which of these two competing facts is newer" without asking a model to
 * reason about recency. These tests pin the storage layer that makes the
 * question answerable: a `commits` table with an orderable ordinal, plus
 * nullable provenance columns on `files` and `documents`.
 *
 * The load-bearing rule is that NULL means "provenance unknown" and unknown is
 * CURRENTLY VALID. Every index written before this existed has NULL everywhere;
 * if NULL read as invalid, those indexes would silently return nothing.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

/** Every row this file writes and reads lives on one branch. */
const BRANCH = 0;

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabaseSync } from "../../../src/core/sqlite.js";
import { FileTracker, resolveHeadCommit } from "../../../src/core/tracker.js";

let workDir: string;

beforeEach(() => {
	workDir = mkdtempSync(join(tmpdir(), "mnemex-provenance-"));
});

afterEach(() => {
	rmSync(workDir, { recursive: true, force: true });
});

/** Column names of a table, in declaration order, duplicates preserved */
function columnNames(dbPath: string, table: string): string[] {
	const db = createDatabaseSync(dbPath);
	try {
		const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
			name: string;
		}>;
		return rows.map((r) => r.name);
	} finally {
		db.close();
	}
}

function countOf(values: string[], target: string): number {
	return values.filter((v) => v === target).length;
}

describe("schema migration", () => {
	test("is idempotent — running it twice adds each column exactly once", () => {
		const dbPath = join(workDir, "index.db");

		const first = new FileTracker(dbPath, workDir);
		first.close();

		// Second open re-runs initializeSchema + migrateSchema against a db that
		// already has everything. Must not throw and must not duplicate columns.
		const second = new FileTracker(dbPath, workDir);
		second.close();

		const fileColumns = columnNames(dbPath, "files");
		const documentColumns = columnNames(dbPath, "documents");

		expect(countOf(fileColumns, "indexed_at_commit")).toBe(1);
		expect(countOf(documentColumns, "valid_from_commit")).toBe(1);
		expect(countOf(documentColumns, "invalidated_at_commit")).toBe(1);
	});

	test("creates the commits table with an ordinal index", () => {
		const dbPath = join(workDir, "index.db");
		const tracker = new FileTracker(dbPath, workDir);
		tracker.close();

		expect(columnNames(dbPath, "commits").sort()).toEqual([
			"committed_at",
			"ordinal",
			"sha",
		]);

		const db = createDatabaseSync(dbPath);
		const indexes = db
			.prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
			.all() as Array<{ name: string }>;
		db.close();

		expect(indexes.map((i) => i.name)).toContain("idx_commits_ordinal");
	});

	/**
	 * CHANGED BY PHASE 3b-1, deliberately, and the change is the point.
	 *
	 * It used to assert that legacy rows "stay valid" — read back through the
	 * ordinary accessors after the column migration. Under index version 4 that
	 * is no longer true and must not be asserted: every tree-scoped statement
	 * carries `branch_id`, and a pre-v4 `files`/`documents` has no such column,
	 * so those reads THROW rather than return a legacy row. Nothing here
	 * regressed — §6 makes the v4 upgrade a REBUILD, which drops those tables
	 * outright, so "the legacy row survives and is readable" was never going to
	 * be true of a v4 store.
	 *
	 * What is still true, and still worth pinning, is everything the rebuild
	 * depends on: the open SUCCEEDS over the old shape (R0 must not fail, or
	 * §6.1's signal could never be read), the ALTER-based column migration still
	 * runs, and the tracker REPORTS the old shape.
	 */
	test("opens a database created at the old schema, migrates its columns, and reports that it needs the v4 rebuild", () => {
		const dbPath = join(workDir, "index.db");

		// Build the pre-provenance schema by hand — no commits table, and no
		// provenance columns on files or documents.
		const legacy = createDatabaseSync(dbPath);
		legacy.exec(`
			CREATE TABLE files (
				path TEXT PRIMARY KEY,
				content_hash TEXT NOT NULL,
				mtime REAL NOT NULL,
				chunk_ids TEXT NOT NULL,
				indexed_at TEXT NOT NULL,
				enrichment_state TEXT DEFAULT '{}',
				enriched_at TEXT
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
		legacy
			.prepare(
				"INSERT INTO files (path, content_hash, mtime, chunk_ids, indexed_at) VALUES (?, ?, ?, ?, ?)",
			)
			.run(
				"src/legacy.ts",
				"hash-legacy",
				1234,
				'["c1"]',
				"2024-01-01T00:00:00Z",
			);
		legacy
			.prepare(
				"INSERT INTO documents (id, document_type, file_path, source_ids, created_at) VALUES (?, ?, ?, ?, ?)",
			)
			.run(
				"doc-legacy",
				"file_summary",
				"src/legacy.ts",
				'["c1"]',
				"2024-01-01T00:00:00Z",
			);
		legacy.close();

		const tracker = new FileTracker(dbPath, workDir);

		// Columns arrived.
		expect(columnNames(dbPath, "files")).toContain("indexed_at_commit");
		expect(columnNames(dbPath, "documents")).toContain("valid_from_commit");
		expect(columnNames(dbPath, "documents")).toContain("invalidated_at_commit");

		// The old rows are still THERE — read with no branch predicate, through
		// the same connection. Nothing was destroyed by opening.
		expect(
			(
				tracker
					.getDatabase()
					.prepare("SELECT COUNT(*) AS n FROM documents")
					.get() as { n: number }
			).n,
		).toBe(1);

		// And the tracker says the shape is pre-v4, which is what routes this
		// store into `rebuildTreeScopedSchemaForV4()` (§6.1's third signal).
		expect(tracker.trackerNeedsV4Schema()).toBe(true);

		// The scoped accessors cannot read the old shape — the column is not
		// there. Asserted, rather than left implicit, because it is the reason
		// the upgrade is a rebuild and not an in-place migration.
		expect(() => tracker.getFileIndexedCommit(BRANCH, "src/legacy.ts")).toThrow(
			/branch_id/,
		);

		// After the rebuild the shape is current, and the old rows are gone —
		// §6's stated cost, asserted rather than assumed.
		tracker.rebuildTreeScopedSchemaForV4();
		expect(tracker.trackerNeedsV4Schema()).toBe(false);
		expect(tracker.getFileIndexedCommit(BRANCH, "src/legacy.ts")).toBeNull();
		expect(tracker.getDocumentProvenance(BRANCH, "doc-legacy")).toBeNull();
		expect(
			tracker.getDocumentsForFile(BRANCH, join(workDir, "src/legacy.ts")),
		).toHaveLength(0);

		tracker.close();
	});
});

describe("commits table", () => {
	test("recording the same sha twice upserts instead of duplicating", () => {
		const dbPath = join(workDir, "index.db");
		const tracker = new FileTracker(dbPath, workDir);

		const sha = "a".repeat(40);
		tracker.recordCommit(sha, 41, "2024-01-01T00:00:00Z");
		// Same sha again — must not throw on the primary key.
		expect(() =>
			tracker.recordCommit(sha, 42, "2024-02-02T00:00:00Z"),
		).not.toThrow();

		const db = tracker.getDatabase();
		const row = db
			.prepare("SELECT COUNT(*) as count FROM commits WHERE sha = ?")
			.get(sha) as { count: number };
		expect(row.count).toBe(1);

		// The re-record wins.
		expect(tracker.getCommitOrdinal(sha)).toBe(42);

		tracker.close();
	});

	test("a re-record without a timestamp keeps the one already stored", () => {
		const dbPath = join(workDir, "index.db");
		const tracker = new FileTracker(dbPath, workDir);

		const sha = "b".repeat(40);
		tracker.recordCommit(sha, 7, "2024-03-03T00:00:00Z");
		tracker.recordCommit(sha, 7, null);

		const row = tracker
			.getDatabase()
			.prepare("SELECT committed_at FROM commits WHERE sha = ?")
			.get(sha) as { committed_at: string | null };
		expect(row.committed_at).toBe("2024-03-03T00:00:00Z");

		tracker.close();
	});

	test("ordinal lookup returns null for an unknown sha", () => {
		const dbPath = join(workDir, "index.db");
		const tracker = new FileTracker(dbPath, workDir);

		expect(tracker.getCommitOrdinal("c".repeat(40))).toBeNull();

		// Recording a different sha does not make the unknown one resolvable.
		tracker.recordCommit("d".repeat(40), 1, null);
		expect(tracker.getCommitOrdinal("c".repeat(40))).toBeNull();

		tracker.close();
	});

	test("ordinals are orderable even though shas are not", () => {
		const dbPath = join(workDir, "index.db");
		const tracker = new FileTracker(dbPath, workDir);

		const older = "f".repeat(40);
		const newer = "0".repeat(40);
		tracker.recordCommit(older, 10, null);
		tracker.recordCommit(newer, 20, null);

		// Lexicographic sha comparison would pick the wrong one; the ordinal
		// is the entire reason this table exists.
		expect(newer < older).toBe(true);
		expect(tracker.getCommitOrdinal(newer) ?? 0).toBeGreaterThan(
			tracker.getCommitOrdinal(older) ?? 0,
		);

		tracker.close();
	});
});

describe("provenance stamping", () => {
	test("documents written while a commit is current carry it", () => {
		const dbPath = join(workDir, "index.db");
		const tracker = new FileTracker(dbPath, workDir);

		const sha = "e".repeat(40);
		tracker.recordCommit(sha, 5, null);
		tracker.setCurrentCommit(sha);

		tracker.trackDocument(BRANCH, {
			id: "doc-1",
			documentType: "file_summary",
			filePath: "src/a.ts",
			sourceIds: ["c1"],
			createdAt: new Date().toISOString(),
		});

		const provenance = tracker.getDocumentProvenance(BRANCH, "doc-1");
		expect(provenance?.validFromCommit).toBe(sha);
		expect(provenance?.isValid).toBe(true);

		tracker.close();
	});

	test("setDocumentsValidFromCommit stamps existing documents and ignores unknown ids", () => {
		const dbPath = join(workDir, "index.db");
		const tracker = new FileTracker(dbPath, workDir);

		tracker.trackDocument(BRANCH, {
			id: "doc-2",
			documentType: "file_summary",
			filePath: "src/b.ts",
			sourceIds: [],
			createdAt: new Date().toISOString(),
		});
		expect(
			tracker.getDocumentProvenance(BRANCH, "doc-2")?.validFromCommit,
		).toBeNull();

		const sha = "1".repeat(40);
		expect(() =>
			tracker.setDocumentsValidFromCommit(
				BRANCH,
				["doc-2", "does-not-exist"],
				sha,
			),
		).not.toThrow();

		expect(
			tracker.getDocumentProvenance(BRANCH, "doc-2")?.validFromCommit,
		).toBe(sha);
		expect(tracker.getDocumentProvenance(BRANCH, "does-not-exist")).toBeNull();

		tracker.close();
	});

	test("setFileIndexedCommit stamps a tracked file", () => {
		const dbPath = join(workDir, "index.db");
		const tracker = new FileTracker(dbPath, workDir);

		const filePath = join(workDir, "src", "c.ts");
		tracker.markIndexed(0, filePath, "hash-c", ["c1"]);
		expect(tracker.getFileIndexedCommit(BRANCH, filePath)).toBeNull();

		const sha = "2".repeat(40);
		tracker.setFileIndexedCommit(BRANCH, filePath, sha);
		expect(tracker.getFileIndexedCommit(BRANCH, filePath)).toBe(sha);

		tracker.close();
	});

	test("markIndexed stamps the run's commit without a per-file git call", () => {
		const dbPath = join(workDir, "index.db");
		const tracker = new FileTracker(dbPath, workDir);

		const sha = "3".repeat(40);
		tracker.setCurrentCommit(sha);

		tracker.markIndexed(0, join(workDir, "src", "d.ts"), "hash-d", ["c1"]);
		tracker.markIndexed(0, join(workDir, "src", "e.ts"), "hash-e", ["c2"]);

		expect(
			tracker.getFileIndexedCommit(BRANCH, join(workDir, "src", "d.ts")),
		).toBe(sha);
		expect(
			tracker.getFileIndexedCommit(BRANCH, join(workDir, "src", "e.ts")),
		).toBe(sha);

		tracker.close();
	});
});

describe("HEAD resolution outside a git repository", () => {
	test("resolveHeadCommit returns null instead of throwing", async () => {
		// mkdtemp lands under the OS temp root, which is not inside any repo.
		const resolved = await resolveHeadCommit(workDir);
		expect(resolved).toBeNull();
	});

	test("resolveHeadCommit returns null for a path that does not exist", async () => {
		const resolved = await resolveHeadCommit(
			join(workDir, "no", "such", "dir"),
		);
		expect(resolved).toBeNull();
	});

	test("recordHeadCommit degrades to NULL provenance and indexing still works", async () => {
		const dbPath = join(workDir, "index.db");
		const tracker = new FileTracker(dbPath, workDir);

		const head = await tracker.recordHeadCommit();
		expect(head).toBeNull();
		expect(tracker.getCurrentCommit()).toBeNull();

		// No commit was invented for the non-git project.
		const commitCount = tracker
			.getDatabase()
			.prepare("SELECT COUNT(*) as count FROM commits")
			.get() as { count: number };
		expect(commitCount.count).toBe(0);

		// The write path still works; it just records unknown provenance.
		const filePath = join(workDir, "src", "f.ts");
		expect(() =>
			tracker.markIndexed(0, filePath, "hash-f", ["c1"]),
		).not.toThrow();
		expect(tracker.getFileIndexedCommit(BRANCH, filePath)).toBeNull();

		tracker.trackDocument(BRANCH, {
			id: "doc-3",
			documentType: "file_summary",
			filePath: "src/f.ts",
			sourceIds: ["c1"],
			createdAt: new Date().toISOString(),
		});
		const provenance = tracker.getDocumentProvenance(BRANCH, "doc-3");
		expect(provenance?.validFromCommit).toBeNull();
		// Unknown provenance must not hide the document.
		expect(provenance?.isValid).toBe(true);

		tracker.close();
	});
});

describe("HEAD resolution inside a git repository", () => {
	test("resolves this repo's HEAD to a sha and a positive ordinal", async () => {
		const resolved = await resolveHeadCommit(process.cwd());

		if (resolved === null) {
			throw new Error("expected this repo's HEAD to resolve");
		}
		expect(resolved.sha).toMatch(/^[0-9a-f]{40}$/);
		expect(resolved.ordinal).toBeGreaterThan(0);
		expect(Number.isInteger(resolved.ordinal)).toBe(true);
	});

	test("recordHeadCommit writes an anchor whose ordinal is retrievable", async () => {
		const dbPath = join(workDir, "index.db");
		// projectRoot is the temp dir for storage, but HEAD is resolved from the
		// tracker's project root — so point the tracker at the repo itself.
		const tracker = new FileTracker(dbPath, process.cwd());

		const head = await tracker.recordHeadCommit();
		if (head === null) {
			throw new Error("expected this repo's HEAD to resolve");
		}
		expect(tracker.getCurrentCommit()).toBe(head.sha);
		expect(tracker.getCommitOrdinal(head.sha)).toBe(head.ordinal);

		// Recording the same HEAD again (a second indexing run) is a no-op.
		await tracker.recordHeadCommit();
		const count = tracker
			.getDatabase()
			.prepare("SELECT COUNT(*) as count FROM commits")
			.get() as { count: number };
		expect(count.count).toBe(1);

		tracker.close();
	});
});
