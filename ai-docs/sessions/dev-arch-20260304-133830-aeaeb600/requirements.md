# Requirements Analysis: claudemem Model Pipeline — Next Steps

**Date**: 2026-03-04
**Session**: dev-arch-20260304-133830-aeaeb600
**Status**: Draft — pending validation

---

## Context Summary

The benchmark phase is complete. 16 small LLMs were evaluated zero-shot on 50 code search queries across 5 scoring dimensions (format compliance, keyword quality, semantic rephrasing, HyDE code quality, latency). The three-tier lineup is selected. The next work is: build the fine-tuning pipeline, integrate query expansion into the live search path, and evaluate whether the same models can serve code completion.

**Benchmark results (top performers, zero-shot)**:

| Tier | Model | Score | Latency | VRAM (q4) |
|------|-------|-------|---------|-----------|
| Super Fast | LFM2-700M | 0.708 | ~697ms | ~422MB |
| Balanced | LFM2.5-1.2B | 0.728 | ~558ms | ~663MB |
| Most Capable | Qwen3-4B-2507 | 0.811 | ~2.2s | ~2.3GB |

Research synthesis recommends Qwen3 family (0.6B / 1.7B / 4B) for fine-tuning due to zero pipeline adaptation cost across tiers and strong SFT baseline from qmd project. LFM2 family dominated zero-shot; post-fine-tuning rankings may shift.

---

## 1. Functional Requirements

### FR-1: Fine-Tuning Pipeline

**FR-1.1** Build a supervised fine-tuning (SFT) pipeline that trains a query expansion model on code-search-specific data using the qmd training format (`lex:/vec:/hyde:` three-line output).

**FR-1.2** The pipeline must support all three tier models without code changes between tiers. Changing model size should require only a single configuration parameter update (target: `model.base` in training config).

**FR-1.3** Generate a code-search-specific training dataset by:
- Starting from qmd's existing 5,157-example dataset (`tobil/qmd-query-expansion-train`) as the format learning foundation
- Adding 500–1,000 new code-domain examples covering: function/symbol queries, error message queries, framework-specific patterns, and codebase navigation queries (e.g., "find unused imports", "SearchBar component")
- Using CodeSearchNet docstrings as query seeds for LLM-generated expansions

**FR-1.4** Training data generation must use an LLM API (Claude Haiku 3.5 or equivalent) with a documented prompt template. The generation script must be reproducible from a fixed seed set.

**FR-1.5** Evaluation after fine-tuning must reuse the existing 50-query benchmark harness (`eval/query-expansion-bench/`) to produce comparable scores. Fine-tuned models should show measurable improvement on HyDE code quality (currently the weakest dimension at zero-shot).

**FR-1.6** Export fine-tuned models in GGUF Q4_K_M format for LM Studio / Ollama compatibility. MLX format export is optional for the first iteration.

### FR-2: Query Expansion Integration into Search

**FR-2.1** Integrate query expansion as an optional, non-blocking step in the search path. When a local LLM is available, expand the query before executing hybrid BM25+vector search. When no local LLM is configured, search proceeds with the raw query unchanged.

**FR-2.2** The expanded `lex:` field drives the BM25 (keyword) search branch. The expanded `vec:` field drives the vector search branch. The `hyde:` field is embedded separately and merged with the `vec:` embedding (weighted average or concatenation — to be determined by A/B test).

**FR-2.3** A `--no-expand` CLI flag (or config option) must allow users to bypass query expansion for debugging or latency-sensitive contexts.

**FR-2.4** Query expansion latency must not block search result rendering. Either:
- (a) Run expansion synchronously and add its latency to total search time, capped at a hard timeout (see NFR-2), or
- (b) Return initial results without expansion and re-rank in the background (streaming update pattern)

Option (a) is simpler and is the default; option (b) is a follow-on if latency measurements show user-perceptible delay.

**FR-2.5** The `SearchUseCase` type system must accommodate expanded queries alongside raw queries. The existing `"fim"` variant in the search type is a reference pattern for how alternate search modes are registered.

**FR-2.6** Query expansion results must be cached per-session (in-process, keyed by normalized query string) to avoid redundant inference calls on repeated searches.

### FR-3: Model Tier Configuration

**FR-3.1** Users must be able to select a query expansion tier via config or CLI flag. Supported values: `"fast"`, `"balanced"`, `"capable"`, `"off"`. Default: `"balanced"`.

**FR-3.2** The tier selection must auto-detect which models are available in the local inference server (LM Studio or Ollama) and degrade gracefully when the selected tier's model is not installed. Degradation order: `capable` → `balanced` → `fast` → `off`.

**FR-3.3** The existing `LocalLLMClient` in `src/llm/providers/local.ts` (which already handles LM Studio contention retries and model metadata queries) must be extended or reused without reimplementation.

### FR-4: Code Completion (Exploratory)

**FR-4.1** Evaluate whether the same fine-tuned 1.2B–4B models can serve fill-in-the-middle (FIM) code completion alongside query expansion. The existing `AutocompleteEngine` in `src/autocomplete/` already handles FIM protocol.

**FR-4.2** The dual-purpose model evaluation must measure: (a) code completion quality on a sample of TypeScript/Python completions from real claudemem source files, (b) latency impact of context switching between query expansion and FIM modes when both are in use.

**FR-4.3** Separate model instances for query expansion and code completion are acceptable if simultaneous use is required. Shared model instances with request queuing are preferred for memory efficiency.

**FR-4.4** Code completion is not blocked on query expansion fine-tuning. It can proceed in parallel using the zero-shot model capability as a starting point.

---

## 2. Non-Functional Requirements

### NFR-1: Memory Constraints

| Tier | Model VRAM | Embedding Model | Total Target |
|------|------------|-----------------|--------------|
| Fast | ~422MB (LFM2-700M) | ~300MB | < 800MB |
| Balanced | ~663MB (LFM2.5-1.2B) | ~300MB | < 1.1GB |
| Capable | ~2.3GB (Qwen3-4B) | ~300MB | < 3.0GB |

Full claudemem stack (query expansion + embedding + BM25 index) must fit within 8GB unified memory on the primary deployment target (M2 Pro / M3 Pro with 16GB). The capable tier leaves ~5GB for OS + other applications on a 16GB machine, which is acceptable.

LanceDB vector index size is separate and bounded by the user's codebase size, not the model tier.

### NFR-2: Latency SLAs

| Operation | Fast Tier | Balanced | Capable | Hard Limit |
|-----------|-----------|----------|---------|------------|
| Query expansion | < 500ms | < 1,000ms | < 3,000ms | 5,000ms |
| Search (with expansion) | < 1,000ms | < 1,500ms | < 4,000ms | 8,000ms |
| Search (without expansion) | < 200ms | < 200ms | < 200ms | 500ms |
| FIM completion (first token) | < 300ms | < 500ms | < 1,500ms | 3,000ms |

If expansion exceeds the hard limit, the request is aborted and search proceeds with the raw query. This timeout is implemented at the `LocalLLMClient` call site.

Current zero-shot measurements show LFM2.5-1.2B at ~558ms — already within the balanced tier SLA. Post-fine-tuning latency is expected to be equivalent (same model weights, same hardware).

### NFR-3: Quality Targets (Post-Fine-Tuning)

| Metric | Zero-Shot Baseline | Fine-Tune Target |
|--------|--------------------|-----------------|
| Total score (best model) | 0.816 | > 0.87 |
| HyDE code quality | ~0.65 (est.) | > 0.80 |
| Format compliance | ~0.95 (top models) | > 0.99 |
| Keyword diversity | ~0.70 (est.) | > 0.80 |

Targets are estimates; actual zero-shot per-dimension scores are in `eval/query-expansion-bench/results/`. Fine-tuning targets are set based on qmd's reported 92–93.8% accuracy on code queries after SFT.

### NFR-4: Reproducibility

The entire pipeline (data generation, training, evaluation) must be scriptable and reproducible from a clean machine with documented steps. No manual steps requiring undocumented human judgment.

### NFR-5: Offline Operation

Query expansion inference must function without internet access. No cloud API calls during inference. Training and data generation may use cloud APIs but must be one-time offline steps whose outputs are checked in or archived.

---

## 3. Constraints

### C-1: Apple Silicon Deployment

Primary deployment target is Apple Silicon (M-series, 16–64GB unified memory). The inference stack must run on:
- macOS 14+ (Sonoma / Sequoia)
- LM Studio >= 0.3.x or Ollama >= 0.3.x
- No CUDA dependency; MLX or Metal-optimized GGUF only

### C-2: 4-Bit Quantization

All production models run at 4-bit quantization (Q4_K_M for GGUF, 4-bit for MLX). No full-precision or 8-bit inference in production. Fine-tuning may use full precision or bfloat16 on cloud GPU hardware.

### C-3: Local-Only Inference

No inference calls to external APIs at search time. The existing `LocalLLMClient` is the only permitted inference path for query expansion. Cloud LLM calls are permitted only during: dataset generation, fine-tuning, and offline evaluation.

### C-4: Existing Infrastructure Compatibility

Must integrate with:
- `LocalLLMClient` (OpenAI-compatible API, supports LM Studio and Ollama, handles model contention retries)
- LanceDB for vector storage and BM25 hybrid search
- Existing `src/llm/` provider abstraction (no new provider classes unless strictly necessary)
- `lms` CLI for model management in the benchmark harness

No rewriting of the core indexing or search pipeline. Query expansion is an additive pre-processing step.

### C-5: Model File Size Budget

A user installing claudemem should not be required to download more than 3GB of model data for any single tier. The capable tier (Qwen3-4B at ~2.3GB GGUF) is the maximum permitted model size for the query expansion feature.

---

## 4. Assumptions

**A-1: SFT teaches format, not domain knowledge.** Fine-tuning on 500–1,000 code-specific examples (on top of qmd's 5,157-example foundation) is sufficient to achieve the quality targets. This is supported by the LIMA paper (1,000 examples sufficient for format alignment) and qmd's empirical result (93.8% accuracy on code queries despite <8% code training data). If this assumption fails, the fallback is to increase training data to 5,000+ examples.

**A-2: Zero-shot LFM2 results generalize post-fine-tuning.** LFM2 dominated the zero-shot benchmark but has no published SFT pipeline for this task format (unlike Qwen3 which has the qmd baseline). We assume fine-tuning LFM2 models is feasible using standard HuggingFace TRL / MLX-LM tooling. This assumption requires validation before committing to LFM2 as the production family.

**A-3: qmd's training format is directly reusable.** The `lex:/vec:/hyde:` three-line format and qmd's `prepare_data.py` / `sft.yaml` pipeline apply without modification for the Qwen3 family. For LFM2, format compatibility requires verification.

**A-4: HyDE is beneficial for code search.** No published benchmark directly validates HyDE on code retrieval (this is the most significant unverified assumption). We assume the dense encoder's bottleneck effect (filters incorrect details from hypothetical snippets) applies to code embeddings. Validation requires an A/B test in claudemem's actual search pipeline.

**A-5: LM Studio contention handling is sufficient.** The existing retry logic in `LocalLLMClient` (2s / 4s / 8s delays) handles the case where LM Studio is swapping models. If users run query expansion and FIM completion simultaneously, contention may increase. We assume sequential request queuing at the application layer is sufficient without changes to the retry logic.

**A-6: The benchmark's 50-query test set is representative.** The existing query set covers the main categories of code search queries. Fine-tuning quality is evaluated using this set. If real-world usage reveals category gaps (e.g., queries in languages not covered), the test set and training data must be extended.

---

## 5. Dependencies

### D-1: Fine-Tuning Compute

- Cloud GPU: HuggingFace Spaces / AutoTrain, or Runpod / Lambda Labs A10G
- Estimated cost: $2–$10 total for all three tiers (see synthesis document for breakdown)
- No local GPU required for training; Apple Silicon MPS is a fallback but slower

### D-2: Training Framework

One of the following (decision is an open question — see Section 6):
- **MLX-LM**: Native Apple Silicon, no GPU server needed, limited to MLX format output
- **Unsloth**: HuggingFace-compatible, 2x faster than vanilla TRL, GGUF export support
- **Axolotl**: Most flexible, highest configuration overhead
- **HuggingFace TRL** (vanilla): Proven by qmd project, A10G support, straightforward

### D-3: Training Data

- `tobil/qmd-query-expansion-train` (HuggingFace, 5,157 examples) — format learning foundation
- `code-search-net/code_search_net` (HuggingFace, 1.88M function/docstring pairs) — query seed source
- Claude Haiku 3.5 API — for generating `lex:/vec:/hyde:` expansions from CodeSearchNet seeds
- Estimated API cost for 500–1,000 new examples: $0.40–$1.00

### D-4: Model Artifacts

- Base models: `Qwen/Qwen3-1.7B` and `Qwen/Qwen3-4B` (HuggingFace, public)
- Or LFM2 bases if chosen: `liquid/LFM2-700M`, `liquid/LFM2.5-1.2B`, `liquid/LFM2-2.6B`
- GGUF Q4_K_M conversion tooling: `llama.cpp` (or integrated in training framework)

### D-5: Evaluation Infrastructure

- Existing: `eval/query-expansion-bench/` harness (TypeScript, runs via `bun`)
- Existing: LM Studio + `lms` CLI for model loading in the harness
- Additional: A/B test harness for HyDE effectiveness (new, lightweight — compare search result quality with and without `hyde:` embedding)

### D-6: Code Completion Evaluation (if pursued)

- Test corpus: A representative sample of incomplete TypeScript/Python snippets from claudemem source files
- FIM evaluation metric: exact match on masked tokens or embedding similarity to reference completion
- Existing infrastructure: `src/autocomplete/` already implements FIM server protocol

---

## 6. Open Questions

### OQ-1: Fine-Tuning Framework Selection

**Decision needed before**: starting training.

Options:
- **Unsloth + TRL**: Best balance of speed (2x faster than vanilla TRL), GGUF export, HuggingFace ecosystem compatibility. Supports Qwen3. Requires a Linux GPU server.
- **MLX-LM**: Runs locally on Apple Silicon. No cloud cost. Output is MLX format only (no GGUF without conversion). Risk: MLX training for instruction-following tasks is less documented than TRL.
- **HuggingFace TRL (vanilla)**: qmd uses this. Proven for the exact task. No Unsloth optimization. A10G cost is ~$1.50–$5 per model tier.
- **Axolotl**: Highest configurability, multi-GPU support. Unnecessary complexity for this task scale.

**Recommendation pending**: Unsloth is likely the best choice if a Linux GPU is accessible. MLX-LM if local-only training is required.

### OQ-2: Model Family Commitment — Qwen3 vs LFM2

**Decision needed before**: building the fine-tuning pipeline.

The zero-shot benchmark favored LFM2 at sub-2B sizes (LFM2-700M: 0.708, LFM2.5-1.2B: 0.728) over Qwen3 (Qwen3-1.7B: scores not yet in top-3 at zero-shot). However:
- qmd's proven SFT pipeline targets Qwen3-1.7B with documented 92–93.8% post-fine-tuning accuracy
- No published fine-tuning baseline exists for LFM2 on this task
- Qwen3 family has zero pipeline adaptation cost across 0.6B / 1.7B / 4B tiers

**The question**: Is LFM2's zero-shot advantage (~0.72 vs Qwen3's unknown zero-shot) significant enough to justify the additional fine-tuning engineering risk? Or does fine-tuning equalize performance, making the Qwen3 pipeline the rational choice?

**Suggested resolution**: Fine-tune Qwen3-1.7B first (lower risk, proven baseline), then fine-tune LFM2.5-1.2B in parallel if time allows, and compare post-fine-tuning scores.

### OQ-3: HyDE Embedding Strategy

**Decision needed before**: search path integration.

Three options for using the `hyde:` field in search:
- (a) **Embed separately, merge embeddings**: Generate a third embedding from the hyde snippet, merge with vec embedding via weighted average. Adds one embedding call per query.
- (b) **Use hyde text as augmented vec**: Append the hyde snippet to the vec field and embed together. Simpler, no extra embedding call, but may dilute the semantic rephrasing.
- (c) **A/B test before committing**: Run search quality comparison on a fixed query set before choosing.

Option (c) is required regardless. The A/B test measures retrieval precision/recall (or a proxy like judge-scored result relevance) with and without the hyde embedding contribution.

**Unresolved**: No published benchmark validates HyDE for code search specifically. This is the highest-priority empirical question before production deployment of HyDE.

### OQ-4: Dataset Size — Option A (500–1K) vs Option B (5K–10K)

**Decision needed before**: data generation sprint.

Research synthesis recommends Option A (500–1,000 new code examples, ~$2–3 total) based on the LIMA finding that format learning saturates quickly. The risk is that HyDE quality for code requires more examples than semantic rephrasing quality.

**Suggested resolution**: Start with Option A. Evaluate fine-tuned model on the benchmark and identify specific failure categories (e.g., consistently poor function-level query hyde output). Only scale to Option B if Option A leaves a clear measurable gap.

### OQ-5: Code Completion Feasibility with Same Models

**Decision needed before**: committing to dual-purpose model serving.

The question is whether 700M–4B models fine-tuned for query expansion retain enough code generation capacity for useful FIM completion. The concern is that SFT for query expansion (short structured output, suppressed chain-of-thought via `/no_think`) may degrade the base model's FIM capability.

**Evidence for feasibility**: LoRA fine-tuning modifies a small fraction of parameters. Base model code generation capacity should be largely retained (Superficial Alignment Hypothesis). qmd's fine-tuned model is documented as still performing well on general tasks.

**Evidence against**: 700M–1.2B models produce weak code completion at zero-shot. Fine-tuning may not help here. Qwen3-4B is borderline useful for FIM; LFM2 models have less documented FIM capability.

**Suggested resolution**: Benchmark Qwen3-4B-2507 (current best, zero-shot) on a FIM task using the existing `src/autocomplete/` infrastructure before deciding whether to invest in dual-purpose fine-tuning. If zero-shot FIM quality is unacceptably low, drop code completion from the model pipeline scope.

### OQ-6: LoRA Rank for 4B Model

**Decision needed before**: training the capable tier.

qmd uses rank=16 for Qwen3-1.7B. For Qwen3-4B, rank=16 is the starting point, but:
- Rank=8 may suffice (lower training cost, less risk of overfitting)
- Rank=32 may improve format compliance quality
- The optimal rank is task-dependent and not published for this model/task combination

**Suggested resolution**: Run a small rank ablation (8, 16, 32) on 10% of the training data and 10 eval queries before the full training run. Cost is minimal (~15 minutes additional compute).

---

## Summary: Work Breakdown

The following is a rough sequencing for the next steps, ordered by dependency:

1. **Decide model family** (Qwen3 vs LFM2) — blocks all fine-tuning work (OQ-2)
2. **Decide training framework** — blocks fine-tuning environment setup (OQ-1)
3. **Generate code-domain training data** — 500–1,000 examples from CodeSearchNet seeds (FR-1.3, FR-1.4)
4. **Fine-tune Balanced tier model** (1.2B–1.7B) — first full training run, validates pipeline
5. **Evaluate on benchmark harness** — compare against zero-shot baseline (FR-1.5)
6. **A/B test HyDE effectiveness** in claudemem search — validates the `hyde:` embedding strategy (OQ-3)
7. **Integrate query expansion into search path** — additive pre-processing step (FR-2.x)
8. **Fine-tune Fast and Capable tier models** — after Balanced tier is validated
9. **Evaluate code completion feasibility** — benchmark Qwen3-4B FIM zero-shot (OQ-5)
10. **Implement tier selection and model auto-detection** — user-facing config (FR-3.x)
