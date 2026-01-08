/**
 * Benchmark V2 Module
 *
 * Comprehensive LLM summary evaluation system with:
 * - LLM-as-Judge evaluation
 * - Contrastive matching
 * - Retrieval evaluation (P@K, MRR)
 * - Downstream tasks (code completion, bug localization, function selection)
 *
 * Usage:
 *   import { runBenchmarkV2 } from './benchmark-v2';
 *   const result = await runBenchmarkV2({ projectPath: '.' });
 */

import { randomUUID } from "crypto";
import { join } from "path";
import { existsSync, mkdirSync } from "fs";

// Re-export core types (avoid module conflicts)
export type {
	BenchmarkCodeUnit,
	GeneratedSummary,
	EvaluationResult,
	BenchmarkRun,
	BenchmarkConfig,
	BenchmarkPhase,
	BenchmarkStatus,
	ModelConfig,
	SamplingConfig,
	JudgeEvaluationConfig,
	ContrastiveEvaluationConfig,
	RetrievalEvaluationConfig,
	DownstreamEvaluationConfig,
	AggregatedScore,
	PairwiseResult,
	QueryType,
	GeneratedQuery,
} from "./types.js";

// Re-export errors
export * from "./errors.js";

// Import types for internal use
import type {
	BenchmarkConfig,
	BenchmarkRun,
	BenchmarkPhase,
	ModelConfig,
	ModelProvider,
	SamplingConfig,
	JudgeEvaluationConfig,
	ContrastiveEvaluationConfig,
	RetrievalEvaluationConfig,
	DownstreamEvaluationConfig,
	EvaluationWeights,
} from "./types.js";
import { BenchmarkDatabase } from "./storage/benchmark-db.js";
import { PipelineOrchestrator } from "./pipeline/orchestrator.js";
import { createExtractionPhaseExecutor } from "./extractors/index.js";
import { createGenerationPhaseExecutor } from "./generators/index.js";
import { createJudgePhaseExecutor } from "./evaluators/judge/index.js";
import { createContrastivePhaseExecutor } from "./evaluators/contrastive/index.js";
import { createRetrievalPhaseExecutor } from "./evaluators/retrieval/index.js";
import { createDownstreamPhaseExecutor } from "./evaluators/downstream/index.js";
import { createSelfEvaluationPhaseExecutor } from "./evaluators/self/index.js";
import { createIterativePhaseExecutor } from "./evaluators/iterative/index.js";
import { createScoringPhaseExecutor } from "./scorers/index.js";
import { createReportingPhaseExecutor } from "./reporters/index.js";
import type { ILLMClient, IEmbeddingsClient } from "../types.js";
import type { PhaseResult } from "./pipeline/orchestrator.js";

// ============================================================================
// Configuration Defaults
// ============================================================================

export const DEFAULT_SAMPLING_CONFIG: SamplingConfig = {
	strategy: "stratified",
	targetCount: 20,
	maxPerFile: 10,
	minComplexity: 2,
};

export const DEFAULT_JUDGE_CONFIG: JudgeEvaluationConfig = {
	enabled: true,
	judgeModels: ["claude-opus-4-5-20251101"],
	usePairwise: true,
	criteriaWeights: {
		accuracy: 0.25,
		completeness: 0.2,
		semanticRichness: 0.2,
		abstraction: 0.2,
		conciseness: 0.15,
	},
};

export const DEFAULT_CONTRASTIVE_CONFIG: ContrastiveEvaluationConfig = {
	enabled: true,
	method: "both",
	distractorCount: 9, // More distractors = harder task = better model differentiation
};

export const DEFAULT_RETRIEVAL_CONFIG: RetrievalEvaluationConfig = {
	enabled: true,
	kValues: [1, 3, 5, 10],
	queryTypes: [
		"vague",
		"wrong_terminology",
		"specific_behavior",
		// Doc-style queries (test documentation search patterns)
		"doc_conceptual",
		"doc_api_lookup",
	],
};

export const DEFAULT_DOWNSTREAM_CONFIG: DownstreamEvaluationConfig = {
	enabled: true,
	tasks: {
		codeCompletion: true,
		bugLocalization: true,
		functionSelection: true,
	},
};

export const DEFAULT_SELF_EVAL_CONFIG: {
	enabled: boolean;
	tasks: ("retrieval" | "function_selection")[];
	queriesPerUnit: number;
} = {
	enabled: true, // Enabled by default
	tasks: ["retrieval", "function_selection"],
	queriesPerUnit: 2,
};

export const DEFAULT_ITERATIVE_CONFIG: {
	enabled: boolean;
	maxRounds: number;
	targetRank: number;
	strategy: "retrieval" | "bleu" | "llm-judge";
	applyRoundsPenalty: boolean;
	sampleSize: number;
} = {
	enabled: true, // Enabled by default - tests model's ability to refine summaries
	maxRounds: 3,
	targetRank: 3,
	strategy: "retrieval",
	applyRoundsPenalty: true,
	sampleSize: 10, // Limit refinement to 10 items per model (expensive operation)
};

/**
 * Default evaluation weights optimized for LLM agent code understanding.
 *
 * Quality Score (determines model ranking):
 * - Retrieval (45%): Can agents FIND the right code?
 * - Contrastive (30%): Can agents DISTINGUISH similar code?
 * - Judge (25%): Is the summary accurate and complete?
 *
 * Operational metrics (latency, cost, refinement, self-eval) are
 * reported separately and don't affect rankings.
 */
export const DEFAULT_EVAL_WEIGHTS: EvaluationWeights = {
	retrieval: 0.45,
	contrastive: 0.3,
	judge: 0.25,
};

// ============================================================================
// Model Provider Detection (for bias warnings)
// ============================================================================

/**
 * Detect the provider/family of a model from its ID.
 * Used to warn about potential bias when judge and generator are from same provider.
 */
export function getModelProvider(modelId: string): ModelProvider {
	const id = modelId.toLowerCase();

	// Anthropic models
	if (id.includes("claude") || id.includes("anthropic")) {
		return "anthropic";
	}

	// OpenAI models
	if (
		id.includes("gpt") ||
		id.includes("o1") ||
		id.includes("openai") ||
		id.includes("chatgpt")
	) {
		return "openai";
	}

	// Google models
	if (
		id.includes("gemini") ||
		id.includes("palm") ||
		id.includes("google") ||
		id.includes("bard")
	) {
		return "google";
	}

	// Meta models
	if (id.includes("llama") || id.includes("meta")) {
		return "meta";
	}

	// Mistral models
	if (id.includes("mistral") || id.includes("mixtral")) {
		return "mistral";
	}

	// Local models (LMStudio, Ollama)
	if (
		id.includes("lmstudio/") ||
		id.includes("ollama/") ||
		id.includes("local/")
	) {
		return "local";
	}

	return "unknown";
}

/**
 * Check if a generator model is being judged by a model from the same provider.
 * This can introduce bias as models from the same family may share similar biases.
 */
export function hasSameProviderBias(
	generatorId: string,
	judgeId: string,
): boolean {
	const genProvider = getModelProvider(generatorId);
	const judgeProvider = getModelProvider(judgeId);

	// Can't determine bias for unknown or local providers
	if (genProvider === "unknown" || judgeProvider === "unknown") {
		return false;
	}
	if (genProvider === "local" || judgeProvider === "local") {
		return false;
	}

	return genProvider === judgeProvider;
}

/**
 * Check if any generator is judged by same-provider model.
 * Returns list of biased pairs for warnings.
 */
export function detectSameProviderBias(
	generatorIds: string[],
	judgeIds: string[],
): Array<{ generator: string; judge: string; provider: ModelProvider }> {
	const biasedPairs: Array<{
		generator: string;
		judge: string;
		provider: ModelProvider;
	}> = [];

	for (const genId of generatorIds) {
		for (const judgeId of judgeIds) {
			if (hasSameProviderBias(genId, judgeId)) {
				biasedPairs.push({
					generator: genId,
					judge: judgeId,
					provider: getModelProvider(genId),
				});
			}
		}
	}

	return biasedPairs;
}

// ============================================================================
// Configuration Builder
// ============================================================================

export interface BenchmarkOptions {
	/** Project path to analyze */
	projectPath: string;
	/** Run name for identification */
	runName?: string;
	/** Database path (defaults to .claudemem/benchmark.db) */
	dbPath?: string;
	/** Output directory for reports */
	outputDir?: string;
	/** LLM models to test (generator configs) */
	generators?: ModelConfig[];
	/** Judge models for LLM-as-Judge */
	judgeModels?: string[];
	/** Sampling configuration */
	sampling?: Partial<SamplingConfig>;
	/** Judge evaluation config */
	judge?: Partial<JudgeEvaluationConfig>;
	/** Contrastive evaluation config */
	contrastive?: Partial<ContrastiveEvaluationConfig>;
	/** Retrieval evaluation config */
	retrieval?: Partial<RetrievalEvaluationConfig>;
	/** Downstream evaluation config */
	downstream?: Partial<DownstreamEvaluationConfig>;
	/** Self-evaluation config (model tests its own summaries) */
	self?: Partial<typeof DEFAULT_SELF_EVAL_CONFIG>;
	/** Iterative refinement config */
	iterative?: Partial<typeof DEFAULT_ITERATIVE_CONFIG>;
	/** Evaluation weights */
	weights?: Partial<EvaluationWeights>;
	/** Client factories */
	clients?: {
		createLLMClient?: (modelId: string) => ILLMClient;
		createEmbeddingsClient?: () => IEmbeddingsClient;
	};
	/** Progress callback */
	onProgress?: (
		phase: string,
		progress: number,
		total: number,
		details?: string,
	) => void;
	/** Phase completion callback with detailed failures */
	onPhaseComplete?: (phase: string, result: PhaseResult) => void;
	/** Abort signal for cancellation */
	signal?: AbortSignal;
	/** Resume from existing run */
	resumeRunId?: string;
	/** Verbose logging */
	verbose?: boolean;
	/**
	 * Local model parallelism (lmstudio, ollama).
	 * - 0 = all in parallel (may cause model swapping if VRAM limited)
	 * - 1 = sequential (default, safest for limited VRAM)
	 * - 2-4 = run N local models concurrently
	 */
	localModelParallelism?: number;
	/**
	 * Large model threshold in billions of parameters.
	 * Models >= this size run alone regardless of localModelParallelism.
	 * Default: 20 (20B+ models run isolated)
	 * Set to 0 to disable size-based isolation.
	 */
	largeModelThreshold?: number;
}

/**
 * Create a complete benchmark configuration from options
 */
export function createBenchmarkConfig(
	options: BenchmarkOptions,
): BenchmarkConfig {
	const {
		projectPath,
		runName = `benchmark-${new Date().toISOString().slice(0, 10)}`,
		generators = [],
		judgeModels = DEFAULT_JUDGE_CONFIG.judgeModels,
		sampling = {},
		judge = {},
		contrastive = {},
		retrieval = {},
		downstream = {},
		self = {},
		weights = {},
	} = options;

	return {
		name: runName,
		projectPath,
		generators,
		judges: judge.judgeModels || judgeModels,
		sampleSize: sampling.targetCount || DEFAULT_SAMPLING_CONFIG.targetCount,
		samplingStrategy: sampling.strategy || DEFAULT_SAMPLING_CONFIG.strategy,
		codeUnitTypes: ["function", "class", "method"],
		evaluation: {
			judge: {
				enabled: judge.enabled ?? DEFAULT_JUDGE_CONFIG.enabled,
				judgeModels: judge.judgeModels || judgeModels,
				usePairwise: judge.usePairwise ?? DEFAULT_JUDGE_CONFIG.usePairwise,
			},
			contrastive: {
				enabled: contrastive.enabled ?? DEFAULT_CONTRASTIVE_CONFIG.enabled,
				distractorCount:
					contrastive.distractorCount ??
					DEFAULT_CONTRASTIVE_CONFIG.distractorCount,
				method: contrastive.method ?? DEFAULT_CONTRASTIVE_CONFIG.method,
			},
			retrieval: {
				enabled: retrieval.enabled ?? DEFAULT_RETRIEVAL_CONFIG.enabled,
				queriesPerUnit: 3,
				kValues: retrieval.kValues ?? DEFAULT_RETRIEVAL_CONFIG.kValues,
			},
			downstream: {
				enabled: downstream.enabled ?? DEFAULT_DOWNSTREAM_CONFIG.enabled,
				tasks: downstream.tasks ?? DEFAULT_DOWNSTREAM_CONFIG.tasks,
			},
			self: {
				enabled: self.enabled ?? DEFAULT_SELF_EVAL_CONFIG.enabled,
				tasks: self.tasks ?? [...DEFAULT_SELF_EVAL_CONFIG.tasks],
				queriesPerUnit:
					self.queriesPerUnit ?? DEFAULT_SELF_EVAL_CONFIG.queriesPerUnit,
			},
			iterative: {
				enabled: options.iterative?.enabled ?? DEFAULT_ITERATIVE_CONFIG.enabled,
				maxRounds:
					options.iterative?.maxRounds ?? DEFAULT_ITERATIVE_CONFIG.maxRounds,
				targetRank:
					options.iterative?.targetRank ?? DEFAULT_ITERATIVE_CONFIG.targetRank,
				strategy:
					options.iterative?.strategy ?? DEFAULT_ITERATIVE_CONFIG.strategy,
				applyRoundsPenalty:
					options.iterative?.applyRoundsPenalty ??
					DEFAULT_ITERATIVE_CONFIG.applyRoundsPenalty,
				sampleSize:
					options.iterative?.sampleSize ?? DEFAULT_ITERATIVE_CONFIG.sampleSize,
			},
		},
		weights: {
			judgeWeights: { pointwise: 0.4, pairwise: 0.6 },
			contrastiveWeights: { embedding: 0.5, llm: 0.5 },
			retrievalWeights: { precision1: 0.3, precision5: 0.4, mrr: 0.3 },
			downstreamWeights: {
				completion: 0.4,
				bugLocalization: 0.3,
				functionSelection: 0.3,
			},
			evalWeights: { ...DEFAULT_EVAL_WEIGHTS, ...weights },
		},
		outputFormats: ["json", "markdown", "html"],
		verbose: options.verbose,
		localModelParallelism: options.localModelParallelism ?? 1, // Default: sequential for safety
		largeModelThreshold: options.largeModelThreshold ?? 20, // Default: 20B+ models run isolated
	};
}

// ============================================================================
// Main Benchmark Runner
// ============================================================================

export interface BenchmarkResult {
	run: BenchmarkRun;
	outputFiles: {
		json?: string;
		markdown?: string;
		html?: string;
	};
	success: boolean;
	error?: string;
}

/**
 * Run the complete benchmark pipeline
 */
export async function runBenchmarkV2(
	options: BenchmarkOptions,
): Promise<BenchmarkResult> {
	const {
		projectPath,
		dbPath = join(projectPath, ".claudemem", "benchmark.db"),
		outputDir = join(projectPath, ".claudemem", "benchmark-reports"),
		clients = {},
		onProgress,
		onPhaseComplete,
		signal,
		resumeRunId,
		verbose = false,
	} = options;

	// Ensure directories exist
	const dbDir = join(projectPath, ".claudemem");
	if (!existsSync(dbDir)) {
		mkdirSync(dbDir, { recursive: true });
	}

	// Create configuration
	const config = createBenchmarkConfig(options);

	// Initialize database
	const db = new BenchmarkDatabase(dbPath);

	// Create or resume run
	let run: BenchmarkRun;
	if (resumeRunId) {
		const existingRun = db.getRun(resumeRunId);
		if (!existingRun) {
			throw new Error(`Run ${resumeRunId} not found`);
		}
		run = existingRun;
		if (verbose) {
			console.log(`Resuming run ${run.id} from status ${run.status}`);
		}
		// Warn if CLI generators differ from resumed run's generators
		// This is informational - we use the run's config to match stored summaries
		const cliGeneratorIds = new Set(config.generators.map((g) => g.id));
		const runGeneratorIds = new Set(run.config.generators.map((g) => g.id));
		const mismatch =
			![...cliGeneratorIds].every((id) => runGeneratorIds.has(id)) ||
			![...runGeneratorIds].every((id) => cliGeneratorIds.has(id));
		if (mismatch) {
			console.log(
				`  Note: CLI generators differ from resumed run. Using run's generators: ${[...runGeneratorIds].join(", ")}`,
			);
		}
	} else {
		// Create new run using the database method
		run = db.createRun(config);
		// Always show run ID so users can resume if needed
		console.log(`\x1b[36mRun ID: ${run.id}\x1b[0m`);
		console.log(
			`\x1b[2m  To resume: claudemem benchmark-llm --resume=${run.id} ...\x1b[0m`,
		);
		console.log();
	}

	// Build client maps
	// IMPORTANT: Use run.config (not CLI config) to match stored summaries' modelIds
	// This ensures self-eval and iterative refinement can find clients for their summaries
	const effectiveConfig = run.config;
	const llmClients = new Map<string, ILLMClient>();
	const judgeClients = new Map<string, ILLMClient>();

	if (clients.createLLMClient) {
		// Create clients for generators using the run's config
		// When resuming, this uses the ORIGINAL generators that created the summaries
		for (const generator of effectiveConfig.generators) {
			try {
				llmClients.set(generator.id, clients.createLLMClient(generator.id));
			} catch (error) {
				if (verbose) {
					console.warn(
						`Failed to create LLM client for ${generator.id}: ${error}`,
					);
				}
			}
		}

		// Create clients for judges
		for (const judgeModel of effectiveConfig.judges) {
			try {
				judgeClients.set(judgeModel, clients.createLLMClient(judgeModel));
			} catch (error) {
				if (verbose) {
					console.warn(
						`Failed to create judge client for ${judgeModel}: ${error}`,
					);
				}
			}
		}
	}

	const embeddingsClient = clients.createEmbeddingsClient?.();

	// Create phase executors
	const extractionExecutor = createExtractionPhaseExecutor(projectPath);
	const generationExecutor = createGenerationPhaseExecutor(llmClients);
	const judgeExecutor = createJudgePhaseExecutor(judgeClients);

	// Get first available client for shared evaluators
	const firstJudgeClient =
		judgeClients.size > 0 ? judgeClients.values().next().value : undefined;

	// Only create evaluators if we have the required clients
	// Update config to disable evaluations we can't run
	const contrastiveExecutor = embeddingsClient
		? createContrastivePhaseExecutor(firstJudgeClient, embeddingsClient)
		: undefined;
	const retrievalExecutor = embeddingsClient
		? createRetrievalPhaseExecutor(embeddingsClient, firstJudgeClient)
		: undefined;
	const downstreamExecutor = firstJudgeClient
		? createDownstreamPhaseExecutor(firstJudgeClient)
		: undefined;

	// Self-evaluation uses the generating models to test their own summaries
	const selfEvalExecutor =
		effectiveConfig.evaluation.self?.enabled && llmClients.size > 0
			? createSelfEvaluationPhaseExecutor(llmClients)
			: undefined;

	// Iterative refinement: refine summaries based on retrieval quality
	const iterativeExecutor =
		effectiveConfig.evaluation.iterative?.enabled &&
		llmClients.size > 0 &&
		embeddingsClient
			? createIterativePhaseExecutor(llmClients, embeddingsClient)
			: undefined;

	// Disable evaluations we can't run (no clients)
	if (!embeddingsClient) {
		effectiveConfig.evaluation.contrastive.enabled = false;
		effectiveConfig.evaluation.retrieval.enabled = false;
		console.log(
			"  Note: Contrastive and retrieval evaluation disabled (no embeddings client)",
		);
	}
	if (!firstJudgeClient) {
		effectiveConfig.evaluation.downstream.enabled = false;
		console.log("  Note: Downstream evaluation disabled (no judge client)");
	}
	const scoringExecutor = createScoringPhaseExecutor();
	const reportingExecutor = createReportingPhaseExecutor(outputDir);

	// Build phase map
	type PhaseExecutor = (context: any) => Promise<PhaseResult>;
	const phases = new Map<string, PhaseExecutor>();
	phases.set("extraction", extractionExecutor);
	phases.set("generation", generationExecutor);
	// Iterative refinement runs first to improve summaries before other evaluations
	if (iterativeExecutor) phases.set("evaluation:iterative", iterativeExecutor);
	phases.set("evaluation:judge", judgeExecutor);
	if (contrastiveExecutor)
		phases.set("evaluation:contrastive", contrastiveExecutor);
	if (retrievalExecutor) phases.set("evaluation:retrieval", retrievalExecutor);
	if (downstreamExecutor)
		phases.set("evaluation:downstream", downstreamExecutor);
	if (selfEvalExecutor) phases.set("evaluation:self", selfEvalExecutor);
	phases.set("aggregation", scoringExecutor);
	phases.set("reporting", reportingExecutor);

	// Create orchestrator
	const orchestrator = new PipelineOrchestrator(db, run, {
		onProgress: (
			phase: BenchmarkPhase,
			progress: number,
			total: number,
			details?: string,
		) => {
			onProgress?.(phase, progress, total, details);
			if (verbose) {
				console.log(`[${phase}] ${progress}/${total} ${details || ""}`);
			}
		},
		onPhaseComplete: (phase: BenchmarkPhase, result: PhaseResult) => {
			// Forward phase completion to caller (with failures if any)
			onPhaseComplete?.(phase, result);
		},
		abortSignal: signal,
	});

	// Register phase executors
	phases.forEach((executor, phaseName) => {
		orchestrator.registerExecutor(phaseName as BenchmarkPhase, executor);
	});

	// Run the pipeline
	try {
		await orchestrator.run();

		// Get final run state
		const finalRun = db.getRun(run.id)!;

		return {
			run: finalRun,
			outputFiles: {
				json: join(outputDir, `${run.id}.json`),
				markdown: join(outputDir, `${run.id}.md`),
				html: join(outputDir, `${run.id}.html`),
			},
			success: true,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);

		// Update run status
		db.updateRunStatus(run.id, "failed");

		return {
			run: db.getRun(run.id)!,
			outputFiles: {},
			success: false,
			error: message,
		};
	}
}

// ============================================================================
// CLI Handler
// ============================================================================

import {
	c,
	printLogo,
	printBenchmarkHeader,
	createBenchmarkProgress,
	createSimpleProgress,
	renderTable,
	renderSummary,
	renderInfo,
	renderSuccess,
	renderError,
	formatPercent,
	formatDuration,
	truncate,
	getHighlight,
	type TableColumn,
	type CellValue,
} from "../ui/index.js";

/**
 * List available benchmark runs
 */
async function handleListRuns(): Promise<void> {
	const projectPath = process.cwd();
	const dbPath = join(projectPath, ".claudemem", "benchmark.db");

	printLogo();
	printBenchmarkHeader("📋", "BENCHMARK RUNS");

	if (!existsSync(dbPath)) {
		console.log(`${c.yellow}No benchmark database found.${c.reset}`);
		console.log(`Run a benchmark first: claudemem benchmark-llm`);
		return;
	}

	const db = new BenchmarkDatabase(dbPath);

	try {
		const runs = db.listRuns();

		if (runs.length === 0) {
			console.log(`${c.yellow}No benchmark runs found.${c.reset}`);
			return;
		}

		console.log(`Found ${runs.length} run(s):\n`);

		for (const run of runs) {
			const statusColor =
				run.status === "completed"
					? c.green
					: run.status === "running"
						? c.yellow
						: run.status === "failed"
							? c.red
							: c.dim;

			const date = new Date(run.startedAt).toLocaleDateString();
			const scores = db.getAggregatedScores(run.id);
			const modelCount = scores.size;

			console.log(`  ${c.cyan}${run.id}${c.reset}`);
			console.log(`    Name:     ${run.name}`);
			console.log(`    Status:   ${statusColor}${run.status}${c.reset}`);
			console.log(`    Date:     ${date}`);
			console.log(`    Models:   ${modelCount > 0 ? modelCount : "N/A"}`);
			console.log();
		}

		console.log(
			`${c.dim}To upload a run: claudemem benchmark-llm upload <runId>${c.reset}`,
		);
	} finally {
		db.close();
	}
}

/**
 * Upload a specific benchmark run to Firebase
 */
async function handleUploadSubcommand(args: string[]): Promise<void> {
	const runId = args[0];
	const projectPath = process.cwd();

	if (!runId) {
		console.log(`${c.red}Error:${c.reset} Missing run ID`);
		console.log(`\nUsage: claudemem benchmark-llm upload <runId>`);
		console.log(`\nTo list available runs:`);
		console.log(`  claudemem benchmark-llm --list`);
		return;
	}

	printLogo();
	printBenchmarkHeader("📤", "UPLOAD TO FIREBASE");

	// Open database
	const dbPath = join(projectPath, ".claudemem", "benchmark.db");
	if (!existsSync(dbPath)) {
		console.log(
			`${c.red}Error:${c.reset} No benchmark database found at ${dbPath}`,
		);
		console.log(`Run a benchmark first: claudemem benchmark-llm`);
		return;
	}

	const db = new BenchmarkDatabase(dbPath);

	try {
		// Get the run
		const run = db.getRun(runId);
		renderInfo(`Found run: ${run.name} (${run.status})`);

		// Get aggregated scores
		const scores = db.getAggregatedScores(runId);
		if (scores.size === 0) {
			console.log(`${c.yellow}Warning:${c.reset} No scores found for this run`);
			console.log(`The benchmark may not have completed evaluation phase.`);
			return;
		}

		renderInfo(`Models: ${Array.from(scores.keys()).join(", ")}`);

		// Calculate latency and cost per model from summaries
		const summaries = db.getSummaries(runId);
		const latencyByModel = new Map<string, number>();
		const costByModel = new Map<string, number>();

		for (const [modelId] of scores) {
			const modelSummaries = summaries.filter((s) => s.modelId === modelId);
			let totalLatency = 0;
			let totalCost = 0;
			for (const s of modelSummaries) {
				totalLatency += s.generationMetadata.latencyMs || 0;
				totalCost += s.generationMetadata.cost || 0;
			}
			latencyByModel.set(
				modelId,
				modelSummaries.length > 0 ? totalLatency / modelSummaries.length : 0,
			);
			costByModel.set(modelId, totalCost);
		}

		// Detect codebase type
		const { detectCodebaseType } = await import("./codebase-detector.js");
		const codebaseType = await detectCodebaseType(projectPath);
		renderInfo(`Codebase type: ${codebaseType.label}`);

		// Calculate total cost
		let totalCost = 0;
		for (const cost of costByModel.values()) {
			totalCost += cost;
		}

		// Upload to Firebase
		const { uploadBenchmarkResults } = await import("./firebase/index.js");
		const projectName = projectPath.split("/").pop() || "unknown";

		renderInfo(`Uploading to Firebase...`);

		const uploadResult = await uploadBenchmarkResults(
			run.id,
			projectName,
			projectPath,
			codebaseType,
			run.config.generators.map((g) => (typeof g === "string" ? g : g.id)),
			run.config.judges,
			run.config.sampleSize,
			run.completedAt
				? new Date(run.completedAt).getTime() -
						new Date(run.startedAt).getTime()
				: 0,
			totalCost,
			scores,
			latencyByModel,
			costByModel,
		);

		if (uploadResult.success) {
			console.log(`\n${c.green}✓${c.reset} Successfully uploaded to Firebase!`);
			console.log(`  Run ID: ${uploadResult.docId}`);
		} else {
			console.log(`\n${c.red}✗${c.reset} Upload failed: ${uploadResult.error}`);
		}

		// Force exit - Firebase SDK keeps connection open
		process.exit(0);
	} catch (error) {
		if (error instanceof Error && error.message.includes("not found")) {
			console.log(`${c.red}Error:${c.reset} Run "${runId}" not found`);
			console.log(`\nAvailable runs:`);
			const runs = db.listRuns();
			for (const r of runs.slice(0, 10)) {
				console.log(`  ${c.cyan}${r.id}${c.reset} - ${r.name} (${r.status})`);
			}
		} else {
			console.log(
				`${c.red}Error:${c.reset} ${error instanceof Error ? error.message : error}`,
			);
		}
	} finally {
		db.close();
	}
}

/**
 * CLI command handler for benchmark-llm-v2
 */
export async function runBenchmarkCLI(args: string[]): Promise<void> {
	// Handle subcommands first
	if (args[0] === "upload") {
		await handleUploadSubcommand(args.slice(1));
		return;
	}

	// Handle --list flag to show available runs
	if (args.includes("--list") || args.includes("-l")) {
		await handleListRuns();
		return;
	}

	const benchmarkStartTime = Date.now();

	// Parse CLI arguments
	const getFlag = (name: string): string | undefined => {
		const idx = args.findIndex((a) => a.startsWith(`--${name}=`));
		if (idx !== -1) return args[idx].split("=")[1];
		const idxSpace = args.findIndex((a) => a === `--${name}`);
		if (
			idxSpace !== -1 &&
			args[idxSpace + 1] &&
			!args[idxSpace + 1].startsWith("-")
		) {
			return args[idxSpace + 1];
		}
		return undefined;
	};

	const generatorsStr = getFlag("generators") || "anthropic";
	const judgesStr = getFlag("judges");
	const casesStr = getFlag("cases") || "20";
	const resumeRunId = getFlag("resume");
	const verbose = args.includes("--verbose") || args.includes("-v");
	const noUpload = args.includes("--no-upload") || args.includes("--local");
	const noSelfEval =
		args.includes("--no-self-eval") || args.includes("--no-self");
	const noIterative =
		args.includes("--no-iterative") || args.includes("--no-refine");
	const localParallelismStr = getFlag("local-parallelism") || getFlag("lp");
	const localModelParallelism = localParallelismStr
		? localParallelismStr === "all"
			? 0
			: parseInt(localParallelismStr, 10)
		: 1; // Default: sequential (safe for limited VRAM)
	const largeModelThresholdStr =
		getFlag("large-model-threshold") || getFlag("lmt");
	const largeModelThreshold = largeModelThresholdStr
		? parseInt(largeModelThresholdStr, 10)
		: 20; // Default: 20B+ models run isolated
	const projectPath = process.cwd();

	// Print logo and header
	printLogo();
	printBenchmarkHeader("🔬", "LLM SUMMARY BENCHMARK");

	// Parse generators
	// Format: "anthropic" or "openrouter/openai/gpt-4" (provider/model)
	let generatorSpecs = generatorsStr.split(",").map((s) => s.trim());
	let generators: ModelConfig[] = generatorSpecs.map((spec) => {
		if (spec.startsWith("openrouter/")) {
			// OpenRouter format: openrouter/provider/model
			const modelName = spec.slice("openrouter/".length); // "openai/gpt-4"
			return {
				id: spec,
				provider: "openrouter" as ModelProvider,
				modelName,
				displayName: spec,
				temperature: 0.7,
				maxTokens: 4096,
			};
		} else if (spec.includes("/")) {
			// Generic provider/model format
			const slashIdx = spec.indexOf("/");
			return {
				id: spec,
				provider: spec.slice(0, slashIdx) as ModelProvider,
				modelName: spec.slice(slashIdx + 1),
				displayName: spec,
				temperature: 0.7,
				maxTokens: 4096,
			};
		} else {
			// Just provider name (e.g., "anthropic")
			return {
				id: spec,
				provider: spec as ModelProvider,
				modelName: spec,
				displayName: spec,
				temperature: 0.7,
				maxTokens: 4096,
			};
		}
	});

	// Parse judges
	let judgeModels = judgesStr
		? judgesStr.split(",").map((s) => s.trim())
		: ["claude-opus-4-5-20251101"];

	// Parse case count
	const targetCount =
		casesStr.toLowerCase() === "all" ? 1000 : parseInt(casesStr, 10);

	// If resuming, load the run's config to use the correct generators/judges
	if (resumeRunId) {
		const { BenchmarkDatabase } = await import("./storage/benchmark-db.js");
		const { join } = await import("node:path");
		const dbPath = join(projectPath, ".claudemem", "benchmark.db");
		const db = new BenchmarkDatabase(dbPath);
		const existingRun = db.getRun(resumeRunId);
		if (existingRun) {
			// Update generators and judges from the resumed run
			generatorSpecs = existingRun.config.generators.map((g) => g.id);
			generators = existingRun.config.generators;
			judgeModels = existingRun.config.judges;
		}
	}

	renderInfo(`Generators: ${generatorSpecs.join(", ")}`);
	renderInfo(`Judges: ${judgeModels.join(", ")}`);
	renderInfo(`Target code units: ${targetCount}`);
	// Show local model parallelism if we have any local models
	const hasLocalModels = generatorSpecs.some(
		(s) => s.startsWith("lmstudio/") || s.startsWith("ollama/"),
	);
	if (hasLocalModels) {
		renderInfo(
			`Local parallelism: ${localModelParallelism === 0 ? "all" : localModelParallelism}`,
		);
	}
	if (resumeRunId) {
		renderInfo(`Resuming run: ${resumeRunId}`);
	}
	console.log();

	// Progress tracking with animated progress bars
	let currentPhase = "";
	const phaseStartTimes = new Map<string, number>();
	let activeMultiProgress: ReturnType<typeof createBenchmarkProgress> | null =
		null;
	let activeSimpleProgress: ReturnType<typeof createSimpleProgress> | null =
		null;
	let inPairwiseMode = false; // Track if we've switched to pairwise judging
	const potentiallySkippedPhases = new Set<string>(); // Track phases that started with 0 items
	const phasesWithWork = new Set<string>(); // Track phases that had actual work
	const phaseFailures = new Map<
		string,
		Array<{ model: string; count: number; error: string }>
	>(); // Track failures per phase
	const phaseSkipReasons = new Map<string, string>(); // Track skip reasons per phase

	// Helper to stop current progress bars
	const stopActiveProgress = () => {
		if (activeMultiProgress) {
			// Mark all items as finished before stopping (handles incomplete items)
			activeMultiProgress.finishAll();
			activeMultiProgress.stop();
			activeMultiProgress = null;
		}
		if (activeSimpleProgress) {
			activeSimpleProgress.finish();
			activeSimpleProgress = null;
		}
		inPairwiseMode = false;
	};

	// Phase display names for progress bars
	const phaseLabels: Record<string, string> = {
		extraction: "extracting",
		generation: "generating",
		"evaluation:iterative": "refining",
		"evaluation:judge": "judging",
		"evaluation:contrastive": "contrastive",
		"evaluation:retrieval": "retrieval",
		"evaluation:downstream": "downstream",
		"evaluation:self": "self-eval",
		aggregation: "aggregating",
		reporting: "reporting",
	};

	const onProgress = (
		phase: string,
		progress: number,
		total: number,
		details?: string,
	) => {
		if (process.env.DEBUG_PROGRESS) {
			console.error(
				`[Progress] onProgress: phase=${phase}, progress=${progress}, total=${total}, details=${details?.slice(0, 40) ?? "none"}`,
			);
		}
		// Handle phase transitions
		if (phase !== currentPhase) {
			// Stop previous phase's progress bar
			stopActiveProgress();

			// If previous phase was in potentiallySkipped but never got work, show it as skipped
			if (
				currentPhase &&
				potentiallySkippedPhases.has(currentPhase) &&
				!phasesWithWork.has(currentPhase)
			) {
				const elapsed =
					Date.now() - (phaseStartTimes.get(currentPhase) || Date.now());
				const elapsedStr = formatDuration(elapsed);
				const label = phaseLabels[currentPhase] || currentPhase;
				const skipReason = phaseSkipReasons.get(currentPhase);
				// Clear the "starting..." line and show skipped
				process.stdout.write("\r" + " ".repeat(60) + "\r"); // Clear line
				if (skipReason) {
					console.log(
						`${c.dim}⏱ ${elapsedStr} │ ${label}: skipped (${skipReason})${c.reset}`,
					);
				} else {
					console.log(`${c.dim}⏱ ${elapsedStr} │ ${label}: skipped${c.reset}`);
				}
			}

			// Complete previous phase with timing
			if (currentPhase) {
				// Print detailed failures if any
				const failures = phaseFailures.get(currentPhase);
				if (failures && failures.length > 0) {
					console.log(`${c.yellow}  Failures:${c.reset}`);
					for (const f of failures) {
						console.log(`${c.red}    ${f.model}: ${f.count} failed${c.reset}`);
						// Show full error, wrapped if long
						const errorLines = f.error.split(/[;\n]/).filter((s) => s.trim());
						for (const line of errorLines.slice(0, 3)) {
							// Max 3 error lines per model
							console.log(`${c.dim}      ${line.trim()}${c.reset}`);
						}
						if (errorLines.length > 3) {
							console.log(
								`${c.dim}      ... and ${errorLines.length - 3} more errors${c.reset}`,
							);
						}
					}
				}
			}

			// Start new phase
			currentPhase = phase;
			phaseStartTimes.set(phase, Date.now());

			// Track phases that start with 0 items (might be skipped, or might update later)
			if (total === 0 && !details) {
				potentiallySkippedPhases.add(phase);
				// Show a quick "starting..." message so user knows we're not stuck
				const label = phaseLabels[phase] || phase;
				process.stdout.write(`${c.dim}  ${label}: starting...${c.reset}\r`);
				return; // Don't create progress bar yet - wait for updates
			}

			// Phase has work
			phasesWithWork.add(phase);

			// Create progress bars for phases
			if (
				phase === "generation" ||
				phase === "evaluation:iterative" ||
				phase === "evaluation:self"
			) {
				// Multi-item progress bar for generation/refinement/self-eval (one per model)
				if (process.env.DEBUG_PROGRESS) {
					console.error(
						`[Progress] Creating progress bar for ${phase} with ${generatorSpecs.length} items: ${generatorSpecs.slice(0, 5).join(", ")}${generatorSpecs.length > 5 ? "..." : ""}`,
					);
				}
				activeMultiProgress = createBenchmarkProgress(generatorSpecs);
				activeMultiProgress.start();
			} else if (phase === "evaluation:judge") {
				// Multi-item progress bar for judge (one per judge model)
				activeMultiProgress = createBenchmarkProgress(judgeModels);
				activeMultiProgress.start();
			} else {
				// Simple single-line progress bar for other phases
				activeSimpleProgress = createSimpleProgress(
					phaseLabels[phase] || phase,
					total,
				);
				activeSimpleProgress.update(0);
			}
		}

		// Handle late start: phase started with 0 items but now has real work
		if (
			potentiallySkippedPhases.has(phase) &&
			total > 0 &&
			!activeSimpleProgress &&
			!activeMultiProgress
		) {
			phasesWithWork.add(phase);
			activeSimpleProgress = createSimpleProgress(
				phaseLabels[phase] || phase,
				total,
			);
			activeSimpleProgress.update(progress);
		}

		// Update progress for multi-item phases
		if (activeMultiProgress && details) {
			if (process.env.DEBUG_PROGRESS) {
				console.error(
					`[Progress] Update for ${phase}: ${details.slice(0, 60)}${details.length > 60 ? "..." : ""}`,
				);
			}
			// Parse details: "model: completed/total/inProgress/failures|error" or "pw:model: completed/total/inProgress"
			const isPairwise =
				details.startsWith("pw:") || details.startsWith("pairwise:");
			// New format with failures: model: 5/6/0/1|error message
			// Old format without failures: model: 5/6/0
			const matchWithFailures = details.match(
				/^(?:pw:|pairwise:)?(.+?):\s*(\d+)\/(\d+)\/(\d+)\/(\d+)(?:\|(.*))?$/,
			);
			const matchOld = details.match(
				/^(?:pw:|pairwise:)?(.+?):\s*(\d+)\/(\d+)\/(\d+)$/,
			);
			const match = matchWithFailures || matchOld;

			if (!match && process.env.DEBUG_PROGRESS) {
				console.error(
					`[Progress] WARNING: Details didn't match expected format: "${details}"`,
				);
			}

			if (match) {
				const [
					,
					model,
					completed,
					modelTotal,
					inProgressStr,
					failuresStr,
					errorMsg,
				] = match;
				const completedNum = parseInt(completed, 10);
				const totalNum = parseInt(modelTotal, 10);
				const inProgressNum = parseInt(inProgressStr, 10);
				const failuresNum = failuresStr ? parseInt(failuresStr, 10) : 0;

				// Debug: Check if model ID matches expected generators
				if (process.env.DEBUG_PROGRESS) {
					const isKnown =
						generatorSpecs.includes(model) || judgeModels.includes(model);
					if (!isKnown) {
						console.error(
							`[Progress] WARNING: Model "${model}" not in generatorSpecs or judgeModels`,
						);
						console.error(
							`[Progress]   generatorSpecs: ${generatorSpecs.join(", ")}`,
						);
						console.error(
							`[Progress]   judgeModels: ${judgeModels.join(", ")}`,
						);
					}
				}

				// When pairwise starts, just note it - reuse existing progress bar
				// (changing phase label is enough, no need for new progress bar)
				if (isPairwise && !inPairwiseMode) {
					inPairwiseMode = true;
				}

				const phaseLabel = isPairwise
					? "pairwise"
					: phase === "generation"
						? "generating"
						: phase === "evaluation:iterative"
							? "refining"
							: phase === "evaluation:self"
								? "self-eval"
								: "judging";
				activeMultiProgress.update(
					model,
					completedNum,
					totalNum,
					inProgressNum,
					phaseLabel,
					failuresNum,
				);

				// Mark as done when complete
				if (completedNum >= totalNum && inProgressNum === 0) {
					if (failuresNum > 0 && failuresNum === totalNum && errorMsg) {
						// All failed - show error
						activeMultiProgress.setError(model, errorMsg);
					} else if (failuresNum > 0) {
						// Partial failures - finish with warning (shown in status)
						activeMultiProgress.finish(model);
					} else {
						activeMultiProgress.finish(model);
					}
				}
			}
		}

		// Update progress for simple progress bar phases
		if (activeSimpleProgress) {
			activeSimpleProgress.update(progress);
		}

		// Handle case where phase is "starting..." but we have details to show
		// This happens when a phase starts with 0 items but then shows progress messages
		if (
			!activeSimpleProgress &&
			!activeMultiProgress &&
			details &&
			potentiallySkippedPhases.has(phase)
		) {
			const label = phaseLabels[phase] || phase;
			// Clear the "starting..." line and show the details
			process.stdout.write(
				`\r${c.dim}  ${label}: ${details}${c.reset}${" ".repeat(20)}\r`,
			);
		}
	};

	// Import LLM resolver and embeddings client factories
	const { LLMResolver } = await import("../llm/resolver.js");
	const { createEmbeddingsClient } = await import("../core/embeddings.js");

	// Create LLM client using unified resolver
	// Supports: anthropic, openrouter/model, or/model, lmstudio/model, ollama/model, x-ai/grok, etc.
	const createClientForModel = async (
		modelSpec: string,
	): Promise<ILLMClient> => {
		return LLMResolver.createClient(modelSpec);
	};

	try {
		const result = await runBenchmarkV2({
			projectPath,
			generators,
			judgeModels,
			sampling: { targetCount },
			self: noSelfEval ? { enabled: false } : undefined,
			iterative: noIterative ? { enabled: false } : undefined,
			localModelParallelism,
			largeModelThreshold,
			onProgress,
			onPhaseComplete: (phase, result) => {
				// Store failures for display when phase transitions
				if (result.failures && result.failures.length > 0) {
					phaseFailures.set(phase, result.failures);
				}
				// Store skip reason if phase was skipped
				if (result.skipReason) {
					phaseSkipReasons.set(phase, result.skipReason);
				}
			},
			resumeRunId,
			verbose,
			clients: {
				createLLMClient: (modelId: string) => {
					// This is sync wrapper - actual creation happens lazily
					let clientPromise: Promise<ILLMClient> | null = null;
					const getClient = async () => {
						if (!clientPromise) {
							clientPromise = createClientForModel(modelId);
						}
						return clientPromise;
					};
					// Check if this is a local model (lmstudio/, ollama/, etc.)
					const isLocalModel = LLMResolver.isLocalProvider(modelId);
					// Return a proxy that delegates to the async client
					return {
						getProvider: () => LLMResolver.parseSpec(modelId).provider,
						getModel: () => modelId,
						isCloud: () => !isLocalModel,
						getAccumulatedUsage: () => ({
							inputTokens: 0,
							outputTokens: 0,
							cost: 0,
							calls: 0,
						}),
						resetAccumulatedUsage: () => {},
						complete: async (messages: any, options?: any) => {
							const client = await getClient();
							return client.complete(messages, options);
						},
						completeJSON: async (messages: any, options?: any) => {
							const client = await getClient();
							return client.completeJSON(messages, options);
						},
						testConnection: async () => {
							const client = await getClient();
							return client.testConnection();
						},
						getModelSizeB: async () => {
							const client = await getClient();
							if (typeof client.getModelSizeB === "function") {
								return client.getModelSizeB();
							}
							return undefined;
						},
					} as ILLMClient;
				},
				createEmbeddingsClient: () => {
					// Create embeddings client for contrastive and retrieval evaluations
					return createEmbeddingsClient();
				},
			},
		});

		// Complete the last phase
		stopActiveProgress();

		if (result.success) {
			console.log();

			// Get scores and evaluation results from database for console display
			const dbPath = join(projectPath, ".claudemem", "benchmark.db");
			const { BenchmarkDatabase } = await import("./storage/benchmark-db.js");
			const db = new BenchmarkDatabase(dbPath);
			const scores = db.getAggregatedScores(result.run.id);
			const evalResults = db.getEvaluationResults(result.run.id, "judge");
			const summaries = db.getSummaries(result.run.id);

			// Helper functions
			const truncateName = (s: string, max = 24) => {
				const short = s.split("/").pop() || s;
				return short.length > max ? short.slice(0, max - 1) + "…" : short;
			};
			const fmtPct = (v: number) =>
				isNaN(v) ? "N/A" : `${(v * 100).toFixed(0)}%`;
			const fmtLatency = (ms: number) => {
				if (isNaN(ms) || ms === 0) return "N/A";
				if (ms < 1000) return `${ms.toFixed(0)}ms`;
				return `${(ms / 1000).toFixed(1)}s`;
			};
			const isLocalModel = (modelId: string) =>
				modelId.startsWith("lmstudio/") ||
				modelId.startsWith("ollama/") ||
				modelId.startsWith("local/");
			const isSubscriptionModel = (modelId: string) =>
				modelId.startsWith("cc/") || modelId.startsWith("claude-code/");
			const fmtCost = (cost: number, modelId?: string) => {
				// Show descriptive labels for non-billed models
				if (modelId && isLocalModel(modelId)) return "LOCAL";
				if (modelId && isSubscriptionModel(modelId)) return "SUB";
				if (isNaN(cost) || cost === 0) return "N/A";
				if (cost < 0.01) return `$${(cost * 100).toFixed(2)}¢`;
				if (cost < 1) return `$${cost.toFixed(3)}`;
				return `$${cost.toFixed(2)}`;
			};
			// Round to display precision for comparison (avoids floating-point issues)
			const round = (v: number) => Math.round(v * 1000) / 1000;
			const highlight = (
				val: string,
				isMax: boolean,
				isMin: boolean,
				shouldHL: boolean,
			) => {
				if (!shouldHL) return val;
				if (isMax) return `${c.green}${val}${c.reset}`;
				if (isMin) return `${c.red}${val}${c.reset}`;
				return val;
			};
			// For latency, lower is better (invert highlighting)
			const highlightLatency = (
				val: string,
				isMin: boolean,
				isMax: boolean,
				shouldHL: boolean,
			) => {
				if (!shouldHL) return val;
				if (isMin) return `${c.green}${val}${c.reset}`; // Lower latency = good
				if (isMax) return `${c.red}${val}${c.reset}`; // Higher latency = bad
				return val;
			};

			// Calculate average latency and total cost per model
			const latencyByModel = new Map<string, number>();
			const costByModel = new Map<string, number>();
			let totalBenchmarkCost = 0;

			for (const modelId of scores.keys()) {
				const modelSummaries = summaries.filter((s) => s.modelId === modelId);
				if (modelSummaries.length > 0) {
					const totalLatency = modelSummaries.reduce(
						(sum, s) => sum + (s.generationMetadata?.latencyMs || 0),
						0,
					);
					latencyByModel.set(modelId, totalLatency / modelSummaries.length);

					const totalCost = modelSummaries.reduce(
						(sum, s) => sum + (s.generationMetadata?.cost || 0),
						0,
					);
					costByModel.set(modelId, totalCost);
					totalBenchmarkCost += totalCost;
				}
			}

			if (scores.size > 0) {
				// Convert to array and sort by overall score
				const scoreArray = Array.from(scores.values()).sort(
					(a, b) => b.overall - a.overall,
				);
				const shouldHighlight = scoreArray.length > 1;

				// ═══════════════════════════════════════════════════════════════════
				// QUALITY SCORES TABLE
				// ═══════════════════════════════════════════════════════════════════
				console.log(
					`${c.orange}${c.bold}╔═══════════════════════════════════════════════════════════════════════════╗${c.reset}`,
				);
				console.log(
					`${c.orange}${c.bold}║${c.reset}                         ${c.bold}QUALITY SCORES${c.reset}                                 ${c.orange}${c.bold}║${c.reset}`,
				);
				console.log(
					`${c.orange}${c.bold}╚═══════════════════════════════════════════════════════════════════════════╝${c.reset}`,
				);
				console.log();
				console.log(
					`${c.dim}How well summaries serve LLM agents for code understanding. Higher is better.${c.reset}`,
				);
				console.log();

				// Calculate min/max for quality metrics
				const stats = {
					retr: {
						max: round(
							Math.max(...scoreArray.map((s) => s.retrieval.combined)),
						),
						min: round(
							Math.min(...scoreArray.map((s) => s.retrieval.combined)),
						),
					},
					contr: {
						max: round(
							Math.max(...scoreArray.map((s) => s.contrastive.combined)),
						),
						min: round(
							Math.min(...scoreArray.map((s) => s.contrastive.combined)),
						),
					},
					judge: {
						max: round(Math.max(...scoreArray.map((s) => s.judge.combined))),
						min: round(Math.min(...scoreArray.map((s) => s.judge.combined))),
					},
					overall: {
						max: round(Math.max(...scoreArray.map((s) => s.overall))),
						min: round(Math.min(...scoreArray.map((s) => s.overall))),
					},
				};

				// Get latency/cost values for stats (filter out 0/NaN)
				const qualityLatencyValues = scoreArray
					.map((s) => latencyByModel.get(s.modelId) || 0)
					.filter((v) => v > 0);
				const qualityCostValues = scoreArray
					.map((s) => costByModel.get(s.modelId) || 0)
					.filter((v) => v > 0);
				const timeStats = {
					min:
						qualityLatencyValues.length > 0
							? Math.min(...qualityLatencyValues)
							: 0,
					max:
						qualityLatencyValues.length > 0
							? Math.max(...qualityLatencyValues)
							: 0,
				};
				const costStats = {
					min:
						qualityCostValues.length > 0 ? Math.min(...qualityCostValues) : 0,
					max:
						qualityCostValues.length > 0 ? Math.max(...qualityCostValues) : 0,
				};

				// Quality table header (ordered by weight importance)
				console.log(
					`  ${"Model".padEnd(26)} ${"Retr.".padEnd(9)} ${"Contr.".padEnd(9)} ${"Judge".padEnd(9)} ${"Overall".padEnd(9)} ${"Time".padEnd(8)} ${"Cost".padEnd(8)}`,
				);
				console.log(
					`  ${"─".repeat(26)} ${"─".repeat(8)} ${"─".repeat(8)} ${"─".repeat(8)} ${"─".repeat(8)} ${"─".repeat(7)} ${"─".repeat(7)}`,
				);

				for (const s of scoreArray) {
					const name = truncateName(s.modelId).padEnd(26);
					const retr = highlight(
						fmtPct(s.retrieval.combined).padEnd(9),
						round(s.retrieval.combined) === stats.retr.max,
						round(s.retrieval.combined) === stats.retr.min &&
							stats.retr.min !== stats.retr.max,
						shouldHighlight,
					);
					const contr = highlight(
						fmtPct(s.contrastive.combined).padEnd(9),
						round(s.contrastive.combined) === stats.contr.max,
						round(s.contrastive.combined) === stats.contr.min &&
							stats.contr.min !== stats.contr.max,
						shouldHighlight,
					);
					const judge = highlight(
						fmtPct(s.judge.combined).padEnd(9),
						round(s.judge.combined) === stats.judge.max,
						round(s.judge.combined) === stats.judge.min &&
							stats.judge.min !== stats.judge.max,
						shouldHighlight,
					);
					const overall = highlight(
						fmtPct(s.overall).padEnd(9),
						round(s.overall) === stats.overall.max,
						round(s.overall) === stats.overall.min &&
							stats.overall.min !== stats.overall.max,
						shouldHighlight,
					);

					// Time and cost (lower is better)
					const latency = latencyByModel.get(s.modelId) || 0;
					const costVal = costByModel.get(s.modelId) || 0;
					const time = highlightLatency(
						fmtLatency(latency).padEnd(8),
						latency > 0 && latency === timeStats.min,
						latency > 0 &&
							latency === timeStats.max &&
							timeStats.min !== timeStats.max,
						shouldHighlight,
					);
					const costStr = highlightLatency(
						fmtCost(costVal, s.modelId).padEnd(8),
						costVal > 0 && costVal === costStats.min,
						costVal > 0 &&
							costVal === costStats.max &&
							costStats.min !== costStats.max,
						shouldHighlight,
					);

					console.log(
						`  ${name} ${retr} ${contr} ${judge} ${overall} ${time} ${costStr}`,
					);
				}

				// Quality column explanations
				console.log();
				console.log(`${c.dim}Quality metrics (used for ranking):${c.reset}`);
				console.log(
					`${c.dim}  • Retr. (45%):  Can agents FIND the right code? (P@K, MRR)${c.reset}`,
				);
				console.log(
					`${c.dim}  • Contr. (30%): Can agents DISTINGUISH similar code?${c.reset}`,
				);
				console.log(
					`${c.dim}  • Judge (25%):  Is summary accurate and complete?${c.reset}`,
				);

				// ═══════════════════════════════════════════════════════════════════
				// OPERATIONAL METRICS TABLE
				// ═══════════════════════════════════════════════════════════════════
				console.log();
				console.log(
					`${c.cyan}${c.bold}┌───────────────────────────────────────────────────────────────────────────┐${c.reset}`,
				);
				console.log(
					`${c.cyan}${c.bold}│${c.reset}                      ${c.bold}OPERATIONAL METRICS${c.reset}                                ${c.cyan}${c.bold}│${c.reset}`,
				);
				console.log(
					`${c.cyan}${c.bold}└───────────────────────────────────────────────────────────────────────────┘${c.reset}`,
				);
				console.log();
				console.log(
					`${c.dim}Production efficiency metrics. Don't affect quality ranking.${c.reset}`,
				);
				console.log();

				// Calculate operational stats
				const latencyValues = scoreArray
					.map((s) => latencyByModel.get(s.modelId) || 0)
					.filter((v) => v > 0);
				const costValues = scoreArray
					.map((s) => costByModel.get(s.modelId) || 0)
					.filter((v) => v > 0);
				const opStats = {
					latency:
						latencyValues.length > 0
							? {
									max: round(Math.max(...latencyValues)),
									min: round(Math.min(...latencyValues)),
								}
							: { max: 0, min: 0 },
					cost:
						costValues.length > 0
							? {
									max: round(Math.max(...costValues)),
									min: round(Math.min(...costValues)),
								}
							: { max: 0, min: 0 },
					refine: {
						max: round(
							Math.max(...scoreArray.map((s) => s.iterative?.avgRounds ?? 0)),
						),
						min: round(
							Math.min(...scoreArray.map((s) => s.iterative?.avgRounds ?? 0)),
						),
					},
					selfEval: {
						max: round(
							Math.max(...scoreArray.map((s) => s.self?.overall ?? 0)),
						),
						min: round(
							Math.min(...scoreArray.map((s) => s.self?.overall ?? 0)),
						),
					},
				};

				// Operational table header
				console.log(
					`  ${"Model".padEnd(26)} ${"Latency".padEnd(10)} ${"Cost".padEnd(10)} ${"Refine".padEnd(10)} ${"Self-Eval".padEnd(10)}`,
				);
				console.log(
					`  ${"─".repeat(26)} ${"─".repeat(9)} ${"─".repeat(9)} ${"─".repeat(9)} ${"─".repeat(9)}`,
				);

				for (const s of scoreArray) {
					const name = truncateName(s.modelId).padEnd(26);
					const modelLatency = latencyByModel.get(s.modelId) || 0;
					const latency = highlightLatency(
						fmtLatency(modelLatency).padEnd(10),
						round(modelLatency) === opStats.latency.min &&
							opStats.latency.min !== opStats.latency.max,
						round(modelLatency) === opStats.latency.max &&
							opStats.latency.min !== opStats.latency.max,
						shouldHighlight,
					);
					const modelCost = costByModel.get(s.modelId) || 0;
					const cost = highlightLatency(
						fmtCost(modelCost, s.modelId).padEnd(10),
						round(modelCost) === opStats.cost.min &&
							opStats.cost.min !== opStats.cost.max,
						round(modelCost) === opStats.cost.max &&
							opStats.cost.min !== opStats.cost.max,
						shouldHighlight,
					);
					// Refinement: lower rounds = better (green), higher = worse (red)
					const avgRounds = s.iterative?.avgRounds ?? 0;
					const refineStr = s.iterative ? `${avgRounds.toFixed(1)} rnd` : "N/A";
					const refine = s.iterative
						? highlightLatency(
								refineStr.padEnd(10),
								round(avgRounds) === opStats.refine.min &&
									opStats.refine.min !== opStats.refine.max,
								round(avgRounds) === opStats.refine.max &&
									opStats.refine.min !== opStats.refine.max,
								shouldHighlight,
							)
						: refineStr.padEnd(10);
					// Self-eval: higher = better
					const selfScore = s.self?.overall ?? 0;
					const selfStr = s.self ? fmtPct(selfScore) : "N/A";
					const selfEval = s.self
						? highlight(
								selfStr.padEnd(10),
								round(selfScore) === opStats.selfEval.max,
								round(selfScore) === opStats.selfEval.min &&
									opStats.selfEval.min !== opStats.selfEval.max,
								shouldHighlight,
							)
						: selfStr.padEnd(10);
					console.log(`  ${name} ${latency} ${cost} ${refine} ${selfEval}`);
				}

				// Operational column explanations
				console.log();
				console.log(
					`${c.dim}Operational metrics (for production decisions):${c.reset}`,
				);
				console.log(
					`${c.dim}  • Latency:   Avg generation time (lower = faster)${c.reset}`,
				);
				console.log(
					`${c.dim}  • Cost:      Total generation cost (lower = cheaper)${c.reset}`,
				);
				console.log(
					`${c.dim}  • Refine:    Avg refinement rounds needed (lower = better first-try quality)${c.reset}`,
				);
				console.log(
					`${c.dim}  • Self-Eval: Can model use its own summaries? (internal consistency check)${c.reset}`,
				);

				// Total benchmark cost
				if (totalBenchmarkCost > 0) {
					console.log();
					console.log(
						`${c.bold}Total Benchmark Cost: ${c.cyan}${fmtCost(totalBenchmarkCost)}${c.reset}`,
					);
				}

				// ═══════════════════════════════════════════════════════════════════
				// DETAILED JUDGE SCORES TABLE
				// ═══════════════════════════════════════════════════════════════════
				console.log();
				console.log(
					`${c.cyan}${c.bold}┌──────────────────────────────────────────────────────────────────────────┐${c.reset}`,
				);
				console.log(
					`${c.cyan}${c.bold}│${c.reset}                      ${c.bold}JUDGE EVALUATION DETAILS${c.reset}                          ${c.cyan}${c.bold}│${c.reset}`,
				);
				console.log(
					`${c.cyan}${c.bold}└──────────────────────────────────────────────────────────────────────────┘${c.reset}`,
				);
				console.log();
				console.log(
					`${c.dim}LLM judges rate summary quality on 5 criteria (1-5 scale, shown as %).${c.reset}`,
				);
				console.log();

				// Calculate per-criteria stats
				const criteriaStats = {
					accuracy: {
						max: Math.max(...scoreArray.map((s) => s.judge.pointwise)),
						min: Math.min(...scoreArray.map((s) => s.judge.pointwise)),
					},
					pairwise: {
						max: Math.max(...scoreArray.map((s) => s.judge.pairwise)),
						min: Math.min(...scoreArray.map((s) => s.judge.pairwise)),
					},
				};

				console.log(
					`  ${"Model".padEnd(26)} ${"Pointwise".padEnd(10)} ${"Pairwise".padEnd(10)} ${"Combined".padEnd(10)}`,
				);
				console.log(
					`  ${"─".repeat(26)} ${"─".repeat(9)} ${"─".repeat(9)} ${"─".repeat(9)}`,
				);

				for (const s of scoreArray) {
					const name = truncateName(s.modelId).padEnd(26);
					const pointwise = highlight(
						fmtPct(s.judge.pointwise).padEnd(10),
						s.judge.pointwise === criteriaStats.accuracy.max,
						s.judge.pointwise === criteriaStats.accuracy.min &&
							criteriaStats.accuracy.min !== criteriaStats.accuracy.max,
						shouldHighlight,
					);
					const pairwise = highlight(
						fmtPct(s.judge.pairwise).padEnd(10),
						s.judge.pairwise === criteriaStats.pairwise.max,
						s.judge.pairwise === criteriaStats.pairwise.min &&
							criteriaStats.pairwise.min !== criteriaStats.pairwise.max,
						shouldHighlight,
					);
					const combined = highlight(
						fmtPct(s.judge.combined).padEnd(10),
						s.judge.combined === stats.judge.max,
						s.judge.combined === stats.judge.min &&
							stats.judge.min !== stats.judge.max,
						shouldHighlight,
					);
					console.log(`  ${name} ${pointwise} ${pairwise} ${combined}`);
				}

				console.log();
				console.log(`${c.dim}Scoring methods:${c.reset}`);
				console.log(
					`${c.dim}  • Pointwise: Each summary rated independently (accuracy, completeness, conciseness)${c.reset}`,
				);
				console.log(
					`${c.dim}  • Pairwise:  Head-to-head comparison (which summary better describes the code?)${c.reset}`,
				);
				console.log(
					`${c.dim}  • Combined:  Weighted mix of pointwise (40%) and pairwise (60%)${c.reset}`,
				);

				// ═══════════════════════════════════════════════════════════════════
				// PER-JUDGE BREAKDOWN (if multiple judges)
				// ═══════════════════════════════════════════════════════════════════
				if (judgeModels.length > 1 && evalResults.length > 0) {
					console.log();
					console.log(
						`${c.yellow}${c.bold}┌──────────────────────────────────────────────────────────────────────────┐${c.reset}`,
					);
					console.log(
						`${c.yellow}${c.bold}│${c.reset}                        ${c.bold}PER-JUDGE BREAKDOWN${c.reset}                            ${c.yellow}${c.bold}│${c.reset}`,
					);
					console.log(
						`${c.yellow}${c.bold}└──────────────────────────────────────────────────────────────────────────┘${c.reset}`,
					);
					console.log();
					console.log(
						`${c.dim}How each judge model scored the generators (shows judge agreement/bias).${c.reset}`,
					);
					console.log();

					// Detect same-provider bias
					const biasedPairs = detectSameProviderBias(
						generatorSpecs,
						judgeModels,
					);
					const biasSet = new Set(
						biasedPairs.map((p) => `${p.generator}:${p.judge}`),
					);

					// Group results by judge
					const byJudge = new Map<string, Map<string, number[]>>();
					for (const judgeId of judgeModels) {
						byJudge.set(judgeId, new Map());
					}

					for (const evalResult of evalResults) {
						if (!evalResult.judgeResults) continue;
						const judgeId = evalResult.judgeResults.judgeModelId;
						const summary = summaries.find(
							(s) => s.id === evalResult.summaryId,
						);
						if (!summary) continue;

						const judgeMap = byJudge.get(judgeId);
						if (!judgeMap) continue;

						if (!judgeMap.has(summary.modelId)) {
							judgeMap.set(summary.modelId, []);
						}
						judgeMap
							.get(summary.modelId)!
							.push(evalResult.judgeResults.weightedAverage);
					}

					// Display per-judge table
					const generatorIds = generatorSpecs;
					const judgeHeader = `  ${"Generator".padEnd(26)} ${judgeModels.map((j) => truncateName(j, 12).padEnd(14)).join("")}`;
					console.log(judgeHeader);
					console.log(
						`  ${"─".repeat(26)} ${judgeModels.map(() => "─".repeat(13)).join(" ")}`,
					);

					// Calculate per-judge stats for highlighting
					const judgeStats = new Map<string, { max: number; min: number }>();
					for (const judgeId of judgeModels) {
						const judgeMap = byJudge.get(judgeId)!;
						const avgs = Array.from(judgeMap.values()).map((scores) =>
							scores.length > 0
								? scores.reduce((a, b) => a + b, 0) / scores.length / 5
								: 0,
						);
						judgeStats.set(judgeId, {
							max: Math.max(...avgs),
							min: Math.min(...avgs),
						});
					}

					for (const genId of generatorIds) {
						const genName = truncateName(genId).padEnd(26);
						const judgeScores = judgeModels
							.map((judgeId) => {
								const judgeMap = byJudge.get(judgeId)!;
								const scores = judgeMap.get(genId) || [];
								const avg =
									scores.length > 0
										? scores.reduce((a, b) => a + b, 0) / scores.length / 5
										: 0;
								const stats = judgeStats.get(judgeId)!;
								const isBiased = biasSet.has(`${genId}:${judgeId}`);
								// Highlight biased scores with yellow background marker
								const scoreStr = fmtPct(avg);
								if (isBiased) {
									return `${c.yellow}${scoreStr}*${c.reset}`.padEnd(
										14 + c.yellow.length + c.reset.length,
									);
								}
								return highlight(
									scoreStr.padEnd(14),
									avg === stats.max,
									avg === stats.min && stats.min !== stats.max,
									shouldHighlight,
								);
							})
							.join("");
						console.log(`  ${genName} ${judgeScores}`);
					}

					console.log();
					console.log(
						`${c.dim}Note: Similar scores across judges = reliable. Large differences = potential bias.${c.reset}`,
					);

					// Show bias warning if detected
					if (biasedPairs.length > 0) {
						console.log();
						console.log(`${c.yellow}⚠️  SAME-PROVIDER BIAS WARNING:${c.reset}`);
						console.log(
							`${c.yellow}   Scores marked with * are from same-provider judging (e.g., Claude judging Claude).${c.reset}`,
						);
						console.log(
							`${c.yellow}   These scores may be biased - models from the same family may rate each other favorably.${c.reset}`,
						);
						console.log(`${c.dim}   Affected pairs:${c.reset}`);
						for (const pair of biasedPairs) {
							console.log(
								`${c.dim}     • ${truncateName(pair.generator, 20)} judged by ${truncateName(pair.judge, 20)} (${pair.provider})${c.reset}`,
							);
						}
					}
				}

				// ═══════════════════════════════════════════════════════════════════
				// SELF-EVAL DETAILS (if available)
				// ═══════════════════════════════════════════════════════════════════
				const hasSelfEvalResults = scoreArray.some((s) => s.self);
				if (hasSelfEvalResults) {
					console.log();
					console.log(
						`${c.magenta}${c.bold}┌──────────────────────────────────────────────────────────────────────────┐${c.reset}`,
					);
					console.log(
						`${c.magenta}${c.bold}│${c.reset}                      ${c.bold}SELF-EVAL DETAILS${c.reset}                               ${c.magenta}${c.bold}│${c.reset}`,
					);
					console.log(
						`${c.magenta}${c.bold}└──────────────────────────────────────────────────────────────────────────┘${c.reset}`,
					);
					console.log();
					console.log(
						`${c.dim}Can each model effectively use its own summaries for retrieval & selection?${c.reset}`,
					);
					console.log();

					// Calculate self-eval stats
					const selfStats = {
						retrieval: {
							max: Math.max(
								...scoreArray
									.filter((s) => s.self)
									.map((s) => s.self!.retrieval),
							),
							min: Math.min(
								...scoreArray
									.filter((s) => s.self)
									.map((s) => s.self!.retrieval),
							),
						},
						funcSel: {
							max: Math.max(
								...scoreArray
									.filter((s) => s.self)
									.map((s) => s.self!.functionSelection),
							),
							min: Math.min(
								...scoreArray
									.filter((s) => s.self)
									.map((s) => s.self!.functionSelection),
							),
						},
						overall: {
							max: Math.max(
								...scoreArray.filter((s) => s.self).map((s) => s.self!.overall),
							),
							min: Math.min(
								...scoreArray.filter((s) => s.self).map((s) => s.self!.overall),
							),
						},
					};

					console.log(
						`  ${"Model".padEnd(26)} ${"Retrieval".padEnd(10)} ${"Func.Sel.".padEnd(10)} ${"Overall".padEnd(10)}`,
					);
					console.log(
						`  ${"─".repeat(26)} ${"─".repeat(9)} ${"─".repeat(9)} ${"─".repeat(9)}`,
					);

					for (const s of scoreArray) {
						if (!s.self) continue;
						const name = truncateName(s.modelId).padEnd(26);
						const retr = highlight(
							fmtPct(s.self.retrieval).padEnd(10),
							s.self.retrieval === selfStats.retrieval.max,
							s.self.retrieval === selfStats.retrieval.min &&
								selfStats.retrieval.min !== selfStats.retrieval.max,
							shouldHighlight,
						);
						const funcSel = highlight(
							fmtPct(s.self.functionSelection).padEnd(10),
							s.self.functionSelection === selfStats.funcSel.max,
							s.self.functionSelection === selfStats.funcSel.min &&
								selfStats.funcSel.min !== selfStats.funcSel.max,
							shouldHighlight,
						);
						const overall = highlight(
							fmtPct(s.self.overall).padEnd(10),
							s.self.overall === selfStats.overall.max,
							s.self.overall === selfStats.overall.min &&
								selfStats.overall.min !== selfStats.overall.max,
							shouldHighlight,
						);
						console.log(`  ${name} ${retr} ${funcSel} ${overall}`);
					}

					console.log();
					console.log(`${c.dim}Self-eval tasks:${c.reset}`);
					console.log(
						`${c.dim}  • Retrieval:  Given a query, can the model pick its own summary from distractors?${c.reset}`,
					);
					console.log(
						`${c.dim}  • Func.Sel.:  Given a task, can the model identify the right function from summaries?${c.reset}`,
					);
					console.log(
						`${c.dim}  • Overall:    Weighted average (60% retrieval, 40% function selection)${c.reset}`,
					);
				}

				// ═══════════════════════════════════════════════════════════════════
				// ITERATIVE REFINEMENT DETAILS (if available)
				// ═══════════════════════════════════════════════════════════════════
				const hasIterativeResults = scoreArray.some((s) => s.iterative);
				if (hasIterativeResults) {
					console.log();
					console.log(
						`${c.cyan}${c.bold}┌──────────────────────────────────────────────────────────────────────────┐${c.reset}`,
					);
					console.log(
						`${c.cyan}${c.bold}│${c.reset}                    ${c.bold}ITERATIVE REFINEMENT DETAILS${c.reset}                        ${c.cyan}${c.bold}│${c.reset}`,
					);
					console.log(
						`${c.cyan}${c.bold}└──────────────────────────────────────────────────────────────────────────┘${c.reset}`,
					);
					console.log();
					console.log(
						`${c.dim}How many refinement rounds were needed to achieve target retrieval rank?${c.reset}`,
					);
					console.log();

					// Calculate iterative stats
					const iterStats = {
						rounds: {
							max: Math.max(
								...scoreArray
									.filter((s) => s.iterative)
									.map((s) => s.iterative!.avgRounds),
							),
							min: Math.min(
								...scoreArray
									.filter((s) => s.iterative)
									.map((s) => s.iterative!.avgRounds),
							),
						},
						successRate: {
							max: Math.max(
								...scoreArray
									.filter((s) => s.iterative)
									.map((s) => s.iterative!.successRate),
							),
							min: Math.min(
								...scoreArray
									.filter((s) => s.iterative)
									.map((s) => s.iterative!.successRate),
							),
						},
						score: {
							max: Math.max(
								...scoreArray
									.filter((s) => s.iterative)
									.map((s) => s.iterative!.avgRefinementScore),
							),
							min: Math.min(
								...scoreArray
									.filter((s) => s.iterative)
									.map((s) => s.iterative!.avgRefinementScore),
							),
						},
					};

					console.log(
						`  ${"Model".padEnd(26)} ${"Avg Rounds".padEnd(11)} ${"Success".padEnd(10)} ${"Score".padEnd(10)}`,
					);
					console.log(
						`  ${"─".repeat(26)} ${"─".repeat(10)} ${"─".repeat(9)} ${"─".repeat(9)}`,
					);

					for (const s of scoreArray) {
						if (!s.iterative) continue;
						const name = truncateName(s.modelId).padEnd(26);
						// For rounds, lower is better (green for min, red for max)
						const roundsStr = `${s.iterative.avgRounds.toFixed(1)} rnd`;
						const rounds = highlightLatency(
							roundsStr.padEnd(11),
							round(s.iterative.avgRounds) === iterStats.rounds.min &&
								iterStats.rounds.min !== iterStats.rounds.max,
							round(s.iterative.avgRounds) === iterStats.rounds.max &&
								iterStats.rounds.min !== iterStats.rounds.max,
							shouldHighlight,
						);
						// For success rate and score, higher is better
						const successRate = highlight(
							fmtPct(s.iterative.successRate).padEnd(10),
							s.iterative.successRate === iterStats.successRate.max,
							s.iterative.successRate === iterStats.successRate.min &&
								iterStats.successRate.min !== iterStats.successRate.max,
							shouldHighlight,
						);
						const score = highlight(
							fmtPct(s.iterative.avgRefinementScore).padEnd(10),
							s.iterative.avgRefinementScore === iterStats.score.max,
							s.iterative.avgRefinementScore === iterStats.score.min &&
								iterStats.score.min !== iterStats.score.max,
							shouldHighlight,
						);
						console.log(`  ${name} ${rounds} ${successRate} ${score}`);
					}

					console.log();
					console.log(`${c.dim}Iterative metrics:${c.reset}`);
					console.log(
						`${c.dim}  • Avg Rounds: Average refinement iterations needed (0 = passed first try, lower = better)${c.reset}`,
					);
					console.log(
						`${c.dim}  • Success:    Rate of achieving target retrieval rank within max rounds${c.reset}`,
					);
					console.log(
						`${c.dim}  • Score:      Brokk-style score: 1/log₂(rounds+2) - rewards fewer iterations${c.reset}`,
					);
				}

				// ═══════════════════════════════════════════════════════════════════
				// SUMMARY
				// ═══════════════════════════════════════════════════════════════════
				console.log();
				console.log(
					`${c.green}${c.bold}┌──────────────────────────────────────────────────────────────────────────┐${c.reset}`,
				);
				console.log(
					`${c.green}${c.bold}│${c.reset}                            ${c.bold}SUMMARY${c.reset}                                     ${c.green}${c.bold}│${c.reset}`,
				);
				console.log(
					`${c.green}${c.bold}└──────────────────────────────────────────────────────────────────────────┘${c.reset}`,
				);
				console.log();

				const best = scoreArray[0];
				const worst = scoreArray[scoreArray.length - 1];
				console.log(
					`  ${c.green}🏆 Best Overall:${c.reset}  ${truncateName(best.modelId, 30)} ${c.bold}(${fmtPct(best.overall)})${c.reset}`,
				);
				if (shouldHighlight) {
					console.log(
						`  ${c.red}📉 Worst Overall:${c.reset} ${truncateName(worst.modelId, 30)} (${fmtPct(worst.overall)})`,
					);
				}

				// Find best in each quality category
				const bestRetr = scoreArray.reduce((a, b) =>
					a.retrieval.combined > b.retrieval.combined ? a : b,
				);
				const bestContr = scoreArray.reduce((a, b) =>
					a.contrastive.combined > b.contrastive.combined ? a : b,
				);
				const bestJudge = scoreArray.reduce((a, b) =>
					a.judge.combined > b.judge.combined ? a : b,
				);

				console.log();
				console.log(`  ${c.cyan}Quality leaders:${c.reset}`);
				console.log(
					`    🔍 Retrieval (45%):   ${truncateName(bestRetr.modelId, 25)} (${fmtPct(bestRetr.retrieval.combined)})`,
				);
				console.log(
					`    🎯 Contrastive (30%): ${truncateName(bestContr.modelId, 25)} (${fmtPct(bestContr.contrastive.combined)})`,
				);
				console.log(
					`    📋 Judge (25%):       ${truncateName(bestJudge.modelId, 25)} (${fmtPct(bestJudge.judge.combined)})`,
				);

				// Find best operational metrics
				const fastestModel = scoreArray.reduce((a, b) => {
					const latA = latencyByModel.get(a.modelId) || Infinity;
					const latB = latencyByModel.get(b.modelId) || Infinity;
					return latA < latB ? a : b;
				});
				const cheapestModel = scoreArray.reduce((a, b) => {
					const costA = costByModel.get(a.modelId) || Infinity;
					const costB = costByModel.get(b.modelId) || Infinity;
					// Skip local and subscription models for cost comparison (no per-call billing)
					if (isLocalModel(a.modelId) || isSubscriptionModel(a.modelId))
						return b;
					if (isLocalModel(b.modelId) || isSubscriptionModel(b.modelId))
						return a;
					return costA < costB ? a : b;
				});

				console.log();
				console.log(`  ${c.cyan}Operational leaders:${c.reset}`);
				const fastestLatency = latencyByModel.get(fastestModel.modelId) || 0;
				console.log(
					`    ⚡ Fastest:  ${truncateName(fastestModel.modelId, 25)} (${fmtLatency(fastestLatency)})`,
				);
				const cheapestCost = costByModel.get(cheapestModel.modelId) || 0;
				// Only show cheapest if there's a model with actual per-call billing
				if (
					!isLocalModel(cheapestModel.modelId) &&
					!isSubscriptionModel(cheapestModel.modelId)
				) {
					console.log(
						`    💰 Cheapest: ${truncateName(cheapestModel.modelId, 25)} (${fmtCost(cheapestCost)})`,
					);
				}
			}

			console.log();
			renderSuccess("Benchmark complete!");
			console.log();
			renderInfo("Reports:");
			if (result.outputFiles.json) {
				console.log(
					`  ${c.cyan}JSON:${c.reset}     ${result.outputFiles.json}`,
				);
			}
			if (result.outputFiles.markdown) {
				console.log(
					`  ${c.cyan}Markdown:${c.reset} ${result.outputFiles.markdown}`,
				);
			}
			if (result.outputFiles.html) {
				console.log(
					`  ${c.cyan}HTML:${c.reset}     ${result.outputFiles.html}`,
				);
			}

			// Upload results to Firebase (unless --no-upload flag is set)
			if (scores.size > 0 && !noUpload) {
				try {
					const { uploadBenchmarkResults } = await import(
						"./firebase/index.js"
					);
					const { detectCodebaseType } = await import("./codebase-detector.js");

					const projectName = projectPath.split("/").pop() || "unknown";

					// Detect codebase type for categorization
					const codebaseType = await detectCodebaseType(projectPath);

					// Calculate total benchmark duration
					const totalDuration = Date.now() - benchmarkStartTime;

					// Calculate total cost
					let totalBenchCost = 0;
					for (const cost of costByModel.values()) {
						totalBenchCost += cost;
					}

					renderInfo(`Uploading to Firebase (${codebaseType.label})...`);
					const uploadResult = await uploadBenchmarkResults(
						result.run.id,
						projectName,
						projectPath,
						{
							language: codebaseType.language,
							category: codebaseType.category,
							stack: codebaseType.stack,
							label: codebaseType.label,
							tags: codebaseType.tags,
						},
						generatorSpecs,
						judgeModels,
						targetCount,
						totalDuration,
						totalBenchCost,
						scores,
						latencyByModel,
						costByModel,
					);

					if (uploadResult.success) {
						console.log(`  ${c.green}✓${c.reset} Results uploaded to Firebase`);
					} else {
						console.log(
							`  ${c.yellow}⚠${c.reset} Firebase upload failed: ${uploadResult.error}`,
						);
					}
				} catch (error) {
					// Firebase upload is optional - don't fail the benchmark
					console.log(
						`  ${c.dim}Firebase upload skipped: ${error instanceof Error ? error.message : error}${c.reset}`,
					);
				}
			}

			console.log();

			// Force exit - Firebase SDK keeps connection open
			process.exit(0);
		} else {
			console.log();
			renderError("Benchmark failed");
			console.error(`${c.dim}${result.error}${c.reset}\n`);
			process.exit(1);
		}
	} catch (error) {
		console.log();
		renderError("Benchmark error");
		console.error(
			`${c.dim}${error instanceof Error ? error.message : error}${c.reset}\n`,
		);
		process.exit(1);
	}
}
