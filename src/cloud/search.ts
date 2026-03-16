/**
 * CloudAwareSearch — orchestrates merged cloud + overlay search
 *
 * 7-step search flow:
 *  1. getDirtyFiles()                     → dirtyFiles
 *  2. overlayIndex.isStale(dirtyFiles)    → rebuild if stale
 *  3. embeddingsClient.embedOne(query)    → queryVector
 *  4a. cloudClient.search(...)            → cloudResults  ─┐ parallel
 *  4b. overlayIndex.search(...)           → overlayResults ─┘
 *  5. OverlayMerger.merge(...)            → merged results
 *  6. Return merged results
 *
 * Cloud errors are handled gracefully — if the cloud search fails the
 * method still returns overlay-only results (best-effort degradation).
 */

import type {
	IEmbeddingsClient,
	SearchOptions,
	SearchResult,
} from "../types.js";
import type {
	IChangeDetector,
	ICloudIndexClient,
	IOverlayIndex,
	DirtyFile,
} from "./types.js";
import { OverlayMerger, type MergedSearchResult } from "./merger.js";

// ============================================================================
// Options
// ============================================================================

export interface CloudSearchOptions {
	/** Absolute path to the project root */
	projectPath: string;
	/** Cloud API client (real or stub) */
	cloudClient: ICloudIndexClient;
	/** Local overlay index for dirty files */
	overlayIndex: IOverlayIndex;
	/** Git change detector */
	changeDetector: IChangeDetector;
	/** Embeddings client used to embed the query */
	embeddingsClient: IEmbeddingsClient;
	/** Repository slug used for cloud API calls */
	repoSlug: string;
	/** Current HEAD commit SHA used for cloud API calls */
	commitSha: string;
}

// ============================================================================
// CloudAwareSearch
// ============================================================================

export class CloudAwareSearch {
	private readonly projectPath: string;
	private readonly cloudClient: ICloudIndexClient;
	private readonly overlayIndex: IOverlayIndex;
	private readonly changeDetector: IChangeDetector;
	private readonly embeddingsClient: IEmbeddingsClient;
	private readonly repoSlug: string;
	private readonly commitSha: string;

	constructor(options: CloudSearchOptions) {
		this.projectPath = options.projectPath;
		this.cloudClient = options.cloudClient;
		this.overlayIndex = options.overlayIndex;
		this.changeDetector = options.changeDetector;
		this.embeddingsClient = options.embeddingsClient;
		this.repoSlug = options.repoSlug;
		this.commitSha = options.commitSha;
	}

	/**
	 * Run a merged cloud + overlay search.
	 *
	 * Never throws — returns best-effort results even when cloud is offline.
	 */
	async search(
		queryText: string,
		options: SearchOptions & { onProgress?: (msg: string) => void } = {},
	): Promise<MergedSearchResult[]> {
		const report = options.onProgress ?? (() => {});
		const limit = options.limit ?? 10;

		// ── Step 1: Get dirty files ──────────────────────────────────────────
		let dirtyFiles: DirtyFile[] = [];
		try {
			dirtyFiles = await this.changeDetector.getDirtyFiles();
		} catch (err) {
			// Non-fatal — treat as no dirty files
			report(`CloudAwareSearch: could not get dirty files: ${String(err)}`);
		}

		const dirtyFilePaths = dirtyFiles.map((f) => f.filePath);

		// ── Step 2: Rebuild overlay if stale ─────────────────────────────────
		try {
			const stale = await this.overlayIndex.isStale(dirtyFiles);
			if (stale) {
				report("CloudAwareSearch: overlay is stale, rebuilding...");
				await this.overlayIndex.rebuild(dirtyFiles, report);
			}
		} catch (err) {
			// Non-fatal — proceed without overlay
			report(`CloudAwareSearch: overlay rebuild failed: ${String(err)}`);
		}

		// ── Step 3: Embed query ───────────────────────────────────────────────
		let queryVector: number[];
		try {
			queryVector = await this.embeddingsClient.embedOne(queryText);
		} catch (err) {
			// Cannot search without a query vector
			report(`CloudAwareSearch: embedding failed: ${String(err)}`);
			return [];
		}

		// ── Step 4: Parallel cloud + overlay search ───────────────────────────
		// We request limit * 2 from each source so the merger has enough
		// candidates to fill the final limit after filtering dirty paths.
		const fetchLimit = limit * 2;

		const [cloudResults, overlayResults] = await Promise.all([
			// Cloud search (with graceful degradation)
			(async () => {
				try {
					return await this.cloudClient.search({
						repoSlug: this.repoSlug,
						commitSha: this.commitSha,
						queryText,
						queryVector,
						limit: fetchLimit,
						language: options.language,
						chunkType: options.chunkType,
					});
				} catch (err) {
					report(
						`CloudAwareSearch: cloud search failed (offline?): ${String(err)}`,
					);
					return [];
				}
			})(),
			// Overlay search (with graceful degradation)
			(async (): Promise<SearchResult[]> => {
				try {
					return await this.overlayIndex.search(
						queryVector,
						queryText,
						fetchLimit,
					);
				} catch (err) {
					report(`CloudAwareSearch: overlay search failed: ${String(err)}`);
					return [];
				}
			})(),
		]);

		// ── Step 5: Merge results ─────────────────────────────────────────────
		return OverlayMerger.merge(
			cloudResults,
			overlayResults,
			dirtyFilePaths,
			limit,
		);
	}
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a CloudAwareSearch instance.
 */
export function createCloudAwareSearch(
	options: CloudSearchOptions,
): CloudAwareSearch {
	return new CloudAwareSearch(options);
}
