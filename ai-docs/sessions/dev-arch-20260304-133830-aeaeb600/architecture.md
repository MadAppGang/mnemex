# Architecture: claudemem Model Pipeline (Alternative B — Research-Grade)

**Date**: 2026-03-04
**Session**: dev-arch-20260304-133830-aeaeb600
**Status**: Decision-ready

---

## 1. System Overview

### Architecture Diagram

```
DATA GENERATION                      FINE-TUNING                       EVALUATION
─────────────────                    ───────────                       ──────────

CodeSearchNet ─────────────────────► Qwen3-4B (Unsloth, A100/H100)
  2,000 seeds                            LoRA rank ablation (8/16/32)         ┐
  Python/JS/TS/Go/Rust/Java              5 epochs, bfloat16                   │
                │                        GGUF Q4_K_M export              Benchmark harness
                ▼                                                         (50 queries)
         Claude Haiku 3.5 ────────► LFM2.5-1.2B (MLX-LM, local)         Pre/post scores
          generate lex/vec/hyde          mlx_lm.lora                          │
                │                        MLX adapter → GGUF (risky)          │
                ▼                                                             │
         Quality scorer ────────► LFM2-700M (MLX-LM, local)            HyDE A/B gate
          format check                   mlx_lm.lora                    (20-query set)
          keyword relevance              MLX adapter → GGUF (risky)          │
          hyde syntax check                                                   │
                │                                                        Holdout eval
                ▼                                                        (20 unseen queries)
         Coverage audit                                                       │
          symbol / error /                                                    ▼
          framework / nav /          SERVING                           FIM benchmark
          code review              ──────────                          (parallel track)
                │                                                       100 scenarios
                ▼                  LM Studio (MLX backend)
         finetune/data/             └─ LFM2-700M-ft (MLX)
          train.jsonl                └─ LFM2.5-1.2B-ft (MLX)
          (JSONL, ~6,700 rows)
                                   Ollama (GGUF backend)                INTEGRATION
                                    └─ Qwen3-4B-ft-q4_k_m             ────────────
                                    └─ LFM2 (if GGUF works)
                                                                        src/core/expansion/
                                         ▲                                expander.ts
                                         │                                parser.ts
                                   Auto-detection                         hyde-embedder.ts
                                   at startup                                   │
                                   (probeModelAvailability)                    ▼
                                                                        store.search()
                                                                        BM25(lex) + vec(vec)
                                                                               + vec(hyde)
                                                                        merge + rerank
```

### Component Descriptions

| Component | Location | Responsibility |
|-----------|----------|----------------|
| Data generation script | `finetune/scripts/generate_data.py` | Samples CodeSearchNet, batches Haiku calls, writes JSONL |
| Quality scorer | `finetune/scripts/score_examples.py` | Format/keyword/syntax validation; outputs pass/fail per row |
| Coverage auditor | `finetune/scripts/audit_coverage.py` | Counts category distribution; identifies gaps |
| Chat template validator | `finetune/scripts/validate_chat_template.py` | Fail-fast check before any training run |
| Qwen3-4B trainer | `finetune/qwen3/train.py` + `finetune/qwen3/config.yaml` | Unsloth SFT + LoRA rank ablation |
| LFM2 trainer | `finetune/lfm2/train_mlx.sh` | MLX-LM LoRA on Apple Silicon |
| Benchmark harness | `eval/query-expansion-bench/run.ts` | Existing — reused unchanged |
| HyDE A/B harness | `eval/hyde-ab-test/run.ts` | New — runs 3-way search comparison |
| FIM benchmark | `eval/fim-bench/run.ts` | New — 100 completion scenarios |
| QueryExpander | `src/core/expansion/expander.ts` | Calls local LLM, parses output, caches result |
| Output parser | `src/core/expansion/parser.ts` | Parses lex:/vec:/hyde: format; shared with benchmark |
| HyDE embedder | `src/core/expansion/hyde-embedder.ts` | Embeds hyde text, merges with vec embedding |
| Model probe | `src/core/expansion/probe.ts` | Startup availability check; tier selection |

---

## 2. Fine-Tuning Pipeline Design

### 2.1 Qwen3-4B-2507 (Most Capable Tier)

**Framework**: Unsloth on cloud GPU (A100 or H100)

Unsloth is chosen over vanilla TRL for three reasons: (1) integrated GGUF export via `model.save_pretrained_gguf(quantization_method="q4_k_m")` eliminates the separate llama.cpp conversion step, (2) 2x training speed over vanilla TRL reduces A100 cost from ~$5 to ~$2.50 per full run, (3) gradient checkpointing support fits 4B training in 24GB VRAM without model parallelism.

**LoRA rank ablation (required before full training run)**:

```bash
# Run on 10% of dataset (565 examples), 10 eval queries each
for rank in 8 16 32; do
    python finetune/qwen3/train.py \
        --rank $rank \
        --dataset finetune/data/train_sample_10pct.jsonl \
        --eval-queries eval/query-expansion-bench/queries_sample10.json \
        --output finetune/ablation/rank_${rank}/
done
# Inspect: finetune/ablation/rank_*/eval_score.json
# Select rank with highest eval score for full training run
```

Ablation cost: ~$1.50-2.00 for three short runs on Runpod A10G.

**Full training config** (`finetune/qwen3/config.yaml`):

```yaml
model:
  base: "Qwen/Qwen3-4B"
  chat_template: qwen3_no_think  # applies /no_think directive
lora:
  rank: 16                        # updated from ablation result
  alpha: 32
  target_modules: ["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"]
  dropout: 0.05
training:
  epochs: 5
  batch_size: 4
  gradient_accumulation: 4       # effective batch = 16
  learning_rate: 2e-4
  warmup_steps: 100
  gradient_checkpointing: true
  bf16: true
  max_seq_length: 512            # expansion output is short; 512 is sufficient
dataset:
  path: "finetune/data/train.jsonl"
  format: "messages"             # {"messages": [{"role": ..., "content": ...}]}
export:
  quantization: "q4_k_m"
  output_path: "finetune/artifacts/qwen3-4b-expansion-q4_k_m.gguf"
```

**Export**: Unsloth's integrated GGUF export runs immediately after training:

```python
model.save_pretrained_gguf(
    "finetune/artifacts/qwen3-4b-expansion",
    quantization_method="q4_k_m",
)
```

This produces `finetune/artifacts/qwen3-4b-expansion-Q4_K_M.gguf` (~2.3GB).

### 2.2 LFM2.5-1.2B (Balanced Tier) — MLX-LM on Apple Silicon

**Framework**: `mlx-lm` (`pip install mlx-lm`)

**Base model**: `mlx-community/LFM2.5-1.2B-4bit` (or `mlx-community/LFM-2.5-1.2B-Instruct-4bit` if available)

**SSM architecture note**: LFM2.5 (and LFM2-700M) use Liquid Foundation Models architecture, a hybrid SSM/attention design related to the Mamba family. Fine-tuning considerations:

- SSM state transition matrices (`A`, `B`, `C`, `D` in S4/Mamba notation) are recurrent parameters. They are stateful during inference but the gradients through recurrent steps are sparse and expensive to compute. MLX-LM by default does NOT apply LoRA to these state matrices — it targets the input/output projections and MLP layers only, which is correct.
- This means LoRA on LFM2 modifies approximately the same parameter surface as on a transformer (attention projections + FFN), but leaves the SSM-specific recurrence frozen. Fine-tuning a 700M-1.2B SSM with this approach is functionally equivalent to fine-tuning a transformer of similar non-SSM parameter count.
- **Known limitation**: If the quality gap between input/output projections and recurrent state is large (i.e., the SSM state matrices carry most of the "code understanding" capacity), LoRA on projections alone will not capture it. This is an unresolved open question for LFM2 specifically. The evaluation gate is the empirical answer.
- **Known limitation**: GGUF conversion from MLX format requires MLX → HuggingFace safetensors → llama.cpp conversion. llama.cpp's support for hybrid SSM/attention architectures was in progress as of early 2026. If the conversion fails, LFM2 serves MLX-only via LM Studio's MLX backend.

**Training command**:

```bash
python -m mlx_lm.lora \
    --model mlx-community/LFM2.5-1.2B-4bit \
    --train \
    --data finetune/data/ \
    --iters 1000 \
    --batch-size 4 \
    --lora-layers 16 \
    --adapter-path finetune/artifacts/lfm2.5-1.2b-expansion-adapter/
```

The `finetune/data/` directory must contain `train.jsonl` and `valid.jsonl` in MLX-LM's expected format (same messages format as HuggingFace).

**Adapter evaluation** (immediately after training, on local machine):

```bash
python -m mlx_lm.generate \
    --model mlx-community/LFM2.5-1.2B-4bit \
    --adapter-path finetune/artifacts/lfm2.5-1.2b-expansion-adapter/ \
    --prompt "<eval prompt>" \
    --max-tokens 200
```

Then run `eval/query-expansion-bench/run.ts` with `lms` pointed at the MLX adapter.

**GGUF conversion attempt** (best-effort):

```bash
# Step 1: Fuse adapter into base weights
python -m mlx_lm.fuse \
    --model mlx-community/LFM2.5-1.2B-4bit \
    --adapter-path finetune/artifacts/lfm2.5-1.2b-expansion-adapter/ \
    --save-path finetune/artifacts/lfm2.5-1.2b-expansion-mlx/

# Step 2: Convert MLX → HuggingFace safetensors
python -m mlx_lm.convert \
    --hf-path finetune/artifacts/lfm2.5-1.2b-expansion-mlx/ \
    --mlx-path finetune/artifacts/lfm2.5-1.2b-expansion-mlx/ \
    --dtype float16

# Step 3: llama.cpp conversion (may fail for SSM architecture)
python llama.cpp/convert_hf_to_gguf.py \
    finetune/artifacts/lfm2.5-1.2b-expansion-hf/ \
    --outfile finetune/artifacts/lfm2.5-1.2b-expansion-Q4_K_M.gguf \
    --outtype q4_k_m
```

If step 3 fails with an unsupported architecture error, document and ship MLX-only. The tier config's `runtime` field handles this.

### 2.3 LFM2-700M (Fast Tier)

Same MLX-LM approach as LFM2.5-1.2B. Base model: `mlx-community/LFM2-700M-4bit`.

```bash
python -m mlx_lm.lora \
    --model mlx-community/LFM2-700M-4bit \
    --train \
    --data finetune/data/ \
    --iters 800 \
    --batch-size 4 \
    --lora-layers 12 \
    --adapter-path finetune/artifacts/lfm2-700m-expansion-adapter/
```

Fewer iters and lora-layers than 1.2B (smaller model saturates format learning faster; risk of overfitting is higher at 700M).

**Primary validation target for LFM2 architecture**: if LFM2.5-1.2B fine-tuning yields less than +0.03 improvement over its zero-shot baseline (0.728), conclude that MLX-LM LoRA is not effective for the LFM2 architecture on this task. In that case, update both LFM2 tiers to zero-shot serving and plan a future sprint for SSM-specific fine-tuning research.

---

## 3. Dataset Creation Strategy (1,500 examples)

### 3.1 Source

**CodeSearchNet** (`code-search-net/code_search_net` on HuggingFace). Use the following subsets:
- Python: 491,219 pairs available — sample 700
- JavaScript: 123,889 pairs — sample 300
- TypeScript: 100,000 pairs (estimated) — sample 300
- Go: 167,288 pairs — sample 300
- Rust: 72,000 pairs (estimated) — sample 200
- Java: 181,930 pairs — sample 200

Total: 2,000 seeds. Filter to docstrings that read like search queries (imperative verb-first phrasing, under 15 words, no `@param`/`@return` annotation-only content).

Expected yield after filtering: ~1,200-1,400 usable seeds from 2,000 raw samples.

### 3.2 Generation

**Claude Haiku 3.5** generates `lex:/vec:/hyde:` for each filtered docstring.

System prompt (in `finetune/scripts/prompts/expansion_system.txt`):

```
You are a code search query expansion model. Given a code search query, output exactly three lines:
lex: <2-5 keywords and identifiers for BM25 keyword search>
vec: <a natural language rephrasing that captures semantic intent, 10-20 words>
hyde: <a realistic 3-8 line code snippet that would answer this query, in the language of the codebase>

Rules:
- lex keywords must appear in or be strongly implied by real code
- vec must NOT repeat the lex keywords verbatim; rephrase the intent
- hyde must be syntactically valid code, not pseudocode
- Output exactly three lines starting with lex:, vec:, hyde: in that order
- Do not add explanations, preamble, or trailing text
```

User message format: `Query: {docstring_text}`

Batch size: 50 examples per API call (using Claude's batch API to minimize cost).

**Generation script**: `finetune/scripts/generate_data.py`

```python
# Key parameters
SEED = 42                    # reproducibility
BATCH_SIZE = 50              # Haiku batch API
MODEL = "claude-haiku-3-5"
MAX_TOKENS = 300             # per example; hyde is at most ~8 lines
```

### 3.3 Quality Scoring

**Automated validation** (`finetune/scripts/score_examples.py`):

Each generated example passes three checks:

1. **Format check**: Output has exactly 3 lines; line 1 starts with `lex:`, line 2 starts with `vec:`, line 3 starts with `hyde:`. Fail = discard.

2. **Keyword relevance check**: At least 2 of the lex keywords appear in the original docstring or a tokenized version of the hyde snippet. Fail = flag for manual review (not auto-discard).

3. **Hyde syntax check**: Run the hyde snippet through a language-specific parser:
   - Python: `ast.parse(hyde_text)`
   - TypeScript/JavaScript: `@typescript-eslint/parser` parse (via subprocess call to a small Node.js script)
   - Go: `go/parser` parse (if Go is available)
   - Rust/Java: regex-based heuristic (bracket balance + no obvious pseudocode markers like `...` or `TODO`)

   Fail = discard (hyde syntax invalidity is the strongest quality signal).

**Pass criterion**: examples passing format check + hyde syntax check are retained. The keyword relevance check flags marginal examples for the coverage audit step but does not auto-discard.

Expected pass rate: 70-80%. From 1,200-1,400 usable seeds, expect 850-1,120 quality examples.

**Combined dataset**:
- qmd foundation: 5,157 examples (from `tobil/qmd-query-expansion-train`)
- Code-domain extension: ~1,000 validated examples
- Handcrafted (from coverage audit): 50-100 examples
- Total: ~6,250-6,350 examples

### 3.4 Coverage Audit

After automated generation, `finetune/scripts/audit_coverage.py` classifies each code-domain example into one of five categories using keyword heuristics:

| Category | Detection heuristic | Target count |
|----------|--------------------|-----------   |
| Symbol lookup | lex contains function/class/variable names with identifiers | 250 |
| Error message | query mentions error, exception, traceback, failure | 150 |
| Concept / pattern | query mentions algorithm, pattern, approach, how to | 200 |
| Framework-specific | query contains framework names (React, FastAPI, SQLAlchemy, etc.) | 200 |
| Code review / navigation | query mentions unused, duplicate, deprecated, import, dependency | 200 |

If any category has fewer than 60% of its target, handcraft examples to fill the gap. Handcrafted examples go in `finetune/data/handcrafted.jsonl` (separate file, same format, merged at training time).

### 3.5 Dataset Format

JSONL format, one JSON object per line:

```jsonl
{"messages": [{"role": "system", "content": "<expansion_system_prompt>"}, {"role": "user", "content": "Query: find all files that import from a deprecated module"}, {"role": "assistant", "content": "lex: deprecated import module dependency usage\nvec: locate source files importing from a module marked as deprecated or scheduled for removal\nhyde: import ast\nimport os\n\ndef find_deprecated_imports(path, deprecated_module):\n    for root, _, files in os.walk(path):\n        for f in files:\n            if f.endswith('.py'):\n                tree = ast.parse(open(os.path.join(root, f)).read())\n                for node in ast.walk(tree):\n                    if isinstance(node, ast.Import):\n                        for alias in node.names:\n                            if alias.name == deprecated_module:\n                                print(os.path.join(root, f))"}]}
```

**Dataset versioning**:

```bash
git add finetune/data/train.jsonl finetune/data/valid.jsonl finetune/data/handcrafted.jsonl
git commit -m "dataset: v1.0 — 6,300 examples (5,157 qmd + 1,000 code-domain + 100 handcrafted)"
git tag dataset-v1.0
```

---

## 4. Evaluation Framework

### 4.1 Primary Benchmark (50-query set)

The existing `eval/query-expansion-bench/` harness is reused without modification. It evaluates on five dimensions:

| Dimension | Scoring method | Zero-shot baseline (top model) | Fine-tune target |
|-----------|---------------|-------------------------------|-----------------|
| Format compliance | Exact format check (0 or 1 per example) | ~0.95 | > 0.99 |
| Keyword quality | Keyword relevance + diversity score | ~0.70 (est.) | > 0.80 |
| Semantic rephrasing | Embedding similarity (vec vs query, penalizing verbatim) | ~0.72 (est.) | > 0.82 |
| HyDE code quality | Syntax validity + relevance heuristic | ~0.65 (est.) | > 0.80 |
| Latency | Milliseconds (lower = better score) | LFM2-700M ~697ms | < 500ms (fast tier) |

Run the harness for each fine-tuned model immediately after export:

```bash
cd eval/query-expansion-bench
bun run run.ts --model qwen3-4b-expansion-q4_k_m --results results/qwen3-4b-ft-$(date +%Y%m%d).json
bun run run.ts --model lfm2.5-1.2b-expansion --results results/lfm2.5-1.2b-ft-$(date +%Y%m%d).json
bun run run.ts --model lfm2-700m-expansion --results results/lfm2-700m-ft-$(date +%Y%m%d).json
```

**Regression gate** (automated, added to harness):

```typescript
// eval/query-expansion-bench/regression-gate.ts
const ZERO_SHOT_BASELINES = {
  "lfm2-700m": 0.708,
  "lfm2.5-1.2b": 0.728,
  "qwen3-4b": 0.811,
};
const REGRESSION_THRESHOLD = 0.01;

function checkRegression(model: string, score: number): void {
  const baseline = ZERO_SHOT_BASELINES[model];
  if (score < baseline - REGRESSION_THRESHOLD) {
    console.error(`REGRESSION: ${model} scored ${score} vs baseline ${baseline}. Do not ship fine-tuned weights.`);
    process.exit(1);
  }
}
```

### 4.2 Holdout Set (20 queries)

20 queries not drawn from the existing 50-query set, not used during dataset creation. Created at the start of Phase 1 (before data generation begins) to prevent contamination.

Location: `eval/query-expansion-bench/queries_holdout20.json`

These queries are evaluated once — after all fine-tuning is complete. They test generalization, not the training distribution.

### 4.3 HyDE A/B Gate (Gate 1 — required before hyde embedding integration)

**Purpose**: empirically validate whether hyde embedding improves retrieval before integrating it into the search path.

**Harness**: `eval/hyde-ab-test/run.ts`

**Query set**: 20 queries drawn from the existing 50-query benchmark set (no new queries needed).

**Conditions per query**:
- A: raw query only (current behavior, no expansion)
- B: lex + vec expansion, no hyde embedding
- C: lex + vec expansion + hyde embedding (weighted average: 0.7 * embed(vec) + 0.3 * embed(hyde))
- D: lex + vec expansion + concatenated embedding (embed(vec_text + " " + hyde_text))

**Scoring**: retrieve top-5 results from the claudemem index of its own source code (well-understood ground truth). Score each result as relevant (2), partially relevant (1), or irrelevant (0). Sum per condition = P@5 proxy.

**Pass criterion for hyde embedding**: condition C or D must outperform condition B on > 12 of 20 queries (60% threshold). If neither passes, disable hyde embedding in the search path. The hyde field is still generated by the expander (it may pass a future gate with a different embedding strategy).

**Merge strategy selection**: whichever of C or D performs better on the query set is adopted. Document in `eval/hyde-ab-test/results.md`.

**Estimated time**: 2-4 hours (query + score 20 × 4 conditions = 80 search invocations; scoring is human-judged at 1-2 min per set of 4 result lists).

### 4.4 FIM Benchmark (Parallel Track)

**Purpose**: assess whether the fine-tuned 700M-4B models can double as code completion models (OQ-5 resolution).

**Location**: `eval/fim-bench/`

**Scenarios**: 100 code completion scenarios across TypeScript and Python:
- 60 TypeScript scenarios from claudemem source files (`src/core/`, `src/cli.ts`)
- 40 Python scenarios from CodeSearchNet validation set

**Format**: each scenario is a JSON object with `prefix`, `suffix`, and `reference_completion` fields. FIM prompt assembled as `<|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>`.

**Metrics**:
- Exact match rate (trimmed): completion matches reference within leading/trailing whitespace
- BLEU-4: n-gram overlap with reference
- Edit similarity: normalized Levenshtein distance to reference (1 - edit_distance/max_len)
- First-token latency: time to first token from API

**Per-model evaluation**:

```bash
bun run eval/fim-bench/run.ts \
    --model qwen3-4b-expansion-q4_k_m \
    --scenarios eval/fim-bench/scenarios.json \
    --results eval/fim-bench/results/qwen3-4b-ft.json
```

**Decision gate for OQ-5**: if Qwen3-4B (best candidate for FIM given parameter count) achieves < 15% exact match or BLEU-4 < 0.25 on the TypeScript scenarios, conclude that dual-purpose use is not viable with current fine-tuning. Document and drop FIM from scope.

---

## 5. Search Integration Design

### 5.1 Module Structure

```
src/core/expansion/
  expander.ts         -- QueryExpander: calls LLM, caches, enforces timeout
  parser.ts           -- Parses lex:/vec:/hyde: output (shared with benchmark)
  hyde-embedder.ts    -- Merges hyde embedding with vec embedding (Gate 1 conditional)
  probe.ts            -- Startup model availability probe, tier selection
  types.ts            -- ExpandedQuery, ExpansionConfig, ExpansionTier interfaces
  index.ts            -- Re-exports public API
```

### 5.2 Type Definitions (`src/core/expansion/types.ts`)

```typescript
export interface ExpandedQuery {
  lex: string;    // BM25 input: keywords and identifiers
  vec: string;    // Vector search input: semantic rephrasing
  hyde: string;   // Hypothetical document: realistic code snippet
  raw: string;    // Original query, used as fallback
}

export type ExpansionTier = "fast" | "balanced" | "capable" | "off";
export type ExpansionRuntime = "gguf" | "mlx";

export interface ExpansionConfig {
  tier: ExpansionTier;
  timeoutMs: number;        // default: 5000
  hydeEnabled: boolean;     // set false if Gate 1 fails
  hydeWeight: number;       // weight for hyde embedding merge, default: 0.3
  runtime?: ExpansionRuntime; // "mlx" for LFM2 MLX-only serving
  modelOverride?: string;   // explicit model name, bypasses tier lookup
}

// Tier → model name mapping (updated after fine-tuning artifacts are named)
export const TIER_MODELS: Record<ExpansionTier, { modelId: string; runtime: ExpansionRuntime } | null> = {
  fast:     { modelId: "lfm2-700m-expansion-q4_k_m",    runtime: "gguf" },
  balanced: { modelId: "lfm2.5-1.2b-expansion-q4_k_m",  runtime: "gguf" },
  capable:  { modelId: "qwen3-4b-expansion-q4_k_m",     runtime: "gguf" },
  off:      null,
};
```

### 5.3 QueryExpander (`src/core/expansion/expander.ts`)

```typescript
import { LocalLLMClient } from "../../llm/providers/local.js";
import { parseExpansion } from "./parser.js";
import type { ExpandedQuery, ExpansionConfig } from "./types.js";

export class QueryExpander {
  private cache = new Map<string, ExpandedQuery>();
  private client: LocalLLMClient;
  private config: ExpansionConfig;

  constructor(client: LocalLLMClient, config: ExpansionConfig) {
    this.client = client;
    this.config = config;
  }

  async expand(query: string): Promise<ExpandedQuery | null> {
    const normalized = query.toLowerCase().trim();

    if (this.cache.has(normalized)) {
      return this.cache.get(normalized)!;
    }

    const result = await this.callWithTimeout(normalized);
    if (result) {
      this.cache.set(normalized, result);
    }
    return result;
  }

  private async callWithTimeout(query: string): Promise<ExpandedQuery | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const raw = await this.client.complete({
        model: this.resolveModel(),
        messages: [
          { role: "system", content: EXPANSION_SYSTEM_PROMPT },
          { role: "user",   content: `Query: ${query}` },
        ],
        maxTokens: 300,
        temperature: 0.1,
        signal: controller.signal,
      });
      return parseExpansion(raw, query);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        // Timeout — log and return null (caller falls back to raw query)
        return null;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private resolveModel(): string {
    if (this.config.modelOverride) return this.config.modelOverride;
    const entry = TIER_MODELS[this.config.tier];
    if (!entry) throw new Error("Expansion tier is 'off'");
    return entry.modelId;
  }
}

const EXPANSION_SYSTEM_PROMPT = `You are a code search query expansion model. Given a code search query, output exactly three lines:
lex: <2-5 keywords and identifiers for BM25 keyword search>
vec: <a natural language rephrasing that captures semantic intent, 10-20 words>
hyde: <a realistic 3-8 line code snippet that would answer this query>

Output exactly three lines starting with lex:, vec:, hyde: in that order. No preamble, no explanations.`;
```

### 5.4 Output Parser (`src/core/expansion/parser.ts`)

Shared between the CLI expander and the benchmark harness (replaces duplicated parsing logic in `eval/query-expansion-bench/run.ts`).

```typescript
export function parseExpansion(raw: string, fallback: string): ExpandedQuery | null {
  const lines = raw.trim().split("\n").map(l => l.trim());
  const lexLine  = lines.find(l => l.startsWith("lex:"));
  const vecLine  = lines.find(l => l.startsWith("vec:"));
  const hydeLine = lines.findIndex(l => l.startsWith("hyde:"));

  if (!lexLine || !vecLine || hydeLine === -1) return null;

  const lex  = lexLine.replace(/^lex:\s*/, "").trim();
  const vec  = vecLine.replace(/^vec:\s*/, "").trim();
  // hyde may span multiple lines; collect from hydeLine to end
  const hyde = lines.slice(hydeLine).join("\n").replace(/^hyde:\s*/, "").trim();

  if (!lex || !vec || !hyde) return null;

  return { lex, vec, hyde, raw: fallback };
}
```

### 5.5 HyDE Embedder (`src/core/expansion/hyde-embedder.ts`)

Only loaded when Gate 1 passes (hydeEnabled = true in config).

```typescript
import type { EmbeddingProvider } from "../../embeddings/types.js";

export class HydeEmbedder {
  constructor(
    private embed: EmbeddingProvider,
    private hydeWeight: number,  // default 0.3
  ) {}

  async mergeEmbeddings(vec: string, hyde: string): Promise<Float32Array> {
    const [vecEmb, hydeEmb] = await Promise.all([
      this.embed(vec),
      this.embed(hyde),
    ]);
    // Weighted average: 0.7 * vec + 0.3 * hyde (weights from Gate 1 selection)
    return vecEmb.map((v, i) => (1 - this.hydeWeight) * v + this.hydeWeight * hydeEmb[i]);
  }
}
```

### 5.6 Integration Point in Search Pipeline

The search path in `src/core/store.ts` receives an optional `ExpandedQuery`. The search handler in `src/cli.ts` is responsible for fetching the expansion before calling search:

```typescript
// In src/cli.ts search handler (pseudocode)
const expander = tier !== "off" ? new QueryExpander(llmClient, config) : null;
const expanded = expander ? await expander.expand(query) : null;

// Pass to store.search()
const results = await store.search({
  lex: expanded?.lex ?? query,
  vec: expanded?.vec ?? query,
  hydeEmbedding: expanded && config.hydeEnabled
    ? await hydeEmbedder.mergeEmbeddings(expanded.vec, expanded.hyde)
    : undefined,
  raw: query,
  limit,
});
```

Inside `store.search()`, BM25 uses `lex`, vector search uses `vec` embedding, and if `hydeEmbedding` is provided, it is used for a third parallel vector query whose results are merged (union with deduplication, reranked by score).

### 5.7 CLI Flag and Config

```
--no-expand          Disable query expansion (sets tier = "off" for this invocation)
--expansion-tier     Override tier: fast | balanced | capable | off
```

Config file (`~/.claudemem/config.json`):

```json
{
  "queryExpansion": {
    "tier": "balanced",
    "timeoutMs": 5000,
    "hydeEnabled": true,
    "hydeWeight": 0.3
  }
}
```

---

## 6. Model Serving Strategy

### 6.1 LM Studio (MLX backend — LFM2 family)

LFM2-700M and LFM2.5-1.2B, if GGUF conversion fails, serve via LM Studio's MLX runtime. The user loads the MLX adapter + base model in LM Studio. The `LocalLLMClient` connects to `http://localhost:1234/v1` (LM Studio default).

Model names in LM Studio: `lfm2-700m-expansion` and `lfm2.5-1.2b-expansion` (as named during LM Studio import).

### 6.2 Ollama (GGUF backend — Qwen3-4B, and LFM2 if GGUF works)

Ollama serves GGUF models. Create `Modelfile` for each:

```
# finetune/artifacts/Modelfile.qwen3-4b-expansion
FROM ./qwen3-4b-expansion-Q4_K_M.gguf
SYSTEM """You are a code search query expansion model..."""
PARAMETER temperature 0.1
PARAMETER num_predict 300
```

```bash
ollama create qwen3-4b-expansion -f finetune/artifacts/Modelfile.qwen3-4b-expansion
ollama run qwen3-4b-expansion "Query: find all usages of deprecated API"
```

The `LocalLLMClient` connects to `http://localhost:11434/v1` (Ollama OpenAI-compatible endpoint).

### 6.3 Auto-Detection at Startup (`src/core/expansion/probe.ts`)

```typescript
export async function probeModelAvailability(
  client: LocalLLMClient,
  requestedTier: ExpansionTier,
): Promise<ExpansionTier> {
  if (requestedTier === "off") return "off";

  // Query /v1/models to get loaded model list
  const availableModels = await client.listModels().catch(() => []);
  const availableIds = new Set(availableModels.map(m => m.id));

  // Try requested tier first, then degrade
  const degradationOrder: ExpansionTier[] = ["capable", "balanced", "fast", "off"];
  const startIdx = degradationOrder.indexOf(requestedTier);

  for (let i = startIdx; i < degradationOrder.length; i++) {
    const tier = degradationOrder[i];
    if (tier === "off") return "off";
    const model = TIER_MODELS[tier];
    if (model && availableIds.has(model.modelId)) {
      if (tier !== requestedTier) {
        console.warn(`[expansion] Requested tier '${requestedTier}' not available; using '${tier}'`);
      }
      return tier;
    }
  }
  return "off";
}
```

The probe runs once on CLI startup (before the first search command executes). Result is cached for the session.

### 6.4 Runtime Compatibility Check

Before committing to a tier, the probe checks the `runtime` field against what is available:

```typescript
function isRuntimeAvailable(runtime: ExpansionRuntime): boolean {
  // Heuristic: if LM Studio is at :1234, MLX is likely available
  // If Ollama is at :11434, GGUF is available
  // Both can be available simultaneously
}
```

If the configured tier requires `runtime: "mlx"` but only Ollama is running (not LM Studio), degrade to the next tier.

---

## 7. Implementation Plan

### Phase 1 — Dataset Generation + Quality Validation (Days 1-2)

**Day 1**:
- Create `validate_chat_template.py` — run on all 3 base models. Fail fast if LFM2 templates are wrong.
- Create `generate_data.py` — sample 2,000 CodeSearchNet pairs, call Haiku 3.5, write raw JSONL.
- Run generation (automated, ~4 hours wall time including API calls).

**Day 2**:
- Run `score_examples.py` — format + keyword + hyde syntax checks.
- Run `audit_coverage.py` — category distribution report.
- Handcraft 50-100 examples for underrepresented categories.
- Merge qmd + code-domain + handcrafted into `finetune/data/train.jsonl` and `valid.jsonl` (90/10 split).
- `git tag dataset-v1.0`.

**Deliverables**: `finetune/data/train.jsonl`, `finetune/data/valid.jsonl`, `finetune/data/audit_report.json`

**Blockers for Phase 2**: dataset files must exist and pass audit.

### Phase 2 — Fine-Tuning All 3 Models (Days 3-5)

**Day 3**:
- Run LoRA rank ablation for Qwen3-4B (3 runs × ~1 hour on A10G = ~3 hours).
- Inspect `finetune/ablation/rank_*/eval_score.json`. Select rank.
- Start Qwen3-4B full training (5 epochs, ~4-5 hours on A10G). Run concurrently with:
- Start LFM2-700M MLX-LM training on local Apple Silicon (~2-3 hours).

**Day 4**:
- Qwen3-4B training completes. Export GGUF via Unsloth.
- Attempt LFM2-700M MLX → GGUF conversion. Document result.
- Start LFM2.5-1.2B MLX-LM training (~3-4 hours).

**Day 5**:
- LFM2.5-1.2B training completes. Attempt GGUF conversion.
- All three models in `finetune/artifacts/`.

**Deliverables**:
- `finetune/artifacts/qwen3-4b-expansion-Q4_K_M.gguf`
- `finetune/artifacts/lfm2-700m-expansion-adapter/` (MLX) + GGUF if conversion succeeded
- `finetune/artifacts/lfm2.5-1.2b-expansion-adapter/` (MLX) + GGUF if conversion succeeded
- `finetune/artifacts/training_log.md` (hyperparameters, wall time, GPU cost)

**Blockers for Phase 3**: at least Qwen3-4B artifact must exist.

### Phase 3 — Evaluation + HyDE A/B Gate (Days 5-6)

**Day 5** (afternoon, after Qwen3-4B artifact is ready):
- Load Qwen3-4B in Ollama. Run benchmark harness. Record scores.
- Load LFM2 models in LM Studio. Run benchmark harness.
- Check regression gate for each model.

**Day 6**:
- Run HyDE A/B gate (20-query set, 4 conditions × 20 queries = 80 searches).
- Score results (human-judged, ~2-3 hours).
- Record pass/fail for gate 1. Update `config.hydeEnabled` default based on result.
- Run holdout evaluation (20-query set) for all models that passed regression gate.
- Write `eval/query-expansion-bench/results/summary-$(date).md`.

**Deliverables**:
- `eval/query-expansion-bench/results/qwen3-4b-ft-*.json`
- `eval/query-expansion-bench/results/lfm2-*.json`
- `eval/hyde-ab-test/results.md`
- Go/no-go decision on hyde embedding integration

**Blockers for Phase 4**: gate 1 decision must be made (determines whether `hyde-embedder.ts` is wired into the search path).

### Phase 4 — QueryExpander Integration into Search Pipeline (Days 6-7)

**Day 6** (afternoon):
- Create `src/core/expansion/` module structure.
- Implement `types.ts`, `parser.ts` (refactored from benchmark harness).
- Implement `expander.ts` with cache and timeout.

**Day 7**:
- Implement `probe.ts` (startup model availability probe).
- Implement `hyde-embedder.ts` if Gate 1 passed; skip otherwise.
- Wire `QueryExpander` into `src/cli.ts` search handler.
- Add `--no-expand` flag and `--expansion-tier` override.
- Add `expansion` section to config schema (`src/config.ts`).
- Write unit tests for `parser.ts` and `expander.ts` (mocked LLM responses).
- Write integration test: search with expansion vs without, verify result set differs.
- Run latency gate: P95 search latency with expansion must meet NFR-2 SLAs.

**Deliverables**:
- `src/core/expansion/` (all files)
- Updated `src/cli.ts`
- Updated `src/config.ts`
- `test/unit/expansion/*.test.ts`
- `test/integration/search-with-expansion.test.ts`

### Phase 5 — FIM Benchmark (Parallel Track, Days 5-7)

Runs in parallel with Phases 3-4. No dependency on fine-tuning outcome.

**Day 5**: Create `eval/fim-bench/scenarios.json` (100 scenarios from claudemem TypeScript + CodeSearchNet Python).

**Day 6**: Implement `eval/fim-bench/run.ts`. Run against Qwen3-4B-2507 (zero-shot first, as the best available FIM candidate).

**Day 7**: Run against fine-tuned models. Write `eval/fim-bench/results/summary.md`. Make OQ-5 decision.

**Deliverables**:
- `eval/fim-bench/scenarios.json`
- `eval/fim-bench/run.ts`
- `eval/fim-bench/results/summary.md`
- OQ-5 decision (continue with dual-purpose FIM or drop from scope)

### Phase 6 — Documentation + Model Distribution (Day 9)

- Update `docs/query-expansion.md` (user-facing setup guide: install Ollama or LM Studio, download model, configure tier).
- Update `src/ai-skill.ts` and `src/ai-instructions.ts` with query expansion patterns.
- Tag fine-tuned model artifacts on HuggingFace under a `claudemem-models/` organization (or GitHub Releases if files are small enough).
- Write `CHANGELOG.md` entry for query expansion feature.
- Update `eval/` results README with final benchmark scores.

---

## 8. Testing Strategy

### 8.1 Unit Tests (`test/unit/expansion/`)

**`parser.test.ts`** — tests for `parseExpansion()`:

```typescript
test("parses valid three-line output", () => {
  const input = "lex: import unused module\nvec: find files with unused imports\nhyde: import os\n# unused import above";
  const result = parseExpansion(input, "find unused imports");
  expect(result?.lex).toBe("import unused module");
  expect(result?.vec).toBe("find files with unused imports");
  expect(result?.hyde).toContain("import os");
});

test("returns null for missing lex line", () => { ... });
test("returns null for missing vec line", () => { ... });
test("handles multi-line hyde correctly", () => { ... });
test("handles whitespace-only lex as null", () => { ... });
```

**`expander.test.ts`** — tests for `QueryExpander`:

```typescript
test("returns cached result on second call", async () => {
  const mockClient = createMockClient("lex: foo\nvec: bar\nhyde: baz");
  const expander = new QueryExpander(mockClient, defaultConfig);
  await expander.expand("find foo function");
  await expander.expand("find foo function");
  expect(mockClient.callCount).toBe(1);  // second call uses cache
});

test("returns null on timeout", async () => {
  const slowClient = createSlowClient(6000);  // slower than 5000ms timeout
  const result = await expander.expand("any query");
  expect(result).toBeNull();
});

test("normalizes cache key (lowercase, trim)", async () => { ... });
```

**`probe.test.ts`** — tests for `probeModelAvailability()`:

```typescript
test("degrades from capable to balanced when capable not loaded", async () => { ... });
test("returns off when no models available", async () => { ... });
test("logs degradation warning", async () => { ... });
```

### 8.2 Integration Tests (`test/integration/`)

**`search-with-expansion.test.ts`**:

```typescript
test("search with expansion returns different results than raw search", async () => {
  // Requires: local LLM running on :1234 or :11434 (skip if not available)
  if (!await isLocalLLMAvailable()) { test.skip(); return; }

  const rawResults    = await searchWithoutExpansion("handle file not found error");
  const expandedResults = await searchWithExpansion("handle file not found error");
  // Results may differ; both should be non-empty
  expect(rawResults.length).toBeGreaterThan(0);
  expect(expandedResults.length).toBeGreaterThan(0);
});

test("search falls back to raw query when expansion times out", async () => { ... });
test("search with --no-expand flag skips expander", async () => { ... });
```

### 8.3 Benchmark Regression Test

Automated comparison against zero-shot baseline, run in CI after fine-tuned models are published:

```bash
# eval/query-expansion-bench/regression-check.sh
# Compares fine-tuned model scores against ZERO_SHOT_BASELINES constants
# Exits non-zero if any tier regresses
bun run eval/query-expansion-bench/regression-gate.ts \
    --results eval/query-expansion-bench/results/latest/ \
    --fail-on-regression
```

### 8.4 HyDE Validation — Statistical Significance

After the A/B gate, document statistical significance of the hyde improvement:

```
- N = 20 queries
- Success = hyde condition outperforms lex+vec-only condition on that query
- Pass threshold: > 12/20 (60%)
- Binomial test: p-value for null hypothesis "hyde is equivalent to no-hyde" at k=12, n=20
  p = P(X >= 12 | n=20, p=0.5) ≈ 0.25 (one-sided)
  This is a practical gate, not a statistically tight one.
  For stronger evidence, extend to 50 queries before publishing claims.
```

Note this in `eval/hyde-ab-test/results.md` — the 20-query gate is a go/no-go for shipping, not a publishable finding.

---

## 9. Risk Mitigation

### Risk 1: LFM2 Fine-Tuning Produces No Improvement (Probability: Medium)

**Trigger**: post-fine-tuning benchmark score for LFM2-700M or LFM2.5-1.2B is within the regression threshold of zero-shot baseline.

**Impact**: two of the three tiers ship as zero-shot models, not fine-tuned. The fast and balanced tier quality targets (> 0.80 keyword diversity, > 0.80 HyDE quality) are not met.

**Mitigation**:
1. If improvement is < +0.03: ship zero-shot LFM2 at those tiers. Document in release notes.
2. In parallel, evaluate Qwen3-1.7B as a replacement balanced tier. Qwen3 family has a proven SFT pipeline. A Qwen3-1.7B fine-tuned model may outperform zero-shot LFM2.5-1.2B.
3. Schedule SSM-specific fine-tuning research as a follow-on sprint (different approach: full fine-tuning instead of LoRA, or SSM-specific parameter-efficient methods like H3-adapt).

**Fallback config** (if LFM2 fine-tuning fails):

```json
{
  "TIER_MODELS": {
    "fast":     { "modelId": "qwen3-0.6b-expansion-q4_k_m",   "runtime": "gguf" },
    "balanced": { "modelId": "qwen3-1.7b-expansion-q4_k_m",   "runtime": "gguf" },
    "capable":  { "modelId": "qwen3-4b-expansion-q4_k_m",     "runtime": "gguf" }
  }
}
```

Qwen3-0.6B and Qwen3-1.7B training uses the same Unsloth config as Qwen3-4B with `model.base` changed. This fallback adds ~2 days of training time (both are small models; A10G runs are fast).

### Risk 2: HyDE Degrades Retrieval Quality (Probability: Medium)

**Trigger**: Gate 1 (HyDE A/B test) fails — condition C or D does not outperform condition B on > 12/20 queries.

**Impact**: HyDE field is still generated by the expander (useful for future research), but the hyde embedding is not used in the search path. The hyde embedding integration (`hyde-embedder.ts`) is not wired into production.

**Mitigation**:
1. Set `hydeEnabled: false` as the default in `ExpansionConfig`.
2. Investigate whether hyde quality improves with more training data or a different hyde merge weight.
3. HyDE can be re-enabled via config (`hydeEnabled: true`) for users who want to experiment. The `hydeWeight` config is tunable without a code change.

The search quality without hyde is identical to the pre-expansion baseline at the lex+vec level, so Gate 1 failure causes no regression for users.

### Risk 3: Model Size Bloat Exceeds User Budget (Probability: Low)

**Trigger**: Qwen3-4B GGUF Q4_K_M export exceeds the 3GB C-5 constraint (current estimate: ~2.3GB, but GGUF size depends on quantization block size choices).

**Mitigation**:
1. Verify GGUF size immediately after export: `ls -lh finetune/artifacts/qwen3-4b-expansion-Q4_K_M.gguf`.
2. If > 3GB: switch to Q3_K_M quantization (`quantization_method="q3_k_m"` in Unsloth). Quality loss is < 1% on the benchmark at Q3 vs Q4 for structured output tasks.
3. Document the quantization level in the model card.

### Risk 4: MLX Adapter → GGUF Conversion Fails for LFM2 (Probability: High)

**Trigger**: `convert_hf_to_gguf.py` exits with `UnsupportedArchitectureError` or produces a corrupt GGUF.

**Impact**: LFM2 models serve MLX-only via LM Studio. Users with Ollama-only setups cannot use the fast or balanced tiers.

**Mitigation**:
1. MLX-only serving is explicitly supported in the tier config (`runtime: "mlx"`).
2. The model probe at startup detects whether LM Studio (MLX) or Ollama (GGUF) is available and selects the appropriate runtime.
3. Document in user-facing docs: "LFM2 tiers require LM Studio with MLX backend. Ollama users should use the capable tier (Qwen3-4B, GGUF)."
4. Track llama.cpp LFM2 GGUF support as a follow-on; re-export when support is confirmed.

### Risk 5: 5-Second Expansion Timeout Adds Perceptible Latency (Probability: Low for fast/balanced, Medium for capable)

**Trigger**: Qwen3-4B expansion at capable tier consistently takes > 2s on M2 Pro, adding noticeable delay before search results appear.

**Mitigation**:
1. The 5-second timeout is a hard cap; most capable-tier expansions complete in 2-3 seconds.
2. If user feedback indicates perceptible delay: implement streaming search (return BM25 results immediately using raw query, then update with expanded results when they arrive). This is the option (b) from FR-2.4.
3. The `--no-expand` flag gives users an escape hatch for latency-sensitive interactive use.
