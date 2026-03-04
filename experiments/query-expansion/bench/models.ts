/**
 * Model Registry for Query Expansion Benchmark
 *
 * Defines the Qwen3.5 and LFM2 model families to benchmark.
 * Model keys match LM Studio's `lms ls` output (verified).
 */

export interface BenchModel {
	/** Display name for reports */
	name: string;
	/** LM Studio model key (used with `lms load`) */
	lmsKey: string;
	/** Model family */
	family: "qwen3.5" | "qwen3" | "lfm2" | "gemma" | "smollm" | "other";
	/** Parameter count in billions */
	paramsB: number;
	/** Quantization */
	quantization: "4bit" | "8bit";
	/** Format */
	format: "mlx" | "gguf";
}

/**
 * All models to benchmark, ordered by family then size.
 * Keys verified against `lms ls` output.
 */
export const BENCH_MODELS: BenchModel[] = [
	// Qwen3.5 family — all 4-bit MLX
	{
		name: "Qwen3.5-0.8B",
		lmsKey: "qwen3.5-0.8b-mlx",
		family: "qwen3.5",
		paramsB: 0.8,
		quantization: "4bit",
		format: "mlx",
	},
	{
		name: "Qwen3.5-2B",
		lmsKey: "qwen3.5-2b",
		family: "qwen3.5",
		paramsB: 2,
		quantization: "4bit",
		format: "mlx",
	},
	{
		name: "Qwen3.5-4B",
		lmsKey: "qwen3.5-4b-mlx",
		family: "qwen3.5",
		paramsB: 4,
		quantization: "4bit",
		format: "mlx",
	},
	{
		name: "Qwen3.5-9B",
		lmsKey: "qwen3.5-9b-mlx@8bit",
		family: "qwen3.5",
		paramsB: 9,
		quantization: "4bit",
		format: "mlx",
	},

	// Qwen3 family (previous gen) — 4-bit GGUF
	{
		name: "Qwen3-4B",
		lmsKey: "qwen/qwen3-4b",
		family: "qwen3",
		paramsB: 4,
		quantization: "4bit",
		format: "gguf",
	},
	{
		name: "Qwen3-4B-2507",
		lmsKey: "qwen/qwen3-4b-2507",
		family: "qwen3",
		paramsB: 4,
		quantization: "4bit",
		format: "gguf",
	},
	{
		name: "Qwen3-8B",
		lmsKey: "qwen/qwen3-8b",
		family: "qwen3",
		paramsB: 8,
		quantization: "4bit",
		format: "gguf",
	},
	{
		name: "Qwen3.5-9B-GGUF",
		lmsKey: "qwen/qwen3.5-9b",
		family: "qwen3.5",
		paramsB: 9,
		quantization: "4bit",
		format: "gguf",
	},

	// LFM2 family — all 4-bit (LFM2.5 for 1.2B slot)
	{
		name: "LFM2-350M",
		lmsKey: "lfm2-350m",
		family: "lfm2",
		paramsB: 0.35,
		quantization: "4bit",
		format: "mlx",
	},
	{
		name: "LFM2-700M",
		lmsKey: "lfm2-700m",
		family: "lfm2",
		paramsB: 0.7,
		quantization: "4bit",
		format: "mlx",
	},
	{
		name: "LFM2.5-1.2B",
		lmsKey: "liquid/lfm2.5-1.2b",
		family: "lfm2",
		paramsB: 1.2,
		quantization: "4bit",
		format: "mlx",
	},
	{
		name: "LFM2-2.6B",
		lmsKey: "lfm2-2.6b",
		family: "lfm2",
		paramsB: 2.6,
		quantization: "4bit",
		format: "mlx",
	},

	// Additional small model candidates — super fast tier
	{
		name: "Qwen3-0.6B",
		lmsKey: "qwen3-0.6b-mlx",
		family: "qwen3",
		paramsB: 0.6,
		quantization: "4bit",
		format: "mlx",
	},
	{
		name: "Qwen3-1.7B",
		lmsKey: "qwen/qwen3-1.7b",
		family: "qwen3",
		paramsB: 1.7,
		quantization: "4bit",
		format: "gguf",
	},
	{
		name: "Gemma-3-1B",
		lmsKey: "google/gemma-3-1b",
		family: "gemma",
		paramsB: 1,
		quantization: "4bit",
		format: "gguf",
	},
	{
		name: "SmolLM2-1.7B",
		lmsKey: "smollm2-1.7b-instruct",
		family: "smollm",
		paramsB: 1.7,
		quantization: "8bit",
		format: "gguf",
	},
];

/** Get a model by name (case-insensitive partial match) */
export function findModel(nameOrKey: string): BenchModel | undefined {
	const lower = nameOrKey.toLowerCase();
	return BENCH_MODELS.find(
		(m) =>
			m.name.toLowerCase() === lower ||
			m.lmsKey.toLowerCase() === lower ||
			m.lmsKey.toLowerCase().includes(lower) ||
			m.name.toLowerCase().includes(lower),
	);
}

/** Get all models for a family */
export function getFamily(family: BenchModel["family"]): BenchModel[] {
	return BENCH_MODELS.filter((m) => m.family === family);
}
