/**
 * File State Tracker
 *
 * Tracks file states using SQLite for efficient incremental indexing.
 * Uses content hashes and mtimes for fast change detection.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative } from "node:path";
import type {
	DocumentType,
	DocProviderType,
	EnrichmentState,
	FileState,
	SymbolDefinition,
	SymbolReference,
	SymbolKind,
	ReferenceKind,
	SymbolGraphStats,
} from "../types.js";
import { createDatabaseSync, type SQLiteDatabase } from "./sqlite.js";

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
	markIndexed(filePath: string, contentHash: string, chunkIds: string[]): void;
	getChunkIds(filePath: string): string[];
	removeFile(filePath: string): void;
	getFileState(filePath: string): FileState | null;
	getAllFiles(): FileState[];
	getMetadata(key: string): string | null;
	setMetadata(key: string, value: string): void;
	getStats(): { totalFiles: number; lastIndexed: string | null };
	clear(): void;
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
}

// ============================================================================
// File Tracker Class
// ============================================================================

export class FileTracker implements IFileTracker {
	private db: SQLiteDatabase;
	private projectRoot: string;

	constructor(dbPath: string, projectRoot: string) {
		// Ensure directory exists
		const dir = dirname(dbPath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}

		this.projectRoot = projectRoot;
		this.db = createDatabaseSync(dbPath);
		this.initializeSchema();
	}

	/**
	 * Initialize the database schema
	 */
	private initializeSchema(): void {
		this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL,
        mtime REAL NOT NULL,
        chunk_ids TEXT NOT NULL,
        indexed_at TEXT NOT NULL,
        enrichment_state TEXT DEFAULT '{}',
        enriched_at TEXT
      );

      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        document_type TEXT NOT NULL,
        file_path TEXT,
        source_ids TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        enriched_at TEXT
      );

      CREATE TABLE IF NOT EXISTS indexed_docs (
        library TEXT NOT NULL,
        version TEXT,
        provider TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        chunk_ids TEXT NOT NULL,
        PRIMARY KEY (library, version, provider)
      );

      CREATE INDEX IF NOT EXISTS idx_files_content_hash ON files(content_hash);
      CREATE INDEX IF NOT EXISTS idx_documents_file_path ON documents(file_path);
      CREATE INDEX IF NOT EXISTS idx_documents_type ON documents(document_type);
      CREATE INDEX IF NOT EXISTS idx_indexed_docs_library ON indexed_docs(library);
      CREATE INDEX IF NOT EXISTS idx_indexed_docs_fetched ON indexed_docs(fetched_at);
    `);

		// Symbol graph tables
		this.initializeSymbolGraphSchema();

		// Activity log table (for monitor mode)
		this.db.exec(`
      CREATE TABLE IF NOT EXISTS activity_log (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        type      TEXT    NOT NULL,
        metadata  TEXT    NOT NULL,
        timestamp TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_activity_log_id ON activity_log(id);
    `);

		// Migration: Add enrichment columns if they don't exist (for existing databases)
		this.migrateSchema();
	}

	/**
	 * Migrate schema for existing databases
	 */
	private migrateSchema(): void {
		try {
			// Check if enrichment_state column exists
			const columns = this.db
				.prepare("PRAGMA table_info(files)")
				.all() as Array<{ name: string }>;
			const columnNames = columns.map((c) => c.name);

			if (!columnNames.includes("enrichment_state")) {
				this.db.exec(
					"ALTER TABLE files ADD COLUMN enrichment_state TEXT DEFAULT '{}'",
				);
			}
			if (!columnNames.includes("enriched_at")) {
				this.db.exec("ALTER TABLE files ADD COLUMN enriched_at TEXT");
			}
		} catch {
			// Ignore migration errors (columns might already exist)
		}
	}

	/**
	 * Get changes between current files and indexed state
	 */
	getChanges(currentFiles: string[]): FileChanges {
		const newFiles: string[] = [];
		const modifiedFiles: string[] = [];
		const unchangedFiles: string[] = [];

		// Get all indexed files
		const indexedFiles = new Set<string>();
		const stmt = this.db.prepare("SELECT path, content_hash, mtime FROM files");
		const indexed = stmt.all() as Array<{
			path: string;
			content_hash: string;
			mtime: number;
		}>;

		const indexedMap = new Map(indexed.map((f) => [f.path, f]));
		for (const f of indexed) {
			indexedFiles.add(f.path);
		}

		// Check each current file
		for (const filePath of currentFiles) {
			const relativePath = relative(this.projectRoot, filePath);

			if (!indexedMap.has(relativePath)) {
				// New file
				newFiles.push(filePath);
			} else {
				// Check if modified
				const indexedFile = indexedMap.get(relativePath)!;

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
							this.updateMtime(relativePath, currentMtime);
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
		}

		// Find deleted files
		const currentSet = new Set(
			currentFiles.map((f) => relative(this.projectRoot, f)),
		);
		const deletedFiles: string[] = [];

		for (const indexedPath of indexedFiles) {
			if (!currentSet.has(indexedPath)) {
				deletedFiles.push(indexedPath);
			}
		}

		return { newFiles, modifiedFiles, deletedFiles, unchangedFiles };
	}

	/**
	 * Mark a file as indexed
	 */
	markIndexed(filePath: string, contentHash: string, chunkIds: string[]): void {
		const relativePath = relative(this.projectRoot, filePath);

		let mtime: number;
		try {
			const stat = statSync(filePath);
			mtime = stat.mtimeMs;
		} catch {
			mtime = Date.now();
		}

		const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO files (path, content_hash, mtime, chunk_ids, indexed_at)
      VALUES (?, ?, ?, ?, ?)
    `);

		stmt.run(
			relativePath,
			contentHash,
			mtime,
			JSON.stringify(chunkIds),
			new Date().toISOString(),
		);
	}

	/**
	 * Get chunk IDs for a file
	 */
	getChunkIds(filePath: string): string[] {
		const relativePath = relative(this.projectRoot, filePath);

		const stmt = this.db.prepare("SELECT chunk_ids FROM files WHERE path = ?");
		const row = stmt.get(relativePath) as { chunk_ids: string } | undefined;

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
		// Handle both absolute and relative paths
		const relativePath = filePath.startsWith(this.projectRoot)
			? relative(this.projectRoot, filePath)
			: filePath;

		const stmt = this.db.prepare("DELETE FROM files WHERE path = ?");
		stmt.run(relativePath);
	}

	/**
	 * Get file state
	 */
	getFileState(filePath: string): FileState | null {
		const relativePath = relative(this.projectRoot, filePath);

		const stmt = this.db.prepare(
			"SELECT path, content_hash, mtime, chunk_ids FROM files WHERE path = ?",
		);
		const row = stmt.get(relativePath) as
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
		const stmt = this.db.prepare(
			"SELECT path, content_hash, mtime, chunk_ids FROM files",
		);
		const rows = stmt.all() as Array<{
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
		const stmt = this.db.prepare("SELECT value FROM metadata WHERE key = ?");
		const row = stmt.get(key) as { value: string } | undefined;
		return row?.value || null;
	}

	/**
	 * Set metadata value
	 */
	setMetadata(key: string, value: string): void {
		const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)
    `);
		stmt.run(key, value);
	}

	/**
	 * Get statistics
	 */
	getStats(): { totalFiles: number; lastIndexed: string | null } {
		const countStmt = this.db.prepare("SELECT COUNT(*) as count FROM files");
		const countRow = countStmt.get() as { count: number };

		const lastStmt = this.db.prepare(
			"SELECT MAX(indexed_at) as last FROM files",
		);
		const lastRow = lastStmt.get() as { last: string | null };

		return {
			totalFiles: countRow.count,
			lastIndexed: lastRow.last,
		};
	}

	/**
	 * Clear all data
	 */
	clear(): void {
		this.db.exec("DELETE FROM files");
		this.db.exec("DELETE FROM metadata");
		this.db.exec("DELETE FROM documents");
		this.db.exec("DELETE FROM indexed_docs");
	}

	// ========================================================================
	// Activity Log Methods (for monitor mode)
	// ========================================================================

	/**
	 * Record a tool activity in the activity_log table.
	 * Returns the inserted row ID.
	 */
	recordActivity(type: string, metadata: Record<string, unknown>): number {
		const stmt = this.db.prepare(
			"INSERT INTO activity_log (type, metadata, timestamp) VALUES (?, ?, ?)",
		);
		const result = stmt.run(
			type,
			JSON.stringify(metadata),
			new Date().toISOString(),
		);
		return Number(result.lastInsertRowid);
	}

	/**
	 * Get activity rows with id > sinceId, ordered ASC.
	 * Used by the TUI monitor to poll for new activity.
	 */
	getActivity(sinceId = 0, limit = 50): ActivityRow[] {
		const stmt = this.db.prepare(
			"SELECT id, type, metadata, timestamp FROM activity_log WHERE id > ? ORDER BY id ASC LIMIT ?",
		);
		return stmt.all(sinceId, limit) as ActivityRow[];
	}

	/**
	 * Prune old activity rows, keeping only the last keepCount rows.
	 * Called periodically by the TUI to prevent unbounded growth.
	 */
	pruneActivity(keepCount = 200): void {
		this.db.exec(`
      DELETE FROM activity_log WHERE id NOT IN (
        SELECT id FROM activity_log ORDER BY id DESC LIMIT ${keepCount}
      )
    `);
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
		const relativePath = relative(this.projectRoot, filePath);

		const stmt = this.db.prepare(
			"SELECT enrichment_state FROM files WHERE path = ?",
		);
		const row = stmt.get(relativePath) as
			| { enrichment_state: string }
			| undefined;

		if (!row || !row.enrichment_state) {
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
		const relativePath = relative(this.projectRoot, filePath);

		// Get current state
		const current = this.getEnrichmentState(filePath);
		current[documentType] = state;

		const stmt = this.db.prepare(`
			UPDATE files SET enrichment_state = ?, enriched_at = ?
			WHERE path = ?
		`);

		stmt.run(
			JSON.stringify(current),
			state === "complete" ? new Date().toISOString() : null,
			relativePath,
		);
	}

	/**
	 * Set all enrichment states for a file at once
	 */
	setAllEnrichmentStates(filePath: string, states: EnrichmentStateMap): void {
		const relativePath = relative(this.projectRoot, filePath);

		const hasComplete = Object.values(states).some((s) => s === "complete");

		const stmt = this.db.prepare(`
			UPDATE files SET enrichment_state = ?, enriched_at = ?
			WHERE path = ?
		`);

		stmt.run(
			JSON.stringify(states),
			hasComplete ? new Date().toISOString() : null,
			relativePath,
		);
	}

	/**
	 * Reset enrichment state for a file (e.g., when file is modified)
	 */
	resetEnrichmentState(filePath: string): void {
		const relativePath = relative(this.projectRoot, filePath);

		const stmt = this.db.prepare(`
			UPDATE files SET enrichment_state = '{}', enriched_at = NULL
			WHERE path = ?
		`);

		stmt.run(relativePath);
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
		const stmt = this.db.prepare("SELECT path, enrichment_state FROM files");
		const rows = stmt.all() as Array<{
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
		const stmt = this.db.prepare(`
			INSERT OR REPLACE INTO documents (id, document_type, file_path, source_ids, created_at, enriched_at)
			VALUES (?, ?, ?, ?, ?, ?)
		`);

		stmt.run(
			doc.id,
			doc.documentType,
			doc.filePath,
			JSON.stringify(doc.sourceIds),
			doc.createdAt,
			doc.enrichedAt || null,
		);
	}

	/**
	 * Track multiple documents at once
	 */
	trackDocuments(docs: TrackedDocument[]): void {
		const stmt = this.db.prepare(`
			INSERT OR REPLACE INTO documents (id, document_type, file_path, source_ids, created_at, enriched_at)
			VALUES (?, ?, ?, ?, ?, ?)
		`);

		for (const doc of docs) {
			stmt.run(
				doc.id,
				doc.documentType,
				doc.filePath,
				JSON.stringify(doc.sourceIds),
				doc.createdAt,
				doc.enrichedAt || null,
			);
		}
	}

	/**
	 * Get all tracked documents for a file
	 */
	getDocumentsForFile(filePath: string): TrackedDocument[] {
		const relativePath = relative(this.projectRoot, filePath);

		const stmt = this.db.prepare(
			"SELECT id, document_type, file_path, source_ids, created_at, enriched_at FROM documents WHERE file_path = ?",
		);
		const rows = stmt.all(relativePath) as Array<{
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
		const stmt = this.db.prepare(
			"SELECT id, document_type, file_path, source_ids, created_at, enriched_at FROM documents WHERE document_type = ?",
		);
		const rows = stmt.all(documentType) as Array<{
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
		const relativePath = relative(this.projectRoot, filePath);

		const stmt = this.db.prepare("DELETE FROM documents WHERE file_path = ?");
		stmt.run(relativePath);
	}

	/**
	 * Delete documents by type
	 */
	deleteDocumentsByType(documentType: DocumentType): void {
		const stmt = this.db.prepare(
			"DELETE FROM documents WHERE document_type = ?",
		);
		stmt.run(documentType);
	}

	/**
	 * Get document count by type
	 */
	getDocumentCounts(): Record<DocumentType, number> {
		const stmt = this.db.prepare(
			"SELECT document_type, COUNT(*) as count FROM documents GROUP BY document_type",
		);
		const rows = stmt.all() as Array<{ document_type: string; count: number }>;

		const counts: Record<string, number> = {};
		for (const row of rows) {
			counts[row.document_type] = row.count;
		}

		return counts as Record<DocumentType, number>;
	}

	/**
	 * Update mtime for a file without changing other fields
	 */
	private updateMtime(relativePath: string, mtime: number): void {
		const stmt = this.db.prepare("UPDATE files SET mtime = ? WHERE path = ?");
		stmt.run(mtime, relativePath);
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
		const stmt = this.db.prepare(`
			SELECT library, version, provider, content_hash, fetched_at, chunk_ids
			FROM indexed_docs
			WHERE library = ? AND (version = ? OR (version IS NULL AND ? IS NULL))
		`);

		const row = stmt.get(library, version || null, version || null) as
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
		const stmt = this.db.prepare(`
			SELECT library, version, provider, content_hash, fetched_at, chunk_ids
			FROM indexed_docs
			ORDER BY library, version
		`);

		const rows = stmt.all() as Array<{
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
		if (version !== undefined) {
			const stmt = this.db.prepare(
				"DELETE FROM indexed_docs WHERE library = ? AND (version = ? OR (version IS NULL AND ? IS NULL))",
			);
			stmt.run(library, version, version);
		} else {
			const stmt = this.db.prepare(
				"DELETE FROM indexed_docs WHERE library = ?",
			);
			stmt.run(library);
		}
	}

	/**
	 * Clear all indexed documentation
	 */
	clearAllIndexedDocs(): void {
		this.db.exec("DELETE FROM indexed_docs");
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
		const countStmt = this.db.prepare(
			"SELECT COUNT(DISTINCT library) as count FROM indexed_docs",
		);
		const totalLibraries = (countStmt.get() as { count: number }).count;

		// Count total chunks across all docs
		const docsStmt = this.db.prepare("SELECT chunk_ids FROM indexed_docs");
		const docs = docsStmt.all() as Array<{ chunk_ids: string }>;
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
		const providerStmt = this.db.prepare(
			"SELECT provider, COUNT(*) as count FROM indexed_docs GROUP BY provider",
		);
		const providerRows = providerStmt.all() as Array<{
			provider: string;
			count: number;
		}>;
		const byProvider: Record<string, number> = {};
		for (const row of providerRows) {
			byProvider[row.provider] = row.count;
		}

		// Get oldest and newest fetch times
		const timeStmt = this.db.prepare(`
			SELECT MIN(fetched_at) as oldest, MAX(fetched_at) as newest FROM indexed_docs
		`);
		const times = timeStmt.get() as {
			oldest: string | null;
			newest: string | null;
		};

		return {
			totalLibraries,
			totalChunks,
			byProvider: byProvider as Record<DocProviderType, number>,
			oldestFetch: times.oldest,
			newestFetch: times.newest,
		};
	}

	// ========================================================================
	// Symbol Graph Schema
	// ========================================================================

	/**
	 * Initialize symbol graph tables
	 */
	private initializeSymbolGraphSchema(): void {
		this.db.exec(`
			-- Symbols table
			CREATE TABLE IF NOT EXISTS symbols (
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
			);

			-- References table
			CREATE TABLE IF NOT EXISTS symbol_references (
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
			);

			-- Graph metadata table
			CREATE TABLE IF NOT EXISTS graph_metadata (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);

			-- Indexes for symbols
			CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
			CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_path);
			CREATE INDEX IF NOT EXISTS idx_symbols_kind ON symbols(kind);
			CREATE INDEX IF NOT EXISTS idx_symbols_pagerank ON symbols(pagerank DESC);
			CREATE INDEX IF NOT EXISTS idx_symbols_parent ON symbols(parent_id);
			CREATE INDEX IF NOT EXISTS idx_symbols_exported ON symbols(is_exported) WHERE is_exported = 1;

			-- Indexes for references
			CREATE INDEX IF NOT EXISTS idx_refs_from ON symbol_references(from_symbol_id);
			CREATE INDEX IF NOT EXISTS idx_refs_to ON symbol_references(to_symbol_id);
			CREATE INDEX IF NOT EXISTS idx_refs_to_name ON symbol_references(to_symbol_name);
			CREATE INDEX IF NOT EXISTS idx_refs_file ON symbol_references(file_path);
			CREATE INDEX IF NOT EXISTS idx_refs_kind ON symbol_references(kind);
		`);
	}

	// ========================================================================
	// Symbol CRUD Methods
	// ========================================================================

	/**
	 * Insert a single symbol
	 */
	insertSymbol(symbol: SymbolDefinition): void {
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
	}

	/**
	 * Insert multiple symbols in a transaction (batched)
	 */
	insertSymbols(symbols: SymbolDefinition[]): void {
		if (symbols.length === 0) return;

		const stmt = this.db.prepare(`
			INSERT OR REPLACE INTO symbols
			(id, name, kind, file_path, start_line, end_line, signature, docstring,
			 parent_id, is_exported, language, pagerank, in_degree, out_degree, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);

		this.db.transaction(() => {
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
		const stmt = this.db.prepare("SELECT * FROM symbols WHERE id = ?");
		const row = stmt.get(id) as Record<string, unknown> | undefined;
		return row ? this.rowToSymbol(row) : null;
	}

	/**
	 * Get all symbols for a file
	 */
	getSymbolsByFile(filePath: string): SymbolDefinition[] {
		const relativePath = filePath.startsWith(this.projectRoot)
			? relative(this.projectRoot, filePath)
			: filePath;

		const stmt = this.db.prepare("SELECT * FROM symbols WHERE file_path = ?");
		const rows = stmt.all(relativePath) as Array<Record<string, unknown>>;
		return rows.map((row) => this.rowToSymbol(row));
	}

	/**
	 * Get symbols by name (with optional kind filter)
	 */
	getSymbolByName(name: string, kind?: SymbolKind): SymbolDefinition[] {
		let stmt;
		let rows: Array<Record<string, unknown>>;

		if (kind) {
			stmt = this.db.prepare(
				"SELECT * FROM symbols WHERE name = ? AND kind = ?",
			);
			rows = stmt.all(name, kind) as Array<Record<string, unknown>>;
		} else {
			stmt = this.db.prepare("SELECT * FROM symbols WHERE name = ?");
			rows = stmt.all(name) as Array<Record<string, unknown>>;
		}

		return rows.map((row) => this.rowToSymbol(row));
	}

	/**
	 * Get all symbols
	 */
	getAllSymbols(): SymbolDefinition[] {
		const stmt = this.db.prepare("SELECT * FROM symbols");
		const rows = stmt.all() as Array<Record<string, unknown>>;
		return rows.map((row) => this.rowToSymbol(row));
	}

	/**
	 * Get top symbols by PageRank score
	 */
	getTopSymbols(limit: number): SymbolDefinition[] {
		const stmt = this.db.prepare(
			"SELECT * FROM symbols ORDER BY pagerank DESC LIMIT ?",
		);
		const rows = stmt.all(limit) as Array<Record<string, unknown>>;
		return rows.map((row) => this.rowToSymbol(row));
	}

	/**
	 * Delete all symbols for a file
	 */
	deleteSymbolsByFile(filePath: string): void {
		const relativePath = filePath.startsWith(this.projectRoot)
			? relative(this.projectRoot, filePath)
			: filePath;

		// Delete references first (cascade would handle this, but be explicit)
		this.db
			.prepare("DELETE FROM symbol_references WHERE file_path = ?")
			.run(relativePath);

		// Delete symbols
		this.db
			.prepare("DELETE FROM symbols WHERE file_path = ?")
			.run(relativePath);
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
	}

	/**
	 * Insert multiple references in a transaction (batched)
	 */
	insertReferences(refs: SymbolReference[]): void {
		if (refs.length === 0) return;

		const stmt = this.db.prepare(`
			INSERT INTO symbol_references
			(from_symbol_id, to_symbol_name, to_symbol_id, kind, file_path, line, is_resolved, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		`);

		this.db.transaction(() => {
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
		const stmt = this.db.prepare(
			"SELECT * FROM symbol_references WHERE from_symbol_id = ?",
		);
		const rows = stmt.all(symbolId) as Array<Record<string, unknown>>;
		return rows.map((row) => this.rowToReference(row));
	}

	/**
	 * Get all references to a symbol
	 */
	getReferencesTo(symbolId: string): SymbolReference[] {
		const stmt = this.db.prepare(
			"SELECT * FROM symbol_references WHERE to_symbol_id = ?",
		);
		const rows = stmt.all(symbolId) as Array<Record<string, unknown>>;
		return rows.map((row) => this.rowToReference(row));
	}

	/**
	 * Get all unresolved references
	 */
	getUnresolvedReferences(): SymbolReference[] {
		const stmt = this.db.prepare(
			"SELECT * FROM symbol_references WHERE is_resolved = 0",
		);
		const rows = stmt.all() as Array<Record<string, unknown>>;
		return rows.map((row) => this.rowToReference(row));
	}

	/**
	 * Get all references
	 */
	getAllReferences(): SymbolReference[] {
		const stmt = this.db.prepare("SELECT * FROM symbol_references");
		const rows = stmt.all() as Array<Record<string, unknown>>;
		return rows.map((row) => this.rowToReference(row));
	}

	/**
	 * Resolve a reference to a symbol
	 */
	resolveReference(refId: number, toSymbolId: string): void {
		const stmt = this.db.prepare(
			"UPDATE symbol_references SET to_symbol_id = ?, is_resolved = 1 WHERE id = ?",
		);
		stmt.run(toSymbolId, refId);
	}

	/**
	 * Bulk resolve references by name
	 * Resolves all unresolved references matching a symbol name
	 */
	resolveReferencesByName(): number {
		// Resolve references where target_name matches a symbol name exactly
		const result = this.db
			.prepare(`
			UPDATE symbol_references
			SET to_symbol_id = (
				SELECT s.id FROM symbols s
				WHERE s.name = symbol_references.to_symbol_name
				AND s.is_exported = 1
				LIMIT 1
			),
			is_resolved = 1
			WHERE is_resolved = 0
			AND EXISTS (
				SELECT 1 FROM symbols s
				WHERE s.name = symbol_references.to_symbol_name
				AND s.is_exported = 1
			)
		`)
			.run();

		return result.changes;
	}

	/**
	 * Delete all references for a file
	 */
	deleteReferencesByFile(filePath: string): void {
		const relativePath = filePath.startsWith(this.projectRoot)
			? relative(this.projectRoot, filePath)
			: filePath;

		this.db
			.prepare("DELETE FROM symbol_references WHERE file_path = ?")
			.run(relativePath);
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
		const stmt = this.db.prepare(
			"UPDATE symbols SET pagerank = ? WHERE id = ?",
		);

		this.db.transaction(() => {
			for (const [id, score] of scores) {
				stmt.run(score, id);
			}
		});

		// Update metadata
		this.setGraphMetadata("pagerank_last_computed", new Date().toISOString());
	}

	/**
	 * Update in/out degree counts for all symbols
	 */
	updateDegreeCounts(): void {
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
	}

	/**
	 * Get graph metadata value
	 */
	getGraphMetadata(key: string): string | null {
		const stmt = this.db.prepare(
			"SELECT value FROM graph_metadata WHERE key = ?",
		);
		const row = stmt.get(key) as { value: string } | undefined;
		return row?.value || null;
	}

	/**
	 * Set graph metadata value
	 */
	setGraphMetadata(key: string, value: string): void {
		const stmt = this.db.prepare(`
			INSERT OR REPLACE INTO graph_metadata (key, value, updated_at)
			VALUES (?, ?, ?)
		`);
		stmt.run(key, value, new Date().toISOString());
	}

	/**
	 * Get symbol graph statistics
	 */
	getSymbolGraphStats(): SymbolGraphStats {
		const symbolCount = (
			this.db.prepare("SELECT COUNT(*) as count FROM symbols").get() as {
				count: number;
			}
		).count;

		const refCount = (
			this.db
				.prepare("SELECT COUNT(*) as count FROM symbol_references")
				.get() as {
				count: number;
			}
		).count;

		const resolvedCount = (
			this.db
				.prepare(
					"SELECT COUNT(*) as count FROM symbol_references WHERE is_resolved = 1",
				)
				.get() as { count: number }
		).count;

		// Symbols by kind
		const symbolsByKind: Partial<Record<SymbolKind, number>> = {};
		const kindRows = this.db
			.prepare("SELECT kind, COUNT(*) as count FROM symbols GROUP BY kind")
			.all() as Array<{ kind: string; count: number }>;
		for (const row of kindRows) {
			symbolsByKind[row.kind as SymbolKind] = row.count;
		}

		// References by kind
		const referencesByKind: Partial<Record<ReferenceKind, number>> = {};
		const refKindRows = this.db
			.prepare(
				"SELECT kind, COUNT(*) as count FROM symbol_references GROUP BY kind",
			)
			.all() as Array<{ kind: string; count: number }>;
		for (const row of refKindRows) {
			referencesByKind[row.kind as ReferenceKind] = row.count;
		}

		return {
			totalSymbols: symbolCount,
			totalReferences: refCount,
			resolvedReferences: resolvedCount,
			symbolsByKind,
			referencesByKind,
			pagerankComputedAt:
				this.getGraphMetadata("pagerank_last_computed") || undefined,
		};
	}

	/**
	 * Clear all symbol graph data
	 */
	clearSymbolGraph(): void {
		this.db.exec("DELETE FROM symbol_references");
		this.db.exec("DELETE FROM symbols");
		this.db.exec("DELETE FROM graph_metadata");
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
 * Create a file tracker for a project
 */
export function createFileTracker(
	dbPath: string,
	projectRoot: string,
): IFileTracker {
	return new FileTracker(dbPath, projectRoot);
}
