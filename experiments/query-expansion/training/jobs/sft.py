# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "trl>=0.15",
#     "peft>=0.7.0",
#     "transformers>=4.45.0",
#     "accelerate>=0.24.0",
#     "huggingface_hub>=0.25",
#     "datasets",
#     "bitsandbytes",
#     "torch",
# ]
# ///
"""
SFT training for claudemem query expansion models.

Trains LoRA adapter, merges, pushes to HuggingFace Hub.

Usage (cloud via HF Jobs):
    hf jobs uv run --flavor a10g-large --secrets HF_TOKEN --timeout 2h \
        experiments/query-expansion/training/jobs/sft.py --model qwen3-1.7b

    hf jobs uv run --flavor a10g-large --secrets HF_TOKEN --timeout 3h \
        experiments/query-expansion/training/jobs/sft.py --model qwen3-4b-2507

    hf jobs uv run --flavor a10g-large --secrets HF_TOKEN --timeout 2h \
        experiments/query-expansion/training/jobs/sft.py --model lfm2-1.2b

    hf jobs uv run --flavor a10g-large --secrets HF_TOKEN --timeout 2h \
        experiments/query-expansion/training/jobs/sft.py --model lfm2-700m
"""

import argparse
import os
import sys

# ─── Parse args first (fast --help) ──────────────────────────────────

MODELS = {
    "qwen3-4b-2507": {
        "base": "Qwen/Qwen3-4B",
        "hub_name": "claudemem-expansion-qwen3-4b",
        "lora_rank": 16,
        "lora_alpha": 32,
        "epochs": 5,
        "batch_size": 4,
        "grad_accum": 4,
        "lr": 2e-4,
        "load_in_4bit": True,
    },
    "qwen3-1.7b": {
        "base": "Qwen/Qwen3-1.7B",
        "hub_name": "claudemem-expansion-qwen3-1.7b",
        "lora_rank": 16,
        "lora_alpha": 32,
        "epochs": 5,
        "batch_size": 4,
        "grad_accum": 4,
        "lr": 2e-4,
        "load_in_4bit": True,
    },
    "lfm2-1.2b": {
        "base": "LiquidAI/LFM2.5-1.2B-Instruct",
        "hub_name": "claudemem-expansion-lfm2-1.2b",
        "lora_rank": 16,
        "lora_alpha": 32,
        "epochs": 5,
        "batch_size": 4,
        "grad_accum": 4,
        "lr": 2e-4,
        "load_in_4bit": False,
    },
    "lfm2-700m": {
        "base": "LiquidAI/LFM2-700M",
        "hub_name": "claudemem-expansion-lfm2-700m",
        "lora_rank": 16,
        "lora_alpha": 32,
        "epochs": 5,
        "batch_size": 4,
        "grad_accum": 4,
        "lr": 2e-4,
        "load_in_4bit": False,
    },
}

parser = argparse.ArgumentParser(description="SFT training for query expansion")
parser.add_argument("--model", required=True, choices=list(MODELS.keys()))
args = parser.parse_args()

cfg = MODELS[args.model]
HF_USER = "jackrudenko"
DATASET_REPO = f"{HF_USER}/claudemem-expansion-data"
OUTPUT_MODEL = f"{HF_USER}/{cfg['hub_name']}"

# ─── Auth ─────────────────────────────────────────────────────────────

from huggingface_hub import login

hf_token = os.environ.get("HF_TOKEN")
if hf_token:
    login(token=hf_token)

# ─── Imports ──────────────────────────────────────────────────────────

import json
from datasets import Dataset
from peft import LoraConfig
from transformers import AutoTokenizer
from trl import SFTTrainer, SFTConfig

# ─── Dataset ──────────────────────────────────────────────────────────

print(f"\n{'='*60}")
print(f"Training: {args.model}")
print(f"Base: {cfg['base']}")
print(f"LoRA r={cfg['lora_rank']} alpha={cfg['lora_alpha']}")
print(f"Epochs: {cfg['epochs']}, Batch: {cfg['batch_size']}x{cfg['grad_accum']}")
print(f"Output: {OUTPUT_MODEL}")
print(f"{'='*60}\n")

# Download dataset from hub
from huggingface_hub import hf_hub_download

train_path = hf_hub_download(
    repo_id=DATASET_REPO,
    filename="train-split.jsonl",
    repo_type="dataset",
)
eval_path = hf_hub_download(
    repo_id=DATASET_REPO,
    filename="eval-split.jsonl",
    repo_type="dataset",
)


def load_jsonl_as_messages(path: str) -> Dataset:
    """Load our JSONL and extract the messages field for SFT."""
    conversations = []
    with open(path) as f:
        for line in f:
            if not line.strip():
                continue
            obj = json.loads(line)
            messages = obj.get("messages")
            if messages and len(messages) == 3:
                conversations.append({"messages": messages})
    return Dataset.from_list(conversations)


train_ds = load_jsonl_as_messages(train_path)
eval_ds = load_jsonl_as_messages(eval_path)
print(f"Train: {len(train_ds)} examples, Eval: {len(eval_ds)} examples")

# ─── Tokenizer ────────────────────────────────────────────────────────

tokenizer = AutoTokenizer.from_pretrained(cfg["base"])
if tokenizer.pad_token is None:
    tokenizer.pad_token = tokenizer.eos_token


def format_messages(example):
    """Apply chat template to messages."""
    text = tokenizer.apply_chat_template(
        example["messages"],
        tokenize=False,
        add_generation_prompt=False,
    )
    return {"text": text}


train_ds = train_ds.map(format_messages)
eval_ds = eval_ds.map(format_messages)

# Print a sample
print(f"\nSample formatted text (first 300 chars):")
print(train_ds[0]["text"][:300])
print("...\n")

# ─── Training Config ──────────────────────────────────────────────────

sft_config = SFTConfig(
    output_dir=f"outputs/{args.model}",
    push_to_hub=True,
    hub_model_id=OUTPUT_MODEL,
    hub_strategy="every_save",

    num_train_epochs=cfg["epochs"],
    per_device_train_batch_size=cfg["batch_size"],
    gradient_accumulation_steps=cfg["grad_accum"],
    learning_rate=cfg["lr"],
    max_length=512,

    logging_steps=10,
    save_strategy="epoch",
    save_total_limit=2,
    eval_strategy="epoch",

    warmup_ratio=0.03,
    lr_scheduler_type="cosine",
    bf16=True,

    report_to="none",
)

peft_config = LoraConfig(
    r=cfg["lora_rank"],
    lora_alpha=cfg["lora_alpha"],
    lora_dropout=0.0,
    bias="none",
    task_type="CAUSAL_LM",
    target_modules=[
        "q_proj", "k_proj", "v_proj", "o_proj",
        "gate_proj", "up_proj", "down_proj",
    ],
)

# ─── Train ────────────────────────────────────────────────────────────

print("Initializing SFT trainer...")

trainer_kwargs = {
    "model": cfg["base"],
    "train_dataset": train_ds,
    "eval_dataset": eval_ds,
    "args": sft_config,
    "peft_config": peft_config,
}

# For 4-bit quantized loading (Qwen models)
if cfg["load_in_4bit"]:
    from transformers import BitsAndBytesConfig
    import torch

    bnb_config = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_compute_dtype=torch.bfloat16,
        bnb_4bit_use_double_quant=True,
    )

    from transformers import AutoModelForCausalLM

    model = AutoModelForCausalLM.from_pretrained(
        cfg["base"],
        quantization_config=bnb_config,
        device_map="auto",
        torch_dtype=torch.bfloat16,
    )
    model.config.use_cache = False
    trainer_kwargs["model"] = model

trainer = SFTTrainer(**trainer_kwargs)

print("Starting SFT training...")
trainer.train()

print("\nPushing to Hub...")
trainer.push_to_hub()
print(f"\nDone! Model: https://huggingface.co/{OUTPUT_MODEL}")
