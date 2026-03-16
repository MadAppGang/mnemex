/**
 * Enhanced Retriever
 *
 * Advanced retrieval pipeline that integrates:
 * - Query routing for optimal search strategy
 * - Hierarchical code unit search
 * - LLM-based reranking
 * - Context formatting with attention-aware positioning
 */

import type { IVectorStore } from "../core/store.js";
import type {
	CodeUnit,
	DocumentType,
	EnrichedSearchResult,
	FormattedContext,
	IEmbeddingsClient,
	ILLMClient,
	QueryIntent,
	RerankedSearchResult,
	UnitType,
} from "../types.js";
import {
	type ContextFormatter,
	type FormatInput,
	createContextFormatter,
} from "./formatting/context-formatter.js";
import {
	type LLMReranker,
	createLLMReranker,
} from "./reranking/llm-reranker.js";
import {
	type QueryRouter,
	type RouteResult,
	createQueryRouter,
} from "./routing/query-router.js";

// ============================================================================
// Types
// ============================================================================

export interface EnhancedRetrieverOptions {
	/** Use query routing (default: true) */
	useQueryRouting?: boolean;
	/** Use LLM reranking (default: true when LLM available) */
	useReranking?: boolean;
	/** Maximum initial results before reranking (default: 30) */
	initialLimit?: number;
	/** Final results limit (default: 10) */
	finalLimit?: number;
	/** Minimum rerank score to include (default: 3) */
	minRerankScore?: number;
	/** Context format style */
	formatStyle?: "markdown" | "xml" | "plain";
	/** Maximum tokens for context (default: 8000) */
	maxContextTokens?: number;
}

export interface SearchOptions {
	/** Number of results (default: 10) */
	limit?: number;
	/** Filter by unit types */
	unitTypes?: UnitType[];
	/** Filter by file path pattern */
	pathPattern?: string;
	/** Force a specific intent (skip routing) */
	forceIntent?: QueryIntent;
	/** Include summaries in context (default: true) */
	includeSummaries?: boolean;
	/** Skip reranking for this query */
	skipReranking?: boolean;
}

export interface EnhancedSearchResult {
	/** Routed query classification */
	routing: RouteResult;
	/** Primary search results */
	results: Array<CodeUnit & { score: number; rerankScore?: number }>;
	/** Formatted context for LLM consumption */
	formattedContext: FormattedContext;
	/** Search metadata */
	metadata: {
		durationMs: number;
		initialResultCount: number;
		finalResultCount: number;
		usedReranking: boolean;
		queryIntent: QueryIntent;
	};
}

// ============================================================================
// Enhanced Retriever Class
// ============================================================================

export class EnhancedRetriever {
	private store: IVectorStore;
	private embeddings: IEmbeddingsClient;
	private llmClient: ILLMClient | null;
	private queryRouter: QueryRouter;
	private reranker: LLMReranker | null;
	private formatter: ContextFormatter;
	private options: Required<EnhancedRetrieverOptions>;

	constructor(
		store: IVectorStore,
		embeddings: IEmbeddingsClient,
		llmClient: ILLMClient | null,
		options: EnhancedRetrieverOptions = {},
	) {
		this.store = store;
		this.embeddings = embeddings;
		this.llmClient = llmClient;

		this.options = {
			useQueryRouting: options.useQueryRouting ?? true,
			useReranking: options.useReranking ?? llmClient !== null,
			initialLimit: options.initialLimit ?? 30,
			finalLimit: options.finalLimit ?? 10,
			minRerankScore: options.minRerankScore ?? 3,
			formatStyle: options.formatStyle ?? "markdown",
			maxContextTokens: options.maxContextTokens ?? 8000,
		};

		// Initialize components
		this.queryRouter = createQueryRouter(llmClient, {
			useLLM: this.options.useQueryRouting,
		});
		this.reranker = llmClient
			? createLLMReranker(llmClient, {
					maxCandidates: this.options.initialLimit,
					minScore: this.options.minRerankScore,
				})
			: null;
		this.formatter = createContextFormatter({
			maxTokens: this.options.maxContextTokens,
			style: this.options.formatStyle,
		});
	}

	/**
	 * Full pipeline search with routing, reranking, and formatting
	 */
	async search(
		query: string,
		options: SearchOptions = {},
	): Promise<EnhancedSearchResult> {
		const startTime = Date.now();
		const {
			limit = this.options.finalLimit,
			unitTypes,
			pathPattern,
			forceIntent,
			includeSummaries = true,
			skipReranking = false,
		} = options;

		// Step 1: Route query
		const routing = forceIntent
			? {
					classification: {
						intent: forceIntent,
						confidence: 1.0,
						extractedEntities: [],
						reasoning: "Forced intent",
					},
					strategy: this.queryRouter.buildStrategyForIntent(forceIntent),
				}
			: await this.queryRouter.route(query);

		// Step 2: Execute search based on strategy
		const initialResults = await this.executeSearch(query, routing, {
			limit: this.options.initialLimit,
			unitTypes,
			pathPattern,
		});

		// Step 3: Rerank if enabled
		let finalResults: Array<CodeUnit & { score: number; rerankScore?: number }>;
		let usedReranking = false;

		if (
			this.options.useReranking &&
			this.reranker &&
			!skipReranking &&
			initialResults.length > 0
		) {
			try {
				const reranked = await this.reranker.rerankCodeUnits(
					query,
					initialResults,
				);
				finalResults = reranked.slice(0, limit);
				usedReranking = true;
			} catch (error) {
				console.warn("Reranking failed, using initial results:", error);
				finalResults = initialResults.slice(0, limit);
			}
		} else {
			finalResults = initialResults.slice(0, limit);
		}

		// Step 4: Get summaries for context (if requested)
		const summaries: Array<{ name: string; summary: string; path: string }> =
			[];
		if (includeSummaries && finalResults.length > 0) {
			const uniqueFiles = [...new Set(finalResults.map((r) => r.filePath))];
			for (const filePath of uniqueFiles.slice(0, 5)) {
				const fileSummary = await this.getFileSummary(filePath);
				if (fileSummary) {
					summaries.push(fileSummary);
				}
			}
		}

		// Step 5: Format context
		const formatInput: FormatInput = {
			primary: finalResults.slice(0, Math.ceil(limit * 0.6)),
			supporting: finalResults.slice(Math.ceil(limit * 0.6)),
			summaries,
			queryIntent: routing.classification.intent,
		};

		const formattedContext = this.formatter.format(formatInput);

		return {
			routing,
			results: finalResults,
			formattedContext,
			metadata: {
				durationMs: Date.now() - startTime,
				initialResultCount: initialResults.length,
				finalResultCount: finalResults.length,
				usedReranking,
				queryIntent: routing.classification.intent,
			},
		};
	}

	/**
	 * Search and return formatted context string for direct LLM use
	 */
	async searchForLLM(
		query: string,
		options: SearchOptions = {},
	): Promise<string> {
		const result = await this.search(query, options);
		return this.formatter.formatForLLM({
			primary: result.results.slice(0, Math.ceil(result.results.length * 0.6)),
			supporting: result.results.slice(Math.ceil(result.results.length * 0.6)),
			summaries: [], // Already included in formattedContext
			queryIntent: result.routing.classification.intent,
		});
	}

	/**
	 * Execute search based on routing strategy
	 */
	private async executeSearch(
		query: string,
		routing: RouteResult,
		options: { limit: number; unitTypes?: UnitType[]; pathPattern?: string },
	): Promise<Array<CodeUnit & { score: number }>> {
		const { strategy } = routing;
		const { limit, unitTypes, pathPattern } = options;

		// Generate query embedding
		const queryVector = await this.embeddings.embedOne(query);

		// Execute based on primary strategy
		switch (strategy.primary) {
			case "symbol":
				// Symbol lookup: prioritize exact/fuzzy name matches
				return this.store.searchCodeUnits(query, queryVector, {
					limit,
					unitTypes: unitTypes || strategy.unitTypes,
					filePath: pathPattern || strategy.filters?.pathPattern,
				});

			case "path":
				// Path-based: filter by path pattern
				return this.store.searchCodeUnits(query, queryVector, {
					limit,
					unitTypes,
					filePath: pathPattern || strategy.filters?.pathPattern,
				});
			default:
				// Hybrid search (default)
				return this.store.searchCodeUnits(query, queryVector, {
					limit,
					unitTypes: unitTypes || strategy.unitTypes,
					filePath: pathPattern,
				});
		}
	}

	/**
	 * Get file summary from store
	 * Fixed: Now properly uses LLM-generated summary from metadata, with better fallback
	 */
	private async getFileSummary(
		filePath: string,
	): Promise<{ name: string; summary: string; path: string } | null> {
		try {
			const units = await this.store.getCodeUnitsByFile(filePath, ["file"]);
			if (units.length > 0) {
				const fileUnit = units[0];
				// Prefer LLM-generated summary from metadata if available
				const summary =
					((fileUnit.metadata as Record<string, unknown>)?.summary as
						| string
						| undefined) ||
					fileUnit.metadata?.docstring ||
					this.generateBriefFileSummary(fileUnit, filePath);

				return {
					name: fileUnit.name || filePath.split("/").pop() || "unknown",
					summary,
					path: filePath,
				};
			}
		} catch {
			// Ignore errors
		}
		return null;
	}

	/**
	 * Generate a brief file summary from available metadata when no LLM summary exists
	 */
	private generateBriefFileSummary(
		fileUnit: CodeUnit,
		filePath: string,
	): string {
		const fileName = filePath.split("/").pop() || "unknown";
		const lines = fileUnit.content.split("\n").length;
		const language = fileUnit.language || "unknown";

		// Extract export names from metadata if available
		const exports = fileUnit.metadata?.importsUsed?.length
			? `Exports: ${fileUnit.metadata.importsUsed.slice(0, 5).join(", ")}${fileUnit.metadata.importsUsed.length > 5 ? "..." : ""}`
			: "";

		return `${fileName} (${language}, ${lines} lines)${exports ? `. ${exports}` : ""}`;
	}

	/**
	 * Direct code unit search (bypasses routing)
	 */
	async searchCodeUnits(
		query: string,
		options: {
			limit?: number;
			unitTypes?: UnitType[];
			pathPattern?: string;
		} = {},
	): Promise<Array<CodeUnit & { score: number }>> {
		const queryVector = await this.embeddings.embedOne(query);
		return this.store.searchCodeUnits(query, queryVector, {
			limit: options.limit || 10,
			unitTypes: options.unitTypes,
			filePath: options.pathPattern,
		});
	}

	/**
	 * Get children of a code unit
	 */
	async getUnitChildren(unitId: string): Promise<CodeUnit[]> {
		return this.store.getChildUnits(unitId);
	}

	/**
	 * Get a single code unit by ID
	 */
	async getUnit(unitId: string): Promise<CodeUnit | null> {
		return this.store.getCodeUnit(unitId);
	}
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create an enhanced retriever
 */
export function createEnhancedRetriever(
	store: IVectorStore,
	embeddings: IEmbeddingsClient,
	llmClient: ILLMClient | null,
	options?: EnhancedRetrieverOptions,
): EnhancedRetriever {
	return new EnhancedRetriever(store, embeddings, llmClient, options);
}
