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
import { toRepoRelative } from "./repo-path.js";
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
	getChanges(currentFiles: string[]): FileChanges;
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
	getChunkIds(filePath: string): string[];
	removeFile(filePath: string): void;
	getFileState(filePath: string): FileState | null;
	getAllFiles(): FileState[];
	getMetadata(key: string): string | null;
	setMetadata(key: string, value: string): void;
	getStats(): { totalFiles: number; lastIndexed: string | null };
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
	recordActivity(type: string, metadata: Record<string, unknown>): number;
	getActivity(sinceId?: number, limit?: number): ActivityRow[];
	pruneActivity(keepCount?: number): void;
	close(): void;
	getDatabase(): SQLiteDatabase;
	getEnrichmentState(filePath: string): EnrichmentStateMap;
	setEnrichmentState(
		filePath: string,
		documentType: DocumentType,
		state: EnrichmentState,
	): void;
	setAllEnrichmentStates(filePath: string, states: EnrichmentStateMap): void;
	resetEnrichmentState(filePath: string): void;
	needsEnrichment(filePath: string, documentType: DocumentType): boolean;
	getFilesNeedingEnrichment(documentType: DocumentType): string[];
	trackDocument(doc: TrackedDocument): void;
	trackDocuments(docs: TrackedDocument[]): void;
	getDocumentsForFile(filePath: string): TrackedDocument[];
	getDocumentsByType(documentType: DocumentType): TrackedDocument[];
	deleteDocumentsForFile(filePath: string): void;
	deleteDocumentsByType(documentType: DocumentType): void;
	getDocumentCounts(): Record<DocumentType, number>;
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
	insertSymbol(symbol: SymbolDefinition): void;
	insertSymbols(symbols: SymbolDefinition[]): void;
	getSymbol(id: string): SymbolDefinition | null;
	getSymbolsByFile(filePath: string): SymbolDefinition[];
	getSymbolByName(name: string, kind?: SymbolKind): SymbolDefinition[];
	getSymbolsByParent(parentId: string): SymbolDefinition[];
	getAllSymbols(): SymbolDefinition[];
	getTopSymbols(limit: number): SymbolDefinition[];
	deleteSymbolsByFile(filePath: string): void;
	insertReference(ref: SymbolReference): void;
	insertReferences(refs: SymbolReference[]): void;
	getReferencesFrom(symbolId: string): SymbolReference[];
	getReferencesTo(symbolId: string): SymbolReference[];
	getUnresolvedReferences(): SymbolReference[];
	getAllReferences(): SymbolReference[];
	resolveReference(refId: number, toSymbolId: string): void;
	resolveReferencesByName(): number;
	deleteReferencesByFile(filePath: string): void;
	updatePageRankScores(scores: Map<string, number>): void;
	updateDegreeCounts(): void;
	getGraphMetadata(key: string): string | null;
	setGraphMetadata(key: string, value: string): void;
	getSymbolGraphStats(): SymbolGraphStats;
	clearSymbolGraph(): void;
	recordCommit(sha: string, ordinal: number, committedAt?: string | null): void;
	getCommitOrdinal(sha: string): number | null;
	recordHeadCommit(): Promise<CommitProvenance | null>;
	setCurrentCommit(sha: string | null): void;
	getCurrentCommit(): string | null;
	setFileIndexedCommit(filePath: string, sha: string | null): void;
	getFileIndexedCommit(filePath: string): string | null;
	setDocumentsValidFromCommit(documentIds: string[], sha: string | null): void;
	getDocumentProvenance(documentId: string): DocumentProvenance | null;
	markDocumentsInvalidated(
		filePaths: string[],
		documentTypes: DocumentType[],
		sha: string,
	): number;
	markDocumentsStale(
		filePaths: string[],
		documentTypes: DocumentType[],
		sha: string,
	): number;
	clearDocumentsStale(documentIds: string[]): number;
	countDocumentsForPaths(
		filePaths: string[],
		documentTypes: DocumentType[],
	): number;
	queueReEnrichment(filePaths: string[], documentTypes: DocumentType[]): number;
	getStaleDocuments(limit?: number): StaleDocument[];
	getDocumentStatusCounts(): DocumentStatusCount[];
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

const DOCUMENTS_TABLE_DDL = `CREATE TABLE IF NOT EXISTS documents (
	id TEXT PRIMARY KEY,
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
	stale_at_commit TEXT
)`;

const INDEXED_DOCS_TABLE_DDL = `CREATE TABLE IF NOT EXISTS indexed_docs (
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

const FILES_INDEX_DDL: readonly string[] = [
	"CREATE INDEX IF NOT EXISTS idx_files_content_hash ON files(content_hash)",
];

const DOCUMENTS_INDEX_DDL: readonly string[] = [
	"CREATE INDEX IF NOT EXISTS idx_documents_file_path ON documents(file_path)",
	"CREATE INDEX IF NOT EXISTS idx_documents_type ON documents(document_type)",
];

const INDEXED_DOCS_INDEX_DDL: readonly string[] = [
	"CREATE INDEX IF NOT EXISTS idx_indexed_docs_library ON indexed_docs(library)",
	"CREATE INDEX IF NOT EXISTS idx_indexed_docs_fetched ON indexed_docs(fetched_at)",
];

/** The core tables and their indexes: 5 CREATE TABLE + 6 CREATE INDEX. */
const CORE_SCHEMA_DDL: readonly string[] = [
	FILES_TABLE_DDL,
	METADATA_TABLE_DDL,
	DOCUMENTS_TABLE_DDL,
	INDEXED_DOCS_TABLE_DDL,
	COMMITS_TABLE_DDL,
	"CREATE INDEX IF NOT EXISTS idx_commits_ordinal ON commits(ordinal)",
	...FILES_INDEX_DDL,
	...DOCUMENTS_INDEX_DDL,
	...INDEXED_DOCS_INDEX_DDL,
];

/** The symbol graph: 3 CREATE TABLE + 11 CREATE INDEX. */
const SYMBOL_GRAPH_DDL: readonly string[] = [
	`CREATE TABLE IF NOT EXISTS symbols (
		id TEXT PRIMARY KEY,
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
		FOREIGN KEY (parent_id) REFERENCES symbols(id) ON DELETE SET NULL
	)`,
	`CREATE TABLE IF NOT EXISTS symbol_references (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		from_symbol_id TEXT NOT NULL,
		to_symbol_name TEXT NOT NULL,
		to_symbol_id TEXT,
		kind TEXT NOT NULL,
		file_path TEXT NOT NULL,
		line INTEGER NOT NULL,
		is_resolved INTEGER DEFAULT 0,
		created_at TEXT NOT NULL,
		FOREIGN KEY (from_symbol_id) REFERENCES symbols(id) ON DELETE CASCADE,
		FOREIGN KEY (to_symbol_id) REFERENCES symbols(id) ON DELETE SET NULL
	)`,
	`CREATE TABLE IF NOT EXISTS graph_metadata (
		key TEXT PRIMARY KEY,
		value TEXT NOT NULL,
		updated_at TEXT NOT NULL
	)`,
	"CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name)",
	"CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_path)",
	"CREATE INDEX IF NOT EXISTS idx_symbols_kind ON symbols(kind)",
	"CREATE INDEX IF NOT EXISTS idx_symbols_pagerank ON symbols(pagerank DESC)",
	"CREATE INDEX IF NOT EXISTS idx_symbols_parent ON symbols(parent_id)",
	"CREATE INDEX IF NOT EXISTS idx_symbols_exported ON symbols(is_exported) WHERE is_exported = 1",
	"CREATE INDEX IF NOT EXISTS idx_refs_from ON symbol_references(from_symbol_id)",
	"CREATE INDEX IF NOT EXISTS idx_refs_to ON symbol_references(to_symbol_id)",
	"CREATE INDEX IF NOT EXISTS idx_refs_to_name ON symbol_references(to_symbol_name)",
	"CREATE INDEX IF NOT EXISTS idx_refs_file ON symbol_references(file_path)",
	"CREATE INDEX IF NOT EXISTS idx_refs_kind ON symbol_references(kind)",
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
 * `files` only, for now. The other five tree-scoped tables gain `branch_id`
 * in Phase 3b, together with the statements that scope them. A `branch_id`
 * leading key under unscoped statements makes every path lookup on those tables
 * a table scan, and takes away the index `resolveReferencesByName`'s plan
 * depends on (`tracker-resolve-plan.test.ts`).
 */
export const BRANCH_ID_TABLES = ["files"] as const;

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
 *   11   CORE_SCHEMA_DDL.length
 *   14   SYMBOL_GRAPH_DDL.length
 *    2   ACTIVITY_LOG_DDL.length
 *    2   PRAGMA table_info — MIGRATED_TABLES
 *    6   ALTER TABLE, at most — COLUMN_MIGRATIONS
 *    2   MIGRATION_INDEXES
 *   --
 *   40   → floor(250 / 40) = 6 ms per statement; 40 × 6 = 240 ms ≤ BUSY_TIMEOUT_MS
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
	MIGRATED_TABLES.length +
	COLUMN_MIGRATIONS.length +
	MIGRATION_INDEXES.length;

/**
 * The tracker's regions. `blockingStatements` is a CLAIM about what the
 * callback runs; changing one invalidates `sync-region.ts`'s arithmetic — redo
 * it.
 *
 *   region    what runs                                   blocking   on contention
 *   R0        WAL pragma, memo key, schema pass           40         fail the open
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
	getChanges(currentFiles: string[]): FileChanges {
		const newFiles: string[] = [];
		const modifiedFiles: string[] = [];
		const unchangedFiles: string[] = [];

		// Get all indexed files — R1, one SELECT.
		const indexed = this.withRegion(TRACKER_REGIONS.changes, () =>
			this.db
				.prepare("SELECT branch_id, path, content_hash, mtime FROM files")
				.all(),
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
	getChunkIds(filePath: string): string[] {
		const relativePath = this.storedPath(filePath);

		const row = this.withRegion(TRACKER_REGIONS.read, () =>
			this.db
				.prepare("SELECT chunk_ids FROM files WHERE path = ?")
				.get(relativePath),
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
	removeFile(filePath: string): void {
		// Absolute or already stored: see `storedPath`.
		const relativePath = this.storedPath(filePath);

		this.withRegion(TRACKER_REGIONS.write, () => {
			this.db.prepare("DELETE FROM files WHERE path = ?").run(relativePath);
		});
	}

	/**
	 * Get file state
	 */
	getFileState(filePath: string): FileState | null {
		const relativePath = this.storedPath(filePath);

		const row = this.withRegion(TRACKER_REGIONS.read, () =>
			this.db
				.prepare(
					"SELECT path, content_hash, mtime, chunk_ids FROM files WHERE path = ?",
				)
				.get(relativePath),
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
	getAllFiles(): FileState[] {
		const rows = this.withRegion(TRACKER_REGIONS.read, () =>
			this.db
				.prepare("SELECT path, content_hash, mtime, chunk_ids FROM files")
				.all(),
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
	getStats(): { totalFiles: number; lastIndexed: string | null } {
		return this.withRegion(reads(2), () => {
			const countRow = this.db
				.prepare("SELECT COUNT(*) as count FROM files")
				.get() as { count: number };
			const lastRow = this.db
				.prepare("SELECT MAX(indexed_at) as last FROM files")
				.get() as { last: string | null };
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
		this.withRegion(TRACKER_REGIONS.txn, () => {
			this.db.exec("DELETE FROM files");
			this.db.exec("DELETE FROM metadata");
			this.db.exec("DELETE FROM documents");
			this.db.exec("DELETE FROM indexed_docs");
		});
	}

	// ========================================================================
	// Activity Log Methods (for monitor mode)
	// ========================================================================

	/**
	 * §6.1's third upgrade signal, and the only one that sees the SQLite half:
	 * `files` exists and has no `branch_id`. False for a database with no `files`
	 * table at all, which is fresh, not outdated.
	 */
	trackerNeedsV4Schema(): boolean {
		const columns = this.withRegion(TRACKER_REGIONS.read, () =>
			this.db.prepare(BRANCH_ID_PROBES.files.columns).all(),
		) as Array<{ name?: unknown }>;
		return (
			columns.length > 0 &&
			!columns.some((column) => column.name === "branch_id")
		);
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
	getEnrichmentState(filePath: string): EnrichmentStateMap {
		const relativePath = this.storedPath(filePath);

		const row = this.withRegion(TRACKER_REGIONS.read, () =>
			this.db
				.prepare("SELECT enrichment_state FROM files WHERE path = ?")
				.get(relativePath),
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
		filePath: string,
		documentType: DocumentType,
		state: EnrichmentState,
	): void {
		const relativePath = this.storedPath(filePath);

		// Read-modify-write in ONE immediate transaction. Two processes that each
		// read the map and wrote their own key back would lose one of the keys;
		// under BEGIN IMMEDIATE the second waits for the first.
		this.withRegion(TRACKER_REGIONS.txn, () => {
			const row = this.db
				.prepare("SELECT enrichment_state FROM files WHERE path = ?")
				.get(relativePath) as { enrichment_state: string } | undefined;
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
					"UPDATE files SET enrichment_state = ?, enriched_at = ? WHERE path = ?",
				)
				.run(
					JSON.stringify(current),
					state === "complete" ? new Date().toISOString() : null,
					relativePath,
				);
		});
	}

	/**
	 * Set all enrichment states for a file at once
	 */
	setAllEnrichmentStates(filePath: string, states: EnrichmentStateMap): void {
		const relativePath = this.storedPath(filePath);

		const hasComplete = Object.values(states).some((s) => s === "complete");

		this.withRegion(TRACKER_REGIONS.write, () => {
			this.db
				.prepare(
					"UPDATE files SET enrichment_state = ?, enriched_at = ? WHERE path = ?",
				)
				.run(
					JSON.stringify(states),
					hasComplete ? new Date().toISOString() : null,
					relativePath,
				);
		});
	}

	/**
	 * Reset enrichment state for a file (e.g., when file is modified)
	 */
	resetEnrichmentState(filePath: string): void {
		const relativePath = this.storedPath(filePath);

		this.withRegion(TRACKER_REGIONS.write, () => {
			this.db
				.prepare(
					"UPDATE files SET enrichment_state = '{}', enriched_at = NULL WHERE path = ?",
				)
				.run(relativePath);
		});
	}

	/**
	 * Check if a file needs enrichment for a specific document type
	 */
	needsEnrichment(filePath: string, documentType: DocumentType): boolean {
		const state = this.getEnrichmentState(filePath);
		return state[documentType] !== "complete";
	}

	/**
	 * Get all files that need enrichment for a specific document type
	 */
	getFilesNeedingEnrichment(documentType: DocumentType): string[] {
		const rows = this.withRegion(TRACKER_REGIONS.read, () =>
			this.db.prepare("SELECT path, enrichment_state FROM files").all(),
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
	// Document Tracking Methods
	// ========================================================================

	/**
	 * Track a document in the documents table
	 */
	trackDocument(doc: TrackedDocument): void {
		this.withRegion(TRACKER_REGIONS.write, () => {
			const stmt = this.db.prepare(`
			INSERT OR REPLACE INTO documents (id, document_type, file_path, source_ids, created_at, enriched_at, valid_from_commit)
			VALUES (?, ?, ?, ?, ?, ?, ?)
		`);

			stmt.run(
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
	trackDocuments(docs: TrackedDocument[]): void {
		if (docs.length === 0) return;

		// ONE immediate transaction for the batch, where there used to be one
		// autocommit INSERT per document: blockingStatements 2, not N.
		this.withRegion(TRACKER_REGIONS.txn, () => {
			const stmt = this.db.prepare(`
			INSERT OR REPLACE INTO documents (id, document_type, file_path, source_ids, created_at, enriched_at, valid_from_commit)
			VALUES (?, ?, ?, ?, ?, ?, ?)
		`);

			for (const doc of docs) {
				stmt.run(
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
	getDocumentsForFile(filePath: string): TrackedDocument[] {
		const relativePath = this.storedPath(filePath);

		const rows = this.withRegion(TRACKER_REGIONS.read, () =>
			this.db
				.prepare(
					"SELECT id, document_type, file_path, source_ids, created_at, enriched_at FROM documents WHERE file_path = ?",
				)
				.all(relativePath),
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
	getDocumentsByType(documentType: DocumentType): TrackedDocument[] {
		const rows = this.withRegion(TRACKER_REGIONS.read, () =>
			this.db
				.prepare(
					"SELECT id, document_type, file_path, source_ids, created_at, enriched_at FROM documents WHERE document_type = ?",
				)
				.all(documentType),
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
	deleteDocumentsForFile(filePath: string): void {
		const relativePath = this.storedPath(filePath);

		this.withRegion(TRACKER_REGIONS.write, () => {
			this.db
				.prepare("DELETE FROM documents WHERE file_path = ?")
				.run(relativePath);
		});
	}

	/**
	 * Delete documents by type
	 */
	deleteDocumentsByType(documentType: DocumentType): void {
		this.withRegion(TRACKER_REGIONS.write, () => {
			this.db
				.prepare("DELETE FROM documents WHERE document_type = ?")
				.run(documentType);
		});
	}

	/**
	 * Get document count by type
	 */
	getDocumentCounts(): Record<DocumentType, number> {
		const rows = this.withRegion(TRACKER_REGIONS.read, () =>
			this.db
				.prepare(
					"SELECT document_type, COUNT(*) as count FROM documents GROUP BY document_type",
				)
				.all(),
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
	setFileIndexedCommit(filePath: string, sha: string | null): void {
		const relativePath = this.storedPath(filePath);

		this.withRegion(TRACKER_REGIONS.write, () => {
			this.db
				.prepare("UPDATE files SET indexed_at_commit = ? WHERE path = ?")
				.run(sha, relativePath);
		});
	}

	/**
	 * Get the commit a file was indexed at.
	 * Null means either "file not tracked" or "indexed before provenance
	 * existed" — in both cases there is nothing to compare against, never a
	 * reason to hide the file.
	 */
	getFileIndexedCommit(filePath: string): string | null {
		const relativePath = this.storedPath(filePath);

		const row = this.withRegion(TRACKER_REGIONS.read, () =>
			this.db
				.prepare("SELECT indexed_at_commit FROM files WHERE path = ?")
				.get(relativePath),
		) as { indexed_at_commit: string | null } | undefined;
		return row?.indexed_at_commit ?? null;
	}

	/**
	 * Set `valid_from_commit` on the given documents.
	 * Unknown IDs are silently ignored.
	 */
	setDocumentsValidFromCommit(documentIds: string[], sha: string | null): void {
		if (documentIds.length === 0) return;

		this.withRegion(TRACKER_REGIONS.txn, () => {
			const stmt = this.db.prepare(
				"UPDATE documents SET valid_from_commit = ? WHERE id = ?",
			);
			for (const id of documentIds) {
				stmt.run(sha, id);
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
	getDocumentProvenance(documentId: string): DocumentProvenance | null {
		const row = this.withRegion(TRACKER_REGIONS.read, () =>
			this.db
				.prepare(
					"SELECT valid_from_commit, invalidated_at_commit, stale_at_commit FROM documents WHERE id = ?",
				)
				.get(documentId),
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
		filePaths: string[],
		documentTypes: DocumentType[],
		leadingParams: unknown[],
		buildSql: (typePlaceholders: string, pathPlaceholders: string) => string,
	): number {
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
					.run(...leadingParams, ...documentTypes, ...batch);
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
		filePaths: string[],
		documentTypes: DocumentType[],
		sha: string,
	): number {
		return this.updateDocumentsByPath(
			filePaths,
			documentTypes,
			[sha],
			(types, paths) => `
				UPDATE documents SET invalidated_at_commit = ?
				WHERE invalidated_at_commit IS NULL
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
		filePaths: string[],
		documentTypes: DocumentType[],
		sha: string,
	): number {
		return this.updateDocumentsByPath(
			filePaths,
			documentTypes,
			[sha],
			(types, paths) => `
				UPDATE documents SET stale_at_commit = ?
				WHERE stale_at_commit IS NULL
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
	clearDocumentsStale(documentIds: string[]): number {
		if (documentIds.length === 0) return 0;

		return this.withRegion(TRACKER_REGIONS.txn, () => {
			let changed = 0;
			for (const batch of FileTracker.chunk(
				documentIds,
				FileTracker.PATH_BATCH_SIZE,
			)) {
				const result = this.db
					.prepare(
						`UPDATE documents SET stale_at_commit = NULL WHERE id IN (${FileTracker.placeholders(batch.length)})`,
					)
					.run(...batch);
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
		filePaths: string[],
		documentTypes: DocumentType[],
	): number {
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
				WHERE document_type IN (${FileTracker.placeholders(documentTypes.length)})
					AND file_path IN (${FileTracker.placeholders(batch.length)})
			`;
				const row = this.db.prepare(sql).get(...documentTypes, ...batch) as {
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
		filePaths: string[],
		documentTypes: DocumentType[],
	): number {
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
				WHERE path IN (${FileTracker.placeholders(batch.length)})
			`;
				const result = this.db.prepare(sql).run(...jsonPaths, ...batch);
				changed += result.changes;
			}
			return changed;
		});
	}

	/**
	 * Documents currently flagged stale, newest flag first.
	 */
	getStaleDocuments(limit?: number): StaleDocument[] {
		const sql = `
			SELECT id, document_type, file_path, stale_at_commit, created_at
			FROM documents
			WHERE stale_at_commit IS NOT NULL
			ORDER BY created_at DESC
			${limit && limit > 0 ? "LIMIT ?" : ""}
		`;

		const rows = this.withRegion(TRACKER_REGIONS.read, () => {
			const stmt = this.db.prepare(sql);
			return limit && limit > 0 ? stmt.all(limit) : stmt.all();
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
	getDocumentStatusCounts(): DocumentStatusCount[] {
		const rows = this.withRegion(TRACKER_REGIONS.read, () =>
			this.db
				.prepare(`
				SELECT
					document_type,
					COUNT(*) as total,
					SUM(CASE WHEN invalidated_at_commit IS NOT NULL THEN 1 ELSE 0 END) as invalidated,
					SUM(CASE WHEN stale_at_commit IS NOT NULL THEN 1 ELSE 0 END) as stale
				FROM documents
				GROUP BY document_type
			`)
				.all(),
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
			(library, version, provider, content_hash, fetched_at, chunk_ids)
			VALUES (?, ?, ?, ?, ?, ?)
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
			WHERE library = ? AND (version = ? OR (version IS NULL AND ? IS NULL))
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
						"DELETE FROM indexed_docs WHERE library = ? AND (version = ? OR (version IS NULL AND ? IS NULL))",
					)
					.run(library, version, version);
			} else {
				this.db
					.prepare("DELETE FROM indexed_docs WHERE library = ?")
					.run(library);
			}
		});
	}

	/**
	 * Clear all indexed documentation
	 */
	clearAllIndexedDocs(): void {
		this.withRegion(TRACKER_REGIONS.write, () => {
			this.db.exec("DELETE FROM indexed_docs");
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
							"SELECT COUNT(DISTINCT library) as count FROM indexed_docs",
						)
						.get() as { count: number }
				).count,
				docs: this.db
					.prepare("SELECT chunk_ids FROM indexed_docs")
					.all() as Array<{ chunk_ids: string }>,
				providerRows: this.db
					.prepare(
						"SELECT provider, COUNT(*) as count FROM indexed_docs GROUP BY provider",
					)
					.all() as Array<{ provider: string; count: number }>,
				times: this.db
					.prepare(
						"SELECT MIN(fetched_at) as oldest, MAX(fetched_at) as newest FROM indexed_docs",
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

	// ========================================================================
	// Symbol CRUD Methods
	// ========================================================================

	/**
	 * Insert a single symbol
	 */
	insertSymbol(symbol: SymbolDefinition): void {
		this.withRegion(TRACKER_REGIONS.write, () => {
			const stmt = this.db.prepare(`
			INSERT OR REPLACE INTO symbols
			(id, name, kind, file_path, start_line, end_line, signature, docstring,
			 parent_id, is_exported, language, pagerank, in_degree, out_degree, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);

			stmt.run(
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

	/**
	 * Insert multiple symbols in ONE immediate transaction (batched)
	 */
	insertSymbols(symbols: SymbolDefinition[]): void {
		if (symbols.length === 0) return;

		// BEGIN IMMEDIATE inside the region, not `db.transaction()`: that is a
		// DEFERRED begin in sqlite.ts's Bun branch, and R-txn's count of 2 rests
		// on the write lock being taken at BEGIN (architecture §5.3, N32).
		this.withRegion(TRACKER_REGIONS.txn, () => {
			const stmt = this.db.prepare(`
			INSERT OR REPLACE INTO symbols
			(id, name, kind, file_path, start_line, end_line, signature, docstring,
			 parent_id, is_exported, language, pagerank, in_degree, out_degree, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);

			for (const symbol of symbols) {
				stmt.run(
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

	/**
	 * Get a symbol by ID
	 */
	getSymbol(id: string): SymbolDefinition | null {
		const row = this.withRegion(TRACKER_REGIONS.read, () =>
			this.db.prepare("SELECT * FROM symbols WHERE id = ?").get(id),
		) as Record<string, unknown> | undefined;
		return row ? this.rowToSymbol(row) : null;
	}

	/**
	 * Get all symbols for a file
	 */
	getSymbolsByFile(filePath: string): SymbolDefinition[] {
		const relativePath = this.storedPath(filePath);

		const rows = this.withRegion(TRACKER_REGIONS.read, () =>
			this.db
				.prepare("SELECT * FROM symbols WHERE file_path = ?")
				.all(relativePath),
		) as Array<Record<string, unknown>>;
		return rows.map((row) => this.rowToSymbol(row));
	}

	/**
	 * Get symbols by name (with optional kind filter)
	 */
	getSymbolByName(name: string, kind?: SymbolKind): SymbolDefinition[] {
		const rows = this.withRegion(TRACKER_REGIONS.read, () =>
			kind
				? this.db
						.prepare("SELECT * FROM symbols WHERE name = ? AND kind = ?")
						.all(name, kind)
				: this.db.prepare("SELECT * FROM symbols WHERE name = ?").all(name),
		) as Array<Record<string, unknown>>;

		return rows.map((row) => this.rowToSymbol(row));
	}

	/**
	 * Get all symbols whose parent_id matches the given parentId
	 */
	getSymbolsByParent(parentId: string): SymbolDefinition[] {
		const rows = this.withRegion(TRACKER_REGIONS.read, () =>
			this.db
				.prepare("SELECT * FROM symbols WHERE parent_id = ?")
				.all(parentId),
		) as Array<Record<string, unknown>>;
		return rows.map((row) => this.rowToSymbol(row));
	}

	/**
	 * Get all symbols
	 */
	getAllSymbols(): SymbolDefinition[] {
		const rows = this.withRegion(TRACKER_REGIONS.read, () =>
			this.db.prepare("SELECT * FROM symbols").all(),
		) as Array<Record<string, unknown>>;
		return rows.map((row) => this.rowToSymbol(row));
	}

	/**
	 * Get top symbols by PageRank score
	 */
	getTopSymbols(limit: number): SymbolDefinition[] {
		const rows = this.withRegion(TRACKER_REGIONS.read, () =>
			this.db
				.prepare("SELECT * FROM symbols ORDER BY pagerank DESC LIMIT ?")
				.all(limit),
		) as Array<Record<string, unknown>>;
		return rows.map((row) => this.rowToSymbol(row));
	}

	/**
	 * Delete all symbols for a file
	 */
	deleteSymbolsByFile(filePath: string): void {
		const relativePath = this.storedPath(filePath);

		this.withRegion(TRACKER_REGIONS.txn, () => {
			// Delete references first (cascade would handle this, but be explicit)
			this.db
				.prepare("DELETE FROM symbol_references WHERE file_path = ?")
				.run(relativePath);

			// Delete symbols
			this.db
				.prepare("DELETE FROM symbols WHERE file_path = ?")
				.run(relativePath);
		});
	}

	/**
	 * Convert database row to SymbolDefinition
	 */
	private rowToSymbol(row: Record<string, unknown>): SymbolDefinition {
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

	// ========================================================================
	// Reference CRUD Methods
	// ========================================================================

	/**
	 * Insert a single reference
	 */
	insertReference(ref: SymbolReference): void {
		this.withRegion(TRACKER_REGIONS.write, () => {
			const stmt = this.db.prepare(`
			INSERT INTO symbol_references
			(from_symbol_id, to_symbol_name, to_symbol_id, kind, file_path, line, is_resolved, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		`);

			stmt.run(
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

	/**
	 * Insert multiple references in ONE immediate transaction (batched)
	 */
	insertReferences(refs: SymbolReference[]): void {
		if (refs.length === 0) return;

		// BEGIN IMMEDIATE inside the region, not `db.transaction()` (N32).
		this.withRegion(TRACKER_REGIONS.txn, () => {
			const stmt = this.db.prepare(`
			INSERT INTO symbol_references
			(from_symbol_id, to_symbol_name, to_symbol_id, kind, file_path, line, is_resolved, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		`);

			for (const ref of refs) {
				stmt.run(
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

	/**
	 * Get all references from a symbol
	 */
	getReferencesFrom(symbolId: string): SymbolReference[] {
		const rows = this.withRegion(TRACKER_REGIONS.read, () =>
			this.db
				.prepare("SELECT * FROM symbol_references WHERE from_symbol_id = ?")
				.all(symbolId),
		) as Array<Record<string, unknown>>;
		return rows.map((row) => this.rowToReference(row));
	}

	/**
	 * Get all references to a symbol
	 */
	getReferencesTo(symbolId: string): SymbolReference[] {
		const rows = this.withRegion(TRACKER_REGIONS.read, () =>
			this.db
				.prepare("SELECT * FROM symbol_references WHERE to_symbol_id = ?")
				.all(symbolId),
		) as Array<Record<string, unknown>>;
		return rows.map((row) => this.rowToReference(row));
	}

	/**
	 * Get all unresolved references
	 */
	getUnresolvedReferences(): SymbolReference[] {
		const rows = this.withRegion(TRACKER_REGIONS.read, () =>
			this.db
				.prepare("SELECT * FROM symbol_references WHERE is_resolved = 0")
				.all(),
		) as Array<Record<string, unknown>>;
		return rows.map((row) => this.rowToReference(row));
	}

	/**
	 * Get all references
	 */
	getAllReferences(): SymbolReference[] {
		const rows = this.withRegion(TRACKER_REGIONS.read, () =>
			this.db.prepare("SELECT * FROM symbol_references").all(),
		) as Array<Record<string, unknown>>;
		return rows.map((row) => this.rowToReference(row));
	}

	/**
	 * Resolve a reference to a symbol
	 */
	resolveReference(refId: number, toSymbolId: string): void {
		this.withRegion(TRACKER_REGIONS.write, () => {
			this.db
				.prepare(
					"UPDATE symbol_references SET to_symbol_id = ?, is_resolved = 1 WHERE id = ?",
				)
				.run(toSymbolId, refId);
		});
	}

	/**
	 * Bulk resolve references by name
	 * Resolves all unresolved references matching a symbol name
	 *
	 * `+s.is_exported`, NOT `s.is_exported`: the unary plus is load-bearing.
	 * It stops that term from using an index, so the planner answers both
	 * subqueries from `idx_symbols_name (name=?)`. Without it — and a tracker
	 * database has no ANALYZE statistics — SQLite picks the partial index
	 * `idx_symbols_exported`, and every unresolved reference walks EVERY
	 * exported symbol, twice, inside this ONE synchronous statement. Measured:
	 * 5.4 s at 8 000 exported x 20 000 references, and a lock heartbeat frozen
	 * for 34.5 s at 20 000 x 40 000, past the 10 s stale rule (CLAUDE.md #31).
	 * No caller-side yield can split one statement.
	 *
	 * The result set is unchanged: `+` is a no-op on the value, and both plans
	 * visit a name's exported rows in rowid order, so `LIMIT 1` picks the same
	 * row. `tracker-resolve-plan.test.ts` pins the PLAN (not a timing) and the
	 * rows against the pre-fix statement.
	 */
	resolveReferencesByName(): number {
		// Resolve references where target_name matches a symbol name exactly
		const result = this.withRegion(TRACKER_REGIONS.write, () =>
			this.db
				.prepare(`
			UPDATE symbol_references
			SET to_symbol_id = (
				SELECT s.id FROM symbols s
				WHERE s.name = symbol_references.to_symbol_name
				AND +s.is_exported = 1
				LIMIT 1
			),
			is_resolved = 1
			WHERE is_resolved = 0
			AND EXISTS (
				SELECT 1 FROM symbols s
				WHERE s.name = symbol_references.to_symbol_name
				AND +s.is_exported = 1
			)
		`)
				.run(),
		);

		return result.changes;
	}

	/**
	 * Delete all references for a file
	 */
	deleteReferencesByFile(filePath: string): void {
		const relativePath = this.storedPath(filePath);

		this.withRegion(TRACKER_REGIONS.write, () => {
			this.db
				.prepare("DELETE FROM symbol_references WHERE file_path = ?")
				.run(relativePath);
		});
	}

	/**
	 * Convert database row to SymbolReference
	 */
	private rowToReference(row: Record<string, unknown>): SymbolReference {
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

	// ========================================================================
	// PageRank and Graph Metadata Methods
	// ========================================================================

	/**
	 * Update PageRank scores for all symbols
	 */
	updatePageRankScores(scores: Map<string, number>): void {
		// ONE immediate transaction for the scores AND the timestamp that says they
		// were computed. They used to be a transaction followed by a second,
		// separate write — two regions with no yield between them (SR-2).
		this.withRegion(TRACKER_REGIONS.txn, () => {
			const stmt = this.db.prepare(
				"UPDATE symbols SET pagerank = ? WHERE id = ?",
			);
			for (const [id, score] of scores) {
				stmt.run(score, id);
			}

			const now = new Date().toISOString();
			this.db
				.prepare(
					"INSERT OR REPLACE INTO graph_metadata (key, value, updated_at) VALUES (?, ?, ?)",
				)
				.run("pagerank_last_computed", now, now);
		});
	}

	/**
	 * Update in/out degree counts for all symbols
	 */
	updateDegreeCounts(): void {
		this.withRegion(TRACKER_REGIONS.txn, () => {
			// Update in_degree
			this.db.exec(`
			UPDATE symbols SET in_degree = (
				SELECT COUNT(*) FROM symbol_references r
				WHERE r.to_symbol_id = symbols.id
			)
		`);

			// Update out_degree
			this.db.exec(`
			UPDATE symbols SET out_degree = (
				SELECT COUNT(*) FROM symbol_references r
				WHERE r.from_symbol_id = symbols.id
			)
		`);
		});
	}

	/**
	 * Get graph metadata value
	 */
	getGraphMetadata(key: string): string | null {
		const row = this.withRegion(TRACKER_REGIONS.read, () =>
			this.db
				.prepare("SELECT value FROM graph_metadata WHERE key = ?")
				.get(key),
		) as { value: string } | undefined;
		return row?.value || null;
	}

	/**
	 * Set graph metadata value
	 */
	setGraphMetadata(key: string, value: string): void {
		this.withRegion(TRACKER_REGIONS.write, () => {
			this.db
				.prepare(
					"INSERT OR REPLACE INTO graph_metadata (key, value, updated_at) VALUES (?, ?, ?)",
				)
				.run(key, value, new Date().toISOString());
		});
	}

	/**
	 * Get symbol graph statistics
	 */
	getSymbolGraphStats(): SymbolGraphStats {
		// Six SELECTs in ONE region. The pagerank timestamp is read here rather
		// than through getGraphMetadata(), which would be a second region with no
		// yield before it (SR-2).
		const raw = this.withRegion(reads(6), () => ({
			symbolCount: (
				this.db.prepare("SELECT COUNT(*) as count FROM symbols").get() as {
					count: number;
				}
			).count,
			refCount: (
				this.db
					.prepare("SELECT COUNT(*) as count FROM symbol_references")
					.get() as { count: number }
			).count,
			resolvedCount: (
				this.db
					.prepare(
						"SELECT COUNT(*) as count FROM symbol_references WHERE is_resolved = 1",
					)
					.get() as { count: number }
			).count,
			kindRows: this.db
				.prepare("SELECT kind, COUNT(*) as count FROM symbols GROUP BY kind")
				.all() as Array<{ kind: string; count: number }>,
			refKindRows: this.db
				.prepare(
					"SELECT kind, COUNT(*) as count FROM symbol_references GROUP BY kind",
				)
				.all() as Array<{ kind: string; count: number }>,
			pagerank: this.db
				.prepare("SELECT value FROM graph_metadata WHERE key = ?")
				.get("pagerank_last_computed") as { value: string } | undefined,
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
	 * Clear all symbol graph data
	 */
	clearSymbolGraph(): void {
		this.withRegion(TRACKER_REGIONS.txn, () => {
			this.db.exec("DELETE FROM symbol_references");
			this.db.exec("DELETE FROM symbols");
			this.db.exec("DELETE FROM graph_metadata");
		});
	}
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
