/**
 * Contrastive Evaluator
 *
 * Evaluates summaries by testing if they can correctly identify
 * their source code from a set of distractors.
 *
 * Two methods:
 * 1. Embedding-based: Use vector similarity
 * 2. LLM-based: Ask an LLM to match summary to code
 */

import { randomUUID } from "crypto";
import type {
	ILLMClient,
	IEmbeddingsClient,
	LLMMessage,
} from "../../../types.js";
import type {
	BenchmarkCodeUnit,
	GeneratedSummary,
	EvaluationResult,
	ContrastiveResults,
	DistractorSet,
	DistractorDifficulty,
	EvaluatorContext,
} from "../../types.js";
import { BaseEvaluator } from "../base.js";
import {
	ContrastiveError,
	InsufficientDistractorsError,
} from "../../errors.js";
import type { PhaseContext, PhaseResult } from "../../pipeline/orchestrator.js";

// ============================================================================
// Prompts
// ============================================================================

const CONTRASTIVE_LLM_PROMPT = `Given a code summary, identify which code snippet it describes.

## Summary
{summary}

## Code Options
{code_options}

Which code option (1-{n}) does this summary describe?

Respond with ONLY a JSON object:
\`\`\`json
{
  "selected": <number 1-{n}>,
  "confidence": "high" | "medium" | "low",
  "reasoning": "<brief explanation>"
}
\`\`\``;

// ============================================================================
// Distractor Selection
// ============================================================================

/**
 * Select distractors for a target code unit
 */
export function selectDistractors(
	target: BenchmarkCodeUnit,
	allUnits: BenchmarkCodeUnit[],
	count: number = 9,
	embeddings?: Map<string, number[]>,
): DistractorSet {
	const distractors: BenchmarkCodeUnit[] = [];

	// Filter candidates (same language, same type, not target)
	const candidates = allUnits.filter(
		(u) =>
			u.id !== target.id &&
			u.language === target.language &&
			u.type === target.type,
	);

	if (candidates.length < count) {
		// Relax type constraint if not enough candidates
		const relaxedCandidates = allUnits.filter(
			(u) => u.id !== target.id && u.language === target.language,
		);

		if (relaxedCandidates.length < count) {
			throw new InsufficientDistractorsError(
				target.id,
				count,
				relaxedCandidates.length,
			);
		}

		// Use relaxed candidates
		distractors.push(...shuffleAndTake(relaxedCandidates, count));
	} else {
		// TIER 1: Same file (hardest - similar context)
		const sameFile = candidates.filter((c) => c.path === target.path);
		distractors.push(...shuffleAndTake(sameFile, Math.min(3, sameFile.length)));

		// TIER 2: Similar signature (hard - same interface)
		if (target.metadata.signature && distractors.length < count) {
			const similarSig = candidates.filter(
				(c) =>
					c.metadata.signature &&
					!distractors.some((d) => d.id === c.id) &&
					signatureSimilarity(
						c.metadata.signature,
						target.metadata.signature!,
					) > 0.7,
			);
			distractors.push(
				...shuffleAndTake(similarSig, Math.min(3, count - distractors.length)),
			);
		}

		// TIER 3: Semantic similarity (HARD) - use embeddings if available
		// Select code that is VERY similar to target (0.70-0.95 range)
		// These should be genuinely confusing alternatives that test summary specificity
		if (embeddings && distractors.length < count) {
			const targetEmb = embeddings.get(target.id);
			if (targetEmb) {
				const similarities = candidates
					.filter((c) => !distractors.some((d) => d.id === c.id))
					.map((c) => ({
						unit: c,
						similarity: cosineSimilarity(embeddings.get(c.id), targetEmb),
					}))
					.filter((s) => s.similarity !== null)
					// Sort by DESCENDING similarity to get the most confusing alternatives
					.sort((a, b) => (b.similarity || 0) - (a.similarity || 0))
					// Take top candidates that are similar but not duplicates (>0.95 might be copies)
					.filter((s) => s.similarity! < 0.95);

				// Prioritize MOST similar items - these are the hardest distractors
				distractors.push(
					...similarities
						.slice(0, count - distractors.length)
						.map((s) => s.unit),
				);
			}
		}

		// TIER 4: Random padding if needed
		if (distractors.length < count) {
			const remaining = candidates.filter(
				(c) => !distractors.some((d) => d.id === c.id),
			);
			distractors.push(
				...shuffleAndTake(remaining, count - distractors.length),
			);
		}
	}

	// Calculate difficulty
	const difficulty = calculateDifficulty(distractors, target);

	return {
		targetCodeUnitId: target.id,
		distractorIds: distractors.slice(0, count).map((d) => d.id),
		difficulty,
	};
}

function shuffleAndTake<T>(array: T[], count: number): T[] {
	const shuffled = [...array].sort(() => Math.random() - 0.5);
	return shuffled.slice(0, count);
}

function signatureSimilarity(sig1: string, sig2: string): number {
	// Simple similarity based on parameter count and names
	const params1 = extractParamNames(sig1);
	const params2 = extractParamNames(sig2);

	if (params1.length === 0 && params2.length === 0) return 1;

	const countSim =
		1 -
		Math.abs(params1.length - params2.length) /
			Math.max(params1.length, params2.length, 1);

	// Check for common parameter names
	const common = params1.filter((p) => params2.includes(p)).length;
	const nameSim = common / Math.max(params1.length, params2.length, 1);

	return (countSim + nameSim) / 2;
}

function extractParamNames(signature: string): string[] {
	const match = signature.match(/\((.*?)\)/);
	if (!match) return [];

	return match[1]
		.split(",")
		.map((p) => p.trim().split(/[:\s]/)[0])
		.filter((p) => p.length > 0);
}

function cosineSimilarity(
	a: number[] | undefined,
	b: number[] | undefined,
): number | null {
	if (!a || !b || a.length !== b.length) return null;

	let dot = 0;
	let normA = 0;
	let normB = 0;

	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}

	const denom = Math.sqrt(normA) * Math.sqrt(normB);
	return denom > 0 ? dot / denom : 0;
}

function calculateDifficulty(
	distractors: BenchmarkCodeUnit[],
	target: BenchmarkCodeUnit,
): DistractorDifficulty {
	// More same-file distractors = harder
	const sameFileCount = distractors.filter(
		(d) => d.path === target.path,
	).length;

	if (sameFileCount >= 3) return "hard";
	if (sameFileCount >= 1) return "medium";
	return "easy";
}

// ============================================================================
// Embedding-based Contrastive Evaluator
// ============================================================================

export class EmbeddingContrastiveEvaluator extends BaseEvaluator<EvaluationResult> {
	private embeddingsClient: IEmbeddingsClient;

	constructor(embeddingsClient: IEmbeddingsClient) {
		super();
		this.embeddingsClient = embeddingsClient;
	}

	async evaluate(
		summary: GeneratedSummary,
		codeUnit: BenchmarkCodeUnit,
		context: EvaluatorContext,
	): Promise<EvaluationResult> {
		const distractorSet = context.distractors?.find(
			(d) => d.targetCodeUnitId === codeUnit.id,
		);

		if (!distractorSet) {
			throw new ContrastiveError("No distractor set for code unit", {
				codeUnitId: codeUnit.id,
			});
		}

		const allUnits = context.allCodeUnits || [];
		const distractorUnits = distractorSet.distractorIds
			.map((id) => allUnits.find((u) => u.id === id))
			.filter((u): u is BenchmarkCodeUnit => u !== undefined);

		// Embed summary and all code candidates
		const candidates = [codeUnit, ...distractorUnits];
		const texts = [summary.summary, ...candidates.map((c) => c.content)];

		const embedResult = await this.embeddingsClient.embed(texts);
		const embeddings = embedResult.embeddings;

		const summaryEmb = embeddings[0];
		const codeEmbs = embeddings.slice(1);

		// Calculate similarities
		const similarities = codeEmbs.map((emb, idx) => ({
			unitId: candidates[idx].id,
			similarity: cosineSimilarity(summaryEmb, emb) || 0,
			isTarget: candidates[idx].id === codeUnit.id,
		}));

		// Sort by similarity (descending)
		similarities.sort((a, b) => b.similarity - a.similarity);

		// Find rank of target
		const targetRank = similarities.findIndex((s) => s.isTarget) + 1;

		const contrastiveResults: ContrastiveResults = {
			correct: targetRank === 1,
			predictedRank: targetRank,
			distractorIds: distractorSet.distractorIds,
			method: "embedding",
			confidenceGap: similarities[0].similarity - similarities[1].similarity,
			embeddingModel: this.embeddingsClient.getModel(),
		};

		return {
			id: randomUUID(),
			summaryId: summary.id,
			evaluationType: "contrastive",
			contrastiveResults,
			evaluatedAt: new Date().toISOString(),
		};
	}

	getType() {
		return "contrastive" as const;
	}
}

// ============================================================================
// LLM-based Contrastive Evaluator
// ============================================================================

interface ContrastiveLLMResponse {
	selected: number;
	confidence: "high" | "medium" | "low";
	reasoning: string;
}

export class LLMContrastiveEvaluator extends BaseEvaluator<EvaluationResult> {
	constructor(llmClient: ILLMClient) {
		super(llmClient);
	}

	async evaluate(
		summary: GeneratedSummary,
		codeUnit: BenchmarkCodeUnit,
		context: EvaluatorContext,
	): Promise<EvaluationResult> {
		if (!this.llmClient) {
			throw new ContrastiveError("No LLM client provided");
		}

		const distractorSet = context.distractors?.find(
			(d) => d.targetCodeUnitId === codeUnit.id,
		);

		if (!distractorSet) {
			throw new ContrastiveError("No distractor set for code unit", {
				codeUnitId: codeUnit.id,
			});
		}

		const allUnits = context.allCodeUnits || [];
		const distractorUnits = distractorSet.distractorIds
			.map((id) => allUnits.find((u) => u.id === id))
			.filter((u): u is BenchmarkCodeUnit => u !== undefined);

		// Randomize order of candidates
		const candidates = [codeUnit, ...distractorUnits].sort(
			() => Math.random() - 0.5,
		);
		const targetPosition =
			candidates.findIndex((c) => c.id === codeUnit.id) + 1;

		// Build code options string
		const codeOptions = candidates
			.map(
				(c, idx) =>
					`### Option ${idx + 1}\n\`\`\`${c.language}\n${this.truncateCode(c.content, 1500)}\n\`\`\``,
			)
			.join("\n\n");

		const prompt = CONTRASTIVE_LLM_PROMPT.replace("{summary}", summary.summary)
			.replace("{code_options}", codeOptions)
			.replace(/{n}/g, String(candidates.length));

		const messages: LLMMessage[] = [{ role: "user", content: prompt }];

		try {
			const response = await this.llmClient.complete(messages, {
				temperature: 0,
				maxTokens: 500,
			});

			const parsed = this.parseJSONResponse<ContrastiveLLMResponse>(
				response.content,
			);

			const correct = parsed.selected === targetPosition;

			const contrastiveResults: ContrastiveResults = {
				correct,
				predictedRank: correct ? 1 : 2, // Simplified - either got it or didn't
				distractorIds: distractorSet.distractorIds,
				method: "llm",
				llmModel: this.llmClient.getModel(),
			};

			return {
				id: randomUUID(),
				summaryId: summary.id,
				evaluationType: "contrastive",
				contrastiveResults,
				evaluatedAt: new Date().toISOString(),
			};
		} catch (error) {
			throw new ContrastiveError(
				error instanceof Error ? error.message : String(error),
				{ summaryId: summary.id, codeUnitId: codeUnit.id },
				error instanceof Error ? error : undefined,
			);
		}
	}

	getType() {
		return "contrastive" as const;
	}
}

// ============================================================================
// Factory Functions
// ============================================================================

export function createEmbeddingContrastiveEvaluator(
	embeddingsClient: IEmbeddingsClient,
): EmbeddingContrastiveEvaluator {
	return new EmbeddingContrastiveEvaluator(embeddingsClient);
}

export function createLLMContrastiveEvaluator(
	llmClient: ILLMClient,
): LLMContrastiveEvaluator {
	return new LLMContrastiveEvaluator(llmClient);
}

// ============================================================================
// Phase Executor
// ============================================================================

/**
 * Create the contrastive evaluation phase executor
 */
export function createContrastivePhaseExecutor(
	llmClient?: ILLMClient,
	embeddingsClient?: IEmbeddingsClient,
): (context: PhaseContext) => Promise<PhaseResult> {
	return async (context: PhaseContext): Promise<PhaseResult> => {
		const { db, run, config, stateMachine } = context;
		const evalConfig = config.evaluation.contrastive;

		if (!evalConfig.enabled) {
			return {
				success: true,
				itemsProcessed: 0,
				skipReason: "disabled in config",
			};
		}

		try {
			// Get data
			const summaries = db.getSummaries(run.id);
			const codeUnits = db.getCodeUnits(run.id);

			// Resume support: get existing evaluation results
			const existingResults = db.getEvaluationResults(run.id, "contrastive");
			const evaluatedContrastive = new Set<string>(); // key: summaryId:method
			for (const result of existingResults) {
				if (result.contrastiveResults) {
					const key = `${result.summaryId}:${result.contrastiveResults.method}`;
					evaluatedContrastive.add(key);
				}
			}

			// Calculate methods to run
			const methods: ("embedding" | "llm")[] = [];
			if (evalConfig.method === "both") {
				if (embeddingsClient) methods.push("embedding");
				if (llmClient) methods.push("llm");
			} else if (evalConfig.method === "embedding" && embeddingsClient) {
				methods.push("embedding");
			} else if (evalConfig.method === "llm" && llmClient) {
				methods.push("llm");
			}

			if (methods.length === 0) {
				return {
					success: true,
					itemsProcessed: 0,
					skipReason: "no evaluation clients available",
				};
			}

			// Adaptive distractor count based on largest same-language group
			// Distractors must be same language, so we need enough units per language
			const languageCounts = new Map<string, number>();
			for (const unit of codeUnits) {
				languageCounts.set(
					unit.language,
					(languageCounts.get(unit.language) || 0) + 1,
				);
			}
			const maxLanguageCount = Math.max(...languageCounts.values());

			// Max possible distractors = largest language group - 1 (excluding target)
			const maxPossibleDistractors = maxLanguageCount - 1;
			const minDistractors = 4;
			let actualDistractorCount = Math.min(
				evalConfig.distractorCount,
				maxPossibleDistractors,
			);

			if (actualDistractorCount < minDistractors) {
				const langInfo = Array.from(languageCounts.entries())
					.map(([lang, count]) => `${lang}:${count}`)
					.join(", ");
				return {
					success: true,
					itemsProcessed: 0,
					skipReason: `largest language group has ${maxLanguageCount} units, need ${minDistractors + 1}+ (${langInfo})`,
				};
			}

			// Pre-compute code embeddings for semantic distractor selection
			// This enables TIER 3 (hard distractors) - finding code similar to target
			let codeEmbeddings: Map<string, number[]> | undefined;
			if (embeddingsClient) {
				try {
					// Show progress - this can be slow for large codebases
					stateMachine.startPhase("evaluation:contrastive", 0);
					stateMachine.updateProgress(
						"evaluation:contrastive",
						0,
						undefined,
						`Embedding ${codeUnits.length} code units for semantic distractors...`,
					);

					// Embed in batches for progress visibility
					const BATCH_SIZE = 50;
					const codeTexts = codeUnits.map((u) => u.content);
					const allEmbeddings: number[][] = [];

					for (let i = 0; i < codeTexts.length; i += BATCH_SIZE) {
						const batchEnd = Math.min(i + BATCH_SIZE, codeTexts.length);
						const batchTexts = codeTexts.slice(i, batchEnd);

						stateMachine.updateProgress(
							"evaluation:contrastive",
							0,
							undefined,
							`Embedding code ${batchEnd}/${codeUnits.length}...`,
						);
						const result = await embeddingsClient.embed(batchTexts);
						allEmbeddings.push(...result.embeddings);
					}

					codeEmbeddings = new Map();
					codeUnits.forEach((unit, idx) => {
						codeEmbeddings!.set(unit.id, allEmbeddings[idx]);
					});

					stateMachine.updateProgress(
						"evaluation:contrastive",
						0,
						undefined,
						"Generating distractor sets...",
					);
				} catch (error) {
					// Fall back to non-semantic distractor selection (silent)
				}
			}

			// Generate distractor sets FIRST (before starting phase)
			const distractorSets: DistractorSet[] = [];
			for (const codeUnit of codeUnits) {
				try {
					const set = selectDistractors(
						codeUnit,
						codeUnits,
						actualDistractorCount,
						codeEmbeddings, // Pass embeddings for TIER 3 selection
					);
					distractorSets.push(set);
				} catch (error) {
					// Skip units without enough distractors (different language/type)
					continue;
				}
			}

			// If no distractor sets could be generated, skip evaluation
			if (distractorSets.length === 0) {
				const langInfo = Array.from(languageCounts.entries())
					.map(([lang, count]) => `${lang}:${count}`)
					.join(", ");
				return {
					success: true,
					itemsProcessed: 0,
					skipReason: `no language has ${actualDistractorCount + 1}+ code units (${langInfo})`,
				};
			}

			// Get code unit IDs that have valid distractor sets
			const validCodeUnitIds = new Set(
				distractorSets.map((ds) => ds.targetCodeUnitId),
			);

			// Filter summaries to only those with valid distractor sets
			const validSummaries = summaries.filter((s) =>
				validCodeUnitIds.has(s.codeUnitId),
			);

			// Only start phase after we know we have work to do
			const totalItems = validSummaries.length * methods.length;
			stateMachine.startPhase("evaluation:contrastive", totalItems);

			// Save distractor sets
			db.insertDistractorSets(run.id, distractorSets);

			const concurrency = 30; // Process 30 summaries concurrently
			const REQUEST_TIMEOUT_MS = 60_000; // 60 second timeout per request

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

			// Build code unit map for faster lookups
			const codeUnitMap = new Map(codeUnits.map((u) => [u.id, u]));

			// Run methods in parallel
			const methodPromises = methods.map(async (method) => {
				const evaluator =
					method === "embedding"
						? createEmbeddingContrastiveEvaluator(embeddingsClient!)
						: createLLMContrastiveEvaluator(llmClient!);

				let methodCompleted = 0;
				const inProgress = new Set<string>();

				const processSummary = async (
					summary: (typeof validSummaries)[0],
				): Promise<void> => {
					const codeUnit = codeUnitMap.get(summary.codeUnitId);
					if (!codeUnit) return;

					// Resume support: skip already evaluated
					const evalKey = `${summary.id}:${method}`;
					if (evaluatedContrastive.has(evalKey)) {
						methodCompleted++;
						return;
					}

					inProgress.add(summary.id);

					try {
						const result = await withTimeout(
							evaluator.evaluate(summary, codeUnit, {
								allCodeUnits: codeUnits,
								distractors: distractorSets,
							}),
							REQUEST_TIMEOUT_MS,
						);
						db.insertEvaluationResult(run.id, result);
					} catch (error) {
						// Skip silently to not disrupt progress bar
					}

					inProgress.delete(summary.id);
					methodCompleted++;

					stateMachine.updateProgress(
						"evaluation:contrastive",
						methodCompleted,
						summary.id,
						`${method}: ${methodCompleted}/${validSummaries.length}/${inProgress.size}`,
					);
				};

				// Initial progress
				stateMachine.updateProgress(
					"evaluation:contrastive",
					0,
					undefined,
					`${method}: 0/${validSummaries.length}/0`,
				);

				// Process in concurrent batches with allSettled (don't block on failures)
				for (let i = 0; i < validSummaries.length; i += concurrency) {
					const batch = validSummaries.slice(i, i + concurrency);
					await Promise.allSettled(batch.map(processSummary));
				}

				return methodCompleted;
			});

			const results = await Promise.all(methodPromises);
			const completed = results.reduce((sum, count) => sum + count, 0);

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
