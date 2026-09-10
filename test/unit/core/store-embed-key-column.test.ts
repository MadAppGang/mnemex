/**
 * `StoredChunk.embedKey` — index version 3's 23rd column.
 *
 * WHY THIS COLUMN AND THE VERSION BUMP CANNOT LAND SEPARATELY.
 *
 * LanceDB infers a table's Arrow schema from the first batch written to it and
 * never declares it (`createTable` in `addChunks` / `addDocuments` /
 * `addCodeUnits`). That is the same fact CLAUDE.md #15 exists for, reached from
 * the other side: there, a zero-length vector froze a `FixedSizeList[0]` column
 * into a table forever; here, a 22-field batch freezes a 22-column schema, and
 * every later 23-field write is rejected.
 *
 * Measured against the installed LanceDB 0.38 and pinned below as a fixture:
 *
 *     Found field not in schema: embedKey at row 0
 *
 * So the column alone would break every existing index, and the version bump
 * alone would claim a shape the writes do not produce. `index-version.test.ts`
 * holds the other half.
 *
 * Everything here reads the BYTES on disk — the Arrow schema, and the column
 * values through an independent LanceDB connection — never a report object from
 * the store that wrote them.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import {
	createVectorStore,
	EMBED_KEY_COLUMN,
	type IVectorStore,
	ZeroDimensionVectorError,
} from "../../../src/core/store.js";
import type {
	ChunkWithEmbedding,
	CodeUnitWithEmbedding,
	DocumentWithEmbedding,
} from "../../../src/types.js";

/** Not exported by store.ts; hardcoded the way store-delete-lazy-open does. */
const CHUNKS_TABLE = "code_chunks";

const DIM = 8;

function vec(seed: number): number[] {
	return Array.from({ length: DIM }, (_, i) => ((seed + i) % 10) / 10 + 0.01);
}

let dir: string;
let dbPath: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "mnemex-embed-key-"));
	dbPath = join(dir, "vectors");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** Fresh instance, initialize, use, close — exactly what every caller does. */
async function withFreshStore<T>(
	fn: (store: IVectorStore) => Promise<T>,
): Promise<T> {
	const store = createVectorStore(dbPath);
	await store.initialize();
	try {
		return await fn(store);
	} finally {
		await store.close();
	}
}

function chunk(
	marker: string,
	overrides: Partial<ChunkWithEmbedding> = {},
): ChunkWithEmbedding {
	return {
		id: `chunk-${marker}`,
		contentHash: `hash-${marker}`,
		content: `function ${marker}() {}`,
		filePath: `src/${marker}.ts`,
		startLine: 1,
		endLine: 3,
		language: "typescript",
		chunkType: "function",
		name: marker,
		fileHash: `file-${marker}`,
		vector: vec(1),
		...overrides,
	};
}

function unit(
	marker: string,
	overrides: Partial<CodeUnitWithEmbedding> = {},
): CodeUnitWithEmbedding {
	return {
		id: `unit-${marker}`,
		content: `class ${marker} {}`,
		filePath: `src/${marker}.ts`,
		startLine: 1,
		endLine: 5,
		language: "typescript",
		unitType: "class",
		name: marker,
		fileHash: `file-${marker}`,
		depth: 1,
		vector: vec(2),
		...overrides,
	};
}

function doc(
	marker: string,
	overrides: Partial<DocumentWithEmbedding> = {},
): DocumentWithEmbedding {
	return {
		id: `doc-${marker}`,
		documentType: "file_summary",
		content: `summary of ${marker}`,
		filePath: `src/${marker}.ts`,
		sourceIds: [],
		createdAt: new Date().toISOString(),
		vector: vec(3),
		...overrides,
	};
}

// ── Independent readers. Never the store that did the writing. ──────────────

async function schemaFieldNames(): Promise<string[]> {
	const db = await lancedb.connect(dbPath);
	const table = await db.openTable(CHUNKS_TABLE);
	const schema = await table.schema();
	return schema.fields.map((f: { name: string }) => f.name);
}

async function readRows(): Promise<Array<Record<string, unknown>>> {
	const db = await lancedb.connect(dbPath);
	const table = await db.openTable(CHUNKS_TABLE);
	return (await table.query().toArray()) as Array<Record<string, unknown>>;
}

async function readRow(id: string): Promise<Record<string, unknown>> {
	const rows = await readRows();
	const row = rows.find((r) => r.id === id);
	if (!row) throw new Error(`row ${id} not found`);
	return row;
}

/**
 * Run `fn` against a store whose table handle records the batch handed to
 * `add()` instead of writing it, and return that batch.
 *
 * WHY THIS SEAM AS WELL AS THE BYTES ON DISK. `updateUnitSummary` and
 * `updateDocumentContent` are delete-then-add round trips: they read a row back
 * with `table.query().toArray()` and re-add `{...existing, …}`. On the installed
 * LanceDB (0.38) that re-add USED TO fail every time, for a reason that has
 * nothing to do with this column — `toArray()` hands back `vector` as an Arrow
 * `Vector` object, and schema inference walked it as a struct:
 *
 *     Found field not in schema: vector.isValid at row 0
 *
 * Both methods swallowed it, and because the delete had already committed, the
 * row was gone. That is fixed (`toPlainVector` at the read boundary, plus a
 * restore-and-throw on a failed add), and pinned by
 * `store-update-row-loss.test.ts`, so each test below now ALSO asserts the
 * key on disk through an independent connection.
 *
 * The capture is kept because it pins the value at the write itself, which is
 * where `embedKey` is decided. The `expect(batch).toHaveLength(1)` in each
 * caller is what stops a swallowed throw from reading as a pass.
 */
async function captureRoundTripAdd(
	fn: (store: IVectorStore) => Promise<unknown>,
): Promise<Array<Record<string, unknown>>> {
	const store = createVectorStore(dbPath);
	await store.initialize();
	try {
		// Open the real table first, then swap the handle. `ensureTableOpen()`
		// returns the memoised `this.table`, so both methods use the recorder.
		await store.hasEmbedKeyColumn();
		const internals = store as unknown as { table: lancedb.Table | null };
		const real = internals.table;
		if (!real) throw new Error("fixture did not open a table");

		const captured: Array<Record<string, unknown>> = [];
		internals.table = {
			query: () => real.query(),
			delete: (predicate: string) => real.delete(predicate),
			add: async (data: Array<Record<string, unknown>>) => {
				captured.push(...data);
			},
		} as unknown as lancedb.Table;

		await fn(store);
		return captured;
	} finally {
		await store.close();
	}
}

/**
 * A pre-v3 table: the exact 22 columns `StoredChunk` had before `embedKey`.
 *
 * Written through a raw LanceDB connection on purpose. Nothing in `src/` can
 * produce this shape any more, which is the point — it is a frozen record of
 * what is already on every existing user's disk, and the only way to exercise
 * the `false` branch of `hasEmbedKeyColumn()`.
 */
async function createV2Table(): Promise<void> {
	const db = await lancedb.connect(dbPath);
	await db.createTable(
		CHUNKS_TABLE,
		[
			{
				id: "legacy-1",
				contentHash: "legacy-hash",
				content: "function legacy() {}",
				filePath: "src/legacy.ts",
				startLine: 1,
				endLine: 3,
				language: "typescript",
				chunkType: "function",
				name: "legacy",
				parentName: "",
				signature: "",
				fileHash: "legacy-file",
				vector: vec(4),
				documentType: "code_chunk",
				sourceIds: "[]",
				metadata: "{}",
				createdAt: new Date().toISOString(),
				enrichedAt: "",
				parentId: "",
				unitType: "",
				depth: -1,
				summary: "",
			},
		],
		{ mode: "create" },
	);
}

// ============================================================================
// The column exists on every table-creating write path
// ============================================================================

describe("the created Arrow schema carries embedKey", () => {
	// Whichever of the three createTable branches runs FIRST defines the schema
	// for all of them, so all three have to carry the field. A path that omitted
	// it would create a 22-column table and the other two would then fail
	// against it — the same shape as the dimension guards of CLAUDE.md #15.
	test("addChunks creates it", async () => {
		await withFreshStore((s) => s.addChunks([chunk("a")]));
		expect(await schemaFieldNames()).toContain(EMBED_KEY_COLUMN);
	});

	test("addCodeUnits creates it", async () => {
		await withFreshStore((s) => s.addCodeUnits([unit("b")]));
		expect(await schemaFieldNames()).toContain(EMBED_KEY_COLUMN);
	});

	test("addDocuments creates it", async () => {
		await withFreshStore((s) => s.addDocuments([doc("c")]));
		expect(await schemaFieldNames()).toContain(EMBED_KEY_COLUMN);
	});

	test("the column is Utf8, not a null-typed column", async () => {
		await withFreshStore((s) => s.addChunks([chunk("a")]));
		const db = await lancedb.connect(dbPath);
		const table = await db.openTable(CHUNKS_TABLE);
		const schema = await table.schema();
		const field = schema.fields.find(
			(f: { name: string }) => f.name === EMBED_KEY_COLUMN,
		);
		expect(String(field?.type)).toMatch(/utf8|string/i);
	});
});

// ============================================================================
// Values
// ============================================================================

describe("embedKey values", () => {
	test("a chunk's key round-trips to the row beside its vector", async () => {
		await withFreshStore((s) =>
			s.addChunks([chunk("keyed", { embedKey: "deadbeefcafe" })]),
		);
		const row = await readRow("chunk-keyed");
		expect(row[EMBED_KEY_COLUMN]).toBe("deadbeefcafe");
	});

	// "" is the legal "unknown" value: BM25 mode, cache off, dimension never
	// learned. It must never be null — Arrow would type the column from the
	// first batch it saw and a null there is the same class of hazard as the
	// zero-dimension vector column.
	test("a chunk with no key stores the empty string, never null", async () => {
		await withFreshStore((s) => s.addChunks([chunk("bare")]));
		const row = await readRow("chunk-bare");
		expect(row[EMBED_KEY_COLUMN]).toBe("");
		expect(row[EMBED_KEY_COLUMN]).not.toBeNull();
	});

	test("a code unit's key round-trips", async () => {
		await withFreshStore((s) =>
			s.addCodeUnits([unit("keyed", { embedKey: "unitkey123" })]),
		);
		const row = await readRow("unit-keyed");
		expect(row[EMBED_KEY_COLUMN]).toBe("unitkey123");
	});

	// Enrichment summaries are embedded with the RAW client, deliberately
	// outside the caching seam, so there is never a key to record for them.
	test("an enriched document always stores the empty string", async () => {
		await withFreshStore((s) => s.addDocuments([doc("summary")]));
		const row = await readRow("doc-summary");
		expect(row[EMBED_KEY_COLUMN]).toBe("");
	});
});

// ============================================================================
// The two round-tripping write paths (sites 4 and 5)
// ============================================================================

describe("round-tripping writes", () => {
	// updateUnitSummary replaces `summary` and leaves `vector` alone, so the key
	// still addresses this row's vector and must survive. This site can neither
	// introduce the column nor create the table, so it cannot define the schema.
	test("updateUnitSummary INHERITS the key — the vector did not change", async () => {
		await withFreshStore((s) =>
			s.addCodeUnits([unit("sum", { embedKey: "survives-me" })]),
		);

		// The bytes first: a real write, read back through an independent
		// connection. The capture below leaves the row deleted (it commits the
		// delete and swallows the add), so it has to come second.
		await withFreshStore((s) => s.updateUnitSummary("unit-sum", "on disk"));
		const row = await readRow("unit-sum");
		expect(row.summary).toBe("on disk");
		expect(row[EMBED_KEY_COLUMN]).toBe("survives-me");

		const batch = await captureRoundTripAdd((s) =>
			s.updateUnitSummary("unit-sum", "a summary"),
		);

		expect(batch).toHaveLength(1);
		expect(batch[0].summary).toBe("a summary");
		expect(batch[0][EMBED_KEY_COLUMN]).toBe("survives-me");
	});

	// updateDocumentContent replaces `content` AND `vector`. Carrying the old
	// key forward would leave a key describing a vector that no longer exists,
	// which breaks the one invariant the column has and makes any hit-rate audit
	// read from it wrong. Harmless today (documents are written with ""), wrong
	// the moment document embeds come inside the caching seam.
	test("updateDocumentContent RESETS the key — the vector was replaced", async () => {
		// Seeded through addChunks so the row starts with a NON-EMPTY key; a
		// fixture starting from "" could not tell a reset from an inherit.
		// `updateDocumentContent` matches on `id` alone, so the row's
		// documentType is irrelevant to it.
		await withFreshStore((s) =>
			s.addChunks([chunk("upd", { id: "doc-upd", embedKey: "stale-key" })]),
		);
		expect((await readRow("doc-upd"))[EMBED_KEY_COLUMN]).toBe("stale-key");

		const batch = await captureRoundTripAdd((s) =>
			s.updateDocumentContent("doc-upd", "new content", vec(7)),
		);

		expect(batch).toHaveLength(1);
		expect(batch[0].content).toBe("new content");
		expect(batch[0][EMBED_KEY_COLUMN]).toBe("");

		// ...and the same thing on the bytes. Re-seeded rather than reusing the
		// row above, for two reasons: the capture commits the delete and
		// swallows the add, so the row is gone; and a second pass over a row
		// whose key the first pass had already reset could not tell a reset from
		// an inherit.
		await withFreshStore((s) =>
			s.addChunks([chunk("upd", { id: "doc-upd2", embedKey: "stale-key" })]),
		);
		await withFreshStore((s) =>
			s.updateDocumentContent("doc-upd2", "on disk", vec(9)),
		);
		const row = await readRow("doc-upd2");
		expect(row.content).toBe("on disk");
		expect(row[EMBED_KEY_COLUMN]).toBe("");
	});
});

// ============================================================================
// hasEmbedKeyColumn — the tri-state live read
// ============================================================================

describe("hasEmbedKeyColumn", () => {
	test("null when there is no table at all", async () => {
		expect(await withFreshStore((s) => s.hasEmbedKeyColumn())).toBeNull();
	});

	test("true against a table this build created", async () => {
		await withFreshStore((s) => s.addChunks([chunk("a")]));
		expect(await withFreshStore((s) => s.hasEmbedKeyColumn())).toBe(true);
	});

	// THE fixture. This is what is on an existing user's disk.
	test("false against a 22-column table written before v3", async () => {
		await createV2Table();
		expect(await schemaFieldNames()).not.toContain(EMBED_KEY_COLUMN);
		expect(await withFreshStore((s) => s.hasEmbedKeyColumn())).toBe(false);
	});

	/**
	 * The read is LIVE. A memoised flag would go stale three ways that all exist
	 * in store.ts today — `clear()` nulls `this.table` without resetting derived
	 * state, the three `createTable` branches assign `this.table` directly, and
	 * `ensureTableOpen()` short-circuits on the memoised handle. This walks one
	 * instance through all three transitions and demands a different answer at
	 * each step.
	 */
	test("answers per call across clear() and re-create on ONE instance", async () => {
		const store = createVectorStore(dbPath);
		await store.initialize();
		try {
			expect(await store.hasEmbedKeyColumn()).toBeNull();

			await store.addChunks([chunk("live")]); // createTable, direct assign
			expect(await store.hasEmbedKeyColumn()).toBe(true);

			await store.clear(); // nulls this.table, leaves derived state
			expect(await store.hasEmbedKeyColumn()).toBeNull();

			await store.addChunks([chunk("again")]);
			expect(await store.hasEmbedKeyColumn()).toBe(true);
		} finally {
			await store.close();
		}
	});
});

// ============================================================================
// FR-8: why the column and the bump are one change
// ============================================================================

describe("a v3 batch against a v2 table", () => {
	/**
	 * The hazard the version number exists to prevent, demonstrated rather than
	 * asserted. LanceDB 0.38 rejects the extra field outright; it does not drop
	 * it, and it does not evolve the schema. Without a version to notice the
	 * old shape, this is what every existing index would do on its next run.
	 */
	test("fails loudly — it is neither dropped nor silently accepted", async () => {
		await createV2Table();

		let caught: Error | undefined;
		try {
			await withFreshStore((s) =>
				s.addChunks([chunk("v3", { embedKey: "abc" })]),
			);
		} catch (err) {
			caught = err as Error;
		}

		expect(caught).toBeDefined();
		expect(caught?.message).toContain(EMBED_KEY_COLUMN);

		// And the v2 table is untouched: still 22 columns, still one row.
		expect(await schemaFieldNames()).not.toContain(EMBED_KEY_COLUMN);
		expect(await readRows()).toHaveLength(1);
	});

	// The reverse direction, for completeness: a table that HAS the column takes
	// a batch whose key is "" without complaint, which is what keeps BM25-mode
	// and cache-off runs writing a v3-shaped table.
	test("a v3 table accepts an empty key, so BM25 mode still writes v3", async () => {
		await withFreshStore((s) =>
			s.addChunks([chunk("first", { embedKey: "k" })]),
		);
		await withFreshStore((s) => s.addChunks([chunk("second")]));
		expect((await readRow("chunk-second"))[EMBED_KEY_COLUMN]).toBe("");
	});
});

// ============================================================================
// The dimension guards are untouched (CLAUDE.md #15)
// ============================================================================

describe("the zero-dimension guards still fire with the new column present", () => {
	test("addChunks rejects a 0-dimension batch even when it carries a key", async () => {
		await expect(
			withFreshStore((s) =>
				s.addChunks([chunk("z", { vector: [], embedKey: "k" })]),
			),
		).rejects.toThrow(ZeroDimensionVectorError);
		// Nothing was created: the guard runs before any write.
		expect(await withFreshStore((s) => s.hasEmbedKeyColumn())).toBeNull();
	});

	test("addCodeUnits and addDocuments reject one too", async () => {
		await expect(
			withFreshStore((s) => s.addCodeUnits([unit("z", { vector: [] })])),
		).rejects.toThrow(ZeroDimensionVectorError);
		await expect(
			withFreshStore((s) => s.addDocuments([doc("z", { vector: [] })])),
		).rejects.toThrow(ZeroDimensionVectorError);
	});
});
