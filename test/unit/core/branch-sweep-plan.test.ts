/**
 * The sweep's page query, pinned as a query PLAN (architecture §4.3, S0).
 *
 * S0 is `WHERE branch_id = :D AND chunk_id > :last ORDER BY chunk_id LIMIT n`,
 * run once per page, and the sweep walks a whole branch one page at a time. It
 * needs ONE access path to serve all three of the branch equality, the id range
 * and the order. `chunk_branches` is `WITHOUT ROWID` keyed
 * `(chunk_id, branch_id)`, and SQLite appends a `WITHOUT ROWID` table's key
 * columns to every index — so `idx_chunk_branches_branch(branch_id)` is really
 * `(branch_id, chunk_id)` and does exactly that:
 *
 *   SEARCH chunk_branches USING COVERING INDEX idx_chunk_branches_branch
 *          (branch_id=? AND chunk_id>?)
 *
 * WHAT THE FALSIFIER ACTUALLY SHOWS, measured rather than assumed. Dropping the
 * index does NOT produce a sort, and the first draft of this file asserted that
 * it would. SQLite falls back to the PRIMARY KEY, whose leading column is
 * `chunk_id`:
 *
 *   SEARCH chunk_branches USING PRIMARY KEY (chunk_id>?)
 *
 * — ordered, so no `TEMP B-TREE`, and no `SCAN` either. It has simply lost the
 * `branch_id=?` equality: every page then walks every id in the STORE above the
 * cursor and filters, so one branch's sweep costs O(all rows) per page instead
 * of O(page). That is the regression, and it is invisible to an assertion about
 * sorting. So the pin is on the EQUALITY.
 *
 * WHY A PLAN AND NOT A STOPWATCH. `EXPLAIN QUERY PLAN` names the ACCESS PATH
 * and is independent of machine load; a timing assertion on this machine has
 * already flaked at load average 68 (`tracker-resolve-plan.test.ts` records
 * it).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileTracker } from "../../../src/core/tracker.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function openTracker(): FileTracker {
	const root = mkdtempSync(join(tmpdir(), "branch-sweep-plan-"));
	tempDirs.push(root);
	return new FileTracker(join(root, "index.db"), root);
}

const S0 = `SELECT chunk_id FROM chunk_branches
	  WHERE branch_id = ? AND chunk_id > ?
	  ORDER BY chunk_id LIMIT ?`;

function planOf(tracker: FileTracker): string[] {
	return (
		tracker
			.getDatabase()
			.prepare(`EXPLAIN QUERY PLAN ${S0}`)
			.all(2, "", 512) as Array<{ detail: string }>
	).map((row) => row.detail);
}

/** Two branches' worth of membership, so the planner has something to choose. */
function seed(tracker: FileTracker): void {
	const db = tracker.getDatabase();
	const insert = db.prepare(
		"INSERT OR IGNORE INTO chunk_branches (chunk_id, branch_id) VALUES (?, ?)",
	);
	for (let i = 0; i < 2000; i++) {
		insert.run(`${i}`.padStart(16, "0"), 1 + (i % 2));
	}
	db.exec("ANALYZE");
}

describe("the sweep's page query reads a range, and never sorts", () => {
	test("EXPLAIN QUERY PLAN uses the branch index, with no sort", () => {
		const tracker = openTracker();
		try {
			seed(tracker);
			const plan = planOf(tracker).join("\n");
			expect(plan).toContain("idx_chunk_branches_branch");
			// The load-bearing half: the branch equality is served by the index,
			// so a page costs O(page) and not O(every row in the store).
			expect(plan).toContain("branch_id=?");
			expect(plan).toContain("chunk_id>?");
			// And no sort, so the ORDER BY costs nothing per page.
			expect(plan).not.toContain("TEMP B-TREE");
			expect(plan).not.toContain("SCAN chunk_branches");
		} finally {
			tracker.close();
		}
	});

	test("the falsifier: without the index the branch equality is lost", () => {
		const tracker = openTracker();
		try {
			seed(tracker);
			tracker.getDatabase().exec("DROP INDEX idx_chunk_branches_branch");
			const plan = planOf(tracker).join("\n");
			expect(plan).not.toContain("idx_chunk_branches_branch");
			// The regression, exactly: still ordered, still no scan — and no
			// longer restricted to one branch.
			expect(plan).toContain("PRIMARY KEY (chunk_id>?)");
			expect(plan).not.toContain("branch_id=?");
		} finally {
			tracker.close();
		}
	});

	test("the page is KEYSET, not OFFSET: it starts strictly above the last id", () => {
		// An OFFSET would skip exactly as many rows as the previous page deleted.
		// This is the behavioural half of the same property.
		const tracker = openTracker();
		try {
			seed(tracker);
			const first = tracker.membershipPage(1, "", 3);
			expect(first).toHaveLength(3);
			const second = tracker.membershipPage(1, first[2], 3);
			expect(second[0] > first[2]).toBe(true);
			expect(new Set([...first, ...second]).size).toBe(6);
		} finally {
			tracker.close();
		}
	});
});
