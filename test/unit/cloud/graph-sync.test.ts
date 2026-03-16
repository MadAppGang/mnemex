/**
 * Unit tests for GraphSyncer
 *
 * Tests the GraphSyncer against LocalCloudStub (no real HTTP) and a
 * minimal in-memory IFileTracker. Verifies that:
 *  - syncGraph() downloads symbols and references from the cloud
 *  - The repo map is cached in local FileTracker metadata
 *  - Counts are reported correctly in GraphSyncResult
 *  - Missing commits return zero counts without throwing
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { LocalCloudStub } from "../../../src/cloud/stub.js";
import {
	GraphSyncer,
	createGraphSyncer,
} from "../../../src/cloud/graph-sync.js";
import type { GraphSyncOptions } from "../../../src/cloud/graph-sync.js";
import type { IFileTracker } from "../../../src/core/tracker.js";
import type {
	UploadIndexRequest,
	UploadChunk,
} from "../../../src/cloud/types.js";

// ============================================================================
// Fixtures
// ============================================================================

const PROJECT_PATH = "/project";
const REPO = "acme-corp/my-repo";
const COMMIT_SHA = "aaaa1111bbbb2222cccc3333dddd4444eeee5555";
const MISSING_SHA = "ffff0000ffff0000ffff0000ffff0000ffff0000";

function makeChunk(overrides: Partial<UploadChunk> = {}): UploadChunk {
	return {
		contentHash: "hash-" + Math.random().toString(36).slice(2),
		filePath: "src/index.ts",
		startLine: 1,
		endLine: 10,
		language: "typescript",
		chunkType: "function",
		name: "myFunction",
		text: "function myFunction() { return 42; }",
		...overrides,
	};
}

function makeUploadRequest(
	chunks: UploadChunk[],
	overrides: Partial<UploadIndexRequest> = {},
): UploadIndexRequest {
	return {
		orgSlug: "acme-corp",
		repoSlug: REPO,
		commitSha: COMMIT_SHA,
		parentShas: [],
		chunks,
		mode: "thin",
		...overrides,
	};
}

// ============================================================================
// Minimal in-memory IFileTracker
// ============================================================================

class InMemoryFileTracker implements IFileTracker {
	private metadata = new Map<string, string>();

	getChanges(_currentFiles: string[]) {
		return { added: [], modified: [], deleted: [], unchanged: [] };
	}
	markIndexed(_filePath: string, _contentHash: string, _chunkIds: string[]) {}
	getChunkIds(_filePath: string): string[] {
		return [];
	}
	removeFile(_filePath: string) {}
	getFileState(_filePath: string) {
		return null;
	}
	getAllFiles() {
		return [];
	}
	getMetadata(key: string): string | null {
		return this.metadata.get(key) ?? null;
	}
	setMetadata(key: string, value: string): void {
		this.metadata.set(key, value);
	}
	getStats() {
		return { totalFiles: 0, lastIndexed: null };
	}
	clear() {
		this.metadata.clear();
	}
	recordActivity(_type: string, _metadata: Record<string, unknown>): number {
		return 0;
	}
	needsEnrichment(_filePath: string, _documentType: string): boolean {
		return false;
	}
	setEnrichmentState(
		_filePath: string,
		_documentType: string,
		_state: string,
	): void {}
	getFilesNeedingEnrichment(_documentType: string): string[] {
		return [];
	}
	trackDocuments(_docs: unknown[]): void {}
}

// ============================================================================
// Setup
// ============================================================================

let stub: LocalCloudStub;
let fileTracker: InMemoryFileTracker;

beforeEach(() => {
	stub = new LocalCloudStub();
	fileTracker = new InMemoryFileTracker();
});

function makeSyncer(overrides: Partial<GraphSyncOptions> = {}): GraphSyncer {
	return new GraphSyncer({
		projectPath: PROJECT_PATH,
		cloudClient: stub,
		repoSlug: REPO,
		commitSha: COMMIT_SHA,
		fileTracker,
		...overrides,
	});
}

// ============================================================================
// Factory
// ============================================================================

describe("createGraphSyncer", () => {
	test("returns a GraphSyncer instance", () => {
		const syncer = createGraphSyncer({
			projectPath: PROJECT_PATH,
			cloudClient: stub,
			repoSlug: REPO,
			commitSha: COMMIT_SHA,
			fileTracker,
		});
		expect(syncer).toBeInstanceOf(GraphSyncer);
	});
});

// ============================================================================
// syncGraph — no indexed commit
// ============================================================================

describe("GraphSyncer — missing commit", () => {
	test("returns zero counts when commit is not indexed", async () => {
		const syncer = makeSyncer({ commitSha: MISSING_SHA });
		const result = await syncer.syncGraph();

		expect(result.symbolCount).toBe(0);
		expect(result.referenceCount).toBe(0);
		expect(result.durationMs).toBeGreaterThanOrEqual(0);
	});

	test("does not cache repo map when commit is missing", async () => {
		const syncer = makeSyncer({ commitSha: MISSING_SHA });
		await syncer.syncGraph();

		// No map should be cached (empty string is falsy)
		const cached = fileTracker.getMetadata("cloudRepoMap");
		expect(cached).toBeNull();
	});
});

// ============================================================================
// syncGraph — with indexed commit
// ============================================================================

describe("GraphSyncer — indexed commit", () => {
	beforeEach(async () => {
		// Pre-populate the stub with some chunks
		await stub.uploadIndex(
			makeUploadRequest([
				makeChunk({
					contentHash: "hash-a",
					name: "funcA",
					filePath: "src/a.ts",
				}),
				makeChunk({
					contentHash: "hash-b",
					name: "funcB",
					filePath: "src/b.ts",
				}),
			]),
		);
	});

	test("returns correct symbolCount from stub", async () => {
		const syncer = makeSyncer();
		const result = await syncer.syncGraph();

		// Two named chunks uploaded → two symbols in graph
		expect(result.symbolCount).toBe(2);
	});

	test("referenceCount is zero (stub returns no references)", async () => {
		const syncer = makeSyncer();
		const result = await syncer.syncGraph();

		expect(result.referenceCount).toBe(0);
	});

	test("caches repo map in FileTracker metadata", async () => {
		const syncer = makeSyncer();
		await syncer.syncGraph();

		const cached = fileTracker.getMetadata("cloudRepoMap");
		expect(cached).not.toBeNull();
		expect(cached).toContain(REPO);
		expect(cached).toContain(COMMIT_SHA.slice(0, 8));
	});

	test("caches commit SHA in FileTracker metadata", async () => {
		const syncer = makeSyncer();
		await syncer.syncGraph();

		const cachedCommit = fileTracker.getMetadata("cloudRepoMapCommit");
		expect(cachedCommit).toBe(COMMIT_SHA);
	});

	test("durationMs is non-negative", async () => {
		const syncer = makeSyncer();
		const result = await syncer.syncGraph();

		expect(result.durationMs).toBeGreaterThanOrEqual(0);
	});
});

// ============================================================================
// getGraph on LocalCloudStub
// ============================================================================

describe("LocalCloudStub.getGraph", () => {
	test("returns empty result for missing commit", async () => {
		const result = await stub.getGraph(REPO, MISSING_SHA);

		expect(result.symbols).toHaveLength(0);
		expect(result.references).toHaveLength(0);
		expect(result.repoMap).toBe("");
	});

	test("returns symbols for indexed commit", async () => {
		await stub.uploadIndex(
			makeUploadRequest([
				makeChunk({
					contentHash: "hash-x",
					name: "Widget",
					filePath: "src/widget.ts",
				}),
			]),
		);

		const result = await stub.getGraph(REPO, COMMIT_SHA);
		expect(result.symbols.length).toBeGreaterThan(0);
		expect(result.symbols[0].name).toBe("Widget");
	});

	test("repoMap contains expected structure", async () => {
		await stub.uploadIndex(
			makeUploadRequest([
				makeChunk({
					contentHash: "hash-y",
					name: "doThing",
					filePath: "src/thing.ts",
				}),
			]),
		);

		const result = await stub.getGraph(REPO, COMMIT_SHA);
		expect(result.repoMap).toContain("doThing");
		expect(result.repoMap).toContain("src/thing.ts");
	});
});

// ============================================================================
// Progress callback
// ============================================================================

describe("GraphSyncer — progress callback", () => {
	test("calls onProgress during sync", async () => {
		await stub.uploadIndex(makeUploadRequest([makeChunk()]));

		const messages: string[] = [];
		const syncer = makeSyncer({
			onProgress: (msg) => messages.push(msg),
		});

		await syncer.syncGraph();

		expect(messages.length).toBeGreaterThan(0);
		// First message should mention the repo/commit
		expect(messages[0]).toContain(REPO);
	});
});
