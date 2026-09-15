/**
 * The vector store's half of index version 4 (architecture §3.1, §3.2,
 * §3.2.1): the DECLARED Arrow schema, row membership (`branchIds`, `pathKind`),
 * and the one read seam that returns repo paths absolute (decision D4).
 *
 * Row contents are read back through an INDEPENDENT `lancedb.connect()`, never
 * through the store that wrote them.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import {
	codeChunksSchema,
	createVectorStore,
	type IVectorStore,
	type RowMembership,
	StoredPathConventionError,
} from "../../../src/core/store.js";
import type {
	ChunkWithEmbedding,
	CodeUnitWithEmbedding,
	DocumentWithEmbedding,
} from "../../../src/types.js";

const DIM = 3;
const REPO_ROWS: RowMembership = { pathKind: "repo", branchId: 4 };
const SHARED_ROWS: RowMembership = { pathKind: "synthetic", branchId: 0 };

const V3_FIELDS = [
	"id",
	"contentHash",
	"content",
	"filePath",
	"startLine",
	"endLine",
	"language",
	"chunkType",
	"name",
	"parentName",
	"signature",
	"fileHash",
	"vector",
	"embedKey",
	"documentType",
	"sourceIds",
	"metadata",
	"createdAt",
	"enrichedAt",
	"parentId",
	"unitType",
	"depth",
	"summary",
];
const V4_FIELDS = [...V3_FIELDS, "branchIds", "pathKind"];

let root: string;
let vectorsDir: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "store-v4-"));
	vectorsDir = join(root, ".mnemex", "vectors");
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function vec(seed: number): number[] {
	return Array.from({ length: DIM }, (_, i) => ((seed + i) % 10) / 10 + 0.01);
}

function chunk(id: string, filePath: string): ChunkWithEmbedding {
	return {
		id,
		contentHash: `hash-${id}`,
		content: `function parseConfig_${id}() { return 1; }`,
		filePath,
		startLine: 1,
		endLine: 3,
		language: "typescript",
		chunkType: "function",
		name: id,
		fileHash: `file-${id}`,
		vector: vec(1),
	};
}

function doc(id: string, filePath: string): DocumentWithEmbedding {
	return {
		id,
		content: `Summary of parseConfig ${id}`,
		documentType: "file_summary",
		filePath,
		createdAt: "2026-09-15T00:00:00.000Z",
		vector: vec(2),
	};
}

function unit(id: string, filePath: string): CodeUnitWithEmbedding {
	return {
		id,
		parentId: null,
		unitType: "function",
		filePath,
		startLine: 1,
		endLine: 3,
		language: "typescript",
		content: `function parseConfig_${id}() {}`,
		name: id,
		fileHash: `file-${id}`,
		depth: 1,
		vector: vec(3),
	};
}

async function withStore<T>(
	fn: (store: IVectorStore) => Promise<T>,
	pathRoot = root,
): Promise<T> {
	const store = createVectorStore({ vectorsDir, pathRoot });
	await store.initialize();
	try {
		return await fn(store);
	} finally {
		await store.close();
	}
}

/** The on-disk rows, through a connection the store never touched. */
async function rows(): Promise<Array<Record<string, unknown>>> {
	const db = await lancedb.connect(vectorsDir);
	if (!(await db.tableNames()).includes("code_chunks")) return [];
	const table = await db.openTable("code_chunks");
	return (await table.query().toArray()) as Array<Record<string, unknown>>;
}

async function fieldNames(): Promise<string[]> {
	const db = await lancedb.connect(vectorsDir);
	const table = await db.openTable("code_chunks");
	return (await table.schema()).fields.map((f: { name: string }) => f.name);
}

/** A 23-column table exactly as an index-v3 build created it: by inference. */
async function createV3Table(): Promise<void> {
	const db = await lancedb.connect(vectorsDir);
	const v3Row: Record<string, unknown> = {};
	for (const field of V3_FIELDS) v3Row[field] = "";
	Object.assign(v3Row, {
		id: "legacy",
		filePath: "/abs/legacy.ts",
		startLine: 1,
		endLine: 1,
		depth: -1,
		vector: vec(9),
		documentType: "code_chunk",
	});
	await db.createTable("code_chunks", [v3Row], { mode: "create" });
}

function describeField(f: {
	name: string;
	type: unknown;
	nullable: boolean;
}): string {
	return `${f.name}:${String(f.type)}:${f.nullable}`;
}

describe("the declared schema (§3.2)", () => {
	test("is field for field what LanceDB INFERRED for a v3 row, plus branchIds and pathKind", async () => {
		await createV3Table();
		const db = await lancedb.connect(vectorsDir);
		const inferred = (await (await db.openTable("code_chunks")).schema())
			.fields;
		const declared = await db.createEmptyTable(
			"declared",
			codeChunksSchema(DIM),
		);
		const round = (await declared.schema()).fields;

		expect(round.slice(0, V3_FIELDS.length).map(describeField)).toEqual(
			inferred.map(describeField),
		);
		expect(round.slice(V3_FIELDS.length).map(describeField)).toEqual([
			"branchIds:Utf8:true",
			"pathKind:Utf8:true",
		]);
	});

	test("all three write paths create a table of exactly the declared 25 fields", async () => {
		for (const write of [
			(s: IVectorStore) => s.addChunks([chunk("c", "src/a.ts")], REPO_ROWS),
			(s: IVectorStore) => s.addDocuments([doc("d", "src/a.ts")], REPO_ROWS),
			(s: IVectorStore) => s.addCodeUnits([unit("u", "src/a.ts")], REPO_ROWS),
		]) {
			rmSync(vectorsDir, { recursive: true, force: true });
			await withStore(write);
			expect(await fieldNames()).toEqual(V4_FIELDS);
		}
	});

	test("rows from all three writers live in one table", async () => {
		await withStore(async (s) => {
			await s.addDocuments([doc("d", "src/a.ts")], REPO_ROWS);
			await s.addChunks([chunk("c", "src/a.ts")], REPO_ROWS);
			await s.addCodeUnits([unit("u", "src/a.ts")], REPO_ROWS);
		});
		expect((await rows()).map((r) => r.id).sort()).toEqual(["c", "d", "u"]);
	});
});

describe("V4.4: a v4 batch cannot land on a live v3 table, which is why the bump is mandatory", () => {
	test("rejected with `Found field not in schema`", async () => {
		await createV3Table();
		await expect(
			withStore((s) => s.addChunks([chunk("new", "src/a.ts")], REPO_ROWS)),
		).rejects.toThrow(/Found field not in schema/);
		expect((await rows()).map((r) => r.id)).toEqual(["legacy"]);
	});

	test("control: the same batch against a table that has branchIds is NOT rejected", async () => {
		await withStore((s) =>
			s.addChunks([chunk("first", "src/a.ts")], REPO_ROWS),
		);
		await withStore((s) =>
			s.addChunks([chunk("second", "src/b.ts")], REPO_ROWS),
		);
		expect((await rows()).map((r) => r.id).sort()).toEqual(["first", "second"]);
	});
});

describe("hasBranchIdsColumn: the LanceDB upgrade signal (§6.1)", () => {
	test("null with no table: a fresh index, NOT an upgrade", async () => {
		expect(await withStore((s) => s.hasBranchIdsColumn())).toBeNull();
	});

	test("false on a v3 table", async () => {
		await createV3Table();
		expect(await withStore((s) => s.hasBranchIdsColumn())).toBe(false);
	});

	test("true on a table this build wrote", async () => {
		await withStore((s) => s.addChunks([chunk("c", "src/a.ts")], REPO_ROWS));
		expect(await withStore((s) => s.hasBranchIdsColumn())).toBe(true);
	});
});

describe("row membership (§3.2.1), on disk", () => {
	test("repo rows carry `,<id>,` and pathKind repo; shared rows `,0,` and synthetic", async () => {
		await withStore(async (s) => {
			await s.addChunks([chunk("code", "src/a.ts")], REPO_ROWS);
			await s.addChunks([chunk("docs", "docs:react")], SHARED_ROWS);
			await s.addCodeUnits([unit("unit", "src/a.ts")], REPO_ROWS);
			await s.addDocuments([doc("summary", "src/a.ts")], REPO_ROWS);
		});
		const byId = new Map((await rows()).map((r) => [r.id, r]));
		for (const id of ["code", "unit", "summary"]) {
			expect(byId.get(id)?.branchIds).toBe(",4,");
			expect(byId.get(id)?.pathKind).toBe("repo");
			expect(byId.get(id)?.filePath).toBe("src/a.ts");
		}
		expect(byId.get("docs")?.branchIds).toBe(",0,");
		expect(byId.get("docs")?.pathKind).toBe("synthetic");
		expect(byId.get("docs")?.filePath).toBe("docs:react");
	});

	test.each([
		["absolute", "/abs/src/a.ts"],
		["empty", ""],
		["escaping", "../outside.ts"],
	])(
		"a repo row with an %s path is refused, and nothing is written",
		async (_what, filePath) => {
			await expect(
				withStore((s) => s.addChunks([chunk("bad", filePath)], REPO_ROWS)),
			).rejects.toThrow(StoredPathConventionError);
			expect(await rows()).toEqual([]);
		},
	);

	test("a write with no membership is refused, even an empty one", async () => {
		await expect(
			withStore((s) => s.addChunks([], undefined as unknown as RowMembership)),
		).rejects.toThrow(TypeError);
	});

	test("a branch id that is not a safe integer >= 0 is refused", async () => {
		await expect(
			withStore((s) =>
				s.addChunks([chunk("c", "src/a.ts")], {
					pathKind: "repo",
					branchId: -1,
				}),
			),
		).rejects.toThrow(RangeError);
		expect(await rows()).toEqual([]);
	});
});

describe("the read seam: repo paths come back absolute, synthetic ones as stored (D4)", () => {
	async function seed(): Promise<void> {
		await withStore(async (s) => {
			await s.addChunks([chunk("code", "src/a.ts")], REPO_ROWS);
			await s.addChunks([chunk("docs", "docs:react")], SHARED_ROWS);
			await s.addCodeUnits([unit("unit", "src/a.ts")], REPO_ROWS);
			await s.addDocuments([doc("summary", "src/a.ts")], REPO_ROWS);
		});
	}

	test("search: the repo row is absolute under pathRoot, the docs row untouched", async () => {
		await seed();
		const results = await withStore((s) =>
			s.search("parseConfig", undefined, { limit: 10, keywordOnly: true }),
		);
		const paths = results.map((r) => r.chunk.filePath).sort();
		expect(paths).toContain(join(root, "src/a.ts"));
		expect(paths).toContain("docs:react");
		expect(paths.every((p) => p === "docs:react" || p.startsWith(root))).toBe(
			true,
		);
	});

	test("path-keyed reads accept the absolute or the stored path, and return absolute", async () => {
		await seed();
		await withStore(async (s) => {
			for (const arg of [join(root, "src/a.ts"), "src/a.ts"]) {
				const chunks = await s.getChunksWithVectors(arg);
				expect(chunks.map((c) => [c.id, c.filePath])).toEqual([
					["code", join(root, "src/a.ts")],
				]);
				// Typed: with no type filter `getDocumentsByFile` returns every row
				// of the path, chunks and units included (unchanged behaviour).
				const docs = await s.getDocumentsByFile(arg, ["file_summary"]);
				expect(docs.map((d) => [d.id, d.filePath])).toEqual([
					["summary", join(root, "src/a.ts")],
				]);
				const units = await s.getCodeUnitsByFile(arg);
				expect(units.map((u) => [u.id, u.filePath])).toEqual([
					["unit", join(root, "src/a.ts")],
				]);
			}
		});
	});

	test("a path outside pathRoot matches nothing and deletes nothing", async () => {
		await seed();
		const outside = join(tmpdir(), "somewhere-else", "src", "a.ts");
		await withStore(async (s) => {
			expect(await s.getChunksWithVectors(outside)).toEqual([]);
			expect(await s.deleteByFile(outside)).toBe(0);
		});
		expect((await rows()).length).toBe(4);
	});

	test("deleteByFile on the absolute path deletes the stored rows, counted independently", async () => {
		await seed();
		const deleted = await withStore((s) =>
			s.deleteByFile(join(root, "src/a.ts")),
		);
		const left = (await rows()).map((r) => r.id).sort();
		expect(deleted).toBe(3);
		expect(left).toEqual(["docs"]);
	});
});
