/**
 * Downstream Task Evaluator
 *
 * Evaluates summaries on practical coding tasks:
 * 1. Code Completion - Complete code using summary context
 * 2. Bug Localization - Find buggy file from summaries
 * 3. Function Selection - Select right function for a task
 */

import { randomUUID } from "crypto";
import type { ILLMClient, LLMMessage } from "../../../types.js";
import type {
	BenchmarkCodeUnit,
	GeneratedSummary,
	EvaluationResult,
	DownstreamResults,
	DownstreamTaskType,
	CompletionTask,
	BugLocalizationTask,
	FunctionSelectionTask,
	EvaluatorContext,
} from "../../types.js";
import { BaseEvaluator } from "../base.js";
import { DownstreamError } from "../../errors.js";
import type { PhaseContext, PhaseResult } from "../../pipeline/orchestrator.js";

// ============================================================================
// Prompts
// ============================================================================

const COMPLETION_PROMPT = `Complete this code using the provided context.

## Context from Codebase
{summaries}

## Code to Complete
\`\`\`{language}
{partial_code}
// TODO: Complete this function
\`\`\`

## Requirements
{requirements}

Provide only the completed code, no explanations.`;

const BUG_LOCALIZATION_PROMPT = `A bug has been reported. Based on the file summaries below, identify which file most likely contains the bug.

## Bug Report
{bug_description}

## File Summaries
{file_summaries}

Which file most likely contains this bug? Respond with JSON:
\`\`\`json
{
  "predicted_file": "<file path>",
  "confidence": "high" | "medium" | "low",
  "reasoning": "<brief explanation>"
}
\`\`\``;

const FUNCTION_SELECTION_PROMPT = `You need to accomplish a task. Based on the available functions, select the most appropriate one.

## Task
{task_description}

## Available Functions
{function_summaries}

Which function should be used? Respond with JSON:
\`\`\`json
{
  "selected_function": "<function name>",
  "confidence": "high" | "medium" | "low",
  "reasoning": "<brief explanation>"
}
\`\`\``;

// ============================================================================
// Task Generators (for creating downstream tasks from code units)
// ============================================================================

/**
 * Generate code completion tasks from code units
 */
export function generateCompletionTasks(
	codeUnits: BenchmarkCodeUnit[],
	count: number = 10,
): CompletionTask[] {
	// Select function/method units
	const candidates = codeUnits.filter(
		(u) =>
			(u.type === "function" || u.type === "method") && u.content.length > 100,
	);

	const selected = candidates
		.sort(() => Math.random() - 0.5)
		.slice(0, Math.min(count, candidates.length));

	return selected.map((unit) => {
		// Create partial code by removing the body
		const lines = unit.content.split("\n");
		const signatureEndLine = lines.findIndex(
			(l) => l.includes("{") || l.includes(":"),
		);

		const partialCode =
			signatureEndLine >= 0
				? lines.slice(0, signatureEndLine + 1).join("\n") +
					"\n    // TODO: implement"
				: lines.slice(0, Math.ceil(lines.length / 3)).join("\n");

		return {
			id: randomUUID(),
			codeUnitId: unit.id,
			partialCode,
			fullCode: unit.content,
			requirements: `Implement the ${unit.name} ${unit.type} according to its signature`,
			language: unit.language,
			relevantSummaryIds: [unit.id], // The summary for this unit
		};
	});
}

/**
 * Generate bug localization tasks
 */
export function generateBugLocalizationTasks(
	codeUnits: BenchmarkCodeUnit[],
	count: number = 5,
): BugLocalizationTask[] {
	// Group by file
	const fileUnits = codeUnits.filter((u) => u.type === "file");

	if (fileUnits.length < 3) return [];

	const selected = fileUnits
		.sort(() => Math.random() - 0.5)
		.slice(0, Math.min(count, fileUnits.length));

	return selected.map((buggyFile) => {
		// Generate a plausible bug description based on file name
		const fileName = buggyFile.name || buggyFile.path.split("/").pop() || "";
		const bugDescriptions = [
			`Users are reporting errors when interacting with ${fileName}. The operation sometimes fails silently.`,
			`There's a null reference exception occurring somewhere in the ${fileName.replace(/\.[^.]+$/, "")} functionality.`,
			`Performance degradation detected in operations related to ${fileName}. Response times have increased.`,
			`Data validation is failing for inputs processed by ${fileName}.`,
		];

		// Get other files as candidates
		const otherFiles = fileUnits
			.filter((f) => f.id !== buggyFile.id)
			.sort(() => Math.random() - 0.5)
			.slice(0, 4);

		const candidateFiles = [buggyFile, ...otherFiles]
			.sort(() => Math.random() - 0.5)
			.map((f) => f.path);

		return {
			id: randomUUID(),
			bugDescription:
				bugDescriptions[Math.floor(Math.random() * bugDescriptions.length)],
			actualBuggyFile: buggyFile.path,
			candidateFiles,
		};
	});
}

/**
 * Generate function selection tasks
 */
export function generateFunctionSelectionTasks(
	codeUnits: BenchmarkCodeUnit[],
	count: number = 10,
): FunctionSelectionTask[] {
	// Select function units
	const functions = codeUnits.filter(
		(u) => u.type === "function" && u.name && u.name.length > 3,
	);

	if (functions.length < 4) return [];

	const selected = functions
		.sort(() => Math.random() - 0.5)
		.slice(0, Math.min(count, functions.length));

	return selected.map((correctFn) => {
		// Generate a task description based on function name
		const fnName = correctFn.name || "function";
		const words = fnName
			.replace(/([A-Z])/g, " $1")
			.toLowerCase()
			.trim()
			.split(/\s+/);

		const taskDescription = `I need to ${words.join(" ")} in my application.`;

		// Get other functions as candidates
		const otherFns = functions
			.filter((f) => f.id !== correctFn.id)
			.sort(() => Math.random() - 0.5)
			.slice(0, 3);

		const candidateFunctions = [correctFn, ...otherFns]
			.sort(() => Math.random() - 0.5)
			.map((f) => f.name || "anonymous");

		return {
			id: randomUUID(),
			taskDescription,
			correctFunction: correctFn.name || "anonymous",
			candidateFunctions,
		};
	});
}

// ============================================================================
// Downstream Evaluator
// ============================================================================

export class DownstreamEvaluator extends BaseEvaluator<EvaluationResult> {
	constructor(llmClient: ILLMClient) {
		super(llmClient);
	}

	async evaluate(
		summary: GeneratedSummary,
		_codeUnit: BenchmarkCodeUnit,
		context: EvaluatorContext,
	): Promise<EvaluationResult> {
		// This method evaluates all downstream tasks for a summary
		throw new Error(
			"Use evaluateTask methods instead for specific downstream tasks",
		);
	}

	/**
	 * Evaluate a code completion task
	 */
	async evaluateCompletion(
		task: CompletionTask,
		summaries: GeneratedSummary[],
		modelId: string,
	): Promise<EvaluationResult> {
		if (!this.llmClient) {
			throw new DownstreamError(
				"completion",
				task.id,
				"No LLM client provided",
			);
		}

		// Get relevant summaries
		const relevantSummaryObjs = summaries.filter((s) =>
			task.relevantSummaryIds.includes(s.codeUnitId),
		);
		const relevantSummaryText = relevantSummaryObjs
			.map((s) => s.summary)
			.join("\n\n---\n\n");

		// Find the primary summary for this task (for the foreign key)
		const primarySummary = summaries.find(
			(s) => s.codeUnitId === task.codeUnitId,
		);
		if (!primarySummary) {
			throw new DownstreamError(
				"completion",
				task.id,
				`No summary found for code unit ${task.codeUnitId}`,
			);
		}

		const prompt = COMPLETION_PROMPT.replace(
			"{summaries}",
			relevantSummaryText || "No context available",
		)
			.replace("{language}", task.language)
			.replace("{partial_code}", task.partialCode)
			.replace("{requirements}", task.requirements);

		const messages: LLMMessage[] = [{ role: "user", content: prompt }];

		try {
			const response = await this.llmClient.complete(messages, {
				temperature: 0,
				maxTokens: 2000,
			});

			const generatedCode = this.extractCode(response.content);

			// Simple evaluation: check if key parts of original are present
			const score = this.calculateCompletionScore(generatedCode, task.fullCode);

			const downstreamResults: DownstreamResults = {
				taskType: "completion",
				taskId: task.id,
				success: score > 0.5,
				partialScore: score,
				details: {
					generatedCode: generatedCode.slice(0, 500),
				},
			};

			return {
				id: randomUUID(),
				summaryId: primarySummary.id,
				evaluationType: "downstream",
				downstreamResults,
				evaluatedAt: new Date().toISOString(),
			};
		} catch (error) {
			throw new DownstreamError(
				"completion",
				task.id,
				error instanceof Error ? error.message : String(error),
				{ modelId },
				error instanceof Error ? error : undefined,
			);
		}
	}

	/**
	 * Evaluate a bug localization task
	 */
	async evaluateBugLocalization(
		task: BugLocalizationTask,
		summaries: GeneratedSummary[],
		codeUnits: BenchmarkCodeUnit[],
		modelId: string,
	): Promise<EvaluationResult> {
		if (!this.llmClient) {
			throw new DownstreamError(
				"bug_localization",
				task.id,
				"No LLM client provided",
			);
		}

		// Find a representative summary for this task (first one from this model)
		const representativeSummary = summaries[0];
		if (!representativeSummary) {
			throw new DownstreamError(
				"bug_localization",
				task.id,
				"No summaries available for model",
			);
		}

		// Build file summaries string
		const fileSummaries = task.candidateFiles
			.map((filePath) => {
				const unit = codeUnits.find((u) => u.path === filePath);
				const summary = summaries.find((s) => s.codeUnitId === unit?.id);
				return `### ${filePath}\n${summary?.summary || "[No summary available]"}`;
			})
			.join("\n\n");

		const prompt = BUG_LOCALIZATION_PROMPT.replace(
			"{bug_description}",
			task.bugDescription,
		).replace("{file_summaries}", fileSummaries);

		const messages: LLMMessage[] = [{ role: "user", content: prompt }];

		try {
			const response = await this.llmClient.complete(messages, {
				temperature: 0,
				maxTokens: 500,
			});

			const parsed = this.parseJSONResponse<{
				predicted_file: string;
				confidence: string;
				reasoning: string;
			}>(response.content);

			const correct = parsed.predicted_file === task.actualBuggyFile;

			const downstreamResults: DownstreamResults = {
				taskType: "bug_localization",
				taskId: task.id,
				success: correct,
				partialScore: correct ? 1 : 0,
				details: {
					predictedFile: parsed.predicted_file,
					actualFile: task.actualBuggyFile,
					confidence: parsed.confidence,
				},
			};

			return {
				id: randomUUID(),
				summaryId: representativeSummary.id,
				evaluationType: "downstream",
				downstreamResults,
				evaluatedAt: new Date().toISOString(),
			};
		} catch (error) {
			throw new DownstreamError(
				"bug_localization",
				task.id,
				error instanceof Error ? error.message : String(error),
				{ modelId },
				error instanceof Error ? error : undefined,
			);
		}
	}

	/**
	 * Evaluate a function selection task
	 */
	async evaluateFunctionSelection(
		task: FunctionSelectionTask,
		summaries: GeneratedSummary[],
		codeUnits: BenchmarkCodeUnit[],
		modelId: string,
	): Promise<EvaluationResult> {
		if (!this.llmClient) {
			throw new DownstreamError(
				"function_selection",
				task.id,
				"No LLM client provided",
			);
		}

		// Find a representative summary for this task (first one from this model)
		const representativeSummary = summaries[0];
		if (!representativeSummary) {
			throw new DownstreamError(
				"function_selection",
				task.id,
				"No summaries available for model",
			);
		}

		// Build function summaries string
		const functionSummaries = task.candidateFunctions
			.map((fnName) => {
				const unit = codeUnits.find((u) => u.name === fnName);
				const summary = summaries.find((s) => s.codeUnitId === unit?.id);
				return `### ${fnName}\n${summary?.summary || "[No summary available]"}`;
			})
			.join("\n\n");

		const prompt = FUNCTION_SELECTION_PROMPT.replace(
			"{task_description}",
			task.taskDescription,
		).replace("{function_summaries}", functionSummaries);

		const messages: LLMMessage[] = [{ role: "user", content: prompt }];

		try {
			const response = await this.llmClient.complete(messages, {
				temperature: 0,
				maxTokens: 500,
			});

			const parsed = this.parseJSONResponse<{
				selected_function: string;
				confidence: string;
				reasoning: string;
			}>(response.content);

			const correct = parsed.selected_function === task.correctFunction;

			const downstreamResults: DownstreamResults = {
				taskType: "function_selection",
				taskId: task.id,
				success: correct,
				partialScore: correct ? 1 : 0,
				details: {
					selectedFunction: parsed.selected_function,
					correctFunction: task.correctFunction,
					confidence: parsed.confidence,
				},
			};

			return {
				id: randomUUID(),
				summaryId: representativeSummary.id,
				evaluationType: "downstream",
				downstreamResults,
				evaluatedAt: new Date().toISOString(),
			};
		} catch (error) {
			throw new DownstreamError(
				"function_selection",
				task.id,
				error instanceof Error ? error.message : String(error),
				{ modelId },
				error instanceof Error ? error : undefined,
			);
		}
	}

	getType() {
		return "downstream" as const;
	}

	private extractCode(response: string): string {
		const codeMatch = response.match(/```(?:\w+)?\s*([\s\S]*?)```/);
		return codeMatch ? codeMatch[1].trim() : response.trim();
	}

	private calculateCompletionScore(
		generated: string,
		original: string,
	): number {
		// Simple token overlap score
		const genTokens = new Set(
			generated.toLowerCase().split(/\W+/).filter(Boolean),
		);
		const origTokens = new Set(
			original.toLowerCase().split(/\W+/).filter(Boolean),
		);

		if (origTokens.size === 0) return 0;

		let matches = 0;
		for (const token of genTokens) {
			if (origTokens.has(token)) matches++;
		}

		return matches / origTokens.size;
	}
}

// ============================================================================
// Factory Function
// ============================================================================

export function createDownstreamEvaluator(
	llmClient: ILLMClient,
): DownstreamEvaluator {
	return new DownstreamEvaluator(llmClient);
}

// ============================================================================
// Phase Executor
// ============================================================================

/**
 * Create the downstream evaluation phase executor
 */
export function createDownstreamPhaseExecutor(
	llmClient: ILLMClient,
): (context: PhaseContext) => Promise<PhaseResult> {
	return async (context: PhaseContext): Promise<PhaseResult> => {
		const { db, run, config, stateMachine } = context;
		const evalConfig = config.evaluation.downstream;

		// Check if downstream evaluation is enabled and has any tasks
		const hasAnyTask =
			evalConfig.tasks.codeCompletion ||
			evalConfig.tasks.bugLocalization ||
			evalConfig.tasks.functionSelection;

		if (!evalConfig.enabled || !hasAnyTask) {
			return { success: true, itemsProcessed: 0 };
		}

		try {
			// Get data
			const summaries = db.getSummaries(run.id);
			const codeUnits = db.getCodeUnits(run.id);

			// Group summaries by model
			const summariesByModel = new Map<string, GeneratedSummary[]>();
			for (const summary of summaries) {
				if (!summariesByModel.has(summary.modelId)) {
					summariesByModel.set(summary.modelId, []);
				}
				summariesByModel.get(summary.modelId)!.push(summary);
			}

			// Generate tasks based on config flags
			const completionTasks = evalConfig.tasks.codeCompletion
				? generateCompletionTasks(codeUnits)
				: [];
			const bugLocTasks = evalConfig.tasks.bugLocalization
				? generateBugLocalizationTasks(codeUnits)
				: [];
			const funcSelectTasks = evalConfig.tasks.functionSelection
				? generateFunctionSelectionTasks(codeUnits)
				: [];

			// Save tasks to DB
			if (completionTasks.length > 0) {
				db.insertCompletionTasks(run.id, completionTasks);
			}
			if (bugLocTasks.length > 0) {
				db.insertBugLocalizationTasks(run.id, bugLocTasks);
			}
			if (funcSelectTasks.length > 0) {
				db.insertFunctionSelectionTasks(run.id, funcSelectTasks);
			}

			const totalTasks =
				(completionTasks.length + bugLocTasks.length + funcSelectTasks.length) *
				summariesByModel.size;

			stateMachine.startPhase("evaluation:downstream", totalTasks);

			const evaluator = createDownstreamEvaluator(llmClient);
			let completed = 0;
			const concurrency = 10; // Process 10 tasks concurrently

			// Build list of all tasks to run
			type TaskItem = {
				type: "completion" | "bugLoc" | "funcSelect";
				task: CompletionTask | BugLocalizationTask | FunctionSelectionTask;
				modelId: string;
				modelSummaries: GeneratedSummary[];
			};

			const allTasks: TaskItem[] = [];
			for (const [modelId, modelSummaries] of summariesByModel) {
				for (const task of completionTasks) {
					allTasks.push({ type: "completion", task, modelId, modelSummaries });
				}
				for (const task of bugLocTasks) {
					allTasks.push({ type: "bugLoc", task, modelId, modelSummaries });
				}
				for (const task of funcSelectTasks) {
					allTasks.push({ type: "funcSelect", task, modelId, modelSummaries });
				}
			}

			// Process task with error handling
			const processTask = async (item: TaskItem): Promise<void> => {
				try {
					let result: EvaluationResult;
					if (item.type === "completion") {
						result = await evaluator.evaluateCompletion(
							item.task as CompletionTask,
							item.modelSummaries,
							item.modelId,
						);
					} else if (item.type === "bugLoc") {
						result = await evaluator.evaluateBugLocalization(
							item.task as BugLocalizationTask,
							item.modelSummaries,
							codeUnits,
							item.modelId,
						);
					} else {
						result = await evaluator.evaluateFunctionSelection(
							item.task as FunctionSelectionTask,
							item.modelSummaries,
							codeUnits,
							item.modelId,
						);
					}
					db.insertEvaluationResult(run.id, result);
				} catch (error) {
					// Log but don't fail - continue with other tasks
				}

				completed++;
				stateMachine.updateProgress(
					"evaluation:downstream",
					completed,
					item.task.id,
					`downstream: ${completed}/${totalTasks}`,
				);
			};

			// Process tasks in concurrent batches
			for (let i = 0; i < allTasks.length; i += concurrency) {
				const batch = allTasks.slice(i, i + concurrency);
				await Promise.all(batch.map(processTask));
			}

			return {
				success: true,
				itemsProcessed: completed,
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
