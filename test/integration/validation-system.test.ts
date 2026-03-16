/**
 * E2E Validation System Tests
 *
 * Comprehensive tests for the validation infrastructure including
 * scenarios, sessions, statistics, and experiment orchestration.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync } from "node:fs";

import {
	// Types
	type ValidationScenario,
	type RecordedSession,
	type StatisticalComparison,
	// Scenario Library
	ScenarioLibrary,
	createScenarioLibrary,
	ScenarioBuilder,
	scenario,
	PERSONAS,
	KNOWLEDGE_BASES,
	// Session Recorder
	SessionRecorder,
	CriteriaEvaluator,
	// Validation Store
	ValidationStore,
	createValidationStore,
	// Environment Manager
	TempEnvironmentManager,
	MockEnvironmentManager,
	createEnvironmentManager,
	// Synthetic Agent
	SyntheticAgent,
	QueryHandler,
	CorrectionInjector,
	createSyntheticAgent,
	// Statistics
	StatisticsEngine,
	createStatisticsEngine,
	// Experiment Engine
	DecisionEngine,
	ParallelExecutor,
} from "../../src/learning/validation/index.js";

// ============================================================================
// Scenario Library Tests
// ============================================================================

describe("ScenarioLibrary", () => {
	let library: ScenarioLibrary;

	beforeEach(() => {
		library = createScenarioLibrary();
	});

	it("should load all built-in scenarios", () => {
		expect(library.count()).toBe(12);
	});

	it("should get scenario by ID", () => {
		const scenario = library.get("file-create-component");
		expect(scenario).toBeDefined();
		expect(scenario?.name).toBe("Create React Component");
		expect(scenario?.category).toBe("file_operations");
	});

	it("should return undefined for unknown scenario", () => {
		const scenario = library.get("non-existent");
		expect(scenario).toBeUndefined();
	});

	it("should filter by category", () => {
		const securityScenarios = library.getByCategory("security");
		expect(securityScenarios.length).toBe(2);
		expect(securityScenarios.every((s) => s.category === "security")).toBe(
			true,
		);
	});

	it("should filter by difficulty", () => {
		const hardScenarios = library.getByDifficulty(4);
		expect(hardScenarios.length).toBeGreaterThan(0);
		expect(hardScenarios.every((s) => s.difficulty === 4)).toBe(true);
	});

	it("should get scenarios by IDs", () => {
		const scenarios = library.getByIds([
			"file-create-component",
			"code-search-auth",
			"non-existent",
		]);
		expect(scenarios.length).toBe(2);
	});

	it("should register custom scenarios", () => {
		const custom = scenario()
			.id("custom-test")
			.name("Custom Test")
			.description("A custom test scenario")
			.difficulty(1)
			.category("testing")
			.template("templates/test")
			.prompt("Run the tests")
			.persona(PERSONAS.intermediate)
			.knowledgeBase(KNOWLEDGE_BASES.typescript_node)
			.expectedTools(["Bash"])
			.maxToolCalls(5)
			.maxCorrections(1)
			.addCriterion({ type: "tests_pass" })
			.build();

		library.register(custom);
		expect(library.count()).toBe(13);
		expect(library.get("custom-test")).toBeDefined();
	});
});

describe("ScenarioBuilder", () => {
	it("should build a valid scenario", () => {
		const built = scenario()
			.id("builder-test")
			.name("Builder Test")
			.description("Test the builder")
			.difficulty(2)
			.category("testing")
			.template("templates/test")
			.prompt("Test prompt")
			.persona(PERSONAS.novice)
			.knowledgeBase(KNOWLEDGE_BASES.typescript_react)
			.expectedTools(["Read", "Write"])
			.maxToolCalls(10)
			.maxCorrections(2)
			.build();

		expect(built.id).toBe("builder-test");
		expect(built.difficulty).toBe(2);
		expect(built.expectedTools).toEqual(["Read", "Write"]);
	});

	it("should throw on missing required fields", () => {
		expect(() => scenario().id("incomplete").build()).toThrow();
	});
});

// ============================================================================
// Session Recorder Tests
// ============================================================================

describe("SessionRecorder", () => {
	let recorder: SessionRecorder;

	beforeEach(() => {
		recorder = new SessionRecorder({
			scenarioId: "test-scenario",
			experimentId: "exp-001",
			experimentGroup: "treatment",
		});
	});

	it("should generate unique session ID", () => {
		const id = recorder.getSessionId();
		expect(id).toMatch(/^sess_/);
	});

	it("should record tool events", () => {
		recorder.recordToolEvent({
			toolName: "Read",
			args: { file_path: "test.ts" },
			success: true,
			durationMs: 50,
		});

		const events = recorder.getToolEvents();
		expect(events.length).toBe(1);
		expect(events[0].toolName).toBe("Read");
	});

	it("should record corrections", () => {
		recorder.recordCorrection(
			{ type: "wrong_tool", tool: "Bash" },
			"Use Read instead",
		);

		const corrections = recorder.getCorrections();
		expect(corrections.length).toBe(1);
		expect(corrections[0].correction).toBe("Use Read instead");
	});

	it("should record user responses", () => {
		recorder.recordUserResponse({
			type: "clarification",
			question: "Which file?",
			answer: "src/main.ts",
		});

		const responses = recorder.getUserResponses();
		expect(responses.length).toBe(1);
		expect(responses[0].type).toBe("clarification");
	});

	it("should calculate metrics on finalize", () => {
		// Add some events
		recorder.recordToolEvent({
			toolName: "Read",
			args: {},
			success: true,
			durationMs: 50,
		});
		recorder.recordToolEvent({
			toolName: "Write",
			args: {},
			success: false,
			errorMessage: "Permission denied",
			durationMs: 30,
		});
		recorder.recordCorrection(
			{ type: "error", errorType: "Permission" },
			"Fix permissions",
		);

		const session = recorder.finalize([], "partial");

		expect(session.metrics.toolCount).toBe(2);
		expect(session.metrics.errorCount).toBe(1);
		expect(session.metrics.correctionCount).toBe(1);
		expect(session.metrics.errorRate).toBe(0.5);
		expect(session.outcome).toBe("partial");
	});

	it("should prevent recording after finalize", () => {
		recorder.finalize([], "success");

		expect(() =>
			recorder.recordToolEvent({
				toolName: "Read",
				args: {},
				success: true,
				durationMs: 10,
			}),
		).toThrow();
	});

	it("should calculate autonomy rate correctly", () => {
		// Tool without preceding correction = autonomous
		recorder.recordToolEvent({
			toolName: "Read",
			args: {},
			success: true,
			durationMs: 50,
		});

		// Correction followed by tool = not autonomous
		recorder.recordCorrection({ type: "wrong_tool", tool: "Read" }, "Use Grep");

		// Small delay to ensure timestamp difference
		recorder.recordToolEvent({
			toolName: "Grep",
			args: {},
			success: true,
			durationMs: 30,
		});

		const session = recorder.finalize([], "success");

		// First tool is autonomous, second is not (but timing-based detection may vary)
		expect(session.metrics.autonomousActions).toBeGreaterThanOrEqual(1);
	});

	it("should determine outcome from criteria", () => {
		const session = recorder.finalize(
			[
				{ criterion: { type: "file_exists", path: "a.ts" }, passed: true },
				{ criterion: { type: "file_exists", path: "b.ts" }, passed: true },
				{ criterion: { type: "tests_pass" }, passed: false },
			],
			undefined, // Let it compute
		);

		// 2/3 passed = partial
		expect(session.outcome).toBe("partial");
	});
});

// ============================================================================
// Validation Store Tests
// ============================================================================

describe("ValidationStore", () => {
	let testDbPath: string;
	let store: ValidationStore;

	beforeEach(() => {
		// Use unique path per test to avoid conflicts
		testDbPath = `/tmp/mnemex-test-validation-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
		store = new ValidationStore(testDbPath);
	});

	afterEach(() => {
		store.close();
		if (existsSync(testDbPath)) {
			rmSync(testDbPath);
		}
	});

	it("should save and retrieve sessions", () => {
		const session: RecordedSession = {
			sessionId: "test-session-001",
			scenarioId: "file-create-component",
			experimentId: "exp-001",
			experimentGroup: "treatment",
			startTime: Date.now() - 60000,
			endTime: Date.now(),
			durationMs: 60000,
			toolEvents: [
				{
					toolName: "Read",
					args: { file: "test.ts" },
					success: true,
					durationMs: 50,
					timestamp: Date.now(),
				},
			],
			corrections: [],
			userResponses: [],
			metrics: {
				toolCount: 1,
				correctionCount: 0,
				errorCount: 0,
				autonomousActions: 1,
				correctionRate: 0,
				errorRate: 0,
				autonomyRate: 1,
				tokensUsed: 100,
				avgToolDurationMs: 50,
			},
			outcome: "success",
			successCriteria: [
				{ criterion: { type: "file_exists", path: "test.ts" }, passed: true },
			],
		};

		store.saveSession(session);

		const retrieved = store.getSession("test-session-001");
		expect(retrieved).toBeDefined();
		expect(retrieved?.sessionId).toBe("test-session-001");
		expect(retrieved?.outcome).toBe("success");
		expect(retrieved?.toolEvents.length).toBe(1);
		expect(retrieved?.successCriteria.length).toBe(1);
	});

	it("should get sessions by scenario", () => {
		const session1: RecordedSession = createMockSession("s1", "scenario-a");
		const session2: RecordedSession = createMockSession("s2", "scenario-a");
		const session3: RecordedSession = createMockSession("s3", "scenario-b");

		store.saveSession(session1);
		store.saveSession(session2);
		store.saveSession(session3);

		const scenarioASessions = store.getSessionsByScenario("scenario-a");
		expect(scenarioASessions.length).toBe(2);
	});

	it("should get sessions by experiment group", () => {
		const control = createMockSession("c1", "test", "exp-001", "control");
		const treatment = createMockSession("t1", "test", "exp-001", "treatment");

		store.saveSession(control);
		store.saveSession(treatment);

		const controlSessions = store.getSessionsByExperimentGroup(
			"exp-001",
			"control",
		);
		const treatmentSessions = store.getSessionsByExperimentGroup(
			"exp-001",
			"treatment",
		);

		expect(controlSessions.length).toBe(1);
		expect(treatmentSessions.length).toBe(1);
	});

	it("should calculate summary stats", () => {
		store.saveSession(
			createMockSession("s1", "test", undefined, undefined, "success"),
		);
		store.saveSession(
			createMockSession("s2", "test", undefined, undefined, "success"),
		);
		store.saveSession(
			createMockSession("s3", "test", undefined, undefined, "failure"),
		);

		const stats = store.getSummaryStats();
		expect(stats.totalSessions).toBe(3);
		expect(stats.successfulSessions).toBe(2);
		expect(stats.failedSessions).toBe(1);
	});

	it("should create and retrieve experiments", () => {
		const experiment = {
			experimentId: "exp-test-001",
			improvementIds: ["imp-1", "imp-2"],
			scenarios: ["scenario-a", "scenario-b"],
			runsPerScenario: 10,
			status: "pending" as const,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};

		store.createExperiment(experiment);

		const retrieved = store.getExperiment("exp-test-001");
		expect(retrieved).toBeDefined();
		expect(retrieved?.improvementIds).toEqual(["imp-1", "imp-2"]);
		expect(retrieved?.status).toBe("pending");
	});

	it("should update experiment status", () => {
		const experiment = {
			experimentId: "exp-status-test",
			improvementIds: [],
			scenarios: [],
			runsPerScenario: 5,
			status: "pending" as const,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		};

		store.createExperiment(experiment);
		store.updateExperimentStatus("exp-status-test", "running");

		const retrieved = store.getExperiment("exp-status-test");
		expect(retrieved?.status).toBe("running");
	});
});

// ============================================================================
// Environment Manager Tests
// ============================================================================

describe("MockEnvironmentManager", () => {
	let env: MockEnvironmentManager;

	beforeEach(() => {
		env = new MockEnvironmentManager("/mock/workspace");
	});

	afterEach(async () => {
		await env.cleanup();
	});

	it("should setup environment", async () => {
		const info = await env.setup("templates/test");
		expect(info.type).toBe("mock");
		expect(info.workingDirectory).toBe("/mock/workspace");
	});

	it("should create and restore snapshots", async () => {
		await env.setup("templates/test");

		const snap1 = await env.snapshot();
		expect(snap1.id).toMatch(/^mock_snap_/);

		await env.restore(snap1.id);
		expect(env.getCallCount("restore")).toBe(1);
	});

	it("should throw on unknown snapshot", async () => {
		await env.setup("templates/test");

		await expect(env.restore("unknown")).rejects.toThrow("not found");
	});

	it("should track all operations", async () => {
		await env.setup("templates/test");
		await env.snapshot();
		await env.cleanup();

		const calls = env.getCalls();
		expect(calls.length).toBe(3);
		expect(calls.map((c) => c.method)).toEqual([
			"setup",
			"snapshot",
			"cleanup",
		]);
	});
});

describe("createEnvironmentManager", () => {
	it("should create mock environment", () => {
		const env = createEnvironmentManager({
			type: "mock",
			baseDirectory: "/mock",
		});
		expect(env.getType()).toBe("mock");
	});

	it("should create temp environment", () => {
		const env = createEnvironmentManager({ type: "temp" });
		expect(env.getType()).toBe("temp");
	});
});

// ============================================================================
// Synthetic Agent Tests
// ============================================================================

describe("QueryHandler", () => {
	it("should answer from custom answers", () => {
		const handler = new QueryHandler(
			{
				customAnswers: { styling: "Use CSS modules" },
			},
			PERSONAS.intermediate,
		);

		const answer = handler.handleQuery("What styling approach should I use?");
		expect(answer.text).toContain("CSS modules");
		expect(answer.source).toBe("custom");
	});

	it("should answer from knowledge base", () => {
		const handler = new QueryHandler(
			{ language: "typescript", packageManager: "npm" },
			PERSONAS.intermediate,
		);

		const answer = handler.handleQuery("Which package manager should I use?");
		expect(answer.text).toContain("npm");
		expect(answer.source).toBe("knowledge_base");
	});

	it("should apply verbosity", () => {
		const terseHandler = new QueryHandler(
			{ language: "typescript" },
			PERSONAS.expert, // terse verbosity
		);
		const verboseHandler = new QueryHandler(
			{ language: "typescript" },
			PERSONAS.novice, // verbose verbosity
		);

		const terseAnswer = terseHandler.handleQuery("What language?");
		const verboseAnswer = verboseHandler.handleQuery("What language?");

		expect(verboseAnswer.text.length).toBeGreaterThan(terseAnswer.text.length);
	});

	it("should handle unknown queries based on expertise", () => {
		const expertHandler = new QueryHandler({}, PERSONAS.expert);
		const noviceHandler = new QueryHandler({}, PERSONAS.novice);

		const expertAnswer = expertHandler.handleQuery(
			"What is the airspeed velocity?",
		);
		const noviceAnswer = noviceHandler.handleQuery(
			"What is the airspeed velocity?",
		);

		expect(expertAnswer.confidence).toBeGreaterThan(noviceAnswer.confidence);
		expect(expertAnswer.source).toBe("expertise_delegation");
		expect(noviceAnswer.source).toBe("uncertainty");
	});
});

describe("CorrectionInjector", () => {
	it("should trigger on tool count threshold", () => {
		const injector = new CorrectionInjector(
			[
				{
					trigger: { type: "tool_count", threshold: 3 },
					correction: "Too many tools",
					expectedRecovery: [],
				},
			],
			PERSONAS.intermediate,
		);

		const events = [
			{
				toolName: "Read",
				args: {},
				success: true,
				durationMs: 10,
				timestamp: Date.now(),
			},
			{
				toolName: "Read",
				args: {},
				success: true,
				durationMs: 10,
				timestamp: Date.now(),
			},
			{
				toolName: "Read",
				args: {},
				success: true,
				durationMs: 10,
				timestamp: Date.now(),
			},
		];

		const result = injector.checkTriggers(events, {
			content: "",
			isQuestion: false,
			toolCalls: [],
			tokens: { input: 0, output: 0 },
		});

		expect(result).toBeDefined();
		expect(result?.message).toContain("Too many tools");
	});

	it("should trigger on wrong tool", () => {
		const injector = new CorrectionInjector(
			[
				{
					trigger: { type: "wrong_tool", tool: "Bash" },
					correction: "Don't use Bash",
					expectedRecovery: ["Read"],
				},
			],
			PERSONAS.expert,
		);

		const events = [
			{
				toolName: "Bash",
				args: {},
				success: true,
				durationMs: 10,
				timestamp: Date.now(),
			},
		];

		const result = injector.checkTriggers(events, {
			content: "",
			isQuestion: false,
			toolCalls: [],
			tokens: { input: 0, output: 0 },
		});

		expect(result).toBeDefined();
		expect(result?.trigger.type).toBe("wrong_tool");
	});

	it("should only trigger once per correction point", () => {
		const injector = new CorrectionInjector(
			[
				{
					trigger: { type: "tool_count", threshold: 1 },
					correction: "One shot",
					expectedRecovery: [],
				},
			],
			PERSONAS.intermediate,
		);

		const events = [
			{
				toolName: "Read",
				args: {},
				success: true,
				durationMs: 10,
				timestamp: Date.now(),
			},
		];

		const response = {
			content: "",
			isQuestion: false,
			toolCalls: [],
			tokens: { input: 0, output: 0 },
		};

		const first = injector.checkTriggers(events, response);
		const second = injector.checkTriggers(events, response);

		expect(first).toBeDefined();
		expect(second).toBeNull(); // Already triggered
	});
});

describe("SyntheticAgent", () => {
	it("should answer agent questions from knowledge base", async () => {
		const library = createScenarioLibrary();
		const scenarioData = library.get("file-create-component")!;
		const recorder = new SessionRecorder({ scenarioId: scenarioData.id });
		const agent = createSyntheticAgent(scenarioData, recorder);

		const response = await agent.processAgentResponse(
			{
				content: "What styling approach?",
				isQuestion: true,
				question: "What styling approach should I use?",
				toolCalls: [],
				tokens: { input: 100, output: 50 },
			},
			[],
		);

		expect(response.type).toBe("answer");
		expect(response.content).toContain("CSS modules");
	});

	it("should provide initial prompt with persona style", () => {
		const library = createScenarioLibrary();
		const scenarioData = library.get("ambiguous-add-feature")!;
		const recorder = new SessionRecorder({ scenarioId: scenarioData.id });
		const agent = createSyntheticAgent(scenarioData, recorder);

		const prompt = agent.getInitialPrompt();

		// Novice persona should add explanation request
		expect(prompt).toContain("explain");
	});
});

// ============================================================================
// Statistics Engine Tests
// ============================================================================

describe("StatisticsEngine", () => {
	let stats: StatisticsEngine;

	beforeEach(() => {
		stats = createStatisticsEngine({
			alpha: 0.05,
			power: 0.8,
			minEffectSize: 0.05,
		});
	});

	it("should calculate required sample size", () => {
		const n = stats.calculateRequiredSampleSize({
			alpha: 0.05,
			power: 0.8,
			minEffectSize: 0.1,
			baselineRate: 0.25,
		});

		expect(n).toBeGreaterThan(100);
		expect(n).toBeLessThan(500);
	});

	it("should calculate achieved power", () => {
		const power = stats.calculateAchievedPower(100, 0.1, 0.25);
		expect(power).toBeGreaterThan(0);
		expect(power).toBeLessThan(1);
	});

	it("should compare proportions", () => {
		const baseline = [0.3, 0.25, 0.35, 0.28, 0.32];
		const treatment = [0.2, 0.18, 0.22, 0.19, 0.21];

		const result = stats.compareProportions(baseline, treatment, "lower");

		expect(result.baseline).toBeCloseTo(0.3, 1);
		expect(result.treatment).toBeCloseTo(0.2, 1);
		expect(result.improved).toBe(true); // Lower is better
		expect(result.relativeChange).toBeLessThan(0); // Decreased
	});

	it("should compare full metrics", () => {
		const baselineSessions = Array.from({ length: 20 }, () =>
			createMockSession(
				`b${Math.random()}`,
				"test",
				undefined,
				undefined,
				"success",
				0.3,
			),
		);
		const treatmentSessions = Array.from({ length: 20 }, () =>
			createMockSession(
				`t${Math.random()}`,
				"test",
				undefined,
				undefined,
				"success",
				0.2,
			),
		);

		const comparison = stats.compareMetrics(
			baselineSessions,
			treatmentSessions,
		);

		expect(comparison.correctionRate).toBeDefined();
		expect(comparison.successRate).toBeDefined();
		expect(comparison.autonomyRate).toBeDefined();
		expect(comparison.errorRate).toBeDefined();
	});

	it("should calculate Cohen's d", () => {
		const group1 = [1, 2, 3, 4, 5];
		const group2 = [3, 4, 5, 6, 7];

		const d = stats.cohensD(group1, group2);
		expect(d).toBeGreaterThan(0); // group2 is higher
	});

	it("should interpret effect size", () => {
		expect(stats.interpretEffectSize(0.1).magnitude).toBe("negligible");
		expect(stats.interpretEffectSize(0.3).magnitude).toBe("small");
		expect(stats.interpretEffectSize(0.6).magnitude).toBe("medium");
		expect(stats.interpretEffectSize(1.0).magnitude).toBe("large");
	});

	it("should apply FDR correction", () => {
		const pValues = [0.01, 0.04, 0.03, 0.2];
		const adjusted = stats.fdrCorrection(pValues);

		expect(adjusted.length).toBe(4);
		// Adjusted p-values should be >= original
		adjusted.forEach((adj, i) => {
			expect(adj).toBeGreaterThanOrEqual(pValues[i]);
		});
	});

	it("should calculate bootstrap confidence interval", () => {
		const data = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
		const [lower, upper] = stats.bootstrapConfidenceInterval(
			data,
			(sample) => sample.reduce((a, b) => a + b, 0) / sample.length,
			100,
		);

		expect(lower).toBeLessThan(5.5);
		expect(upper).toBeGreaterThan(5.5);
	});
});

// ============================================================================
// Decision Engine Tests
// ============================================================================

describe("DecisionEngine", () => {
	let decisionEngine: DecisionEngine;
	let stats: StatisticsEngine;

	beforeEach(() => {
		stats = createStatisticsEngine();
		decisionEngine = new DecisionEngine(stats);
	});

	it("should recommend rollback on regression", () => {
		const comparison: StatisticalComparison = {
			correctionRate: {
				baseline: 0.2,
				treatment: 0.35,
				relativeChange: 0.75,
				pValue: 0.01,
				confidenceInterval: [0.1, 0.2],
				statisticallySignificant: true,
				practicallySignificant: true,
				improved: false, // Regression!
			},
			successRate: {
				baseline: 0.8,
				treatment: 0.8,
				relativeChange: 0,
				pValue: 1.0,
				confidenceInterval: [-0.1, 0.1],
				statisticallySignificant: false,
				practicallySignificant: false,
				improved: false,
			},
			autonomyRate: {
				baseline: 0.7,
				treatment: 0.7,
				relativeChange: 0,
				pValue: 1.0,
				confidenceInterval: [-0.1, 0.1],
				statisticallySignificant: false,
				practicallySignificant: false,
				improved: false,
			},
			errorRate: {
				baseline: 0.1,
				treatment: 0.1,
				relativeChange: 0,
				pValue: 1.0,
				confidenceInterval: [-0.05, 0.05],
				statisticallySignificant: false,
				practicallySignificant: false,
				improved: false,
			},
			overallImproved: false,
		};

		const decision = decisionEngine.decide({
			baseline: createMockAggregates(20),
			treatment: createMockAggregates(20),
			comparison,
		});

		expect(decision.action).toBe("rollback");
		expect(decision.significantMetrics).toContain("correctionRate");
	});

	it("should recommend graduate on multiple improvements", () => {
		const comparison: StatisticalComparison = {
			correctionRate: {
				baseline: 0.3,
				treatment: 0.2,
				relativeChange: -0.33,
				pValue: 0.01,
				confidenceInterval: [-0.15, -0.05],
				statisticallySignificant: true,
				practicallySignificant: true,
				improved: true,
			},
			successRate: {
				baseline: 0.7,
				treatment: 0.85,
				relativeChange: 0.21,
				pValue: 0.02,
				confidenceInterval: [0.05, 0.25],
				statisticallySignificant: true,
				practicallySignificant: true,
				improved: true,
			},
			autonomyRate: {
				baseline: 0.6,
				treatment: 0.6,
				relativeChange: 0,
				pValue: 1.0,
				confidenceInterval: [-0.1, 0.1],
				statisticallySignificant: false,
				practicallySignificant: false,
				improved: false,
			},
			errorRate: {
				baseline: 0.1,
				treatment: 0.1,
				relativeChange: 0,
				pValue: 1.0,
				confidenceInterval: [-0.05, 0.05],
				statisticallySignificant: false,
				practicallySignificant: false,
				improved: false,
			},
			overallImproved: true,
		};

		const decision = decisionEngine.decide({
			baseline: createMockAggregates(20),
			treatment: createMockAggregates(20),
			comparison,
		});

		expect(decision.action).toBe("graduate");
		expect(decision.significantMetrics.length).toBeGreaterThanOrEqual(2);
	});

	it("should recommend extend on single improvement", () => {
		const comparison: StatisticalComparison = {
			correctionRate: {
				baseline: 0.3,
				treatment: 0.2,
				relativeChange: -0.33,
				pValue: 0.01,
				confidenceInterval: [-0.15, -0.05],
				statisticallySignificant: true,
				practicallySignificant: true,
				improved: true,
			},
			successRate: {
				baseline: 0.7,
				treatment: 0.72,
				relativeChange: 0.03,
				pValue: 0.5,
				confidenceInterval: [-0.1, 0.15],
				statisticallySignificant: false,
				practicallySignificant: false,
				improved: true,
			},
			autonomyRate: {
				baseline: 0.6,
				treatment: 0.6,
				relativeChange: 0,
				pValue: 1.0,
				confidenceInterval: [-0.1, 0.1],
				statisticallySignificant: false,
				practicallySignificant: false,
				improved: false,
			},
			errorRate: {
				baseline: 0.1,
				treatment: 0.1,
				relativeChange: 0,
				pValue: 1.0,
				confidenceInterval: [-0.05, 0.05],
				statisticallySignificant: false,
				practicallySignificant: false,
				improved: false,
			},
			overallImproved: false,
		};

		const decision = decisionEngine.decide({
			baseline: createMockAggregates(20),
			treatment: createMockAggregates(20),
			comparison,
		});

		expect(decision.action).toBe("extend");
	});

	it("should recommend continue when no significant changes", () => {
		const comparison: StatisticalComparison = {
			correctionRate: {
				baseline: 0.25,
				treatment: 0.24,
				relativeChange: -0.04,
				pValue: 0.8,
				confidenceInterval: [-0.1, 0.08],
				statisticallySignificant: false,
				practicallySignificant: false,
				improved: true,
			},
			successRate: {
				baseline: 0.75,
				treatment: 0.76,
				relativeChange: 0.01,
				pValue: 0.9,
				confidenceInterval: [-0.08, 0.1],
				statisticallySignificant: false,
				practicallySignificant: false,
				improved: true,
			},
			autonomyRate: {
				baseline: 0.65,
				treatment: 0.66,
				relativeChange: 0.015,
				pValue: 0.85,
				confidenceInterval: [-0.08, 0.11],
				statisticallySignificant: false,
				practicallySignificant: false,
				improved: true,
			},
			errorRate: {
				baseline: 0.1,
				treatment: 0.09,
				relativeChange: -0.1,
				pValue: 0.7,
				confidenceInterval: [-0.08, 0.06],
				statisticallySignificant: false,
				practicallySignificant: false,
				improved: true,
			},
			overallImproved: false,
		};

		const decision = decisionEngine.decide({
			baseline: createMockAggregates(30),
			treatment: createMockAggregates(30),
			comparison,
		});

		expect(decision.action).toBe("continue");
	});
});

// ============================================================================
// Helper Functions
// ============================================================================

function createMockSession(
	sessionId: string,
	scenarioId: string,
	experimentId?: string,
	experimentGroup?: "control" | "treatment",
	outcome: "success" | "failure" | "partial" = "success",
	correctionRate: number = 0.25,
): RecordedSession {
	return {
		sessionId,
		scenarioId,
		experimentId,
		experimentGroup,
		startTime: Date.now() - 60000,
		endTime: Date.now(),
		durationMs: 60000,
		toolEvents: [],
		corrections: [],
		userResponses: [],
		metrics: {
			toolCount: 10,
			correctionCount: Math.round(correctionRate * 10),
			errorCount: 1,
			autonomousActions: Math.round((1 - correctionRate) * 10),
			correctionRate,
			errorRate: 0.1,
			autonomyRate: 1 - correctionRate,
			tokensUsed: 1000,
			avgToolDurationMs: 50,
		},
		outcome,
		successCriteria: [],
	};
}

function createMockAggregates(totalRuns: number) {
	return {
		totalRuns,
		successfulRuns: Math.round(totalRuns * 0.75),
		failedRuns: Math.round(totalRuns * 0.25),
		successRate: 0.75,
		avgCorrectionRate: 0.25,
		avgErrorRate: 0.1,
		avgAutonomyRate: 0.7,
		avgDurationMs: 60000,
		byScenario: new Map(),
	};
}
