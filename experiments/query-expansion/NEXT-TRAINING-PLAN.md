# Next SFT Training Plan — Query Expansion Models (Round 2)

*Created: 2026-03-04*

## Context

Round 1 fine-tuning proved massive gains from SFT on models with poor format compliance:
- Qwen3-1.7B: 0.230 → 0.777 (3.4x gain)
- Qwen3-4B: 0.278 → 0.726 (2.6x gain)

Key insight: **SFT teaches FORMAT, not domain knowledge.** Models with strong code pretraining but broken format compliance benefit most.

## Training Queue (Priority Order)

### 1. Qwen3.5-9B — Highest Priority
- **Base**: `Qwen/Qwen3.5-9B`
- **Base benchmark score**: 0.011 (completely failed format)
- **Architecture**: Gated Delta Network + MoE (new, released Mar 2, 2026)
- **LoRA targets**: `q_proj, k_proj, v_proj, o_proj, gate_proj, up_proj, down_proj` (same as Qwen3)
- **Training**: `a10g-large`, QLoRA 4-bit, ~$12
- **Expected gain**: 0.011 → 0.8+ (massive upside)
- **License**: Apache 2.0

### 2. Qwen3.5-4B
- **Base**: `Qwen/Qwen3.5-4B`
- **Base benchmark score**: 0.016 (completely failed format)
- **Training**: `a10g-large`, QLoRA 4-bit, ~$6
- **Expected gain**: 0.016 → 0.8+ (massive upside)
- **License**: Apache 2.0

### 3. MiMo-7B — Dark Horse
- **Base**: `XiaomiMiMo/MiMo-7B-SFT` (or `MiMo-7B-Base`)
- **Base benchmark score**: untested
- **Architecture**: Purpose-built for code reasoning, matches o1-mini on LiveCodeBench
- **Training**: `a10g-large`, QLoRA 4-bit, ~$10
- **License**: Apache 2.0
- **Note**: Need to verify chat template and LoRA target modules

### 4. Phi-4-mini (3.8B)
- **Base**: `microsoft/Phi-4-mini-instruct`
- **Base benchmark score**: untested
- **Architecture**: Microsoft reasoning model, strong coding, 128K context
- **Training**: `a10g-large`, QLoRA 4-bit, ~$5
- **License**: MIT
- **Note**: Different chat template, no `/no_think` — needs prompt engineering

### 5. Qwen3.5-2B
- **Base**: `Qwen/Qwen3.5-2B`
- **Base benchmark score**: 0.712 (already decent — smaller expected gain)
- **Training**: `a10g-large`, fp16 LoRA, ~$4
- **License**: Apache 2.0

### 6. Qwen3-14B — Quality Ceiling
- **Base**: `Qwen/Qwen3-14B`
- **Base benchmark score**: untested (expect ~0.2 like other Qwen3 due to `<think>`)
- **Training**: `a100-large` (needs >24GB VRAM), ~$20
- **License**: Apache 2.0
- **Note**: Cannot fit on single A10G for training; deploys fine on 64GB Mac

## Implementation Notes

### sft.py Changes Needed
1. Add new model configs to `MODELS` dict
2. For Qwen3.5: verify `load_in_4bit=True` works (new architecture)
3. For MiMo-7B: investigate chat template format
4. For Phi-4-mini: different chat template, test tokenizer compatibility
5. For Qwen3-14B: need `a100-large` flavor instead of `a10g-large`

### Pre-Training Checklist
- [ ] Run base benchmark for untested models (MiMo-7B, Phi-4-mini, Qwen3-14B)
- [ ] Verify Qwen3.5 LoRA compatibility with PEFT (new architecture)
- [ ] Test chat template for MiMo-7B and Phi-4-mini
- [ ] Estimate total HF Jobs cost (~$57 for all 6)

### HF Jobs Commands (when ready)
```bash
# Priority 1: Qwen3.5-9B
hf jobs uv run --flavor a10g-large --secrets HF_TOKEN --timeout 3h \
    experiments/query-expansion/training/jobs/sft.py --model qwen3.5-9b

# Priority 2: Qwen3.5-4B
hf jobs uv run --flavor a10g-large --secrets HF_TOKEN --timeout 2h \
    experiments/query-expansion/training/jobs/sft.py --model qwen3.5-4b

# Priority 3: MiMo-7B
hf jobs uv run --flavor a10g-large --secrets HF_TOKEN --timeout 3h \
    experiments/query-expansion/training/jobs/sft.py --model mimo-7b

# Priority 4: Phi-4-mini
hf jobs uv run --flavor a10g-large --secrets HF_TOKEN --timeout 2h \
    experiments/query-expansion/training/jobs/sft.py --model phi4-mini

# Priority 5: Qwen3.5-2B
hf jobs uv run --flavor a10g-large --secrets HF_TOKEN --timeout 2h \
    experiments/query-expansion/training/jobs/sft.py --model qwen3.5-2b

# Priority 6: Qwen3-14B
hf jobs uv run --flavor a100-large --secrets HF_TOKEN --timeout 4h \
    experiments/query-expansion/training/jobs/sft.py --model qwen3-14b
```

## Current Results (Round 1)

| Model | Params | Base | FT | Gain |
|-------|--------|------|-----|------|
| Qwen3-1.7B | 1.7B | 0.230 | **0.777** | 3.4x |
| Qwen3-4B | 4B | 0.278 | **0.726** | 2.6x |
| LFM2-1.2B | 1.2B | 0.728 | 0.698 | -4% |
| LFM2-700M | 0.7B | 0.708 | 0.658 | -7% |

Top base models for reference: LFM2-2.6B (0.816), Qwen3-4B-2507 (0.811)
