/**
 * Retrieval Module Exports
 *
 * Public API for the retrieval system.
 */

// Original enriched retriever (backward compatibility)
export {
	EnrichedRetriever,
	createEnrichedRetriever,
	DEFAULT_TYPE_WEIGHTS,
} from "./retriever.js";
export type { RetrieverOptions } from "./retriever.js";

// Enhanced retriever (new hierarchical model)
export {
	EnhancedRetriever,
	createEnhancedRetriever,
} from "./enhanced-retriever.js";
export type {
	EnhancedRetrieverOptions,
	SearchOptions,
	EnhancedSearchResult,
} from "./enhanced-retriever.js";

// Query routing
export { QueryRouter, createQueryRouter } from "./routing/query-router.js";
export type {
	QueryRouterOptions,
	RouteResult,
	RetrievalStrategy,
} from "./routing/query-router.js";

// Reranking
export { LLMReranker, createLLMReranker } from "./reranking/llm-reranker.js";
export type {
	RerankerOptions,
	RerankableResult,
} from "./reranking/llm-reranker.js";

// Context formatting
export {
	ContextFormatter,
	createContextFormatter,
} from "./formatting/context-formatter.js";
export type {
	FormatterOptions,
	FormatInput,
} from "./formatting/context-formatter.js";

// Prompts
export {
	QUERY_CLASSIFICATION_PROMPT,
	QUERY_EXPANSION_PROMPT,
	RERANKING_PROMPT,
	CONTEXT_FILTER_PROMPT,
	formatCandidatesForReranking,
	formatContextForFiltering,
} from "./prompts.js";
