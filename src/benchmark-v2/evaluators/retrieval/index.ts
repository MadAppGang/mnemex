/**
 * Retrieval Evaluator
 *
 * Evaluates how well summaries help retrieve the correct code
 * when searching with natural language queries.
 *
 * Metrics:
 * - Precision@K (P@K): Did target appear in top K results?
 * - Mean Reciprocal Rank (MRR): 1/rank of target
 */

import { randomUUID } from "crypto";
import type {
	IEmbeddingsClient,
	LLMMessage,
	ILLMClient,
} from "../../../types.js";
import type {
	BenchmarkCodeUnit,
	GeneratedSummary,
	GeneratedQuery,
	EvaluationResult,
	RetrievalResults,
	EvaluatorContext,
	QueryType,
} from "../../types.js";
import { BaseEvaluator } from "../base.js";
import { RetrievalError } from "../../errors.js";
import { createQueryGenerator } from "../../extractors/query-generator.js";
import type { PhaseContext, PhaseResult } from "../../pipeline/orchestrator.js";

// ============================================================================
// Vector Index (Simple In-Memory)
// ============================================================================

interface IndexEntry {
	summaryId: string;
	codeUnitId: string;
	modelId: string;
	embedding: number[];
}

class SimpleVectorIndex {
	private entries: IndexEntry[] = [];

	add(
		summaryId: string,
		codeUnitId: string,
		modelId: string,
		embedding: number[],
	): void {
		this.entries.push({ summaryId, codeUnitId, modelId, embedding });
	}

	/**
	 * Search and return results with model information
	 */
	search(
		queryEmbedding: number[],
		k: number,
	): Array<{ codeUnitId: string; modelId: string; score: number }> {
		// Calculate similarities
		const similarities = this.entries.map((entry) => ({
			codeUnitId: entry.codeUnitId,
			modelId: entry.modelId,
			score: this.cosineSimilarity(queryEmbedding, entry.embedding),
		}));

		// Sort by similarity (descending) and take top K
		return similarities.sort((a, b) => b.score - a.score).slice(0, k);
	}

	/**
	 * Search for a specific code unit across all models
	 * Returns the rank of each model's summary for this code unit
	 */
	searchWithModelRanks(
		queryEmbedding: number[],
		targetCodeUnitId: string,
	): Map<string, { rank: number; score: number }> {
		// Calculate all similarities
		const similarities = this.entries.map((entry) => ({
			codeUnitId: entry.codeUnitId,
			modelId: entry.modelId,
			score: this.cosineSimilarity(queryEmbedding, entry.embedding),
		}));

		// Sort by similarity (descending)
		similarities.sort((a, b) => b.score - a.score);

		// Find rank of each model's summary for the target code unit
		const modelRanks = new Map<string, { rank: number; score: number }>();

		for (let i = 0; i < similarities.length; i++) {
			const entry = similarities[i];
			if (entry.codeUnitId === targetCodeUnitId) {
				// First occurrence of this model for this code unit
				if (!modelRanks.has(entry.modelId)) {
					modelRanks.set(entry.modelId, {
						rank: i + 1, // 1-indexed rank
						score: entry.score,
					});
				}
			}
		}

		return modelRanks;
	}

	private cosineSimilarity(a: number[], b: number[]): number {
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

	clear(): void {
		this.entries = [];
	}

	size(): number {
		return this.entries.length;
	}

	getModelCount(): number {
		return new Set(this.entries.map((e) => e.modelId)).size;
	}
}

// ============================================================================
// Retrieval Evaluator
// ============================================================================

export interface RetrievalEvaluatorOptions {
	embeddingsClient: IEmbeddingsClient;
	kValues: number[];
}

export class RetrievalEvaluator extends BaseEvaluator<EvaluationResult[]> {
	private embeddingsClient: IEmbeddingsClient;
	private kValues: number[];
	private index: SimpleVectorIndex;
	private modelIds: string[] = [];

	constructor(options: RetrievalEvaluatorOptions) {
		super();
		this.embeddingsClient = options.embeddingsClient;
		this.kValues = options.kValues;
		this.index = new SimpleVectorIndex();
	}

	/**
	 * Build a COMBINED index from ALL models' summaries
	 * This enables cross-model competition where models compete to have
	 * their summaries rank highest for each query.
	 *
	 * @param onProgress Optional callback for progress updates during embedding
	 */
	async buildCombinedIndex(
		summariesByModel: Map<string, GeneratedSummary[]>,
		onProgress?: (message: string) => void,
	): Promise<void> {
		this.index.clear();
		this.modelIds = Array.from(summariesByModel.keys());

		// Collect all summaries with their model IDs
		const allSummaries: Array<{ summary: GeneratedSummary; modelId: string }> =
			[];
		for (const [modelId, summaries] of summariesByModel) {
			for (const summary of summaries) {
				allSummaries.push({ summary, modelId });
			}
		}

		const total = allSummaries.length;
		onProgress?.(`Embedding ${total} summaries...`);

		// Embed in batches for progress visibility
		const BATCH_SIZE = 50;
		const texts = allSummaries.map((s) => s.summary.summary);
		const allEmbeddings: number[][] = [];

		for (let i = 0; i < texts.length; i += BATCH_SIZE) {
			const batchEnd = Math.min(i + BATCH_SIZE, texts.length);
			const batchTexts = texts.slice(i, batchEnd);

			onProgress?.(`Embedding ${batchEnd}/${total} summaries...`);
			const embedResult = await this.embeddingsClient.embed(batchTexts);
			allEmbeddings.push(...embedResult.embeddings);
		}

		onProgress?.(`Indexing ${total} summaries...`);
		for (let i = 0; i < allSummaries.length; i++) {
			const { summary, modelId } = allSummaries[i];
			this.index.add(summary.id, summary.codeUnitId, modelId, allEmbeddings[i]);
		}
	}

	/**
	 * Build index for a single model (legacy compatibility)
	 */
	async buildIndex(summaries: GeneratedSummary[]): Promise<void> {
		this.index.clear();
		const modelId = summaries[0]?.modelId || "unknown";
		this.modelIds = [modelId];

		const texts = summaries.map((s) => s.summary);
		const embedResult = await this.embeddingsClient.embed(texts);

		for (let i = 0; i < summaries.length; i++) {
			this.index.add(
				summaries[i].id,
				summaries[i].codeUnitId,
				modelId,
				embedResult.embeddings[i],
			);
		}
	}

	/**
	 * Evaluate retrieval with cross-model competition
	 * Returns results for ALL models for a single query
	 */
	async evaluateQueryCrossModel(
		query: GeneratedQuery,
		summariesByModel: Map<string, GeneratedSummary[]>,
	): Promise<EvaluationResult[]> {
		// Embed the query
		const queryEmbedding = await this.embeddingsClient.embedOne(query.query);

		// Get ranks for all models
		const modelRanks = this.index.searchWithModelRanks(
			queryEmbedding,
			query.codeUnitId,
		);

		// Total items in index (for calculating relative rank)
		const totalItems = this.index.size();
		const numModels = this.index.getModelCount();

		// Create a result for each model
		const results: EvaluationResult[] = [];

		for (const [modelId, summaries] of summariesByModel) {
			const rankInfo = modelRanks.get(modelId);

			// If this model doesn't have a summary for this code unit, skip
			if (!rankInfo) continue;

			const rank = rankInfo.rank;

			// Calculate hit@K for each K value
			// Note: K is now relative to ALL summaries in the combined index
			const hitAtK: Record<number, boolean> = {};
			for (const k of this.kValues) {
				hitAtK[k] = rank <= k;
			}

			// Calculate "model rank" - which model ranked highest among models?
			// Sort all models by their rank for this query
			const sortedModels = Array.from(modelRanks.entries()).sort(
				(a, b) => a[1].rank - b[1].rank,
			);
			const modelPosition = sortedModels.findIndex(([m]) => m === modelId) + 1;

			// Find the summary for this code unit from this model
			const targetSummary = summaries.find(
				(s) => s.codeUnitId === query.codeUnitId,
			);
			if (!targetSummary) continue;

			const retrievalResults: RetrievalResults = {
				queryId: query.id,
				queryType: query.type,
				query: query.query,
				hitAtK,
				reciprocalRank: 1 / rank,
				retrievedRank: rank,
				// New fields for cross-model competition
				modelRank: modelPosition, // 1 = best among models
				totalModels: numModels,
				isWinner: modelPosition === 1,
				poolSize: totalItems,
			};

			results.push({
				id: randomUUID(),
				summaryId: targetSummary.id,
				evaluationType: "retrieval",
				retrievalResults,
				evaluatedAt: new Date().toISOString(),
			});
		}

		return results;
	}

	/**
	 * Evaluate retrieval for a single query (single model, legacy)
	 */
	async evaluateQuery(
		query: GeneratedQuery,
		modelId: string,
		summaries: GeneratedSummary[],
	): Promise<EvaluationResult> {
		// Embed the query
		const queryEmbedding = await this.embeddingsClient.embedOne(query.query);

		// Search the index
		const maxK = Math.max(...this.kValues);
		const results = this.index.search(queryEmbedding, maxK);

		// Find rank of target (first match for this code unit)
		const targetRank =
			results.findIndex((r) => r.codeUnitId === query.codeUnitId) + 1;

		// Calculate hit@K for each K value
		const hitAtK: Record<number, boolean> = {};
		for (const k of this.kValues) {
			hitAtK[k] = targetRank > 0 && targetRank <= k;
		}

		const retrievalResults: RetrievalResults = {
			queryId: query.id,
			queryType: query.type,
			query: query.query,
			hitAtK,
			reciprocalRank: targetRank > 0 ? 1 / targetRank : 0,
			retrievedRank: targetRank > 0 ? targetRank : null,
		};

		// Find a representative summary for the foreign key
		const targetSummary =
			summaries.find((s) => s.codeUnitId === query.codeUnitId) || summaries[0];

		if (!targetSummary) {
			throw new RetrievalError(`No summary found for model ${modelId}`);
		}

		return {
			id: randomUUID(),
			summaryId: targetSummary.id,
			evaluationType: "retrieval",
			retrievalResults,
			evaluatedAt: new Date().toISOString(),
		};
	}

	/**
	 * Evaluate retrieval for all queries
	 */
	async evaluate(
		_summary: GeneratedSummary,
		_codeUnit: BenchmarkCodeUnit,
		context: EvaluatorContext,
	): Promise<EvaluationResult[]> {
		const queries = context.queries || [];
		const results: EvaluationResult[] = [];

		for (const query of queries) {
			try {
				const result = await this.evaluateQuery(query, "combined", []);
				results.push(result);
			} catch (error) {
				// Skip silently to not disrupt progress bar
			}
		}

		return results;
	}

	getType() {
		return "retrieval" as const;
	}
}

// ============================================================================
// Aggregated Retrieval Metrics
// ============================================================================

export interface AggregatedRetrievalMetrics {
	modelId: string;
	precision: Record<number, number>;
	mrr: number;
	/** Win rate: How often did this model's summary rank #1 among all models? */
	winRate: number;
	/** Average model rank (1 = best, lower is better) */
	avgModelRank: number;
	byQueryType: Record<
		QueryType,
		{
			precision: Record<number, number>;
			mrr: number;
			winRate: number;
			count: number;
		}
	>;
}

export function aggregateRetrievalResults(
	results: RetrievalResults[],
	kValues: number[],
): AggregatedRetrievalMetrics {
	if (results.length === 0) {
		return {
			modelId: "",
			precision: Object.fromEntries(kValues.map((k) => [k, 0])),
			mrr: 0,
			winRate: 0,
			avgModelRank: 0,
			byQueryType: {} as any,
		};
	}

	// Calculate overall precision@K
	const precision: Record<number, number> = {};
	for (const k of kValues) {
		const hits = results.filter((r) => r.hitAtK[k]).length;
		precision[k] = hits / results.length;
	}

	// Calculate MRR
	const mrr =
		results.reduce((sum, r) => sum + r.reciprocalRank, 0) / results.length;

	// Calculate win rate (cross-model competition)
	const resultsWithModelRank = results.filter((r) => r.modelRank !== undefined);
	const winRate =
		resultsWithModelRank.length > 0
			? resultsWithModelRank.filter((r) => r.isWinner).length /
				resultsWithModelRank.length
			: 0;

	// Calculate average model rank
	const avgModelRank =
		resultsWithModelRank.length > 0
			? resultsWithModelRank.reduce((sum, r) => sum + (r.modelRank || 0), 0) /
				resultsWithModelRank.length
			: 0;

	// Group by query type
	const byType = new Map<QueryType, RetrievalResults[]>();
	for (const result of results) {
		const type = result.queryType as QueryType;
		if (!byType.has(type)) {
			byType.set(type, []);
		}
		byType.get(type)!.push(result);
	}

	const byQueryType: AggregatedRetrievalMetrics["byQueryType"] = {} as any;
	for (const [type, typeResults] of byType) {
		const typePrecision: Record<number, number> = {};
		for (const k of kValues) {
			const hits = typeResults.filter((r) => r.hitAtK[k]).length;
			typePrecision[k] = hits / typeResults.length;
		}

		const typeResultsWithRank = typeResults.filter(
			(r) => r.modelRank !== undefined,
		);
		const typeWinRate =
			typeResultsWithRank.length > 0
				? typeResultsWithRank.filter((r) => r.isWinner).length /
					typeResultsWithRank.length
				: 0;

		byQueryType[type] = {
			precision: typePrecision,
			mrr:
				typeResults.reduce((sum, r) => sum + r.reciprocalRank, 0) /
				typeResults.length,
			winRate: typeWinRate,
			count: typeResults.length,
		};
	}

	return {
		modelId: "",
		precision,
		mrr,
		winRate,
		avgModelRank,
		byQueryType,
	};
}

// ============================================================================
// Factory Function
// ============================================================================

export function createRetrievalEvaluator(
	options: RetrievalEvaluatorOptions,
): RetrievalEvaluator {
	return new RetrievalEvaluator(options);
}

// ============================================================================
// Phase Executor
// ============================================================================

/**
 * Create the retrieval evaluation phase executor
 *
 * Uses CROSS-MODEL COMPETITION: All models' summaries are indexed together.
 * For each query, we measure which model's summary ranks highest.
 * This provides much better model discrimination than per-model indexing.
 */
export function createRetrievalPhaseExecutor(
	embeddingsClient: IEmbeddingsClient,
	llmClient?: ILLMClient,
): (context: PhaseContext) => Promise<PhaseResult> {
	return async (context: PhaseContext): Promise<PhaseResult> => {
		const { db, run, config, stateMachine } = context;
		const evalConfig = config.evaluation.retrieval;

		if (!evalConfig.enabled) {
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

			const numModels = summariesByModel.size;

			// Resume support: get existing evaluation results
			const existingResults = db.getEvaluationResults(run.id, "retrieval");
			const evaluatedRetrieval = new Set<string>(); // key: queryId (all models evaluated together)
			// Count how many results exist per query - a query is complete when it has numModels results
			const resultCountByQuery = new Map<string, number>();
			for (const result of existingResults) {
				if (result.retrievalResults) {
					const queryId = result.retrievalResults.queryId;
					resultCountByQuery.set(
						queryId,
						(resultCountByQuery.get(queryId) || 0) + 1,
					);
				}
			}
			// Mark queries as evaluated if they have results for all models
			for (const [queryId, count] of resultCountByQuery) {
				if (count >= numModels) {
					evaluatedRetrieval.add(queryId);
				}
			}

			// Generate queries if needed
			let queries = db.getQueries(run.id);
			if (queries.length === 0) {
				stateMachine.startPhase("evaluation:retrieval", 0);
				stateMachine.updateProgress(
					"evaluation:retrieval",
					0,
					undefined,
					"Generating search queries...",
				);

				if (llmClient) {
					const queryGen = createQueryGenerator({ llmClient });
					queries = await queryGen.generateForCodeUnits(codeUnits);
				} else {
					const queryGen = createQueryGenerator({
						llmClient: null as any,
					});
					queries = codeUnits.flatMap((u) => queryGen.generateSimpleQueries(u));
				}

				db.insertQueries(run.id, queries);
			}

			// Total: each query produces one result per model
			const totalItems = queries.length * numModels;
			let completed = 0;

			stateMachine.startPhase("evaluation:retrieval", totalItems);

			// Create evaluator and build COMBINED index with ALL models' summaries
			const evaluator = createRetrievalEvaluator({
				embeddingsClient,
				kValues: evalConfig.kValues,
			});

			stateMachine.updateProgress(
				"evaluation:retrieval",
				0,
				undefined,
				`Building combined index (${summaries.length} summaries from ${numModels} models)...`,
			);

			// Build ONE index with ALL summaries - models compete!
			// Pass progress callback for embedding visibility
			await evaluator.buildCombinedIndex(summariesByModel, (msg) => {
				stateMachine.updateProgress("evaluation:retrieval", 0, undefined, msg);
			});

			// Evaluate each query with cross-model competition
			for (const query of queries) {
				// Resume support: skip already-evaluated queries
				if (evaluatedRetrieval.has(query.id)) {
					completed += numModels;
					continue;
				}

				try {
					// This returns results for ALL models in one call
					const results = await evaluator.evaluateQueryCrossModel(
						query,
						summariesByModel,
					);

					for (const result of results) {
						db.insertEvaluationResult(run.id, result);
						completed++;
					}

					stateMachine.updateProgress(
						"evaluation:retrieval",
						completed,
						query.id,
						`Cross-model: ${completed}/${totalItems}`,
					);
				} catch (error) {
					// Skip query but count the models we would have evaluated
					completed += numModels;
				}
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
