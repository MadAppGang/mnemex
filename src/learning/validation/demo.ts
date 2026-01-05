#!/usr/bin/env bun
/**
 * E2E Validation System Demo
 *
 * Demonstrates the core components working together.
 */

import {
  // Scenario Library
  createScenarioLibrary,
  PERSONAS,
  KNOWLEDGE_BASES,

  // Session Recording
  SessionRecorder,
  CriteriaEvaluator,

  // Validation Store
  ValidationStore,

  // Environment Manager
  TempEnvironmentManager,
  MockEnvironmentManager,

  // Synthetic Agent
  createSyntheticAgent,

  // Statistics
  StatisticsEngine,

  // Experiment Engine
  DecisionEngine,
} from "./index.js";

import type { RecordedSession, StatisticalComparison } from "./types.js";

// ============================================================================
// Demo: Scenario Library
// ============================================================================

console.log("═".repeat(60));
console.log("📚 SCENARIO LIBRARY DEMO");
console.log("═".repeat(60));

const library = createScenarioLibrary();
console.log(`\nLoaded ${library.count()} built-in scenarios:\n`);

const scenarios = library.getAll();
for (const scenario of scenarios) {
  console.log(`  [${scenario.difficulty}⭐] ${scenario.id}`);
  console.log(`      Category: ${scenario.category}`);
  console.log(`      ${scenario.description.slice(0, 60)}...`);
  console.log();
}

// Show by category
console.log("\n📊 Scenarios by Category:");
const categories = ["file_operations", "code_search", "debugging", "security", "ambiguous"] as const;
for (const cat of categories) {
  const count = library.getByCategory(cat).length;
  console.log(`  ${cat}: ${count} scenario(s)`);
}

// ============================================================================
// Demo: Session Recorder
// ============================================================================

console.log("\n" + "═".repeat(60));
console.log("📝 SESSION RECORDER DEMO");
console.log("═".repeat(60));

const recorder = new SessionRecorder({
  scenarioId: "file-create-component",
  experimentId: "exp_demo_001",
  experimentGroup: "treatment",
});

// Simulate some tool events
console.log("\nSimulating validation session...\n");

recorder.recordToolEvent({
  toolName: "Glob",
  args: { pattern: "src/components/**/*.tsx" },
  success: true,
  durationMs: 45,
});
console.log("  ✓ Recorded: Glob tool call");

recorder.recordToolEvent({
  toolName: "Read",
  args: { file_path: "src/components/Button.tsx" },
  success: false,
  errorMessage: "File not found",
  durationMs: 12,
});
console.log("  ✓ Recorded: Read tool call (failed)");

recorder.recordCorrection(
  { type: "file_not_found", pattern: "Button.tsx" },
  "The file should be in src/components/Button.tsx"
);
console.log("  ✓ Recorded: Correction injected");

recorder.recordToolEvent({
  toolName: "Write",
  args: { file_path: "src/components/Button.tsx" },
  success: true,
  durationMs: 89,
});
console.log("  ✓ Recorded: Write tool call");

recorder.recordUserResponse({
  type: "acknowledgment",
  answer: "Looks good, continue.",
});
console.log("  ✓ Recorded: User response");

// Get current state
const snapshot = recorder.getCurrentState();
console.log("\n📊 Session Snapshot:");
console.log(`  Session ID: ${snapshot.sessionId}`);
console.log(`  Elapsed: ${snapshot.elapsedMs}ms`);
console.log(`  Tool calls: ${snapshot.toolEventCount}`);
console.log(`  Corrections: ${snapshot.correctionCount}`);
console.log(`  Errors: ${snapshot.errorCount}`);

// Finalize
const session = recorder.finalize([
  { criterion: { type: "file_exists", path: "src/components/Button.tsx" }, passed: true },
  { criterion: { type: "file_contains", path: "src/components/Button.tsx", pattern: "interface.*Props" }, passed: true },
], "success");

console.log("\n✅ Session Finalized:");
console.log(`  Outcome: ${session.outcome}`);
console.log(`  Duration: ${session.durationMs}ms`);
console.log(`  Metrics:`);
console.log(`    - Tool count: ${session.metrics.toolCount}`);
console.log(`    - Correction rate: ${(session.metrics.correctionRate * 100).toFixed(1)}%`);
console.log(`    - Error rate: ${(session.metrics.errorRate * 100).toFixed(1)}%`);
console.log(`    - Autonomy rate: ${(session.metrics.autonomyRate * 100).toFixed(1)}%`);

// ============================================================================
// Demo: Statistics Engine
// ============================================================================

console.log("\n" + "═".repeat(60));
console.log("📈 STATISTICS ENGINE DEMO");
console.log("═".repeat(60));

const stats = new StatisticsEngine({
  alpha: 0.05,
  power: 0.80,
  minEffectSize: 0.05,
});

// Power analysis
console.log("\n🔬 Power Analysis:");
const requiredN = stats.calculateRequiredSampleSize({
  alpha: 0.05,
  power: 0.80,
  minEffectSize: 0.10, // 10% improvement
  baselineRate: 0.25,  // 25% baseline correction rate
});
console.log(`  To detect 10% improvement from 25% baseline:`);
console.log(`  Required sample size: ${requiredN} per group`);

const achievedPower = stats.calculateAchievedPower(50, 0.10, 0.25);
console.log(`  With n=50, achieved power: ${(achievedPower * 100).toFixed(1)}%`);

// Simulate A/B comparison
console.log("\n📊 Simulated A/B Comparison:");

// Create mock sessions for comparison
const createMockSession = (correctionRate: number, success: boolean): RecordedSession => ({
  sessionId: `sess_${Math.random().toString(36).slice(2)}`,
  scenarioId: "test",
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
  outcome: success ? "success" : "failure",
  successCriteria: [],
});

// Baseline: 30% correction rate, 70% success
const baselineSessions = Array.from({ length: 30 }, () =>
  createMockSession(0.25 + Math.random() * 0.10, Math.random() > 0.30)
);

// Treatment: 20% correction rate, 80% success (improved)
const treatmentSessions = Array.from({ length: 30 }, () =>
  createMockSession(0.15 + Math.random() * 0.10, Math.random() > 0.20)
);

const comparison = stats.compareMetrics(baselineSessions, treatmentSessions);

console.log("\n  Correction Rate:");
console.log(`    Baseline: ${(comparison.correctionRate.baseline * 100).toFixed(1)}%`);
console.log(`    Treatment: ${(comparison.correctionRate.treatment * 100).toFixed(1)}%`);
console.log(`    Change: ${(comparison.correctionRate.relativeChange * 100).toFixed(1)}%`);
console.log(`    p-value: ${comparison.correctionRate.pValue.toFixed(4)}`);
console.log(`    Significant: ${comparison.correctionRate.statisticallySignificant ? "✅ Yes" : "❌ No"}`);
console.log(`    Improved: ${comparison.correctionRate.improved ? "✅ Yes" : "❌ No"}`);

console.log("\n  Success Rate:");
console.log(`    Baseline: ${(comparison.successRate.baseline * 100).toFixed(1)}%`);
console.log(`    Treatment: ${(comparison.successRate.treatment * 100).toFixed(1)}%`);
console.log(`    Change: ${(comparison.successRate.relativeChange * 100).toFixed(1)}%`);
console.log(`    p-value: ${comparison.successRate.pValue.toFixed(4)}`);
console.log(`    Significant: ${comparison.successRate.statisticallySignificant ? "✅ Yes" : "❌ No"}`);

console.log(`\n  Overall Improved: ${comparison.overallImproved ? "✅ Yes" : "❌ No"}`);

// ============================================================================
// Demo: Decision Engine
// ============================================================================

console.log("\n" + "═".repeat(60));
console.log("🎯 DECISION ENGINE DEMO");
console.log("═".repeat(60));

const decisionEngine = new DecisionEngine(stats);

// Calculate aggregates for decision
const calculateAggregates = (sessions: RecordedSession[]) => ({
  totalRuns: sessions.length,
  successfulRuns: sessions.filter(s => s.outcome === "success").length,
  failedRuns: sessions.filter(s => s.outcome === "failure").length,
  successRate: sessions.filter(s => s.outcome === "success").length / sessions.length,
  avgCorrectionRate: sessions.reduce((sum, s) => sum + s.metrics.correctionRate, 0) / sessions.length,
  avgErrorRate: sessions.reduce((sum, s) => sum + s.metrics.errorRate, 0) / sessions.length,
  avgAutonomyRate: sessions.reduce((sum, s) => sum + s.metrics.autonomyRate, 0) / sessions.length,
  avgDurationMs: sessions.reduce((sum, s) => sum + s.durationMs, 0) / sessions.length,
  byScenario: new Map(),
});

const decision = decisionEngine.decide({
  baseline: calculateAggregates(baselineSessions),
  treatment: calculateAggregates(treatmentSessions),
  comparison,
});

console.log("\n📋 Experiment Decision:");
console.log(`  Action: ${decision.action.toUpperCase()}`);
console.log(`  Confidence: ${(decision.confidence * 100).toFixed(1)}%`);
console.log(`  Reason: ${decision.reason}`);
if (decision.significantMetrics.length > 0) {
  console.log(`  Significant Metrics: ${decision.significantMetrics.join(", ")}`);
}

// ============================================================================
// Demo: Synthetic Agent
// ============================================================================

console.log("\n" + "═".repeat(60));
console.log("🤖 SYNTHETIC AGENT DEMO");
console.log("═".repeat(60));

const scenario = library.get("ambiguous-add-feature")!;
const agentRecorder = new SessionRecorder({ scenarioId: scenario.id });
const syntheticAgent = createSyntheticAgent(scenario, agentRecorder);

console.log(`\nScenario: ${scenario.name}`);
console.log(`Persona: ${scenario.persona.expertiseLevel} (${scenario.persona.correctionStyle})`);
console.log(`\nInitial Prompt:`);
console.log(`  "${syntheticAgent.getInitialPrompt()}"`);

// Simulate agent asking a question
console.log("\n🔄 Simulating Agent Interaction:");
console.log("\n  Agent asks: 'What aspect would you like me to improve?'");

const response = await syntheticAgent.processAgentResponse(
  {
    content: "I can help improve the app. What aspect would you like me to focus on?",
    isQuestion: true,
    question: "What aspect would you like me to improve?",
    toolCalls: [],
    tokens: { input: 100, output: 50 },
  },
  []
);

console.log(`\n  Synthetic User (${scenario.persona.expertiseLevel}):`);
console.log(`    Type: ${response.type}`);
console.log(`    Response: "${response.content}"`);
console.log(`    Continue: ${response.shouldContinue}`);

// ============================================================================
// Demo: Environment Manager
// ============================================================================

console.log("\n" + "═".repeat(60));
console.log("🗂️  ENVIRONMENT MANAGER DEMO");
console.log("═".repeat(60));

const mockEnv = new MockEnvironmentManager("/mock/workspace");

console.log("\n📁 Mock Environment Operations:");

await mockEnv.setup("templates/react-app");
console.log("  ✓ Setup environment from template");

const snap1 = await mockEnv.snapshot();
console.log(`  ✓ Created snapshot: ${snap1.id}`);

const snap2 = await mockEnv.snapshot();
console.log(`  ✓ Created snapshot: ${snap2.id}`);

await mockEnv.restore(snap1.id);
console.log(`  ✓ Restored to snapshot: ${snap1.id}`);

console.log(`\n📊 Call History:`);
for (const call of mockEnv.getCalls()) {
  console.log(`  - ${call.method}(${JSON.stringify(call.args)})`);
}

await mockEnv.cleanup();
console.log("\n  ✓ Cleanup complete");

// ============================================================================
// Demo: Validation Store
// ============================================================================

console.log("\n" + "═".repeat(60));
console.log("💾 VALIDATION STORE DEMO");
console.log("═".repeat(60));

const dbPath = "/tmp/claudemem-validation-demo.db";
const store = new ValidationStore(dbPath);

console.log(`\nDatabase: ${dbPath}`);

// Save the session we created earlier
store.saveSession(session);
console.log("  ✓ Saved session to database");

// Retrieve it
const retrieved = store.getSession(session.sessionId);
console.log(`  ✓ Retrieved session: ${retrieved?.sessionId}`);
console.log(`    Outcome: ${retrieved?.outcome}`);
console.log(`    Criteria passed: ${retrieved?.successCriteria.filter(c => c.passed).length}/${retrieved?.successCriteria.length}`);

// Get summary stats
const summaryStats = store.getSummaryStats();
console.log("\n📊 Summary Stats:");
console.log(`  Total sessions: ${summaryStats.totalSessions}`);
console.log(`  Successful: ${summaryStats.successfulSessions}`);
console.log(`  Avg correction rate: ${(summaryStats.avgCorrectionRate * 100).toFixed(1)}%`);

store.close();
console.log("\n  ✓ Database closed");

// ============================================================================
// Summary
// ============================================================================

console.log("\n" + "═".repeat(60));
console.log("✅ E2E VALIDATION SYSTEM DEMO COMPLETE");
console.log("═".repeat(60));
console.log(`
Components demonstrated:
  ✓ ScenarioLibrary - 12 built-in validation scenarios
  ✓ SessionRecorder - Event recording and metrics
  ✓ StatisticsEngine - Power analysis and hypothesis testing
  ✓ DecisionEngine - Graduate/rollback decisions
  ✓ SyntheticAgent - User simulation with personas
  ✓ EnvironmentManager - Test isolation
  ✓ ValidationStore - SQLite persistence

The system is ready for integration with actual agent drivers!
`);
