/**
 * `deleteByFile` returns the number of rows LanceDB actually deleted.
 *
 * It returned a hardcoded 1 under the comment "LanceDB doesn't return count".
 * That comment is stale: LanceDB 0.38's `Table.delete` resolves to
 * `DeleteResult { numDeletedRows, version }`
 * (`node_modules/@lancedb/lancedb/dist/native.d.ts`). The constant is what let
 * the ghost-chunk defect pass for success: a delete that matched zero rows
 * reported 1, and its one caller could not tell
 * (`findings/deleted-files-leave-ghost-chunks.md`).
 *
 * Every count here is also read through an INDEPENDENT LanceDB connection the
 * store under test never touches. A return value alone cannot show a row that
 * is still there.
 *
 * The existing delete suites seed ONE row per file, where the constant 1 and
 * the real count agree, so they could not tell the two apart. These seed
 * several.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import { createVectorStore } from "../../../src/core/store.js";
import type { ChunkWithEmbedding } from "../../../src/types.js";

const DIM = 8;
/** `store.ts`'s table name. A wrong name makes `openTable` throw, not pass. */
const CHUNKS_TABLE = "code_chunks";

/** A deterministic non-zero vector: store.ts rejects zero-dimension batches. */
function vec(seed: number): number[] {
	return Array.from({ length: DIM }, (_, i) => ((seed + i) % 10) / 10 + 0.01);
}

function chunk(filePath: string, n: number): ChunkWithEmbedding {
	const id = `${filePath}#${n}`;
	return {
		id,
		contentHash: `hash-${id}`,
		content: `function f${n}() { return ${n}; } // ${id}`,
		filePath,
		startLine: n * 10 + 1,
		endLine: n * 10 + 9,
		language: "typescript",
		chunkType: "function",
		name: `f${n}`,
		fileHash: `file-${filePath}`,
		vector: vec(n),
	};
}

let dir: string;
let vectorsDir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "mnemex-delete-count-"));
	vectorsDir = join(dir, "vectors");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** Fresh instance, initialize, use, close: exactly what every caller does. */
async function withStore<T>(
	fn: (store: ReturnType<typeof createVectorStore>) => Promise<T>,
): Promise<T> {
	const store = createVectorStore({ vectorsDir, pathRoot: dir });
	await store.initialize();
	try {
		return await fn(store);
	} finally {
		await store.close();
	}
}

/**
 * Row counts through a connection of its own. Equality predicate, so the
 * value is quote-doubled and nothing else (CLAUDE.md #22).
 */
async function independentCounts(
	filePath: string,
): Promise<{ total: number; forFile: number }> {
	const db = await lancedb.connect(vectorsDir);
	const table = await db.openTable(CHUNKS_TABLE);
	const total = await table.countRows();
	const forFile = await table.countRows(
		`filePath = '${filePath.replaceAll("'", "''")}'`,
	);
	return { total, forFile };
}

const MULTI = "src/multi.ts";
const OTHER = "src/other.ts";

async function seedFiveRows(): Promise<void> {
	await withStore((store) =>
		store.addChunks([
			chunk(MULTI, 1),
			chunk(MULTI, 2),
			chunk(MULTI, 3),
			chunk(OTHER, 4),
			chunk(OTHER, 5),
		]),
	);
}

describe("deleteByFile returns LanceDB's real delete count", () => {
	test("a three-row file reports 3, and exactly those rows are gone", async () => {
		await seedFiveRows();
		// Precondition, through the same independent connection: the fixture is
		// what the assertions below assume.
		expect(await independentCounts(MULTI)).toEqual({ total: 5, forFile: 3 });

		const deleted = await withStore((store) => store.deleteByFile(MULTI));

		expect(deleted).toBe(3);
		expect(await independentCounts(MULTI)).toEqual({ total: 2, forFile: 0 });
		expect((await independentCounts(OTHER)).forFile).toBe(2);
	});

	test("a delete that matches nothing reports 0 and removes nothing", async () => {
		await seedFiveRows();

		const deleted = await withStore((store) =>
			store.deleteByFile("src/absent.ts"),
		);

		// The constant made this read 1: a no-op indistinguishable from work.
		expect(deleted).toBe(0);
		expect(await independentCounts(MULTI)).toEqual({ total: 5, forFile: 3 });
	});

	test("a second delete of the same file reports 0", async () => {
		await seedFiveRows();

		const first = await withStore((store) => store.deleteByFile(MULTI));
		const second = await withStore((store) => store.deleteByFile(MULTI));

		expect([first, second]).toEqual([3, 0]);
		expect(await independentCounts(MULTI)).toEqual({ total: 2, forFile: 0 });
	});
});
