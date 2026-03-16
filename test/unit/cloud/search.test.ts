/**
 * Unit tests for CloudAwareSearch
 *
 * Uses stub implementations for cloud client, overlay index, change detector,
 * and embeddings client. No I/O, no LanceDB, no HTTP.
 *
 * Tests cover:
 *  - Returns merged results from cloud + overlay
 *  - Rebuilds stale overlay before searching
 *  - Handles cloud offline gracefully (returns overlay-only results)
 *  - Handles overlay failure gracefully (returns cloud-only results)
 *  - Handles dirty files failure gracefully (treats as no dirty files)
 *  - Respects limit
 */

import { describe, test, expect, beforeEach } from "bun:test";
import type {
	ICloudIndexClient,
	IOverlayIndex,
	IChangeDetector,
	ChangedFile,
	DirtyFile,
	CloudSearchResult,
	CloudSearchRequest,
	ChunkCheckResult,
	UploadIndexRequest,
	UploadIndexResponse,
	CommitStatus,
	RegisterRepoRequest,
	RegisterRepoResponse,
	CloudSymbol,
	CloudCallerResult,
	CloudCalleeResult,
} from "../../../src/cloud/types.js";
import type {
	SearchResult,
	IEmbeddingsClient,
	EmbedResult,
} from "../../../src/types.js";
import {
	CloudAwareSearch,
	createCloudAwareSearch,
} from "../../../src/cloud/search.js";

// ============================================================================
// Stub helpers
// ============================================================================

function makeCloudResult(filePath: string, score = 0.8): CloudSearchResult {
	return {
		contentHash: `hash-${filePath}`,
		filePath,
		startLine: 1,
		endLine: 10,
		language: "typescript",
		chunkType: "function",
		name: "testFn",
		score,
	};
}

function makeOverlayResult(filePath: string, score = 0.7): SearchResult {
	return {
		chunk: {
			id: `id-${filePath}`,
			contentHash: `ch-${filePath}`,
			content: "function foo() {}",
			filePath,
			startLine: 1,
			endLine: 5,
			language: "typescript",
			chunkType: "function",
			name: "foo",
			fileHash: "fh",
		},
		score,
		vectorScore: score,
		keywordScore: 0,
	};
}

// ── Mock IChangeDetector ──────────────────────────────────────────────────────

class MockChangeDetector implements IChangeDetector {
	dirtyFiles: DirtyFile[];
	shouldThrow = false;

	constructor(dirtyFiles: DirtyFile[] = []) {
		this.dirtyFiles = dirtyFiles;
	}

	async getDirtyFiles(): Promise<DirtyFile[]> {
		if (this.shouldThrow) throw new Error("git error");
		return this.dirtyFiles;
	}

	async getHeadSha(): Promise<string> {
		return "abc123";
	}

	async getParentShas(_sha: string): Promise<string[]> {
		return [];
	}

	async getChangedFiles(
		_from: string | null,
		_to: string,
	): Promise<ChangedFile[]> {
		return [];
	}
}

// ── Mock IOverlayIndex ────────────────────────────────────────────────────────

class MockOverlayIndex implements IOverlayIndex {
	stale = true;
	results: SearchResult[] = [];
	rebuildCalled = false;
	shouldThrowOnSearch = false;
	shouldThrowOnRebuild = false;

	async isStale(_dirtyFiles: DirtyFile[]): Promise<boolean> {
		return this.stale;
	}

	async rebuild(
		_dirtyFiles: DirtyFile[],
		_onProgress?: (msg: string) => void,
	): Promise<void> {
		if (this.shouldThrowOnRebuild) throw new Error("rebuild failed");
		this.rebuildCalled = true;
		this.stale = false;
	}

	async search(
		_queryVector: number[],
		_queryText: string,
		_limit?: number,
	): Promise<SearchResult[]> {
		if (this.shouldThrowOnSearch) throw new Error("overlay search failed");
		return this.results;
	}

	async getStats(): Promise<{ chunkCount: number; fileCount: number }> {
		return { chunkCount: this.results.length, fileCount: 1 };
	}

	async invalidate(): Promise<void> {
		this.stale = true;
	}

	async close(): Promise<void> {}
}

// ── Mock ICloudIndexClient ────────────────────────────────────────────────────

class MockCloudClient implements ICloudIndexClient {
	results: CloudSearchResult[] = [];
	shouldThrow = false;

	async search(_req: CloudSearchRequest): Promise<CloudSearchResult[]> {
		if (this.shouldThrow) throw new Error("network error");
		return this.results;
	}

	async checkChunks(
		_repoSlug: string,
		_hashes: string[],
	): Promise<ChunkCheckResult> {
		return { existing: [], missing: _hashes };
	}

	async uploadIndex(_req: UploadIndexRequest): Promise<UploadIndexResponse> {
		return { ok: true, chunksAdded: 0, chunksDeduplicated: 0, status: "ready" };
	}

	async getCommitStatus(
		_repoSlug: string,
		_commitSha: string,
	): Promise<CommitStatus> {
		return { commitSha: _commitSha, status: "not_found" };
	}

	async waitForCommit(
		_repoSlug: string,
		_commitSha: string,
	): Promise<CommitStatus> {
		return { commitSha: _commitSha, status: "ready" };
	}

	async registerRepo(_req: RegisterRepoRequest): Promise<RegisterRepoResponse> {
		return { ok: true, created: true, repoSlug: _req.repoSlug };
	}

	async getSymbol(
		_repoSlug: string,
		_sha: string,
		_name: string,
	): Promise<CloudSymbol[]> {
		return [];
	}

	async getCallers(
		_repoSlug: string,
		_sha: string,
		name: string,
	): Promise<CloudCallerResult> {
		return { symbolName: name, callers: [] };
	}

	async getCallees(
		_repoSlug: string,
		_sha: string,
		name: string,
	): Promise<CloudCalleeResult> {
		return { symbolName: name, callees: [] };
	}

	async getMap(_repoSlug: string, _sha: string): Promise<string> {
		return "";
	}
}

// ── Mock IEmbeddingsClient ────────────────────────────────────────────────────

class MockEmbeddingsClient implements IEmbeddingsClient {
	private readonly dim: number;
	shouldThrow = false;

	constructor(dim = 4) {
		this.dim = dim;
	}

	async embed(texts: string[]): Promise<EmbedResult> {
		return {
			embeddings: texts.map(() =>
				Array.from({ length: this.dim }, (_, i) => i * 0.1),
			),
		};
	}

	async embedOne(_text: string): Promise<number[]> {
		if (this.shouldThrow) throw new Error("embedding failed");
		return Array.from({ length: this.dim }, (_, i) => i * 0.1);
	}

	getModel(): string {
		return "mock-model";
	}

	getDimension(): number | undefined {
		return this.dim;
	}

	getProvider() {
		return "local" as const;
	}

	isLocal(): boolean {
		return true;
	}
}

// ============================================================================
// Setup
// ============================================================================

const PROJECT_PATH = "/project";
const REPO_SLUG = "acme/my-repo";
const COMMIT_SHA = "abc123def456abc123def456abc123def456abc1";

let changeDetector: MockChangeDetector;
let overlayIndex: MockOverlayIndex;
let cloudClient: MockCloudClient;
let embeddingsClient: MockEmbeddingsClient;

beforeEach(() => {
	changeDetector = new MockChangeDetector();
	overlayIndex = new MockOverlayIndex();
	cloudClient = new MockCloudClient();
	embeddingsClient = new MockEmbeddingsClient();
});

function makeSearch(): CloudAwareSearch {
	return new CloudAwareSearch({
		projectPath: PROJECT_PATH,
		cloudClient,
		overlayIndex,
		changeDetector,
		embeddingsClient,
		repoSlug: REPO_SLUG,
		commitSha: COMMIT_SHA,
	});
}

// ============================================================================
// Factory
// ============================================================================

describe("createCloudAwareSearch", () => {
	test("returns a CloudAwareSearch instance", () => {
		const s = createCloudAwareSearch({
			projectPath: PROJECT_PATH,
			cloudClient,
			overlayIndex,
			changeDetector,
			embeddingsClient,
			repoSlug: REPO_SLUG,
			commitSha: COMMIT_SHA,
		});
		expect(s).toBeInstanceOf(CloudAwareSearch);
	});
});

// ============================================================================
// Basic search
// ============================================================================

describe("CloudAwareSearch.search — basic flow", () => {
	test("returns merged results from cloud and overlay", async () => {
		cloudClient.results = [makeCloudResult("src/a.ts", 0.9)];
		overlayIndex.results = [makeOverlayResult("src/dirty.ts", 0.8)];
		overlayIndex.stale = false; // No rebuild needed

		const search = makeSearch();
		const results = await search.search("foo");

		expect(results.length).toBeGreaterThan(0);
		const sources = results.map((r) => r.source);
		expect(sources).toContain("cloud");
		expect(sources).toContain("overlay");
	});

	test("returns empty array when no results from either source", async () => {
		overlayIndex.stale = false;

		const search = makeSearch();
		const results = await search.search("nonexistent");

		expect(results).toHaveLength(0);
	});

	test("respects limit option", async () => {
		cloudClient.results = Array.from({ length: 10 }, (_, i) =>
			makeCloudResult(`src/file${i}.ts`, 0.9 - i * 0.05),
		);
		overlayIndex.stale = false;

		const search = makeSearch();
		const results = await search.search("foo", { limit: 3 });

		expect(results.length).toBeLessThanOrEqual(3);
	});

	test("result has source field set correctly", async () => {
		cloudClient.results = [makeCloudResult("src/committed.ts", 0.9)];
		overlayIndex.stale = false;

		const search = makeSearch();
		const results = await search.search("foo");

		const cloudResult = results.find(
			(r) => r.chunk.filePath === "src/committed.ts",
		);
		expect(cloudResult?.source).toBe("cloud");
	});
});

// ============================================================================
// Overlay rebuild
// ============================================================================

describe("CloudAwareSearch.search — overlay rebuild", () => {
	test("rebuilds stale overlay before searching", async () => {
		overlayIndex.stale = true;
		changeDetector.dirtyFiles = [
			{ filePath: "src/dirty.ts", status: "modified" },
		];

		const search = makeSearch();
		await search.search("foo");

		expect(overlayIndex.rebuildCalled).toBe(true);
	});

	test("does not rebuild if overlay is fresh", async () => {
		overlayIndex.stale = false;

		const search = makeSearch();
		await search.search("foo");

		expect(overlayIndex.rebuildCalled).toBe(false);
	});

	test("passes dirty files to rebuild", async () => {
		let rebuiltWith: DirtyFile[] | null = null;
		overlayIndex.rebuild = async (files) => {
			rebuiltWith = files;
			overlayIndex.stale = false;
		};
		overlayIndex.stale = true;
		changeDetector.dirtyFiles = [
			{ filePath: "src/a.ts", status: "modified" },
			{ filePath: "src/b.ts", status: "untracked" },
		];

		const search = makeSearch();
		await search.search("foo");

		expect(rebuiltWith).toHaveLength(2);
	});
});

// ============================================================================
// Cloud offline / error handling
// ============================================================================

describe("CloudAwareSearch.search — cloud offline", () => {
	test("returns overlay-only results when cloud throws", async () => {
		cloudClient.shouldThrow = true;
		overlayIndex.results = [makeOverlayResult("src/dirty.ts", 0.8)];
		overlayIndex.stale = false;

		const search = makeSearch();
		const results = await search.search("foo");

		// Should have at least the overlay result
		expect(results.length).toBeGreaterThan(0);
		for (const r of results) {
			expect(r.source).toBe("overlay");
		}
	});

	test("never throws even when cloud and overlay both fail", async () => {
		cloudClient.shouldThrow = true;
		overlayIndex.shouldThrowOnSearch = true;
		overlayIndex.stale = false;

		const search = makeSearch();
		const results = await search.search("foo");

		// Should return empty (not throw)
		expect(Array.isArray(results)).toBe(true);
	});

	test("returns cloud-only results when overlay search fails", async () => {
		cloudClient.results = [makeCloudResult("src/a.ts", 0.9)];
		overlayIndex.shouldThrowOnSearch = true;
		overlayIndex.stale = false;

		const search = makeSearch();
		const results = await search.search("foo");

		expect(results.length).toBeGreaterThan(0);
		for (const r of results) {
			expect(r.source).toBe("cloud");
		}
	});
});

// ============================================================================
// Dirty files failure
// ============================================================================

describe("CloudAwareSearch.search — dirty files failure", () => {
	test("treats as no dirty files when getDirtyFiles throws", async () => {
		changeDetector.shouldThrow = true;
		cloudClient.results = [makeCloudResult("src/a.ts", 0.9)];
		overlayIndex.stale = true; // Will try to rebuild with []

		const search = makeSearch();
		// Should not throw
		const results = await search.search("foo");

		expect(Array.isArray(results)).toBe(true);
	});
});

// ============================================================================
// Embedding failure
// ============================================================================

describe("CloudAwareSearch.search — embedding failure", () => {
	test("returns empty array when embedding fails", async () => {
		embeddingsClient.shouldThrow = true;
		overlayIndex.stale = false;

		const search = makeSearch();
		const results = await search.search("foo");

		expect(results).toHaveLength(0);
	});
});

// ============================================================================
// Dirty file suppression in merged results
// ============================================================================

describe("CloudAwareSearch.search — dirty file suppression", () => {
	test("does not include cloud results for dirty files", async () => {
		changeDetector.dirtyFiles = [
			{ filePath: "src/dirty.ts", status: "modified" },
		];
		cloudClient.results = [
			makeCloudResult("src/dirty.ts", 0.95),
			makeCloudResult("src/clean.ts", 0.7),
		];
		overlayIndex.results = [makeOverlayResult("src/dirty.ts", 0.9)];
		overlayIndex.stale = false;

		const search = makeSearch();
		const results = await search.search("foo");

		// No cloud result for the dirty file
		const cloudDirty = results.find(
			(r) => r.source === "cloud" && r.chunk.filePath === "src/dirty.ts",
		);
		expect(cloudDirty).toBeUndefined();

		// Overlay result for the dirty file should be present
		const overlayDirty = results.find(
			(r) => r.source === "overlay" && r.chunk.filePath === "src/dirty.ts",
		);
		expect(overlayDirty).toBeDefined();
	});
});

// ============================================================================
// Progress callback
// ============================================================================

describe("CloudAwareSearch.search — progress callback", () => {
	test("invokes onProgress callback at least once during search", async () => {
		overlayIndex.stale = true;
		changeDetector.dirtyFiles = [{ filePath: "src/a.ts", status: "modified" }];

		const messages: string[] = [];
		const search = makeSearch();
		await search.search("foo", { onProgress: (msg) => messages.push(msg) });

		// Overlay rebuild produces progress messages
		expect(messages.length).toBeGreaterThan(0);
	});
});
