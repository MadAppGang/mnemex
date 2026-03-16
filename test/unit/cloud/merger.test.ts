/**
 * Unit tests for OverlayMerger
 *
 * Pure unit tests — no I/O, no LanceDB, no HTTP.
 * Tests cover:
 *  - Cloud results only → tagged as "cloud"
 *  - Overlay results only → tagged as "overlay"
 *  - Mixed: overlay takes precedence for dirty files
 *  - Score normalisation
 *  - Edge cases: empty results, single result, identical scores
 *  - Limit applied correctly
 */

import { describe, test, expect } from "bun:test";
import { OverlayMerger } from "../../../src/cloud/merger.js";
import type { MergedSearchResult } from "../../../src/cloud/merger.js";
import type { CloudSearchResult } from "../../../src/cloud/types.js";
import type { SearchResult, CodeChunk } from "../../../src/types.js";

// ============================================================================
// Fixtures
// ============================================================================

function makeCloudResult(
	overrides: Partial<CloudSearchResult> = {},
): CloudSearchResult {
	return {
		contentHash: "hash-cloud-1",
		filePath: "src/committed.ts",
		startLine: 1,
		endLine: 10,
		language: "typescript",
		chunkType: "function",
		name: "committedFn",
		score: 0.8,
		...overrides,
	};
}

function makeChunk(
	filePath: string,
	overrides: Partial<CodeChunk> = {},
): CodeChunk {
	return {
		id: `id-${filePath}`,
		contentHash: `hash-${filePath}`,
		content: "function foo() {}",
		filePath,
		startLine: 1,
		endLine: 5,
		language: "typescript",
		chunkType: "function",
		name: "foo",
		fileHash: "filehash-abc",
		...overrides,
	};
}

function makeOverlayResult(
	filePath: string,
	score = 0.7,
	overrides: Partial<SearchResult> = {},
): SearchResult {
	return {
		chunk: makeChunk(filePath),
		score,
		vectorScore: score,
		keywordScore: 0,
		...overrides,
	};
}

// ============================================================================
// Cloud results only
// ============================================================================

describe("OverlayMerger — cloud results only", () => {
	test("tags all results as 'cloud'", () => {
		const cloud = [
			makeCloudResult({ contentHash: "h1", filePath: "src/a.ts", score: 0.9 }),
			makeCloudResult({ contentHash: "h2", filePath: "src/b.ts", score: 0.7 }),
		];

		const results = OverlayMerger.merge(cloud, [], [], 10);

		expect(results).toHaveLength(2);
		for (const r of results) {
			expect(r.source).toBe("cloud");
		}
	});

	test("preserves file paths", () => {
		const cloud = [
			makeCloudResult({ contentHash: "h1", filePath: "src/a.ts" }),
			makeCloudResult({ contentHash: "h2", filePath: "src/b.ts" }),
		];

		const results = OverlayMerger.merge(cloud, [], [], 10);
		const paths = results.map((r) => r.chunk.filePath);

		expect(paths).toContain("src/a.ts");
		expect(paths).toContain("src/b.ts");
	});

	test("respects limit", () => {
		const cloud = Array.from({ length: 5 }, (_, i) =>
			makeCloudResult({
				contentHash: `h${i}`,
				filePath: `src/file${i}.ts`,
				score: 1 - i * 0.1,
			}),
		);

		const results = OverlayMerger.merge(cloud, [], [], 3);
		expect(results).toHaveLength(3);
	});
});

// ============================================================================
// Overlay results only
// ============================================================================

describe("OverlayMerger — overlay results only", () => {
	test("tags all results as 'overlay'", () => {
		const overlay = [
			makeOverlayResult("src/dirty.ts", 0.9),
			makeOverlayResult("src/other-dirty.ts", 0.5),
		];

		const results = OverlayMerger.merge(
			[],
			overlay,
			["src/dirty.ts", "src/other-dirty.ts"],
			10,
		);

		expect(results).toHaveLength(2);
		for (const r of results) {
			expect(r.source).toBe("overlay");
		}
	});

	test("respects limit", () => {
		const overlay = Array.from({ length: 8 }, (_, i) =>
			makeOverlayResult(`src/dirty${i}.ts`, 1 - i * 0.1),
		);

		const results = OverlayMerger.merge([], overlay, [], 5);
		expect(results).toHaveLength(5);
	});
});

// ============================================================================
// Empty results
// ============================================================================

describe("OverlayMerger — empty results", () => {
	test("returns empty array when both inputs are empty", () => {
		const results = OverlayMerger.merge([], [], [], 10);
		expect(results).toHaveLength(0);
	});

	test("returns empty array when both are empty regardless of dirty paths", () => {
		const results = OverlayMerger.merge([], [], ["src/a.ts"], 10);
		expect(results).toHaveLength(0);
	});
});

// ============================================================================
// Dirty file filtering (belt-and-suspenders)
// ============================================================================

describe("OverlayMerger — dirty file suppression", () => {
	test("filters cloud results for dirty file paths", () => {
		const cloud = [
			makeCloudResult({
				contentHash: "h1",
				filePath: "src/dirty.ts",
				score: 0.9,
			}),
			makeCloudResult({
				contentHash: "h2",
				filePath: "src/clean.ts",
				score: 0.7,
			}),
		];
		const overlay = [makeOverlayResult("src/dirty.ts", 0.85)];

		const results = OverlayMerger.merge(cloud, overlay, ["src/dirty.ts"], 10);

		// The cloud result for src/dirty.ts should be suppressed
		const cloudDirtyResult = results.find(
			(r) => r.source === "cloud" && r.chunk.filePath === "src/dirty.ts",
		);
		expect(cloudDirtyResult).toBeUndefined();

		// The overlay result for src/dirty.ts should be present
		const overlayResult = results.find(
			(r) => r.source === "overlay" && r.chunk.filePath === "src/dirty.ts",
		);
		expect(overlayResult).toBeDefined();
	});

	test("allows cloud results for non-dirty file paths", () => {
		const cloud = [
			makeCloudResult({
				contentHash: "h1",
				filePath: "src/clean.ts",
				score: 0.8,
			}),
		];

		const results = OverlayMerger.merge(cloud, [], ["src/dirty.ts"], 10);

		expect(results).toHaveLength(1);
		expect(results[0].chunk.filePath).toBe("src/clean.ts");
		expect(results[0].source).toBe("cloud");
	});

	test("overlay result takes place of suppressed cloud result", () => {
		const cloud = [
			makeCloudResult({
				contentHash: "h1",
				filePath: "src/dirty.ts",
				score: 1.0,
			}),
		];
		const overlay = [makeOverlayResult("src/dirty.ts", 0.9)];

		const results = OverlayMerger.merge(cloud, overlay, ["src/dirty.ts"], 10);

		expect(results).toHaveLength(1);
		expect(results[0].source).toBe("overlay");
		expect(results[0].chunk.filePath).toBe("src/dirty.ts");
	});
});

// ============================================================================
// Score normalisation
// ============================================================================

describe("OverlayMerger — score normalisation", () => {
	test("normalises scores to [0, 1] range", () => {
		const cloud = [
			makeCloudResult({ contentHash: "h1", score: 0.2 }),
			makeCloudResult({ contentHash: "h2", filePath: "src/b.ts", score: 0.6 }),
		];
		const overlay = [
			makeOverlayResult("src/dirty.ts", 0.5),
			makeOverlayResult("src/dirty2.ts", 0.9),
		];

		const results = OverlayMerger.merge(cloud, overlay, [], 10);

		for (const r of results) {
			expect(r.score).toBeGreaterThanOrEqual(0);
			expect(r.score).toBeLessThanOrEqual(1);
		}
	});

	test("highest score in each group normalises to 1.0", () => {
		const cloud = [
			makeCloudResult({ contentHash: "h1", score: 0.3 }),
			makeCloudResult({ contentHash: "h2", filePath: "src/b.ts", score: 0.9 }),
		];
		const overlay = [
			makeOverlayResult("src/d1.ts", 0.4),
			makeOverlayResult("src/d2.ts", 0.8),
		];

		const results = OverlayMerger.merge(cloud, overlay, [], 10);

		// The top cloud and top overlay should each have score 1.0 before being
		// deduped by the combined sort. At least one result should be 1.0.
		const topScore = Math.max(...results.map((r) => r.score));
		expect(topScore).toBeCloseTo(1.0, 5);
	});

	test("single result normalises to 1.0", () => {
		// Single cloud result only
		const results = OverlayMerger.merge(
			[makeCloudResult({ score: 0.42 })],
			[],
			[],
			10,
		);
		expect(results).toHaveLength(1);
		expect(results[0].score).toBeCloseTo(1.0, 5);
	});

	test("identical scores all normalise to 1.0", () => {
		const cloud = [
			makeCloudResult({ contentHash: "h1", score: 0.5 }),
			makeCloudResult({ contentHash: "h2", filePath: "src/b.ts", score: 0.5 }),
		];

		const results = OverlayMerger.merge(cloud, [], [], 10);

		for (const r of results) {
			expect(r.score).toBeCloseTo(1.0, 5);
		}
	});
});

// ============================================================================
// Sorting and ordering
// ============================================================================

describe("OverlayMerger — result ordering", () => {
	test("results are sorted by normalised score descending", () => {
		const cloud = [
			makeCloudResult({ contentHash: "h1", filePath: "src/a.ts", score: 0.3 }),
			makeCloudResult({ contentHash: "h2", filePath: "src/b.ts", score: 0.9 }),
		];

		const results = OverlayMerger.merge(cloud, [], [], 10);

		for (let i = 1; i < results.length; i++) {
			expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
		}
	});

	test("mixed cloud+overlay results are sorted together", () => {
		const cloud = [makeCloudResult({ contentHash: "h1", score: 0.5 })];
		const overlay = [makeOverlayResult("src/dirty.ts", 0.9)];

		const results = OverlayMerger.merge(cloud, overlay, [], 10);

		// Each group normalises to [0.0, 1.0] independently.
		// Both top results normalise to 1.0, so ordering between them is stable
		// but either could come first. Both should be present.
		expect(results).toHaveLength(2);
		const sources = results.map((r) => r.source);
		expect(sources).toContain("cloud");
		expect(sources).toContain("overlay");
	});
});

// ============================================================================
// MergedSearchResult type check
// ============================================================================

describe("OverlayMerger — MergedSearchResult shape", () => {
	test("merged result has all SearchResult fields plus source", () => {
		const cloud = [makeCloudResult()];
		const results: MergedSearchResult[] = OverlayMerger.merge(
			cloud,
			[],
			[],
			10,
		);

		expect(results[0]).toHaveProperty("chunk");
		expect(results[0]).toHaveProperty("score");
		expect(results[0]).toHaveProperty("vectorScore");
		expect(results[0]).toHaveProperty("keywordScore");
		expect(results[0]).toHaveProperty("source");
	});

	test("cloud result chunk has contentHash and filePath from cloud response", () => {
		const cloud = [
			makeCloudResult({
				contentHash: "deadbeef",
				filePath: "src/x.ts",
				score: 0.5,
			}),
		];
		const results = OverlayMerger.merge(cloud, [], [], 10);

		expect(results[0].chunk.contentHash).toBe("deadbeef");
		expect(results[0].chunk.filePath).toBe("src/x.ts");
	});
});
