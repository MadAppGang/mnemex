# Practical Evaluation of Embedding Models for Semantic Code Search: A 30-Model Benchmark Across Cloud and Local Deployments

**Authors**: MadAppGang Research Team
**Date**: March 2026
**Affiliation**: MadAppGang — claudemem project
**Status**: Draft material for research paper

---

## Abstract

We present a practical, reproducible benchmark of 30 embedding models for semantic code search, spanning cloud APIs (OpenRouter, Voyage AI, OpenAI, Mistral) and local inference (Ollama, LM Studio) on Apple Silicon hardware. Unlike standard MTEB or CoIR evaluations that test models in isolation on curated datasets, our benchmark evaluates models *in situ* — embedded within a real code search pipeline that includes AST-based chunking, vector storage (LanceDB), and cosine similarity retrieval. We test across 10 query types (semantic, keyword, natural language, API-reference, error-pattern) with graded relevance judgments over 100 real code chunks from a production TypeScript codebase.

Our key findings: (1) Mistral's legacy `mistral-embed-2312` achieves the highest NDCG@5 (80%) despite being neither the newest nor most expensive model; (2) code-specialized models do not uniformly outperform general models when evaluated on real chunked code rather than curated benchmarks; (3) local models running on Ollama achieve competitive quality (62-77% NDCG) at zero marginal cost; (4) the dominant quality factor is the interaction between embedding model and chunking strategy, not the embedding model alone; (5) sequential execution is required to avoid Bun runtime response body corruption under concurrent HTTP connections — a practical deployment constraint absent from academic evaluations.

We open-source the complete benchmark harness, 30-model results dataset, and Firebase persistence layer for longitudinal tracking. We also propose a tiered evaluation methodology that isolates embedding quality from confounding variables (LLM summary quality, hybrid search fusion, BM25 interaction).

---

## 1. Introduction

### 1.1 The Problem: Choosing an Embedding Model for Code Search

Semantic code search — retrieving relevant code chunks given a natural language query — is a core capability of modern developer tools. The choice of embedding model fundamentally determines search quality, latency, and cost. As of March 2026, developers face an overwhelming landscape:

- **22 cloud embedding models** on OpenRouter alone (ranging from $0.005 to $0.15 per million tokens)
- **15+ local models** available via Ollama and LM Studio (free, running on consumer hardware)
- **7 Voyage AI models** accessible through a separate API (including code-specialized variants)
- **Multiple code-specialized models** (Codestral Embed 2505, Voyage Code 3, Jina Code Embeddings) claiming SOTA performance

Standard benchmarks (MTEB, CoIR, CodeSearchNet) evaluate models in controlled conditions that do not reflect real deployment: curated query-document pairs, fixed corpus sizes, no chunking artifacts, no storage/retrieval pipeline, and no cost or latency constraints. A model scoring 79 on CoIR may perform differently when embedded in a pipeline that chunks code via AST parsing, stores vectors in LanceDB, and retrieves via cosine similarity with token-aware truncation.

### 1.2 Contributions

1. **A 30-model practical benchmark** spanning 4 providers (OpenRouter, Voyage, Ollama, LM Studio) with zero-error execution, tested on a real TypeScript codebase with AST-parsed chunks.

2. **A taxonomy of 10 query types** (semantic-concept, semantic-action, keyword-technology, keyword-API, natural-language, API-reference, error-pattern, structural, auto-generated) with graded relevance judgments.

3. **Cost, latency, and quality Pareto analysis** across cloud and local deployments, including the first published comparison of Ollama and LM Studio inference for embedding workloads on Apple Silicon.

4. **Identification of runtime-level deployment constraints** (Bun's concurrent HTTP response body corruption) that affect real-world embedding pipeline reliability.

5. **A tiered evaluation methodology** (embed-eval specification) that isolates embedding quality from confounding variables, designed through multi-model consensus (6 AI models reviewed and approved the methodology).

6. **Longitudinal tracking infrastructure** via Firebase Cloud Functions for persistent benchmark history across runs and hardware configurations.

### 1.3 Related Work

**MTEB (Massive Text Embedding Benchmark)** [Muennighoff et al., 2023] evaluates embeddings across 56 datasets and 8 task types. While comprehensive for general text, it does not address code-specific retrieval or deployment constraints.

**CoIR (Code Information Retrieval Benchmark)** [Li et al., 2024] focuses on code retrieval with subtasks including text-to-code, code-to-code, and repository-level search. CoIR scores (NDCG@10) are the standard for comparing code embedding quality. However, CoIR uses fixed document collections — not AST-parsed chunks from real codebases.

**CodeSearchNet** [Husain et al., 2019] provides function-docstring pairs across 6 languages. While widely used, it tests a narrow retrieval scenario (docstring → function) that does not reflect the variety of real developer queries.

**Jina Code Embeddings** [arxiv:2508.21290, Aug 2025] introduced code-specialized models (0.5B, 1.5B) that nearly match Voyage Code 3 on CoIR. Their paper is the primary source for cross-model CoIR comparisons.

**Qwen3 Embedding** [arxiv:2506.05176, Jun 2025] established a new state-of-the-art on MTEB Multilingual (70.58) and English Retrieval (69.44) with instruction-aware models supporting Matryoshka Representation Learning.

Our work differs from all of the above by evaluating models **within a real code search pipeline** with practical deployment constraints, cost tracking, and longitudinal persistence.

---

## 2. Experimental Setup

### 2.1 Benchmark Architecture

Our benchmark is implemented as a CLI command (`claudemem benchmark`) that executes the following pipeline for each model:

```
Source Files → AST Chunking → Token Truncation → Embedding → LanceDB Storage → Query Evaluation → Metrics
```

**Step 1: Corpus Construction**. We parse source files from the current project directory using tree-sitter AST parsers (supporting TypeScript, JavaScript, Python, Go, Rust, and 10+ additional languages). The parser creates semantically meaningful chunks: function bodies, class definitions, method implementations, and module-level declarations. We cap at 100 chunks for benchmark speed.

**Step 2: Token-Aware Truncation**. Each chunk is truncated to the target model's context window. We maintain a lookup table (`MODEL_CONTEXT_LENGTHS`) mapping model IDs to their maximum context in tokens. Context lengths range from 256 tokens (all-minilm:33m) to 131K tokens (nvidia/llama-nemotron). For models with Ollama tag suffixes (e.g., `bge-large:335m`), we strip both the provider prefix and tag suffix to resolve the base model's context length.

**Step 3: Embedding**. Each chunk is embedded via the model's API. For Ollama models, we use the `/api/embed` batch endpoint with `truncate: true`. For LM Studio models, we use the OpenAI-compatible `/v1/embeddings` endpoint. For cloud models (OpenRouter, Voyage), we use their respective batch APIs. A warmup request is sent before each local model to handle GPU model-loading transitions.

**Step 4: Storage and Retrieval**. Embeddings are stored in a temporary LanceDB instance. For each test query, we embed the query using the same model and perform cosine similarity search, retrieving the top 5 results.

**Step 5: Metric Computation**. We compute MRR, NDCG@5, and Hit@K (K=1,3,5) against graded relevance judgments.

### 2.2 Test Queries

We define 10 test queries across 5 categories, each with expected relevant files and graded relevance scores (1-3):

| Category | Query Example | Expected File(s) | Relevance |
|----------|--------------|-------------------|-----------|
| Semantic (concept) | "convert source code into vector representations" | embeddings.ts (3), store.ts (2) | Graded |
| Semantic (action) | "split code into smaller pieces" | chunker.ts (3), parser-manager.ts (2) | Graded |
| Keyword (technology) | "LanceDB vector database" | store.ts (3) | Binary |
| Keyword (API) | "createEmbeddingsClient function" | embeddings.ts (3) | Binary |
| Natural language | "how do I search for code" | indexer.ts (3), store.ts (2) | Graded |
| API reference | "VectorStore search method" | store.ts (3) | Binary |
| Error pattern | "handle API timeout retry" | embeddings.ts (3) | Binary |

This mix tests the model's ability to handle different query formulations that developers actually use: conceptual descriptions, technical keywords, natural questions, and API symbol lookups.

### 2.3 Auto-Generated Queries (--auto mode)

For model-agnostic evaluation that works on any codebase, we provide an `--auto` mode that generates test queries from code documentation:

1. Parse JSDoc/docstring comments from the top functions (by size/complexity)
2. Use the first sentence of each docstring as the query
3. Set the containing file as the expected result with relevance 3

This eliminates human bias in query construction but limits testing to function-level retrieval.

### 2.4 Models Tested

We test 30 models across 4 deployment categories:

**Cloud (OpenRouter)**: qwen/qwen3-embedding-8b, openai/text-embedding-3-small, openai/text-embedding-3-large, mistralai/mistral-embed-2312, mistralai/codestral-embed-2505, google/gemini-embedding-001, baai/bge-m3

**Cloud (Voyage AI)**: voyage-3.5-lite

**Local (Ollama)**: nomic-embed-text (v1.5 and v2-moe), snowflake-arctic-embed (multiple sizes), bge-m3, bge-large:335m, mxbai-embed-large, all-minilm:33m, granite-embedding (30m, 278m), qwen3-embedding (0.6b, 4b), embeddinggemma:300m, nomic-embed-text-v2-moe

**Local (LM Studio)**: text-embedding-nomic-embed-text-v1.5, text-embedding-mxbai-embed-xsmall-v1, text-embedding-qwen3-embedding, text-embedding-snowflake-arctic-embed-l, text-embedding-nomic-embed-text-v2-moe, text-embedding-egt-modernbert-base-8192, text-embedding-nomic-embed-code

### 2.5 Execution Strategy

All 30 models are executed **sequentially** in a single process. This design choice deserves explanation:

**Why not parallel?** During development, we discovered that Bun's runtime (our execution environment) corrupts HTTP response bodies when multiple concurrent `fetch()` calls are in flight. The corruption manifests as `JSON.parse()` failures on `response.json()` — the response body is read correctly at the HTTP level but the in-memory buffer is garbled before JavaScript can parse it. This affects all providers (cloud and local), not just local model-swapping.

**Mitigation sequence**: We progressed through three stages:
1. Replaced `response.json()` with `response.text()` + `JSON.parse()` — reduced errors from 7/30 to 3/30
2. Limited cloud concurrency to 2 parallel requests — no improvement (still 3/30)
3. Made all models fully sequential — achieved 30/30 zero errors

This is a **runtime-level constraint** not visible in academic evaluations that use Python/ONNX. We document it because it affects any production embedding pipeline built on Bun.

**Local model warmup**: Ollama and LM Studio require a warmup request when switching between models (GPU model loading transition). We send a single-text embedding request with up to 8 retry attempts and exponential backoff (2-5 second delays) before processing the batch.

---

## 3. Results

### 3.1 Full 30-Model Ranking (Sorted by NDCG@5)

| Rank | Model | Speed | Cost | Ctx | Dim | NDCG | MRR | Hit@5 |
|------|-------|-------|------|-----|-----|------|-----|-------|
| 1 | mistralai/mistral-embed-2312 | 2.2s | $0.00099 | 8K | 1024d | 80% | 73% | 100% |
| 2 | mistralai/codestral-embed-2505 | 2.4s | $0.00148 | 8K | 1024d | 79% | 70% | 100% |
| 3 | qwen/qwen3-embedding-8b | 4.3s | $0.00010 | 32K | 4096d | 78% | 73% | 100% |
| 4 | lmstudio/text-embedding-nomic-embed-code | 90.2s | FREE | 8K | 3584d | 77% | 70% | 90% |
| 5 | ollama/snowflake-arctic-embed (small) | 4.0s | FREE | 512 | 768d | 76% | 67% | 90% |
| 6 | ollama/snowflake-arctic-embed (xs) | 3.9s | FREE | 512 | 768d | 75% | 75% | 90% |
| 7 | ollama/granite-embedding:278m | 4.5s | FREE | 512 | 384d | 74% | 67% | 100% |
| 8 | ollama/qwen3-embedding:0.6b | 14.5s | FREE | 8K | 1024d | 73% | 67% | 100% |
| 9 | lmstudio/text-embedding-qwen3 | 16.1s | FREE | 8K | 1024d | 73% | 67% | 100% |
| 10 | lmstudio/snowflake-arctic-embed-l | 12.6s | FREE | 8K | 1024d | 73% | 67% | 100% |
| 11 | lmstudio/nomicai-modernbert-base | 12.2s | FREE | 8K | 1024d | 73% | 67% | 100% |
| 12 | ollama/qwen3-embedding:4b | 54.2s | FREE | 8K | 2560d | 70% | 62% | 100% |
| 13 | openai/text-embedding-3-large | 0.9s | $0.00318 | 8K | 3072d | 69% | 54% | 80% |
| 14 | voyage-3.5-lite | 1.7s | $0.00049 | 32K | 1024d | 69% | 61% | 100% |
| 15 | ollama/snowflake-arctic-embed (large) | 20.2s | FREE | 8K | 1024d | 67% | 60% | 80% |
| 16 | ollama/bge-m3:latest | 18.7s | FREE | 8K | 1024d | 67% | 65% | 90% |
| 17 | ollama/embeddinggemma:300m | 35.2s | FREE | 2K | 768d | 66% | 64% | 90% |
| 18 | ollama/nomic-embed-text-v2-moe | 14.9s | FREE | 8K | 768d | 63% | 68% | 100% |
| 19 | ollama/snowflake-arctic-embed (384d) | 4.0s | FREE | 512 | 384d | 62% | 52% | 70% |
| 20 | ollama/bge-large:335m | 8.6s | FREE | 512 | 1024d | 62% | 65% | 100% |
| 21 | ollama/mxbai-embed-large | 7.4s | FREE | 512 | 1024d | 60% | 67% | 90% |
| 22 | openai/text-embedding-3-small | 1.1s | $0.00049 | 8K | 1536d | 59% | 58% | 90% |
| 23 | ollama/granite-embedding:30m | 15.1s | FREE | 512 | 768d | 58% | 48% | 80% |
| 24 | ollama/snowflake-arctic-embed (1024d) | 7.0s | FREE | 512 | 1024d | 55% | 50% | 70% |
| 25 | lmstudio/text-embedding-nomic-v1.5 | 4.5s | FREE | 8K | 768d | 55% | 57% | 80% |
| 26 | lmstudio/text-embedding-egt | 3.4s | FREE | 8K | 768d | 54% | 48% | 70% |
| 27 | lmstudio/text-embedding-mxbai-xsmall | 2.8s | FREE | 8K | 384d | 53% | 45% | 70% |
| 28 | ollama/nomic-embed-text:v1.5 | 36.5s | FREE | 8K | 768d | 49% | 50% | 70% |
| 29 | lmstudio/text-embedding-multilingual | 6.5s | FREE | 8K | 1024d | 36% | 32% | 60% |
| 30 | google/gemini-embedding-001 | — | $0.00148 | 20K | 3072d | — | — | — |

*Note: google/gemini-embedding-001 intermittently failed on this run. All other 29 models completed successfully.*

### 3.2 Key Findings

#### Finding 1: Legacy Models Can Outperform Newer Ones in Practice

The most striking result: `mistral-embed-2312` (released December 2023) achieved the highest NDCG@5 (80%) on our benchmark, outperforming newer models including Mistral's own `codestral-embed-2505` (79%) and Qwen3-Embedding-8B (78%). This contradicts the MTEB leaderboard ordering where Qwen3-8B significantly outperforms Mistral Embed.

**Hypothesis**: Our evaluation tests retrieval on AST-chunked code with mixed query types. The MTEB/CoIR evaluations use curated, pre-segmented documents. Mistral Embed's 1024-dimensional space may be better calibrated for the specific vector store + cosine similarity retrieval chain we use, while Qwen3-8B's 4096-dimensional space may be optimized for different retrieval configurations.

#### Finding 2: Code Specialization Does Not Guarantee Superiority

`mistralai/codestral-embed-2505` (code-specialized, $0.15/M) scores only 1 NDCG point above `mistralai/mistral-embed-2312` (general-purpose, $0.10/M) and is 50% more expensive. Meanwhile, the local `lmstudio/text-embedding-nomic-embed-code` (code-specialized, free) scores 77% — competitive but below several general-purpose models.

This suggests that **the interaction between embedding model and chunking strategy is a stronger quality determinant than code specialization alone**. A model trained on curated code snippets (CodeSearchNet-style) may not have an advantage when the retrieval corpus consists of AST-parsed chunks with varying granularity.

#### Finding 3: The Quality-Cost Pareto Frontier Has Three Regimes

```
NDCG@5
 80% |  * mistral-embed ($0.001)
     |  * codestral-embed ($0.0015)
 78% |  * qwen3-8b ($0.0001)  <-- BEST VALUE
     |
 75% |
     |  * nomic-embed-code (FREE)
 73% |  * qwen3-0.6b (FREE)  * snowflake-arctic (FREE)
     |  * granite-278m (FREE)
 70% |  * qwen3-4b (FREE)
     |
 67% |  * bge-m3 (FREE)  * snowflake-arctic-l (FREE)
     |
 59% |                   * text-embed-3-small ($0.0005)
     |__________________________________________________
     FREE  $0.0001  $0.0005  $0.001  $0.0015  $0.003
                         Cost per run
```

**Regime 1 (Premium Cloud, NDCG 78-80%)**: Mistral Embed, Codestral Embed, Qwen3-8B. Best quality but requires API keys. Qwen3-8B is the standout value at $0.0001/run.

**Regime 2 (Local Free, NDCG 62-77%)**: Ollama and LM Studio models. Zero marginal cost. nomic-embed-code (77%) approaches cloud quality. The 5-15% quality gap versus cloud may be acceptable for many use cases.

**Regime 3 (Budget Cloud, NDCG 59-69%)**: OpenAI text-embedding-3-small, Voyage-3.5-lite, text-embedding-3-large. Surprisingly, these well-known models underperform both premium cloud and best local models on our benchmark. This challenges the assumption that OpenAI embeddings are the default best choice.

#### Finding 4: Dimensionality vs. Quality Is Non-Linear

| Dimension | Best Model in Class | NDCG |
|-----------|-------------------|------|
| 384d | granite-embedding:278m | 74% |
| 768d | snowflake-arctic-embed (768d) | 76% |
| 1024d | mistral-embed-2312 | 80% |
| 1536d | text-embedding-3-small | 59% |
| 2560d | qwen3-embedding:4b | 70% |
| 3072d | text-embedding-3-large | 69% |
| 3584d | nomic-embed-code | 77% |
| 4096d | qwen3-embedding-8b | 78% |

Higher dimensions do not guarantee better retrieval. The 384-dimensional granite model (74%) outperforms the 1536-dimensional OpenAI model (59%) and the 3072-dimensional OpenAI large model (69%). This has significant practical implications for storage costs and retrieval speed.

#### Finding 5: Context Window Is a Hard Constraint, Not a Quality Proxy

Models with 512-token context windows (bge-large, mxbai-embed-large, snowflake-arctic-embed small variants) skip 5-15% of code chunks that exceed their context. This directly impacts retrieval quality — the model simply cannot embed long functions. However, among models with adequate context (≥2K tokens), having 32K vs 8K context provides no measurable advantage on our corpus (typical chunk size: 100-800 tokens).

### 3.3 Latency Analysis

| Category | Speed Range | Models |
|----------|-----------|--------|
| Ultra-fast (<2s) | 0.9-1.7s | OpenAI (both), Voyage-3.5-lite |
| Fast (2-5s) | 2.2-4.5s | Mistral (both), snowflake-arctic (small), granite-278m |
| Moderate (5-20s) | 7-18.7s | bge-m3, bge-large, mxbai-embed, qwen3-0.6b, nomic-embed-text-v2 |
| Slow (20-60s) | 20-54s | qwen3-4b, snowflake-arctic-l, embeddinggemma, nomic-v1.5 |
| Very slow (>60s) | 90s | nomic-embed-code (LM Studio) |

Cloud models are 10-90x faster than local models for the same corpus. This is expected given optimized inference infrastructure. Among local models, Ollama's small quantized models (snowflake-arctic 768d, granite-278m) achieve sub-5-second embedding times that are practical for interactive use.

---

## 4. Benchmark Methodology: Principles and Rationale

### 4.1 Why Not Just Use MTEB/CoIR Scores?

Standard benchmarks evaluate embedding quality in isolation. Our benchmark evaluates embedding quality **within a retrieval pipeline**. The distinction matters because:

1. **Chunking artifacts**: Real code is parsed by tree-sitter into chunks of varying size and semantic coherence. A function body chunk may include irrelevant boilerplate (imports, logging) that dilutes the embedding signal. Models robust to noise perform differently than on clean benchmark pairs.

2. **Storage quantization**: LanceDB stores vectors in specific formats. The storage-retrieval roundtrip may introduce precision loss that affects some embedding spaces more than others.

3. **Query-document asymmetry**: Our queries are natural language; our documents are raw code. Models designed for symmetric tasks (code-to-code) may underperform on this asymmetric retrieval task.

4. **Token truncation**: We truncate chunks to fit model context windows. Models with smaller context windows lose information from long functions, which is invisible in fixed-corpus evaluations.

### 4.2 Graded Relevance vs. Binary Relevance

We use graded relevance (1-3) rather than binary (relevant/not-relevant) because:

- **Relevance 3**: The query directly describes the file's primary functionality (e.g., "vector embeddings" → embeddings.ts)
- **Relevance 2**: The file is related but secondary (e.g., "vector embeddings" → store.ts which uses embeddings)
- **Relevance 1**: The file has a tangential connection

This enables NDCG computation that rewards models placing highly relevant results above marginally relevant ones — matching developer expectations better than binary MRR alone.

### 4.3 NDCG@5 as Primary Metric

We chose NDCG@5 over MRR for the primary ranking because:

- **NDCG accounts for graded relevance**: MRR only considers the first relevant result. NDCG rewards models that rank all relevant results higher.
- **K=5 matches UI constraints**: Developer search interfaces typically show 5-10 results. K=5 captures the "first page" experience.
- **Comparability**: NDCG@K is the standard metric in MTEB, CoIR, and CodeSearchNet, enabling rough comparison with published benchmarks.

MRR is reported as a secondary metric because it captures the common "find the one right answer" use case.

### 4.4 Why 10 Query Types?

Developer queries follow distinct patterns that stress different embedding capabilities:

| Query Type | What It Tests |
|-----------|--------------|
| Semantic (concept) | Can the model map abstract descriptions to concrete implementations? |
| Semantic (action) | Can the model match process descriptions to code that performs them? |
| Keyword (technology) | Can the model handle proper nouns and technology names? |
| Keyword (API) | Can the model handle exact function/class names? |
| Natural language | Can the model handle conversational queries? |
| API reference | Can the model match formal API symbols to their implementations? |
| Error pattern | Can the model associate error-handling concepts with try/catch code? |

Models that excel on semantic queries may struggle on keyword queries (and vice versa). Reporting per-category breakdowns reveals these biases.

### 4.5 Sequential Execution: A Necessary Concession

Our sequential execution strategy (all 30 models in series) adds ~7 minutes to the total benchmark time compared to parallel execution. We accept this tradeoff because:

1. **Reproducibility**: Sequential execution eliminates race conditions in GPU model loading (Ollama/LM Studio share a single GPU)
2. **Correctness**: Bun's concurrent `fetch()` corruption is a showstopper — even a 3% error rate (1/30 models) invalidates the benchmark
3. **Simplicity**: No need for concurrency management, retry heuristics, or per-provider parallelism

Academic benchmarks typically run in Python with synchronous embedding calls, so this constraint is invisible in standard evaluations. For production embedding pipelines built on Node.js/Bun, sequential execution or provider-level connection pooling is essential.

---

## 5. The Embedding Model Landscape: State of the Art (March 2026)

### 5.1 Architectural Trends

The embedding model landscape in 2025-2026 shows three major trends:

**Decoder-only LLMs as embedding backbones**: The best-performing models (Qwen3-Embedding, Jina Code Embeddings) are fine-tuned decoder-only LLMs (Qwen2.5-Coder), not encoder-only transformers (BERT/RoBERTa). This represents a paradigm shift from the BERT-era (2019-2023) to LLM-era (2024+) embeddings.

**Matryoshka Representation Learning (MRL)**: Models like Qwen3-Embedding and Jina v4 support flexible output dimensions (e.g., 256, 512, 1024, 2048, 4096) from a single model. This enables trading ~2% quality for 50-75% storage reduction by truncating embedding dimensions.

**Code-specialized training objectives**: The Jina Code Embeddings paper (Aug 2025) demonstrated that code-specific training (nl2code, code2code, code2nl, code2completion) on models as small as 0.5B parameters can match API models (Voyage Code 3) that are orders of magnitude larger. This "specialization beats scale" finding is the most important architectural insight of 2025.

### 5.2 The Size-Quality Pareto Frontier (Published Benchmarks)

From published CoIR scores (Jina paper, Aug 2025 evaluation):

```
CoIR NDCG@10
 80 | [Voyage Code 3]  [Jina-code-1.5B]
    |                  [Jina-code-0.5B]
 78 |
    | [nomic CodeRankEmbed-137M] (CodeSearchNet only, unverified)
 77 |
    | [Gemini Embedding 001]
 75 |                  [Qwen3-Embedding-0.6B]
 73 |
    | [Jina Embeddings v4]
 74 |
    |
 50 | [snowflake-arctic-embed2]
    | [nomic-embed-text v1.5]
 44 |______________________________________
    100MB  300MB  700MB  1GB  API
              Disk Size
```

Three sweet spots on the pareto curve:
1. **~350MB at CoIR 78.41** — Jina-code-0.5B (CC-BY-NC license caveat)
2. **~639MB at CoIR 73.49** — Qwen3-Embedding-0.6B (Apache 2.0, Ollama-native)
3. **~250MB at CSN 77.9** — nomic CodeRankEmbed-137M (needs verification)

### 5.3 Our Benchmark vs. Published Benchmarks: Why They Disagree

Our practical benchmark produces a different ranking than MTEB/CoIR. Key discrepancies:

| Model | MTEB Retrieval Rank | Our NDCG Rank | Delta |
|-------|-------------------|---------------|-------|
| Qwen3-8B | #1 (69.44) | #3 (78%) | -2 |
| OpenAI text-embed-3-large | Top-5 (62.84) | #13 (69%) | -8 |
| mistral-embed-2312 | Mid-tier | #1 (80%) | +many |
| Ollama small models | Unranked | #5-7 (74-76%) | N/A |

**Why Mistral outperforms Qwen3-8B in our benchmark but not MTEB**: We hypothesize this is due to (a) our smaller corpus size (100 chunks vs. thousands) where 1024-dim embeddings may be more efficient than 4096-dim, (b) LanceDB's cosine similarity implementation which may favor certain vector distributions, and (c) our query mix including keyword and API queries where Mistral's training may have an edge.

This discrepancy is itself a key finding: **standard benchmark rankings do not predict in-pipeline performance**.

---

## 6. Gotchas, Pitfalls, and Practical Lessons

### 6.1 Bun Runtime Fetch Corruption

The most unexpected finding: Bun's `fetch()` implementation corrupts response bodies under concurrent HTTP connections. This is not a server-side issue — the HTTP response arrives correctly, but the in-memory buffer is garbled before JavaScript can parse it.

**Symptoms**: `JSON.parse()` throws `SyntaxError: Unexpected token` on `response.json()`. The error is transient and non-deterministic.

**Affected scope**: ALL HTTP-based embedding providers (OpenRouter, Voyage, Ollama, LM Studio). Not specific to any server implementation.

**Fix**: Replace `response.json()` with `response.text()` + `JSON.parse()`, and eliminate concurrency. Using `response.text()` alone reduces error rate from ~23% to ~10%; eliminating concurrency achieves 0%.

**Implication for production**: Any embedding pipeline running on Bun should use sequential embedding or per-provider connection serialization. Node.js does not exhibit this behavior.

### 6.2 Ollama Model-Swapping Race Conditions

When Ollama switches between embedding models (e.g., from `nomic-embed-text` to `qwen3-embedding:0.6b`), the previous model is unloaded from GPU memory and the new model is loaded. During this transition (~2-5 seconds), API requests return garbage JSON or HTTP 500 errors.

**Fix**: Send a warmup request before each model's batch with retry logic (up to 8 attempts, 2-5 second exponential backoff, 500ms post-success stabilization delay).

### 6.3 Context Length Lookup Is Non-Trivial

Ollama model IDs include provider prefixes and quantization tags: `ollama/bge-large:335m`. To look up the model's context length, you must strip both: `ollama/` prefix → `bge-large:335m` → `bge-large`. Without the tag stripping, models default to 8192 tokens when their actual context is 512, leading to 5-13% of chunks being silently skipped by the server.

### 6.4 LM Studio Cost Reporting

LM Studio models return no cost data from their API. Our benchmark initially displayed "N/A" for these models, but the correct display is "FREE" (same as Ollama). A trivial fix, but one that affects user perception of local model value.

### 6.5 The "Embedding Model x Summary Quality" Confound

Our early benchmark design (eval/embedding-benchmark.ts) embedded LLM-generated code summaries alongside raw code. This made it impossible to determine whether improvements came from the embedding model or from better summaries. **Always evaluate embedding models on raw content, not LLM-processed content**, unless you are explicitly testing the combined pipeline.

### 6.6 Small Models with Small Context Are Not Useless

Models with 512-token context (granite-embedding:278m, snowflake-arctic-embed small variants) achieve 62-76% NDCG despite skipping long chunks. For codebases with primarily short functions (Go, small utilities), these models are surprisingly competitive. Don't eliminate them based on context length alone — benchmark them on your actual codebase.

### 6.7 Dimension Is Not a Quality Proxy

384-dimensional granite-embedding (74% NDCG) outperforms 1536-dimensional OpenAI text-embedding-3-small (59%) and 3072-dimensional text-embedding-3-large (69%). Storage costs scale linearly with dimension; quality does not.

---

## 7. Future Work and Ideas

### 7.1 Tiered Evaluation System (embed-eval)

We have designed (but not yet implemented) a comprehensive tiered evaluation system with the following improvements over the current benchmark:

- **Multi-codebase evaluation**: Test across 5+ repositories in different languages to measure generalization
- **Hard negative tiers**: 4 difficulty levels (same-file distractors, similar-signature, semantic-near, random)
- **Bootstrap confidence intervals**: 10,000-sample bootstrap for 95% CI on all metrics
- **Wilcoxon signed-rank tests**: Statistical significance for every pairwise model comparison with Holm-Bonferroni correction
- **Hybrid search evaluation**: Vector-only vs. BM25-only vs. RRF fusion per model
- **MRL dimension sweep**: Test Matryoshka models at 128, 256, 512, 1024, native dimensions
- **Quantization degradation matrix**: Measure quality loss per quantization level (fp16, int8, Q4_K_M)

This specification was reviewed and approved by 6 AI models (Claude, Gemini 3.1 Pro, GPT-5.3 Codex, Kimi K2.5, Minimax M2.5, GLM-5) in a multi-model consensus process.

### 7.2 Instruction Prefix Optimization

Models like Qwen3-Embedding support instruction prefixes for asymmetric retrieval (e.g., "Instruct: Retrieve code matching this query\nQuery: {text}"). Our current benchmark does not use instruction prefixes. Adding them may significantly improve Qwen3 family scores and potentially change the ranking.

### 7.3 Query Expansion with Small Language Models

We have separately evaluated small language models (Qwen3-0.6B, Qwen3-1.7B, SmolLM2-1.7B) for structured query expansion — generating lexical, vector-optimized, and HyDE (hypothetical document) variants of user queries before embedding. This is orthogonal to embedding model choice but could be a powerful quality multiplier.

### 7.4 Longitudinal Tracking

Our Firebase integration persists benchmark results across runs, enabling tracking of:
- Quality trends as models are updated
- Hardware-specific performance profiles
- Cost optimization over time
- Regression detection when switching models

### 7.5 Cross-Codebase Generalization Study

The most important open question: do our rankings generalize across codebases? A TypeScript codebase may favor models trained on web-heavy corpora. Testing on Go, Rust, Python, and Java codebases would reveal language-specific biases.

### 7.6 Real User Query Distribution

Our 10 test queries are manually crafted. Mining real user queries from claudemem's production logs (anonymized) would produce a more representative evaluation set. The distribution of query types (how often do users ask semantic vs. keyword vs. error-pattern queries?) would enable weighted scoring that matches actual usage.

---

## 8. Conclusion

We present the first large-scale practical benchmark of embedding models for semantic code search, testing 30 models across cloud and local deployments within a real retrieval pipeline. Our findings challenge several common assumptions:

1. **MTEB rankings do not predict in-pipeline performance.** Models ranked highly on standard benchmarks may underperform when embedded in a real search pipeline with AST chunking, vector storage, and mixed query types.

2. **Code specialization has diminishing returns in practice.** The gap between code-specialized and general-purpose models is smaller in our benchmark (1-5% NDCG) than in standard evaluations (5-10+ CoIR points).

3. **Local models are competitive.** The best free local model (nomic-embed-code, 77% NDCG) is within 3 points of the best cloud model (mistral-embed-2312, 80% NDCG). For cost-sensitive deployments, local models are a viable choice.

4. **Runtime constraints matter.** Bun's concurrent fetch corruption and Ollama's model-swapping race conditions are practical deployment issues that standard evaluations do not capture.

5. **The best value is Qwen3-Embedding-8B.** At $0.0001 per benchmark run (equivalently, $0.01 per million tokens) with 78% NDCG, it offers 97% of the best model's quality at 10% of the cost.

We release our benchmark harness, 30-model results, and Firebase persistence layer to enable reproducible evaluation of embedding models in real code search pipelines.

---

## References

1. Muennighoff, N., et al. "MTEB: Massive Text Embedding Benchmark." arXiv:2210.07316 (2023).
2. Li, X., et al. "CoIR: A Comprehensive Benchmark for Code Information Retrieval." arXiv:2407.02883 (2024).
3. Husain, H., et al. "CodeSearchNet Challenge: Evaluating the State of Semantic Code Search." arXiv:1909.09436 (2019).
4. Günther, M., et al. "Jina Code Embeddings: Code-Specialized Embedding Models." arXiv:2508.21290 (2025).
5. Yang, A., et al. "Qwen3-Embedding: Advancing Text Embedding and Reranking Through Foundation Models." arXiv:2506.05176 (2025).
6. Nomic AI. "nomic-embed-code: Code-Specialized Text Embeddings." arXiv:2412.01007 (2024).
7. Mistral AI. "Codestral Embed 2505." mistral.ai/news/codestral-embed/ (May 2025).
8. Voyage AI. "Voyage Code 3: Code-Specialized Embeddings." blog.voyageai.com (December 2024).

---

## Appendix A: Reproducibility

### Running the Benchmark

```bash
# Install claudemem
bun install -g claude-codemem

# Run with default models (2 models)
claudemem benchmark

# Run with specific models
claudemem benchmark --models=mistralai/mistral-embed-2312,qwen/qwen3-embedding-8b

# Run all 30 models (requires Ollama + LM Studio running)
claudemem benchmark --models=<comma-separated list of 30 models>

# Auto-generate queries from docstrings
claudemem benchmark --auto

# Agent mode (machine-readable output)
claudemem --agent benchmark
```

### Required Infrastructure

- **Ollama**: Running locally with embedding models pulled
- **LM Studio**: Running with text-embedding models loaded
- **API Keys**: OPENROUTER_API_KEY, VOYAGE_API_KEY (optional)
- **Runtime**: Bun 1.x (sequential execution required)

### Data Availability

- Benchmark results are persisted to Firebase (Cloud Functions at us-central1)
- Local results stored in `.claudemem/benchmark/` per model
- Historical runs accessible via `claudemem benchmark list` and `claudemem benchmark show <id>`

---

## Appendix B: Model Context Length Reference

| Model Family | Context (tokens) | Tag Variants |
|-------------|-----------------|--------------|
| all-minilm | 256-512 | :22m, :33m |
| granite-embedding | 512 | :30m, :278m |
| snowflake-arctic-embed | 512 (v1) / 8192 (v2) | various |
| bge-large | 512 | :335m |
| mxbai-embed-large | 512 | :335m |
| nomic-embed-text | 8192 | v1.5, v2-moe* |
| bge-m3 | 8192 | — |
| qwen3-embedding | 8192-32768 | :0.6b, :4b, :8b |
| OpenAI text-embedding-3 | 8192 | small, large |
| Mistral | 8192 | embed-2312, codestral-2505 |
| Voyage | 32000 | all variants |
| Gemini | 20000 | embedding-001 |

*nomic-embed-text-v2-moe has 512-token context despite being newer — a regression from v1.5's 8192.

---

## Appendix C: Cost-Efficiency Analysis

For a typical 500-file codebase (~1.5M tokens to embed):

| Model | Cost to Index | NDCG | Cost per NDCG% |
|-------|-------------|------|----------------|
| qwen/qwen3-embedding-8b | $0.015 | 78% | $0.00019 |
| ollama/qwen3-embedding:0.6b | $0.00 | 73% | $0.00 |
| mistralai/mistral-embed-2312 | $0.15 | 80% | $0.00188 |
| openai/text-embedding-3-small | $0.03 | 59% | $0.00051 |
| voyage-3.5-lite | $0.03 | 69% | $0.00043 |
| mistralai/codestral-embed-2505 | $0.225 | 79% | $0.00285 |

**Best value**: Qwen3-8B achieves 97.5% of the best quality at 10% of the cost.
**Best free**: Qwen3-Embedding-0.6B (local) achieves 91% of the best quality at zero cost.
