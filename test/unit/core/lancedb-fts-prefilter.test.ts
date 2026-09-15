/**
 * LanceDB applies a `.where()` predicate BEFORE top-k, for full-text search as
 * well as for vectors. This file pins that on the installed LanceDB.
 *
 * The branch-membership design (repo-stable dataset, architecture §4.4) scopes
 * every search to a branch at the storage predicate: the same `filters` array
 * that already carries `language` and `pathPattern`, joined into
 * `.where(filterStr)` on both retrievers in `VectorStore.search`. That is
 * correct only if the predicate runs before `limit`. A filter applied after
 * top-k returns FEWER than `limit` rows, and on a branch that owns none of the
 * corpus's best BM25 matches it returns NONE, with no error anywhere.
 *
 * For `vectorSearch`, pre-filtering is the documented default (`postfilter()`
 * is opt-in). For `fullTextSearch`, no method and no docstring says when the
 * predicate applies, so the behaviour was measured (0.38.0) and is pinned
 * here. A LanceDB upgrade that moves the FTS filter after top-k fails this file
 * instead of shipping a silently broken branch filter.
 *
 * Fixture: 100 rows that BM25 ranks HIGH for the term (short document, tf = 3)
 * on branch 1, and 100 it ranks LOW (tf = 1 in a long document) on branch 2.
 * The predicate selects branch 2, so it excludes the entire natural top-n. The
 * precondition tests assert exactly that, which is what stops the main
 * assertions from passing vacuously: with the top-n all excluded, a post-filter
 * would return zero rows.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as lancedb from "@lancedb/lancedb";

const TERM = "widget";
const N = 5;

/** The design's membership predicate shape (§4.4 `branchMembershipFilter`). */
const onBranch = (id: number) =>
	`(branchIds LIKE '%,0,%' OR branchIds LIKE '%,${id},%')`;

interface Row {
	id: string;
	branchIds: string;
}

let dir: string;
let table: lancedb.Table;

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "mnemex-fts-prefilter-"));
	const db = await lancedb.connect(dir);
	const filler = Array.from({ length: 60 }, (_, i) => `filler${i}`).join(" ");
	const rows = [];
	for (let i = 0; i < 100; i++) {
		rows.push({
			id: `high-${i}`,
			content: `${TERM} ${TERM} ${TERM}`,
			branchIds: ",1,",
			vector: [1, 0, 0, 0],
		});
	}
	for (let i = 0; i < 100; i++) {
		rows.push({
			id: `low-${i}`,
			content: `${TERM} ${filler}`,
			branchIds: ",2,",
			vector: [0, 1, 0, 0],
		});
	}
	table = await db.createTable("chunks", rows);
	// The same index configuration `ensureFtsIndex` builds in store.ts.
	await table.createIndex("content", { config: lancedb.Index.fts() });
});

afterAll(() => {
	table?.close();
	rmSync(dir, { recursive: true, force: true });
});

/** store.ts's builder shape: `fullTextSearch(q, { columns }).limit(n)`, then `.where(p)`. */
async function ftsTopK(where?: string): Promise<Row[]> {
	let query = table
		.query()
		.fullTextSearch(TERM, { columns: ["content"] })
		.limit(N);
	if (where) query = query.where(where);
	return (await query.toArray()) as Row[];
}

/** store.ts's builder shape: `vectorSearch(v).limit(n)`, then `.where(p)`. */
async function vectorTopK(where?: string): Promise<Row[]> {
	let query = table.vectorSearch([1, 0, 0, 0]).limit(N);
	if (where) query = query.where(where);
	return (await query.toArray()) as Row[];
}

describe("LanceDB applies .where() before top-k", () => {
	test("precondition: the predicate excludes the ENTIRE natural FTS top-n", async () => {
		const natural = await ftsTopK();
		expect(natural).toHaveLength(N);
		for (const row of natural) expect(row.branchIds).toBe(",1,");
	});

	test("fullTextSearch(t).limit(n).where(p) still returns n rows, all matching p", async () => {
		const rows = await ftsTopK(onBranch(2));
		expect(rows).toHaveLength(N);
		for (const row of rows) expect(row.branchIds).toBe(",2,");
	});

	test("builder order does not matter: where(p) before limit(n) also returns n rows", async () => {
		const rows = (await table
			.query()
			.fullTextSearch(TERM, { columns: ["content"] })
			.where(onBranch(2))
			.limit(N)
			.toArray()) as Row[];
		expect(rows).toHaveLength(N);
		for (const row of rows) expect(row.branchIds).toBe(",2,");
	});

	test("rows appended after the FTS index was built are filtered in, not dropped", async () => {
		const filler = Array.from({ length: 60 }, (_, i) => `late${i}`).join(" ");
		await table.add(
			Array.from({ length: 10 }, (_, i) => ({
				id: `late-${i}`,
				content: `${TERM} ${filler}`,
				branchIds: ",3,",
				vector: [0, 0, 1, 0],
			})),
		);
		const rows = await ftsTopK(onBranch(3));
		expect(rows).toHaveLength(N);
		for (const row of rows) expect(row.branchIds).toBe(",3,");
	});

	test("precondition: the predicate excludes the ENTIRE natural vector top-n", async () => {
		const natural = await vectorTopK();
		expect(natural).toHaveLength(N);
		for (const row of natural) expect(row.branchIds).toBe(",1,");
	});

	test("vectorSearch(v).limit(n).where(p) returns n rows, all matching p", async () => {
		const rows = await vectorTopK(onBranch(2));
		expect(rows).toHaveLength(N);
		for (const row of rows) expect(row.branchIds).toBe(",2,");
	});
});
