# AI Validation Techniques for Continuous Learning Systems

## Executive Summary

This document describes the validation techniques used in claudemem's User-Agent Interaction Monitoring & Continuous Learning System. The system automatically learns from user-agent interactions, generates improvements (skills, subagents, prompt optimizations), and validates their effectiveness using a multi-layer statistical approach.

**Key Innovation**: Unlike traditional A/B testing that requires millions of users, our approach is designed for **local, project-scoped learning** with limited session data. We combine implicit feedback signals, Bayesian statistics, and novel metrics like "Code Survival Rate" to validate improvements with smaller sample sizes.

---

## Table of Contents

1. [Validation Philosophy](#1-validation-philosophy)
2. [Implicit Feedback Signals](#2-implicit-feedback-signals)
3. [Session Quality Scoring](#3-session-quality-scoring)
4. [A/B Testing Framework](#4-ab-testing-framework)
5. [Statistical Methods](#5-statistical-methods)
6. [Long-Term Monitoring](#6-long-term-monitoring)
7. [Adversarial Safety Validation](#7-adversarial-safety-validation)
8. [Federated Validation](#8-federated-validation)
9. [Implementation Architecture](#9-implementation-architecture)
10. [Best Practices](#10-best-practices)

---

## 1. Validation Philosophy

### 1.1 The Challenge

Traditional ML validation assumes:
- Large datasets (millions of samples)
- Clear ground truth labels
- Centralized data collection
- Stationary distributions

Our context is different:
- **Limited data**: 50-500 sessions per project
- **No explicit labels**: Users rarely rate agent responses
- **Local-first**: Data stays on user's machine
- **Evolving context**: Codebases change constantly

### 1.2 Our Approach

We solve this through:

1. **Implicit Feedback Mining**: Extract signal from user behavior, not explicit ratings
2. **Composite Scoring**: Combine multiple weak signals into strong quality metrics
3. **Bayesian Statistics**: Make decisions with smaller sample sizes
4. **Continuous Monitoring**: Track improvements over time, not just at deployment
5. **Adversarial Testing**: Attack improvements before deployment to ensure safety

### 1.3 Validation Goals

| Goal | Metric | Target |
|------|--------|--------|
| Improvements help users | Quality score increase | > 10% |
| No regressions | Error rate | No significant increase |
| Safe to deploy | Safety score | > 0.9 for auto-deploy |
| Statistically valid | P-value | < 0.05 |
| Long-term stability | 30-day retention | No degradation |

---

## 2. Implicit Feedback Signals

### 2.1 Signal Types

We collect implicit feedback signals that indicate user satisfaction without requiring explicit ratings:

#### Negative Signals (Something went wrong)

| Signal | Description | Weight | Detection Method |
|--------|-------------|--------|------------------|
| **Lexical Correction** | User says "no", "wrong", "actually" | 0.30 | NLP pattern matching |
| **Strategy Pivot** | Sudden change in tool usage after failure | 0.20 | Tool sequence analysis |
| **Overwrite** | User edits same file region agent modified | 0.35 | Diff analysis |
| **Reask** | User repeats similar prompt | 0.15 | Semantic similarity |

#### Positive Signals (Things went well)

| Signal | Description | Strength | Detection Method |
|--------|-------------|----------|------------------|
| **Task Completion** | Session ends without abandonment | Medium | Session outcome tracking |
| **Code Survival** | Agent's code makes it to git commit | Strong | Git hook integration |
| **Retry Reduction** | Fewer attempts for similar tasks | Medium | Task type clustering |
| **Efficiency Gain** | Faster completion than historical average | Medium | Duration comparison |
| **Autonomy** | Less user intervention needed | Medium | Intervention counting |

### 2.2 Correction Score Formula

The correction score combines multiple signals into a single metric:

```
correction_score = w_lexical × lexical +
                   w_pivot × pivot +
                   w_overwrite × overwrite +
                   w_reask × reask

Where:
  w_lexical = 0.30   (verbal correction indicators)
  w_pivot = 0.20     (behavioral change indicators)
  w_overwrite = 0.35 (code modification indicators)
  w_reask = 0.15     (repeated attempt indicators)
```

**Interpretation**:
- Score > 0.7: Strong correction signal (agent likely made a mistake)
- Score 0.4-0.7: Moderate correction (possible misunderstanding)
- Score < 0.4: No significant correction detected

### 2.3 Code Survival Rate

The strongest positive signal we can measure locally:

```
code_survival_rate = lines_kept / lines_written_by_agent

Where:
  lines_kept = agent-written lines that appear in final git commit
  lines_written_by_agent = total lines agent wrote during session
```

**Why this matters**:
- If a user keeps agent's code → agent did well
- If a user rewrites everything → agent failed
- Direct measurement of real-world value

**Implementation**:
1. Track file changes during session (who wrote what)
2. On git commit, compare committed content vs. session changes
3. Calculate overlap between agent's version and committed version
4. Higher overlap = better agent performance

---

## 3. Session Quality Scoring

### 3.1 Quality Score Components

Each session receives a quality score (0.0 to 1.0) based on five components:

```typescript
interface SessionQualityScore {
  overallScore: number;  // Weighted combination

  components: {
    taskCompletion: number;    // 0-1: Did session end successfully?
    correctionRate: number;    // 0-1: Inverse of corrections (fewer = better)
    autonomyRate: number;      // 0-1: Agent worked independently
    codeSurvival: number;      // 0-1: Code made it to commit
    efficiency: number;        // 0-1: Faster than historical average
  };
}
```

### 3.2 Scoring Formula

```
overall_score = w1 × task_completion +
                w2 × (1 - correction_rate) +
                w3 × autonomy_rate +
                w4 × code_survival +
                w5 × efficiency

Default weights:
  w1 = 0.20  (task completion)
  w2 = 0.25  (inverse corrections - most important negative signal)
  w3 = 0.15  (autonomy)
  w4 = 0.30  (code survival - strongest positive signal)
  w5 = 0.10  (efficiency)
```

### 3.3 Task Type Normalization

Different tasks have different baseline difficulty. We normalize scores by task type:

| Task Type | Detection Pattern | Baseline Quality | Adjustment |
|-----------|-------------------|------------------|------------|
| `fix_bug` | Edit → Bash(test) | 0.65 | +0.05 |
| `add_feature` | Write → Edit → Bash | 0.60 | +0.10 |
| `refactor` | Read → Edit (multiple) | 0.55 | +0.15 |
| `write_tests` | Read → Write(test) | 0.70 | 0.00 |
| `documentation` | Write(md) | 0.80 | -0.10 |

**Normalized score** = raw_score / task_baseline

This enables fair comparison across different session types.

---

## 4. A/B Testing Framework

### 4.1 Experiment Design

When a new improvement is proposed, we test it with controlled rollout:

```
┌─────────────────────────────────────────────────────────────┐
│                    A/B TEST LIFECYCLE                        │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  PROPOSED → TESTING → GRADUATED/ROLLED_BACK → MONITORING    │
│                                                              │
│  Phase 1: Testing (10% traffic)                             │
│  ├── Minimum 100 sessions                                   │
│  ├── Minimum 7 days                                         │
│  └── Statistical significance required                      │
│                                                              │
│  Phase 2: Graduation (100% traffic)                         │
│  ├── If p-value < 0.05 and improvement > 10%               │
│  └── Automatic rollback if metrics degrade                  │
│                                                              │
│  Phase 3: Monitoring (ongoing)                              │
│  ├── 30/60/90 day check-ins                                │
│  └── Regression detection                                   │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### 4.2 Traffic Splitting

```typescript
interface TrafficAllocation {
  control: number;    // Percentage without improvement
  treatment: number;  // Percentage with improvement
}

// Default: 90/10 split
const allocation = {
  control: 90,
  treatment: 10
};

// Session assignment (deterministic hash)
function assignSession(sessionId: string, experimentId: string): "control" | "treatment" {
  const hash = murmurhash3(sessionId + experimentId);
  const bucket = hash % 100;
  return bucket < allocation.treatment ? "treatment" : "control";
}
```

### 4.3 Metrics Tracked Per Experiment

| Metric | Description | Direction |
|--------|-------------|-----------|
| `sessions` | Total sessions per group | Higher = more confidence |
| `corrections` | Total correction events | Lower = better |
| `errors` | Tool errors encountered | Lower = better |
| `autonomousCompletions` | Sessions without intervention | Higher = better |
| `avgQualityScore` | Mean session quality | Higher = better |
| `codeSurvivalRate` | Percentage of code surviving to commit | Higher = better |

### 4.4 Experiment Decision Criteria

```typescript
function evaluateExperiment(experiment: Experiment): ExperimentDecision {
  const { controlMetrics, treatmentMetrics, statisticalResult } = experiment;

  // Must have statistical significance
  if (!statisticalResult.isSignificant) {
    if (experiment.durationMs > MAX_DURATION) {
      return { action: "rollback", reason: "Inconclusive after max duration" };
    }
    return { action: "continue", reason: "Awaiting significance" };
  }

  // Check improvement threshold
  if (statisticalResult.relativeImprovement >= MIN_IMPROVEMENT) {
    return { action: "graduate", reason: `${improvement}% improvement, p=${pValue}` };
  }

  // Significant but negative
  if (statisticalResult.relativeImprovement < 0) {
    return { action: "rollback", reason: "Significant regression detected" };
  }

  return { action: "extend", reason: "Improvement below threshold" };
}
```

---

## 5. Statistical Methods

### 5.1 Two-Proportion Z-Test (Primary)

Used for comparing rates (correction rate, autonomy rate) between control and treatment:

```
z = (p1 - p2) / sqrt(p_pooled × (1 - p_pooled) × (1/n1 + 1/n2))

Where:
  p1 = treatment success rate
  p2 = control success rate
  p_pooled = (x1 + x2) / (n1 + n2)
  n1, n2 = sample sizes
```

**When to use**: Comparing binary outcomes (success/failure) between groups.

### 5.2 Welch's T-Test

Used for comparing means (quality scores, session duration) with unequal variances:

```
t = (x̄1 - x̄2) / sqrt(s1²/n1 + s2²/n2)

Degrees of freedom (Welch-Satterthwaite):
df = (s1²/n1 + s2²/n2)² / ((s1²/n1)²/(n1-1) + (s2²/n2)²/(n2-1))
```

**When to use**: Comparing continuous metrics between groups.

### 5.3 Thompson Sampling (Bayesian)

For small-sample scenarios where traditional tests lack power:

```typescript
class ThompsonSampling {
  // Beta distribution parameters per arm
  private alpha: Map<string, number>;  // Successes + 1
  private beta: Map<string, number>;   // Failures + 1

  // Sample from posterior to select arm
  recommend(context: TaskContext): string {
    const samples = [];

    for (const [arm, a] of this.alpha) {
      const b = this.beta.get(arm)!;
      const sample = this.sampleBeta(a, b);
      samples.push({ arm, sample });
    }

    // Return arm with highest sample
    return samples.sort((a, b) => b.sample - a.sample)[0].arm;
  }

  // Update posteriors with outcome
  update(arm: string, success: boolean): void {
    if (success) {
      this.alpha.set(arm, this.alpha.get(arm)! + 1);
    } else {
      this.beta.set(arm, this.beta.get(arm)! + 1);
    }
  }
}
```

**Advantages for our use case**:
- Works with 20-50 samples (vs. thousands for frequentist tests)
- Natural exploration/exploitation balance
- Continuous learning (no fixed experiment duration)

### 5.4 CUSUM for Change Detection

Cumulative sum control chart for detecting when metrics shift:

```
S_t = max(0, S_{t-1} + (x_t - μ_0 - k))

Where:
  S_t = cumulative sum at time t
  x_t = observation at time t
  μ_0 = target mean (baseline)
  k = allowance parameter (typically σ/2)

Alert when S_t > h (threshold, typically 4-5 × σ)
```

**Use case**: Detecting when a graduated improvement starts degrading.

### 5.5 Effect Size (Cohen's d)

Beyond statistical significance, we measure practical significance:

```
d = (x̄1 - x̄2) / s_pooled

Where:
  s_pooled = sqrt(((n1-1)s1² + (n2-1)s2²) / (n1 + n2 - 2))
```

**Interpretation**:
- d < 0.2: Negligible effect
- 0.2 ≤ d < 0.5: Small effect
- 0.5 ≤ d < 0.8: Medium effect
- d ≥ 0.8: Large effect

**Requirement**: We require both p < 0.05 AND d ≥ 0.3 for graduation.

---

## 6. Long-Term Monitoring

### 6.1 Post-Graduation Tracking

After an improvement graduates from A/B testing, we continue monitoring:

```
┌─────────────────────────────────────────────────────────────┐
│              POST-GRADUATION MONITORING                      │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  DAY 0: Graduation                                          │
│  ├── Baseline metrics recorded                              │
│  └── Full traffic enabled                                   │
│                                                              │
│  DAY 7: First Check-in                                      │
│  ├── Compare vs. graduation baseline                        │
│  └── Alert if > 10% degradation                            │
│                                                              │
│  DAY 30: Monthly Review                                     │
│  ├── Trend analysis                                         │
│  ├── Compare vs. pre-improvement baseline                   │
│  └── Decision: Continue / Flag / Rollback                   │
│                                                              │
│  DAY 60/90: Quarterly Review                                │
│  ├── Long-term stability assessment                         │
│  └── Concept drift detection                                │
│                                                              │
│  ONGOING: Anomaly Detection                                 │
│  ├── CUSUM monitoring                                       │
│  └── Automatic alerts on regression                         │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### 6.2 Regression Detection

```typescript
interface RegressionDetector {
  // Check if metrics have degraded
  checkForRegression(
    improvementId: string,
    currentMetrics: MetricsSnapshot,
    baselineMetrics: MetricsSnapshot
  ): RegressionResult;
}

interface RegressionResult {
  hasRegression: boolean;
  severity: "minor" | "moderate" | "severe";
  affectedMetrics: string[];
  recommendation: "monitor" | "investigate" | "rollback";
}

// Thresholds
const REGRESSION_THRESHOLDS = {
  minor: 0.05,      // 5% degradation
  moderate: 0.10,   // 10% degradation
  severe: 0.20,     // 20% degradation
};
```

### 6.3 Concept Drift Detection

Over time, codebases and user behavior change. We detect when improvements become stale:

```typescript
interface ConceptDriftDetector {
  // Compare recent patterns to historical patterns
  detectDrift(
    recentSessions: SessionQualityScore[],
    historicalBaseline: SessionQualityScore[]
  ): DriftResult;
}

interface DriftResult {
  hasDrift: boolean;
  driftType: "gradual" | "sudden" | "recurring";
  driftedFeatures: string[];  // Which signals changed
  recommendation: "retrain" | "monitor" | "investigate";
}
```

**Detection methods**:
1. **Distribution comparison**: KL divergence between recent and historical quality scores
2. **Feature monitoring**: Track individual signal distributions over time
3. **Prediction error**: If improvement's "expected impact" diverges from actual

---

## 7. Adversarial Safety Validation

### 7.1 Red Team / Blue Team Framework

Before deploying improvements, we attack them to find vulnerabilities:

```
┌─────────────────────────────────────────────────────────────┐
│                ADVERSARIAL VALIDATION                        │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  RED TEAM (Attack)                 BLUE TEAM (Defend)       │
│  ┌─────────────────────┐          ┌─────────────────────┐   │
│  │ • Edge case inputs  │          │ • Input validation  │   │
│  │ • Malformed data    │    →     │ • Output sanitize   │   │
│  │ • Injection attacks │          │ • Resource limits   │   │
│  │ • Resource exhaust  │          │ • Error handling    │   │
│  │ • Sequence manipu   │          │ • Sequence enforce  │   │
│  └─────────────────────┘          └─────────────────────┘   │
│           ↓                                ↓                 │
│  ┌─────────────────────────────────────────────────────┐    │
│  │              SAFETY SCORER                           │    │
│  │                                                      │    │
│  │  Score = 0.30 × red_team_resilience +               │    │
│  │          0.35 × blue_team_coverage +                │    │
│  │          0.20 × pattern_confidence +                │    │
│  │          0.15 × historical_performance              │    │
│  │                                                      │    │
│  │  Decision:                                          │    │
│  │  • Score ≥ 0.90 → Auto-deploy                       │    │
│  │  • Score ≥ 0.70 → Human review                      │    │
│  │  • Score < 0.70 → Reject                            │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### 7.2 Attack Types

| Attack Type | Description | Severity |
|-------------|-------------|----------|
| `edge_case` | Unusual but valid inputs | Medium |
| `malformed_input` | Invalid data formats | High |
| `injection` | Command/code injection attempts | Critical |
| `resource_exhaustion` | Memory/CPU exhaustion | High |
| `sequence_manipulation` | Unexpected tool orderings | Medium |
| `boundary_violation` | Out-of-bounds operations | High |
| `state_corruption` | Invalid state transitions | Critical |

### 7.3 Defense Mitigations

| Mitigation Type | Description | Effectiveness |
|-----------------|-------------|---------------|
| `input_validation` | Validate all inputs | 0.9 |
| `output_sanitization` | Sanitize generated content | 0.85 |
| `resource_limiting` | Cap memory/time usage | 0.8 |
| `sequence_enforcement` | Validate tool sequences | 0.75 |
| `access_control` | Limit file/command access | 0.9 |
| `error_handling` | Graceful failure modes | 0.7 |
| `logging` | Audit trail | 0.5 |

### 7.4 Safety Score Calculation

```typescript
function calculateSafetyScore(
  redTeamReport: RedTeamReport,
  blueTeamReport: BlueTeamReport,
  patternConfidence: number,
  historicalPerformance: number
): SafetyScoreResult {

  // Red team: How many attacks were resisted?
  const redTeamScore = redTeamReport.attacksResisted / redTeamReport.totalAttacks;

  // Blue team: How complete is the defense?
  const blueTeamScore = blueTeamReport.overallCoverage;

  // Weighted combination
  const overallScore =
    0.30 * redTeamScore +
    0.35 * blueTeamScore +
    0.20 * patternConfidence +
    0.15 * historicalPerformance;

  // Determine deployment decision
  let decision: DeploymentDecision;
  if (overallScore >= 0.90) {
    decision = "auto_deploy";
  } else if (overallScore >= 0.70) {
    decision = "human_review";
  } else {
    decision = "reject";
  }

  return { overallScore, decision, ... };
}
```

---

## 8. Federated Validation

### 8.1 Cross-Project Pattern Sharing

For opt-in users, we can validate improvements across projects:

```
┌─────────────────────────────────────────────────────────────┐
│                 FEDERATED VALIDATION                         │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  PROJECT A          PROJECT B          PROJECT C            │
│  ┌─────────┐        ┌─────────┐        ┌─────────┐         │
│  │ Local   │        │ Local   │        │ Local   │         │
│  │ Patterns│        │ Patterns│        │ Patterns│         │
│  └────┬────┘        └────┬────┘        └────┬────┘         │
│       │                  │                  │               │
│       ▼                  ▼                  ▼               │
│  ┌──────────────────────────────────────────────────┐      │
│  │            PATTERN HASHER                         │      │
│  │  • Anonymize with differential privacy           │      │
│  │  • Apply k-anonymity (min 5 occurrences)        │      │
│  │  • Hash sensitive details                        │      │
│  └──────────────────────────────────────────────────┘      │
│                          │                                  │
│                          ▼                                  │
│  ┌──────────────────────────────────────────────────┐      │
│  │            SYNC COORDINATOR                       │      │
│  │  • Exchange anonymized patterns                  │      │
│  │  • Aggregate with trust scoring                  │      │
│  │  • Validate: "Works in 80% of projects"         │      │
│  └──────────────────────────────────────────────────┘      │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### 8.2 Privacy Protections

| Protection | Method | Parameter |
|------------|--------|-----------|
| **Differential Privacy** | Laplace noise | ε = 1.0 |
| **K-Anonymity** | Minimum count threshold | k = 5 |
| **Structural Hashing** | One-way hash of patterns | SHA-256 |
| **No Content Sharing** | Only metrics, never code | N/A |

### 8.3 Federated Validation Metrics

```typescript
interface FederatedValidationResult {
  improvementId: string;

  // Cross-project performance
  projectsUsing: number;
  projectsWithSuccess: number;
  successRate: number;  // projectsWithSuccess / projectsUsing

  // Aggregated metrics
  avgQualityImprovement: number;
  avgCorrectionReduction: number;

  // Confidence
  confidence: number;  // Higher with more projects
  recommendation: "adopt" | "test" | "avoid";
}
```

---

## 9. Implementation Architecture

### 9.1 Module Structure

```
src/learning/
├── interaction/           # Data Collection
│   ├── interaction-store.ts    # SQLite storage
│   ├── session-tracker.ts      # Session lifecycle
│   ├── tool-event-logger.ts    # Tool execution events
│   ├── correction-scorer.ts    # Multi-signal corrections
│   └── types.ts                # Shared types
│
├── analysis/              # Pattern Detection
│   ├── pattern-miner.ts        # FP-Growth algorithm
│   ├── error-clusterer.ts      # Error clustering
│   └── workflow-detector.ts    # Workflow patterns
│
├── generator/             # Improvement Generation
│   ├── skill-generator.ts      # Generate skills
│   ├── subagent-composer.ts    # Generate subagents
│   ├── prompt-optimizer.ts     # Optimize prompts
│   └── safety-validator.ts     # Pre-deployment safety
│
├── deployment/            # A/B Testing & Rollout
│   ├── ab-testing.ts           # Experiment management
│   ├── metrics-tracker.ts      # Time-series metrics
│   └── rollback.ts             # Regression handling
│
├── validation/            # Validation Pipeline (NEW)
│   ├── session-quality-scorer.ts   # Quality scoring
│   ├── outcome-tracker.ts          # Long-term outcomes
│   ├── cohort-analyzer.ts          # Before/after analysis
│   └── learning-dashboard.ts       # Aggregate reporting
│
├── shadow/                # Shadow Agent
│   ├── shadow-predictor.ts     # Tool prediction
│   └── deviation-detector.ts   # Anomaly detection
│
├── bandit/                # Adaptive Selection
│   ├── tool-bandit.ts          # Thompson Sampling
│   └── context-encoder.ts      # Context features
│
├── federated/             # Cross-Project Learning
│   ├── pattern-hasher.ts       # Privacy-preserving hash
│   └── sync-coordinator.ts     # Pattern exchange
│
└── adversarial/           # Safety Testing
    ├── red-team.ts             # Attack simulation
    ├── blue-team.ts            # Defense validation
    └── safety-scorer.ts        # Final safety score
```

### 9.2 Data Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           VALIDATION DATA FLOW                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  USER SESSION                                                                │
│       │                                                                      │
│       ▼                                                                      │
│  ┌─────────────┐     ┌─────────────┐     ┌─────────────┐                   │
│  │ Interaction │ ──▶ │  Pattern    │ ──▶ │ Improvement │                   │
│  │   Store     │     │   Miner     │     │  Generator  │                   │
│  └─────────────┘     └─────────────┘     └─────────────┘                   │
│       │                                         │                            │
│       │                                         ▼                            │
│       │              ┌─────────────────────────────────────┐                │
│       │              │        ADVERSARIAL TESTING           │                │
│       │              │  ┌──────────┐    ┌──────────┐       │                │
│       │              │  │ Red Team │ ──▶│Blue Team │       │                │
│       │              │  └──────────┘    └──────────┘       │                │
│       │              │           │              │          │                │
│       │              │           ▼              ▼          │                │
│       │              │     ┌─────────────────────┐         │                │
│       │              │     │   Safety Scorer     │         │                │
│       │              │     └─────────────────────┘         │                │
│       │              └─────────────────────────────────────┘                │
│       │                             │                                        │
│       │                             ▼                                        │
│       │              ┌─────────────────────────────────────┐                │
│       │              │         A/B TESTING                  │                │
│       │              │  ┌───────────┐  ┌───────────┐       │                │
│       │              │  │  Control  │  │ Treatment │       │                │
│       │              │  │   Group   │  │   Group   │       │                │
│       │              │  └───────────┘  └───────────┘       │                │
│       │              └─────────────────────────────────────┘                │
│       │                             │                                        │
│       ▼                             ▼                                        │
│  ┌─────────────┐     ┌─────────────────────────────────────┐                │
│  │  Quality    │ ──▶ │      COHORT ANALYSIS                 │                │
│  │  Scoring    │     │  • Before vs. After                  │                │
│  └─────────────┘     │  • Statistical validation            │                │
│       │              │  • Effect size calculation           │                │
│       │              └─────────────────────────────────────┘                │
│       │                             │                                        │
│       ▼                             ▼                                        │
│  ┌─────────────┐     ┌─────────────────────────────────────┐                │
│  │  Outcome    │ ──▶ │      LONG-TERM MONITORING            │                │
│  │  Tracker    │     │  • Post-graduation tracking          │                │
│  └─────────────┘     │  • Regression detection              │                │
│                      │  • Concept drift                      │                │
│                      └─────────────────────────────────────┘                │
│                                     │                                        │
│                                     ▼                                        │
│                      ┌─────────────────────────────────────┐                │
│                      │      LEARNING DASHBOARD              │                │
│                      │  • Overall system health             │                │
│                      │  • Per-improvement validation        │                │
│                      │  • Recommendations                   │                │
│                      └─────────────────────────────────────┘                │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 10. Best Practices

### 10.1 Validation Checklist

Before deploying any improvement:

- [ ] **Pattern Confidence**: ≥ 0.7 (based on occurrence count and consistency)
- [ ] **Safety Score**: ≥ 0.9 for auto-deploy, ≥ 0.7 for human review
- [ ] **Red Team Passed**: Resisted ≥ 80% of attacks
- [ ] **Blue Team Coverage**: ≥ 85% of attack types mitigated
- [ ] **A/B Test**: Statistical significance (p < 0.05) achieved
- [ ] **Effect Size**: Cohen's d ≥ 0.3 (practical significance)
- [ ] **Sample Size**: ≥ 100 sessions per group

### 10.2 Anti-Patterns to Avoid

| Anti-Pattern | Problem | Solution |
|--------------|---------|----------|
| **Peeking** | Checking results before minimum duration | Wait for minimum sample size |
| **P-hacking** | Testing multiple hypotheses | Pre-register primary metric |
| **Survivorship Bias** | Only tracking successful sessions | Track all sessions including abandoned |
| **Simpson's Paradox** | Aggregating across task types | Stratify by task type |
| **Reward Hacking** | Optimizing proxy metrics | Use composite scoring |

### 10.3 Interpreting Results

**Positive Result** (improvement works):
- Quality score increase ≥ 10%
- Correction rate decrease ≥ 15%
- p-value < 0.05
- Effect size d ≥ 0.3

**Inconclusive Result**:
- p-value > 0.05 after max duration
- Effect size d < 0.2
- High variance in metrics

**Negative Result** (improvement harmful):
- Quality score decrease
- Correction rate increase
- Any critical safety issue

### 10.4 Continuous Improvement

The validation system itself should be validated:

1. **Calibration**: Are our quality scores predictive of real outcomes?
2. **Coverage**: Are we catching regressions before users notice?
3. **Efficiency**: Are we making decisions fast enough?
4. **False Positives**: Are we rejecting good improvements?
5. **False Negatives**: Are we deploying harmful improvements?

Track these meta-metrics monthly.

---

## Appendix A: Statistical Reference

### A.1 Sample Size Calculations

For two-proportion z-test with 80% power and α = 0.05:

| Expected Effect | Baseline Rate | Required N per Group |
|-----------------|---------------|---------------------|
| 10% relative improvement | 50% | 408 |
| 15% relative improvement | 50% | 182 |
| 20% relative improvement | 50% | 103 |
| 10% relative improvement | 20% | 544 |
| 20% relative improvement | 20% | 138 |

### A.2 Bayesian Priors

Default priors for Thompson Sampling:

| Metric | Prior Distribution | Parameters |
|--------|-------------------|------------|
| Success rate | Beta | α=1, β=1 (uniform) |
| Quality score | Normal | μ=0.6, σ=0.15 |
| Duration | Gamma | α=2, β=0.001 |

### A.3 Confidence Intervals

95% CI for proportion:
```
CI = p ± 1.96 × sqrt(p(1-p)/n)
```

95% CI for difference in proportions:
```
CI = (p1-p2) ± 1.96 × sqrt(p1(1-p1)/n1 + p2(1-p2)/n2)
```

---

## Appendix B: Glossary

| Term | Definition |
|------|------------|
| **Correction Gap** | The difference between agent's output and user's final version |
| **Code Survival Rate** | Percentage of agent-written code that survives to git commit |
| **Quality Score** | Composite metric (0-1) measuring session quality |
| **Implicit Feedback** | Signals inferred from behavior, not explicit ratings |
| **Thompson Sampling** | Bayesian algorithm balancing exploration and exploitation |
| **CUSUM** | Cumulative sum control chart for change detection |
| **Effect Size** | Standardized measure of practical significance (Cohen's d) |
| **Concept Drift** | When underlying data distribution changes over time |
| **Federated Validation** | Cross-project validation with privacy protection |
| **Red Team** | Simulated attacks on improvements to find vulnerabilities |
| **Blue Team** | Defensive measures applied to improvements |
| **Safety Score** | Combined score determining deployment eligibility |

---

## Appendix C: References

### Academic Papers
1. Meta AI. "Reinforcement Learning from User Feedback" (2025). arXiv:2505.14946
2. "Interaction Dynamics as a Reward Signal for LLMs" (2025). arXiv:2511.08394
3. "Agent A/B: Automated and Scalable Web A/B Testing" (2025). arXiv:2504.09723

### Industry Resources
1. Dynatrace. "AI Model Versioning and A/B Testing for LLM Services" (2025)
2. Tray.ai. "How to Measure AI Agent Performance" (2025)
3. Neptune.ai. "Retraining Model During Deployment" (2025)
4. Martin Fowler. "Continuous Delivery for Machine Learning" (2025)

### Internal Documentation
- `src/learning/interaction/types.ts` - Type definitions
- `src/learning/deployment/ab-testing.ts` - A/B test implementation
- `src/learning/adversarial/` - Safety validation implementation

---

*Document Version: 1.0*
*Last Updated: January 2026*
*Maintainer: claudemem Development Team*
