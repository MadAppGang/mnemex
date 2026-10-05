/**
 * I-12 RULING 2 — `idx_files_path`, pinned as a query PLAN.
 *
 * Under the v4 key `PRIMARY KEY (branch_id, path)`, a lookup that names only
 * the path cannot use the key: SQLite needs an equality on the LEADING column
 * first. Measured by Phase 3a-2 on a 20 000-row table: 2.5 ms per unscoped call
 * against 0.003 ms scoped, about 900x.
 *
 * It would be tempting to answer that with "so scope every lookup", and the
 * rest of this phase does exactly that. But path-only lookups exist in the END
 * state, by design and not as a migration artefact: D1's unknown-branch
 * fallback (§4.4.2) drops the branch filter, because returning nothing on a
 * newly created branch fails INVISIBLY. So the scan would be permanent, on the
 * path a `git checkout -b` makes common. Ruling 2: add the index.
 *
 * WHY A PLAN AND NOT A STOPWATCH. `EXPLAIN QUERY PLAN` is deterministic and
 * independent of machine load, and it names the ACCESS PATH, which is the thing
 * the ruling is about. A timing assertion on this machine flaked at load
 * average 68 (`tracker-resolve-plan.test.ts` records that).
 *
 * FALSIFIED BY dropping the index: the unscoped plan must regress to
 * `SCAN files`. That falsification runs below, on the same database, so a plan
 * assertion that had stopped distinguishing anything cannot pass quietly.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabaseSync } from "../../../src/core/sqlite.js";
import { FileTracker } from "../../../src/core/tracker.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function openTracker(): FileTracker {
	const root = mkdtempSync(join(tmpdir(), "tracker-files-path-plan-"));
	tempDirs.push(root);
	return new FileTracker(join(root, "index.db"), root);
}

interface PlanRow {
	detail: string;
}

function planOf(tracker: FileTracker, sql: string, ...params: unknown[]) {
	return (
		tracker
			.getDatabase()
			.prepare(`EXPLAIN QUERY PLAN ${sql}`)
			.all(...params) as PlanRow[]
	).map((row) => row.detail);
}

/** Enough rows that the planner has something to prefer an index for. */
function seed(tracker: FileTracker): void {
	for (let branch = 1; branch <= 3; branch++) {
		for (let i = 0; i < 200; i++) {
			tracker.markIndexed(branch, `src/f${i}.ts`, `hash-${branch}-${i}`, [
				`c${i}`,
			]);
		}
	}
}

const SCOPED = "SELECT chunk_ids FROM files WHERE branch_id = ? AND path = ?";
const UNSCOPED = "SELECT chunk_ids FROM files WHERE path = ?";

describe("I-12 Ruling 2 — the files(path) index", () => {
	test("an UNSCOPED path lookup uses idx_files_path", () => {
		const tracker = openTracker();
		seed(tracker);
		const plan = planOf(tracker, UNSCOPED, "src/f7.ts");
		console.log(`unscoped plan: ${plan.join(" / ")}`);
		expect(plan).toEqual(["SEARCH files USING INDEX idx_files_path (path=?)"]);
		tracker.close();
	});

	test("a SCOPED lookup still uses the primary key", () => {
		const tracker = openTracker();
		seed(tracker);
		const plan = planOf(tracker, SCOPED, 2, "src/f7.ts");
		console.log(`scoped plan: ${plan.join(" / ")}`);
		expect(plan).toEqual([
			"SEARCH files USING INDEX sqlite_autoindex_files_1 (branch_id=? AND path=?)",
		]);
		tracker.close();
	});

	test("both plans return the right rows, so the index changed the path and not the answer", () => {
		const tracker = openTracker();
		seed(tracker);
		const db = tracker.getDatabase();

		// Scoped: exactly one row, this branch's.
		expect(db.prepare(SCOPED).all(2, "src/f7.ts")).toEqual([
			{ chunk_ids: '["c7"]' },
		]);
		// Unscoped: the superset — one row per branch that has the path. This is
		// what D1's fallback reads, and why it needs an index of its own.
		expect(db.prepare(UNSCOPED).all("src/f7.ts")).toHaveLength(3);

		tracker.close();
	});

	test("FALSIFIER: with idx_files_path dropped, the unscoped lookup is a full SCAN", () => {
		const root = mkdtempSync(
			join(tmpdir(), "tracker-files-path-plan-falsify-"),
		);
		tempDirs.push(root);
		const dbPath = join(root, "index.db");
		const tracker = new FileTracker(dbPath, root);
		seed(tracker);
		tracker.close();

		// INDEPENDENT, short-lived connections: the tracker re-creates the index
		// on every open (`CREATE INDEX IF NOT EXISTS`), so the drop has to
		// outlive it — and an EXPLAIN statement still alive on a connection locks
		// the table against a DDL statement on that same connection.
		const planOn = (): string[] => {
			const db = createDatabaseSync(dbPath);
			try {
				return (
					db
						.prepare(`EXPLAIN QUERY PLAN ${UNSCOPED}`)
						.all("src/f7.ts") as PlanRow[]
				).map((r) => r.detail);
			} finally {
				db.close();
			}
		};

		expect(planOn()[0]).toContain("idx_files_path");

		const ddl = createDatabaseSync(dbPath);
		try {
			ddl.exec("DROP INDEX idx_files_path");
		} finally {
			ddl.close();
		}

		const after = planOn();
		console.log(`falsifier plan (index dropped): ${after.join(" / ")}`);
		expect(after).toEqual(["SCAN files"]);
	});
});
