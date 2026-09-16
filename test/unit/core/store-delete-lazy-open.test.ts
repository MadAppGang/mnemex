/**
 * Deletes must not depend on the table having been opened already.
 *
 * `VectorStore` opens the LanceDB table LAZILY: `initialize()` only connects
 * the database, and `this.table` stays null until some call runs
 * `ensureTableOpen()`. Every read path does that (`getChunksWithVectors`,
 * `getStats`, `search`, ...), but `deleteByFile` used to test the raw
 * `this.table` field:
 *
 *     if (!this.db || !this.table) return 0;
 *
 * So a delete issued before any read on that instance silently did nothing and
 * returned 0 — indistinguishable from "there was nothing to delete". Real call
 * paths hit this: `handleDocsClear` and `handleDocsFetch` in cli.ts call
 * `initialize()` and then delete immediately, and `Indexer.index()` deletes
 * removed files (indexer.ts:540) before the first `getChunksWithVectors` opens
 * the table. Stale chunks survived a delete that reported success, while the
 * file tracker forgot about them.
 *
 * These tests pin the contract from the caller's side:
 *   - table exists on disk, never opened => the delete really deletes
 *   - no table at all                    => 0, and no throw
 *   - table already open (post-search)   => unchanged behaviour
 *
 * `deleteByFile` returns LanceDB's real `numDeletedRows` (Phase 3a). Each seed
 * here puts ONE row per file, so a successful delete reads 1 and a matchless
 * one 0; `store-delete-count.test.ts` covers multi-row files.
 *
 * PHASE 3b-3 RETIRED THREE SIBLINGS, and their cases went with them.
 * `deleteByFileHash`, `deleteByDocumentType` and `deleteAllByFile` had no
 * caller in `src/` and each deleted across every branch of a shared store
 * (architecture §3.5, decision I-15). The lazy-open guard they were asserted
 * against is `ensureTableOpen()`, which the surviving `deleteByFile` still
 * exercises on every case below, so nothing about the guard is now untested —
 * what is gone is the duplicate coverage of three methods that no longer exist.
 * `test/unit/core/store-delete-allowlist.test.ts` is what stops them coming
 * back.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCOPE_ALL } from "../../../src/core/branch-scope.js";
import { createVectorStore } from "../../../src/core/store.js";
import type { ChunkWithEmbedding } from "../../../src/types.js";

const DIM = 8;

/** A deterministic non-zero vector — store.ts rejects zero-dimension batches. */
function vec(seed: number): number[] {
	return Array.from({ length: DIM }, (_, i) => ((seed + i) % 10) / 10 + 0.01);
}

function chunk(id: string, seed = 1): ChunkWithEmbedding {
	return {
		id,
		contentHash: `hash-${id}`,
		content: `function ${id}() { return parseConfig(); } // MARKER:${id}`,
		filePath: `src/${id}.ts`,
		startLine: 1,
		endLine: 10,
		language: "typescript",
		chunkType: "function",
		name: id,
		fileHash: `file-${id}`,
		vector: vec(seed),
	};
}

let dir: string;
let dbPath: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "mnemex-delete-"));
	dbPath = join(dir, "vectors");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** Fresh instance, initialize, use, close — exactly what every caller does. */
async function withFreshStore<T>(
	fn: (store: ReturnType<typeof createVectorStore>) => Promise<T>,
): Promise<T> {
	const store = createVectorStore({ vectorsDir: dbPath, pathRoot: dir });
	await store.initialize();
	try {
		return await fn(store);
	} finally {
		await store.close();
	}
}

/** Seed a corpus on its own instance so nothing is left open for the next one. */
async function seed(chunks: ChunkWithEmbedding[]): Promise<void> {
	await withFreshStore((store) =>
		store.addChunks(chunks, { pathKind: "repo", branchId: 0 }),
	);
}

/** Chunk ids still in the store, read on a fresh instance. */
async function remainingIds(): Promise<string[]> {
	return withFreshStore(async (store) => {
		const ids: string[] = [];
		for (const id of ["alpha", "beta"]) {
			const chunks = await store.getChunksWithVectors(`src/${id}.ts`);
			if (chunks.length > 0) ids.push(id);
		}
		return ids.sort();
	});
}

describe("deleteByFile — table not yet opened on this instance", () => {
	test("deletes the file's chunks instead of silently no-opping", async () => {
		await seed([chunk("alpha", 1), chunk("beta", 2)]);

		const deleted = await withFreshStore((store) =>
			// No read first: `this.table` is null here, only `this.db` is set.
			store.deleteByFile("src/alpha.ts"),
		);

		expect(deleted).toBe(1);
		expect(await remainingIds()).toEqual(["beta"]);
	});

	test("reports the delete rather than an ambiguous 0", async () => {
		await seed([chunk("alpha", 1)]);

		const deleted = await withFreshStore((store) =>
			store.deleteByFile("src/alpha.ts"),
		);

		// 0 would be indistinguishable from "nothing to delete" — the exact
		// ambiguity that hid the bug from callers.
		expect(deleted).toBe(1);
	});

	test("a second delete on a fresh instance is idempotent", async () => {
		await seed([chunk("alpha", 1), chunk("beta", 2)]);

		await withFreshStore((store) => store.deleteByFile("src/alpha.ts"));
		await withFreshStore((store) => store.deleteByFile("src/alpha.ts"));

		expect(await remainingIds()).toEqual(["beta"]);
	});
});

describe("deletes on a store with no table at all", () => {
	test("deleteByFile returns 0 and does not throw", async () => {
		// Nothing was ever indexed, so `ensureTableOpen()` returns null: there is
		// no table to open. A no-op is genuinely correct here.
		const deleted = await withFreshStore((store) =>
			store.deleteByFile("src/alpha.ts"),
		);

		expect(deleted).toBe(0);
	});

	test("an unopenable table still returns 0 rather than throwing", async () => {
		// A `code_chunks.lance` directory with no manifest: `tableNames()` lists
		// it, so `ensureTableOpen()` gets as far as `openTable()` and THROWS
		// rather than returning null. Deletes previously could not throw at all
		// (they never opened anything); routing them through the lazy open must
		// not change that.
		mkdirSync(join(dbPath, "code_chunks.lance"), { recursive: true });

		await withFreshStore(async (store) => {
			expect(await store.deleteByFile("src/alpha.ts")).toBe(0);
		});
	});
});

describe("deletes on a store whose table is already open", () => {
	test("deleteByFile after a search behaves exactly as before", async () => {
		await seed([chunk("alpha", 1), chunk("beta", 2)]);

		const deleted = await withFreshStore(async (store) => {
			// The search opens the table, which is what used to be required.
			await store.search("parseConfig", undefined, SCOPE_ALL, {
				limit: 10,
				keywordOnly: true,
			});
			return store.deleteByFile("src/alpha.ts");
		});

		expect(deleted).toBe(1);
		expect(await remainingIds()).toEqual(["beta"]);
	});

	test("deleting a file with no chunks still returns the open-table path", async () => {
		await seed([chunk("alpha", 1)]);

		const deleted = await withFreshStore(async (store) => {
			await store.search("parseConfig", undefined, SCOPE_ALL, {
				limit: 10,
				keywordOnly: true,
			});
			return store.deleteByFile("src/never-indexed.ts");
		});

		// The real count: nothing matched, so 0. This pinned the hardcoded 1
		// ("LanceDB doesn't return count") until Phase 3a returned LanceDB's own
		// `numDeletedRows`; an open table no longer makes a no-op look like work.
		expect(deleted).toBe(0);
		expect(await remainingIds()).toEqual(["alpha"]);
	});
});
