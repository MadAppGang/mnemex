/**
 * `updateUnitSummary` / `updateDocumentContent` must not destroy the row they
 * were asked to update.
 *
 * LanceDB has no upsert, so both methods express an update as delete + add.
 * The two are not atomic. Before the fix, the `add` sat inside a `try` whose
 * `catch` only called `console.warn`, so ANY failure of the add left the row
 * deleted and never restored while the method returned normally — a silent
 * data loss the caller could not detect. `updateUnitSummary` is the enrichment
 * write-back path, so the symptom was a code unit vanishing from the index
 * after enrichment ran.
 *
 * The failure was not hypothetical on the installed LanceDB (0.38):
 * `table.query().toArray()` hands `vector` back as an Arrow `Vector` object,
 * and LanceDB's schema inference walks that object as a struct —
 *
 *     Found field not in schema: vector.isValid at row 0
 *
 * — so `table.add([{ ...existing, summary }])` threw on EVERY call. The same
 * Arrow-`Vector`-handed-back-to-`add` shape reaches `addChunks` through
 * `getChunksWithVectors` on the indexer's incremental-reuse path, which is why
 * the last describe below is in this file: one root cause, one fix.
 *
 * WHAT THESE TESTS ASSERT, AND WHY IT IS THE ROW COUNT. CLAUDE.md #25: a test
 * for this class of bug asserts on the bytes or the rows, never on a report
 * object — the losing path threw nothing and reported nothing, so a test that
 * only checked for an absent exception passed against the bug. Every count here
 * is read back through an INDEPENDENT LanceDB connection, not from the store
 * that did the writing.
 *
 * The thrown error is asserted STRUCTURALLY (`name`, `rowRestored`, `cause`)
 * rather than with `toBeInstanceOf`, so that a regression fails on the row
 * count and the missing throw rather than on a missing import.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import {
	createVectorStore,
	type IVectorStore,
} from "../../../src/core/store.js";
import type {
	ChunkWithEmbedding,
	CodeUnitWithEmbedding,
	DocumentWithEmbedding,
} from "../../../src/types.js";

/** Not exported by store.ts; hardcoded the way the sibling store tests do. */
const CHUNKS_TABLE = "code_chunks";

const DIM = 8;

function vec(seed: number): number[] {
	return Array.from({ length: DIM }, (_, i) => ((seed + i) % 10) / 10 + 0.01);
}

let dir: string;
let dbPath: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "mnemex-update-row-loss-"));
	dbPath = join(dir, "vectors");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

// ── Independent reader. Never the store that did the writing. ───────────────

async function readRows(): Promise<Array<Record<string, unknown>>> {
	const db = await lancedb.connect(dbPath);
	const table = await db.openTable(CHUNKS_TABLE);
	return (await table.query().toArray()) as Array<Record<string, unknown>>;
}

async function rowIds(): Promise<string[]> {
	return (await readRows()).map((r) => r.id as string).sort();
}

async function readRow(id: string): Promise<Record<string, unknown>> {
	const row = (await readRows()).find((r) => r.id === id);
	if (!row) throw new Error(`row ${id} not found`);
	return row;
}

// ── Fixtures ────────────────────────────────────────────────────────────────

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

function chunk(
	marker: string,
	overrides: Partial<ChunkWithEmbedding> = {},
): ChunkWithEmbedding {
	return {
		id: `chunk-${marker}`,
		contentHash: `hash-${marker}`,
		content: `function ${marker}() {}`,
		filePath: `/p/${marker}.ts`,
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

/**
 * Run `fn` against a store whose table handle fails `add`.
 *
 * `"first"` fails only the update's own add and lets the restore through — the
 * realistic case, and the one the fix has to survive. `"all"` also fails the
 * restore, which is the case NOTHING can save once the delete has committed;
 * it is here to pin that the caller is still told.
 *
 * Everything else (query, delete, schema) passes straight through to the real
 * table, so the delete really commits and the row count really moves.
 */
async function withFailingAdd<T>(
	mode: "first" | "all",
	fn: (store: IVectorStore) => Promise<T>,
): Promise<{ addCalls: number }> {
	const store = createVectorStore(dbPath);
	await store.initialize();
	try {
		// Open the real table first, then swap the handle. `ensureTableOpen()`
		// returns the memoised `this.table`, so the update uses the wrapper.
		await store.hasEmbedKeyColumn();
		const internals = store as unknown as { table: lancedb.Table | null };
		const real = internals.table;
		if (!real) throw new Error("fixture did not open a table");

		let addCalls = 0;
		internals.table = {
			query: () => real.query(),
			schema: () => real.schema(),
			delete: (predicate: string) => real.delete(predicate),
			add: async (data: unknown) => {
				addCalls += 1;
				if (mode === "all" || addCalls === 1) {
					throw new Error("forced add failure");
				}
				return real.add(data as never);
			},
		} as unknown as lancedb.Table;

		await fn(store);
		return { addCalls };
	} finally {
		await store.close();
	}
}

type ThrownUpdateError = {
	name?: string;
	message?: string;
	rowRestored?: boolean;
	cause?: unknown;
};

async function captureThrow(
	fn: () => Promise<unknown>,
): Promise<ThrownUpdateError | null> {
	try {
		await fn();
		return null;
	} catch (error) {
		return error as ThrownUpdateError;
	}
}

// ============================================================================
// updateUnitSummary
// ============================================================================

describe("updateUnitSummary", () => {
	test("a forced add failure leaves the row COUNT unchanged, and throws", async () => {
		await withFreshStore((s) => s.addCodeUnits([unit("a"), unit("b")]));
		expect(await rowIds()).toEqual(["unit-a", "unit-b"]);

		let thrown: ThrownUpdateError | null = null;
		const { addCalls } = await withFailingAdd("first", async (s) => {
			thrown = await captureThrow(() => s.updateUnitSummary("unit-a", "new"));
		});

		// The row survived. This is the assertion the bug was invisible to.
		expect(await rowIds()).toEqual(["unit-a", "unit-b"]);
		// ...and it survived UNCHANGED, not as a half-written husk.
		const restored = await readRow("unit-a");
		expect(restored.summary).toBe("");
		expect(restored.content).toBe("class a {}");
		expect(Array.from(restored.vector as ArrayLike<number>)).toEqual(
			vec(2).map((v) => Math.fround(v)),
		);

		// The failure reached the caller instead of being warned about.
		expect(thrown).not.toBeNull();
		expect((thrown as ThrownUpdateError).name).toBe("VectorStoreUpdateError");
		expect((thrown as ThrownUpdateError).rowRestored).toBe(true);
		expect(
			((thrown as ThrownUpdateError).cause as Error | undefined)?.message,
		).toBe("forced add failure");

		// 1 failed update add + 1 restore add.
		expect(addCalls).toBe(2);
	});

	test("when the restore ALSO fails the caller is told the row is gone", async () => {
		await withFreshStore((s) => s.addCodeUnits([unit("a"), unit("b")]));

		let thrown: ThrownUpdateError | null = null;
		await withFailingAdd("all", async (s) => {
			thrown = await captureThrow(() => s.updateUnitSummary("unit-a", "new"));
		});

		// Nothing can restore a committed delete when every add fails. The
		// point of this case is that it is REPORTED rather than swallowed.
		expect(await rowIds()).toEqual(["unit-b"]);
		expect((thrown as unknown as ThrownUpdateError)?.name).toBe(
			"VectorStoreUpdateError",
		);
		expect((thrown as unknown as ThrownUpdateError)?.rowRestored).toBe(false);
		expect((thrown as unknown as ThrownUpdateError)?.message).toContain(
			"NOT restored",
		);
	});

	test("a real update keeps every row and writes the summary", async () => {
		await withFreshStore((s) => s.addCodeUnits([unit("a"), unit("b")]));

		await withFreshStore((s) => s.updateUnitSummary("unit-a", "a summary"));

		expect(await rowIds()).toEqual(["unit-a", "unit-b"]);
		expect((await readRow("unit-a")).summary).toBe("a summary");
	});

	test("an unknown id is a no-op, not a throw", async () => {
		await withFreshStore((s) => s.addCodeUnits([unit("a")]));

		await withFreshStore((s) => s.updateUnitSummary("unit-nope", "x"));

		expect(await rowIds()).toEqual(["unit-a"]);
	});

	// A keyword-only (BM25) index stores the placeholder vector `[0]`, which the
	// indexer's reuse path recognises by `length > 1`. The pre-delete dimension
	// guard added here must pass it: it refuses 0, not 1. Rejecting a BM25 row
	// would turn every enrichment write-back on such an index into a throw.
	test("a placeholder [0] vector is not mistaken for an empty one", async () => {
		await withFreshStore((s) =>
			s.addCodeUnits([unit("bm25", { vector: [0] })]),
		);

		await withFreshStore((s) => s.updateUnitSummary("unit-bm25", "keyword"));

		expect(await rowIds()).toEqual(["unit-bm25"]);
		expect((await readRow("unit-bm25")).summary).toBe("keyword");
	});

	// The equality escaper's half of the same round trip. `store-filter-
	// escaping.test.ts` could not assert this while the re-add always failed —
	// the row vanished whatever the predicate did — and `rowToCodeUnit` does not
	// map `summary`, so the raw reader here is what makes it checkable.
	test("an underscored id round-trips", async () => {
		await withFreshStore((s) => s.addCodeUnits([unit("a", { id: "unit_a" })]));

		await withFreshStore((s) => s.updateUnitSummary("unit_a", "underscored"));

		expect(await rowIds()).toEqual(["unit_a"]);
		expect((await readRow("unit_a")).summary).toBe("underscored");
	});
});

// ============================================================================
// updateDocumentContent
// ============================================================================

describe("updateDocumentContent", () => {
	test("a forced add failure leaves the row COUNT unchanged, and throws", async () => {
		await withFreshStore((s) => s.addDocuments([doc("a"), doc("b")]));
		expect(await rowIds()).toEqual(["doc-a", "doc-b"]);

		let thrown: ThrownUpdateError | null = null;
		await withFailingAdd("first", async (s) => {
			thrown = await captureThrow(() =>
				s.updateDocumentContent("doc-a", "new content", vec(7)),
			);
		});

		expect(await rowIds()).toEqual(["doc-a", "doc-b"]);
		const restored = await readRow("doc-a");
		expect(restored.content).toBe("summary of a");
		expect(Array.from(restored.vector as ArrayLike<number>)).toEqual(
			vec(3).map((v) => Math.fround(v)),
		);

		expect((thrown as unknown as ThrownUpdateError)?.name).toBe(
			"VectorStoreUpdateError",
		);
		expect((thrown as unknown as ThrownUpdateError)?.rowRestored).toBe(true);
	});

	test("when the restore ALSO fails the caller is told the row is gone", async () => {
		await withFreshStore((s) => s.addDocuments([doc("a"), doc("b")]));

		let thrown: ThrownUpdateError | null = null;
		await withFailingAdd("all", async (s) => {
			thrown = await captureThrow(() =>
				s.updateDocumentContent("doc-a", "new content", vec(7)),
			);
		});

		expect(await rowIds()).toEqual(["doc-b"]);
		expect((thrown as unknown as ThrownUpdateError)?.rowRestored).toBe(false);
	});

	test("a real update keeps every row and writes the content", async () => {
		await withFreshStore((s) => s.addDocuments([doc("a"), doc("b")]));

		const updated = await withFreshStore((s) =>
			s.updateDocumentContent("doc-a", "new content", vec(7)),
		);

		expect(updated).toBe(true);
		expect(await rowIds()).toEqual(["doc-a", "doc-b"]);
		expect((await readRow("doc-a")).content).toBe("new content");
	});

	// `false` now means exactly one thing — no such document — and a failed
	// write throws. Before the fix both outcomes returned `false`, which is why
	// the one caller could not act on it.
	test("an unknown id returns false and destroys nothing", async () => {
		await withFreshStore((s) => s.addDocuments([doc("a")]));

		const updated = await withFreshStore((s) =>
			s.updateDocumentContent("doc-nope", "x", vec(7)),
		);

		expect(updated).toBe(false);
		expect(await rowIds()).toEqual(["doc-a"]);
	});

	// The delete must not commit when the incoming vector is empty: a 0-length
	// vector cannot be written (CLAUDE.md #15) and the row would be destroyed
	// for nothing. Fail before the delete, not after it.
	test("an empty replacement vector is refused BEFORE the delete", async () => {
		await withFreshStore((s) => s.addDocuments([doc("a")]));

		const thrown = await captureThrow(() =>
			withFreshStore((s) => s.updateDocumentContent("doc-a", "new", [])),
		);

		expect(thrown?.name).toBe("ZeroDimensionVectorError");
		expect(await rowIds()).toEqual(["doc-a"]);
		expect((await readRow("doc-a")).content).toBe("summary of a");
	});
});

// ============================================================================
// The shared root cause: a vector read back out of LanceDB must be writable
// ============================================================================

describe("vector round-trip", () => {
	// `getChunksWithVectors` feeds the indexer's incremental-reuse path
	// (indexer.ts, `reuseFromLance`), which hands the vector straight back to
	// `addChunks`. Declared `number[]`; on LanceDB 0.38 it was an Arrow
	// `Vector`, and the re-add threw "Found field not in schema: vector.isValid"
	// — the exit-1 seen when a modified file meets a degraded embedding cache.
	test("getChunksWithVectors returns a plain array, not an Arrow Vector", async () => {
		await withFreshStore((s) => s.addChunks([chunk("a")]));

		const chunks = await withFreshStore((s) =>
			s.getChunksWithVectors("/p/a.ts"),
		);

		expect(chunks).toHaveLength(1);
		expect(Array.isArray(chunks[0].vector)).toBe(true);
	});

	test("a vector read back can be written back — and keeps its bits", async () => {
		await withFreshStore((s) => s.addChunks([chunk("a")]));
		const chunks = await withFreshStore((s) =>
			s.getChunksWithVectors("/p/a.ts"),
		);
		const reused = chunks[0].vector;

		await withFreshStore((s) =>
			s.addChunks([
				chunk("a", {
					id: "chunk-reused",
					contentHash: "hash-a",
					vector: reused,
				}),
			]),
		);

		expect(await rowIds()).toEqual(["chunk-a", "chunk-reused"]);
		const before = Array.from(
			(await readRow("chunk-a")).vector as ArrayLike<number>,
		);
		const after = Array.from(
			(await readRow("chunk-reused")).vector as ArrayLike<number>,
		);
		expect(after).toHaveLength(DIM);
		// Bit-identical, element by element: a reused vector that drifted would
		// silently change every search score computed against it.
		for (let i = 0; i < DIM; i++) {
			expect(Object.is(after[i], before[i])).toBe(true);
		}
	});

	// Same shape through the other read that hands a vector back out.
	test("getAllSummaries returns plain arrays", async () => {
		await withFreshStore((s) => s.addDocuments([doc("a")]));

		const summaries = await withFreshStore((s) => s.getAllSummaries());

		expect(summaries).toHaveLength(1);
		expect(Array.isArray(summaries[0].vector)).toBe(true);
		expect(summaries[0].vector).toHaveLength(DIM);
	});
});
