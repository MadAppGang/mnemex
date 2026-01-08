/**
 * LanceDB Vector Store
 *
 * Handles vector storage and hybrid search (BM25 + vector similarity)
 * using LanceDB's embedded database.
 */

import * as lancedb from "@lancedb/lancedb";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
	ASTMetadata,
	BaseDocument,
	ChunkWithEmbedding,
	CodeChunk,
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
import { getTestFileMode, type TestFileMode } from "../config.js";

// ============================================================================
// Constants
// ============================================================================

/** Table name for code chunks */
const CHUNKS_TABLE = "code_chunks";

/** Default search limit */
const DEFAULT_LIMIT = 10;

/** BM25 weight in hybrid search */
const BM25_WEIGHT = 0.4;

/** Vector weight in hybrid search */
const VECTOR_WEIGHT = 0.6;

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Escape special characters in filter values to prevent injection attacks
 * and crashes on special characters (identified by multi-model review)
 */
function escapeFilterValue(value: string): string {
	// Escape single quotes by doubling them (SQL-style escaping)
	// Also escape backslashes and other special chars
	return value
		.replace(/\\/g, "\\\\")
		.replace(/'/g, "''")
		.replace(/%/g, "\\%")
		.replace(/_/g, "\\_");
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

interface SearchOptions {
	limit?: number;
	language?: string;
	filePath?: string;
	keywordOnly?: boolean;
}

// ============================================================================
// Vector Store Class
// ============================================================================

export class VectorStore {
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
		// dbPath is like: /path/to/project/.claudemem/vectors
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
				if (vectorField && vectorField.type && "listSize" in vectorField.type) {
					this.tableDimension = (
						vectorField.type as { listSize: number }
					).listSize;
				}
			} catch {
				// Ignore schema read errors - dimension check will be skipped
			}

			return this.table;
		}

		return null;
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
		const incomingDimension = data[0].vector.length;
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
			// Table exists, add to it
			await table.add(data);
		} else {
			// Create table with the first batch of data
			if (!this.db) {
				await this.initialize();
			}
			this.table = await this.db!.createTable(CHUNKS_TABLE, data, {
				mode: "create",
			});
			this.tableDimension = incomingDimension;
		}

		// Store dimension for later
		if (data.length > 0 && !this.dimension) {
			this.dimension = data[0].vector.length;
		}
	}

	/**
	 * Search for similar chunks using hybrid search
	 * @param queryText - The search query text
	 * @param queryVector - Query embedding vector (undefined for keyword-only search)
	 * @param options - Search options
	 */
	async search(
		queryText: string,
		queryVector: number[] | undefined,
		options: SearchOptions = {},
	): Promise<SearchResult[]> {
		const { limit = DEFAULT_LIMIT, language, filePath, keywordOnly } = options;

		const table = await this.ensureTableOpen();
		if (!table) {
			// No index yet, return empty results
			return [];
		}

		// Build filter string with escaped values to prevent injection
		const filters: string[] = [];
		if (language) {
			filters.push(`language = '${escapeFilterValue(language)}'`);
		}
		if (filePath) {
			filters.push(`filePath LIKE '%${escapeFilterValue(filePath)}%'`);
		}
		const filterStr = filters.length > 0 ? filters.join(" AND ") : undefined;

		// Vector search (skip if keyword-only mode or no vector)
		let vectorResults: any[] = [];
		if (!keywordOnly && queryVector) {
			let vectorQuery = table.vectorSearch(queryVector).limit(limit * 2);
			if (filterStr) {
				vectorQuery = vectorQuery.where(filterStr);
			}
			vectorResults = await vectorQuery.toArray();
		}

		// BM25 full-text search (if available)
		let bm25Results: any[] = [];
		try {
			let ftsQuery = table.search(queryText, "content").limit(limit * 2);
			if (filterStr) {
				ftsQuery = ftsQuery.where(filterStr);
			}
			bm25Results = await ftsQuery.toArray();
		} catch {
			// FTS might not be available, fall back to vector-only
			bm25Results = [];
		}

		// Reciprocal Rank Fusion with test file handling
		const testFileMode = getTestFileMode(this.projectPath);
		const results = reciprocalRankFusion(
			vectorResults,
			bm25Results,
			VECTOR_WEIGHT,
			BM25_WEIGHT,
			this.testFileDetector,
			testFileMode,
		);

		// Convert to SearchResult format
		return results.slice(0, limit).map((r) => ({
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
			score: r.fusedScore,
			vectorScore: r.vectorScore || 0,
			keywordScore: r.keywordScore || 0,
		}));
	}

	/**
	 * Delete all chunks from a specific file
	 */
	async deleteByFile(filePath: string): Promise<number> {
		if (!this.db || !this.table) {
			return 0;
		}

		try {
			await this.table.delete(`filePath = '${filePath}'`);
			return 1; // LanceDB doesn't return count
		} catch {
			return 0;
		}
	}

	/**
	 * Delete chunks by file hash
	 */
	async deleteByFileHash(fileHash: string): Promise<number> {
		if (!this.db || !this.table) {
			return 0;
		}

		try {
			await this.table.delete(`fileHash = '${fileHash}'`);
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
			const results = await table
				.query()
				.where(
					`filePath = '${escapeFilterValue(filePath)}' AND documentType = 'code_chunk'`,
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
		const incomingDimension = data[0].vector.length;
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
			await table.add(data);
		} else {
			if (!this.db) {
				await this.initialize();
			}
			this.table = await this.db!.createTable(CHUNKS_TABLE, data, {
				mode: "create",
			});
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
		if (!this.db || !this.table) {
			return 0;
		}

		try {
			await this.table.delete(`documentType = '${documentType}'`);
			return 1;
		} catch {
			return 0;
		}
	}

	/**
	 * Delete all documents (code chunks and enriched) for a specific file
	 */
	async deleteAllByFile(filePath: string): Promise<number> {
		if (!this.db || !this.table) {
			return 0;
		}

		try {
			await this.table.delete(`filePath = '${filePath}'`);
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
			let filter = `filePath = '${filePath}'`;
			if (documentTypes && documentTypes.length > 0) {
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

		// Build filter string with escaped values to prevent injection
		const filters: string[] = [];
		if (language) {
			filters.push(`language = '${escapeFilterValue(language)}'`);
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
			const types = effectiveTypes
				.map((t) => `'${escapeFilterValue(t)}'`)
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
		let bm25Results: any[] = [];
		try {
			let ftsQuery = table.search(queryText, "content").limit(limit * 3);
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
		return results.slice(0, limit).map((r) => ({
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
			score: r.fusedScore,
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
		const incomingDimension = data[0].vector.length;
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
			await table.add(data);
		} else {
			if (!this.db) {
				await this.initialize();
			}
			this.table = await this.db!.createTable(CHUNKS_TABLE, data, {
				mode: "create",
			});
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
			// First, get the existing record
			const results = await table
				.query()
				.where(`id = '${escapeFilterValue(unitId)}'`)
				.toArray();
			if (results.length === 0) return;

			const existing = results[0] as StoredChunk;

			// Delete old record
			await table.delete(`id = '${escapeFilterValue(unitId)}'`);

			// Insert updated record
			await table.add([{ ...existing, summary }]);
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
			// LanceDB update via delete + insert pattern
			const results = await table
				.query()
				.where(`id = '${escapeFilterValue(documentId)}'`)
				.toArray();
			if (results.length === 0) return false;

			const existing = results[0] as StoredChunk;

			// Delete old record
			await table.delete(`id = '${escapeFilterValue(documentId)}'`);

			// Insert updated record with new content and vector
			await table.add([
				{
					...existing,
					content: newContent,
					vector: newVector,
					enrichedAt: new Date().toISOString(),
				},
			]);

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
			let filter = `filePath = '${escapeFilterValue(filePath)}' AND documentType = 'code_unit'`;
			if (unitTypes && unitTypes.length > 0) {
				const types = unitTypes
					.map((t) => `'${escapeFilterValue(t)}'`)
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
				filter += ` AND filePath = '${escapeFilterValue(filePath)}'`;
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
			const filter = `parentId = '${escapeFilterValue(parentId)}' AND documentType = 'code_unit'`;
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
			const filter = `id = '${escapeFilterValue(unitId)}'`;
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
			const types = unitTypes
				.map((t) => `'${escapeFilterValue(t)}'`)
				.join(", ");
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
		let bm25Results: any[] = [];
		try {
			let ftsQuery = table.search(queryText, "content").limit(limit * 2);
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
				filter += ` AND filePath = '${escapeFilterValue(filePath)}'`;
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
 * @param dbPath - Path to the vector database (e.g., /project/.claudemem/vectors)
 * @param projectPath - Optional explicit project path (derived from dbPath if not provided)
 */
export function createVectorStore(
	dbPath: string,
	projectPath?: string,
): VectorStore {
	return new VectorStore(dbPath, projectPath);
}
