/**
 * R2 (D-TWIN) — one span, one result slot, on every local ranked path.
 *
 * Measured on the repository's own store before this change: 49 of 400 top-20
 * slots (12.3 %) were a `(filePath, startLine, endLine)` the list had already
 * shown, because one span is indexed as a `code_chunk` row AND a `code_unit`
 * row. Only 528 of 2 788 twins are byte-identical (the chunk usually carries a
 * leading `export\n`), so the fixture below gives the twins DIFFERENT text on
 * purpose: a content-keyed dedup would pass a byte-identical fixture and miss
 * the real case.
 *
 *   T-1   `VectorStore.search`: 0 duplicate-span slots, `length === limit`,
 *         back-filled from the fused list, and the kept rows are the higher-
 *         ranked twins (A)
 *   T-2   `VectorStore.searchDocuments`: the same, code rows only (A)
 *   T-2b  `VectorStore.searchCodeUnits` in SCOPE_ALL with two revisions of one
 *         span: one slot; and `search` never shows another revision's summary
 *         on the kept row (A)
 *   T-4   summary carry-over from a dropped twin, both through the twin's own
 *         `summary` column and through a `symbol_summary` keyed to its id (A)
 *   T-6   both writers' rows for one span produce ONE key through the read
 *         seam, so they collapse (A)
 *
 * Every assertion is ABSOLUTE (NFR-4): it names the rows that must be there,
 * not merely that a list did not change.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { branchScope, SCOPE_ALL } from "../../../src/core/branch-scope.js";
import {
	createVectorStore,
	type IVectorStore,
} from "../../../src/core/store.js";
import type {
	ChunkWithEmbedding,
	CodeUnitWithEmbedding,
	DocumentWithEmbedding,
} from "../../../src/types.js";

const DIM = 8;
const BRANCH = 1;

let dir: string;
let vectorsDir: string;

beforeEach(() => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "mnemex-span-twin-")));
	vectorsDir = join(dir, "vectors");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** 16 lowercase hex characters, deterministic per label. */
function hexId(label: string): string {
	return createHash("sha256").update(label).digest("hex").slice(0, 16);
}

/** First component carries the similarity: `near` 1 is the query itself. */
function vec(near: number): number[] {
	const v = new Array(DIM).fill(0.01);
	v[0] = 1 / near;
	return v;
}

const QUERY_VECTOR = vec(1);

interface SpanSpec {
	/** Repo-relative path (the stored spelling). */
	path: string;
	near: number;
	startLine?: number;
	endLine?: number;
	/** Text the BM25 channel can match; omitted -> no keyword hit. */
	keyword?: string;
	tag?: string;
}

function chunkFor(spec: SpanSpec): ChunkWithEmbedding {
	const start = spec.startLine ?? 1;
	const end = spec.endLine ?? 10;
	const body = `function ${spec.tag ?? "fn"}() { ${spec.keyword ?? "plain"} }`;
	return {
		id: hexId(`chunk:${spec.path}:${start}:${end}:${spec.tag ?? ""}`),
		contentHash: hexId(`chash:${spec.path}:${spec.tag ?? ""}`),
		// The real shape: the chunk carries a leading `export\n` the unit lacks.
		content: `export\n${body}`,
		filePath: spec.path,
		startLine: start,
		endLine: end,
		language: "typescript",
		chunkType: "function",
		name: spec.tag ?? "fn",
		fileHash: hexId(`file:${spec.path}`),
		vector: vec(spec.near),
	};
}

function unitFor(spec: SpanSpec, revision = ""): CodeUnitWithEmbedding {
	const start = spec.startLine ?? 1;
	const end = spec.endLine ?? 10;
	return {
		id: hexId(
			`unit:${spec.path}:${start}:${end}:${spec.tag ?? ""}:${revision}`,
		),
		parentId: null,
		unitType: "function",
		filePath: spec.path,
		startLine: start,
		endLine: end,
		language: "typescript",
		content: `function ${spec.tag ?? "fn"}() { ${spec.keyword ?? "plain"} ${revision} }`,
		name: spec.tag ?? "fn",
		fileHash: hexId(`file:${spec.path}:${revision}`),
		depth: 1,
		vector: vec(spec.near),
	};
}

async function withStore<T>(
	fn: (store: IVectorStore) => Promise<T>,
): Promise<T> {
	const store = createVectorStore({ vectorsDir, pathRoot: dir });
	await store.initialize();
	try {
		return await fn(store);
	} finally {
		await store.close();
	}
}

/** Output-path span key as a USER sees it: absolute path + lines. */
function spanOf(r: { filePath?: string; startLine: number; endLine: number }) {
	return `${r.filePath}:${r.startLine}-${r.endLine}`;
}

function duplicates(keys: readonly string[]): string[] {
	const seen = new Set<string>();
	const dups: string[] = [];
	for (const key of keys) {
		if (seen.has(key)) dups.push(key);
		seen.add(key);
	}
	return dups;
}

/**
 * Twelve spans, each written as a `code_chunk` AND a `code_unit` with the same
 * vector. Spans 0-4 also match the keyword, so both twins of each rank high in
 * BOTH channels and sit next to each other after fusion; spans 5-11 are
 * vector-only and can only enter the list as back-fill.
 */
const SPANS: SpanSpec[] = Array.from({ length: 12 }, (_, i) => ({
	path: `src/f${String(i).padStart(2, "0")}.ts`,
	near: i + 1,
	keyword: i < 5 ? "deluxe" : undefined,
	tag: `parseConfig${i}`,
}));

async function seedTwins(branchId = BRANCH): Promise<void> {
	await withStore(async (store) => {
		await store.addChunks(SPANS.map(chunkFor), { pathKind: "repo", branchId });
		await store.addCodeUnits(
			SPANS.map((s) => unitFor(s)),
			{ pathKind: "repo", branchId },
		);
	});
}

const abs = (spec: SpanSpec) =>
	`${join(dir, spec.path)}:${spec.startLine ?? 1}-${spec.endLine ?? 10}`;

// ════════════════════════════════════════════════════════════════════════════
// T-1 — VectorStore.search
// ════════════════════════════════════════════════════════════════════════════

describe("T-1 — VectorStore.search: one slot per span", () => {
	test("0 duplicate-span slots, length === limit, back-filled, higher-ranked twin kept (A)", async () => {
		await seedTwins();
		const results = await withStore((store) =>
			store.search("deluxe", QUERY_VECTOR, branchScope(BRANCH), { limit: 6 }),
		);
		const keys = results.map((r) => spanOf(r.chunk));

		expect(duplicates(keys)).toEqual([]);
		expect(results).toHaveLength(6);
		// The six nearest spans, in order: 0-4 from both channels, and span 5,
		// vector-only, as BACK-FILL into a slot a twin would otherwise take.
		expect(keys).toEqual(SPANS.slice(0, 6).map(abs));
		// Under the `search` weights (`code_chunk` 0.15 > `code_unit` 0.1) the
		// chunk is the higher-ranked twin after fusion, so it is the one kept.
		expect(results.map((r) => r.chunk.id)).toEqual(
			SPANS.slice(0, 6).map((s) => chunkFor(s).id),
		);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// T-2 — VectorStore.searchDocuments
// ════════════════════════════════════════════════════════════════════════════

describe("T-2 — VectorStore.searchDocuments: one slot per code span", () => {
	test("equal type weights: 0 duplicate spans, length === limit (A)", async () => {
		await seedTwins();
		// Equal weights are a real caller option (`RetrieverOptions.typeWeights`)
		// and the shape the queued eval would ship: with no weight gap between
		// the twins, both sit at the top and the list WOULD hold each span twice.
		const results = await withStore((store) =>
			store.searchDocuments("deluxe", QUERY_VECTOR, branchScope(BRANCH), {
				limit: 6,
				typeWeights: { code_chunk: 0.1, code_unit: 0.1 },
			}),
		);
		const keys = results.map((r) =>
			spanOf({
				filePath: r.document.filePath,
				// `BaseDocument` carries no lines; the span lives on the id.
				startLine: 1,
				endLine: 10,
			}),
		);
		expect(duplicates(keys)).toEqual([]);
		expect(results).toHaveLength(6);
		// The exact SET: spans 0-4 (both channels) plus span 5 as back-fill.
		// Order is not asserted: with equal weights the BM25 channel ties
		// across spans (same keyword, same length) and breaks ties by id.
		expect([...keys].sort()).toEqual(SPANS.slice(0, 6).map(abs).sort());
	});

	test("non-code documents at one path are never collapsed", async () => {
		await withStore(async (store) => {
			const docs: DocumentWithEmbedding[] = ["a", "b"].map((tag) => ({
				id: hexId(`obs:${tag}`),
				content: `observation ${tag} deluxe`,
				documentType: "session_observation",
				filePath: "src/f00.ts",
				createdAt: new Date().toISOString(),
				vector: vec(1),
			}));
			await store.addDocuments(docs, { pathKind: "repo", branchId: BRANCH });
		});
		const results = await withStore((store) =>
			store.searchDocuments("deluxe", QUERY_VECTOR, branchScope(BRANCH), {
				limit: 5,
			}),
		);
		expect(
			results.filter((r) => r.documentType === "session_observation"),
		).toHaveLength(2);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// T-2b — SCOPE_ALL, two revisions of one span
// ════════════════════════════════════════════════════════════════════════════

describe("T-2b — two revisions of one span in SCOPE_ALL", () => {
	const span: SpanSpec = { path: "src/rev.ts", near: 1, tag: "revised" };
	const rest: SpanSpec[] = [2, 3, 4, 5].map((near) => ({
		path: `src/other${near}.ts`,
		near: near + 1,
		tag: `other${near}`,
	}));

	async function seedRevisions(): Promise<{ rev1: string; rev2: string }> {
		// Same path and lines, different content -> different unit ids (the id
		// carries content, D-7). Revision 2 is nearer, so it is the kept one.
		const rev1 = unitFor({ ...span, near: 1.5 }, "rev1");
		const rev2 = unitFor(span, "rev2");
		await withStore(async (store) => {
			await store.addCodeUnits([rev1], { pathKind: "repo", branchId: 1 });
			await store.addCodeUnits([rev2], { pathKind: "repo", branchId: 2 });
			await store.addCodeUnits(
				rest.map((s) => unitFor(s)),
				{ pathKind: "repo", branchId: 1 },
			);
		});
		return { rev1: rev1.id, rev2: rev2.id };
	}

	test("searchCodeUnits: one slot for the span, back-filled to limit (A)", async () => {
		const { rev2 } = await seedRevisions();
		const results = await withStore((store) =>
			store.searchCodeUnits("zzqqxx", QUERY_VECTOR, SCOPE_ALL, { limit: 3 }),
		);
		const keys = results.map(spanOf);
		expect(duplicates(keys)).toEqual([]);
		expect(results).toHaveLength(3);
		expect(results[0].id).toBe(rev2);
		expect(keys).toEqual([span, rest[0], rest[1]].map(abs));
	});

	test("search: the kept revision never shows the OTHER revision's summary (A)", async () => {
		const { rev1, rev2 } = await seedRevisions();
		await withStore((store) =>
			store.updateUnitSummary(rev1, "REVISION ONE SUMMARY"),
		);
		const results = await withStore((store) =>
			store.search("zzqqxx", QUERY_VECTOR, SCOPE_ALL, { limit: 3 }),
		);
		const kept = results.find((r) => r.chunk.id === rev2);
		expect(kept).toBeDefined();
		expect(results.some((r) => r.chunk.id === rev1)).toBe(false);
		// rev1 is on branch 1 only, rev2 on branch 2 only: no shared membership,
		// so rev1's summary describes code the kept row does not contain.
		expect(kept?.summary).toBeUndefined();
	});
});

// ════════════════════════════════════════════════════════════════════════════
// T-4 — summary carry-over from a dropped twin
// ════════════════════════════════════════════════════════════════════════════

describe("T-4 — summary carry-over", () => {
	const span: SpanSpec = { path: "src/sum.ts", near: 1, tag: "summed" };
	const filler: SpanSpec = { path: "src/filler.ts", near: 2, tag: "filler" };

	async function seedPair(): Promise<{ chunkId: string; unitId: string }> {
		const chunk = chunkFor(span);
		const unit = unitFor(span);
		await withStore(async (store) => {
			await store.addChunks([chunk, chunkFor(filler)], {
				pathKind: "repo",
				branchId: BRANCH,
			});
			await store.addCodeUnits([unit], { pathKind: "repo", branchId: BRANCH });
		});
		return { chunkId: chunk.id, unitId: unit.id };
	}

	test("the dropped code_unit's own summary is shown on the kept code_chunk (A)", async () => {
		const { chunkId, unitId } = await seedPair();
		await withStore((store) =>
			store.updateUnitSummary(unitId, "UNIT-LEVEL SUMMARY"),
		);
		const results = await withStore((store) =>
			store.search("zzqqxx", QUERY_VECTOR, branchScope(BRANCH), { limit: 5 }),
		);
		expect(results.map((r) => r.chunk.id)).not.toContain(unitId);
		const kept = results.find((r) => r.chunk.id === chunkId);
		expect(kept?.summary).toBe("UNIT-LEVEL SUMMARY");
	});

	test("a symbol_summary keyed to the DROPPED twin's id reaches the kept row (A)", async () => {
		const { chunkId, unitId } = await seedPair();
		await withStore((store) =>
			store.addDocuments(
				[
					{
						id: hexId("symsum"),
						content: "summary of summed",
						documentType: "symbol_summary",
						filePath: span.path,
						createdAt: new Date().toISOString(),
						sourceIds: [unitId],
						vector: vec(1.2),
					},
				],
				{ pathKind: "repo", branchId: BRANCH },
			),
		);
		const results = await withStore((store) =>
			store.search("zzqqxx", QUERY_VECTOR, branchScope(BRANCH), { limit: 5 }),
		);
		const kept = results.find((r) => r.chunk.id === chunkId);
		expect(kept?.summary).toBe("summary of summed");
	});

	test("the kept row's OWN summary still wins over a twin's", async () => {
		const { chunkId, unitId } = await seedPair();
		await withStore(async (store) => {
			await store.updateUnitSummary(unitId, "TWIN SUMMARY");
			await store.addDocuments(
				[
					{
						id: hexId("own-symsum"),
						content: "OWN SYMBOL SUMMARY",
						documentType: "symbol_summary",
						filePath: span.path,
						createdAt: new Date().toISOString(),
						sourceIds: [chunkId],
						vector: vec(1.2),
					},
				],
				{ pathKind: "repo", branchId: BRANCH },
			);
		});
		const results = await withStore((store) =>
			store.search("zzqqxx", QUERY_VECTOR, branchScope(BRANCH), { limit: 5 }),
		);
		const kept = results.find((r) => r.chunk.id === chunkId);
		// A twin only FILLS a gap. The kept row's own symbol-level summary
		// (its column, then a symbol_summary naming its id) comes before any
		// twin's; file-level summaries come after every symbol-level one.
		expect(kept?.summary).toBe("OWN SYMBOL SUMMARY");
	});
});

// ════════════════════════════════════════════════════════════════════════════
// T-6 — one span, one key, across the two writers
// ════════════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════════════
// T-4c — identity carry-over (orchestrator ruling R2-A)
// ════════════════════════════════════════════════════════════════════════════

describe("T-4c — a nameless kept twin carries its named twin's identity", () => {
	/**
	 * The chunker writes a function under `MIN_CHUNK_TOKENS` as a GAP chunk —
	 * `chunkType: "module"`, no name — while the unit extractor names the same
	 * span. 683 of 1 895 twin spans in this repository's `src/` have that
	 * shape. The chunk outranks the unit (0.15 vs 0.1), so without carry-over
	 * the kept row has no name: `--agent` prints `type=module name=` and the
	 * dead-code penalty, which looks symbols up BY NAME, never sees the span.
	 */
	const span: SpanSpec = { path: "src/small.ts", near: 1, tag: "get" };
	const filler: SpanSpec = { path: "src/filler.ts", near: 2, tag: "filler" };

	function gapChunk(spec: SpanSpec): ChunkWithEmbedding {
		return { ...chunkFor(spec), name: undefined, chunkType: "module" };
	}

	function namedUnit(spec: SpanSpec, revision = ""): CodeUnitWithEmbedding {
		return {
			...unitFor(spec, revision),
			signature: "get(key: string): string",
		};
	}

	test("search: the kept chunk keeps its id, content and lines, and takes the unit's name, type and signature (A)", async () => {
		const chunk = gapChunk(span);
		const unit = namedUnit(span);
		await withStore(async (store) => {
			await store.addChunks([chunk, chunkFor(filler)], {
				pathKind: "repo",
				branchId: BRANCH,
			});
			await store.addCodeUnits([unit], { pathKind: "repo", branchId: BRANCH });
		});
		const results = await withStore((store) =>
			store.search("zzqqxx", QUERY_VECTOR, branchScope(BRANCH), { limit: 5 }),
		);
		expect(results.map((r) => r.chunk.id)).not.toContain(unit.id);
		const kept = results.find((r) => r.chunk.id === chunk.id);
		expect(kept).toBeDefined();
		// Identity from the twin...
		expect(kept?.chunk.name).toBe("get");
		expect(kept?.chunk.chunkType).toBe("function");
		expect(kept?.chunk.signature).toBe("get(key: string): string");
		// ...everything else still the kept row's own (R2.2 unchanged).
		expect(kept?.chunk.content).toBe(chunk.content);
		expect(kept?.chunk.startLine).toBe(chunk.startLine);
		expect(kept?.chunk.endLine).toBe(chunk.endLine);
		expect(kept?.score).toBe(1);
	});

	test("search: a named kept row is never renamed by its twin", async () => {
		const chunk = { ...chunkFor(span), name: "ownName" };
		await withStore(async (store) => {
			await store.addChunks([chunk], { pathKind: "repo", branchId: BRANCH });
			await store.addCodeUnits([namedUnit(span)], {
				pathKind: "repo",
				branchId: BRANCH,
			});
		});
		const results = await withStore((store) =>
			store.search("zzqqxx", QUERY_VECTOR, branchScope(BRANCH), { limit: 5 }),
		);
		expect(results).toHaveLength(1);
		expect(results[0].chunk.name).toBe("ownName");
		expect(results[0].chunk.chunkType).toBe("function");
	});

	test("search, SCOPE_ALL: no identity from a twin on a branch the kept row is not on (A)", async () => {
		const chunk = gapChunk(span);
		await withStore(async (store) => {
			await store.addChunks([chunk], { pathKind: "repo", branchId: 1 });
			await store.addCodeUnits([namedUnit(span)], {
				pathKind: "repo",
				branchId: 2,
			});
		});
		const results = await withStore((store) =>
			store.search("zzqqxx", QUERY_VECTOR, SCOPE_ALL, { limit: 5 }),
		);
		expect(results).toHaveLength(1);
		expect(results[0].chunk.id).toBe(chunk.id);
		expect(results[0].chunk.name).toBeUndefined();
	});

	test("searchCodeUnits: a nameless kept unit takes a same-branch named revision's name (A)", async () => {
		// Two revisions of one span held by one branch (a widened row next to
		// its successor): the nearer revision is nameless.
		const nameless = { ...unitFor(span, "rev-a"), name: undefined };
		const named = namedUnit({ ...span, near: 1.5 }, "rev-b");
		await withStore((store) =>
			store.addCodeUnits([nameless, named], {
				pathKind: "repo",
				branchId: BRANCH,
			}),
		);
		const results = await withStore((store) =>
			store.searchCodeUnits("zzqqxx", QUERY_VECTOR, branchScope(BRANCH), {
				limit: 5,
			}),
		);
		expect(results).toHaveLength(1);
		expect(results[0].id).toBe(nameless.id);
		expect(results[0].content).toBe(nameless.content);
		expect(results[0].name).toBe("get");
		expect(results[0].signature).toBe("get(key: string): string");
	});
});

describe("T-6 — the chunk writer and the unit writer spell one span alike", () => {
	test("a same-span code_chunk/code_unit pair, written by the real writers, collapses (A)", async () => {
		// A non-ASCII name: a writer that changed its spelling (NFC vs NFD, or
		// an absolute path) would split the key and the twin would survive.
		const span: SpanSpec = { path: "src/café.ts", near: 1, tag: "accented" };
		await withStore(async (store) => {
			await store.addChunks([chunkFor(span)], {
				pathKind: "repo",
				branchId: BRANCH,
			});
			await store.addCodeUnits([unitFor(span)], {
				pathKind: "repo",
				branchId: BRANCH,
			});
		});
		const results = await withStore((store) =>
			store.search("zzqqxx", QUERY_VECTOR, branchScope(BRANCH), { limit: 5 }),
		);
		expect(results).toHaveLength(1);
		expect(results[0].chunk.filePath).toBe(join(dir, "src/café.ts"));
	});
});
