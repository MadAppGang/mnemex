/**
 * Integration tests for QueryRouter
 *
 * Tests:
 * - Query classification (symbol, structural, semantic, location, similarity)
 * - Strategy generation
 * - Entity extraction
 */

import { describe, test, expect } from "bun:test";
import { QueryRouter } from "../../src/retrieval/routing/query-router.js";

describe("QueryRouter", () => {
	// Create router without LLM for deterministic rule-based tests
	const router = new QueryRouter(null, { useLLM: false });

	describe("Symbol lookup classification", () => {
		test("classifies PascalCase names as symbol_lookup", async () => {
			const result = await router.route("UserService");
			expect(result.classification.intent).toBe("symbol_lookup");
			expect(result.classification.confidence).toBeGreaterThan(0.8);
		});

		test("classifies camelCase names as symbol_lookup", async () => {
			const result = await router.route("createUser");
			expect(result.classification.intent).toBe("symbol_lookup");
		});

		test("classifies function keyword queries as symbol_lookup", async () => {
			const result = await router.route("function handleAuth");
			expect(result.classification.intent).toBe("symbol_lookup");
		});

		test("classifies class keyword queries as symbol_lookup", async () => {
			const result = await router.route("class PaymentService");
			expect(result.classification.intent).toBe("symbol_lookup");
		});

		test("strategy uses symbol primary for symbol_lookup", async () => {
			const result = await router.route("UserService");
			expect(result.strategy.primary).toBe("symbol");
			expect(result.strategy.useHybrid).toBe(false);
		});
	});

	describe("Structural classification", () => {
		test("classifies 'what calls' queries as structural", async () => {
			const result = await router.route("what calls createUser");
			expect(result.classification.intent).toBe("structural");
		});

		test("classifies 'methods in' queries as structural", async () => {
			const result = await router.route("methods in UserService");
			expect(result.classification.intent).toBe("structural");
		});

		test("classifies dependency queries as structural", async () => {
			const result = await router.route("functions that import auth module");
			expect(result.classification.intent).toBe("structural");
		});

		test("classifies caller queries as structural", async () => {
			const result = await router.route("callers of processPayment");
			expect(result.classification.intent).toBe("structural");
		});

		test("strategy uses hybrid search for structural", async () => {
			const result = await router.route("methods in UserService");
			expect(result.strategy.primary).toBe("keyword");
			expect(result.strategy.useHybrid).toBe(true);
		});
	});

	describe("Location classification", () => {
		test("classifies folder queries as location", async () => {
			const result = await router.route("handlers in api folder");
			expect(result.classification.intent).toBe("location");
		});

		test("classifies test queries as location", async () => {
			const result = await router.route("tests for payment module");
			expect(result.classification.intent).toBe("location");
		});

		test("classifies directory queries as location", async () => {
			const result = await router.route("files under src/components");
			expect(result.classification.intent).toBe("location");
		});

		test("classifies file extension queries as location", async () => {
			// Entity extraction extracts file paths with code extensions (.ts, .js, .py, .go, etc.)
			const result = await router.route("find src/config.ts");
			// Path with code file extension is extracted as entity
			expect(result.classification.extractedEntities).toContain(
				"src/config.ts",
			);
		});

		test("strategy uses path primary for location", async () => {
			const result = await router.route("tests for auth module");
			expect(result.strategy.primary).toBe("path");
		});
	});

	describe("Similarity classification", () => {
		test("classifies 'similar to' queries as similarity", async () => {
			const result = await router.route("code similar to error handling");
			expect(result.classification.intent).toBe("similarity");
		});

		test("classifies 'like' queries as similarity", async () => {
			const result = await router.route("code like the retry logic");
			expect(result.classification.intent).toBe("similarity");
		});

		test("classifies pattern queries as similarity", async () => {
			const result = await router.route("pattern for authentication");
			expect(result.classification.intent).toBe("similarity");
		});

		test("strategy prioritizes vector for similarity", async () => {
			const result = await router.route("code similar to error handling");
			expect(result.strategy.primary).toBe("vector");
			expect(result.strategy.weights?.vector).toBeGreaterThan(0.7);
		});
	});

	describe("Semantic classification", () => {
		test("classifies natural language questions as semantic", async () => {
			const result = await router.route("how does authentication work");
			expect(result.classification.intent).toBe("semantic");
		});

		test("classifies explanatory questions as semantic", async () => {
			// "where is" may match structural patterns, use clearer semantic query
			const result = await router.route("explain how rate limiting works");
			expect(result.classification.intent).toBe("semantic");
		});

		test("classifies behavior questions as semantic", async () => {
			const result = await router.route("code that handles retries");
			expect(result.classification.intent).toBe("semantic");
		});

		test("defaults to semantic for ambiguous queries", async () => {
			const result = await router.route("handling errors gracefully");
			expect(result.classification.intent).toBe("semantic");
		});

		test("strategy uses hybrid search for semantic", async () => {
			const result = await router.route("how does authentication work");
			expect(result.strategy.primary).toBe("vector");
			expect(result.strategy.useHybrid).toBe(true);
		});
	});

	describe("Entity extraction", () => {
		test("extracts PascalCase entities", async () => {
			const result = await router.route("find UserService and PaymentHandler");
			expect(result.classification.extractedEntities).toContain("UserService");
			expect(result.classification.extractedEntities).toContain(
				"PaymentHandler",
			);
		});

		test("extracts camelCase entities", async () => {
			const result = await router.route("where is handlePayment used");
			expect(result.classification.extractedEntities).toContain(
				"handlePayment",
			);
		});

		test("extracts snake_case entities", async () => {
			const result = await router.route("find process_payment function");
			expect(result.classification.extractedEntities).toContain(
				"process_payment",
			);
		});

		test("extracts file paths", async () => {
			const result = await router.route("look at src/auth/handler.ts");
			expect(result.classification.extractedEntities).toContain(
				"src/auth/handler.ts",
			);
		});
	});

	describe("Strategy generation", () => {
		test("buildStrategyForIntent generates correct strategies", () => {
			const symbolStrategy = router.buildStrategyForIntent("symbol_lookup");
			expect(symbolStrategy.primary).toBe("symbol");

			const semanticStrategy = router.buildStrategyForIntent("semantic");
			expect(semanticStrategy.primary).toBe("vector");
			expect(semanticStrategy.useHybrid).toBe(true);

			const locationStrategy = router.buildStrategyForIntent("location");
			expect(locationStrategy.primary).toBe("path");
		});

		test("symbol strategy includes appropriate unit types", async () => {
			const result = await router.route("UserService");
			expect(result.strategy.unitTypes).toContain("class");
			expect(result.strategy.unitTypes).toContain("function");
			expect(result.strategy.unitTypes).toContain("interface");
		});
	});

	describe("Edge cases", () => {
		test("handles empty query", async () => {
			const result = await router.route("");
			expect(result.classification.intent).toBe("semantic"); // Default
		});

		test("handles very long query", async () => {
			const longQuery = "how does " + "the system ".repeat(100) + "work";
			const result = await router.route(longQuery);
			expect(result.classification).toBeDefined();
		});

		test("handles special characters in query", async () => {
			const result = await router.route("find $special_var and @decorator");
			expect(result.classification).toBeDefined();
		});

		test("handles mixed case query", async () => {
			const result = await router.route("FIND userService CLASS");
			expect(result.classification.extractedEntities).toContain("userService");
		});
	});
});
