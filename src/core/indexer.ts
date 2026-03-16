/**
 * Code Indexer
 *
 * Orchestrates the indexing process: file discovery, chunking,
 * embedding generation, and storage.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
	shouldExclude as sharedShouldExclude,
	shouldInclude as sharedShouldInclude,
} from "../shared/pattern-matcher.js";
import {
	ensureProjectDir,
	getDocsConfig,
	getEmbeddingModel,
	getExcludePatterns,
	getIndexDbPath,
	getVectorStorePath,
	isDocsEnabled,
	isEnrichmentEnabled,
	isVectorEnabled,
	loadProjectConfig,
} from "../config.js";
import { createLLMClient } from "../llm/client.js";
import type { ILLMClient } from "../types.js";
import {
	createEnricher,
	type Enricher,
	type FileToEnrich,
} from "./enrichment/index.js";
import { getParserManager } from "../parsers/parser-manager.js";
import type {
	ChunkWithEmbedding,
	CodeChunk,
	CodeUnit,
	CodeUnitWithEmbedding,
	EnrichedIndexResult,
	EnrichmentResult,
	IEmbeddingsClient,
	IndexResult,
	IndexStatus,
	SearchOptions,
	SearchResult,
	SupportedLanguage,
} from "../types.js";
import {
	createCodeUnitExtractor,
	type CodeUnitExtractor,
} from "./ast/code-unit-extractor.js";
import { setIndexVersion, CURRENT_INDEX_VERSION } from "./index-version.js";
import { chunkFileByPath } from "./chunker.js";
import { createEmbeddingsClient } from "./embeddings.js";
import { createVectorStore, type IVectorStore } from "./store.js";
import {
	computeFileHash,
	createFileTracker,
	type IFileTracker,
} from "./tracker.js";
import { createSymbolExtractor } from "./symbol-extractor.js";
import { createReferenceGraphManager } from "./reference-graph.js";
import { createRepoMapGenerator } from "./repo-map.js";
import { createIndexLock, type IIndexLock, type LockOptions } from "./lock.js";
import { createDocsFetcher, type DocsFetcher } from "../docs/index.js";
import { computeHash } from "./tracker.js";

// ============================================================================
// Errors
// ============================================================================

/**
 * Error thrown when search uses a different embedding model than indexing
 */
export class EmbeddingModelMismatchError extends Error {
	constructor(
		public storedModel: string,
		public requestedModel: string,
	) {
		super(
			`Embedding model mismatch!\n` +
				`  Index was created with: ${storedModel}\n` +
				`  You're trying to use: ${requestedModel}\n\n` +
				`Solutions:\n` +
				`  1. Use the same model: mnemex search --model ${storedModel} "query"\n` +
				`  2. Reindex with new model: mnemex index --force --model ${requestedModel}\n` +
				`  3. Let mnemex auto-detect: mnemex search "query" (uses stored model)`,
		);
		this.name = "EmbeddingModelMismatchError";
	}
}

/**
 * Error thrown when indexing is already in progress by another process
 */
export class IndexLockError extends Error {
	constructor(
		public holderPid: number | undefined,
		public runningFor: number | undefined,
		public reason: "already_running" | "timeout" | "error",
	) {
		const runningForSec =
			runningFor !== undefined ? Math.round(runningFor / 1000) : 0;
		let message: string;
		if (reason === "error") {
			message =
				`Failed to acquire index lock.\n` +
				`  There may be a filesystem error or permissions issue.\n` +
				`  Try running with --force-unlock to clear any stale locks.`;
		} else if (reason === "timeout") {
			message =
				`Timed out waiting for indexing to complete.\n` +
				`  Another process (PID ${holderPid}) has been indexing for ${runningForSec}s.\n` +
				`  If the process is stuck, use --force-unlock to clear the lock.`;
		} else {
			message =
				`Another process (PID ${holderPid}) is currently indexing.\n` +
				`  It has been running for ${runningForSec}s.\n` +
				`  Use --wait to wait for it to finish, or --force-unlock if it's stuck.`;
		}
		super(message);
		this.name = "IndexLockError";
	}
}

// ============================================================================
// Types
// ============================================================================

interface IndexerOptions {
	/** Project root path */
	projectPath: string;
	/** Embedding model to use */
	model?: string;
	/** Additional exclude patterns */
	excludePatterns?: string[];
	/** Include only these patterns */
	includePatterns?: string[];
	/** Progress callback (inProgress = items currently being processed, for animation) */
	onProgress?: (
		current: number,
		total: number,
		file: string,
		inProgress?: number,
	) => void;
	/** Force re-index all files */
	force?: boolean;
	/** Enable LLM enrichment (default: from config) */
	enableEnrichment?: boolean;
	/** Concurrency for LLM enrichment requests (default: 10) */
	enrichmentConcurrency?: number;
	/** Lock options for concurrent access control */
	lockOptions?: LockOptions;
	/** Callback when waiting for another process to finish indexing */
	onWaitingForLock?: (holderPid: number, waitedMs: number) => void;
}

// ============================================================================
// Indexer Class
// ============================================================================

export class Indexer {
	private projectPath: string;
	private model: string;
	private modelExplicitlySet: boolean;
	private excludePatterns: string[];
	private includePatterns: string[];
	private onProgress?: (
		current: number,
		total: number,
		file: string,
		inProgress?: number,
	) => void;
	private enableEnrichment: boolean;
	private enrichmentConcurrency: number;
	private vectorEnabled: boolean;
	private lockOptions?: LockOptions;
	private onWaitingForLock?: (holderPid: number, waitedMs: number) => void;

	private embeddingsClient: IEmbeddingsClient | null = null;
	private vectorStore: IVectorStore | null = null;
	private fileTracker: IFileTracker | null = null;
	private llmClient: ILLMClient | null = null;
	private enricher: Enricher | null = null;
	private indexLock: IIndexLock | null = null;
	private docsFetcher: DocsFetcher | null = null;
	private codeUnitExtractor: CodeUnitExtractor | null = null;

	// Smart incremental reindexing: cache of old chunk vectors by contentHash
	// Used to reuse embeddings for unchanged content, saving API costs
	private oldChunksCache: Map<string, Map<string, number[]>> = new Map();

	constructor(options: IndexerOptions) {
		this.projectPath = options.projectPath;
		this.modelExplicitlySet = !!options.model;
		this.model = options.model || getEmbeddingModel(options.projectPath);
		// Get exclude patterns from config (includes defaults, gitignore, etc.)
		this.excludePatterns = [
			...getExcludePatterns(options.projectPath),
			...(options.excludePatterns || []),
		];
		// Get config options
		const projectConfig = loadProjectConfig(options.projectPath);
		this.includePatterns =
			options.includePatterns || projectConfig?.includePatterns || [];

		this.onProgress = options.onProgress;

		// Enrichment enabled by default (from config), can be overridden
		this.enableEnrichment =
			options.enableEnrichment ?? isEnrichmentEnabled(options.projectPath);
		this.enrichmentConcurrency = options.enrichmentConcurrency ?? 10;

		// Vector embeddings enabled by default (from config)
		this.vectorEnabled = isVectorEnabled(options.projectPath);

		// Lock options for concurrent access control
		this.lockOptions = options.lockOptions;
		this.onWaitingForLock = options.onWaitingForLock;
	}

	/**
	 * Initialize all components
	 * @param forSearch - If true, use stored embedding model (for retrieval consistency)
	 */
	private async initialize(forSearch = false): Promise<void> {
		// Ensure project directory exists
		ensureProjectDir(this.projectPath);

		// Initialize parser manager
		const parserManager = getParserManager();
		await parserManager.initialize();

		// Initialize code unit extractor (always available, falls back to file-level unit)
		this.codeUnitExtractor = createCodeUnitExtractor();

		// Create file tracker first (to read stored metadata)
		const indexDbPath = getIndexDbPath(this.projectPath);
		this.fileTracker = createFileTracker(indexDbPath, this.projectPath);

		// Create embeddings client only when vector mode is enabled
		if (this.vectorEnabled) {
			// For search operations, use the stored embedding model to ensure consistency
			let modelToUse = this.model;
			if (forSearch) {
				const storedModel = this.fileTracker.getMetadata("embeddingModel");
				if (storedModel) {
					// If user explicitly requested a different model, throw clear error
					if (this.modelExplicitlySet && this.model !== storedModel) {
						throw new EmbeddingModelMismatchError(storedModel, this.model);
					}
					// Otherwise use the stored model for consistency
					modelToUse = storedModel;
				}
			}

			// Create embeddings client with appropriate model
			this.embeddingsClient = createEmbeddingsClient({ model: modelToUse });
		}

		// Create vector store
		const vectorStorePath = getVectorStorePath(this.projectPath);
		this.vectorStore = createVectorStore(vectorStorePath);
		await this.vectorStore.initialize();

		// Initialize enrichment if enabled (requires vector mode for embeddings)
		if (this.enableEnrichment && this.vectorEnabled) {
			try {
				this.llmClient = await createLLMClient({}, this.projectPath);
				this.enricher = createEnricher(
					this.llmClient,
					this.embeddingsClient!,
					this.vectorStore,
					this.fileTracker,
				);
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				throw new Error(
					`Enrichment failed to initialize: ${msg}\n` +
						`LLM enrichment is enabled by default and requires a running LLM provider.\n` +
						`Either:\n` +
						`  • Start your LLM provider (e.g. LM Studio, Ollama)\n` +
						`  • Or run with --no-llm to skip enrichment`,
				);
			}
		}

		// Initialize docs fetcher if enabled
		if (isDocsEnabled(this.projectPath) && this.vectorEnabled) {
			this.docsFetcher = createDocsFetcher(this.projectPath);
		}
	}

	/** Maximum files to process per batch (limits memory usage) */
	private static readonly FILES_PER_BATCH = 500;

	/**
	 * Index the codebase
	 */
	async index(force = false): Promise<EnrichedIndexResult> {
		const startTime = Date.now();

		// Ensure project directory exists before acquiring lock
		ensureProjectDir(this.projectPath);

		// Acquire lock to prevent concurrent indexing
		this.indexLock = createIndexLock(this.projectPath);
		const lockResult = await this.indexLock.acquire({
			...this.lockOptions,
			onWaiting: this.onWaitingForLock,
		});

		if (!lockResult.acquired) {
			throw new IndexLockError(
				lockResult.holderPid,
				lockResult.runningFor,
				lockResult.reason as "already_running" | "timeout" | "error",
			);
		}

		try {
			return await this.indexInternal(force, startTime);
		} finally {
			// Always release lock when done
			this.indexLock.release();
			this.indexLock = null;
		}
	}

	/** Manifest files that trigger docs re-fetch when changed */
	private static readonly MANIFEST_FILES = new Set([
		"package.json",
		"requirements.txt",
		"pyproject.toml",
		"go.mod",
		"Cargo.toml",
	]);

	/**
	 * Internal indexing logic (called after lock acquired)
	 */
	private async indexInternal(
		force: boolean,
		startTime: number,
	): Promise<EnrichedIndexResult> {
		await this.initialize();

		// Check if embedding model changed - requires full reindex
		const previousModel = this.fileTracker!.getMetadata("embeddingModel");
		const modelChanged = previousModel && previousModel !== this.model;
		if (modelChanged) {
			console.log(
				`\n⚠️  Embedding model changed: ${previousModel} → ${this.model}`,
			);
			console.log("   Clearing old index (vector dimensions may differ)...\n");
			await this.vectorStore!.clear();
			this.fileTracker!.clear();
			force = true; // Treat as force reindex
		}

		// Discover files
		const allFiles = this.discoverFiles();

		// Get changes
		let filesToIndex: string[];
		let deletedFiles: string[] = [];
		let manifestFilesChanged = force; // Always refresh docs on force reindex

		if (force) {
			// Force re-index all files
			filesToIndex = allFiles;
			// Clear existing data (skip if already cleared due to model change)
			if (!modelChanged) {
				await this.vectorStore!.clear();
				this.fileTracker!.clear();
			}
		} else {
			// Incremental indexing
			const changes = this.fileTracker!.getChanges(allFiles);
			filesToIndex = [...changes.newFiles, ...changes.modifiedFiles];
			deletedFiles = changes.deletedFiles;

			// Check if any manifest files changed (to decide if docs phase should run)
			for (const file of filesToIndex) {
				const basename = file.split("/").pop() || "";
				if (Indexer.MANIFEST_FILES.has(basename)) {
					manifestFilesChanged = true;
					break;
				}
			}

			// Remove deleted files from index
			for (const deletedFile of deletedFiles) {
				const chunkIds = this.fileTracker!.getChunkIds(deletedFile);
				if (chunkIds.length > 0) {
					await this.vectorStore!.deleteByFile(deletedFile);
				}
				this.fileTracker!.removeFile(deletedFile);
			}

			// SMART INCREMENTAL: Collect old chunks for modified files BEFORE deleting
			// This allows us to reuse embeddings for unchanged content
			for (const modifiedFile of changes.modifiedFiles) {
				// Chunks are stored with absolute paths, so use absolute path for lookups
				const oldChunks =
					await this.vectorStore!.getChunksWithVectors(modifiedFile);
				if (oldChunks.length > 0) {
					// Store old chunks indexed by contentHash for O(1) lookup
					// Key by absolute path to match during embedding phase
					const oldChunksMap = new Map<string, number[]>();
					for (const chunk of oldChunks) {
						if (chunk.contentHash && chunk.vector.length > 1) {
							// >1 to exclude placeholder [0]
							oldChunksMap.set(chunk.contentHash, chunk.vector);
						}
					}
					this.oldChunksCache.set(modifiedFile, oldChunksMap);
				}
				// Now delete old data (use absolute path to match stored chunks)
				await this.vectorStore!.deleteByFile(modifiedFile);
				this.fileTracker!.resetEnrichmentState(modifiedFile);
			}
		}

		// Process files in batches to limit memory usage
		// Each batch: parse → embed → store → release memory
		const skippedFiles: string[] = [];
		const errors: Array<{ file: string; error: string }> = [];
		let totalFilesIndexed = 0;
		let totalChunksCreated = 0;
		let totalCodeUnitsCreated = 0;
		let totalCost = 0;
		let totalTokens = 0;

		// Track files for enrichment (file -> chunks mapping)
		const fileChunksForEnrichment: FileToEnrich[] = [];

		// PARALLEL MODE: Run AST extraction and enrichment in parallel
		// Conditions: embedding is local (uses GPU/CPU) AND LLM is cloud (uses network)
		const canParallelizeEnrichment =
			this.enableEnrichment &&
			this.enricher &&
			this.vectorEnabled &&
			this.embeddingsClient?.isLocal() &&
			this.llmClient?.isCloud();

		const totalBatches = Math.ceil(
			filesToIndex.length / Indexer.FILES_PER_BATCH,
		);

		for (let batchNum = 0; batchNum < totalBatches; batchNum++) {
			const batchStart = batchNum * Indexer.FILES_PER_BATCH;
			const batchEnd = Math.min(
				batchStart + Indexer.FILES_PER_BATCH,
				filesToIndex.length,
			);
			const batchFiles = filesToIndex.slice(batchStart, batchEnd);

			// Phase 1: Parse and chunk batch of files
			const batchChunks: Array<{
				chunk: CodeChunk;
				filePath: string;
				fileHash: string;
			}> = [];

			for (let i = 0; i < batchFiles.length; i++) {
				const filePath = batchFiles[i];
				const relativePath = relative(this.projectPath, filePath);
				const globalIndex = batchStart + i + 1;

				// Report progress (parsing phase) - show "X/Y" with filename, or just "X/Y files" at completion
				if (this.onProgress) {
					const batchInfo =
						totalBatches > 1 ? ` [batch ${batchNum + 1}/${totalBatches}]` : "";
					const isLast = globalIndex === filesToIndex.length;
					const detail = isLast
						? `${globalIndex}/${filesToIndex.length} files`
						: `${globalIndex}/${filesToIndex.length} ${relativePath}`;
					this.onProgress(
						globalIndex,
						filesToIndex.length,
						`[parsing]${batchInfo} ${detail}`,
					);
				}

				try {
					const content = readFileSync(filePath, "utf-8");
					const fileHash = computeFileHash(filePath);
					const chunks = await chunkFileByPath(content, filePath, fileHash);

					if (chunks.length === 0) {
						skippedFiles.push(relativePath);
					} else {
						for (const chunk of chunks) {
							batchChunks.push({ chunk, filePath, fileHash });
						}
					}
				} catch (error) {
					const errorMsg =
						error instanceof Error ? error.message : String(error);
					errors.push({ file: relativePath, error: errorMsg });
				}
			}

			// Skip embedding/storing if no chunks in this batch
			if (batchChunks.length === 0) {
				continue;
			}

			// Phase 2: Embed batch chunks (skip if vector mode disabled)
			// SMART INCREMENTAL: Reuse vectors from cache for unchanged chunks
			const batchInfo =
				totalBatches > 1 ? ` [batch ${batchNum + 1}/${totalBatches}]` : "";
			let validChunks: Array<{
				chunk: CodeChunk;
				filePath: string;
				fileHash: string;
				vector: number[];
			}>;

			if (this.vectorEnabled) {
				// Separate chunks into: cached (reuse vector) vs new (need embedding)
				const chunksNeedingEmbedding: Array<{
					chunk: CodeChunk;
					filePath: string;
					fileHash: string;
					originalIndex: number;
				}> = [];
				const cachedChunks: Array<{
					chunk: CodeChunk;
					filePath: string;
					fileHash: string;
					vector: number[];
				}> = [];

				for (let i = 0; i < batchChunks.length; i++) {
					const { chunk, filePath, fileHash } = batchChunks[i];
					// Cache is keyed by absolute path (filePath is already absolute)
					const cachedVectors = this.oldChunksCache.get(filePath);

					if (
						cachedVectors &&
						chunk.contentHash &&
						cachedVectors.has(chunk.contentHash)
					) {
						// REUSE: Same content found in cache - skip embedding API call!
						cachedChunks.push({
							chunk,
							filePath,
							fileHash,
							vector: cachedVectors.get(chunk.contentHash)!,
						});
					} else {
						// NEW: Content changed or new chunk - needs embedding
						chunksNeedingEmbedding.push({
							chunk,
							filePath,
							fileHash,
							originalIndex: i,
						});
					}
				}

				const reusedCount = cachedChunks.length;
				const newCount = chunksNeedingEmbedding.length;

				if (this.onProgress) {
					const reuseInfo = reusedCount > 0 ? ` (${reusedCount} reused)` : "";
					this.onProgress(
						0,
						batchChunks.length,
						`[embedding]${batchInfo} ${newCount} new${reuseInfo}...`,
					);
				}

				// Only call embedding API for chunks that actually need it
				let newlyEmbeddedChunks: Array<{
					chunk: CodeChunk;
					filePath: string;
					fileHash: string;
					vector: number[];
				}> = [];

				if (chunksNeedingEmbedding.length > 0) {
					const texts = chunksNeedingEmbedding.map((c) => c.chunk.content);
					let embedResult: {
						embeddings: number[][];
						cost?: number;
						totalTokens?: number;
					};

					try {
						// Pass progress callback to track embedding progress
						embedResult = await this.embeddingsClient!.embed(
							texts,
							(completed, total, inProgress) => {
								if (this.onProgress) {
									const reuseInfo =
										reusedCount > 0 ? ` (${reusedCount} reused)` : "";
									this.onProgress(
										completed + reusedCount,
										total + reusedCount,
										`[embedding]${batchInfo} ${completed}/${total} new${reuseInfo}`,
										inProgress,
									);
								}
							},
						);
					} catch (error) {
						const errorMsg =
							error instanceof Error ? error.message : String(error);
						throw new Error(`Embedding generation failed: ${errorMsg}`);
					}

					// Track cost and tokens
					if (embedResult.cost) totalCost += embedResult.cost;
					if (embedResult.totalTokens) totalTokens += embedResult.totalTokens;

					// Verify we got embeddings for all chunks
					if (embedResult.embeddings.length !== texts.length) {
						throw new Error(
							`Embedding count mismatch: expected ${texts.length}, got ${embedResult.embeddings.length}`,
						);
					}

					// Map embeddings back to chunks
					newlyEmbeddedChunks = chunksNeedingEmbedding
						.map((c, i) => ({
							chunk: c.chunk,
							filePath: c.filePath,
							fileHash: c.fileHash,
							vector: embedResult.embeddings[i],
						}))
						.filter((c) => c.vector.length > 0);
				}

				// Combine cached + newly embedded chunks
				validChunks = [...cachedChunks, ...newlyEmbeddedChunks];
			} else {
				// Vector mode disabled - store chunks with placeholder vector (BM25 only)
				// LanceDB requires non-empty vectors, so we use a single-element placeholder
				validChunks = batchChunks.map((c) => ({
					...c,
					vector: [0], // Placeholder - BM25 search only (vector search disabled)
				}));
			}

			// Phase 3: Store batch chunks
			const chunksWithEmbeddings: ChunkWithEmbedding[] = validChunks.map(
				(c) => ({
					...c.chunk,
					vector: c.vector,
				}),
			);

			if (this.onProgress) {
				const batchInfo =
					totalBatches > 1 ? ` [batch ${batchNum + 1}/${totalBatches}]` : "";
				this.onProgress(
					0,
					chunksWithEmbeddings.length,
					`[storing]${batchInfo} ${chunksWithEmbeddings.length} chunks...`,
				);
			}
			await this.vectorStore!.addChunks(chunksWithEmbeddings);

			// Report storing completion
			if (this.onProgress) {
				const total = chunksWithEmbeddings.length;
				this.onProgress(total, total, `[storing] ${total} chunks stored`);
			}

			// Check if vector store auto-cleared due to dimension mismatch
			// If so, we need to also clear file tracker for consistency
			if (this.vectorStore!.dimensionMismatchCleared) {
				this.fileTracker!.clear();
			}

			// Phase 2b: Extract code units with AST metadata (once per file, not per chunk)
			// Runs in same batch loop, produces code_unit records in addition to code_chunk records
			if (this.codeUnitExtractor) {
				const filesProcessedForUnits = new Set<string>();
				const batchUnitsToEmbed: Array<{
					unit: CodeUnit;
					filePath: string;
					fileHash: string;
				}> = [];

				for (const { filePath, fileHash } of validChunks) {
					if (filesProcessedForUnits.has(filePath)) continue;
					filesProcessedForUnits.add(filePath);

					const language = getParserManager().getLanguage(
						filePath,
					) as SupportedLanguage;
					if (!language) continue;

					try {
						const content = readFileSync(filePath, "utf-8");
						const units = await this.codeUnitExtractor.extractUnits(
							content,
							filePath,
							language,
							fileHash,
						);
						for (const unit of units) {
							batchUnitsToEmbed.push({ unit, filePath, fileHash });
						}
					} catch (error) {
						// Code unit extraction failure is non-fatal
						const relativePath = relative(this.projectPath, filePath);
						console.warn(
							`Warning: Code unit extraction failed for ${relativePath}: ` +
								`${error instanceof Error ? error.message : String(error)}`,
						);
					}
				}

				// Embed code units if any were extracted and vector mode is enabled
				if (
					batchUnitsToEmbed.length > 0 &&
					this.vectorEnabled &&
					this.embeddingsClient
				) {
					const unitBatchInfo =
						totalBatches > 1 ? ` [batch ${batchNum + 1}/${totalBatches}]` : "";
					if (this.onProgress) {
						this.onProgress(
							0,
							batchUnitsToEmbed.length,
							`[units]${unitBatchInfo} embedding ${batchUnitsToEmbed.length} code units...`,
						);
					}

					const unitTexts = batchUnitsToEmbed.map(({ unit }) => unit.content);
					let unitEmbedResult: {
						embeddings: number[][];
						cost?: number;
						totalTokens?: number;
					};

					try {
						unitEmbedResult = await this.embeddingsClient.embed(
							unitTexts,
							(completed, total, inProgress) => {
								if (this.onProgress) {
									this.onProgress(
										completed,
										total,
										`[units]${unitBatchInfo} ${completed}/${total} units`,
										inProgress,
									);
								}
							},
						);
					} catch (error) {
						// Unit embedding failure is non-fatal - code_chunk records already stored
						console.warn(
							`Warning: Code unit embedding failed: ` +
								`${error instanceof Error ? error.message : String(error)}`,
						);
						unitEmbedResult = { embeddings: [] };
					}

					if (unitEmbedResult.embeddings.length === unitTexts.length) {
						if (unitEmbedResult.cost) totalCost += unitEmbedResult.cost;
						if (unitEmbedResult.totalTokens)
							totalTokens += unitEmbedResult.totalTokens;

						const unitsWithEmbeddings: CodeUnitWithEmbedding[] =
							batchUnitsToEmbed
								.map(({ unit }, idx) => ({
									...unit,
									vector: unitEmbedResult.embeddings[idx],
								}))
								.filter((u) => u.vector.length > 0);

						if (unitsWithEmbeddings.length > 0) {
							await this.vectorStore!.addCodeUnits(unitsWithEmbeddings);
							totalCodeUnitsCreated += unitsWithEmbeddings.length;

							if (this.onProgress) {
								this.onProgress(
									unitsWithEmbeddings.length,
									unitsWithEmbeddings.length,
									`[units]${unitBatchInfo} ${unitsWithEmbeddings.length} units stored`,
								);
							}
						}
					}
				} else if (batchUnitsToEmbed.length > 0 && !this.vectorEnabled) {
					// BM25-only mode: store units with placeholder vector
					const unitsWithPlaceholder: CodeUnitWithEmbedding[] =
						batchUnitsToEmbed.map(({ unit }) => ({ ...unit, vector: [0] }));
					await this.vectorStore!.addCodeUnits(unitsWithPlaceholder);
					totalCodeUnitsCreated += unitsWithPlaceholder.length;
				}
			}

			// Phase 4: Update file tracker for this batch (only for successfully stored chunks)
			const fileChunkMap = new Map<
				string,
				{ fileHash: string; chunkIds: string[] }
			>();
			for (const { chunk, filePath, fileHash } of validChunks) {
				if (!fileChunkMap.has(filePath)) {
					fileChunkMap.set(filePath, { fileHash, chunkIds: [] });
				}
				fileChunkMap.get(filePath)!.chunkIds.push(chunk.id);
			}

			for (const [filePath, { fileHash, chunkIds }] of fileChunkMap) {
				this.fileTracker!.markIndexed(filePath, fileHash, chunkIds);
			}

			totalFilesIndexed += fileChunkMap.size;
			totalChunksCreated += chunksWithEmbeddings.length;

			// Collect files for enrichment
			if (this.enableEnrichment && this.enricher) {
				// Group chunks by file for enrichment
				const fileChunksMap = new Map<
					string,
					{ content: string; chunks: CodeChunk[]; language: string }
				>();

				for (const { chunk, filePath } of validChunks) {
					if (!fileChunksMap.has(filePath)) {
						const content = readFileSync(filePath, "utf-8");
						fileChunksMap.set(filePath, {
							content,
							chunks: [],
							language: chunk.language,
						});
					}
					fileChunksMap.get(filePath)!.chunks.push(chunk);
				}

				for (const [filePath, { content, chunks, language }] of fileChunksMap) {
					fileChunksForEnrichment.push({
						filePath: relative(this.projectPath, filePath),
						fileContent: content,
						codeChunks: chunks,
						language,
					});
				}
			}

			// Memory is released when batchChunks, embeddings, chunksWithEmbeddings go out of scope
		}

		// Set index version after successful chunk + code unit indexing
		// Placed before enrichment so a partial enrichment failure doesn't prevent version write
		setIndexVersion(this.projectPath, CURRENT_INDEX_VERSION);

		// Collect previously-indexed files that still need enrichment
		if (this.enableEnrichment && this.enricher && this.fileTracker) {
			const alreadyQueued = new Set(
				fileChunksForEnrichment.map((f) => f.filePath),
			);
			const unenrichedPaths =
				this.fileTracker.getFilesNeedingEnrichment("file_summary");

			for (const relPath of unenrichedPaths) {
				if (alreadyQueued.has(relPath)) continue;
				const absPath = join(this.projectPath, relPath);
				if (!existsSync(absPath)) continue;

				try {
					const content = readFileSync(absPath, "utf-8");
					const fileHash = computeFileHash(absPath);
					const chunks = await chunkFileByPath(content, absPath, fileHash);
					if (chunks.length === 0) continue;

					fileChunksForEnrichment.push({
						filePath: relPath,
						fileContent: content,
						codeChunks: chunks,
						language: chunks[0].language,
					});
				} catch {
					// Skip files that can't be read/chunked
				}
			}
		}

		// Phase 4.5 & 5: AST Extraction and Enrichment
		// Run in parallel when embedding is local and LLM is cloud (no resource contention)
		let enrichmentResult: EnrichmentResult | undefined;

		const runEnrichment = async (): Promise<void> => {
			if (
				!this.enableEnrichment ||
				!this.enricher ||
				fileChunksForEnrichment.length === 0
			) {
				return;
			}
			try {
				enrichmentResult = await this.enricher.enrichFiles(
					fileChunksForEnrichment,
					{
						concurrency: this.enrichmentConcurrency,
						onProgress: (completed, total, phase, status, inProgress) => {
							if (this.onProgress) {
								this.onProgress(
									completed,
									total,
									`[${phase}] ${status}`,
									inProgress,
								);
							}
						},
					},
				);
			} catch (error) {
				console.warn(
					"⚠️  Enrichment failed:",
					error instanceof Error ? error.message : error,
				);
			}
		};

		const runASTExtraction = async (): Promise<void> => {
			if (filesToIndex.length > 0) {
				await this.extractSymbolGraph(filesToIndex, force);
			}
		};

		if (canParallelizeEnrichment) {
			// Parallel: AST extraction and enrichment run concurrently
			// AST uses CPU, enrichment uses cloud LLM - no contention
			await Promise.all([runASTExtraction(), runEnrichment()]);
		} else {
			// Sequential: AST first, then enrichment
			await runASTExtraction();
			await runEnrichment();
		}

		// Add enrichment cost to total
		if (enrichmentResult?.cost) {
			totalCost += enrichmentResult.cost;
		}

		// Phase 6: Fetch external documentation for dependencies
		// Only run if manifest files changed (or force reindex), to avoid unnecessary network calls
		if (this.docsFetcher?.isEnabled() && manifestFilesChanged) {
			try {
				const docsResult = await this.fetchExternalDocs();
				if (docsResult.cost) {
					totalCost += docsResult.cost;
				}
			} catch (error) {
				console.warn(
					"⚠️  Documentation fetching failed:",
					error instanceof Error ? error.message : error,
				);
			}
		}

		// Save metadata
		this.fileTracker!.setMetadata("embeddingModel", this.model);
		this.fileTracker!.setMetadata("lastIndexed", new Date().toISOString());

		// Clean up: Release cached old chunks to free memory
		this.oldChunksCache.clear();

		const durationMs = Date.now() - startTime;

		return {
			filesIndexed: totalFilesIndexed,
			chunksCreated: totalChunksCreated,
			codeUnitsCreated: totalCodeUnitsCreated,
			durationMs,
			skippedFiles,
			errors,
			cost: totalCost > 0 ? totalCost : undefined,
			totalTokens: totalTokens > 0 ? totalTokens : undefined,
			enrichment: enrichmentResult,
		};
	}

	/**
	 * Search the indexed codebase
	 * Uses the stored embedding model from indexing for consistency
	 */
	async search(
		query: string,
		options: SearchOptions = {},
	): Promise<SearchResult[]> {
		// Initialize with forSearch=true to use stored embedding model
		await this.initialize(true);

		// Force keyword-only mode when vector embeddings are disabled
		const useKeywordOnly = options.keywordOnly || !this.vectorEnabled;

		// Generate query embedding (skip if keyword-only mode or vector disabled)
		let queryVector: number[] | undefined;
		if (!useKeywordOnly && this.embeddingsClient) {
			queryVector = await this.embeddingsClient.embedOne(query);
		}

		// Search
		const results = await this.vectorStore!.search(query, queryVector, {
			...options,
			keywordOnly: useKeywordOnly,
		});

		// Dead code deprioritization: penalize symbols with 0 callers
		// This prevents agents from being directed to unused/dead code
		if (this.fileTracker && results.length > 1) {
			const DEAD_CODE_PENALTY = 0.6; // 40% score reduction
			for (const r of results) {
				if (!r.chunk.name) continue;
				const syms = this.fileTracker.getSymbolByName(r.chunk.name);
				// Find the symbol in the same file
				const sym =
					syms.find((s) => s.filePath === r.chunk.filePath) ?? syms[0];
				if (sym && sym.inDegree === 0 && sym.pagerankScore < 0.001) {
					r.score *= DEAD_CODE_PENALTY;
				}
			}
			// Re-sort after penalty
			results.sort((a, b) => b.score - a.score);
		}

		return results;
	}

	/**
	 * Get index status
	 */
	async getStatus(): Promise<IndexStatus> {
		const indexDbPath = getIndexDbPath(this.projectPath);

		if (!existsSync(indexDbPath)) {
			return {
				exists: false,
				totalFiles: 0,
				totalChunks: 0,
				languages: [],
			};
		}

		// Initialize with forSearch=true (not indexing, just reading status)
		await this.initialize(true);

		const trackerStats = this.fileTracker!.getStats();
		const storeStats = await this.vectorStore!.getStats();

		const embeddingModel = this.fileTracker!.getMetadata("embeddingModel");
		const lastIndexed = this.fileTracker!.getMetadata("lastIndexed");

		return {
			exists: true,
			totalFiles: trackerStats.totalFiles,
			totalChunks: storeStats.totalChunks,
			lastUpdated: lastIndexed ? new Date(lastIndexed) : undefined,
			embeddingModel: embeddingModel || undefined,
			languages: storeStats.languages,
		};
	}

	/**
	 * Clear the index
	 */
	async clear(): Promise<void> {
		await this.initialize();

		await this.vectorStore!.clear();
		this.fileTracker!.clear();
	}

	/**
	 * Check if another process is currently indexing this project
	 */
	isIndexingInProgress(): {
		inProgress: boolean;
		holderPid?: number;
		runningFor?: number;
	} {
		const lock = createIndexLock(this.projectPath);
		const status = lock.isLocked();
		return {
			inProgress: status.locked,
			holderPid: status.holderPid,
			runningFor: status.runningFor,
		};
	}

	/**
	 * Force release a stale lock (use when a previous indexing process died)
	 */
	forceUnlock(): boolean {
		const lock = createIndexLock(this.projectPath);
		return lock.forceRelease();
	}

	/**
	 * Get the stored embedding model for a project without full initialization.
	 * Useful for quick checks before search operations.
	 */
	static getStoredEmbeddingModel(projectPath: string): string | null {
		const indexDbPath = getIndexDbPath(projectPath);
		if (!existsSync(indexDbPath)) {
			return null;
		}
		const tracker = createFileTracker(indexDbPath, projectPath);
		const model = tracker.getMetadata("embeddingModel");
		tracker.close();
		return model;
	}

	/**
	 * Discover files to index
	 */
	private discoverFiles(): string[] {
		const files: string[] = [];
		const parserManager = getParserManager();
		const supportedExtensions = new Set(parserManager.getSupportedExtensions());

		const walk = (dir: string) => {
			const entries = readdirSync(dir, { withFileTypes: true });

			for (const entry of entries) {
				const fullPath = join(dir, entry.name);
				const relativePath = relative(this.projectPath, fullPath);

				// Check exclude patterns
				if (
					sharedShouldExclude(
						relativePath,
						entry.isDirectory(),
						this.excludePatterns,
					)
				) {
					continue;
				}

				if (entry.isDirectory()) {
					walk(fullPath);
				} else if (entry.isFile()) {
					// Check include patterns if specified
					if (
						this.includePatterns.length > 0 &&
						!sharedShouldInclude(relativePath, this.includePatterns)
					) {
						continue;
					}

					// Get file extension and check if supported by parser
					const ext = "." + entry.name.split(".").pop()?.toLowerCase();
					if (supportedExtensions.has(ext)) {
						files.push(fullPath);
					}
				}
			}
		};

		walk(this.projectPath);
		return files;
	}

	/**
	 * Extract symbol graph from indexed files
	 * Phase 4.5 of the indexing pipeline
	 */
	private async extractSymbolGraph(
		filesToIndex: string[],
		force: boolean,
	): Promise<void> {
		const symbolExtractor = createSymbolExtractor();
		const graphManager = createReferenceGraphManager(this.fileTracker!);
		const parserManager = getParserManager();

		// Delete old symbols/references for files being re-indexed
		if (!force) {
			for (const filePath of filesToIndex) {
				this.fileTracker!.deleteSymbolsByFile(filePath);
			}
		} else {
			// Full reindex - clear all symbol data
			this.fileTracker!.clearSymbolGraph();
		}

		// Extract symbols and references from each file
		if (this.onProgress) {
			this.onProgress(
				0,
				filesToIndex.length,
				"[analyzing] extracting symbols...",
			);
		}

		let processedFiles = 0;
		for (const filePath of filesToIndex) {
			const language = parserManager.getLanguage(filePath);
			if (!language) {
				continue;
			}

			try {
				const content = readFileSync(filePath, "utf-8");
				const relativePath = relative(this.projectPath, filePath);

				// Extract symbols
				const symbols = await symbolExtractor.extractSymbols(
					content,
					relativePath,
					language as SupportedLanguage,
				);

				if (symbols.length > 0) {
					this.fileTracker!.insertSymbols(symbols);

					// Extract references
					const references = await symbolExtractor.extractReferences(
						content,
						relativePath,
						language as SupportedLanguage,
						symbols,
					);

					if (references.length > 0) {
						this.fileTracker!.insertReferences(references);
					}
				}
			} catch (error) {
				// Symbol extraction errors shouldn't fail indexing
				console.warn(
					`Warning: Failed to extract symbols from ${filePath}:`,
					error instanceof Error ? error.message : error,
				);
			}

			processedFiles++;
			if (this.onProgress && processedFiles % 50 === 0) {
				this.onProgress(
					processedFiles,
					filesToIndex.length,
					`[analyzing] ${processedFiles}/${filesToIndex.length} files`,
				);
			}
		}

		// Resolve cross-file references
		if (this.onProgress) {
			this.onProgress(0, 1, "[analyzing] resolving references...");
		}
		const resolvedCount = await graphManager.resolveReferences();

		// Compute PageRank scores
		if (this.onProgress) {
			this.onProgress(0, 1, "[analyzing] computing importance scores...");
		}
		await graphManager.computeAndStorePageRank();

		// Generate and cache repo map
		const repoMapGen = createRepoMapGenerator(this.fileTracker!);
		const repoMap = repoMapGen.generate({ maxTokens: 4000 });
		this.fileTracker!.setMetadata("repoMap", repoMap);
		this.fileTracker!.setMetadata(
			"repoMapGeneratedAt",
			new Date().toISOString(),
		);

		// Store graph stats
		const stats = this.fileTracker!.getSymbolGraphStats();
		this.fileTracker!.setMetadata("symbolGraphStats", JSON.stringify(stats));

		if (this.onProgress) {
			this.onProgress(
				filesToIndex.length,
				filesToIndex.length,
				`[analyzing] ${stats.totalSymbols} symbols, ${resolvedCount} refs resolved`,
			);
		}
	}

	/**
	 * Fetch external documentation for project dependencies
	 * Phase 6 of the indexing pipeline
	 *
	 * Uses parallel fetching for better performance when fetching many libraries.
	 */
	private async fetchExternalDocs(): Promise<{
		librariesFetched: number;
		chunksAdded: number;
		cost?: number;
	}> {
		if (
			!this.docsFetcher ||
			!this.embeddingsClient ||
			!this.vectorStore ||
			!this.fileTracker
		) {
			return { librariesFetched: 0, chunksAdded: 0 };
		}

		const config = getDocsConfig(this.projectPath);
		const cacheTTLMs = (config.cacheTTL || 24) * 60 * 60 * 1000;

		// Detect dependencies
		const deps = await this.docsFetcher.detectDependencies(this.projectPath);
		if (deps.length === 0) {
			return { librariesFetched: 0, chunksAdded: 0 };
		}

		// Filter to dependencies that need refresh
		const depsToFetch = deps.filter((dep) =>
			this.fileTracker!.needsDocsRefresh(
				dep.name,
				dep.majorVersion,
				cacheTTLMs,
			),
		);

		if (depsToFetch.length === 0) {
			if (this.onProgress) {
				this.onProgress(
					deps.length,
					deps.length,
					`[docs] ${deps.length} libraries up-to-date`,
				);
			}
			return { librariesFetched: 0, chunksAdded: 0 };
		}

		if (this.onProgress) {
			this.onProgress(
				0,
				depsToFetch.length,
				`[docs] fetching ${depsToFetch.length} libraries...`,
			);
		}

		// Thread-safe counters (JS is single-threaded for sync ops)
		let librariesFetched = 0;
		let totalChunksAdded = 0;
		let totalCost = 0;
		let completed = 0;
		const inProgress = new Set<string>();
		const concurrency = this.enrichmentConcurrency; // Use same concurrency as enrichment

		// Process a single dependency
		const processDep = async (dep: (typeof depsToFetch)[0]): Promise<void> => {
			inProgress.add(dep.name);

			// Report progress with active items
			if (this.onProgress) {
				const active = inProgress.size;
				const activeList = Array.from(inProgress).slice(0, 3).join(", ");
				const moreCount = active > 3 ? ` +${active - 3}` : "";
				this.onProgress(
					completed,
					depsToFetch.length,
					`[docs] ${completed}/${depsToFetch.length} (${active} active) ${activeList}${moreCount}`,
					active,
				);
			}

			try {
				// Fetch and chunk documentation
				const chunks = await this.docsFetcher!.fetchAndChunk(dep.name, {
					version: dep.majorVersion,
				});

				if (chunks.length === 0) {
					return;
				}

				// Virtual path for documentation chunks
				const docsPath = `docs:${dep.name}`;

				// Delete old chunks for this library first
				await this.vectorStore!.deleteByFile(docsPath);

				// Embed the chunks
				const texts = chunks.map((c) => c.content);
				const embedResult = await this.embeddingsClient!.embed(texts);

				if (embedResult.cost) {
					totalCost += embedResult.cost;
				}

				// Add chunks to vector store
				const fileHash = computeHash(chunks.map((c) => c.content).join(""));
				const chunksWithEmbeddings: import("../types.js").ChunkWithEmbedding[] =
					chunks.map((chunk, idx) => ({
						id: chunk.id,
						content: chunk.content,
						filePath: docsPath,
						startLine: 0,
						endLine: 0,
						language: "markdown",
						chunkType: "module" as const, // Use module for docs
						contentHash: computeHash(chunk.content),
						fileHash,
						vector: embedResult.embeddings[idx],
						// Store doc-specific metadata in name field for now
						name: chunk.title,
						signature: chunk.sourceUrl,
					}));

				await this.vectorStore!.addChunks(chunksWithEmbeddings);

				// Mark as indexed in tracker
				this.fileTracker!.markDocsIndexed(
					dep.name,
					dep.majorVersion || null,
					chunks[0].provider,
					fileHash,
					chunks.map((c) => c.id),
				);

				librariesFetched++;
				totalChunksAdded += chunks.length;
			} catch (error) {
				console.warn(
					`  ⚠️  Failed to fetch docs for ${dep.name}:`,
					error instanceof Error ? error.message : error,
				);
			} finally {
				inProgress.delete(dep.name);
				completed++;
			}
		};

		// Process in parallel batches (same pattern as enricher)
		for (let i = 0; i < depsToFetch.length; i += concurrency) {
			const batch = depsToFetch.slice(i, i + concurrency);
			await Promise.all(batch.map(processDep));
		}

		if (this.onProgress) {
			this.onProgress(
				depsToFetch.length,
				depsToFetch.length,
				`[docs] ${librariesFetched} libraries, ${totalChunksAdded} chunks`,
			);
		}

		return {
			librariesFetched,
			chunksAdded: totalChunksAdded,
			cost: totalCost > 0 ? totalCost : undefined,
		};
	}

	/**
	 * Close all resources
	 */
	async close(): Promise<void> {
		if (this.vectorStore) {
			await this.vectorStore.close();
		}
		if (this.fileTracker) {
			this.fileTracker.close();
		}
	}
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create an indexer for a project
 */
export function createIndexer(options: IndexerOptions): Indexer {
	return new Indexer(options);
}

/**
 * Quick index function
 */
export async function indexProject(
	projectPath: string,
	options: Partial<IndexerOptions> = {},
): Promise<IndexResult> {
	const indexer = createIndexer({ projectPath, ...options });
	try {
		return await indexer.index(options.force !== false);
	} finally {
		await indexer.close();
	}
}

/**
 * Quick search function
 */
export async function searchProject(
	projectPath: string,
	query: string,
	options: SearchOptions = {},
): Promise<SearchResult[]> {
	const indexer = createIndexer({ projectPath });
	try {
		return await indexer.search(query, options);
	} finally {
		await indexer.close();
	}
}
