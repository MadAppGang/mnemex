/**
 * LanceDB Vector Store
 *
 * Handles vector storage and hybrid search (BM25 + vector similarity)
 * using LanceDB's embedded database.
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import * as lancedb from "@lancedb/lancedb";
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
	addChunks(chunks: ChunkWithEmbedding[]): Promise<void>;
	search(
		queryText: string,
		queryVector: number[] | undefined,
		options?: SearchOptions,
	): Promise<SearchResult[]>;
	deleteByFile(filePath: string): Promise<number>;
	deleteByFileHash(fileHash: string): Promise<number>;
	getChunksWithVectors(filePath: string): Promise<ChunkWithEmbedding[]>;
	clear(): Promise<void>;
	getChunkContents(limit?: number): Promise<string[]>;
	getStats(): Promise<{
		totalChunks: number;
		uniqueFiles: number;
		languages: string[];
	}>;
	addDocuments(documents: DocumentWithEmbedding[]): Promise<void>;
	deleteByDocumentType(documentType: DocumentType): Promise<number>;
	deleteAllByFile(filePath: string): Promise<number>;
	getDocumentsByFile(
		filePath: string,
		documentTypes?: DocumentType[],
	): Promise<BaseDocument[]>;
	searchDocuments(
		queryText: string,
		queryVector: number[],
		options?: EnrichedSearchOptions,
	): Promise<EnrichedSearchResult[]>;
	getDocumentTypeStats(): Promise<Record<DocumentType, number>>;
	close(): Promise<void>;
	addCodeUnits(units: CodeUnitWithEmbedding[]): Promise<void>;
	updateUnitSummary(unitId: string, summary: string): Promise<void>;
	updateDocumentContent(
		documentId: string,
		newContent: string,
		newVector: number[],
	): Promise<boolean>;
	getAllSummaries(): Promise<Array<BaseDocument & { vector: number[] }>>;
	getCodeUnitsByFile(
		filePath: string,
		unitTypes?: UnitType[],
	): Promise<CodeUnit[]>;
	getCodeUnitsByDepth(depth: number, filePath?: string): Promise<CodeUnit[]>;
	getChildUnits(parentId: string): Promise<CodeUnit[]>;
	getCodeUnit(unitId: string): Promise<CodeUnit | null>;
	searchCodeUnits(
		queryText: string,
		queryVector: number[],
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

export class VectorStore implements IVectorStore {
	private dbPath: string;
	private projectPath: string;
	private db: lancedb.Connection | null = null;
	private table: lancedb.Table | null = null;
	private dimension: number | null = null;
	private tableDimension: number | null = null;
	private _dimensionMismatchCleared = false;
	private testFileDetector: TestFileDetector;

	constructor(dbPath: string, projectPath?: string) {
		this.dbPath = dbPath;
		// Extract project path from dbPath if not provided
		// dbPath is like: /path/to/project/.mnemex/vectors
		this.projectPath = projectPath ?? dirname(dirname(dbPath));
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
	async addChunks(chunks: ChunkWithEmbedding[]): Promise<void> {
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
				this.db!.createTable(CHUNKS_TABLE, data, { mode: "create" }),
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
		if (language) {
			filters.push(`language = '${escapeSqlLiteral(language)}'`);
		}
		if (filePath) {
			filters.push(`filePath LIKE '%${escapeFilterValue(filePath)}%'`);
		}
		if (pathPattern) {
			filters.push(`filePath LIKE '%${escapeFilterValue(pathPattern)}%'`);
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
		const testFileMode = getTestFileMode(this.projectPath);
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
					filePath: r.filePath,
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
	 * Delete all chunks from a specific file
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

			await table.delete(`filePath = '${escapeSqlLiteral(filePath)}'`);
			return 1; // LanceDB doesn't return count
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
					`filePath = '${escapeSqlLiteral(filePath)}' AND documentType = 'code_chunk'`,
				)
				.toArray();

			return results.map((row) => ({
				id: row.id,
				contentHash: row.contentHash || "",
				content: row.content,
				filePath: row.filePath,
				startLine: row.startLine,
				endLine: row.endLine,
				language: row.language,
				chunkType: row.chunkType as any,
				name: row.name || undefined,
				parentName: row.parentName || undefined,
				signature: row.signature || undefined,
				fileHash: row.fileHash,
				vector: row.vector,
			}));
		} catch {
			return [];
		}
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
	async addDocuments(documents: DocumentWithEmbedding[]): Promise<void> {
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
				this.db!.createTable(CHUNKS_TABLE, data, { mode: "create" }),
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

			// The value was interpolated raw. That is data loss, not a syntax
			// hazard: `x' OR filePath LIKE '%` renders the well-formed predicate
			// `filePath = 'x' OR filePath LIKE '%'`, which matches every row —
			// so a delete aimed at one file empties the table. Equality, so the
			// escape is quote doubling only (`escapeSqlLiteral`); the LIKE
			// escaper would break ordinary `my_file.ts` paths instead.
			await table.delete(`filePath = '${escapeSqlLiteral(filePath)}'`);
			return 1;
		} catch {
			return 0;
		}
	}

	/**
	 * Get all documents for a specific file
	 */
	async getDocumentsByFile(
		filePath: string,
		documentTypes?: DocumentType[],
	): Promise<BaseDocument[]> {
		const table = await this.ensureTableOpen();
		if (!table) {
			return [];
		}

		try {
			// Same raw interpolation as `deleteAllByFile` had: a quote in the
			// path made LanceDB reject the statement (caught below, reported as
			// "no documents"), and a crafted path widened the predicate to every
			// row. Equality, so quote doubling only.
			let filter = `filePath = '${escapeSqlLiteral(filePath)}'`;
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
				filePath: row.filePath || undefined,
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
		if (language) {
			filters.push(`language = '${escapeSqlLiteral(language)}'`);
		}
		if (pathPattern) {
			filters.push(`filePath LIKE '%${escapeFilterValue(pathPattern)}%'`);
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
		const testFileMode = getTestFileMode(this.projectPath);
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
				filePath: r.filePath || undefined,
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
	async addCodeUnits(units: CodeUnitWithEmbedding[]): Promise<void> {
		if (units.length === 0) {
			return;
		}

		const now = new Date().toISOString();
		const data: StoredChunk[] = units.map((unit) => ({
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
		}));

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
				this.db!.createTable(CHUNKS_TABLE, data, { mode: "create" }),
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
	 * Update summary for a code unit (used during bottom-up summarization)
	 */
	async updateUnitSummary(unitId: string, summary: string): Promise<void> {
		const table = await this.ensureTableOpen();
		if (!table) return;

		try {
			// LanceDB update via delete + insert pattern
			// First, get the existing record (equality: quote doubling only)
			const results = await table
				.query()
				.where(`id = '${escapeSqlLiteral(unitId)}'`)
				.toArray();
			if (results.length === 0) return;

			const existing = results[0] as StoredChunk;

			// Delete old record
			await table.delete(`id = '${escapeSqlLiteral(unitId)}'`);

			// Insert updated record (watchdog-wrapped: same native write path).
			//
			// `embedKey` (index v3) is INHERITED here on purpose: this
			// round-trips a row read back from the table and replaces only
			// `summary`, leaving `vector` exactly as it was, so the key still
			// addresses this row's vector. Because the row came from the table,
			// this site can neither introduce the column nor create the table,
			// and so cannot define the schema.
			await withTimeout(
				table.add([{ ...existing, summary }]),
				LANCEDB_WRITE_TIMEOUT_MS,
				"updateUnitSummary:table.add",
			);
		} catch (error) {
			console.warn(`Failed to update summary for unit ${unitId}:`, error);
		}
	}

	/**
	 * Update document content and re-embed (used for summary refinement)
	 */
	async updateDocumentContent(
		documentId: string,
		newContent: string,
		newVector: number[],
	): Promise<boolean> {
		const table = await this.ensureTableOpen();
		if (!table) return false;

		try {
			// LanceDB update via delete + insert pattern (equality predicates)
			const results = await table
				.query()
				.where(`id = '${escapeSqlLiteral(documentId)}'`)
				.toArray();
			if (results.length === 0) return false;

			const existing = results[0] as StoredChunk;

			// Delete old record
			await table.delete(`id = '${escapeSqlLiteral(documentId)}'`);

			// Insert updated record with new content and vector
			// (watchdog-wrapped: same native write path).
			//
			// `embedKey` (index v3) is RESET, not inherited. This replaces both
			// `content` and `vector`, so carrying `existing.embedKey` forward
			// would leave a key describing a vector that no longer exists —
			// breaking the one invariant the column has ("when non-empty, the
			// key addresses the vector beside it") and making any hit-rate audit
			// read from it wrong. Harmless today, because documents are written
			// with `embedKey: ""` in the first place; wrong the moment document
			// embeds come inside the caching seam.
			await withTimeout(
				table.add([
					{
						...existing,
						content: newContent,
						vector: newVector,
						embedKey: "",
						enrichedAt: new Date().toISOString(),
					},
				]),
				LANCEDB_WRITE_TIMEOUT_MS,
				"updateDocumentContent:table.add",
			);

			return true;
		} catch (error) {
			console.warn(`Failed to update document ${documentId}:`, error);
			return false;
		}
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
				filePath: row.filePath || undefined,
				fileHash: row.fileHash || undefined,
				createdAt: row.createdAt,
				enrichedAt: row.enrichedAt || undefined,
				sourceIds: row.sourceIds ? JSON.parse(row.sourceIds) : undefined,
				metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
				vector: row.vector,
			}));
		} catch {
			return [];
		}
	}

	/**
	 * Get code units for a file, optionally filtered by unit type
	 */
	async getCodeUnitsByFile(
		filePath: string,
		unitTypes?: UnitType[],
	): Promise<CodeUnit[]> {
		const table = await this.ensureTableOpen();
		if (!table) return [];

		try {
			let filter = `filePath = '${escapeSqlLiteral(filePath)}' AND documentType = 'code_unit'`;
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
		depth: number,
		filePath?: string,
	): Promise<CodeUnit[]> {
		const table = await this.ensureTableOpen();
		if (!table) return [];

		try {
			let filter = `depth = ${depth} AND documentType = 'code_unit'`;
			if (filePath) {
				filter += ` AND filePath = '${escapeSqlLiteral(filePath)}'`;
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
	async getChildUnits(parentId: string): Promise<CodeUnit[]> {
		const table = await this.ensureTableOpen();
		if (!table) return [];

		try {
			const filter = `parentId = '${escapeSqlLiteral(parentId)}' AND documentType = 'code_unit'`;
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
			filters.push(`filePath LIKE '%${escapeFilterValue(filePath)}%'`);
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
		const testFileMode = getTestFileMode(this.projectPath);
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
				filter += ` AND filePath = '${escapeSqlLiteral(filePath)}'`;
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
			filePath: row.filePath,
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
 * Create a vector store for a project
 * @param dbPath - Path to the vector database (e.g., /project/.mnemex/vectors)
 * @param projectPath - Optional explicit project path (derived from dbPath if not provided)
 */
export function createVectorStore(
	dbPath: string,
	projectPath?: string,
): IVectorStore {
	return new VectorStore(dbPath, projectPath);
}
