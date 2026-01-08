/**
 * Retrieval Refinement Strategy
 *
 * Tests summary quality by checking if it ranks well in retrieval.
 * Uses embedding-based similarity to rank the summary against competitors.
 *
 * Success criterion: Summary ranks within top-K for relevant queries.
 */

import type { IEmbeddingsClient } from "../../../../types.js";
import type { QualityTestResult, RefinementContext } from "../types.js";
import {
	BaseRefinementStrategy,
	cosineSimilarity,
	truncateForFeedback,
} from "./base.js";

// ============================================================================
// Retry Helper (for LMStudio model contention)
// ============================================================================

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

async function withRetry<T>(
	fn: () => Promise<T>,
	retries = MAX_RETRIES,
	delay = RETRY_DELAY_MS,
): Promise<T> {
	let lastError: Error | undefined;
	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			return await fn();
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));
			const isRetryable =
				lastError.message.includes("Model unloaded") ||
				lastError.message.includes("Model does not exist") ||
				lastError.message.includes("Model has unloaded");

			if (!isRetryable || attempt === retries) {
				throw lastError;
			}
			// Wait before retry (with exponential backoff)
			await new Promise((r) => setTimeout(r, delay * (attempt + 1)));
		}
	}
	throw lastError;
}

// ============================================================================
// Types
// ============================================================================

export interface RetrievalStrategyOptions {
	/** Embeddings client for vectorizing summaries */
	embeddingsClient: IEmbeddingsClient;
	/** Target rank for success (default: 3) */
	targetRank?: number;
	/** Optional: pre-computed query embeddings by code unit ID */
	queryEmbeddingsCache?: Map<string, number[]>;
}

// ============================================================================
// Retrieval Strategy
// ============================================================================

export class RetrievalRefinementStrategy extends BaseRefinementStrategy {
	private embeddingsClient: IEmbeddingsClient;
	private queryEmbeddingsCache: Map<string, number[]>;

	constructor(options: RetrievalStrategyOptions) {
		super(options.targetRank ?? 3);
		this.embeddingsClient = options.embeddingsClient;
		this.queryEmbeddingsCache = options.queryEmbeddingsCache ?? new Map();
	}

	/**
	 * Set query embeddings cache (for batch pre-embedding)
	 */
	setQueryEmbeddingsCache(cache: Map<string, number[]>): void {
		this.queryEmbeddingsCache = cache;
	}

	getName(): string {
		return "retrieval";
	}

	/**
	 * Test summary quality by checking its retrieval rank
	 *
	 * 1. Embed the summary being tested
	 * 2. Embed all competitor summaries
	 * 3. For each query, calculate similarity rankings
	 * 4. Average the rank across all queries
	 */
	async testQuality(
		summary: string,
		context: RefinementContext,
	): Promise<QualityTestResult> {
		const { competitors = [], queries = [] } = context;

		// If no competitors, the summary is automatically #1
		if (competitors.length === 0) {
			return {
				passed: true,
				rank: 1,
				score: 1.0,
				details: {
					totalCandidates: 1,
					query: queries[0],
				},
			};
		}

		// If no queries provided, generate a simple one from the code
		const testQueries =
			queries.length > 0 ? queries : [this.generateSimpleQuery(context)];

		// Use pre-computed embedding if available (for initial summary), otherwise embed
		// This avoids re-embedding the initial summary which was already pre-embedded
		let summaryEmbedding = context.summaryEmbedding;
		if (!summaryEmbedding) {
			// Embed the test summary (with retry for LMStudio model contention)
			summaryEmbedding = await withRetry(() =>
				this.embeddingsClient.embedOne(summary),
			);
		}

		// Embed competitors if not already embedded (with retry)
		const competitorEmbeddings = await withRetry(() =>
			this.embedCompetitors(competitors),
		);

		// Test against each query and collect ranks
		const ranks: number[] = [];
		let bestRank = Infinity;
		let bestQuery = "";
		let winningSummary = "";
		let winningModelId = "";

		for (const query of testQueries) {
			// Use cached query embedding if available, otherwise embed
			// This avoids model switching in LMStudio when we've pre-embedded queries
			const codeUnitId = context.metadata.codeUnitId;
			let queryEmbedding = codeUnitId
				? this.queryEmbeddingsCache.get(codeUnitId)
				: undefined;

			if (!queryEmbedding) {
				// Embed the query (with retry for LMStudio model contention)
				queryEmbedding = await withRetry(() =>
					this.embeddingsClient.embedOne(query),
				);
			}

			// Calculate similarity of test summary to query
			const testSimilarity = cosineSimilarity(queryEmbedding, summaryEmbedding);

			// Calculate similarities of all competitors to query
			const allSimilarities: Array<{
				similarity: number;
				summary: string;
				modelId: string;
				isTest: boolean;
			}> = [
				{
					similarity: testSimilarity,
					summary,
					modelId: "test",
					isTest: true,
				},
				...competitorEmbeddings.map((c, i) => ({
					similarity: cosineSimilarity(queryEmbedding, c.embedding),
					summary: competitors[i].summary,
					modelId: competitors[i].modelId,
					isTest: false,
				})),
			];

			// Sort by similarity (descending)
			allSimilarities.sort((a, b) => b.similarity - a.similarity);

			// Find rank of test summary (1-indexed)
			const rank = allSimilarities.findIndex((s) => s.isTest) + 1;
			ranks.push(rank);

			// Track best rank and winning summary
			if (rank < bestRank) {
				bestRank = rank;
				bestQuery = query;
			}

			// Track the winner (for feedback)
			const winner = allSimilarities[0];
			if (!winner.isTest) {
				winningSummary = winner.summary;
				winningModelId = winner.modelId;
			}
		}

		// Calculate average rank across all queries
		const avgRank = ranks.reduce((a, b) => a + b, 0) / ranks.length;
		const roundedRank = Math.round(avgRank);

		// Calculate score (inverse of rank, normalized)
		const totalCandidates = competitors.length + 1;
		const score = 1 - (roundedRank - 1) / totalCandidates;

		// Adjust target rank based on number of candidates
		// With few candidates, require being near the top (top 50%)
		// This prevents trivial passes when there are only 2-3 candidates
		const effectiveTargetRank = Math.min(
			this.targetRank,
			Math.max(1, Math.ceil(totalCandidates * 0.5)),
		);

		// Debug log to verify fix is applied
		if (process.env.DEBUG_ITERATIVE) {
			console.log(
				`[DEBUG] rank=${roundedRank}, target=${this.targetRank}, effective=${effectiveTargetRank}, candidates=${totalCandidates}, passed=${roundedRank <= effectiveTargetRank}`,
			);
		}

		return {
			passed: roundedRank <= effectiveTargetRank,
			rank: roundedRank,
			score,
			details: {
				totalCandidates,
				effectiveTargetRank,
				winningSummary: winningSummary || undefined,
				query: bestQuery,
				winningModelId: winningModelId || undefined,
			},
		};
	}

	/**
	 * Generate feedback to help the model improve its summary
	 */
	async generateFeedback(
		result: QualityTestResult,
		context: RefinementContext,
	): Promise<string> {
		const { rank, details } = result;
		const { totalCandidates, effectiveTargetRank, winningSummary, query } =
			details;

		// Use effective target rank if available (accounts for small candidate pools)
		const targetRank = effectiveTargetRank ?? this.targetRank;

		const lines: string[] = [];

		// Rank information
		lines.push(
			`📊 Your summary ranked #${rank} out of ${totalCandidates} summaries.`,
		);
		lines.push(`🎯 Target: Rank in the top ${targetRank} to succeed.`);
		lines.push("");

		// Query context
		if (query) {
			lines.push(`🔍 Test query: "${truncateForFeedback(query, 100)}"`);
			lines.push("");
		}

		// Winning summary comparison
		if (winningSummary) {
			lines.push("✅ The top-ranked summary:");
			lines.push(`"${truncateForFeedback(winningSummary, 300)}"`);
			lines.push("");
			lines.push("💡 Consider what makes this summary rank higher:");
			lines.push("   - More specific terminology?");
			lines.push("   - Better matches common search queries?");
			lines.push("   - More concise and focused?");
		} else {
			lines.push("💡 Tips for improvement:");
			lines.push("   - Use terms developers would search for");
			lines.push("   - Focus on WHAT the code does, not HOW");
			lines.push("   - Be specific about the code's purpose");
		}

		return lines.join("\n");
	}

	/**
	 * Embed competitors that don't have embeddings yet
	 */
	private async embedCompetitors(
		competitors: RefinementContext["competitors"],
	): Promise<Array<{ embedding: number[] }>> {
		if (!competitors || competitors.length === 0) {
			return [];
		}

		// Check if all competitors already have embeddings
		const needsEmbedding = competitors.filter((c) => !c.embedding);

		if (needsEmbedding.length === 0) {
			return competitors.map((c) => ({ embedding: c.embedding! }));
		}

		// Embed those that need it
		const textsToEmbed = needsEmbedding.map((c) => c.summary);
		const result = await this.embeddingsClient.embed(textsToEmbed);

		// Merge embeddings back
		let embedIndex = 0;
		return competitors.map((c) => {
			if (c.embedding) {
				return { embedding: c.embedding };
			}
			return { embedding: result.embeddings[embedIndex++] };
		});
	}

	/**
	 * Generate a simple query from code context
	 */
	private generateSimpleQuery(context: RefinementContext): string {
		const { metadata, language } = context;

		if (metadata.symbolName) {
			const type = metadata.symbolType || "code";
			return `${type} ${metadata.symbolName} ${language}`;
		}

		if (metadata.filePath) {
			const filename = metadata.filePath.split("/").pop() || metadata.filePath;
			return `${filename} ${language}`;
		}

		return `${language} code`;
	}
}

// ============================================================================
// Factory Function
// ============================================================================

export function createRetrievalStrategy(
	options: RetrievalStrategyOptions,
): RetrievalRefinementStrategy {
	return new RetrievalRefinementStrategy(options);
}
