/**
 * Retrieval Prompts
 *
 * Prompts used in the retrieval pipeline for:
 * - Query classification
 * - Query expansion
 * - LLM reranking
 * - Context relevance filtering
 */

// ============================================================================
// Query Classification
// ============================================================================

export const QUERY_CLASSIFICATION_PROMPT = `Classify this code search query into one of the following categories:

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

// ============================================================================
// Query Expansion
// ============================================================================

export const QUERY_EXPANSION_PROMPT = `Expand this code search query with related terms, synonyms, and alternate phrasings that might match relevant code.

**Original Query:** {query}
**Detected Language Context:** {language_hint}

Generate expansions that:
1. Include synonyms (auth → authentication, verify, validate)
2. Include related concepts (login → session, token, credentials)
3. Include common implementation patterns (cache → memoize, store, LRU)
4. Include language-specific terms if applicable

Respond with JSON only:
\`\`\`json
{
  "original": "<original query>",
  "synonyms": ["<direct synonyms>"],
  "related_concepts": ["<semantically related terms>"],
  "implementation_patterns": ["<common implementation terms>"],
  "expanded_query": "<combined query for search>"
}
\`\`\``;

// ============================================================================
// LLM Reranking
// ============================================================================

export const RERANKING_PROMPT = `You are ranking code search results by relevance to a query.

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
// Context Relevance Filter
// ============================================================================

export const CONTEXT_FILTER_PROMPT = `Given a coding task, filter this list of code snippets to only those that would be helpful context.

**Task:** {task}

**Available Context:**
{context_list}

For each item, decide:
- **include**: Essential or very helpful for the task
- **maybe**: Might be useful for reference
- **exclude**: Not relevant to this specific task

Respond with JSON only:
\`\`\`json
{
  "include": [<indices of essential items>],
  "maybe": [<indices of potentially useful items>],
  "exclude": [<indices of irrelevant items>],
  "reasoning": "<brief explanation of filtering logic>"
}
\`\`\``;

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Format candidates for reranking prompt
 */
export function formatCandidatesForReranking(
	candidates: Array<{
		name: string;
		type: string;
		path: string;
		summary: string;
	}>,
): string {
	return candidates
		.map(
			(c, i) =>
				`[${i + 1}] ${c.name} (${c.type}) - ${c.path}\nSummary: ${c.summary}\n---`,
		)
		.join("\n");
}

/**
 * Format context items for filtering prompt
 */
export function formatContextForFiltering(
	items: Array<{ name: string; description: string }>,
): string {
	return items
		.map((item, i) => `[${i + 1}] ${item.name} - ${item.description}`)
		.join("\n");
}
