/**
 * Delete predicates must escape their values.
 *
 * `deleteByFile` / `deleteByFileHash` interpolated straight into a DataFusion
 * predicate:
 *
 *     await table.delete(`filePath = '${filePath}'`);
 *
 * A single quote is legal in a path on macOS and Linux (`src/o'brien.ts`), and
 * it terminates the string literal early. LanceDB then rejects the statement —
 * verified against 0.33: "Error tokenizing statement ... Unterminated string
 * literal" — the surrounding `catch` swallows it, and the method returns 0.
 * Zero is also what "there was nothing to delete" returns, so the delete failed
 * silently: exactly the class of bug the lazy-open fix in
 * `store-delete-lazy-open.test.ts` set out to remove, one level down, and now
 * more reachable because these deletes actually execute.
 *
 * A value that closes the quote and appends its own SQL is worse than an error:
 * `x' OR filePath LIKE '%` makes a well-formed predicate that deletes the whole
 * table.
 *
 * The escape is SQL-standard quote doubling, which is what LanceDB's own
 * `toSQL()` helper (`@lancedb/lancedb/dist/util.js`) does for string literals.
 * It is deliberately NOT the module's `escapeFilterValue`, which additionally
 * backslash-escapes `%` and `_` for LIKE patterns — correct there, wrong for an
 * equality literal, where DataFusion takes the backslash literally and the row
 * stops matching. The `my_file.ts` / `100%report.ts` / backslash cases below
 * pin that distinction: they are ordinary paths that must keep working.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVectorStore } from "../../../src/core/store.js";
import type { ChunkWithEmbedding } from "../../../src/types.js";

const DIM = 8;

/** A deterministic non-zero vector — store.ts rejects zero-dimension batches. */
function vec(seed: number): number[] {
	return Array.from({ length: DIM }, (_, i) => ((seed + i) % 10) / 10 + 0.01);
}

/**
 * A chunk whose content carries a unique marker, so survivors can be read back
 * with `getChunkContents()` — an UNFILTERED scan. Reading back through
 * `getChunksWithVectors()` would route the assertion through
 * `escapeFilterValue`, whose LIKE escaping mangles `_` and `%` and would report
 * a surviving row as deleted.
 */
function chunk(
	marker: string,
	filePath: string,
	fileHash: string,
	seed = 1,
): ChunkWithEmbedding {
	return {
		id: `id-${marker}`,
		contentHash: `hash-${marker}`,
		content: `function f() { return parseConfig(); } // MARKER:${marker}`,
		filePath,
		startLine: 1,
		endLine: 10,
		language: "typescript",
		chunkType: "function",
		name: `f-${marker}`,
		fileHash,
		vector: vec(seed),
	};
}

let dir: string;
let dbPath: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "mnemex-delete-escape-"));
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

async function seed(chunks: ChunkWithEmbedding[]): Promise<void> {
	await withFreshStore((store) => store.addChunks(chunks));
}

/** Markers still in the store, read with no predicate at all. */
async function survivors(): Promise<string[]> {
	return withFreshStore(async (store) => {
		const contents = await store.getChunkContents();
		return contents
			.map((c) => c.match(/MARKER:(\S+)/)?.[1])
			.filter((m): m is string => m !== undefined)
			.sort();
	});
}

describe("deleteByFile with a quote in the path", () => {
	test("deletes the file whose path contains a single quote", async () => {
		const quoted = "src/o'brien.ts";
		await seed([
			chunk("quoted", quoted, "file-quoted", 1),
			chunk("plain", "src/plain.ts", "file-plain", 2),
		]);

		const deleted = await withFreshStore((store) => store.deleteByFile(quoted));

		// The unescaped predicate made LanceDB throw, the catch returned 0, and
		// the row stayed behind while the caller was told nothing needed doing.
		expect(deleted).toBe(1);
		expect(await survivors()).toEqual(["plain"]);
	});

	test("a path that closes the quote cannot delete unrelated rows", async () => {
		await seed([
			chunk("alpha", "src/alpha.ts", "file-alpha", 1),
			chunk("beta", "src/beta.ts", "file-beta", 2),
		]);

		// Unescaped this becomes `filePath = 'x' OR filePath LIKE '%'` — valid
		// SQL that matches every row, so the whole table goes.
		await withFreshStore((store) =>
			store.deleteByFile("x' OR filePath LIKE '%"),
		);

		expect(await survivors()).toEqual(["alpha", "beta"]);
	});
});

describe("deleteByFileHash with a quote in the hash", () => {
	test("deletes the chunks whose file hash contains a single quote", async () => {
		await seed([
			chunk("quoted", "src/quoted.ts", "file-o'brien", 1),
			chunk("plain", "src/plain.ts", "file-plain", 2),
		]);

		const deleted = await withFreshStore((store) =>
			store.deleteByFileHash("file-o'brien"),
		);

		expect(deleted).toBe(1);
		expect(await survivors()).toEqual(["plain"]);
	});

	test("a hash that closes the quote cannot delete unrelated rows", async () => {
		await seed([
			chunk("alpha", "src/alpha.ts", "file-alpha", 1),
			chunk("beta", "src/beta.ts", "file-beta", 2),
		]);

		await withFreshStore((store) =>
			store.deleteByFileHash("x' OR fileHash LIKE '%"),
		);

		expect(await survivors()).toEqual(["alpha", "beta"]);
	});
});

describe("ordinary paths keep working", () => {
	// These are the cases that reject `escapeFilterValue` as the escape: its
	// `%` / `_` / backslash handling is for LIKE patterns, and an equality
	// literal that carries those escapes matches nothing.

	test.each([
		["underscore", "src/my_file.ts"],
		["percent", "src/100%report.ts"],
		["backslash", "src/back\\slash.ts"],
		["ordinary", "src/plain.ts"],
	])("deleteByFile removes a %s path", async (_label, target) => {
		await seed([
			chunk("target", target, "file-target", 1),
			chunk("other", "src/other.ts", "file-other", 2),
		]);

		const deleted = await withFreshStore((store) => store.deleteByFile(target));

		expect(deleted).toBe(1);
		expect(await survivors()).toEqual(["other"]);
	});

	test("deleteByFileHash removes a hash with LIKE metacharacters", async () => {
		await seed([
			chunk("target", "src/target.ts", "hash_with%meta", 1),
			chunk("other", "src/other.ts", "file-other", 2),
		]);

		await withFreshStore((store) => store.deleteByFileHash("hash_with%meta"));

		expect(await survivors()).toEqual(["other"]);
	});

	test("a quoted path is not deleted by a delete aimed at another file", async () => {
		await seed([
			chunk("quoted", "src/o'brien.ts", "file-quoted", 1),
			chunk("plain", "src/plain.ts", "file-plain", 2),
		]);

		await withFreshStore((store) => store.deleteByFile("src/plain.ts"));

		expect(await survivors()).toEqual(["quoted"]);
	});
});
