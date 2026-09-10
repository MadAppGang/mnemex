/**
 * Filter predicates must use the escape that matches their operator.
 *
 * `store.ts` carries two escapers on purpose:
 *
 *   - `escapeFilterValue` doubles quotes AND backslash-escapes `%` and `_`.
 *     Correct for a LIKE pattern, where those two are wildcards.
 *   - `escapeSqlLiteral` doubles quotes and nothing else. Correct for an
 *     equality / IN literal, where DataFusion takes the backslash literally.
 *
 * Verified against the installed LanceDB (0.38) on a real table:
 *
 *     filePath = 'src/my_file.ts'                       -> matches
 *     filePath = 'src/my\_file.ts'                      -> matches NOTHING
 *     documentType IN ('file_summary')                  -> matches
 *     documentType IN ('file\_summary')                 -> matches NOTHING
 *     filePath LIKE '%my\_file%'                        -> literal `_` only
 *     filePath LIKE '%my_file%'                         -> `_` is a wildcard
 *
 * So the two escapers are NOT interchangeable in either direction, and both
 * halves need pinning: the equality sites that were silently matching zero
 * rows, and the LIKE sites that must keep their wildcard escaping.
 *
 * The third failure mode is no escaping at all. `deleteAllByFile` and
 * `getDocumentsByFile` interpolated `filePath` raw. A path is attacker-shaped
 * data as soon as it comes from a repo someone else wrote: `x' OR filePath
 * LIKE '%` renders a VALID predicate matching every row, which turns
 * `deleteAllByFile` into "delete the whole table".
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createVectorStore,
	escapeFilterValue,
	escapeSqlLiteral,
	type IVectorStore,
} from "../../../src/core/store.js";
import type {
	ChunkWithEmbedding,
	CodeUnitWithEmbedding,
	DocumentWithEmbedding,
	UnitType,
} from "../../../src/types.js";

const DIM = 8;

/** Deterministic non-zero vector — store.ts rejects zero-dimension batches. */
function vec(seed: number): number[] {
	return Array.from({ length: DIM }, (_, i) => ((seed + i) % 10) / 10 + 0.01);
}

/** A path that closes the string literal and appends its own predicate. */
const INJECTION = "x' OR filePath LIKE '%";

function chunk(
	marker: string,
	filePath: string,
	seed = 1,
	language = "typescript",
): ChunkWithEmbedding {
	return {
		id: `chunk-${marker}`,
		contentHash: `hash-${marker}`,
		content: `function f() { return parseConfig(); } // MARKER:${marker}`,
		filePath,
		startLine: 1,
		endLine: 10,
		language,
		chunkType: "function",
		name: `f-${marker}`,
		fileHash: `file-${marker}`,
		vector: vec(seed),
	};
}

function doc(
	marker: string,
	filePath: string,
	documentType: DocumentWithEmbedding["documentType"],
	seed = 1,
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

function unit(
	marker: string,
	filePath: string,
	overrides: Partial<CodeUnitWithEmbedding> = {},
): CodeUnitWithEmbedding {
	return {
		id: `unit-${marker}`,
		parentId: null,
		unitType: "function",
		filePath,
		startLine: 1,
		endLine: 10,
		language: "typescript",
		content: `function f() { return parseConfig(); } // MARKER:${marker}`,
		name: `f-${marker}`,
		fileHash: `file-${marker}`,
		depth: 1,
		vector: vec(2),
		...overrides,
	};
}

let dir: string;
let dbPath: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "mnemex-filter-escape-"));
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

async function seedChunks(chunks: ChunkWithEmbedding[]): Promise<void> {
	await withFreshStore((store) => store.addChunks(chunks));
}

async function seedDocs(docs: DocumentWithEmbedding[]): Promise<void> {
	await withFreshStore((store) => store.addDocuments(docs));
}

async function seedUnits(units: CodeUnitWithEmbedding[]): Promise<void> {
	await withFreshStore((store) => store.addCodeUnits(units));
}

/** Markers still in the store, read with NO predicate at all. */
async function survivors(): Promise<string[]> {
	return withFreshStore(async (store) => {
		const contents = await store.getChunkContents();
		return contents
			.map((c) => c.match(/MARKER:(\S+)/)?.[1])
			.filter((m): m is string => m !== undefined)
			.sort();
	});
}

// ============================================================================
// Equality predicates — the LIKE escaper matches zero rows here
// ============================================================================

describe("getChunksWithVectors (filePath equality)", () => {
	// THE performance bug: this feeds incremental reindex vector reuse
	// (indexer.ts). Returning [] for an underscored path means every chunk of
	// every such file is re-embedded on every reindex, silently.
	test.each([
		["underscore", "src/my_file.ts"],
		["percent", "src/100%report.ts"],
		["backslash", "src/back\\slash.ts"],
		["quote", "src/o'brien.ts"],
		["ordinary", "src/plain.ts"],
	])("finds the chunks of a %s path", async (_label, target) => {
		await seedChunks([
			chunk("target", target, 1),
			chunk("other", "src/other.ts", 2),
		]);

		const found = await withFreshStore((store) =>
			store.getChunksWithVectors(target),
		);

		expect(found.map((c) => c.filePath)).toEqual([target]);
		expect(found[0].vector.length).toBe(DIM);
	});

	test("a path that closes the quote matches nothing", async () => {
		await seedChunks([
			chunk("alpha", "src/alpha.ts", 1),
			chunk("beta", "src/beta.ts", 2),
		]);

		const found = await withFreshStore((store) =>
			store.getChunksWithVectors(INJECTION),
		);

		expect(found).toEqual([]);
	});
});

describe("search language filter (equality)", () => {
	test("matches a language identifier containing an underscore", async () => {
		await seedChunks([
			chunk("sharp", "src/a.cs", 1, "c_sharp"),
			chunk("ts", "src/b.ts", 2, "typescript"),
		]);

		const results = await withFreshStore((store) =>
			store.search("parseConfig", vec(1), { limit: 10, language: "c_sharp" }),
		);

		expect(results.map((r) => r.chunk.filePath)).toEqual(["src/a.cs"]);
	});

	test("searchDocuments matches the same language identifier", async () => {
		await seedChunks([
			chunk("sharp", "src/a.cs", 1, "c_sharp"),
			chunk("ts", "src/b.ts", 2, "typescript"),
		]);

		const results = await withFreshStore((store) =>
			store.searchDocuments("parseConfig", vec(1), {
				limit: 10,
				language: "c_sharp",
			}),
		);

		expect(results.length).toBeGreaterThan(0);
		expect(results.every((r) => r.document.filePath === "src/a.cs")).toBe(true);
	});
});

describe("searchDocuments documentType IN (equality semantics)", () => {
	// Every DocumentType but `idiom` contains an underscore
	// (`file_summary`, `symbol_summary`, `usage_example`, `anti_pattern`, ...),
	// so the LIKE escaper made this filter match NOTHING — a type-filtered
	// enriched search returned zero results for every type it could name.
	test("finds documents whose type name contains an underscore", async () => {
		await seedDocs([
			doc("summary", "src/a.ts", "file_summary", 1),
			doc("idiom", "src/b.ts", "idiom", 2),
		]);

		const results = await withFreshStore((store) =>
			store.searchDocuments("parseConfig", vec(1), {
				limit: 10,
				documentTypes: ["file_summary"],
			}),
		);

		expect(results.length).toBeGreaterThan(0);
		expect(results.every((r) => r.documentType === "file_summary")).toBe(true);
	});

	test("the default enriched-only type list is not empty", async () => {
		await seedDocs([
			doc("summary", "src/a.ts", "file_summary", 1),
			doc("example", "src/b.ts", "usage_example", 2),
		]);

		const results = await withFreshStore((store) =>
			store.searchDocuments("parseConfig", vec(1), {
				limit: 10,
				includeCodeChunks: false,
			}),
		);

		expect(results.length).toBeGreaterThan(0);
	});
});

describe("code unit lookups (equality)", () => {
	const path = "src/my_file.ts";

	test("getCodeUnitsByFile finds units of an underscored path", async () => {
		await seedUnits([unit("target", path), unit("other", "src/other.ts")]);

		const units = await withFreshStore((store) =>
			store.getCodeUnitsByFile(path),
		);

		expect(units.map((u) => u.id)).toEqual(["unit-target"]);
	});

	test("getCodeUnitsByDepth filters by an underscored path", async () => {
		await seedUnits([unit("target", path), unit("other", "src/other.ts")]);

		const units = await withFreshStore((store) =>
			store.getCodeUnitsByDepth(1, path),
		);

		expect(units.map((u) => u.id)).toEqual(["unit-target"]);
	});

	test("getMaxDepth filters by an underscored path", async () => {
		await seedUnits([
			unit("target", path, { depth: 3 }),
			unit("other", "src/other.ts", { depth: 7 }),
		]);

		const depth = await withFreshStore((store) => store.getMaxDepth(path));

		expect(depth).toBe(3);
	});

	test("getCodeUnit and getChildUnits match ids containing an underscore", async () => {
		await seedUnits([
			unit("parent", path, { id: "unit_parent", depth: 0, unitType: "file" }),
			unit("child", path, { id: "unit_child", parentId: "unit_parent" }),
		]);

		const { found, children } = await withFreshStore(async (store) => ({
			found: await store.getCodeUnit("unit_parent"),
			children: await store.getChildUnits("unit_parent"),
		}));

		expect(found?.id).toBe("unit_parent");
		expect(children.map((c) => c.id)).toEqual(["unit_child"]);
	});

	// `updateUnitSummary` is asserted end-to-end in
	// `store-update-row-loss.test.ts` ("an underscored id round-trips"), which
	// has the raw row reader `summary` needs — `rowToCodeUnit` does not map it.
	// It could not be asserted anywhere while its delete+insert re-added the row
	// it had just read back from Arrow, which LanceDB rejected with "Found field
	// not in schema: vector.isValid": the unit was DELETED and the summary lost,
	// whatever the predicate did. That is fixed at the read boundary
	// (`toPlainVector`), so the predicate is now observable through it.
	test("updateDocumentContent rewrites a doc whose id contains an underscore", async () => {
		await seedDocs([
			{ ...doc("summary", path, "file_summary", 1), id: "doc_summary" },
		]);

		const { updated, content } = await withFreshStore(async (store) => ({
			updated: await store.updateDocumentContent(
				"doc_summary",
				"new body",
				vec(5),
			),
			content: (await store.getDocumentsByFile(path))[0]?.content,
		}));

		expect(updated).toBe(true);
		expect(content).toBe("new body");
	});
});

// ============================================================================
// Raw interpolation — injection and data loss
// ============================================================================

describe("deleteAllByFile", () => {
	// `deleteAllByFile` now routes through `ensureTableOpen()` like every other
	// method (the lazy-open contract is pinned in
	// `store-delete-lazy-open.test.ts`). Seeding on the SAME instance is kept
	// anyway: it isolates these assertions to the predicate, so a regression
	// here reads as an escaping bug rather than a table-open one.
	async function deleteAllOnOpenStore(
		chunks: ChunkWithEmbedding[],
		target: string,
	): Promise<void> {
		await withFreshStore(async (store) => {
			await store.addChunks(chunks);
			await store.deleteAllByFile(target);
		});
	}

	test("deletes a path containing a single quote, and only that path", async () => {
		await deleteAllOnOpenStore(
			[chunk("quoted", "src/o'brien.ts", 1), chunk("plain", "src/plain.ts", 2)],
			"src/o'brien.ts",
		);

		expect(await survivors()).toEqual(["plain"]);
	});

	test("a path that closes the quote cannot delete unrelated rows", async () => {
		// Raw, this renders `filePath = 'x' OR filePath LIKE '%'` — valid SQL
		// that matches every row. The whole table goes.
		await deleteAllOnOpenStore(
			[chunk("alpha", "src/alpha.ts", 1), chunk("beta", "src/beta.ts", 2)],
			INJECTION,
		);

		expect(await survivors()).toEqual(["alpha", "beta"]);
	});

	test.each([
		["underscore", "src/my_file.ts"],
		["percent", "src/100%report.ts"],
	])("still deletes a %s path", async (_label, target) => {
		await deleteAllOnOpenStore(
			[chunk("target", target, 1), chunk("other", "src/other.ts", 2)],
			target,
		);

		expect(await survivors()).toEqual(["other"]);
	});
});

describe("getDocumentsByFile", () => {
	test("returns the documents of a path containing a single quote", async () => {
		await seedDocs([
			doc("quoted", "src/o'brien.ts", "file_summary", 1),
			doc("plain", "src/plain.ts", "file_summary", 2),
		]);

		const found = await withFreshStore((store) =>
			store.getDocumentsByFile("src/o'brien.ts"),
		);

		expect(found.map((d) => d.id)).toEqual(["doc-quoted"]);
	});

	test("a path that closes the quote matches nothing", async () => {
		await seedDocs([
			doc("alpha", "src/alpha.ts", "file_summary", 1),
			doc("beta", "src/beta.ts", "file_summary", 2),
		]);

		const found = await withFreshStore((store) =>
			store.getDocumentsByFile(INJECTION),
		);

		expect(found).toEqual([]);
	});

	test.each([
		["underscore", "src/my_file.ts"],
		["percent", "src/100%report.ts"],
	])("returns the documents of a %s path", async (_label, target) => {
		await seedDocs([
			doc("target", target, "file_summary", 1),
			doc("other", "src/other.ts", "file_summary", 2),
		]);

		const found = await withFreshStore((store) =>
			store.getDocumentsByFile(target),
		);

		expect(found.map((d) => d.id)).toEqual(["doc-target"]);
	});

	test("the documentType filter still selects underscored type names", async () => {
		await seedDocs([
			doc("summary", "src/a.ts", "file_summary", 1),
			doc("idiom", "src/a.ts", "idiom", 2),
		]);

		const found = await withFreshStore((store) =>
			store.getDocumentsByFile("src/a.ts", ["file_summary"]),
		);

		expect(found.map((d) => d.id)).toEqual(["doc-summary"]);
	});
});

// ============================================================================
// LIKE predicates — guard against over-correction
// ============================================================================

describe("LIKE patterns keep their wildcard escaping", () => {
	// If someone "unifies" the helpers onto `escapeSqlLiteral`, `_` and `%`
	// become wildcards again and these patterns start over-matching.
	test("search pathPattern treats `_` as a literal, not a wildcard", async () => {
		await seedChunks([
			chunk("literal", "src/my_file.ts", 1),
			chunk("wildcard", "src/myXfile.ts", 2),
		]);

		const results = await withFreshStore((store) =>
			store.search("parseConfig", vec(1), {
				limit: 10,
				pathPattern: "my_file",
			}),
		);

		expect(results.map((r) => r.chunk.filePath)).toEqual(["src/my_file.ts"]);
	});

	test("search filePath option treats `%` as a literal", async () => {
		await seedChunks([
			chunk("literal", "src/100%report.ts", 1),
			chunk("wildcard", "src/100report.ts", 2),
		]);

		const results = await withFreshStore((store) =>
			store.search("parseConfig", vec(1), {
				limit: 10,
				filePath: "100%report",
			}),
		);

		expect(results.map((r) => r.chunk.filePath)).toEqual(["src/100%report.ts"]);
	});

	test("searchDocuments pathPattern treats `_` as a literal", async () => {
		await seedChunks([
			chunk("literal", "src/my_file.ts", 1),
			chunk("wildcard", "src/myXfile.ts", 2),
		]);

		const results = await withFreshStore((store) =>
			store.searchDocuments("parseConfig", vec(1), {
				limit: 10,
				pathPattern: "my_file",
			}),
		);

		expect(results.length).toBeGreaterThan(0);
		expect(results.every((r) => r.document.filePath === "src/my_file.ts")).toBe(
			true,
		);
	});

	test("searchCodeUnits filePath treats `_` as a literal", async () => {
		await seedUnits([
			unit("literal", "src/my_file.ts"),
			unit("wildcard", "src/myXfile.ts"),
		]);

		const results = await withFreshStore((store) =>
			store.searchCodeUnits("parseConfig", vec(2), {
				limit: 10,
				filePath: "my_file",
			}),
		);

		expect(results.length).toBeGreaterThan(0);
		expect(results.every((r) => r.filePath === "src/my_file.ts")).toBe(true);
	});
});

// ============================================================================
// IN-lists over the closed `UnitType` union — the switch must be a no-op
// ============================================================================

/**
 * The two `unitType IN (...)` sites (`getCodeUnitsByFile`, `searchCodeUnits`)
 * used to render with `escapeFilterValue`. That was correct only by accident:
 * no `UnitType` member contains a quote, `%` or `_`, so the LIKE escaper is the
 * identity on all seven. The comment that stood there said "if a member ever
 * gains an underscore, switch it to `escapeSqlLiteral`" — a documented landmine
 * rather than a removed one, since nothing would fail when that happened; the
 * filter would just quietly match zero rows.
 *
 * Both sites now use `escapeSqlLiteral`, which is right for IN today AND stays
 * right if the union grows. These tests pin that the switch changed nothing.
 */
describe("unitType IN-lists render identically under either escaper", () => {
	// A total Record makes this exhaustive at COMPILE time: adding a member to
	// `UnitType` without adding it here is a typecheck error, so the assertions
	// below can never silently stop covering the union.
	const UNIT_TYPE_MEMBERS: Record<UnitType, true> = {
		file: true,
		class: true,
		interface: true,
		function: true,
		method: true,
		type: true,
		enum: true,
	};
	const ALL_UNIT_TYPES = Object.keys(UNIT_TYPE_MEMBERS) as UnitType[];

	const renderInList = (escaper: (value: string) => string): string =>
		`unitType IN (${ALL_UNIT_TYPES.map((t) => `'${escaper(t)}'`).join(", ")})`;

	test.each(ALL_UNIT_TYPES)(
		"both escapers are the identity on %s",
		(unitType) => {
			expect(escapeSqlLiteral(unitType)).toBe(unitType);
			expect(escapeFilterValue(unitType)).toBe(unitType);
		},
	);

	test("the rendered predicate is byte-identical either way", () => {
		expect(renderInList(escapeSqlLiteral)).toBe(
			renderInList(escapeFilterValue),
		);
	});

	test("and is the predicate the store actually needs", () => {
		expect(renderInList(escapeSqlLiteral)).toBe(
			"unitType IN ('file', 'class', 'interface', 'function', 'method', 'type', 'enum')",
		);
	});

	test("the two escapers are NOT interchangeable in general", () => {
		// The guard on the test above: it passes because of what `UnitType`
		// contains, not because the helpers agree. Keep the difference visible so
		// nobody reads the byte-identity as licence to merge them.
		expect(escapeSqlLiteral("file_summary")).toBe("file_summary");
		expect(escapeFilterValue("file_summary")).toBe("file\\_summary");
	});
});

describe("unitType filters still select the right rows end to end", () => {
	test("getCodeUnitsByFile narrows to the requested types", async () => {
		await seedUnits([
			unit("fn", "src/a.ts", { unitType: "function" }),
			unit("cls", "src/a.ts", { unitType: "class" }),
			unit("iface", "src/a.ts", { unitType: "interface" }),
		]);

		const units = await withFreshStore((store) =>
			store.getCodeUnitsByFile("src/a.ts", ["class", "interface"]),
		);

		expect(units.map((u) => u.id).sort()).toEqual(["unit-cls", "unit-iface"]);
	});

	test("searchCodeUnits narrows to the requested types", async () => {
		await seedUnits([
			unit("fn", "src/a.ts", { unitType: "function" }),
			unit("cls", "src/b.ts", { unitType: "class" }),
		]);

		const results = await withFreshStore((store) =>
			store.searchCodeUnits("parseConfig", vec(2), {
				limit: 10,
				unitTypes: ["class"],
			}),
		);

		expect(results.length).toBeGreaterThan(0);
		expect(results.every((r) => r.unitType === "class")).toBe(true);
	});
});
