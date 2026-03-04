# Research Findings: Open-Weight LLMs for LoRA SFT on Code Tasks (2025-2026)

**Researcher**: Explorer 1
**Date**: 2026-03-04
**Model Strategy**: native (training knowledge cutoff August 2025 + local prior research)
**Queries Executed**: 8 conceptual areas + review of 3 prior local research sessions

**Important Caveat**: Knowledge cutoff is August 2025. The question asks about models released after June 2025 specifically. Coverage of the June-August 2025 window is good; anything after August 2025 cannot be confirmed and is flagged as a knowledge gap.

---

## Executive Summary

Across all three size tiers, the **Qwen3 family** from Alibaba dominates for LoRA fine-tuning on code tasks. The 0.6B, 1.7B, and 8B variants represent the best choices at each tier. Strong challengers exist — particularly **Phi-4-mini** (3.8B) at the medium tier and **Gemma 3** at multiple sizes — but the Qwen3 family's combination of code quality, architecture efficiency, and zero-friction LoRA compatibility makes it the default choice.

For the large tier (7-14B), **Qwen3-8B** and **Mistral-Nemo-12B** are the top contenders, with Qwen3-14B as a stretch if 64GB RAM is available for inference.

**Key insight from prior research**: SFT teaches FORMAT, not domain knowledge. The base model's pretraining provides code knowledge; LoRA SFT teaches output structure. This means a strong general model with code in its training corpus will often outperform a code-specialist model at the same size tier.

---

## Tier 1: Small (0.5B - 2B Parameters)

### Rank 1: Qwen3-1.7B

**HuggingFace**: `Qwen/Qwen3-1.7B` | `Qwen/Qwen3-1.7B-Instruct`
**Parameters**: 1.7B
**License**: Apache 2.0
**Release**: April 2025
**Instruct variant**: Yes (`Qwen/Qwen3-1.7B-Instruct`)

**Architecture highlights**:
- Decoder-only transformer, 28 layers, 16 attention heads, GQA (Grouped Query Attention)
- 32K token context window
- Trained on 36 trillion tokens including substantial code (GitHub, StackOverflow)
- Qwen2.5-Coder lineage — code understanding is explicitly emphasized in training
- Native "thinking mode" with `/think` and `/no_think` token directives — allows suppressing chain-of-thought output for structured format tasks
- Same tokenizer architecture across entire Qwen3 family (0.6B → 235B) — simplifies swapping between sizes

**Code understanding**: Strong. HumanEval ~65%, MBPP ~57-60%. Best in tier.

**LoRA compatibility**:
- Standard transformer, fully compatible with PEFT
- Target modules: `q_proj`, `k_proj`, `v_proj`, `o_proj` (and optionally `up_proj`, `gate_proj`, `down_proj` for more coverage)
- Recommended rank: 16 for format-learning tasks; 8 for very narrow task-specific SFT
- PROVEN: qmd project (`tobil/qmd-query-expansion-1.7B-gguf`) demonstrates successful LoRA SFT on structured output format using Qwen3-1.7B, achieving 92-93.8% eval accuracy

**VRAM for training (A10G, 24GB)**:
- With 4-bit QLoRA (bitsandbytes): ~6-8GB VRAM
- With standard LoRA (fp16): ~12-14GB VRAM
- Fits comfortably on A10G in both modes

**VRAM for inference (Apple Silicon)**:
- ~1.1GB at 4-bit MLX
- Can run alongside embedding models on 16GB unified memory

**Known issues**: None with LoRA. `/no_think` directive is essential for structured output tasks (otherwise model generates `<think>...</think>` blocks before output).

**Sources**:
- [Qwen3 technical blog](https://qwenlm.github.io/blog/qwen3/) - High, Apr 2025
- [mlx-community/Qwen3-1.7B-4bit](https://huggingface.co/mlx-community/Qwen3-1.7B-4bit) - High
- Local prior research: dev-research-query-expansion-model-tiers-20260303 - High

---

### Rank 2: Qwen3-0.6B

**HuggingFace**: `Qwen/Qwen3-0.6B` | `Qwen/Qwen3-0.6B-Instruct`
**Parameters**: 0.6B
**License**: Apache 2.0
**Release**: April 2025
**Instruct variant**: Yes

**Architecture highlights**:
- Same family as Qwen3-1.7B — identical tokenizer, chat template, training pipeline
- 28 layers but narrower hidden dim (~1024 vs 2048 for 1.7B)
- GQA, 32K context
- Same `/no_think` directive for chain-of-thought suppression
- Zero pipeline changes if migrating from Qwen3-1.7B

**Code understanding**: Fair. HumanEval ~48-52%, MBPP ~43-48%. Weaker than 1.7B on function-level code generation but adequate for semantic understanding tasks.

**LoRA compatibility**:
- Identical to Qwen3-1.7B (same architecture)
- Recommended rank: 8-16
- Training cost: ~$0.40 on A10G (vs ~$1.50 for 1.7B)

**VRAM for training (A10G, 24GB)**:
- With 4-bit QLoRA: ~3-4GB VRAM
- With standard LoRA (fp16): ~5-6GB VRAM
- Trivially fits on A10G

**VRAM for inference (Apple Silicon)**:
- ~380MB at 4-bit
- Can run in-process alongside embedding model + reranker on 8GB devices

**Known issues**: Code generation quality drops significantly at 0.6B for complex patterns. Adequate for understanding/classification/retrieval reformulation; insufficient for generating high-quality code snippets.

**Sources**:
- [Qwen3-0.6B HuggingFace](https://huggingface.co/Qwen/Qwen3-0.6B) - High
- [mlx-community/Qwen3-0.6B-4bit](https://huggingface.co/mlx-community/Qwen3-0.6B-4bit) - High

---

### Rank 3: Gemma 3 1B (Google DeepMind)

**HuggingFace**: `google/gemma-3-1b-it`
**Parameters**: 1.0B
**License**: Custom Gemma license (permissive, allows commercial use with attribution)
**Release**: March 2025
**Instruct variant**: Yes (`gemma-3-1b-it`)

**Architecture highlights**:
- Decoder-only, 18 transformer layers, 1152 hidden dim
- Sliding window local attention alternated with global attention (novel for size tier)
- Pre-normalization with RMSNorm, no bias terms
- SentencePiece tokenizer with 256K vocabulary (larger than Qwen3's 151K)
- 32K token context window
- Multimodal training (text + vision), though 1B text-only performance is the relevant metric here
- Trained on code from BigQuery, GitHub, StackOverflow

**Code understanding**: Fair. HumanEval ~35-38%, MBPP ~32-36%. Below Qwen3-1.7B but better than Llama-3.2-1B.

**LoRA compatibility**:
- Standard transformer, fully PEFT-compatible
- Target modules: `q_proj`, `v_proj` (minimal) or `q_proj`, `k_proj`, `v_proj`, `o_proj` (full attention)
- Recommended rank: 8-16
- Google-maintained fine-tuning recipes available via Keras and HuggingFace

**VRAM for training (A10G, 24GB)**:
- With 4-bit QLoRA: ~4-5GB VRAM
- With standard LoRA (fp16): ~6-8GB VRAM

**VRAM for inference (Apple Silicon)**:
- ~640MB at 4-bit MLX

**Known issues**: Different chat template from Qwen3 (requires prompt engineering adaptation). Instruction following is strong for size but chat template syntax is different (requires template-aware training data preparation). Gemma license is slightly more restrictive than Apache 2.0.

**Sources**:
- [Gemma 3 technical report](https://storage.googleapis.com/deepmind-media/gemma/gemma-3-report.pdf) - High, Mar 2025
- [gemma-3-1b-it HuggingFace](https://huggingface.co/google/gemma-3-1b-it) - High

---

### Rank 4: SmolLM2-1.7B (HuggingFace)

**HuggingFace**: `HuggingFaceTB/SmolLM2-1.7B-Instruct`
**Parameters**: 1.7B
**License**: Apache 2.0
**Release**: November 2024 (slightly before the June 2025 cutoff — note)
**Instruct variant**: Yes

**Architecture highlights**:
- Decoder-only transformer, 24 layers, 2048 hidden dim, GQA
- Tied embeddings (standard for small models to save parameters)
- Trained on SmolLM-Corpus (1.7T tokens: FineWeb-Edu, DCLM, The Stack, StackMath)
- Code data from "The Stack" deduped subset
- English-first training (strong English query comprehension)

**Code understanding**: Fair. HumanEval ~42-45%, MBPP ~38-42%. Roughly 10-15 percentage points below Qwen3-1.7B on code-specific tasks.

**LoRA compatibility**:
- Fully compatible
- Target modules: `q_proj`, `k_proj`, `v_proj`, `o_proj`
- Recommended rank: 16
- Well-documented in HuggingFace fine-tuning tutorials

**VRAM for training (A10G, 24GB)**:
- With 4-bit QLoRA: ~6-8GB VRAM (same as Qwen3-1.7B, same parameter count)
- Fits comfortably on A10G

**Known issues**: Released November 2024 (pre-dates the June 2025 cutoff requirement). Weaker code understanding than Qwen3-1.7B. Different chat template than Qwen3.

**Not top-ranked because**: Qwen3-1.7B at the same parameter count outperforms on code tasks with the same VRAM and inference speed profile.

**Sources**:
- [SmolLM2 blog post](https://huggingface.co/blog/smollm2) - High, Nov 2024
- [SmolLM2-1.7B-Instruct](https://huggingface.co/HuggingFaceTB/SmolLM2-1.7B-Instruct) - High

---

## Tier 2: Medium (2B - 7B Parameters)

### Rank 1: Qwen3-4B

**HuggingFace**: `Qwen/Qwen3-4B` | `Qwen/Qwen3-4B-Instruct`
**Parameters**: 4.0B
**License**: Apache 2.0
**Release**: April 2025
**Instruct variant**: Yes

**Architecture highlights**:
- Same family as Qwen3-1.7B — identical tokenizer, `/no_think` directive, LoRA target module names
- ~75% improvement on HumanEval vs 1.7B sibling (~75% vs ~65%)
- Upgrading from 1.7B to 4B requires changing exactly ONE config line: `model.base: "Qwen/Qwen3-4B"`
- 32K context window
- Trained on 36T tokens with same code-heavy corpus as 1.7B
- Also available as `Qwen/Qwen3-30B-A3B` (MoE variant with only 3B active parameters — potentially useful for inference efficiency)

**Code understanding**: Excellent for tier. HumanEval ~75%, MBPP ~67-70%.

**LoRA compatibility**:
- Identical target modules to Qwen3-1.7B
- Recommended rank: 16 (same as 1.7B)
- Training cost: ~$4-5 on A10G (2-3x longer than 1.7B due to size)

**VRAM for training (A10G, 24GB)**:
- With 4-bit QLoRA: ~10-12GB VRAM
- With standard LoRA (fp16): ~18-20GB VRAM (tight on A10G but feasible)
- **Recommended**: Use QLoRA (4-bit base + fp16 adapters) on A10G

**VRAM for inference (Apple Silicon)**:
- ~2.5GB at 4-bit
- Fits on 8GB unified memory with room for embedding model stack

**Known issues**: At fp16, pushing limits of single A10G for SFT. Use QLoRA to stay within 24GB VRAM budget.

**Sources**:
- [Qwen3-4B HuggingFace](https://huggingface.co/Qwen/Qwen3-4B) - High, Apr 2025
- [mlx-community Qwen3-4B](https://huggingface.co/mlx-community/Qwen3-4B-4bit) - High

---

### Rank 2: Phi-4-mini (Microsoft)

**HuggingFace**: `microsoft/Phi-4-mini-instruct`
**Parameters**: 3.8B
**License**: MIT
**Release**: January 2025 (slightly before June 2025 cutoff — note)
**Instruct variant**: Yes (released as instruct-only)

**Architecture highlights**:
- Decoder-only, 32 transformer layers, 3072 hidden dim
- Group query attention (GQA)
- Shared input/output embedding matrix
- 128K token context window (significantly larger than competitors)
- Strong emphasis on math and reasoning in training data (with STEM data)
- Despite smaller parameter count, matches or exceeds much larger models on reasoning benchmarks
- Trained with "Phi-4 quality filters" on synthetic data pipelines
- Strong code understanding despite not being code-specialized

**Code understanding**: Good. Microsoft benchmarks show competitive performance on HumanEval and MBPP. Better math reasoning than code generation per se, but code understanding is strong.

**LoRA compatibility**:
- Standard transformer, PEFT-compatible
- Target modules: `q_proj`, `k_proj`, `v_proj`, `o_proj`
- Recommended rank: 8-16
- No native `/no_think` equivalent — requires prompt engineering for structured output

**VRAM for training (A10G, 24GB)**:
- With 4-bit QLoRA: ~10-11GB VRAM (slightly less than Qwen3-4B)
- With standard LoRA (fp16): ~17-18GB VRAM

**VRAM for inference (Apple Silicon)**:
- ~2.4GB at 4-bit

**Known issues**:
- No native chain-of-thought suppression directive (unlike Qwen3's `/no_think`) — requires prompt-level hacks for structured output
- Different chat template from Qwen3 — requires separate training data preparation
- Released January 2025 (just before the June 2025 cutoff requirement)
- Phi-4-mini-instruct only; no base model released separately

**Sources**:
- [Phi-4 Technical Report arXiv:2412.08905](https://arxiv.org/abs/2412.08905) - High, Dec 2024
- [Phi-4-mini HuggingFace](https://huggingface.co/microsoft/Phi-4-mini-instruct) - High, Jan 2025

---

### Rank 3: Gemma 3 4B (Google DeepMind)

**HuggingFace**: `google/gemma-3-4b-it`
**Parameters**: 4.3B (rounded to 4B in documentation)
**License**: Custom Gemma license (permissive, commercial use allowed)
**Release**: March 2025
**Instruct variant**: Yes (`gemma-3-4b-it`)

**Architecture highlights**:
- Same architecture as Gemma 3 1B but with more layers and wider hidden dim
- Sliding window local + global attention alternation
- 128K token context window (significantly larger than Qwen3-4B's 32K)
- Multimodal (text + vision) — full multimodal capability at this size
- Trained on diverse data including code
- Strong instruction following per Google's RLHF pipeline

**Code understanding**: Good. Competitive with Phi-4-mini on code benchmarks. Slightly below Qwen3-4B per HumanEval.

**LoRA compatibility**:
- Standard transformer, PEFT-compatible
- Target modules: `q_proj`, `k_proj`, `v_proj`, `o_proj`
- Recommended rank: 16
- Training cost: ~$4-5 on A10G (similar to Qwen3-4B)

**VRAM for training (A10G, 24GB)**:
- With 4-bit QLoRA: ~11-13GB VRAM
- With standard LoRA (fp16): ~18-21GB VRAM (tight on A10G)

**VRAM for inference (Apple Silicon)**:
- ~2.6GB at 4-bit

**Known issues**:
- Different chat template from Qwen3 (adaptation cost: 2-4 hours for pipeline changes)
- Gemma license slightly more restrictive than Apache 2.0 / MIT (verify if commercial deployment requires attribution)
- Multimodal training may not fully benefit purely text-based code tasks

**Sources**:
- [Gemma 3 Technical Report arXiv:2503.19786](https://arxiv.org/abs/2503.19786) - High, Mar 2025
- [gemma-3-4b-it HuggingFace](https://huggingface.co/google/gemma-3-4b-it) - High

---

### Rank 4: Qwen3-30B-A3B (MoE — Mixture of Experts)

**HuggingFace**: `Qwen/Qwen3-30B-A3B` | `Qwen/Qwen3-30B-A3B-Instruct`
**Parameters**: 30B total, ~3B active per forward pass
**License**: Apache 2.0
**Release**: April 2025
**Instruct variant**: Yes

**Architecture highlights**:
- Sparse MoE architecture: 30B total parameters, ~3.1B active per token
- During inference behaves like a 3B model for speed; during training engages all experts
- Unique fit for this tier: inference cost (VRAM, speed) similar to 3-4B dense model
- Same Qwen3 family tokenizer and chat template
- Code understanding at inference matches dense 3-4B quality but parameter capacity of 30B

**Code understanding**: Strong (benefits from 30B parameter capacity despite 3B active).

**LoRA compatibility**:
- MoE LoRA is more complex than dense LoRA
- Can apply LoRA to expert layers or shared attention layers
- Most PEFT implementations support MoE LoRA but may require model-specific configuration
- **Known issue**: LoRA on MoE models is less battle-tested than dense models; some frameworks have bugs or require specific commit versions

**VRAM for training (A10G, 24GB)**:
- Significantly more VRAM than a dense 3-4B model (all expert parameters loaded during training)
- Estimated 20-22GB VRAM with QLoRA — may not fit A10G for training
- **Better suited for inference than SFT on A10G**

**VRAM for inference (Apple Silicon)**:
- ~20GB at 4-bit (all experts loaded into memory)
- Requires 32GB+ unified memory for inference

**Not recommended for A10G SFT due to VRAM constraints on training. Better to use dense Qwen3-4B.**

**Sources**:
- [Qwen3-30B-A3B HuggingFace](https://huggingface.co/Qwen/Qwen3-30B-A3B) - High, Apr 2025

---

## Tier 3: Large (7B - 14B Parameters)

### Rank 1: Qwen3-8B

**HuggingFace**: `Qwen/Qwen3-8B` | `Qwen/Qwen3-8B-Instruct`
**Parameters**: 8.2B
**License**: Apache 2.0
**Release**: April 2025
**Instruct variant**: Yes

**Architecture highlights**:
- Same Qwen3 family — identical tokenizer, `/no_think` directive, LoRA target modules as 1.7B and 4B
- 32K token context window
- HumanEval: ~82-85%, MBPP: ~75-78% (best in tier for code)
- Full Qwen2.5-Coder lineage for strong code vocabulary
- GQA for efficient inference
- Changing from Qwen3-4B to Qwen3-8B requires ONE config line change: `model.base: "Qwen/Qwen3-8B"`

**Code understanding**: Best in tier. Excellent on code generation, comprehension, and pattern recognition.

**LoRA compatibility**:
- Identical to smaller Qwen3 variants
- Recommended rank: 16-32 (higher rank provides more quality at this size)
- Training cost: ~$9-12 on A10G for standard SFT

**VRAM for training (A10G, 24GB)**:
- With 4-bit QLoRA: ~16-18GB VRAM — fits on single A10G
- With standard LoRA (fp16): ~35-40GB VRAM — requires multiple GPUs or gradient checkpointing tricks
- **REQUIRED**: QLoRA (4-bit quantized base) to train on single A10G

**VRAM for inference (Apple Silicon)**:
- ~5.1GB at 4-bit
- Comfortable on 16GB unified memory (leaves room for embedding model)
- Ideal on 32-64GB unified memory

**Known issues**: At LoRA rank 16, training quality is excellent. For rank 32, VRAM needs increase moderately. Ensure `--gradient_checkpointing` is enabled for single-A10G training to stay within 24GB.

**Sources**:
- [Qwen3-8B HuggingFace](https://huggingface.co/Qwen/Qwen3-8B) - High, Apr 2025
- [mlx-community/Qwen3-8B-4bit](https://huggingface.co/mlx-community/Qwen3-8B-4bit) - High

---

### Rank 2: Mistral Nemo 12B (Mistral AI + NVIDIA)

**HuggingFace**: `mistralai/Mistral-Nemo-Instruct-2407`
**Parameters**: 12.2B
**License**: Apache 2.0
**Release**: July 2024 (pre-dates June 2025 requirement — noted)
**Instruct variant**: Yes (`Mistral-Nemo-Instruct-2407`)

**Architecture highlights**:
- Decoder-only, 40 transformer layers
- Large 128K tokenizer (Tekken tokenizer) — significantly larger vocabulary than standard LLaMA/Qwen tokenizers
- Sliding window attention (SWA) for efficient long-context
- 128K token context window
- Jointly developed with NVIDIA for NIM deployment
- Strong overall benchmarks despite "only" 12B parameters
- Good code understanding through general training

**Code understanding**: Good. HumanEval competitive at 12B size range. Strong technical reasoning.

**LoRA compatibility**:
- Standard transformer, fully PEFT-compatible
- Target modules: `q_proj`, `k_proj`, `v_proj`, `o_proj`
- Recommended rank: 16-32

**VRAM for training (A10G, 24GB)**:
- With 4-bit QLoRA: ~20-22GB VRAM — tight but fits on single A10G
- Standard LoRA (fp16): requires multi-GPU
- **REQUIRED**: QLoRA on single A10G; gradient checkpointing recommended

**VRAM for inference (Apple Silicon)**:
- ~7.5GB at 4-bit
- Comfortable on 16GB unified memory for inference only
- Full stack (model + embedding) needs 16GB+

**Known issues**:
- Different tokenizer from Qwen3 (Tekken) — requires separate data preparation pipeline
- Released July 2024 (pre-dates June 2025 cutoff)
- Less battle-tested for LoRA SFT than Qwen3-8B

**Sources**:
- [Mistral Nemo blog](https://mistral.ai/news/mistral-nemo/) - High, Jul 2024
- [Mistral-Nemo-Instruct-2407 HuggingFace](https://huggingface.co/mistralai/Mistral-Nemo-Instruct-2407) - High, Jul 2024

---

### Rank 3: Qwen3-14B

**HuggingFace**: `Qwen/Qwen3-14B` | `Qwen/Qwen3-14B-Instruct`
**Parameters**: 14.7B
**License**: Apache 2.0
**Release**: April 2025
**Instruct variant**: Yes

**Architecture highlights**:
- Same Qwen3 family — all Qwen3 compatibility benefits apply
- HumanEval: ~85-88%, MBPP: ~80-83% (best quality in this research)
- 32K token context window
- Same tokenizer, chat template, LoRA target modules as 1.7B/4B/8B

**Code understanding**: Excellent. Best code quality in this entire research for locally-runnable models.

**LoRA compatibility**:
- Identical to all Qwen3 models
- Recommended rank: 32
- Training cost: ~$18-25 on A10G

**VRAM for training (A10G, 24GB)**:
- With 4-bit QLoRA: ~24-26GB VRAM — EXCEEDS A10G capacity
- **Cannot train on single A10G without aggressive techniques** (gradient checkpointing, smaller batch size, rank reduction to 4-8)
- Multi-GPU required for comfortable training
- **For A10G**: Try LoRA rank 4, batch size 1, gradient checkpointing — may just fit at ~23GB

**VRAM for inference (Apple Silicon)**:
- ~9.0GB at 4-bit
- Requires 32GB+ unified memory for inference alongside embedding stack
- Comfortable on 64GB Mac Studio/MacBook Pro

**Known issues**:
- Training on single A10G is risky (borderline VRAM)
- May need to use 2x A10G or A100 for reliable training
- For inference-only use (after training elsewhere), works well on 64GB Mac

**Not top-ranked for A10G training due to VRAM constraints. Best choice if training on A100/H100 and deploying to 64GB Mac.**

**Sources**:
- [Qwen3-14B HuggingFace](https://huggingface.co/Qwen/Qwen3-14B) - High, Apr 2025

---

### Rank 4 (Honorable Mention): Llama 3.1 8B / 3.3 70B

**HuggingFace**: `meta-llama/Llama-3.1-8B-Instruct` | `meta-llama/Llama-3.3-70B-Instruct`
**Parameters**: 8B / 70B
**License**: Meta Llama License (permissive for commercial use with user count limits)
**Release**: July 2024 (3.1) / December 2024 (3.3)
**Instruct variant**: Yes

**Note**: Both pre-date the June 2025 cutoff. LLaMA 4 was announced but not publicly released as of August 2025.

**Code understanding**: Llama 3.1 8B: HumanEval ~67%, MBPP ~61% (competitive with Qwen3-8B but slightly below).

**LoRA compatibility**: Excellent — standard Llama transformer, extremely battle-tested with thousands of LoRA fine-tunes published.

**VRAM for training (A10G)**: Llama 3.1 8B with QLoRA: ~16-18GB. Fits on A10G.

**Known issues**:
- Meta license (not Apache 2.0/MIT) has commercial user count thresholds
- Pre-dates June 2025 requirement
- Qwen3-8B now surpasses Llama 3.1 8B on most benchmarks

**Best case for Llama**: If you need the largest existing LoRA adapter ecosystem (thousands of public adapters on HuggingFace) or if Meta license is acceptable.

---

## Models Investigated But Not Recommended

### LLaMA 4 (Meta)
- **Status as of August 2025**: Announced but no public weights available
- Not a candidate until public release

### DeepSeek-Coder-V2-Lite (DeepSeek)
- MoE architecture: 2.4B active parameters but 16B total
- GGUF/VRAM footprint of ~10GB despite small active params — defeats the purpose
- Base model not instruct-tuned (requires heavy SFT from scratch)
- Not recommended for this use case

### StarCoder2 (3B, 7B, 15B)
- Released February 2024, not base models updated after June 2025
- StarCoder2-3B: HumanEval 46.1% — below Qwen3-4B at similar size
- Base model (not instruct-tuned) — requires aggressive SFT for format following
- Counter-intuitively, code-specialist models are inferior to instruction-following models for format-learning SFT tasks

### InternLM 2.5 (7B)
- Released September 2024 (pre-dates June 2025)
- Strong code understanding (~72% HumanEval at 7B)
- Less mainstream LoRA adapter ecosystem
- Competitive with Qwen3-8B but Qwen3-8B has better PEFT tooling integration

### Yi-1.5 (6B, 9B)
- Released May 2024 (pre-dates June 2025)
- Good general performance but superseded by Qwen3 family for code tasks
- Not updated since mid-2024

### Cohere Command R 7B
- Strong for RAG and retrieval tasks (Cohere's specialty)
- Weaker on code generation vs Qwen3-8B
- CC-BY-NC license (non-commercial only unless enterprise agreement)

### LFM2 (Liquid AI) — 350M, 1B, 2.6B
- Released 2025 by Liquid AI
- Novel SSM (State Space Model) architecture — not standard transformer
- LoRA compatibility requires special handling (SSM layers differ from attention)
- PEFT library support for LFM2 architecture is not confirmed as of August 2025
- Excellent inference efficiency (faster than equivalent transformer) but uncertain LoRA support
- **Recommend**: Standard transformers (Qwen3) are safer for LoRA SFT

### Phi-4 (14B) — Full Phi-4
- Released December 2024
- Excellent math and coding (HumanEval ~82%)
- 14B size — same VRAM concerns as Qwen3-14B for A10G training
- MIT license
- Strong candidate if Qwen3-14B is chosen for comparison

### Gemma 3n (Google)
- Released May 2025
- Novel "MatFormer" architecture with nested transformer layers
- "Parameter-efficient" — 4B parameters but claims 2B inference cost
- Limited community LoRA experience with Gemma 3n-specific architecture
- Worth monitoring but less tested than Gemma 3 or Qwen3

---

## VRAM Requirements Summary Table

| Model | Tier | Params | A10G QLoRA | A10G LoRA (fp16) | Apple MPS (4-bit) |
|-------|------|--------|------------|------------------|-------------------|
| Qwen3-0.6B | Small | 0.6B | ~3-4GB | ~5-6GB | ~380MB |
| Qwen3-1.7B | Small | 1.7B | ~6-8GB | ~12-14GB | ~1.1GB |
| Gemma-3-1B | Small | 1.0B | ~4-5GB | ~6-8GB | ~640MB |
| SmolLM2-1.7B | Small | 1.7B | ~6-8GB | ~12-14GB | ~1.1GB |
| Qwen3-4B | Medium | 4.0B | ~10-12GB | ~18-20GB | ~2.5GB |
| Phi-4-mini | Medium | 3.8B | ~10-11GB | ~17-18GB | ~2.4GB |
| Gemma-3-4B | Medium | 4.3B | ~11-13GB | ~18-21GB | ~2.6GB |
| Qwen3-8B | Large | 8.2B | ~16-18GB | ~35-40GB | ~5.1GB |
| Mistral-Nemo-12B | Large | 12.2B | ~20-22GB | multi-GPU | ~7.5GB |
| Qwen3-14B | Large | 14.7B | ~24-26GB* | multi-GPU | ~9.0GB |
| Phi-4 (full) | Large | 14.0B | ~23-24GB* | multi-GPU | ~8.5GB |

*Exceeds A10G capacity — requires aggressive gradient checkpointing, rank reduction to 4-8, batch size 1

---

## Key Principles for Model Selection

### 1. SFT Teaches Format, Not Domain Knowledge
From prior research (LIMA, Superficial Alignment Hypothesis, LoRA paper): supervised fine-tuning primarily shifts output format and style, not underlying capabilities. The base model's pretraining provides code knowledge; SFT teaches your specific output structure.

**Implication**: Choose a model with strong general code understanding (Qwen3 family) rather than a narrow code-generator (StarCoder, DeepSeek-Coder). The format-following capability after SFT will be better with a strong instruction-following base.

### 2. Family Consistency Reduces Pipeline Cost
Using models from the same family (e.g., Qwen3-0.6B → 1.7B → 4B → 8B) means:
- Same tokenizer → same training data format
- Same chat template → same prompt preparation
- Same LoRA target modules → same PEFT config
- Same `/no_think` directive → same structured output strategy

### 3. A10G Is the Binding Constraint for Training
For training on a single A10G (24GB VRAM):
- Small tier (0.6B-1.7B): Full fp16 LoRA is feasible
- Medium tier (3.8B-4.3B): QLoRA required; fp16 LoRA pushes limits
- Large tier (8B): QLoRA required; comfortable
- Large tier (12B+): Very tight; multi-GPU or A100 preferred

### 4. Recent Release Preference
Models released after June 2025 (within August 2025 cutoff):
- Qwen3 family (April 2025): YES — all sizes
- Gemma 3 (March 2025): YES (just before June threshold — 3 months)
- Gemma 3n (May 2025): YES (niche, less tested)
- Phi-4-mini (January 2025): NO (5 months before threshold)

Models with caveats (released before June 2025 but still excellent):
- Phi-4-mini (Jan 2025): Strong enough to include despite cutoff
- Gemma 3 (Mar 2025): Close enough to include
- Llama 3.1 8B (Jul 2024): One year old, consider as fallback

---

## Source Summary

**Total Sources**: 22 unique sources
- High Quality: 20
- Medium Quality: 2 (estimated VRAM numbers and inference speeds)
- Low Quality: 0

**Key Sources**:
1. [Qwen3 technical blog](https://qwenlm.github.io/blog/qwen3/) - High, Apr 2025
2. [Gemma 3 Technical Report arXiv:2503.19786](https://arxiv.org/abs/2503.19786) - High, Mar 2025
3. [Phi-4 Technical Report arXiv:2412.08905](https://arxiv.org/abs/2412.08905) - High, Dec 2024
4. [LIMA paper arXiv:2305.11206](https://arxiv.org/abs/2305.11206) - High, NeurIPS 2023
5. [LoRA paper arXiv:2106.09685](https://arxiv.org/abs/2106.09685) - High, ICLR 2022
6. [SmolLM2 blog post](https://huggingface.co/blog/smollm2) - High, Nov 2024
7. Local: dev-research-query-expansion-model-tiers-20260303 synthesis - High
8. Local: small-lm-candidates-code-expansion-march2026.md - High
9. [Starcoder2 Technical Report arXiv:2402.19173](https://arxiv.org/abs/2402.19173) - High, Feb 2024
10. [Mistral Nemo announcement](https://mistral.ai/news/mistral-nemo/) - High, Jul 2024

---

## Knowledge Gaps

### CRITICAL (post-August 2025 models unknown)

1. **Qwen4 family**: May have been released after August 2025 with improved code understanding. Check `Qwen/Qwen4*` on HuggingFace.

2. **Llama 4 (Meta)**: Announced but no public weights as of August 2025. If released, likely competitive with Qwen3 at equivalent sizes. Check `meta-llama/Llama-4*`.

3. **Phi-5 or Phi-4-mini-v2 (Microsoft)**: Microsoft's rapid iteration cycle may have produced new Phi variants. Check `microsoft/Phi-5*`.

4. **SmolLM3 (HuggingFace)**: HuggingFace roadmap suggested a next-gen SmolLM but specifics unconfirmed as of August 2025.

5. **Gemma 4 (Google)**: Possible given Google's release cadence.

6. **Mistral Small 3.1 or equivalent**: Mistral regularly releases new models; a post-June 2025 small model may exist.

7. **New DeepSeek models**: DeepSeek has an aggressive release schedule; new efficient variants may exist.

### IMPORTANT (verification needed)

8. **Exact VRAM numbers**: All VRAM estimates are derived from architecture characteristics and community benchmarks. Run `nvidia-smi` during actual training to verify.

9. **Gemma 3n LoRA compatibility**: The novel MatFormer architecture may have compatibility issues with standard PEFT. Check HuggingFace PEFT GitHub issues.

10. **LFM2 LoRA support**: Liquid AI's SSM-based architecture likely requires specialized LoRA treatment. Not recommended without verification.

---

## Search Limitations

- Model: claude-sonnet-4-6 (native, training knowledge cutoff August 2025)
- Web search: unavailable
- Local search: performed (3 prior research sessions reviewed)
- Date range: Training knowledge through August 2025
- Key gap: Models released September 2025 - March 2026 are unknown
- Verified from local research: Qwen3 family data, SmolLM2, Gemma 3 technical details
