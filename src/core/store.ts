/**
 * LanceDB Vector Store
 *
 * Handles vector storage and hybrid search (BM25 + vector similarity)
 * using LanceDB's embedded database.
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import {
	Field,
	FixedSizeList,
	Float32,
	Float64,
	Schema,
	Utf8,
} from "apache-arrow";
import { getTestFileMode, type TestFileMode } from "../config.js";
import type {
	BaseDocument,
	ChunkWithEmbedding,
	CodeUnit,
	CodeUnitWithEmbedding,
	DocumentType,
	DocumentWithEmbedding,
	EnrichedSearchOptions,
	EnrichedSearchResult,
	SearchResult,
	SearchUseCase,
	UnitType,
} from "../types.js";
import {
	createTestFileDetector,
	type TestFileDetector,
} from "./analysis/test-detector.js";
import {
	type BranchScope,
	branchMembershipFilter,
	decodeBranchIds,
} from "./branch-scope.js";
import {
	fromStoredPath,
	isStoredRepoPath,
	type PathKind,
	toRepoRelative,
} from "./repo-path.js";

// ============================================================================
// Constants
// ============================================================================

/** Table name for code chunks */
const CHUNKS_TABLE = "code_chunks";

/** Column carrying the BM25 full-text index. */
const FTS_COLUMN = "content";

/**
 * Column carrying the embedding-cache key — added by index version 3.
 * Its presence in the Arrow schema is what distinguishes a v3 table from a v2
 * one; see `VectorStore.hasEmbedKeyColumn`.
 */
export const EMBED_KEY_COLUMN = "embedKey";

/**
 * Index version 4's two columns (architecture §3.2). `branchIds` is `Utf8`
 * with a comma on BOTH ends (`,1,4,7,`), so `LIKE '%,4,%'` cannot match 14 or
 * 41 (decision I-6: no mask column, no list type). `pathKind` is the closed
 * union `"repo" | "synthetic"` (§3.1). Their presence is what distinguishes a
 * v4 table from a v3 one; see `VectorStore.hasBranchIdsColumn`.
 */
export const BRANCH_IDS_COLUMN = "branchIds";
export const PATH_KIND_COLUMN = "pathKind";

/** `IndexConfig.indexType` for a full-text index, upper-cased for comparison. */
const FTS_INDEX_TYPE = "FTS";

/** Default search limit */
const DEFAULT_LIMIT = 10;

/** BM25 weight in hybrid search */
const BM25_WEIGHT = 0.4;

/** Vector weight in hybrid search */
const VECTOR_WEIGHT = 0.6;

/**
 * Watchdog timeout (ms) for LanceDB write operations (table.add / createTable).
 *
 * Generous on purpose: a legitimate write of a large batch can take a while, so
 * this is an upper bound on "one write should never exceed this" — it exists to
 * catch the LanceDB 0.13.0 deadlock (all tokio threads park in Condvar::wait,
 * 0% CPU, 0 bytes written, forever), NOT to bound normal latency.
 */
export const LANCEDB_WRITE_TIMEOUT_MS = 60000;

/**
 * Thrown when a write batch carries zero-dimension vectors.
 *
 * LanceDB infers the table schema from the first batch, so a batch whose
 * vectors are empty arrays creates a `vector` column typed
 * `FixedSizeList[0]<Float32>`. That column is permanently unusable: the table
 * opens and `countRows()` succeeds, but every read that touches `vector`
 * fails — LanceDB >= 0.20 raises `LanceError(Schema): dimension must be a
 * positive integer`, and 0.13 panics in Rust with "attempt to divide by zero".
 *
 * The schema is fixed at creation, so there is no repair short of a full
 * reindex. Failing the write is strictly better than silently producing an
 * index that can never answer a query.
 *
 * Empty vectors in practice mean the embedding provider returned nothing —
 * e.g. the configured Ollama endpoint is not running.
 */
export class ZeroDimensionVectorError extends Error {
	constructor(readonly label: string) {
		super(
			`Refusing to write '${label}': embedding vectors are empty (0 dimensions). ` +
				"This would create an unqueryable index. Check that the configured " +
				"embedding provider is reachable, then reindex.",
		);
		this.name = "ZeroDimensionVectorError";
	}
}

/**
 * Thrown when an EXISTING table is opened and its `vector` column is typed
 * `FixedSizeList[0]<Float32>`.
 *
 * Read-side counterpart of ZeroDimensionVectorError, which guards writes. A
 * table that slipped past those guards — written by an older build, or by a run
 * whose embedding provider returned nothing — is corrupt in a way the schema
 * makes permanent. Detecting it at open time converts an uncatchable Rust panic
 * into a normal exception carrying one actionable sentence.
 */
export class UnqueryableVectorIndexError extends Error {
	constructor() {
		super(
			"The vector index is corrupt: its vector column has 0 dimensions, so no " +
				"query can read it. A previous index run stored empty vectors, which " +
				"happens when the embedding provider returns nothing. " +
				"Rebuild it with: mnemex index --force",
		);
		this.name = "UnqueryableVectorIndexError";
	}
}

/**
 * Guard the dimension of an EXISTING table's `vector` column, read from its
 * Arrow schema when the table is opened.
 *
 * Deliberately compares against 0 rather than testing truthiness. The three
 * write-path guards in this file spell the same idea as `this.tableDimension &&
 * ...`, which is false for 0 and therefore skips the one case worth catching.
 * Exported for tests.
 *
 * @param listSize the column's FixedSizeList width, or null when unknown
 *                 (a schema read failed) — unknown is not an error.
 */
export function assertQueryableTableDimension(listSize: number | null): void {
	if (listSize === 0) {
		throw new UnqueryableVectorIndexError();
	}
}

/**
 * Guard a batch's inferred vector dimension before it reaches LanceDB.
 * Exported for tests.
 * @returns the validated, non-zero dimension
 */
export function assertVectorDimension(
	dimension: number,
	label: string,
): number {
	if (!Number.isFinite(dimension) || dimension <= 0) {
		throw new ZeroDimensionVectorError(label);
	}
	return dimension;
}

/**
 * Thrown by `withTimeout` when a wrapped LanceDB write does not settle in time.
 * Carries the operation label and the timeout so the indexer can fail loudly and
 * its lock's finally/release can run (instead of the process parking forever).
 */
export class LanceWriteTimeoutError extends Error {
	constructor(
		readonly label: string,
		readonly timeoutMs: number,
	) {
		super(
			`LanceDB write '${label}' did not complete within ${timeoutMs}ms — ` +
				"the native write appears hung (LanceDB 0.13.0 Condvar deadlock).",
		);
		this.name = "LanceWriteTimeoutError";
	}
}

/**
 * Thrown when an update (delete + add) failed AFTER its delete had committed.
 *
 * LanceDB has no upsert, so `updateUnitSummary` / `updateDocumentContent`
 * express an update as a delete followed by an add, and the two are not atomic.
 * Both methods used to swallow a failed add with `console.warn` and return
 * normally, so the row was gone and every caller believed the update had
 * succeeded — `updateUnitSummary` is the enrichment write-back path, so the
 * symptom was a code unit silently vanishing from the index.
 *
 * `rowRestored` is the part a caller has to be able to act on:
 *
 *   - `true`  — the pre-update row was written back. The update did not happen;
 *               nothing was lost. Retrying is safe.
 *   - `false` — the restore ALSO failed. The row is gone from the index and
 *               only a reindex will bring it back. Nothing can prevent this
 *               once the delete has committed (see `restoreAfterFailedUpdate`),
 *               which is exactly why it must be reported rather than warned.
 */
export class VectorStoreUpdateError extends Error {
	constructor(
		readonly operation: string,
		readonly rowId: string,
		readonly rowRestored: boolean,
		cause: unknown,
		readonly restoreError?: unknown,
	) {
		super(
			`${operation} failed for '${rowId}': ${
				cause instanceof Error ? cause.message : String(cause)
			}. LanceDB has no upsert, so the row was deleted before the write; it ` +
				(rowRestored
					? "was restored, so the index is unchanged and the update did not happen."
					: `was NOT restored (${
							restoreError instanceof Error
								? restoreError.message
								: String(restoreError)
						}) — it is missing from the index until the next reindex.`),
			{ cause },
		);
		this.name = "VectorStoreUpdateError";
	}
}

/**
 * A `vector` read back out of LanceDB, as a plain `number[]` that can be
 * written back.
 *
 * `table.query().toArray()` types its rows as records of JS values, and every
 * other column really is one — but `vector` comes back as an Arrow `Vector`
 * object, NOT the `number[]` that `StoredChunk` and `ChunkWithEmbedding`
 * declare. Handing that object back to `table.add` makes LanceDB's schema
 * inference walk it as a struct and reject the whole batch (measured on the
 * installed 0.38):
 *
 *     Found field not in schema: vector.isValid at row 0
 *
 * That is one root cause with two symptoms, and both were silent-ish data
 * loss: the delete-then-add updates below destroyed the row they were updating,
 * and `getChunksWithVectors` -> indexer `reuseFromLance` -> `addChunks` failed
 * the whole index run with exit 1 whenever a modified file met a degraded
 * embedding cache. Normalising at the READ boundary fixes both, because a
 * vector that never leaves this file as an Arrow object cannot be handed back
 * as one.
 *
 * Bit-exactness is not incidental: `toArray()` on a Float32 column yields a
 * `Float32Array`, each element widens to a JS double exactly, and writing it
 * back into the same Float32 column narrows it back to the same bits. A reused
 * vector that drifted would silently change every score computed against it.
 *
 * `[]` for an undecodable value is deliberate. It is not a silent hole: the
 * write-side guard (`assertVectorDimension`, CLAUDE.md #15) rejects it before
 * it can create an unqueryable column, and the indexer's reuse path already
 * skips vectors of length <= 1.
 */
export function toPlainVector(value: unknown): number[] {
	if (Array.isArray(value)) {
		return value as number[];
	}
	if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
		return Array.from(value as unknown as ArrayLike<number>);
	}
	const arrowLike = value as
		| { toArray?: () => ArrayLike<number>; length?: number }
		| null
		| undefined;
	if (typeof arrowLike?.toArray === "function") {
		return Array.from(arrowLike.toArray());
	}
	if (typeof arrowLike?.length === "number") {
		return Array.from(arrowLike as ArrayLike<number>);
	}
	return [];
}

/**
 * Race a promise against a timeout.
 *
 * IMPORTANT — this CANNOT cancel the underlying operation. LanceDB's
 * `table.add()` / `createTable()` do NOT accept an AbortSignal, so there is no
 * way to abort the native call. When `ms` elapses, `withTimeout` only stops
 * AWAITING `p` and throws `LanceWriteTimeoutError`; the hung tokio thread keeps
 * running until the process exits. That is the intended, accepted behaviour: the
 * throw frees the JS process to release its index lock and fail loudly (rather
 * than parking forever), which pairs with the lock's progress-based auto-reclaim.
 * Do NOT mistake this for cancellation.
 *
 * The `p.finally(clearTimeout)` clears the timer on the normal (fast) path so a
 * 60s timer does not linger after a quick write; on the hang path `p` never
 * settles (again: we cannot cancel it), which is exactly the case this guards.
 */
export function withTimeout<T>(
	p: Promise<T>,
	ms: number,
	label: string,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			reject(new LanceWriteTimeoutError(label, ms));
		}, ms);
	});
	return Promise.race([
		p.finally(() => {
			if (timer) clearTimeout(timer);
		}),
		timeout,
	]);
}

// ============================================================================
// Row membership (index version 4)
// ============================================================================

/**
 * Which branch a write's rows belong to, and what kind of path they carry
 * (architecture §3.2.1). EVERY write names it, and there is no default: the
 * only value a store could default to, `,0,`, is the one §3.2.1 forbids for a
 * repository's own rows (every such row would be visible from every branch).
 */
export interface RowMembership {
	readonly pathKind: PathKind;
	/**
	 * The branch registry's REAL id for the current HEAD, or `BRANCH_ID_SHARED`
	 * (0) for docs, session observations, and every row of a store with no git
	 * layout.
	 */
	readonly branchId: number;
}

/** The canonical `branchIds` value for one branch: `,<id>,`. */
export function encodeBranchIds(branchId: number): string {
	if (!Number.isSafeInteger(branchId) || branchId < 0) {
		throw new RangeError(`not a branch id: ${String(branchId)}`);
	}
	return `,${branchId},`;
}

/**
 * A `"repo"` row whose `filePath` breaks the stored-path convention (§3.1):
 * absolute, empty, or with a `..` segment. Refused at the write, because an
 * absolute path in a relative column matches no delete and no lookup ever
 * again. That is the ghost-chunk defect, made permanent.
 */
export class StoredPathConventionError extends Error {
	constructor(
		readonly label: string,
		readonly filePath: string,
	) {
		super(
			`Refusing to write '${label}': '${filePath}' is not a repo-relative path. ` +
				"Stored repo paths are relative to the worktree root (architecture §3.1); " +
				"convert with toRepoRelative before the write.",
		);
		this.name = "StoredPathConventionError";
	}
}

/** The two v4 columns for one write, after checking every row obeys the convention. */
function membershipColumns(
	membership: RowMembership,
	filePaths: readonly string[],
	label: string,
): { branchIds: string; pathKind: PathKind } {
	if (typeof membership !== "object" || membership === null) {
		throw new TypeError(`${label}: a RowMembership is required`);
	}
	const branchIds = encodeBranchIds(membership.branchId);
	if (membership.pathKind === "repo") {
		for (const filePath of filePaths) {
			if (!isStoredRepoPath(filePath)) {
				throw new StoredPathConventionError(label, filePath);
			}
		}
	} else if (membership.pathKind !== "synthetic") {
		throw new RangeError(
			`${label}: pathKind must be "repo" or "synthetic", not ${String(membership.pathKind)}`,
		);
	}
	return { branchIds, pathKind: membership.pathKind };
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Escape special characters in filter values to prevent injection attacks
 * and crashes on special characters (identified by multi-model review).
 *
 * For LIKE patterns ONLY — see `escapeSqlLiteral` below for equality/IN
 * literals. Exported for the escaping tests, which pin the two apart.
 */
export function escapeFilterValue(value: string): string {
	// Escape single quotes by doubling them (SQL-style escaping)
	// Also escape backslashes and other special chars
	return value
		.replace(/\\/g, "\\\\")
		.replace(/'/g, "''")
		.replace(/%/g, "\\%")
		.replace(/_/g, "\\_");
}

/**
 * Escape a value for a single-quoted SQL string literal in an EQUALITY
 * predicate.
 *
 * SQL-standard quote doubling and nothing else — the same rule LanceDB's own
 * `toSQL()` (`@lancedb/lancedb/dist/util.js`) applies to strings. That helper
 * is not re-exported from the package index (only the `IntoSql` type is), so
 * calling it would mean importing from `dist/`; the rule is one line and
 * stable, so it is restated here instead. LanceDB 0.33 offers no parameterized
 * predicate API at all: `Table.delete`, `countRows` and `Query.where` each take
 * a pre-rendered SQL string, so rendering it safely is the caller's job.
 *
 * Deliberately NOT `escapeFilterValue` above: that one also backslash-escapes
 * `%` and `_` for LIKE patterns. Correct for LIKE, wrong here — in an equality
 * literal DataFusion takes the backslash literally, so `filePath =
 * 'src/my\_file.ts'` matches no row at all. Verified against LanceDB 0.33:
 * quote-doubling alone matches `o'brien.ts`, `my_file.ts`, `100%.ts` and
 * backslash paths; the LIKE escaping matches only the first.
 */
export function escapeSqlLiteral(value: string): string {
	return value.replace(/'/g, "''");
}

/**
 * A chunk id as this codebase generates them: lowercase hex, and one of the two
 * widths the tree actually produces.
 *
 * ── A DEVIATION FROM §3.7 ROW 2, recorded rather than quietly widened ──────
 * The design writes the guard as `/^[0-9a-f]{64}$/`, "sha256 hex". That is true
 * of CODE CHUNK ids (`chunker.ts` uses the full digest) and false of the other
 * two row classes this phase has to address by id: code units
 * (`code-unit-extractor.ts`) and enriched documents (`extractors/base.ts`) both
 * `.slice(0, 16)`. A 64-only guard would reject every `code_unit` and every
 * `document` id — the two classes §4.1.1's N4 exists for. The PROPERTY the
 * design's rule is about is unchanged: a closed alphabet this module produces,
 * with nothing to quote-double and nothing to neutralise.
 */
const CHUNK_ID_PATTERN = /^(?:[0-9a-f]{16}|[0-9a-f]{64})$/;

/** A chunk id that did not come out of this codebase's id generators. */
export class ChunkIdConventionError extends Error {
	constructor(readonly id: string) {
		super(
			`Refusing to build an id predicate from ${JSON.stringify(id)}: chunk ids are 16 or 64 lowercase hex characters. ` +
				"This predicate is interpolated with no escaper precisely because its alphabet is closed (architecture §3.7 row 2, CLAUDE.md #22).",
		);
		this.name = "ChunkIdConventionError";
	}
}

/**
 * `id IN ('…','…')` — §3.7 row 2's renderer, and the ONLY way this file builds
 * an id predicate.
 *
 * NO ESCAPER, and the assertion is the mechanism rather than decoration: every
 * id is checked against a closed alphabet, so there is nothing to quote-double
 * (`escapeSqlLiteral`) and nothing to neutralise (`escapeFilterValue`, whose
 * backslashes would make an equality or `IN` literal match ZERO rows —
 * CLAUDE.md #22's headline failure). It runs on every call and is not gated on
 * a debug flag.
 */
export function hexIdList(ids: readonly string[]): string {
	const quoted: string[] = [];
	for (const id of ids) {
		if (!CHUNK_ID_PATTERN.test(id)) throw new ChunkIdConventionError(id);
		quoted.push(`'${id}'`);
	}
	return `id IN (${quoted.join(", ")})`;
}

/** How many ids go into one `id IN (…)` predicate. `WRITE_CHUNK` (§4.1.1). */
const ID_PREDICATE_BATCH = 256;

function chunkIds(ids: readonly string[]): string[][] {
	const batches: string[][] = [];
	for (let i = 0; i < ids.length; i += ID_PREDICATE_BATCH) {
		batches.push([...ids.slice(i, i + ID_PREDICATE_BATCH)]);
	}
	return batches;
}

/**
 * The stored row's column names, taken from the DECLARED schema so a round trip
 * cannot silently drop a column added later. The width is irrelevant — only the
 * field names are read.
 */
let storedChunkColumnNames: string[] | null = null;
function storedChunkColumns(): string[] {
	storedChunkColumnNames ??= codeChunksSchema(1).fields.map(
		(field) => field.name,
	);
	return storedChunkColumnNames;
}

/**
 * The ids in one stored `branchIds` cell (`,1,2,`).
 *
 * Deliberately NOT imported from `branch-scope.ts`: that module is a LEAF the
 * tracker and the MCP tools depend on, and it must not gain an edge to this
 * file (which pulls in LanceDB). Six lines, one direction of the same encoding.
 */
function decodeBranchIdCell(cell: unknown): number[] {
	if (typeof cell !== "string" || cell.length === 0) return [];
	const ids: number[] = [];
	for (const part of cell.split(",")) {
		if (part === "") continue;
		const id = Number(part);
		if (Number.isSafeInteger(id) && id >= 0) ids.push(id);
	}
	return ids;
}

/**
 * `StoredChunk` rows for code units. ONE definition, shared by the append path
 * (`addCodeUnits`) and the in-place refresh (`refreshCodeUnits`): a refresh that
 * built its rows separately would drift from the append's column set, and the
 * declared schema would then reject one of them at write time.
 *
 * `branchIds` is per ROW rather than per batch, because a refresh writes each
 * row's RECOMPUTED mirror (the row may be held by several branches) while an
 * append writes one branch's `,<id>,`.
 */
function storedRowsForUnits(
	units: CodeUnitWithEmbedding[],
	branchIds: string | ReadonlyMap<string, string>,
	pathKind: PathKind,
): StoredChunk[] {
	const now = new Date().toISOString();
	return units.map((unit) => ({
		id: unit.id,
		contentHash: "", // CodeUnits don't use contentHash (for incremental diffing)
		content: unit.content,
		filePath: unit.filePath,
		startLine: unit.startLine,
		endLine: unit.endLine,
		language: unit.language,
		chunkType: unit.unitType, // Map unitType to chunkType for compatibility
		name: unit.name || "",
		parentName: "", // Not used in new model
		signature: unit.signature || "",
		fileHash: unit.fileHash,
		vector: unit.vector,
		// Index v3.
		embedKey: unit.embedKey ?? "",
		// Document fields for unified storage
		documentType: "code_unit",
		sourceIds: "[]",
		metadata: JSON.stringify(unit.metadata || {}),
		createdAt: now,
		enrichedAt: "",
		// Hierarchical fields
		parentId: unit.parentId || "",
		unitType: unit.unitType,
		depth: unit.depth,
		summary: "", // Will be populated by summarization phase
		branchIds:
			typeof branchIds === "string"
				? branchIds
				: (branchIds.get(unit.id) ?? ""),
		pathKind,
	}));
}

/**
 * One row of a widening merge's SOURCE: every declared column, with `vector`
 * already normalised to a plain array.
 */
export type WidenSourceRow = Record<string, unknown> & {
	id: string;
	branchIds: string;
};

/**
 * True when the table's BM25 index on `FTS_COLUMN` exists AND already covers
 * every live row, so rebuilding it would be pure cost.
 *
 * The semantics below were established empirically against LanceDB 0.37.1,
 * because the answer decides whether skipping a rebuild can silently rot BM25:
 *
 *   - rows ADDED after the index was built are still returned by
 *     `fullTextSearch` (LanceDB scans the unindexed tail), and are reported as
 *     `numUnindexedRows > 0`;
 *   - rows DELETED after the index was built are correctly excluded, via
 *     deletion vectors applied at query time;
 *   - rows UPDATED after the index was built return their new terms and stop
 *     returning their stale ones, and count as unindexed.
 *
 * So `numUnindexedRows === 0` is an exact "this index is current" signal, and
 * treating everything else as stale reproduces the previous
 * rebuild-whenever-the-corpus-moved behaviour without any in-process
 * bookkeeping that a second process could invalidate behind our back.
 */
async function ftsIndexCoversCorpus(table: lancedb.Table): Promise<boolean> {
	const fts = (await table.listIndices()).find(
		(index) =>
			index.indexType.toUpperCase() === FTS_INDEX_TYPE &&
			index.columns.includes(FTS_COLUMN),
	);

	// No FTS index at all: a fresh store, or one written before FTS existed.
	if (!fts) return false;

	// Local tables report coverage inline. Remote tables leave these undefined
	// and need the extra round trip to `indexStats`.
	const unindexed =
		fts.numUnindexedRows ??
		(await table.indexStats(fts.name))?.numUnindexedRows;

	return unindexed === 0;
}

// ============================================================================
// Types
// ============================================================================

interface StoredChunk {
	[key: string]: unknown;
	id: string;
	contentHash: string; // Content-addressable hash for incremental diffing
	content: string;
	filePath: string;
	startLine: number;
	endLine: number;
	language: string;
	chunkType: string;
	name: string;
	parentName: string;
	signature: string;
	fileHash: string;
	vector: number[];
	/**
	 * Embedding-cache key for THIS row's `vector` — index version 3's column.
	 *
	 * `""` means "unknown", which is a legal and common value: enriched
	 * documents (never cached), BM25 mode, a run with the cache disabled, or a
	 * dimension that was never learned. Never null — Arrow infers the column
	 * type from the first batch and a null would make it nullable-of-nothing,
	 * the same class of hazard as the 0-dimension vector column.
	 *
	 * The invariant a consumer may rely on is only this: when non-empty, the key
	 * addresses the vector stored BESIDE it in this row. Every write path that
	 * replaces `vector` without recomputing the key must therefore clear it —
	 * see `updateDocumentContent`.
	 */
	embedKey: string;
	// Enriched document fields
	documentType: string; // "code_chunk" for code, others for enriched docs
	sourceIds: string; // JSON array of source chunk IDs
	metadata: string; // JSON for type-specific fields (also used for ASTMetadata)
	createdAt: string;
	enrichedAt: string;
	// Hierarchical CodeUnit fields (new in v0.4)
	parentId: string; // ID of parent unit (null for file-level)
	unitType: string; // "file" | "class" | "interface" | "function" | "method" | "type" | "enum"
	depth: number; // Depth in hierarchy (0=file, 1=class/function, 2=method)
	summary: string; // LLM-generated summary of this unit
	/** Index v4: `,<id>,` membership, from the write's `RowMembership`. */
	branchIds: string;
	/** Index v4: `"repo"` | `"synthetic"` (§3.1). */
	pathKind: string;
}

/**
 * The DECLARED Arrow schema of `code_chunks` (architecture §3.2), passed at
 * all three `createTable` sites. Field for field it is what LanceDB 0.38
 * INFERRED from a v3 row (measured: every string `Utf8`, every number
 * `Float64`, the vector `FixedSizeList[dim]<Float32>`, all nullable), plus
 * the two v4 columns. It is declared rather than inferred for two reasons:
 *
 *   - A writer whose keys disagree with it fails AT WRITE TIME, with the
 *     field named, instead of deciding the schema by being first.
 *   - The vector width comes from the validated dimension, not from whatever
 *     the first batch held. That retires the `FixedSizeList[0]` hazard for
 *     NEW tables. The four CLAUDE.md #15 guards stay, because tables written
 *     by older builds still exist.
 *
 * It is a function of the dimension, not one constant, because the vector
 * width belongs to the embedding model.
 */
export function codeChunksSchema(dimension: number): Schema {
	const width = assertVectorDimension(dimension, "codeChunksSchema");
	const text = (name: string) => new Field(name, new Utf8(), true);
	const number = (name: string) => new Field(name, new Float64(), true);
	return new Schema([
		text("id"),
		text("contentHash"),
		text("content"),
		text("filePath"),
		number("startLine"),
		number("endLine"),
		text("language"),
		text("chunkType"),
		text("name"),
		text("parentName"),
		text("signature"),
		text("fileHash"),
		new Field(
			"vector",
			new FixedSizeList(width, new Field("item", new Float32(), true)),
			true,
		),
		text(EMBED_KEY_COLUMN),
		text("documentType"),
		text("sourceIds"),
		text("metadata"),
		text("createdAt"),
		text("enrichedAt"),
		text("parentId"),
		text("unitType"),
		number("depth"),
		text("summary"),
		text(BRANCH_IDS_COLUMN),
		text(PATH_KIND_COLUMN),
	]);
}

export interface SearchOptions {
	limit?: number;
	language?: string;
	filePath?: string;
	pathPattern?: string;
	keywordOnly?: boolean;
	useCase?: SearchUseCase;
}

// ============================================================================
// IVectorStore Interface
// ============================================================================

/**
 * Interface for vector store implementations.
 * Allows swapping in cloud or alternative storage backends.
 */
export interface IVectorStore {
	readonly dimensionMismatchCleared: boolean;
	initialize(): Promise<void>;
	/** True when the table exists but its vector column has 0 dimensions. */
	isUnqueryable(): Promise<boolean>;
	/**
	 * Tri-state live schema read for the index-v3 `embedKey` column.
	 * See `VectorStore.hasEmbedKeyColumn` for why it is not memoised.
	 */
	hasEmbedKeyColumn(): Promise<boolean | null>;
	/** Tri-state live schema read for index v4's `branchIds` column (§6.1). */
	hasBranchIdsColumn(): Promise<boolean | null>;
	/** The declared width of the vector column; `1` is BM25-only. See the method. */
	vectorWidth(): Promise<number | null>;
	/** `membership` is required: see `RowMembership`. */
	addChunks(
		chunks: ChunkWithEmbedding[],
		membership: RowMembership,
	): Promise<void>;
	/**
	 * `scope` is a REQUIRED POSITIONAL parameter, never construction state
	 * (§2.5, §4.4). The MCP server is long-lived and the user switches branches
	 * underneath it, so a scope captured at construction answers the previous
	 * branch for the rest of the process's life (V3.10). Positional, so a caller
	 * that forgets it is a type error rather than a read that spans branches.
	 */
	search(
		queryText: string,
		queryVector: number[] | undefined,
		scope: BranchScope,
		options?: SearchOptions,
	): Promise<SearchResult[]>;
	/** Rows actually deleted (LanceDB's `numDeletedRows`); 0 on no match or failure. */
	deleteByFile(filePath: string): Promise<number>;
	deleteByFileHash(fileHash: string): Promise<number>;
	getChunksWithVectors(filePath: string): Promise<ChunkWithEmbedding[]>;
	/**
	 * Membership by id (§4.1). These take NO `BranchScope`: they are write-path
	 * operations addressed by primary key, and the branch they act for is the
	 * caller's `branchId`, not HEAD's. See each method for its contract.
	 */
	existingIds(ids: string[]): Promise<Set<string>>;
	rowsForWidening(ids: string[]): Promise<WidenSourceRow[]>;
	/** Rewrite existing code-unit rows in place; see the method for WHY. */
	refreshCodeUnits(
		units: CodeUnitWithEmbedding[],
		mirrorById: ReadonlyMap<string, string>,
		pathKind: PathKind,
	): Promise<number>;
	writeBranchIdsMirror(rows: WidenSourceRow[]): Promise<number>;
	deleteByIds(ids: string[]): Promise<number>;
	optimize(): Promise<void>;
	/** The highest branch id any ROW carries, or null (3a-2 finding 4). */
	highestBranchId(): Promise<number | null>;
	getVectorsByIds(ids: string[]): Promise<Map<string, number[]>>;
	clear(): Promise<void>;
	getChunkContents(limit?: number): Promise<string[]>;
	getStats(): Promise<{
		totalChunks: number;
		uniqueFiles: number;
		languages: string[];
	}>;
	addDocuments(
		documents: DocumentWithEmbedding[],
		membership: RowMembership,
	): Promise<void>;
	deleteByDocumentType(documentType: DocumentType): Promise<number>;
	deleteAllByFile(filePath: string): Promise<number>;
	getDocumentsByFile(
		scope: BranchScope,
		filePath: string,
		documentTypes?: DocumentType[],
	): Promise<BaseDocument[]>;
	searchDocuments(
		queryText: string,
		queryVector: number[],
		scope: BranchScope,
		options?: EnrichedSearchOptions,
	): Promise<EnrichedSearchResult[]>;
	getDocumentTypeStats(): Promise<Record<DocumentType, number>>;
	close(): Promise<void>;
	addCodeUnits(
		units: CodeUnitWithEmbedding[],
		membership: RowMembership,
	): Promise<void>;
	/**
	 * No-op when there is no such unit; THROWS `VectorStoreUpdateError` when the
	 * write fails. The error's `rowRestored` says whether the row survived.
	 */
	updateUnitSummary(unitId: string, summary: string): Promise<void>;
	/**
	 * `false` means no such document — nothing else. A failed write THROWS
	 * `VectorStoreUpdateError`, whose `rowRestored` says whether the row
	 * survived.
	 */
	updateDocumentContent(
		documentId: string,
		newContent: string,
		newVector: number[],
	): Promise<boolean>;
	getAllSummaries(): Promise<Array<BaseDocument & { vector: number[] }>>;
	getCodeUnitsByFile(
		scope: BranchScope,
		filePath: string,
		unitTypes?: UnitType[],
	): Promise<CodeUnit[]>;
	getCodeUnitsByDepth(
		scope: BranchScope,
		depth: number,
		filePath?: string,
	): Promise<CodeUnit[]>;
	/**
	 * `parentId` is CONTENT-derived, so two branches holding the same file
	 * produce the same parent and an unscoped read returns both branches'
	 * children. Scoped for that reason, although §4.4's site list names only the
	 * six above.
	 */
	getChildUnits(scope: BranchScope, parentId: string): Promise<CodeUnit[]>;
	getCodeUnit(unitId: string): Promise<CodeUnit | null>;
	searchCodeUnits(
		queryText: string,
		queryVector: number[],
		scope: BranchScope,
		options?: {
			limit?: number;
			unitTypes?: UnitType[];
			minDepth?: number;
			maxDepth?: number;
			filePath?: string;
			includeSummaries?: boolean;
		},
	): Promise<Array<CodeUnit & { score: number }>>;
	getMaxDepth(filePath?: string): Promise<number>;
}

// ============================================================================
// Vector Store Class
// ============================================================================

/**
 * Construction options for `VectorStore`. BOTH fields are required, and that is
 * the mechanism: the positional `(dbPath, projectPath?)` it replaces let callers
 * omit the second argument and inherit `dirname(dirname(dbPath))`, a directory
 * derived from wherever the store happens to sit. An object with no optional
 * field makes every such caller a compile error instead.
 */
export interface VectorStoreOptions {
	/** The LanceDB directory: the store's `vectors/`. */
	vectorsDir: string;
	/**
	 * The caller's own `resolveStoreLocation(startPath).pathRoot`: the worktree
	 * root, or the start path outside a repository. Never derived from
	 * `vectorsDir`, and never read back from the store.
	 */
	pathRoot: string;
}

export class VectorStore implements IVectorStore {
	private dbPath: string;
	/** See `VectorStoreOptions.pathRoot`. Read by `getTestFileMode`. */
	private pathRoot: string;
	private db: lancedb.Connection | null = null;
	private table: lancedb.Table | null = null;
	private dimension: number | null = null;
	private tableDimension: number | null = null;
	private _dimensionMismatchCleared = false;
	private testFileDetector: TestFileDetector;

	/**
	 * There is deliberately NO fallback for `pathRoot`. The store used to derive
	 * it as `dirname(dirname(dbPath))`, which names the project only while the
	 * store sits at `<project>/.mnemex/vectors`: under an index-dir override it
	 * named the override's parent, for a benchmark temp store it named
	 * `.mnemex`, and once the store moves under the git common dir it would name
	 * `.git`. A default here would restore that trap silently.
	 */
	constructor(options: VectorStoreOptions) {
		this.dbPath = options.vectorsDir;
		this.pathRoot = options.pathRoot;
		this.testFileDetector = createTestFileDetector();
	}

	/**
	 * Returns true if vectors were auto-cleared due to dimension mismatch
	 * during this session. Used by indexer to also clear file tracker.
	 */
	get dimensionMismatchCleared(): boolean {
		return this._dimensionMismatchCleared;
	}

	/**
	 * Initialize the database connection
	 */
	async initialize(): Promise<void> {
		// Ensure directory exists
		if (!existsSync(dirname(this.dbPath))) {
			mkdirSync(dirname(this.dbPath), { recursive: true });
		}

		this.db = await lancedb.connect(this.dbPath);
	}

	/**
	 * THE read seam (architecture §3.1, decision D4): a stored row's path as a
	 * caller sees it. Every row-to-result hydration in this class goes through
	 * here, and nothing above the store converts a path.
	 */
	private outputPath(row: { filePath: string; pathKind?: unknown }): string {
		return fromStoredPath(this.pathRoot, row);
	}

	/**
	 * A caller's path argument in stored form, for an EQUALITY predicate.
	 * Absolute: repo-relative under `pathRoot`, or null when outside it (and the
	 * caller then matches nothing). Relative: already stored, e.g. a
	 * `docs:<pkg>` id or a path the tracker handed back.
	 */
	private storedPathArg(filePath: string): string | null {
		return isAbsolute(filePath)
			? toRepoRelative(this.pathRoot, filePath)
			: filePath;
	}

	/**
	 * A `LIKE` substring argument: an absolute path under `pathRoot` is matched
	 * in stored form, anything else as written. Every use still escapes it with
	 * `escapeFilterValue` (CLAUDE.md #22).
	 */
	private likePatternArg(pattern: string): string {
		return isAbsolute(pattern)
			? (toRepoRelative(this.pathRoot, pattern) ?? pattern)
			: pattern;
	}

	/**
	 * Ensure the table exists, opening it if available
	 */
	private async ensureTableOpen(): Promise<lancedb.Table | null> {
		if (!this.db) {
			await this.initialize();
		}

		if (this.table) {
			return this.table;
		}

		// Check if table exists
		const tables = await this.db!.tableNames();
		if (tables.includes(CHUNKS_TABLE)) {
			this.table = await this.db!.openTable(CHUNKS_TABLE);

			// Extract vector dimension from schema for compatibility checks
			try {
				const schema = await this.table.schema();
				const vectorField = schema.fields.find(
					(f: { name: string }) => f.name === "vector",
				);
				if (vectorField?.type && "listSize" in vectorField.type) {
					this.tableDimension = (
						vectorField.type as { listSize: number }
					).listSize;
				}
			} catch {
				// Ignore schema read errors - dimension check will be skipped
			}

			// A FixedSizeList[0] vector column is unqueryable and unrepairable.
			// Every read that touches `vector` fails in native code: LanceDB
			// >= 0.20 raises LanceError(Schema), and 0.13-0.19 panic inside a
			// tokio worker with "attempt to divide by zero" — a Rust backtrace
			// that no JS catch can intercept and no user can act on. Reject the
			// table here, at the one place every read and write opens it, so the
			// caller gets one sentence naming the fix instead.
			//
			// Thrown OUTSIDE the try above, whose catch would swallow it.
			// `clear()` drops the table without calling this method, so
			// `mnemex index --force` still recovers.
			try {
				assertQueryableTableDimension(this.tableDimension);
			} catch (err) {
				this.table = null;
				this.tableDimension = null;
				throw err;
			}

			return this.table;
		}

		return null;
	}

	/**
	 * The DECLARED width of the stored vector column, or `null` when there is no
	 * table (or it cannot be read).
	 *
	 * `1` means the store was written in BM25-only mode: every row carries the
	 * `[0]` placeholder, and no row can answer a vector query. That is a
	 * whole-store fact rather than a per-row one, because `addChunks` clears the
	 * table the moment an incoming width disagrees — so a table never holds two
	 * widths at once.
	 *
	 * The indexer reads it BEFORE deciding anything: under the branch model the
	 * tier-1 hit test would otherwise WIDEN placeholder rows into this run,
	 * because they exist and are registered, and the mismatch clear that follows
	 * would then drop them (see `indexInternal`).
	 */
	async vectorWidth(): Promise<number | null> {
		try {
			const table = await this.ensureTableOpen();
			if (!table) return null;
			return this.tableDimension;
		} catch {
			return null;
		}
	}

	/**
	 * Non-throwing corruption probe: true when the table exists but its vector
	 * column has 0 dimensions.
	 *
	 * Reuses `ensureTableOpen()` so detection stays in one place. Callers that
	 * can repair the index (the indexer, which owns the tracker too) ask this
	 * first; callers that cannot let the throw reach the user instead.
	 */
	async isUnqueryable(): Promise<boolean> {
		try {
			await this.ensureTableOpen();
			return false;
		} catch (err) {
			if (err instanceof UnqueryableVectorIndexError) {
				return true;
			}
			throw err;
		}
	}

	/**
	 * Does the table on disk carry the index-v3 `embedKey` column?
	 *
	 *   true  — a table exists and has it (v3-shaped).
	 *   false — a table exists and does NOT (v2-shaped; the caller rebuilds).
	 *   null  — there is no table yet, or its schema could not be read.
	 *
	 * The Arrow schema is INFERRED from whichever batch creates the table
	 * (`createTable` in `addChunks` / `addDocuments` / `addCodeUnits`) and is
	 * never declared, so an index written before v3 has a 22-column schema and a
	 * 23-field batch against it is a schema mismatch. This read is how the
	 * indexer notices, once, before it writes anything.
	 *
	 * DELIBERATELY NOT MEMOISED, and deliberately not folded into
	 * `ensureTableOpen()`. A cached flag would go stale three independent ways,
	 * all of which exist in this file today:
	 *
	 *   - `clear()` sets `this.table = null` but leaves derived state alone
	 *     (compare the EXPLICIT `this.tableDimension = null` in `addChunks`'s
	 *     dimension-mismatch branch, which exists because `clear()` does not do
	 *     it);
	 *   - the three `createTable` branches assign `this.table` DIRECTLY, never
	 *     through `ensureTableOpen()`, so a flag computed there is never
	 *     recomputed for the table they just created;
	 *   - `ensureTableOpen()` returns the memoised `this.table` on every call
	 *     after the first, so a flag computed there is computed once.
	 *
	 * There is one caller, it runs at most once per index run, and it runs
	 * before any write. One schema read per run is not worth a cache, and a
	 * cache here is worth a defect — this is CLAUDE.md #21's shape, decided the
	 * other way round because the answer, not the setup, is what goes stale.
	 *
	 * `ensureTableOpen()`'s throw is NOT swallowed: `UnqueryableVectorIndexError`
	 * is the read-side 0-dimension guard, and a probe that turned it into `null`
	 * would be a second, quieter way past it. A caller that wants a non-throwing
	 * corruption probe has `isUnqueryable()`, and the indexer runs that first.
	 */
	async hasEmbedKeyColumn(): Promise<boolean | null> {
		const table = await this.ensureTableOpen();
		if (!table) return null;

		try {
			const schema = await table.schema();
			return schema.fields.some(
				(f: { name: string }) => f.name === EMBED_KEY_COLUMN,
			);
		} catch {
			// Schema unreadable on a table that just opened. No rebuild is
			// triggered, so an incremental run then builds a 23-field batch and
			// `table.add` fails loudly — which is the correct direction: mixing
			// row shapes silently is the thing the version exists to prevent.
			return null;
		}
	}

	/**
	 * Does the table on disk carry index version 4's `branchIds` column?
	 * `true` / `false` / `null` exactly as `hasEmbedKeyColumn`, and NOT memoised
	 * for the same reasons. `false` is the upgrade signal. `null` (no table) is a
	 * fresh index and needs no migration, which is why the caller compares
	 * `=== false`, never falsiness (architecture §6.1).
	 */
	async hasBranchIdsColumn(): Promise<boolean | null> {
		const table = await this.ensureTableOpen();
		if (!table) return null;

		try {
			const schema = await table.schema();
			return schema.fields.some(
				(f: { name: string }) => f.name === BRANCH_IDS_COLUMN,
			);
		} catch {
			return null;
		}
	}

	/**
	 * Build the BM25 full-text index on `content` if, and only if, the one on
	 * disk does not already cover the current corpus.
	 *
	 * This used to be guarded by a per-INSTANCE `ftsIndexReady` flag while
	 * VectorStore instances are built per-SEARCH (SemanticBackend constructs a
	 * fresh Indexer per query and closes it in a `finally`, and each Indexer
	 * builds its own VectorStore). The flag was therefore always `false` on
	 * entry, so `createIndex(..., { replace: true })` — which rebuilds rather
	 * than no-ops — ran on EVERY search. Measured on this repo's real store
	 * (19,862 rows, 2.6 GB): ~275 ms per call against a ~9 ms BM25 query, i.e.
	 * roughly half of total search latency spent rebuilding an index that was
	 * already correct, and 820 index versions accumulated on disk. Same defect
	 * as `initializedSchemas` in src/core/tracker.ts and
	 * src/learning/feedback/feedback-store.ts — an idempotent-but-expensive
	 * setup guarded per-instance while instances are per-request.
	 *
	 * Freshness is read from the store itself rather than memoized in a
	 * process-global set, because LanceDB answers the question directly and
	 * cheaply: `indexStats().numUnindexedRows` is 0 exactly when the index
	 * covers every live row. Measured on the same store, `listIndices()` +
	 * `indexStats()` cost ~0.09 ms — three orders of magnitude below a rebuild,
	 * so there is nothing to gain from a memo, and a memo would be strictly
	 * less correct: it cannot see a corpus mutated by ANOTHER process (a
	 * `mnemex watch` daemon writing while an MCP server serves searches), which
	 * this probe catches for free. It also needs no invalidation hooks on
	 * `addChunks` and friends, so there is no way to add a write path later and
	 * silently rot BM25 by forgetting to invalidate.
	 *
	 * Verified against LanceDB 0.37.1 — see the empirical notes on
	 * `ftsIndexCoversCorpus`. A missing index yields `listIndices() === []`, so
	 * a fresh store, or one created before FTS existed, still gets its index
	 * built here.
	 */
	private async ensureFtsIndex(): Promise<void> {
		const table = this.table;
		if (!table) return;

		try {
			if (await ftsIndexCoversCorpus(table)) return;
		} catch {
			// Freshness unknown — fall through and rebuild, which is the safe
			// direction: a redundant rebuild is slow, a skipped one is wrong.
		}

		try {
			await table.createIndex(FTS_COLUMN, {
				config: lancedb.Index.fts(),
				replace: true,
			});
		} catch {
			// FTS index creation failed — BM25 search will be unavailable
		}
	}

	/**
	 * Add chunks with embeddings to the store
	 */
	async addChunks(
		chunks: ChunkWithEmbedding[],
		membership: RowMembership,
	): Promise<void> {
		// Checked before the empty-batch return, so a caller that forgot the
		// membership fails on its first call, not on its first non-empty one.
		const columns = membershipColumns(
			membership,
			chunks.map((chunk) => chunk.filePath),
			"addChunks",
		);
		if (chunks.length === 0) {
			return;
		}

		// Convert to stored format
		// Use empty strings instead of null for optional fields to avoid Arrow type inference issues
		const now = new Date().toISOString();
		const data: StoredChunk[] = chunks.map((chunk) => ({
			id: chunk.id,
			contentHash: chunk.contentHash || "", // For incremental diffing
			content: chunk.content,
			filePath: chunk.filePath,
			startLine: chunk.startLine,
			endLine: chunk.endLine,
			language: chunk.language,
			chunkType: chunk.chunkType,
			name: chunk.name || "",
			parentName: chunk.parentName || "",
			signature: chunk.signature || "",
			fileHash: chunk.fileHash,
			vector: chunk.vector,
			// Index v3. Covers code chunks AND external-docs rows, which are
			// written through this same method as documentType "code_chunk".
			embedKey: chunk.embedKey ?? "",
			// Enriched document fields (defaults for code chunks)
			documentType: "code_chunk",
			sourceIds: "[]",
			metadata: "{}",
			createdAt: now,
			enrichedAt: "",
			// Hierarchical fields (defaults for legacy code chunks)
			parentId: "",
			unitType: "",
			depth: -1,
			summary: "",
			branchIds: columns.branchIds,
			pathKind: columns.pathKind,
		}));

		// Try to open existing table
		let table = await this.ensureTableOpen();

		// Check for dimension mismatch with existing table
		const incomingDimension = assertVectorDimension(
			data[0].vector.length,
			"addChunks",
		);
		if (
			table &&
			this.tableDimension &&
			this.tableDimension !== incomingDimension
		) {
			// Dimension mismatch - clear the table and recreate
			// This happens when embedding model changes but tracker metadata wasn't updated properly
			console.warn(
				`⚠️  Vector dimension mismatch: table has ${this.tableDimension}d, new embeddings are ${incomingDimension}d`,
			);
			console.warn(
				"   Clearing existing vectors to match new embedding model...\n",
			);
			await this.clear();
			table = null;
			this.tableDimension = null;
			this._dimensionMismatchCleared = true;
		}

		if (table) {
			// Table exists, add to it. Wrapped in withTimeout so a hung LanceDB
			// write throws (and releases the lock) instead of parking forever.
			await withTimeout(
				table.add(data),
				LANCEDB_WRITE_TIMEOUT_MS,
				"addChunks:table.add",
			);
		} else {
			// Create table with the first batch of data
			if (!this.db) {
				await this.initialize();
			}
			this.table = await withTimeout(
				this.db!.createTable(CHUNKS_TABLE, data, {
					mode: "create",
					// DECLARED, not inferred: see `codeChunksSchema`.
					schema: codeChunksSchema(incomingDimension),
				}),
				LANCEDB_WRITE_TIMEOUT_MS,
				"addChunks:createTable",
			);
			this.tableDimension = incomingDimension;
		}

		// Store dimension for later
		if (data.length > 0 && !this.dimension) {
			this.dimension = data[0].vector.length;
		}
	}

	/**
	 * Unified search: type-aware hybrid search across all document layers.
	 *
	 * Uses typeAwareRRFFusion to weight code_chunks, symbol_summaries, and
	 * file_summaries by use-case. Summary documents are joined back to their
	 * source code chunks via sourceIds, so callers get code results with
	 * attached LLM summaries.
	 *
	 * This is the single search path used by CLI, TUI, and MCP.
	 */
	async search(
		queryText: string,
		queryVector: number[] | undefined,
		scope: BranchScope,
		options: SearchOptions = {},
	): Promise<SearchResult[]> {
		const {
			limit = DEFAULT_LIMIT,
			language,
			filePath,
			pathPattern,
			keywordOnly,
			useCase,
		} = options;

		const table = await this.ensureTableOpen();
		if (!table) {
			return [];
		}

		// Build filter string with escaped values to prevent injection.
		// Note the two escapers: equality literals take `escapeSqlLiteral`, LIKE
		// patterns take `escapeFilterValue` (which additionally neutralises the
		// `%` / `_` wildcards). Swapping either way is a silent bug — see the
		// comments on the two functions.
		const filters: string[] = [];
		// D6, part 1: the branch predicate is a PRE-filter, on BOTH retrievers.
		// It goes in the same `filters` array the language and path predicates
		// use, which is passed to `.where()` on the vectorSearch query AND on the
		// fullTextSearch query below. A foreign row then never enters the
		// candidate set, never consumes a `limit` slot and never displaces a
		// visible row. A POST-filter would silently return fewer than `limit`
		// results — a far larger NFR-5 break than any statistical drift — which is
		// why `postfilter` must not appear in this file at all (swept).
		const branchFilter = branchMembershipFilter(scope);
		if (branchFilter !== null) filters.push(branchFilter);
		if (language) {
			filters.push(`language = '${escapeSqlLiteral(language)}'`);
		}
		if (filePath) {
			filters.push(
				`filePath LIKE '%${escapeFilterValue(this.likePatternArg(filePath))}%'`,
			);
		}
		if (pathPattern) {
			filters.push(
				`filePath LIKE '%${escapeFilterValue(this.likePatternArg(pathPattern))}%'`,
			);
		}
		const filterStr = filters.length > 0 ? filters.join(" AND ") : undefined;

		// Fetch more results to account for multi-type documents
		const fetchLimit = limit * 3;

		// Vector search (skip if keyword-only mode or no vector)
		let vectorResults: any[] = [];
		if (!keywordOnly && queryVector) {
			let vectorQuery = table.vectorSearch(queryVector).limit(fetchLimit);
			if (filterStr) {
				vectorQuery = vectorQuery.where(filterStr);
			}
			vectorResults = await vectorQuery.toArray();
		}

		// BM25 full-text search (if available)
		await this.ensureFtsIndex();
		let bm25Results: any[] = [];
		try {
			let ftsQuery = table
				.query()
				.fullTextSearch(queryText, { columns: ["content"] })
				.limit(fetchLimit);
			if (filterStr) {
				ftsQuery = ftsQuery.where(filterStr);
			}
			bm25Results = await ftsQuery.toArray();
		} catch {
			bm25Results = [];
		}

		// Type-aware Reciprocal Rank Fusion
		const weights = getUseCaseWeights(useCase || "search");
		const testFileMode = getTestFileMode(this.pathRoot);
		const fused = typeAwareRRFFusion(
			vectorResults,
			bm25Results,
			VECTOR_WEIGHT,
			BM25_WEIGHT,
			weights,
			this.testFileDetector,
			testFileMode,
		);

		// Separate code results from summary results
		const codeResults: FusedResult[] = [];
		const symbolSummaryById = new Map<string, string>(); // sourceChunkId -> symbol summary
		const fileSummaryById = new Map<string, string>(); // sourceChunkId -> file summary

		for (const r of fused) {
			// Skip corrupt/empty rows (LanceDB binary data corruption)
			if (!r.filePath) continue;

			const docType = (r.documentType || "code_chunk") as string;
			if (docType === "symbol_summary" || docType === "file_summary") {
				// Extract summary text and map to source code chunks
				let sourceIds: string[] = [];
				if (r.sourceIds) {
					try {
						sourceIds =
							typeof r.sourceIds === "string"
								? JSON.parse(r.sourceIds)
								: r.sourceIds;
					} catch {
						// Skip corrupted sourceIds from legacy index migration
					}
				}
				const summaryText = r.content || "";
				const targetMap =
					docType === "symbol_summary" ? symbolSummaryById : fileSummaryById;
				for (const srcId of sourceIds) {
					if (!targetMap.has(srcId)) {
						targetMap.set(srcId, summaryText);
					}
				}
			} else {
				// code_chunk, code_unit, session_observation, etc.
				codeResults.push(r);
			}
		}

		// Attach summaries to their source code chunks
		// Prefer symbol-level summary (more specific), fall back to file-level
		const topResults = codeResults.slice(0, limit);
		const maxFused = topResults.length > 0 ? topResults[0].fusedScore : 1;
		return topResults.map((r) => {
			const docType = (r.documentType || "code_chunk") as string;
			let meta: Record<string, unknown> | undefined;
			if (r.metadata) {
				try {
					meta =
						typeof r.metadata === "string"
							? JSON.parse(r.metadata)
							: r.metadata;
				} catch {
					// Skip corrupted metadata (e.g. from legacy index migration)
					meta = undefined;
				}
			}
			return {
				chunk: {
					id: r.id,
					contentHash: r.contentHash || "",
					content: r.content,
					filePath: this.outputPath(r),
					startLine: r.startLine,
					endLine: r.endLine,
					language: r.language,
					chunkType: r.chunkType as any,
					name: r.name || undefined,
					parentName: r.parentName || undefined,
					signature: r.signature || undefined,
					fileHash: r.fileHash,
				},
				score: maxFused > 0 ? r.fusedScore / maxFused : 0,
				vectorScore: r.vectorScore || 0,
				keywordScore: r.keywordScore || 0,
				// D1's per-row attribution, as IDS. The store has no registry, so
				// it cannot name branches; `Indexer.searchScoped` resolves these to
				// labels. Per-row attribution is what lets an agent discount a
				// foreign row instead of discarding the whole response (§4.4.2).
				branchIds: decodeBranchIds(r[BRANCH_IDS_COLUMN]),
				summary:
					r.summary ||
					symbolSummaryById.get(r.id) ||
					fileSummaryById.get(r.id) ||
					undefined,
				fileSummary: fileSummaryById.get(r.id) || undefined,
				unitType: r.unitType || undefined,
				...(docType === "session_observation"
					? {
							documentType: "session_observation" as const,
							observationMetadata: meta,
						}
					: {}),
			};
		});
	}

	/**
	 * Delete all chunks from a specific file.
	 *
	 * @returns the number of rows LanceDB deleted. 0 means nothing matched, there
	 * is no table, or the delete failed (it never throws; see the catch).
	 */
	async deleteByFile(filePath: string): Promise<number> {
		// REGRESSION: deleteByFile silently no-opped when the table had not been
		// lazily opened. The guard used to be `if (!this.db || !this.table)`,
		// testing the raw field — but the table is opened lazily, and every read
		// path (`getChunksWithVectors`, `getStats`, `search`) goes through
		// `ensureTableOpen()` instead. A delete issued before any read on the
		// instance returned 0, which is indistinguishable from "nothing to
		// delete", so stale chunks survived a delete that reported success.
		// `ensureTableOpen()` returns null only when the table does not exist on
		// disk — the one genuinely-safe no-op — and throws if opening fails, so
		// the whole thing stays inside the existing catch: deletes must never
		// throw where they previously returned 0.
		//
		// BEHAVIOUR CHANGE, deliberate: a delete on a store that has not been
		// connected yet now runs `initialize()` (via `ensureTableOpen()`), where
		// before it returned 0 without touching the disk. That only connects —
		// `ensureTableOpen()` lists `tableNames()` and calls `openTable()` on a
		// hit, and has no create path (see it above), so no empty table is
		// materialized by a delete against a store that was never indexed.
		//
		// The value is escaped, not interpolated raw: a single quote is legal in
		// a path on macOS and Linux (`src/o'brien.ts`) and ends the string
		// literal early, which LanceDB rejects — and the catch below would turn
		// that into a silent 0, the same "delete reported success but did
		// nothing" failure this method was just fixed for.
		try {
			const table = await this.ensureTableOpen();
			if (!table) {
				return 0;
			}
			const storedPath = this.storedPathArg(filePath);
			if (storedPath === null) {
				return 0;
			}

			// The REAL count. LanceDB 0.38 returns `DeleteResult { numDeletedRows,
			// version }`; this returned a hardcoded 1 under the stale comment "LanceDB
			// doesn't return count", so a delete that matched zero rows (the
			// ghost-chunk defect: a relative path against absolute stored paths)
			// reported success and its caller could not tell.
			const { numDeletedRows } = await table.delete(
				`filePath = '${escapeSqlLiteral(storedPath)}'`,
			);
			return numDeletedRows;
		} catch {
			return 0;
		}
	}

	/**
	 * Delete chunks by file hash
	 */
	async deleteByFileHash(fileHash: string): Promise<number> {
		// Same lazy-open bug, same deliberate connect-on-delete behaviour change,
		// and same literal escaping as deleteByFile above; see the notes there.
		try {
			const table = await this.ensureTableOpen();
			if (!table) {
				return 0;
			}

			await table.delete(`fileHash = '${escapeSqlLiteral(fileHash)}'`);
			// Still a constant, unlike deleteByFile: this member has no caller in
			// src/ and is retired with its tests in Phase 3b (architecture §3.5).
			return 1;
		} catch {
			return 0;
		}
	}

	/**
	 * Get all code chunks for a file with their vectors (for incremental diffing)
	 * Returns chunks with contentHash and vector for reuse during smart reindexing
	 */
	async getChunksWithVectors(filePath: string): Promise<ChunkWithEmbedding[]> {
		const table = await this.ensureTableOpen();
		if (!table) {
			return [];
		}
		const storedPath = this.storedPathArg(filePath);
		if (storedPath === null) {
			return [];
		}

		try {
			// Equality, so `escapeSqlLiteral`. This used the LIKE escaper, which
			// backslash-escapes `%` and `_`; in an equality literal DataFusion
			// takes the backslash literally, so every file with an underscore in
			// its name returned zero chunks. The caller (indexer.ts) reads that
			// as "no previous vectors to reuse" and re-embeds the whole file on
			// every incremental reindex — silent, and paid for on each run.
			const results = await table
				.query()
				.where(
					`filePath = '${escapeSqlLiteral(storedPath)}' AND documentType = 'code_chunk'`,
				)
				.toArray();

			return results.map((row) => ({
				id: row.id,
				contentHash: row.contentHash || "",
				content: row.content,
				filePath: this.outputPath(row),
				startLine: row.startLine,
				endLine: row.endLine,
				language: row.language,
				chunkType: row.chunkType as any,
				name: row.name || undefined,
				parentName: row.parentName || undefined,
				signature: row.signature || undefined,
				fileHash: row.fileHash,
				// Normalised, not passed through: the caller
				// (indexer.ts, `reuseFromLance`) hands this straight back to
				// `addChunks`, and an Arrow `Vector` there fails the whole batch
				// with "Found field not in schema: vector.isValid" — the exit-1
				// on any incremental re-index of a modified file whose embedding
				// cache is degraded. See `toPlainVector`.
				vector: toPlainVector(row.vector),
			}));
		} catch {
			return [];
		}
	}

	// ========================================================================
	// Membership by id — the LanceDB half of the id algebra (§4.1).
	//
	// Every predicate here is §3.7 row 2: `id IN (…)` over ids THIS CODEBASE
	// generated, rendered by `hexIdList`, which asserts the alphabet per id and
	// therefore applies no escaper. Nothing here takes user path text.
	// ========================================================================

	/**
	 * P1's belt (§4.1.1): which of `ids` have a LIVE row right now.
	 *
	 * A PROJECTION, never `countRows`. A count says how many of 256 ids are
	 * missing and never WHICH, and both ways to act on a short count are wrong:
	 * demote the batch and 255 live rows are appended a second time; widen them
	 * all and the missing one stays invisible. The caller demotes exactly the
	 * ids this did not return, from WIDEN to INSERT.
	 */
	async existingIds(ids: string[]): Promise<Set<string>> {
		const present = new Set<string>();
		if (ids.length === 0) return present;
		const table = await this.ensureTableOpen();
		if (!table) return present;
		for (const batch of chunkIds(ids)) {
			const rows = await table
				.query()
				.where(hexIdList(batch))
				.select(["id"])
				.toArray();
			for (const row of rows) present.add(row.id as string);
		}
		return present;
	}

	/**
	 * The widening drain's SOURCE (§4.1.3b): every column of the rows behind
	 * `ids`, as plain JS values LanceDB will accept back.
	 *
	 * `vector` goes through `toPlainVector` here and nowhere later: writing back
	 * a raw Arrow `Vector` fails the whole batch with `Found field not in
	 * schema: vector.isValid` and writes nothing (measured, I-7 FINAL). Columns
	 * are taken from the DECLARED schema rather than from the row's own keys, so
	 * a column added to `codeChunksSchema` later cannot be silently dropped by
	 * the round trip.
	 *
	 * It returns one entry per ROW, not per id: a crash duplicate gives two, and
	 * the caller's M2 is what notices.
	 */
	async rowsForWidening(ids: string[]): Promise<WidenSourceRow[]> {
		if (ids.length === 0) return [];
		const table = await this.ensureTableOpen();
		if (!table) return [];
		const columns = storedChunkColumns();
		const out: WidenSourceRow[] = [];
		for (const batch of chunkIds(ids)) {
			const rows = await table.query().where(hexIdList(batch)).toArray();
			for (const row of rows) {
				const copy: Record<string, unknown> = {};
				for (const column of columns) {
					copy[column] =
						column === "vector" ? toPlainVector(row.vector) : row[column];
				}
				out.push(copy as WidenSourceRow);
			}
		}
		return out;
	}

	/**
	 * Rewrite the `branchIds` mirror of `rows`, through UPDATE-ONLY
	 * `mergeInsert` (decision I-7 FINAL). Returns `numUpdatedRows`.
	 *
	 * Named for what it does, not for one of its two callers: the widening drain
	 * (§4.1.3b) and `narrowIds`' survivor step (§4.1.1 M3) both RECOMPUTE the
	 * mirror from `chunk_branches` and write the result, and §4.1.3a makes that
	 * one rule for both directions. The design writes the narrow half as a
	 * grouped `table.update`; that mechanism is what I-7 FINAL rejected, and
	 * the cliff it rejected it for — one call, one version and one fragment per
	 * distinct membership — is reached by exactly the same input here.
	 *
	 * `whenMatchedUpdateAll` with NO insert clause, which is what makes P1 hold
	 * forwards: measured over 153 cases x 5 repetitions on LanceDB 0.38, an id
	 * absent from the table, two absent ids, a duplicated absent id and a target
	 * deleted just before the merge all insert NOTHING. It also never changes
	 * how many rows an id has — a crash duplicate is carried, neither multiplied
	 * nor collapsed.
	 *
	 * THE CONDITION is `target.branchIds <> source.branchIds`. The value written
	 * is recomputed from `chunk_branches` either way (U3), so this only skips
	 * the WRITE where the mirror is already exact — it never patches. Measured:
	 * a redo of a half-applied 256-id batch rewrites 128 rows instead of 256,
	 * which halves both write amplification and the FTS tail the drain's
	 * `optimize()` then has to fold back in.
	 *
	 * THE CALLER MUST DEDUPLICATE `rows` BY ID (M1). Two source rows for one id
	 * throw `Ambiguous merge inserts are prohibited` and write nothing — and
	 * they would throw identically on every retry, so a single crash duplicate
	 * would livelock the backlog.
	 */
	async writeBranchIdsMirror(rows: WidenSourceRow[]): Promise<number> {
		if (rows.length === 0) return 0;
		const table = await this.ensureTableOpen();
		if (!table) return 0;
		const result = await withTimeout(
			table
				.mergeInsert("id")
				.whenMatchedUpdateAll({
					where: "target.branchIds <> source.branchIds",
				})
				.execute(rows as Array<Record<string, unknown>>),
			LANCEDB_WRITE_TIMEOUT_MS,
			"writeBranchIdsMirror:mergeInsert",
		);
		return result.numUpdatedRows;
	}

	/**
	 * Replace the CONTENT of code-unit rows that already exist, in place.
	 *
	 * ── WHY THIS EXISTS, AND WHAT IT WORKS AROUND ─────────────────────────────
	 * §4.1.1 justifies widening on the id alone by asserting that "chunk ids are
	 * content+position addressed". A CODE UNIT's is not: it is
	 * `sha256(filePath:unitType:name:startRow)` (`code-unit-extractor.ts`), with
	 * no content in it. Measured — editing a function body without moving its
	 * first line leaves the id at `edc328f7f7d95751` while the body differs. So
	 * two revisions of one function, on one branch or on two, CANNOT have
	 * distinct rows: they collide on the id.
	 *
	 * Given that, the only outcomes available are a stale row, a duplicate id,
	 * or one row holding the latest content. This writes the last one: an
	 * UPDATE-ONLY `mergeInsert` over the whole row, atomic, never inserting, and
	 * leaving the id with exactly the number of rows it already had. `branchIds`
	 * is the caller's RECOMPUTED mirror per row, so a row several branches hold
	 * does not lose them.
	 *
	 * THE WART IS REAL AND IS REPORTED, not papered over: the branch that
	 * indexed LAST decides the body every branch sees for that unit. The durable
	 * fix is to put the content into the unit id, which is a stored-id change
	 * and therefore a version bump.
	 */
	async refreshCodeUnits(
		units: CodeUnitWithEmbedding[],
		mirrorById: ReadonlyMap<string, string>,
		pathKind: PathKind,
	): Promise<number> {
		if (units.length === 0) return 0;
		const table = await this.ensureTableOpen();
		if (!table) return 0;
		const rows = storedRowsForUnits(units, mirrorById, pathKind);
		const result = await withTimeout(
			table
				.mergeInsert("id")
				.whenMatchedUpdateAll()
				.execute(rows as unknown as Array<Record<string, unknown>>),
			LANCEDB_WRITE_TIMEOUT_MS,
			"refreshCodeUnits:mergeInsert",
		);
		return result.numUpdatedRows;
	}

	/**
	 * W1's LanceDB half, by id: the orphan delete of `narrowIds` and recovery's
	 * add-undo (§4.1.1 M3, §4.1.4). Returns the real `numDeletedRows`.
	 *
	 * Deleting ids that are not there is a no-op (`numDeletedRows` 0), which is
	 * what makes both callers idempotent under a repeated crash.
	 */
	async deleteByIds(ids: string[]): Promise<number> {
		if (ids.length === 0) return 0;
		const table = await this.ensureTableOpen();
		if (!table) return 0;
		let deleted = 0;
		for (const batch of chunkIds(ids)) {
			const result = await withTimeout(
				table.delete(hexIdList(batch)),
				LANCEDB_WRITE_TIMEOUT_MS,
				"deleteByIds:table.delete",
			);
			deleted += result.numDeletedRows;
		}
		return deleted;
	}

	/**
	 * M5 (I-7 FINAL): ONE `optimize()` at the end of the widening drain.
	 *
	 * Every row a merge rewrites leaves the FTS index — measured, 19 026 of
	 * 20 000 after a second worktree's first run. Recall is NOT lost
	 * (`fullTextSearch` scans the unindexed tail and returned 982/982), so this
	 * is a latency and a SCORING step, not a correctness one: filtered FTS goes
	 * from 0.7 ms to 60-72 ms, and rewritten rows' BM25 scores shift by up to
	 * 5 %. Fusion is rank-only, so a 5 % shift can reorder results. `optimize()`
	 * folds the tail back in, restores scores exactly, and compacts to two
	 * fragments; 180-580 ms at 20 000 rows.
	 *
	 * Never per batch: the cost is in the fold, not in the number of rows.
	 */
	async optimize(): Promise<void> {
		const table = await this.ensureTableOpen();
		if (!table) return;
		await withTimeout(
			table.optimize(),
			LANCEDB_WRITE_TIMEOUT_MS,
			"optimize:table.optimize",
		);
	}

	/**
	 * The highest branch id any ROW of this store carries, or null (3a-2's
	 * finding 4; C1 mechanism 2 in `branch-registry.ts`).
	 *
	 * Read from the rows themselves, not from SQLite. The residue finding 4
	 * describes needs `branches.json` to have lost an allocation the rows still
	 * carry; `index.db` covers that through `chunk_branches` and the journal,
	 * but a store whose `index.db` was replaced or hand-deleted has no such
	 * record, and the registry would then re-issue an id that live rows already
	 * use. One projection of one small Utf8 column, once per index run.
	 */
	async highestBranchId(): Promise<number | null> {
		let rows: Array<Record<string, unknown>>;
		try {
			const table = await this.ensureTableOpen();
			if (!table) return null;
			rows = await table.query().select([BRANCH_IDS_COLUMN]).toArray();
		} catch {
			// `null`, not a throw. This runs BEFORE the corruption and upgrade
			// branches, so the table it is asked about may be the 0-dimension one
			// `ensureTableOpen` refuses (CLAUDE.md #15) or a pre-v4 one with no
			// `branchIds` column at all. Both are about to be rebuilt, so no row
			// that could carry an id survives to collide with one — and refusing
			// to open the run over it would make the repair path unreachable.
			return null;
		}
		let highest: number | null = null;
		for (const row of rows) {
			for (const id of decodeBranchIdCell(row[BRANCH_IDS_COLUMN])) {
				if (highest === null || id > highest) highest = id;
			}
		}
		return highest;
	}

	/**
	 * TIER 2's vectors (§4.1.2): the stored vector for each of `ids`.
	 *
	 * The embedding is a function of the chunk TEXT alone, so a row holding the
	 * same content at the same path can lend its vector to a new row with a new
	 * id and a new line range: zero embedding requests, one new row. This is
	 * `oldChunksCache` lifted off `documentType = 'code_chunk'`, which is why
	 * code units — whose stored `contentHash` is empty — could never reuse
	 * anything before.
	 */
	async getVectorsByIds(ids: string[]): Promise<Map<string, number[]>> {
		const byId = new Map<string, number[]>();
		if (ids.length === 0) return byId;
		const table = await this.ensureTableOpen();
		if (!table) return byId;
		for (const batch of chunkIds(ids)) {
			const rows = await table
				.query()
				.where(hexIdList(batch))
				.select(["id", "vector"])
				.toArray();
			for (const row of rows) {
				const vector = toPlainVector(row.vector);
				// `> 1` excludes the BM25-mode placeholder `[0]`, exactly as the
				// same-branch reuse path does. A placeholder lent to a new row
				// would silently make it unsearchable by vector.
				if (vector.length > 1) byId.set(row.id as string, vector);
			}
		}
		return byId;
	}

	/**
	 * Delete all chunks
	 */
	async clear(): Promise<void> {
		if (!this.db) {
			return;
		}

		// Drop and recreate the table
		const tables = await this.db.tableNames();
		if (tables.includes(CHUNKS_TABLE)) {
			await this.db.dropTable(CHUNKS_TABLE);
		}
		this.table = null;
	}

	/**
	 * Get chunk contents for benchmarking
	 */
	async getChunkContents(limit?: number): Promise<string[]> {
		const table = await this.ensureTableOpen();
		if (!table) {
			return [];
		}

		try {
			let query = table.query();
			if (limit) {
				query = query.limit(limit);
			}
			const allData = await query.toArray();
			return allData.map((row) => row.content as string);
		} catch {
			return [];
		}
	}

	/**
	 * Get statistics about the store
	 */
	async getStats(): Promise<{
		totalChunks: number;
		uniqueFiles: number;
		languages: string[];
	}> {
		// Ensure table is opened before querying
		const table = await this.ensureTableOpen();
		if (!table) {
			return { totalChunks: 0, uniqueFiles: 0, languages: [] };
		}

		try {
			const allData = await table.query().toArray();

			const files = new Set<string>();
			const languages = new Set<string>();

			for (const row of allData) {
				files.add(row.filePath);
				languages.add(row.language);
			}

			return {
				totalChunks: allData.length,
				uniqueFiles: files.size,
				languages: Array.from(languages),
			};
		} catch {
			return { totalChunks: 0, uniqueFiles: 0, languages: [] };
		}
	}

	// ========================================================================
	// Enriched Document Methods
	// ========================================================================

	/**
	 * Add enriched documents with embeddings to the store
	 */
	async addDocuments(
		documents: DocumentWithEmbedding[],
		membership: RowMembership,
	): Promise<void> {
		// Checked before the empty-batch return, so a caller that forgot the
		// membership fails on its first call, not on its first non-empty one.
		const columns = membershipColumns(
			membership,
			documents.map((doc) => doc.filePath || ""),
			"addDocuments",
		);
		if (documents.length === 0) {
			return;
		}

		const now = new Date().toISOString();
		const data: StoredChunk[] = documents.map((doc) => ({
			id: doc.id,
			contentHash: "", // Enriched documents don't use contentHash (not for diffing)
			content: doc.content,
			filePath: doc.filePath || "",
			startLine: 0,
			endLine: 0,
			language: "",
			chunkType: "",
			name: "",
			parentName: "",
			signature: "",
			fileHash: doc.fileHash || "",
			vector: doc.vector,
			// Index v3. Always "" here: enrichment summaries are embedded with
			// the RAW client, deliberately outside the caching seam (LLM output
			// is non-deterministic for identical input, so such entries could
			// never hit), so there is no key to record. The column is still
			// written, because this method can be the one that CREATES the
			// table and the Arrow schema is inferred from whichever batch does.
			embedKey: "",
			// Enriched document fields
			documentType: doc.documentType,
			sourceIds: JSON.stringify(doc.sourceIds || []),
			metadata: JSON.stringify(doc.metadata || {}),
			createdAt: doc.createdAt || now,
			enrichedAt: doc.enrichedAt || now,
			// Hierarchical fields (defaults for enriched documents)
			parentId: "",
			unitType: "",
			depth: -1,
			summary: "",
			branchIds: columns.branchIds,
			pathKind: columns.pathKind,
		}));

		// Try to open existing table
		let table = await this.ensureTableOpen();

		// Check for dimension mismatch with existing table
		const incomingDimension = assertVectorDimension(
			data[0].vector.length,
			"addDocuments",
		);
		if (
			table &&
			this.tableDimension &&
			this.tableDimension !== incomingDimension
		) {
			console.warn(
				`⚠️  Vector dimension mismatch: table has ${this.tableDimension}d, new embeddings are ${incomingDimension}d`,
			);
			console.warn(
				"   Clearing existing vectors to match new embedding model...\n",
			);
			await this.clear();
			table = null;
			this.tableDimension = null;
			this._dimensionMismatchCleared = true;
		}

		if (table) {
			await withTimeout(
				table.add(data),
				LANCEDB_WRITE_TIMEOUT_MS,
				"addDocuments:table.add",
			);
		} else {
			if (!this.db) {
				await this.initialize();
			}
			this.table = await withTimeout(
				this.db!.createTable(CHUNKS_TABLE, data, {
					mode: "create",
					// DECLARED, not inferred: see `codeChunksSchema`.
					schema: codeChunksSchema(incomingDimension),
				}),
				LANCEDB_WRITE_TIMEOUT_MS,
				"addDocuments:createTable",
			);
			this.tableDimension = incomingDimension;
		}

		if (data.length > 0 && !this.dimension) {
			this.dimension = data[0].vector.length;
		}
	}

	/**
	 * Delete all documents of a specific type
	 */
	async deleteByDocumentType(documentType: DocumentType): Promise<number> {
		// Same lazy-open bug, same deliberate connect-on-delete behaviour change
		// as deleteByFile above; see the notes there.
		//
		// `documentType` is interpolated RAW and must stay that way. It is the
		// closed `DocumentType` union (`code_chunk`, `file_summary`,
		// `session_observation`, ...), so no member carries a quote and there is
		// nothing for `escapeSqlLiteral` to do. Applying the LIKE escaper
		// (`escapeFilterValue`) here would actively BREAK it: nearly every member
		// contains an underscore, which that escaper backslash-escapes, and in an
		// equality literal DataFusion takes the backslash literally — so the
		// predicate would match no row and the delete would silently no-op.
		try {
			const table = await this.ensureTableOpen();
			if (!table) {
				return 0;
			}

			await table.delete(`documentType = '${documentType}'`);
			return 1;
		} catch {
			return 0;
		}
	}

	/**
	 * Delete all documents (code chunks and enriched) for a specific file
	 */
	async deleteAllByFile(filePath: string): Promise<number> {
		// Same lazy-open bug, same deliberate connect-on-delete behaviour change
		// as deleteByFile above; see the notes there.
		try {
			const table = await this.ensureTableOpen();
			if (!table) {
				return 0;
			}
			const storedPath = this.storedPathArg(filePath);
			if (storedPath === null) {
				return 0;
			}

			// The value was interpolated raw. That is data loss, not a syntax
			// hazard: `x' OR filePath LIKE '%` renders the well-formed predicate
			// `filePath = 'x' OR filePath LIKE '%'`, which matches every row —
			// so a delete aimed at one file empties the table. Equality, so the
			// escape is quote doubling only (`escapeSqlLiteral`); the LIKE
			// escaper would break ordinary `my_file.ts` paths instead.
			await table.delete(`filePath = '${escapeSqlLiteral(storedPath)}'`);
			return 1;
		} catch {
			return 0;
		}
	}

	/**
	 * Get all documents for a specific file
	 */
	async getDocumentsByFile(
		scope: BranchScope,
		filePath: string,
		documentTypes?: DocumentType[],
	): Promise<BaseDocument[]> {
		const table = await this.ensureTableOpen();
		if (!table) {
			return [];
		}
		const storedPath = this.storedPathArg(filePath);
		if (storedPath === null) {
			return [];
		}

		try {
			// Same raw interpolation as `deleteAllByFile` had: a quote in the
			// path made LanceDB reject the statement (caught below, reported as
			// "no documents"), and a crafted path widened the predicate to every
			// row. Equality, so quote doubling only.
			let filter = `filePath = '${escapeSqlLiteral(storedPath)}'`;
			const branchFilter = branchMembershipFilter(scope);
			if (branchFilter !== null) filter += ` AND ${branchFilter}`;
			if (documentTypes && documentTypes.length > 0) {
				// `documentTypes` is the closed `DocumentType` union — no quotes
				// to escape, and no `%`/`_` handling wanted either, since IN
				// compares by equality.
				const types = documentTypes.map((t) => `'${t}'`).join(", ");
				filter += ` AND documentType IN (${types})`;
			}

			const results = await table.query().where(filter).toArray();

			return results.map((row) => ({
				id: row.id,
				content: row.content,
				documentType: row.documentType as DocumentType,
				filePath: row.filePath ? this.outputPath(row) : undefined,
				fileHash: row.fileHash || undefined,
				createdAt: row.createdAt,
				enrichedAt: row.enrichedAt || undefined,
				sourceIds: row.sourceIds ? JSON.parse(row.sourceIds) : undefined,
				metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
			}));
		} catch {
			return [];
		}
	}

	/**
	 * Search with document type filtering and use-case weights
	 */
	async searchDocuments(
		queryText: string,
		queryVector: number[],
		scope: BranchScope,
		options: EnrichedSearchOptions = {},
	): Promise<EnrichedSearchResult[]> {
		const {
			limit = DEFAULT_LIMIT,
			language,
			pathPattern,
			documentTypes,
			typeWeights,
			useCase,
			includeCodeChunks = true,
		} = options;

		const table = await this.ensureTableOpen();
		if (!table) {
			return [];
		}

		// Build filter string with escaped values to prevent injection.
		// Equality takes `escapeSqlLiteral`, LIKE takes `escapeFilterValue`.
		const filters: string[] = [];
		// D6, part 1: PRE-filter, both retrievers. See `search`.
		const branchFilter = branchMembershipFilter(scope);
		if (branchFilter !== null) filters.push(branchFilter);
		if (language) {
			filters.push(`language = '${escapeSqlLiteral(language)}'`);
		}
		if (pathPattern) {
			filters.push(
				`filePath LIKE '%${escapeFilterValue(this.likePatternArg(pathPattern))}%'`,
			);
		}

		// Filter by document types (these are enum values, but escape anyway for safety)
		const effectiveTypes =
			documentTypes ||
			(includeCodeChunks
				? undefined // No filter = all types
				: [
						"file_summary",
						"symbol_summary",
						"idiom",
						"usage_example",
						"anti_pattern",
						"project_doc",
					]);

		if (effectiveTypes && effectiveTypes.length > 0) {
			// IN compares by equality, so this needs `escapeSqlLiteral`. With the
			// LIKE escaper it was not merely redundant, it was broken: every
			// `DocumentType` but `idiom` contains an underscore, so the rendered
			// `documentType IN ('file\_summary', 'symbol\_summary', ...)` matched
			// NO row and every type-filtered enriched search came back empty.
			const types = effectiveTypes
				.map((t) => `'${escapeSqlLiteral(t)}'`)
				.join(", ");
			filters.push(`documentType IN (${types})`);
		}

		const filterStr = filters.length > 0 ? filters.join(" AND ") : undefined;

		// Vector search
		let vectorQuery = table.vectorSearch(queryVector).limit(limit * 3);
		if (filterStr) {
			vectorQuery = vectorQuery.where(filterStr);
		}
		const vectorResults = await vectorQuery.toArray();

		// BM25 full-text search
		await this.ensureFtsIndex();
		let bm25Results: any[] = [];
		try {
			let ftsQuery = table
				.query()
				.fullTextSearch(queryText, { columns: ["content"] })
				.limit(limit * 3);
			if (filterStr) {
				ftsQuery = ftsQuery.where(filterStr);
			}
			bm25Results = await ftsQuery.toArray();
		} catch {
			bm25Results = [];
		}

		// Get weights for the use case
		const weights = typeWeights || getUseCaseWeights(useCase);

		// Type-aware RRF fusion with test file handling
		const testFileMode = getTestFileMode(this.pathRoot);
		const results = typeAwareRRFFusion(
			vectorResults,
			bm25Results,
			VECTOR_WEIGHT,
			BM25_WEIGHT,
			weights,
			this.testFileDetector,
			testFileMode,
		);

		// Convert to EnrichedSearchResult format
		const topResults = results.slice(0, limit);
		const maxFused = topResults.length > 0 ? topResults[0].fusedScore : 1;
		return topResults.map((r) => ({
			document: {
				id: r.id,
				content: r.content,
				documentType: r.documentType as DocumentType,
				filePath: r.filePath ? this.outputPath(r) : undefined,
				fileHash: r.fileHash || undefined,
				createdAt: r.createdAt,
				enrichedAt: r.enrichedAt || undefined,
				sourceIds: r.sourceIds ? JSON.parse(r.sourceIds) : undefined,
				metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
			},
			score: maxFused > 0 ? r.fusedScore / maxFused : 0,
			vectorScore: r.vectorScore || 0,
			keywordScore: r.keywordScore || 0,
			documentType: r.documentType as DocumentType,
		}));
	}

	/**
	 * Get document type statistics
	 */
	async getDocumentTypeStats(): Promise<Record<DocumentType, number>> {
		const table = await this.ensureTableOpen();
		if (!table) {
			return {} as Record<DocumentType, number>;
		}

		try {
			const allData = await table.query().toArray();

			const counts: Record<string, number> = {};
			for (const row of allData) {
				const docType = row.documentType || "code_chunk";
				counts[docType] = (counts[docType] || 0) + 1;
			}

			return counts as Record<DocumentType, number>;
		} catch {
			return {} as Record<DocumentType, number>;
		}
	}

	/**
	 * Close the database connection
	 */
	async close(): Promise<void> {
		// LanceDB connections are auto-managed
		this.db = null;
		this.table = null;
	}

	// ========================================================================
	// Code Unit Methods (Hierarchical Model)
	// ========================================================================

	/**
	 * Add code units with embeddings to the store
	 */
	async addCodeUnits(
		units: CodeUnitWithEmbedding[],
		membership: RowMembership,
	): Promise<void> {
		// Checked before the empty-batch return, so a caller that forgot the
		// membership fails on its first call, not on its first non-empty one.
		const columns = membershipColumns(
			membership,
			units.map((unit) => unit.filePath),
			"addCodeUnits",
		);
		if (units.length === 0) {
			return;
		}

		const data = storedRowsForUnits(units, columns.branchIds, columns.pathKind);

		let table = await this.ensureTableOpen();

		// Check for dimension mismatch
		const incomingDimension = assertVectorDimension(
			data[0].vector.length,
			"addCodeUnits",
		);
		if (
			table &&
			this.tableDimension &&
			this.tableDimension !== incomingDimension
		) {
			console.warn(
				`⚠️  Vector dimension mismatch: table has ${this.tableDimension}d, new embeddings are ${incomingDimension}d`,
			);
			console.warn(
				"   Clearing existing vectors to match new embedding model...\n",
			);
			await this.clear();
			table = null;
			this.tableDimension = null;
			this._dimensionMismatchCleared = true;
		}

		if (table) {
			await withTimeout(
				table.add(data),
				LANCEDB_WRITE_TIMEOUT_MS,
				"addCodeUnits:table.add",
			);
		} else {
			if (!this.db) {
				await this.initialize();
			}
			this.table = await withTimeout(
				this.db!.createTable(CHUNKS_TABLE, data, {
					mode: "create",
					// DECLARED, not inferred: see `codeChunksSchema`.
					schema: codeChunksSchema(incomingDimension),
				}),
				LANCEDB_WRITE_TIMEOUT_MS,
				"addCodeUnits:createTable",
			);
			this.tableDimension = incomingDimension;
		}

		if (data.length > 0 && !this.dimension) {
			this.dimension = data[0].vector.length;
		}
	}

	/**
	 * Read one row by id, as an object LanceDB will accept back.
	 *
	 * `vector` is normalised here and nowhere later: an Arrow `Vector` handed
	 * back to `table.add` is rejected for the whole batch (see
	 * `toPlainVector`), and this is the only read whose result is written back.
	 */
	private async readRowForUpdate(
		table: lancedb.Table,
		id: string,
	): Promise<StoredChunk | null> {
		// Equality predicate: quote doubling only (CLAUDE.md #22).
		const results = await table
			.query()
			.where(`id = '${escapeSqlLiteral(id)}'`)
			.toArray();
		if (results.length === 0) return null;

		const existing = results[0] as StoredChunk;
		return { ...existing, vector: toPlainVector(existing.vector) };
	}

	/**
	 * Put back the row an update deleted, and build the error that says whether
	 * it worked.
	 *
	 * WHY RESTORE-ON-FAILURE AND NOT ADD-BEFORE-DELETE. The delete's predicate
	 * is `id = '...'` and both copies carry the same id, so an add-first order
	 * would need the delete to distinguish two rows that differ only in the
	 * field being updated — and until it ran, every reader matching on id
	 * (`getCodeUnit`, `getChunksWithVectors`, search de-duplication) would see
	 * two rows and pick one arbitrarily. Restoring keeps the one-row-per-id
	 * invariant at all times; its only window is one where the row is briefly
	 * ABSENT, which every reader already handles as a miss.
	 *
	 * The delete is re-issued before the restore because `withTimeout` cannot
	 * cancel a native write (see `withTimeout`): a timed-out add may still land,
	 * and re-deleting first makes the restore converge on exactly one row — the
	 * original — instead of leaving a duplicate id behind. An add that lands
	 * after the restore is the one case left uncovered, and it cannot be closed
	 * without cancellation.
	 */
	private async restoreAfterFailedUpdate(
		table: lancedb.Table,
		operation: string,
		rowId: string,
		original: StoredChunk,
		cause: unknown,
	): Promise<VectorStoreUpdateError> {
		try {
			await table.delete(`id = '${escapeSqlLiteral(rowId)}'`);
			await withTimeout(
				table.add([original]),
				LANCEDB_WRITE_TIMEOUT_MS,
				`${operation}:restore`,
			);
			return new VectorStoreUpdateError(operation, rowId, true, cause);
		} catch (restoreError) {
			return new VectorStoreUpdateError(
				operation,
				rowId,
				false,
				cause,
				restoreError,
			);
		}
	}

	/**
	 * Update summary for a code unit (used during bottom-up summarization).
	 *
	 * A no-op when there is no such unit. THROWS `VectorStoreUpdateError` when
	 * the write fails — the failure used to be swallowed with `console.warn`
	 * while the deleted row stayed deleted, so callers were told an update had
	 * succeeded that had in fact destroyed a row.
	 */
	async updateUnitSummary(unitId: string, summary: string): Promise<void> {
		const table = await this.ensureTableOpen();
		if (!table) return;

		const existing = await this.readRowForUpdate(table, unitId);
		if (!existing) return;

		// Before the delete, never after it: a row whose vector cannot be
		// written back must not be destroyed for nothing (CLAUDE.md #15).
		assertVectorDimension(existing.vector.length, "updateUnitSummary");

		// `embedKey` (index v3) is INHERITED here on purpose: this round-trips a
		// row read back from the table and replaces only `summary`, leaving
		// `vector` exactly as it was, so the key still addresses this row's
		// vector. Because the row came from the table, this site can neither
		// introduce the column nor create the table, and so cannot define the
		// schema.
		const updated: StoredChunk = { ...existing, summary };

		// LanceDB has no upsert, so this is delete + add, and the two are not
		// atomic. Everything that can fail without destroying anything has
		// already run.
		await table.delete(`id = '${escapeSqlLiteral(unitId)}'`);

		try {
			// Watchdog-wrapped: same native write path as every other add.
			await withTimeout(
				table.add([updated]),
				LANCEDB_WRITE_TIMEOUT_MS,
				"updateUnitSummary:table.add",
			);
		} catch (error) {
			throw await this.restoreAfterFailedUpdate(
				table,
				"updateUnitSummary",
				unitId,
				existing,
				error,
			);
		}
	}

	/**
	 * Update document content and re-embed (used for summary refinement).
	 *
	 * Returns `false` for exactly one thing — there is no such document — and
	 * THROWS `VectorStoreUpdateError` when the write fails. Both used to return
	 * `false`, which is why the one caller could not act on either.
	 */
	async updateDocumentContent(
		documentId: string,
		newContent: string,
		newVector: number[],
	): Promise<boolean> {
		const table = await this.ensureTableOpen();
		if (!table) return false;

		const existing = await this.readRowForUpdate(table, documentId);
		if (!existing) return false;

		// Both vectors are checked before the delete: the incoming one because
		// an empty embedding must never reach a write (CLAUDE.md #15), and the
		// stored one because it is the restore copy.
		assertVectorDimension(newVector.length, "updateDocumentContent");
		assertVectorDimension(existing.vector.length, "updateDocumentContent");

		// `embedKey` (index v3) is RESET, not inherited. This replaces both
		// `content` and `vector`, so carrying `existing.embedKey` forward would
		// leave a key describing a vector that no longer exists — breaking the
		// one invariant the column has ("when non-empty, the key addresses the
		// vector beside it") and making any hit-rate audit read from it wrong.
		// Harmless today, because documents are written with `embedKey: ""` in
		// the first place; wrong the moment document embeds come inside the
		// caching seam.
		const updated: StoredChunk = {
			...existing,
			content: newContent,
			vector: newVector,
			embedKey: "",
			enrichedAt: new Date().toISOString(),
		};

		await table.delete(`id = '${escapeSqlLiteral(documentId)}'`);

		try {
			await withTimeout(
				table.add([updated]),
				LANCEDB_WRITE_TIMEOUT_MS,
				"updateDocumentContent:table.add",
			);
		} catch (error) {
			throw await this.restoreAfterFailedUpdate(
				table,
				"updateDocumentContent",
				documentId,
				existing,
				error,
			);
		}

		return true;
	}

	/**
	 * Get all summary documents (file_summary and symbol_summary) for refinement
	 */
	async getAllSummaries(): Promise<Array<BaseDocument & { vector: number[] }>> {
		const table = await this.ensureTableOpen();
		if (!table) return [];

		try {
			const filter = "documentType IN ('file_summary', 'symbol_summary')";
			const results = await table.query().where(filter).toArray();

			return results.map((row) => ({
				id: row.id,
				content: row.content,
				documentType: row.documentType as DocumentType,
				filePath: row.filePath ? this.outputPath(row) : undefined,
				fileHash: row.fileHash || undefined,
				createdAt: row.createdAt,
				enrichedAt: row.enrichedAt || undefined,
				sourceIds: row.sourceIds ? JSON.parse(row.sourceIds) : undefined,
				metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
				// Declared `number[]`; Arrow hands back a `Vector`. Normalised
				// so the declared type is the true one — see `toPlainVector`.
				vector: toPlainVector(row.vector),
			}));
		} catch {
			return [];
		}
	}

	/**
	 * Get code units for a file, optionally filtered by unit type
	 */
	async getCodeUnitsByFile(
		scope: BranchScope,
		filePath: string,
		unitTypes?: UnitType[],
	): Promise<CodeUnit[]> {
		const table = await this.ensureTableOpen();
		if (!table) return [];
		const storedPath = this.storedPathArg(filePath);
		if (storedPath === null) {
			return [];
		}

		try {
			let filter = `filePath = '${escapeSqlLiteral(storedPath)}' AND documentType = 'code_unit'`;
			const branchFilter = branchMembershipFilter(scope);
			if (branchFilter !== null) filter += ` AND ${branchFilter}`;
			if (unitTypes && unitTypes.length > 0) {
				// IN compares by equality, so this takes `escapeSqlLiteral`.
				const types = unitTypes
					.map((t) => `'${escapeSqlLiteral(t)}'`)
					.join(", ");
				filter += ` AND unitType IN (${types})`;
			}

			const results = await table.query().where(filter).toArray();

			return results.map((row) => this.rowToCodeUnit(row));
		} catch {
			return [];
		}
	}

	/**
	 * Get code units by depth level (for bottom-up processing)
	 */
	async getCodeUnitsByDepth(
		scope: BranchScope,
		depth: number,
		filePath?: string,
	): Promise<CodeUnit[]> {
		const table = await this.ensureTableOpen();
		if (!table) return [];

		try {
			let filter = `depth = ${depth} AND documentType = 'code_unit'`;
			const branchFilter = branchMembershipFilter(scope);
			if (branchFilter !== null) filter += ` AND ${branchFilter}`;
			if (filePath) {
				const storedPath = this.storedPathArg(filePath);
				if (storedPath === null) return [];
				filter += ` AND filePath = '${escapeSqlLiteral(storedPath)}'`;
			}

			const results = await table.query().where(filter).toArray();

			return results.map((row) => this.rowToCodeUnit(row));
		} catch {
			return [];
		}
	}

	/**
	 * Get children of a code unit
	 */
	async getChildUnits(
		scope: BranchScope,
		parentId: string,
	): Promise<CodeUnit[]> {
		const table = await this.ensureTableOpen();
		if (!table) return [];

		try {
			let filter = `parentId = '${escapeSqlLiteral(parentId)}' AND documentType = 'code_unit'`;
			const branchFilter = branchMembershipFilter(scope);
			if (branchFilter !== null) filter += ` AND ${branchFilter}`;
			const results = await table.query().where(filter).toArray();

			return results.map((row) => this.rowToCodeUnit(row));
		} catch {
			return [];
		}
	}

	/**
	 * Get a code unit by ID
	 */
	async getCodeUnit(unitId: string): Promise<CodeUnit | null> {
		const table = await this.ensureTableOpen();
		if (!table) return null;

		try {
			const filter = `id = '${escapeSqlLiteral(unitId)}'`;
			const results = await table.query().where(filter).toArray();

			if (results.length === 0) return null;
			return this.rowToCodeUnit(results[0]);
		} catch {
			return null;
		}
	}

	/**
	 * Search code units with hierarchy awareness
	 */
	async searchCodeUnits(
		queryText: string,
		queryVector: number[],
		scope: BranchScope,
		options: {
			limit?: number;
			unitTypes?: UnitType[];
			minDepth?: number;
			maxDepth?: number;
			filePath?: string;
			includeSummaries?: boolean;
		} = {},
	): Promise<Array<CodeUnit & { score: number }>> {
		const {
			limit = 10,
			unitTypes,
			minDepth,
			maxDepth,
			filePath,
			includeSummaries = true,
		} = options;

		const table = await this.ensureTableOpen();
		if (!table) return [];

		// Build filter
		const filters: string[] = ["documentType = 'code_unit'"];
		// D6, part 1: PRE-filter, both retrievers. See `search`.
		const unitBranchFilter = branchMembershipFilter(scope);
		if (unitBranchFilter !== null) filters.push(unitBranchFilter);

		if (unitTypes && unitTypes.length > 0) {
			// IN compares by equality, so this takes `escapeSqlLiteral`.
			const types = unitTypes.map((t) => `'${escapeSqlLiteral(t)}'`).join(", ");
			filters.push(`unitType IN (${types})`);
		}
		if (minDepth !== undefined) {
			filters.push(`depth >= ${minDepth}`);
		}
		if (maxDepth !== undefined) {
			filters.push(`depth <= ${maxDepth}`);
		}
		if (filePath) {
			filters.push(
				`filePath LIKE '%${escapeFilterValue(this.likePatternArg(filePath))}%'`,
			);
		}

		const filterStr = filters.join(" AND ");

		// Vector search
		let vectorQuery = table.vectorSearch(queryVector).limit(limit * 2);
		vectorQuery = vectorQuery.where(filterStr);
		const vectorResults = await vectorQuery.toArray();

		// BM25 search (search both content and summary if summaries exist)
		await this.ensureFtsIndex();
		let bm25Results: any[] = [];
		try {
			let ftsQuery = table
				.query()
				.fullTextSearch(queryText, { columns: ["content"] })
				.limit(limit * 2);
			ftsQuery = ftsQuery.where(filterStr);
			bm25Results = await ftsQuery.toArray();
		} catch {
			bm25Results = [];
		}

		// RRF fusion with test file handling
		const testFileMode = getTestFileMode(this.pathRoot);
		const results = reciprocalRankFusion(
			vectorResults,
			bm25Results,
			VECTOR_WEIGHT,
			BM25_WEIGHT,
			this.testFileDetector,
			testFileMode,
		);

		return results.slice(0, limit).map((r) => ({
			...this.rowToCodeUnit(r),
			score: r.fusedScore,
		}));
	}

	/**
	 * Get maximum depth in the unit hierarchy for a file
	 */
	async getMaxDepth(filePath?: string): Promise<number> {
		const table = await this.ensureTableOpen();
		if (!table) return 0;

		try {
			let filter = "documentType = 'code_unit'";
			if (filePath) {
				const storedPath = this.storedPathArg(filePath);
				if (storedPath === null) return 0;
				filter += ` AND filePath = '${escapeSqlLiteral(storedPath)}'`;
			}

			const results = await table.query().where(filter).toArray();
			if (results.length === 0) return 0;

			return Math.max(...results.map((r) => (r.depth as number) || 0));
		} catch {
			return 0;
		}
	}

	/**
	 * Convert database row to CodeUnit
	 */
	private rowToCodeUnit(row: any): CodeUnit {
		return {
			id: row.id,
			parentId: row.parentId || null,
			unitType: (row.unitType || "function") as UnitType,
			filePath: this.outputPath(row),
			startLine: row.startLine,
			endLine: row.endLine,
			language: row.language,
			content: row.content,
			name: row.name || undefined,
			signature: row.signature || undefined,
			fileHash: row.fileHash,
			depth: row.depth ?? 0,
			metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
		};
	}
}

// ============================================================================
// Reciprocal Rank Fusion
// ============================================================================

interface FusedResult extends StoredChunk {
	fusedScore: number;
	vectorScore?: number;
	keywordScore?: number;
}

/** Test file weight multiplier for downranking */
const TEST_FILE_WEIGHT = 0.3;

/**
 * Combine results from vector and BM25 search using RRF
 */
function reciprocalRankFusion(
	vectorResults: any[],
	bm25Results: any[],
	vectorWeight: number,
	bm25Weight: number,
	testFileDetector?: TestFileDetector,
	testFileMode?: TestFileMode,
	k = 60, // RRF constant
): FusedResult[] {
	const scores = new Map<string, FusedResult>();

	// Helper to check if result should be excluded
	// Note: Empty/missing filePath returns false (safe default - don't exclude unknown sources)
	const shouldExclude = (filePath: string): boolean => {
		if (!filePath || !testFileDetector || testFileMode !== "exclude")
			return false;
		return testFileDetector.isTestFile(filePath);
	};

	// Helper to get test file weight multiplier
	// Note: Empty/missing filePath returns 1.0 (safe default - full weight for unknown sources)
	const getTestWeight = (filePath: string): number => {
		if (!filePath || !testFileDetector || testFileMode !== "downrank")
			return 1.0;
		return testFileDetector.isTestFile(filePath) ? TEST_FILE_WEIGHT : 1.0;
	};

	// Add vector results with their ranks
	for (let i = 0; i < vectorResults.length; i++) {
		const result = vectorResults[i];
		const id = result.id;
		const filePath = result.filePath || "";

		// Skip excluded test files
		if (shouldExclude(filePath)) continue;

		// Apply test file weight
		const testWeight = getTestWeight(filePath);
		const rrf = (vectorWeight * testWeight) / (k + i + 1);

		if (!scores.has(id)) {
			scores.set(id, {
				...result,
				fusedScore: rrf,
				vectorScore: 1 / (i + 1),
			});
		} else {
			const existing = scores.get(id)!;
			existing.fusedScore += rrf;
			existing.vectorScore = 1 / (i + 1);
		}
	}

	// Add BM25 results with their ranks
	for (let i = 0; i < bm25Results.length; i++) {
		const result = bm25Results[i];
		const id = result.id;
		const filePath = result.filePath || "";

		// Skip excluded test files
		if (shouldExclude(filePath)) continue;

		// Apply test file weight
		const testWeight = getTestWeight(filePath);
		const rrf = (bm25Weight * testWeight) / (k + i + 1);

		if (!scores.has(id)) {
			scores.set(id, {
				...result,
				fusedScore: rrf,
				keywordScore: 1 / (i + 1),
			});
		} else {
			const existing = scores.get(id)!;
			existing.fusedScore += rrf;
			existing.keywordScore = 1 / (i + 1);
		}
	}

	// Sort by fused score
	return Array.from(scores.values()).sort(
		(a, b) => b.fusedScore - a.fusedScore,
	);
}

// ============================================================================
// Use Case Weights
// ============================================================================

/** Default weights per document type for each use case */
const USE_CASE_WEIGHTS: Record<
	SearchUseCase,
	Partial<Record<DocumentType, number>>
> = {
	// FIM completion: prioritize code and examples, include API docs
	fim: {
		code_chunk: 0.4,
		usage_example: 0.2,
		idiom: 0.12,
		symbol_summary: 0.08,
		api_reference: 0.1, // API docs help with completion
		framework_doc: 0.07, // Framework patterns
		best_practice: 0.03, // Light best practice guidance
		session_observation: 0.05, // Low — observations less useful for completion
	},
	// Human search: balanced across summaries, code, and external docs
	search: {
		file_summary: 0.2,
		symbol_summary: 0.2,
		code_chunk: 0.15,
		idiom: 0.12,
		usage_example: 0.08,
		anti_pattern: 0.05,
		framework_doc: 0.1, // Official framework docs
		best_practice: 0.05, // Best practices
		api_reference: 0.05, // API reference
		session_observation: 0.2, // High — observations most useful for search
	},
	// Agent navigation: prioritize understanding structure and patterns
	navigation: {
		symbol_summary: 0.28,
		file_summary: 0.25,
		code_chunk: 0.15,
		idiom: 0.08,
		project_doc: 0.04,
		framework_doc: 0.1, // Framework understanding
		api_reference: 0.08, // API navigation
		best_practice: 0.02, // Light guidance
		session_observation: 0.15, // Medium — useful for understanding architecture
	},
};

/**
 * Get weights for a use case (or default balanced weights)
 */
function getUseCaseWeights(
	useCase?: SearchUseCase,
): Partial<Record<DocumentType, number>> {
	if (useCase && USE_CASE_WEIGHTS[useCase]) {
		return USE_CASE_WEIGHTS[useCase];
	}
	// Default balanced weights (includes external docs)
	return {
		code_chunk: 0.25,
		file_summary: 0.12,
		symbol_summary: 0.15,
		idiom: 0.12,
		usage_example: 0.08,
		anti_pattern: 0.03,
		project_doc: 0.05,
		framework_doc: 0.1,
		best_practice: 0.05,
		api_reference: 0.05,
		session_observation: 0.15,
	};
}

// ============================================================================
// Type-Aware RRF Fusion
// ============================================================================

/**
 * Combine results with document type weighting
 */
function typeAwareRRFFusion(
	vectorResults: any[],
	bm25Results: any[],
	vectorWeight: number,
	bm25Weight: number,
	typeWeights: Partial<Record<DocumentType, number>>,
	testFileDetector?: TestFileDetector,
	testFileMode?: TestFileMode,
	k = 60,
): FusedResult[] {
	const scores = new Map<string, FusedResult>();

	// Helper to check if result should be excluded
	// Note: Empty/missing filePath returns false (safe default - don't exclude unknown sources)
	const shouldExclude = (filePath: string): boolean => {
		if (!filePath || !testFileDetector || testFileMode !== "exclude")
			return false;
		return testFileDetector.isTestFile(filePath);
	};

	// Helper to get test file weight multiplier
	// Note: Empty/missing filePath returns 1.0 (safe default - full weight for unknown sources)
	const getTestWeight = (filePath: string): number => {
		if (!filePath || !testFileDetector || testFileMode !== "downrank")
			return 1.0;
		return testFileDetector.isTestFile(filePath) ? TEST_FILE_WEIGHT : 1.0;
	};

	// Process vector results
	for (let i = 0; i < vectorResults.length; i++) {
		const result = vectorResults[i];
		const id = result.id;
		const filePath = result.filePath || "";

		// Skip excluded test files
		if (shouldExclude(filePath)) continue;

		const docType = (result.documentType || "code_chunk") as DocumentType;
		const typeWeight = typeWeights[docType] ?? 0.1;
		const testWeight = getTestWeight(filePath);
		const rrf = (vectorWeight * typeWeight * testWeight) / (k + i + 1);

		if (!scores.has(id)) {
			scores.set(id, {
				...result,
				fusedScore: rrf,
				vectorScore: 1 / (i + 1),
			});
		} else {
			const existing = scores.get(id)!;
			existing.fusedScore += rrf;
			existing.vectorScore = 1 / (i + 1);
		}
	}

	// Process BM25 results
	for (let i = 0; i < bm25Results.length; i++) {
		const result = bm25Results[i];
		const id = result.id;
		const filePath = result.filePath || "";

		// Skip excluded test files
		if (shouldExclude(filePath)) continue;

		const docType = (result.documentType || "code_chunk") as DocumentType;
		const typeWeight = typeWeights[docType] ?? 0.1;
		const testWeight = getTestWeight(filePath);
		const rrf = (bm25Weight * typeWeight * testWeight) / (k + i + 1);

		if (!scores.has(id)) {
			scores.set(id, {
				...result,
				fusedScore: rrf,
				keywordScore: 1 / (i + 1),
			});
		} else {
			const existing = scores.get(id)!;
			existing.fusedScore += rrf;
			existing.keywordScore = 1 / (i + 1);
		}
	}

	// Sort by fused score
	return Array.from(scores.values()).sort(
		(a, b) => b.fusedScore - a.fusedScore,
	);
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a vector store. Both options are required; see `VectorStoreOptions`.
 */
export function createVectorStore(options: VectorStoreOptions): IVectorStore {
	return new VectorStore(options);
}
