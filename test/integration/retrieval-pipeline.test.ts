/**
 * Integration tests for the full retrieval pipeline
 *
 * Tests:
 * - End-to-end indexing and search
 * - Context formatting
 * - Reranking (mocked)
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { readFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { CodeUnitExtractor } from "../../src/core/ast/code-unit-extractor.js";
import { ContextFormatter } from "../../src/retrieval/formatting/context-formatter.js";
import { QueryRouter } from "../../src/retrieval/routing/query-router.js";
import { LLMReranker } from "../../src/retrieval/reranking/llm-reranker.js";
import type {
	CodeUnit,
	ILLMClient,
	LLMMessage,
	LLMResponse,
	LLMUsageStats,
	QueryIntent,
} from "../../src/types.js";

const FIXTURES_DIR = join(import.meta.dir, "../fixtures");
const TEST_INDEX_DIR = join(import.meta.dir, "../.test-index");

// Mock LLM client for testing
class MockLLMClient implements ILLMClient {
	async complete(messages: LLMMessage[]): Promise<LLMResponse> {
		return {
			content: "Mock response",
			model: "mock-model",
			usage: { inputTokens: 10, outputTokens: 5 },
		};
	}

	async completeJSON<T>(messages: LLMMessage[]): Promise<T> {
		// Return mock rankings for reranker
		const prompt = messages[0]?.content || "";
		if (prompt.includes("ranking")) {
			return {
				rankings: [
					{ index: 1, score: 9, reason: "Highly relevant" },
					{ index: 2, score: 7, reason: "Moderately relevant" },
					{ index: 3, score: 5, reason: "Somewhat relevant" },
				],
			} as T;
		}
		// Return mock classification for query router
		return {
			category: "semantic",
			confidence: 0.85,
			extracted_entities: [],
			reasoning: "Mock classification",
		} as T;
	}

	getProvider() {
		return "local" as const;
	}

	getModel() {
		return "mock-model";
	}

	async testConnection() {
		return true;
	}

	getAccumulatedUsage(): LLMUsageStats {
		return { inputTokens: 0, outputTokens: 0, cost: 0, calls: 0 };
	}

	resetAccumulatedUsage() {}
}

describe("Retrieval Pipeline Integration", () => {
	let extractor: CodeUnitExtractor;
	let allUnits: CodeUnit[];

	beforeAll(async () => {
		// Parser manager initializes lazily
		extractor = new CodeUnitExtractor();

		// Extract units from all fixture files
		allUnits = [];

		// TypeScript
		const tsSource = readFileSync(
			join(FIXTURES_DIR, "sample-typescript.ts"),
			"utf-8",
		);
		const tsHash = createHash("sha256")
			.update(tsSource)
			.digest("hex")
			.slice(0, 16);
		const tsUnits = await extractor.extractUnits(
			tsSource,
			"test/fixtures/sample-typescript.ts",
			"typescript",
			tsHash,
		);
		allUnits.push(...tsUnits);

		// Python
		const pySource = readFileSync(
			join(FIXTURES_DIR, "sample-python.py"),
			"utf-8",
		);
		const pyHash = createHash("sha256")
			.update(pySource)
			.digest("hex")
			.slice(0, 16);
		const pyUnits = await extractor.extractUnits(
			pySource,
			"test/fixtures/sample-python.py",
			"python",
			pyHash,
		);
		allUnits.push(...pyUnits);

		// Go
		const goSource = readFileSync(join(FIXTURES_DIR, "sample-go.go"), "utf-8");
		const goHash = createHash("sha256")
			.update(goSource)
			.digest("hex")
			.slice(0, 16);
		const goUnits = await extractor.extractUnits(
			goSource,
			"test/fixtures/sample-go.go",
			"go",
			goHash,
		);
		allUnits.push(...goUnits);
	});

	describe("Multi-language extraction", () => {
		test("extracts units from all fixture files", () => {
			expect(allUnits.length).toBeGreaterThan(20);
		});

		test("has units from each language", () => {
			const languages = new Set(allUnits.map((u) => u.language));
			expect(languages.has("typescript")).toBe(true);
			expect(languages.has("python")).toBe(true);
			expect(languages.has("go")).toBe(true);
		});

		test("has hierarchical structure for each file", () => {
			const files = allUnits.filter((u) => u.unitType === "file");
			expect(files.length).toBe(3);

			// Each file should have children
			for (const file of files) {
				const children = allUnits.filter((u) => u.parentId === file.id);
				expect(children.length).toBeGreaterThan(0);
			}
		});
	});

	describe("ContextFormatter", () => {
		const formatter = new ContextFormatter({
			style: "markdown",
			maxTokens: 4000,
		});

		test("formats code units for LLM context", () => {
			const classUnits = allUnits
				.filter((u) => u.unitType === "class")
				.slice(0, 2);
			const methodUnits = allUnits
				.filter((u) => u.unitType === "method")
				.slice(0, 3);

			const formatted = formatter.format({
				primary: classUnits,
				supporting: methodUnits,
				summaries: [
					{
						name: "UserService",
						summary: "Manages user operations",
						path: "sample-typescript.ts",
					},
				],
				queryIntent: "semantic" as QueryIntent,
			});

			expect(formatted.primary).toContain("class");
			expect(formatted.metadata.resultCount).toBe(5);
			expect(formatted.metadata.tokenEstimate).toBeGreaterThan(0);
		});

		test("formatForLLM produces readable output", () => {
			const units = allUnits
				.filter((u) => u.unitType === "function")
				.slice(0, 3);

			const output = formatter.formatForLLM({
				primary: units,
				supporting: [],
				summaries: [],
				queryIntent: "symbol_lookup" as QueryIntent,
			});

			// Should have markdown headers
			expect(output).toContain("## Relevant Code");
			// Should have code blocks
			expect(output).toContain("```");
		});

		test("respects token budget", () => {
			const smallFormatter = new ContextFormatter({ maxTokens: 500 });
			const units = allUnits.slice(0, 20);

			const formatted = smallFormatter.format({
				primary: units,
				supporting: [],
				summaries: [],
				queryIntent: "semantic" as QueryIntent,
			});

			// Token estimate should be near the budget
			expect(formatted.metadata.tokenEstimate).toBeLessThanOrEqual(600); // Some buffer
		});

		test("handles different styles", () => {
			const xmlFormatter = new ContextFormatter({ style: "xml" });
			const plainFormatter = new ContextFormatter({ style: "plain" });

			const units = allUnits
				.filter((u) => u.unitType === "function")
				.slice(0, 1);

			const xmlOutput = xmlFormatter.formatForLLM({
				primary: units,
				supporting: [],
				summaries: [],
				queryIntent: "semantic" as QueryIntent,
			});

			const plainOutput = plainFormatter.formatForLLM({
				primary: units,
				supporting: [],
				summaries: [],
				queryIntent: "semantic" as QueryIntent,
			});

			expect(xmlOutput).toContain("<code");
			expect(plainOutput).not.toContain("<code");
			expect(plainOutput).toContain("===");
		});
	});

	describe("LLMReranker", () => {
		const mockLLM = new MockLLMClient();
		const reranker = new LLMReranker(mockLLM, {
			maxCandidates: 10,
			minScore: 3,
		});

		test("reranks code units", async () => {
			const unitsWithScore = allUnits.slice(0, 5).map((u, i) => ({
				...u,
				score: 0.5 - i * 0.1, // Decreasing scores
			}));

			const reranked = await reranker.rerankCodeUnits(
				"UserService",
				unitsWithScore,
			);

			// Should have rerank scores
			expect(reranked.every((r) => typeof r.rerankScore === "number")).toBe(
				true,
			);
			expect(reranked.every((r) => typeof r.finalScore === "number")).toBe(
				true,
			);
		});

		test("filters by minimum score", async () => {
			const unitsWithScore = allUnits.slice(0, 5).map((u, i) => ({
				...u,
				score: 0.5,
			}));

			const strictReranker = new LLMReranker(mockLLM, { minScore: 6 });
			const reranked = await strictReranker.rerankCodeUnits(
				"UserService",
				unitsWithScore,
			);

			// Only high-scoring results should remain (based on mock returning 9, 7, 5)
			expect(reranked.every((r) => r.rerankScore >= 6)).toBe(true);
		});

		test("clamps rerank scores to 0-10 range", async () => {
			const unitsWithScore = allUnits.slice(0, 3).map((u) => ({
				...u,
				score: 0.5,
			}));

			const reranked = await reranker.rerankCodeUnits("test", unitsWithScore);

			for (const result of reranked) {
				expect(result.rerankScore).toBeGreaterThanOrEqual(0);
				expect(result.rerankScore).toBeLessThanOrEqual(10);
			}
		});

		test("handles empty input", async () => {
			const reranked = await reranker.rerankCodeUnits("test", []);
			expect(reranked).toEqual([]);
		});
	});

	describe("QueryRouter with LLM", () => {
		const mockLLM = new MockLLMClient();
		const router = new QueryRouter(mockLLM, {
			useLLM: true,
			minConfidence: 0.5,
		});

		test("uses rule-based classification for high-confidence patterns", async () => {
			// PascalCase should trigger high-confidence rule
			const result = await router.route("UserService");
			expect(result.classification.intent).toBe("symbol_lookup");
			expect(result.classification.confidence).toBeGreaterThan(0.8);
		});

		test("falls back to LLM for ambiguous queries", async () => {
			// This query doesn't strongly match any rule
			const result = await router.route("something ambiguous here");
			// Mock returns "semantic" with 0.85 confidence
			expect(result.classification).toBeDefined();
		});
	});

	describe("End-to-end pipeline simulation", () => {
		test("simulates full search flow", async () => {
			// 1. Route query (use keyword before name for symbol_lookup pattern)
			const router = new QueryRouter(null, { useLLM: false });
			const routing = await router.route("class UserService");

			expect(routing.classification.intent).toBe("symbol_lookup");

			// 2. Filter units based on strategy
			const relevantUnits = allUnits.filter((u) => {
				if (routing.strategy.unitTypes) {
					return routing.strategy.unitTypes.includes(u.unitType);
				}
				return true;
			});

			expect(relevantUnits.length).toBeGreaterThan(0);

			// 3. Simulate search scoring
			const searchResults = relevantUnits.slice(0, 10).map((u, i) => ({
				...u,
				score: 1 - i * 0.1,
			}));

			// 4. Format context
			const formatter = new ContextFormatter({ maxTokens: 2000 });
			const context = formatter.formatForLLM({
				primary: searchResults.slice(0, 5),
				supporting: searchResults.slice(5),
				summaries: [],
				queryIntent: routing.classification.intent,
			});

			expect(context.length).toBeGreaterThan(0);
			expect(context).toContain("Relevant Code");
		});

		test("handles semantic search flow", async () => {
			const router = new QueryRouter(null, { useLLM: false });
			const routing = await router.route("how does user authentication work");

			expect(routing.classification.intent).toBe("semantic");
			expect(routing.strategy.useHybrid).toBe(true);
			expect(routing.strategy.primary).toBe("vector");
		});

		test("handles location-based search flow", async () => {
			const router = new QueryRouter(null, { useLLM: false });
			const routing = await router.route("tests in api folder");

			expect(routing.classification.intent).toBe("location");
			expect(routing.strategy.primary).toBe("path");
		});
	});

	describe("Cross-language search simulation", () => {
		test("finds similar patterns across languages", () => {
			// Find all async functions across languages
			const asyncUnits = allUnits.filter((u) => u.metadata?.isAsync === true);

			// Should have async functions from both TypeScript and Python
			const languages = new Set(asyncUnits.map((u) => u.language));
			expect(languages.size).toBeGreaterThanOrEqual(2);
		});

		test("finds similar class patterns across languages", () => {
			const classes = allUnits.filter((u) => u.unitType === "class");
			const languages = new Set(classes.map((u) => u.language));

			expect(languages.has("typescript")).toBe(true);
			expect(languages.has("python")).toBe(true);
			expect(languages.has("go")).toBe(true); // Structs are treated as classes
		});

		test("maintains hierarchical consistency across languages", () => {
			const files = allUnits.filter((u) => u.unitType === "file");

			for (const file of files) {
				// Get all descendants
				const descendants = allUnits.filter((u) => {
					let current = u;
					while (current.parentId) {
						if (current.parentId === file.id) return true;
						const parent = allUnits.find((p) => p.id === current.parentId);
						if (!parent) break;
						current = parent;
					}
					return false;
				});

				// All descendants should have depth > file depth
				for (const desc of descendants) {
					expect(desc.depth).toBeGreaterThan(file.depth);
				}
			}
		});
	});
});
