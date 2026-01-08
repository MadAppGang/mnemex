/**
 * Iterative Refinement Evaluator
 *
 * Evaluates how well models can improve their summaries through iterative refinement.
 * Uses feedback from quality testing (e.g., retrieval ranking) to guide improvement.
 *
 * Inspired by Brokk's edit-test loop where models get up to N attempts to
 * improve their output based on test feedback.
 *
 * Flow:
 * 1. Test initial summary quality (retrieval rank)
 * 2. If rank > target, provide feedback and ask model to refine
 * 3. Repeat until success or max rounds reached
 * 4. Score using Brokk-style formula: 1.0 / log2(rounds + 2)
 */

import { randomUUID } from "crypto";
import type { ILLMClient, IEmbeddingsClient } from "../../../types.js";
import type {
	BenchmarkCodeUnit,
	GeneratedSummary,
	EvaluationResult,
	IterativeResults,
} from "../../types.js";
import type { PhaseContext, PhaseResult } from "../../pipeline/orchestrator.js";
import {
	createRefinementEngine,
	createRetrievalStrategy,
	type RefinementContext,
	type RefinementResult,
	calculateRefinementScore,
} from "../../../core/enrichment/refinement/index.js";
import {
	MaxTokensError,
	ContentFilterError,
	RateLimitError,
} from "../../../llm/providers/openrouter.js";

// ============================================================================
// Pre-computed Embeddings Cache
// ============================================================================

/**
 * Cache for pre-computed embeddings to avoid model switching in LMStudio
 *
 * LMStudio swaps models when alternating between embedding and LLM calls.
 * By pre-embedding everything upfront, we minimize model switches:
 * 1. Load embedding model → embed all summaries and queries in batch
 * 2. Unload embedding model → load LLM → run all refinements
 * 3. Only re-embed refined summaries when needed
 */
interface EmbeddingCache {
	/** Summary embeddings by summary ID */
	summaries: Map<string, number[]>;
	/** Query embeddings by code unit ID */
	queries: Map<string, { query: string; embedding: number[] }>;
}

/**
 * Generate a simple query for a code unit (same logic as retrieval strategy)
 */
function generateQueryForCodeUnit(codeUnit: BenchmarkCodeUnit): string {
	if (codeUnit.name) {
		return `${codeUnit.type || "code"} ${codeUnit.name} ${codeUnit.language}`;
	}
	if (codeUnit.path) {
		const filename = codeUnit.path.split("/").pop() || codeUnit.path;
		return `${filename} ${codeUnit.language}`;
	}
	return `${codeUnit.language} code`;
}

/**
 * Pre-embed all summaries and queries in batches
 * This loads the embedding model ONCE and processes everything
 */
async function preEmbedAll(
	summaries: GeneratedSummary[],
	codeUnits: BenchmarkCodeUnit[],
	embeddingsClient: IEmbeddingsClient,
	onProgress?: (msg: string) => void,
): Promise<EmbeddingCache> {
	const cache: EmbeddingCache = {
		summaries: new Map(),
		queries: new Map(),
	};

	// Batch embed all summaries
	onProgress?.("Pre-embedding summaries...");
	const summaryTexts = summaries.map((s) => s.summary);
	if (summaryTexts.length > 0) {
		const result = await embeddingsClient.embed(summaryTexts);
		for (let i = 0; i < summaries.length; i++) {
			cache.summaries.set(summaries[i].id, result.embeddings[i]);
		}
	}

	// Generate and embed queries for each code unit
	onProgress?.("Pre-embedding queries...");
	const queryTexts: string[] = [];
	const codeUnitIds: string[] = [];
	for (const unit of codeUnits) {
		const query = generateQueryForCodeUnit(unit);
		queryTexts.push(query);
		codeUnitIds.push(unit.id);
	}

	if (queryTexts.length > 0) {
		const result = await embeddingsClient.embed(queryTexts);
		for (let i = 0; i < codeUnits.length; i++) {
			cache.queries.set(codeUnitIds[i], {
				query: queryTexts[i],
				embedding: result.embeddings[i],
			});
		}
	}

	onProgress?.(
		`Pre-embedded ${summaryTexts.length} summaries, ${queryTexts.length} queries`,
	);
	return cache;
}

// ============================================================================
// Adapter: Convert benchmark context to refinement context
// ============================================================================

/**
 * Build refinement context from benchmark data
 * Uses pre-computed embeddings from cache to avoid model switching
 */
function buildRefinementContext(
	summary: GeneratedSummary,
	codeUnit: BenchmarkCodeUnit,
	allSummaries: Map<string, GeneratedSummary[]>,
	currentModelId: string,
	embeddingCache?: EmbeddingCache,
): RefinementContext {
	// Collect competitor summaries (same code unit, different models)
	const competitors: RefinementContext["competitors"] = [];

	for (const [modelId, summaries] of allSummaries) {
		if (modelId === currentModelId) continue;

		const competitorSummary = summaries.find(
			(s) => s.codeUnitId === codeUnit.id,
		);
		if (competitorSummary) {
			competitors.push({
				summary: competitorSummary.summary,
				modelId,
				// Include pre-computed embedding if available
				embedding: embeddingCache?.summaries.get(competitorSummary.id),
			});
		}
	}

	// Get pre-computed query if available
	const cachedQuery = embeddingCache?.queries.get(codeUnit.id);

	return {
		summary: summary.summary,
		// Include pre-computed embedding for the initial summary (avoids re-embedding)
		summaryEmbedding: embeddingCache?.summaries.get(summary.id),
		codeContent: codeUnit.content,
		language: codeUnit.language,
		metadata: {
			filePath: codeUnit.path,
			symbolName: codeUnit.name,
			symbolType: codeUnit.type,
			codeUnitId: codeUnit.id,
		},
		competitors,
		// Use pre-computed query if available
		queries: cachedQuery ? [cachedQuery.query] : undefined,
	};
}

/**
 * Convert refinement result to evaluation result
 */
function toEvaluationResult(
	summaryId: string,
	modelId: string,
	codeUnitId: string,
	result: RefinementResult,
	strategyName: string,
): EvaluationResult {
	const iterativeResults: IterativeResults = {
		modelId,
		codeUnitId,
		rounds: result.rounds,
		success: result.success,
		initialRank: result.metrics.initialRank,
		finalRank: result.metrics.finalRank,
		refinementScore: result.metrics.refinementScore,
		history: result.history.map((h) => ({
			round: h.round,
			rank: h.testResult.rank,
			passed: h.testResult.passed,
			summary: h.summary,
		})),
		strategyName,
		refinedSummary: result.rounds > 0 ? result.finalSummary : undefined,
		durationMs: result.metrics.totalDurationMs,
	};

	return {
		id: randomUUID(),
		summaryId,
		evaluationType: "iterative",
		iterativeResults,
		evaluatedAt: new Date().toISOString(),
	};
}

// ============================================================================
// Phase Executor
// ============================================================================

/**
 * Create the iterative refinement evaluation phase executor
 *
 * This phase:
 * 1. Takes all generated summaries
 * 2. For each summary, tests retrieval quality
 * 3. If quality is poor, refines with feedback (up to maxRounds)
 * 4. Stores the best summary and scores based on rounds needed
 */
export function createIterativePhaseExecutor(
	generatorClients: Map<string, ILLMClient>,
	embeddingsClient: IEmbeddingsClient,
): (context: PhaseContext) => Promise<PhaseResult> {
	return async (context: PhaseContext): Promise<PhaseResult> => {
		const { db, run, config, stateMachine } = context;
		const evalConfig = config.evaluation.iterative;

		if (!evalConfig?.enabled) {
			return {
				success: true,
				itemsProcessed: 0,
				skipReason: "Iterative refinement disabled",
			};
		}

		try {
			// Get data
			const allSummaries = db.getSummaries(run.id);
			const codeUnits = db.getCodeUnits(run.id);

			// Resume support: get existing evaluation results
			const existingResults = db.getEvaluationResults(run.id, "iterative");
			const evaluatedIterative = new Set<string>(); // key: summaryId
			for (const result of existingResults) {
				if (result.iterativeResults) {
					evaluatedIterative.add(result.summaryId);
				}
			}

			// Group summaries by model
			const allSummariesByModel = new Map<string, GeneratedSummary[]>();
			for (const summary of allSummaries) {
				if (!allSummariesByModel.has(summary.modelId)) {
					allSummariesByModel.set(summary.modelId, []);
				}
				allSummariesByModel.get(summary.modelId)!.push(summary);
			}

			// Sample summaries per model (refinement is expensive, limit to sampleSize)
			const sampleSize = evalConfig.sampleSize || 10;
			const summariesByModel = new Map<string, GeneratedSummary[]>();
			for (const [modelId, modelSummaries] of allSummariesByModel) {
				if (modelSummaries.length <= sampleSize) {
					summariesByModel.set(modelId, modelSummaries);
				} else {
					// Random sample - shuffle and take first N
					const shuffled = [...modelSummaries].sort(() => Math.random() - 0.5);
					summariesByModel.set(modelId, shuffled.slice(0, sampleSize));
				}
			}

			// Flatten sampled summaries for embedding
			const summaries = Array.from(summariesByModel.values()).flat();

			// Create code unit lookup
			const codeUnitMap = new Map(codeUnits.map((u) => [u.id, u]));

			// Calculate total work: each model × sampled items
			const totalItems = summaries.length;
			let completed = 0;

			if (process.env.DEBUG_PROGRESS) {
				console.error(
					`[Iterative] Starting phase with ${totalItems} items (${summariesByModel.size} models)`,
				);
			}
			stateMachine.startPhase("evaluation:iterative", totalItems);

			// Create refinement engine and strategy
			const engine = createRefinementEngine();
			const strategy = createRetrievalStrategy({
				embeddingsClient,
				targetRank: evalConfig.targetRank,
			});

			// Pre-embed ALL summaries and queries upfront
			// This is critical for performance because:
			// 1. Batches embedding calls together (more efficient)
			// 2. Avoids re-embedding initial summaries during testQuality()
			// 3. Avoids re-embedding queries and competitors on each test
			// 4. If embedding model is local (LMStudio), avoids model switching
			stateMachine.updateProgress(
				"evaluation:iterative",
				0,
				undefined,
				"Pre-embedding summaries and queries...",
			);
			// Embed ALL summaries (not just sampled) because competitors need embeddings too
			const embeddingCache = await preEmbedAll(
				allSummaries,
				codeUnits,
				embeddingsClient,
				(msg) =>
					stateMachine.updateProgress(
						"evaluation:iterative",
						0,
						undefined,
						msg,
					),
			);

			// Set query embeddings cache on strategy
			const queryEmbedCache = new Map<string, number[]>();
			for (const [codeUnitId, data] of embeddingCache.queries) {
				queryEmbedCache.set(codeUnitId, data.embedding);
			}
			strategy.setQueryEmbeddingsCache(queryEmbedCache);

			// Track stats for reporting
			const stats = {
				totalRefined: 0,
				successCount: 0,
				avgRounds: 0,
				roundsSum: 0,
			};

			const failures: PhaseResult["failures"] = [];

			// Timeout configuration per model type
			// These patterns should match THINKING_MODEL_PATTERNS in openrouter.ts
			const DEFAULT_TIMEOUT_MS = 120_000; // 2 minutes for regular models
			const THINKING_TIMEOUT_MS = 600_000; // 10 minutes for thinking models
			const SLOW_MODEL_PATTERNS = [
				// Thinking/reasoning models
				"thinking",
				"kimi",
				"o1-",
				"o3-",
				"deepseek-r1",
				"qwq",
				// Models from error logs that frequently timeout
				"nemotron",
				"trinity",
				"olmo",
			];

			const isSlowModel = (modelId: string): boolean =>
				SLOW_MODEL_PATTERNS.some((p) => modelId.toLowerCase().includes(p));

			const getTimeoutForModel = (modelId: string): number =>
				isSlowModel(modelId) ? THINKING_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;

			// Timeout wrapper
			const withTimeout = <T>(
				promise: Promise<T>,
				timeoutMs: number,
			): Promise<T> => {
				return Promise.race([
					promise,
					new Promise<T>((_, reject) =>
						setTimeout(
							() =>
								reject(new Error(`Refinement timeout after ${timeoutMs}ms`)),
							timeoutMs,
						),
					),
				]);
			};

			// Separate cloud and local models
			const cloudModels: string[] = [];
			const localModels: string[] = [];
			for (const modelId of summariesByModel.keys()) {
				const isLocal =
					modelId.startsWith("lmstudio/") || modelId.startsWith("ollama/");
				if (isLocal) {
					localModels.push(modelId);
				} else {
					cloudModels.push(modelId);
				}
			}

			// Per-model progress tracking
			const modelProgress = new Map<
				string,
				{
					completed: number;
					total: number;
					inProgress: number;
					failures: number;
				}
			>();

			// Initialize progress for all models
			for (const [modelId, modelSummaries] of summariesByModel) {
				modelProgress.set(modelId, {
					completed: 0,
					total: modelSummaries.length,
					inProgress: 0,
					failures: 0,
				});
			}

			// Debug: log the model IDs being tracked
			if (process.env.DEBUG_PROGRESS) {
				const modelIds = Array.from(summariesByModel.keys());
				console.error(
					`[Iterative] Tracking ${modelIds.length} models: ${modelIds.join(", ")}`,
				);
			}

			// Helper to report per-model progress
			const reportModelProgress = (modelId: string) => {
				const p = modelProgress.get(modelId)!;
				stateMachine.updateProgress(
					"evaluation:iterative",
					completed,
					undefined,
					`${modelId}: ${p.completed}/${p.total}/${p.inProgress}/${p.failures}`,
				);
			};

			// Process a single model's summaries
			const processModel = async (modelId: string) => {
				const modelSummaries = summariesByModel.get(modelId)!;
				const client = generatorClients.get(modelId);

				if (!client) {
					failures.push({
						model: modelId,
						count: modelSummaries.length,
						error: `No LLM client for model ${modelId}`,
					});
					const p = modelProgress.get(modelId)!;
					p.completed = modelSummaries.length;
					p.failures = modelSummaries.length;
					completed += modelSummaries.length;
					reportModelProgress(modelId);
					return;
				}

				// Process summaries one at a time for this model
				for (const summary of modelSummaries) {
					const p = modelProgress.get(modelId)!;

					// Resume support: skip already evaluated
					if (evaluatedIterative.has(summary.id)) {
						p.completed++;
						completed++;
						reportModelProgress(modelId);
						continue;
					}

					p.inProgress++;
					reportModelProgress(modelId);

					const codeUnit = codeUnitMap.get(summary.codeUnitId);
					if (!codeUnit) {
						p.inProgress--;
						p.completed++;
						completed++;
						reportModelProgress(modelId);
						continue;
					}

					try {
						// Build refinement context (with pre-computed embeddings for local models)
						// Use allSummariesByModel for competitors (fair competition across all models)
						const refinementContext = buildRefinementContext(
							summary,
							codeUnit,
							allSummariesByModel,
							modelId,
							embeddingCache,
						);

						// Run refinement with timeout protection
						// Thinking models can take 5+ minutes per refinement round
						const timeoutMs = getTimeoutForModel(modelId);
						const result = await withTimeout(
							engine.refine(summary.summary, refinementContext, {
								maxRounds: evalConfig.maxRounds,
								strategy,
								llmClient: client,
							}),
							timeoutMs,
						);

						// Track stats
						stats.totalRefined++;
						stats.roundsSum += result.rounds;
						if (result.success) stats.successCount++;

						// Store result
						const evalResult = toEvaluationResult(
							summary.id,
							modelId,
							codeUnit.id,
							result,
							strategy.getName(),
						);
						db.insertEvaluationResult(run.id, evalResult);

						// If refinement improved the summary, update it in the database
						if (result.rounds > 0 && result.success) {
							db.updateSummary(run.id, summary.id, {
								summary: result.finalSummary,
								generationMetadata: {
									...summary.generationMetadata,
									// @ts-ignore - extending metadata
									refinementRound: result.rounds,
								},
							});
						}
					} catch (error) {
						// Categorize error for better reporting
						let errorType: string;
						let message: string;

						if (error instanceof MaxTokensError) {
							errorType = "max_tokens";
							message = error.message;
						} else if (error instanceof ContentFilterError) {
							errorType = "content_filter";
							message = error.message;
						} else if (error instanceof RateLimitError) {
							errorType = "rate_limit";
							message = error.message;
						} else if (
							error instanceof Error &&
							error.message.includes("timeout")
						) {
							errorType = "timeout";
							message = error.message;
						} else {
							errorType = "unknown";
							message = error instanceof Error ? error.message : String(error);
						}

						failures.push({
							model: modelId,
							count: 1,
							error: `[${errorType}] ${message}`,
						});
						p.failures++;
					} finally {
						p.inProgress--;
						p.completed++;
						completed++;
						reportModelProgress(modelId);
					}
				}
			};

			// Create cloud models stream (all run in parallel)
			const runCloudModels = async () => {
				if (cloudModels.length === 0) return;
				await Promise.all(cloudModels.map(processModel));
			};

			// Create local models stream (respects localModelParallelism + large model isolation)
			const runLocalModels = async () => {
				if (localModels.length === 0) return;

				const localParallelism = config.localModelParallelism ?? 1;
				const largeModelThreshold = config.largeModelThreshold ?? 20;
				const debug = process.env.DEBUG_MODEL_SIZE === "1";

				// If threshold is 0, skip size-based isolation
				if (largeModelThreshold === 0) {
					if (
						localParallelism === 0 ||
						localParallelism >= localModels.length
					) {
						await Promise.all(localModels.map(processModel));
					} else if (localParallelism === 1) {
						for (const modelId of localModels) {
							await processModel(modelId);
						}
					} else {
						for (let i = 0; i < localModels.length; i += localParallelism) {
							const batch = localModels.slice(i, i + localParallelism);
							await Promise.all(batch.map(processModel));
						}
					}
					return;
				}

				// Query model sizes to separate large from small
				if (debug)
					console.error(
						`[Iterative] Querying sizes for ${localModels.length} local models, threshold=${largeModelThreshold}B`,
					);
				const modelSizes = new Map<string, number | undefined>();

				await Promise.all(
					localModels.map(async (modelId) => {
						const client = generatorClients.get(modelId);
						if (client && typeof client.getModelSizeB === "function") {
							try {
								const size = await client.getModelSizeB();
								modelSizes.set(modelId, size);
								if (debug)
									console.error(
										`[Iterative] ${modelId} → ${size ?? "unknown"}B ${size !== undefined && size >= largeModelThreshold ? "(LARGE)" : "(small)"}`,
									);
							} catch {
								modelSizes.set(modelId, undefined);
							}
						}
					}),
				);

				// Separate large models (>= threshold) from small models
				const largeModels: string[] = [];
				const smallModels: string[] = [];

				for (const modelId of localModels) {
					const size = modelSizes.get(modelId);
					if (size !== undefined && size >= largeModelThreshold) {
						largeModels.push(modelId);
					} else {
						smallModels.push(modelId);
					}
				}

				// Run large models sequentially first (they need full GPU memory)
				for (const modelId of largeModels) {
					await processModel(modelId);
				}

				// Then run small models with configured parallelism
				if (smallModels.length > 0) {
					if (
						localParallelism === 0 ||
						localParallelism >= smallModels.length
					) {
						await Promise.all(smallModels.map(processModel));
					} else if (localParallelism === 1) {
						for (const modelId of smallModels) {
							await processModel(modelId);
						}
					} else {
						for (let i = 0; i < smallModels.length; i += localParallelism) {
							const batch = smallModels.slice(i, i + localParallelism);
							await Promise.all(batch.map(processModel));
						}
					}
				}
			};

			// Run BOTH streams in parallel - cloud and local don't block each other
			await Promise.all([runCloudModels(), runLocalModels()]);

			// Calculate final stats
			stats.avgRounds =
				stats.totalRefined > 0 ? stats.roundsSum / stats.totalRefined : 0;

			return {
				success: true,
				itemsProcessed: completed,
				failures: failures.length > 0 ? failures : undefined,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				success: false,
				itemsProcessed: 0,
				error: message,
			};
		}
	};
}

// ============================================================================
// Aggregation Helper
// ============================================================================

export interface IterativeMetrics {
	modelId: string;
	/** Average refinement rounds needed */
	avgRounds: number;
	/** Success rate (achieved target rank) */
	successRate: number;
	/** Average Brokk score (penalized by rounds) */
	avgRefinementScore: number;
	/** Average rank improvement */
	avgRankImprovement: number;
	/** Breakdown by initial rank */
	byInitialRank: Map<number, { count: number; avgRoundsToSuccess: number }>;
	/** Total summaries evaluated */
	totalEvaluated: number;
}

/**
 * Aggregate iterative refinement results for a model
 */
export function aggregateIterativeResults(
	results: EvaluationResult[],
	modelId: string,
): IterativeMetrics {
	const iterativeResults = results.filter(
		(r) =>
			r.evaluationType === "iterative" &&
			r.iterativeResults?.modelId === modelId,
	);

	if (iterativeResults.length === 0) {
		return {
			modelId,
			avgRounds: 0,
			successRate: 0,
			avgRefinementScore: 0,
			avgRankImprovement: 0,
			byInitialRank: new Map(),
			totalEvaluated: 0,
		};
	}

	let roundsSum = 0;
	let successCount = 0;
	let scoreSum = 0;
	let improvementSum = 0;
	const byInitialRank = new Map<
		number,
		{ count: number; roundsSum: number; successCount: number }
	>();

	for (const result of iterativeResults) {
		const ir = result.iterativeResults!;

		roundsSum += ir.rounds;
		if (ir.success) successCount++;
		scoreSum += ir.refinementScore;

		// Calculate improvement
		if (ir.initialRank !== null && ir.finalRank !== null) {
			improvementSum += ir.initialRank - ir.finalRank;
		}

		// Track by initial rank
		if (ir.initialRank !== null) {
			const existing = byInitialRank.get(ir.initialRank) || {
				count: 0,
				roundsSum: 0,
				successCount: 0,
			};
			existing.count++;
			if (ir.success) {
				existing.roundsSum += ir.rounds;
				existing.successCount++;
			}
			byInitialRank.set(ir.initialRank, existing);
		}
	}

	const n = iterativeResults.length;

	// Convert byInitialRank to final format
	const finalByInitialRank = new Map<
		number,
		{ count: number; avgRoundsToSuccess: number }
	>();
	for (const [rank, data] of byInitialRank) {
		finalByInitialRank.set(rank, {
			count: data.count,
			avgRoundsToSuccess:
				data.successCount > 0 ? data.roundsSum / data.successCount : 0,
		});
	}

	return {
		modelId,
		avgRounds: roundsSum / n,
		successRate: successCount / n,
		avgRefinementScore: scoreSum / n,
		avgRankImprovement: improvementSum / n,
		byInitialRank: finalByInitialRank,
		totalEvaluated: n,
	};
}
