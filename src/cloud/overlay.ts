/**
 * OverlayIndex — local LanceDB index for uncommitted (dirty) files
 *
 * Layered on top of the cloud index to provide up-to-date search results
 * for files that have not yet been committed and uploaded. The overlay is
 * stored at `{projectPath}/.mnemex/overlay/` and uses the same
 * VectorStore + chunkFileByPath infrastructure as the main index.
 *
 * Staleness detection uses a SHA-256 fingerprint computed from each dirty
 * file's path and mtime. If the fingerprint changes (files modified, added,
 * or removed) the overlay is rebuilt automatically before search.
 */

import { createHash } from "node:crypto";
import {
	existsSync,
	readFileSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { chunkFileByPath } from "../core/chunker.js";
import { VectorStore } from "../core/store.js";
import { getParserManager } from "../parsers/parser-manager.js";
import type { IEmbeddingsClient, SearchResult } from "../types.js";
import type { DirtyFile, IOverlayIndex } from "./types.js";

// ============================================================================
// Options
// ============================================================================

export interface OverlayIndexOptions {
	/** Absolute path to the project root */
	projectPath: string;
	/**
	 * Directory where the overlay LanceDB database is stored.
	 * Typically `{projectPath}/.mnemex/overlay`.
	 */
	overlayDir: string;
	/** Embeddings client used to generate vectors for dirty file chunks */
	embeddingsClient: IEmbeddingsClient;
}

// ============================================================================
// OverlayIndex
// ============================================================================

export class OverlayIndex implements IOverlayIndex {
	private readonly projectPath: string;
	private readonly overlayDir: string;
	private readonly embeddingsClient: IEmbeddingsClient;
	private readonly fingerprintPath: string;
	private vectorStore: VectorStore;
	private initialized = false;

	constructor(options: OverlayIndexOptions) {
		this.projectPath = options.projectPath;
		this.overlayDir = options.overlayDir;
		this.embeddingsClient = options.embeddingsClient;
		this.fingerprintPath = join(options.overlayDir, ".fingerprint");
		this.vectorStore = new VectorStore(
			join(options.overlayDir, "vectors"),
			options.projectPath,
		);
	}

	// --------------------------------------------------------------------------
	// IOverlayIndex
	// --------------------------------------------------------------------------

	/**
	 * Check whether the overlay is stale given the current set of dirty files.
	 *
	 * Returns true if:
	 * - No fingerprint file exists (first use)
	 * - The computed fingerprint differs from the stored fingerprint
	 */
	async isStale(dirtyFiles: DirtyFile[]): Promise<boolean> {
		const current = this.computeFingerprint(dirtyFiles);
		if (!existsSync(this.fingerprintPath)) {
			return true;
		}
		try {
			const stored = readFileSync(this.fingerprintPath, "utf8").trim();
			return stored !== current;
		} catch {
			return true;
		}
	}

	/**
	 * Rebuild the overlay index from the provided dirty files.
	 *
	 * Steps:
	 *  1. Filter out deleted files (status === "deleted")
	 *  2. Read each file from disk, skip on error
	 *  3. Chunk via chunkFileByPath
	 *  4. Embed chunks
	 *  5. Clear existing overlay vectors
	 *  6. Write new chunks to LanceDB
	 *  7. Write new fingerprint file
	 */
	async rebuild(
		dirtyFiles: DirtyFile[],
		onProgress?: (msg: string) => void,
	): Promise<void> {
		const report = onProgress ?? (() => {});

		// Initialize parsers + store
		await this.ensureInitialized();

		const filesToProcess = dirtyFiles.filter((f) => f.status !== "deleted");
		report(
			`Overlay: rebuilding from ${filesToProcess.length} dirty file(s)...`,
		);

		// Collect chunks from all dirty files
		const allChunksWithContent: Array<{
			chunk: import("../types.js").CodeChunk;
			content: string;
		}> = [];

		for (const dirty of filesToProcess) {
			const absolutePath = join(this.projectPath, dirty.filePath);
			let source: string;
			try {
				source = readFileSync(absolutePath, "utf8");
			} catch {
				// File may have been removed between getDirtyFiles and rebuild
				continue;
			}

			const fileHash = createHash("sha256").update(source).digest("hex");
			const chunks = await chunkFileByPath(source, dirty.filePath, fileHash);
			for (const chunk of chunks) {
				allChunksWithContent.push({ chunk, content: chunk.content });
			}
		}

		report(
			`Overlay: collected ${allChunksWithContent.length} chunk(s), embedding...`,
		);

		// Clear existing overlay
		await this.vectorStore.clear();

		if (allChunksWithContent.length === 0) {
			// Nothing to index — write fingerprint and return
			this.writeFingerprint(dirtyFiles);
			report("Overlay: no chunks to index.");
			return;
		}

		// Embed all chunks
		const texts = allChunksWithContent.map((c) => c.content);
		const embedResult = await this.embeddingsClient.embed(texts);
		const vectors = embedResult.embeddings;

		// Build ChunkWithEmbedding objects
		const chunksWithEmbedding = allChunksWithContent.map((c, i) => ({
			...c.chunk,
			vector: vectors[i],
		}));

		// Write to LanceDB
		await this.vectorStore.addChunks(chunksWithEmbedding);

		// Persist fingerprint
		this.writeFingerprint(dirtyFiles);

		report(
			`Overlay: indexed ${chunksWithEmbedding.length} chunk(s) from ${filesToProcess.length} file(s).`,
		);
	}

	/** Search the overlay index */
	async search(
		queryVector: number[],
		queryText: string,
		limit?: number,
	): Promise<SearchResult[]> {
		await this.ensureInitialized();
		return this.vectorStore.search(queryText, queryVector, {
			limit: limit ?? 10,
		});
	}

	/** Return stats about the overlay contents */
	async getStats(): Promise<{ chunkCount: number; fileCount: number }> {
		await this.ensureInitialized();
		const stats = await this.vectorStore.getStats();
		return {
			chunkCount: stats.totalChunks,
			fileCount: stats.uniqueFiles,
		};
	}

	/**
	 * Invalidate the overlay by deleting the fingerprint file.
	 * The next call to isStale() will return true, forcing a rebuild.
	 */
	async invalidate(): Promise<void> {
		if (existsSync(this.fingerprintPath)) {
			try {
				unlinkSync(this.fingerprintPath);
			} catch {
				// Ignore errors (race condition or already deleted)
			}
		}
	}

	/** Release resources held by the overlay */
	async close(): Promise<void> {
		await this.vectorStore.close();
	}

	// --------------------------------------------------------------------------
	// Private helpers
	// --------------------------------------------------------------------------

	/**
	 * Ensure the vector store is initialized and parsers are ready.
	 * Idempotent — subsequent calls are no-ops.
	 */
	private async ensureInitialized(): Promise<void> {
		if (this.initialized) return;
		const parserManager = getParserManager();
		await parserManager.initialize();
		await this.vectorStore.initialize();
		this.initialized = true;
	}

	/**
	 * Compute a fingerprint for the current set of dirty files.
	 *
	 * The fingerprint is SHA-256 of the sorted list of
	 * `{filePath}:{mtimeMs}` pairs, so any file modification, addition,
	 * or removal changes the fingerprint.
	 *
	 * Deleted files (status === "deleted") do not have an mtime on disk;
	 * we include them with mtime "0" so that removing a file is still
	 * detected as a change.
	 */
	private computeFingerprint(dirtyFiles: DirtyFile[]): string {
		const parts = dirtyFiles
			.map((f) => {
				if (f.status === "deleted") {
					return `${f.filePath}:0`;
				}
				const absolutePath = join(this.projectPath, f.filePath);
				try {
					const mtime = statSync(absolutePath).mtimeMs;
					return `${f.filePath}:${mtime}`;
				} catch {
					return `${f.filePath}:0`;
				}
			})
			.sort();

		return createHash("sha256").update(parts.join("\n")).digest("hex");
	}

	/** Write the current fingerprint to disk */
	private writeFingerprint(dirtyFiles: DirtyFile[]): void {
		const fingerprint = this.computeFingerprint(dirtyFiles);
		try {
			writeFileSync(this.fingerprintPath, fingerprint + "\n", "utf8");
		} catch {
			// Non-fatal — next isStale() call will recompute
		}
	}
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create and return a new OverlayIndex.
 *
 * The overlay directory is typically `{projectPath}/.mnemex/overlay`.
 * The VectorStore inside is lazily initialized on first use.
 */
export async function createOverlayIndex(
	options: OverlayIndexOptions,
): Promise<OverlayIndex> {
	return new OverlayIndex(options);
}
