---
name: agentbench-eval
description: AgentBench evaluation harness for claudemem. Covers pre-indexed repos, experiment conditions, running benchmarks, analyzing results, and managing index archives. Use when working on eval infrastructure, running experiments, or interpreting benchmark results.
---

# AgentBench Evaluation Skill

Run and manage claudemem evaluation experiments against the eth-sri/agentbench benchmark (138 instances, 12 Python repos).

## Repo Location

The agentbench repo is a sibling of the claudemem repo:
```
../agentbench/
```

All paths below are relative to the agentbench repo root unless noted otherwise.

## Data Layout

```
data/
├── eval-repos/              # 12 cloned repos with pre-built .claudemem/ indexes
│   └── {slug}/.claudemem/   # AST, symbols, vectors, enrichment per repo
├── archives/                # Immutable index snapshots (tar.gz)
│   ├── indexes-20260304-deepseek.tar.gz          # v2 full: 12 repos (1.2GB)
│   └── indexes-20260304-deepseek-11of12.tar.gz   # v2: 11 repos enriched (830MB)
├── eval-cache/              # Runtime sentinel cache
└── eval-generated/          # Generated CLAUDE.md files
```

## Index Specs (v2, 2026-03-04)

- Enrichment model: `deepseek/deepseek-v3.2` via OpenRouter
- Embedding model: `qwen/qwen3-embedding-8b` via OpenRouter
- Total: 12 repos, ~39K symbols, ~36K enrichment docs, ~1.9GB indexes
- Cost: ~$0.25 total via OpenRouter

### Repo Inventory

| Slug | Files | Symbols | Docs | Size |
|------|-------|---------|------|------|
| ansible_ansible | 1758 | 4,597 | 7,214 | 176M |
| getzep_graphiti | 115 | 434 | 635 | 43M |
| huggingface_smolagents | 70 | 475 | 621 | 20M |
| huggingface_transformers | 3082 | 0 | 0 | ~640M |
| jlowin_fastmcp | 417 | 1,914 | 3,348 | 92M |
| openai_openai-agents-python | 477 | 3,504 | 3,620 | 98M |
| opshin_opshin | 125 | 714 | 855 | 24M |
| pdm-project_pdm | 215 | 1,183 | 1,480 | 34M |
| qodo-ai_pr-agent | 114 | 328 | 835 | 21M |
| tinygrad_tinygrad | 884 | 20,018 | 6,345 | 400M |
| vibrantlabsai_ragas | 401 | 1,357 | 2,514 | 57M |
| wagtail_wagtail | 2270 | 4,434 | 8,419 | 261M |

Note: `huggingface_transformers` has 0 symbols/docs (tree-sitter WASM errors on metaprogramming). Vector search still works.

## Experiment Conditions

| Condition | Type | Workers | What it does |
|-----------|------|---------|--------------|
| `no_plan` | Baseline | 2 | Raw Claude Code, no AGENTS.md |
| `claudemem_full` | Per-instance | 2 | claudemem map+search → AGENTS.md per task |
| `dc_planner` | Cross-instance | 1 | Dynamic Cheatsheet — learns across tasks |
| `ace_planner` | Cross-instance | 1 | ACE reflector+curator playbook — learns across tasks |

### Instance Filter (24 instances, 2 per repo)

Hardcoded in `scripts/agentbench/run_harness/run_condition.py`.

## Common Tasks

### Run an Experiment

```bash
cd scripts/agentbench/run_harness
python run_condition.py <condition>
# e.g.: python run_condition.py no_plan
#        python run_condition.py claudemem_full
#        python run_condition.py dc_planner
#        python run_condition.py ace_planner
```

Never pass filter directly in shell — pipe `|` gets escaped by zsh.

### Restore Indexes (New Machine)

```bash
# From the agentbench repo root:
./scripts/agentbench/run_harness/restore_indexes.sh
# or specify archive:
./scripts/agentbench/run_harness/restore_indexes.sh \
  --archive data/archives/indexes-20260304-deepseek.tar.gz
```

### Re-Index a Single Repo

```bash
# Full enrichment (~$0.02/repo)
CLAUDEMEM_LLM=or/deepseek/deepseek-v3.2 claudemem index --force data/eval-repos/{slug}

# Fast index without enrichment (map works, search doesn't)
claudemem index --no-llm data/eval-repos/{slug}
```

### Create Archive Snapshot

```bash
cd data/eval-repos
tar czf ../archives/indexes-$(date +%Y%m%d)-deepseek.tar.gz */.claudemem/
```

### Check Experiment Results

```bash
# Results live at:
ls scripts/agentbench/run_harness/output/agentbench/eth-sri_agentbench/{condition}/

# Evaluate:
cd scripts/agentbench/run_harness
python evaluate.py --condition <condition> --run_id <N>

# Analyze:
python analyze.py
```

### DC/ACE Training Data

- DC cheatsheets: `plans/dynamic_cheatsheet/{model}/cheatsheet_{repo}.txt`
- ACE playbooks: `plans/ace_playbook/{model}/playbook_{repo}.json`
- History: `*_history/` subdirectories track evolution across instances

## Key Gotchas

1. **Always use `run_condition.py`** — shell escaping of `|` in filters breaks otherwise
2. **DC/ACE are sequential** (workers=1) — they learn across instances, can't parallelize
3. **Index cache is 3-level**: in-process set → `index.db` file → sentinel in `data/eval-cache/`
4. **Model keys are short names**: `sonnet-4-5` not `claude-sonnet-4-5-20250929`
5. **`generate.py` uses `fire.Fire(main)`** — both positional and `--flag=val` args work
6. **`--no-llm` indexes**: only give `map` (PageRank symbols). Full enrichment enables semantic `search`
7. **All paths are repo-relative** — no `~/.claudemem/` dependencies
8. **Enrichment model**: deepseek/deepseek-v3.2 was selected from 76 benchmark runs (composite score 0.886)

## Architecture (Key Files)

| File | Purpose |
|------|---------|
| `src/agentbench/planners/claudemem_planner.py` | ClaudememPlanner — indexes repo, generates AGENTS.md |
| `src/agentbench/planners/ace/ace.py` | ACE planner — reflector+curator playbook |
| `src/agentbench/planners/evo_reproducer/evo_reproducer.py` | DC/EvoReproducer planner — dynamic cheatsheet |
| `scripts/agentbench/run_harness/generate.py` | Main harness entry point |
| `scripts/agentbench/run_harness/run_condition.py` | Launch helper (handles filter escaping) |
| `scripts/agentbench/run_harness/restore_indexes.sh` | Archive restore script |
| `scripts/agentbench/run_harness/evaluate.py` | Result evaluator |
| `scripts/agentbench/run_harness/analyze.py` | Cross-condition analyzer |
