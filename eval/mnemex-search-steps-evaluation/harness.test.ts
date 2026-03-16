/**
 * Code Search Harness — Test Suite
 *
 * Tests for loader.ts, ablation.ts, and reporter.ts.
 * Run with: bun test eval/mnemex-search-steps-evaluation/harness.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ============================================================================
// Imports from modules under test
// ============================================================================

import {
	classifyQueryType,
	mapQueryTypeToRouterLabel,
	splitDataset,
	loadSwebenchQueries,
	loadBeirDataset,
} from "./loader.js";
import type { HarnessQuery } from "./loader.js";

import {
	computeReciprocalRank,
	computeNdcgAtK,
	computeRecallAtK,
	STANDARD_CONDITIONS,
	runCondition,
	runAblation,
	mockSearchFn,
	mockRouterFn,
	mockExpanderFn,
	mockRerankerFn,
} from "./ablation.js";
import type {
	AblationCondition,
	AblationConfig,
	SearchResult,
} from "./ablation.js";

import {
	generateComparisonTable,
	generateDeltaAnalysis,
	writeTrecRunFile,
	generateReport,
} from "./reporter.js";
import type { ConditionResult } from "./ablation.js";

// ============================================================================
// Shared temp directory
// ============================================================================

let tmpDir: string;

beforeAll(async () => {
	tmpDir = await mkdtemp(join(tmpdir(), "harness-test-"));
});

afterAll(async () => {
	await rm(tmpDir, { recursive: true, force: true });
});

// ============================================================================
// Helpers
// ============================================================================

function makeHarnessQuery(overrides: Partial<HarnessQuery> = {}): HarnessQuery {
	return {
		id: "q1",
		codeUnitId: "unit1",
		type: "vague",
		query: "find something",
		shouldFind: true,
		...overrides,
	};
}

function makeConditionResult(
	overrides: Partial<ConditionResult> = {},
): ConditionResult {
	const condition: AblationCondition = {
		name: "A",
		description: "Baseline",
		useRouter: false,
		useExpander: false,
		useReranker: false,
		dataset: "hybrid",
	};
	return {
		condition,
		dataset: "hybrid",
		nQueries: 0,
		perQueryResults: [],
		metrics: {
			mrrAt10: 0,
			ndcgAt10: 0,
			ndcgAt5: 0,
			recallAt100: 0,
		},
		latency: { p50: 0, p95: 0, mean: 0 },
		...overrides,
	};
}

// ============================================================================
// loader.ts — classifyQueryType
// ============================================================================

describe("classifyQueryType", () => {
	describe("symbol_lookup", () => {
		test("backtick-quoted identifier", () => {
			expect(classifyQueryType("where is `computeScore` defined")).toBe(
				"symbol_lookup",
			);
		});

		test("CamelCase class name", () => {
			expect(classifyQueryType("Where is QueryExpander implemented")).toBe(
				"symbol_lookup",
			);
		});

		test("snake_case function name", () => {
			expect(classifyQueryType("find the load_dataset function")).toBe(
				"symbol_lookup",
			);
		});

		test("multiple snake_case words", () => {
			expect(classifyQueryType("what does compute_mrr_at_k return")).toBe(
				"symbol_lookup",
			);
		});
	});

	describe("structural", () => {
		test("callers of", () => {
			expect(classifyQueryType("callers of the search function")).toBe(
				"structural",
			);
		});

		test("caller of (singular)", () => {
			expect(classifyQueryType("caller of runCondition")).toBe("structural");
		});

		test("depends on", () => {
			expect(classifyQueryType("which modules depend on the loader")).toBe(
				"structural",
			);
		});

		test("used by", () => {
			expect(
				classifyQueryType("this utility is used by the ablation runner"),
			).toBe("structural");
		});

		test("where is X called", () => {
			expect(classifyQueryType("where is computeScore called")).toBe(
				"structural",
			);
		});
	});

	describe("semantic_search", () => {
		test("error keyword", () => {
			expect(classifyQueryType("authentication error occurs on login")).toBe(
				"semantic_search",
			);
		});

		test("crash keyword", () => {
			expect(
				classifyQueryType("the server crashes when too many connections"),
			).toBe("semantic_search");
		});

		test("doesn't work", () => {
			expect(
				classifyQueryType("query expansion doesn't work with special chars"),
			).toBe("semantic_search");
		});

		test("bug keyword", () => {
			expect(classifyQueryType("there is a bug in the reranker")).toBe(
				"semantic_search",
			);
		});

		test("exception keyword", () => {
			expect(classifyQueryType("throws an exception during indexing")).toBe(
				"semantic_search",
			);
		});
	});

	describe("exploratory", () => {
		test("how to", () => {
			expect(classifyQueryType("how to configure the embedding model")).toBe(
				"exploratory",
			);
		});

		test("implement keyword", () => {
			expect(classifyQueryType("implement a custom reranker")).toBe(
				"exploratory",
			);
		});

		test("best practice", () => {
			expect(classifyQueryType("best practice for indexing large repos")).toBe(
				"exploratory",
			);
		});

		test("best way", () => {
			expect(classifyQueryType("best way to evaluate retrieval quality")).toBe(
				"exploratory",
			);
		});

		test("example of", () => {
			expect(classifyQueryType("example of a BEIR dataset format")).toBe(
				"exploratory",
			);
		});
	});

	describe("default", () => {
		test("plain query defaults to semantic_search", () => {
			expect(classifyQueryType("retrieve related documents")).toBe(
				"semantic_search",
			);
		});

		test("generic description defaults to semantic_search", () => {
			expect(classifyQueryType("the pipeline processes queries")).toBe(
				"semantic_search",
			);
		});
	});
});

// ============================================================================
// loader.ts — mapQueryTypeToRouterLabel
// ============================================================================

describe("mapQueryTypeToRouterLabel", () => {
	test("doc_api_lookup → symbol_lookup", () => {
		expect(mapQueryTypeToRouterLabel("doc_api_lookup")).toBe("symbol_lookup");
	});

	test("specific_behavior → semantic_search", () => {
		expect(mapQueryTypeToRouterLabel("specific_behavior")).toBe(
			"semantic_search",
		);
	});

	test("problem_based → semantic_search", () => {
		expect(mapQueryTypeToRouterLabel("problem_based")).toBe("semantic_search");
	});

	test("wrong_terminology → semantic_search", () => {
		expect(mapQueryTypeToRouterLabel("wrong_terminology")).toBe(
			"semantic_search",
		);
	});

	test("integration → structural", () => {
		expect(mapQueryTypeToRouterLabel("integration")).toBe("structural");
	});

	test("vague → exploratory", () => {
		expect(mapQueryTypeToRouterLabel("vague")).toBe("exploratory");
	});

	test("doc_conceptual → exploratory", () => {
		expect(mapQueryTypeToRouterLabel("doc_conceptual")).toBe("exploratory");
	});

	test("doc_best_practice → exploratory", () => {
		expect(mapQueryTypeToRouterLabel("doc_best_practice")).toBe("exploratory");
	});
});

// ============================================================================
// loader.ts — loadSwebenchQueries (tests extractFilesFromPatch indirectly)
// ============================================================================

describe("loadSwebenchQueries", () => {
	test("parses patch and extracts ground truth files", async () => {
		const patch = [
			"diff --git a/src/foo.py b/src/foo.py",
			"--- a/src/foo.py",
			"+++ b/src/foo.py",
			"@@ -1,4 +1,5 @@",
			" def foo():",
			"+    pass",
			"diff --git a/tests/test_foo.py b/tests/test_foo.py",
			"--- a/tests/test_foo.py",
			"+++ b/tests/test_foo.py",
			"@@ -1,2 +1,3 @@",
			" import foo",
		].join("\n");

		const jsonlContent = JSON.stringify({
			instance_id: "repo-123",
			problem_statement: "Fix the foo function",
			patch,
		});

		const swebenchPath = join(tmpDir, "swebench.jsonl");
		await writeFile(swebenchPath, jsonlContent + "\n", "utf8");

		const queries = await loadSwebenchQueries(swebenchPath);

		expect(queries).toHaveLength(1);
		const q = queries[0];
		expect(q.id).toBe("repo-123");
		expect(q.query).toBe("Fix the foo function");
		expect(q.type).toBe("problem_based");
		expect(q.groundTruthFiles).toContain("src/foo.py");
		expect(q.groundTruthFiles).toContain("tests/test_foo.py");
		expect(q.groundTruthFiles).toHaveLength(2);
	});

	test("handles instance without patch", async () => {
		const jsonlContent = JSON.stringify({
			instance_id: "repo-456",
			problem_statement: "Something is broken",
		});

		const swebenchPath = join(tmpDir, "swebench-nopatch.jsonl");
		await writeFile(swebenchPath, jsonlContent + "\n", "utf8");

		const queries = await loadSwebenchQueries(swebenchPath);

		expect(queries).toHaveLength(1);
		expect(queries[0].groundTruthFiles).toHaveLength(0);
	});

	test("deduplicates files from patch", async () => {
		// Same file modified twice (shouldn't happen in practice but tests de-dup)
		const patch = [
			"+++ b/src/foo.py",
			"+++ b/src/foo.py",
			"+++ b/src/bar.py",
		].join("\n");

		const jsonlContent = JSON.stringify({
			instance_id: "repo-789",
			problem_statement: "Multi-file change",
			patch,
		});

		const swebenchPath = join(tmpDir, "swebench-dedup.jsonl");
		await writeFile(swebenchPath, jsonlContent + "\n", "utf8");

		const queries = await loadSwebenchQueries(swebenchPath);

		const files = queries[0].groundTruthFiles ?? [];
		const uniqueFiles = [...new Set(files)];
		expect(files).toHaveLength(uniqueFiles.length);
	});

	test("assigns routerLabel from classifyQueryType", async () => {
		const jsonlContent = JSON.stringify({
			instance_id: "repo-abc",
			problem_statement: "how to implement the authentication flow",
		});

		const swebenchPath = join(tmpDir, "swebench-router.jsonl");
		await writeFile(swebenchPath, jsonlContent + "\n", "utf8");

		const queries = await loadSwebenchQueries(swebenchPath);
		expect(queries[0].routerLabel).toBe("exploratory");
	});
});

// ============================================================================
// loader.ts — splitDataset
// ============================================================================

describe("splitDataset", () => {
	function makeQueries(
		count: number,
		label: "symbol_lookup" | "semantic_search",
	): HarnessQuery[] {
		return Array.from({ length: count }, (_, i) =>
			makeHarnessQuery({ id: `${label}-${i}`, routerLabel: label }),
		);
	}

	test("respects routerTestSize", () => {
		const queries = makeQueries(20, "semantic_search");
		const split = splitDataset(queries, {
			routerTestSize: 5,
			retrievalEvalSize: 15,
		});
		expect(split.routerTestSet.length).toBeLessThanOrEqual(5);
	});

	test("respects retrievalEvalSize", () => {
		const queries = makeQueries(20, "semantic_search");
		const split = splitDataset(queries, {
			routerTestSize: 5,
			retrievalEvalSize: 10,
		});
		expect(split.retrievalEvalSet.length).toBeLessThanOrEqual(10);
	});

	test("stratified split across multiple labels", () => {
		const symbolQueries = makeQueries(10, "symbol_lookup");
		const semanticQueries = makeQueries(10, "semantic_search");
		const all = [...symbolQueries, ...semanticQueries];

		const split = splitDataset(all, {
			routerTestSize: 4,
			retrievalEvalSize: 16,
		});

		// Both labels should be represented in router test set
		const routerLabels = new Set(split.routerTestSet.map((q) => q.routerLabel));
		expect(routerLabels.has("symbol_lookup")).toBe(true);
		expect(routerLabels.has("semantic_search")).toBe(true);
	});

	test("deterministic (same split on repeated calls)", () => {
		const queries = makeQueries(20, "semantic_search");
		const split1 = splitDataset(queries, {
			routerTestSize: 5,
			retrievalEvalSize: 15,
		});
		const split2 = splitDataset(queries, {
			routerTestSize: 5,
			retrievalEvalSize: 15,
		});

		const ids1 = split1.routerTestSet.map((q) => q.id).sort();
		const ids2 = split2.routerTestSet.map((q) => q.id).sort();
		expect(ids1).toEqual(ids2);
	});

	test("handles empty query set", () => {
		const split = splitDataset([], {
			routerTestSize: 5,
			retrievalEvalSize: 10,
		});
		expect(split.routerTestSet).toHaveLength(0);
		expect(split.retrievalEvalSet).toHaveLength(0);
	});
});

// ============================================================================
// loader.ts — loadBeirDataset
// ============================================================================

describe("loadBeirDataset", () => {
	test("loads corpus, queries, and qrels from directory", async () => {
		const beirDir = join(tmpDir, "beir-dataset");
		await mkdir(join(beirDir, "qrels"), { recursive: true });

		// Write corpus.jsonl
		await writeFile(
			join(beirDir, "corpus.jsonl"),
			[
				JSON.stringify({ _id: "doc1", title: "Foo", text: "Content of doc 1" }),
				JSON.stringify({ _id: "doc2", title: "Bar", text: "Content of doc 2" }),
			].join("\n") + "\n",
			"utf8",
		);

		// Write queries.jsonl
		await writeFile(
			join(beirDir, "queries.jsonl"),
			[
				JSON.stringify({ _id: "q1", text: "what is foo" }),
				JSON.stringify({
					_id: "q2",
					text: "bar documentation",
					routerLabel: "symbol_lookup",
				}),
			].join("\n") + "\n",
			"utf8",
		);

		// Write qrels/test.tsv
		await writeFile(
			join(beirDir, "qrels", "test.tsv"),
			"query-id\tcorpus-id\tscore\nq1\tdoc1\t1\nq2\tdoc2\t1\n",
			"utf8",
		);

		const dataset = await loadBeirDataset(beirDir);

		expect(dataset.corpus.size).toBe(2);
		expect(dataset.corpus.get("doc1")).toBe("Content of doc 1");
		expect(dataset.queries).toHaveLength(2);
		expect(dataset.qrels.get("q1")?.get("doc1")).toBe(1);

		// Query with explicit routerLabel should keep it
		const q2 = dataset.queries.find((q) => q.id === "q2");
		expect(q2?.routerLabel).toBe("symbol_lookup");
	});
});

// ============================================================================
// ablation.ts — computeReciprocalRank
// ============================================================================

describe("computeReciprocalRank", () => {
	test("relevant doc at rank 1 → 1.0", () => {
		const retrieved = ["doc1", "doc2", "doc3"];
		const relevant = new Set(["doc1"]);
		expect(computeReciprocalRank(retrieved, relevant)).toBe(1.0);
	});

	test("relevant doc at rank 2 → 0.5", () => {
		const retrieved = ["doc0", "doc1", "doc2"];
		const relevant = new Set(["doc1"]);
		expect(computeReciprocalRank(retrieved, relevant)).toBeCloseTo(0.5);
	});

	test("relevant doc at rank 3 → 1/3", () => {
		const retrieved = ["doc0", "doc1", "doc2"];
		const relevant = new Set(["doc2"]);
		expect(computeReciprocalRank(retrieved, relevant)).toBeCloseTo(1 / 3);
	});

	test("no relevant doc → 0", () => {
		const retrieved = ["doc0", "doc1", "doc2"];
		const relevant = new Set(["doc9"]);
		expect(computeReciprocalRank(retrieved, relevant)).toBe(0);
	});

	test("empty retrieved list → 0", () => {
		const retrieved: string[] = [];
		const relevant = new Set(["doc1"]);
		expect(computeReciprocalRank(retrieved, relevant)).toBe(0);
	});

	test("multiple relevant docs uses first match", () => {
		const retrieved = ["doc2", "doc1", "doc3"];
		const relevant = new Set(["doc1", "doc2"]);
		// doc2 is at rank 1
		expect(computeReciprocalRank(retrieved, relevant)).toBe(1.0);
	});
});

// ============================================================================
// ablation.ts — computeNdcgAtK
// ============================================================================

describe("computeNdcgAtK", () => {
	test("single relevant doc at rank 1 → 1.0", () => {
		const retrieved = ["doc1", "doc2", "doc3"];
		const relevant = new Set(["doc1"]);
		// DCG = 1/log2(2) = 1; IDCG = 1/log2(2) = 1; NDCG = 1.0
		expect(computeNdcgAtK(retrieved, relevant, 5)).toBeCloseTo(1.0);
	});

	test("single relevant doc at rank 2 < 1.0", () => {
		const retrieved = ["doc0", "doc1", "doc2"];
		const relevant = new Set(["doc1"]);
		// DCG = 1/log2(3) ≈ 0.63; IDCG = 1; NDCG < 1
		const ndcg = computeNdcgAtK(retrieved, relevant, 5);
		expect(ndcg).toBeGreaterThan(0);
		expect(ndcg).toBeLessThan(1);
	});

	test("relevant doc beyond k → 0 contribution inside k", () => {
		const retrieved = ["doc0", "doc1", "doc2", "doc3", "doc4", "doc_rel"];
		const relevant = new Set(["doc_rel"]);
		// doc_rel is at rank 6; k=5 means it's not counted
		expect(computeNdcgAtK(retrieved, relevant, 5)).toBe(0);
	});

	test("no relevant docs → 0", () => {
		const retrieved = ["doc0", "doc1"];
		const relevant = new Set<string>();
		expect(computeNdcgAtK(retrieved, relevant, 5)).toBe(0);
	});

	test("perfect retrieval at k=1", () => {
		const retrieved = ["doc1"];
		const relevant = new Set(["doc1"]);
		expect(computeNdcgAtK(retrieved, relevant, 1)).toBeCloseTo(1.0);
	});

	test("NDCG increases as rank improves", () => {
		// Doc at rank 1
		const ndcg1 = computeNdcgAtK(["doc1", "doc0"], new Set(["doc1"]), 5);
		// Doc at rank 2
		const ndcg2 = computeNdcgAtK(["doc0", "doc1"], new Set(["doc1"]), 5);
		expect(ndcg1).toBeGreaterThan(ndcg2);
	});
});

// ============================================================================
// ablation.ts — computeRecallAtK
// ============================================================================

describe("computeRecallAtK", () => {
	test("full recall when all relevant docs in top-K", () => {
		const retrieved = ["doc1", "doc2", "doc3"];
		const relevant = new Set(["doc1", "doc2"]);
		expect(computeRecallAtK(retrieved, relevant, 3)).toBe(1.0);
	});

	test("partial recall", () => {
		const retrieved = ["doc1", "doc0", "doc0b"];
		const relevant = new Set(["doc1", "doc2"]);
		// 1 of 2 relevant docs in top-3
		expect(computeRecallAtK(retrieved, relevant, 3)).toBeCloseTo(0.5);
	});

	test("no recall when no relevant docs in top-K", () => {
		const retrieved = ["doc0", "doc1", "doc2"];
		const relevant = new Set(["doc9", "doc10"]);
		expect(computeRecallAtK(retrieved, relevant, 3)).toBe(0);
	});

	test("empty relevant set → 0", () => {
		const retrieved = ["doc0", "doc1"];
		const relevant = new Set<string>();
		expect(computeRecallAtK(retrieved, relevant, 3)).toBe(0);
	});

	test("k limits the window", () => {
		const retrieved = ["doc0", "doc1", "doc2", "doc3", "doc_rel"];
		const relevant = new Set(["doc_rel"]);
		// doc_rel is at position 5 (index 4); k=4 means it won't be counted
		expect(computeRecallAtK(retrieved, relevant, 4)).toBe(0);
		// k=5 includes it
		expect(computeRecallAtK(retrieved, relevant, 5)).toBe(1.0);
	});
});

// ============================================================================
// ablation.ts — STANDARD_CONDITIONS
// ============================================================================

describe("STANDARD_CONDITIONS", () => {
	test("has exactly 14 conditions", () => {
		expect(STANDARD_CONDITIONS).toHaveLength(14);
	});

	test("all expected condition names are present", () => {
		const names = STANDARD_CONDITIONS.map((c) => c.name);
		expect(names).toContain("A");
		expect(names).toContain("B1");
		expect(names).toContain("B2");
		expect(names).toContain("B3");
		expect(names).toContain("C1");
		expect(names).toContain("C2");
		expect(names).toContain("C3");
		expect(names).toContain("D");
		expect(names).toContain("E");
		expect(names).toContain("F");
		expect(names).toContain("E-RA");
		expect(names).toContain("F-RA");
		expect(names).toContain("Q1");
		expect(names).toContain("Q2");
	});

	test("condition A is the baseline (no components enabled)", () => {
		const condA = STANDARD_CONDITIONS.find((c) => c.name === "A");
		expect(condA).toBeDefined();
		expect(condA!.useRouter).toBe(false);
		expect(condA!.useExpander).toBe(false);
		expect(condA!.useReranker).toBe(false);
	});

	test("condition E is the full pipeline", () => {
		const condE = STANDARD_CONDITIONS.find((c) => c.name === "E");
		expect(condE).toBeDefined();
		expect(condE!.useRouter).toBe(true);
		expect(condE!.useExpander).toBe(true);
		expect(condE!.useReranker).toBe(true);
	});

	test("B-series conditions use router only", () => {
		for (const name of ["B1", "B2", "B3"]) {
			const cond = STANDARD_CONDITIONS.find((c) => c.name === name);
			expect(cond).toBeDefined();
			expect(cond!.useRouter).toBe(true);
			expect(cond!.useExpander).toBe(false);
			expect(cond!.useReranker).toBe(false);
		}
	});

	test("C-series conditions use expander only", () => {
		for (const name of ["C1", "C2", "C3"]) {
			const cond = STANDARD_CONDITIONS.find((c) => c.name === name);
			expect(cond).toBeDefined();
			expect(cond!.useRouter).toBe(false);
			expect(cond!.useExpander).toBe(true);
			expect(cond!.useReranker).toBe(false);
		}
	});

	test("condition D uses reranker only", () => {
		const condD = STANDARD_CONDITIONS.find((c) => c.name === "D");
		expect(condD).toBeDefined();
		expect(condD!.useRouter).toBe(false);
		expect(condD!.useExpander).toBe(false);
		expect(condD!.useReranker).toBe(true);
	});

	test("all conditions have a non-empty description", () => {
		for (const cond of STANDARD_CONDITIONS) {
			expect(cond.description.length).toBeGreaterThan(0);
		}
	});
});

// ============================================================================
// ablation.ts — runCondition
// ============================================================================

describe("runCondition", () => {
	test("produces ConditionResult with correct structure", async () => {
		const conditionOutputDir = join(tmpDir, "run-condition-basic");

		const queries: HarnessQuery[] = [
			makeHarnessQuery({ id: "q1", query: "find bar", codeUnitId: "unit1" }),
			makeHarnessQuery({ id: "q2", query: "find baz", codeUnitId: "unit2" }),
		];

		const condition = STANDARD_CONDITIONS.find((c) => c.name === "A")!;
		const config: AblationConfig = {
			conditions: [condition],
			querySet: queries,
			outputDir: conditionOutputDir,
			kValues: [1, 5, 10],
		};

		const result = await runCondition(condition, config);

		expect(result.condition.name).toBe("A");
		expect(result.nQueries).toBe(2);
		expect(result.perQueryResults).toHaveLength(2);
		expect(result.metrics).toHaveProperty("mrrAt10");
		expect(result.metrics).toHaveProperty("ndcgAt10");
		expect(result.metrics).toHaveProperty("ndcgAt5");
		expect(result.metrics).toHaveProperty("recallAt100");
		expect(result.latency).toHaveProperty("p50");
		expect(result.latency).toHaveProperty("p95");
		expect(result.latency).toHaveProperty("mean");
	});

	test("writes condition JSON to outputDir", async () => {
		const conditionOutputDir = join(tmpDir, "run-condition-file");
		const condition = STANDARD_CONDITIONS.find((c) => c.name === "A")!;

		const config: AblationConfig = {
			conditions: [condition],
			querySet: [makeHarnessQuery({ id: "q1" })],
			outputDir: conditionOutputDir,
			kValues: [5, 10],
		};

		await runCondition(condition, config);

		const outPath = join(conditionOutputDir, "condition_A.json");
		const raw = await readFile(outPath, "utf8");
		const parsed = JSON.parse(raw);
		expect(parsed.condition.name).toBe("A");
	});

	test("uses custom searchFn and computes metrics against ground truth", async () => {
		const conditionOutputDir = join(tmpDir, "run-condition-custom-search");

		// A search fn that always returns doc "unit1" first
		const searchFn = async (): Promise<SearchResult[]> => [
			{ docId: "unit1", score: 1.0 },
			{ docId: "unit2", score: 0.5 },
		];

		const query = makeHarnessQuery({
			id: "q1",
			query: "test",
			codeUnitId: "unit1",
			groundTruthFiles: ["unit1"],
		});

		const condition = STANDARD_CONDITIONS.find((c) => c.name === "A")!;
		const config: AblationConfig = {
			conditions: [condition],
			querySet: [query],
			outputDir: conditionOutputDir,
			kValues: [1, 5, 10],
			searchFn,
		};

		const result = await runCondition(condition, config);

		// unit1 is at rank 1 → RR = 1.0
		expect(result.metrics.mrrAt10).toBeCloseTo(1.0);
		// NDCG@10 should be perfect
		expect(result.metrics.ndcgAt10).toBeCloseTo(1.0);
		// Recall at k=1 should be 1.0 (unit1 in top-1)
		expect(result.perQueryResults[0].recallAtK[1]).toBe(1.0);
	});

	test("calls routerFn when useRouter=true", async () => {
		const conditionOutputDir = join(tmpDir, "run-condition-router");

		let routerCalled = false;
		const routerFn = async (): Promise<"symbol_lookup"> => {
			routerCalled = true;
			return "symbol_lookup";
		};

		const condition = STANDARD_CONDITIONS.find((c) => c.name === "B1")!;
		const config: AblationConfig = {
			conditions: [condition],
			querySet: [makeHarnessQuery({ id: "q1" })],
			outputDir: conditionOutputDir,
			kValues: [5],
			routerFn,
		};

		await runCondition(condition, config);
		expect(routerCalled).toBe(true);
	});

	test("calls expanderFn when useExpander=true", async () => {
		const conditionOutputDir = join(tmpDir, "run-condition-expander");

		let expanderCalled = false;
		const expanderFn = async (q: string) => {
			expanderCalled = true;
			return { expanded: `expanded: ${q}` };
		};

		const condition = STANDARD_CONDITIONS.find((c) => c.name === "C1")!;
		const config: AblationConfig = {
			conditions: [condition],
			querySet: [makeHarnessQuery({ id: "q1" })],
			outputDir: conditionOutputDir,
			kValues: [5],
			expanderFn,
		};

		await runCondition(condition, config);
		expect(expanderCalled).toBe(true);
	});

	test("calls rerankerFn when useReranker=true and results non-empty", async () => {
		const conditionOutputDir = join(tmpDir, "run-condition-reranker");

		let rerankerCalled = false;
		const rerankerFn = async (results: SearchResult[]) => {
			rerankerCalled = true;
			return results.slice().reverse();
		};
		const searchFn = async (): Promise<SearchResult[]> => [
			{ docId: "a", score: 1.0 },
			{ docId: "b", score: 0.5 },
		];

		const condition = STANDARD_CONDITIONS.find((c) => c.name === "D")!;
		const config: AblationConfig = {
			conditions: [condition],
			querySet: [makeHarnessQuery({ id: "q1" })],
			outputDir: conditionOutputDir,
			kValues: [5],
			rerankerFn,
			searchFn,
		};

		await runCondition(condition, config);
		expect(rerankerCalled).toBe(true);
	});

	test("empty query set produces nQueries=0", async () => {
		const conditionOutputDir = join(tmpDir, "run-condition-empty");
		const condition = STANDARD_CONDITIONS.find((c) => c.name === "A")!;

		const config: AblationConfig = {
			conditions: [condition],
			querySet: [],
			outputDir: conditionOutputDir,
			kValues: [5],
		};

		const result = await runCondition(condition, config);
		expect(result.nQueries).toBe(0);
		expect(result.metrics.mrrAt10).toBe(0);
	});

	test("route-aware expansion skips expander for symbol_lookup queries", async () => {
		const conditionOutputDir = join(tmpDir, "run-condition-route-aware");

		let expanderCallCount = 0;
		const expanderFn = async (q: string) => {
			expanderCallCount++;
			return { expanded: `expanded: ${q}` };
		};

		// Router always returns symbol_lookup
		const routerFn = async (): Promise<"symbol_lookup"> => {
			return "symbol_lookup";
		};

		const condition = STANDARD_CONDITIONS.find((c) => c.name === "E-RA")!;
		const config: AblationConfig = {
			conditions: [condition],
			querySet: [
				makeHarnessQuery({
					id: "q1",
					query: "FastMCP",
					routerLabel: "symbol_lookup",
				}),
				makeHarnessQuery({
					id: "q2",
					query: "another symbol",
					routerLabel: "symbol_lookup",
				}),
			],
			outputDir: conditionOutputDir,
			kValues: [5],
			expanderFn,
			routerFn,
		};

		await runCondition(condition, config);
		// Expander should NOT have been called for symbol_lookup queries
		expect(expanderCallCount).toBe(0);
	});

	test("route-aware expansion calls expander for semantic queries", async () => {
		const conditionOutputDir = join(
			tmpDir,
			"run-condition-route-aware-semantic",
		);

		let expanderCallCount = 0;
		const expanderFn = async (q: string) => {
			expanderCallCount++;
			return { expanded: `expanded: ${q}` };
		};

		// Router returns semantic_search
		const routerFn = async (): Promise<"semantic_search"> => {
			return "semantic_search";
		};

		const condition = STANDARD_CONDITIONS.find((c) => c.name === "E-RA")!;
		const config: AblationConfig = {
			conditions: [condition],
			querySet: [
				makeHarnessQuery({ id: "q1", query: "how does error handling work" }),
			],
			outputDir: conditionOutputDir,
			kValues: [5],
			expanderFn,
			routerFn,
		};

		await runCondition(condition, config);
		// Expander SHOULD have been called for semantic queries
		expect(expanderCallCount).toBe(1);
	});

	test("E-RA has routeAwareExpansion=true while E does not", () => {
		const condE = STANDARD_CONDITIONS.find((c) => c.name === "E")!;
		const condERA = STANDARD_CONDITIONS.find((c) => c.name === "E-RA")!;
		expect(condE.routeAwareExpansion).toBeUndefined();
		expect(condERA.routeAwareExpansion).toBe(true);
	});
});

// ============================================================================
// ablation.ts — runAblation
// ============================================================================

describe("runAblation", () => {
	test("runs 2 conditions and returns both results", async () => {
		const ablationOutputDir = join(tmpDir, "run-ablation-two");

		const condA = STANDARD_CONDITIONS.find((c) => c.name === "A")!;
		const condB1 = STANDARD_CONDITIONS.find((c) => c.name === "B1")!;

		const config: AblationConfig = {
			conditions: [condA, condB1],
			querySet: [makeHarnessQuery({ id: "q1" })],
			outputDir: ablationOutputDir,
			kValues: [5, 10],
		};

		const results = await runAblation(config);

		expect(results).toHaveLength(2);
		expect(results[0].condition.name).toBe("A");
		expect(results[1].condition.name).toBe("B1");
	});

	test("writes summary.json to outputDir", async () => {
		const ablationOutputDir = join(tmpDir, "run-ablation-summary");

		const condA = STANDARD_CONDITIONS.find((c) => c.name === "A")!;

		const config: AblationConfig = {
			conditions: [condA],
			querySet: [],
			outputDir: ablationOutputDir,
			kValues: [5],
		};

		await runAblation(config);

		const summaryPath = join(ablationOutputDir, "summary.json");
		const raw = await readFile(summaryPath, "utf8");
		const parsed = JSON.parse(raw);
		expect(Array.isArray(parsed)).toBe(true);
		expect(parsed[0].condition).toBe("A");
	});

	test("writes per-condition JSON files", async () => {
		const ablationOutputDir = join(tmpDir, "run-ablation-files");

		const condA = STANDARD_CONDITIONS.find((c) => c.name === "A")!;
		const condD = STANDARD_CONDITIONS.find((c) => c.name === "D")!;

		const config: AblationConfig = {
			conditions: [condA, condD],
			querySet: [],
			outputDir: ablationOutputDir,
			kValues: [5],
		};

		await runAblation(config);

		// Each condition file should exist
		const fileA = await readFile(
			join(ablationOutputDir, "condition_A.json"),
			"utf8",
		);
		const fileD = await readFile(
			join(ablationOutputDir, "condition_D.json"),
			"utf8",
		);
		expect(JSON.parse(fileA).condition.name).toBe("A");
		expect(JSON.parse(fileD).condition.name).toBe("D");
	});
});

// ============================================================================
// reporter.ts — generateComparisonTable
// ============================================================================

describe("generateComparisonTable", () => {
	test("returns placeholder for empty results", () => {
		const table = generateComparisonTable([]);
		expect(table).toContain("No results");
	});

	test("includes header row with metric names", () => {
		const result = makeConditionResult({
			condition: {
				name: "A",
				description: "Baseline",
				useRouter: false,
				useExpander: false,
				useReranker: false,
				dataset: "hybrid",
			},
			metrics: { mrrAt10: 0.5, ndcgAt10: 0.6, ndcgAt5: 0.55, recallAt100: 0.8 },
			latency: { p50: 10, p95: 20, mean: 12 },
		});

		const table = generateComparisonTable([result]);
		expect(table).toContain("MRR@10");
		expect(table).toContain("NDCG@10");
		expect(table).toContain("NDCG@5");
		expect(table).toContain("Recall@100");
		expect(table).toContain("P95 Latency");
	});

	test("includes condition name and description", () => {
		const result = makeConditionResult({
			condition: {
				name: "B1",
				description: "+Regex router",
				useRouter: true,
				useExpander: false,
				useReranker: false,
				dataset: "hybrid",
			},
		});

		const table = generateComparisonTable([result]);
		expect(table).toContain("B1");
		expect(table).toContain("+Regex router");
	});

	test("bolds the best non-baseline MRR value", () => {
		const baseline = makeConditionResult({
			condition: {
				name: "A",
				description: "Baseline",
				useRouter: false,
				useExpander: false,
				useReranker: false,
				dataset: "hybrid",
			},
			metrics: { mrrAt10: 0.4, ndcgAt10: 0.4, ndcgAt5: 0.4, recallAt100: 0.4 },
			latency: { p50: 5, p95: 10, mean: 6 },
		});

		const better = makeConditionResult({
			condition: {
				name: "B1",
				description: "+Regex router",
				useRouter: true,
				useExpander: false,
				useReranker: false,
				dataset: "hybrid",
			},
			metrics: { mrrAt10: 0.6, ndcgAt10: 0.6, ndcgAt5: 0.6, recallAt100: 0.6 },
			latency: { p50: 8, p95: 15, mean: 10 },
		});

		const table = generateComparisonTable([baseline, better]);
		// The best non-baseline value should be bolded
		expect(table).toContain("**");
	});

	test("table is valid markdown (has separator row)", () => {
		const result = makeConditionResult();
		const table = generateComparisonTable([result]);
		// Separator row consists of dashes
		expect(table).toMatch(/\|[-]+\|/);
	});
});

// ============================================================================
// reporter.ts — generateDeltaAnalysis
// ============================================================================

describe("generateDeltaAnalysis", () => {
	function makeResultWithRR(
		name: string,
		queryId: string,
		rr: number,
	): ConditionResult {
		return makeConditionResult({
			condition: {
				name,
				description: `Condition ${name}`,
				useRouter: false,
				useExpander: false,
				useReranker: false,
				dataset: "hybrid",
			},
			nQueries: 1,
			perQueryResults: [
				{
					queryId,
					query: "test query",
					reciprocalRank: rr,
					ndcgAt5: rr,
					ndcgAt10: rr,
					recallAtK: { 5: rr, 10: rr },
					latencyMs: 1,
					retrievedDocs: [],
					groundTruth: [],
				},
			],
			metrics: {
				mrrAt10: rr,
				ndcgAt10: rr,
				ndcgAt5: rr,
				recallAt100: rr,
			},
		});
	}

	test("returns empty array when baseline not found", () => {
		const result = makeResultWithRR("B1", "q1", 0.5);
		const analyses = generateDeltaAnalysis([result], "A");
		expect(analyses).toHaveLength(0);
	});

	test("returns one DeltaAnalysis per non-baseline condition", () => {
		const baseline = makeResultWithRR("A", "q1", 0.4);
		const condB1 = makeResultWithRR("B1", "q1", 0.6);
		const condB2 = makeResultWithRR("B2", "q1", 0.5);

		const analyses = generateDeltaAnalysis([baseline, condB1, condB2], "A");
		expect(analyses).toHaveLength(2);
	});

	test("delta is conditionValue - baselineValue", () => {
		const baseline = makeResultWithRR("A", "q1", 0.4);
		const condB1 = makeResultWithRR("B1", "q1", 0.6);

		const analyses = generateDeltaAnalysis([baseline, condB1], "A");
		expect(analyses[0].delta).toBeCloseTo(0.2);
	});

	test("DeltaAnalysis has required fields", () => {
		const baseline = makeResultWithRR("A", "q1", 0.5);
		const condB1 = makeResultWithRR("B1", "q1", 0.5);

		const analyses = generateDeltaAnalysis([baseline, condB1], "A");
		const analysis = analyses[0];

		expect(analysis).toHaveProperty("condition");
		expect(analysis).toHaveProperty("baselineCondition");
		expect(analysis).toHaveProperty("metric");
		expect(analysis).toHaveProperty("baselineValue");
		expect(analysis).toHaveProperty("conditionValue");
		expect(analysis).toHaveProperty("delta");
		expect(analysis).toHaveProperty("wilcoxonP");
		expect(analysis).toHaveProperty("effectSizeR");
		expect(analysis).toHaveProperty("significant");
	});

	test("significant is false when delta is 0", () => {
		const baseline = makeResultWithRR("A", "q1", 0.5);
		const condB1 = makeResultWithRR("B1", "q1", 0.5);

		const analyses = generateDeltaAnalysis([baseline, condB1], "A");
		// When identical RR values, Wilcoxon p=1 → not significant
		expect(analyses[0].significant).toBe(false);
	});
});

// ============================================================================
// reporter.ts — writeTrecRunFile
// ============================================================================

describe("writeTrecRunFile", () => {
	test("writes TREC format with correct columns", async () => {
		const trecPath = join(tmpDir, "trec", "run_A.trec");

		const result = makeConditionResult({
			condition: {
				name: "A",
				description: "Baseline",
				useRouter: false,
				useExpander: false,
				useReranker: false,
				dataset: "hybrid",
			},
			perQueryResults: [
				{
					queryId: "q1",
					query: "test",
					reciprocalRank: 1.0,
					ndcgAt5: 1.0,
					ndcgAt10: 1.0,
					recallAtK: { 5: 1.0 },
					latencyMs: 5,
					retrievedDocs: ["doc1", "doc2", "doc3"],
					groundTruth: ["doc1"],
				},
			],
		});

		await writeTrecRunFile(result, trecPath);

		const content = await readFile(trecPath, "utf8");
		const lines = content
			.trim()
			.split("\n")
			.filter((l) => l.length > 0);

		// Should have 3 lines (one per doc)
		expect(lines).toHaveLength(3);

		// Check format of first line: qid Q0 docid rank score run_name
		const parts = lines[0].split("\t");
		expect(parts).toHaveLength(6);
		expect(parts[0]).toBe("q1");
		expect(parts[1]).toBe("Q0");
		expect(parts[2]).toBe("doc1");
		expect(parts[3]).toBe("1"); // rank 1
		expect(parts[5]).toBe("condition_a"); // run name
	});

	test("rank is 1-indexed and increases", async () => {
		const trecPath = join(tmpDir, "trec", "run_B.trec");

		const result = makeConditionResult({
			condition: {
				name: "B1",
				description: "+Regex",
				useRouter: true,
				useExpander: false,
				useReranker: false,
				dataset: "hybrid",
			},
			perQueryResults: [
				{
					queryId: "q1",
					query: "test",
					reciprocalRank: 0.5,
					ndcgAt5: 0.5,
					ndcgAt10: 0.5,
					recallAtK: {},
					latencyMs: 3,
					retrievedDocs: ["docA", "docB", "docC"],
					groundTruth: ["docB"],
				},
			],
		});

		await writeTrecRunFile(result, trecPath);

		const content = await readFile(trecPath, "utf8");
		const lines = content
			.trim()
			.split("\n")
			.filter((l) => l.length > 0);

		const ranks = lines.map((l) => Number.parseInt(l.split("\t")[3], 10));
		expect(ranks).toEqual([1, 2, 3]);
	});

	test("score decreases with rank", async () => {
		const trecPath = join(tmpDir, "trec", "run_C.trec");

		const result = makeConditionResult({
			condition: {
				name: "C1",
				description: "+Expander",
				useRouter: false,
				useExpander: true,
				useReranker: false,
				dataset: "hybrid",
			},
			perQueryResults: [
				{
					queryId: "q1",
					query: "test",
					reciprocalRank: 1.0,
					ndcgAt5: 1.0,
					ndcgAt10: 1.0,
					recallAtK: {},
					latencyMs: 10,
					retrievedDocs: ["d1", "d2", "d3"],
					groundTruth: ["d1"],
				},
			],
		});

		await writeTrecRunFile(result, trecPath);

		const content = await readFile(trecPath, "utf8");
		const lines = content
			.trim()
			.split("\n")
			.filter((l) => l.length > 0);

		const scores = lines.map((l) => Number.parseFloat(l.split("\t")[4]));
		expect(scores[0]).toBeGreaterThan(scores[1]);
		expect(scores[1]).toBeGreaterThan(scores[2]);
	});
});

// ============================================================================
// reporter.ts — generateReport
// ============================================================================

describe("generateReport", () => {
	test("writes a markdown file when given empty results", async () => {
		const reportPath = join(tmpDir, "reports", "empty.md");
		await generateReport([], reportPath);

		const content = await readFile(reportPath, "utf8");
		expect(content).toContain("Ablation Report");
	});

	test("report contains required sections", async () => {
		const reportPath = join(tmpDir, "reports", "full.md");

		const baseline = makeConditionResult({
			condition: {
				name: "A",
				description: "Baseline",
				useRouter: false,
				useExpander: false,
				useReranker: false,
				dataset: "hybrid",
			},
			nQueries: 2,
			perQueryResults: [
				{
					queryId: "q1",
					query: "test1",
					reciprocalRank: 0.5,
					ndcgAt5: 0.5,
					ndcgAt10: 0.5,
					recallAtK: { 100: 0.5 },
					latencyMs: 10,
					retrievedDocs: ["d1"],
					groundTruth: ["d1"],
				},
				{
					queryId: "q2",
					query: "test2",
					reciprocalRank: 1.0,
					ndcgAt5: 1.0,
					ndcgAt10: 1.0,
					recallAtK: { 100: 1.0 },
					latencyMs: 12,
					retrievedDocs: ["d2"],
					groundTruth: ["d2"],
				},
			],
			metrics: {
				mrrAt10: 0.75,
				ndcgAt10: 0.75,
				ndcgAt5: 0.75,
				recallAt100: 0.75,
			},
			latency: { p50: 10, p95: 12, mean: 11 },
		});

		const condB1 = makeConditionResult({
			condition: {
				name: "B1",
				description: "+Regex router",
				useRouter: true,
				useExpander: false,
				useReranker: false,
				dataset: "hybrid",
			},
			nQueries: 2,
			perQueryResults: [
				{
					queryId: "q1",
					query: "test1",
					reciprocalRank: 0.6,
					ndcgAt5: 0.6,
					ndcgAt10: 0.6,
					recallAtK: { 100: 0.6 },
					latencyMs: 11,
					retrievedDocs: ["d1"],
					groundTruth: ["d1"],
				},
				{
					queryId: "q2",
					query: "test2",
					reciprocalRank: 1.0,
					ndcgAt5: 1.0,
					ndcgAt10: 1.0,
					recallAtK: { 100: 1.0 },
					latencyMs: 13,
					retrievedDocs: ["d2"],
					groundTruth: ["d2"],
				},
			],
			metrics: { mrrAt10: 0.8, ndcgAt10: 0.8, ndcgAt5: 0.8, recallAt100: 0.8 },
			latency: { p50: 11, p95: 13, mean: 12 },
		});

		await generateReport([baseline, condB1], reportPath);

		const content = await readFile(reportPath, "utf8");

		// Required sections
		expect(content).toContain("# Code Search Ablation Report");
		expect(content).toContain("## Results Summary");
		expect(content).toContain("## Delta vs Baseline");
		expect(content).toContain("## Latency Breakdown");
		expect(content).toContain("## Key Findings");
	});

	test("report contains condition names", async () => {
		const reportPath = join(tmpDir, "reports", "conditions.md");

		const results = [
			makeConditionResult({
				condition: {
					name: "A",
					description: "Baseline",
					useRouter: false,
					useExpander: false,
					useReranker: false,
					dataset: "hybrid",
				},
			}),
		];

		await generateReport(results, reportPath);

		const content = await readFile(reportPath, "utf8");
		expect(content).toContain("A");
		expect(content).toContain("Baseline");
	});

	test("report contains footer attribution", async () => {
		const reportPath = join(tmpDir, "reports", "footer.md");

		await generateReport([makeConditionResult()], reportPath);

		const content = await readFile(reportPath, "utf8");
		expect(content).toContain("reporter.ts");
	});
});

// ============================================================================
// Mock functions smoke tests
// ============================================================================

describe("mock functions", () => {
	test("mockSearchFn returns empty array", async () => {
		const results = await mockSearchFn("test query", { k: 10 });
		expect(results).toHaveLength(0);
	});

	test("mockRouterFn returns semantic_search", async () => {
		const label = await mockRouterFn("any query");
		expect(label).toBe("semantic_search");
	});

	test("mockExpanderFn returns query unchanged", async () => {
		const expanded = await mockExpanderFn("my query");
		expect(expanded.expanded).toBe("my query");
	});

	test("mockRerankerFn returns results unchanged", async () => {
		const results: SearchResult[] = [
			{ docId: "a", score: 1.0 },
			{ docId: "b", score: 0.5 },
		];
		const reranked = await mockRerankerFn(results, "query");
		expect(reranked).toEqual(results);
	});
});
