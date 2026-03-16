/**
 * Query Router
 *
 * Classifies search queries to determine the optimal retrieval strategy:
 * - symbol_lookup: Direct symbol search (exact match or fuzzy)
 * - structural: Relationship queries (callers, callees, dependencies)
 * - semantic: Natural language queries (vector search)
 * - similarity: Find similar code patterns
 * - location: Path-based queries
 */

import type {
	ILLMClient,
	LLMMessage,
	QueryClassification,
	QueryIntent,
	UnitType,
	Visibility,
} from "../../types.js";

// ============================================================================
// Types
// ============================================================================

export interface QueryRouterOptions {
	/** Use LLM for classification (default: true) */
	useLLM?: boolean;
	/** Minimum confidence for LLM classification (default: 0.6) */
	minConfidence?: number;
}

export interface RouteResult {
	classification: QueryClassification;
	strategy: RetrievalStrategy;
}

export interface RetrievalStrategy {
	/** Primary search method */
	primary: "vector" | "keyword" | "symbol" | "path";
	/** Whether to use hybrid search */
	useHybrid: boolean;
	/** Unit types to prioritize */
	unitTypes?: UnitType[];
	/** Weight adjustments for search */
	weights?: {
		vector?: number;
		keyword?: number;
	};
	/** Post-retrieval filtering */
	filters?: {
		pathPattern?: string;
		visibility?: Visibility[];
		isExported?: boolean;
	};
}

// ============================================================================
// Constants
// ============================================================================

const CLASSIFICATION_PROMPT = `Classify this code search query into one of the following categories:

**Categories:**
1. **symbol_lookup** - Looking for a specific named entity (function, class, variable, type)
   - Examples: "UserService", "handleAuth function", "PaymentError type"

2. **structural** - Asking about code relationships or structure
   - Examples: "methods in UserService", "functions that call processPayment", "files importing auth module"

3. **semantic** - Natural language question about functionality or behavior
   - Examples: "how does authentication work", "where is rate limiting implemented", "code that handles retries"

4. **similarity** - Looking for code similar to a given example
   - Examples: "code like this error handling pattern", "similar to the retry logic in utils"

5. **location** - Looking for code in a specific location
   - Examples: "tests for payment module", "handlers in api folder", "config files"

**Query:** {query}

Respond with JSON only:
\`\`\`json
{
  "category": "<category_name>",
  "confidence": <0.0-1.0>,
  "extracted_entities": ["<any specific names or identifiers mentioned>"],
  "reasoning": "<one sentence explanation>"
}
\`\`\``;

/** Pattern matchers for rule-based classification */
const CLASSIFICATION_PATTERNS: Array<{
	intent: QueryIntent;
	patterns: RegExp[];
	confidence: number;
}> = [
	{
		// Symbol lookup: specific names, function/class keywords
		intent: "symbol_lookup",
		patterns: [
			/^[A-Z][a-zA-Z0-9]*$/, // PascalCase name
			/^[a-z][a-zA-Z0-9]*$/, // camelCase name
			/\b(function|class|type|interface|enum)\s+\w+/i,
			/\bdef\s+\w+/, // Python function
			/\bfunc\s+\w+/, // Go function
		],
		confidence: 0.85,
	},
	{
		// Structural: relationship keywords (must be complete words, not prefixes)
		intent: "structural",
		patterns: [
			/\b(calls?|invokes?|uses|imports?|extends?|implements?|inherits?|depends?)\b/i,
			/\b(callers?|callees?|dependencies|dependents)\b/i,
			/\b(methods|properties|fields)\s+(in|of|on)\b/i,
			/what\s+(calls|uses|imports)\b/i,
			/who\s+(calls|uses|imports)\b/i,
		],
		confidence: 0.8,
	},
	{
		// Location: path-based queries
		intent: "location",
		patterns: [
			/\b(in|under|inside)\s+(the\s+)?(\w+\/|\w+\s+folder|\w+\s+directory)/i,
			/\b(tests?|specs?)\s+for\b/i,
			/\b(files?|modules?)\s+(in|under)\b/i,
			/\.(ts|js|py|go|rs|java)$/, // File extension
		],
		confidence: 0.75,
	},
	{
		// Similarity: pattern matching keywords
		intent: "similarity",
		patterns: [
			/\b(similar|like|same\s+as|pattern)\b/i,
			/\bexample\s+of\b/i,
			/\bcode\s+(like|similar)\b/i,
		],
		confidence: 0.7,
	},
];

// ============================================================================
// Query Router Class
// ============================================================================

export class QueryRouter {
	private llmClient: ILLMClient | null;
	private options: Required<QueryRouterOptions>;

	constructor(llmClient: ILLMClient | null, options: QueryRouterOptions = {}) {
		this.llmClient = llmClient;
		this.options = {
			useLLM: options.useLLM ?? true,
			minConfidence: options.minConfidence ?? 0.6,
		};
	}

	/**
	 * Route a query to determine the best retrieval strategy
	 */
	async route(query: string): Promise<RouteResult> {
		// First try rule-based classification
		const ruleClassification = this.classifyWithRules(query);

		// If high confidence or no LLM available, use rules
		if (
			ruleClassification.confidence >= 0.85 ||
			!this.llmClient ||
			!this.options.useLLM
		) {
			return {
				classification: ruleClassification,
				strategy: this.buildStrategy(ruleClassification),
			};
		}

		// Use LLM for more nuanced classification
		try {
			const llmClassification = await this.classifyWithLLM(query);

			// Use LLM result if confident enough
			if (llmClassification.confidence >= this.options.minConfidence) {
				return {
					classification: llmClassification,
					strategy: this.buildStrategy(llmClassification),
				};
			}
		} catch (error) {
			// Fall back to rules on error
			console.warn("LLM classification failed, using rules:", error);
		}

		// Fall back to rule-based result
		return {
			classification: ruleClassification,
			strategy: this.buildStrategy(ruleClassification),
		};
	}

	/**
	 * Classify query using pattern matching rules
	 */
	private classifyWithRules(query: string): QueryClassification {
		const trimmedQuery = query.trim();

		// Check each pattern set
		for (const { intent, patterns, confidence } of CLASSIFICATION_PATTERNS) {
			for (const pattern of patterns) {
				if (pattern.test(trimmedQuery)) {
					return {
						intent,
						confidence,
						extractedEntities: this.extractEntities(trimmedQuery),
						reasoning: `Matched ${intent} pattern`,
					};
				}
			}
		}

		// Default to semantic (natural language)
		return {
			intent: "semantic",
			confidence: 0.5,
			extractedEntities: this.extractEntities(trimmedQuery),
			reasoning:
				"No specific pattern matched, treating as natural language query",
		};
	}

	/**
	 * Classify query using LLM
	 */
	private async classifyWithLLM(query: string): Promise<QueryClassification> {
		if (!this.llmClient) {
			throw new Error("LLM client not available");
		}

		const prompt = CLASSIFICATION_PROMPT.replace("{query}", query);
		const messages: LLMMessage[] = [{ role: "user", content: prompt }];

		const result = await this.llmClient.completeJSON<{
			category: string;
			confidence: number;
			extracted_entities: string[];
			reasoning: string;
		}>(messages);

		// Map category to intent
		const intentMap: Record<string, QueryIntent> = {
			symbol_lookup: "symbol_lookup",
			structural: "structural",
			semantic: "semantic",
			similarity: "similarity",
			location: "location",
		};

		return {
			intent: intentMap[result.category] || "semantic",
			confidence: result.confidence,
			extractedEntities: result.extracted_entities,
			reasoning: result.reasoning,
		};
	}

	/**
	 * Extract potential symbol names and entities from query
	 */
	private extractEntities(query: string): string[] {
		const entities: string[] = [];

		// Extract PascalCase names (likely classes/types)
		const pascalMatches = query.match(/\b[A-Z][a-zA-Z0-9]+\b/g);
		if (pascalMatches) entities.push(...pascalMatches);

		// Extract camelCase names (likely functions/methods)
		const camelMatches = query.match(/\b[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*\b/g);
		if (camelMatches) entities.push(...camelMatches);

		// Extract snake_case names
		const snakeMatches = query.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g);
		if (snakeMatches) entities.push(...snakeMatches);

		// Extract file paths
		const pathMatches = query.match(
			/[\w\/.-]+\.(ts|js|py|go|rs|java|cpp|c|h)\b/g,
		);
		if (pathMatches) entities.push(...pathMatches);

		return [...new Set(entities)]; // Deduplicate
	}

	/**
	 * Build strategy for a forced intent (public helper for enhanced retriever)
	 */
	buildStrategyForIntent(intent: QueryIntent): RetrievalStrategy {
		return this.buildStrategy({
			intent,
			confidence: 1.0,
			extractedEntities: [],
		});
	}

	/**
	 * Build retrieval strategy based on classification
	 */
	private buildStrategy(
		classification: QueryClassification,
	): RetrievalStrategy {
		switch (classification.intent) {
			case "symbol_lookup":
				return {
					primary: "symbol",
					useHybrid: false,
					unitTypes: ["function", "method", "class", "interface", "type"],
					weights: { keyword: 0.7, vector: 0.3 },
				};

			case "structural":
				return {
					primary: "keyword",
					useHybrid: true,
					unitTypes: ["class", "interface", "function"],
					weights: { keyword: 0.6, vector: 0.4 },
				};

			case "location":
				return {
					primary: "path",
					useHybrid: false,
					filters: {
						pathPattern: this.extractPathPattern(
							classification.extractedEntities,
						),
					},
				};

			case "similarity":
				return {
					primary: "vector",
					useHybrid: true,
					weights: { vector: 0.8, keyword: 0.2 },
				};
			default:
				return {
					primary: "vector",
					useHybrid: true,
					weights: { vector: 0.6, keyword: 0.4 },
				};
		}
	}

	/**
	 * Extract path pattern from entities
	 */
	private extractPathPattern(entities: string[]): string | undefined {
		// Look for path-like patterns
		for (const entity of entities) {
			if (entity.includes("/") || entity.includes(".")) {
				return entity;
			}
		}
		return undefined;
	}
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a query router
 */
export function createQueryRouter(
	llmClient: ILLMClient | null,
	options?: QueryRouterOptions,
): QueryRouter {
	return new QueryRouter(llmClient, options);
}
