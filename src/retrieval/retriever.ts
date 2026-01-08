/**
 * Enriched Retriever
 *
 * Multi-type retrieval orchestrator for enriched RAG.
 * Provides use-case optimized search with configurable weights.
 * Now includes structural repo map context for better LLM understanding.
 */

import type {
	DocumentType,
	EnrichedSearchOptions,
	EnrichedSearchResult,
	IEmbeddingsClient,
	RetrieverSearchResponse,
	SearchUseCase,
} from "../types.js";
import type { VectorStore } from "../core/store.js";
import type { FileTracker } from "../core/tracker.js";
import {
	createRepoMapGenerator,
	type RepoMapGenerator,
} from "../core/repo-map.js";

// ============================================================================
// Default Weights
// ============================================================================

/**
 * Default weights per document type for each use case.
 * These can be overridden via project config or at search time.
 */
export const DEFAULT_TYPE_WEIGHTS: Record<
	SearchUseCase,
	Partial<Record<DocumentType, number>>
> = {
	// FIM completion: prioritize code and examples
	fim: {
		code_chunk: 0.5,
		usage_example: 0.25,
		idiom: 0.15,
		symbol_summary: 0.1,
	},
	// Human search: balanced across summaries and code
	search: {
		file_summary: 0.25,
		symbol_summary: 0.25,
		code_chunk: 0.2,
		idiom: 0.15,
		usage_example: 0.1,
		anti_pattern: 0.05,
	},
	// Agent navigation: prioritize understanding structure
	navigation: {
		symbol_summary: 0.35,
		file_summary: 0.3,
		code_chunk: 0.2,
		idiom: 0.1,
		project_doc: 0.05,
	},
};

// ============================================================================
// Retriever Options
// ============================================================================

export interface RetrieverOptions {
	/** Maximum results to return */
	limit?: number;
	/** Use case preset (affects type weights) */
	useCase?: SearchUseCase;
	/** Custom type weights (overrides use case) */
	typeWeights?: Partial<Record<DocumentType, number>>;
	/** Filter by document types */
	documentTypes?: DocumentType[];
	/** Filter by file path pattern */
	pathPattern?: string;
	/** Filter by language */
	language?: string;
	/** Include code chunks in results (default: true) */
	includeCodeChunks?: boolean;
	/** Include repo map context in results (default: true for searchWithContext) */
	includeRepoMap?: boolean;
	/** Maximum tokens for repo map context (default: 500) */
	repoMapTokens?: number;
}

// ============================================================================
// Enriched Retriever Class
// ============================================================================

export class EnrichedRetriever {
	private store: VectorStore;
	private embeddings: IEmbeddingsClient;
	private defaultUseCase: SearchUseCase;
	private fileTracker: FileTracker | null = null;
	private repoMapGenerator: RepoMapGenerator | null = null;

	constructor(
		store: VectorStore,
		embeddings: IEmbeddingsClient,
		defaultUseCase: SearchUseCase = "search",
		fileTracker?: FileTracker,
	) {
		this.store = store;
		this.embeddings = embeddings;
		this.defaultUseCase = defaultUseCase;
		if (fileTracker) {
			this.setFileTracker(fileTracker);
		}
	}

	/**
	 * Set the file tracker for repo map generation
	 * This enables structural context in search results
	 */
	setFileTracker(tracker: FileTracker): void {
		this.fileTracker = tracker;
		this.repoMapGenerator = createRepoMapGenerator(tracker);
	}

	/**
	 * Search for relevant documents
	 */
	async search(
		query: string,
		options: RetrieverOptions = {},
	): Promise<EnrichedSearchResult[]> {
		const {
			limit = 10,
			useCase = this.defaultUseCase,
			typeWeights,
			documentTypes,
			pathPattern,
			language,
			includeCodeChunks = true,
		} = options;

		// Generate query embedding
		const queryVector = await this.embeddings.embedOne(query);

		// Build search options
		const searchOptions: EnrichedSearchOptions = {
			limit,
			useCase,
			documentTypes,
			pathPattern,
			language,
			includeCodeChunks,
		};

		// Apply custom weights if provided
		if (typeWeights) {
			searchOptions.typeWeights = typeWeights;
		}

		// Execute search
		return this.store.searchDocuments(query, queryVector, searchOptions);
	}

	/**
	 * Search with structural repo map context
	 *
	 * Returns search results plus a token-budgeted repo map relevant to the query.
	 * This gives LLMs both specific code snippets AND a structural overview
	 * of the codebase, improving code understanding and generation quality.
	 */
	async searchWithContext(
		query: string,
		options: RetrieverOptions = {},
	): Promise<RetrieverSearchResponse> {
		const startTime = Date.now();
		const { includeRepoMap = true, repoMapTokens = 500 } = options;

		// Execute base search
		const results = await this.search(query, options);

		// Build response
		const response: RetrieverSearchResponse = {
			results,
			metadata: {
				durationMs: Date.now() - startTime,
				includesRepoMap: false,
			},
		};

		// Add repo map context if enabled and available
		if (includeRepoMap && this.repoMapGenerator) {
			try {
				// Generate query-specific repo map (symbols relevant to query)
				const repoMapContext = this.repoMapGenerator.generateForQuery(query, {
					maxTokens: repoMapTokens,
				});

				if (repoMapContext && repoMapContext.length > 0) {
					response.repoMapContext = repoMapContext;
					response.metadata!.includesRepoMap = true;
				}
			} catch (error) {
				// Log but don't fail - repo map is optional context
				console.warn("Failed to generate repo map context:", error);
			}
		}

		response.metadata!.durationMs = Date.now() - startTime;
		return response;
	}

	/**
	 * Search optimized for FIM completion
	 */
	async searchForFIM(
		query: string,
		options: Omit<RetrieverOptions, "useCase"> = {},
	): Promise<EnrichedSearchResult[]> {
		return this.search(query, { ...options, useCase: "fim" });
	}

	/**
	 * Search optimized for human queries
	 */
	async searchForHuman(
		query: string,
		options: Omit<RetrieverOptions, "useCase"> = {},
	): Promise<EnrichedSearchResult[]> {
		return this.search(query, { ...options, useCase: "search" });
	}

	/**
	 * Search optimized for agent navigation
	 */
	async searchForNavigation(
		query: string,
		options: Omit<RetrieverOptions, "useCase"> = {},
	): Promise<EnrichedSearchResult[]> {
		return this.search(query, { ...options, useCase: "navigation" });
	}

	/**
	 * Get type weights for a use case
	 */
	getTypeWeights(
		useCase: SearchUseCase,
	): Partial<Record<DocumentType, number>> {
		return DEFAULT_TYPE_WEIGHTS[useCase] || DEFAULT_TYPE_WEIGHTS.search;
	}

	/**
	 * Get documents by file path
	 */
	async getDocumentsByFile(
		filePath: string,
		documentTypes?: DocumentType[],
	): Promise<EnrichedSearchResult[]> {
		const docs = await this.store.getDocumentsByFile(filePath, documentTypes);

		// Convert to EnrichedSearchResult format
		return docs.map((doc) => ({
			document: doc,
			score: 1.0, // Direct lookup
			vectorScore: 1.0,
			keywordScore: 1.0,
			documentType: doc.documentType,
		}));
	}

	/**
	 * Get document type statistics
	 */
	async getDocumentStats(): Promise<Record<DocumentType, number>> {
		return this.store.getDocumentTypeStats();
	}
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create an enriched retriever
 */
export function createEnrichedRetriever(
	store: VectorStore,
	embeddings: IEmbeddingsClient,
	defaultUseCase?: SearchUseCase,
	fileTracker?: FileTracker,
): EnrichedRetriever {
	return new EnrichedRetriever(store, embeddings, defaultUseCase, fileTracker);
}
