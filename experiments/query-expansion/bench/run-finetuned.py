#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "transformers>=4.45.0",
#     "peft>=0.7.0",
#     "accelerate>=0.24.0",
#     "torch",
#     "huggingface_hub>=0.25",
# ]
# ///
"""
Evaluate fine-tuned query expansion models against the 50-query benchmark.

Loads each model from HuggingFace Hub, runs all queries, scores them,
and saves results in the same JSON format as the LM Studio benchmark.

Usage:
    uv run experiments/query-expansion/bench/run-finetuned.py [--model <name>]
    uv run experiments/query-expansion/bench/run-finetuned.py --all

Models:
    qwen3-1.7b    jackrudenko/claudemem-expansion-qwen3-1.7b
    qwen3-4b      jackrudenko/claudemem-expansion-qwen3-4b
    lfm2-1.2b     jackrudenko/claudemem-expansion-lfm2-1.2b
    lfm2-700m     jackrudenko/claudemem-expansion-lfm2-700m
"""

import argparse
import json
import os
import re
import time
from pathlib import Path

# ─── Config ──────────────────────────────────────────────────────────

HF_USER = "jackrudenko"

MODELS = {
    "qwen3-1.7b": {
        "base": "Qwen/Qwen3-1.7B",
        "adapter": f"{HF_USER}/claudemem-expansion-qwen3-1.7b",
        "family": "qwen3-ft",
        "paramsB": 1.7,
    },
    "qwen3-4b": {
        "base": "Qwen/Qwen3-4B",
        "adapter": f"{HF_USER}/claudemem-expansion-qwen3-4b",
        "family": "qwen3-ft",
        "paramsB": 4,
    },
    "lfm2-1.2b": {
        "base": "LiquidAI/LFM2.5-1.2B-Instruct",
        "adapter": f"{HF_USER}/claudemem-expansion-lfm2-1.2b",
        "family": "lfm2-ft",
        "paramsB": 1.2,
    },
    "lfm2-700m": {
        "base": "LiquidAI/LFM2-700M",
        "adapter": f"{HF_USER}/claudemem-expansion-lfm2-700m",
        "family": "lfm2-ft",
        "paramsB": 0.7,
    },
}

SYSTEM_PROMPT = """You are a code search query expansion engine. Given a search query, expand it into three types:
- lex: keyword variants for BM25 search (technical terms, synonyms, related identifiers)
- vec: a natural language rephrasing for semantic vector search
- hyde: a short hypothetical code snippet that would match this query

Respond with exactly 3 lines, no other text:
lex: ...
vec: ...
hyde: ..."""

BENCH_DIR = Path(__file__).parent
QUERIES_PATH = BENCH_DIR / "queries.json"
RESULTS_DIR = BENCH_DIR.parent / "results" / "finetuned"

# ─── Scoring (mirrors scorer.ts) ─────────────────────────────────────


def parse_expansion(raw: str) -> dict:
    """Parse raw output into lex/vec/hyde components."""
    lex = vec = hyde = None
    for line in raw.strip().split("\n"):
        trimmed = line.strip()
        lower = trimmed.lower()
        if lower.startswith("lex:"):
            lex = trimmed[4:].strip()
        elif lower.startswith("vec:"):
            vec = trimmed[4:].strip()
        elif lower.startswith("hyde:"):
            hyde = trimmed[5:].strip()
    return {"raw": raw, "lex": lex, "vec": vec, "hyde": hyde}


def score_format(exp: dict) -> float:
    s = 0.0
    if exp["lex"] and len(exp["lex"]) > 0:
        s += 0.33
    if exp["vec"] and len(exp["vec"]) > 0:
        s += 0.33
    if exp["hyde"] and len(exp["hyde"]) > 0:
        s += 0.34
    return s


def score_keywords(exp: dict, query: str) -> float:
    if not exp["lex"]:
        return 0.0
    lex_terms = [t.strip().lower() for t in re.split(r"[,;|\s]+", exp["lex"]) if len(t.strip()) > 1]
    if not lex_terms:
        return 0.0
    query_terms = [t.lower() for t in query.split() if len(t) > 1]
    score = 0.0
    unique = set(lex_terms)
    score += min(len(unique) / 10, 1.0) * 0.4
    has_overlap = any(
        any(lt in qt or qt in lt for lt in lex_terms) for qt in query_terms
    )
    if has_overlap:
        score += 0.3
    new_terms = [lt for lt in lex_terms if lt not in query_terms]
    if new_terms:
        score += 0.3
    return min(score, 1.0)


def score_semantic(exp: dict, query: str) -> float:
    if not exp["vec"]:
        return 0.0
    vec = exp["vec"]
    score = 0.0
    if 10 <= len(vec) <= 200:
        score += 0.3
    elif len(vec) > 3:
        score += 0.1
    if vec.lower() != query.lower():
        score += 0.3
    else:
        score += 0.05
    if " " in vec and len(vec) > 15:
        score += 0.4
    return min(score, 1.0)


def score_hyde(exp: dict) -> float:
    if not exp["hyde"]:
        return 0.0
    hyde = exp["hyde"]
    score = 0.0
    if len(hyde) > 20:
        score += 0.2
    elif len(hyde) > 5:
        score += 0.1
    code_patterns = [
        r"[{}()\[\]]",
        r"\b(function|const|let|var|class|def|import|export|return|if|for|while|async|await)\b",
        r"[=;:]",
        r"\.\w+\(",
        r"\w+\s*=>",
        r"//",
    ]
    match_count = sum(1 for p in code_patterns if re.search(p, hyde))
    score += min(match_count / 4, 1.0) * 0.5
    line_count = len(hyde.split("\n"))
    if line_count >= 2:
        score += 0.15
    if line_count >= 3:
        score += 0.15
    return min(score, 1.0)


def score_speed(latency_ms: float) -> float:
    if latency_ms <= 500:
        return 1.0
    if latency_ms <= 1500:
        return 0.7
    if latency_ms <= 5000:
        return 0.4
    if latency_ms <= 15000:
        return 0.1
    return 0.0


WEIGHTS = {"format": 0.2, "keyword": 0.2, "semantic": 0.2, "hyde": 0.25, "speed": 0.15}


def score_query(query_id: str, query: str, model_name: str, raw: str, latency_ms: float) -> dict:
    exp = parse_expansion(raw)
    fmt = score_format(exp)
    kw = score_keywords(exp, query)
    sem = score_semantic(exp, query)
    hy = score_hyde(exp)
    spd = score_speed(latency_ms)
    total = (
        fmt * WEIGHTS["format"]
        + kw * WEIGHTS["keyword"]
        + sem * WEIGHTS["semantic"]
        + hy * WEIGHTS["hyde"]
        + spd * WEIGHTS["speed"]
    )
    return {
        "queryId": query_id,
        "query": query,
        "modelName": model_name,
        "format": fmt,
        "keyword": kw,
        "semantic": sem,
        "hyde": hy,
        "latencyMs": latency_ms,
        "total": total,
        "expansion": exp,
    }


# ─── Model Loading ──────────────────────────────────────────────────


def load_model(model_key: str):
    """Load fine-tuned model from HF Hub (base + LoRA adapter)."""
    import torch
    from transformers import AutoTokenizer, AutoModelForCausalLM
    from peft import PeftModel

    cfg = MODELS[model_key]
    print(f"\nLoading {model_key}...")
    print(f"  Base: {cfg['base']}")
    print(f"  Adapter: {cfg['adapter']}")

    # Detect device
    if torch.backends.mps.is_available():
        device = "mps"
        dtype = torch.float16
    elif torch.cuda.is_available():
        device = "cuda"
        dtype = torch.bfloat16
    else:
        device = "cpu"
        dtype = torch.float32

    print(f"  Device: {device}, dtype: {dtype}")

    tokenizer = AutoTokenizer.from_pretrained(cfg["adapter"])
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    # Load base model
    base_model = AutoModelForCausalLM.from_pretrained(
        cfg["base"],
        torch_dtype=dtype,
        device_map=device,
    )

    # Load and merge LoRA adapter
    model = PeftModel.from_pretrained(base_model, cfg["adapter"])
    model = model.merge_and_unload()
    model.eval()

    print(f"  Model loaded and merged on {device}")
    return model, tokenizer, device


def generate_expansion(model, tokenizer, device, query: str, max_new_tokens: int = 300) -> tuple[str, float]:
    """Generate query expansion, return (output, latency_ms)."""
    import torch

    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": f"Query: {query}"},
    ]

    text = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    inputs = tokenizer(text, return_tensors="pt").to(device)

    start = time.perf_counter()
    with torch.no_grad():
        outputs = model.generate(
            **inputs,
            max_new_tokens=max_new_tokens,
            temperature=0.3,
            do_sample=True,
            top_p=0.9,
            pad_token_id=tokenizer.pad_token_id,
        )
    latency_ms = (time.perf_counter() - start) * 1000

    # Decode only the new tokens
    new_tokens = outputs[0][inputs["input_ids"].shape[1]:]
    output = tokenizer.decode(new_tokens, skip_special_tokens=True)

    return output.strip(), latency_ms


# ─── Benchmark ───────────────────────────────────────────────────────


def benchmark_model(model_key: str, queries: list[dict]) -> dict:
    """Run benchmark for a single model."""
    import torch

    cfg = MODELS[model_key]
    display_name = f"{model_key}-FT"

    model, tokenizer, device = load_model(model_key)

    scores = []
    raw_results = []
    success_count = 0
    fail_count = 0

    print(f"\n{'='*60}")
    print(f"Benchmarking: {display_name} ({cfg['paramsB']}B, fine-tuned)")
    print(f"{'='*60}")

    for i, q in enumerate(queries):
        progress = f"[{i+1}/{len(queries)}]"
        try:
            output, latency_ms = generate_expansion(model, tokenizer, device, q["query"])
            sc = score_query(q["id"], q["query"], display_name, output, latency_ms)
            scores.append(sc)
            raw_results.append({
                "queryId": q["id"],
                "query": q["query"],
                "output": output,
                "latencyMs": latency_ms,
            })
            success_count += 1
            print(f'  {progress} "{q["query"][:40]}..." → fmt={sc["format"]:.2f} total={sc["total"]:.2f} {latency_ms:.0f}ms')
        except Exception as e:
            fail_count += 1
            print(f'  {progress} "{q["query"][:40]}..." → FAILED: {str(e)[:60]}')
            raw_results.append({
                "queryId": q["id"],
                "query": q["query"],
                "output": "",
                "latencyMs": 0,
                "error": str(e),
            })

    # Aggregate
    if scores:
        avg = {
            "format": sum(s["format"] for s in scores) / len(scores),
            "keyword": sum(s["keyword"] for s in scores) / len(scores),
            "semantic": sum(s["semantic"] for s in scores) / len(scores),
            "hyde": sum(s["hyde"] for s in scores) / len(scores),
            "latencyMs": sum(s["latencyMs"] for s in scores) / len(scores),
            "total": sum(s["total"] for s in scores) / len(scores),
        }
    else:
        avg = {"format": 0, "keyword": 0, "semantic": 0, "hyde": 0, "latencyMs": 0, "total": 0}

    print(f"\n  Results: {success_count} ok, {fail_count} failed")
    print(f"  Avg: format={avg['format']:.3f} kw={avg['keyword']:.3f} sem={avg['semantic']:.3f} hyde={avg['hyde']:.3f} speed={avg['latencyMs']:.0f}ms total={avg['total']:.3f}")

    # Save results
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    safe_name = f"ft-{model_key}"
    result_file = RESULTS_DIR / f"{safe_name}.json"

    result_data = {
        "model": {
            "name": display_name,
            "lmsKey": cfg["adapter"],
            "family": cfg["family"],
            "paramsB": cfg["paramsB"],
        },
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
        "config": {
            "port": 0,
            "timeout": 60000,
            "retries": 0,
            "note": "Local inference via transformers+peft, not LM Studio",
        },
        "summary": avg,
        "queryCount": len(queries),
        "successCount": success_count,
        "failCount": fail_count,
        "scores": scores,
        "rawResults": raw_results,
    }

    result_file.write_text(json.dumps(result_data, indent=2))
    print(f"  Saved: {result_file}")

    # Free memory
    del model
    del tokenizer
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    elif torch.backends.mps.is_available():
        torch.mps.empty_cache()

    return result_data


# ─── Main ────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Evaluate fine-tuned query expansion models")
    parser.add_argument("--model", choices=list(MODELS.keys()), help="Run a single model")
    parser.add_argument("--all", action="store_true", help="Run all models")
    args = parser.parse_args()

    if not args.model and not args.all:
        parser.print_help()
        print(f"\nAvailable models: {', '.join(MODELS.keys())}")
        return

    # Load queries
    if not QUERIES_PATH.exists():
        print(f"Queries file not found: {QUERIES_PATH}")
        return

    query_set = json.loads(QUERIES_PATH.read_text())
    queries = query_set["queries"]
    print(f"Loaded {len(queries)} queries ({query_set['version']})")

    # Determine which models to run
    model_keys = list(MODELS.keys()) if args.all else [args.model]

    print(f"Models to evaluate: {', '.join(model_keys)}")

    all_results = []
    start = time.time()

    for key in model_keys:
        try:
            result = benchmark_model(key, queries)
            all_results.append(result)
        except Exception as e:
            print(f"\nFATAL: {key} failed: {e}")
            import traceback
            traceback.print_exc()

    total_time = int(time.time() - start)
    print(f"\n{'='*60}")
    print(f"Benchmark Complete ({total_time}s total)")
    print(f"{'='*60}")

    # Print summary table
    if all_results:
        print(f"\n{'Model':<20} {'Format':>7} {'Lex':>7} {'Vec':>7} {'HyDE':>7} {'Speed':>8} {'Total':>7}")
        print("-" * 70)
        for r in all_results:
            s = r["summary"]
            print(
                f"{r['model']['name']:<20} "
                f"{s['format']:>7.3f} "
                f"{s['keyword']:>7.3f} "
                f"{s['semantic']:>7.3f} "
                f"{s['hyde']:>7.3f} "
                f"{s['latencyMs']:>7.0f}ms "
                f"{s['total']:>7.3f}"
            )

    print(f"\nRun report.ts for full comparison:")
    print(f"  bun run experiments/query-expansion/bench/report.ts")


if __name__ == "__main__":
    main()
