/**
 * Judge Evaluators Module
 *
 * LLM-as-Judge evaluation for summary quality.
 */

export {
	PointwiseJudgeEvaluator,
	createPointwiseJudgeEvaluator,
} from "./pointwise.js";

export {
	PairwiseJudgeEvaluator,
	createPairwiseJudgeEvaluator,
	aggregateTournamentResults,
} from "./pairwise.js";

// ============================================================================
// Phase Executor
// ============================================================================

import { randomUUID } from "crypto";
import type { ILLMClient } from "../../../types.js";
import type { PhaseContext, PhaseResult } from "../../pipeline/orchestrator.js";
import { selectJudges } from "../base.js";
import { createPointwiseJudgeEvaluator } from "./pointwise.js";
import {
	createPairwiseJudgeEvaluator,
	aggregateTournamentResults,
} from "./pairwise.js";
import type {
	EvaluationResult,
	PairwiseResult,
	JudgeResults,
} from "../../types.js";

/**
 * Create the judge evaluation phase executor
 */
export function createJudgePhaseExecutor(
	judgeClients: Map<string, ILLMClient>,
): (context: PhaseContext) => Promise<PhaseResult> {
	return async (context: PhaseContext): Promise<PhaseResult> => {
		const { db, run, config, stateMachine } = context;
		const evalConfig = config.evaluation.judge;

		if (!evalConfig.enabled) {
			return { success: true, itemsProcessed: 0 };
		}

		try {
			// Get summaries and code units
			const summaries = db.getSummaries(run.id);
			const codeUnits = db.getCodeUnits(run.id);
			const codeUnitMap = new Map(codeUnits.map((u) => [u.id, u]));

			// Resume support: get existing evaluation results
			const existingResults = db.getEvaluationResults(run.id, "judge");
			const evaluatedPointwise = new Set<string>(); // key: summaryId:judgeModelId
			for (const result of existingResults) {
				if (result.judgeResults) {
					const key = `${result.summaryId}:${result.judgeResults.judgeModelId}`;
					evaluatedPointwise.add(key);
				}
			}

			// Pairwise results are stored separately
			const existingPairwise = db.getPairwiseResults(run.id);
			const evaluatedPairwise = new Set<string>(); // key: codeUnitId:modelA:modelB:judgeModelId
			for (const pw of existingPairwise) {
				// Store both orderings to catch either direction
				const key1 = `${pw.codeUnitId}:${pw.modelA}:${pw.modelB}:${pw.judgeModel}`;
				const key2 = `${pw.codeUnitId}:${pw.modelB}:${pw.modelA}:${pw.judgeModel}`;
				evaluatedPairwise.add(key1);
				evaluatedPairwise.add(key2);
			}

			// Calculate total work per judge
			const summariesPerJudge = summaries.length;
			const totalPairwise = evalConfig.usePairwise
				? ((config.generators.length * (config.generators.length - 1)) / 2) *
					codeUnits.length *
					evalConfig.judgeModels.length
				: 0;
			const totalItems =
				summariesPerJudge * evalConfig.judgeModels.length + totalPairwise;

			stateMachine.startPhase("evaluation:judge", totalItems);

			const concurrency = 30; // Process 30 summaries concurrently per judge
			const DEFAULT_TIMEOUT_MS = 60_000; // 60 second timeout per request
			const CC_TIMEOUT_MS = 180_000; // 180 seconds for Claude Code (subprocess overhead + Opus thinking)

			// Get timeout based on provider (cc/ models need more time)
			const getTimeoutForModel = (modelId: string): number => {
				return modelId.startsWith("cc/") ? CC_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
			};

			// Timeout wrapper
			const withTimeout = <T>(
				promise: Promise<T>,
				timeoutMs: number,
			): Promise<T> => {
				return Promise.race([
					promise,
					new Promise<T>((_, reject) =>
						setTimeout(
							() => reject(new Error(`Request timeout after ${timeoutMs}ms`)),
							timeoutMs,
						),
					),
				]);
			};

			// Track failures for reporting (don't print during progress bar)
			const failures: Array<{ model: string; count: number; error: string }> =
				[];

			// Pointwise evaluation - process all judges in parallel
			const judgePromises = evalConfig.judgeModels.map(async (judgeModelId) => {
				const client = judgeClients.get(judgeModelId);
				if (!client)
					return { judgeModelId, completed: 0, failures: 0, lastError: "" };

				const evaluator = createPointwiseJudgeEvaluator(client, judgeModelId);

				// Track progress for this judge
				let judgeCompleted = 0;
				let judgeFailures = 0;
				let lastError = "";
				const inProgress = new Set<string>();

				const processSummary = async (
					summary: (typeof summaries)[0],
				): Promise<void> => {
					const codeUnit = codeUnitMap.get(summary.codeUnitId);
					if (!codeUnit) return;

					// Check if model can judge (not same family)
					const eligible = selectJudges(summary.modelId, [judgeModelId], 1);
					if (eligible.length === 0) return;

					// Resume support: skip already evaluated
					const evalKey = `${summary.id}:${judgeModelId}`;
					if (evaluatedPointwise.has(evalKey)) {
						judgeCompleted++;
						return;
					}

					inProgress.add(summary.id);

					// Report progress with inProgress count
					stateMachine.updateProgress(
						"evaluation:judge",
						judgeCompleted,
						summary.id,
						`${judgeModelId}: ${judgeCompleted}/${summariesPerJudge}/${inProgress.size}`,
					);

					try {
						const result = await withTimeout(
							evaluator.evaluate(summary, codeUnit, {}),
							getTimeoutForModel(judgeModelId),
						);
						db.insertEvaluationResult(run.id, result);
					} catch (error) {
						// Track error silently (don't print during progress bar)
						judgeFailures++;
						lastError = String(error);
					}

					inProgress.delete(summary.id);
					judgeCompleted++;

					// Report completion
					stateMachine.updateProgress(
						"evaluation:judge",
						judgeCompleted,
						summary.id,
						`${judgeModelId}: ${judgeCompleted}/${summariesPerJudge}/${inProgress.size}`,
					);
				};

				// Initial progress
				stateMachine.updateProgress(
					"evaluation:judge",
					0,
					undefined,
					`${judgeModelId}: 0/${summariesPerJudge}/0`,
				);

				// Process in concurrent batches with allSettled (don't block on failures)
				for (let i = 0; i < summaries.length; i += concurrency) {
					const batch = summaries.slice(i, i + concurrency);
					await Promise.allSettled(batch.map(processSummary));
				}

				return {
					judgeModelId,
					completed: judgeCompleted,
					failures: judgeFailures,
					lastError,
				};
			});

			const judgeResults = await Promise.all(judgePromises);
			let completed = judgeResults.reduce((sum, r) => sum + r.completed, 0);

			// Collect pointwise failures for reporting
			for (const r of judgeResults) {
				if (r.failures > 0) {
					failures.push({
						model: r.judgeModelId,
						count: r.failures,
						error: r.lastError,
					});
				}
			}

			// Pairwise evaluation - run judges in parallel
			if (evalConfig.usePairwise) {
				// Show progress while building pairwise tasks
				stateMachine.updateProgress(
					"evaluation:judge",
					completed,
					undefined,
					"preparing pairwise comparisons...",
				);

				const allPairwiseResults: PairwiseResult[] = [];

				// Hard cap: max 600 comparisons per judge (300 pairs × 2 orderings)
				const MAX_COMPARISONS_PER_JUDGE = 600;
				const MAX_PAIRS_PER_JUDGE = MAX_COMPARISONS_PER_JUDGE / 2;

				// Build comparison tasks efficiently using maps for O(1) lookups
				const numModels = config.generators.length;
				type ComparisonTask = {
					codeUnit: (typeof codeUnits)[0];
					summaries: typeof summaries;
				};

				// Group summaries by code unit for fast lookup
				const summariesByUnit = new Map<string, typeof summaries>();
				for (const summary of summaries) {
					const existing = summariesByUnit.get(summary.codeUnitId) || [];
					existing.push(summary);
					summariesByUnit.set(summary.codeUnitId, existing);
				}

				// Get unique model pairs
				const modelIds = config.generators.map((g) => g.id);
				const modelPairs: Array<{ modelA: string; modelB: string }> = [];
				for (let i = 0; i < modelIds.length; i++) {
					for (let j = i + 1; j < modelIds.length; j++) {
						modelPairs.push({ modelA: modelIds[i], modelB: modelIds[j] });
					}
				}

				// Build tasks per model pair
				const tasksByPair = new Map<string, ComparisonTask[]>();
				for (const pair of modelPairs) {
					const pairKey = `${pair.modelA}::${pair.modelB}`;
					const tasks: ComparisonTask[] = [];

					for (const codeUnit of codeUnits) {
						const unitSummaries = summariesByUnit.get(codeUnit.id) || [];
						if (unitSummaries.length < 2) continue;

						const summaryA = unitSummaries.find(
							(s) => s.modelId === pair.modelA,
						);
						const summaryB = unitSummaries.find(
							(s) => s.modelId === pair.modelB,
						);
						if (summaryA && summaryB) {
							tasks.push({ codeUnit, summaries: [summaryA, summaryB] });
						}
					}

					if (tasks.length > 0) {
						tasksByPair.set(pairKey, tasks);
					}
				}

				// Sample evenly across model pairs if we exceed the cap
				const numPairs = tasksByPair.size;
				const tasksPerPair = Math.ceil(MAX_PAIRS_PER_JUDGE / numPairs);

				// Collect sampled tasks
				const sampledTasks: ComparisonTask[] = [];
				for (const [_, tasks] of tasksByPair) {
					if (tasks.length <= tasksPerPair) {
						sampledTasks.push(...tasks);
					} else {
						const step = tasks.length / tasksPerPair;
						for (let i = 0; i < tasksPerPair; i++) {
							sampledTasks.push(tasks[Math.floor(i * step)]);
						}
					}
				}

				// Pairwise task concurrency - process multiple code units in parallel per judge
				const PAIRWISE_CONCURRENCY = 20;

				const pairwisePromises = evalConfig.judgeModels.map(
					async (judgeModelId) => {
						const client = judgeClients.get(judgeModelId);
						if (!client)
							return {
								results: [] as PairwiseResult[],
								failures: 0,
								lastError: "",
							};

						// Resume support: filter out already-evaluated pairwise comparisons for this judge
						const tasksForJudge = sampledTasks.filter((task) => {
							const [summaryA, summaryB] = task.summaries;
							const pairKey = `${task.codeUnit.id}:${summaryA.modelId}:${summaryB.modelId}:${judgeModelId}`;
							const pairKeyReverse = `${task.codeUnit.id}:${summaryB.modelId}:${summaryA.modelId}:${judgeModelId}`;
							return (
								!evaluatedPairwise.has(pairKey) &&
								!evaluatedPairwise.has(pairKeyReverse)
							);
						});

						// Calculate actual total comparisons after filtering
						const totalComparisons = Math.min(
							tasksForJudge.length * 2,
							MAX_COMPARISONS_PER_JUDGE,
						);

						// Show this judge is starting pairwise
						stateMachine.updateProgress(
							"evaluation:judge",
							0,
							undefined,
							`pw:${judgeModelId}: 0/${totalComparisons}/0`,
						);

						const evaluator = createPairwiseJudgeEvaluator(
							client,
							judgeModelId,
						);
						const results: PairwiseResult[] = [];
						let pairwiseFailures = 0;
						let lastError = "";
						let totalCompleted = 0;
						let inProgressCount = 0;

						// Process sampled tasks in parallel batches (filtered for resume)
						for (
							let i = 0;
							i < tasksForJudge.length;
							i += PAIRWISE_CONCURRENCY
						) {
							const batch = tasksForJudge.slice(i, i + PAIRWISE_CONCURRENCY);
							inProgressCount = batch.length;

							// Update progress when batch starts
							stateMachine.updateProgress(
								"evaluation:judge",
								totalCompleted,
								undefined,
								`pw:${judgeModelId}: ${totalCompleted}/${totalComparisons}/${inProgressCount}`,
							);

							const batchPromises = batch.map(async (task) => {
								try {
									const pairResults = await evaluator.comparePairs(
										task.codeUnit,
										task.summaries,
										() => {
											// Trigger animation refresh
											stateMachine.updateProgress(
												"evaluation:judge",
												totalCompleted,
												task.codeUnit.id,
												`pw:${judgeModelId}: ${totalCompleted}/${totalComparisons}/${inProgressCount}`,
											);
										},
									);
									inProgressCount--;
									totalCompleted += 2;
									// Update progress as task completes
									stateMachine.updateProgress(
										"evaluation:judge",
										totalCompleted,
										task.codeUnit.id,
										`pw:${judgeModelId}: ${totalCompleted}/${totalComparisons}/${inProgressCount}`,
									);
									return { success: true as const, results: pairResults };
								} catch (error) {
									inProgressCount--;
									totalCompleted += 2;
									stateMachine.updateProgress(
										"evaluation:judge",
										totalCompleted,
										undefined,
										`pw:${judgeModelId}: ${totalCompleted}/${totalComparisons}/${inProgressCount}`,
									);
									return { success: false as const, error: String(error) };
								}
							});

							const batchResults = await Promise.allSettled(batchPromises);

							for (const result of batchResults) {
								if (result.status === "fulfilled") {
									if (result.value.success) {
										results.push(...result.value.results);
									} else {
										pairwiseFailures++;
										lastError = result.value.error;
									}
								} else {
									pairwiseFailures++;
									lastError = result.reason?.message || "Unknown error";
								}
							}
						}

						return { results, failures: pairwiseFailures, lastError };
					},
				);

				// Add a global timeout to prevent hanging indefinitely
				const PAIRWISE_GLOBAL_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes max for all pairwise
				const pairwiseWithTimeout = Promise.race([
					Promise.all(pairwisePromises),
					new Promise<never>((_, reject) =>
						setTimeout(
							() =>
								reject(
									new Error(
										`Pairwise evaluation timed out after ${PAIRWISE_GLOBAL_TIMEOUT_MS / 60000} minutes`,
									),
								),
							PAIRWISE_GLOBAL_TIMEOUT_MS,
						),
					),
				]);

				const pairwiseResultArrays = await pairwiseWithTimeout;

				for (let i = 0; i < pairwiseResultArrays.length; i++) {
					const {
						results,
						failures: pairFailures,
						lastError,
					} = pairwiseResultArrays[i];
					allPairwiseResults.push(...results);
					if (pairFailures > 0) {
						const judgeId = evalConfig.judgeModels[i];
						failures.push({
							model: `${judgeId} (pairwise)`,
							count: pairFailures,
							error: lastError,
						});
					}
				}
				completed += allPairwiseResults.length;

				// Save pairwise results
				stateMachine.updateProgress(
					"evaluation:judge",
					completed,
					undefined,
					`saving ${allPairwiseResults.length} pairwise results...`,
				);
				db.insertPairwiseResults(run.id, allPairwiseResults);

				// Aggregate tournament scores
				stateMachine.updateProgress(
					"evaluation:judge",
					completed,
					undefined,
					`aggregating tournament (${config.generators.length} models)...`,
				);
				const tournamentScores = aggregateTournamentResults(
					allPairwiseResults,
					config.generators.map((g) => g.id),
				);

				// Update progress to show aggregation complete
				stateMachine.updateProgress(
					"evaluation:judge",
					completed,
					undefined,
					"tournament aggregation complete",
				);
			}

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
