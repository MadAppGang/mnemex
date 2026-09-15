/**
 * `VectorStore` takes `pathRoot` from its caller and never derives it.
 *
 * The constructor used to default it to `dirname(dirname(dbPath))`. That names
 * the project only while the store sits at `<project>/.mnemex/vectors`. With
 * the store anywhere else (an index-dir override, a benchmark temp store, and
 * from Phase 3c the git common dir) it names a different directory, and
 * whatever reads it silently answers for the wrong project. Today that reader
 * is `getTestFileMode`, which loads the project's `testFiles` setting.
 *
 * The fixture puts the store OUTSIDE the project and gives the project a
 * `mnemex.json` with `testFiles: "exclude"`. A store that honours `pathRoot`
 * drops the test file from results. A store that derives its root from the
 * store path finds no config there, falls back to "downrank", and keeps it.
 *
 * The control passes the store's own grandparent as `pathRoot`: exactly the
 * directory the deleted derivation produced. It shows the test file IS
 * retrievable, so the main assertion cannot pass by returning nothing.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { createVectorStore } from "../../../src/core/store.js";
import type { ChunkWithEmbedding } from "../../../src/types.js";

const DIM = 8;

/** A deterministic non-zero vector: store.ts rejects zero-dimension batches. */
function vec(seed: number): number[] {
	return Array.from({ length: DIM }, (_, i) => ((seed + i) % 10) / 10 + 0.01);
}

function chunk(
	name: string,
	filePath: string,
	seed: number,
): ChunkWithEmbedding {
	return {
		id: `chunk-${name}`,
		contentHash: `hash-${name}`,
		content: `function ${name}() { return parseConfig(); }`,
		filePath,
		startLine: 1,
		endLine: 3,
		language: "typescript",
		chunkType: "function",
		name,
		fileHash: `file-${name}`,
		vector: vec(seed),
	};
}

const SOURCE = "src/parser.ts";
const TEST_FILE = "src/parser.test.ts";

/** The project: holds `mnemex.json`, and no store. */
let project: string;
/** A separate directory the store sits under, as an override would place it. */
let storeParent: string;
let vectorsDir: string;

beforeEach(() => {
	project = mkdtempSync(join(tmpdir(), "mnemex-pathroot-project-"));
	storeParent = mkdtempSync(join(tmpdir(), "mnemex-pathroot-store-"));
	vectorsDir = join(storeParent, "store", "vectors");
	writeFileSync(
		join(project, "mnemex.json"),
		JSON.stringify({ testFiles: "exclude" }),
	);
});

afterEach(() => {
	rmSync(project, { recursive: true, force: true });
	rmSync(storeParent, { recursive: true, force: true });
});

async function seed(): Promise<void> {
	const store = createVectorStore({ vectorsDir, pathRoot: project });
	await store.initialize();
	try {
		await store.addChunks(
			[chunk("parse", SOURCE, 1), chunk("parseSpec", TEST_FILE, 2)],
			{ pathKind: "repo", branchId: 0 },
		);
	} finally {
		await store.close();
	}
}

async function searchedPaths(pathRoot: string): Promise<string[]> {
	const store = createVectorStore({ vectorsDir, pathRoot });
	await store.initialize();
	try {
		const results = await store.search("parseConfig", undefined, {
			limit: 10,
			keywordOnly: true,
		});
		// The read seam returns repo paths absolute under pathRoot (decision
		// D4); mapped back to the stored form so the two cases compare alike.
		return results.map((r) => relative(pathRoot, r.chunk.filePath)).sort();
	} finally {
		await store.close();
	}
}

describe("VectorStore reads project settings from pathRoot, not from the store's location", () => {
	test("control: the store's grandparent has no config, so the test file IS returned", async () => {
		await seed();
		// What `dirname(dirname(vectorsDir))` named before the fallback was deleted.
		const derived = dirname(dirname(vectorsDir));
		expect(derived).toBe(storeParent);

		expect(await searchedPaths(derived)).toEqual([TEST_FILE, SOURCE]);
	});

	test("testFiles: exclude at pathRoot drops the test file", async () => {
		await seed();

		expect(await searchedPaths(project)).toEqual([SOURCE]);
	});
});
