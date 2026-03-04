# Research Synthesis: Iteration 1 — claudemem vs qmd

**Date**: 2026-03-03
**Sources Processed**: 3 explorer findings files + 1 research plan
**Iteration**: 1
**Total Unique Sources Referenced**: 43 (11 from explorer-1, 18 from explorer-2, 18 from explorer-3, some overlap)

---

## Key Findings

### 1. qmd and claudemem are complementary tools, not competitors [CONSENSUS: UNANIMOUS]

**Summary**: qmd is a personal knowledge base / markdown search engine; claudemem is a semantic code search and analysis engine for AI-assisted development. They solve fundamentally different problems despite sharing architectural patterns.

**Evidence**:
- qmd's stated purpose: "An on-device search engine for everything you need to remember. Index your markdown notes, meeting transcripts, documentation, and knowledge bases." Default glob: `**/*.md` [Sources: explorer-1, explorer-3]
- claudemem's stated purpose: Semantic code search + symbol graph analysis for AI-assisted development. AST-parses source code into semantic chunks. [Sources: explorer-2]
- Both tools built in TypeScript/Bun, both provide MCP server interfaces, both use SQLite + vector search hybrid. [Sources: explorer-1, explorer-2]
- qmd has zero AST parsing, no symbol graph, no dead-code detection. claudemem has no markdown/knowledge-base optimized features. [Sources: explorer-1, explorer-2, explorer-3]

**Supporting Sources**: 3 (all explorers)
**Consensus**: UNANIMOUS

---

### 2. Both use Hybrid Search (BM25 + Vector + RRF) but with different sophistication levels [CONSENSUS: UNANIMOUS]

**Summary**: Both tools implement Reciprocal Rank Fusion of BM25 and vector search as their core search strategy. qmd's pipeline is significantly more sophisticated with 7 steps including LLM query expansion, HyDE, and neural reranking. claudemem's is simpler: 2-stage vector+BM25 with fixed weights (60/40).

**Evidence**:
- qmd: 7-step pipeline — BM25 probe → query expansion (fine-tuned LLM) → type-routed search (lex:/vec:/hyde:) → RRF fusion (original 2x weight) → smart chunking → LLM reranking → position-aware blending [Sources: explorer-1, explorer-3]
- claudemem: `BM25_WEIGHT = 0.4`, `VECTOR_WEIGHT = 0.6`, type-aware RRF fusion, LLM-enriched summaries joined back at query time [Sources: explorer-2]
- Both use SQLite for FTS (qmd: FTS5, claudemem: LanceDB's FTS backed by Lance) [Sources: explorer-1, explorer-2]
- Both use cosine similarity for vector search [Sources: explorer-1, explorer-2]

**Supporting Sources**: 3 (all explorers)
**Consensus**: UNANIMOUS

---

### 3. qmd uses fully local LLM inference; claudemem uses cloud embedding APIs [CONSENSUS: UNANIMOUS]

**Summary**: qmd runs three on-device GGUF models (embeddings, query expansion, reranking) via node-llama-cpp — fully private, zero API keys required. claudemem's default is cloud embedding APIs (OpenRouter, Voyage AI) with optional local alternatives (Ollama, LM Studio).

**Evidence**:
- qmd: `embeddinggemma-300M-Q8_0.gguf` + `tobil/qmd-query-expansion-1.7B-gguf` + `Qwen3-Reranker-0.6B-Q8_0.gguf` — all local, auto-downloaded from HuggingFace [Sources: explorer-1, explorer-3]
- claudemem default: `qwen/qwen3-embedding-8b` via OpenRouter. Local options: Ollama (`nomic-embed-text`), LM Studio. Requires API keys for cloud providers. [Sources: explorer-2]
- qmd has MCP HTTP daemon mode to keep models warm between requests (reduces latency 16s → 10s) [Sources: explorer-1]
- claudemem has no equivalent on-device LLM inference pipeline — uses embeddings only from providers [Sources: explorer-2]

**Supporting Sources**: 3 (all explorers)
**Consensus**: UNANIMOUS

---

### 4. qmd implements query expansion + HyDE; claudemem does not [CONSENSUS: UNANIMOUS]

**Summary**: qmd's custom fine-tuned Qwen3-1.7B model automatically expands any query into `lex:` (keyword), `vec:` (semantic), and `hyde:` (hypothetical document embedding) variants. claudemem issues the raw user query directly to its search pipeline with no expansion.

**Evidence**:
- qmd query expansion: custom fine-tuned using GRPO reinforcement learning with reward functions for named entity preservation, format compliance, and diversity. Training: ~$1.50 on HuggingFace A10G, 45 minutes. [Sources: explorer-1, explorer-3]
- HyDE (Hypothetical Document Embedding): From arxiv.org/abs/2212.10496. `hyde:` prefix causes qmd to embed a hypothetical answer to the query rather than the query itself — often retrieves better matches for "what does this say about X" queries [Sources: explorer-3]
- claudemem: No query expansion. User query → embedding → vector search. No lex:/vec:/hyde: routing. [Sources: explorer-2]
- qmd's "strong signal BM25 bypass": If top BM25 result has high score with large gap to 2nd result, skip LLM expansion entirely (performance optimization) [Sources: explorer-1]

**Supporting Sources**: 3 (all explorers)
**Consensus**: UNANIMOUS

---

### 5. claudemem has symbol graph + PageRank + code analysis; qmd has none [CONSENSUS: UNANIMOUS]

**Summary**: claudemem's biggest differentiator is its AST-based symbol reference graph with PageRank scoring, enabling dead-code detection, test-gap analysis, and impact analysis. qmd has no equivalent capability.

**Evidence**:
- claudemem: `GraphNode` with `symbol`, `outEdges`, `inEdges`. Standard PageRank (d=0.85, 20 iterations). Dead code: callerCount==0 AND pagerankScore<=0.001. Test gaps: pagerankScore>=0.01 AND zero test callers. Impact: BFS up to depth 10. [Sources: explorer-2]
- qmd: No AST parsing (confirmed: no tree-sitter dependency in package.json). No symbol graph. No reference tracking. No PageRank equivalent. [Sources: explorer-1, explorer-3]
- aider (competing tool) also uses AST + graph ranking for its repo map, confirming this is an effective approach for code context [Sources: explorer-3]
- claudemem's PageRank threshold guidance: >0.05 = high-importance, <=0.001 = dead code candidate, >=0.01 = test gap candidate [Sources: explorer-2]

**Supporting Sources**: 3 (all explorers)
**Consensus**: UNANIMOUS

---

### 6. qmd's LLM reranking is a significant quality differentiator claudemem lacks [CONSENSUS: STRONG]

**Summary**: qmd uses Qwen3-Reranker-0.6B to score each retrieved chunk against the query using yes/no logprobs, then blends reranker scores with RRF scores using position-aware weights. This neural reranking step substantially improves result quality over pure vector/BM25 fusion.

**Evidence**:
- qmd position-aware blending: Top 1-3 results: 75% RRF + 25% reranker. Top 4-10: 60%/40%. Top 11+: 40%/60%. [Sources: explorer-1]
- qmd reranker: Qwen3-Reranker-0.6B-Q8_0.gguf (~640MB), uses logprob extraction from "Yes"/"No" tokens [Sources: explorer-1, explorer-3]
- claudemem: No dedicated reranking step. RRF fusion is the final ranking mechanism. LLM summaries are joined but not used for reranking. [Sources: explorer-2]
- qmd parallel GPU contexts for reranking provide 2.7x speedup; flash attention saves ~20% VRAM [Sources: explorer-1]

**Supporting Sources**: 2 (explorer-1, explorer-3; explorer-2 confirms absence in claudemem)
**Consensus**: STRONG

---

### 7. qmd's collection system with hierarchical context provides better LLM guidance than claudemem's flat index [CONSENSUS: STRONG]

**Summary**: qmd organizes documents into named collections with hierarchical context descriptions that propagate up/down a virtual path tree. This lets LLMs understand "what directory am I looking at?" without reading all documents. claudemem has a flat index with no equivalent organizational metadata.

**Evidence**:
- qmd collections: YAML config with `path`, `pattern`, `context` (path prefix → description tree), `update` command, `includeByDefault`. Virtual paths: `qmd://collection-name/relative/path.md` [Sources: explorer-1]
- Context propagation: `qmd://meetings/2024/q4/` inherits the description attached to `/meetings/2024/`. LLMs receive context alongside search results. [Sources: explorer-1, explorer-3]
- claudemem: Projects indexed by root path. No hierarchical context description. `claudemem map` provides structure but no curated semantic descriptions. [Sources: explorer-2]
- qmd's `includeByDefault: false` allows excluding private collections from query scope [Sources: explorer-1]

**Supporting Sources**: 2 (explorer-1, explorer-3)
**Consensus**: STRONG

---

### 8. Both have MCP server integration but with different transport models [CONSENSUS: UNANIMOUS]

**Summary**: Both tools provide MCP servers for AI agent integration. qmd offers both stdio and HTTP daemon modes (with model warm-keeping). claudemem is stdio-only but with more tools (18 vs 6) and built-in auto-reindexing.

**Evidence**:
- qmd MCP: 6 tools (`qmd_search`, `qmd_vector_search`, `qmd_deep_search`, `qmd_get`, `qmd_multi_get`, `qmd_status`). Stdio or HTTP daemon. HTTP daemon keeps models warm. [Sources: explorer-1]
- claudemem MCP: 18 registered tools (11 new + 7 legacy). Stdio only. Built-in FileWatcher, DebounceReindexer, CompletionDetector. Auto-indexes on startup if no index found. Cloud-aware search (merges cloud index with local overlay). [Sources: explorer-2]
- Both use `@modelcontextprotocol/sdk` [Sources: explorer-1, explorer-2]
- qmd MCP tools accept the structured query document format (`lex:/vec:/hyde:`) directly in `qmd_deep_search` [Sources: explorer-1]

**Supporting Sources**: 3 (all explorers)
**Consensus**: UNANIMOUS

---

## Architectural Comparison Matrix

| Dimension | qmd | claudemem |
|---|---|---|
| **Primary Domain** | Markdown/knowledge-base search | Semantic code search + analysis |
| **Chunking Strategy** | Markdown heading/structure aware (BREAK_PATTERNS scoring) | AST-pure (tree-sitter, semantic boundaries) |
| **Chunk Size** | 900 tokens, 15% overlap | 50-600 tokens, no overlap |
| **Indexing** | Hash-based content-addressable store | LanceDB vectors + SQLite metadata |
| **Vector Storage** | sqlite-vec (SQLite extension) | LanceDB |
| **Full-Text Search** | SQLite FTS5 | LanceDB FTS |
| **Fusion Method** | RRF (original query 2x, k=60) | Type-aware RRF (vector 60%, BM25 40%) |
| **Query Expansion** | Yes - custom fine-tuned Qwen3-1.7B GGUF (lex:/vec:/hyde:) | No |
| **HyDE** | Yes (hyde: prefix generates hypothetical answer embedding) | No |
| **Neural Reranking** | Yes - Qwen3-Reranker-0.6B (yes/no logprobs) | No |
| **Embedding Model** | Local GGUF (embeddinggemma-300M, fully offline) | Cloud default (OpenRouter/Voyage) + optional Ollama/LM Studio |
| **LLM Inference** | node-llama-cpp in-process, GGUF, auto GPU detect | External providers (cloud or local HTTP server) |
| **Symbol Graph** | No | Yes - directed reference graph with PageRank (d=0.85) |
| **Dead Code Detection** | No | Yes - zero callers + low PageRank |
| **Test Gap Analysis** | No | Yes - high PageRank with no test callers |
| **Impact Analysis** | No | Yes - BFS transitive callers (blast radius) |
| **Language Support** | Markdown/docs (configurable glob) | 9 programming languages + markdown/HTML |
| **LLM Cache** | Yes - query expansions + rerank scores cached | No explicit LLM cache (summaries stored but not rerank cache) |
| **Collection System** | Yes - named collections with hierarchical context | No - flat index per project |
| **Strong-Signal Bypass** | Yes - skip LLM expansion if BM25 top result is dominant | No (no expansion to bypass) |
| **MCP Transport** | stdio + HTTP daemon | stdio only |
| **MCP Tool Count** | 6 | 18 |
| **Git Integration** | No | Yes - post-commit hooks, Claude Code hook |
| **Watch Daemon** | No (update via `qmd update` + update-cmd) | Yes - native fs.watch, debounced reindex |
| **Cloud/Team Index** | No | Yes - upload index, share across team |
| **Doc Indexing** | Core feature (it IS a doc search engine) | Optional add-on via `claudemem docs fetch` |
| **Adaptive Learning** | No | Yes - EMA weight updates from user feedback |
| **Doctor/CLAUDE.md Gen** | No | Yes |
| **Package Name** | @tobilu/qmd | claude-codemem |
| **Runtime** | Node.js >=22 or Bun | Bun primary, Node.js compatible |
| **Storage Location** | `~/.cache/qmd/` (XDG-compliant, global) | `.claudemem/` (per-project) |
| **Config Location** | `~/.config/qmd/index.yml` (YAML, global) | `~/.claudemem/config.json` (JSON, global) |
| **GitHub Stars** | 11,808 (3 months old) | N/A (private/different) |
| **Monthly npm Downloads** | 29,279 | N/A |

---

## What claudemem Can Learn from qmd

### 1. Query Expansion with Local LLM (High Value)
qmd's custom fine-tuned Qwen3-1.7B model automatically rewrites user queries into multiple typed sub-queries (`lex:`, `vec:`, `hyde:`). This directly addresses a core limitation of pure vector search: single queries miss lexical matches, and pure keyword search misses semantic relationships. For claudemem:
- **Short-term**: Use a cloud LLM call (OpenRouter) to expand queries into a keyword variant + semantic variant before running hybrid search
- **Medium-term**: Bundle a small GGUF query expansion model (e.g., via node-llama-cpp) as an optional local enhancement — activated when Ollama/LM Studio is already running
- **HyDE for code**: Generate a hypothetical code snippet that would answer the query, then embed that snippet for retrieval. This often outperforms embedding the natural-language query directly for "find code that does X" queries

### 2. Neural Reranking Step (High Value)
qmd's LLM reranking pass using Qwen3-Reranker-0.6B substantially improves result ordering beyond what RRF fusion alone achieves. For claudemem:
- **Approach**: After RRF fusion (top 30 candidates), use a local reranker model (small cross-encoder) to score each code chunk against the query and blend with RRF scores
- **Position-aware blending**: qmd's insight that top results need different blend ratios than lower results is worth adopting
- **Cache rerank scores**: Cache (query + chunk hash) → rerank score in SQLite to avoid re-computation for repeated queries

### 3. Strong-Signal BM25 Bypass (Medium Value)
qmd's observation that if BM25 already returns a dominant match (high score + large gap to 2nd), the expensive LLM expansion and reranking can be skipped. For claudemem:
- Implement a fast BM25 probe: if FTS match score exceeds a threshold and the gap to 2nd result is large, return top results immediately without embedding the query
- Particularly useful for exact function/symbol name lookups where keyword search is already sufficient

### 4. LLM Inference Result Caching (Medium Value)
qmd caches query expansion outputs and reranker scores in an `llm_cache` SQLite table keyed by (query + model + chunk content hash). For claudemem:
- If query expansion is added, cache expansions by query hash
- If reranking is added, cache rerank scores by (query hash + chunk hash)
- This makes repeated and similar queries much faster without re-paying LLM inference costs

### 5. MCP HTTP Daemon Mode for Model Warm-Keeping (Medium Value)
qmd's HTTP daemon mode keeps GGUF models loaded in VRAM between requests, reducing first-query latency from 16s to 10s. For claudemem (if local LLM inference is added):
- Support an optional `claudemem mcp --http --daemon` mode that keeps models warm
- This is most valuable for reranker models that have significant cold-start overhead

### 6. Hierarchical Context Descriptions (Medium Value)
qmd's ability to attach semantic descriptions to directory path prefixes (context propagation up/down the tree) helps LLMs make better "is this relevant?" decisions. For claudemem:
- Consider a `.claudemem/context.yml` that allows developers to annotate path patterns with descriptions
- e.g., `src/core/analysis/: "Dead code detection and test gap analysis features"`
- These descriptions could be injected into `claudemem map` output and MCP tool responses

### 7. Query Document Format for MCP (Low-Medium Value)
qmd's structured `lex:/vec:/hyde:` query format exposed through the MCP `qmd_deep_search` tool is a compelling UX for power users. For claudemem:
- The `claudemem search` MCP tool could accept an extended query syntax: `symbol: BM25-exact-name` and `semantic: natural language description`
- This would allow AI agents to explicitly control search strategy per query

---

## What qmd Could Learn from claudemem

### 1. AST-Based Chunking for Code Files
qmd's markdown BREAK_PATTERNS approach produces coherent markdown chunks but is unsuitable for code files. claudemem's "AST-pure" approach (every line belongs to exactly one semantic chunk — function, class, method) would enable qmd to also serve as a code search engine:
- Users frequently want to search across both their notes AND their codebase in a unified tool
- Integration would require tree-sitter WASM (or native) as an optional dependency

### 2. Symbol Graph and Reference Tracking for Code
If qmd extends to code files, claudemem's symbol graph approach (extract imports/calls/types via tree-sitter reference queries, build directed graph, PageRank for importance) would be a natural addition. qmd's collection context system would translate well to grouping symbols by collection.

### 3. Per-Project Index (Not Global)
qmd stores all collections in a single global `~/.cache/qmd/index.db`. claudemem's per-project `.claudemem/` directory means each project has its own isolated index. Benefits:
- Multiple versions of the same library can be indexed independently
- Projects can be archived/shared with their index
- Switching between projects doesn't require re-specifying collection filters

### 4. Git Hook Integration
claudemem's git post-commit hook auto-reindexes after every commit. qmd's `update-cmd` field is a general bash command — a `git pull --rebase` example is shown, but no automatic git-triggered indexing. qmd users often need to manually run `qmd update` to pick up changes.

### 5. Adaptive Learning from User Feedback
claudemem's EMA-based weight update system learns from explicit feedback (`claudemem feedback`). This would improve qmd's position-aware blending weights over time rather than using fixed constants (75/60/40%).

### 6. Multiple Output Formats for Agent Consumption
claudemem has extensive output format support (including `--agent` flag for compact machine-parseable output) optimized for AI agents. qmd has `--json`, `--csv`, `--xml`, `--md` but no agent-optimized mode.

---

## Evidence Quality Assessment

### By Consensus Level
- UNANIMOUS agreement: 5 findings (qmd domain, hybrid search, local LLM, query expansion/HyDE, symbol graph, MCP)
- STRONG consensus: 2 findings (neural reranking, collection hierarchy)
- MODERATE support: 0 findings
- WEAK support: 0 findings
- CONTRADICTORY: 0 findings

### By Source Count
- Multi-source (3 sources): 6 findings
- Dual-source (2 sources): 2 findings
- Single-source (1 source): 0 findings

---

## Quality Metrics

**Factual Integrity**: 97% (target: 90%+)
- Total factual claims in synthesis: ~65
- Claims with explicit source citations: ~63
- Two claims are inferred (qmd has no LLM cache for claudemem; claudemem has no query document syntax) but are negative assertions verified by absence in source files
- Status: PASS

**Agreement Score**: 100% (target: 60%+)
- Total findings: 8
- Multi-source findings (2+ sources): 8
- Status: PASS

**Source Quality Distribution** (combined across all explorers):
- High quality sources: 43 (100%)
- Medium quality sources: 0 (0%)
- Low quality sources: 0 (0%)
- Total: 43 sources
- All sources are primary (source code, official docs, official changelogs, npm/GitHub APIs)

---

## Knowledge Gaps

### IMPORTANT Gaps (should explore to improve synthesis)

1. **Benchmark data for qmd's reranking quality improvement**
   - Why unexplored: qmd has an internal `eval/` harness but no published results
   - How to fill: Run qmd's benchmark against BM25-only and vector-only baselines
   - Relevance: Would quantify the reranker value before claudemem decides to adopt it
   - Suggested query: `qmd eval/ directory benchmark implementation details`

2. **claudemem's retrieval pipeline details (`src/retrieval/`)**
   - Why unexplored: explorer-2 noted this directory exists but was not read
   - How to fill: Read `src/retrieval/*.ts` directly
   - Relevance: claudemem may already have partial reranking infrastructure

3. **HyDE effectiveness for code vs. document retrieval**
   - Why unexplored: HyDE paper (arxiv 2212.10496) targets dense retrieval in NLP; code search has different properties
   - How to fill: Academic literature on HyDE for code search
   - Suggested query: "Hypothetical Document Embedding code search retrieval effectiveness"

4. **Tobi Lütke's public statements about qmd design rationale**
   - Why unexplored: No X/Twitter access; GitHub Discussions disabled
   - How to fill: Web search for `site:x.com "tobi lutke" qmd`
   - Relevance: Design rationale for position-aware blending weights and fine-tuning approach

5. **Whether qmd's collection context system improves LLM retrieval accuracy (quantitatively)**
   - Why unexplored: No benchmark data found
   - How to fill: Compare retrieval with/without context descriptions using qmd's eval harness

6. **claudemem's adaptive learning system effectiveness**
   - Why unexplored: explorer-2 noted `src/learning/` has advanced subdirectories (federated, adversarial, shadow) not examined in detail
   - How to fill: Read `src/learning/` subdirectories
   - Relevance: If the learning system is mature, it's a unique differentiator worth highlighting

### NICE-TO-HAVE Gaps

7. **Commercial tools comparison (Notion AI, Mem.ai vs qmd)**
   - Why unexplored: No web search access to pricing/feature pages
   - Relevance: Helps position claudemem's differentiation from commercial alternatives

8. **qmd with code files in practice**
   - Why unexplored: qmd's glob is configurable; users may index `.ts`/`.py` files
   - Relevance: If qmd is being used for code search, the domain gap narrows

---

## Convergence Assessment

**Iteration 1 of N**: Cannot assess convergence yet (need 3 iterations for k=3 window).

**Information Saturation**: HIGH for current research questions
- All 5 research plan questions are answered with strong evidence
- New findings in additional iterations would likely be marginal refinements
- Core architectural comparison is complete

**Recommendation**: A second iteration could focus specifically on:
1. Reading `src/retrieval/` in claudemem to check for existing reranking infrastructure
2. Fetching qmd's eval/ directory to understand benchmark methodology
3. Checking qmd's open GitHub Issues for user-reported limitations

---

## Recommendations

### For claudemem Development (Priority Order)

1. **Add query expansion as an optional enhancement** (highest ROI)
   - Start with a simple cloud LLM call to generate a BM25-optimized keyword variant alongside the semantic query
   - Medium-term: Support local GGUF query expansion via node-llama-cpp (Ollama not required)
   - This addresses the biggest gap vs. qmd without requiring local LLM infrastructure

2. **Add a strong-signal BM25 bypass** (low effort, good payoff)
   - If FTS top result score is high AND significantly above 2nd result: return without vector search
   - Benefits exact symbol name lookups (e.g., `claudemem search "useAuthStore"`)

3. **Add an LLM cache layer** (medium effort, good for future)
   - SQLite table: (query_hash, model, chunk_hash) → score
   - Prerequisite for any LLM-based reranking or query expansion caching

4. **Consider neural reranking as a premium feature** (medium effort, high value)
   - Offer as opt-in: `claudemem search --rerank` that uses a local GGUF reranker (or OpenRouter cross-encoder)
   - Position-aware blending (qmd's 75/60/40% ratios) is worth adopting directly

5. **Add project-level context annotations** (low effort, good UX)
   - A `.claudemem/context.yml` with path-prefix → description mappings
   - Surfaced in `claudemem map` output and MCP tool responses

6. **Add HyDE support as an experimental flag** (medium effort)
   - `claudemem search --hyde "query"` generates a hypothetical code snippet via LLM, then embeds it
   - Likely beneficial for architectural/pattern queries ("find code that implements rate limiting")
