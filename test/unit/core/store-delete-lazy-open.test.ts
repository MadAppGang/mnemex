/**
 * Deletes must not depend on the table having been opened already.
 *
 * `VectorStore` opens the LanceDB table LAZILY: `initialize()` only connects
 * the database, and `this.table` stays null until some call runs
 * `ensureTableOpen()`. Every read path does that (`getChunksWithVectors`,
 * `getStats`, `search`, ...), but `deleteByFile` / `deleteByFileHash` used to
 * test the raw `this.table` field:
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
 *   - `deleteByFileHash` matches `deleteByFile` on all of the above
 *   - `deleteByDocumentType` / `deleteAllByFile` match them too
 *
 * `deleteByFile` returns LanceDB's real `numDeletedRows` (Phase 3a). Each seed
 * here puts ONE row per file, so a successful delete reads 1 and a matchless
 * one 0; `store-delete-count.test.ts` covers multi-row files. `deleteByFileHash`
 * still returns a constant 1 (no caller in src/, retired in 3b) and is asserted
 * as-is.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVectorStore } from "../../../src/core/store.js";
import type {
	ChunkWithEmbedding,
	DocumentType,
	DocumentWithEmbedding,
} from "../../../src/types.js";

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

function doc(
	marker: string,
	filePath: string,
	documentType: DocumentType,
	seed = 3,
): DocumentWithEmbedding {
	return {
		id: `doc-${marker}`,
		content: `Summary of parseConfig behaviour. // MARKER:${marker}`,
		documentType,
		filePath,
		fileHash: `file-${marker}`,
		createdAt: new Date().toISOString(),
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

describe("deleteByFileHash — table not yet opened on this instance", () => {
	test("deletes the hash's chunks instead of silently no-opping", async () => {
		await seed([chunk("alpha", 1), chunk("beta", 2)]);

		const deleted = await withFreshStore((store) =>
			store.deleteByFileHash("file-alpha"),
		);

		expect(deleted).toBe(1);
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

	test("deleteByFileHash returns 0 and does not throw", async () => {
		const deleted = await withFreshStore((store) =>
			store.deleteByFileHash("file-alpha"),
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
			expect(await store.deleteByFileHash("file-alpha")).toBe(0);
		});
	});
});

describe("deletes on a store whose table is already open", () => {
	test("deleteByFile after a search behaves exactly as before", async () => {
		await seed([chunk("alpha", 1), chunk("beta", 2)]);

		const deleted = await withFreshStore(async (store) => {
			// The search opens the table, which is what used to be required.
			await store.search("parseConfig", undefined, {
				limit: 10,
				keywordOnly: true,
			});
			return store.deleteByFile("src/alpha.ts");
		});

		expect(deleted).toBe(1);
		expect(await remainingIds()).toEqual(["beta"]);
	});

	test("deleteByFileHash after a search behaves exactly as before", async () => {
		await seed([chunk("alpha", 1), chunk("beta", 2)]);

		const deleted = await withFreshStore(async (store) => {
			await store.search("parseConfig", undefined, {
				limit: 10,
				keywordOnly: true,
			});
			return store.deleteByFileHash("file-alpha");
		});

		expect(deleted).toBe(1);
		expect(await remainingIds()).toEqual(["beta"]);
	});

	test("deleting a file with no chunks still returns the open-table path", async () => {
		await seed([chunk("alpha", 1)]);

		const deleted = await withFreshStore(async (store) => {
			await store.search("parseConfig", undefined, {
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

// ============================================================================
// The same guard, two methods that were outside the original fix
// ============================================================================

/** Seed enriched documents on their own instance, as `seed` does for chunks. */
async function seedDocs(docs: DocumentWithEmbedding[]): Promise<void> {
	await withFreshStore((store) =>
		store.addDocuments(docs, { pathKind: "repo", branchId: 0 }),
	);
}

/**
 * Every MARKER still in the store, read with NO predicate at all.
 *
 * `remainingIds` above goes through `getChunksWithVectors`, which only sees
 * `documentType = 'code_chunk'` rows. These two methods delete across types, so
 * the oracle has to be an unfiltered scan.
 */
async function markers(): Promise<string[]> {
	return withFreshStore(async (store) => {
		const contents = await store.getChunkContents();
		return contents
			.map((c) => c.match(/MARKER:(\S+)/)?.[1])
			.filter((m): m is string => m !== undefined)
			.sort();
	});
}

describe("deleteByDocumentType — table not yet opened on this instance", () => {
	test("deletes that type's documents instead of silently no-opping", async () => {
		await seedDocs([
			doc("summary", "src/alpha.ts", "file_summary", 3),
			doc("idiom", "src/beta.ts", "idiom", 4),
		]);

		const deleted = await withFreshStore((store) =>
			// No read first: `this.table` is null here, only `this.db` is set.
			store.deleteByDocumentType("file_summary"),
		);

		expect(deleted).toBe(1);
		expect(await markers()).toEqual(["idiom"]);
	});

	test("leaves the other document types in place", async () => {
		await seed([chunk("alpha", 1)]);
		await seedDocs([doc("summary", "src/alpha.ts", "file_summary", 3)]);

		await withFreshStore((store) => store.deleteByDocumentType("file_summary"));

		expect(await markers()).toEqual(["alpha"]);
	});

	test("returns 0 and does not throw when there is no table at all", async () => {
		const deleted = await withFreshStore((store) =>
			store.deleteByDocumentType("file_summary"),
		);

		expect(deleted).toBe(0);
	});

	test("returns 0 rather than throwing when the table cannot be opened", async () => {
		mkdirSync(join(dbPath, "code_chunks.lance"), { recursive: true });

		await withFreshStore(async (store) => {
			expect(await store.deleteByDocumentType("file_summary")).toBe(0);
		});
	});

	test("after a search behaves exactly as before", async () => {
		await seedDocs([
			doc("summary", "src/alpha.ts", "file_summary", 3),
			doc("idiom", "src/beta.ts", "idiom", 4),
		]);

		const deleted = await withFreshStore(async (store) => {
			await store.search("parseConfig", undefined, {
				limit: 10,
				keywordOnly: true,
			});
			return store.deleteByDocumentType("file_summary");
		});

		expect(deleted).toBe(1);
		expect(await markers()).toEqual(["idiom"]);
	});
});

describe("deleteAllByFile — table not yet opened on this instance", () => {
	test("deletes every row for the file, chunk and enriched alike", async () => {
		await seed([chunk("alpha", 1), chunk("beta", 2)]);
		await seedDocs([doc("alpha-summary", "src/alpha.ts", "file_summary", 3)]);

		const deleted = await withFreshStore((store) =>
			store.deleteAllByFile("src/alpha.ts"),
		);

		expect(deleted).toBe(1);
		expect(await markers()).toEqual(["beta"]);
	});

	test("reports the delete rather than an ambiguous 0", async () => {
		await seed([chunk("alpha", 1)]);

		const deleted = await withFreshStore((store) =>
			store.deleteAllByFile("src/alpha.ts"),
		);

		expect(deleted).toBe(1);
	});

	test("returns 0 and does not throw when there is no table at all", async () => {
		const deleted = await withFreshStore((store) =>
			store.deleteAllByFile("src/alpha.ts"),
		);

		expect(deleted).toBe(0);
	});

	test("returns 0 rather than throwing when the table cannot be opened", async () => {
		mkdirSync(join(dbPath, "code_chunks.lance"), { recursive: true });

		await withFreshStore(async (store) => {
			expect(await store.deleteAllByFile("src/alpha.ts")).toBe(0);
		});
	});

	test("after a search behaves exactly as before", async () => {
		await seed([chunk("alpha", 1), chunk("beta", 2)]);

		const deleted = await withFreshStore(async (store) => {
			await store.search("parseConfig", undefined, {
				limit: 10,
				keywordOnly: true,
			});
			return store.deleteAllByFile("src/alpha.ts");
		});

		expect(deleted).toBe(1);
		expect(await markers()).toEqual(["beta"]);
	});
});
