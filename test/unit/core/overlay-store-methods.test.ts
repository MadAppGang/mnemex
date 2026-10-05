/**
 * The VectorStore methods the dirty overlay writes and reads through (step 3,
 * R3.4, R3.10, HIGH 5, HIGH 10). Real LanceDB on a temp directory.
 *
 *   deleteRowsByStoredPathsStrict  `filePath IN (…)`, quote-doubled
 *       (CLAUDE.md #22), ≤ 256 per statement, and it THROWS on failure. The
 *       existing `deleteByFile` returns 0 on error, which is indistinguishable
 *       from "nothing to delete" — the overlay must never advance its manifest
 *       past a delete that did not happen.
 *   optimize({ retentionMs })      the overlay prunes every old version
 *       (R3.10). Refused below the default on a SHARED store, where another
 *       process's pinned handle could be reading an old version.
 *   vectorCandidates               top `searchFetchLimit(limit)` by distance
 *       among the given ids AND the user's language/path filters — built by
 *       the SAME `buildUserFilters` the main search uses — materialised, id-
 *       unique, `(_distance, id)` order.
 *   rowsByIds                      the served rows without vectors.
 *
 * Each test names the falsifier it guards against.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import {
	createVectorStore,
	type IVectorStore,
	searchFetchLimit,
	VectorStore,
} from "../../../src/core/store.js";
import type { ChunkWithEmbedding } from "../../../src/types.js";

const dirs: string[] = [];
afterAll(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
	const d = realpathSync.native(mkdtempSync(join(tmpdir(), "mnemex-ovstore-")));
	dirs.push(d);
	return d;
}

const hex = (s: string) => createHash("sha256").update(s).digest("hex");

function chunk(
	filePath: string,
	line: number,
	vector: number[],
	language = "typescript",
): ChunkWithEmbedding {
	const content = `export const v${line} = ${JSON.stringify(filePath)};`;
	return {
		id: hex(`${filePath}:${line}:${content}`),
		contentHash: hex(content),
		content,
		filePath,
		startLine: line,
		endLine: line,
		language,
		chunkType: "module",
		name: `v${line}`,
		fileHash: hex(filePath),
		vector,
	};
}

function overlayStore(dir: string): IVectorStore {
	return createVectorStore({
		vectorsDir: join(dir, "vectors"),
		pathRoot: dir,
		role: "overlay",
	});
}

const MEMBERSHIP = { branchId: 0, pathKind: "repo" } as const;

async function versionCount(vectorsDir: string): Promise<number> {
	const db = await lancedb.connect(vectorsDir);
	const table = await db.openTable("code_chunks");
	return (await table.listVersions()).length;
}

describe("searchFetchLimit — one formula for both sides of the merge", () => {
	test("is today's limit * 3", () => {
		expect(searchFetchLimit(10)).toBe(30);
		expect(searchFetchLimit(1)).toBe(3);
	});
});

describe("deleteRowsByStoredPathsStrict", () => {
	test("deletes exactly the named paths, escaping quotes, across statement batches", async () => {
		const dir = tempDir();
		const store = overlayStore(dir);
		const paths = Array.from({ length: 300 }, (_, i) => `src/f${i}.ts`);
		paths.push("src/my_file's.ts", "src/100%.ts");
		await store.addChunks(
			paths.map((p, i) => chunk(p, i + 1, [i, 1])),
			MEMBERSHIP,
		);
		await store.addChunks([chunk("src/keep.ts", 1, [1, 1])], MEMBERSHIP);

		const deleted = await store.deleteRowsByStoredPathsStrict(paths);
		expect(deleted).toBe(paths.length);
		const left = await store.rowsByIds([chunk("src/keep.ts", 1, [1, 1]).id]);
		expect(left.map((r) => r.filePath)).toEqual(["src/keep.ts"]);
		await store.close();
	});

	test("a failing delete THROWS (falsifier: deleteByFile's catch-and-return-0)", async () => {
		const dir = tempDir();
		const store = overlayStore(dir);
		await store.addChunks([chunk("src/a.ts", 1, [1, 0])], MEMBERSHIP);
		// Open the table, then make its delete fail the way a LanceDB error does.
		await store.rowsByIds([]);
		const table = await (
			store as unknown as { ensureTableOpen(): Promise<lancedb.Table> }
		).ensureTableOpen();
		table.delete = () => Promise.reject(new Error("injected lance failure"));
		await expect(
			store.deleteRowsByStoredPathsStrict(["src/a.ts"]),
		).rejects.toThrow("injected lance failure");
		await store.close();
	});

	test("no table yet: nothing to delete, 0, no throw", async () => {
		const store = overlayStore(tempDir());
		expect(await store.deleteRowsByStoredPathsStrict(["src/a.ts"])).toBe(0);
	});

	test("refused on a SHARED store", async () => {
		const dir = tempDir();
		const shared = createVectorStore({
			vectorsDir: join(dir, "vectors"),
			pathRoot: dir,
		});
		await expect(
			shared.deleteRowsByStoredPathsStrict(["src/a.ts"]),
		).rejects.toThrow(/overlay/);
	});
});

describe("optimize({ retentionMs })", () => {
	test("retention 0 on the overlay store leaves ≤ 2 versions (falsifier: default retention)", async () => {
		const dir = tempDir();
		const store = overlayStore(dir);
		for (let i = 0; i < 6; i++) {
			await store.deleteRowsByStoredPathsStrict(["src/a.ts"]);
			await store.addChunks([chunk("src/a.ts", i + 1, [i, 1])], MEMBERSHIP);
		}
		const before = await versionCount(join(dir, "vectors"));
		expect(before).toBeGreaterThan(6);
		await store.optimize({ retentionMs: 0 });
		expect(await versionCount(join(dir, "vectors"))).toBeLessThanOrEqual(2);
		await store.close();
	});

	test("a retention below the default is refused on a SHARED store", async () => {
		const dir = tempDir();
		const shared = createVectorStore({
			vectorsDir: join(dir, "vectors"),
			pathRoot: dir,
		});
		await shared.addChunks([chunk("src/a.ts", 1, [1, 0])], {
			branchId: 1,
			pathKind: "repo",
		});
		await expect(shared.optimize({ retentionMs: 0 })).rejects.toThrow(
			RangeError,
		);
		await shared.optimize(); // the default stays available
		await shared.close();
	});
});

describe("vectorCandidates / rowsByIds", () => {
	test("only the given ids, the user's filters, (_distance, id) order, cut at fetchLimit (A)", async () => {
		const dir = tempDir();
		const store = overlayStore(dir);
		const near = chunk("src/near.ts", 1, [1, 0]);
		const tieA = chunk("src/tie-a.ts", 1, [0, 1]);
		const tieB = chunk("src/tie-b.ts", 1, [0, 1]);
		const far = chunk("src/far.ts", 1, [-5, -5]);
		const notServed = chunk("src/not-served.ts", 1, [1, 0]);
		const python = chunk("src/py.py", 1, [1, 0], "python");
		await store.addChunks(
			[near, tieA, tieB, far, notServed, python],
			MEMBERSHIP,
		);
		// A late duplicate append of one served row (a timed-out native write).
		await store.addChunks([tieA], MEMBERSHIP);

		const served = [near.id, tieA.id, tieB.id, far.id, python.id];
		const all = await store.vectorCandidates([1, 0], served, { limit: 10 });
		expect(all.map((r) => r.filePath)).not.toContain("src/not-served.ts");
		const ids = all.map((r) => r.id);
		expect(new Set(ids).size).toBe(ids.length); // id-unique
		for (let i = 1; i < all.length; i++) {
			const a = all[i - 1];
			const b = all[i];
			expect(
				a._distance < b._distance ||
					(a._distance === b._distance && a.id < b.id),
			).toBe(true);
		}
		const row = all.find((r) => r.id === near.id);
		expect(row).toMatchObject({
			filePath: "src/near.ts",
			content: near.content,
			startLine: 1,
			endLine: 1,
			language: "typescript",
			contentHash: near.contentHash,
		});

		// The user's language filter applies to the overlay side too.
		const ts = await store.vectorCandidates([1, 0], served, {
			limit: 10,
			language: "python",
		});
		expect(ts.map((r) => r.id)).toEqual([python.id]);

		// Cut at searchFetchLimit(limit).
		const cut = await store.vectorCandidates([1, 0], served, { limit: 1 });
		expect(cut).toHaveLength(searchFetchLimit(1));
		expect(cut[0].id).toBe(
			[near.id, python.id].sort()[0], // the two at distance 0, id order
		);

		const byId = await store.rowsByIds([tieA.id, far.id]);
		expect(byId.map((r) => r.id).sort()).toEqual([tieA.id, far.id].sort());
		expect(byId.every((r) => !("vector" in r))).toBe(true);
		await store.close();
	});

	test("the overlay's filters ARE the main search's (buildUserFilters is shared)", () => {
		const store = new VectorStore({
			vectorsDir: join(tempDir(), "vectors"),
			pathRoot: "/repo",
		});
		expect(
			store.buildUserFilters({
				language: "ty'pe",
				filePath: "/repo/src/my_file.ts",
				pathPattern: "lib%",
			}),
		).toEqual([
			"language = 'ty''pe'",
			"filePath LIKE '%src/my\\_file.ts%'",
			"filePath LIKE '%lib\\%%'",
		]);
	});
});
