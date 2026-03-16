/**
 * CloudAwareIndexer — orchestrates the 10-step cloud indexing flow
 *
 * Wraps the existing local chunking pipeline and uploads results to the
 * mnemex cloud API using an ICloudIndexClient.
 *
 * The indexer is deliberately decoupled from the local Indexer class —
 * it uses chunkFileByPath and the symbol extractor directly, rather than
 * extending or instantiating Indexer. This keeps concerns separate and
 * avoids pulling in LanceDB / SQLite dependencies for CI environments.
 *
 * Flow (10 steps):
 *  1. getHeadSha()                        → currentSha
 *  2. getCommitStatus(currentSha)         → skip if already "ready"
 *  3. getParentShas(currentSha)           → parentSha (first parent)
 *  4. getChangedFiles(parentSha, head)    → changedFiles
 *  5. Read + chunk each non-deleted file
 *  6. checkChunks(allHashes)             → existing / missing
 *  7. embed missing hashes (thin mode)
 *  8. Build UploadIndexRequest
 *  9. uploadIndex(request)
 * 10. (smart mode) waitForCommit() — not implemented yet
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { IEmbeddingsClient } from "../types.js";
import { chunkFileByPath } from "../core/chunker.js";
import { getParserManager } from "../parsers/parser-manager.js";
import type { IVectorStore } from "../core/store.js";
import type {
	ICloudIndexClient,
	IChangeDetector,
	ChangedFile,
	CloudEnrichmentDoc,
	UploadChunk,
	UploadIndexRequest,
} from "./types.js";
import type { TeamConfig } from "./types.js";

// ============================================================================
// Result type
// ============================================================================

export interface CloudIndexResult {
	/** Full 40-char commit SHA that was indexed */
	commitSha: string;
	/**
	 * Final status:
	 * - "ready"     — upload accepted (thin mode commits are immediately ready)
	 * - "embedding" — upload accepted, cloud is embedding (smart mode)
	 * - "skipped"   — commit was already indexed; nothing uploaded
	 */
	status: "ready" | "embedding" | "skipped";
	/** Number of changed files processed */
	filesChanged: number;
	/** Number of chunks uploaded in this run */
	chunksUploaded: number;
	/** Number of chunks skipped (already existed in cloud) */
	chunksDeduped: number;
	/** Embedding cost in USD (thin mode only, if reported by provider) */
	embeddingCost?: number;
	/** Wall-clock duration in milliseconds */
	durationMs: number;
}

// ============================================================================
// Options
// ============================================================================

export interface CloudIndexerOptions {
	/** Absolute path to the project root */
	projectPath: string;
	/** Cloud API client (real or stub) */
	cloudClient: ICloudIndexClient;
	/** Git change detector */
	changeDetector: IChangeDetector;
	/**
	 * Embeddings client used in thin mode to generate vectors locally.
	 * Required when teamConfig.cloudMode is "thin" (the default).
	 * Omit to skip embedding (useful in tests or smart mode).
	 */
	embeddingsClient?: IEmbeddingsClient;
	/**
	 * Local vector store for reading enrichment docs.
	 * Required when teamConfig.uploadEnrichment === true.
	 * Omit to skip enrichment upload.
	 */
	vectorStore?: IVectorStore;
	/** Team configuration from mnemex.json */
	teamConfig: TeamConfig;
	/** Optional progress callback for UI feedback */
	onProgress?: (message: string) => void;
}

// ============================================================================
// CloudAwareIndexer
// ============================================================================

export class CloudAwareIndexer {
	private readonly projectPath: string;
	private readonly cloudClient: ICloudIndexClient;
	private readonly changeDetector: IChangeDetector;
	private readonly embeddingsClient?: IEmbeddingsClient;
	private readonly vectorStore?: IVectorStore;
	private readonly teamConfig: TeamConfig;
	private readonly onProgress: (message: string) => void;

	constructor(options: CloudIndexerOptions) {
		this.projectPath = options.projectPath;
		this.cloudClient = options.cloudClient;
		this.changeDetector = options.changeDetector;
		this.embeddingsClient = options.embeddingsClient;
		this.vectorStore = options.vectorStore;
		this.teamConfig = options.teamConfig;
		this.onProgress = options.onProgress ?? (() => {});
	}

	/**
	 * Execute the full 10-step cloud indexing flow.
	 */
	async indexToCloud(): Promise<CloudIndexResult> {
		const startMs = Date.now();
		const repoSlug = this.resolveRepoSlug();
		const orgSlug = this.teamConfig.orgSlug;
		const mode = this.teamConfig.cloudMode ?? "thin";

		// ── Step 1: Get current HEAD SHA ────────────────────────────────────
		this.onProgress("Getting HEAD commit SHA...");
		const currentSha = await this.changeDetector.getHeadSha();

		// ── Step 2: Check if already indexed ────────────────────────────────
		this.onProgress(`Checking cloud status for ${currentSha.slice(0, 8)}...`);
		const existingStatus = await this.cloudClient.getCommitStatus(
			repoSlug,
			currentSha,
		);
		if (existingStatus.status === "ready") {
			this.onProgress("Commit already indexed — skipping upload.");
			return {
				commitSha: currentSha,
				status: "skipped",
				filesChanged: 0,
				chunksUploaded: 0,
				chunksDeduped: 0,
				durationMs: Date.now() - startMs,
			};
		}

		// ── Step 3: Get parent SHA ───────────────────────────────────────────
		this.onProgress("Resolving parent commit...");
		const parentShas = await this.changeDetector.getParentShas(currentSha);
		const parentSha = parentShas[0] ?? null; // null = initial commit

		// ── Step 4: Get changed files ────────────────────────────────────────
		this.onProgress(
			parentSha
				? `Computing diff ${parentSha.slice(0, 8)}..${currentSha.slice(0, 8)}...`
				: "Initial commit — indexing all files...",
		);
		const changedFiles = await this.changeDetector.getChangedFiles(
			parentSha,
			currentSha,
		);

		// Separate deleted files from files to process
		const deletedFiles = changedFiles
			.filter((f) => f.status === "deleted")
			.map((f) => f.filePath);

		const filesToProcess = changedFiles.filter((f) => f.status !== "deleted");

		this.onProgress(
			`Processing ${filesToProcess.length} changed files (${deletedFiles.length} deleted)...`,
		);

		// ── Step 5: Read + chunk each non-deleted file ───────────────────────
		await this.ensureParsersInitialized();

		const allChunks: UploadChunk[] = [];

		for (const file of filesToProcess) {
			const chunks = await this.processFile(file);
			allChunks.push(...chunks);
		}

		this.onProgress(`Collected ${allChunks.length} chunks from changed files.`);

		// ── Step 6: Check which chunks already exist in cloud ────────────────
		let chunksUploaded = 0;
		let chunksDeduped = 0;
		let embeddingCost: number | undefined;
		let chunksToUpload = allChunks;

		if (allChunks.length > 0) {
			this.onProgress("Checking chunk deduplication...");
			const allHashes = allChunks.map((c) => c.contentHash);
			const checkResult = await this.cloudClient.checkChunks(
				repoSlug,
				allHashes,
			);

			const existingSet = new Set(checkResult.existing);
			const missingSet = new Set(checkResult.missing);

			chunksDeduped = checkResult.existing.length;
			chunksToUpload = allChunks.filter((c) => missingSet.has(c.contentHash));

			this.onProgress(
				`Deduplication: ${chunksDeduped} existing, ${chunksToUpload.length} to upload.`,
			);

			// Mark existing chunks (already in cloud) so they don't need vectors
			const existingChunks = allChunks
				.filter((c) => existingSet.has(c.contentHash))
				.map((c) => ({ ...c, vector: undefined as unknown as number[] }));

			// ── Step 7: Embed missing chunks (thin mode) ─────────────────────
			if (mode === "thin" && chunksToUpload.length > 0) {
				const embeddedChunks = await this.embedChunks(chunksToUpload);
				chunksToUpload = embeddedChunks.chunks;
				embeddingCost = embeddedChunks.cost;
			}

			chunksUploaded = chunksToUpload.length;

			// Combine: chunks to upload + re-listed existing chunks (for commit mapping)
			// The upload request includes ALL chunks for this commit (for server-side
			// commit → chunk mapping), but only missing ones have actual data.
			// We send only chunks we're uploading to save bandwidth.
			void existingChunks; // not re-uploaded, server already has them
		}

		// ── Step 7b: Collect enrichment docs (optional) ──────────────────────
		let enrichmentDocs: CloudEnrichmentDoc[] | undefined;
		if (
			this.teamConfig.uploadEnrichment &&
			this.vectorStore &&
			filesToProcess.length > 0
		) {
			enrichmentDocs = await this.collectEnrichmentDocs(
				filesToProcess.map((f) => f.filePath),
			);
			if (enrichmentDocs.length > 0) {
				this.onProgress(
					`Collected ${enrichmentDocs.length} enrichment docs for upload.`,
				);
			}
		}

		// ── Step 8: Build upload request ────────────────────────────────────
		const uploadRequest: UploadIndexRequest = {
			orgSlug,
			repoSlug,
			commitSha: currentSha,
			parentShas: parentShas,
			chunks: chunksToUpload,
			deletedFiles: deletedFiles.length > 0 ? deletedFiles : undefined,
			mode,
			enrichmentDocs:
				enrichmentDocs && enrichmentDocs.length > 0
					? enrichmentDocs
					: undefined,
		};

		// ── Step 9: Upload index ─────────────────────────────────────────────
		this.onProgress(
			`Uploading ${chunksToUpload.length} chunks for commit ${currentSha.slice(0, 8)}...`,
		);
		const uploadResponse = await this.cloudClient.uploadIndex(uploadRequest);

		// ── Step 10: Wait for cloud processing (smart mode only) ─────────────
		// Smart mode: cloud embeds the text server-side. We poll until ready.
		// Thin mode: vectors are included; commit is ready immediately after upload.
		let finalStatus: "ready" | "embedding" = "ready";
		if (mode === "smart" && uploadResponse.status !== "ready") {
			finalStatus = "embedding";
			this.onProgress(
				`Cloud is embedding chunks for ${currentSha.slice(0, 8)} — polling for completion...`,
			);
			const commitStatus = await this.cloudClient.waitForCommit(
				repoSlug,
				currentSha,
			);
			if (commitStatus.status === "ready") {
				finalStatus = "ready";
				this.onProgress("Cloud embedding complete — commit is ready.");
			} else {
				this.onProgress(
					`Commit status after polling: ${commitStatus.status}. ` +
						"The index may not be fully searchable yet.",
				);
			}
		}

		this.onProgress(
			`Upload complete: ${uploadResponse.chunksAdded} added, ${uploadResponse.chunksDeduplicated} deduped.`,
		);

		return {
			commitSha: currentSha,
			status: finalStatus,
			filesChanged: filesToProcess.length,
			chunksUploaded,
			chunksDeduped,
			embeddingCost,
			durationMs: Date.now() - startMs,
		};
	}

	// --------------------------------------------------------------------------
	// Private helpers
	// --------------------------------------------------------------------------

	private resolveRepoSlug(): string {
		if (this.teamConfig.repoSlug) {
			return this.teamConfig.repoSlug;
		}
		// Fallback: use orgSlug/project-path-basename
		const baseName =
			this.projectPath.split("/").filter(Boolean).pop() ?? "repo";
		return `${this.teamConfig.orgSlug}/${baseName}`;
	}

	/** Ensure tree-sitter parsers are initialized before chunking */
	private async ensureParsersInitialized(): Promise<void> {
		const parserManager = getParserManager();
		await parserManager.initialize();
	}

	/**
	 * Read a file from disk and convert its chunks to UploadChunk format.
	 * Returns an empty array if the file cannot be read.
	 *
	 * In smart mode the text field is populated so the cloud can embed it.
	 * In thin mode the text field is omitted to save upload bandwidth.
	 */
	private async processFile(file: ChangedFile): Promise<UploadChunk[]> {
		const absolutePath = join(this.projectPath, file.filePath);
		let source: string;
		try {
			source = readFileSync(absolutePath, "utf8");
		} catch {
			// File may have been deleted after diff computation, or inaccessible
			return [];
		}

		const mode = this.teamConfig.cloudMode ?? "thin";
		const fileHash = computeContentHash(source);
		const codeChunks = await chunkFileByPath(source, file.filePath, fileHash);

		return codeChunks.map(
			(chunk): UploadChunk => ({
				contentHash: chunk.contentHash,
				filePath: chunk.filePath,
				startLine: chunk.startLine,
				endLine: chunk.endLine,
				language: chunk.language,
				chunkType: chunk.chunkType,
				name: chunk.name,
				// Include raw source text in smart mode so the cloud can embed it.
				// Omit in thin mode to save upload bandwidth (vectors carry the semantics).
				text: mode === "smart" ? chunk.content : undefined,
			}),
		);
	}

	/**
	 * Collect enrichment docs from the local vector store for a set of file paths.
	 *
	 * Fetches file_summary and symbol_summary documents for each changed file
	 * from the local LanceDB index. These are uploaded alongside chunks so that
	 * the cloud index can serve LLM-generated summaries without re-generating them.
	 *
	 * The contentHash field in the returned docs is set to the file's contentHash
	 * (derived from the file hash stored in the enrichment doc's fileHash field).
	 * Since enrichment docs don't store a per-chunk contentHash, we use the
	 * doc's own ID as the contentHash to uniquely identify each enrichment entry.
	 */
	private async collectEnrichmentDocs(
		filePaths: string[],
	): Promise<CloudEnrichmentDoc[]> {
		if (!this.vectorStore) return [];

		const docs: CloudEnrichmentDoc[] = [];
		const docTypes = ["file_summary", "symbol_summary"] as const;

		for (const filePath of filePaths) {
			try {
				const stored = await this.vectorStore.getDocumentsByFile(
					filePath,
					docTypes as unknown as import("../types.js").DocumentType[],
				);

				for (const doc of stored) {
					if (!doc.content) continue;
					// Use doc.id as contentHash — it's a stable SHA256 of the content
					docs.push({
						contentHash: doc.id,
						docType: doc.documentType,
						content: doc.content,
						llmModel: (doc.metadata?.["llmModel"] as string) ?? "unknown",
					});
				}
			} catch {
				// Non-fatal: enrichment docs may not exist for all files
			}
		}

		return docs;
	}

	/**
	 * Generate embeddings for chunks that are missing from the cloud.
	 * Returns the chunks with vector fields populated.
	 */
	private async embedChunks(
		chunks: UploadChunk[],
	): Promise<{ chunks: UploadChunk[]; cost?: number }> {
		if (!this.embeddingsClient) {
			// No embeddings client available — return chunks without vectors
			// (server will need to handle missing vectors or reject)
			return { chunks };
		}

		this.onProgress(
			`Generating embeddings for ${chunks.length} chunks (thin mode)...`,
		);

		// We need the source text to embed. Since UploadChunk.text is optional,
		// we use name + chunkType as fallback for chunks that have no text.
		// In a real flow the text should have been set by processFile.
		const texts = chunks.map(
			(c) =>
				c.text ?? [c.name, c.chunkType, c.filePath].filter(Boolean).join(" "),
		);

		const embedResult = await this.embeddingsClient.embed(texts);

		const embeddedChunks = chunks.map((chunk, i) => ({
			...chunk,
			vector: embedResult.embeddings[i],
		}));

		return {
			chunks: embeddedChunks,
			cost: embedResult.cost,
		};
	}
}

// ============================================================================
// Helpers
// ============================================================================

function computeContentHash(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a CloudAwareIndexer with the given options.
 */
export function createCloudIndexer(
	options: CloudIndexerOptions,
): CloudAwareIndexer {
	return new CloudAwareIndexer(options);
}
