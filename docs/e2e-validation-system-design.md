# End-to-End Validation System for Continuous Learning

## Executive Summary

This document designs an **automated validation system** where synthetic AI agents simulate real users to measure the efficiency of continuous learning improvements. The system uses **record/replay** patterns combined with **A/B testing** to provide statistically rigorous validation.

**Key Innovation**: Instead of waiting for real user sessions (slow, noisy), we run controlled synthetic scenarios that exercise the agent's capabilities before and after improvements, providing fast, reproducible feedback.

---

## Research Foundation

### Industry Best Practices (2025)

| Approach | Source | Key Insight |
|----------|--------|-------------|
| **AgentRR (Record & Replay)** | [arXiv 2505.17716](https://arxiv.org/abs/2505.17716) | Record agent traces, replay to validate consistency |
| **τ-Bench** | [Sierra AI](https://sierra.ai/blog/benchmarking-ai-agents) | LLM-based user simulators + programmatic APIs |
| **RAISE** | [OpenReview](https://openreview.net/pdf?id=53oRwdZe6k) | High-fidelity synthetic traces via coordinated models |
| **OpenTelemetry GenAI** | [OpenTelemetry](https://opentelemetry.io/blog/2025/ai-agent-observability/) | Session tracking, spans, conversation IDs |
| **Langfuse Sessions** | [Langfuse](https://langfuse.com/blog/2024-07-ai-agent-observability-with-langfuse) | Multi-turn session evaluation, LLM-as-judge |
| **Multi-Armed Bandits** | [Omniconvert](https://www.omniconvert.com/blog/ai-ab-testing/) | Dynamic traffic allocation to winning variants |
| **Bloom** | [Anthropic](https://alignment.anthropic.com/2025/bloom-auto-evals/) | Agentic framework for automated behavioral evaluations |

### Key Metrics for Validation

Based on research, these metrics are critical for measuring improvement effectiveness:

| Metric | Description | Direction | Weight |
|--------|-------------|-----------|--------|
| **Correction Rate** | User corrections / Total actions | ↓ Decrease | 0.30 |
| **Autonomy Rate** | Autonomous completions / Total tasks | ↑ Increase | 0.25 |
| **Error Rate** | Tool errors / Total tool calls | ↓ Decrease | 0.20 |
| **Task Success Rate** | Successful scenarios / Total runs | ↑ Increase | 0.15 |
| **Efficiency** | Tokens used, time taken | ↓ Decrease | 0.10 |

### Statistical Rigor Requirements

> **Added based on multi-model review consensus (6/8 models flagged)**

#### Power Analysis & Sample Size

Before running experiments, calculate required sample size to detect meaningful effects:

```typescript
// src/learning/validation/statistics.ts

export interface PowerAnalysisConfig {
  alpha: number;              // Significance level (default: 0.05)
  power: number;              // Target power (default: 0.80)
  minEffectSize: number;      // Minimum detectable effect (default: 0.05 = 5%)
  baselineRate: number;       // Expected baseline metric value
}

/**
 * Calculate required sample size per group for two-proportion z-test.
 * Uses formula: n = 2 * ((z_α + z_β)² * p̄(1-p̄)) / (p1 - p2)²
 */
export function calculateRequiredSampleSize(config: PowerAnalysisConfig): number {
  const { alpha, power, minEffectSize, baselineRate } = config;

  const zAlpha = normalQuantile(1 - alpha / 2);  // Two-tailed
  const zBeta = normalQuantile(power);

  const p1 = baselineRate;
  const p2 = baselineRate * (1 - minEffectSize);  // Expected improvement
  const pBar = (p1 + p2) / 2;

  const n = 2 * Math.pow(zAlpha + zBeta, 2) * pBar * (1 - pBar) / Math.pow(p1 - p2, 2);

  return Math.ceil(n);
}

// Default config: 80% power to detect 5% improvement at p<0.05
export const DEFAULT_POWER_CONFIG: PowerAnalysisConfig = {
  alpha: 0.05,
  power: 0.80,
  minEffectSize: 0.05,
  baselineRate: 0.15,  // Assume 15% baseline correction rate
};

// With defaults: ~620 samples per group needed
// For 10 scenarios: 62 runs per scenario per group
```

#### Multiple Testing Correction (Bonferroni/FDR)

When comparing multiple metrics, adjust p-values to control false discovery:

```typescript
export interface StatisticalConfig {
  alpha: number;                                    // Base significance (0.05)
  multipleTestingCorrection: 'bonferroni' | 'fdr' | 'none';
  minEffectSize: number;                           // Minimum practical significance
  confidenceLevel: number;                         // For confidence intervals (0.95)
}

/**
 * Apply Bonferroni correction for multiple comparisons.
 */
export function bonferroniCorrection(pValues: number[], alpha: number): boolean[] {
  const adjustedAlpha = alpha / pValues.length;
  return pValues.map(p => p < adjustedAlpha);
}

/**
 * Apply Benjamini-Hochberg FDR correction (less conservative).
 */
export function fdrCorrection(pValues: number[], alpha: number): boolean[] {
  const n = pValues.length;
  const sorted = pValues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);

  const significant = new Array(n).fill(false);
  for (let k = n; k >= 1; k--) {
    const threshold = (k / n) * alpha;
    if (sorted[k - 1].p <= threshold) {
      // All p-values up to k are significant
      for (let j = 0; j < k; j++) {
        significant[sorted[j].i] = true;
      }
      break;
    }
  }
  return significant;
}
```

#### Effect Size Requirements

Statistical significance alone is not sufficient. Require practical significance:

```typescript
export interface MetricComparison {
  baseline: number;
  treatment: number;
  pValue: number;
  confidenceInterval: [number, number];  // 95% CI for the difference

  // Significance checks
  statisticallySignificant: boolean;     // p < adjusted_alpha
  practicallySignificant: boolean;       // |effect| >= minEffectSize

  // Combined decision
  significantImprovement: boolean;       // Both statistical AND practical
}

/**
 * Determine if improvement is significant (both statistically and practically).
 */
export function isSignificantImprovement(
  comparison: MetricComparison,
  config: StatisticalConfig
): boolean {
  const relativeChange = (comparison.treatment - comparison.baseline) / comparison.baseline;

  return (
    comparison.pValue < config.alpha &&                    // Statistically significant
    Math.abs(relativeChange) >= config.minEffectSize &&   // At least 5% effect
    comparison.confidenceInterval[0] > 0                  // CI doesn't cross zero
  );
}
```

#### Updated Decision Logic

```typescript
private makeDecision(comparison: StatisticalComparison): ExperimentDecision {
  const metrics = [
    comparison.correctionRate,
    comparison.successRate,
    comparison.autonomyRate,
  ];

  // Apply Bonferroni correction
  const pValues = metrics.map(m => m.pValue);
  const significant = bonferroniCorrection(pValues, 0.05);

  // Check for regressions (significant AND effect >= 5%)
  const regressions = metrics.filter((m, i) =>
    significant[i] && !m.improved && Math.abs(m.relativeChange) >= 0.05
  );

  if (regressions.length > 0) {
    return { action: "rollback", ... };
  }

  // Check for improvements (significant AND effect >= 5%)
  const improvements = metrics.filter((m, i) =>
    significant[i] && m.improved && Math.abs(m.relativeChange) >= 0.05
  );

  if (improvements.length >= 2) {
    return { action: "graduate", ... };
  }

  // ...
}
```

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         E2E VALIDATION SYSTEM                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐       │
│  │ SCENARIO LIBRARY │    │  SYNTHETIC AGENT │    │  SESSION RECORDER │      │
│  │                  │───>│   (User Sim)     │───>│                   │      │
│  │ 10 predefined    │    │                  │    │ OpenTelemetry-    │      │
│  │ scenarios        │    │ Executes tasks   │    │ compatible spans  │      │
│  └──────────────────┘    │ with corrections │    └────────┬──────────┘      │
│                          └──────────────────┘             │                  │
│                                                           ▼                  │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                        EXPERIMENT ENGINE                              │   │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌────────────┐   │   │
│  │  │  BASELINE   │  │  TREATMENT  │  │ STATISTICAL │  │  DECISION  │   │   │
│  │  │   RUN       │  │    RUN      │  │   COMPARE   │  │   ENGINE   │   │   │
│  │  │             │  │             │  │             │  │            │   │   │
│  │  │ No improve- │  │ With auto-  │  │ Z-test,     │  │ Graduate/  │   │   │
│  │  │ ments       │  │ improvements│  │ chi-squared │  │ Rollback   │   │   │
│  │  └─────────────┘  └─────────────┘  └─────────────┘  └────────────┘   │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │                        METRICS DASHBOARD                              │   │
│  │  Correction Rate: 12.3% ↓   |   Autonomy: 78.5% ↑   |   p=0.023    │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Component Design

### 1. Scenario Library (10 Predefined Scenarios)

Each scenario defines:
- **Goal**: What the user wants to accomplish
- **Setup**: Initial project state
- **User Persona**: Expertise level, verbosity, correction tendency
- **Expected Flow**: Ideal tool sequence
- **Correction Triggers**: When to inject corrections
- **Success Criteria**: How to determine success

```typescript
// src/learning/validation/scenarios/types.ts

export interface ValidationScenario {
  id: string;
  name: string;
  description: string;
  difficulty: 1 | 2 | 3 | 4 | 5;
  category: ScenarioCategory;

  // Setup
  projectTemplate: string; // Path to template project
  initialPrompt: string;   // User's opening request

  // User simulation
  persona: UserPersona;

  // Knowledge base for answering agent clarifying questions
  // (Added based on Gemini review - handles "TypeScript or JavaScript?" type questions)
  knowledgeBase: ScenarioKnowledgeBase;

  // Expected behavior
  expectedTools: string[];         // Tools that should be used
  forbiddenTools?: string[];       // Tools that should NOT be used
  maxToolCalls: number;            // Efficiency bound
  maxCorrections: number;          // Quality bound

  // Correction injection
  correctionPoints: CorrectionPoint[];

  // Success validation
  successCriteria: SuccessCriterion[];
}

export type ScenarioCategory =
  | "file_operations"     // Create, edit, delete files
  | "code_search"         // Find code, understand codebase
  | "refactoring"         // Rename, restructure code
  | "debugging"           // Find and fix bugs
  | "testing"             // Write and run tests
  | "git_operations"      // Commits, branches, PRs
  | "documentation"       // Write docs, comments
  | "multi_step"          // Complex multi-file changes
  | "error_recovery"      // Handle failures gracefully
  | "ambiguous"           // Unclear requirements

export interface UserPersona {
  expertiseLevel: "novice" | "intermediate" | "expert";
  verbosity: "terse" | "normal" | "verbose";
  correctionStyle: "polite" | "direct" | "frustrated";
  patience: number; // 0-1, how many failures before abandoning
}

export interface CorrectionPoint {
  trigger: CorrectionTrigger;
  correction: string;
  expectedRecovery: string[];
}

export type CorrectionTrigger =
  | { type: "tool_count"; threshold: number }
  | { type: "wrong_tool"; tool: string }
  | { type: "file_not_found"; pattern: string }
  | { type: "error"; errorType: string }
  | { type: "random"; probability: number };

/**
 * Knowledge base for consistent answers to agent clarifying questions.
 * (Added based on Gemini review consensus)
 *
 * When the agent asks "TypeScript or JavaScript?", the synthetic user
 * looks up the answer in this knowledge base rather than hallucinating.
 */
export interface ScenarioKnowledgeBase {
  // Project preferences
  language?: "typescript" | "javascript" | "python" | "go" | "rust";
  packageManager?: "npm" | "yarn" | "pnpm" | "bun";
  framework?: string;           // e.g., "react", "vue", "express"
  testFramework?: string;       // e.g., "jest", "vitest", "mocha"

  // Style preferences
  styleGuide?: string;          // e.g., "airbnb", "standard"
  componentStyle?: "functional" | "class";
  stateManagement?: string;     // e.g., "redux", "zustand", "context"

  // Environment
  nodeVersion?: string;
  targetBrowser?: string[];
  deployTarget?: string;        // e.g., "vercel", "aws", "docker"

  // Custom Q&A for scenario-specific questions
  customAnswers?: Record<string, string>;
}

/**
 * Default knowledge base - used when scenario doesn't specify.
 */
export const DEFAULT_KNOWLEDGE_BASE: ScenarioKnowledgeBase = {
  language: "typescript",
  packageManager: "npm",
  testFramework: "jest",
  componentStyle: "functional",
};
```

#### Scenario 1: Simple File Creation

```typescript
const scenario1: ValidationScenario = {
  id: "file-create-component",
  name: "Create React Component",
  description: "User asks to create a new React component",
  difficulty: 1,
  category: "file_operations",

  projectTemplate: "templates/react-app",
  initialPrompt: "Create a Button component in src/components/",

  persona: {
    expertiseLevel: "intermediate",
    verbosity: "normal",
    correctionStyle: "polite",
    patience: 0.8,
  },

  // Knowledge base for answering clarifying questions
  knowledgeBase: {
    language: "typescript",
    framework: "react",
    componentStyle: "functional",
    customAnswers: {
      "props interface": "Yes, include a Props interface",
      "styling": "Use CSS modules",
    },
  },

  expectedTools: ["Write", "Read"],
  forbiddenTools: ["Bash"], // Should not need shell for this
  maxToolCalls: 5,
  maxCorrections: 1,

  correctionPoints: [
    {
      trigger: { type: "wrong_tool", tool: "Bash" },
      correction: "Please just create the file directly, no need for shell commands",
      expectedRecovery: ["Write"],
    },
  ],

  successCriteria: [
    { type: "file_exists", path: "src/components/Button.tsx" },
    { type: "file_contains", path: "src/components/Button.tsx", pattern: "export" },
    { type: "file_contains", path: "src/components/Button.tsx", pattern: "Button" },
  ],
};
```

#### Scenario 2: Code Search and Understanding

```typescript
const scenario2: ValidationScenario = {
  id: "code-search-auth",
  name: "Find Authentication Implementation",
  description: "User wants to understand how auth works",
  difficulty: 2,
  category: "code_search",

  projectTemplate: "templates/express-api",
  initialPrompt: "How does authentication work in this codebase?",

  persona: {
    expertiseLevel: "novice",
    verbosity: "verbose",
    correctionStyle: "polite",
    patience: 0.9,
  },

  expectedTools: ["Grep", "Read", "Glob"],
  maxToolCalls: 15,
  maxCorrections: 2,

  correctionPoints: [
    {
      trigger: { type: "tool_count", threshold: 10 },
      correction: "Can you summarize what you've found so far?",
      expectedRecovery: [], // Should respond, not use more tools
    },
  ],

  successCriteria: [
    { type: "response_mentions", patterns: ["JWT", "token", "middleware"] },
    { type: "files_read", minCount: 3 },
  ],
};
```

#### Scenario 3: Multi-Step Refactoring

```typescript
const scenario3: ValidationScenario = {
  id: "refactor-rename-function",
  name: "Rename Function Across Codebase",
  description: "User wants to rename a function everywhere",
  difficulty: 3,
  category: "refactoring",

  projectTemplate: "templates/typescript-lib",
  initialPrompt: "Rename the function 'getData' to 'fetchUserData' everywhere",

  persona: {
    expertiseLevel: "expert",
    verbosity: "terse",
    correctionStyle: "direct",
    patience: 0.7,
  },

  expectedTools: ["Grep", "Edit", "Read"],
  maxToolCalls: 20,
  maxCorrections: 2,

  correctionPoints: [
    {
      trigger: { type: "file_not_found", pattern: "*.test.ts" },
      correction: "Don't forget to update the tests too",
      expectedRecovery: ["Grep", "Edit"],
    },
  ],

  successCriteria: [
    { type: "no_matches", pattern: "getData", excludePaths: ["node_modules"] },
    { type: "file_contains", path: "src/api.ts", pattern: "fetchUserData" },
    { type: "tests_pass" },
  ],
};
```

#### Scenario 4: Error Recovery

```typescript
const scenario4: ValidationScenario = {
  id: "error-recovery-bash",
  name: "Recover from Shell Errors",
  description: "Handle common Bash command failures",
  difficulty: 3,
  category: "error_recovery",

  projectTemplate: "templates/node-cli",
  initialPrompt: "Run the tests and fix any failures",

  persona: {
    expertiseLevel: "intermediate",
    verbosity: "normal",
    correctionStyle: "polite",
    patience: 0.8,
  },

  expectedTools: ["Bash", "Read", "Edit"],
  maxToolCalls: 25,
  maxCorrections: 3,

  correctionPoints: [
    {
      trigger: { type: "error", errorType: "timeout" },
      correction: "That command timed out, try with a shorter timeout",
      expectedRecovery: ["Bash"],
    },
    {
      trigger: { type: "error", errorType: "permission" },
      correction: "Permission denied - can you try a different approach?",
      expectedRecovery: ["Bash", "Read"],
    },
  ],

  successCriteria: [
    { type: "tests_pass" },
    { type: "no_errors", excludeTypes: ["intentional"] },
  ],
};
```

#### Scenario 5: Ambiguous Requirements

```typescript
const scenario5: ValidationScenario = {
  id: "ambiguous-add-feature",
  name: "Handle Ambiguous Request",
  description: "User gives unclear requirements, agent should ask for clarification",
  difficulty: 4,
  category: "ambiguous",

  projectTemplate: "templates/react-app",
  initialPrompt: "Add a better way to handle errors",

  persona: {
    expertiseLevel: "novice",
    verbosity: "terse",
    correctionStyle: "frustrated",
    patience: 0.5,
  },

  expectedTools: ["Read", "Grep"], // Should explore before acting
  forbiddenTools: ["Write", "Edit"], // Should NOT modify without clarification
  maxToolCalls: 10,
  maxCorrections: 2,

  correctionPoints: [], // No corrections - success is asking for clarification

  successCriteria: [
    { type: "asks_clarification" }, // Agent should ask what kind of errors
    { type: "no_file_modifications" },
  ],
};
```

#### Remaining Scenarios (6-10)

| ID | Name | Category | Difficulty | Key Challenge |
|----|------|----------|------------|---------------|
| 6 | `git-commit-workflow` | git_operations | 2 | Proper commit message, staged files |
| 7 | `write-unit-tests` | testing | 3 | Test coverage, mocking |
| 8 | `debug-runtime-error` | debugging | 4 | Stack trace analysis, fix validation |
| 9 | `multi-file-migration` | multi_step | 5 | Consistent changes across 10+ files |
| 10 | `document-api` | documentation | 2 | OpenAPI spec generation |
| 11 | `security-fix-sqli` | security | 4 | SQL injection fix, input validation |

#### Scenario 11: Security Fix (SQL Injection)

> **Added based on multi-model review consensus (3/8 models flagged missing security scenarios)**

```typescript
const scenario11: ValidationScenario = {
  id: "security-fix-sqli",
  name: "Fix SQL Injection Vulnerability",
  description: "User reports potential SQL injection, agent should fix safely",
  difficulty: 4,
  category: "security",

  projectTemplate: "templates/express-api-vulnerable",
  initialPrompt: "There's a SQL injection vulnerability in the search endpoint. Can you fix it?",

  persona: {
    expertiseLevel: "intermediate",
    verbosity: "normal",
    correctionStyle: "direct",
    patience: 0.7,
  },

  knowledgeBase: {
    language: "typescript",
    framework: "express",
    customAnswers: {
      "database": "PostgreSQL with pg driver",
      "orm": "No ORM, using raw queries",
      "breaking changes": "Minimize breaking changes to API",
    },
  },

  expectedTools: ["Read", "Grep", "Edit"],
  forbiddenTools: [],
  maxToolCalls: 20,
  maxCorrections: 2,

  correctionPoints: [
    {
      trigger: { type: "wrong_tool", tool: "Write" },
      correction: "Please edit the existing file rather than rewriting it",
      expectedRecovery: ["Edit"],
    },
    {
      // Trigger if agent tries to use string interpolation (insecure fix)
      trigger: { type: "file_contains", pattern: "${" },
      correction: "That still looks like string interpolation - use parameterized queries",
      expectedRecovery: ["Edit"],
    },
  ],

  successCriteria: [
    // Must use parameterized queries
    { type: "file_contains", path: "src/routes/search.ts", pattern: "$1" },
    { type: "file_not_contains", path: "src/routes/search.ts", pattern: "${" },
    // Must not break existing tests
    { type: "tests_pass" },
    // Should add input validation
    { type: "file_contains", path: "src/routes/search.ts", pattern: "validate" },
  ],
};
```

#### Scenario 12: Secrets Handling (Bonus)

```typescript
const scenario12: ValidationScenario = {
  id: "secrets-handling",
  name: "Handle Secrets in Code",
  description: "User accidentally committed API key, agent should fix properly",
  difficulty: 3,
  category: "security",

  projectTemplate: "templates/node-app-with-secrets",
  initialPrompt: "I accidentally committed my API key in config.ts. Can you help me fix this?",

  persona: {
    expertiseLevel: "novice",
    verbosity: "verbose",
    correctionStyle: "polite",
    patience: 0.9,
  },

  knowledgeBase: {
    language: "typescript",
    customAnswers: {
      "rotate key": "Yes, I'll rotate the key after",
      "env file": "Use .env with dotenv",
    },
  },

  expectedTools: ["Read", "Edit", "Bash"],
  maxToolCalls: 15,
  maxCorrections: 2,

  successCriteria: [
    // API key removed from source
    { type: "file_not_contains", path: "src/config.ts", pattern: "sk-" },
    // Uses environment variable
    { type: "file_contains", path: "src/config.ts", pattern: "process.env" },
    // .env.example created
    { type: "file_exists", path: ".env.example" },
    // .gitignore updated
    { type: "file_contains", path: ".gitignore", pattern: ".env" },
  ],
};
```

---

### 2. Synthetic Agent (User Simulator)

The synthetic agent simulates user behavior by:
1. Sending the initial prompt
2. Observing agent responses
3. Injecting corrections based on triggers
4. Evaluating success criteria

```typescript
// src/learning/validation/synthetic-agent.ts

export interface SyntheticAgentConfig {
  scenario: ValidationScenario;
  agentEndpoint: string; // Where to send prompts
  experimentId?: string; // For A/B testing
  recordSession: boolean;
}

export class SyntheticAgent {
  private scenario: ValidationScenario;
  private sessionRecorder: SessionRecorder;
  private toolHistory: ToolEvent[] = [];
  private correctionCount = 0;
  private startTime = 0;

  constructor(config: SyntheticAgentConfig) {
    this.scenario = config.scenario;
    this.sessionRecorder = new SessionRecorder({
      experimentId: config.experimentId,
      scenarioId: config.scenario.id,
    });
  }

  /**
   * Execute the scenario and return results.
   */
  async execute(): Promise<ScenarioResult> {
    const sessionId = this.generateSessionId();
    this.startTime = Date.now();

    // Start session recording
    this.sessionRecorder.startSession(sessionId, this.scenario.id);

    try {
      // Send initial prompt
      let response = await this.sendPrompt(this.scenario.initialPrompt);

      // Main interaction loop
      while (!this.isComplete(response)) {
        // Check correction triggers
        const correction = this.checkCorrectionTriggers(response);

        if (correction) {
          this.correctionCount++;
          this.sessionRecorder.recordCorrection({
            trigger: correction.trigger,
            correction: correction.correction,
            timestamp: Date.now(),
          });

          // Check patience
          if (this.shouldAbandon()) {
            return this.createResult("abandoned");
          }

          // Send correction
          response = await this.sendPrompt(correction.correction);
        } else {
          // Continue naturally (agent might ask questions)
          response = await this.handleAgentQuery(response);
        }
      }

      // Evaluate success
      const success = await this.evaluateSuccess();
      return this.createResult(success ? "success" : "failure");

    } finally {
      this.sessionRecorder.endSession(sessionId);
    }
  }

  private checkCorrectionTriggers(response: AgentResponse): CorrectionPoint | null {
    for (const cp of this.scenario.correctionPoints) {
      switch (cp.trigger.type) {
        case "tool_count":
          if (this.toolHistory.length >= cp.trigger.threshold) {
            return cp;
          }
          break;
        case "wrong_tool":
          const lastTool = this.toolHistory[this.toolHistory.length - 1];
          if (lastTool?.toolName === cp.trigger.tool) {
            return cp;
          }
          break;
        case "error":
          if (response.error?.type === cp.trigger.errorType) {
            return cp;
          }
          break;
        case "random":
          if (Math.random() < cp.trigger.probability) {
            return cp;
          }
          break;
      }
    }
    return null;
  }

  private shouldAbandon(): boolean {
    const patience = this.scenario.persona.patience;
    const correctionRatio = this.correctionCount / this.scenario.maxCorrections;
    return correctionRatio > patience;
  }

  /**
   * Handle agent clarifying questions using the scenario's knowledge base.
   * (Added based on Gemini review - was previously undefined)
   *
   * Examples:
   * - Agent: "Should I use TypeScript or JavaScript?"
   * - Agent: "Do you want functional or class components?"
   * - Agent: "Should I add tests?"
   */
  private async handleAgentQuery(response: AgentResponse): Promise<AgentResponse> {
    // If agent is asking a question, answer from knowledge base
    if (response.isQuestion) {
      const answer = this.findAnswer(response.question);
      if (answer) {
        this.sessionRecorder.recordUserResponse({
          type: "clarification",
          question: response.question,
          answer,
          timestamp: Date.now(),
        });
        return this.sendPrompt(answer);
      }

      // Unknown question - use LLM with persona + low temperature for consistency
      const generatedAnswer = await this.generateAnswer(response.question);
      return this.sendPrompt(generatedAnswer);
    }

    // Not a question - agent is working, wait for next response
    return this.waitForNextResponse();
  }

  /**
   * Look up answer in knowledge base.
   */
  private findAnswer(question: string): string | null {
    const kb = this.scenario.knowledgeBase;
    const q = question.toLowerCase();

    // Check custom answers first
    if (kb.customAnswers) {
      for (const [key, answer] of Object.entries(kb.customAnswers)) {
        if (q.includes(key.toLowerCase())) {
          return answer;
        }
      }
    }

    // Check standard preferences
    if (q.includes("typescript") || q.includes("javascript")) {
      return kb.language === "typescript" ? "TypeScript please" : "JavaScript is fine";
    }
    if (q.includes("functional") || q.includes("class")) {
      return kb.componentStyle === "functional"
        ? "Use functional components"
        : "Class components are fine";
    }
    if (q.includes("package manager") || q.includes("npm") || q.includes("yarn")) {
      return `Use ${kb.packageManager ?? "npm"}`;
    }
    if (q.includes("test")) {
      return kb.testFramework ? `Yes, use ${kb.testFramework}` : "Tests aren't needed for now";
    }

    return null; // Unknown question
  }

  /**
   * Generate answer using LLM with persona constraints.
   * Uses low temperature (0.1) for consistency across runs.
   */
  private async generateAnswer(question: string): Promise<string> {
    const persona = this.scenario.persona;
    const prompt = `You are a ${persona.expertiseLevel} developer.
Your communication style is ${persona.verbosity} and ${persona.correctionStyle}.
Answer this question briefly: "${question}"
Base your answer on: ${JSON.stringify(this.scenario.knowledgeBase)}`;

    return this.llm.generate(prompt, { temperature: 0.1, maxTokens: 100 });
  }

  private async evaluateSuccess(): Promise<boolean> {
    for (const criterion of this.scenario.successCriteria) {
      const passed = await this.checkCriterion(criterion);
      if (!passed) return false;
    }
    return true;
  }

  private async checkCriterion(criterion: SuccessCriterion): Promise<boolean> {
    switch (criterion.type) {
      case "file_exists":
        return await fileExists(criterion.path);
      case "file_contains":
        const content = await readFile(criterion.path);
        return content.includes(criterion.pattern);
      case "tests_pass":
        return await runTests();
      case "asks_clarification":
        return this.lastResponseAskedQuestion;
      case "no_file_modifications":
        return this.toolHistory.filter(t =>
          ["Write", "Edit"].includes(t.toolName)
        ).length === 0;
      // ... more criteria
    }
  }
}
```

---

### 2.5 Agent Driver Interface

> **Added based on Claude review (CRITICAL) - defines how synthetic agent communicates with the agent under test**

The `AgentDriver` interface abstracts the communication between the synthetic user and the actual Claude Code agent being tested. This enables:
- Testing different agent configurations
- Switching between local and remote agents
- Mocking for unit tests

```typescript
// src/learning/validation/agent-driver.ts

/**
 * Interface for communicating with the agent under test.
 * Implementations can be HTTP, WebSocket, or direct function calls.
 */
export interface AgentDriver {
  /**
   * Send a user prompt to the agent and receive a response.
   */
  sendPrompt(prompt: string): Promise<AgentResponse>;

  /**
   * Subscribe to tool call events as they happen.
   * Used for real-time correction injection.
   */
  observeToolCall(callback: (event: ToolEvent) => void): () => void;

  /**
   * Enable or disable specific improvements for this session.
   * Used for A/B testing treatment vs control.
   */
  setImprovements(improvementIds: string[]): Promise<void>;

  /**
   * Reset agent state between scenario runs.
   * Clears conversation history, tool cache, etc.
   */
  reset(): Promise<void>;

  /**
   * Get current agent configuration for logging.
   */
  getConfig(): AgentConfig;
}

export interface AgentResponse {
  content: string;
  isQuestion: boolean;
  question?: string;
  toolCalls: ToolCall[];
  error?: AgentError;
  tokens: { input: number; output: number };
}

export interface AgentConfig {
  model: string;
  improvements: string[];
  temperature: number;
  maxTokens: number;
}

/**
 * Local agent driver - direct function calls to claudemem.
 * Used for development and fast iteration.
 */
export class LocalAgentDriver implements AgentDriver {
  private agent: ClaudeCodeAgent;
  private toolCallHandlers: Set<(event: ToolEvent) => void> = new Set();
  private activeImprovements: string[] = [];

  constructor(config: LocalDriverConfig) {
    this.agent = new ClaudeCodeAgent({
      ...config,
      onToolCall: (event) => {
        this.toolCallHandlers.forEach(h => h(event));
      },
    });
  }

  async sendPrompt(prompt: string): Promise<AgentResponse> {
    const result = await this.agent.processMessage(prompt);
    return this.parseResponse(result);
  }

  observeToolCall(callback: (event: ToolEvent) => void): () => void {
    this.toolCallHandlers.add(callback);
    return () => this.toolCallHandlers.delete(callback);
  }

  async setImprovements(ids: string[]): Promise<void> {
    this.activeImprovements = ids;
    // Toggle improvement flags in learning system
    for (const id of ids) {
      await enableImprovement(id);
    }
  }

  async reset(): Promise<void> {
    await this.agent.reset();
    this.activeImprovements = [];
  }

  getConfig(): AgentConfig {
    return {
      model: this.agent.model,
      improvements: this.activeImprovements,
      temperature: this.agent.temperature,
      maxTokens: this.agent.maxTokens,
    };
  }
}

/**
 * HTTP agent driver - for testing remote/production agents.
 */
export class HttpAgentDriver implements AgentDriver {
  constructor(private baseUrl: string, private apiKey: string) {}

  async sendPrompt(prompt: string): Promise<AgentResponse> {
    const response = await fetch(`${this.baseUrl}/v1/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ message: prompt }),
    });
    return response.json();
  }

  // WebSocket-based observation for remote agents
  observeToolCall(callback: (event: ToolEvent) => void): () => void {
    const ws = new WebSocket(`${this.baseUrl.replace('http', 'ws')}/v1/events`);
    ws.onmessage = (e) => {
      const event = JSON.parse(e.data);
      if (event.type === 'tool_call') callback(event);
    };
    return () => ws.close();
  }

  async setImprovements(ids: string[]): Promise<void> {
    await fetch(`${this.baseUrl}/v1/config`, {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${this.apiKey}` },
      body: JSON.stringify({ improvements: ids }),
    });
  }

  async reset(): Promise<void> {
    await fetch(`${this.baseUrl}/v1/reset`, { method: 'POST' });
  }

  getConfig(): AgentConfig {
    // Fetch from remote
    return { model: 'remote', improvements: [], temperature: 0, maxTokens: 0 };
  }
}
```

**Usage in SyntheticAgent:**

```typescript
export class SyntheticAgent {
  private driver: AgentDriver;

  constructor(config: SyntheticAgentConfig) {
    // Select driver based on config
    this.driver = config.remote
      ? new HttpAgentDriver(config.agentEndpoint, config.apiKey)
      : new LocalAgentDriver(config);

    // Subscribe to tool calls for correction triggers
    this.driver.observeToolCall((event) => {
      this.toolHistory.push(event);
      this.sessionRecorder.recordToolEvent(event);
    });
  }

  async execute(): Promise<ScenarioResult> {
    // Set improvements for this run (treatment vs control)
    await this.driver.setImprovements(this.config.improvements);

    // Reset agent state
    await this.driver.reset();

    // Run scenario...
    const response = await this.driver.sendPrompt(this.scenario.initialPrompt);
    // ...
  }
}
```

---

### 3. Session Recorder (OpenTelemetry-Compatible)

Records all interactions in a format compatible with existing infrastructure:

```typescript
// src/learning/validation/session-recorder.ts

import type {
  AgentSession,
  ToolEvent,
  CorrectionEvent,
  CorrectionSignals,
} from "../interaction/types.js";

export interface RecordedSession {
  sessionId: string;
  scenarioId: string;
  experimentId?: string;
  experimentGroup?: "treatment" | "control";

  // Timing
  startTime: number;
  endTime: number;
  durationMs: number;

  // Events
  toolEvents: ToolEvent[];
  corrections: RecordedCorrection[];

  // Aggregates
  metrics: SessionMetrics;

  // Outcome
  outcome: "success" | "partial" | "failure" | "abandoned";
  successCriteria: CriteriaResult[];
}

export interface SessionMetrics {
  toolCount: number;
  correctionCount: number;
  errorCount: number;
  autonomousActions: number;

  // Derived
  correctionRate: number;      // corrections / toolCount
  errorRate: number;           // errors / toolCount
  autonomyRate: number;        // autonomous / (autonomous + corrections)

  // Efficiency
  tokensUsed: number;
  avgToolDurationMs: number;
}

export class SessionRecorder {
  private session: RecordedSession | null = null;
  private store: ValidationStore;

  constructor(private config: RecorderConfig) {
    this.store = new ValidationStore(config.dbPath);
  }

  startSession(sessionId: string, scenarioId: string): void {
    this.session = {
      sessionId,
      scenarioId,
      experimentId: this.config.experimentId,
      experimentGroup: this.config.experimentGroup,
      startTime: Date.now(),
      endTime: 0,
      durationMs: 0,
      toolEvents: [],
      corrections: [],
      metrics: this.createEmptyMetrics(),
      outcome: "failure",
      successCriteria: [],
    };
  }

  recordToolEvent(event: ToolEvent): void {
    if (!this.session) return;
    this.session.toolEvents.push(event);
    this.session.metrics.toolCount++;
    if (!event.success) {
      this.session.metrics.errorCount++;
    }
  }

  recordCorrection(correction: RecordedCorrection): void {
    if (!this.session) return;
    this.session.corrections.push(correction);
    this.session.metrics.correctionCount++;
  }

  endSession(sessionId: string, outcome?: SessionOutcome): RecordedSession {
    if (!this.session) throw new Error("No active session");

    this.session.endTime = Date.now();
    this.session.durationMs = this.session.endTime - this.session.startTime;
    this.session.outcome = outcome ?? "failure";

    // Calculate derived metrics
    this.session.metrics = this.calculateMetrics();

    // Persist to storage
    this.store.saveSession(this.session);

    // If part of experiment, record to A/B testing
    if (this.session.experimentId) {
      this.recordToExperiment();
    }

    const result = this.session;
    this.session = null;
    return result;
  }

  private calculateMetrics(): SessionMetrics {
    const s = this.session!;
    const toolCount = s.toolEvents.length;
    const corrections = s.corrections.length;
    const errors = s.toolEvents.filter(t => !t.success).length;
    const autonomous = toolCount - corrections;

    return {
      toolCount,
      correctionCount: corrections,
      errorCount: errors,
      autonomousActions: autonomous,

      correctionRate: toolCount > 0 ? corrections / toolCount : 0,
      errorRate: toolCount > 0 ? errors / toolCount : 0,
      autonomyRate: toolCount > 0 ? autonomous / toolCount : 0,

      tokensUsed: this.sumTokens(),
      avgToolDurationMs: this.avgDuration(),
    };
  }

  private recordToExperiment(): void {
    const abManager = getABTestManager();
    const group = this.session!.experimentGroup ?? "control";

    abManager.recordSessionMetrics(
      this.session!.experimentId!,
      group,
      {
        corrections: this.session!.metrics.correctionCount,
        errors: this.session!.metrics.errorCount,
        autonomousCompletions: this.session!.outcome === "success" ? 1 : 0,
        avgSessionDurationMs: this.session!.durationMs,
      }
    );
  }
}
```

---

### 3.5 Environment State Management

> **Added based on DeepSeek review (CRITICAL) - environment reset between validation runs**

Each scenario run must start from a clean, deterministic state. Without proper reset, test pollution occurs (previous run's files, git state, or caches affect the next run).

```typescript
// src/learning/validation/environment-manager.ts

export interface EnvironmentSnapshot {
  snapshotId: string;
  scenarioId: string;
  timestamp: number;

  // Captured state
  files: FileSnapshot[];
  gitState: GitSnapshot;
  envVars: Record<string, string>;
}

export interface EnvironmentManager {
  /**
   * Create a snapshot of the current environment.
   * Called once when scenario template is first set up.
   */
  createSnapshot(scenarioId: string): Promise<EnvironmentSnapshot>;

  /**
   * Restore environment to a previous snapshot.
   * Called before each scenario run.
   */
  restoreSnapshot(snapshotId: string): Promise<void>;

  /**
   * Clean up temporary files and caches.
   */
  cleanup(): Promise<void>;
}

/**
 * Docker-based environment manager for full isolation.
 * Recommended for CI/CD environments.
 */
export class DockerEnvironmentManager implements EnvironmentManager {
  private containerId: string | null = null;

  async createSnapshot(scenarioId: string): Promise<EnvironmentSnapshot> {
    // Create container from scenario template
    const templatePath = `templates/${scenarioId}`;
    const result = await exec(`docker create -v ${templatePath}:/workspace scenario-runner`);
    this.containerId = result.stdout.trim();

    // Commit as snapshot image
    await exec(`docker commit ${this.containerId} snapshot:${scenarioId}`);

    return {
      snapshotId: `snapshot:${scenarioId}`,
      scenarioId,
      timestamp: Date.now(),
      files: [],
      gitState: { branch: 'main', clean: true },
      envVars: {},
    };
  }

  async restoreSnapshot(snapshotId: string): Promise<void> {
    // Stop and remove current container
    if (this.containerId) {
      await exec(`docker stop ${this.containerId}`);
      await exec(`docker rm ${this.containerId}`);
    }

    // Create fresh container from snapshot
    const result = await exec(`docker create ${snapshotId}`);
    this.containerId = result.stdout.trim();
    await exec(`docker start ${this.containerId}`);
  }

  async cleanup(): Promise<void> {
    if (this.containerId) {
      await exec(`docker stop ${this.containerId}`);
      await exec(`docker rm ${this.containerId}`);
    }
  }
}

/**
 * Git-based environment manager for lightweight isolation.
 * Faster than Docker, suitable for local development.
 */
export class GitEnvironmentManager implements EnvironmentManager {
  private workDir: string;
  private snapshotBranch: string | null = null;

  constructor(workDir: string) {
    this.workDir = workDir;
  }

  async createSnapshot(scenarioId: string): Promise<EnvironmentSnapshot> {
    this.snapshotBranch = `snapshot/${scenarioId}`;

    // Ensure clean state
    await exec(`git -C ${this.workDir} checkout main`);
    await exec(`git -C ${this.workDir} clean -fdx`);
    await exec(`git -C ${this.workDir} reset --hard HEAD`);

    // Create snapshot branch
    await exec(`git -C ${this.workDir} branch -f ${this.snapshotBranch}`);

    // Capture file state
    const files = await this.captureFileState();

    return {
      snapshotId: this.snapshotBranch,
      scenarioId,
      timestamp: Date.now(),
      files,
      gitState: { branch: 'main', clean: true },
      envVars: { ...process.env } as Record<string, string>,
    };
  }

  async restoreSnapshot(snapshotId: string): Promise<void> {
    // Hard reset to snapshot branch
    await exec(`git -C ${this.workDir} checkout ${snapshotId}`);
    await exec(`git -C ${this.workDir} clean -fdx`);
    await exec(`git -C ${this.workDir} reset --hard HEAD`);

    // Clear any caches
    await exec(`rm -rf ${this.workDir}/node_modules/.cache`);
    await exec(`rm -rf ${this.workDir}/.claudemem`);
  }

  async cleanup(): Promise<void> {
    await exec(`git -C ${this.workDir} checkout main`);
    await exec(`git -C ${this.workDir} clean -fdx`);
  }

  private async captureFileState(): Promise<FileSnapshot[]> {
    const result = await exec(`git -C ${this.workDir} ls-files`);
    return result.stdout.split('\n').filter(Boolean).map(path => ({
      path,
      hash: '', // Could compute file hash if needed
    }));
  }
}

/**
 * In-memory environment manager for fast unit tests.
 * No actual file system changes.
 */
export class MockEnvironmentManager implements EnvironmentManager {
  private snapshots = new Map<string, EnvironmentSnapshot>();

  async createSnapshot(scenarioId: string): Promise<EnvironmentSnapshot> {
    const snapshot: EnvironmentSnapshot = {
      snapshotId: `mock:${scenarioId}`,
      scenarioId,
      timestamp: Date.now(),
      files: [],
      gitState: { branch: 'main', clean: true },
      envVars: {},
    };
    this.snapshots.set(snapshot.snapshotId, snapshot);
    return snapshot;
  }

  async restoreSnapshot(snapshotId: string): Promise<void> {
    // No-op for mock
  }

  async cleanup(): Promise<void> {
    this.snapshots.clear();
  }
}
```

**Usage in Experiment Engine:**

```typescript
export class ExperimentEngine {
  private envManager: EnvironmentManager;

  constructor(config: ExperimentEngineConfig) {
    // Select environment manager based on config
    this.envManager = config.useDocker
      ? new DockerEnvironmentManager()
      : new GitEnvironmentManager(config.workDir);
  }

  async runExperiment(experiment: ValidationExperiment): Promise<ExperimentResults> {
    // Create snapshots for each scenario
    const snapshots = new Map<string, EnvironmentSnapshot>();
    for (const scenarioId of experiment.scenarios) {
      const snapshot = await this.envManager.createSnapshot(scenarioId);
      snapshots.set(scenarioId, snapshot);
    }

    try {
      // Run baseline
      const baseline = await this.runScenarios(experiment, snapshots, { group: 'control' });

      // Run treatment
      const treatment = await this.runScenarios(experiment, snapshots, { group: 'treatment' });

      return this.compareResults(baseline, treatment);
    } finally {
      await this.envManager.cleanup();
    }
  }

  private async runScenarios(
    experiment: ValidationExperiment,
    snapshots: Map<string, EnvironmentSnapshot>,
    config: RunConfig
  ): Promise<AggregateResults> {
    const sessions: RecordedSession[] = [];

    for (const scenarioId of experiment.scenarios) {
      for (let i = 0; i < experiment.runsPerScenario; i++) {
        // CRITICAL: Restore clean state before each run
        const snapshot = snapshots.get(scenarioId)!;
        await this.envManager.restoreSnapshot(snapshot.snapshotId);

        // Now run scenario on clean environment
        const agent = new SyntheticAgent({ ... });
        const result = await agent.execute();
        sessions.push(result.session);
      }
    }

    return this.aggregateResults(sessions);
  }
}
```

---

### 4. Experiment Engine

Orchestrates baseline vs treatment runs:

```typescript
// src/learning/validation/experiment-engine.ts

export interface ValidationExperiment {
  experimentId: string;
  improvementIds: string[];   // Improvements being tested
  scenarios: string[];        // Scenario IDs to run
  runsPerScenario: number;    // Statistical power
  status: "pending" | "running" | "complete";
}

export interface ExperimentResults {
  experimentId: string;
  baseline: AggregateResults;
  treatment: AggregateResults;
  comparison: StatisticalComparison;
  decision: ExperimentDecision;
}

export interface AggregateResults {
  totalRuns: number;
  successRate: number;
  avgCorrectionRate: number;
  avgErrorRate: number;
  avgAutonomyRate: number;
  avgDurationMs: number;

  // Per-scenario breakdown
  byScenario: Map<string, ScenarioResults>;
}

export class ExperimentEngine {
  private scenarios: Map<string, ValidationScenario>;
  private abManager: ABTestManager;
  private store: ValidationStore;

  constructor(config: ExperimentEngineConfig) {
    this.scenarios = this.loadScenarios();
    this.abManager = createABTestManager(config.abConfig);
    this.store = new ValidationStore(config.dbPath);
  }

  /**
   * Run a complete validation experiment.
   *
   * 1. Run baseline (no improvements)
   * 2. Run treatment (with improvements)
   * 3. Compare statistically
   * 4. Make decision
   */
  async runExperiment(
    experimentConfig: ValidationExperiment
  ): Promise<ExperimentResults> {
    const experimentId = experimentConfig.experimentId;

    // Phase 1: Baseline runs
    console.log("Phase 1: Running baseline scenarios...");
    const baselineResults = await this.runScenarios(
      experimentConfig.scenarios,
      experimentConfig.runsPerScenario,
      { experimentId, group: "control", improvements: [] }
    );

    // Phase 2: Treatment runs (with improvements active)
    console.log("Phase 2: Running treatment scenarios...");
    const treatmentResults = await this.runScenarios(
      experimentConfig.scenarios,
      experimentConfig.runsPerScenario,
      {
        experimentId,
        group: "treatment",
        improvements: experimentConfig.improvementIds,
      }
    );

    // Phase 3: Statistical comparison
    console.log("Phase 3: Analyzing results...");
    const comparison = this.compareResults(baselineResults, treatmentResults);

    // Phase 4: Decision
    const decision = this.makeDecision(comparison);

    // Store results
    const results: ExperimentResults = {
      experimentId,
      baseline: baselineResults,
      treatment: treatmentResults,
      comparison,
      decision,
    };

    this.store.saveExperimentResults(results);

    return results;
  }

  /**
   * Run scenarios with given configuration.
   */
  private async runScenarios(
    scenarioIds: string[],
    runsPerScenario: number,
    config: RunConfig
  ): Promise<AggregateResults> {
    const allSessions: RecordedSession[] = [];

    for (const scenarioId of scenarioIds) {
      const scenario = this.scenarios.get(scenarioId);
      if (!scenario) continue;

      for (let i = 0; i < runsPerScenario; i++) {
        // Enable/disable improvements for this run
        this.setImprovements(config.improvements);

        const agent = new SyntheticAgent({
          scenario,
          experimentId: config.experimentId,
          recordSession: true,
        });

        const result = await agent.execute();
        allSessions.push(result.session);
      }
    }

    return this.aggregateResults(allSessions);
  }

  /**
   * Statistical comparison between baseline and treatment.
   */
  private compareResults(
    baseline: AggregateResults,
    treatment: AggregateResults
  ): StatisticalComparison {
    // Correction rate comparison (lower is better)
    const correctionTest = this.proportionZTest(
      baseline.avgCorrectionRate,
      baseline.totalRuns,
      treatment.avgCorrectionRate,
      treatment.totalRuns
    );

    // Success rate comparison (higher is better)
    const successTest = this.proportionZTest(
      treatment.successRate,
      treatment.totalRuns,
      baseline.successRate,
      baseline.totalRuns
    );

    // Autonomy rate comparison (higher is better)
    const autonomyTest = this.proportionZTest(
      treatment.avgAutonomyRate,
      treatment.totalRuns,
      baseline.avgAutonomyRate,
      baseline.totalRuns
    );

    return {
      correctionRate: {
        baseline: baseline.avgCorrectionRate,
        treatment: treatment.avgCorrectionRate,
        relativeChange: this.relativeChange(
          baseline.avgCorrectionRate,
          treatment.avgCorrectionRate
        ),
        pValue: correctionTest.pValue,
        significant: correctionTest.pValue < 0.05,
        improved: treatment.avgCorrectionRate < baseline.avgCorrectionRate,
      },
      successRate: {
        baseline: baseline.successRate,
        treatment: treatment.successRate,
        relativeChange: this.relativeChange(
          baseline.successRate,
          treatment.successRate
        ),
        pValue: successTest.pValue,
        significant: successTest.pValue < 0.05,
        improved: treatment.successRate > baseline.successRate,
      },
      autonomyRate: {
        baseline: baseline.avgAutonomyRate,
        treatment: treatment.avgAutonomyRate,
        relativeChange: this.relativeChange(
          baseline.avgAutonomyRate,
          treatment.avgAutonomyRate
        ),
        pValue: autonomyTest.pValue,
        significant: autonomyTest.pValue < 0.05,
        improved: treatment.avgAutonomyRate > baseline.avgAutonomyRate,
      },
      overallImproved: this.isOverallImproved(
        correctionTest,
        successTest,
        autonomyTest
      ),
    };
  }

  /**
   * Make graduation/rollback decision.
   */
  private makeDecision(comparison: StatisticalComparison): ExperimentDecision {
    const { correctionRate, successRate, autonomyRate } = comparison;

    // Check for significant regressions
    if (correctionRate.significant && !correctionRate.improved) {
      return {
        action: "rollback",
        confidence: 1 - correctionRate.pValue,
        reason: `Correction rate increased by ${Math.abs(correctionRate.relativeChange * 100).toFixed(1)}% (p=${correctionRate.pValue.toFixed(4)})`,
      };
    }

    if (successRate.significant && !successRate.improved) {
      return {
        action: "rollback",
        confidence: 1 - successRate.pValue,
        reason: `Success rate decreased by ${Math.abs(successRate.relativeChange * 100).toFixed(1)}% (p=${successRate.pValue.toFixed(4)})`,
      };
    }

    // Check for significant improvements
    const significantImprovements = [
      correctionRate.significant && correctionRate.improved,
      successRate.significant && successRate.improved,
      autonomyRate.significant && autonomyRate.improved,
    ].filter(Boolean).length;

    if (significantImprovements >= 2) {
      return {
        action: "graduate",
        confidence: Math.min(
          1 - correctionRate.pValue,
          1 - successRate.pValue
        ),
        reason: `${significantImprovements}/3 metrics significantly improved`,
      };
    }

    if (significantImprovements === 1) {
      return {
        action: "extend",
        confidence: 0.6,
        reason: "Only 1/3 metrics significantly improved, need more data",
      };
    }

    return {
      action: "continue",
      confidence: 0.5,
      reason: "No significant changes detected yet",
    };
  }
}
```

---

### 4.5 Parallel Execution Model

> **Added based on Claude review (CRITICAL) - sequential execution is too slow**

Running 200 sessions (10 scenarios × 20 runs) sequentially could take hours. This section adds parallel execution with worker pools and failure isolation.

```typescript
// src/learning/validation/parallel-executor.ts

export interface ParallelExecutorConfig {
  maxConcurrency: number;      // Max parallel workers (default: 10)
  timeoutMs: number;           // Per-scenario timeout (default: 300000 = 5 min)
  retryFailedScenarios: boolean;
  maxRetries: number;
}

export interface ExecutionTask {
  scenarioId: string;
  runIndex: number;
  config: RunConfig;
}

export interface ExecutionResult {
  task: ExecutionTask;
  status: 'fulfilled' | 'rejected' | 'timeout';
  session?: RecordedSession;
  error?: Error;
  durationMs: number;
}

/**
 * Parallel executor with worker pool and failure isolation.
 */
export class ParallelExecutor {
  private config: ParallelExecutorConfig;
  private activeWorkers = 0;
  private queue: ExecutionTask[] = [];

  constructor(config: Partial<ParallelExecutorConfig> = {}) {
    this.config = {
      maxConcurrency: config.maxConcurrency ?? 10,
      timeoutMs: config.timeoutMs ?? 300000,
      retryFailedScenarios: config.retryFailedScenarios ?? true,
      maxRetries: config.maxRetries ?? 2,
    };
  }

  /**
   * Execute all scenarios with parallel workers.
   * Uses Promise.allSettled for failure isolation.
   */
  async executeAll(
    scenarios: Map<string, ValidationScenario>,
    runsPerScenario: number,
    config: RunConfig
  ): Promise<ExecutionResult[]> {
    // Build task queue
    const tasks: ExecutionTask[] = [];
    for (const [scenarioId] of scenarios) {
      for (let i = 0; i < runsPerScenario; i++) {
        tasks.push({ scenarioId, runIndex: i, config });
      }
    }

    // Shuffle for better distribution (avoid all hard scenarios at once)
    this.shuffleArray(tasks);

    // Execute with concurrency limit
    return this.runWithConcurrency(tasks, scenarios);
  }

  private async runWithConcurrency(
    tasks: ExecutionTask[],
    scenarios: Map<string, ValidationScenario>
  ): Promise<ExecutionResult[]> {
    const results: ExecutionResult[] = [];
    const executing: Promise<void>[] = [];

    for (const task of tasks) {
      // Wait if at max concurrency
      if (executing.length >= this.config.maxConcurrency) {
        await Promise.race(executing);
      }

      // Start new worker
      const worker = this.executeTask(task, scenarios.get(task.scenarioId)!)
        .then(result => {
          results.push(result);
          // Remove from executing
          const idx = executing.indexOf(worker);
          if (idx > -1) executing.splice(idx, 1);
        });

      executing.push(worker);
    }

    // Wait for all remaining
    await Promise.all(executing);

    return results;
  }

  private async executeTask(
    task: ExecutionTask,
    scenario: ValidationScenario
  ): Promise<ExecutionResult> {
    const startTime = Date.now();

    try {
      // Add timeout wrapper
      const sessionPromise = this.runScenario(task, scenario);
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Timeout')), this.config.timeoutMs)
      );

      const session = await Promise.race([sessionPromise, timeoutPromise]);

      return {
        task,
        status: 'fulfilled',
        session,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      const status = error.message === 'Timeout' ? 'timeout' : 'rejected';

      // Retry logic
      if (this.config.retryFailedScenarios && task.config.retryCount < this.config.maxRetries) {
        console.log(`Retrying ${task.scenarioId} (attempt ${task.config.retryCount + 1})`);
        task.config.retryCount = (task.config.retryCount ?? 0) + 1;
        return this.executeTask(task, scenario);
      }

      return {
        task,
        status,
        error: error as Error,
        durationMs: Date.now() - startTime,
      };
    }
  }

  private async runScenario(
    task: ExecutionTask,
    scenario: ValidationScenario
  ): Promise<RecordedSession> {
    const agent = new SyntheticAgent({
      scenario,
      experimentId: task.config.experimentId,
      improvements: task.config.improvements,
    });

    const result = await agent.execute();
    return result.session;
  }

  private shuffleArray<T>(array: T[]): void {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
  }
}
```

**Updated Experiment Engine:**

```typescript
export class ExperimentEngine {
  private executor: ParallelExecutor;

  constructor(config: ExperimentEngineConfig) {
    this.executor = new ParallelExecutor({
      maxConcurrency: config.maxConcurrency ?? 10,
      timeoutMs: config.scenarioTimeoutMs ?? 300000,
    });
  }

  async runExperiment(experiment: ValidationExperiment): Promise<ExperimentResults> {
    // Phase 1: Baseline (parallel)
    console.log(`Running baseline: ${experiment.scenarios.length} scenarios × ${experiment.runsPerScenario} runs`);
    console.log(`Max concurrency: ${this.executor.config.maxConcurrency}`);

    const baselineResults = await this.executor.executeAll(
      this.scenarios,
      experiment.runsPerScenario,
      { experimentId: experiment.experimentId, group: 'control', improvements: [] }
    );

    // Check for minimum success threshold
    const baselineSuccess = baselineResults.filter(r => r.status === 'fulfilled');
    if (baselineSuccess.length < baselineResults.length * 0.8) {
      throw new Error(`Baseline failed: only ${baselineSuccess.length}/${baselineResults.length} succeeded`);
    }

    // Phase 2: Treatment (parallel)
    const treatmentResults = await this.executor.executeAll(
      this.scenarios,
      experiment.runsPerScenario,
      { experimentId: experiment.experimentId, group: 'treatment', improvements: experiment.improvementIds }
    );

    // Aggregate and compare
    return this.analyzeResults(baselineResults, treatmentResults);
  }
}
```

**Performance Comparison:**

| Execution Mode | 200 Sessions @ 2min each | Time |
|----------------|---------------------------|------|
| Sequential | 200 × 2 min | **6.7 hours** |
| Parallel (10 workers) | 20 batches × 2 min | **40 minutes** |
| Parallel (20 workers) | 10 batches × 2 min | **20 minutes** |

---

## Integration with Existing Infrastructure

### 1. Hook into Learning System

```typescript
// src/learning/index.ts - Add validation integration

export async function runValidationExperiment(
  improvementIds: string[],
  options: ValidationOptions = {}
): Promise<ExperimentResults> {
  const engine = new ExperimentEngine({
    dbPath: options.dbPath ?? ".claudemem/validation.db",
    abConfig: options.abConfig ?? DEFAULT_AB_CONFIG,
  });

  return engine.runExperiment({
    experimentId: `val_${Date.now()}`,
    improvementIds,
    scenarios: options.scenarios ?? getAllScenarioIds(),
    runsPerScenario: options.runsPerScenario ?? 10,
    status: "pending",
  });
}
```

### 2. Tiered Validation Strategy

> **Added based on Gemini review - different validation depths for different contexts**

Running full validation (200 sessions) for every change is wasteful. Use tiered validation to match effort to context:

```typescript
// src/learning/validation/tiers.ts

export type ValidationTier = 'smoke' | 'standard' | 'deep' | 'release';

export interface TierConfig {
  name: ValidationTier;
  scenarios: string[];           // Which scenarios to run
  runsPerScenario: number;       // How many runs each
  maxDuration: number;           // Timeout for entire tier (ms)
  requiredForMerge: boolean;     // Block PR if fails?
}

export const VALIDATION_TIERS: Record<ValidationTier, TierConfig> = {
  /**
   * SMOKE: Fast sanity check for PRs
   * ~3 scenarios × 1 run = ~6 minutes
   */
  smoke: {
    name: 'smoke',
    scenarios: [
      'file-create-component',    // Basic file ops
      'code-search-auth',         // Basic search
      'error-recovery-bash',      // Error handling
    ],
    runsPerScenario: 1,
    maxDuration: 10 * 60 * 1000,  // 10 minutes
    requiredForMerge: true,
  },

  /**
   * STANDARD: Normal CI validation
   * ~5 scenarios × 5 runs = ~50 minutes
   */
  standard: {
    name: 'standard',
    scenarios: [
      'file-create-component',
      'code-search-auth',
      'refactor-rename-function',
      'error-recovery-bash',
      'ambiguous-add-feature',
    ],
    runsPerScenario: 5,
    maxDuration: 60 * 60 * 1000,  // 1 hour
    requiredForMerge: false,
  },

  /**
   * DEEP: Nightly comprehensive validation
   * ~12 scenarios × 20 runs = ~4 hours (with parallelism)
   */
  deep: {
    name: 'deep',
    scenarios: 'all',  // All scenarios
    runsPerScenario: 20,
    maxDuration: 6 * 60 * 60 * 1000,  // 6 hours
    requiredForMerge: false,
  },

  /**
   * RELEASE: Pre-release full validation with extended runs
   * ~12 scenarios × 50 runs = ~10 hours
   */
  release: {
    name: 'release',
    scenarios: 'all',
    runsPerScenario: 50,
    maxDuration: 12 * 60 * 60 * 1000,  // 12 hours
    requiredForMerge: false,
  },
};
```

**Tier Selection Logic:**

```typescript
export function selectValidationTier(context: ValidationContext): ValidationTier {
  // Release branch → full release validation
  if (context.branch.startsWith('release/')) {
    return 'release';
  }

  // Nightly cron job → deep validation
  if (context.trigger === 'schedule') {
    return 'deep';
  }

  // PR with learning-related changes → standard validation
  if (context.trigger === 'pull_request' && context.changedPaths.some(p =>
    p.includes('learning/') || p.includes('improvements/')
  )) {
    return 'standard';
  }

  // Default PR → smoke test only
  return 'smoke';
}
```

**CI/CD Integration (GitHub Actions):**

```yaml
# .github/workflows/validation.yml
name: E2E Validation

on:
  pull_request:
    paths:
      - 'src/learning/**'
      - 'src/hooks/**'
  schedule:
    - cron: '0 2 * * *'  # Nightly at 2 AM
  workflow_dispatch:
    inputs:
      tier:
        description: 'Validation tier'
        required: true
        default: 'standard'
        type: choice
        options: [smoke, standard, deep, release]

jobs:
  validate:
    runs-on: ubuntu-latest
    timeout-minutes: 360  # 6 hours max

    steps:
      - uses: actions/checkout@v4

      - name: Determine validation tier
        id: tier
        run: |
          if [ "${{ github.event_name }}" == "schedule" ]; then
            echo "tier=deep" >> $GITHUB_OUTPUT
          elif [ "${{ github.event_name }}" == "workflow_dispatch" ]; then
            echo "tier=${{ inputs.tier }}" >> $GITHUB_OUTPUT
          else
            echo "tier=smoke" >> $GITHUB_OUTPUT
          fi

      - name: Run validation
        run: claudemem validate --tier=${{ steps.tier.outputs.tier }}

      - name: Upload results
        uses: actions/upload-artifact@v4
        with:
          name: validation-results
          path: .claudemem/validation/
```

---

### 3. CLI Commands

```bash
# Run validation experiment for pending improvements
claudemem validate --improvements=all-pending

# Run specific scenarios
claudemem validate --scenarios=file-create,code-search --runs=20

# View validation results
claudemem validate --results

# Run nightly validation (cron-compatible)
claudemem validate --nightly --report=json > /var/log/claudemem-validation.json
```

### 3. Integration with A/B Testing

The validation system integrates directly with the existing `ABTestManager`:

```typescript
// When synthetic sessions run, they're recorded like real sessions
abManager.recordSessionMetrics(experimentId, group, {
  corrections: session.metrics.correctionCount,
  errors: session.metrics.errorCount,
  autonomousCompletions: session.outcome === "success" ? 1 : 0,
  avgSessionDurationMs: session.durationMs,
});

// Graduation decision uses same statistical framework
const decision = abManager.evaluateExperiment(experimentId);
```

---

## Example Output

```
┌─────────────────────────────────────────────────────────────────────────────┐
│              VALIDATION EXPERIMENT RESULTS: val_1704444800000               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  IMPROVEMENTS TESTED                                                         │
│  ├── auto-glob-to-read (skill)                                              │
│  ├── prevent-bash-timeout (skill)                                           │
│  └── clarify-ambiguous (prompt)                                              │
│                                                                              │
│  SCENARIOS RUN: 10 scenarios × 20 runs = 200 total sessions                 │
│                                                                              │
├─────────────────────────────────────────────────────────────────────────────┤
│  BASELINE vs TREATMENT                                                       │
│                                                                              │
│  Metric           Baseline    Treatment    Change     p-value   Sig?        │
│  ────────────────────────────────────────────────────────────────────       │
│  Correction Rate  18.3%       12.1%        -33.9% ↓   0.0023    ✅           │
│  Success Rate     72.0%       84.5%        +17.4% ↑   0.0089    ✅           │
│  Autonomy Rate    68.2%       79.3%        +16.3% ↑   0.0156    ✅           │
│  Avg Duration     45.2s       38.7s        -14.4% ↓   0.0412    ✅           │
│  Error Rate       8.1%        6.2%         -23.5% ↓   0.1230    ❌           │
│                                                                              │
├─────────────────────────────────────────────────────────────────────────────┤
│  PER-SCENARIO BREAKDOWN                                                      │
│                                                                              │
│  Scenario                  Base Success  Treat Success  Improvement         │
│  ──────────────────────────────────────────────────────────────────         │
│  file-create-component     85%           95%            +10% ✅              │
│  code-search-auth          70%           85%            +15% ✅              │
│  refactor-rename           60%           80%            +20% ✅              │
│  error-recovery-bash       50%           65%            +15% ✅              │
│  ambiguous-add-feature     40%           70%            +30% ✅              │
│  git-commit-workflow       90%           95%            +5%                  │
│  write-unit-tests          65%           75%            +10% ✅              │
│  debug-runtime-error       55%           70%            +15% ✅              │
│  multi-file-migration      45%           60%            +15% ✅              │
│  document-api              80%           90%            +10% ✅              │
│                                                                              │
├─────────────────────────────────────────────────────────────────────────────┤
│  DECISION: ✅ GRADUATE                                                       │
│  Confidence: 99.77%                                                          │
│  Reason: 4/5 metrics significantly improved                                  │
│                                                                              │
│  Recommendations:                                                            │
│  ├── Deploy improvements to 100% of sessions                                │
│  ├── Continue monitoring correction rate in production                       │
│  └── Schedule follow-up validation in 7 days                                 │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Implementation Roadmap

### Phase 1: Core Infrastructure (2-3 days)
- [ ] Create `src/learning/validation/` module
- [ ] Implement `ValidationScenario` types
- [ ] Implement `SessionRecorder` with OpenTelemetry-compatible spans
- [ ] Create `ValidationStore` (SQLite) for persisting results

### Phase 2: Scenarios (2-3 days)
- [ ] Create 10 predefined scenarios with templates
- [ ] Implement `SyntheticAgent` class
- [ ] Add correction injection logic
- [ ] Implement success criteria evaluation

### Phase 3: Experiment Engine (2-3 days)
- [ ] Implement `ExperimentEngine` orchestration
- [ ] Integrate with existing `ABTestManager`
- [ ] Add statistical comparison logic
- [ ] Implement decision engine

### Phase 4: CLI & Integration (1-2 days)
- [ ] Add `claudemem validate` CLI command
- [ ] Create JSON/CLI reporters
- [ ] Add nightly cron job support
- [ ] Documentation

---

## Key Innovations

1. **Synthetic Users, Not Real Users**: Fast, reproducible, no privacy concerns
2. **Scenario-Based Testing**: Tests specific capabilities, not random interactions
3. **Correction Injection**: Simulates realistic user behavior including frustration
4. **Persona Variation**: Tests with novice, intermediate, expert simulated users
5. **Integration with A/B Testing**: Reuses existing statistical framework
6. **OpenTelemetry-Compatible**: Standard observability format for tooling
7. **Deterministic Replay**: Can re-run exact scenarios for debugging

---

## Sources

- [OpenTelemetry AI Agent Observability](https://opentelemetry.io/blog/2025/ai-agent-observability/)
- [τ-Bench: Benchmarking AI Agents](https://sierra.ai/blog/benchmarking-ai-agents)
- [AgentRR: Record & Replay for LLM Agents](https://arxiv.org/abs/2505.17716)
- [RAISE: Simulated Experience for Agent Improvement](https://openreview.net/pdf?id=53oRwdZe6k)
- [Langfuse AI Agent Observability](https://langfuse.com/blog/2024-07-ai-agent-observability-with-langfuse)
- [Anthropic Bloom: Automated Behavioral Evaluations](https://alignment.anthropic.com/2025/bloom-auto-evals/)
- [AgentBench: Comprehensive LLM Agent Benchmark](https://github.com/THUDM/AgentBench)
- [KDD 2025: Evaluation & Benchmarking of LLM Agents](https://sap-samples.github.io/llm-agents-eval-tutorial/)
- [AI A/B Testing: Multi-Armed Bandits](https://www.omniconvert.com/blog/ai-ab-testing/)
- [Evidently AI: Agent Benchmarks](https://www.evidentlyai.com/blog/ai-agent-benchmarks)
