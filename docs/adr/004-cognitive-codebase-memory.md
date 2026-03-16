# ADR-004: Cognitive Codebase Memory with Session Enrichment

**Status:** Proposed
**Date:** 2026-03-04

---

## Context

### The Problem

AI coding agents rediscover the same project knowledge every session. An agent implementing auth refresh tokens today will encounter the same hidden footguns, make the same discoveries about token signing configuration, and learn the same singleton pattern constraints as every agent that has worked on that codebase before. Those discoveries vanish when the session ends.

claudemem already solves the static retrieval problem: AST-parsed code chunks, semantic embeddings, a symbol graph with PageRank. A new agent can search the codebase meaningfully from session one. But the index only knows what is written in the code. It does not know what agents have learned by working with the code.

There is no production AI coding tool today that automatically accumulates project-specific knowledge from agent sessions and surfaces it for future agents at the moment it is needed. This ADR describes the architecture to build that capability in claudemem.

### Research Background

This decision is grounded in a multi-source research session conducted on 2026-03-04:

- **Deep comparative analysis**: MuninnDB (a general-purpose cognitive AI memory database written in Go) was studied at the source-code level — 25+ source files, 6 official documentation files, cognitive primitive implementations. MuninnDB serves as an architectural blueprint for cognitive memory primitives, not as a dependency.
- **Cognitive science review**: ACT-R (Adaptive Control of Thought-Rational, Anderson 1993) base-level activation theory and Hebbian associative learning were reviewed for applicability to code search ranking.
- **Academic literature**: Key papers from 2023–2026 were reviewed: Generative Agents (Park et al., 2023), Dynamic Cheatsheet (arXiv 2504.07952), ETH Zurich's AGENTS.md evaluation (arXiv 2602.11988), SkillsBench (arXiv 2602.12670), MemGPT (Packer et al., 2023), Voyager (Wang et al., 2023).
- **Competitor analysis**: Cursor, Windsurf, Claude Code, GitHub Copilot, Aider, Continue.dev, and Cody were analyzed for their project memory mechanisms.
- **claudemem source analysis**: The existing learning module (`src/learning/`), memory store (`src/memory/`), and enrichment pipeline (`src/core/enrichment/`) were analyzed to map existing infrastructure to the proposed architecture.

Research artifacts are in: `ai-docs/sessions/dev-research-claudemem-vs-muninndb-20260304-143632-4e8e43a3/`

### Key Research Findings

**Finding 1 — No production coding tool learns from agent sessions (UNANIMOUS)**

Every mainstream AI coding assistant uses static, manually-maintained text files as its primary project-specific memory mechanism:

| Tool | Memory Mechanism | Learns Across Sessions? |
|------|-----------------|------------------------|
| Claude Code | CLAUDE.md (injected always) | No |
| Cursor | .cursorrules + cloud Memory beta (user-level only) | No |
| Windsurf | .windsurfrules + Memories (user-level cloud) | No |
| GitHub Copilot | .github/copilot-instructions.md | No |
| Aider | CONVENTIONS.md + git log (no semantic retrieval) | No |
| Continue.dev | LanceDB RAG, no session memory layer | No |
| Cody | cody.json + memory.jsonl (manual writes only) | No |

The only systems that learn across sessions — MuninnDB, mem0, Graphiti/Zep — are general-purpose agent memory databases with no code awareness. There is no production coding tool with session-accumulating, code-linked, semantically-retrieved memory. [Source: Explorer 8, Findings 1-10]

**Finding 2 — Auto-generated context hurts if not quality-gated (CRITICAL WARNING)**

arXiv 2602.11988 (ETH Zurich, February 2026): LLM-generated context files like CLAUDE.md reduce coding task resolve rate by **0.5–8.3 percentage points**, with +20–23% token cost overhead. 100% of LLM-generated files contained codebase overviews — obvious content that is discoverable from the code itself. The failure mode is writing content that distracts and bloats the context without adding earned knowledge.

This finding does NOT mean session observations are harmful. It means **quality gating is non-negotiable**. [Source: Explorer 8, Findings 4 and 11]

**Finding 3 — Session learning with quality gating achieves dramatic improvements**

Dynamic Cheatsheet (arXiv 2504.07952): A Curator LLM that reviews agent trajectories post-session and extracts only non-obvious, earned insights into a persistent cheatsheet achieves **10% → 99% solve rate** on Python puzzle tasks after several learning sessions. The mechanism is: agent attempts task → Curator reviews trajectory → extracts non-obvious insights → writes to cheatsheet → future sessions prepend relevant entries.

This is the direct prior art for the session enrichment pipeline proposed in this ADR. [Source: Explorer 8, Finding 9]

**Finding 4 — ACT-R temporal scoring provides 37x recency advantage**

MuninnDB's implementation of Anderson (1993) ACT-R base-level activation formula:
```
B(M) = ln(n+1) - 0.5 × ln(ageDays / (n+1))
```
Where `n` = access count, `ageDays` = days since last access, `0.5` = Anderson's decay parameter.

Worked example from MuninnDB's own benchmarks:
- 13 accesses, 10 days ago: `B = ln(14) - 0.5 × ln(10/14) = 2.64 + 0.17 = 2.81`, `softplus(2.81) ≈ 2.87`
- 1 access, 1400 days ago: `B = ln(2) - 0.5 × ln(1400/2) = 0.69 - 3.27 = -2.58`, `softplus(-2.58) ≈ 0.07`
- Ratio: **37x temporal advantage** for recently-accessed content

The formula requires only two persisted fields (`accessCount`, `lastAccess`) and zero background workers — it is computed at query time from current wall clock. [Source: Explorer 4, Q4; Explorer 5, Finding 1]

**Finding 5 — Hebbian co-access learning surfaces expert-level associations**

From MuninnDB `internal/cognitive/hebbian.go`:
```
logNew = log(current) + effectiveSignal × log(1 + HebbianLearningRate)
newWeight = min(1.0, exp(logNew))
```
Where `HebbianLearningRate = 0.01`. The signal per co-activation is the geometric product of both items' activation scores. Associations start cold at 0.01 weight and grow toward 1.0 asymptotically. The deliberate slow learning rate (0.01) prevents single-session noise from creating spurious associations — weight 0.5 requires hundreds of genuine co-activations.

Applied to code: files consistently opened together during work sessions develop weighted associations. Retrieving one surfaces the other — the "oh, you're working on JWT? you'll also need auth-middleware" pattern that senior developers carry in their heads. [Source: Explorer 4, Q2]

**Finding 6 — claudemem's learning module already has the infrastructure, but writes nothing to the index**

claudemem's `src/learning/` module contains: `SessionTracker`, `ToolEventLogger`, `InteractionStore`, `AdaptiveRanker`, `WorkflowDetector`, `PatternMiner`. Sessions are tracked. Tool calls are logged. But the learning system uses this data only to adjust global search weights — it writes zero knowledge about specific code chunks. A session that discovers "AuthService is a singleton — never instantiate in tests" leaves the index identical to before the session. [Source: Explorer 6, Finding 8; Explorer 7, Finding 5]

**Finding 7 — claudemem has 7 document types, none session-scoped**

From `src/types.ts` and `src/core/enrichment/extractors/`: `code_chunk`, `file_summary`, `symbol_summary`, `idiom`, `usage_example`, `anti_pattern`, `project_doc`. All seven are produced from static file content at index time. The `EnrichmentPipeline.extractFile()` context takes only `filePath`, `fileContent`, `codeChunks`, `language` — no session parameter, no observation injection. [Source: Explorer 7, Finding 4]

---

## Decision

### Two-Layer Cognitive Memory Architecture

claudemem will evolve from a single-layer code index to a two-layer cognitive memory system. The layers are complementary; Layer 2 does not replace Layer 1.

#### Layer 1: Static Knowledge (existing, unchanged)

- AST-parsed code chunks via tree-sitter (20 languages)
- 7 LLM enrichment document types (`file_summary`, `symbol_summary`, `idiom`, `usage_example`, `anti_pattern`, `project_doc`)
- Symbol graph with PageRank (callers, callees, dead-code, test-gaps, impact)
- Hybrid search: vector (cosine) + BM25 via Reciprocal Rank Fusion
- Git hooks, watch mode, incremental re-indexing on content hash change

Layer 1 answers: "What does this code do?" and "How is this codebase structured?"

#### Layer 2: Session-Accumulated Observations (new)

- `session_observation` document type — agent-written, chunk-linked, temporally-scored
- Written by agents mid-session via the `claudemem_observe` MCP tool
- Written automatically post-session by a Curator LLM pass
- Linked to Layer 1 chunks via `sourceChunkIds` and `affectedFiles`
- Participates in hybrid search alongside static documents
- ACT-R temporal scoring: recent observations surface above stale ones
- Confidence multiplier: low-confidence observations appear at proportionally reduced rank

Layer 2 answers: "What have agents learned by working with this code? What are the gotchas? What patterns do experts apply? What decisions were made and why?"

**Cold state**: Layer 2 is empty → behavior identical to claudemem today. No cliff edge, no degradation.
**Warm state**: Layer 2 has 50–200 observations → agent benefits from accumulated knowledge.
**Hot state**: Layer 2 has 1000+ consolidated observations → equivalent to a senior engineer's "project briefing" delivered at exactly the moment the relevant code is touched.

---

### Cognitive Primitives to Implement

#### 1. ACT-R Temporal Scoring

**What it does**: Computes a time-and-access-weighted score for every document at query time. Recently-accessed documents score higher; dormant documents fade — without hard deletion.

**Why we are adopting it**: The 37x recency advantage is empirically measured in MuninnDB's benchmarks [Explorer 4, Q4]. The implementation is purely derived computation from two persisted fields; no background workers or stored-score mutation required. Cold state (zero accesses) produces a small positive B(M) ≈ 0 — effectively neutral, preserving current behavior.

**How it maps to claudemem's architecture**:
- Add `accessCount: number` and `lastAccess: string` to all LanceDB document schemas
- Track retrievals asynchronously in `src/core/store.ts` (batch write after search)
- Apply formula to composite RRF score in the hybrid search pipeline

**Formula**:
```
B(M) = ln(n) - 0.5 × ln(max(ageDays, 1/1440) / n)
where n = accessCount + 1
ageDays = days since lastAccess (floor: 1 minute)

temporal_boost = TEMPORAL_WEIGHT × softplus(B(M))
composite_score = rrf_score + pagerank_boost + temporal_boost
```

**Implementation files**: `src/core/store.ts`, `src/types.ts`, `src/core/search/`

---

#### 2. Session Observation Documents

**What it does**: A new `DocumentType` that agents write during or after sessions, linked to specific code chunks, capturing knowledge that is not derivable from reading the code alone.

**Why we are adopting it**: CLAUDE.md proves the market wants project-specific persistent knowledge, but CLAUDE.md is global-scoped, always-injected, requires human authorship, and degrades at scale. Session observations are chunk-scoped, semantically retrieved, agent-authored with Curator quality gating, and accumulate automatically. [Source: Explorer 6, Finding 2; Explorer 8, Finding 11]

**Schema** (addition to `src/types.ts`):

```typescript
type DocumentType =
  | "code_chunk"
  | "file_summary"
  | "symbol_summary"
  | "idiom"
  | "usage_example"
  | "anti_pattern"
  | "project_doc"
  | "session_observation"  // NEW

interface SessionObservation {
  documentType: "session_observation";

  // The core observation
  content: string;            // What the agent learned (specific, non-obvious)
  agentTask: string;          // What the agent was doing
  observationType:
    | "architecture"   // How the system is structured
    | "pattern"        // Coding pattern to apply in this codebase
    | "gotcha"         // Non-obvious behavior or footgun
    | "test_gap"       // Untested code path discovered
    | "dependency"     // Hidden or non-obvious dependency
    | "performance"    // Performance characteristic or issue
    | "procedure"      // How to do X in this codebase
    | "decision";      // Why something is done a certain way

  // Links to Layer 1 documents
  sourceChunkIds: string[];   // IDs of code chunks this observation is about
  affectedFiles: string[];    // File paths (used for staleness detection)
  affectedSymbols: string[];  // Symbol names (for symbol graph integration)

  // Provenance
  sessionId: string;          // Which agent session produced this
  sessionDate: string;        // ISO 8601 timestamp

  // ACT-R temporal fields
  accessCount: number;        // Times this observation was retrieved (starts 0)
  lastAccess: string;         // Last retrieval timestamp

  // Quality / confidence
  confidence: number;         // 0.0–1.0 (starts 0.7, boosted by corroboration)
  corroboratedBy: string[];   // IDs of other observations that confirm this
}
```

**Search integration**: `session_observation` documents participate in the existing hybrid search pipeline. After Layer 1 hybrid search returns top-K chunks, the pipeline also queries for `session_observations` where `affectedFiles` overlaps the returned files. Merged into results ranked by `confidence × temporal_score`. Document type weight for `session_observation` is set higher than `code_chunk` (0.8 vs 0.6) because observations about code are more contextually useful at retrieval time than raw code.

**Staleness detection**: When a file in `affectedFiles` changes (content hash differs, tracked by existing `src/core/tracker.ts`), all linked `session_observations` receive a `staleness_flag: true` marker. Stale observations rank at 50% of normal score until re-confirmed, updated, or archived.

**Good vs bad observation examples**:

```
GOOD: "JWT tokens must use config.auth.secret, NOT process.env.JWT_SECRET directly.
      The config module applies a rotation key wrapper that process.env bypasses.
      Using env directly causes silent token validation failures in production."
  [observationType: "gotcha", confidence: 0.9]

GOOD: "AuthService is a singleton initialized in app.ts. Do not instantiate in
      tests — import the exported instance. Creating new AuthService() in tests
      causes state leakage between test suites."
  [observationType: "gotcha", confidence: 0.9]

GOOD: "All DB access must go through Repository classes in src/db/repositories/.
      Direct Knex calls are forbidden by convention (enforced in PR review).
      Analytics exception: analytics-report.ts lines 44, 89, 134 use raw Knex
      intentionally and are grandfathered."
  [observationType: "architecture", confidence: 0.9]

BAD:  "AuthService is defined in src/auth/service.ts."  [discoverable from index]
BAD:  "This project uses TypeScript."  [discoverable from package.json]
BAD:  "The login function takes a username and password."  [discoverable from signature]
```

---

#### 3. Post-Session Curator Extraction

**What it does**: An LLM pass that runs after an agent session completes, reviewing the session trajectory and extracting non-obvious insights that the agent may not have explicitly written via `claudemem_observe`.

**Why we are adopting it**: The Dynamic Cheatsheet paper [arXiv 2504.07952] demonstrates that this exact pattern — Curator LLM reviewing session trajectories, extracting non-obvious insights — achieves 10% → 99% solve rate on coding tasks. The infrastructure to trigger it already exists in `src/learning/interaction/session-tracker.ts`. [Source: Explorer 8, Finding 9; Explorer 7, Write Path architecture]

**Quality gate**: The Curator must apply the criterion: "Would a competent agent reading the code and existing enrichment already know this?" If yes, discard. This gate is the difference between the 10% → 99% improvement in Dynamic Cheatsheet and the -8.3pp degradation in ETH Zurich's AGENTS.md evaluation. Both involve LLM-generated context; the quality gate is what separates them. [Source: Explorer 8, Findings 4, 9, 11]

**Curator prompt structure**:
```
You are reviewing an AI agent's coding session. Extract 3-10 non-obvious insights
about the codebase that future agents should know.

SESSION TOOL CALLS: [from ToolEventLogger]
GIT DIFF: [changes made during session]
CODE READ: [chunks retrieved during session]
EXISTING OBSERVATIONS: [current session_observations about modified files]

Extract observations that:
1. Are NOT discoverable by reading the code directly
2. Are NOT already captured in the existing observations
3. Represent earned knowledge from working with the code
4. Would prevent mistakes or save time for the next agent

Do NOT write observations about discoverable facts (what functions exist, tech
stack, function signatures). Only write earned insights.
```

**Inputs**: Session tool call log (`ToolEventLogger`), git diff since session start, chunks retrieved during session, existing `session_observations` about modified files (for dedup awareness).

**Infrastructure already in place**: `src/learning/interaction/session-tracker.ts` tracks `AgentSession` with `outcome: success|partial|failure|abandoned`. The Curator runs when a session is marked complete.

**Implementation files**: `src/core/enrichment/curator.ts` (new), `src/learning/`

---

#### 4. Hebbian Co-Access Associations (Phase 4, higher effort)

**What it does**: Files and functions consistently retrieved together in agent sessions develop weighted bidirectional associations. Retrieving one surfaces the other — even when the query has no direct semantic relationship to the associated item.

**Why we are adopting it**: Hebbian learning captures the "expert intuition" that pure vector search cannot: "whenever you work on JWT, you also need auth-middleware." This association is not derivable from embeddings — it is learned from co-access patterns over many sessions. MuninnDB measures 10% higher composite scores for Hebbian-boosted co-retrieved items. [Source: Explorer 4, Q2; Explorer 5, Finding 5]

**Formula** (adapted from MuninnDB `internal/cognitive/hebbian.go`):
```
signal = scoreA × scoreB  (geometric product of both items' scores at co-retrieval)
logNew = log(current_weight) + signal × log(1 + 0.01)
new_weight = min(1.0, exp(logNew))
```
Starting weight: 0.01 (cold seed). The 0.01 learning rate means weight 0.5 requires hundreds of genuine co-retrievals — deliberate protection against single-session noise creating spurious associations.

**Implementation**: `chunk_associations` table in SQLite (`src/core/tracker.ts`). Async batch write after each search. Hebbian boost applied as an additive signal in the composite scoring formula.

**Implementation files**: `src/core/tracker.ts`, `src/core/store.ts`, new `HebbianWorker` in TypeScript

---

#### 5. Differential RRF k-Values per Retrieval Source

**What it does**: Uses different k constants in the RRF formula per retrieval channel, rather than a uniform k=60 for all sources.

**Why we are adopting it**: MuninnDB uses `FTS k=60, HNSW k=40, temporal k=120, PAS k=50` — different k per list tunes relative trust. A lower k gives a retrieval channel more influence at top positions. [Source: Explorer 1, synthesis iteration-1 §3.2]

**Implementation**: Expose `VECTOR_K` and `BM25_K` as configuration values. Add a `TEMPORAL_K` for the temporal pool when that feature is added. Default current k=60 behavior unchanged; allows future tuning without code changes.

**Implementation files**: `src/core/search/`, `src/types.ts`

---

#### 6. Score Explanation in Agent Mode

**What it does**: Adds per-result score breakdown to `--agent` mode output: `vector_score`, `bm25_score`, `rrf_score`, `temporal_boost`, `pagerank_boost`, `observation_confidence`.

**Why we are adopting it**: MuninnDB's `muninn_explain` tool exposes per-result ranking transparency. For AI agents consuming claudemem output, understanding why a result ranked highly enables better context selection decisions. Helps users debug poor search results. [Source: synthesis iteration-1 §6.5]

**Implementation files**: `src/core/store.ts`, `src/cli.ts`, `src/mcp/server.ts`

---

### What We Are NOT Adopting (and why)

**Full MuninnDB as a dependency**: MuninnDB is an architectural blueprint, not a library we import. It is written in Go (claudemem is TypeScript), licensed BSL 1.1 with a patent pending (U.S. Provisional 63/991,402, filed February 26, 2026), and targets enterprise multi-tenancy at 100M+ engrams. claudemem targets single-developer use. We use MuninnDB's source code as a reference for implementing equivalent primitives in TypeScript with LanceDB and SQLite. [Source: Explorer 2; synthesis iteration-1 §1]

**PAS Sequential Transition Tables**: MuninnDB's Predictive Activation Signal (+21% Recall@10 improvement, +10–15% MRR) learns "if agent retrieved A, it probably needs B next." The mechanism is well-understood and benchmarked [Explorer 4, Q5]. However, it requires a persistent transition table with indefinitely-growing counters (no decay in MuninnDB's current implementation), and there is a known risk: early-session sequential patterns permanently dominate if the workflow evolves. This is explicitly noted as an open design gap in the research [synthesis iteration-2 §10]. PAS is deferred to a future phase after Hebbian co-access proves its value.

**Contradiction Detection**: MuninnDB's three-mode contradiction detection (structural relationship matrix, same-relation-different-target, LLM semantic) is complex to implement and has unclear ROI for code-specific observations. The stale file detection mechanism (content hash change → confidence penalty) addresses the most important contradiction case for code: an observation that was true before a refactor becomes stale after it. Full Bayesian contradiction detection is not implemented in this phase.

**Raft Clustering and Multi-Vault**: claudemem targets single-developer local use. Raft-based clustering is not in scope.

**Push/Trigger System**: MuninnDB's semantic push triggers (subscriptions that proactively deliver memories when context matches) require a persistent server model. claudemem is single-process and does not maintain persistent server state between tool calls. Proactive surfacing via file-read interception (intercepting MCP `read_file` calls to inject observations) is a lighter alternative that can be added in a future phase without a daemon.

---

## Implementation Roadmap

### Phase 1: Temporal Scoring (1–2 days)

Add `accessCount` and `lastAccess` to the LanceDB schema for all document types. Track retrievals asynchronously in `src/core/store.ts` after each search. Apply ACT-R formula to composite RRF score.

Cold behavior: `accessCount = 0`, `lastAccess = epoch` → `B(M)` is a small near-zero value → effectively neutral boost. Existing search quality is preserved exactly.

Files touched: `src/core/store.ts`, `src/types.ts`, `src/core/search/`

Schema migration: requires `claudemem index --force` to rebuild with new fields. Content hash tracking means unchanged files reuse cached embeddings — only schema columns are re-added.

---

### Phase 2: Session Observation Document Type (2–3 days)

1. Add `'session_observation'` to `DocumentType` union in `src/types.ts`
2. Define `SessionObservation` interface (full schema above)
3. Add `claudemem_observe` MCP tool in `src/mcp/tools/observe.ts`
4. Update hybrid search to JOIN `session_observations` against returned file paths
5. Add document type weight `session_observation: 0.8` in search weight tables

Files touched: `src/types.ts`, `src/mcp/tools/observe.ts` (new), `src/core/store.ts`, `src/core/search/`

---

### Phase 3: Search Integration (1 day)

Update hybrid search pipeline:
- After Layer 1 search returns top-K chunks, query for `session_observations` where `affectedFiles` overlaps returned files (JOIN step)
- Merge observations into results: ranked by `confidence × temporal_score`
- Apply `session_observation` document type weight (0.8)
- In `--agent` mode, include per-result score breakdown fields

Files touched: `src/core/store.ts`, `src/core/search/`, `src/cli.ts`

---

### Phase 4: Post-Session Curator (3–5 days)

1. Implement `SessionEnrichmentExtractor` class in `src/core/enrichment/curator.ts`
2. Curator LLM prompt with quality gate (see Section above)
3. Hook into session end event via `src/learning/interaction/session-tracker.ts`
4. Read session tool log from `ToolEventLogger`
5. Fetch git diff via existing `src/git/` infrastructure
6. Write approved observations to LanceDB via the enrichment pipeline

The Curator runs as an async post-session step — it does not block the agent session. The LLM call cost is analogous to the existing enrichment pipeline LLM calls.

Files touched: `src/core/enrichment/curator.ts` (new), `src/learning/interaction/session-tracker.ts`, `src/learning/`

---

### Phase 5: Staleness Detection (1 day)

When `src/core/tracker.ts` detects a file content hash change (existing mechanism), query for `session_observations` with that file in `affectedFiles`. Set `staleness_flag: true` on all linked observations. Apply 0.5× rank multiplier to stale observations until re-confirmed or archived.

Files touched: `src/core/tracker.ts`, `src/core/store.ts`

---

### Phase 6: Hebbian Co-Access (future, higher effort)

1. Add `chunk_associations` table to SQLite: columns `chunkIdA`, `chunkIdB`, `weight float`, `lastUpdated timestamp`
2. After each hybrid search, log co-occurrence of returned chunk IDs (async batch write)
3. Implement `HebbianWorker` (TypeScript adaptation of MuninnDB's `internal/cognitive/hebbian.go`)
4. Formula: `logNew = log(current) + signal × log(1.01)`, `newWeight = min(1.0, exp(logNew))`
5. Incorporate Hebbian boost into composite score alongside temporal boost

Files touched: `src/core/tracker.ts`, `src/core/store.ts`, new `HebbianWorker`

---

### Phase 7: Consolidation (future, medium effort)

1. Deduplication: pairwise cosine similarity across `session_observations`. Threshold: 0.95. Elect highest-confidence representative; archive others. Merge `corroboratedBy` references.
2. Confidence boosting: when 3+ sessions independently corroborate the same observation → boost confidence to 0.90+.
3. Hub promotion: observations linked from 5+ sessions about the same symbol → boost that symbol's `symbol_summary` relevance score (analogous to MuninnDB's schema node promotion at `out-degree >= 10`).
4. Triggered by: `claudemem consolidate` CLI command, or scheduled interval.

Files touched: new `src/core/enrichment/consolidator.ts`

---

## Concrete Scenarios

These scenarios are derived directly from the research [Explorer 7, Scenario A and B; synthesis iteration-2 §6].

### Scenario A: Agent Writes Tests for Auth Module

**Session 1 — Layer 2 starts empty.**

Agent reads `src/auth/service.ts`, `src/auth/jwt.ts`, discovers test patterns in `src/auth/__tests__/`. Calls:

```
claudemem_observe(
  observation: "Auth module tests use beforeEach to mock jwt.verify directly
               (not via env var). Pattern: jest.spyOn(jwt, 'verify').mockImplementation().
               Discovered 3 untested error paths in AuthService.login():
               invalid issuer, expired token, missing sub claim.",
  observationType: "test_gap",
  affectedFiles: ["src/auth/service.ts", "src/auth/__tests__/service.test.ts"],
  affectedSymbols: ["AuthService.login", "jwt.verify"],
  confidence: 0.85
)
```

Post-session Curator also extracts:
```
observation: "AuthService is a singleton — do not instantiate in tests.
             Import the exported instance from service.ts.
             Creating new AuthService() causes state leakage between test suites.",
observationType: "gotcha",
affectedFiles: ["src/auth/service.ts"],
confidence: 0.90
```

**Session 2 — Different agent works on auth.**

Agent searches "auth implementation" or opens `src/auth/service.ts`.

What surfaces from Layer 2:
- Test mock pattern (the singleton gotcha)
- Three untested error paths

The agent avoids creating a new `AuthService` instance in tests — a bug that would have taken hours to debug is prevented before a line is written.

**After 10 sessions:**
- 20–40 `session_observation` documents accumulated about the auth module
- Deduplication consolidates 3 sessions that all noted the singleton gotcha → 1 high-confidence canonical observation with `corroboratedBy: ["session-1", "session-3", "session-7"]`
- `AuthService` symbol summary is hub-promoted (linked from many observations)
- A new engineer's agent starts with the equivalent of a senior developer's auth briefing

---

### Scenario B: Agent Refactors Database Layer

**Session 1 — Agent discovers patterns:**

```
observation: "All DB access goes through Repository classes in src/db/repositories/.
             Direct Knex calls are forbidden by convention (PR review enforced).
             BaseRepository provides findById, save, update, delete.
             Analytics exception: analytics-report.ts lines 44, 89, 134 use raw
             Knex intentionally — this is grandfathered, not a mistake.",
observationType: "architecture",
affectedFiles: ["src/db/repositories/base.ts"],
confidence: 0.90

observation: "Migrations use knex migrate:latest on deploy. Down migrations
             intentionally omitted (one-way schema by policy). Files named
             YYYYMMDD_description.ts. Dev seed: npm run db:seed.",
observationType: "procedure",
affectedFiles: ["knexfile.ts", "db/migrations/"],
confidence: 0.95

observation: "N+1 at UserRepository.findWithOrders() — fetches orders in a loop.
             Known issue. Fix: joinRelated or eager loading.",
observationType: "performance",
affectedFiles: ["src/db/repositories/user.ts"],
affectedSymbols: ["UserRepository.findWithOrders"],
confidence: 0.85
```

**Session 2 — Bug fix in DB layer.**

Agent searches "database query" or opens `src/db/repositories/`. What surfaces from Layer 2 automatically:
1. Repository pattern constraint — prevents writing direct Knex calls before a single line is written
2. Migration procedure — prevents accidentally writing a down migration
3. Known N+1 — agent can decide to fix it or consciously leave it

Three potential mistakes are prevented before the agent writes a line of code.

---

## Consequences

### Positive

- **Compounding value**: Session 1 adds 5 observations. Session 50 has the accumulated wisdom of all prior sessions. The system gets smarter the more it is used — no other production coding tool offers this.
- **Semantic retrieval of knowledge**: Unlike CLAUDE.md (always fully injected regardless of relevance), observations are retrieved only when semantically relevant to the current task. Minimal context overhead.
- **Addresses the proven capability gap**: The research identifies no production competitor in this exact space [Explorer 8, Finding 10]. First-mover advantage in session-accumulating, code-linked, temporally-scored cognitive RAG.
- **Cold start equals current quality**: An empty Layer 2 produces exactly current claudemem behavior. No degradation risk on initial deployment.
- **Builds on existing infrastructure**: The LanceDB schema, enrichment pipeline, session tracker, tool event logger, and content hash tracker all exist. No new databases required.
- **Complementary to CLAUDE.md**: CLAUDE.md remains the right place for global conventions (commit message format, setup instructions, tribal knowledge). Session observations are the right place for code-specific patterns linked to specific chunks. These are additive, not competing.

### Negative

- **Storage growth**: Observations accumulate over sessions. At 5 observations per session with ~500 tokens each and 1536-dim float32 embeddings (~6KB per vector), 1000 sessions ≈ 5000 observations ≈ 30MB of vectors. Consolidation (dedup at 0.95 cosine similarity) keeps effective count lower.
- **LLM cost**: The post-session Curator requires an LLM call per completed session. Analogous to existing enrichment pipeline costs. Opt-in; can be disabled if cost is a concern.
- **Privacy**: Session observations may capture sensitive reasoning — debugging notes that reveal security vulnerabilities, implementation decisions that expose business logic. Session observations should NOT be included in `claudemem pack` by default.
- **Complexity**: Two-layer search pipeline is more complex than the current single-layer pipeline. The JOIN step and temporal scoring add latency.

### Risks

**CRITICAL — ETH Zurich quality gate**: The ETH Zurich finding [arXiv 2602.11988] is a direct warning: auto-generated context with obvious content reduces performance by up to 8.3 percentage points. The Curator quality gate is the most important implementation detail. The criterion "would a competent agent already know this from reading the code and existing enrichment?" must be calibrated carefully. Consider: A/B testing sessions with and without observations to measure empirical impact before broad rollout.

**Cold start and temporal signals**: ACT-R temporal scoring and Hebbian co-access associations provide zero value until usage accumulates. A codebase indexed but never queried through the cognitive layer starts with neutral temporal signals. Mitigation: seed ACT-R `accessCount` from git commit frequency (files with more recent commits get higher initial temporal weight) — this was noted as a potential cold-start mitigation in the research [Explorer 6, Finding 4].

**Observation staleness**: Code changes can make observations wrong. The staleness detection mechanism (content hash change → rank penalty) mitigates this but cannot catch semantic staleness — an observation that is still syntactically correct but no longer true after a refactor. This is an inherent limitation of all persistent knowledge systems.

**Context window growth**: Too many observations per search result could bloat the agent's context window. The semantic retrieval mechanism (only surface observations relevant to the current task) is the primary mitigation. An explicit limit on observations per search result (e.g., top 5 by confidence × temporal score) should be enforced.

---

## Research References

### Papers

- Anderson, J.R. (1993). *Rules of the Mind*. Hillsdale, NJ: Erlbaum. — ACT-R base-level activation formula: B(M) = ln(n) - d × ln(T/n), d = 0.5
- Anderson, J.R. et al. (2004). "An integrated theory of the mind." *Psychological Review* 111(4):1036–1060.
- arXiv 2602.11988 (ETH Zurich, February 2026) — LLM-generated context files reduce coding task resolve rate by 0.5–8.3pp; +20–23% token cost overhead in all conditions
- arXiv 2504.07952 — "Dynamic Cheatsheet": session-learned insights improve solve rate from 10% → 99% on Python puzzle tasks; Curator quality gate is the differentiating mechanism
- arXiv 2602.12670 — SkillsBench: +4.5pp on Software Engineering with curated skill documents
- Park, J.S. et al. (2023). "Generative Agents: Interactive Simulacra of Human Behavior." arXiv:2304.03442. — recency × importance × relevance composite retrieval, ACT-R-inspired
- Packer, C. et al. (2023). "MemGPT: Towards LLMs as Operating Systems." arXiv:2310.08560.
- Zhong, W. et al. (2023). "MemoryBank." arXiv:2305.10250. — Ebbinghaus decay for LLM memory
- Sumers, T.R. et al. (2024). "Cognitive Architectures for Language Agents." arXiv:2309.02427. — survey noting ACT-R temporal decay not widely implemented in production LLM agents as of 2024
- Hebb, D.O. (1949). *The Organization of Behavior*. New York: Wiley. — Δw_ij = η × x_i × x_j
- Wang, G. et al. (2023). "Voyager." arXiv:2305.16291. — LLM agent skill library accumulated from successful task completions; closest published prior art to session observation accumulation

### Tools Analyzed

- **MuninnDB** (https://github.com/scrypster/muninndb) — Cognitive AI memory database, Go 1.25, BSL 1.1, patent pending U.S. Provisional 63/991,402 (filed February 26, 2026)
  - 6-phase ACTIVATE pipeline: embed → parallel retrieval → RRF → Hebbian → PAS → BFS graph → ACT-R composite scoring
  - Cognitive primitives: ACT-R temporal scoring, Hebbian association learning (η=0.01), Bayesian confidence (posterior = (p×s)/(p×s + (1-p)×(1-s))), Contradiction detection (3 modes), PAS (+21% Recall@10)
  - 5-phase Consolidation: dedup at 0.95 cosine, confidence boosting, schema node promotion, transitive inference
  - Source files analyzed: `internal/engine/activation/engine.go`, `internal/cognitive/hebbian.go`, `internal/cognitive/transition.go`, `internal/cognitive/contradict.go`, `internal/consolidation/dedup.go`, `internal/consolidation/schema.go`, `internal/mcp/handlers.go` (1354 lines), and 14 additional files
  - Used as architectural blueprint only — not a dependency

- **Cursor** (.cursorrules + cloud Memory beta) — static rules injection + user-level preference cloud memory (not project-specific)
- **Windsurf** (.windsurfrules + cloud Memories) — hierarchical static rules + user-level cloud memory
- **Claude Code** (CLAUDE.md) — static markdown injection, hierarchical (global → project → subdirectory)
- **GitHub Copilot** (.github/copilot-instructions.md) — static markdown injection, 8000 char limit
- **Aider** (CONVENTIONS.md + --read flag + git log) — static injection; git history as implicit but semantically-unretrievable memory
- **Continue.dev** (LanceDB + BM25 + embedding RAG) — nearly identical retrieval architecture to claudemem; no session memory layer
- **Cody/Sourcegraph** (Sourcegraph structural graph + memory.jsonl) — richest structural context among IDEs; manual writes to memory.jsonl only

### Research Session Artifacts

All artifacts in `ai-docs/sessions/dev-research-claudemem-vs-muninndb-20260304-143632-4e8e43a3/`:

- `research-plan.md` — original research questions
- `findings/explorer-1-muninndb-web.md` — MuninnDB web/GitHub research (6 official sources)
- `findings/explorer-2-muninndb-code.md` — MuninnDB source code analysis (25+ files)
- `findings/explorer-3-claudemem-local.md` — claudemem local codebase analysis (15 primary files)
- `findings/explorer-4-cognitive-deep-dive.md` — MuninnDB cognitive primitive deep dive (formulas, source)
- `findings/explorer-5-cognitive-science.md` — ACT-R and cognitive science research
- `findings/explorer-6-cognitive-codebase.md` — Cognitive codebase memory design
- `findings/explorer-7-session-enrichment.md` — Session enrichment patterns and scenarios
- `findings/explorer-8-existing-tools-memory.md` — Competitor tool memory analysis
- `synthesis/iteration-1.md` — Cross-validated MuninnDB vs. claudemem comparison
- `synthesis/iteration-2.md` — Cognitive codebase memory architecture synthesis
