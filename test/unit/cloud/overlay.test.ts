/**
 * Unit tests for OverlayIndex
 *
 * Uses real LanceDB in a temporary directory (deleted after each test).
 * Mocks node:fs and the chunker to avoid needing real files or tree-sitter.
 *
 * Tests cover:
 *  - isStale with no fingerprint → true
 *  - isStale with matching fingerprint → false
 *  - rebuild creates chunks in LanceDB
 *  - search returns results for dirty files
 *  - invalidate makes isStale return true
 *  - close() releases resources
 */

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import {
	mkdtempSync,
	rmSync,
	writeFileSync,
	mkdirSync,
	existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DirtyFile } from "../../../src/cloud/types.js";
import type { EmbedResult } from "../../../src/types.js";

// ============================================================================
// Module mocks (must come before imports that use them)
// ============================================================================

// Mock parser manager to avoid loading WASM in unit tests
mock.module("../../../src/parsers/parser-manager.js", () => ({
	getParserManager: mock(() => ({
		initialize: mock(async () => {}),
		isSupported: mock(() => true),
		getLanguage: mock(() => "typescript"),
	})),
}));

// Mock chunker to return deterministic chunks without needing tree-sitter
mock.module("../../../src/core/chunker.js", () => ({
	chunkFileByPath: mock(
		async (source: string, filePath: string, fileHash: string) => [
			{
				id: `id-${fileHash.slice(0, 8)}`,
				contentHash: `ch-${fileHash.slice(0, 8)}`,
				content: source,
				filePath,
				startLine: 1,
				endLine: 3,
				language: "typescript",
				chunkType: "function",
				name: "myFn",
				fileHash,
			},
		],
	),
	canChunkFile: mock(() => true),
}));

// Import after mocking
const { OverlayIndex, createOverlayIndex } = await import(
	"../../../src/cloud/overlay.js"
);

// ============================================================================
// Helpers
// ============================================================================

/** Deterministic mock embeddings client */
class MockEmbeddingsClient {
	private readonly dim: number;

	constructor(dim = 4) {
		this.dim = dim;
	}

	async embed(texts: string[]): Promise<EmbedResult> {
		return {
			embeddings: texts.map((_, i) =>
				Array.from({ length: this.dim }, (__, j) => (i + 1) * 0.1 + j * 0.01),
			),
		};
	}

	async embedOne(_text: string): Promise<number[]> {
		return Array.from({ length: this.dim }, (_, i) => i * 0.01);
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

const DIRTY_FILE: DirtyFile = {
	filePath: "src/dirty.ts",
	status: "modified",
};

const UNTRACKED_FILE: DirtyFile = {
	filePath: "src/new.ts",
	status: "untracked",
};

const DELETED_FILE: DirtyFile = {
	filePath: "src/removed.ts",
	status: "deleted",
};

// ============================================================================
// Setup/teardown
// ============================================================================

let tmpDir: string;
let projectDir: string;
let overlayDir: string;
let embeddingsClient: MockEmbeddingsClient;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "mnemex-overlay-test-"));
	projectDir = join(tmpDir, "project");
	overlayDir = join(tmpDir, "overlay");

	mkdirSync(projectDir, { recursive: true });
	mkdirSync(join(projectDir, "src"), { recursive: true });
	mkdirSync(overlayDir, { recursive: true });

	// Write real files so statSync works
	writeFileSync(
		join(projectDir, "src/dirty.ts"),
		"function myFn() { return 1; }",
		"utf8",
	);
	writeFileSync(
		join(projectDir, "src/new.ts"),
		"function newFn() { return 2; }",
		"utf8",
	);

	embeddingsClient = new MockEmbeddingsClient();
});

afterEach(() => {
	if (existsSync(tmpDir)) {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

function makeOverlay(): InstanceType<typeof OverlayIndex> {
	return new OverlayIndex({
		projectPath: projectDir,
		overlayDir,
		embeddingsClient,
	});
}

// ============================================================================
// isStale
// ============================================================================

describe("OverlayIndex.isStale", () => {
	test("returns true when no fingerprint file exists", async () => {
		const overlay = makeOverlay();
		const stale = await overlay.isStale([DIRTY_FILE]);
		expect(stale).toBe(true);
		await overlay.close();
	});

	test("returns false when fingerprint matches current state", async () => {
		const overlay = makeOverlay();

		// Build creates the fingerprint
		await overlay.rebuild([DIRTY_FILE]);

		const stale = await overlay.isStale([DIRTY_FILE]);
		expect(stale).toBe(false);
		await overlay.close();
	});

	test("returns true when dirty file set changes", async () => {
		const overlay = makeOverlay();
		await overlay.rebuild([DIRTY_FILE]);

		// Now we add another dirty file
		const stale = await overlay.isStale([DIRTY_FILE, UNTRACKED_FILE]);
		expect(stale).toBe(true);
		await overlay.close();
	});

	test("returns true when dirty file set becomes empty", async () => {
		const overlay = makeOverlay();
		await overlay.rebuild([DIRTY_FILE]);

		// No dirty files now
		const stale = await overlay.isStale([]);
		expect(stale).toBe(true);
		await overlay.close();
	});

	test("returns true for empty dirty files with no fingerprint", async () => {
		const overlay = makeOverlay();
		const stale = await overlay.isStale([]);
		expect(stale).toBe(true);
		await overlay.close();
	});

	test("two separate instances agree on staleness", async () => {
		const o1 = makeOverlay();
		await o1.rebuild([DIRTY_FILE]);
		await o1.close();

		const o2 = makeOverlay();
		const stale = await o2.isStale([DIRTY_FILE]);
		expect(stale).toBe(false);
		await o2.close();
	});
});

// ============================================================================
// rebuild
// ============================================================================

describe("OverlayIndex.rebuild", () => {
	test("creates chunks in LanceDB for dirty files", async () => {
		const overlay = makeOverlay();
		await overlay.rebuild([DIRTY_FILE]);

		const stats = await overlay.getStats();
		expect(stats.chunkCount).toBeGreaterThan(0);
		await overlay.close();
	});

	test("skips deleted files (no content to index)", async () => {
		const overlay = makeOverlay();
		await overlay.rebuild([DELETED_FILE]);

		const stats = await overlay.getStats();
		expect(stats.chunkCount).toBe(0);
		await overlay.close();
	});

	test("handles empty dirty files list gracefully", async () => {
		const overlay = makeOverlay();
		await overlay.rebuild([]);

		const stats = await overlay.getStats();
		expect(stats.chunkCount).toBe(0);
		await overlay.close();
	});

	test("counts correct number of files", async () => {
		const overlay = makeOverlay();
		await overlay.rebuild([DIRTY_FILE, UNTRACKED_FILE]);

		const stats = await overlay.getStats();
		expect(stats.fileCount).toBe(2);
		await overlay.close();
	});

	test("clears old chunks on subsequent rebuild", async () => {
		const overlay = makeOverlay();
		await overlay.rebuild([DIRTY_FILE, UNTRACKED_FILE]);

		const statsAfterFirst = await overlay.getStats();
		expect(statsAfterFirst.chunkCount).toBeGreaterThan(0);

		// Rebuild with only one file
		await overlay.rebuild([DIRTY_FILE]);

		const statsAfterSecond = await overlay.getStats();
		// Should have fewer or equal chunks (one file instead of two)
		// Since mock returns 1 chunk per file:
		expect(statsAfterSecond.chunkCount).toBe(1);
		await overlay.close();
	});

	test("calls onProgress callback during rebuild", async () => {
		const overlay = makeOverlay();
		const messages: string[] = [];

		await overlay.rebuild([DIRTY_FILE], (msg) => messages.push(msg));

		expect(messages.length).toBeGreaterThan(0);
		await overlay.close();
	});

	test("writes fingerprint after rebuild", async () => {
		const overlay = makeOverlay();
		await overlay.rebuild([DIRTY_FILE]);

		// Fingerprint file should exist
		expect(existsSync(join(overlayDir, ".fingerprint"))).toBe(true);
		await overlay.close();
	});
});

// ============================================================================
// search
// ============================================================================

describe("OverlayIndex.search", () => {
	test("returns results after rebuild", async () => {
		const overlay = makeOverlay();
		await overlay.rebuild([DIRTY_FILE]);

		const queryVector = Array.from({ length: 4 }, (_, i) => i * 0.01);
		const results = await overlay.search(queryVector, "myFn", 10);

		// We indexed 1 chunk from the mocked chunker — should get at least 1 result
		expect(results.length).toBeGreaterThan(0);
		await overlay.close();
	});

	test("returns empty results from empty overlay", async () => {
		const overlay = makeOverlay();
		await overlay.rebuild([]);

		const queryVector = Array.from({ length: 4 }, (_, i) => i * 0.01);
		const results = await overlay.search(queryVector, "anything", 10);

		expect(results).toHaveLength(0);
		await overlay.close();
	});

	test("result has expected SearchResult shape", async () => {
		const overlay = makeOverlay();
		await overlay.rebuild([DIRTY_FILE]);

		const queryVector = Array.from({ length: 4 }, (_, i) => i * 0.01);
		const results = await overlay.search(queryVector, "myFn", 5);

		if (results.length > 0) {
			const r = results[0];
			expect(r).toHaveProperty("chunk");
			expect(r).toHaveProperty("score");
			expect(r.chunk).toHaveProperty("filePath");
		}
		await overlay.close();
	});
});

// ============================================================================
// invalidate
// ============================================================================

describe("OverlayIndex.invalidate", () => {
	test("makes isStale return true after invalidate", async () => {
		const overlay = makeOverlay();
		await overlay.rebuild([DIRTY_FILE]);

		// Confirm not stale
		expect(await overlay.isStale([DIRTY_FILE])).toBe(false);

		// Invalidate
		await overlay.invalidate();

		// Now should be stale
		expect(await overlay.isStale([DIRTY_FILE])).toBe(true);
		await overlay.close();
	});

	test("invalidate is safe even when no fingerprint exists", async () => {
		const overlay = makeOverlay();
		// No rebuild, no fingerprint yet
		await expect(overlay.invalidate()).resolves.toBeUndefined();
		await overlay.close();
	});
});

// ============================================================================
// getStats
// ============================================================================

describe("OverlayIndex.getStats", () => {
	test("returns zero counts for empty overlay", async () => {
		const overlay = makeOverlay();
		await overlay.rebuild([]);

		const stats = await overlay.getStats();
		expect(stats.chunkCount).toBe(0);
		expect(stats.fileCount).toBe(0);
		await overlay.close();
	});

	test("returns positive counts after rebuild with dirty files", async () => {
		const overlay = makeOverlay();
		await overlay.rebuild([DIRTY_FILE]);

		const stats = await overlay.getStats();
		expect(stats.chunkCount).toBeGreaterThan(0);
		expect(stats.fileCount).toBeGreaterThanOrEqual(1);
		await overlay.close();
	});
});

// ============================================================================
// Factory
// ============================================================================

describe("createOverlayIndex", () => {
	test("returns an OverlayIndex instance", async () => {
		const overlay = await createOverlayIndex({
			projectPath: projectDir,
			overlayDir,
			embeddingsClient,
		});
		expect(overlay).toBeInstanceOf(OverlayIndex);
		await overlay.close();
	});
});
