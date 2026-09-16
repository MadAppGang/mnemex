/**
 * File State Tracker
 *
 * Tracks file states using SQLite for efficient incremental indexing.
 * Uses content hashes and mtimes for fast change detection.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { GitDiffChangeDetector } from "../cloud/git-diff.js";
import type {
	DocProviderType,
	DocumentType,
	EnrichmentState,
	FileState,
	ReferenceKind,
	SymbolDefinition,
	SymbolGraphStats,
	SymbolKind,
	SymbolReference,
} from "../types.js";
import { type PathKind, toRepoRelative } from "./repo-path.js";
import { createDatabaseSync, type SQLiteDatabase } from "./sqlite.js";
import { resolveStoreLocation } from "./store-location.js";
import {
	busyTimeoutPragma,
	clampedBusyTimeoutMs,
	MAX_SYNC_REGION_MS,
	type SyncRegion,
} from "./sync-region.js";

// ============================================================================
// Types
// ============================================================================

export interface ActivityRow {
	id: number;
	type: string;
	metadata: string;
	timestamp: string;
}

export interface FileChanges {
	/** Files that are new (not in index) */
	newFiles: string[];
	/** Files that have been modified */
	modifiedFiles: string[];
	/** Files that have been deleted */
	deletedFiles: string[];
	/** Files that are unchanged */
	unchangedFiles: string[];
}

/** Enrichment state per document type for a file */
export type EnrichmentStateMap = Partial<Record<DocumentType, EnrichmentState>>;

/**
 * The key one enrichment record is filed under (architecture §4.6).
 *
 * BOTH halves are part of the key, and the path half is the correction §4.6
 * needs — see `ENRICHMENT_BY_CONTENT_TABLE_DDL` for the measurement.
 */
export interface EnrichmentContentKey {
	pathKind: PathKind;
	/** The STORED path: repo-relative, POSIX separators, as `chunk_index` holds it. */
	path: string;
	/** sha256 of the FILE CONTENT that was enriched — not of the summary. */
	contentHash: string;
}

/** One summary `enrichment_by_content` remembers, with what adopting it needs. */
export interface EnrichmentRecord {
	documentType: DocumentType;
	/** The LanceDB row id of the summary. */
	summaryId: string;
	state: EnrichmentState;
	/** The chunk ids the summary was derived from, for the `documents` row. */
	sourceIds: string[];
	createdAt: string | null;
	enrichedAt: string;
	/** AUDIT ONLY: the `provider/model` that produced it. Never part of the key. */
	producer: string | null;
}

/** The map key `enrichmentByContent` returns, so a caller can look a key up. */
export function enrichmentContentKeyId(key: EnrichmentContentKey): string {
	return `${key.pathKind}\u0000${key.path}\u0000${key.contentHash}`;
}

/**
 * Which producer wrote a stored row (architecture §3.2.1, §4.1.1's table).
 *
 * The narrow step runs ONCE PER CLASS, each immediately after that class's
 * producer: a class whose producer did not run this pass is not narrowed at
 * all, because narrowing against an empty `newIds` deletes every row the branch
 * has of that class.
 */
export type ChunkRowClass = "code_chunk" | "code_unit" | "document";

/** One `chunk_index` row: what the store holds, independent of branch. */
export interface ChunkIndexRow {
	chunkId: string;
	pathKind: PathKind;
	/** Repo-relative with POSIX separators, or a `docs:<pkg>` synthetic path. */
	path: string;
	/** sha256 of the text that was EMBEDDED for this row (tier 2, §4.1.2). */
	contentHash: string;
	rowClass: ChunkRowClass;
}

/** One `files` stamp, committed inside R5b rather than on its own (§4.1.4). */
export interface FileStamp {
	storedPath: string;
	contentHash: string;
	mtime: number;
	chunkIds: string[];
}

/** R5b's whole payload — see `FileTracker.commitAddBatch`. */
export interface AddBatchCommit {
	/** INSERT ids, with the `chunk_index` row each one registers. */
	registered: ChunkIndexRow[];
	/** INSERT + WIDEN ids: everything this branch now points at. */
	memberIds: string[];
	/** WIDEN ids only: the drain's work (§4.1.3b). */
	widenIds: string[];
	/** The `files` rows this batch stamps. May be empty (a docs or units batch). */
	files: FileStamp[];
	/** The `'add'` intents this batch opened, cleared in the same transaction. */
	clearAddIntentIds: string[];
}

/** Document tracking info */
export interface TrackedDocument {
	id: string;
	documentType: DocumentType;
	filePath: string;
	sourceIds: string[];
	createdAt: string;
	enrichedAt?: string;
}

/**
 * A commit anchor: the SHA plus an orderable ordinal for it.
 *
 * SHAs cannot be compared, so every consumer that needs "which of these facts
 * is newer" reads `ordinal` instead.
 */
export interface CommitProvenance {
	/** Full 40-char commit SHA */
	sha: string;
	/** First-parent depth (`git rev-list --count --first-parent <sha>`) */
	ordinal: number;
	/** Committer date, ISO-8601, or null when unavailable */
	committedAt: string | null;
}

/**
 * Commit provenance recorded against a document.
 *
 * NULL columns mean "provenance unknown" — every row written before commit
 * tracking existed has them. Unknown provenance is CURRENTLY VALID; only an
 * explicit `invalidatedAtCommit` makes a document superseded.
 */
export interface DocumentProvenance {
	/** Commit this document was first written at, or null if unknown */
	validFromCommit: string | null;
	/** Commit that superseded this document, or null if still current */
	invalidatedAtCommit: string | null;
	/** True when the document has not been explicitly invalidated */
	isValid: boolean;
	/** Commit that flagged this document as suspect, or null if not flagged */
	staleAtCommit: string | null;
	/**
	 * True when a source change made this document suspect but it was NOT
	 * superseded. Stale and valid are independent: a stale document is still
	 * returned, it is just no longer trusted blindly.
	 */
	isStale: boolean;
}

/** A document flagged stale but deliberately kept */
export interface StaleDocument {
	id: string;
	documentType: DocumentType;
	filePath: string | null;
	/** Commit that flagged it */
	staleAtCommit: string;
	createdAt: string;
}

/** Validity tallies for one document type */
export interface DocumentStatusCount {
	documentType: DocumentType;
	total: number;
	invalidated: number;
	stale: number;
}

/** State of indexed documentation for a library */
export interface IndexedDocState {
	/** Library name */
	library: string;
	/** Version indexed (e.g., "v18") */
	version: string | null;
	/** Provider used */
	provider: DocProviderType;
	/** Content hash for change detection */
	contentHash: string;
	/** When this was fetched */
	fetchedAt: string;
	/** Chunk IDs stored in vector store */
	chunkIds: string[];
}

// ============================================================================
// IFileTracker Interface
// ============================================================================

/**
 * Interface for file tracker implementations.
 * Allows swapping in alternative storage backends.
 */
export interface IFileTracker {
	/**
	 * EVERY per-branch member takes `branchId` as its FIRST positional
	 * parameter, so a caller that forgets it is a type error rather than a read
	 * that silently spans branches (§4.4.1). The exceptions are named where they
	 * appear: the `indexed_docs` members (external docs are repository-scoped and
	 * carry `branch_id = 0` literally), `clear()` (whole store, reached only
	 * through `rebuildStore`'s producers), and the `commits`/`metadata`/
	 * `activity_log` members, whose tables describe the repository (§3.5).
	 *
	 * The symbol graph is NOT here. Its 24 members live on `BranchScopedGraph`,
	 * reachable only as `graph(branchId)`.
	 */
	getChanges(branchId: number, currentFiles: string[]): FileChanges;
	/**
	 * `branchId` FIRST, so a caller that omits it is a type error rather than a
	 * row written under the wrong branch: the registry's id for the current
	 * HEAD, or `BRANCH_ID_SHARED` in a store with no git layout.
	 */
	markIndexed(
		branchId: number,
		filePath: string,
		contentHash: string,
		chunkIds: string[],
	): void;
	getChunkIds(branchId: number, filePath: string): string[];
	removeFile(branchId: number, filePath: string): void;
	getFileState(branchId: number, filePath: string): FileState | null;
	getAllFiles(branchId: number): FileState[];
	getMetadata(key: string): string | null;
	setMetadata(key: string, value: string): void;
	getStats(branchId: number): {
		totalFiles: number;
		lastIndexed: string | null;
	};
	/** WHOLE STORE. V3.11b's one declared exception; see the method. */
	clear(): void;
	/** §6.1's third upgrade signal: `files` exists and lacks `branch_id`. */
	trackerNeedsV4Schema(): boolean;
	/**
	 * The highest branch id any row carries across `BRANCH_ID_TABLES`, or null
	 * when none does. The branch registry's `nextId` raise reads it.
	 */
	highestBranchId(): number | null;
	/** §3.5.1's DROP + inline CREATE pass, for the v4 upgrade. */
	rebuildTreeScopedSchemaForV4(): void;
	/**
	 * The chunk-membership half of the id algebra (§4.1). `chunk_index` is
	 * branch-INDEPENDENT, so `knownChunkIds` and `findByContentKey` take no
	 * branch id — the row exists once for the store and `chunk_branches` decides
	 * who sees it. Every member that reads or writes membership does take one,
	 * first and positionally.
	 */
	knownChunkRows(chunkIds: string[]): Map<string, string>;
	findByContentKey(
		pathKind: PathKind,
		path: string,
		contentHashes: string[],
	): Map<string, string>;
	chunkIdsForPath(
		branchId: number,
		pathKind: PathKind,
		path: string,
		rowClass?: ChunkRowClass,
	): Array<{ chunkId: string; rowClass: ChunkRowClass }>;
	beginAddIntents(branchId: number, chunkIds: string[]): void;
	commitAddBatch(branchId: number, batch: AddBatchCommit): void;
	membershipsOf(
		chunkIds: string[],
		excludeBranchId?: number,
	): Map<string, number[]>;
	beginRemoveIntents(branchId: number, chunkIds: string[]): void;
	finishNarrowBatch(
		branchId: number,
		chunkIds: string[],
		orphanIds: string[],
	): void;
	takeWidenIntents(limit: number): string[];
	clearWidenIntents(chunkIds: string[]): void;
	countWidenIntents(): number;
	/**
	 * The §4.3 sweep's S0: one page of a tombstoned branch's membership, in
	 * `chunk_id` order, starting strictly above `afterChunkId`.
	 */
	membershipPage(
		branchId: number,
		afterChunkId: string,
		limit: number,
	): string[];
	/** `count(*) FROM chunk_branches WHERE branch_id = ?` — rule C's proof. */
	countMembership(branchId: number): number;
	/** Every branch id that holds at least one row, with its row count. */
	membershipCounts(): Map<number, number>;
	/**
	 * Delete up to `limit` rows PER TABLE from the five tree-scoped tables for
	 * one branch, returning what each one removed. The caller loops until every
	 * count is 0, yielding between calls (SR-2).
	 */
	deleteBranchTreeRows(
		branchId: number,
		limit: number,
	): Record<TreeScopedTable, number>;
	/** Rows each tree-scoped table holds for one branch. For `mnemex branches`. */
	countBranchTreeRows(branchId: number): Record<TreeScopedTable, number>;
	pendingIntents(
		kind: "add" | "remove",
		limit: number,
	): Array<{ chunkId: string; branchId: number }>;
	clearAddIntents(chunkIds: string[]): void;
	recordActivity(type: string, metadata: Record<string, unknown>): number;
	getActivity(sinceId?: number, limit?: number): ActivityRow[];
	pruneActivity(keepCount?: number): void;
	close(): void;
	getDatabase(): SQLiteDatabase;
	getEnrichmentState(branchId: number, filePath: string): EnrichmentStateMap;
	setEnrichmentState(
		branchId: number,
		filePath: string,
		documentType: DocumentType,
		state: EnrichmentState,
	): void;
	setAllEnrichmentStates(
		branchId: number,
		filePath: string,
		states: EnrichmentStateMap,
	): void;
	resetEnrichmentState(branchId: number, filePath: string): void;
	needsEnrichment(
		branchId: number,
		filePath: string,
		documentType: DocumentType,
	): boolean;
	getFilesNeedingEnrichment(
		branchId: number,
		documentType: DocumentType,
	): string[];
	/**
	 * §4.6's reuse table. NO `branchId`, and that is the point: a summary is a
	 * function of the text it was derived from, so the record exists once for
	 * the store and `chunk_branches` decides who can see the row it names. The
	 * same shape and the same reason as `knownChunkRows` / `findByContentKey`.
	 */
	enrichmentByContent(
		keys: readonly EnrichmentContentKey[],
	): Map<string, EnrichmentRecord[]>;
	recordEnrichmentByContent(
		key: EnrichmentContentKey,
		records: readonly EnrichmentRecord[],
	): void;
	trackDocument(branchId: number, doc: TrackedDocument): void;
	trackDocuments(branchId: number, docs: TrackedDocument[]): void;
	getDocumentsForFile(branchId: number, filePath: string): TrackedDocument[];
	getDocumentsByType(
		branchId: number,
		documentType: DocumentType,
	): TrackedDocument[];
	deleteDocumentsForFile(branchId: number, filePath: string): void;
	deleteDocumentsByType(branchId: number, documentType: DocumentType): void;
	getDocumentCounts(branchId: number): Record<DocumentType, number>;
	markDocsIndexed(
		library: string,
		version: string | null,
		provider: DocProviderType,
		contentHash: string,
		chunkIds: string[],
	): void;
	needsDocsRefresh(
		library: string,
		version?: string,
		maxAgeMs?: number,
	): boolean;
	getDocsState(library: string, version?: string): IndexedDocState | null;
	getAllIndexedDocs(): IndexedDocState[];
	getDocsChunkIds(library: string, version?: string): string[];
	deleteIndexedDocs(library: string, version?: string): void;
	clearAllIndexedDocs(): void;
	getIndexedDocsStats(): {
		totalLibraries: number;
		totalChunks: number;
		byProvider: Record<DocProviderType, number>;
		oldestFetch: string | null;
		newestFetch: string | null;
	};
	/** The symbol graph, through one branch. See `BranchScopedGraph`. */
	graph(branchId: number): BranchScopedGraph;
	recordCommit(sha: string, ordinal: number, committedAt?: string | null): void;
	getCommitOrdinal(sha: string): number | null;
	recordHeadCommit(): Promise<CommitProvenance | null>;
	setCurrentCommit(sha: string | null): void;
	getCurrentCommit(): string | null;
	setFileIndexedCommit(
		branchId: number,
		filePath: string,
		sha: string | null,
	): void;
	getFileIndexedCommit(branchId: number, filePath: string): string | null;
	setDocumentsValidFromCommit(
		branchId: number,
		documentIds: string[],
		sha: string | null,
	): void;
	getDocumentProvenance(
		branchId: number,
		documentId: string,
	): DocumentProvenance | null;
	markDocumentsInvalidated(
		branchId: number,
		filePaths: string[],
		documentTypes: DocumentType[],
		sha: string,
	): number;
	markDocumentsStale(
		branchId: number,
		filePaths: string[],
		documentTypes: DocumentType[],
		sha: string,
	): number;
	clearDocumentsStale(branchId: number, documentIds: string[]): number;
	countDocumentsForPaths(
		branchId: number,
		filePaths: string[],
		documentTypes: DocumentType[],
	): number;
	queueReEnrichment(
		branchId: number,
		filePaths: string[],
		documentTypes: DocumentType[],
	): number;
	getStaleDocuments(branchId: number, limit?: number): StaleDocument[];
	getDocumentStatusCounts(branchId: number): DocumentStatusCount[];
}

// ============================================================================
// Commit Provenance Helpers
// ============================================================================

/**
 * Resolve the HEAD commit of a project into a recordable anchor.
 *
 * Shells out through the existing GitDiffChangeDetector — there is exactly one
 * place in this codebase that runs git subprocesses, and this is not a second
 * one. Costs two subprocess calls, so callers must invoke it ONCE per indexing
 * run and reuse the result, never once per file.
 *
 * Returns null for any failure — no git binary, not a repository, an empty
 * repository with no commits, a detached/corrupt state. Commit provenance is an
 * optional enrichment on the index; its absence must never make indexing fail.
 */
export async function resolveHeadCommit(
	projectPath: string,
): Promise<CommitProvenance | null> {
	try {
		const detector = new GitDiffChangeDetector(projectPath);

		const sha = await detector.getHeadSha();
		if (!/^[0-9a-f]{40}$/.test(sha)) {
			return null;
		}

		const ordinal = await detector.getCommitOrdinal(sha);

		// The timestamp is the least important field — losing it must not lose
		// the anchor, which is what actually enables ordering.
		let committedAt: string | null = null;
		try {
			committedAt = (await detector.getCommitTimestamp(sha)) || null;
		} catch {
			committedAt = null;
		}

		return { sha, ordinal, committedAt };
	} catch {
		return null;
	}
}

// ============================================================================
// Per-database schema memo
// ============================================================================

/**
 * Databases whose tracker schema has already been applied in this process,
 * keyed by the sqlite file each connection is attached to.
 *
 * A FileTracker is constructed fresh per MCP tool request — `search_code`
 * builds one on EVERY call even when learning is disabled, because it also
 * records activity — and the constructor's schema pass is unconditional: 5
 * `CREATE TABLE IF NOT EXISTS` + 9 `CREATE INDEX IF NOT EXISTS` + the
 * migration's `PRAGMA table_info` probes and `ALTER TABLE` attempts. Measured
 * warm on this repo over 300 iterations that is ~315 µs against a ~31 µs sqlite
 * open: the dominant cost of opening a tracker, paid unconditionally on the hot
 * path.
 *
 * Every one of those statements is idempotent, so re-running them only ever
 * cost time. Memoizing per database FILE makes the schema pass run at most ONCE
 * per process per database, whatever the connection. Same defect and same fix
 * as `initializedSchemas` in src/learning/feedback/feedback-store.ts — a guard
 * that was per-instance while instances are per-request.
 */
const initializedSchemas = new Set<string>();

/** One row of `PRAGMA database_list`. */
interface DatabaseListRow {
	name?: string;
	file?: string;
}

/** The row `PRAGMA journal_mode` returns, set or read. */
interface JournalModeRow {
	journal_mode?: unknown;
}

function journalModeOf(row: JournalModeRow | undefined): string {
	return typeof row?.journal_mode === "string"
		? row.journal_mode.toLowerCase()
		: "unknown";
}

/**
 * Stable identity of the database a connection is attached to, or null when it
 * has none and therefore must not be memoized.
 *
 * Asks sqlite rather than keying on the `dbPath` the constructor was handed,
 * for two reasons:
 *
 *   - `PRAGMA database_list` reports the CANONICAL path of `main`. Verified
 *     under bun:sqlite: an absolute path, a relative path, and a symlink to the
 *     same file all report one identical string, so alternative spellings share
 *     a single memo entry instead of each re-running the DDL.
 *   - it reports an EMPTY string for in-memory and anonymous databases, for
 *     every spelling (`:memory:`, `""`, `file::memory:`), where matching on
 *     dbPath would have to enumerate them. Each such database is a distinct,
 *     private, empty database that genuinely needs its own schema; memoizing
 *     them would hand the second one an "already done" verdict and an
 *     unschema'd database, which fails later and confusingly.
 *
 * The inode is folded in so that a database deleted and recreated at the same
 * path counts as a different database and gets the schema pass again.
 *
 * Pure over the rows: R0 reads `PRAGMA database_list` inside its region (SR-1)
 * and passes them in, or `null` when that read failed.
 */
function schemaMemoKey(rows: DatabaseListRow[] | null): string | null {
	if (rows === null) {
		// Unknown identity: treat as non-memoizable and re-apply the schema.
		return null;
	}
	const main = rows.find((row) => row.name === "main") ?? rows[0];
	if (typeof main?.file !== "string" || main.file.length === 0) {
		return null;
	}
	const file = main.file;

	try {
		return `${file}:${statSync(file).ino}`;
	} catch {
		// Path is real but unstattable — the path alone still identifies it.
		return file;
	}
}

/**
 * Forget which databases have had the tracker schema applied.
 *
 * For tests, and for any caller that deletes or replaces a database file
 * in-process (the path would otherwise still look initialized).
 */
export function resetTrackerSchemaCache(): void {
	initializedSchemas.clear();
}

/**
 * Forget ONE database's schema memo, so any `FileTracker` constructed later in
 * this process re-runs the ordinary pass against the shape the database has
 * NOW. `rebuildTreeScopedSchemaForV4` calls it before its COMMIT (N30): a
 * long-lived MCP server that upgrades a store must not go on trusting a memo
 * taken against the old tables.
 */
function forgetTrackerSchema(memoKey: string | null): void {
	if (memoKey !== null) initializedSchemas.delete(memoKey);
}

/**
 * Delete a `-wal`/`-shm` pair whose database file is GONE.
 *
 * Such a pair belongs to a deleted database. A new database opened at the same
 * path attaches to that dead write-ahead log, and while any connection to the
 * old file is still alive it shares the old wal-index outright. bun's
 * `close()` with unfinalized statements leaves exactly such a connection
 * behind until a GC finalizes them (measured: it blocks `journal_mode =
 * DELETE` until `Bun.gc(true)`). Under the rollback journal the tracker used
 * before WAL, `rm .mnemex/index.db` was a clean reset; this keeps it one.
 *
 * ONLY when the main file is absent. Beside a live database its sidecars are
 * live state, and deleting them would lose committed transactions.
 */
function removeOrphanedWalSidecars(dbPath: string): void {
	if (dbPath === "" || dbPath === ":memory:" || dbPath.startsWith("file:")) {
		return;
	}
	if (existsSync(dbPath)) return;
	for (const sidecar of [`${dbPath}-wal`, `${dbPath}-shm`]) {
		rmSync(sidecar, { force: true });
	}
}

// ============================================================================
// Schema DDL — issued ONLY inside region R0 (see TRACKER_REGIONS)
// ============================================================================

/*
 * ONE STATEMENT PER ELEMENT, and R0 execs them one at a time — never as a
 * batch. Measured on bun:sqlite (bun 1.4.0), each under another connection's
 * write lock: a multi-statement `exec` whose statement returns SQLITE_BUSY does
 * NOT stop. It carries on to the next statement, and the BUSY is lost —
 *
 *   exec("CREATE TABLE a (x); SELECT 1;")            no throw, `a` NOT created
 *   exec("CREATE TABLE a (x); CREATE TABLE b (y);
 *         CREATE INDEX ib ON b(y);")                 "no such table: main.b"
 *
 * — where better-sqlite3 throws SQLITE_BUSY in both cases. A batched schema
 * pass under contention could therefore report SUCCESS over a half-created
 * schema, which the memo would then mark done, or fail with an error that does
 * not say "busy" and that no region can classify. One statement per `exec`
 * surfaces the BUSY itself. Each element is one term in R0's count.
 */

/**
 * `files` at index version 4 (architecture §3.5). `branch_id` holds the branch
 * registry's REAL id for the HEAD that wrote the row, or `BRANCH_ID_SHARED`
 * (0) in a store with no git layout. There is no placeholder value (decision
 * I-10). The primary key is `(branch_id, path)`: under `(path)` a second
 * branch's row would REPLACE the first's.
 *
 * `CREATE TABLE IF NOT EXISTS` does nothing against a pre-v4 `files`, and no
 * `ALTER` can change a primary key, so a v3 database reaches this shape only
 * through `rebuildTreeScopedSchemaForV4` (§3.5.1).
 */
const FILES_TABLE_DDL = `CREATE TABLE IF NOT EXISTS files (
	branch_id INTEGER NOT NULL,
	path TEXT NOT NULL,
	content_hash TEXT NOT NULL,
	mtime REAL NOT NULL,
	chunk_ids TEXT NOT NULL,
	indexed_at TEXT NOT NULL,
	enrichment_state TEXT DEFAULT '{}',
	enriched_at TEXT,
	-- Commit this file was last indexed at. NULL = provenance unknown.
	indexed_at_commit TEXT,
	PRIMARY KEY (branch_id, path)
)`;

const METADATA_TABLE_DDL = `CREATE TABLE IF NOT EXISTS metadata (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
)`;

/**
 * v4: `(branch_id, id)`.
 *
 * A document id is CONTENT-DERIVED (`<sha of filePath>:<documentType>` and
 * friends), so the same file summarised on two branches produces the SAME id —
 * I-12 Ruling 1's first case. Under a single-column key the second branch's
 * `INSERT OR REPLACE` would silently overwrite the first's row.
 *
 * Ruling 1's other half binds here: EVERY statement touching this table is
 * scoped in the same change. Without that, `WHERE id = ?` becomes a table scan,
 * and two such statements (`setDocumentsValidFromCommit`, `clearDocumentsStale`)
 * run N times inside ONE `BEGIN IMMEDIATE` — a heartbeat hazard (3a-2's D-a,
 * reason 2).
 */
const DOCUMENTS_TABLE_DDL = `CREATE TABLE IF NOT EXISTS documents (
	branch_id INTEGER NOT NULL,
	id TEXT NOT NULL,
	document_type TEXT NOT NULL,
	file_path TEXT,
	source_ids TEXT NOT NULL DEFAULT '[]',
	created_at TEXT NOT NULL,
	enriched_at TEXT,
	-- Bi-temporal validity. Both NULL = provenance unknown, which means
	-- CURRENTLY VALID: only a non-NULL invalidated_at_commit supersedes a
	-- document. Facts are superseded, never deleted.
	valid_from_commit TEXT,
	invalidated_at_commit TEXT,
	-- Commit that made this document SUSPECT without superseding it.
	--
	-- Only ever set on OBSERVED documents (session observations, project
	-- docs): they cannot be re-derived from source, so a source change is
	-- evidence that they may be wrong, never proof. Auto-invalidating them
	-- would destroy a human/agent observation that no pipeline can
	-- regenerate. NULL = not flagged. See src/core/invalidation.ts.
	stale_at_commit TEXT,
	PRIMARY KEY (branch_id, id)
)`;

/**
 * v4: a `branch_id` column, and the key is UNCHANGED.
 *
 * REPORTED, because this table fits NEITHER of I-12 Ruling 1's two named cases
 * (it has no content-derived id that repeats across branches, and no
 * AUTOINCREMENT surrogate) — its key is the natural, content-derived triple
 * `(library, version, provider)`.
 *
 * What settles it is that the design states this table's end state outright
 * (§4.4.1: "`indexed_docs`, id 0 only … no `branchId` parameter — external docs
 * are repository-scoped (§3.2.1). Statements carry `branch_id = 0` literally").
 * Nothing is invented here. And Ruling 1's PRINCIPLE agrees: the composite key
 * exists to stop two branches colliding on one id, and these rows are all
 * written under `BRANCH_ID_SHARED`, so no two branches ever produce the same
 * key. Adding `branch_id` to the key would buy nothing and cost every lookup
 * its plan.
 *
 * The column is still carried, for two reasons: the V3.11b sweep then needs no
 * exception for this table (every statement names `branch_id`), and
 * `highestBranchId()`'s C1 raise reads a uniform shape across `BRANCH_ID_TABLES`.
 */
const INDEXED_DOCS_TABLE_DDL = `CREATE TABLE IF NOT EXISTS indexed_docs (
	branch_id INTEGER NOT NULL,
	library TEXT NOT NULL,
	version TEXT,
	provider TEXT NOT NULL,
	content_hash TEXT NOT NULL,
	fetched_at TEXT NOT NULL,
	chunk_ids TEXT NOT NULL,
	PRIMARY KEY (library, version, provider)
)`;

// Commit anchors for provenance.
//
// `ordinal` is the first-parent depth of the commit
// (`git rev-list --count --first-parent <sha>`). SHAs are not orderable,
// so recency comparisons use the ordinal.
//
// LIMITATION: the ordinal is monotonic and stable only for a history that
// is appended to. It is NOT stable across history rewrites — rebase,
// commit --amend, squash-merge and filter-branch all renumber commits, so
// previously recorded ordinals then refer to commits that no longer
// exist. After a rewrite the index must be rebuilt (`mnemex index
// --force`); there is no in-place repair.
const COMMITS_TABLE_DDL = `CREATE TABLE IF NOT EXISTS commits (
	sha TEXT PRIMARY KEY,
	ordinal INTEGER NOT NULL,
	committed_at TEXT
)`;

/**
 * AUTHORITATIVE branch membership, per stored row (architecture §3.5). The
 * LanceDB `branchIds` string is a DERIVED MIRROR of this table and is always
 * recomputed from it, never patched (U3, §4.1.3a).
 */
const CHUNK_BRANCHES_TABLE_DDL = `CREATE TABLE IF NOT EXISTS chunk_branches (
	chunk_id TEXT NOT NULL,
	branch_id INTEGER NOT NULL,
	PRIMARY KEY (chunk_id, branch_id)
) WITHOUT ROWID`;

/**
 * What the store already holds, INDEPENDENT of branch (architecture §3.5).
 *
 * It carries NO `branch_id`, and that is the design, not an omission: the row
 * it describes exists once for the whole store, and which branches can see it
 * is `chunk_branches`' business. This is why `chunk_index` is not in
 * `BRANCH_ID_TABLES` and not in V3.11b's table lists.
 *
 * `row_class` is what makes code units and enriched summaries go through the
 * same hit test and the same narrow step as code chunks (§3.2.1, §4.1.1 N4);
 * `content_hash` is what makes tier-2 vector reuse possible (§4.1.2).
 */
const CHUNK_INDEX_TABLE_DDL = `CREATE TABLE IF NOT EXISTS chunk_index (
	chunk_id TEXT PRIMARY KEY,
	path_kind TEXT NOT NULL,
	path TEXT NOT NULL,
	content_hash TEXT NOT NULL,
	row_class TEXT NOT NULL
) WITHOUT ROWID`;

/**
 * ENRICHMENT REUSE, keyed on CONTENT (architecture §4.6, decision I-15).
 *
 * WHY IT CARRIES NO `branch_id` — I-15's FOURTH case, stated here because "an
 * exclusion with no stated reason is indistinguishable from an oversight". A
 * row here describes a SUMMARY THAT EXISTS, keyed by the source text it was
 * derived from; which branches can see that summary is `chunk_branches`'
 * business, exactly as for `chunk_index`. So it is out of `BRANCH_ID_TABLES`,
 * out of `trackerNeedsV4Schema`, out of `highestBranchId()` and out of
 * V3.11b's table lists, and it is NOT a tree-scoped table (`TreeScopedTable`):
 * a branch sweep must not delete it, because the row it names may still be
 * held by three other branches.
 *
 * WHERE THIS DEVIATES FROM §4.6's LITERAL DDL, which is
 * `(content_hash PRIMARY KEY, state, summary_id, enriched_at)`. Measured, not
 * assumed — see the implementation log for phase 3b-4:
 *
 *   - `path` is IN THE KEY. §4.6 says enrichment "is a function of file
 *     content, not of which branch happened to be checked out", and the first
 *     half of that is false in this tree: `buildFileSummaryPrompt(filePath,
 *     …)` puts the path in the PROMPT, `buildContent(filePath, response)` puts
 *     it in the stored summary TEXT, and `generateId(content, filePath)` puts
 *     it in the summary's ID. A content-only key therefore hands `src/b.ts`
 *     the summary of an identical `src/a.ts` — a summary that NAMES a
 *     different file, under an id whose `chunk_index` row says `src/a.ts`, so
 *     NARROW_SUMMARIES for `src/b.ts` could never collect it again. Path in
 *     the key is what makes the key cover every input the value depends on,
 *     which is CLAUDE.md #31's rule for a content-addressed cache.
 *   - `summary_id` is in the key rather than a single column: one pass over
 *     one file produces one `file_summary` AND up to 20 `symbol_summary`
 *     documents. One column cannot hold them, and a JSON list would invent an
 *     encoding where a row per summary needs none.
 *   - `source_ids` / `created_at` are carried because ADOPTING a summary has
 *     to reconstruct the `documents` row for the adopting branch without
 *     reading another branch's rows (every `documents` statement is
 *     branch-scoped — V3.11b).
 *   - `producer` is an AUDIT column, deliberately NOT in the key: see
 *     `enrichmentProducer()` in `enricher.ts` for the policy and
 *     the reason it matches today's per-branch behaviour exactly.
 */
const ENRICHMENT_BY_CONTENT_TABLE_DDL = `CREATE TABLE IF NOT EXISTS enrichment_by_content (
	path_kind TEXT NOT NULL,
	path TEXT NOT NULL,
	content_hash TEXT NOT NULL,
	document_type TEXT NOT NULL,
	summary_id TEXT NOT NULL,
	state TEXT NOT NULL,
	source_ids TEXT NOT NULL DEFAULT '[]',
	created_at TEXT,
	enriched_at TEXT NOT NULL,
	producer TEXT,
	PRIMARY KEY (path_kind, path, content_hash, summary_id)
) WITHOUT ROWID`;

/**
 * The crash-recovery journal and the widening backlog (architecture §4.1.4,
 * §4.1.3b).
 *
 * `'add'` and `'remove'` rows exist only between a batch's regions: recovery
 * UNDOES adds and COMPLETES removes. `'widen'` rows are the drain's backlog —
 * committed in the same transaction as the membership they mirror, deleted
 * once the mirror is written, consumed by the drain and never by recovery.
 */
const CHUNK_WRITE_INTENT_TABLE_DDL = `CREATE TABLE IF NOT EXISTS chunk_write_intent (
	chunk_id TEXT NOT NULL,
	branch_id INTEGER NOT NULL,
	kind TEXT NOT NULL CHECK (kind IN ('add','remove','widen')),
	started_at TEXT NOT NULL,
	PRIMARY KEY (chunk_id, kind)
) WITHOUT ROWID`;

const CHUNK_MEMBERSHIP_INDEX_DDL: readonly string[] = [
	"CREATE INDEX IF NOT EXISTS idx_chunk_branches_branch ON chunk_branches(branch_id)",
	"CREATE INDEX IF NOT EXISTS idx_chunk_index_content ON chunk_index(content_hash, path_kind, path)",
	// The NARROW step's work list is derived from THIS index (§4.1.1), never
	// from `files.chunk_ids`, which holds code chunks only.
	"CREATE INDEX IF NOT EXISTS idx_chunk_index_path ON chunk_index(path_kind, path, row_class)",
	/**
	 * NOT in the architecture's DDL, and added deliberately rather than
	 * inherited. The primary key is `(chunk_id, kind)`, so the drain's
	 * `WHERE kind = 'widen' LIMIT 256` (§4.1.3b) is a SCAN of the intent table.
	 * The backlog is the whole repository on a second worktree's first run —
	 * `WIDEN_BUDGET` is 20 000 rows — so that scan would be re-walked once per
	 * 256-id batch, inside a bounded region. One leading-equality index makes
	 * each batch a range read instead. It adds no statement and changes no
	 * semantics.
	 */
	"CREATE INDEX IF NOT EXISTS idx_chunk_write_intent_kind ON chunk_write_intent(kind, chunk_id)",
	/**
	 * `enrichment_by_content`'s primary key leads with `(path_kind, path,
	 * content_hash)`, which is the LOOKUP. This index serves the other
	 * direction: the narrow step deletes records BY SUMMARY ID, and without it
	 * that delete is a full scan of the table inside a bounded region (R-txn)
	 * — a table that grows with every revision of every enriched file.
	 */
	"CREATE INDEX IF NOT EXISTS idx_enrichment_by_content_summary ON enrichment_by_content(summary_id)",
];

const FILES_INDEX_DDL: readonly string[] = [
	"CREATE INDEX IF NOT EXISTS idx_files_content_hash ON files(content_hash)",
	/**
	 * I-12 Ruling 2. Under the `(branch_id, path)` key an UNSCOPED
	 * `WHERE path = ?` is a table scan — measured at 2.5 ms per call over 20 000
	 * rows, against 0.003 ms scoped (~900x). Path-only lookups exist in the END
	 * state, not only as a migration artefact: D1's unknown-branch fallback
	 * drops the branch filter BY DESIGN (§4.4.2), so the scan would be permanent.
	 * `tracker-resolve-plan.test.ts` asserts with EXPLAIN QUERY PLAN that an
	 * unscoped lookup uses this index and a scoped one still uses the key.
	 */
	"CREATE INDEX IF NOT EXISTS idx_files_path ON files(path)",
];

/**
 * INDEXES THAT NAME `branch_id` ARE CONDITIONAL, and that is a migration
 * requirement, not a nicety.
 *
 * `CREATE TABLE IF NOT EXISTS` is a no-op against a PRE-v4 table, so on a v3
 * database the old shape survives R0 — which is the point: §6.1's third upgrade
 * signal is read from an OPEN tracker, and `rebuildTreeScopedSchemaForV4()` is
 * what replaces the shape. But `CREATE INDEX … ON documents(branch_id, …)`
 * against that old table raises `no such column: branch_id` and, inside R0,
 * that FAILS THE OPEN — so the upgrade could never be detected and no store
 * written before this release could ever be read again.
 *
 * So every index whose column list names `branch_id` is issued only when its
 * table actually has the column (`openRegion` probes once per table). The
 * rebuild pass re-issues all of them AFTER its DROP + CREATE, where it always
 * does.
 *
 * `idx_files_content_hash`, `idx_files_path`, `idx_indexed_docs_fetched` and
 * `MIGRATION_INDEXES` name no `branch_id`, so they stay unconditional.
 */
const BRANCH_LEADING_INDEX_DDL: ReadonlyArray<{
	readonly table: (typeof BRANCH_ID_TABLES)[number];
	readonly ddl: string;
}> = [
	{
		table: "documents",
		ddl: "CREATE INDEX IF NOT EXISTS idx_documents_file_path ON documents(branch_id, file_path)",
	},
	{
		table: "documents",
		ddl: "CREATE INDEX IF NOT EXISTS idx_documents_type ON documents(branch_id, document_type)",
	},
	{
		table: "indexed_docs",
		ddl: "CREATE INDEX IF NOT EXISTS idx_indexed_docs_library ON indexed_docs(branch_id, library)",
	},
	{
		table: "symbols",
		ddl: "CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(branch_id, name)",
	},
	{
		table: "symbols",
		ddl: "CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(branch_id, file_path)",
	},
	{
		table: "symbols",
		ddl: "CREATE INDEX IF NOT EXISTS idx_symbols_kind ON symbols(branch_id, kind)",
	},
	{
		table: "symbols",
		ddl: "CREATE INDEX IF NOT EXISTS idx_symbols_pagerank ON symbols(branch_id, pagerank DESC)",
	},
	{
		table: "symbols",
		ddl: "CREATE INDEX IF NOT EXISTS idx_symbols_parent ON symbols(branch_id, parent_id)",
	},
	{
		table: "symbols",
		ddl: "CREATE INDEX IF NOT EXISTS idx_symbols_exported ON symbols(branch_id, is_exported) WHERE is_exported = 1",
	},
	{
		table: "symbol_references",
		ddl: "CREATE INDEX IF NOT EXISTS idx_refs_from ON symbol_references(branch_id, from_symbol_id)",
	},
	{
		table: "symbol_references",
		ddl: "CREATE INDEX IF NOT EXISTS idx_refs_to ON symbol_references(branch_id, to_symbol_id)",
	},
	{
		table: "symbol_references",
		ddl: "CREATE INDEX IF NOT EXISTS idx_refs_to_name ON symbol_references(branch_id, to_symbol_name)",
	},
	{
		table: "symbol_references",
		ddl: "CREATE INDEX IF NOT EXISTS idx_refs_file ON symbol_references(branch_id, file_path)",
	},
	{
		table: "symbol_references",
		ddl: "CREATE INDEX IF NOT EXISTS idx_refs_kind ON symbol_references(branch_id, kind)",
	},
];

/** The tables `openRegion` probes before issuing a branch-leading index. */
const BRANCH_INDEXED_TABLES: ReadonlyArray<(typeof BRANCH_ID_TABLES)[number]> =
	[...new Set(BRANCH_LEADING_INDEX_DDL.map((entry) => entry.table))];

const DOCUMENTS_INDEX_DDL: readonly string[] = [];

const INDEXED_DOCS_INDEX_DDL: readonly string[] = [
	"CREATE INDEX IF NOT EXISTS idx_indexed_docs_fetched ON indexed_docs(fetched_at)",
];

/**
 * The core tables and their indexes: 9 CREATE TABLE + 11 CREATE INDEX.
 *
 * The four membership/reuse tables are NEW in index version 4 and are
 * therefore created by this ordinary pass, as §3.5.1 says ("`chunk_branches` /
 * `chunk_index` / `chunk_write_intent` / `enrichment_by_content` are new
 * tables, so the ordinary constructor pass creates them"). They are not in the
 * §3.5.1 DROP list: no pre-v4 database has them, and dropping them on an
 * upgrade would throw away a journal a crashed run may have left.
 */
const CORE_SCHEMA_DDL: readonly string[] = [
	FILES_TABLE_DDL,
	METADATA_TABLE_DDL,
	DOCUMENTS_TABLE_DDL,
	INDEXED_DOCS_TABLE_DDL,
	COMMITS_TABLE_DDL,
	CHUNK_BRANCHES_TABLE_DDL,
	CHUNK_INDEX_TABLE_DDL,
	CHUNK_WRITE_INTENT_TABLE_DDL,
	ENRICHMENT_BY_CONTENT_TABLE_DDL,
	"CREATE INDEX IF NOT EXISTS idx_commits_ordinal ON commits(ordinal)",
	...FILES_INDEX_DDL,
	...DOCUMENTS_INDEX_DDL,
	...INDEXED_DOCS_INDEX_DDL,
	...CHUNK_MEMBERSHIP_INDEX_DDL,
];

/**
 * The symbol graph's 3 CREATE TABLEs, at index version 4. Its 11 indexes all
 * lead with `branch_id` and therefore live in `BRANCH_LEADING_INDEX_DDL`.
 *
 * This block is the design's member #1, `initializeSymbolGraphSchema` — in this
 * tree the DDL is a constant consumed by the schema pass, not a method, so
 * `BranchScopedGraph` carries the OTHER 24 members of §4.4.1's table and this
 * constant carries the first. It is the V3.11b sweep's one declared exception
 * for these three tables.
 *
 * I-12 Ruling 1, per table:
 *
 * - `symbols` — CONTENT-DERIVED id: `sha256(filePath:name:kind:line)`
 *   (`symbol-extractor.ts`), identical on every branch that has the symbol once
 *   paths are repo-relative. Ruling 1's first case, so `PRIMARY KEY
 *   (branch_id, id)`. Without it `INSERT OR REPLACE` silently overwrites the
 *   other branch's row.
 * - `symbol_references` — SURROGATE id: `INTEGER PRIMARY KEY AUTOINCREMENT`,
 *   already unique table-wide. Ruling 1's second case, so the single-column key
 *   is KEPT and the table gains `branch_id NOT NULL` plus branch-LEADING
 *   secondary indexes. This is 3a-2's finding 1: SQLite assigns rowid aliases
 *   only to a single-column INTEGER PRIMARY KEY, so the design's literal
 *   `(branch_id, id)` would give every inserted reference `id NULL` and
 *   `resolveReference(refId)` would then match nothing.
 * - `graph_metadata` — content-derived key (`pagerank_last_computed`), the same
 *   string on every branch. Ruling 1's first case: `PRIMARY KEY (branch_id, key)`.
 *
 * THE THREE FOREIGN KEYS ARE DROPPED (§3.5.1, N33). `symbols(id)` is no longer
 * a unique single-column key, so a FK that names it is not even declarable; and
 * a cross-branch `ON DELETE CASCADE` is exactly the data loss this phase closes.
 * The `DELETE`s that the cascade covered are issued explicitly already
 * (`deleteSymbolsByFile` deletes references first, "cascade would handle this,
 * but be explicit").
 *
 * Every index leads with `branch_id`, because every statement is now scoped.
 * `idx_symbols_name` becomes `(branch_id, name)`, which is the index I-12
 * Ruling 3 requires `resolveReferencesByName` to keep using — its plan is
 * pinned, with its falsifier, in `tracker-resolve-plan.test.ts`.
 */
const SYMBOL_GRAPH_DDL: readonly string[] = [
	`CREATE TABLE IF NOT EXISTS symbols (
		branch_id INTEGER NOT NULL,
		id TEXT NOT NULL,
		name TEXT NOT NULL,
		kind TEXT NOT NULL,
		file_path TEXT NOT NULL,
		start_line INTEGER NOT NULL,
		end_line INTEGER NOT NULL,
		signature TEXT,
		docstring TEXT,
		parent_id TEXT,
		is_exported INTEGER DEFAULT 0,
		language TEXT NOT NULL,
		pagerank REAL DEFAULT 0.0,
		in_degree INTEGER DEFAULT 0,
		out_degree INTEGER DEFAULT 0,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL,
		PRIMARY KEY (branch_id, id)
	)`,
	`CREATE TABLE IF NOT EXISTS symbol_references (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		branch_id INTEGER NOT NULL,
		from_symbol_id TEXT NOT NULL,
		to_symbol_name TEXT NOT NULL,
		to_symbol_id TEXT,
		kind TEXT NOT NULL,
		file_path TEXT NOT NULL,
		line INTEGER NOT NULL,
		is_resolved INTEGER DEFAULT 0,
		created_at TEXT NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS graph_metadata (
		branch_id INTEGER NOT NULL,
		key TEXT NOT NULL,
		value TEXT NOT NULL,
		updated_at TEXT NOT NULL,
		PRIMARY KEY (branch_id, key)
	)`,
];

/** Activity log (monitor mode): 1 CREATE TABLE + 1 CREATE INDEX. */
const ACTIVITY_LOG_DDL: readonly string[] = [
	`CREATE TABLE IF NOT EXISTS activity_log (
		id        INTEGER PRIMARY KEY AUTOINCREMENT,
		type      TEXT    NOT NULL,
		metadata  TEXT    NOT NULL,
		timestamp TEXT    NOT NULL
	)`,
	"CREATE INDEX IF NOT EXISTS idx_activity_log_id ON activity_log(id)",
];

/** The tables whose columns the migration probes — one `PRAGMA table_info` each. */
const MIGRATED_TABLES = ["files", "documents"] as const;

/**
 * Columns added after their table first shipped. Each is added only when
 * `PRAGMA table_info` shows it missing, so a database written by an older
 * version migrates on the first open by a process that has not seen it.
 */
const COLUMN_MIGRATIONS: ReadonlyArray<{
	readonly table: (typeof MIGRATED_TABLES)[number];
	readonly column: string;
	readonly ddl: string;
}> = [
	{
		table: "files",
		column: "enrichment_state",
		ddl: "ALTER TABLE files ADD COLUMN enrichment_state TEXT DEFAULT '{}'",
	},
	{
		table: "files",
		column: "enriched_at",
		ddl: "ALTER TABLE files ADD COLUMN enriched_at TEXT",
	},
	// Commit provenance. All nullable — every row written before commit
	// tracking existed reads back NULL, which means "provenance unknown" and
	// must be treated as CURRENTLY VALID, never as invalid.
	{
		table: "files",
		column: "indexed_at_commit",
		ddl: "ALTER TABLE files ADD COLUMN indexed_at_commit TEXT",
	},
	{
		table: "documents",
		column: "valid_from_commit",
		ddl: "ALTER TABLE documents ADD COLUMN valid_from_commit TEXT",
	},
	{
		table: "documents",
		column: "invalidated_at_commit",
		ddl: "ALTER TABLE documents ADD COLUMN invalidated_at_commit TEXT",
	},
	{
		table: "documents",
		column: "stale_at_commit",
		ddl: "ALTER TABLE documents ADD COLUMN stale_at_commit TEXT",
	},
];

/**
 * Indexes on migrated columns. Created after the migration rather than in
 * CORE_SCHEMA_DDL: that block is one `exec`, and a CREATE INDEX on a column an
 * older database has not been migrated to yet would abort the whole setup.
 */
const MIGRATION_INDEXES = [
	"CREATE INDEX IF NOT EXISTS idx_documents_stale ON documents(stale_at_commit)",
	"CREATE INDEX IF NOT EXISTS idx_documents_invalidated ON documents(invalidated_at_commit)",
] as const;

// ============================================================================
// Index version 4: branch ids and the §3.5.1 rebuild
// ============================================================================

/**
 * The tables that carry a `branch_id` in this build. The branch registry's
 * `nextId` raise (branch-registry.ts, C1 mechanism 2) reads the highest id
 * from EVERY table listed here, and `tracker-branch-id.test.ts` fails if a
 * table with a `branch_id` column is missing from the list. Leaving one out
 * re-opens C1 for that table.
 *
 * ALL SIX tree-scoped tables, as of Phase 3b-1 (I-12 Ruling 1). 3a-2 carried
 * `files` alone, deliberately: a `branch_id` leading key under UNSCOPED
 * statements makes every path lookup a table scan and takes away the index
 * `resolveReferencesByName`'s plan depends on. 3b-1 changes the DDL TOGETHER
 * with the statements that scope it, which is what makes the other five safe to
 * add. Every statement on these tables now names `branch_id` (swept: V3.11b).
 *
 * `commits`, `metadata` and `activity_log` describe the REPOSITORY, not a tree,
 * and carry no branch id (§3.5). Neither does `chunk_index`: it records which
 * rows the STORE holds, and which branches can see one is `chunk_branches`'
 * business.
 *
 * 3b-2 CLOSES 3a-2's finding 4 — "the raise covers `files` only; LanceDB rows
 * carry branch ids too". It is closed here rather than by reading LanceDB,
 * because these two tables cover every LanceDB row that carries a branch id:
 * `chunk_branches` holds the membership of every REGISTERED row (P1), and
 * `chunk_write_intent` holds the branch of a batch that was appended but not
 * yet registered — which is exactly the window finding 4 describes (the W-R1
 * rename lost AND the run dead between the append and R5b). The store's own
 * `highestBranchId()` is read too; see `Indexer.indexInternal`.
 */
export const BRANCH_ID_TABLES = [
	"files",
	"documents",
	"indexed_docs",
	"symbols",
	"symbol_references",
	"graph_metadata",
	"chunk_branches",
	"chunk_write_intent",
] as const;

/**
 * The tables a BRANCH's sweep reclaims (§4.3, §4.5's `narrowBranch`).
 *
 * `indexed_docs` is in `BRANCH_ID_TABLES` and deliberately NOT here. Its rows
 * are not tree-scoped: they record which external package documentation this
 * STORE has fetched, every statement carries `BRANCH_ID_SHARED` literally
 * (I-13's third case), and no branch id other than 0 can ever appear in it. A
 * per-branch delete would be a no-op on a correct store and would destroy the
 * repository's docs bookkeeping on a corrupt one.
 *
 * The three membership tables are not here either: `chunk_branches` is the
 * sweep's WORK LIST and is emptied by `narrowIds` batch by batch (W1), and
 * `chunk_index`/`chunk_write_intent` describe rows rather than trees.
 */
export const TREE_SCOPED_TABLES = [
	"files",
	"documents",
	"symbols",
	"symbol_references",
	"graph_metadata",
] as const;

export type TreeScopedTable = (typeof TREE_SCOPED_TABLES)[number];

/**
 * Each tree-scoped table's per-branch statements, as LITERALS.
 *
 * Written out rather than interpolated from the table name for the same reason
 * `BRANCH_ID_PROBES` is: a table name assembled at runtime is one refactor away
 * from being a value, and a value in a SQL string is CLAUDE.md #22's trap. The
 * `rowid IN (SELECT … LIMIT ?)` form is how a bounded delete is written in
 * SQLite without `SQLITE_ENABLE_UPDATE_DELETE_LIMIT`; all five of these tables
 * have rowids (only the three membership tables are `WITHOUT ROWID`).
 */
const TREE_SCOPED_STATEMENTS: Readonly<
	Record<
		TreeScopedTable,
		{ readonly deletePage: string; readonly count: string }
	>
> = {
	files: {
		deletePage:
			"DELETE FROM files WHERE rowid IN (SELECT rowid FROM files WHERE branch_id = ? LIMIT ?)",
		count: "SELECT COUNT(*) AS n FROM files WHERE branch_id = ?",
	},
	documents: {
		deletePage:
			"DELETE FROM documents WHERE rowid IN (SELECT rowid FROM documents WHERE branch_id = ? LIMIT ?)",
		count: "SELECT COUNT(*) AS n FROM documents WHERE branch_id = ?",
	},
	symbols: {
		deletePage:
			"DELETE FROM symbols WHERE rowid IN (SELECT rowid FROM symbols WHERE branch_id = ? LIMIT ?)",
		count: "SELECT COUNT(*) AS n FROM symbols WHERE branch_id = ?",
	},
	symbol_references: {
		deletePage:
			"DELETE FROM symbol_references WHERE rowid IN (SELECT rowid FROM symbol_references WHERE branch_id = ? LIMIT ?)",
		count: "SELECT COUNT(*) AS n FROM symbol_references WHERE branch_id = ?",
	},
	graph_metadata: {
		deletePage:
			"DELETE FROM graph_metadata WHERE rowid IN (SELECT rowid FROM graph_metadata WHERE branch_id = ? LIMIT ?)",
		count: "SELECT COUNT(*) AS n FROM graph_metadata WHERE branch_id = ?",
	},
};

/** Each listed table's two probes, written as literals: no interpolated SQL. */
const BRANCH_ID_PROBES: Readonly<
	Record<
		(typeof BRANCH_ID_TABLES)[number],
		{ readonly columns: string; readonly highest: string }
	>
> = {
	files: {
		columns: "PRAGMA table_info(files)",
		highest: "SELECT MAX(branch_id) AS highest FROM files",
	},
	documents: {
		columns: "PRAGMA table_info(documents)",
		highest: "SELECT MAX(branch_id) AS highest FROM documents",
	},
	indexed_docs: {
		columns: "PRAGMA table_info(indexed_docs)",
		highest: "SELECT MAX(branch_id) AS highest FROM indexed_docs",
	},
	symbols: {
		columns: "PRAGMA table_info(symbols)",
		highest: "SELECT MAX(branch_id) AS highest FROM symbols",
	},
	symbol_references: {
		columns: "PRAGMA table_info(symbol_references)",
		highest: "SELECT MAX(branch_id) AS highest FROM symbol_references",
	},
	graph_metadata: {
		columns: "PRAGMA table_info(graph_metadata)",
		highest: "SELECT MAX(branch_id) AS highest FROM graph_metadata",
	},
	chunk_branches: {
		columns: "PRAGMA table_info(chunk_branches)",
		highest: "SELECT MAX(branch_id) AS highest FROM chunk_branches",
	},
	chunk_write_intent: {
		columns: "PRAGMA table_info(chunk_write_intent)",
		highest: "SELECT MAX(branch_id) AS highest FROM chunk_write_intent",
	},
};

/**
 * §3.5.1: the six TREE-scoped tables. `commits`, `metadata` and `activity_log`
 * describe the repository and survive the rebuild. None of the six has an FTS
 * shadow table in this schema.
 */
const TREE_SCOPED_DROP_DDL: readonly string[] = [
	"DROP TABLE IF EXISTS files",
	"DROP TABLE IF EXISTS documents",
	"DROP TABLE IF EXISTS indexed_docs",
	"DROP TABLE IF EXISTS symbols",
	"DROP TABLE IF EXISTS symbol_references",
	"DROP TABLE IF EXISTS graph_metadata",
];

/**
 * The CREATEs `rebuildTreeScopedSchemaForV4` issues INLINE, after its DROPs and
 * inside the same transaction (N30), rather than leaving them to the ordinary
 * schema pass. That pass is memoized per process, and in a real run it has
 * already run against the OLD tables by the time the rebuild starts. The
 * statements are shared with that pass; issuing them here is what the rebuild
 * owns.
 */
const TREE_SCOPED_CREATE_DDL: readonly string[] = [
	FILES_TABLE_DDL,
	DOCUMENTS_TABLE_DDL,
	INDEXED_DOCS_TABLE_DDL,
	...FILES_INDEX_DDL,
	...DOCUMENTS_INDEX_DDL,
	...INDEXED_DOCS_INDEX_DDL,
	...MIGRATION_INDEXES,
	...SYMBOL_GRAPH_DDL,
	// UNCONDITIONALLY here, unlike in `openRegion`: every one of these tables
	// was just dropped and re-created at the v4 shape three statements ago, so
	// `branch_id` is present by construction.
	...BRANCH_LEADING_INDEX_DDL.map((entry) => entry.ddl),
];

/** A branch id is a safe integer >= 0; 0 is the shared marker. */
function assertBranchId(branchId: number): void {
	if (!Number.isSafeInteger(branchId) || branchId < 0) {
		throw new RangeError(
			`tracker: ${String(branchId)} is not a branch id (a safe integer >= 0)`,
		);
	}
}

// ============================================================================
// Bounded regions — CLAUDE.md #31's bound, on the tracker's own connection
// ============================================================================

/**
 * WHY. Every call through `sqlite.ts` is SYNCHRONOUS, so it blocks the event
 * loop, and `lock.ts`'s `heartbeat` advances only from a 1 s `setInterval` that
 * a blocked loop cannot run. `isLockStale`'s heartbeat rule (10 s) is 30x
 * tighter than its progress rule (300 s), so it is the one that binds. While
 * each worktree owned its own `index.db` nothing else wrote to it. Once the file
 * is shared, another process's write transaction is contention this connection
 * waits on, and an unbounded wait inside the index lock is how a second indexer
 * reclaims a HELD lock (CLAUDE.md #27, #31).
 *
 * HOW. `sync-region.ts`'s mechanism, reused rather than copied. Every statement
 * on this connection runs inside `withRegion()` (SR-1), which sets
 * `busy_timeout` to the region's allowance DIVIDED by its blocking statements
 * before the first one runs and back to 0 after the last, so each region's
 * busy-wait is at most BUSY_TIMEOUT_MS = 250 ms however the contention falls
 * (`sync-region.ts`, THE ARITHMETIC, [1]).
 *
 * THE RESTING VALUE IS 0, and that is a mechanism: a statement that escapes a
 * region and has to wait throws SQLITE_BUSY at once instead of widening the
 * bound in silence. It also overrides better-sqlite3's constructor default of
 * 5 000 ms (`better-sqlite3/lib/database.js`), which `sqlite.ts` never touches —
 * under Node, R0 is the first thing that bounds this connection at all.
 *
 * SR-2. The step from one region's bound to the heartbeat's needs the event
 * loop to run BETWEEN regions. Every public method here is ONE region
 * (`getChanges` is two, separated by file I/O, not by a loop) and none loops
 * over regions; a caller that invokes these methods back to back in a
 * synchronous loop defeats SR-2 and must yield itself. Both invariants are
 * swept statically by `test/unit/core/tracker-regions.test.ts`.
 */

/**
 * Busy-wait this PROCESS may spend on the tracker per window. Once spent, every
 * region's clamp is 0, so a contended statement fails at once.
 *
 * MODULE state on purpose: a `FileTracker` is constructed per MCP request, so
 * a per-instance budget would refill on every request and bound nothing
 * (CLAUDE.md #21). WINDOWED rather than latched like the embed cache's, because
 * the tracker has no degraded tier: a long-lived MCP server that spent its
 * budget once must not fail fast for the rest of its life.
 *
 * The heartbeat bound does NOT rest on this; it rests on the per-region clamp.
 * This decides only when to stop waiting at all.
 */
export const TRACKER_CONTENTION_BUDGET_MS = 1000;

/** How often `TRACKER_CONTENTION_BUDGET_MS` refills. */
export const TRACKER_CONTENTION_WINDOW_MS = 10_000;

export type TrackerRegionName = "R0" | "R1" | "R-read" | "R-write" | "R-txn";

/** What a region does when its bounded wait runs out (architecture §5.3, N7). */
export type OnContention =
	/** Reads: retry once INSIDE the same allowance, then TrackerContendedError. */
	| "retry-once"
	/** Writes: TrackerContendedError. Never skipped, never swallowed. */
	| "fail"
	/** R0: the constructor throws, so no half-initialised tracker is handed out. */
	| "fail-open";

export interface TrackerRegion extends SyncRegion {
	readonly name: TrackerRegionName;
	readonly onContention: OnContention;
	/**
	 * Run the callback inside `BEGIN IMMEDIATE` … `COMMIT`. This is what licenses
	 * a `blockingStatements` of 2 however many statements the callback runs:
	 * BEGIN IMMEDIATE takes the write lock at BEGIN, so only BEGIN and COMMIT can
	 * wait (a WAL commit can contend with a checkpointer). A DEFERRED begin would
	 * let the first write re-contend, and a read-then-write upgrade under WAL
	 * returns SQLITE_BUSY_SNAPSHOT, which busy_timeout does not retry at all.
	 */
	readonly immediateTransaction: boolean;
}

/**
 * R0's blocking statements, counted ONE BY ONE: every statement is its own
 * `exec` in its own autocommit transaction, so each can wait on the busy
 * handler independently. Derived from the arrays below it counts.
 *
 *    2   PRAGMA journal_mode = WAL, and its read-back when the switch is contended
 *    1   PRAGMA database_list — the memo key; measured lock-free, counted anyway
 *   18   CORE_SCHEMA_DDL.length: 9 CREATE TABLE + 9 CREATE INDEX. 3b-2 added the
 *          three membership tables (`chunk_branches`, `chunk_index`,
 *          `chunk_write_intent`) and their four indexes; 3b-4 added
 *          `enrichment_by_content` (§4.6) and its one index; 3b-1 had 9 here
 *    3   SYMBOL_GRAPH_DDL.length — the 3 CREATE TABLEs
 *    2   ACTIVITY_LOG_DDL.length
 *    4   PRAGMA table_info — BRANCH_INDEXED_TABLES
 *   14   BRANCH_LEADING_INDEX_DDL.length, at most: each is issued only when its
 *          table has `branch_id`, and `blockingStatements` is an UPPER BOUND on
 *          what the region can issue, which is what the clamp needs
 *    2   PRAGMA table_info — MIGRATED_TABLES
 *    6   ALTER TABLE, at most — COLUMN_MIGRATIONS
 *    2   MIGRATION_INDEXES
 *   --
 *   54   → floor(250 / 54) = 4 ms per statement; 54 × 4 = 216 ms ≤ BUSY_TIMEOUT_MS
 *
 * The architecture's table says 15 ("the 14 constructor DDL execs + the
 * pragma"). That counted `exec` CALLS; the DDL was then three batched execs
 * carrying 11, 14 and 2 statements. It is now one statement per exec (see
 * CORE_SCHEMA_DDL for the bun defect that forced it), and
 * `tracker-regions.test.ts` counts the statements R0 really issues at the
 * driver seam and pins this number EXACTLY.
 *
 * NOT one BEGIN IMMEDIATE (which would make it 2 + the pragmas): on a schema
 * that is already current every `IF NOT EXISTS` is a no-op that under WAL takes
 * no write lock — measured, it succeeds while another connection holds BEGIN
 * EXCLUSIVE. BEGIN IMMEDIATE takes the write lock unconditionally, so every
 * open of a shared store would queue behind whichever process is writing (V2.8).
 */
const R0_BLOCKING_STATEMENTS =
	2 + // PRAGMA journal_mode = WAL, and its read-back when contended
	1 + // PRAGMA database_list
	CORE_SCHEMA_DDL.length +
	SYMBOL_GRAPH_DDL.length +
	ACTIVITY_LOG_DDL.length +
	BRANCH_INDEXED_TABLES.length +
	BRANCH_LEADING_INDEX_DDL.length +
	MIGRATED_TABLES.length +
	COLUMN_MIGRATIONS.length +
	MIGRATION_INDEXES.length;

/**
 * The tracker's regions. `blockingStatements` is a CLAIM about what the
 * callback runs; changing one invalidates `sync-region.ts`'s arithmetic — redo
 * it.
 *
 *   region    what runs                                   blocking   on contention
 *   R0        WAL pragma, memo key, schema pass           54         fail the open
 *   R1        getChanges' one SELECT over `files`         1          retry once
 *   R-read    n read-only statements (`reads(n)`)         n          retry once
 *   R-write   ONE autocommit write statement              1          fail
 *   R-txn     BEGIN IMMEDIATE, any statements, COMMIT     2          fail
 *
 * The architecture's later write regions (R3, R5a/b, R7, R-recovery) all have
 * R-txn's shape; they get their own names when their tables exist.
 */
export const TRACKER_REGIONS = {
	open: {
		name: "R0",
		blockingStatements: R0_BLOCKING_STATEMENTS,
		onContention: "fail-open",
		immediateTransaction: false,
	},
	changes: {
		name: "R1",
		blockingStatements: 1,
		onContention: "retry-once",
		immediateTransaction: false,
	},
	read: {
		name: "R-read",
		blockingStatements: 1,
		onContention: "retry-once",
		immediateTransaction: false,
	},
	write: {
		name: "R-write",
		blockingStatements: 1,
		onContention: "fail",
		immediateTransaction: false,
	},
	txn: {
		name: "R-txn",
		blockingStatements: 2,
		onContention: "fail",
		immediateTransaction: true,
	},
} as const satisfies Record<string, TrackerRegion>;

/** An R-read that runs `statements` independent SELECTs. */
function reads(statements: number): TrackerRegion {
	return { ...TRACKER_REGIONS.read, blockingStatements: statements };
}

/** A read may run twice (its retry), so it has twice the chances to wait. */
function attemptsFor(region: TrackerRegion): number {
	return region.onContention === "retry-once" ? 2 : 1;
}

/**
 * The per-statement `busy_timeout` a region runs at: `sync-region.ts`'s shared
 * clamp, with a read's retry counted as statements. A read that may run twice
 * is divided by twice as many, which keeps [1] — region busy-wait ≤ 250 ms — a
 * statement about the region INCLUDING its retry, not about each attempt.
 */
export function trackerBusyTimeoutMs(
	region: TrackerRegion,
	contentionUsedMs: number,
): number {
	return clampedBusyTimeoutMs(
		{
			name: region.name,
			blockingStatements: region.blockingStatements * attemptsFor(region),
		},
		TRACKER_CONTENTION_BUDGET_MS,
		contentionUsedMs,
	);
}

/** This process's contention ledger. See TRACKER_CONTENTION_BUDGET_MS. */
const contention = { windowStartedAt: 0, usedMs: 0 };

function contentionUsedMs(now: number): number {
	if (now - contention.windowStartedAt >= TRACKER_CONTENTION_WINDOW_MS) {
		contention.windowStartedAt = now;
		contention.usedMs = 0;
	}
	return contention.usedMs;
}

/**
 * Charge a finished region, with `embed-cache.ts`'s rule: elapsed time beyond
 * MAX_SYNC_REGION_MS (by definition not accounted work), plus the whole
 * allowance whenever a statement actually returned SQLITE_BUSY. It over-charges
 * a BUSY and cannot see a wait that ended in success, which is why nothing
 * about the heartbeat rests on it.
 */
function chargeContention(
	perStatementMs: number,
	statements: number,
	elapsedMs: number,
	hitBusy: boolean,
): void {
	let charge = Math.max(0, elapsedMs - MAX_SYNC_REGION_MS);
	if (hitBusy) charge += perStatementMs * statements;
	contention.usedMs += charge;
}

/** Forget this process's contention. For tests. */
export function resetTrackerContentionBudget(): void {
	contention.windowStartedAt = 0;
	contention.usedMs = 0;
}

/** SQLITE_BUSY in either driver: both set `code`; the message is the fallback. */
function isSqliteBusy(error: unknown): boolean {
	const code = (error as { code?: unknown } | null)?.code;
	if (typeof code === "string" && code.startsWith("SQLITE_BUSY")) return true;
	const message = error instanceof Error ? error.message : String(error);
	return (
		message.includes("SQLITE_BUSY") || message.includes("database is locked")
	);
}

/**
 * A region waited its whole bounded allowance and another process still held
 * the lock.
 *
 * NAMED, and never converted into an empty result. There is no correct
 * fallback for `getChanges`, a `files` upsert or a symbol write, and a read that
 * answered "nothing" under contention would turn a busy store into a silently
 * empty one (architecture §5.3, N7). `withRegion` has no parameter through
 * which a fallback could be passed.
 */
export class TrackerContendedError extends Error {
	readonly region: TrackerRegionName;

	constructor(region: TrackerRegionName, cause: unknown) {
		const detail = cause instanceof Error ? cause.message : String(cause);
		super(
			`tracker region ${region}: the index database stayed locked by another process past the bounded wait (${detail})`,
			{ cause },
		);
		this.name = "TrackerContendedError";
		this.region = region;
	}
}

// ============================================================================
// File Tracker Class
// ============================================================================

export class FileTracker implements IFileTracker {
	private db: SQLiteDatabase;
	/**
	 * What every stored path is relative TO (architecture §3.1): the seam's
	 * `pathRoot` for the start path this tracker was opened with, the worktree
	 * root inside a repository. Resolved here rather than taken from the
	 * caller, so every tracker on a store agrees with the indexer and the
	 * vector store about what a stored path means.
	 */
	private readonly pathRoot: string;
	/**
	 * The start path exactly as the caller spelled it. Used ONLY by
	 * `pathVariants`, to also match an absolute path a writer stored in that
	 * spelling. Never a root for a stored path: that is `pathRoot`.
	 */
	private readonly startPath: string;
	/**
	 * Commit anchor for the current indexing run, set once per run by the
	 * indexer via `recordHeadCommit()` / `setCurrentCommit()`.
	 *
	 * Null means "no commit provenance available" — not a git repo, or the git
	 * call failed. Writes then leave the provenance columns NULL, which reads
	 * as "unknown", which is treated as valid. Provenance is an enrichment; its
	 * absence must never turn indexing into a failure.
	 */
	private currentCommitSha: string | null = null;
	/** See `journalMode`. */
	private journalModeValue = "unknown";
	/** The region executing on this connection, for the nesting guard. */
	private activeRegion: TrackerRegionName | null = null;

	constructor(dbPath: string, startPath: string) {
		// Ensure directory exists
		const dir = dirname(dbPath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}

		this.pathRoot = resolveStoreLocation(startPath).pathRoot;
		this.startPath = startPath;
		removeOrphanedWalSidecars(dbPath);
		this.db = createDatabaseSync(dbPath);
		try {
			this.openRegion();
		} catch (error) {
			// R0 fails the OPEN (architecture §5.3): no half-initialised tracker is
			// ever handed out, and the connection it would have leaked is closed.
			this.db.close();
			throw error;
		}
	}

	/**
	 * The journal mode this connection ended up in: "wal" normally; a rollback
	 * mode ("delete", …) when WAL did not stick — contended at open, or a
	 * filesystem without shared memory; "memory" for an in-memory database.
	 * Under a rollback mode readers DO contend with a writer, and every region is
	 * clamped either way (architecture §3.5.3 item 5).
	 */
	get journalMode(): string {
		return this.journalModeValue;
	}

	/**
	 * THE ONE PLACE a statement may run on this connection (SR-1).
	 *
	 *   1. `busy_timeout` ← the region's divided allowance, BEFORE the first
	 *      statement: pre-flight, never post-hoc (CLAUDE.md #27).
	 *   2. An R-txn runs inside BEGIN IMMEDIATE … COMMIT, rolled back on a throw.
	 *   3. SQLITE_BUSY: a read retries once inside the same allowance; anything
	 *      else, and a read's second BUSY, is a TrackerContendedError.
	 *   4. `busy_timeout` ← 0, the resting value, whatever happened.
	 *
	 * Regions do not nest: an inner region would overwrite the outer's clamp and
	 * then rest it at 0 with the outer's statements still to run. A nested call
	 * is a programming error and throws before it touches the connection.
	 */
	private withRegion<T>(region: TrackerRegion, fn: () => T): T {
		if (this.activeRegion !== null) {
			throw new Error(
				`tracker: region ${region.name} opened inside region ${this.activeRegion}; regions must not nest`,
			);
		}
		const attempts = attemptsFor(region);
		const perStatementMs = trackerBusyTimeoutMs(
			region,
			contentionUsedMs(Date.now()),
		);
		const started = Date.now();
		let hitBusy = false;
		this.activeRegion = region.name;
		try {
			this.db.exec(busyTimeoutPragma(perStatementMs, "tracker"));
			for (let attempt = 1; ; attempt++) {
				try {
					if (!region.immediateTransaction) return fn();
					this.db.exec("BEGIN IMMEDIATE");
					try {
						const result = fn();
						this.db.exec("COMMIT");
						return result;
					} catch (error) {
						try {
							this.db.exec("ROLLBACK");
						} catch {
							// No transaction left to roll back.
						}
						throw error;
					}
				} catch (error) {
					if (!isSqliteBusy(error)) throw error;
					hitBusy = true;
					if (attempt < attempts) continue;
					throw new TrackerContendedError(region.name, error);
				}
			}
		} finally {
			this.activeRegion = null;
			try {
				this.db.exec(busyTimeoutPragma(0, "tracker"));
			} catch {
				// A closed connection: there is nothing left to bound.
			}
			chargeContention(
				perStatementMs,
				region.blockingStatements * attempts,
				Date.now() - started,
				hitBusy,
			);
		}
	}

	/**
	 * R0: WAL, then the schema pass, as ONE region — the constructor is
	 * synchronous and cannot yield between two.
	 *
	 * WAL is set here, on the tracker's own connection, and NEVER in
	 * `sqlite.ts`'s shared opener: the embed cache must set `auto_vacuum` BEFORE
	 * WAL while its header is still empty (`embed-cache.ts`, open step 4), and a
	 * pragma in the shared opener would silently reverse that order (V2.9).
	 * `.get()`, not `.exec()`: the pragma returns the mode it ended in, and a
	 * refusal is visible only in that row.
	 *
	 * The tracker does NOT set `auto_vacuum`. It has no eviction loop, and on a
	 * file whose header already exists the pragma would be a silent no-op; it
	 * could only ever arrive with a version bump that recreates the file.
	 *
	 * The schema pass runs at most once per process per database file
	 * (`initializedSchemas`). What the schema IS is unchanged; only how often it
	 * is issued.
	 */
	private openRegion(): void {
		this.withRegion(TRACKER_REGIONS.open, () => {
			try {
				const row = this.db.prepare("PRAGMA journal_mode = WAL").get() as
					| JournalModeRow
					| undefined;
				this.journalModeValue = journalModeOf(row);
			} catch (error) {
				// Switching a rollback-mode file INTO WAL needs a moment of exclusive
				// access, which another process mid-read denies — measured:
				// SQLITE_BUSY under a concurrent SHARED lock. That is "WAL did not
				// stick THIS time", not a reason to refuse the open: stay in rollback
				// mode, every region still clamped, and the next open tries again
				// (architecture §3.5.3 item 5).
				if (!isSqliteBusy(error)) throw error;
				const row = this.db.prepare("PRAGMA journal_mode").get() as
					| JournalModeRow
					| undefined;
				this.journalModeValue = journalModeOf(row);
			}

			let databaseList: DatabaseListRow[] | null = null;
			try {
				databaseList = this.db
					.prepare("PRAGMA database_list")
					.all() as DatabaseListRow[];
			} catch (error) {
				if (isSqliteBusy(error)) throw error;
			}
			const memoKey = schemaMemoKey(databaseList);
			if (memoKey !== null && initializedSchemas.has(memoKey)) return;

			// One statement per exec — see CORE_SCHEMA_DDL for why never a batch.
			for (const statement of CORE_SCHEMA_DDL) this.db.exec(statement);
			for (const statement of SYMBOL_GRAPH_DDL) this.db.exec(statement);
			for (const statement of ACTIVITY_LOG_DDL) this.db.exec(statement);

			// Branch-leading indexes, ONLY on tables that have the column. See
			// `BRANCH_LEADING_INDEX_DDL`: issuing them unconditionally makes R0
			// throw on a v3 database, and R0 fails the OPEN — so §6.1's upgrade
			// signal could never be read and no pre-v4 store could be recovered.
			const branchIndexed = new Set<string>();
			for (const table of BRANCH_INDEXED_TABLES) {
				const columns = this.db
					.prepare(`PRAGMA table_info(${table})`)
					.all() as Array<{ name: string }>;
				if (columns.some((column) => column.name === "branch_id")) {
					branchIndexed.add(table);
				}
			}
			for (const { table, ddl } of BRANCH_LEADING_INDEX_DDL) {
				if (branchIndexed.has(table)) this.db.exec(ddl);
			}

			// Migration: columns and indexes an older database lacks. Runs for every
			// database this process has not seen before, including one created by
			// an older version — the memo is only consulted above, never used to
			// skip a migration on a first sighting.
			try {
				const present = new Set<string>();
				for (const table of MIGRATED_TABLES) {
					const columns = this.db
						.prepare(`PRAGMA table_info(${table})`)
						.all() as Array<{ name: string }>;
					for (const column of columns) present.add(`${table}.${column.name}`);
				}
				for (const { table, column, ddl } of COLUMN_MIGRATIONS) {
					if (!present.has(`${table}.${column}`)) this.db.exec(ddl);
				}
				for (const ddl of MIGRATION_INDEXES) this.db.exec(ddl);
			} catch (error) {
				// Ignored, as before: a column that already exists is not a failure.
				// SQLITE_BUSY is NOT ignored — swallowing it would mark the schema done
				// and hand out a tracker over a half-migrated file.
				if (isSqliteBusy(error)) throw error;
			}

			if (memoKey !== null) initializedSchemas.add(memoKey);
		});
	}

	/**
	 * A path argument in STORED form. Absolute: repo-relative under `pathRoot`,
	 * or null when it is not under it. Relative: taken AS the stored path. Every
	 * relative path this class is handed came out of the index (`getChanges`'
	 * `deletedFiles`, `getFilesNeedingEnrichment`) or out of git, which is
	 * repo-root relative. It is never re-resolved against the process cwd, which
	 * is what `relative(root, "src/a.ts")` used to do. A null binds as SQL NULL
	 * and matches no row: a path outside the tree is "not tracked", not an error.
	 */
	private storedPath(filePath: string): string | null {
		return isAbsolute(filePath)
			? toRepoRelative(this.pathRoot, filePath)
			: filePath;
	}

	/**
	 * Get changes between current files and indexed state.
	 *
	 * Takes ABSOLUTE paths and compares STORED ones (§3.5.2, N14).
	 * `newFiles`, `modifiedFiles` and `unchangedFiles` echo the caller's paths,
	 * while `deletedFiles` are stored, repo-relative paths. A current file with no
	 * stored path (outside `pathRoot`) is left out of the comparison AND out of
	 * the deletion candidates, so a file outside the tree can never cause a
	 * delete.
	 *
	 * Unscoped by branch in this build: the `{ branchId, pathPrefix }` scope is
	 * Phase 3b's (§3.5.2).
	 */
	getChanges(branchId: number, currentFiles: string[]): FileChanges {
		assertBranchId(branchId);
		const newFiles: string[] = [];
		const modifiedFiles: string[] = [];
		const unchangedFiles: string[] = [];

		// Get all indexed files — R1, one SELECT.
		const indexed = this.withRegion(TRACKER_REGIONS.changes, () =>
			this.db
				.prepare(
					"SELECT branch_id, path, content_hash, mtime FROM files WHERE branch_id = ?",
				)
				.all(branchId),
		) as Array<{
			branch_id: number;
			path: string;
			content_hash: string;
			mtime: number;
		}>;

		// Files whose mtime moved but whose hash did not. Refreshed together in
		// ONE region after the loop — the loop is file I/O and holds no lock —
		// rather than as one autocommit UPDATE per file. Each keeps the branch id
		// of the row it came from, so every UPDATE is a primary-key lookup on
		// `(branch_id, path)`, never a scan of `files` inside the region.
		const mtimeRefreshes: Array<{
			branchId: number;
			path: string;
			mtime: number;
		}> = [];

		const indexedMap = new Map(indexed.map((f) => [f.path, f]));
		// The stored form of every current file, computed once, so the
		// comparison and the deletion candidates cannot disagree about it.
		const currentStored = new Set<string>();

		// Check each current file
		for (const filePath of currentFiles) {
			const storedPath = this.storedPath(filePath);
			if (storedPath === null) continue;
			currentStored.add(storedPath);

			const indexedFile = indexedMap.get(storedPath);
			if (indexedFile === undefined) {
				// New file
				newFiles.push(filePath);
				continue;
			}

			try {
				const stat = statSync(filePath);
				const currentMtime = stat.mtimeMs;

				// Fast path: check mtime first
				if (currentMtime !== indexedFile.mtime) {
					// Mtime changed, verify with hash
					const currentHash = this.computeFileHash(filePath);

					if (currentHash !== indexedFile.content_hash) {
						modifiedFiles.push(filePath);
					} else {
						// Hash same, just update mtime
						mtimeRefreshes.push({
							branchId: indexedFile.branch_id,
							path: storedPath,
							mtime: currentMtime,
						});
						unchangedFiles.push(filePath);
					}
				} else {
					// Mtime unchanged, assume file unchanged
					unchangedFiles.push(filePath);
				}
			} catch {
				// File might have been deleted between listing and checking
				modifiedFiles.push(filePath);
			}
		}

		// Two regions in one synchronous method, and no yield between them: the
		// interface is synchronous. They are separated by file I/O, not by a loop,
		// so this is two regions' worth of blocking, never N.
		if (mtimeRefreshes.length > 0) {
			this.withRegion(TRACKER_REGIONS.txn, () => {
				const stmt = this.db.prepare(
					"UPDATE files SET mtime = ? WHERE branch_id = ? AND path = ?",
				);
				for (const refresh of mtimeRefreshes) {
					stmt.run(refresh.mtime, refresh.branchId, refresh.path);
				}
			});
		}

		// Find deleted files
		const deletedFiles: string[] = [];
		for (const indexedPath of indexedMap.keys()) {
			if (!currentStored.has(indexedPath)) {
				deletedFiles.push(indexedPath);
			}
		}

		return { newFiles, modifiedFiles, deletedFiles, unchangedFiles };
	}

	/**
	 * Mark a file as indexed, under `branchId`: the registry's REAL id for the
	 * HEAD this run indexed, or `BRANCH_ID_SHARED` in a store with no git layout.
	 * Never a placeholder (decision I-10).
	 */
	markIndexed(
		branchId: number,
		filePath: string,
		contentHash: string,
		chunkIds: string[],
	): void {
		assertBranchId(branchId);
		const storedPath = this.storedPath(filePath);
		if (storedPath === null) {
			throw new RangeError(
				`tracker: ${filePath} is outside ${this.pathRoot}, so it has no stored path`,
			);
		}

		let mtime: number;
		try {
			const stat = statSync(
				isAbsolute(filePath) ? filePath : join(this.pathRoot, storedPath),
			);
			mtime = stat.mtimeMs;
		} catch {
			mtime = Date.now();
		}

		this.withRegion(TRACKER_REGIONS.write, () => {
			const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO files (branch_id, path, content_hash, mtime, chunk_ids, indexed_at, indexed_at_commit)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

			stmt.run(
				branchId,
				storedPath,
				contentHash,
				mtime,
				JSON.stringify(chunkIds),
				new Date().toISOString(),
				this.currentCommitSha,
			);
		});
	}

	/**
	 * Get chunk IDs for a file
	 */
	getChunkIds(branchId: number, filePath: string): string[] {
		assertBranchId(branchId);
		const relativePath = this.storedPath(filePath);

		const row = this.withRegion(TRACKER_REGIONS.read, () =>
			this.db
				.prepare("SELECT chunk_ids FROM files WHERE branch_id = ? AND path = ?")
				.get(branchId, relativePath),
		) as { chunk_ids: string } | undefined;

		if (!row) {
			return [];
		}

		try {
			return JSON.parse(row.chunk_ids);
		} catch {
			return [];
		}
	}

	/**
	 * Remove a file from the index
	 */
	removeFile(branchId: number, filePath: string): void {
		assertBranchId(branchId);
		// Absolute or already stored: see `storedPath`.
		const relativePath = this.storedPath(filePath);

		this.withRegion(TRACKER_REGIONS.write, () => {
			this.db
				.prepare("DELETE FROM files WHERE branch_id = ? AND path = ?")
				.run(branchId, relativePath);
		});
	}

	/**
	 * Get file state
	 */
	getFileState(branchId: number, filePath: string): FileState | null {
		assertBranchId(branchId);
		const relativePath = this.storedPath(filePath);

		const row = this.withRegion(TRACKER_REGIONS.read, () =>
			this.db
				.prepare(
					"SELECT path, content_hash, mtime, chunk_ids FROM files WHERE branch_id = ? AND path = ?",
				)
				.get(branchId, relativePath),
		) as
			| {
					path: string;
					content_hash: string;
					mtime: number;
					chunk_ids: string;
			  }
			| undefined;

		if (!row) {
			return null;
		}

		return {
			path: row.path,
			contentHash: row.content_hash,
			mtime: row.mtime,
			chunkIds: JSON.parse(row.chunk_ids),
		};
	}

	/**
	 * Get all indexed files
	 */
	getAllFiles(branchId: number): FileState[] {
		assertBranchId(branchId);
		const rows = this.withRegion(TRACKER_REGIONS.read, () =>
			this.db
				.prepare(
					"SELECT path, content_hash, mtime, chunk_ids FROM files WHERE branch_id = ?",
				)
				.all(branchId),
		) as Array<{
			path: string;
			content_hash: string;
			mtime: number;
			chunk_ids: string;
		}>;

		return rows.map((row) => ({
			path: row.path,
			contentHash: row.content_hash,
			mtime: row.mtime,
			chunkIds: JSON.parse(row.chunk_ids),
		}));
	}

	/**
	 * Get metadata value
	 */
	getMetadata(key: string): string | null {
		const row = this.withRegion(TRACKER_REGIONS.read, () =>
			this.db.prepare("SELECT value FROM metadata WHERE key = ?").get(key),
		) as { value: string } | undefined;
		return row?.value || null;
	}

	/**
	 * Set metadata value
	 */
	setMetadata(key: string, value: string): void {
		this.withRegion(TRACKER_REGIONS.write, () => {
			this.db
				.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)")
				.run(key, value);
		});
	}

	/**
	 * Get statistics
	 */
	getStats(branchId: number): {
		totalFiles: number;
		lastIndexed: string | null;
	} {
		assertBranchId(branchId);
		return this.withRegion(reads(2), () => {
			const countRow = this.db
				.prepare("SELECT COUNT(*) as count FROM files WHERE branch_id = ?")
				.get(branchId) as { count: number };
			const lastRow = this.db
				.prepare(
					"SELECT MAX(indexed_at) as last FROM files WHERE branch_id = ?",
				)
				.get(branchId) as { last: string | null };
			return {
				totalFiles: countRow.count,
				lastIndexed: lastRow.last,
			};
		});
	}

	/**
	 * Clear all data
	 */
	clear(): void {
		// One transaction: a clear another process can observe half-done is a
		// `files` table that no longer agrees with `metadata`.
		//
		// The three membership tables go WITH it. Every caller of `clear()` has
		// just dropped (or is about to drop) the LanceDB table, and a `chunk_index`
		// that survives a cleared dataset breaks P1 for every row in it: the
		// tier-1 hit test would WIDEN ids whose rows no longer exist, so their
		// content would be permanently unsearchable while every probe reported
		// health. A surviving journal would likewise ask recovery to finish a
		// removal against a dataset that no longer has the rows.
		//
		// `enrichment_by_content` goes with them for the same reason (§4.6):
		// every record names a summary ROW, and after a whole-store clear there
		// are none. Adoption re-verifies liveness and would refuse them all, so
		// keeping them would not be a correctness bug — it would be a table of
		// records that can never be used again, growing across rebuilds.
		this.withRegion(TRACKER_REGIONS.txn, () => {
			this.db.exec("DELETE FROM files");
			this.db.exec("DELETE FROM metadata");
			this.db.exec("DELETE FROM documents");
			this.db.exec("DELETE FROM indexed_docs");
			this.db.exec("DELETE FROM chunk_branches");
			this.db.exec("DELETE FROM chunk_index");
			this.db.exec("DELETE FROM chunk_write_intent");
			this.db.exec("DELETE FROM enrichment_by_content");
		});
	}

	// ========================================================================
	// Activity Log Methods (for monitor mode)
	// ========================================================================

	/**
	 * §6.1's third upgrade signal, and the only one that sees the SQLite half:
	 * a table in `BRANCH_ID_TABLES` EXISTS and has no `branch_id`. A table that
	 * does not exist at all is fresh, not outdated, and contributes nothing —
	 * which is what keeps a brand-new database from reporting an upgrade.
	 *
	 * Extended in 3b-1 from `files` alone to every table that now carries the
	 * column. A store written by 3a-2 has `files.branch_id` and no
	 * `symbols.branch_id`; probing `files` alone would call that store current
	 * and leave five tables at the v3 shape, where `INSERT OR REPLACE` silently
	 * overwrites another branch's row.
	 */
	trackerNeedsV4Schema(): boolean {
		return this.withRegion(reads(BRANCH_ID_TABLES.length), () => {
			for (const table of BRANCH_ID_TABLES) {
				const columns = this.db
					.prepare(BRANCH_ID_PROBES[table].columns)
					.all() as Array<{ name?: unknown }>;
				if (columns.length === 0) continue;
				if (!columns.some((column) => column.name === "branch_id")) return true;
			}
			return false;
		});
	}

	/**
	 * The highest branch id any row carries in `BRANCH_ID_TABLES`, or null. The
	 * branch registry raises `nextId` above it on its lock-held open (C1,
	 * mechanism 2), so an id whose allocation was lost cannot be issued to a
	 * second label while a row still carries it. A table without the column (a
	 * pre-v4 `files`) carries no branch id, which is its answer, not an error.
	 */
	highestBranchId(): number | null {
		return this.withRegion(reads(2 * BRANCH_ID_TABLES.length), () => {
			let highest: number | null = null;
			for (const table of BRANCH_ID_TABLES) {
				const probe = BRANCH_ID_PROBES[table];
				const columns = this.db.prepare(probe.columns).all() as Array<{
					name?: unknown;
				}>;
				if (!columns.some((column) => column.name === "branch_id")) continue;
				const row = this.db.prepare(probe.highest).get() as
					| { highest?: unknown }
					| undefined;
				const value = row?.highest;
				if (
					typeof value === "number" &&
					(highest === null || value > highest)
				) {
					highest = value;
				}
			}
			return highest;
		});
	}

	/**
	 * §3.5.1: DROP the six tree-scoped tables and re-issue their CREATEs INLINE,
	 * in ONE immediate transaction (R7's shape; `TRACKER_REGIONS.txn` is the one
	 * transactional region), then forget this database's schema memo before the
	 * COMMIT.
	 *
	 * Why DROP: `CREATE TABLE IF NOT EXISTS` against the old `files` does
	 * nothing, SQLite cannot change a primary key with `ALTER`, and `clear()`'s
	 * `DELETE FROM` keeps the old shape. Adding the column instead leaves the
	 * key at `(path)`, where a second branch's row REPLACES the first's.
	 *
	 * Why the CREATEs are INLINE (N30): the ordinary pass is memoized per
	 * process and, in a real run, has already run against the old tables before
	 * this is called. Relying on it leaves this connection with no `files` table.
	 *
	 * Rows are not copied. Their paths are absolute and their chunk ids are about
	 * to change, and the rebuild that calls this re-indexes them. The
	 * repo-scoped tables (`commits`, `metadata`, `activity_log`) are untouched.
	 */
	rebuildTreeScopedSchemaForV4(): void {
		this.withRegion(TRACKER_REGIONS.txn, () => {
			for (const statement of TREE_SCOPED_DROP_DDL) this.db.exec(statement);
			for (const statement of TREE_SCOPED_CREATE_DDL) this.db.exec(statement);
			const databaseList = this.db
				.prepare("PRAGMA database_list")
				.all() as DatabaseListRow[];
			forgetTrackerSchema(schemaMemoKey(databaseList));
		});
	}

	// ========================================================================
	// Chunk membership — the SQLite half of the id algebra (§4.1, §4.1.3b,
	// §4.1.4). Every method here is ONE region; the LanceDB half and the
	// ordering between the two stores (W1) live in `branch-membership.ts`.
	// ========================================================================

	/**
	 * TIER 1 of the hit test (§4.1.1): for each of `chunkIds` the store already
	 * holds, the CONTENT HASH it holds it at. `chunk_index` is branch-independent
	 * by design — the row exists once and membership decides who sees it — so
	 * this asks nothing about a branch.
	 *
	 * A projection, never a count: a count says how many of 256 ids are present
	 * and never WHICH, and both ways to act on a short count are wrong (§4.1.1).
	 *
	 * THE CONTENT HASH IS RETURNED, NOT JUST THE ID. §4.1.1 defines a tier-1 hit
	 * as "the store already holds this exact row (same path, same LINES, same
	 * CONTENT)", and justifies widening on the id alone by asserting that "chunk
	 * ids are content+position addressed". Since I-14 that holds for BOTH row
	 * classes: `chunker.ts` hashes `filePath:startLine:endLine:content` and
	 * `codeUnitRowId` hashes `filePath:unitType:name:startRow` plus the unit's
	 * content hash. Before I-14 the code-unit half was false — editing a body
	 * without moving its first line left the id at `edc328f7f7d95751` while the
	 * content differed — and this hash was what stopped a branch being handed the
	 * other revision's body.
	 *
	 * It is still returned, as a BELT rather than as the mechanism: a 16-hex id
	 * is 64 bits, and the registration of a rewritten unit is deliberately a
	 * second transaction, so a caller that compares turns both of those into an
	 * in-place refresh instead of a wrong answer. See
	 * `VectorStore.refreshCodeUnits`.
	 */
	knownChunkRows(chunkIds: string[]): Map<string, string> {
		if (chunkIds.length === 0) return new Map();
		const batches = FileTracker.chunk(chunkIds, FileTracker.ID_BATCH_SIZE);
		return this.withRegion(reads(batches.length), () => {
			const known = new Map<string, string>();
			for (const batch of batches) {
				const rows = this.db
					.prepare(
						`SELECT chunk_id, content_hash FROM chunk_index WHERE chunk_id IN (${FileTracker.placeholders(batch.length)})`,
					)
					.all(...batch) as Array<{
					chunk_id: string;
					content_hash: string;
				}>;
				for (const row of rows) known.set(row.chunk_id, row.content_hash);
			}
			return known;
		});
	}

	/**
	 * TIER 2 of the hit test (§4.1.2): one stored id per content hash, for rows
	 * at this exact path. Serves `idx_chunk_index_content`.
	 *
	 * The path is part of the key deliberately. A content match at a DIFFERENT
	 * path is not a vector this row may reuse without also inheriting that
	 * path's line numbers, which is the correctness cost §4.1.2 refuses.
	 */
	findByContentKey(
		pathKind: PathKind,
		path: string,
		contentHashes: string[],
	): Map<string, string> {
		if (contentHashes.length === 0) return new Map();
		const batches = FileTracker.chunk(
			[...new Set(contentHashes)],
			FileTracker.ID_BATCH_SIZE,
		);
		return this.withRegion(reads(batches.length), () => {
			const byHash = new Map<string, string>();
			for (const batch of batches) {
				const rows = this.db
					.prepare(
						`SELECT chunk_id, content_hash FROM chunk_index
						 WHERE path_kind = ? AND path = ?
						   AND content_hash IN (${FileTracker.placeholders(batch.length)})`,
					)
					.all(pathKind, path, ...batch) as Array<{
					chunk_id: string;
					content_hash: string;
				}>;
				for (const row of rows) {
					if (!byHash.has(row.content_hash)) {
						byHash.set(row.content_hash, row.chunk_id);
					}
				}
			}
			return byHash;
		});
	}

	/**
	 * The NARROW step's work list (§4.1.1): the ids THIS BRANCH points at for
	 * one path, per row class. Derived from `chunk_index` joined to
	 * `chunk_branches`, never from `files.chunk_ids` — that column holds code
	 * chunks only, so a `chunk_ids`-driven narrow leaves every code unit and
	 * every enriched summary behind forever (N4). It is DIAGNOSTIC now (§3.5).
	 *
	 * `rowClass` null means every class, which is what `removeFileFromBranch`
	 * needs and what lets it report PER CLASS (3a-2 finding 2).
	 */
	chunkIdsForPath(
		branchId: number,
		pathKind: PathKind,
		path: string,
		rowClass?: ChunkRowClass,
	): Array<{ chunkId: string; rowClass: ChunkRowClass }> {
		assertBranchId(branchId);
		return this.withRegion(TRACKER_REGIONS.read, () => {
			const rows =
				rowClass === undefined
					? (this.db
							.prepare(
								`SELECT ci.chunk_id AS chunk_id, ci.row_class AS row_class
								   FROM chunk_index ci
								   JOIN chunk_branches cb ON cb.chunk_id = ci.chunk_id
								  WHERE cb.branch_id = ? AND ci.path_kind = ? AND ci.path = ?`,
							)
							.all(branchId, pathKind, path) as Array<{
							chunk_id: string;
							row_class: string;
						}>)
					: (this.db
							.prepare(
								`SELECT ci.chunk_id AS chunk_id, ci.row_class AS row_class
								   FROM chunk_index ci
								   JOIN chunk_branches cb ON cb.chunk_id = ci.chunk_id
								  WHERE cb.branch_id = ? AND ci.path_kind = ? AND ci.path = ?
								    AND ci.row_class = ?`,
							)
							.all(branchId, pathKind, path, rowClass) as Array<{
							chunk_id: string;
							row_class: string;
						}>);
			return rows.map((row) => ({
				chunkId: row.chunk_id,
				rowClass: row.row_class as ChunkRowClass,
			}));
		});
	}

	/**
	 * R5a (§4.1.4): the `'add'` intents that bracket an append. Written BEFORE
	 * `table.add`, so a crash anywhere after this leaves a journal row naming
	 * exactly the ids that may have been appended, and the next run's recovery
	 * deletes them.
	 */
	beginAddIntents(branchId: number, chunkIds: string[]): void {
		assertBranchId(branchId);
		if (chunkIds.length === 0) return;
		const startedAt = new Date().toISOString();
		this.withRegion(TRACKER_REGIONS.txn, () => {
			const stmt = this.db.prepare(
				"INSERT OR REPLACE INTO chunk_write_intent (chunk_id, branch_id, kind, started_at) VALUES (?, ?, 'add', ?)",
			);
			for (const chunkId of chunkIds) stmt.run(chunkId, branchId, startedAt);
		});
	}

	/**
	 * R5b (§4.1.4): ONE transaction that registers the appended ids, commits
	 * this branch's membership for the INSERT *and* WIDEN ids, records the
	 * WIDEN ids' drain work, stamps the `files` rows and clears the `'add'`
	 * intents.
	 *
	 * All five in one transaction, and each part is load-bearing:
	 *   - `INSERT OR REPLACE` on `chunk_index` — a DEMOTED id (one the tier-1
	 *     existence check found missing from LanceDB) already has a row, and a
	 *     plain INSERT would abort the run on the primary key, every run
	 *     (§4.1.1);
	 *   - `INSERT OR IGNORE` on `chunk_branches` — a WIDEN id may already be in
	 *     this branch;
	 *   - `INSERT OR IGNORE` on the `'widen'` intents — the mirror is recomputed
	 *     from the chunk's WHOLE membership, so one pending row per chunk is
	 *     enough (§4.1.3b);
	 *   - the `files` stamp rides HERE rather than in `markIndexed`, because
	 *     §4.1.4's W1 clause allows the stamp to precede the mirror only when
	 *     the intent that guarantees the mirror commits beside it. A WIDEN-ONLY
	 *     file still gets its row, which is what stops the next run classifying
	 *     it NEW forever;
	 *   - the `'add'` intents are cleared LAST, in the same transaction, so the
	 *     window recovery has to cover is exactly "appended but not registered".
	 */
	commitAddBatch(branchId: number, batch: AddBatchCommit): void {
		assertBranchId(branchId);
		const startedAt = new Date().toISOString();
		this.withRegion(TRACKER_REGIONS.txn, () => {
			if (batch.registered.length > 0) {
				const stmt = this.db.prepare(
					"INSERT OR REPLACE INTO chunk_index (chunk_id, path_kind, path, content_hash, row_class) VALUES (?, ?, ?, ?, ?)",
				);
				for (const row of batch.registered) {
					stmt.run(
						row.chunkId,
						row.pathKind,
						row.path,
						row.contentHash,
						row.rowClass,
					);
				}
			}
			if (batch.memberIds.length > 0) {
				const stmt = this.db.prepare(
					"INSERT OR IGNORE INTO chunk_branches (chunk_id, branch_id) VALUES (?, ?)",
				);
				for (const chunkId of batch.memberIds) stmt.run(chunkId, branchId);
			}
			if (batch.widenIds.length > 0) {
				const stmt = this.db.prepare(
					"INSERT OR IGNORE INTO chunk_write_intent (chunk_id, branch_id, kind, started_at) VALUES (?, ?, 'widen', ?)",
				);
				for (const chunkId of batch.widenIds) {
					stmt.run(chunkId, branchId, startedAt);
				}
			}
			if (batch.files.length > 0) {
				const stmt = this.db.prepare(
					`INSERT OR REPLACE INTO files (branch_id, path, content_hash, mtime, chunk_ids, indexed_at, indexed_at_commit)
					 VALUES (?, ?, ?, ?, ?, ?, ?)`,
				);
				const indexedAt = new Date().toISOString();
				for (const file of batch.files) {
					stmt.run(
						branchId,
						file.storedPath,
						file.contentHash,
						file.mtime,
						JSON.stringify(file.chunkIds),
						indexedAt,
						this.currentCommitSha,
					);
				}
			}
			if (batch.clearAddIntentIds.length > 0) {
				for (const idBatch of FileTracker.chunk(
					batch.clearAddIntentIds,
					FileTracker.ID_BATCH_SIZE,
				)) {
					this.db
						.prepare(
							`DELETE FROM chunk_write_intent WHERE kind = 'add' AND chunk_id IN (${FileTracker.placeholders(idBatch.length)})`,
						)
						.run(...idBatch);
				}
			}
		});
	}

	/**
	 * Each id's CURRENT membership, as branch ids. The input to every mirror
	 * recomputation (§4.1.3a) and to `narrowIds`' survivor test (§4.1.1 M2).
	 *
	 * `excludeBranchId` answers "who else still points at this row", which is
	 * what decides orphan-vs-narrow. The raw ids are returned rather than a
	 * rendered string: `group_concat` has no defined order and its text
	 * concatenation would sort 10 before 2 (N11), so the ONE renderer
	 * (`canonicalBranchIds`) is applied by the caller, never here.
	 */
	membershipsOf(
		chunkIds: string[],
		excludeBranchId?: number,
	): Map<string, number[]> {
		if (excludeBranchId !== undefined) assertBranchId(excludeBranchId);
		if (chunkIds.length === 0) return new Map();
		const batches = FileTracker.chunk(chunkIds, FileTracker.ID_BATCH_SIZE);
		return this.withRegion(reads(batches.length), () => {
			const byId = new Map<string, number[]>();
			for (const batch of batches) {
				const rows = (
					excludeBranchId === undefined
						? this.db
								.prepare(
									`SELECT chunk_id, branch_id FROM chunk_branches
									  WHERE chunk_id IN (${FileTracker.placeholders(batch.length)})`,
								)
								.all(...batch)
						: this.db
								.prepare(
									`SELECT chunk_id, branch_id FROM chunk_branches
									  WHERE branch_id <> ? AND chunk_id IN (${FileTracker.placeholders(batch.length)})`,
								)
								.all(excludeBranchId, ...batch)
				) as Array<{ chunk_id: string; branch_id: number }>;
				for (const row of rows) {
					const ids = byId.get(row.chunk_id);
					if (ids === undefined) byId.set(row.chunk_id, [row.branch_id]);
					else ids.push(row.branch_id);
				}
			}
			return byId;
		});
	}

	/**
	 * R7 (§4.1.1 M4): ONE transaction that drops this branch's membership for
	 * `chunkIds`, deletes the `chunk_index` rows of the ids that became orphans
	 * (their LanceDB rows are already gone — W1), forgets any `§4.6` enrichment
	 * record naming those orphans, and clears the `'remove'` intents.
	 *
	 * The ONLY `DELETE FROM chunk_index` in `src/` (§3.5, W1's allowlist).
	 */
	finishNarrowBatch(
		branchId: number,
		chunkIds: string[],
		orphanIds: string[],
	): void {
		assertBranchId(branchId);
		if (chunkIds.length === 0) return;
		this.withRegion(TRACKER_REGIONS.txn, () => {
			for (const batch of FileTracker.chunk(
				chunkIds,
				FileTracker.ID_BATCH_SIZE,
			)) {
				this.db
					.prepare(
						`DELETE FROM chunk_branches WHERE branch_id = ? AND chunk_id IN (${FileTracker.placeholders(batch.length)})`,
					)
					.run(branchId, ...batch);
			}
			for (const batch of FileTracker.chunk(
				orphanIds,
				FileTracker.ID_BATCH_SIZE,
			)) {
				this.db
					.prepare(
						`DELETE FROM chunk_index WHERE chunk_id IN (${FileTracker.placeholders(batch.length)})`,
					)
					.run(...batch);
				// §4.6: an enrichment record names a summary ROW. The row behind
				// these ids has just been deleted (no branch pointed at it any
				// more), so the record can never be adopted again — adoption
				// refuses an id `existingIds` does not return. Deleting it here,
				// in the same transaction and in W1's order (LanceDB first, the
				// SQLite state that makes it findable second), is what stops the
				// table growing with every revision of every file ever enriched.
				// Served by `idx_enrichment_by_content_summary`; without that
				// index this is a full scan inside a bounded region.
				this.db
					.prepare(
						`DELETE FROM enrichment_by_content WHERE summary_id IN (${FileTracker.placeholders(batch.length)})`,
					)
					.run(...batch);
			}
			for (const batch of FileTracker.chunk(
				chunkIds,
				FileTracker.ID_BATCH_SIZE,
			)) {
				this.db
					.prepare(
						`DELETE FROM chunk_write_intent WHERE kind = 'remove' AND chunk_id IN (${FileTracker.placeholders(batch.length)})`,
					)
					.run(...batch);
			}
		});
	}

	/** M1 (§4.1.1): the `'remove'` intents that bracket a narrow batch. */
	beginRemoveIntents(branchId: number, chunkIds: string[]): void {
		assertBranchId(branchId);
		if (chunkIds.length === 0) return;
		const startedAt = new Date().toISOString();
		this.withRegion(TRACKER_REGIONS.txn, () => {
			const stmt = this.db.prepare(
				"INSERT OR REPLACE INTO chunk_write_intent (chunk_id, branch_id, kind, started_at) VALUES (?, ?, 'remove', ?)",
			);
			for (const chunkId of chunkIds) stmt.run(chunkId, branchId, startedAt);
		});
	}

	/**
	 * The widening drain's input (§4.1.3b): a bounded slice of the `'widen'`
	 * backlog. A SET of committed rows, not a cursor — an id widened below where
	 * an earlier batch stopped is still a row in the set, so nothing can be
	 * stranded by hash order.
	 */
	takeWidenIntents(limit: number): string[] {
		return this.withRegion(TRACKER_REGIONS.read, () => {
			const rows = this.db
				.prepare(
					"SELECT chunk_id FROM chunk_write_intent WHERE kind = 'widen' ORDER BY chunk_id LIMIT ?",
				)
				.all(limit) as Array<{ chunk_id: string }>;
			return rows.map((row) => row.chunk_id);
		});
	}

	/** The drain's LAST step per batch (§4.1.3b), after the mirror is written. */
	clearWidenIntents(chunkIds: string[]): void {
		if (chunkIds.length === 0) return;
		this.withRegion(TRACKER_REGIONS.txn, () => {
			for (const batch of FileTracker.chunk(
				chunkIds,
				FileTracker.ID_BATCH_SIZE,
			)) {
				this.db
					.prepare(
						`DELETE FROM chunk_write_intent WHERE kind = 'widen' AND chunk_id IN (${FileTracker.placeholders(batch.length)})`,
					)
					.run(...batch);
			}
		});
	}

	/**
	 * `IndexResult.membershipWidenRemaining` (§4.1.3b) — store-wide, because a
	 * search is flagged conservatively while ANOTHER branch's backlog drains.
	 */
	countWidenIntents(): number {
		return this.withRegion(TRACKER_REGIONS.read, () => {
			const row = this.db
				.prepare(
					"SELECT COUNT(*) AS n FROM chunk_write_intent WHERE kind = 'widen'",
				)
				.get() as { n: number };
			return row.n;
		});
	}

	/**
	 * S0 of the §4.3 sweep: one page of a tombstoned branch's membership.
	 *
	 * KEYSET, not OFFSET. The rows in the page are deleted before the next page
	 * is asked for, so an OFFSET would skip exactly as many rows as it had just
	 * removed. `idx_chunk_branches_branch` is `(branch_id)` over a
	 * `WITHOUT ROWID` table keyed `(chunk_id, branch_id)`, so SQLite appends the
	 * key columns and this reads as a range on `(branch_id, chunk_id)` with no
	 * sort — pinned with EXPLAIN QUERY PLAN in `branch-sweep-plan.test.ts`,
	 * because a sort here would re-read the whole branch once per page.
	 */
	membershipPage(
		branchId: number,
		afterChunkId: string,
		limit: number,
	): string[] {
		assertBranchId(branchId);
		return this.withRegion(TRACKER_REGIONS.read, () => {
			const rows = this.db
				.prepare(
					`SELECT chunk_id FROM chunk_branches
					  WHERE branch_id = ? AND chunk_id > ?
					  ORDER BY chunk_id LIMIT ?`,
				)
				.all(branchId, afterChunkId, limit) as Array<{ chunk_id: string }>;
			return rows.map((row) => row.chunk_id);
		});
	}

	/** Rule C's proof: rows still carrying this branch id. */
	countMembership(branchId: number): number {
		assertBranchId(branchId);
		return this.withRegion(TRACKER_REGIONS.read, () => {
			const row = this.db
				.prepare("SELECT COUNT(*) AS n FROM chunk_branches WHERE branch_id = ?")
				.get(branchId) as { n: number };
			return row.n;
		});
	}

	/** Every branch id that holds a row, with its count. `mnemex branches`. */
	membershipCounts(): Map<number, number> {
		return this.withRegion(TRACKER_REGIONS.read, () => {
			const rows = this.db
				.prepare(
					"SELECT branch_id, COUNT(*) AS n FROM chunk_branches GROUP BY branch_id",
				)
				.all() as Array<{ branch_id: number; n: number }>;
			return new Map(rows.map((row) => [row.branch_id, row.n]));
		});
	}

	/**
	 * The §4.3 sweep's tail, and §4.5's: drop up to `limit` rows PER TABLE of
	 * one branch's tree-scoped state.
	 *
	 * ONE region, so one `BEGIN IMMEDIATE` covers all five tables and a reader
	 * never sees a branch whose `symbols` are gone but whose `files` are not.
	 * Bounded per call so the caller can yield between pages (SR-2): a branch
	 * with 20 000 files inside one region is the event-loop block CLAUDE.md #31
	 * exists to prevent.
	 */
	deleteBranchTreeRows(
		branchId: number,
		limit: number,
	): Record<TreeScopedTable, number> {
		assertBranchId(branchId);
		return this.withRegion(TRACKER_REGIONS.txn, () => {
			const deleted = {} as Record<TreeScopedTable, number>;
			for (const table of TREE_SCOPED_TABLES) {
				const result = this.db
					.prepare(TREE_SCOPED_STATEMENTS[table].deletePage)
					.run(branchId, limit);
				deleted[table] = Number(result.changes ?? 0);
			}
			return deleted;
		});
	}

	/** What each tree-scoped table holds for one branch. `mnemex branches`. */
	countBranchTreeRows(branchId: number): Record<TreeScopedTable, number> {
		assertBranchId(branchId);
		return this.withRegion(reads(TREE_SCOPED_TABLES.length), () => {
			const counts = {} as Record<TreeScopedTable, number>;
			for (const table of TREE_SCOPED_TABLES) {
				const row = this.db
					.prepare(TREE_SCOPED_STATEMENTS[table].count)
					.get(branchId) as { n: number };
				counts[table] = row.n;
			}
			return counts;
		});
	}

	/**
	 * Recovery's input (§4.1.4): a bounded slice of the `'add'` or `'remove'`
	 * residue. `'widen'` rows are NOT recovery's — they are the drain's backlog,
	 * and draining them there would bypass the budget.
	 */
	pendingIntents(
		kind: "add" | "remove",
		limit: number,
	): Array<{ chunkId: string; branchId: number }> {
		return this.withRegion(TRACKER_REGIONS.read, () => {
			const rows = this.db
				.prepare(
					"SELECT chunk_id, branch_id FROM chunk_write_intent WHERE kind = ? ORDER BY chunk_id LIMIT ?",
				)
				.all(kind, limit) as Array<{ chunk_id: string; branch_id: number }>;
			return rows.map((row) => ({
				chunkId: row.chunk_id,
				branchId: row.branch_id,
			}));
		});
	}

	/** Recovery's add-undo second half (§4.1.4), after the LanceDB delete. */
	clearAddIntents(chunkIds: string[]): void {
		if (chunkIds.length === 0) return;
		this.withRegion(TRACKER_REGIONS.txn, () => {
			for (const batch of FileTracker.chunk(
				chunkIds,
				FileTracker.ID_BATCH_SIZE,
			)) {
				this.db
					.prepare(
						`DELETE FROM chunk_write_intent WHERE kind = 'add' AND chunk_id IN (${FileTracker.placeholders(batch.length)})`,
					)
					.run(...batch);
			}
		});
	}

	/**
	 * Record a tool activity in the activity_log table.
	 * Returns the inserted row ID.
	 */
	recordActivity(type: string, metadata: Record<string, unknown>): number {
		const result = this.withRegion(TRACKER_REGIONS.write, () =>
			this.db
				.prepare(
					"INSERT INTO activity_log (type, metadata, timestamp) VALUES (?, ?, ?)",
				)
				.run(type, JSON.stringify(metadata), new Date().toISOString()),
		);
		return Number(result.lastInsertRowid);
	}

	/**
	 * Get activity rows with id > sinceId, ordered ASC.
	 * Used by the TUI monitor to poll for new activity.
	 */
	getActivity(sinceId = 0, limit = 50): ActivityRow[] {
		return this.withRegion(TRACKER_REGIONS.read, () =>
			this.db
				.prepare(
					"SELECT id, type, metadata, timestamp FROM activity_log WHERE id > ? ORDER BY id ASC LIMIT ?",
				)
				.all(sinceId, limit),
		) as ActivityRow[];
	}

	/**
	 * Prune old activity rows, keeping only the last keepCount rows.
	 * Called periodically by the TUI to prevent unbounded growth.
	 */
	pruneActivity(keepCount = 200): void {
		// `keepCount` is BOUND, never rendered into the SQL (CLAUDE.md #22).
		this.withRegion(TRACKER_REGIONS.write, () => {
			this.db
				.prepare(
					"DELETE FROM activity_log WHERE id NOT IN (SELECT id FROM activity_log ORDER BY id DESC LIMIT ?)",
				)
				.run(keepCount);
		});
	}

	/**
	 * Close the database connection
	 */
	close(): void {
		this.db.close();
	}

	/**
	 * Get the underlying database instance.
	 * Used for integrations like the learning system.
	 *
	 * Statements run through this handle are OUTSIDE every region: they execute
	 * at the resting busy_timeout of 0, so under contention they fail at once
	 * rather than wait. SR-1 is a property of this file only.
	 */
	getDatabase(): SQLiteDatabase {
		return this.db;
	}

	// ========================================================================
	// Enrichment Tracking Methods
	// ========================================================================

	/**
	 * Get enrichment state for a file
	 */
	getEnrichmentState(branchId: number, filePath: string): EnrichmentStateMap {
		assertBranchId(branchId);
		const relativePath = this.storedPath(filePath);

		const row = this.withRegion(TRACKER_REGIONS.read, () =>
			this.db
				.prepare(
					"SELECT enrichment_state FROM files WHERE branch_id = ? AND path = ?",
				)
				.get(branchId, relativePath),
		) as { enrichment_state: string } | undefined;

		if (!row?.enrichment_state) {
			return {};
		}

		try {
			return JSON.parse(row.enrichment_state);
		} catch {
			return {};
		}
	}

	/**
	 * Set enrichment state for a specific document type
	 */
	setEnrichmentState(
		branchId: number,
		filePath: string,
		documentType: DocumentType,
		state: EnrichmentState,
	): void {
		assertBranchId(branchId);
		const relativePath = this.storedPath(filePath);

		// Read-modify-write in ONE immediate transaction. Two processes that each
		// read the map and wrote their own key back would lose one of the keys;
		// under BEGIN IMMEDIATE the second waits for the first.
		this.withRegion(TRACKER_REGIONS.txn, () => {
			const row = this.db
				.prepare(
					"SELECT enrichment_state FROM files WHERE branch_id = ? AND path = ?",
				)
				.get(branchId, relativePath) as
				| { enrichment_state: string }
				| undefined;
			let current: EnrichmentStateMap = {};
			if (row?.enrichment_state) {
				try {
					current = JSON.parse(row.enrichment_state);
				} catch {
					current = {};
				}
			}
			current[documentType] = state;

			this.db
				.prepare(
					"UPDATE files SET enrichment_state = ?, enriched_at = ? WHERE branch_id = ? AND path = ?",
				)
				.run(
					JSON.stringify(current),
					state === "complete" ? new Date().toISOString() : null,
					branchId,
					relativePath,
				);
		});
	}

	/**
	 * Set all enrichment states for a file at once
	 */
	setAllEnrichmentStates(
		branchId: number,
		filePath: string,
		states: EnrichmentStateMap,
	): void {
		assertBranchId(branchId);
		const relativePath = this.storedPath(filePath);

		const hasComplete = Object.values(states).some((s) => s === "complete");

		this.withRegion(TRACKER_REGIONS.write, () => {
			this.db
				.prepare(
					"UPDATE files SET enrichment_state = ?, enriched_at = ? WHERE branch_id = ? AND path = ?",
				)
				.run(
					JSON.stringify(states),
					hasComplete ? new Date().toISOString() : null,
					branchId,
					relativePath,
				);
		});
	}

	/**
	 * Reset enrichment state for a file (e.g., when file is modified)
	 */
	resetEnrichmentState(branchId: number, filePath: string): void {
		assertBranchId(branchId);
		const relativePath = this.storedPath(filePath);

		this.withRegion(TRACKER_REGIONS.write, () => {
			this.db
				.prepare(
					"UPDATE files SET enrichment_state = '{}', enriched_at = NULL WHERE branch_id = ? AND path = ?",
				)
				.run(branchId, relativePath);
		});
	}

	/**
	 * Check if a file needs enrichment for a specific document type
	 */
	needsEnrichment(
		branchId: number,
		filePath: string,
		documentType: DocumentType,
	): boolean {
		const state = this.getEnrichmentState(branchId, filePath);
		return state[documentType] !== "complete";
	}

	/**
	 * Get all files that need enrichment for a specific document type
	 */
	getFilesNeedingEnrichment(
		branchId: number,
		documentType: DocumentType,
	): string[] {
		assertBranchId(branchId);
		const rows = this.withRegion(TRACKER_REGIONS.read, () =>
			this.db
				.prepare("SELECT path, enrichment_state FROM files WHERE branch_id = ?")
				.all(branchId),
		) as Array<{
			path: string;
			enrichment_state: string;
		}>;

		const needsEnrichment: string[] = [];
		for (const row of rows) {
			try {
				const state = JSON.parse(
					row.enrichment_state || "{}",
				) as EnrichmentStateMap;
				if (state[documentType] !== "complete") {
					needsEnrichment.push(row.path);
				}
			} catch {
				needsEnrichment.push(row.path);
			}
		}

		return needsEnrichment;
	}

	// ========================================================================
	// Enrichment reuse by CONTENT (architecture §4.6, decision I-15)
	// ========================================================================

	/**
	 * What this STORE already holds for each `(path, content)`, whichever branch
	 * paid for it.
	 *
	 * NO `branchId`, for the reason `knownChunkRows` takes none: the record
	 * describes a row that exists once for the store. Adoption is what makes a
	 * branch able to SEE it, and adoption goes through the membership path like
	 * every other row (§4.1.3a).
	 *
	 * The statement filters on `(path_kind, path)` — the primary key's leading
	 * columns — and the content hash is compared here rather than in SQL. A
	 * composite `IN` over three columns is either a cross product (which
	 * over-matches across keys) or a row-value `IN`, whose support differs
	 * between the two SQLite backends this tree runs on. The rows per path are
	 * bounded by the revisions whose summaries are still live, because
	 * `finishNarrowBatch` forgets a record when the row it names is deleted.
	 */
	enrichmentByContent(
		keys: readonly EnrichmentContentKey[],
	): Map<string, EnrichmentRecord[]> {
		const out = new Map<string, EnrichmentRecord[]>();
		if (keys.length === 0) return out;
		const wanted = new Set(keys.map(enrichmentContentKeyId));
		const byKind = new Map<PathKind, string[]>();
		for (const key of keys) {
			const paths = byKind.get(key.pathKind);
			if (paths === undefined) byKind.set(key.pathKind, [key.path]);
			else paths.push(key.path);
		}
		const statements: Array<{ pathKind: PathKind; paths: string[] }> = [];
		for (const [pathKind, paths] of byKind) {
			for (const batch of FileTracker.chunk(
				[...new Set(paths)],
				FileTracker.ID_BATCH_SIZE,
			)) {
				statements.push({ pathKind, paths: batch });
			}
		}
		return this.withRegion(reads(statements.length), () => {
			for (const statement of statements) {
				const rows = this.db
					.prepare(
						`SELECT path, content_hash, document_type, summary_id, state, source_ids, created_at, enriched_at, producer
						   FROM enrichment_by_content
						  WHERE path_kind = ? AND path IN (${FileTracker.placeholders(statement.paths.length)})`,
					)
					.all(statement.pathKind, ...statement.paths) as Array<{
					path: string;
					content_hash: string;
					document_type: string;
					summary_id: string;
					state: string;
					source_ids: string;
					created_at: string | null;
					enriched_at: string;
					producer: string | null;
				}>;
				for (const row of rows) {
					const id = enrichmentContentKeyId({
						pathKind: statement.pathKind,
						path: row.path,
						contentHash: row.content_hash,
					});
					if (!wanted.has(id)) continue;
					let sourceIds: string[] = [];
					try {
						const parsed = JSON.parse(row.source_ids);
						if (Array.isArray(parsed)) sourceIds = parsed.map(String);
					} catch {
						sourceIds = [];
					}
					const record: EnrichmentRecord = {
						documentType: row.document_type as DocumentType,
						summaryId: row.summary_id,
						state: row.state as EnrichmentState,
						sourceIds,
						createdAt: row.created_at,
						enrichedAt: row.enriched_at,
						producer: row.producer,
					};
					const existing = out.get(id);
					if (existing === undefined) out.set(id, [record]);
					else existing.push(record);
				}
			}
			return out;
		});
	}

	/**
	 * Record what one enrichment pass produced for one `(path, content)`.
	 *
	 * `INSERT OR REPLACE`, because re-enriching the same content at the same
	 * path (after a `--force`, or after a failure part-way) must overwrite its
	 * own record rather than abort the run on the primary key — the same reason
	 * `commitAddBatch` registers `chunk_index` rows that way.
	 *
	 * It is NOT the thing that makes a summary reusable: a record whose row
	 * LanceDB no longer holds is refused at adoption (`existingIds`), which is
	 * what keeps this table an optimisation rather than a second source of
	 * truth about what the store contains.
	 */
	recordEnrichmentByContent(
		key: EnrichmentContentKey,
		records: readonly EnrichmentRecord[],
	): void {
		if (records.length === 0) return;
		this.withRegion(TRACKER_REGIONS.txn, () => {
			const stmt = this.db.prepare(
				`INSERT OR REPLACE INTO enrichment_by_content
				 (path_kind, path, content_hash, document_type, summary_id, state, source_ids, created_at, enriched_at, producer)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			);
			for (const record of records) {
				stmt.run(
					key.pathKind,
					key.path,
					key.contentHash,
					record.documentType,
					record.summaryId,
					record.state,
					JSON.stringify(record.sourceIds),
					record.createdAt,
					record.enrichedAt,
					record.producer,
				);
			}
		});
	}

	// ========================================================================
	// Document Tracking Methods
	// ========================================================================

	/**
	 * Track a document in the documents table
	 */
	trackDocument(branchId: number, doc: TrackedDocument): void {
		assertBranchId(branchId);
		this.withRegion(TRACKER_REGIONS.write, () => {
			const stmt = this.db.prepare(`
			INSERT OR REPLACE INTO documents (branch_id, id, document_type, file_path, source_ids, created_at, enriched_at, valid_from_commit)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		`);

			stmt.run(
				branchId,
				doc.id,
				doc.documentType,
				doc.filePath,
				JSON.stringify(doc.sourceIds),
				doc.createdAt,
				doc.enrichedAt || null,
				this.currentCommitSha,
			);
		});
	}

	/**
	 * Track multiple documents at once
	 */
	trackDocuments(branchId: number, docs: TrackedDocument[]): void {
		assertBranchId(branchId);
		if (docs.length === 0) return;

		// ONE immediate transaction for the batch, where there used to be one
		// autocommit INSERT per document: blockingStatements 2, not N.
		this.withRegion(TRACKER_REGIONS.txn, () => {
			const stmt = this.db.prepare(`
			INSERT OR REPLACE INTO documents (branch_id, id, document_type, file_path, source_ids, created_at, enriched_at, valid_from_commit)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		`);

			for (const doc of docs) {
				stmt.run(
					branchId,
					doc.id,
					doc.documentType,
					doc.filePath,
					JSON.stringify(doc.sourceIds),
					doc.createdAt,
					doc.enrichedAt || null,
					this.currentCommitSha,
				);
			}
		});
	}

	/**
	 * Get all tracked documents for a file
	 */
	getDocumentsForFile(branchId: number, filePath: string): TrackedDocument[] {
		assertBranchId(branchId);
		const relativePath = this.storedPath(filePath);

		const rows = this.withRegion(TRACKER_REGIONS.read, () =>
			this.db
				.prepare(
					"SELECT id, document_type, file_path, source_ids, created_at, enriched_at FROM documents WHERE branch_id = ? AND file_path = ?",
				)
				.all(branchId, relativePath),
		) as Array<{
			id: string;
			document_type: string;
			file_path: string;
			source_ids: string;
			created_at: string;
			enriched_at: string | null;
		}>;

		return rows.map((row) => ({
			id: row.id,
			documentType: row.document_type as DocumentType,
			filePath: row.file_path,
			sourceIds: JSON.parse(row.source_ids),
			createdAt: row.created_at,
			enrichedAt: row.enriched_at || undefined,
		}));
	}

	/**
	 * Get all tracked documents of a specific type
	 */
	getDocumentsByType(
		branchId: number,
		documentType: DocumentType,
	): TrackedDocument[] {
		assertBranchId(branchId);
		const rows = this.withRegion(TRACKER_REGIONS.read, () =>
			this.db
				.prepare(
					"SELECT id, document_type, file_path, source_ids, created_at, enriched_at FROM documents WHERE branch_id = ? AND document_type = ?",
				)
				.all(branchId, documentType),
		) as Array<{
			id: string;
			document_type: string;
			file_path: string;
			source_ids: string;
			created_at: string;
			enriched_at: string | null;
		}>;

		return rows.map((row) => ({
			id: row.id,
			documentType: row.document_type as DocumentType,
			filePath: row.file_path,
			sourceIds: JSON.parse(row.source_ids),
			createdAt: row.created_at,
			enrichedAt: row.enriched_at || undefined,
		}));
	}

	/**
	 * Delete all documents for a file
	 */
	deleteDocumentsForFile(branchId: number, filePath: string): void {
		assertBranchId(branchId);
		const relativePath = this.storedPath(filePath);

		this.withRegion(TRACKER_REGIONS.write, () => {
			this.db
				.prepare("DELETE FROM documents WHERE branch_id = ? AND file_path = ?")
				.run(branchId, relativePath);
		});
	}

	/**
	 * Delete documents by type
	 */
	deleteDocumentsByType(branchId: number, documentType: DocumentType): void {
		assertBranchId(branchId);
		this.withRegion(TRACKER_REGIONS.write, () => {
			this.db
				.prepare(
					"DELETE FROM documents WHERE branch_id = ? AND document_type = ?",
				)
				.run(branchId, documentType);
		});
	}

	/**
	 * Get document count by type
	 */
	getDocumentCounts(branchId: number): Record<DocumentType, number> {
		assertBranchId(branchId);
		const rows = this.withRegion(TRACKER_REGIONS.read, () =>
			this.db
				.prepare(
					"SELECT document_type, COUNT(*) as count FROM documents WHERE branch_id = ? GROUP BY document_type",
				)
				.all(branchId),
		) as Array<{ document_type: string; count: number }>;

		const counts: Record<string, number> = {};
		for (const row of rows) {
			counts[row.document_type] = row.count;
		}

		return counts as Record<DocumentType, number>;
	}

	// ========================================================================
	// Commit Provenance Methods
	// ========================================================================

	/**
	 * Record a commit anchor. Idempotent: re-recording the same SHA updates the
	 * ordinal in place rather than inserting a duplicate or throwing.
	 */
	recordCommit(
		sha: string,
		ordinal: number,
		committedAt: string | null = null,
	): void {
		this.withRegion(TRACKER_REGIONS.write, () => {
			const stmt = this.db.prepare(`
			INSERT INTO commits (sha, ordinal, committed_at)
			VALUES (?, ?, ?)
			ON CONFLICT(sha) DO UPDATE SET
				ordinal = excluded.ordinal,
				committed_at = COALESCE(excluded.committed_at, commits.committed_at)
		`);
			stmt.run(sha, ordinal, committedAt);
		});
	}

	/**
	 * Look up the ordinal for a commit SHA.
	 * Returns null when the SHA was never recorded — an unknown commit is not
	 * an error, it just cannot participate in recency comparisons.
	 */
	getCommitOrdinal(sha: string): number | null {
		const row = this.withRegion(TRACKER_REGIONS.read, () =>
			this.db.prepare("SELECT ordinal FROM commits WHERE sha = ?").get(sha),
		) as { ordinal: number } | undefined;
		return row ? row.ordinal : null;
	}

	/**
	 * Resolve HEAD for this project, record it as a commit anchor, and make it
	 * the commit stamped on everything written for the rest of this run.
	 *
	 * Returns null — and changes nothing — when the project is not a git repo
	 * or git fails. Callers must treat that as normal.
	 */
	async recordHeadCommit(): Promise<CommitProvenance | null> {
		const head = await resolveHeadCommit(this.pathRoot);
		if (!head) {
			this.currentCommitSha = null;
			return null;
		}

		this.recordCommit(head.sha, head.ordinal, head.committedAt);
		this.currentCommitSha = head.sha;
		return head;
	}

	/**
	 * Set the commit stamped on subsequent `markIndexed` / `trackDocument(s)`
	 * writes. Pass null to write NULL provenance.
	 */
	setCurrentCommit(sha: string | null): void {
		this.currentCommitSha = sha;
	}

	/** The commit currently being stamped on writes, or null if unknown */
	getCurrentCommit(): string | null {
		return this.currentCommitSha;
	}

	/**
	 * Set `indexed_at_commit` for an already-tracked file.
	 * No-op when the file is not tracked.
	 */
	setFileIndexedCommit(
		branchId: number,
		filePath: string,
		sha: string | null,
	): void {
		assertBranchId(branchId);
		const relativePath = this.storedPath(filePath);

		this.withRegion(TRACKER_REGIONS.write, () => {
			this.db
				.prepare(
					"UPDATE files SET indexed_at_commit = ? WHERE branch_id = ? AND path = ?",
				)
				.run(sha, branchId, relativePath);
		});
	}

	/**
	 * Get the commit a file was indexed at.
	 * Null means either "file not tracked" or "indexed before provenance
	 * existed" — in both cases there is nothing to compare against, never a
	 * reason to hide the file.
	 */
	getFileIndexedCommit(branchId: number, filePath: string): string | null {
		assertBranchId(branchId);
		const relativePath = this.storedPath(filePath);

		const row = this.withRegion(TRACKER_REGIONS.read, () =>
			this.db
				.prepare(
					"SELECT indexed_at_commit FROM files WHERE branch_id = ? AND path = ?",
				)
				.get(branchId, relativePath),
		) as { indexed_at_commit: string | null } | undefined;
		return row?.indexed_at_commit ?? null;
	}

	/**
	 * Set `valid_from_commit` on the given documents.
	 * Unknown IDs are silently ignored.
	 */
	setDocumentsValidFromCommit(
		branchId: number,
		documentIds: string[],
		sha: string | null,
	): void {
		assertBranchId(branchId);
		if (documentIds.length === 0) return;

		// `branch_id = ?` is not only FR-4 here: under the v4 `(branch_id, id)`
		// key an unscoped `WHERE id = ?` is a table scan, and this loop runs N of
		// them inside ONE `BEGIN IMMEDIATE` (3a-2's D-a, reason 2). Scoped, every
		// iteration is a primary-key lookup.
		this.withRegion(TRACKER_REGIONS.txn, () => {
			const stmt = this.db.prepare(
				"UPDATE documents SET valid_from_commit = ? WHERE branch_id = ? AND id = ?",
			);
			for (const id of documentIds) {
				stmt.run(sha, branchId, id);
			}
		});
	}

	/**
	 * Read commit provenance for a document.
	 *
	 * Returns null only when the document does not exist. A document that
	 * exists with NULL provenance is reported as `isValid: true` — unknown
	 * provenance means "we cannot say when this became true", never "this is
	 * false". Encoding it the other way would make every pre-provenance index
	 * silently return nothing.
	 */
	getDocumentProvenance(
		branchId: number,
		documentId: string,
	): DocumentProvenance | null {
		assertBranchId(branchId);
		const row = this.withRegion(TRACKER_REGIONS.read, () =>
			this.db
				.prepare(
					"SELECT valid_from_commit, invalidated_at_commit, stale_at_commit FROM documents WHERE branch_id = ? AND id = ?",
				)
				.get(branchId, documentId),
		) as
			| {
					valid_from_commit: string | null;
					invalidated_at_commit: string | null;
					stale_at_commit: string | null;
			  }
			| undefined;

		if (!row) {
			return null;
		}

		return {
			validFromCommit: row.valid_from_commit ?? null,
			invalidatedAtCommit: row.invalidated_at_commit ?? null,
			isValid: (row.invalidated_at_commit ?? null) === null,
			staleAtCommit: row.stale_at_commit ?? null,
			isStale: (row.stale_at_commit ?? null) !== null,
		};
	}

	// ========================================================================
	// Batched Invalidation Primitives
	// ========================================================================

	/**
	 * How many file paths go into a single batched statement.
	 *
	 * Each path expands to at most two bound parameters (relative + absolute),
	 * so 400 paths is ~800 parameters — comfortably under the 999-parameter
	 * limit of the oldest SQLite builds either backend might link against.
	 *
	 * The point of batching is that a 5000-file commit must not become 5000
	 * UPDATE statements.
	 */
	private static readonly PATH_BATCH_SIZE = 400;

	/**
	 * How many chunk ids go into a single batched membership statement.
	 *
	 * One bound parameter each, plus at most two leading ones, so 256 is well
	 * under the 999-parameter limit of the oldest SQLite builds either backend
	 * might link against. It is also `WRITE_CHUNK` (§4.1.1), so a caller that
	 * batches at the design's size issues exactly one statement per region.
	 */
	private static readonly ID_BATCH_SIZE = 256;

	/**
	 * Both spellings of every path, deduped.
	 *
	 * `documents.file_path` is written by several call sites and is relative in
	 * practice, but nothing in the schema enforces that and the enricher passes
	 * through whatever it was handed. Matching on both spellings costs one extra
	 * bound parameter per path and removes an entire class of silent misses,
	 * where invalidation quietly matches nothing and reports success.
	 */
	private pathVariants(filePaths: string[]): string[] {
		const variants = new Set<string>();

		for (const filePath of filePaths) {
			if (!filePath) continue;
			variants.add(filePath);
			if (isAbsolute(filePath)) {
				const storedPath = toRepoRelative(this.pathRoot, filePath);
				if (storedPath !== null) variants.add(storedPath);
			} else {
				variants.add(join(this.pathRoot, filePath));
				// ALSO the spelling this tracker was opened with. `pathRoot` is the
				// seam's realpath, and a writer that stored an absolute path stored the
				// caller's spelling (`/tmp/x` against `/private/tmp/x`), so one variant
				// alone would miss it. The Set drops the duplicate when they agree.
				variants.add(join(this.startPath, filePath));
			}
		}

		return [...variants];
	}

	private static chunk<T>(items: T[], size: number): T[][] {
		const chunks: T[][] = [];
		for (let i = 0; i < items.length; i += size) {
			chunks.push(items.slice(i, i + size));
		}
		return chunks;
	}

	private static placeholders(count: number): string {
		return new Array(count).fill("?").join(", ");
	}

	/**
	 * Run one batched UPDATE per chunk of paths and return total rows changed.
	 * `buildSql` receives the placeholder lists for types and paths.
	 */
	private updateDocumentsByPath(
		branchId: number,
		filePaths: string[],
		documentTypes: DocumentType[],
		leadingParams: unknown[],
		buildSql: (typePlaceholders: string, pathPlaceholders: string) => string,
	): number {
		assertBranchId(branchId);
		if (filePaths.length === 0 || documentTypes.length === 0) return 0;

		const variants = this.pathVariants(filePaths);
		if (variants.length === 0) return 0;

		// Every batch in ONE immediate transaction: blockingStatements 2 however
		// many batches, and a supersession nobody can observe half-applied.
		return this.withRegion(TRACKER_REGIONS.txn, () => {
			let changed = 0;
			for (const batch of FileTracker.chunk(
				variants,
				FileTracker.PATH_BATCH_SIZE,
			)) {
				const sql = buildSql(
					FileTracker.placeholders(documentTypes.length),
					FileTracker.placeholders(batch.length),
				);
				const result = this.db
					.prepare(sql)
					.run(...leadingParams, branchId, ...documentTypes, ...batch);
				changed += result.changes;
			}
			return changed;
		});
	}

	/**
	 * Supersede documents of the given types whose source file changed.
	 *
	 * `invalidated_at_commit IS NULL` in the WHERE clause keeps the FIRST commit
	 * that invalidated a document rather than the most recent one — the question
	 * worth answering later is "when did this stop being true", not "when did we
	 * last notice".
	 *
	 * Never deletes. Returns the number of documents newly superseded.
	 */
	markDocumentsInvalidated(
		branchId: number,
		filePaths: string[],
		documentTypes: DocumentType[],
		sha: string,
	): number {
		return this.updateDocumentsByPath(
			branchId,
			filePaths,
			documentTypes,
			[sha],
			(types, paths) => `
				UPDATE documents SET invalidated_at_commit = ?
				WHERE invalidated_at_commit IS NULL
					AND branch_id = ?
					AND document_type IN (${types})
					AND file_path IN (${paths})
			`,
		);
	}

	/**
	 * Flag documents of the given types as suspect without superseding them.
	 *
	 * `invalidated_at_commit` is deliberately left alone: a stale document is
	 * still returned by every reader. Returns the number newly flagged.
	 */
	markDocumentsStale(
		branchId: number,
		filePaths: string[],
		documentTypes: DocumentType[],
		sha: string,
	): number {
		return this.updateDocumentsByPath(
			branchId,
			filePaths,
			documentTypes,
			[sha],
			(types, paths) => `
				UPDATE documents SET stale_at_commit = ?
				WHERE stale_at_commit IS NULL
					AND branch_id = ?
					AND document_type IN (${types})
					AND file_path IN (${paths})
			`,
		);
	}

	/**
	 * Clear the stale flag on specific documents — the "I looked, it is still
	 * true" acknowledgement. Without this a flagged observation stays flagged
	 * forever, which trains people to ignore the flag.
	 */
	clearDocumentsStale(branchId: number, documentIds: string[]): number {
		assertBranchId(branchId);
		if (documentIds.length === 0) return 0;

		return this.withRegion(TRACKER_REGIONS.txn, () => {
			let changed = 0;
			for (const batch of FileTracker.chunk(
				documentIds,
				FileTracker.PATH_BATCH_SIZE,
			)) {
				const result = this.db
					.prepare(
						`UPDATE documents SET stale_at_commit = NULL WHERE branch_id = ? AND id IN (${FileTracker.placeholders(batch.length)})`,
					)
					.run(branchId, ...batch);
				changed += result.changes;
			}
			return changed;
		});
	}

	/**
	 * Count documents of the given types attached to the given paths.
	 * Used to report how many documents a policy deliberately left alone.
	 */
	countDocumentsForPaths(
		branchId: number,
		filePaths: string[],
		documentTypes: DocumentType[],
	): number {
		assertBranchId(branchId);
		if (filePaths.length === 0 || documentTypes.length === 0) return 0;

		const batches = FileTracker.chunk(
			this.pathVariants(filePaths),
			FileTracker.PATH_BATCH_SIZE,
		);
		if (batches.length === 0) return 0;

		// One SELECT per batch, each able to wait once: the region's count IS the
		// batch count, so the clamp divides the allowance across all of them.
		return this.withRegion(reads(batches.length), () => {
			let total = 0;
			for (const batch of batches) {
				const sql = `
				SELECT COUNT(*) as count FROM documents
				WHERE branch_id = ?
					AND document_type IN (${FileTracker.placeholders(documentTypes.length)})
					AND file_path IN (${FileTracker.placeholders(batch.length)})
			`;
				const row = this.db
					.prepare(sql)
					.get(branchId, ...documentTypes, ...batch) as {
					count: number;
				};
				total += row.count;
			}
			return total;
		});
	}

	/**
	 * Queue re-derivation of the given document types for the given files, in
	 * batched statements rather than one per file.
	 *
	 * Drops just those keys from `enrichment_state` instead of resetting the
	 * whole map, so re-deriving file summaries does not silently discard the
	 * completion state of document types this commit said nothing about.
	 *
	 * `json_valid` guard: a row whose enrichment_state was corrupted would
	 * otherwise abort the entire batch and take the healthy rows with it.
	 */
	queueReEnrichment(
		branchId: number,
		filePaths: string[],
		documentTypes: DocumentType[],
	): number {
		assertBranchId(branchId);
		if (filePaths.length === 0 || documentTypes.length === 0) return 0;

		const variants = this.pathVariants(filePaths);
		if (variants.length === 0) return 0;
		const jsonPaths = documentTypes.map((t) => `$.${t}`);

		// Every batch in ONE immediate transaction: blockingStatements 2.
		return this.withRegion(TRACKER_REGIONS.txn, () => {
			let changed = 0;
			for (const batch of FileTracker.chunk(
				variants,
				FileTracker.PATH_BATCH_SIZE,
			)) {
				const sql = `
				UPDATE files SET
					enrichment_state = json_remove(
						CASE WHEN json_valid(enrichment_state) THEN enrichment_state ELSE '{}' END,
						${FileTracker.placeholders(jsonPaths.length)}
					),
					enriched_at = NULL
				WHERE branch_id = ?
					AND path IN (${FileTracker.placeholders(batch.length)})
			`;
				const result = this.db
					.prepare(sql)
					.run(...jsonPaths, branchId, ...batch);
				changed += result.changes;
			}
			return changed;
		});
	}

	/**
	 * Documents currently flagged stale, newest flag first.
	 */
	getStaleDocuments(branchId: number, limit?: number): StaleDocument[] {
		assertBranchId(branchId);
		const sql = `
			SELECT id, document_type, file_path, stale_at_commit, created_at
			FROM documents
			WHERE branch_id = ? AND stale_at_commit IS NOT NULL
			ORDER BY created_at DESC
			${limit && limit > 0 ? "LIMIT ?" : ""}
		`;

		const rows = this.withRegion(TRACKER_REGIONS.read, () => {
			const stmt = this.db.prepare(sql);
			return limit && limit > 0
				? stmt.all(branchId, limit)
				: stmt.all(branchId);
		}) as Array<{
			id: string;
			document_type: string;
			file_path: string | null;
			stale_at_commit: string;
			created_at: string;
		}>;

		return rows.map((row) => ({
			id: row.id,
			documentType: row.document_type as DocumentType,
			filePath: row.file_path,
			staleAtCommit: row.stale_at_commit,
			createdAt: row.created_at,
		}));
	}

	/**
	 * Per-type validity tallies in a single scan.
	 */
	getDocumentStatusCounts(branchId: number): DocumentStatusCount[] {
		assertBranchId(branchId);
		const rows = this.withRegion(TRACKER_REGIONS.read, () =>
			this.db
				.prepare(`
				SELECT
					document_type,
					COUNT(*) as total,
					SUM(CASE WHEN invalidated_at_commit IS NOT NULL THEN 1 ELSE 0 END) as invalidated,
					SUM(CASE WHEN stale_at_commit IS NOT NULL THEN 1 ELSE 0 END) as stale
				FROM documents
				WHERE branch_id = ?
				GROUP BY document_type
			`)
				.all(branchId),
		) as Array<{
			document_type: string;
			total: number;
			invalidated: number;
			stale: number;
		}>;

		return rows.map((row) => ({
			documentType: row.document_type as DocumentType,
			total: row.total,
			invalidated: row.invalidated ?? 0,
			stale: row.stale ?? 0,
		}));
	}

	/**
	 * Compute SHA256 hash of file content
	 */
	private computeFileHash(filePath: string): string {
		const content = readFileSync(filePath);
		return createHash("sha256").update(content).digest("hex");
	}

	// ========================================================================
	// Indexed Documentation Methods
	// ========================================================================

	/**
	 * Mark documentation as indexed for a library
	 */
	markDocsIndexed(
		library: string,
		version: string | null,
		provider: DocProviderType,
		contentHash: string,
		chunkIds: string[],
	): void {
		this.withRegion(TRACKER_REGIONS.write, () => {
			const stmt = this.db.prepare(`
			INSERT OR REPLACE INTO indexed_docs
			(branch_id, library, version, provider, content_hash, fetched_at, chunk_ids)
			VALUES (0, ?, ?, ?, ?, ?, ?)
		`);

			stmt.run(
				library,
				version,
				provider,
				contentHash,
				new Date().toISOString(),
				JSON.stringify(chunkIds),
			);
		});
	}

	/**
	 * Check if documentation needs refresh based on age
	 */
	needsDocsRefresh(
		library: string,
		version?: string,
		maxAgeMs = 24 * 60 * 60 * 1000, // Default: 24 hours
	): boolean {
		const state = this.getDocsState(library, version);
		if (!state) return true;

		const fetchedAt = new Date(state.fetchedAt).getTime();
		const age = Date.now() - fetchedAt;
		return age > maxAgeMs;
	}

	/**
	 * Get indexed documentation state for a library
	 */
	getDocsState(library: string, version?: string): IndexedDocState | null {
		const row = this.withRegion(TRACKER_REGIONS.read, () =>
			this.db
				.prepare(`
			SELECT library, version, provider, content_hash, fetched_at, chunk_ids
			FROM indexed_docs
			WHERE branch_id = 0
				AND library = ? AND (version = ? OR (version IS NULL AND ? IS NULL))
		`)
				.get(library, version || null, version || null),
		) as
			| {
					library: string;
					version: string | null;
					provider: string;
					content_hash: string;
					fetched_at: string;
					chunk_ids: string;
			  }
			| undefined;

		if (!row) return null;

		return {
			library: row.library,
			version: row.version,
			provider: row.provider as DocProviderType,
			contentHash: row.content_hash,
			fetchedAt: row.fetched_at,
			chunkIds: JSON.parse(row.chunk_ids),
		};
	}

	/**
	 * Get all indexed documentation entries
	 */
	getAllIndexedDocs(): IndexedDocState[] {
		const rows = this.withRegion(TRACKER_REGIONS.read, () =>
			this.db
				.prepare(`
			SELECT library, version, provider, content_hash, fetched_at, chunk_ids
			FROM indexed_docs
			WHERE branch_id = 0
			ORDER BY library, version
		`)
				.all(),
		) as Array<{
			library: string;
			version: string | null;
			provider: string;
			content_hash: string;
			fetched_at: string;
			chunk_ids: string;
		}>;

		return rows.map((row) => ({
			library: row.library,
			version: row.version,
			provider: row.provider as DocProviderType,
			contentHash: row.content_hash,
			fetchedAt: row.fetched_at,
			chunkIds: JSON.parse(row.chunk_ids),
		}));
	}

	/**
	 * Get chunk IDs for indexed documentation
	 */
	getDocsChunkIds(library: string, version?: string): string[] {
		const state = this.getDocsState(library, version);
		return state?.chunkIds || [];
	}

	/**
	 * Delete indexed documentation for a library
	 */
	deleteIndexedDocs(library: string, version?: string): void {
		this.withRegion(TRACKER_REGIONS.write, () => {
			if (version !== undefined) {
				this.db
					.prepare(
						"DELETE FROM indexed_docs WHERE branch_id = 0 AND library = ? AND (version = ? OR (version IS NULL AND ? IS NULL))",
					)
					.run(library, version, version);
			} else {
				this.db
					.prepare(
						"DELETE FROM indexed_docs WHERE branch_id = 0 AND library = ?",
					)
					.run(library);
			}
		});
	}

	/**
	 * Clear all indexed documentation
	 */
	clearAllIndexedDocs(): void {
		this.withRegion(TRACKER_REGIONS.write, () => {
			this.db.exec("DELETE FROM indexed_docs WHERE branch_id = 0");
		});
	}

	/**
	 * Get indexed documentation statistics
	 */
	getIndexedDocsStats(): {
		totalLibraries: number;
		totalChunks: number;
		byProvider: Record<DocProviderType, number>;
		oldestFetch: string | null;
		newestFetch: string | null;
	} {
		// Four SELECTs in ONE region; the arithmetic on their results runs after.
		const { totalLibraries, docs, providerRows, times } = this.withRegion(
			reads(4),
			() => ({
				totalLibraries: (
					this.db
						.prepare(
							"SELECT COUNT(DISTINCT library) as count FROM indexed_docs WHERE branch_id = 0",
						)
						.get() as { count: number }
				).count,
				docs: this.db
					.prepare("SELECT chunk_ids FROM indexed_docs WHERE branch_id = 0")
					.all() as Array<{ chunk_ids: string }>,
				providerRows: this.db
					.prepare(
						"SELECT provider, COUNT(*) as count FROM indexed_docs WHERE branch_id = 0 GROUP BY provider",
					)
					.all() as Array<{ provider: string; count: number }>,
				times: this.db
					.prepare(
						"SELECT MIN(fetched_at) as oldest, MAX(fetched_at) as newest FROM indexed_docs WHERE branch_id = 0",
					)
					.get() as { oldest: string | null; newest: string | null },
			}),
		);

		// Count total chunks across all docs
		let totalChunks = 0;
		for (const doc of docs) {
			try {
				const chunks = JSON.parse(doc.chunk_ids);
				totalChunks += chunks.length;
			} catch {
				// Ignore parse errors
			}
		}

		// Count by provider
		const byProvider: Record<string, number> = {};
		for (const row of providerRows) {
			byProvider[row.provider] = row.count;
		}

		return {
			totalLibraries,
			totalChunks,
			byProvider: byProvider as Record<DocProviderType, number>,
			oldestFetch: times.oldest,
			newestFetch: times.newest,
		};
	}

	/**
	 * THE ONLY WAY to reach a symbol-graph statement (§4.4.1, step 3).
	 *
	 * Every one of the 24 members below lived on `FileTracker` and took no
	 * branch. Nineteen of them kept compiling unchanged when the key became
	 * `(branch_id, id)` and silently went cross-branch — including a
	 * `deleteSymbolsByFile` that `extractSymbolGraph` drives PER FILE on every
	 * incremental re-index, which is cross-branch data loss, not a theoretical
	 * one. Relying on the compiler to find them would have found five.
	 *
	 * So the members moved onto a handle that cannot be obtained without naming
	 * a branch, and the handle holds NO branch-free state: a `db`, a `branchId`,
	 * the region runner and the path mapper, and nothing else. A 26th method
	 * added to `BranchScopedGraph` has nothing unscoped to reach for.
	 */
	graph(branchId: number): BranchScopedGraph {
		assertBranchId(branchId);
		return new BranchScopedGraph(
			this.db,
			branchId,
			(region, fn) => this.withRegion(region, fn),
			(filePath) => this.storedPath(filePath),
		);
	}
}

/**
 * The symbol graph, through ONE branch (§4.4.1).
 *
 * Obtained only as `tracker.graph(branchId)`. Every statement here names
 * `branch_id`, and the static sweep V3.11b (`tracker-graph-sweep.test.ts`)
 * fails on any that does not — including the one nobody has written yet.
 *
 * The three tables' DDL (the design's member #1) is `SYMBOL_GRAPH_DDL`, above,
 * which is the sweep's declared exception for them.
 */
export class BranchScopedGraph {
	constructor(
		private readonly db: SQLiteDatabase,
		private readonly branchId: number,
		private readonly runRegion: <T>(region: TrackerRegion, fn: () => T) => T,
		private readonly storedPath: (filePath: string) => string | null,
	) {}

	/**
	 * THE ONE PLACE a statement may run on this handle (SR-1), and it is a real
	 * METHOD rather than the injected field itself because the NAME is what
	 * V2.10's sweep recognises: `withRegion` may appear only as a method
	 * definition's name or as a call's callee, so that an alias cannot open a
	 * region the flow walk (SR-2) never sees. The field is therefore called
	 * `runRegion`, and this delegates to it.
	 *
	 * It is `FileTracker.withRegion` underneath, on the SAME connection, so the
	 * clamp, the nesting guard and the contention ledger are shared — a graph
	 * region and a tracker region cannot nest.
	 */
	private withRegion<T>(region: TrackerRegion, fn: () => T): T {
		return this.runRegion(region, fn);
	}

	/** Which branch this handle reads and writes. Diagnostics only. */
	get scopedBranchId(): number {
		return this.branchId;
	}

	// ========================================================================
	// Symbol CRUD
	// ========================================================================

	/** Insert a single symbol, under this handle's branch. */
	insertSymbol(symbol: SymbolDefinition): void {
		this.withRegion(TRACKER_REGIONS.write, () => {
			const stmt = this.db.prepare(`
			INSERT OR REPLACE INTO symbols
			(branch_id, id, name, kind, file_path, start_line, end_line, signature, docstring,
			 parent_id, is_exported, language, pagerank, in_degree, out_degree, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);

			stmt.run(
				this.branchId,
				symbol.id,
				symbol.name,
				symbol.kind,
				symbol.filePath,
				symbol.startLine,
				symbol.endLine,
				symbol.signature || null,
				symbol.docstring || null,
				symbol.parentId || null,
				symbol.isExported ? 1 : 0,
				symbol.language,
				symbol.pagerankScore,
				symbol.inDegree || 0,
				symbol.outDegree || 0,
				symbol.createdAt,
				symbol.updatedAt,
			);
		});
	}

	/** Insert multiple symbols in ONE immediate transaction (batched). */
	insertSymbols(symbols: SymbolDefinition[]): void {
		if (symbols.length === 0) return;

		// BEGIN IMMEDIATE inside the region, not `db.transaction()`: that is a
		// DEFERRED begin in sqlite.ts's Bun branch, and R-txn's count of 2 rests
		// on the write lock being taken at BEGIN (architecture §5.3, N32).
		this.withRegion(TRACKER_REGIONS.txn, () => {
			const stmt = this.db.prepare(`
			INSERT OR REPLACE INTO symbols
			(branch_id, id, name, kind, file_path, start_line, end_line, signature, docstring,
			 parent_id, is_exported, language, pagerank, in_degree, out_degree, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);

			for (const symbol of symbols) {
				stmt.run(
					this.branchId,
					symbol.id,
					symbol.name,
					symbol.kind,
					symbol.filePath,
					symbol.startLine,
					symbol.endLine,
					symbol.signature || null,
					symbol.docstring || null,
					symbol.parentId || null,
					symbol.isExported ? 1 : 0,
					symbol.language,
					symbol.pagerankScore,
					symbol.inDegree || 0,
					symbol.outDegree || 0,
					symbol.createdAt,
					symbol.updatedAt,
				);
			}
		});
	}

	/** Get a symbol by ID. */
	getSymbol(id: string): SymbolDefinition | null {
		const row = this.withRegion(TRACKER_REGIONS.read, () =>
			this.db
				.prepare("SELECT * FROM symbols WHERE branch_id = ? AND id = ?")
				.get(this.branchId, id),
		) as Record<string, unknown> | undefined;
		return row ? rowToSymbol(row) : null;
	}

	/** Get all symbols for a file. */
	getSymbolsByFile(filePath: string): SymbolDefinition[] {
		const relativePath = this.storedPath(filePath);

		const rows = this.withRegion(TRACKER_REGIONS.read, () =>
			this.db
				.prepare("SELECT * FROM symbols WHERE branch_id = ? AND file_path = ?")
				.all(this.branchId, relativePath),
		) as Array<Record<string, unknown>>;
		return rows.map((row) => rowToSymbol(row));
	}

	/**
	 * Get symbols by name (with optional kind filter).
	 *
	 * SINGULAR — `getSymbolByName`. Revision 1 of the design wrote
	 * `getSymbolsByName`, which is not an identifier in this tree (N37).
	 */
	getSymbolByName(name: string, kind?: SymbolKind): SymbolDefinition[] {
		const rows = this.withRegion(TRACKER_REGIONS.read, () =>
			kind
				? this.db
						.prepare(
							"SELECT * FROM symbols WHERE branch_id = ? AND name = ? AND kind = ?",
						)
						.all(this.branchId, name, kind)
				: this.db
						.prepare("SELECT * FROM symbols WHERE branch_id = ? AND name = ?")
						.all(this.branchId, name),
		) as Array<Record<string, unknown>>;

		return rows.map((row) => rowToSymbol(row));
	}

	/** Get all symbols whose parent_id matches the given parentId. */
	getSymbolsByParent(parentId: string): SymbolDefinition[] {
		const rows = this.withRegion(TRACKER_REGIONS.read, () =>
			this.db
				.prepare("SELECT * FROM symbols WHERE branch_id = ? AND parent_id = ?")
				.all(this.branchId, parentId),
		) as Array<Record<string, unknown>>;
		return rows.map((row) => rowToSymbol(row));
	}

	/** Get all symbols. */
	getAllSymbols(): SymbolDefinition[] {
		const rows = this.withRegion(TRACKER_REGIONS.read, () =>
			this.db
				.prepare("SELECT * FROM symbols WHERE branch_id = ?")
				.all(this.branchId),
		) as Array<Record<string, unknown>>;
		return rows.map((row) => rowToSymbol(row));
	}

	/** Get top symbols by PageRank score. Feeds `map` and `doctor`. */
	getTopSymbols(limit: number): SymbolDefinition[] {
		const rows = this.withRegion(TRACKER_REGIONS.read, () =>
			this.db
				.prepare(
					"SELECT * FROM symbols WHERE branch_id = ? ORDER BY pagerank DESC LIMIT ?",
				)
				.all(this.branchId, limit),
		) as Array<Record<string, unknown>>;
		return rows.map((row) => rowToSymbol(row));
	}

	/**
	 * Delete all symbols for a file, on THIS branch only.
	 *
	 * `extractSymbolGraph` calls this per file on every incremental re-index. It
	 * is the statement N3 was raised CRITICAL over: unpredicated, one worktree's
	 * re-index erased that file's symbols for every other branch.
	 */
	deleteSymbolsByFile(filePath: string): void {
		const relativePath = this.storedPath(filePath);

		this.withRegion(TRACKER_REGIONS.txn, () => {
			// References first. The v4 DDL drops the three FKs (N33), so there is
			// no cascade to fall back on — which was already the reason this
			// statement was written out explicitly.
			this.db
				.prepare(
					"DELETE FROM symbol_references WHERE branch_id = ? AND file_path = ?",
				)
				.run(this.branchId, relativePath);

			this.db
				.prepare("DELETE FROM symbols WHERE branch_id = ? AND file_path = ?")
				.run(this.branchId, relativePath);
		});
	}

	// ========================================================================
	// Reference CRUD
	// ========================================================================

	/** Insert a single reference. */
	insertReference(ref: SymbolReference): void {
		this.withRegion(TRACKER_REGIONS.write, () => {
			const stmt = this.db.prepare(`
			INSERT INTO symbol_references
			(branch_id, from_symbol_id, to_symbol_name, to_symbol_id, kind, file_path, line, is_resolved, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);

			stmt.run(
				this.branchId,
				ref.fromSymbolId,
				ref.toSymbolName,
				ref.toSymbolId || null,
				ref.kind,
				ref.filePath,
				ref.line,
				ref.isResolved ? 1 : 0,
				ref.createdAt,
			);
		});
	}

	/** Insert multiple references in ONE immediate transaction (batched). */
	insertReferences(refs: SymbolReference[]): void {
		if (refs.length === 0) return;

		// BEGIN IMMEDIATE inside the region, not `db.transaction()` (N32).
		this.withRegion(TRACKER_REGIONS.txn, () => {
			const stmt = this.db.prepare(`
			INSERT INTO symbol_references
			(branch_id, from_symbol_id, to_symbol_name, to_symbol_id, kind, file_path, line, is_resolved, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);

			for (const ref of refs) {
				stmt.run(
					this.branchId,
					ref.fromSymbolId,
					ref.toSymbolName,
					ref.toSymbolId || null,
					ref.kind,
					ref.filePath,
					ref.line,
					ref.isResolved ? 1 : 0,
					ref.createdAt,
				);
			}
		});
	}

	/** Get all references from a symbol. */
	getReferencesFrom(symbolId: string): SymbolReference[] {
		const rows = this.withRegion(TRACKER_REGIONS.read, () =>
			this.db
				.prepare(
					"SELECT * FROM symbol_references WHERE branch_id = ? AND from_symbol_id = ?",
				)
				.all(this.branchId, symbolId),
		) as Array<Record<string, unknown>>;
		return rows.map((row) => rowToReference(row));
	}

	/** Get all references to a symbol. */
	getReferencesTo(symbolId: string): SymbolReference[] {
		const rows = this.withRegion(TRACKER_REGIONS.read, () =>
			this.db
				.prepare(
					"SELECT * FROM symbol_references WHERE branch_id = ? AND to_symbol_id = ?",
				)
				.all(this.branchId, symbolId),
		) as Array<Record<string, unknown>>;
		return rows.map((row) => rowToReference(row));
	}

	/** Get all unresolved references. */
	getUnresolvedReferences(): SymbolReference[] {
		const rows = this.withRegion(TRACKER_REGIONS.read, () =>
			this.db
				.prepare(
					"SELECT * FROM symbol_references WHERE branch_id = ? AND is_resolved = 0",
				)
				.all(this.branchId),
		) as Array<Record<string, unknown>>;
		return rows.map((row) => rowToReference(row));
	}

	/** Get all references. */
	getAllReferences(): SymbolReference[] {
		const rows = this.withRegion(TRACKER_REGIONS.read, () =>
			this.db
				.prepare("SELECT * FROM symbol_references WHERE branch_id = ?")
				.all(this.branchId),
		) as Array<Record<string, unknown>>;
		return rows.map((row) => rowToReference(row));
	}

	/**
	 * Resolve a reference to a symbol.
	 *
	 * `id` is a SURROGATE (`INTEGER PRIMARY KEY AUTOINCREMENT`), unique across
	 * the whole table, so `WHERE id = ?` alone would find the right row — I-12
	 * Ruling 1's second case, and the reason this table keeps its single-column
	 * key. `branch_id = ?` is still in the predicate: it makes a cross-branch
	 * `refId` a no-op rather than a silent write, and it is what V3.11b's sweep
	 * asserts for every statement on these tables.
	 */
	resolveReference(refId: number, toSymbolId: string): void {
		this.withRegion(TRACKER_REGIONS.write, () => {
			this.db
				.prepare(
					"UPDATE symbol_references SET to_symbol_id = ?, is_resolved = 1 WHERE branch_id = ? AND id = ?",
				)
				.run(toSymbolId, this.branchId, refId);
		});
	}

	/**
	 * Bulk resolve references by name, within this branch.
	 *
	 * `+s.is_exported`, NOT `s.is_exported`: the unary plus is load-bearing.
	 * It stops that term from using an index, so the planner answers both
	 * subqueries from the name index. Without it — and a tracker database has no
	 * ANALYZE statistics — SQLite picks the partial index `idx_symbols_exported`,
	 * and every unresolved reference walks EVERY exported symbol, twice, inside
	 * this ONE synchronous statement. Measured: 5.4 s at 8 000 exported x 20 000
	 * references, and a lock heartbeat frozen for 34.5 s at 20 000 x 40 000, past
	 * the 10 s stale rule (CLAUDE.md #31). No caller-side yield can split one
	 * statement.
	 *
	 * I-12 Ruling 3: the name index is now `idx_symbols_name (branch_id, name)`,
	 * and BOTH correlated subqueries carry `s.branch_id = ?` so the planner can
	 * still use it as an equality lookup on both columns. The test's intent is
	 * unchanged — one name lookup per reference, never a scan across exported
	 * symbols — and `tracker-resolve-plan.test.ts` pins the PLAN with the same
	 * falsification: remove the scoping, or the `+`, and it regresses to a scan.
	 *
	 * The result set is unchanged by the `+`: it is a no-op on the value, and
	 * both plans visit a name's exported rows in rowid order, so `LIMIT 1` picks
	 * the same row.
	 */
	resolveReferencesByName(): number {
		const result = this.withRegion(TRACKER_REGIONS.write, () =>
			this.db
				.prepare(`
			UPDATE symbol_references
			SET to_symbol_id = (
				SELECT s.id FROM symbols s
				WHERE s.branch_id = ?
				AND s.name = symbol_references.to_symbol_name
				AND +s.is_exported = 1
				LIMIT 1
			),
			is_resolved = 1
			WHERE branch_id = ?
			AND is_resolved = 0
			AND EXISTS (
				SELECT 1 FROM symbols s
				WHERE s.branch_id = ?
				AND s.name = symbol_references.to_symbol_name
				AND +s.is_exported = 1
			)
		`)
				.run(this.branchId, this.branchId, this.branchId),
		);

		return result.changes;
	}

	/** Delete all references for a file, on THIS branch only. */
	deleteReferencesByFile(filePath: string): void {
		const relativePath = this.storedPath(filePath);

		this.withRegion(TRACKER_REGIONS.write, () => {
			this.db
				.prepare(
					"DELETE FROM symbol_references WHERE branch_id = ? AND file_path = ?",
				)
				.run(this.branchId, relativePath);
		});
	}

	// ========================================================================
	// PageRank and Graph Metadata
	// ========================================================================

	/** Update PageRank scores for this branch's symbols. */
	updatePageRankScores(scores: Map<string, number>): void {
		// ONE immediate transaction for the scores AND the timestamp that says they
		// were computed. They used to be a transaction followed by a second,
		// separate write — two regions with no yield between them (SR-2).
		this.withRegion(TRACKER_REGIONS.txn, () => {
			const stmt = this.db.prepare(
				"UPDATE symbols SET pagerank = ? WHERE branch_id = ? AND id = ?",
			);
			for (const [id, score] of scores) {
				stmt.run(score, this.branchId, id);
			}

			const now = new Date().toISOString();
			this.db
				.prepare(
					"INSERT OR REPLACE INTO graph_metadata (branch_id, key, value, updated_at) VALUES (?, ?, ?, ?)",
				)
				.run(this.branchId, "pagerank_last_computed", now, now);
		});
	}

	/**
	 * Update in/out degree counts for this branch's symbols.
	 *
	 * The outer UPDATE and BOTH subqueries are scoped: unscoped, this wrote
	 * across branches AND counted across them, so branch A's degrees reflected
	 * branch B's references.
	 */
	updateDegreeCounts(): void {
		this.withRegion(TRACKER_REGIONS.txn, () => {
			this.db
				.prepare(`
			UPDATE symbols SET in_degree = (
				SELECT COUNT(*) FROM symbol_references r
				WHERE r.branch_id = ? AND r.to_symbol_id = symbols.id
			)
			WHERE branch_id = ?
		`)
				.run(this.branchId, this.branchId);

			this.db
				.prepare(`
			UPDATE symbols SET out_degree = (
				SELECT COUNT(*) FROM symbol_references r
				WHERE r.branch_id = ? AND r.from_symbol_id = symbols.id
			)
			WHERE branch_id = ?
		`)
				.run(this.branchId, this.branchId);
		});
	}

	/** Get graph metadata value. */
	getGraphMetadata(key: string): string | null {
		const row = this.withRegion(TRACKER_REGIONS.read, () =>
			this.db
				.prepare(
					"SELECT value FROM graph_metadata WHERE branch_id = ? AND key = ?",
				)
				.get(this.branchId, key),
		) as { value: string } | undefined;
		return row?.value || null;
	}

	/** Set graph metadata value. */
	setGraphMetadata(key: string, value: string): void {
		this.withRegion(TRACKER_REGIONS.write, () => {
			this.db
				.prepare(
					"INSERT OR REPLACE INTO graph_metadata (branch_id, key, value, updated_at) VALUES (?, ?, ?, ?)",
				)
				.run(this.branchId, key, value, new Date().toISOString());
		});
	}

	/** Symbol graph statistics, for THIS branch — `doctor` used to sum all of them. */
	getSymbolGraphStats(): SymbolGraphStats {
		// Six SELECTs in ONE region. The pagerank timestamp is read here rather
		// than through getGraphMetadata(), which would be a second region with no
		// yield before it (SR-2).
		const raw = this.withRegion(reads(6), () => ({
			symbolCount: (
				this.db
					.prepare("SELECT COUNT(*) as count FROM symbols WHERE branch_id = ?")
					.get(this.branchId) as {
					count: number;
				}
			).count,
			refCount: (
				this.db
					.prepare(
						"SELECT COUNT(*) as count FROM symbol_references WHERE branch_id = ?",
					)
					.get(this.branchId) as { count: number }
			).count,
			resolvedCount: (
				this.db
					.prepare(
						"SELECT COUNT(*) as count FROM symbol_references WHERE branch_id = ? AND is_resolved = 1",
					)
					.get(this.branchId) as { count: number }
			).count,
			kindRows: this.db
				.prepare(
					"SELECT kind, COUNT(*) as count FROM symbols WHERE branch_id = ? GROUP BY kind",
				)
				.all(this.branchId) as Array<{ kind: string; count: number }>,
			refKindRows: this.db
				.prepare(
					"SELECT kind, COUNT(*) as count FROM symbol_references WHERE branch_id = ? GROUP BY kind",
				)
				.all(this.branchId) as Array<{ kind: string; count: number }>,
			pagerank: this.db
				.prepare(
					"SELECT value FROM graph_metadata WHERE branch_id = ? AND key = ?",
				)
				.get(this.branchId, "pagerank_last_computed") as
				| { value: string }
				| undefined,
		}));

		// Symbols by kind
		const symbolsByKind: Partial<Record<SymbolKind, number>> = {};
		for (const row of raw.kindRows) {
			symbolsByKind[row.kind as SymbolKind] = row.count;
		}

		// References by kind
		const referencesByKind: Partial<Record<ReferenceKind, number>> = {};
		for (const row of raw.refKindRows) {
			referencesByKind[row.kind as ReferenceKind] = row.count;
		}

		return {
			totalSymbols: raw.symbolCount,
			totalReferences: raw.refCount,
			resolvedReferences: raw.resolvedCount,
			symbolsByKind,
			referencesByKind,
			pagerankComputedAt: raw.pagerank?.value || undefined,
		};
	}

	/**
	 * Clear THIS branch's symbol graph.
	 *
	 * Unpredicated, a force-rebuild in one worktree erased every branch's graph
	 * — the one instance revision 1 of the design found.
	 */
	clearSymbolGraph(): void {
		this.withRegion(TRACKER_REGIONS.txn, () => {
			this.db
				.prepare("DELETE FROM symbol_references WHERE branch_id = ?")
				.run(this.branchId);
			this.db
				.prepare("DELETE FROM symbols WHERE branch_id = ?")
				.run(this.branchId);
			this.db
				.prepare("DELETE FROM graph_metadata WHERE branch_id = ?")
				.run(this.branchId);
		});
	}
}

/** Database row → `SymbolDefinition`. Runs no SQL, so it takes no branch. */
function rowToSymbol(row: Record<string, unknown>): SymbolDefinition {
	return {
		id: row.id as string,
		name: row.name as string,
		kind: row.kind as SymbolKind,
		filePath: row.file_path as string,
		startLine: row.start_line as number,
		endLine: row.end_line as number,
		signature: (row.signature as string) || undefined,
		docstring: (row.docstring as string) || undefined,
		parentId: (row.parent_id as string) || undefined,
		isExported: (row.is_exported as number) === 1,
		language: row.language as string,
		pagerankScore: row.pagerank as number,
		inDegree: row.in_degree as number,
		outDegree: row.out_degree as number,
		createdAt: row.created_at as string,
		updatedAt: row.updated_at as string,
	};
}

/** Database row → `SymbolReference`. Runs no SQL, so it takes no branch. */
function rowToReference(row: Record<string, unknown>): SymbolReference {
	return {
		id: row.id as number,
		fromSymbolId: row.from_symbol_id as string,
		toSymbolName: row.to_symbol_name as string,
		toSymbolId: (row.to_symbol_id as string) || undefined,
		kind: row.kind as ReferenceKind,
		filePath: row.file_path as string,
		line: row.line as number,
		isResolved: (row.is_resolved as number) === 1,
		createdAt: row.created_at as string,
	};
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Compute SHA256 hash of a string
 */
export function computeHash(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

/**
 * Compute SHA256 hash of a file
 */
export function computeFileHash(filePath: string): string {
	const content = readFileSync(filePath);
	return createHash("sha256").update(content).digest("hex");
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a file tracker for a project. `startPath` is resolved through the
 * store-location seam to the path root every stored path is relative to.
 */
export function createFileTracker(
	dbPath: string,
	startPath: string,
): IFileTracker {
	return new FileTracker(dbPath, startPath);
}
