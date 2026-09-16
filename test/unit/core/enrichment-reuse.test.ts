/**
 * §4.6 — enrichment is REUSED across branches, not re-bought (decision I-15).
 *
 * Driven through the REAL `Enricher`, the REAL `FileTracker` and the REAL
 * LanceDB store, with `createStubLLMClient()` standing in for the provider.
 * That stub is the harness 3b-2's finding 2 asked for: before it,
 * `grep -rln "createEnricher" test/` found nothing and no test in this tree
 * could reach the enricher at all.
 *
 * WHAT IS ASSERTED, AND WHY IT IS ASSERTED THAT WAY. The count is
 * `stub.calls.length` — calls that really happened, never a report field. Every
 * row fact is read through an INDEPENDENT `lancedb.connect()` and every
 * membership fact through an INDEPENDENT `bun:sqlite` connection. The end-to-end
 * shape, through a real `mnemex index` child with a fake HTTP endpoint, is
 * `enrichment-reuse-e2e.test.ts`; this file is the mechanism.
 *
 * BOTH DIRECTIONS ARE REQUIRED. A reuse path that reuses everything is
 * indistinguishable from one broken in the expensive direction, so each test
 * that asserts a zero has a sibling asserting a NON-zero for content that
 * genuinely changed, for a different path holding identical text, and for a
 * record whose row the store no longer has.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import { drainWidenIntents } from "../../../src/core/branch-membership.js";
import {
	createEnricher,
	type Enricher,
	type FileToEnrich,
} from "../../../src/core/enrichment/index.js";
import {
	createVectorStore,
	type IVectorStore,
	type RowMembership,
} from "../../../src/core/store.js";
import {
	computeHash,
	createFileTracker,
	type IFileTracker,
	enrichmentContentKeyId as keyId,
} from "../../../src/core/tracker.js";
import type {
	ChunkType,
	CodeChunk,
	EmbeddingProvider,
	EmbedResult,
	IEmbeddingsClient,
} from "../../../src/types.js";
import {
	createStubLLMClient,
	type StubLLMClient,
} from "../../helpers/stub-llm.js";

const DIM = 8;
const TEST_TIMEOUT_MS = 120_000;

let dir: string;
let vectorsDir: string;
let indexDb: string;
let store: IVectorStore;
let tracker: IFileTracker;
let llm: StubLLMClient;
let enricher: Enricher;

/** Deterministic, non-zero, different for different text. */
function embeddingsStub(): IEmbeddingsClient {
	return {
		async embed(texts: string[]): Promise<EmbedResult> {
			return {
				embeddings: texts.map((text) => {
					let h = 2166136261;
					for (let i = 0; i < text.length; i++) {
						h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
					}
					return Array.from({ length: DIM }, (_, i) => {
						h = Math.imul(h ^ (i + 1), 16777619) >>> 0;
						return ((h % 1000) + 1) / 1000;
					});
				}),
			};
		},
		async embedOne(text: string): Promise<number[]> {
			return (await this.embed([text])).embeddings[0];
		},
		getModel: () => "stub-embed",
		getDimension: () => DIM,
		getProvider: () => "ollama" as EmbeddingProvider,
		isLocal: () => true,
	};
}

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "mnemex-enrich-reuse-"));
	vectorsDir = join(dir, "vectors");
	indexDb = join(dir, "index.db");
	store = createVectorStore({ vectorsDir, pathRoot: dir });
	await store.initialize();
	tracker = createFileTracker(indexDb, dir);
	llm = createStubLLMClient();
	enricher = createEnricher(llm, embeddingsStub(), store, tracker);
});

afterEach(async () => {
	await store.close();
	tracker.close();
	rmSync(dir, { recursive: true, force: true });
});

function repo(branchId: number): RowMembership {
	return { pathKind: "repo", branchId };
}

/** One file of `functions` exported functions, with `token` in every body. */
function source(path: string, token: string, functions = 2): FileToEnrich {
	const parts: string[] = [];
	const chunks: CodeChunk[] = [];
	const stem = path.replace(/[^A-Za-z0-9]/g, "_");
	for (let i = 0; i < functions; i++) {
		const body = `export function ${stem}_${i}(n: number): number {\n\treturn n + ${i} /* ${token} */;\n}`;
		parts.push(body);
		chunks.push({
			id: `${stem}-${i}-${token}`.padEnd(64, "0").slice(0, 64),
			contentHash: `hash-${stem}-${i}-${token}`,
			content: body,
			filePath: path,
			startLine: i * 4 + 1,
			endLine: i * 4 + 3,
			language: "typescript",
			chunkType: "function" as ChunkType,
			name: `${stem}_${i}`,
			fileHash: `file-${stem}-${token}`,
		});
	}
	return {
		filePath: path,
		fileContent: parts.join("\n\n"),
		codeChunks: chunks,
		language: "typescript",
	};
}

/**
 * A `files` row for the branch, so `setEnrichmentState`'s UPDATE has something
 * to hit. The indexer's chunk pass writes this before enrichment runs
 * (`commitAddBatch`'s `files` stamp), including for a WIDEN-ONLY file.
 */
function stampFile(branchId: number, file: FileToEnrich): void {
	tracker.markIndexed(
		branchId,
		file.filePath,
		`content-${file.filePath}`,
		file.codeChunks.map((c) => c.id),
	);
}

/** Rows through a LanceDB connection the store under test never touched. */
async function rows(): Promise<Array<Record<string, unknown>>> {
	const db = await lancedb.connect(vectorsDir);
	if (!(await db.tableNames()).includes("code_chunks")) return [];
	const table = await db.openTable("code_chunks");
	return (await table.query().toArray()) as Array<Record<string, unknown>>;
}

function summaryRows(
	all: Array<Record<string, unknown>>,
	path: string,
): Array<Record<string, unknown>> {
	return all.filter(
		(r) =>
			r.filePath === path &&
			(r.documentType === "file_summary" ||
				r.documentType === "symbol_summary"),
	);
}

/** One read through an independent SQLite connection. */
function withDb<T>(fn: (db: Database) => T): T {
	const db = new Database(indexDb, { readonly: true });
	try {
		return fn(db);
	} finally {
		db.close();
	}
}

function membership(chunkId: string): number[] {
	return withDb((db) =>
		(
			db
				.prepare(
					"SELECT branch_id FROM chunk_branches WHERE chunk_id = ? ORDER BY branch_id",
				)
				.all(chunkId) as Array<{ branch_id: number }>
		).map((r) => r.branch_id),
	);
}

function recordCount(): number {
	return withDb(
		(db) =>
			(
				db.prepare("SELECT COUNT(*) AS n FROM enrichment_by_content").get() as {
					n: number;
				}
			).n,
	);
}

function documentIdsFor(branchId: number, path: string): string[] {
	return withDb((db) =>
		(
			db
				.prepare(
					"SELECT id FROM documents WHERE branch_id = ? AND file_path = ? ORDER BY id",
				)
				.all(branchId, path) as Array<{ id: string }>
		).map((r) => r.id),
	);
}

function enrichmentState(branchId: number, path: string): string {
	return withDb(
		(db) =>
			(
				db
					.prepare(
						"SELECT enrichment_state FROM files WHERE branch_id = ? AND path = ?",
					)
					.get(branchId, path) as { enrichment_state: string }
			).enrichment_state,
	);
}

// ════════════════════════════════════════════════════════════════════════════
// The zero direction — and what makes it a saving rather than a silence
// ════════════════════════════════════════════════════════════════════════════

describe("§4.6 — a second branch adopts what the store already enriched", () => {
	test(
		"ZERO LLM calls, and the branch can SEE the summaries it did not pay for",
		async () => {
			const file = source("src/a.ts", "rev1");
			stampFile(1, file);
			const first = await enricher.enrichFiles([file], {
				membership: repo(1),
			});
			const calls1 = llm.calls.length;
			expect(calls1).toBeGreaterThan(0);
			expect(first.documentsCreated).toBeGreaterThan(0);
			expect(first.reuse).toEqual({
				filesReused: 0,
				documentsReused: 0,
				filesEnriched: 1,
				filesRefused: 0,
			});
			const afterFirst = summaryRows(await rows(), "src/a.ts");
			expect(afterFirst.length).toBeGreaterThan(0);
			expect(recordCount()).toBe(afterFirst.length);

			// ── The second branch: same content, same path, different branch ──
			llm.resetCalls();
			stampFile(2, file);
			const second = await enricher.enrichFiles([file], {
				membership: repo(2),
			});

			// V3.13's assertion, as a COUNT OF CALLS THAT HAPPENED.
			expect(llm.calls.length).toBe(0);
			expect(second.documentsCreated).toBe(0);
			expect(second.reuse).toEqual({
				filesReused: 1,
				documentsReused: afterFirst.length,
				filesEnriched: 0,
				filesRefused: 0,
			});

			// NOT A SILENCE. Branch 2 holds every summary id, the rows were
			// WIDENED rather than copied, and the `documents` rows a search reads
			// exist for branch 2 as well.
			const afterSecond = summaryRows(await rows(), "src/a.ts");
			expect(afterSecond.length).toBe(afterFirst.length);
			const ids = afterFirst.map((r) => String(r.id)).sort();
			expect(afterSecond.map((r) => String(r.id)).sort()).toEqual(ids);
			for (const id of ids) expect(membership(id)).toEqual([1, 2]);
			expect(documentIdsFor(2, "src/a.ts")).toEqual(ids);
			expect(JSON.parse(enrichmentState(2, "src/a.ts"))).toEqual(
				JSON.parse(enrichmentState(1, "src/a.ts")),
			);

			// The mirror the drain writes agrees with the membership table.
			await drainWidenIntents(tracker, store);
			for (const row of summaryRows(await rows(), "src/a.ts")) {
				expect(row.branchIds).toBe(",1,2,");
			}
		},
		TEST_TIMEOUT_MS,
	);
});

// ════════════════════════════════════════════════════════════════════════════
// The expensive direction — three ways reuse must NOT happen
// ════════════════════════════════════════════════════════════════════════════

describe("§4.6 — what must still be bought", () => {
	test(
		"content that genuinely changed is enriched again, on the SAME branch",
		async () => {
			const rev1 = source("src/a.ts", "rev1");
			stampFile(1, rev1);
			await enricher.enrichFiles([rev1], { membership: repo(1) });
			const idsRev1 = summaryRows(await rows(), "src/a.ts")
				.map((r) => String(r.id))
				.sort();

			llm.resetCalls();
			const rev2 = source("src/a.ts", "rev2");
			const result = await enricher.enrichFiles([rev2], {
				membership: repo(1),
			});

			expect(llm.calls.length).toBeGreaterThan(0);
			expect(result.reuse?.filesReused).toBe(0);
			expect(result.reuse?.filesEnriched).toBe(1);

			// The new revision's summaries replaced the old ones for this branch:
			// NARROW_SUMMARIES collected the previous ids, which nothing else
			// would ever have collected (they are not derived from the file's
			// current content).
			const idsRev2 = summaryRows(await rows(), "src/a.ts")
				.map((r) => String(r.id))
				.sort();
			expect(idsRev2).not.toEqual(idsRev1);
			expect(idsRev2.some((id) => idsRev1.includes(id))).toBe(false);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"identical content at a DIFFERENT path is NOT reused — the path is in the key",
		async () => {
			// The same bytes at two paths. A content-only key (§4.6 as literally
			// written) would hand `src/b.ts` the summary of `src/a.ts` — a summary
			// whose TEXT names a.ts, whose id hashes a.ts, and whose `chunk_index`
			// row says a.ts, so NARROW_SUMMARIES for b.ts could never collect it.
			const a = source("src/a.ts", "same");
			const b: FileToEnrich = { ...a, filePath: "src/b.ts" };
			expect(b.fileContent).toBe(a.fileContent);

			stampFile(1, a);
			await enricher.enrichFiles([a], { membership: repo(1) });
			llm.resetCalls();
			stampFile(1, b);
			const result = await enricher.enrichFiles([b], { membership: repo(1) });

			expect(llm.calls.length).toBeGreaterThan(0);
			expect(result.reuse?.filesReused).toBe(0);
			const all = await rows();
			expect(summaryRows(all, "src/a.ts").length).toBeGreaterThan(0);
			expect(summaryRows(all, "src/b.ts").length).toBeGreaterThan(0);
			// Every summary row names the file it summarises, on both sides.
			for (const path of ["src/a.ts", "src/b.ts"]) {
				for (const row of summaryRows(all, path)) {
					expect(String(row.id)).not.toBe("");
					expect(row.filePath).toBe(path);
				}
			}
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"a record whose LanceDB row is GONE is refused, in data, and the file is bought again",
		async () => {
			const file = source("src/a.ts", "rev1");
			stampFile(1, file);
			await enricher.enrichFiles([file], { membership: repo(1) });
			const before = summaryRows(await rows(), "src/a.ts");
			expect(before.length).toBeGreaterThan(0);
			expect(recordCount()).toBe(before.length);

			// Delete ONE summary row, leaving its `chunk_index` registration and
			// its §4.6 record behind — the P1 break the belt exists for. Through
			// the store's OWN handle, not a second `lancedb.connect()`: a handle
			// holds a dataset VERSION, so a delete through another connection is
			// invisible to this process until it reopens the table, and the test
			// would then be measuring the snapshot rather than the belt.
			const victim = String(before[0].id);
			expect(await store.deleteByIds([victim])).toBe(1);

			llm.resetCalls();
			stampFile(2, file);
			const result = await enricher.enrichFiles([file], {
				membership: repo(2),
			});

			// It did NOT reuse, it SAYS it did not reuse, and it paid.
			expect(result.reuse).toEqual({
				filesReused: 0,
				documentsReused: 0,
				filesEnriched: 1,
				filesRefused: 1,
			});
			expect(llm.calls.length).toBeGreaterThan(0);
			expect(summaryRows(await rows(), "src/a.ts").length).toBeGreaterThan(0);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"a file the store has never enriched reports no-record, not a refusal",
		async () => {
			const file = source("src/fresh.ts", "rev1");
			stampFile(1, file);
			const result = await enricher.enrichFiles([file], {
				membership: repo(1),
			});
			expect(result.reuse).toEqual({
				filesReused: 0,
				documentsReused: 0,
				filesEnriched: 1,
				filesRefused: 0,
			});
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"a record that is NOT complete is never adopted",
		async () => {
			// Nothing writes a non-`complete` record today — the enricher records
			// only what finished — so this guard would otherwise be an unreachable
			// branch nobody had run. Written straight through the tracker, which
			// is where a future producer would write one.
			const file = source("src/pending.ts", "rev1");
			stampFile(1, file);
			tracker.recordEnrichmentByContent(
				{
					pathKind: "repo",
					path: "src/pending.ts",
					contentHash: computeHash(file.fileContent),
				},
				[
					{
						documentType: "file_summary",
						summaryId: "deadbeefdeadbeef",
						state: "in_progress",
						sourceIds: [],
						createdAt: null,
						enrichedAt: new Date().toISOString(),
						producer: "local/stub-model",
					},
				],
			);

			const result = await enricher.enrichFiles([file], {
				membership: repo(1),
			});
			expect(result.reuse?.filesReused).toBe(0);
			expect(result.reuse?.filesEnriched).toBe(1);
			// `incomplete`, NOT `row-missing`: the record never reached the
			// liveness check, and the two reasons must not be confused — one says
			// the store lost a row, the other says nothing ever finished.
			expect(result.reuse?.filesRefused).toBe(0);
			expect(llm.calls.length).toBeGreaterThan(0);
		},
		TEST_TIMEOUT_MS,
	);
});

// ════════════════════════════════════════════════════════════════════════════
// The tracker seam on its own
// ════════════════════════════════════════════════════════════════════════════

describe("enrichment_by_content — the key is the whole key", () => {
	test("a record is found by (path_kind, path, content_hash) and by nothing else", () => {
		const key = {
			pathKind: "repo" as const,
			path: "src/a.ts",
			contentHash: "c0ffee",
		};
		tracker.recordEnrichmentByContent(key, [
			{
				documentType: "file_summary",
				summaryId: "aaaa1111",
				state: "complete",
				sourceIds: ["chunk-1"],
				createdAt: "t0",
				enrichedAt: "t1",
				producer: "local/stub-model",
			},
		]);

		expect(tracker.enrichmentByContent([key]).get(keyId(key))).toEqual([
			{
				documentType: "file_summary",
				summaryId: "aaaa1111",
				state: "complete",
				sourceIds: ["chunk-1"],
				createdAt: "t0",
				enrichedAt: "t1",
				producer: "local/stub-model",
			},
		]);
		// A different content hash at the same path: a MISS, which is what makes
		// an edited file get a new summary.
		expect(
			tracker.enrichmentByContent([{ ...key, contentHash: "beef" }]).size,
		).toBe(0);
		// The same content at a different path: also a miss. This is the half
		// §4.6's literal `content_hash PRIMARY KEY` does not have, and the
		// measurement behind it is in the implementation log.
		expect(
			tracker.enrichmentByContent([{ ...key, path: "src/b.ts" }]).size,
		).toBe(0);
	});

	test("one pass's records for one key come back together, in one lookup", () => {
		const key = {
			pathKind: "repo" as const,
			path: "src/multi.ts",
			contentHash: "hash-multi",
		};
		tracker.recordEnrichmentByContent(
			key,
			["file_summary", "symbol_summary", "symbol_summary"].map(
				(documentType, index) => ({
					documentType: documentType as "file_summary" | "symbol_summary",
					summaryId: `id-${index}`,
					state: "complete" as const,
					sourceIds: [],
					createdAt: null,
					enrichedAt: "t",
					producer: null,
				}),
			),
		);
		// Three summaries for one file — the shape §4.6's single `summary_id`
		// column cannot hold, which is why the id is part of the key.
		expect(tracker.enrichmentByContent([key]).get(keyId(key))?.length).toBe(3);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// The record table's own lifecycle
// ════════════════════════════════════════════════════════════════════════════

describe("§4.6 — the record table does not outlive the rows it names", () => {
	test(
		"a narrow that deletes the last holder of a summary forgets its record",
		async () => {
			const rev1 = source("src/a.ts", "rev1");
			stampFile(1, rev1);
			await enricher.enrichFiles([rev1], { membership: repo(1) });
			const recordsAfterFirst = recordCount();
			expect(recordsAfterFirst).toBeGreaterThan(0);

			// Re-enrich the SAME path with new content on the SAME branch: the old
			// revision's summaries lose their only holder, so `narrowIds` deletes
			// the rows and `finishNarrowBatch` forgets the records.
			await enricher.enrichFiles([source("src/a.ts", "rev2")], {
				membership: repo(1),
			});
			const live = summaryRows(await rows(), "src/a.ts").length;
			expect(recordCount()).toBe(live);
		},
		TEST_TIMEOUT_MS,
	);
});
