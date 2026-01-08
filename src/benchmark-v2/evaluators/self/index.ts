/**
 * Self-Evaluation Evaluator
 *
 * Tests whether a generating model can effectively use its own summaries.
 * This measures "internal consistency" - does the model understand what it wrote?
 *
 * Tasks:
 * - Self-Retrieval: Given a query, can the model identify which of its summaries
 *   describes the target code (vs distractors)?
 * - Self-Completion: Given its own summary, can the model complete related code?
 * - Self-Function-Selection: Given a task, can the model pick the right function
 *   using only its own summaries?
 */

import { randomUUID } from "crypto";
import type { ILLMClient } from "../../../types.js";
import type {
	BenchmarkCodeUnit,
	GeneratedSummary,
	GeneratedQuery,
	EvaluationResult,
	SelfEvalTaskType,
} from "../../types.js";
import type { PhaseContext, PhaseResult } from "../../pipeline/orchestrator.js";

// ============================================================================
// Self-Retrieval Evaluator
// ============================================================================

interface SelfRetrievalTask {
	query: GeneratedQuery;
	targetSummary: GeneratedSummary;
	distractorSummaries: GeneratedSummary[];
	targetCode: BenchmarkCodeUnit;
}

const SELF_RETRIEVAL_PROMPT = `You are testing whether a code summary accurately describes a piece of code.

Given a search query and several code summaries, determine which summary best matches the query.

## Query
{query}

## Summaries
{summaries}

## Instructions
1. Read each summary carefully
2. Determine which summary best answers the search query
3. Respond with JSON only:

{
  "selectedIndex": <0-based index of the best matching summary>,
  "confidence": <0.0-1.0 how confident you are>,
  "reasoning": "<brief explanation>"
}`;

/**
 * Evaluate self-retrieval: can the model find the right code using its own summary?
 */
async function evaluateSelfRetrieval(
	client: ILLMClient,
	modelId: string,
	task: SelfRetrievalTask,
): Promise<EvaluationResult> {
	// Shuffle summaries (target + distractors) to avoid position bias
	const allSummaries = [task.targetSummary, ...task.distractorSummaries];
	const shuffled = [...allSummaries].sort(() => Math.random() - 0.5);
	const targetIndex = shuffled.findIndex((s) => s.id === task.targetSummary.id);

	// Build prompt
	const summariesText = shuffled
		.map((s, i) => `[${i}] ${s.summary}`)
		.join("\n\n");

	const prompt = SELF_RETRIEVAL_PROMPT.replace(
		"{query}",
		task.query.query,
	).replace("{summaries}", summariesText);

	try {
		const response = await client.completeJSON<{
			selectedIndex?: number;
			selected_index?: number;
			confidence?: number;
			reasoning?: string;
		}>([{ role: "user", content: prompt }], { maxTokens: 500 });

		// Handle various field name conventions (common with local models)
		// biome-ignore lint: we need to access dynamic properties
		const resp = response as Record<string, unknown>;
		const rawIndex =
			resp.selectedIndex ??
			resp.selected_index ??
			resp.index ??
			resp.selection ??
			resp.choice;
		const confidence = (resp.confidence as number) ?? 0;
		const reasoning = (resp.reasoning as string) ?? "No reasoning provided";

		// Parse selectedIndex - models often return it as a string
		let selectedIndex: number;
		if (typeof rawIndex === "number") {
			selectedIndex = rawIndex;
		} else if (typeof rawIndex === "string") {
			selectedIndex = parseInt(rawIndex, 10);
			if (isNaN(selectedIndex)) {
				throw new Error(
					`Invalid response: selectedIndex "${rawIndex}" is not a number. Response: ${JSON.stringify(response).slice(0, 100)}`,
				);
			}
		} else {
			throw new Error(
				`Invalid response: missing selectedIndex. Response: ${JSON.stringify(response).slice(0, 100)}`,
			);
		}

		const correct = selectedIndex === targetIndex;

		return {
			id: randomUUID(),
			summaryId: task.targetSummary.id,
			evaluationType: "self",
			selfEvaluationResults: {
				generatingModelId: modelId,
				taskType: "retrieval",
				retrievalResults: {
					queryId: task.query.id,
					query: task.query.query,
					correct,
					confidence,
					reasoning,
				},
			},
			evaluatedAt: new Date().toISOString(),
		};
	} catch (error) {
		// Don't log to console - failures are tracked and displayed via phaseFailures
		const errMsg = error instanceof Error ? error.message : String(error);
		// Return failure result with error in reasoning (will be tracked by parent)
		return {
			id: randomUUID(),
			summaryId: task.targetSummary.id,
			evaluationType: "self",
			selfEvaluationResults: {
				generatingModelId: modelId,
				taskType: "retrieval",
				retrievalResults: {
					queryId: task.query.id,
					query: task.query.query,
					correct: false,
					confidence: 0,
					reasoning: `Error: ${errMsg.slice(0, 300)}`,
				},
			},
			evaluatedAt: new Date().toISOString(),
		};
	}
}

// ============================================================================
// Self-Function-Selection Evaluator
// ============================================================================

const SELF_FUNCTION_SELECTION_PROMPT = `You are testing whether code summaries help identify the right function for a task.

## Task Description
{taskDescription}

## Available Functions (by their summaries)
{summaries}

## Instructions
Select which function best accomplishes the task based on the summaries.
Respond with JSON only:

{
  "selectedIndex": <0-based index of the best function>,
  "confidence": <0.0-1.0>,
  "reasoning": "<brief explanation>"
}`;

interface FunctionSelectionTask {
	taskDescription: string;
	targetSummary: GeneratedSummary;
	distractorSummaries: GeneratedSummary[];
	targetFunctionName: string;
}

async function evaluateSelfFunctionSelection(
	client: ILLMClient,
	modelId: string,
	task: FunctionSelectionTask,
): Promise<EvaluationResult> {
	const allSummaries = [task.targetSummary, ...task.distractorSummaries];
	const shuffled = [...allSummaries].sort(() => Math.random() - 0.5);
	const targetIndex = shuffled.findIndex((s) => s.id === task.targetSummary.id);

	const summariesText = shuffled
		.map((s, i) => `[${i}] ${s.summary}`)
		.join("\n\n");

	const prompt = SELF_FUNCTION_SELECTION_PROMPT.replace(
		"{taskDescription}",
		task.taskDescription,
	).replace("{summaries}", summariesText);

	try {
		const response = await client.completeJSON<{
			selectedIndex?: number;
			selected_index?: number;
			confidence?: number;
			reasoning?: string;
		}>([{ role: "user", content: prompt }], { maxTokens: 500 });

		// Handle various field name conventions (common with local models)
		// biome-ignore lint: we need to access dynamic properties
		const resp = response as Record<string, unknown>;
		const rawIndex =
			resp.selectedIndex ??
			resp.selected_index ??
			resp.index ??
			resp.selection ??
			resp.choice;
		const reasoning = (resp.reasoning as string) ?? "No reasoning provided";

		// Parse selectedIndex - models often return it as a string
		let selectedIndex: number;
		if (typeof rawIndex === "number") {
			selectedIndex = rawIndex;
		} else if (typeof rawIndex === "string") {
			selectedIndex = parseInt(rawIndex, 10);
			if (isNaN(selectedIndex)) {
				throw new Error(
					`Invalid response: selectedIndex "${rawIndex}" is not a number. Response: ${JSON.stringify(response).slice(0, 100)}`,
				);
			}
		} else {
			throw new Error(
				`Invalid response: missing selectedIndex. Response: ${JSON.stringify(response).slice(0, 100)}`,
			);
		}

		const correct = selectedIndex === targetIndex;

		return {
			id: randomUUID(),
			summaryId: task.targetSummary.id,
			evaluationType: "self",
			selfEvaluationResults: {
				generatingModelId: modelId,
				taskType: "function_selection",
				functionSelectionResults: {
					taskId: randomUUID(),
					correct,
					selectedFunction:
						shuffled[selectedIndex]?.summary.slice(0, 50) || "unknown",
					reasoning,
				},
			},
			evaluatedAt: new Date().toISOString(),
		};
	} catch (error) {
		// Don't log to console - failures are tracked and displayed via phaseFailures
		const errMsg = error instanceof Error ? error.message : String(error);
		return {
			id: randomUUID(),
			summaryId: task.targetSummary.id,
			evaluationType: "self",
			selfEvaluationResults: {
				generatingModelId: modelId,
				taskType: "function_selection",
				functionSelectionResults: {
					taskId: randomUUID(),
					correct: false,
					selectedFunction: "error",
					reasoning: `Error: ${error instanceof Error ? error.message : String(error)}`,
				},
			},
			evaluatedAt: new Date().toISOString(),
		};
	}
}

// ============================================================================
// Phase Executor
// ============================================================================

/**
 * Create the self-evaluation phase executor
 *
 * For each generating model, uses THAT model to test its own summaries.
 * This measures internal consistency - can the model use what it wrote?
 */
export function createSelfEvaluationPhaseExecutor(
	generatorClients: Map<string, ILLMClient>,
): (context: PhaseContext) => Promise<PhaseResult> {
	return async (context: PhaseContext): Promise<PhaseResult> => {
		const { db, run, config, stateMachine } = context;
		const evalConfig = config.evaluation.self;

		if (!evalConfig?.enabled) {
			return {
				success: true,
				itemsProcessed: 0,
				skipReason: "Self-evaluation disabled",
			};
		}

		try {
			// Get summaries and code units
			const summaries = db.getSummaries(run.id);
			const codeUnits = db.getCodeUnits(run.id);
			const queries = db.getQueries(run.id);

			// Group summaries by model
			const summariesByModel = new Map<string, GeneratedSummary[]>();
			for (const summary of summaries) {
				if (!summariesByModel.has(summary.modelId)) {
					summariesByModel.set(summary.modelId, []);
				}
				summariesByModel.get(summary.modelId)!.push(summary);
			}

			// Calculate per-model work
			const tasksToRun = evalConfig.tasks || ["retrieval"];
			const queriesPerModel = Math.min(
				queries.length,
				codeUnits.length * (evalConfig.queriesPerUnit || 2),
			);
			const tasksPerQuery = tasksToRun.length;

			// Calculate total items
			let totalItems = 0;
			for (const [modelId] of generatorClients) {
				const modelSummaries = summariesByModel.get(modelId) || [];
				if (modelSummaries.length > 0) {
					totalItems += queriesPerModel * tasksPerQuery;
				}
			}

			stateMachine.startPhase("evaluation:self", totalItems);

			let completed = 0;
			const CONCURRENCY = 10;
			const failures: PhaseResult["failures"] = [];

			// Separate cloud and local models
			const cloudModels: string[] = [];
			const localModels: string[] = [];
			for (const modelId of generatorClients.keys()) {
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
					lastError: string;
				}
			>();

			// Initialize progress for all models
			for (const [modelId] of generatorClients) {
				const modelSummaries = summariesByModel.get(modelId) || [];
				const total =
					modelSummaries.length > 0 ? queriesPerModel * tasksPerQuery : 0;
				modelProgress.set(modelId, {
					completed: 0,
					total,
					inProgress: 0,
					failures: 0,
					lastError: "",
				});
			}

			// Helper to report per-model progress (format: model: completed/total/inProgress/failures|error)
			const reportModelProgress = (modelId: string) => {
				const p = modelProgress.get(modelId)!;
				const details = p.lastError
					? `${modelId}: ${p.completed}/${p.total}/${p.inProgress}/${p.failures}|${p.lastError}`
					: `${modelId}: ${p.completed}/${p.total}/${p.inProgress}/${p.failures}`;
				stateMachine.updateProgress(
					"evaluation:self",
					completed,
					undefined,
					details,
				);
			};

			// Process a single model
			const processModel = async (modelId: string) => {
				const client = generatorClients.get(modelId)!;
				const modelSummaries = summariesByModel.get(modelId) || [];
				if (modelSummaries.length === 0) return;

				const p = modelProgress.get(modelId)!;

				// Create lookup for model's summaries by code unit
				const summaryByCodeUnit = new Map(
					modelSummaries.map((s) => [s.codeUnitId, s]),
				);
				const codeUnitMap = new Map(codeUnits.map((u) => [u.id, u]));

				// Get queries that have corresponding summaries
				const relevantQueries = queries.filter((q) =>
					summaryByCodeUnit.has(q.codeUnitId),
				);
				const selectedQueries = relevantQueries.slice(0, queriesPerModel);

				// Process queries in batches
				for (let i = 0; i < selectedQueries.length; i += CONCURRENCY) {
					const batch = selectedQueries.slice(i, i + CONCURRENCY);

					const batchPromises = batch.map(async (query) => {
						const targetSummary = summaryByCodeUnit.get(query.codeUnitId);
						if (!targetSummary) return;

						const targetCode = codeUnitMap.get(query.codeUnitId);
						if (!targetCode) return;

						// Get distractor summaries (other summaries from same model)
						const distractorSummaries = modelSummaries
							.filter((s) => s.codeUnitId !== query.codeUnitId)
							.sort(() => Math.random() - 0.5)
							.slice(0, 4); // 4 distractors

						if (distractorSummaries.length < 2) return; // Need at least 2 distractors

						// Run self-retrieval task
						if (tasksToRun.includes("retrieval")) {
							p.inProgress++;
							reportModelProgress(modelId);

							try {
								const result = await evaluateSelfRetrieval(client, modelId, {
									query,
									targetSummary,
									distractorSummaries,
									targetCode,
								});
								db.insertEvaluationResult(run.id, result);
								// Check if the result was an error (parsed from error response)
								const reasoning =
									result.selfEvaluationResults?.retrievalResults?.reasoning;
								if (reasoning?.startsWith("Error:")) {
									p.failures++;
									p.lastError = reasoning.slice(7, 100); // Capture error message
								}
							} catch (error) {
								// Outer catch for unexpected errors (evaluateSelfRetrieval catches its own)
								p.failures++;
								p.lastError =
									error instanceof Error
										? error.message.slice(0, 100)
										: "Unknown error";
							} finally {
								p.inProgress--;
								p.completed++;
								completed++;
								reportModelProgress(modelId);
							}
						}

						// Run self-function-selection task
						if (tasksToRun.includes("function_selection")) {
							p.inProgress++;
							reportModelProgress(modelId);

							try {
								const taskDescription = `Find a function that: ${query.query}`;
								const result = await evaluateSelfFunctionSelection(
									client,
									modelId,
									{
										taskDescription,
										targetSummary,
										distractorSummaries,
										targetFunctionName: targetCode.name,
									},
								);
								db.insertEvaluationResult(run.id, result);
								// Check if the result was an error (parsed from error response)
								const reasoning =
									result.selfEvaluationResults?.functionSelectionResults
										?.reasoning;
								if (reasoning?.startsWith("Error:")) {
									p.failures++;
									p.lastError = reasoning.slice(7, 100); // Capture error message
								}
							} catch (error) {
								// Outer catch for unexpected errors (evaluateSelfFunctionSelection catches its own)
								p.failures++;
								p.lastError =
									error instanceof Error
										? error.message.slice(0, 100)
										: "Unknown error";
							} finally {
								p.inProgress--;
								p.completed++;
								completed++;
								reportModelProgress(modelId);
							}
						}
					});

					await Promise.allSettled(batchPromises);
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
						`[SelfEval] Querying sizes for ${localModels.length} local models, threshold=${largeModelThreshold}B`,
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
										`[SelfEval] ${modelId} → ${size ?? "unknown"}B ${size !== undefined && size >= largeModelThreshold ? "(LARGE)" : "(small)"}`,
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

export interface SelfEvaluationMetrics {
	modelId: string;
	retrieval: {
		accuracy: number;
		avgConfidence: number;
		count: number;
	};
	functionSelection: {
		accuracy: number;
		count: number;
	};
	overall: number;
}

export function aggregateSelfEvaluationResults(
	results: EvaluationResult[],
	modelId: string,
): SelfEvaluationMetrics {
	const selfResults = results.filter(
		(r) =>
			r.evaluationType === "self" &&
			r.selfEvaluationResults?.generatingModelId === modelId,
	);

	// Aggregate retrieval results
	const retrievalResults = selfResults.filter(
		(r) => r.selfEvaluationResults?.taskType === "retrieval",
	);
	const retrievalCorrect = retrievalResults.filter(
		(r) => r.selfEvaluationResults?.retrievalResults?.correct,
	).length;
	const retrievalConfidences = retrievalResults.map(
		(r) => r.selfEvaluationResults?.retrievalResults?.confidence || 0,
	);
	const avgConfidence =
		retrievalConfidences.length > 0
			? retrievalConfidences.reduce((a, b) => a + b, 0) /
				retrievalConfidences.length
			: 0;

	// Aggregate function selection results
	const funcResults = selfResults.filter(
		(r) => r.selfEvaluationResults?.taskType === "function_selection",
	);
	const funcCorrect = funcResults.filter(
		(r) => r.selfEvaluationResults?.functionSelectionResults?.correct,
	).length;

	const retrievalAccuracy =
		retrievalResults.length > 0
			? retrievalCorrect / retrievalResults.length
			: 0;
	const funcAccuracy =
		funcResults.length > 0 ? funcCorrect / funcResults.length : 0;

	// Overall is weighted average of tasks
	const weights = { retrieval: 0.6, functionSelection: 0.4 };
	const overall =
		retrievalAccuracy * weights.retrieval +
		funcAccuracy * weights.functionSelection;

	return {
		modelId,
		retrieval: {
			accuracy: retrievalAccuracy,
			avgConfidence,
			count: retrievalResults.length,
		},
		functionSelection: {
			accuracy: funcAccuracy,
			count: funcResults.length,
		},
		overall,
	};
}
