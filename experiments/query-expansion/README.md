# Query Expansion Model Experiments

Benchmark and fine-tuning pipeline for small LLMs that expand search queries into `lex:` (keywords), `vec:` (semantic rephrasing), and `hyde:` (hypothetical code snippet) variants for claudemem's hybrid search.

## Current Leaderboard

| Rank | Model | Params | Type | Total |
|------|-------|--------|------|-------|
| 1 | LFM2-2.6B | 2.6B | base | 0.816 |
| 2 | Qwen3-4B-2507 | 4B | base | 0.811 |
| 3 | Qwen3-1.7B-FT | 1.7B | finetuned | 0.777 |
| 4 | LFM2.5-1.2B | 1.2B | base | 0.728 |
| 5 | Qwen3-4B-FT | 4B | finetuned | 0.726 |
| 6 | Qwen3.5-2B | 2B | base | 0.712 |
| 7 | LFM2-700M | 0.7B | base | 0.708 |
| 8 | LFM2-1.2B-FT | 1.2B | finetuned | 0.698 |
| 9 | Gemma-3-1B | 1B | base | 0.690 |
| 10 | SmolLM2-1.7B | 1.7B | base | 0.687 |

Key insight: **SFT teaches FORMAT, not domain knowledge.** Qwen3 models with broken format compliance (scoring 0.01-0.28 base) jump to 0.72-0.78 after fine-tuning. Models with good native format compliance (LFM2, Qwen3.5-2B) show no gain from SFT.

## Directory Structure

```
experiments/query-expansion/
├── README.md                     ← This file
├── NEXT-TRAINING-PLAN.md         ← Round 2 training candidates
├── bench/                        ← Benchmark suite
│   ├── queries.json              ← 50 test queries
│   ├── scorer.ts                 ← Scoring functions
│   ├── models.ts                 ← Model registry (LM Studio keys)
│   ├── run.ts                    ← Runner: base models via LM Studio
│   ├── run-finetuned.py          ← Runner: fine-tuned via transformers+peft
│   └── report.ts                 ← Comparison table generator
├── results/                      ← All benchmark results
│   ├── base/                     ← 16 base model results
│   └── finetuned/                ← 4 fine-tuned model results
├── training/                     ← Fine-tuning pipeline
│   ├── data/                     ← Training datasets
│   │   ├── train.jsonl           ← Raw (1362 examples)
│   │   ├── train-clean.jsonl     ← Deduplicated (692)
│   │   ├── train-split.jsonl     ← Training set (622)
│   │   ├── eval-split.jsonl      ← Eval set (70)
│   │   └── sources/              ← Source data files
│   ├── scripts/                  ← Data generation & validation
│   ├── jobs/                     ← HF Jobs training scripts
│   └── seeds/                    ← Seed queries for data generation
└── research/                     ← Consolidated research notes
    ├── model-tiers.md            ← Model tier comparison matrix
    ├── qmd-comparison.md         ← claudemem vs qmd architectural comparison
    └── sft-candidates.md         ← Open-weight LLMs for LoRA SFT
```

## How to Run

### Generate comparison report

```bash
bun run experiments/query-expansion/bench/report.ts
bun run experiments/query-expansion/bench/report.ts --format csv --sort params
```

### Benchmark a base model (requires LM Studio)

```bash
bun run experiments/query-expansion/bench/run.ts --model qwen3-1.7b
bun run experiments/query-expansion/bench/run.ts --family qwen3.5
```

### Benchmark a fine-tuned model

```bash
uv run experiments/query-expansion/bench/run-finetuned.py --model qwen3-1.7b
uv run experiments/query-expansion/bench/run-finetuned.py --all
```

### Generate training data

```bash
OPENROUTER_API_KEY=... bun run experiments/query-expansion/training/scripts/generate-data.ts
```

### Validate & split dataset

```bash
bun run experiments/query-expansion/training/scripts/validate-dataset.ts --fix --split
```

### Train a model (HF Jobs)

```bash
hf jobs uv run --flavor a10g-large --secrets HF_TOKEN --timeout 2h \
    experiments/query-expansion/training/jobs/sft.py --model qwen3-1.7b
```

## Scoring

Weighted composite of 5 dimensions (see `bench/scorer.ts`):
- **Format** (0.20): Does output contain valid `lex:`, `vec:`, `hyde:` lines?
- **Keyword** (0.20): Are lex terms relevant, diverse, and expanded?
- **Semantic** (0.20): Is vec a good natural language rephrasing?
- **HyDE** (0.25): Is hyde a plausible code snippet?
- **Speed** (0.15): Generation latency

## Result File Naming

- Base models: `{family}-{size}.json` (e.g., `qwen3-1.7b.json`)
- Fine-tuned: `{family}-{size}-ft.json` (e.g., `qwen3-1.7b-ft.json`)
