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
import type {
	OverlayCandidates,
	OverlayChunkRef,
	OverlayVectorRow,
} from "./overlay/types.js";
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

/**
 * How many candidates each retriever fetches for a result list of `limit`
 * (`fetchLimit`). ONE formula, exported, because the dirty overlay's vector
 * read (`vectorCandidates`) and `search` must cut their lists at the same depth
 * before the two are merged (step 3, §5 Merge): a different depth on either
 * side changes which candidates can win.
 *
 * Equal depth in COUNT is not equal COVERAGE: after `trimIncompleteTieTail`
 * the index list is exact only for rows strictly better than its edge. The
 * merge therefore also gates overlay rows at that edge (`mergeRetrieverLists`,
 * iteration 2, F2); the shared depth alone does not make the merge exact.
 */
export function searchFetchLimit(limit: number): number {
	return limit * 3;
}

/**
 * The deepest any ranked search fetches per retriever for a result list of
 * `limit`: the bound on `fetchUntilFilled`.
 *
 * ── WHY A RANKED SEARCH EVER FETCHES DEEPER ─────────────────────────────────
 * `trimIncompleteTieTail` drops the tie group at the cut of a FULL list, and
 * `collapseSpanTwins` then folds each span's `code_chunk` / `code_unit` pair
 * into one slot. A full `3 × limit` list can hold only ~`1.5 × limit` spans,
 * so trimming its tied tail can leave fewer than `limit` — while the index
 * holds plenty more. Measured in release 0.37.0's black-box TEST-07 on Linux
 * x64: `--limit 10` returned 9 rows, `--limit 20` returned 16, because x64
 * float summation produced an exact tie at rank 30 that arm64 did not. v0.36.1
 * always returned `limit` rows.
 *
 * So when a pass comes back SHORT and a retriever list was cut by count, the
 * search re-runs at double the depth. Each deeper pass is threshold-bounded
 * by the same trim, so the answer stays a function of the corpus.
 *
 * ── WHY 8 ───────────────────────────────────────────────────────────────────
 * At most two re-runs for `search` / `searchDocuments` (3× → 6× → 8×) and two
 * for `searchCodeUnits` (2× → 4× → 8×). A tie group deeper than the cap is
 * the case where no depth helps (every cut lands inside it), and the search
 * then returns what it has rather than chasing the corpus. Raising it costs
 * one more round trip per channel on exactly those queries.
 */
export function searchMaxFetchLimit(limit: number): number {
	return limit * 8;
}

/**
 * The depth the dirty overlay materialises its vector list at, for a search
 * whose `limit` may be unset: `searchMaxFetchLimit` of the limit `search`
 * itself will use. Deep enough that no deepened pass outruns it.
 */
export function overlayVectorFetchLimit(limit: number | undefined): number {
	return searchMaxFetchLimit(limit ?? DEFAULT_LIMIT);
}

/**
 * The next fetch depth after `current`, or `null` when there is none: double,
 * clamped to `cap`; `null` once `current` has reached the cap or doubling
 * would not grow it (a zero depth), so the loop cannot spin.
 */
export function nextFetchLimit(current: number, cap: number): number | null {
	const next = Math.min(current * 2, cap);
	return next > current ? next : null;
}

/** One ranked pass at one fetch depth (`fetchUntilFilled`). */
interface RankedPass<R> {
	readonly results: R[];
	/**
	 * A list that fed fusion was cut by COUNT (an engine list came back with
	 * its full `limit`, or a merge input held rows past the depth), so a
	 * deeper fetch can add candidates. `false` means every list was complete
	 * and no depth can change the answer.
	 */
	readonly truncated: boolean;
}

/**
 * Run `pass` at `firstFetch`, and again at doubling depths up to `cap`, while
 * it comes back SHORT of `limit` and truncated; the LAST pass is the answer.
 * See `searchMaxFetchLimit`.
 *
 * The common path is one call: a first pass that fills `limit` (or whose
 * lists were all complete) is returned as it is, so its statements and its
 * results are exactly what they were before deepening existed (N-2).
 */
async function fetchUntilFilled<P extends RankedPass<unknown>>(
	limit: number,
	firstFetch: number,
	cap: number,
	pass: (fetchLimit: number) => Promise<P>,
): Promise<P> {
	let fetchLimit = firstFetch;
	for (;;) {
		const ranked = await pass(fetchLimit);
		if (ranked.results.length >= limit || !ranked.truncated) return ranked;
		const next = nextFetchLimit(fetchLimit, cap);
		if (next === null) return ranked;
		fetchLimit = next;
	}
}

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
 * How long a superseded dataset version is kept before `optimize()` prunes it.
 *
 * ONE HOUR, and the reasoning — including the measurement that a pruned-out
 * handle fails with `Not found: …lance` rather than degrading — is on
 * `VectorStore.optimize()`, which is the only caller. LanceDB's own default is
 * 7 days, which this feature's rewrite volume turns into 6.8x the live data on
 * disk. Raising it costs disk; lowering it starts to approach the lifetime of a
 * table handle another process is holding, which is the thing it is buying.
 */
export const VERSION_RETENTION_MS = 60 * 60 * 1000;

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

/** The columns an overlay row is materialised from — never `vector`. */
const OVERLAY_ROW_COLUMNS = [
	"id",
	"filePath",
	"content",
	"language",
	"chunkType",
	"name",
	"parentName",
	"signature",
	"contentHash",
	"fileHash",
	"startLine",
	"endLine",
];

function overlayRowOf(row: Record<string, unknown>): OverlayVectorRow {
	const text = (v: unknown) => (typeof v === "string" ? v : "");
	const optional = (v: unknown) =>
		typeof v === "string" && v.length > 0 ? v : undefined;
	return {
		id: text(row.id),
		filePath: text(row.filePath),
		content: text(row.content),
		language: text(row.language),
		chunkType: text(row.chunkType),
		name: optional(row.name),
		parentName: optional(row.parentName),
		signature: optional(row.signature),
		contentHash: text(row.contentHash),
		fileHash: text(row.fileHash),
		startLine: Number(row.startLine),
		endLine: Number(row.endLine),
		_distance: typeof row._distance === "number" ? row._distance : 0,
	};
}

/**
 * First row per id. Identical ids are identical rows here: a chunk id hashes
 * path, lines and content (`chunker.ts`), so a duplicate is a late or repeated
 * append of the same row, never a different one.
 */
function dedupeById(rows: OverlayVectorRow[]): OverlayVectorRow[] {
	const seen = new Set<string>();
	const out: OverlayVectorRow[] = [];
	for (const row of rows) {
		if (seen.has(row.id)) continue;
		seen.add(row.id);
		out.push(row);
	}
	return out;
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
		// Document fields for unified storage. `satisfies`: the value written
		// must be a member of the union every reader types it as (R2.3).
		documentType: "code_unit" satisfies DocumentType,
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
		/**
		 * This worktree's dirty overlay (step 3, R3.2/R3.3). `undefined` is
		 * today's search, statement for statement (NFR-2, pinned by N-2).
		 */
		overlay?: OverlayCandidates,
	): Promise<SearchResult[]>;
	/**
	 * Rows a `suppressedPaths` pre-filter hides from `scope`: `pathKind =
	 * 'repo' AND filePath IN (…)` under the branch predicate. The overlay
	 * report's `suppressedRows` (R3.3 asks for a POSITIVE count). Paths are
	 * stored spelling, compared by equality (`escapeSqlLiteral`, #22).
	 */
	countRowsForStoredPaths(
		scope: BranchScope,
		storedPaths: readonly string[],
	): Promise<number>;
	/**
	 * Rows actually deleted (LanceDB's `numDeletedRows`); 0 on no match or failure.
	 *
	 * THE ONLY surviving unscoped delete-by-path, and it survives for the docs
	 * row class alone (§3.2.1: docs rows are neither widened nor swept). Its four
	 * callers all render `docs:<package>`, which no repository row can equal, so
	 * it cannot reach a row `chunk_index` registered. `deleteByFileHash`,
	 * `deleteByDocumentType` and `deleteAllByFile` were retired in Phase 3b-3
	 * (§3.5): they had no caller in `src/` and each deleted across every branch
	 * of a shared store.
	 */
	deleteByFile(filePath: string): Promise<number>;
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
	/**
	 * The dirty overlay's delete (step 3): every row whose `filePath` is one of
	 * `storedPaths`, and it THROWS on failure. Overlay-role stores only.
	 */
	deleteRowsByStoredPathsStrict(
		storedPaths: readonly string[],
	): Promise<number>;
	/**
	 * Top `fetchLimit` (default `searchFetchLimit(limit)`) rows by vector
	 * distance among `ids`, under the user's language/path filters;
	 * materialised, id-unique, `(_distance, id)` order. The dirty overlay's
	 * vector channel (step 3, §5 Merge). The overlay reads at
	 * `searchMaxFetchLimit(limit)` so a deepened search pass has its rows.
	 */
	vectorCandidates(
		queryVector: number[],
		ids: readonly string[],
		options: Pick<
			SearchOptions,
			"limit" | "language" | "filePath" | "pathPattern"
		>,
		fetchLimit?: number,
	): Promise<OverlayVectorRow[]>;
	/** The rows behind `ids`, materialised without vectors, id-unique. */
	rowsByIds(ids: readonly string[]): Promise<OverlayVectorRow[]>;
	optimize(options?: OptimizeOptions): Promise<void>;
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
	 * `parentKey` is a `codeUnitParentKey` — path, unit type, name and start row,
	 * and deliberately NO content (I-14). It is NOT a row id, and a row id passed
	 * here matches nothing; `codeUnitParentKeyOf(parent)` renders it, over the
	 * parent's STORED path (this class's own `storedPathArg`, not the path
	 * `rowToCodeUnit` hands back).
	 *
	 * THE SCOPE IS REQUIRED, and the reason stated here before I-14 was wrong:
	 * the link is not and never was content-derived. The correct reason is
	 * stronger. Being positional, the key is identical on every branch that holds
	 * that file at that position, so an unscoped read returns EVERY branch's
	 * children of it — including revisions that exist only on another branch.
	 * Scoped, it answers with this branch's current children, because
	 * NARROW_UNITS has already removed the branch's superseded ones.
	 * (§4.4's site list names only the six above; this one is scoped anyway.)
	 */
	getChildUnits(scope: BranchScope, parentKey: string): Promise<CodeUnit[]>;
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
/** `VectorStore.optimize` options. */
export interface OptimizeOptions {
	/**
	 * Keep dataset versions younger than this, ms. Default
	 * `VERSION_RETENTION_MS`. Below the default only on an `"overlay"`-role
	 * store, whose handles are never open outside its own lock.
	 */
	retentionMs?: number;
}

/**
 * What a store is FOR. `"shared"` (the default) is the repository's index,
 * opened by many processes. `"overlay"` is one worktree's dirty-overlay
 * sidecar (step 3): every handle to it is opened after its lock is taken and
 * dropped before it is released, which is what makes the overlay-only
 * operations (strict path delete, zero retention) safe there and only there.
 */
export type VectorStoreRole = "shared" | "overlay";

export interface VectorStoreOptions {
	/** The LanceDB directory: the store's `vectors/`. */
	vectorsDir: string;
	/** Default `"shared"`. See `VectorStoreRole`. */
	role?: VectorStoreRole;
	/**
	 * The caller's own `resolveStoreLocation(startPath).pathRoot`: the worktree
	 * root, or the start path outside a repository. Never derived from
	 * `vectorsDir`, and never read back from the store.
	 */
	pathRoot: string;
}

export class VectorStore implements IVectorStore {
	private dbPath: string;
	/** See `VectorStoreRole`. */
	private readonly role: VectorStoreRole;
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
		this.role = options.role ?? "shared";
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
	 * R2's span key for a fused row, through THE read seam above, so a
	 * `code_chunk` and a `code_unit` over one span get one key: both writers
	 * store the same repo-relative path (`membershipColumns` refuses anything
	 * else for a `"repo"` row) and both are read back here. `null` — never
	 * collapsed — for a row with no path (a corrupt row) or a non-code type.
	 */
	private spanKeyOf(row: {
		filePath: string;
		pathKind?: unknown;
		documentType?: unknown;
		startLine?: unknown;
		endLine?: unknown;
	}): string | null {
		if (!row.filePath) return null;
		return codeSpanKey(row, this.outputPath(row));
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
	 * The USER's predicates — language, `filePath`, `pathPattern` — in the
	 * order and spelling `search` has always rendered them. One builder, so the
	 * dirty overlay's vector read (`vectorCandidates`) filters exactly as the
	 * index side does and the two lists cannot diverge (step 3, §5 Merge).
	 *
	 * Two escapers, by operator context (CLAUDE.md #22): the equality literal
	 * takes `escapeSqlLiteral`, the LIKE patterns `escapeFilterValue`.
	 */
	buildUserFilters(
		options: Pick<SearchOptions, "language" | "filePath" | "pathPattern">,
	): string[] {
		const filters: string[] = [];
		if (options.language) {
			filters.push(`language = '${escapeSqlLiteral(options.language)}'`);
		}
		if (options.filePath) {
			filters.push(
				`filePath LIKE '%${escapeFilterValue(this.likePatternArg(options.filePath))}%'`,
			);
		}
		if (options.pathPattern) {
			filters.push(
				`filePath LIKE '%${escapeFilterValue(this.likePatternArg(options.pathPattern))}%'`,
			);
		}
		return filters;
	}

	/** Overlay-only operations refuse on any other store. See `VectorStoreRole`. */
	private assertOverlayRole(operation: string): void {
		if (this.role !== "overlay") {
			throw new Error(
				`${operation}: only the dirty overlay's own store may do this (role "${this.role}")`,
			);
		}
	}

	/**
	 * See `IVectorStore.deleteRowsByStoredPathsStrict`.
	 *
	 * Unlike `deleteByFile`, nothing is caught: a LanceDB error, a timeout or a
	 * refused predicate propagates. The overlay advances a file's manifest
	 * entry only after its delete AND add both resolved, and a delete that
	 * failed silently would let it name rows that were never removed. Paths
	 * are STORED (repo-relative) and compared by equality, so they take
	 * `escapeSqlLiteral` (CLAUDE.md #22); ≤ 256 per statement.
	 */
	async deleteRowsByStoredPathsStrict(
		storedPaths: readonly string[],
	): Promise<number> {
		this.assertOverlayRole("deleteRowsByStoredPathsStrict");
		if (storedPaths.length === 0) return 0;
		const table = await this.ensureTableOpen();
		if (!table) return 0;
		let deleted = 0;
		for (let i = 0; i < storedPaths.length; i += ID_PREDICATE_BATCH) {
			const batch = storedPaths.slice(i, i + ID_PREDICATE_BATCH);
			const list = batch.map((p) => `'${escapeSqlLiteral(p)}'`).join(", ");
			const result = await withTimeout(
				table.delete(`filePath IN (${list})`),
				LANCEDB_WRITE_TIMEOUT_MS,
				"deleteRowsByStoredPathsStrict:table.delete",
			);
			deleted += result.numDeletedRows;
		}
		return deleted;
	}

	/** See `IVectorStore.vectorCandidates`. */
	async vectorCandidates(
		queryVector: number[],
		ids: readonly string[],
		options: Pick<
			SearchOptions,
			"limit" | "language" | "filePath" | "pathPattern"
		>,
		fetchLimit: number = searchFetchLimit(options.limit ?? DEFAULT_LIMIT),
	): Promise<OverlayVectorRow[]> {
		if (ids.length === 0) return [];
		const table = await this.ensureTableOpen();
		if (!table) return [];
		const user = this.buildUserFilters(options);
		const rows: OverlayVectorRow[] = [];
		for (const batch of chunkIds(ids)) {
			const where = [hexIdList(batch), ...user].join(" AND ");
			const found = await table
				.vectorSearch(queryVector)
				.where(where)
				// `_distance` named explicitly: LanceDB warns that an explicit
				// projection will stop including it implicitly, and a missing
				// distance would read as 0 and rank every overlay row first.
				.select([...OVERLAY_ROW_COLUMNS, "_distance"])
				.limit(fetchLimit)
				.toArray();
			for (const row of found) {
				// Never default a missing distance: 0 would rank the row first.
				if (typeof row._distance !== "number") {
					throw new Error(
						"vectorCandidates: LanceDB returned a row with no _distance",
					);
				}
				rows.push(overlayRowOf(row));
			}
		}
		return dedupeById(rows)
			.sort((a, b) =>
				a._distance !== b._distance
					? a._distance - b._distance
					: a.id < b.id
						? -1
						: a.id > b.id
							? 1
							: 0,
			)
			.slice(0, fetchLimit);
	}

	/** See `IVectorStore.rowsByIds`. */
	async rowsByIds(ids: readonly string[]): Promise<OverlayVectorRow[]> {
		if (ids.length === 0) return [];
		const table = await this.ensureTableOpen();
		if (!table) return [];
		const rows: OverlayVectorRow[] = [];
		for (const batch of chunkIds(ids)) {
			const found = await table
				.query()
				.where(hexIdList(batch))
				.select(OVERLAY_ROW_COLUMNS)
				.toArray();
			for (const row of found) rows.push(overlayRowOf(row));
		}
		return dedupeById(rows);
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
	 *
	 * Four stages (step 3, phase 5): `buildSearchFilters` → `retrieveCandidates`
	 * → `applyOverlay` → `fuseAndHydrate`. With `overlay === undefined` the
	 * third stage does not run and the other three issue exactly the statements
	 * the single method did (N-2 deep-equals a snapshot frozen before the split).
	 * With an overlay, its rows are merged into the index's retriever lists
	 * BEFORE fusion and the stale index rows are pre-filtered out (R3.2/R3.3).
	 *
	 * Stages 2-4 re-run at a deeper `fetchLimit` only when a pass comes back
	 * SHORT of `limit` while a list was cut by count (`fetchUntilFilled`,
	 * `searchMaxFetchLimit`). A pass that fills `limit` is the only pass.
	 */
	async search(
		queryText: string,
		queryVector: number[] | undefined,
		scope: BranchScope,
		options: SearchOptions = {},
		overlay?: OverlayCandidates,
	): Promise<SearchResult[]> {
		const table = await this.ensureTableOpen();
		if (!table) {
			return [];
		}
		const first = this.buildSearchFilters(scope, options, overlay);
		const ranked = await fetchUntilFilled(
			first.limit,
			first.fetchLimit,
			searchDepthCap(first, overlay),
			async (fetchLimit) => {
				const plan =
					fetchLimit === first.fetchLimit ? first : { ...first, fetchLimit };
				const lists = await this.retrieveCandidates(
					table,
					queryText,
					queryVector,
					plan,
				);
				const merged =
					overlay === undefined
						? lists
						: await this.applyOverlay(table, queryText, plan, lists, overlay);
				return {
					results: this.fuseAndHydrate(merged, plan),
					truncated: merged.truncated,
				};
			},
		);
		return ranked.results;
	}

	/**
	 * Stage 1: every predicate and limit of one search, decided before any I/O.
	 *
	 * Note the two escapers: equality literals take `escapeSqlLiteral`, LIKE
	 * patterns take `escapeFilterValue` (which additionally neutralises the
	 * `%` / `_` wildcards). Swapping either way is a silent bug — see the
	 * comments on the two functions.
	 *
	 * D6, part 1: the branch predicate is a PRE-filter, on BOTH retrievers. It
	 * goes in the same `filters` array the language and path predicates use,
	 * which is passed to `.where()` on the vectorSearch query AND on the
	 * fullTextSearch query. A foreign row then never enters the candidate set,
	 * never consumes a `limit` slot and never displaces a visible row. A
	 * POST-filter would silently return fewer than `limit` results — a far
	 * larger NFR-5 break than any statistical drift — which is why `postfilter`
	 * must not appear in this file at all (swept).
	 *
	 * R3.3's suppression predicate joins the SAME array, last, for the same
	 * reason: a stale row of a dirty file must not take a candidate slot. It is
	 * absent when nothing is suppressed, so an empty overlay renders today's
	 * predicate string exactly (N-1).
	 */
	private buildSearchFilters(
		scope: BranchScope,
		options: SearchOptions,
		overlay: OverlayCandidates | undefined,
	): SearchPlan {
		const {
			limit = DEFAULT_LIMIT,
			language,
			filePath,
			pathPattern,
			keywordOnly,
			useCase,
		} = options;
		const filters: string[] = [];
		const branchFilter = branchMembershipFilter(scope);
		if (branchFilter !== null) filters.push(branchFilter);
		const userFilters = this.buildUserFilters({
			language,
			filePath,
			pathPattern,
		});
		filters.push(...userFilters);
		const suppression =
			overlay === undefined
				? null
				: suppressionPredicate(overlay.suppressedPaths);
		if (suppression !== null) filters.push(suppression);
		return {
			limit,
			// Fetch more results to account for multi-type documents
			fetchLimit: searchFetchLimit(limit),
			filterStr: filters.length > 0 ? filters.join(" AND ") : undefined,
			branchFilter,
			userFilters,
			keywordOnly: keywordOnly === true,
			useCase,
		};
	}

	/**
	 * Stage 2: the index's two retriever lists.
	 *
	 * NFR-5: both lists go through `stabilizeRetrieverOrder` before fusion.
	 * Tied rows come back from the engine in STORAGE order, which every
	 * widening rewrite changes, and rank-only fusion turns a tie swap into a
	 * real reordering. See that function for the measurement.
	 */
	private async retrieveCandidates(
		table: lancedb.Table,
		queryText: string,
		queryVector: number[] | undefined,
		plan: SearchPlan,
	): Promise<RetrieverLists> {
		const { filterStr, fetchLimit, limit } = plan;

		// Vector search (skip if keyword-only mode or no vector)
		let vector: Record<string, unknown>[] = [];
		let vectorEdge: number | null = null;
		let truncated = false;
		const vectorRan = !plan.keywordOnly && queryVector !== undefined;
		if (vectorRan) {
			let vectorQuery = table.vectorSearch(queryVector).limit(fetchLimit);
			if (filterStr) {
				vectorQuery = vectorQuery.where(filterStr);
			}
			const ordered = stabilizeRetrieverOrder(
				await vectorQuery.toArray(),
				"_distance",
			);
			truncated ||= ordered.length >= fetchLimit;
			vectorEdge = retrieverEdge(ordered, "_distance", fetchLimit);
			vector = trimIncompleteTieTail(ordered, "_distance", {
				fetched: fetchLimit,
				keepAtLeast: limit,
			});
		}

		// BM25 full-text search (if available)
		await this.ensureFtsIndex();
		let bm25: Record<string, unknown>[] = [];
		let bm25Edge: number | null = null;
		try {
			let ftsQuery = table
				.query()
				.fullTextSearch(queryText, { columns: ["content"] })
				.limit(fetchLimit);
			if (filterStr) {
				ftsQuery = ftsQuery.where(filterStr);
			}
			const ordered = stabilizeRetrieverOrder(
				await ftsQuery.toArray(),
				"_score",
			);
			truncated ||= ordered.length >= fetchLimit;
			bm25Edge = retrieverEdge(ordered, "_score", fetchLimit);
			bm25 = trimIncompleteTieTail(ordered, "_score", {
				fetched: fetchLimit,
				keepAtLeast: limit,
			});
		} catch {
			bm25 = [];
			// A channel that THREW is not a complete list, so not `null`. `NaN`
			// admits no overlay row (`mergeRetrieverLists`): a calibrated twin
			// found by a later, successful FTS query must not own a BM25 channel
			// the index side could not fill (outer review 2, LOW 5). The
			// overlay-free path never reads the edge.
			bm25Edge = Number.NaN;
		}
		return { vector, bm25, vectorRan, vectorEdge, bm25Edge, truncated };
	}

	/**
	 * Stage 3 (overlay only): merge the overlay's candidates into the index's
	 * lists, BEFORE fusion (R3.2).
	 *
	 * - Vector channel, exact: the overlay's rows (top `fetchLimit` by flat L2
	 *   in its own store, same model, same metric — M-2) that are strictly
	 *   better than the index list's edge (`lists.vectorEdge`) join it by
	 *   `(_distance, id)`. Only when the vector channel ran at all.
	 * - BM25 channel, calibrated: the overlay's own FTS scores are NOT
	 *   commensurable (separate index, own IDF), so unchanged overlay chunks
	 *   take the BM25 score of their index twin (`calibratedTwins`), gated
	 *   at the main BM25 list's edge (`lists.bm25Edge`) the same way, and
	 *   changed/new chunks are vector-only (ruling 4).
	 *
	 * Depth: the overlay's vector list may be materialised DEEPER than this
	 * pass (`OverlayCandidates.vectorFetchLimit`), so it is cut here at
	 * `plan.fetchLimit` — `(_distance, id)` order, so its first `fetchLimit`
	 * rows are exactly a fetch at that depth. Both sides of the merge are then
	 * cut at the same depth on every pass (`searchDepthCap` keeps a deepened
	 * pass from outrunning the overlay's own depth).
	 */
	private async applyOverlay(
		table: lancedb.Table,
		queryText: string,
		plan: SearchPlan,
		lists: RetrieverLists,
		overlay: OverlayCandidates,
	): Promise<RetrieverLists> {
		const cut = { fetched: plan.fetchLimit, keepAtLeast: plan.limit };
		let truncated = lists.truncated;
		let vector = lists.vector;
		if (lists.vectorRan && overlay.vector.length > 0) {
			truncated ||= overlay.vector.length > plan.fetchLimit;
			vector = mergeRetrieverLists(
				lists.vector,
				overlay.vector
					.slice(0, plan.fetchLimit)
					.map((row) => overlayRetrieverRow(row, { _distance: row._distance })),
				"_distance",
				{ ...cut, indexEdge: lists.vectorEdge },
			);
		}
		let bm25 = lists.bm25;
		const twins = await this.calibratedTwins(table, queryText, plan, overlay);
		if (twins.length > 0) {
			truncated ||= twins.length > plan.fetchLimit;
			bm25 = mergeRetrieverLists(lists.bm25, twins, "_score", {
				...cut,
				indexEdge: lists.bm25Edge,
			});
		}
		return {
			vector,
			bm25,
			vectorRan: lists.vectorRan,
			vectorEdge: lists.vectorEdge,
			bm25Edge: lists.bm25Edge,
			truncated,
		};
	}

	/**
	 * The calibrated BM25 channel (revision 1, HIGH 2): one FTS query on the
	 * INDEX for the twins of served overlay chunks (`calibrationPredicate`),
	 * paired one-to-one and re-labelled as the overlay chunk
	 * (`pairCalibratedTwins`).
	 *
	 * Exactness under dropped rows: the query starts at `2 × fetchLimit`. If
	 * pairing left fewer twins than `fetchLimit` (and fewer than the served
	 * chunk count, which bounds it) while the query returned its FULL limit,
	 * unpaired rows may have crowded twins out, so it is re-issued with the
	 * limit doubled, at most `CALIBRATION_REISSUES` times. An FTS failure means
	 * no calibrated twins — the same answer the main BM25 query gives then.
	 */
	private async calibratedTwins(
		table: lancedb.Table,
		queryText: string,
		plan: SearchPlan,
		overlay: OverlayCandidates,
	): Promise<Record<string, unknown>[]> {
		if (overlay.servedPaths.length === 0) return [];
		const hashes = new Set<string>();
		let servedChunks = 0;
		for (const [key, refs] of overlay.chunksByPathHash) {
			hashes.add(key.slice(key.lastIndexOf("\0") + 1));
			servedChunks += refs.length;
		}
		if (servedChunks === 0) return [];
		const where = calibrationPredicate(
			plan.branchFilter,
			overlay.servedPaths,
			[...hashes].sort(),
			plan.userFilters,
		);
		const wanted = Math.min(plan.fetchLimit, servedChunks);
		let queryLimit = 2 * plan.fetchLimit;
		for (let attempt = 0; ; attempt++) {
			let rows: Record<string, unknown>[];
			try {
				rows = await table
					.query()
					.fullTextSearch(queryText, { columns: ["content"] })
					.where(where)
					.limit(queryLimit)
					.toArray();
			} catch {
				return [];
			}
			const twins = pairCalibratedTwins(rows, overlay);
			if (
				twins.length >= wanted ||
				rows.length < queryLimit ||
				attempt >= CALIBRATION_REISSUES
			) {
				return twins;
			}
			queryLimit *= 2;
		}
	}

	/**
	 * Stage 4: type-aware RRF fusion, summary separation, the R2 span collapse
	 * (which is also the `limit` cut) and hydration.
	 *
	 * Overlay rows (`source: "dirty"`) hydrate from their materialised
	 * candidate: no summary lookup, no carry-over in either direction, no
	 * `branchIds` (R3.7, R3.8).
	 */
	private fuseAndHydrate(
		lists: RetrieverLists,
		plan: SearchPlan,
	): SearchResult[] {
		const { limit } = plan;

		// Type-aware Reciprocal Rank Fusion
		const weights = getUseCaseWeights(plan.useCase || "search");
		const testFileMode = getTestFileMode(this.pathRoot);
		const fused = typeAwareRRFFusion(
			lists.vector,
			lists.bm25,
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

		// R2 (D-TWIN): one result slot per code span. A span indexed as BOTH a
		// `code_chunk` and a `code_unit` row reaches the fused list twice; the
		// collapse keeps the higher-ranked twin and back-fills the freed slot
		// from further down the fused list, so this is the `limit` cut too.
		const { kept: topResults, twinIdsOf } = collapseSpanTwins(
			codeResults,
			limit,
			(r) => this.spanKeyOf(r),
		);
		const codeById = new Map(codeResults.map((r) => [r.id, r]));

		// Attach summaries to their source code chunks.
		// Prefer symbol-level summary (more specific), fall back to file-level.
		// A dropped twin's summaries are CARRIED OVER to the kept row, after the
		// kept row's own at each level: a `symbol_summary` usually names the
		// chunk's id and a unit summary lives on the unit row, so keeping either
		// twin alone would otherwise lose the other's.
		const maxFused = topResults.length > 0 ? topResults[0].fusedScore : 1;
		return topResults.map((keptRow) => {
			if (keptRow.source === DIRTY_SOURCE) {
				return this.hydrateOverlayRow(keptRow, maxFused);
			}
			const sources = carryOverSourcesFor(
				keptRow,
				twinIdsOf.get(keptRow.id),
				codeById,
			);
			// R2-A: a nameless kept row (a gap chunk) takes its named twin's
			// identity; id, content, lines and score stay its own.
			const r = withCarriedIdentity(keptRow, sources);
			const symbolLevel = firstNonEmpty(
				sources.map((s) => s.summary || symbolSummaryById.get(s.id)),
			);
			const fileLevel = firstNonEmpty(
				sources.map((s) => fileSummaryById.get(s.id)),
			);
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
				summary: symbolLevel || fileLevel || undefined,
				fileSummary: fileLevel || undefined,
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
	 * An overlay row as a result: its own materialised fields, the output path
	 * through THE read seam (a `"repo"` row, so absolute), `source: "dirty"`.
	 * No `branchIds` key at all — it belongs to no branch (R3.7) — and no
	 * summary or unit type: the overlay has no enrichment (R3.8). Its id can
	 * equal an index chunk's (an unchanged chunk at unchanged lines), so a
	 * summary keyed to that id describes the INDEXED revision and is never
	 * looked up here.
	 */
	private hydrateOverlayRow(r: FusedResult, maxFused: number): SearchResult {
		return {
			chunk: {
				id: r.id,
				contentHash: r.contentHash || "",
				content: r.content,
				filePath: this.outputPath(r),
				startLine: r.startLine,
				endLine: r.endLine,
				language: r.language,
				chunkType: r.chunkType as SearchResult["chunk"]["chunkType"],
				name: r.name || undefined,
				parentName: r.parentName || undefined,
				signature: r.signature || undefined,
				fileHash: r.fileHash,
			},
			score: maxFused > 0 ? r.fusedScore / maxFused : 0,
			vectorScore: r.vectorScore || 0,
			keywordScore: r.keywordScore || 0,
			source: DIRTY_SOURCE,
		};
	}

	/** See `IVectorStore.countRowsForStoredPaths`. */
	async countRowsForStoredPaths(
		scope: BranchScope,
		storedPaths: readonly string[],
	): Promise<number> {
		// Not `unique`: tree-sitter's TS grammar reads that as the `unique
		// symbol` keyword and the AST sweeps over this file lose the line.
		const paths = [...new Set(storedPaths)];
		if (paths.length === 0) return 0;
		const table = await this.ensureTableOpen();
		if (!table) return 0;
		const branchFilter = branchMembershipFilter(scope);
		let total = 0;
		for (let i = 0; i < paths.length; i += ID_PREDICATE_BATCH) {
			const parts: string[] = [];
			if (branchFilter !== null) parts.push(branchFilter);
			parts.push(`${PATH_KIND_COLUMN} = 'repo'`);
			parts.push(
				equalityInLists("filePath", paths.slice(i, i + ID_PREDICATE_BATCH)),
			);
			total += await table.countRows(parts.join(" AND "));
		}
		return total;
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
	 * ── A BELT SINCE I-14, AND IT SHOULD NEVER FIRE ───────────────────────────
	 * It was built because a code-unit id hashed `filePath:unitType:name:startRow`
	 * and no content, so two revisions of one function collided on ONE row and
	 * the branch that indexed LAST decided the body every branch saw. `codeUnitRowId`
	 * now hashes the content too, so an id match implies a content match and the
	 * collision this method answers cannot arise from the id scheme any more.
	 *
	 * IT IS KEPT, NOT DELETED, for two reasons, and both are cheap:
	 *
	 *   1. A row id is `sha256(...).slice(0, 16)` — 64 bits. Two DIFFERENT bodies
	 *      at one path, type, name and start row colliding is not something to
	 *      rely on never happening, and a belt turns "serve the wrong body"
	 *      (silent, cross-branch) into "rewrite in place" (the pre-I-14
	 *      behaviour: degraded, never corrupt).
	 *   2. `chunk_index.content_hash` is registered in a SECOND transaction after
	 *      this rewrite on purpose, so a crash between them leaves the new
	 *      content under the old hash. The comparison in the caller is what reads
	 *      that as a mismatch and repeats the rewrite, idempotently.
	 *
	 * The caller's count of these (`totalUnitsRefreshed`) is therefore the
	 * cheapest live check that I-14 works: it reads 0 on every ordinary run,
	 * including a second branch that changed the same function.
	 *
	 * The mechanism: an UPDATE-ONLY `mergeInsert` over the whole row, atomic,
	 * never inserting, leaving the id with exactly the number of rows it already
	 * had. `branchIds` is the caller's RECOMPUTED mirror per row, so a row
	 * several branches hold does not lose them.
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
	 * M5 (I-7 FINAL): ONE `optimize()` at the end of the widening drain — and
	 * the only place this store prunes old dataset versions.
	 *
	 * Every row a merge rewrites leaves the FTS index — measured, 19 026 of
	 * 20 000 after a second worktree's first run. Recall is NOT lost
	 * (`fullTextSearch` scans the unindexed tail and returned 982/982), so this
	 * is a latency step: filtered FTS goes from 0.7 ms to 60-72 ms, and
	 * `optimize()` folds the tail back in and compacts to two fragments;
	 * 180-700 ms at 20 000-26 288 rows.
	 *
	 * It does NOT restore BM25 scores, and it never had to. The claim that a
	 * merge shifts them "by up to 5 %" was measured false at repository scale:
	 * 0 of 1 200 score cells moved after all 26 288 rows were rewritten, and 0
	 * of 1 200 again after a forced `createIndex(replace:true)`. The NFR-5
	 * exposure is TIE ORDER, and it is closed in `stabilizeRetrieverOrder`.
	 *
	 * Never per batch: the cost is in the fold, not in the number of rows.
	 *
	 * ── PRUNING, AND WHY THE WINDOW IS AN HOUR RATHER THAN A MINUTE ─────────
	 * `table.optimize()` with no argument keeps every version for LanceDB's
	 * default **7 days**, and this feature multiplies rewrite volume: one
	 * dataset version per 256-id merge batch, ~82-107 of them for a single
	 * worktree's first index. Measured across three worktrees of one repository:
	 * `vectors/` grew **97.7 MB -> 679.2 MB against 105 MB of live data** — 6.8x
	 * — entirely in retained old versions. Nothing else in `src/` prunes, and
	 * nothing in `src/` does a time-travel read (no `listVersions`, `checkout`
	 * or `restore` on this table), so the retained versions serve no reader.
	 *
	 * They do serve one thing, which is what sets the window. A local lancedb
	 * table handle is PINNED to the version it opened — no read-consistency
	 * interval is configured anywhere — and pruning out from under such a handle
	 * is not graceful. Measured on a throwaway table: a handle opened before the
	 * churn, then `optimize({cleanupOlderThan: now})`, then a read:
	 *
	 *     Not found: …/t.lance/data/0111…fe3b4ba1399f.lance
	 *
	 * So the window must exceed the lifetime of any handle another process may
	 * be holding. Every store handle in `src/` is opened and closed inside one
	 * operation — the MCP search tool and the file watcher each build an Indexer
	 * per call and `close()` it, and a CLI search is a process — so the longest
	 * such lifetime is a single search, measured at 0.8-1.2 s including process
	 * start. ONE HOUR is ~3 000x that, still collapses the steady state (a
	 * post-commit hook's ~6 MB per run is retained for an hour instead of a
	 * week, ~35x less), and leaves a wide margin for a long-held handle nobody
	 * has thought of. `deleteUnverified` is deliberately NOT set: files that
	 * belong to no manifest may be an in-progress transaction of another
	 * process, and LanceDB's 7-day rule for those is the right one to keep.
	 *
	 * Measured against the doc comment, because the doc comment reads as if no
	 * window under 7 days can do anything: with `deleteUnverified` false and
	 * files minutes old, `cleanupOlderThan` removed 42 old versions and
	 * 4 166 555 bytes, taking the directory from 4.6 MB to 1.9 MB.
	 */
	async optimize(options: OptimizeOptions = {}): Promise<void> {
		const retentionMs = options.retentionMs ?? VERSION_RETENTION_MS;
		// The hour above is what protects ANOTHER process's pinned handle. Only
		// the dirty overlay's store may go below it: no handle to it is ever open
		// outside its lock (step 3, §5 Storage), so nothing can be reading an old
		// version when it prunes. `deleteUnverified` stays unset either way.
		if (retentionMs < VERSION_RETENTION_MS && this.role !== "overlay") {
			throw new RangeError(
				`optimize: retention ${retentionMs} ms is below ${VERSION_RETENTION_MS} ms, which only the dirty overlay's store may use`,
			);
		}
		const table = await this.ensureTableOpen();
		if (!table) return;
		await withTimeout(
			table.optimize({
				cleanupOlderThan: new Date(Date.now() - retentionMs),
			}),
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
			// This used to interpolate the path raw, as the now-retired
			// `deleteAllByFile` did: a quote in the path made LanceDB reject the
			// statement (caught below, reported as "no documents"), and a crafted
			// path widened the predicate to every row. Equality, so quote
			// doubling only.
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

		// Get weights for the use case
		const weights = typeWeights || getUseCaseWeights(useCase);
		const testFileMode = getTestFileMode(this.pathRoot);

		// One ranked pass at `fetchLimit`; re-run deeper only when it comes
		// back short with a list cut by count (`fetchUntilFilled`).
		const rankAt = async (
			fetchLimit: number,
		): Promise<RankedPass<FusedResult>> => {
			// Vector search. NFR-5: deterministic rank order, see `search` above.
			let vectorQuery = table.vectorSearch(queryVector).limit(fetchLimit);
			if (filterStr) {
				vectorQuery = vectorQuery.where(filterStr);
			}
			const vectorRows = await vectorQuery.toArray();
			let truncated = vectorRows.length >= fetchLimit;
			const vectorResults = trimIncompleteTieTail(
				stabilizeRetrieverOrder(vectorRows, "_distance"),
				"_distance",
				{ fetched: fetchLimit, keepAtLeast: limit },
			);

			// BM25 full-text search
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
				const ftsRows = await ftsQuery.toArray();
				truncated ||= ftsRows.length >= fetchLimit;
				bm25Results = trimIncompleteTieTail(
					stabilizeRetrieverOrder(ftsRows, "_score"),
					"_score",
					{ fetched: fetchLimit, keepAtLeast: limit },
				);
			} catch {
				bm25Results = [];
			}

			// Type-aware RRF fusion with test file handling
			const results = typeAwareRRFFusion(
				vectorResults,
				bm25Results,
				VECTOR_WEIGHT,
				BM25_WEIGHT,
				weights,
				this.testFileDetector,
				testFileMode,
			);

			// R2: one slot per code span, collapsed before the cut (code rows
			// only; every other document type keeps its own slot). See `search`.
			// No identity carry-over (R2-A) here: `BaseDocument` carries no
			// name, chunk type, signature or parent, so a nameless kept row
			// shows nothing that a twin could complete.
			const { kept } = collapseSpanTwins(results, limit, (r) =>
				this.spanKeyOf(r),
			);
			return { results: kept, truncated };
		};
		const firstFetch = limit * 3;
		const { results: topResults } = await fetchUntilFilled(
			limit,
			firstFetch,
			Math.max(firstFetch, searchMaxFetchLimit(limit)),
			rankAt,
		);

		// Convert to EnrichedSearchResult format
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
	 * Get children of a code unit, by the parent's POSITION KEY (see the
	 * interface declaration; `codeUnitParentKeyOf` renders it). The stored column
	 * is still called `parentId`, which is the name of the link, not a claim that
	 * it holds a row id.
	 */
	async getChildUnits(
		scope: BranchScope,
		parentKey: string,
	): Promise<CodeUnit[]> {
		const table = await this.ensureTableOpen();
		if (!table) return [];

		try {
			let filter = `parentId = '${escapeSqlLiteral(parentKey)}' AND documentType = 'code_unit'`;
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
		const testFileMode = getTestFileMode(this.pathRoot);

		// One ranked pass at `fetchLimit`; re-run deeper only when it comes
		// back short with a list cut by count (`fetchUntilFilled`). The pass
		// carries its fused list and twin map out with it, for hydration.
		const rankAt = async (fetchLimit: number) => {
			// Vector search. NFR-5: deterministic rank order, see `search` above.
			let vectorQuery = table.vectorSearch(queryVector).limit(fetchLimit);
			vectorQuery = vectorQuery.where(filterStr);
			const vectorRows = await vectorQuery.toArray();
			let truncated = vectorRows.length >= fetchLimit;
			const vectorResults = trimIncompleteTieTail(
				stabilizeRetrieverOrder(vectorRows, "_distance"),
				"_distance",
				{ fetched: fetchLimit, keepAtLeast: limit },
			);

			// BM25 search (search both content and summary if summaries exist)
			await this.ensureFtsIndex();
			let bm25Results: any[] = [];
			try {
				let ftsQuery = table
					.query()
					.fullTextSearch(queryText, { columns: ["content"] })
					.limit(fetchLimit);
				ftsQuery = ftsQuery.where(filterStr);
				const ftsRows = await ftsQuery.toArray();
				truncated ||= ftsRows.length >= fetchLimit;
				bm25Results = trimIncompleteTieTail(
					stabilizeRetrieverOrder(ftsRows, "_score"),
					"_score",
					{ fetched: fetchLimit, keepAtLeast: limit },
				);
			} catch {
				bm25Results = [];
			}

			// RRF fusion with test file handling
			const results = reciprocalRankFusion(
				vectorResults,
				bm25Results,
				VECTOR_WEIGHT,
				BM25_WEIGHT,
				this.testFileDetector,
				testFileMode,
			);

			// R2: the pre-filter admits only `code_unit` rows, so a twin here
			// is two REVISIONS of one span (a unit id carries its content,
			// D-7): in a SCOPE_ALL superset, or two rows one branch still
			// holds. One slot per span, as on the other two paths, and a
			// nameless kept revision takes a branch-sharing twin's identity
			// (R2-A).
			const { kept, twinIdsOf } = collapseSpanTwins(results, limit, (r) =>
				this.spanKeyOf(r),
			);
			return { results: kept, truncated, twinIdsOf, fused: results };
		};
		const firstFetch = limit * 2;
		const {
			results: kept,
			twinIdsOf,
			fused,
		} = await fetchUntilFilled(
			limit,
			firstFetch,
			Math.max(firstFetch, searchMaxFetchLimit(limit)),
			rankAt,
		);
		const unitById = new Map(fused.map((r) => [r.id, r]));
		return kept.map((keptRow) => {
			const r = withCarriedIdentity(
				keptRow,
				carryOverSourcesFor(keptRow, twinIdsOf.get(keptRow.id), unitById),
			);
			return { ...this.rowToCodeUnit(r), score: r.fusedScore };
		});
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

/** One search's predicates and limits (`VectorStore.buildSearchFilters`). */
interface SearchPlan {
	readonly limit: number;
	readonly fetchLimit: number;
	/** Branch AND user AND suppression predicates, for both main retrievers. */
	readonly filterStr: string | undefined;
	readonly branchFilter: string | null;
	readonly userFilters: readonly string[];
	readonly keywordOnly: boolean;
	readonly useCase: SearchUseCase | undefined;
}

/** The two retriever lists `typeAwareRRFFusion` consumes. */
interface RetrieverLists {
	readonly vector: Record<string, unknown>[];
	readonly bm25: Record<string, unknown>[];
	/** The vector channel ran (not keyword-only, a query vector exists). */
	readonly vectorRan: boolean;
	/**
	 * `retrieverEdge` of each channel's engine list: the score of its last row
	 * when the engine FILLED it, `null` when the channel did not run or came
	 * back short (complete), `NaN` when its order cannot be trusted or the
	 * BM25 query THREW (admits nothing). The dirty overlay's merge admits only
	 * rows strictly better than it (`mergeRetrieverLists`); the overlay-free
	 * path computes it and never reads it.
	 */
	readonly vectorEdge: number | null;
	readonly bm25Edge: number | null;
	/** `RankedPass.truncated`: a deeper fetch could add candidates. */
	readonly truncated: boolean;
}

/**
 * The deepest `search` may fetch: `searchMaxFetchLimit`, and with an overlay
 * no deeper than the overlay's own vector list reaches.
 *
 * The merge gate (`mergeRetrieverLists`) relies on both sides being cut at
 * the SAME depth: an overlay list materialised at depth `d` and FULL there is
 * missing whatever lies past `d`, so a pass at a depth beyond `d` would rank
 * index rows the overlay's absent rows should have beaten. A list SHORTER
 * than its depth holds every served row, so it bounds nothing.
 */
function searchDepthCap(
	plan: SearchPlan,
	overlay: OverlayCandidates | undefined,
): number {
	const cap = Math.max(plan.fetchLimit, searchMaxFetchLimit(plan.limit));
	if (overlay === undefined) return cap;
	const depth = overlay.vectorFetchLimit ?? plan.fetchLimit;
	if (overlay.vector.length < depth) return cap;
	return Math.min(cap, Math.max(plan.fetchLimit, depth));
}

/** Test file weight multiplier for downranking */
const TEST_FILE_WEIGHT = 0.3;

/**
 * NFR-5's ACTUAL mechanism, and the one place it is closed.
 *
 * ── WHAT WAS MEASURED, AND WHAT IT RULED OUT ────────────────────────────────
 * The design (and the comment on `optimize()` that this supersedes) said a
 * widening `mergeInsert` shifts rewritten rows' BM25 scores by up to 5 %, and
 * that the end-of-drain `optimize()` "restores scores exactly". Measured on a
 * 26 288-row copy of a real repository store, all 26 288 rows rewritten through
 * the shipped `rowsForWidening` + `writeBranchIdsMirror` pair:
 *
 *   BM25 scores differing after the rewrite + optimize(): 0 of 1 200 cells
 *   BM25 scores differing after a FORCED createIndex(replace:true): 0 of 1 200
 *   BM25 ordered id lists identical: 7 of 20, in BOTH cases
 *   of the 13 queries whose list moved, moves confined to EQUAL-SCORE groups: 13
 *   vector channel: 20/20 ordered lists identical, 0 of 1 200 distances moved
 *
 * So the scores never drift — not across the rewrite, not across compaction —
 * and a full FTS rebuild changes nothing (314 ms for an identical reading). The
 * list moves because **the retrievers return TIED rows in storage order**, and
 * every rewrite changes storage order. Ties are not rare here and never will be.
 * One source of them is the `code_chunk` / `code_unit` pair over one span —
 * the duplication that put 49 repeated `(path, startLine, endLine)` tuples in
 * 400 result rows before `collapseSpanTwins` (R2). The two rows are NOT the same
 * text by construction: measured over 2 788 such pairs, 528 are byte-identical
 * and tie exactly, while 2 260 differ (the chunk usually carries a leading
 * `export\n` the unit lacks) and score close but not equal. Identical content
 * at different locations is another source (`(a, b) => a + b` is indexed 40
 * times in this repository). Ties are about ORDER; why the rows exist twice is
 * the collapse's business, not this function's.
 *
 * Fusion is rank-only (`1 / (k + i + 1)`), so a tie SWAP at ranks i / i+1 is a
 * real fused-score difference, and at the top-20 boundary it evicts a result.
 * That is the `max=20` in the pre-release measurement: a swap at rank 19/20.
 *
 * ── THE FIX ─────────────────────────────────────────────────────────────────
 * Make each retriever's rank a pure function of `(score, id)` instead of of
 * storage layout. `id` is content-addressed and unique per row, so the order is
 * total, stable across compaction, and identical in every worktree — which is
 * exactly what NFR-5 asks for. This costs one sort of at most `limit * 3` rows.
 *
 * ── WHY IT REFUSES RATHER THAN GUESSES WHEN THE COLUMN IS ABSENT ────────────
 * LanceDB supplies the rank column (`_score` for FTS, `_distance` for vector)
 * on a full projection; verified on 0.38. If a future version renames or drops
 * it, sorting anyway would order the whole candidate list BY ID — catastrophic,
 * and silent. So a list that does not carry a finite number in `scoreField` on
 * every row is returned untouched, which is exactly today's behaviour, and
 * `store-rank-stability.test.ts` fails loudly instead.
 *
 * The candidate SET is the OTHER half of this, and it is `trimIncompleteTieTail`'s.
 */
export function stabilizeRetrieverOrder<T extends Record<string, unknown>>(
	rows: T[],
	scoreField: "_score" | "_distance",
): T[] {
	// `_score` is better-when-larger, `_distance` better-when-smaller.
	const sign = scoreField === "_score" ? -1 : 1;
	for (const row of rows) {
		const score = row[scoreField];
		if (typeof score !== "number" || !Number.isFinite(score)) return rows;
		if (typeof row.id !== "string") return rows;
	}
	return [...rows].sort((a, b) => {
		const sa = a[scoreField] as number;
		const sb = b[scoreField] as number;
		if (sa !== sb) return sign * (sa - sb);
		const ia = a.id as string;
		const ib = b.id as string;
		return ia < ib ? -1 : ia > ib ? 1 : 0;
	});
}

/**
 * Drop the LAST score group when the engine cut the list, because that group is
 * the one that may be incomplete.
 *
 * ── THE HALF OF NFR-5 THAT ORDERING ALONE DOES NOT CLOSE ────────────────────
 * `stabilizeRetrieverOrder` makes the ORDER of a candidate list independent of
 * storage. It cannot make the list's MEMBERSHIP independent of it: the engine
 * takes the top `fetched` rows by score and breaks its own ties by storage
 * order, so when a tie group straddles rank `fetched`, WHICH of its members is
 * fetched at all is decided by the layout that the last rewrite happened to
 * leave.
 *
 * That is not hypothetical and it is not rare enough to wave away. Measured on
 * the live 26 288-row store, query 10 of the pinned set, `limit = 20` so
 * `fetched = 60`:
 *
 *     caching-embeddings-client.ts:1020-1036  code_unit   vector rank 59
 *     caching-embeddings-client.ts:1020-1036  code_chunk  vector rank 60
 *     both at distance 0.7403558492660522 — bit-identical
 *
 * One row in, one row out, of an IDENTICALLY-scored pair, split by the cut. And
 * the two are not interchangeable downstream: the type weight differs, so which
 * twin survives changes the fused score. On the path users take (CLI search
 * passes no use case, so `getUseCaseWeights("search")`) `code_chunk` weighs
 * 0.15 against `code_unit`'s 0.1 — 1.5x, not the 2.5x this comment once quoted
 * from the DEFAULT table's 0.25. `fim` is 4x (0.4). `code_unit` had no entry
 * in any table then and took the `?? 0.1` fallback; it is now explicit at the
 * same value (R2.2). That single swap is the whole of
 * the one ordered list (of 20) that still moved after a fifth worktree's first
 * index, and it moved by EVICTING a result from the top 20.
 *
 * ── THE RULE, AND WHY IT IS DETERMINISTIC RATHER THAN MERELY LUCKIER ────────
 * The engine's contract is "the top `fetched` rows BY SCORE". So the set of
 * rows scoring strictly better than the last row's score is fully determined by
 * the corpus — no tie order can change it. Everything at exactly the last
 * score, in contrast, is an arbitrary sample of its group. Dropping that group
 * turns a count-bounded candidate set into a THRESHOLD-bounded one, which is
 * the property that makes it reproducible.
 *
 * Over-fetching was the alternative and it is strictly weaker: it moves the
 * boundary without removing it, and the same straddle happens at the new rank.
 *
 * ── THE THREE CONDITIONS, EACH OF WHICH IS A WAY TO GET THIS WRONG ─────────
 *   - Only when `rows.length >= fetched`. A short list was not cut, so its last
 *     group is complete and dropping it would delete real results.
 *   - Never below `keepAtLeast`. A single-term query can put every fetched row
 *     on one score; trimming there would empty the channel. In that case the
 *     arbitrary sample is kept, because an arbitrary answer beats no answer —
 *     and it is the case where no choice can be principled anyway.
 *   - Only on a list that is already ordered by score, which is why this runs
 *     AFTER `stabilizeRetrieverOrder` and reads the score of the LAST row.
 */
export function trimIncompleteTieTail<T extends Record<string, unknown>>(
	rows: T[],
	scoreField: "_score" | "_distance",
	options: { fetched: number; keepAtLeast: number },
): T[] {
	if (rows.length === 0 || rows.length < options.fetched) return rows;
	const edge = rows[rows.length - 1][scoreField];
	if (typeof edge !== "number" || !Number.isFinite(edge)) return rows;
	let cut = rows.length;
	while (cut > 0 && rows[cut - 1][scoreField] === edge) cut--;
	if (cut < options.keepAtLeast) return rows;
	return rows.slice(0, cut);
}

/**
 * The EDGE of one engine retriever list: the score below which the list is no
 * longer exact.
 *
 * `trimIncompleteTieTail` turns a count-bounded list into a threshold-bounded
 * one, so a list the engine FILLED (`rows.length >= fetched`) is exact only for
 * rows strictly better than its last row's score; what lies at or past that
 * score was never fetched, or was fetched as an arbitrary sample of a tie
 * group. A SHORT list holds every row matching its predicate, so it has no
 * edge: `null`.
 *
 * Read from the trim's own INPUT (the `stabilizeRetrieverOrder`-ed engine
 * list), never from its output, which is shorter than `fetched` exactly when
 * the trim fired.
 *
 * `NaN` when the list is full but its order cannot be trusted: a row in it
 * carries no finite score, so `stabilizeRetrieverOrder` returned it untouched.
 * A non-finite edge admits no overlay row at all (`mergeRetrieverLists`),
 * which fails toward the index-only ranking.
 */
export function retrieverEdge(
	ordered: readonly Record<string, unknown>[],
	scoreField: "_score" | "_distance",
	fetched: number,
): number | null {
	if (ordered.length < fetched || fetched <= 0) return null;
	for (let i = 0; i < fetched; i++) {
		const score = ordered[i][scoreField];
		if (typeof score !== "number" || !Number.isFinite(score)) return Number.NaN;
	}
	return ordered[fetched - 1][scoreField] as number;
}

// ============================================================================
// The dirty overlay's candidate-level merge (step 3, R3.2 / R3.3)
// ============================================================================

/** `SearchResult.source` of an overlay row. */
const DIRTY_SOURCE = "dirty" as const;

/**
 * `score` is a finite number strictly better than `edge` on `scoreField`'s
 * metric (`_distance`: smaller, `_score`: larger). A non-finite `edge` makes
 * every comparison false, so nothing passes.
 */
function strictlyBetter(
	score: unknown,
	edge: number,
	scoreField: "_score" | "_distance",
): boolean {
	if (typeof score !== "number" || !Number.isFinite(score)) return false;
	if (!Number.isFinite(edge)) return false;
	return scoreField === "_distance" ? score < edge : score > edge;
}

/**
 * One retriever list built from two sources, ordered and cut exactly as one
 * engine list would be: overlay rows GATED at the index list's edge, then
 * `(score, id)` order (`stabilizeRetrieverOrder`), one entry per id, cut at
 * `fetched`, then the incomplete tie tail dropped (`trimIncompleteTieTail`).
 *
 * ── THE GATE (iteration 2, F2) ──────────────────────────────────────────────
 * `index` arrives already trimmed, i.e. THRESHOLD-bounded: when the engine
 * filled it, it is exact only for rows strictly better than `indexEdge`
 * (`retrieverEdge`), and is shorter than `fetched` whenever the trim fired.
 * Cutting the union by COUNT would refill those freed slots with the
 * overlay's best rows however far past the edge they lie — compared against
 * index rows the engine never fetched. Measured on a real store (q7 of the
 * pinned set): an unchanged overlay chunk whose index twin sits at vector rank
 * 1742 took rank 29, result #8 of 10. So an overlay row is admitted only
 * where the index list is exact:
 *
 *   - `indexEdge === null` (the index list is short, hence complete): every
 *     overlay row competes;
 *   - otherwise only rows STRICTLY better than the edge. The group AT the edge
 *     is the arbitrary sample the trim drops; an overlay row at exactly that
 *     value would join the same sample;
 *   - a non-finite edge admits none, which fails toward the index-only ranking.
 *
 * Index rows are never gated against the overlay's own edge: `overlay` is cut
 * at `fetched` too, so an index row past the overlay's edge already falls past
 * position `fetched` in the union, and a tie AT that edge is dropped by the
 * trim below. The index channel's membership with an overlay therefore equals
 * the suppressed index list, and an unchanged overlay chunk takes exactly the
 * channel rank its index twin would take under the same suppression.
 *
 * A PRE-FUSION ordering step, and the reason the local overlay does not ship
 * D-MERGE (`step3-scope.md` §2.3): the cloud merger min-max normalises each
 * list on its own, so the best overlay row is always 1.0 however poor it is.
 * Here an overlay row competes on its RAW `_distance` / calibrated `_score`
 * against index rows from the same metric, and `typeAwareRRFFusion` then ranks
 * both by position, unchanged.
 *
 * Duplicate ids keep the better-ranked entry. Identical ids are identical
 * rows (a chunk id hashes path, lines and content), and fusion would otherwise
 * credit one row twice.
 */
export function mergeRetrieverLists<T extends Record<string, unknown>>(
	index: readonly T[],
	overlay: readonly T[],
	scoreField: "_score" | "_distance",
	options: { fetched: number; keepAtLeast: number; indexEdge: number | null },
): T[] {
	const { indexEdge } = options;
	const admitted =
		indexEdge === null
			? overlay
			: overlay.filter((row) =>
					strictlyBetter(row[scoreField], indexEdge, scoreField),
				);
	const ordered = stabilizeRetrieverOrder([...index, ...admitted], scoreField);
	const seen = new Set<unknown>();
	const distinct: T[] = [];
	for (const row of ordered) {
		if (seen.has(row.id)) continue;
		seen.add(row.id);
		distinct.push(row);
	}
	return trimIncompleteTieTail(
		distinct.slice(0, options.fetched),
		scoreField,
		options,
	);
}

/**
 * `(col IN (…) OR col IN (…))`, ≤ 256 values per list (`ID_PREDICATE_BATCH`).
 * EQUALITY over stored text, so `escapeSqlLiteral` and nothing else
 * (CLAUDE.md #22): `escapeFilterValue` would turn `my_file.ts` into
 * `my\_file.ts`, which matches no row.
 *
 * PARENTHESISED HERE, not by the callers (review 1, LOW 12): `AND` binds
 * tighter than `OR`, so an unparenthesised multi-list result joined with
 * `AND` widens to every row the later lists match, whatever the other terms
 * say. Exported for that test.
 *
 * An EMPTY `values` is a predicate that matches NOTHING, `(1 = 0)` — the
 * meaning of "equal to one of no values" — never `()`, which LanceDB rejects
 * as a parse error (review 2, LOW 9). Pinned against a real table.
 */
export const MATCH_NOTHING_PREDICATE = "(1 = 0)";

export function equalityInLists(
	column: string,
	values: readonly string[],
): string {
	if (values.length === 0) return MATCH_NOTHING_PREDICATE;
	const lists: string[] = [];
	for (let i = 0; i < values.length; i += ID_PREDICATE_BATCH) {
		const batch = values.slice(i, i + ID_PREDICATE_BATCH);
		lists.push(
			`${column} IN (${batch.map((v) => `'${escapeSqlLiteral(v)}'`).join(", ")})`,
		);
	}
	return `(${lists.join(" OR ")})`;
}

/**
 * R3.3's stale-row pre-filter: hide every `"repo"` row whose stored path is
 * suppressed (`served ∪ staleDeleted`), or `null` when nothing is.
 *
 * The `pathKind` guard (MEDIUM 1) keeps session observations visible: they
 * store `filePath = affectedFiles[0]` with `pathKind: "synthetic"` and are
 * authored data, never stale. Summary rows of a suppressed file are `"repo"`
 * rows of that path and go with it.
 */
export function suppressionPredicate(
	storedPaths: readonly string[],
): string | null {
	if (storedPaths.length === 0) return null;
	return `NOT (${PATH_KIND_COLUMN} = 'repo' AND ${equalityInLists("filePath", storedPaths)})`;
}

/**
 * The calibrated BM25 twin query's predicate (revision 1, HIGH 2). Every row
 * it returns is a TRUE twin of a served overlay chunk, so its `limit` is spent
 * on twins only (CAL-1):
 *
 *   - `branchFilter` — the SAME branch predicate the main retrievers carry
 *     (absent only in SCOPE_ALL), so another branch's copy of the text never
 *     lends a row its score (BR-1);
 *   - `documentType = 'code_chunk' AND pathKind = 'repo'` — the overlay holds
 *     code chunks of repository files only;
 *   - `filePath IN (served)` and `contentHash IN (served chunk hashes)`;
 *   - the user's language/path predicates (`buildUserFilters`).
 */
export function calibrationPredicate(
	branchFilter: string | null,
	servedPaths: readonly string[],
	contentHashes: readonly string[],
	userFilters: readonly string[],
): string {
	const parts: string[] = [];
	if (branchFilter !== null) parts.push(branchFilter);
	parts.push("documentType = 'code_chunk'");
	parts.push(`${PATH_KIND_COLUMN} = 'repo'`);
	parts.push(equalityInLists("filePath", servedPaths));
	parts.push(equalityInLists("contentHash", contentHashes));
	parts.push(...userFilters);
	return parts.join(" AND ");
}

/**
 * A materialised overlay row in the shape the retriever lists and fusion read:
 * a `code_chunk` of a `"repo"` path, marked `source: "dirty"`, with NO
 * `branchIds` (R3.7: overlay rows belong to no branch). `rank` carries the
 * row's retriever score — `_distance` for the vector channel, the index
 * twin's `_score` for the calibrated BM25 channel.
 */
function overlayRetrieverRow(
	row: OverlayVectorRow,
	rank: { _distance: number } | { _score: number },
): Record<string, unknown> {
	return {
		id: row.id,
		filePath: row.filePath,
		content: row.content,
		language: row.language,
		chunkType: row.chunkType,
		name: row.name ?? "",
		parentName: row.parentName ?? "",
		signature: row.signature ?? "",
		contentHash: row.contentHash,
		fileHash: row.fileHash,
		startLine: row.startLine,
		endLine: row.endLine,
		documentType: "code_chunk",
		[PATH_KIND_COLUMN]: "repo",
		source: DIRTY_SOURCE,
		...rank,
	};
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Above this many candidate pairs in ONE `(filePath, contentHash)` group,
 * `pairCalibratedTwins` stops materialising the Cartesian product (review 2,
 * MEDIUM 6). That product is quadratic and synchronous: one 512 KiB file of
 * 2 500 identical chunks gave 6.25 M pairs and ~1.1 s of blocked event loop,
 * past CLAUDE.md #31's 250 ms work allowance. 65 536 pairs sorts in a few ms.
 */
export const TWIN_PAIRING_EXACT_MAX_PAIRS = 65_536;

type TwinRef = OverlayChunkRef;

/**
 * The large-group pairing: O((R + N) log) instead of O(R × N). Index rows in
 * `(startLine, id)` order each take the NEAREST still-unused overlay chunk
 * (ties: overlay id asc), found through two "next unused" pointer forests
 * over the chunks sorted by `(startLine, id)`. Still ONE-TO-ONE, so DUP-1
 * holds; it differs from the exact global-nearest-first order only in which
 * of several equally plausible lines a twin is shown on, in a group of
 * identical chunks the exact rule could not afford.
 */
function pairLargeGroup(
	rows: readonly Record<string, unknown>[],
	refs: readonly TwinRef[],
): Array<{ ref: TwinRef; row: Record<string, unknown> }> {
	const sortedRefs = [...refs].sort(
		(a, b) => a.startLine - b.startLine || byText(a.id, b.id),
	);
	const sortedRows = [...rows].sort(
		(a, b) =>
			Number(a.startLine) - Number(b.startLine) ||
			byText(String(a.id), String(b.id)),
	);
	const n = sortedRefs.length;
	// right[i]: the first unused index >= i (n = none); left[i + 1]: the last
	// unused index <= i (0 = none), shifted by one so "none" has a slot.
	const right = Array.from({ length: n + 1 }, (_, i) => i);
	const left = Array.from({ length: n + 1 }, (_, i) => i);
	const find = (forest: number[], i: number): number => {
		let root = i;
		while (forest[root] !== root) root = forest[root] as number;
		let at = i;
		while (forest[at] !== root) {
			const next = forest[at] as number;
			forest[at] = root;
			at = next;
		}
		return root;
	};
	const out: Array<{ ref: TwinRef; row: Record<string, unknown> }> = [];
	for (const row of sortedRows) {
		if (out.length >= n) break;
		const line = Number(row.startLine);
		let lo = 0;
		let hi = n;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if ((sortedRefs[mid] as TwinRef).startLine < line) lo = mid + 1;
			else hi = mid;
		}
		const r = find(right, lo); // n = none
		const l = find(left, lo) - 1; // -1 = none
		const rRef = r < n ? sortedRefs[r] : undefined;
		const lRef = l >= 0 ? sortedRefs[l] : undefined;
		let pick: number;
		if (rRef === undefined) pick = l;
		else if (lRef === undefined) pick = r;
		else {
			const dr = Math.abs(rRef.startLine - line);
			const dl = Math.abs(lRef.startLine - line);
			pick = dl < dr || (dl === dr && byText(lRef.id, rRef.id) < 0) ? l : r;
		}
		const ref = sortedRefs[pick] as TwinRef;
		out.push({ ref, row });
		right[pick] = pick + 1;
		left[pick + 1] = pick;
	}
	return out;
}

/**
 * Pair calibrated index BM25 rows with the overlay chunks they are twins of,
 * ONE-TO-ONE (revision 1, HIGH 2), and re-label each pair as its overlay chunk.
 *
 * Grouped by `(filePath, contentHash)` — the key `chunksByPathHash` uses.
 * Within a group the candidate pairs are taken in order of
 * `|index.startLine − overlay.startLine|` asc, then overlay id asc, then index
 * id asc, and a pair is accepted when neither side is used yet. So each overlay
 * id appears AT MOST ONCE, and `typeAwareRRFFusion`'s duplicate summing can
 * never credit it twice (DUP-1) — identical chunks twice in one file, or one
 * chunk on two branches in SCOPE_ALL, still give one entry.
 *
 * Unpaired index rows are dropped. A paired row keeps the index row's
 * `_score`: identical content scores identically, so the pairing chooses which
 * LINES are shown (the overlay's, current), never the score.
 */
export function pairCalibratedTwins(
	indexRows: readonly Record<string, unknown>[],
	overlay: Pick<OverlayCandidates, "chunksByPathHash" | "rowsById">,
): Record<string, unknown>[] {
	const groups = new Map<string, Record<string, unknown>[]>();
	for (const row of indexRows) {
		const key = `${String(row.filePath)}\0${String(row.contentHash)}`;
		if (!overlay.chunksByPathHash.has(key)) continue;
		const group = groups.get(key);
		if (group === undefined) groups.set(key, [row]);
		else group.push(row);
	}
	const out: Record<string, unknown>[] = [];
	for (const [key, groupRows] of groups) {
		const groupRefs = overlay.chunksByPathHash.get(key) ?? [];
		// Only pairable members take part: a ref with a materialised row, a row
		// with a numeric score. (The exact path below skips the same ones.)
		const refs = groupRefs.filter((ref) => overlay.rowsById.has(ref.id));
		const rows = groupRows.filter((row) => typeof row._score === "number");
		if (refs.length * rows.length > TWIN_PAIRING_EXACT_MAX_PAIRS) {
			for (const { ref, row } of pairLargeGroup(rows, refs)) {
				const materialised = overlay.rowsById.get(ref.id);
				if (materialised !== undefined) {
					out.push(
						overlayRetrieverRow(materialised, { _score: row._score as number }),
					);
				}
			}
		} else {
			out.push(...pairExactGroup(rows, refs, overlay));
		}
	}
	return out;
}

/** The exact rule, for a group whose Cartesian product is affordable. */
function pairExactGroup(
	rows: readonly Record<string, unknown>[],
	refs: readonly TwinRef[],
	overlay: Pick<OverlayCandidates, "rowsById">,
): Record<string, unknown>[] {
	const out: Record<string, unknown>[] = [];
	const pairs: {
		distance: number;
		ref: (typeof refs)[number];
		row: Record<string, unknown>;
	}[] = [];
	for (const ref of refs) {
		for (const row of rows) {
			pairs.push({
				distance: Math.abs(Number(row.startLine) - ref.startLine),
				ref,
				row,
			});
		}
	}
	pairs.sort(
		(x, y) =>
			x.distance - y.distance ||
			byText(x.ref.id, y.ref.id) ||
			byText(String(x.row.id), String(y.row.id)),
	);
	const usedRefs = new Set<string>();
	const usedRows = new Set<unknown>();
	for (const { ref, row } of pairs) {
		if (usedRefs.has(ref.id) || usedRows.has(row.id)) continue;
		const materialised = overlay.rowsById.get(ref.id);
		if (materialised === undefined) continue;
		if (typeof row._score !== "number") continue;
		usedRefs.add(ref.id);
		usedRows.add(row.id);
		out.push(overlayRetrieverRow(materialised, { _score: row._score }));
	}
	return out;
}

/**
 * How many times the calibrated twin query is re-issued with its limit
 * doubled when pairing dropped rows and left fewer twins than `fetchLimit`.
 */
const CALIBRATION_REISSUES = 3;

/**
 * R2's span key: one `(output path, startLine, endLine)` per code span, or
 * `null` for a row that must never be collapsed.
 *
 * Only `code_chunk` and `code_unit` rows have one (a missing `documentType` is
 * a `code_chunk`, the store's own default). Summaries, observations and the
 * external-docs types keep a slot each, whatever path and lines they carry.
 *
 * The key is the SPAN, never the content hash. Measured on this repository's
 * store, only 528 of 2 788 chunk/unit twins are byte-identical — the chunk
 * usually carries a leading `export\n` the unit does not — and a `code_unit`
 * row stores `contentHash: ""` anyway. `\0` separates the parts because no
 * path can contain it, so `a.ts` + line 12 never collides with `a.ts1` + 2.
 *
 * `outputPath` is the row's path as the caller sees it (`VectorStore`'s read
 * seam), not the stored column, so the key is the span the USER would see
 * twice.
 */
export function codeSpanKey(
	row: {
		readonly documentType?: unknown;
		readonly startLine?: unknown;
		readonly endLine?: unknown;
	},
	outputPath: string,
): string | null {
	const type = row.documentType || "code_chunk";
	if (type !== "code_chunk" && type !== "code_unit") return null;
	return `${outputPath}\0${String(row.startLine)}\0${String(row.endLine)}`;
}

export interface SpanCollapse<T> {
	/** At most `limit` rows, fused order kept, one per span key. */
	readonly kept: T[];
	/** Kept row id -> ids of the rows dropped as its twins, fused order. */
	readonly twinIdsOf: ReadonlyMap<string, readonly string[]>;
	/** How many rows were dropped as the twin of a KEPT row. */
	readonly collapsed: number;
}

/**
 * R2 (D-TWIN): one result slot per code span, applied to the FUSED list in
 * place of the `slice(0, limit)` cut.
 *
 * Measured before this existed: 49 of 400 top-20 slots (12.3 %) on 19 of 20
 * queries showed a span the list had already shown, because one span is
 * indexed as a `code_chunk` row and as a `code_unit` row and both rank.
 *
 * - The FIRST occurrence of a key wins. The fused list is ordered by
 *   `(fusedScore desc, id asc)` (`sortFused`), so that is the higher-ranked
 *   twin after fusion — which is why every weight table carries an explicit
 *   `code_unit` entry: the weight decides the winner.
 * - The walk covers the WHOLE list, not the first `limit` rows: a freed slot
 *   is back-filled from below, so the result is short only when fewer than
 *   `limit` distinct spans exist, and a twin ranked below the cut is still
 *   recorded against its kept row (summary carry-over needs it).
 * - Rows with a `null` key always take a slot of their own.
 *
 * Pure: no I/O, the input is not mutated.
 */
export function collapseSpanTwins<T extends { readonly id: string }>(
	fused: readonly T[],
	limit: number,
	spanKeyOf: (row: T) => string | null,
): SpanCollapse<T> {
	const kept: T[] = [];
	const twinIdsOf = new Map<string, string[]>();
	// Span key -> id of the kept row that owns it, or null when the key's
	// first occurrence fell below the cut (its twins are then irrelevant).
	const ownerOf = new Map<string, string | null>();
	let collapsed = 0;
	for (const row of fused) {
		const key = spanKeyOf(row);
		if (key === null) {
			if (kept.length < limit) kept.push(row);
			continue;
		}
		if (ownerOf.has(key)) {
			const owner = ownerOf.get(key);
			if (owner !== null && owner !== undefined) {
				const twins = twinIdsOf.get(owner);
				if (twins) twins.push(row.id);
				else twinIdsOf.set(owner, [row.id]);
				collapsed++;
			}
			continue;
		}
		if (kept.length < limit) {
			kept.push(row);
			ownerOf.set(key, row.id);
		} else {
			ownerOf.set(key, null);
		}
	}
	return { kept, twinIdsOf, collapsed };
}

/**
 * The rows a kept row may borrow from — its summaries (`search`) and, when it
 * has no name, its symbol identity (`withCarriedIdentity`): itself, then each
 * dropped twin that shares at least one branch with it, in fused order.
 *
 * Within one branch scope every row passed the branch pre-filter, so every
 * twin qualifies. In `SCOPE_ALL` (an unknown branch, a flagged superset) one
 * span can hold DIFFERENT REVISIONS from different branches — a unit id
 * carries its content (D-7) — and a summary of one revision describes code the
 * other does not contain. So a twin with no branch in common contributes
 * nothing; the kept row shows its own summary (and name) or none.
 *
 * A dirty-overlay row (`source: "dirty"`, step 3) never takes part in either
 * direction: it describes uncommitted text no index summary or unit was built
 * from. It carries no `branchIds`, so the membership rule already excludes
 * it; the explicit test keeps that true if overlay rows ever gain one.
 */
function carryOverSourcesFor(
	kept: FusedResult,
	twinIds: readonly string[] | undefined,
	byId: ReadonlyMap<string, FusedResult>,
): FusedResult[] {
	if (!twinIds || twinIds.length === 0) return [kept];
	if (kept.source === DIRTY_SOURCE) return [kept];
	const keptBranches = new Set(decodeBranchIds(kept[BRANCH_IDS_COLUMN]));
	const sources = [kept];
	for (const id of twinIds) {
		const twin = byId.get(id);
		if (!twin || twin.source === DIRTY_SOURCE) continue;
		const shared = decodeBranchIds(twin[BRANCH_IDS_COLUMN]).some((b) =>
			keptBranches.has(b),
		);
		if (shared) sources.push(twin);
	}
	return sources;
}

/**
 * Orchestrator ruling R2-A — IDENTITY carry-over, the sibling of summary
 * carry-over.
 *
 * The chunker writes a function under `MIN_CHUNK_TOKENS` as a GAP chunk
 * (`chunkType: "module"`, no name; `chunker.ts` `flushGap`) while the unit
 * extractor names the same span. Measured over this repository's `src/`: 683
 * of 1 895 chunk/unit twin spans have that shape, and none the other way
 * round. The chunk is the higher-ranked twin under every weight table, so
 * keeping it alone printed `type=module name=` and took the span out of the
 * dead-code penalty, which looks a symbol up BY NAME (R1).
 *
 * So: when the kept row has no `name`, it takes `name`, `chunkType`,
 * `signature` and `parentName` from the FIRST named row in `sources` — the
 * highest-ranked twin at the same span key that shares a branch with it
 * (`carryOverSourcesFor`). For a `code_unit` kept row the unit's type lives in
 * `unitType` (which `rowToCodeUnit` reads), so it follows `chunkType`. The
 * kept row's id, content, lines and score are untouched: R2.2's "the higher-
 * ranked twin wins" is unchanged, only its label is completed. A named kept
 * row is returned as is, never relabelled by a twin.
 */
function withCarriedIdentity(
	kept: FusedResult,
	sources: readonly FusedResult[],
): FusedResult {
	if (kept.name) return kept;
	const named = sources.find((s) => s !== kept && s.name);
	if (!named) return kept;
	const carried: FusedResult = {
		...kept,
		name: named.name,
		chunkType: named.chunkType,
		signature: named.signature,
		parentName: named.parentName,
	};
	if (kept.documentType === "code_unit" && named.unitType) {
		carried.unitType = named.unitType;
	}
	return carried;
}

function firstNonEmpty(values: ReadonlyArray<string | undefined>): string {
	for (const value of values) if (value) return value;
	return "";
}

/**
 * The same total order applied to the FUSED list.
 *
 * Belt to `stabilizeRetrieverOrder`'s braces: once both input lists are ordered
 * deterministically the fused order already is, because `Array.sort` is stable
 * and the `Map` preserves insertion order. This removes the dependence on both
 * of those facts, and covers the case two rows land on exactly the same fused
 * score from different channels.
 */
function sortFused(results: FusedResult[]): FusedResult[] {
	return results.sort((a, b) => {
		if (a.fusedScore !== b.fusedScore) return b.fusedScore - a.fusedScore;
		return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
	});
}

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

	// Sort by fused score, ties broken by id (see `sortFused`).
	return sortFused(Array.from(scores.values()));
}

// ============================================================================
// Use Case Weights
// ============================================================================

/**
 * Default weights per document type for each use case.
 *
 * `code_unit` is listed EXPLICITLY in every table, the default included
 * (R2.2). 0.1 is exactly what the `?? 0.1` fallback in `typeAwareRRFFusion`
 * gave it before, so these entries change no ranking — they turn an unchosen
 * fallback into a chosen value. It matters because the weight decides which
 * twin of a `code_chunk`/`code_unit` pair ranks higher after fusion, and
 * `collapseSpanTwins` keeps exactly that one. Whether `code_unit` should equal
 * `code_chunk` instead is queued as a mnemex-bench eval, not decided here.
 */
const USE_CASE_WEIGHTS: Record<
	SearchUseCase,
	Partial<Record<DocumentType, number>>
> = {
	// FIM completion: prioritize code and examples, include API docs
	fim: {
		code_chunk: 0.4,
		code_unit: 0.1,
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
		code_unit: 0.1,
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
		code_unit: 0.1,
		idiom: 0.08,
		project_doc: 0.04,
		framework_doc: 0.1, // Framework understanding
		api_reference: 0.08, // API navigation
		best_practice: 0.02, // Light guidance
		session_observation: 0.15, // Medium — useful for understanding architecture
	},
};

/**
 * Get weights for a use case (or default balanced weights). Exported for the
 * weight-table test (T-3); search callers go through `search` /
 * `searchDocuments`.
 */
export function getUseCaseWeights(
	useCase?: SearchUseCase,
): Partial<Record<DocumentType, number>> {
	if (useCase && USE_CASE_WEIGHTS[useCase]) {
		return USE_CASE_WEIGHTS[useCase];
	}
	// Default balanced weights (includes external docs)
	return {
		code_chunk: 0.25,
		code_unit: 0.1,
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

	// Sort by fused score, ties broken by id (see `sortFused`).
	return sortFused(Array.from(scores.values()));
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
