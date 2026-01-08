/**
 * Query Generator for Retrieval Evaluation
 *
 * Generates realistic search queries for testing how well summaries
 * can be retrieved using semantic search.
 */

import { randomUUID } from "crypto";
import type { ILLMClient, LLMMessage } from "../../types.js";
import type { BenchmarkCodeUnit, GeneratedQuery, QueryType } from "../types.js";

// ============================================================================
// Query Generation Prompt
// ============================================================================

const QUERY_GENERATION_SYSTEM_PROMPT = `You are an expert at simulating how developers search for code.
Your task is to generate realistic search queries that a developer might use to find a specific piece of code.
These queries should vary in specificity and terminology - NOT be perfect descriptions.`;

const QUERY_GENERATION_USER_PROMPT = `Generate realistic search queries that a developer might use to find this code.

## Code
\`\`\`{language}
{code}
\`\`\`

## Context
- File: {file_path}
- Name: {name}
- Type: {type}

Generate exactly 8 search queries of varying types:

1. **Vague query**: A partial or imprecise query (e.g., "something with users")
2. **Wrong terminology**: Uses related but not exact terms (e.g., "authenticate" instead of "login")
3. **Specific behavior**: Asks about a particular thing the code does
4. **Integration query**: Asks how to use this with something else
5. **Problem-based**: Describes a problem this code solves
6. **Doc conceptual**: Documentation-style conceptual question (e.g., "What is X?", "How does X work?", "Explain X")
7. **Doc API lookup**: Looking for API details (e.g., "X parameters", "X return type", "X function signature")
8. **Doc best practice**: Seeking recommended patterns (e.g., "best way to use X", "X recommended approach", "when to use X")

These should be realistic queries a developer would type, NOT perfect descriptions.

Respond with JSON only:
\`\`\`json
{
  "queries": [
    {"type": "vague", "query": "..."},
    {"type": "wrong_terminology", "query": "..."},
    {"type": "specific_behavior", "query": "..."},
    {"type": "integration", "query": "..."},
    {"type": "problem_based", "query": "..."},
    {"type": "doc_conceptual", "query": "..."},
    {"type": "doc_api_lookup", "query": "..."},
    {"type": "doc_best_practice", "query": "..."}
  ]
}
\`\`\``;

// ============================================================================
// Query Generator Class
// ============================================================================

export interface QueryGeneratorOptions {
	/** LLM client for generating queries */
	llmClient: ILLMClient;
	/** Number of queries per code unit (default: 5) */
	queriesPerUnit?: number;
	/** Query types to include */
	queryTypes?: QueryType[];
}

interface ParsedQueryResponse {
	queries: Array<{
		type: QueryType;
		query: string;
	}>;
}

export class QueryGenerator {
	private llmClient: ILLMClient;
	private queriesPerUnit: number;
	private queryTypes: QueryType[];

	constructor(options: QueryGeneratorOptions) {
		this.llmClient = options.llmClient;
		this.queriesPerUnit = options.queriesPerUnit ?? 8;
		this.queryTypes = options.queryTypes ?? [
			"vague",
			"wrong_terminology",
			"specific_behavior",
			"integration",
			"problem_based",
			"doc_conceptual",
			"doc_api_lookup",
			"doc_best_practice",
		];
	}

	/**
	 * Generate queries for a single code unit
	 */
	async generateForCodeUnit(
		codeUnit: BenchmarkCodeUnit,
	): Promise<GeneratedQuery[]> {
		const prompt = this.buildPrompt(codeUnit);

		const messages: LLMMessage[] = [
			{ role: "system", content: QUERY_GENERATION_SYSTEM_PROMPT },
			{ role: "user", content: prompt },
		];

		try {
			const response = await this.llmClient.completeJSON<ParsedQueryResponse>(
				messages,
				{
					temperature: 0.7, // Some creativity in query generation
					maxTokens: 1000,
				},
			);

			// Convert to GeneratedQuery objects
			return response.queries
				.filter((q) => this.queryTypes.includes(q.type))
				.map((q) => ({
					id: randomUUID(),
					codeUnitId: codeUnit.id,
					type: q.type,
					query: q.query,
					shouldFind: true,
				}));
		} catch (error) {
			// Return empty array on failure - query generation is non-critical
			console.warn(
				`Failed to generate queries for ${codeUnit.name}: ${error instanceof Error ? error.message : String(error)}`,
			);
			return [];
		}
	}

	/**
	 * Generate queries for multiple code units
	 */
	async generateForCodeUnits(
		codeUnits: BenchmarkCodeUnit[],
		onProgress?: (completed: number, total: number) => void,
	): Promise<GeneratedQuery[]> {
		const allQueries: GeneratedQuery[] = [];

		for (let i = 0; i < codeUnits.length; i++) {
			const unit = codeUnits[i];
			const queries = await this.generateForCodeUnit(unit);
			allQueries.push(...queries);

			if (onProgress) {
				onProgress(i + 1, codeUnits.length);
			}
		}

		return allQueries;
	}

	/**
	 * Generate simple queries without LLM (fallback)
	 */
	generateSimpleQueries(codeUnit: BenchmarkCodeUnit): GeneratedQuery[] {
		const queries: GeneratedQuery[] = [];
		const name = codeUnit.name.toLowerCase();
		const type = codeUnit.type;

		// Vague query - just the name
		queries.push({
			id: randomUUID(),
			codeUnitId: codeUnit.id,
			type: "vague",
			query: name.replace(/([A-Z])/g, " $1").trim(),
			shouldFind: true,
		});

		// Specific behavior - "how does X work"
		queries.push({
			id: randomUUID(),
			codeUnitId: codeUnit.id,
			type: "specific_behavior",
			query: `how does ${name} work`,
			shouldFind: true,
		});

		// Problem-based - "where is X implemented"
		queries.push({
			id: randomUUID(),
			codeUnitId: codeUnit.id,
			type: "problem_based",
			query: `${type} that handles ${name.split(/(?=[A-Z])/).slice(-1)[0] || name}`,
			shouldFind: true,
		});

		// Doc conceptual - "What is X?"
		queries.push({
			id: randomUUID(),
			codeUnitId: codeUnit.id,
			type: "doc_conceptual",
			query: `what is ${name}`,
			shouldFind: true,
		});

		// Doc API lookup - "X parameters" or "X signature"
		queries.push({
			id: randomUUID(),
			codeUnitId: codeUnit.id,
			type: "doc_api_lookup",
			query: `${name} ${type === "function" || type === "method" ? "parameters" : "API"}`,
			shouldFind: true,
		});

		// Doc best practice - "best way to use X"
		queries.push({
			id: randomUUID(),
			codeUnitId: codeUnit.id,
			type: "doc_best_practice",
			query: `best practice ${name}`,
			shouldFind: true,
		});

		return queries;
	}

	private buildPrompt(codeUnit: BenchmarkCodeUnit): string {
		// Truncate code if too long
		const maxCodeLength = 2000;
		let code = codeUnit.content;
		if (code.length > maxCodeLength) {
			code = code.slice(0, maxCodeLength) + "\n// ... (truncated)";
		}

		return QUERY_GENERATION_USER_PROMPT.replace("{language}", codeUnit.language)
			.replace("{code}", code)
			.replace("{file_path}", codeUnit.path)
			.replace("{name}", codeUnit.name)
			.replace("{type}", codeUnit.type);
	}
}

// ============================================================================
// Factory Function
// ============================================================================

export function createQueryGenerator(
	options: QueryGeneratorOptions,
): QueryGenerator {
	return new QueryGenerator(options);
}
