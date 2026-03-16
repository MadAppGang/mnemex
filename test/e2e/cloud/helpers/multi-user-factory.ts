/**
 * Multi-user factory helpers for E2E tests.
 *
 * Shared utilities for creating test fixtures, synthetic vectors,
 * fake SHAs/hashes, and the registerAndIndex helper that wraps
 * the three-step register → upload → assert-ready pattern.
 */

import { createThinCloudClient } from "../../../../src/cloud/thin-client.js";
import type {
	UploadChunk,
	UploadIndexResponse,
} from "../../../../src/cloud/types.js";
import type { MergedSearchResult } from "../../../../src/cloud/merger.js";
import type { CloudSearchResult } from "../../../../src/cloud/types.js";

// ============================================================================
// Constants
// ============================================================================

export const ORG_SLUG = "test-org";
export const BARE_REPO_SLUG = "e2e-multi-user-repo";
export const REPO_SLUG = `${ORG_SLUG}/${BARE_REPO_SLUG}`;

// ============================================================================
// Vector / SHA / Hash helpers
// ============================================================================

/**
 * Generate a deterministic 8-dimensional unit vector using sin-based seeding.
 * Same algorithm as thin-mode.test.ts syntheticVector() for consistency.
 */
export function syntheticVector(seed: number): number[] {
	const v = Array.from({ length: 8 }, (_, i) => Math.sin(seed * 1.7 + i * 0.5));
	const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
	return v.map((x) => x / norm);
}

/** Generate a fake 40-char hex SHA from a number */
export function fakeSha(n: number): string {
	return n.toString(16).padStart(40, "0");
}

/** Generate a fake content hash from a number */
export function fakeHash(n: number): string {
	return `hash_${n.toString(16).padStart(62, "0")}`;
}

// ============================================================================
// Chunk factory
// ============================================================================

/**
 * Build UploadChunk[] with distinct filePaths.
 *
 * @param count Number of chunks to create
 * @param seed  Base seed for vector/hash generation
 * @param fileNames Optional array of file path strings. When provided, each
 *   chunk uses fileNames[i % fileNames.length] as its filePath. When omitted,
 *   paths default to `src/file_${i}.ts`.
 */
export function makeChunks(
	count: number,
	seed: number,
	fileNames?: string[],
): UploadChunk[] {
	return Array.from({ length: count }, (_, i) => ({
		contentHash: fakeHash(seed + i),
		filePath: fileNames
			? (fileNames[i % fileNames.length] as string)
			: `src/file_${i}.ts`,
		startLine: i * 10 + 1,
		endLine: i * 10 + 10,
		language: "typescript",
		chunkType: "function",
		name: `fn_${seed + i}`,
		vector: syntheticVector(seed + i),
	}));
}

// ============================================================================
// registerAndIndex
// ============================================================================

/**
 * Register the shared repo (idempotent) and upload a commit's index.
 *
 * Wraps the three-step pattern:
 *   1. client.registerRepo()
 *   2. client.uploadIndex()
 *   3. return the UploadIndexResponse
 *
 * @param endpoint   The test server base URL
 * @param commitSha  The commit SHA to index
 * @param parentShas Parent commit SHA(s) for incremental inheritance
 * @param chunks     The chunks to upload
 */
export async function registerAndIndex(
	endpoint: string,
	commitSha: string,
	parentShas: string[],
	chunks: UploadChunk[],
): Promise<UploadIndexResponse> {
	const client = createThinCloudClient({ endpoint, token: "dummy" });

	await client.registerRepo({
		orgSlug: ORG_SLUG,
		repoSlug: BARE_REPO_SLUG,
	});

	return client.uploadIndex({
		orgSlug: ORG_SLUG,
		repoSlug: BARE_REPO_SLUG,
		commitSha,
		parentShas,
		chunks,
		mode: "thin",
	});
}

// ============================================================================
// cloudToMerged
// ============================================================================

/**
 * Wrap CloudSearchResult[] as MergedSearchResult[] with source: "cloud".
 *
 * Used by Scenarios 1, 3, 4 which call client.search() directly (returning
 * CloudSearchResult[]) and then pass results to TraceCollector.
 */
export function cloudToMerged(
	cloudResults: CloudSearchResult[],
): MergedSearchResult[] {
	return cloudResults.map((r) => ({
		chunk: {
			id: r.contentHash,
			contentHash: r.contentHash,
			content: "",
			filePath: r.filePath,
			startLine: r.startLine,
			endLine: r.endLine,
			language: r.language,
			chunkType: r.chunkType as import("../../../../src/types.js").ChunkType,
			name: r.name,
			fileHash: "",
		},
		score: r.score,
		vectorScore: r.score,
		keywordScore: 0,
		summary: r.summary,
		source: "cloud",
	}));
}
