# Trade-off Analysis: claudemem Model Pipeline — Alternative Selection

**Date**: 2026-03-04
**Session**: dev-arch-20260304-133830-aeaeb600
**Decision**: Alternative B (Research-Grade) selected

---

## Trade-off Matrix

| Dimension | Alternative A (Lightweight) | Alternative B (Research-Grade) | Alternative C (Production-Optimized) |
|-----------|----------------------------|-------------------------------|--------------------------------------|
| **Performance** | Zero-shot fallback for LFM2 if LoRA fails; no ablation means potentially suboptimal hyperparameters for Qwen3-4B; 500 examples may leave HyDE quality below target (est. 0.65 → target 0.80) | Ablation-selected LoRA rank; architecture-appropriate tooling per model family; 1,500 examples with quality loop maximizes fine-tuning ceiling | Teacher labels internally consistent but bounded by Qwen3-4B quality ceiling; sequential pipeline means LFM2 training data quality depends entirely on step 1 success |
| **Maintainability** | Single training framework path (TRL) is easy to follow, but LFM2 "attempt + fallback" logic is implicit and undocumented at the code level; no dataset versioning | Two frameworks (Unsloth + MLX-LM) adds surface area, but each is architecturally justified; dataset tagged in git; explicit gate results documented in eval/; parser.ts shared between expander and benchmark | Three distinct layers (raw data → Qwen3 → LFM2 teacher labels); hardest to reason about; expansion server adds a long-lived background process with its own lifecycle; highest ongoing maintenance burden |
| **Scalability** | Session-only cache; manual model management; adding a 4th tier or new model family requires re-running the same ad-hoc pipeline | Session-only cache; startup probe is stateless; adding tiers follows documented pattern; gate results are reusable artifacts | Persistent SQLite cache scales across sessions; automated model install scales to end-users; but Ollama dependency and Unix socket server are premature scale solutions for a tool at this adoption stage |
| **Development effort** | Low: ~4-5 days; relies on qmd's existing configs with minimal changes | Medium: ~7-9 days; additional days are spent on measurable quality work (ablation, data quality loop, HyDE gate) | High: ~10-13 days; significant portion spent on serving infrastructure (expansion server, model manager, installer) rather than model quality |
| **Risk** | LFM2 LoRA may silently underperform; HyDE ships unvalidated (highest risk item); coarse fallback criterion (lower-than-zero-shot → revert) may miss subtle regressions | MLX adapter → GGUF conversion is uncertain for LFM2 SSM; mitigated by MLX-only serving fallback; HyDE gate eliminates the biggest production risk; chat template validation catches failures before wasted training runs | Teacher quality bottleneck: if Qwen3-4B fine-tuning underperforms, LFM2 training data is also compromised (error amplification); background process is a UX risk for a CLI tool |
| **Cost** | ~$2.50-3.50 total (lowest) | ~$5-7 total (ablation adds ~$2-3; data generation adds ~$1) | ~$5-8 total (similar to B but sequential dependency means cloud GPU time is not parallelizable with LFM2 local training) |

---

## Why Alternative B Is the Right Choice

### The project context demands validation before production

This is a real research project with production clients (claudemem users). The benchmark phase already established zero-shot baselines. The fine-tuning phase is explicitly about validating assumptions before shipping:

- **Assumption A-4 (HyDE is beneficial for code search)** is the highest-priority unvalidated assumption in the requirements doc. Alternative A defers this validation entirely — it ships a feature whose core mechanic has no published evidence of working on code retrieval. Alternative B makes the HyDE A/B gate a hard prerequisite before integrating hyde embedding into the search path. If HyDE degrades retrieval quality, Alternative A ships a regression; Alternative B prevents it.

- **Assumption A-2 (LFM2 fine-tuning is feasible)** requires active validation. The LFM2 models won the zero-shot benchmark but have no published SFT pipeline for this task format. Alternative A accepts this risk with a coarse fallback criterion ("lower than zero-shot → revert"). Alternative B validates the assumption with architecture-appropriate tooling (MLX-LM on Apple Silicon, where LFM2's MLX weights are tested) and documents the failure mode explicitly if MLX → GGUF conversion fails.

- **The LoRA rank ablation is 3 hours of compute on 10% of data.** For Qwen3-4B, which will run on production machines at the capable tier, the optimal rank matters. Not running an ablation when the cost is $2-3 and the payoff is a measurably better model is not a reasonable trade-off.

### Alternative A's risks are asymmetric

The failure modes in Alternative A are not symmetric:

- Shipping HyDE unvalidated risks degrading search quality for all users, silently, with no A/B comparison documented. Rolling back requires a code change and a release.
- The "lower than zero-shot → revert" criterion for LFM2 fine-tuning only catches catastrophic failures. A model that scores 0.730 post-fine-tuning (vs 0.728 zero-shot) would not be reverted but has wasted training compute and user trust.
- 500 examples with basic format filtering is explicitly noted in the requirements as a risk: "The risk is that HyDE quality for code requires more examples than semantic rephrasing quality." This is the dimension with the most improvement gap (0.65 → 0.80 target). Alternative A bets that it does not; Alternative B removes the bet.

### Alternative C is premature

Alternative C's serving infrastructure (expansion server, model manager, automated installer) solves user-facing operational problems that are not yet validated as real pain points. Before building automated model management, the project needs to:
1. Confirm that fine-tuned models are measurably better than zero-shot (not proven yet)
2. Confirm that HyDE actually improves retrieval (not validated)
3. Ship to users and observe which model management friction points matter in practice

Building a persistent background server with Unix socket IPC and Ollama API integration before any of those validations exist is an over-investment. The distillation approach is genuinely clever for LFM2 quality, but the sequential dependency (Qwen3-4B must train and validate before LFM2 training begins) removes the parallelism that makes the Alternative B timeline competitive.

---

## Elements to Borrow into Alternative B

### From Alternative A

**Single combined dataset for all tiers.** Alternative B's dataset creation produces a single high-quality JSONL corpus that all three models train on. Alternative A's insight that tier-specific datasets are unnecessary at this scale is correct. The optional architecture-specific bias (shorter hyde outputs for LFM2) in Alternative B is a lightweight addition to the shared dataset, not a separate one.

**The `--no-expand` flag as a first-class feature.** Alternative A correctly makes this a CLI flag rather than a config-only option. This belongs in the query expansion API surface regardless of which alternative is chosen.

**Zero-shot fallback criterion as a hard regression gate.** Alternative A's "lower than zero-shot → revert" criterion is coarse but correct in direction. Alternative B should formalize it: if any fine-tuned tier scores within 0.01 of its zero-shot baseline across the full 50-query benchmark, do not ship that tier's fine-tuned weights — ship zero-shot instead. The regression gate should be automated in the benchmark harness.

**The FIM benchmark as a one-day measurement exercise.** Alternative A correctly scopes FIM as a parallel measurement track, not a blocking dependency. Alternative B's structured FIM harness is better, but the timeline allocation (parallel, not blocking) is borrowed from A.

### From Alternative C

**The startup model availability probe.** Alternative C's `probeModelAvailability()` function that queries the inference server at startup time (rather than on-first-search) provides more predictable behavior for users. This is a small addition to Alternative B's serving strategy with no timeline impact.

**The `runtime: "mlx" | "gguf"` distinction in tier config.** When LFM2 models are MLX-only (if GGUF conversion fails), the tier config needs to distinguish which runtime backend to use. Alternative C anticipated this; Alternative B should include it.

**Dataset versioning.** Alternative C's emphasis on pinning the dataset version to the package version is the right long-term practice. Alternative B adopts this: `git tag dataset-v1.0` after generating the training corpus, and the benchmark harness records which dataset version produced a given eval result.

**Coverage audit by query category.** Alternative C's layered data generation implicitly ensures category coverage by design. Alternative B borrows this as an explicit coverage audit step: after automated generation, count examples per category (symbol, error, framework, navigation, code review) and handcraft examples for underrepresented categories. This is the highest-value data engineering step in the entire pipeline.

---

## Decision Record

**Selected**: Alternative B (Research-Grade)

**Primary rationale**: The project is at a validation stage. The two most critical unvalidated assumptions (HyDE effectiveness on code search, LFM2 SSM fine-tuning feasibility) require empirical gates before production integration. Alternative B's additional 2-3 days of development time is spent resolving these uncertainties, not building infrastructure. Alternative A ships faster but with higher probability of shipping a regression or a model that fails to meaningfully exceed the zero-shot baseline. Alternative C solves the right long-term problems at the wrong point in the project lifecycle.

**Conditions for revisiting**: If the HyDE A/B gate completes in under 2 hours (e.g., by scripting the search comparison rather than manual scoring), the timeline gap between A and B narrows to approximately 1 day. In that case, B remains the choice but with reduced timeline cost.
