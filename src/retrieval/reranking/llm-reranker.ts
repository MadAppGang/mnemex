/**
 * LLM Reranker
 *
 * Uses an LLM to rerank search results based on semantic relevance.
 * This provides a second pass after initial hybrid search to improve
 * precision for complex queries.
 */

import type {
	CodeUnit,
	EnrichedSearchResult,
	ILLMClient,
	LLMMessage,
	RerankResult,
	RerankedSearchResult,
} from "../../types.js";

// ============================================================================
// Types
// ============================================================================

export interface RerankerOptions {
	/** Maximum candidates to rerank (default: 20) */
	maxCandidates?: number;
	/** Minimum score threshold to include (default: 3) */
	minScore?: number;
	/** Whether to include reasoning in results (default: false) */
	includeReasoning?: boolean;
}

export interface RerankableResult {
	/** Unique identifier */
	id: string;
	/** Display name */
	name: string;
	/** Type (function, class, file, etc.) */
	type: string;
	/** File path */
	path: string;
	/** Summary or content snippet */
	summary: string;
	/** Original search score */
	originalScore: number;
	/** Original data (passed through) */
	original: unknown;
}

/** Reranking scores added to results */
export interface RerankingScores {
	/** Score from LLM reranking (0-10) */
	rerankScore: number;
	/** Combined final score */
	finalScore: number;
	/** Reasoning from LLM reranker */
	rerankReason?: string;
}

/** Result with reranking scores added (intersection type for proper generic handling) */
export type RerankedRerankableResult<
	T extends RerankableResult = RerankableResult,
> = T & RerankingScores;

// ============================================================================
// Constants
// ============================================================================

const RERANK_PROMPT = `You are ranking code search results by relevance to a query.

**Query:** {query}

**Candidates:**
{candidates}

Rate each candidate's relevance from 0-10:
- **10**: Exactly what the query is looking for
- **7-9**: Highly relevant, directly addresses the query
- **4-6**: Somewhat relevant, related but not directly answering
- **1-3**: Tangentially related at best
- **0**: Not relevant

Consider:
- Does the code/summary directly address the query's intent?
- Would this help someone trying to understand or modify related functionality?
- Is this the right level of abstraction (not too high-level, not too low-level)?

Respond with JSON only:
\`\`\`json
{
  "rankings": [
    {"index": 1, "score": <0-10>, "reason": "<brief explanation>"},
    {"index": 2, "score": <0-10>, "reason": "<brief explanation>"}
  ]
}
\`\`\``;

// ============================================================================
// LLM Reranker Class
// ============================================================================

export class LLMReranker {
	private llmClient: ILLMClient;
	private options: Required<RerankerOptions>;

	constructor(llmClient: ILLMClient, options: RerankerOptions = {}) {
		this.llmClient = llmClient;
		this.options = {
			maxCandidates: options.maxCandidates ?? 20,
			minScore: options.minScore ?? 3,
			includeReasoning: options.includeReasoning ?? false,
		};
	}

	/**
	 * Rerank search results using LLM
	 * Returns results extended with rerankScore, finalScore, and optional rerankReason
	 */
	async rerank<T extends RerankableResult>(
		query: string,
		results: T[],
	): Promise<RerankedRerankableResult<T>[]> {
		if (results.length === 0) {
			return [];
		}

		// Limit candidates
		const candidates = results.slice(0, this.options.maxCandidates);

		// Format candidates for the prompt
		const candidatesFormatted = candidates
			.map((r, i) => this.formatCandidate(r, i + 1))
			.join("\n");

		// Build prompt
		const prompt = RERANK_PROMPT.replace("{query}", query).replace(
			"{candidates}",
			candidatesFormatted,
		);

		// Call LLM
		const messages: LLMMessage[] = [{ role: "user", content: prompt }];

		try {
			const response = await this.llmClient.completeJSON<{
				rankings: Array<{ index: number; score: number; reason: string }>;
			}>(messages);

			// Build score map
			const scoreMap = new Map<number, { score: number; reason: string }>();
			for (const ranking of response.rankings) {
				scoreMap.set(ranking.index, {
					score: ranking.score,
					reason: ranking.reason,
				});
			}

			// Apply scores and filter (with validation to clamp scores to 0-10 range)
			const reranked = candidates
				.map((result, i) => {
					const ranking = scoreMap.get(i + 1);
					// Validate and clamp rerank score to 0-10 range
					const rawScore = ranking?.score ?? 0;
					const rerankScore = Math.max(0, Math.min(10, rawScore));
					return {
						...result,
						rerankScore,
						rerankReason: this.options.includeReasoning
							? ranking?.reason
							: undefined,
						// Combine original score with rerank score
						finalScore: this.combineScores(result.originalScore, rerankScore),
					};
				})
				.filter((r) => r.rerankScore >= this.options.minScore)
				.sort((a, b) => b.finalScore - a.finalScore);

			return reranked;
		} catch (error) {
			// On error, return original results with default rerank scores
			console.warn("LLM reranking failed, returning original order:", error);
			return candidates.map((result) => ({
				...result,
				rerankScore: 0,
				finalScore: result.originalScore,
				rerankReason: undefined,
			}));
		}
	}

	/**
	 * Rerank enriched search results
	 * Fixed: Proper typing without unsafe type assertions
	 */
	async rerankEnrichedResults(
		query: string,
		results: EnrichedSearchResult[],
	): Promise<RerankedSearchResult[]> {
		if (results.length === 0) {
			return [];
		}

		// Convert to rerankable format
		const rerankable: RerankableResult[] = results.map((r) => ({
			id: r.document.id,
			name: this.extractName(r),
			type: r.documentType,
			path: r.document.filePath || "unknown",
			summary: r.document.content.slice(0, 500), // Limit summary length
			originalScore: r.score,
			original: r,
		}));

		// Rerank - now returns properly typed RerankedRerankableResult[]
		const reranked = await this.rerank(query, rerankable);

		// Convert back to RerankedSearchResult format (now using proper types)
		return reranked.map((r) => {
			const original = r.original as EnrichedSearchResult;
			return {
				...original,
				originalScore: r.originalScore,
				rerankScore: r.rerankScore,
				finalScore: r.finalScore,
				rerankReason: r.rerankReason,
			};
		});
	}

	/**
	 * Rerank code units
	 * Fixed: Proper typing without unsafe type assertions
	 */
	async rerankCodeUnits(
		query: string,
		units: Array<CodeUnit & { score: number }>,
	): Promise<
		Array<CodeUnit & { score: number; rerankScore: number; finalScore: number }>
	> {
		if (units.length === 0) {
			return [];
		}

		// Convert to rerankable format
		const rerankable: RerankableResult[] = units.map((u) => ({
			id: u.id,
			name: u.name || u.signature || "anonymous",
			type: u.unitType,
			path: u.filePath,
			summary: u.content.slice(0, 500),
			originalScore: u.score,
			original: u,
		}));

		// Rerank - now returns properly typed RerankedRerankableResult[]
		const reranked = await this.rerank(query, rerankable);

		// Convert back (now using proper types instead of unsafe casts)
		return reranked.map((r) => {
			const original = r.original as CodeUnit & { score: number };
			return {
				...original,
				rerankScore: r.rerankScore,
				finalScore: r.finalScore,
			};
		});
	}

	/**
	 * Format a candidate for the prompt
	 */
	private formatCandidate(result: RerankableResult, index: number): string {
		return `[${index}] ${result.name} (${result.type}) - ${result.path}
Summary: ${result.summary}
---`;
	}

	/**
	 * Extract display name from enriched result
	 */
	private extractName(result: EnrichedSearchResult): string {
		const metadata = result.document.metadata;
		if (metadata && typeof metadata === "object") {
			if ("name" in metadata && metadata.name) return String(metadata.name);
			if ("symbolName" in metadata && metadata.symbolName)
				return String(metadata.symbolName);
		}
		// Fall back to extracting from content or path
		const path = result.document.filePath || "";
		return path.split("/").pop() || "unknown";
	}

	/**
	 * Combine original score with rerank score
	 */
	private combineScores(originalScore: number, rerankScore: number): number {
		// Weighted combination: rerank score (normalized to 0-1) has higher weight
		const normalizedRerank = rerankScore / 10;
		return originalScore * 0.3 + normalizedRerank * 0.7;
	}
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create an LLM reranker
 */
export function createLLMReranker(
	llmClient: ILLMClient,
	options?: RerankerOptions,
): LLMReranker {
	return new LLMReranker(llmClient, options);
}
