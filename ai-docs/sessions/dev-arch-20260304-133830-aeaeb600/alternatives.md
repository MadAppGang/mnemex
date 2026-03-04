# Alternatives Design: claudemem Model Fine-Tuning and Integration Pipeline

**Date**: 2026-03-04
**Session**: dev-arch-20260304-133830-aeaeb600
**Status**: Decision-ready

---

## Scope and Framing

This document covers three alternative strategies for building the query expansion fine-tuning pipeline and integrating it into claudemem's live search path. The parallel FIM benchmark (FR-4) is covered as a lightweight side-track in each alternative — its execution does not block or couple to query expansion work.

User decision: Fine-tune all three model tiers in parallel — LFM2-700M (Fast), LFM2.5-1.2B (Balanced), Qwen3-4B-2507 (Most Capable).

**Tension**: The user has chosen the zero-shot benchmark winners (LFM2 family for fast/balanced, Qwen3 for capable) rather than the single-family Qwen3 lineup recommended by the research synthesis. This introduces a meaningful architectural decision: LFM2 is a State Space Model (Mamba-like architecture), not a transformer. Fine-tuning SSMs requires different tooling and carries more risk than fine-tuning the Qwen3 family. Each alternative handles this tension differently.

---

## Alternative A: Lightweight / Practical

**Tagline**: Ship a working fine-tuned model this week using proven tooling, defer SSM risk to a later iteration.

### Overview

Alternative A prioritizes time-to-working-model over completeness. It fine-tunes all three tiers using whatever tooling has the best-documented path for each architecture, accepts that the LFM2 tiers may need to fall back to zero-shot if SSM fine-tuning proves difficult, and integrates query expansion into the search path with a minimal, stable API surface. The FIM benchmark runs independently as a one-day measurement exercise.

The key bet: qmd's existing pipeline works for Qwen3-4B with zero changes. For LFM2, HuggingFace TRL is attempted first with a hardcoded fallback to zero-shot if training fails. The search integration is additive and behind a feature flag — it ships regardless of fine-tuning outcome.

### Fine-Tuning Framework and Methodology

**Qwen3-4B (Most Capable tier)**:
- Framework: HuggingFace TRL (SFT Trainer), same as qmd's proven pipeline
- Config: Clone `qmd/finetune/configs/sft.yaml`, change `model.base: "Qwen/Qwen3-4B"` — one line change
- LoRA rank: 16 (qmd default, no ablation)
- Training: 5 epochs, A10G or L4 GPU via HuggingFace Spaces AutoTrain or Runpod
- Export: GGUF Q4_K_M via llama.cpp `convert_hf_to_gguf.py`

**LFM2-700M and LFM2.5-1.2B (Fast and Balanced tiers)**:
- First attempt: HuggingFace TRL with PEFT LoRA on LFM2 models
- LFM2 architecture note: Liquid Foundation Models use a hybrid SSM/attention architecture. HuggingFace transformers library has added LFM2 model class support (as of late 2025); PEFT LoRA targets the attention projection layers, not the SSM state transition matrices, which are generally left frozen. This makes standard LoRA applicable but limits the fine-tuning surface.
- If LoRA adapter training succeeds: export adapter + base in GGUF Q4_K_M
- If training fails or produces degraded output: document the failure, ship zero-shot LFM2 at those tiers, schedule SSM-specific fine-tuning research for a future sprint
- Fallback criterion: If eval score post-fine-tuning is lower than zero-shot baseline (0.708 / 0.728), revert to zero-shot

**Chat template handling**:
- Qwen3: use existing `apply_chat_template` from qmd pipeline, `/no_think` directive included
- LFM2: verify chat template in HuggingFace model card before training; if not standard, use raw instruction format (less risk than wrong template)

### Dataset Creation Strategy

Reuse qmd's existing 5,157-example dataset as-is for format learning. Generate 500 new code-domain examples as follows:

1. Sample 1,000 function/docstring pairs from CodeSearchNet (Python + TypeScript subsets)
2. Filter to docstrings that read like search queries (imperative phrasing, verb-first, < 15 words)
3. Batch-generate `lex:/vec:/hyde:` expansions using Claude Haiku 3.5 with the existing system prompt from `eval/query-expansion-bench/run.ts`
4. Filter outputs for format compliance (must have exactly 3 lines with correct prefixes)
5. Manual spot-check of 50 random examples; discard batches with > 10% bad hyde outputs
6. Target: 500 examples. Do not scale up unless evaluation shows clear gaps.

All three tiers train on the same combined dataset (5,157 qmd + 500 code-domain = 5,657 examples total). Separate datasets per tier are not needed at this scale.

**Estimated cost**: $0.50 for data generation + $1.50 for Qwen3-4B training + $0.50-1.00 for two LFM2 runs = ~$2.50-3.50 total.

### Integration into Search Pipeline

Add a `QueryExpander` class in `src/core/expansion/expander.ts`:

```typescript
interface ExpandedQuery {
  lex: string;   // BM25 branch input
  vec: string;   // vector embedding input
  hyde: string;  // hypothetical document embedding input
  raw: string;   // fallback (original query)
}

class QueryExpander {
  private cache: Map<string, ExpandedQuery>;
  private client: LocalLLMClient;
  private timeoutMs: number;

  async expand(query: string): Promise<ExpandedQuery | null>;
}
```

In `src/core/store.ts`, the `search()` method receives an optional `expandedQuery` parameter. When provided, it uses `lex` for BM25 and `vec` for vector search. The `hyde` embedding is generated separately and merged with the `vec` embedding (weighted average, weight configurable, default 0.5).

The `--no-expand` flag sets `expandedQuery` to null, restoring the zero-shot search path.

The `SearchUseCase` type gains a new `"expanded"` variant (parallel to the existing `"fim"` variant in types.ts).

Session-level cache: keyed by normalized query (lowercase, trimmed). Cache lives for the duration of the CLI process. No persistence across invocations.

### Model Serving Strategy

No new serving infrastructure. The existing `LocalLLMClient` is used as-is. Model is loaded in LM Studio or Ollama by the user before running claudemem. Tier selection maps to a model name string in config:

```
claudemem.queryExpansion.tier = "capable"  # fast | balanced | capable | off
claudemem.queryExpansion.model = "qwen3-4b-instruct-q4_k_m"  # optional override
```

Auto-detection: on first search, `LocalLLMClient` queries the inference server's model list. If the configured tier's model is not loaded, degrade to next available tier. No model loading/unloading is triggered by claudemem — the user manages which model is loaded.

Timeout: 5,000ms hard limit at the `LocalLLMClient` call site. On timeout, proceed with raw query.

### FIM Benchmark (Side-Track)

One-day measurement exercise. Load each of the three models in turn using `lms`. Run a fixed set of 20 FIM prompts sampled from claudemem's own TypeScript source files. Score completions by: (a) syntactic validity, (b) relevance to the surrounding context (human-judged, 5-point scale), (c) first-token latency. Write results to `eval/fim-bench/results/`. No fine-tuning for FIM in this alternative — zero-shot only.

### Pros and Cons

**Pros**:
- Fastest path to a working end-to-end system (~3-4 days total)
- Qwen3-4B fine-tuning is zero-risk (proven pipeline, one config change)
- Search integration is additive; ships regardless of fine-tuning outcome
- Low cost ($2.50-3.50)
- Clear fallback: zero-shot LFM2 if SSM fine-tuning fails

**Cons**:
- LFM2 fine-tuning may silently underperform without rigorous ablations; the "lower than zero-shot → revert" criterion is coarse
- No LoRA rank ablation for Qwen3-4B (rank=16 may not be optimal)
- HyDE embedding strategy is not validated before shipping (A/B test deferred)
- Single dataset for all tiers (ignores that LFM2 and Qwen3 may have different format learning needs)
- LFM2 SSM architecture risk is accepted but not actively mitigated

### Estimated Complexity and Timeline

| Task | Owner | Duration |
|------|-------|----------|
| Data generation script | 1 dev | 4 hours |
| Generate + filter 500 examples | automated | 2 hours |
| Qwen3-4B fine-tuning (cloud) | automated | 3-4 hours |
| LFM2 fine-tuning attempts | 1 dev | 4-6 hours |
| GGUF export for all models | 1 dev | 2 hours |
| QueryExpander class + cache | 1 dev | 4 hours |
| store.ts integration + --no-expand flag | 1 dev | 3 hours |
| Tier config + auto-detection | 1 dev | 3 hours |
| Benchmark harness re-run | automated | 2 hours |
| FIM benchmark (side-track) | 1 dev | 1 day |
| **Total** | | **~4-5 days** |

### Risk Assessment

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| LFM2 LoRA training produces degraded model | Medium | Low | Zero-shot fallback criterion; document for future SSM sprint |
| Qwen3-4B fine-tuning fails to improve over zero-shot | Low | Medium | qmd proven baseline; Qwen3 SFT is well-documented |
| HyDE embedding degrades search quality | Medium | Medium | `--no-expand` flag; hyde weight configurable |
| LM Studio contention under simultaneous query expansion + FIM | Low | Low | Sequential queuing via existing retry logic |
| 500 examples insufficient for HyDE quality target (> 0.80) | Medium | Medium | Extend to 1,000 examples; schedule additional training run |

---

## Alternative B: Research-Grade

**Tagline**: Comprehensive fine-tuning with architecture-aware methodology, synthetic data generation loops, and rigorous evaluation before any production integration.

### Overview

Alternative B treats the LFM2 SSM architecture as a first-class concern and builds distinct fine-tuning pipelines for transformers (Qwen3) and SSMs (LFM2). It generates training data through an iterative quality loop, runs ablation studies before committing to training hyperparameters, validates HyDE effectiveness empirically before integrating it into the search path, and produces evaluation-grade artifacts at each stage. The FIM benchmark is embedded into the evaluation framework as a shared quality gate.

The key bet: investing 2-3 additional days upfront in rigorous methodology will produce better post-fine-tuning model quality and fewer surprises in production integration.

### Fine-Tuning Framework and Methodology

**Qwen3-4B (Most Capable tier)**:
- Framework: Unsloth (wraps TRL, 2x faster than vanilla, lower VRAM, integrated GGUF export)
- LoRA rank ablation (required before full training run):
  - Train Qwen3-4B with rank={8, 16, 32} on 10% of dataset (565 examples), evaluate on 10 queries
  - Select rank with highest eval score; full training only after ablation complete
- Gradient checkpointing enabled (reduces VRAM for 4B training)
- Training: 5 epochs, A10G on Runpod (billed per hour, not per job — schedule efficiently)
- Export: Unsloth's `model.save_pretrained_gguf(quantization_method="q4_k_m")` (integrated, avoids separate llama.cpp step)

**LFM2-700M (Fast tier)**:
- Framework: MLX-LM (`mlx_lm.lora`) — runs locally on Apple Silicon, no cloud cost
- Rationale: LFM2 models have MLX-format weights available (`mlx-community/LFM2-700M-4bit`). MLX-LM fine-tuning targets the linear projection layers exposed by the MLX model implementation. For SSMs, this is safer than PEFT LoRA on HuggingFace because the MLX model class is specifically tested against LFM2's architecture.
- Limitation: MLX-LM produces MLX format adapters. GGUF conversion requires a second step via `mlx_lm.convert` → HuggingFace → llama.cpp.
- If GGUF conversion fails (SSM architecture may not be fully supported in llama.cpp as of early 2026): ship the MLX adapter for LM Studio MLX backend only. Document GGUF conversion as a follow-on.
- Adapter evaluation: run benchmark harness immediately after training on M-series Mac.

**LFM2.5-1.2B (Balanced tier)**:
- Same MLX-LM approach as LFM2-700M
- Separate adapter trained on same dataset
- This tier is the primary LFM2 validation target: if 1.2B fine-tuning yields < 0.03 improvement over zero-shot (0.728), MLX-LM is not effective for LFM2 and the Fast tier is updated to reflect this

**Architecture-specific considerations**:
- SSM state transition matrices are stateful during inference but not differentiable in the same way as attention weights during backpropagation. MLX-LM targets the input/output projections and MLP layers (same as LoRA), leaving the recurrent state matrices frozen. This is the correct approach.
- Qwen3 uses standard transformer attention: LoRA on Q, K, V, O projections is well-studied.
- Mixing frameworks (Unsloth for Qwen3, MLX-LM for LFM2) adds operational complexity but reduces per-architecture risk.

**Chat template validation step (required before training)**:
- Write a `validate_chat_template.py` script that loads each base model, applies its chat template to 5 sample conversations, and outputs the raw tokenized prompt. Inspect for: correct role tags, no leaked system prompt in user turns, consistent BOS/EOS tokens.
- Fail-fast: if the template produces unexpected output for either LFM2 model, halt and document before starting training.

### Dataset Creation Strategy

**Phase 1: Foundation dataset** (qmd's 5,157 examples as-is).

**Phase 2: Code-domain extension** with quality loop:

1. Sample 2,000 function/docstring pairs from CodeSearchNet (Python, TypeScript, Go)
2. Generate `lex:/vec:/hyde:` expansions using Claude Haiku 3.5
3. Score each generated example using the existing `scorer.ts` heuristics (format compliance + keyword quality check, automated)
4. Keep examples scoring > 0.85 on automated check
5. Expected yield: 70-80% pass rate → 1,400-1,600 examples from 2,000 seeds

**Phase 3: Coverage audit** — after automated generation:
- Count examples per category (symbol queries, error queries, framework queries, navigation queries)
- Identify underrepresented categories
- Handcraft 50-100 examples for missing categories (this is the highest-value data)

**Target**: 1,500 code-domain examples (vs Alternative A's 500). Combined dataset: ~6,700 examples.

**Separate datasets per architecture (optional)**:
- For LFM2 models: bias the training mix toward shorter hyde outputs (< 5 lines of code). SSMs at 700M-1.2B are capacity-constrained; shorter code snippets reduce the probability of hallucinated syntax.
- For Qwen3-4B: use full dataset including longer code snippets.

**Dataset versioning**: save final JSONL files to `finetune/data/` in the repo. Tag with `git tag dataset-v1.0`.

**Estimated cost**: $1.50-2.00 for data generation (2,000 seeds × ~$0.75/1K output tokens) + training costs below.

### Integration into Search Pipeline

More comprehensive than Alternative A, with explicit validation gates before enabling each component.

**Gate 1: HyDE A/B test (required before integrating hyde embedding)**

Before shipping hyde in the search path, run a controlled comparison:
- Take 20 queries from the existing benchmark query set
- For each query: run search with (a) raw query, (b) lex+vec only, (c) lex+vec+hyde
- Score results manually (3-point scale: relevant / partially / irrelevant, top-5 results)
- Only enable hyde embedding if (c) outperforms (b) on > 60% of queries
- Document results in `eval/hyde-ab-test/results.md`

**Implementation**:

```
src/core/expansion/
  expander.ts       -- QueryExpander class with timeout and cache
  parser.ts         -- Parses lex:/vec:/hyde: output format (shared with benchmark)
  hyde-embedder.ts  -- Optional: generates and merges hyde embedding
```

The `hyde-embedder.ts` module is imported only when gate 1 passes. If gate 1 fails, the hyde field is still generated by the expander (for potential future use) but not used in the embedding step.

**HyDE embedding merge strategy (empirically selected)**:
- Option 1: `merged_vec = 0.7 * embed(vec) + 0.3 * embed(hyde)`
- Option 2: `merged_vec = embed(vec + " " + hyde)` (concatenation before embedding)
- Run both on the A/B test query set; pick the winner. Document in `eval/hyde-ab-test/`.

**Gate 2: End-to-end latency measurement**

After integration, run all three tiers through the search path with a 50-query load test. Verify that SLAs from NFR-2 are met. Fail if P95 latency for any tier exceeds hard limit.

**Search integration**: same `SearchUseCase` type extension and `QueryExpander` class as Alternative A, but with the explicit gates creating natural checkpoints.

### Model Serving Strategy

Still uses the existing `LocalLLMClient` for production serving. The research-grade addition is a model availability probe at startup:

```typescript
async function probeModelAvailability(config: ExpansionConfig): Promise<ExpansionTier> {
  // Query /v1/models endpoint
  // Try capable → balanced → fast → off in order
  // Cache result for session
  // Log which tier was selected and why
}
```

This probe runs once when the claudemem CLI starts with a search command. It replaces the on-first-search detection from Alternative A with a more predictable startup-time behavior.

**MLX vs GGUF serving distinction**: LFM2 models (if MLX-only due to GGUF conversion failure) require LM Studio with the MLX runtime. The tier config gains an optional `runtime: "mlx" | "gguf"` field. The probe checks runtime compatibility before committing to a tier.

### FIM Benchmark (Side-Track)

More structured than Alternative A. The FIM benchmark is implemented as a proper eval harness at `eval/fim-bench/`:
- 30 FIM prompts across TypeScript (claudemem source), Python (CodeSearchNet samples), Go (CodeSearchNet samples)
- Automated scoring: prefix match rate (exact), BLEU-4 (semantic), first-token latency
- Separate model configs for query expansion vs FIM (different system prompts, different temperature)
- Results feed into the OQ-5 decision (code completion feasibility)

The FIM benchmark runs in parallel with fine-tuning (different compute, no dependency).

### Pros and Cons

**Pros**:
- Architecture-aware methodology: MLX-LM for SSMs, Unsloth for transformers — reduces per-architecture risk
- Ablation studies prevent shipping with suboptimal hyperparameters
- HyDE gate prevents degrading search quality with unvalidated assumptions
- Higher data quality and volume (1,500 code examples vs 500)
- Dataset versioned in repo; reproducible from scratch
- Chat template validation catches LFM2 compatibility issues before wasted training runs
- FIM benchmark is structured and produces actionable data for OQ-5

**Cons**:
- 2-3 days longer than Alternative A before integration ships
- Two training frameworks (Unsloth + MLX-LM) = more tooling to learn and maintain
- MLX adapter → GGUF conversion is a manual multi-step process with unclear support for LFM2's architecture
- Ablation studies on cloud GPU add $2-3 to training cost
- Gate 1 (HyDE A/B test) may delay the hyde embedding integration by days if the human scoring step is slow

### Estimated Complexity and Timeline

| Task | Owner | Duration |
|------|-------|----------|
| Chat template validation script | 1 dev | 2 hours |
| Data generation (2,000 seeds) | automated | 4 hours |
| Coverage audit + 50-100 handcrafted examples | 1 dev | 4 hours |
| LoRA rank ablation (Qwen3-4B) | automated | 3 hours |
| Qwen3-4B full training (Unsloth, cloud) | automated | 4-5 hours |
| MLX-LM training: LFM2-700M | automated (local) | 2-3 hours |
| MLX-LM training: LFM2.5-1.2B | automated (local) | 3-4 hours |
| GGUF export (Qwen3-4B via Unsloth) | automated | 1 hour |
| MLX → GGUF conversion (LFM2, risky) | 1 dev | 2-4 hours |
| Benchmark harness re-run (3 tiers) | automated | 2 hours |
| HyDE A/B test (Gate 1) | 1 dev | 4-6 hours |
| src/core/expansion/ implementation | 1 dev | 6 hours |
| store.ts integration + latency gate | 1 dev | 4 hours |
| Tier config + startup probe | 1 dev | 3 hours |
| FIM benchmark harness (side-track) | 1 dev | 2 days |
| **Total** | | **~7-9 days** |

### Risk Assessment

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| MLX adapter → GGUF conversion fails for LFM2 | High | Medium | MLX-only serving path for LFM2; document GGUF as follow-on |
| Ablation shows rank=16 not optimal; delays full training run | Low | Low | Budget for one extra training run in cost estimate |
| HyDE A/B test fails gate (hyde degrades search) | Medium | Low | Hyde field still generated; drop embedding step, not generation |
| MLX-LM fine-tuning produces no improvement on LFM2 SSM layers | Medium | Medium | Document architecture limit; recommit to zero-shot or Qwen3 for those tiers |
| 7-9 day timeline slips on manual tasks | Medium | Low | Chat template validation and data audit are parallelizable |

---

## Alternative C: Production-Optimized

**Tagline**: Design for operational simplicity first — automated model management, distillation-aware training, and a self-contained serving layer that handles model lifecycle without user intervention.

### Overview

Alternative C inverts the priority: instead of starting with fine-tuning and bolting on serving, it starts by designing the serving and model management layer, then works backward to determine what fine-tuning artifacts that layer needs. The result is a more operationally complete system — but with more code to write upfront.

The key bets:
1. **Knowledge distillation over pure SFT**: Use Qwen3-4B (post-SFT) as a teacher to generate training data for the LFM2 tiers. This bypasses the SSM fine-tuning architecture problem: instead of fighting LFM2's architecture, generate higher-quality training data specifically calibrated to LFM2's output capacity.
2. **Automated model management**: claudemem handles model download, GGUF conversion, and LM Studio/Ollama installation — the user runs `claudemem models install --tier balanced` and everything is handled.
3. **Request queue with pooling**: A persistent background process (`claudemem expansion-server`) manages the model lifecycle and serves expansion requests via Unix socket, avoiding LM Studio contention entirely.

### Fine-Tuning Framework and Methodology

**Sequencing** (different from A and B):
1. Fine-tune Qwen3-4B first (transformer, proven pipeline, no risk)
2. Use the fine-tuned Qwen3-4B as teacher to generate LFM2 training data
3. Fine-tune LFM2 tiers on teacher-generated data (not raw qmd + CodeSearchNet)

**Qwen3-4B (Step 1)**:
- Framework: HuggingFace TRL with vanilla SFT Trainer
- Dataset: qmd's 5,157 examples + 800 CodeSearchNet-seeded examples generated with Haiku 3.5
- This is the same as Alternative A's Qwen3-4B training, with slightly more data
- LoRA rank: 16 (accept qmd's default, no ablation — Qwen3-4B is not the bottleneck in this alternative)
- After training: verify on benchmark harness. Target: > 0.85 total score.

**Knowledge Distillation for LFM2 tiers (Step 2)**:
- Load fine-tuned Qwen3-4B in LM Studio
- Run the full 50-query benchmark query set through it (50 queries × 5 variations each = 250 prompts)
- Use the Qwen3-4B outputs as teacher labels (not the original qmd or Haiku-generated labels)
- Augment with CodeSearchNet seeds run through the fine-tuned Qwen3-4B: generate 1,000 teacher-labeled examples
- Combined LFM2 dataset: ~1,250 teacher-labeled examples (smaller, but higher quality and calibrated to the task)

**Rationale**: A 700M-1.2B model cannot learn the same output quality as a 4B model from raw training data. But it can learn to approximate the 4B model's outputs. Teacher-generated labels are more internally consistent (same output format, same level of code detail in hyde) than mixing qmd labels (general-domain) with Haiku-generated labels (code-domain, different style). This is knowledge distillation via SFT — a well-established technique.

**LFM2 fine-tuning (Step 3)**:
- Framework: First attempt HuggingFace TRL LoRA on LFM2 (test viability)
- If TRL LoRA works: train LFM2-700M and LFM2.5-1.2B on teacher-labeled data
- If TRL LoRA fails on LFM2 architecture: fall back to MLX-LM (same as Alternative B)
- Teacher labels are format-compatible regardless of framework choice

**Export target**: GGUF Q4_K_M for all three tiers (Qwen3-4B is straightforward; LFM2 GGUF conversion follows Alternative B's approach).

### Dataset Creation Strategy

**Layered generation approach**:

Layer 1 (format foundation): qmd's 5,157 examples — used only for Qwen3-4B training.

Layer 2 (code-domain extension for Qwen3-4B): 800 examples generated by Claude Haiku 3.5 from CodeSearchNet seeds, covering all four query categories (symbol, error, framework, navigation). This is the teacher's training data.

Layer 3 (distilled LFM2 data): 1,250 examples generated by fine-tuned Qwen3-4B, used only for LFM2 training. These examples share format conventions with Qwen3-4B's output style, which the LFM2 models are being trained to replicate.

This layering means:
- LFM2 models are not trying to learn from heterogeneous label sources
- The teacher model has already solved the format compliance problem; LFM2 just needs to match outputs
- Dataset sizes are smaller for the smaller models (correct: LFM2 at 700M learns faster, risks overfitting on large datasets)

**Estimated cost**: $1.00 for Haiku-generated data + $2-3 for Qwen3-4B cloud training + $0.50-1.00 for LFM2 training = ~$3.50-5.00 total. Higher than Alternative A, but teacher generation is free (local inference).

### Integration into Search Pipeline

Alternative C introduces a background expansion server instead of synchronous in-process calls.

**`claudemem expansion-server` (persistent process)**:

```
src/expansion-server/
  server.ts         -- Unix socket server, listens at ~/.claudemem/expansion.sock
  model-manager.ts  -- Handles model loading, unloading, tier selection
  request-queue.ts  -- Serializes concurrent expansion requests
  cache.ts          -- Persistent on-disk cache (SQLite, keyed by query hash)
```

The expansion server:
- Starts automatically when claudemem runs a search (spawned as a child process if not already running)
- Stays alive for 5 minutes after last request, then exits (saves VRAM)
- Manages its own model loading via Ollama's API (not LM Studio, which requires manual model loading)
- Responds to expansion requests over the Unix socket with a 5,000ms timeout

The main claudemem CLI process connects to the expansion server socket. If the server is not running or does not respond within 500ms on the socket, it falls back to direct `LocalLLMClient` calls (same path as Alternative A/B). This provides fault tolerance.

**Cache**: persistent SQLite at `~/.claudemem/expansion-cache.db`, keyed by SHA256 of the normalized query. Entries expire after 7 days. This means repeated queries across sessions skip the model entirely.

**Search integration in store.ts**: unchanged from Alternative A — `search()` accepts an optional `ExpandedQuery`. The caller (CLI search handler) is responsible for fetching the expansion from the server before calling search.

**Ollama dependency for server mode**: the expansion server uses Ollama's REST API to load/unload models programmatically (`POST /api/generate`, `DELETE /api/blobs/:digest`). This is a new dependency not present in A/B. LM Studio does not expose a model management API suitable for automated loading. If the user has LM Studio but not Ollama, the server falls back to direct `LocalLLMClient` calls.

### Model Serving Strategy

**Automated model installation**:

```
claudemem models install --tier fast      # downloads LFM2-700M GGUF, registers with Ollama
claudemem models install --tier balanced  # downloads LFM2.5-1.2B GGUF
claudemem models install --tier capable   # downloads Qwen3-4B GGUF
claudemem models list                     # shows installed tiers, sizes, versions
claudemem models upgrade                  # checks for updated fine-tuned model releases
```

This requires:
- Hosting the fine-tuned GGUF files (HuggingFace Hub under a `claudemem-models` organization, or GitHub Releases for small files)
- A model registry file (`models.json`) versioned with the claudemem package that specifies download URLs and checksums
- Ollama's push/pull API for installation

**Version pinning**: the model registry is pinned to the claudemem package version. `claudemem@0.5.0` specifies which GGUF version to use, preventing version skew between the model and the prompt template.

**Tier fallback at runtime**: the expansion server probes which tiers are installed and selects the best available. Unlike A/B, the user does not need to manually load a model — the server handles it via Ollama's API.

### FIM Benchmark (Side-Track)

Alternative C positions the FIM benchmark as a validation step for the expansion server's ability to handle concurrent requests:
- Run 10 concurrent FIM requests + 10 expansion requests simultaneously to the expansion server
- Measure contention, queue depth, P95 latency under load
- This answers OQ-5's practical question about dual-purpose serving, not just model quality

FIM evaluation uses the same approach as Alternative B (30 prompts, BLEU-4 + first-token latency). Results inform whether the expansion server should have separate model instances for FIM vs query expansion.

### Pros and Cons

**Pros**:
- Distillation approach elegantly sidesteps LFM2 SSM fine-tuning risk by generating better training data, not fighting the architecture
- Persistent server with disk cache eliminates repeated inference overhead — repeated queries across sessions are essentially free
- Automated model installation removes the biggest user friction point in the current design
- Ollama-based model management enables programmatic loading/unloading (VRAM released when not in use)
- Version pinning prevents model/prompt compatibility drift

**Cons**:
- Most code to write: expansion server, model manager, Unix socket IPC, persistent cache, model installer, model registry
- New Ollama dependency for server mode (LM Studio users need Ollama installed separately or get degraded serving)
- Sequential dependency: Qwen3-4B must be trained and evaluated before LFM2 training can begin (blocks parallelism)
- Hosting fine-tuned model files adds ongoing maintenance: HuggingFace org, versioned uploads, checksum management
- "Spawn a background process" is a significant UX increase in system complexity — surprising behavior for a CLI tool
- If distillation improves LFM2 quality but teacher quality is mediocre, errors propagate: bad teacher → bad student

### Estimated Complexity and Timeline

| Task | Owner | Duration |
|------|-------|----------|
| Data generation (800 Haiku-seeded examples) | automated | 3 hours |
| Qwen3-4B fine-tuning (TRL, cloud) | automated | 4-5 hours |
| Qwen3-4B evaluation + validation | 1 dev | 2 hours |
| Teacher generation (1,250 LFM2 examples via Qwen3-4B) | automated | 2 hours |
| LFM2 fine-tuning (2 models, TRL or MLX-LM) | automated | 4-6 hours |
| GGUF export (3 models) | 1 dev | 2-3 hours |
| Model hosting setup (HuggingFace org, registry) | 1 dev | 4 hours |
| expansion-server: Unix socket + queue | 1 dev | 1 day |
| expansion-server: model-manager (Ollama API) | 1 dev | 1 day |
| expansion-server: persistent SQLite cache | 1 dev | 4 hours |
| `claudemem models install` command | 1 dev | 1 day |
| store.ts integration | 1 dev | 3 hours |
| Tier config + startup probe | 1 dev | 3 hours |
| FIM concurrency benchmark (side-track) | 1 dev | 1.5 days |
| **Total** | | **~10-13 days** |

### Risk Assessment

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Qwen3-4B teacher quality insufficient (mediocre teacher → bad student) | Low | High | Validate Qwen3-4B on benchmark before using as teacher; abort if < 0.85 |
| LFM2 GGUF hosting and versioning adds ongoing maintenance burden | High | Medium | Use HuggingFace Hub with automated uploads; version pinned in models.json |
| Unix socket server is surprising behavior for a CLI tool | Medium | Medium | Clear documentation; fallback to synchronous path is seamless |
| Ollama dependency conflicts with LM Studio-only users | Medium | Medium | Graceful fallback to direct LocalLLMClient when socket server unavailable |
| Sequential dependency (train Qwen3 first) adds 4-5 hours to critical path | Medium | Low | Parallelize where possible; LFM2 data generation can start with Haiku |
| Distillation yields no measurable quality gain over SFT on raw data | Low | Low | SFT on raw data is the fallback; teacher labels not strictly required |

---

## Comparison Matrix

| Dimension | Alternative A | Alternative B | Alternative C |
|-----------|--------------|--------------|--------------|
| **Time to first working model** | 1-2 days | 3-4 days | 5-7 days |
| **Time to production integration** | 4-5 days | 7-9 days | 10-13 days |
| **LFM2 SSM risk handling** | Coarse fallback | Architecture-aware tooling | Distillation sidestep |
| **Training cost** | ~$3 | ~$5-7 | ~$5 |
| **HyDE validation** | Deferred | Explicit gate | Deferred |
| **Dataset quality** | 500 examples, basic filtering | 1,500 examples, quality loop | 800+1,250 (layered, distilled) |
| **Serving infrastructure** | LocalLLMClient (existing) | LocalLLMClient + startup probe | Persistent server + Ollama |
| **Cache scope** | Session (in-process) | Session (in-process) | Cross-session (SQLite) |
| **User model management** | Manual (LM Studio/Ollama UI) | Manual + compatibility check | Automated (`models install`) |
| **Code to write** | Low | Medium | High |
| **Novel architecture risk** | Low | Medium (MLX-LM for SSMs) | Medium (distillation + server) |

---

## Recommendation

**Alternative A for the first sprint, with Alternative B's HyDE gate added.**

The primary reason: the LFM2 SSM architecture is an unvalidated risk across all three alternatives. Alternative A's approach (attempt LoRA, fall back to zero-shot) is the honest response to uncertainty. Alternative B's MLX-LM approach is architecturally more principled but adds tooling complexity and still may fail. Alternative C's distillation approach elegantly avoids the problem but delays the first model by 5+ days.

The single element worth borrowing from Alternative B immediately is the HyDE A/B gate. Running HyDE without validating it first (as Alternative A does) risks degrading search quality silently. The gate costs one day and resolves the most critical knowledge gap (OQ-3).

Alternative C's model management and persistent cache ideas are valuable but premature for an initial implementation. They make more sense as follow-on work once the fine-tuned models are validated and in users' hands.

**For the LFM2 SSM problem specifically**: if TRL LoRA on LFM2 fails (which has a real probability), the correct response is to ship Qwen3 for all three tiers using the size-appropriate Qwen3 family (0.6B / 1.7B / 4B), not to invest 2-3 additional days in MLX-LM for an architecture with no published fine-tuning baseline on this task. Document the LFM2 SSM path as a follow-on investigation.

**For the FIM benchmark**: run it in parallel as a one-day measurement exercise (Alternative A's approach). Do not let it block the query expansion timeline.
