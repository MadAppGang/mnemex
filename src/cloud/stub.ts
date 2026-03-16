/**
 * LocalCloudStub — in-memory ICloudIndexClient for testing
 *
 * Provides a complete, dependency-free implementation of ICloudIndexClient
 * backed by Maps and Sets. Use this in unit tests and integration tests
 * wherever a real HTTP cloud client would be needed.
 *
 * Key behaviours:
 * - checkChunks: returns previously uploaded hashes as "existing"
 * - uploadIndex: stores chunks by content hash, records commit mappings
 * - getCommitStatus: returns "ready" for uploaded commits, "not_found" otherwise
 * - waitForCommit: resolves immediately for ready commits
 * - search: naive text-contains match against stored chunk text/name
 * - all other methods return sensible empty defaults
 */

import type {
	ICloudIndexClient,
	ChunkCheckResult,
	CloudCallerResult,
	CloudCalleeResult,
	CloudGraphResult,
	CloudSearchRequest,
	CloudSearchResult,
	CloudSymbol,
	CommitStatus,
	RegisterRepoRequest,
	RegisterRepoResponse,
	UploadChunk,
	UploadIndexRequest,
	UploadIndexResponse,
} from "./types.js";

// ============================================================================
// Internal storage structures
// ============================================================================

interface StoredChunk extends UploadChunk {
	/** When this chunk was first stored (ISO 8601) */
	storedAt: string;
}

interface CommitRecord {
	commitSha: string;
	repoSlug: string;
	parentShas: string[];
	/** Content hashes of all chunks associated with this commit */
	chunkHashes: Set<string>;
	/** Paths of files deleted with this commit */
	deletedFiles: string[];
	indexedAt: string;
}

interface RepoRecord {
	repoSlug: string;
	orgSlug: string;
	displayName?: string;
	remoteUrl?: string;
	mode: "thin" | "smart";
}

// ============================================================================
// LocalCloudStub
// ============================================================================

export class LocalCloudStub implements ICloudIndexClient {
	/** All chunks ever uploaded, keyed by content hash */
	private readonly chunks = new Map<string, StoredChunk>();

	/** Commit records, keyed by `${repoSlug}::${commitSha}` */
	private readonly commits = new Map<string, CommitRecord>();

	/** Registered repos, keyed by `${orgSlug}::${repoSlug}` */
	private readonly repos = new Map<string, RepoRecord>();

	// --------------------------------------------------------------------------
	// ICloudIndexClient
	// --------------------------------------------------------------------------

	async checkChunks(
		_repoSlug: string,
		hashes: string[],
		_commitSha?: string,
	): Promise<ChunkCheckResult> {
		const existing: string[] = [];
		const missing: string[] = [];

		for (const hash of hashes) {
			if (this.chunks.has(hash)) {
				existing.push(hash);
			} else {
				missing.push(hash);
			}
		}

		return { existing, missing };
	}

	async uploadIndex(request: UploadIndexRequest): Promise<UploadIndexResponse> {
		const key = this.commitKey(request.repoSlug, request.commitSha);
		let chunksAdded = 0;
		let chunksDeduplicated = 0;

		const chunkHashes = new Set<string>();

		for (const chunk of request.chunks) {
			if (this.chunks.has(chunk.contentHash)) {
				chunksDeduplicated++;
			} else {
				this.chunks.set(chunk.contentHash, {
					...chunk,
					storedAt: new Date().toISOString(),
				});
				chunksAdded++;
			}
			chunkHashes.add(chunk.contentHash);
		}

		this.commits.set(key, {
			commitSha: request.commitSha,
			repoSlug: request.repoSlug,
			parentShas: request.parentShas,
			chunkHashes,
			deletedFiles: request.deletedFiles ?? [],
			indexedAt: new Date().toISOString(),
		});

		return {
			ok: true,
			chunksAdded,
			chunksDeduplicated,
			status: "ready",
		};
	}

	async getCommitStatus(
		repoSlug: string,
		commitSha: string,
	): Promise<CommitStatus> {
		const key = this.commitKey(repoSlug, commitSha);
		const record = this.commits.get(key);

		if (!record) {
			return { commitSha, status: "not_found" };
		}

		return {
			commitSha,
			status: "ready",
			indexedAt: record.indexedAt,
			chunkCount: record.chunkHashes.size,
		};
	}

	async waitForCommit(
		repoSlug: string,
		commitSha: string,
		_timeoutMs?: number,
	): Promise<CommitStatus> {
		// In the stub, commits are synchronously "ready" after upload
		return this.getCommitStatus(repoSlug, commitSha);
	}

	async search(request: CloudSearchRequest): Promise<CloudSearchResult[]> {
		const key = this.commitKey(request.repoSlug, request.commitSha);
		const record = this.commits.get(key);

		if (!record) {
			return [];
		}

		const query = request.queryText.toLowerCase();
		const limit = request.limit ?? 10;
		const results: CloudSearchResult[] = [];

		for (const hash of record.chunkHashes) {
			const chunk = this.chunks.get(hash);
			if (!chunk) continue;

			// Filter by language if specified
			if (request.language && chunk.language !== request.language) continue;

			// Filter by chunk type if specified
			if (request.chunkType && chunk.chunkType !== request.chunkType) continue;

			// Naive text match — check name, summary, and text fields
			const searchTarget = [
				chunk.name ?? "",
				chunk.summary ?? "",
				chunk.text ?? "",
			]
				.join(" ")
				.toLowerCase();

			if (query && !searchTarget.includes(query)) continue;

			// Score: 1.0 if name matches exactly, 0.5 for partial text match
			let score = 0.5;
			if (chunk.name?.toLowerCase() === query) {
				score = 1.0;
			} else if (chunk.name?.toLowerCase().includes(query)) {
				score = 0.8;
			}

			results.push({
				contentHash: chunk.contentHash,
				filePath: chunk.filePath,
				startLine: chunk.startLine,
				endLine: chunk.endLine,
				language: chunk.language,
				chunkType: chunk.chunkType,
				name: chunk.name,
				score,
				summary: chunk.summary,
			});

			if (results.length >= limit) break;
		}

		// Sort by score descending
		results.sort((a, b) => b.score - a.score);
		return results;
	}

	async registerRepo(
		request: RegisterRepoRequest,
	): Promise<RegisterRepoResponse> {
		const key = `${request.orgSlug}::${request.repoSlug}`;
		const existed = this.repos.has(key);

		this.repos.set(key, {
			repoSlug: request.repoSlug,
			orgSlug: request.orgSlug,
			displayName: request.displayName,
			remoteUrl: request.remoteUrl,
			mode: request.mode ?? "thin",
		});

		return {
			ok: true,
			created: !existed,
			repoSlug: request.repoSlug,
		};
	}

	async getSymbol(
		repoSlug: string,
		commitSha: string,
		name: string,
	): Promise<CloudSymbol[]> {
		const key = this.commitKey(repoSlug, commitSha);
		const record = this.commits.get(key);
		if (!record) return [];

		const results: CloudSymbol[] = [];
		const queryName = name.toLowerCase();

		for (const hash of record.chunkHashes) {
			const chunk = this.chunks.get(hash);
			if (!chunk?.name) continue;
			if (!chunk.name.toLowerCase().includes(queryName)) continue;

			results.push({
				name: chunk.name,
				kind: chunk.chunkType,
				filePath: chunk.filePath,
				startLine: chunk.startLine,
				endLine: chunk.endLine,
				pagerankScore: 0,
			});
		}

		return results;
	}

	async getCallers(
		repoSlug: string,
		commitSha: string,
		_name: string,
	): Promise<CloudCallerResult> {
		// Stub returns empty callers — symbol graph not tracked in-memory
		const key = this.commitKey(repoSlug, commitSha);
		const exists = this.commits.has(key);

		return {
			symbolName: _name,
			callers: exists ? [] : [],
		};
	}

	async getCallees(
		repoSlug: string,
		commitSha: string,
		_name: string,
	): Promise<CloudCalleeResult> {
		// Stub returns empty callees — symbol graph not tracked in-memory
		const key = this.commitKey(repoSlug, commitSha);
		const exists = this.commits.has(key);

		return {
			symbolName: _name,
			callees: exists ? [] : [],
		};
	}

	async getGraph(
		repoSlug: string,
		commitSha: string,
	): Promise<CloudGraphResult> {
		const key = this.commitKey(repoSlug, commitSha);
		const record = this.commits.get(key);

		if (!record) {
			return { symbols: [], references: [], repoMap: "" };
		}

		// Build symbols from stored chunks
		const symbols: CloudGraphResult["symbols"] = [];
		for (const hash of record.chunkHashes) {
			const chunk = this.chunks.get(hash);
			if (!chunk?.name) continue;
			symbols.push({
				name: chunk.name,
				kind: chunk.chunkType,
				filePath: chunk.filePath,
				startLine: chunk.startLine,
				endLine: chunk.endLine,
				pagerankScore: 0,
			});
		}

		// Build repo map using the same logic as getMap
		const repoMap = await this.getMap(repoSlug, commitSha);

		return {
			symbols,
			references: [],
			repoMap,
		};
	}

	async getMap(
		repoSlug: string,
		commitSha: string,
		query?: string,
		_maxTokens?: number,
	): Promise<string> {
		const key = this.commitKey(repoSlug, commitSha);
		const record = this.commits.get(key);

		if (!record) {
			return `# No index found for ${repoSlug} @ ${commitSha.slice(0, 8)}\n`;
		}

		const lines: string[] = [
			`# Repo Map — ${repoSlug} @ ${commitSha.slice(0, 8)}`,
		];
		if (query) lines.push(`# Query: ${query}`);
		lines.push("");

		// Collect files from chunks
		const byFile = new Map<
			string,
			Array<{ name: string; kind: string; line: number }>
		>();
		for (const hash of record.chunkHashes) {
			const chunk = this.chunks.get(hash);
			if (!chunk?.name) continue;

			const entry = byFile.get(chunk.filePath) ?? [];
			entry.push({
				name: chunk.name,
				kind: chunk.chunkType,
				line: chunk.startLine,
			});
			byFile.set(chunk.filePath, entry);
		}

		for (const [filePath, symbols] of byFile) {
			lines.push(`file=${filePath}`);
			for (const sym of symbols) {
				lines.push(
					`  symbol name=${sym.name} kind=${sym.kind} line=${sym.line} rank=0.000`,
				);
			}
		}

		return lines.join("\n") + "\n";
	}

	// --------------------------------------------------------------------------
	// Test helpers (not part of ICloudIndexClient)
	// --------------------------------------------------------------------------

	/** Return all stored chunks (for assertions in tests) */
	getAllChunks(): StoredChunk[] {
		return Array.from(this.chunks.values());
	}

	/** Return the commit record for a specific commit (for assertions in tests) */
	getCommitRecord(
		repoSlug: string,
		commitSha: string,
	): CommitRecord | undefined {
		return this.commits.get(this.commitKey(repoSlug, commitSha));
	}

	/** Return all registered repos (for assertions in tests) */
	getAllRepos(): RepoRecord[] {
		return Array.from(this.repos.values());
	}

	/** Clear all stored data (useful between tests) */
	reset(): void {
		this.chunks.clear();
		this.commits.clear();
		this.repos.clear();
	}

	// --------------------------------------------------------------------------
	// Private helpers
	// --------------------------------------------------------------------------

	private commitKey(repoSlug: string, commitSha: string): string {
		return `${repoSlug}::${commitSha}`;
	}
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a new LocalCloudStub with empty state.
 */
export function createLocalCloudStub(): LocalCloudStub {
	return new LocalCloudStub();
}
