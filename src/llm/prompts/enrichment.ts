/**
 * Enrichment Prompts
 *
 * Prompt templates for generating enriched documents from code.
 * Each document type has a specific prompt designed to extract the right information.
 */

import type { DocumentType, CodeChunk } from "../../types.js";

// ============================================================================
// System Prompts
// ============================================================================

export const SYSTEM_PROMPTS: Record<DocumentType, string> = {
	code_chunk: "", // Not used - code chunks are extracted directly

	file_summary: `You are a code documentation expert. Analyze the provided source code file and generate a concise summary.

Your output must be valid JSON with this exact structure:
{
  "summary": "One paragraph describing the file's main purpose",
  "responsibilities": ["Main responsibility 1", "Main responsibility 2", "Main responsibility 3"],
  "exports": ["exportedFunction1", "exportedFunction2", "ExportedClass"],
  "dependencies": ["imported/module", "another/dependency"],
  "patterns": ["Pattern used 1", "Pattern used 2"]
}

Guidelines:
- summary: 2-3 sentences describing what this file does and why it exists
- responsibilities: 2-4 bullet points of the file's main jobs
- exports: List exported symbols (functions, classes, types, constants)
- dependencies: List imported modules (external and internal)
- patterns: Notable patterns (e.g., "Factory pattern", "React hooks", "Error boundary")

Be concise and accurate. Focus on what a developer needs to know to use or modify this file.`,

	symbol_summary: `You are a code documentation expert. Analyze the provided code symbol (function, class, or method) and generate a concise summary.

Your output must be valid JSON with this exact structure:
{
  "summary": "One sentence describing what this symbol does",
  "parameters": [
    {"name": "param1", "description": "What this parameter is for"}
  ],
  "returnDescription": "What the function returns and when",
  "sideEffects": ["Side effect 1", "Side effect 2"],
  "usageContext": "When and where to use this symbol"
}

Guidelines:
- summary: One clear sentence explaining the symbol's purpose
- parameters: List each parameter with a brief description (omit if none)
- returnDescription: What it returns, including edge cases (omit if void/none)
- sideEffects: Any state mutations, API calls, file I/O, etc. (omit if pure)
- usageContext: When to use this - the "why" not just the "what"

Be precise and practical. Focus on information needed to correctly use this symbol.`,

	idiom: `You are a code pattern analyst. Examine the provided code and extract recurring idioms, conventions, and patterns used in this codebase.

Your output must be valid JSON with this exact structure:
{
  "idioms": [
    {
      "category": "error_handling|async_patterns|naming|state_management|testing|other",
      "pattern": "Short name/description of the pattern",
      "example": "Code snippet showing the pattern",
      "rationale": "Why this pattern is used here",
      "appliesTo": ["functions", "classes", "modules"]
    }
  ]
}

Guidelines:
- Look for repeating patterns across the code
- Categories: error_handling, async_patterns, naming, state_management, testing, other
- example: Include a minimal code snippet (2-10 lines) showing the pattern
- rationale: Explain WHY this pattern is preferred in this codebase
- appliesTo: Where this pattern should be applied

Focus on patterns unique or important to this codebase, not generic language features.`,

	usage_example: `You are a code example generator. Create practical usage examples for the provided code symbol.

Your output must be valid JSON with this exact structure:
{
  "examples": [
    {
      "exampleType": "basic|with_options|error_case|in_context|test",
      "code": "Example code showing usage",
      "description": "What this example demonstrates"
    }
  ]
}

Guidelines:
- Generate 2-4 examples covering different scenarios
- exampleType:
  - basic: Simplest usage
  - with_options: Using optional parameters/config
  - error_case: Handling errors or edge cases
  - in_context: Real-world usage in a larger context
  - test: How to test this symbol
- code: Runnable code snippets (5-15 lines)
- description: One sentence explaining the example

Focus on practical, realistic examples that help developers use this code correctly.`,

	anti_pattern: `You are a code quality analyst. Identify potential anti-patterns, code smells, or common mistakes in the provided code.

Your output must be valid JSON with this exact structure:
{
  "antiPatterns": [
    {
      "pattern": "Name of the anti-pattern",
      "badExample": "Code showing the problematic pattern",
      "reason": "Why this is problematic",
      "alternative": "Better approach or fix",
      "severity": "low|medium|high"
    }
  ]
}

Guidelines:
- Only report genuine issues, not style preferences
- severity:
  - low: Minor code smell, readability issue
  - medium: Could cause bugs or maintenance issues
  - high: Security risk, performance problem, or likely bug
- badExample: The actual problematic code (minimal snippet)
- alternative: Concrete suggestion for improvement

Be constructive and specific. If the code is well-written, return {"antiPatterns": []}.`,

	project_doc: `You are a technical documentation writer. Generate project-level documentation based on the provided codebase information.

Your output must be valid JSON with this exact structure:
{
  "title": "Document title",
  "category": "architecture|getting_started|api|contributing|standards",
  "sections": [
    {
      "heading": "Section heading",
      "content": "Section content in markdown format"
    }
  ]
}

Guidelines:
- category determines the document focus:
  - architecture: System design, component relationships, data flow
  - getting_started: Setup instructions, prerequisites, first steps
  - api: API reference, endpoints, function signatures
  - contributing: Development workflow, coding standards
  - standards: Coding conventions, patterns to follow
- sections: 3-6 logical sections with markdown content
- Be concise but complete. Focus on what's unique to this project.

Write for developers who are new to the codebase.`,

	// External documentation types - not generated via LLM enrichment
	// These are fetched from external sources (Context7, llms.txt, DevDocs)
	framework_doc: "", // Not used - fetched from external sources
	best_practice: "", // Not used - fetched from external sources
	api_reference: "", // Not used - fetched from external sources
};

// ============================================================================
// User Prompt Builders
// ============================================================================

/**
 * Build prompt for file summary extraction
 */
export function buildFileSummaryPrompt(
	filePath: string,
	fileContent: string,
	language: string,
): string {
	// Sanitize code content to prevent prompt injection
	const safeContent = sanitizeCodeContent(truncateContent(fileContent, 8000));

	return `Analyze this ${language} file and generate a summary.

File: ${filePath}

\`\`\`${language}
${safeContent}
\`\`\`

Generate the JSON summary.`;
}

/**
 * File info for batch processing
 */
export interface BatchFileInfo {
	filePath: string;
	fileContent: string;
	language: string;
}

/**
 * Build prompt for BATCHED file summary extraction (multiple files in one call)
 */
export function buildBatchedFileSummaryPrompt(files: BatchFileInfo[]): string {
	let prompt = `Analyze these ${files.length} source files and generate summaries for each.

`;

	for (let i = 0; i < files.length; i++) {
		const file = files[i];
		// Truncate more aggressively when batching to fit context window
		const maxChars = Math.floor(24000 / files.length);
		const safeContent = sanitizeCodeContent(
			truncateContent(file.fileContent, maxChars),
		);

		prompt += `=== FILE ${i + 1}: ${file.filePath} ===
\`\`\`${file.language}
${safeContent}
\`\`\`

`;
	}

	prompt += `Generate a JSON array with summaries for each file, in the same order as above.`;
	return prompt;
}

/**
 * System prompt for batched file summaries
 */
export const BATCHED_FILE_SUMMARY_SYSTEM_PROMPT = `You are a code documentation expert. Analyze the provided source files and generate concise summaries for each.

Your output must be valid JSON - an array with one object per file:
[
  {
    "filePath": "path/to/file.ts",
    "summary": "One paragraph describing the file's main purpose",
    "responsibilities": ["Main responsibility 1", "Main responsibility 2"],
    "exports": ["exportedFunction1", "ExportedClass"],
    "dependencies": ["imported/module"],
    "patterns": ["Pattern used 1"]
  }
]

Guidelines:
- Return one object per file, in the SAME ORDER as the input files
- summary: 2-3 sentences describing what each file does
- responsibilities: 2-4 bullet points of main jobs
- exports: List exported symbols
- dependencies: List imported modules
- patterns: Notable patterns used

Be concise. Focus on what developers need to know to use or modify each file.`;

/**
 * Build prompt for symbol summary extraction
 */
export function buildSymbolSummaryPrompt(
	chunk: CodeChunk,
	fileContext?: string,
): string {
	const symbolType = chunk.chunkType === "method" ? "method" : chunk.chunkType;
	const contextInfo = chunk.parentName ? ` (part of ${chunk.parentName})` : "";

	// Sanitize code content to prevent prompt injection
	const safeContent = sanitizeCodeContent(chunk.content);

	let prompt = `Analyze this ${chunk.language} ${symbolType}${contextInfo} and generate a summary.

Symbol: ${chunk.name || "anonymous"}
File: ${chunk.filePath}

\`\`\`${chunk.language}
${safeContent}
\`\`\``;

	// Add surrounding context if available
	if (fileContext) {
		const safeContext = sanitizeCodeContent(truncateContent(fileContext, 2000));
		prompt += `

Surrounding context:
\`\`\`${chunk.language}
${safeContext}
\`\`\``;
	}

	prompt += "\n\nGenerate the JSON summary.";
	return prompt;
}

/**
 * Symbol info for batch processing
 */
export interface BatchSymbolInfo {
	name: string;
	symbolType: string;
	content: string;
	language: string;
	parentName?: string;
}

/**
 * Build prompt for BATCHED symbol summary extraction (multiple symbols in one call)
 */
export function buildBatchedSymbolSummaryPrompt(
	symbols: BatchSymbolInfo[],
): string {
	let prompt = `Analyze these ${symbols.length} code symbols and generate summaries for each.

`;

	for (let i = 0; i < symbols.length; i++) {
		const sym = symbols[i];
		// Truncate more aggressively when batching
		const maxChars = Math.floor(16000 / symbols.length);
		const safeContent = sanitizeCodeContent(
			truncateContent(sym.content, maxChars),
		);
		const parentInfo = sym.parentName ? ` (part of ${sym.parentName})` : "";

		prompt += `=== SYMBOL ${i + 1}: ${sym.name}${parentInfo} [${sym.symbolType}] ===
\`\`\`${sym.language}
${safeContent}
\`\`\`

`;
	}

	prompt += `Generate a JSON array with summaries for each symbol, in the same order as above.`;
	return prompt;
}

/**
 * System prompt for batched symbol summaries
 */
export const BATCHED_SYMBOL_SUMMARY_SYSTEM_PROMPT = `You are a code documentation expert. Analyze the provided code symbols and generate concise summaries for each.

Your output must be valid JSON - an array with one object per symbol:
[
  {
    "name": "symbolName",
    "summary": "One sentence describing what this symbol does",
    "parameters": [{"name": "param1", "description": "What this parameter is for"}],
    "returnDescription": "What the function returns",
    "sideEffects": ["Side effect 1"],
    "usageContext": "When and where to use this symbol"
  }
]

Guidelines:
- Return one object per symbol, in the SAME ORDER as the input
- summary: One clear sentence explaining the purpose
- parameters: List each parameter with description (omit if none)
- returnDescription: What it returns (omit if void)
- sideEffects: State mutations, API calls, I/O (omit if pure)
- usageContext: When to use this - the "why"

Be precise and practical. Focus on information needed to correctly use each symbol.`;

/**
 * Build prompt for idiom extraction
 */
export function buildIdiomPrompt(
	chunks: CodeChunk[],
	language: string,
): string {
	// Select representative chunks (mix of types)
	const selectedChunks = selectRepresentativeChunks(chunks, 10);

	let prompt = `Analyze these ${language} code samples and identify recurring patterns and idioms.

`;

	for (const chunk of selectedChunks) {
		// Sanitize code content to prevent prompt injection
		const safeContent = sanitizeCodeContent(
			truncateContent(chunk.content, 500),
		);
		prompt += `--- ${chunk.filePath}:${chunk.startLine} (${chunk.chunkType}: ${chunk.name || "anonymous"}) ---
\`\`\`${chunk.language}
${safeContent}
\`\`\`

`;
	}

	prompt +=
		"Identify idioms and patterns used across these code samples. Generate the JSON response.";
	return prompt;
}

/**
 * Build prompt for usage example generation
 */
export function buildUsageExamplePrompt(
	chunk: CodeChunk,
	symbolSummary?: string,
): string {
	// Sanitize code content to prevent prompt injection
	const safeContent = sanitizeCodeContent(chunk.content);
	const safeSignature = chunk.signature
		? sanitizeCodeContent(chunk.signature)
		: "";

	let prompt = `Generate usage examples for this ${chunk.language} ${chunk.chunkType}.

Symbol: ${chunk.name || "anonymous"}
File: ${chunk.filePath}
${safeSignature ? `Signature: ${safeSignature}` : ""}

\`\`\`${chunk.language}
${safeContent}
\`\`\``;

	if (symbolSummary) {
		// symbolSummary comes from our own LLM output, but sanitize anyway for defense-in-depth
		const safeSummary = sanitizeCodeContent(symbolSummary);
		prompt += `

Symbol summary: ${safeSummary}`;
	}

	prompt += "\n\nGenerate practical usage examples as JSON.";
	return prompt;
}

/**
 * Build prompt for anti-pattern detection
 */
export function buildAntiPatternPrompt(
	chunks: CodeChunk[],
	language: string,
): string {
	let prompt = `Review this ${language} code for potential anti-patterns, code smells, or common mistakes.

`;

	for (const chunk of chunks.slice(0, 5)) {
		// Sanitize code content to prevent prompt injection
		const safeContent = sanitizeCodeContent(
			truncateContent(chunk.content, 800),
		);
		prompt += `--- ${chunk.filePath}:${chunk.startLine} (${chunk.chunkType}: ${chunk.name || "anonymous"}) ---
\`\`\`${chunk.language}
${safeContent}
\`\`\`

`;
	}

	prompt +=
		"Identify any anti-patterns or code quality issues. Generate the JSON response.";
	return prompt;
}

/**
 * Build prompt for project documentation
 */
export function buildProjectDocPrompt(
	category:
		| "architecture"
		| "getting_started"
		| "api"
		| "contributing"
		| "standards",
	fileSummaries: Array<{ filePath: string; summary: string }>,
	idioms: Array<{ pattern: string; rationale: string }>,
): string {
	let prompt = `Generate ${category} documentation for this project.

## File Summaries

`;

	for (const file of fileSummaries.slice(0, 20)) {
		// Sanitize summaries (from LLM output, but defense-in-depth)
		const safeSummary = sanitizeCodeContent(file.summary);
		prompt += `- **${file.filePath}**: ${safeSummary}\n`;
	}

	if (idioms.length > 0) {
		prompt += `
## Project Patterns

`;
		for (const idiom of idioms.slice(0, 10)) {
			// Sanitize idiom content
			const safePattern = sanitizeCodeContent(idiom.pattern);
			const safeRationale = sanitizeCodeContent(idiom.rationale);
			prompt += `- **${safePattern}**: ${safeRationale}\n`;
		}
	}

	prompt += `
Generate comprehensive ${category} documentation as JSON.`;
	return prompt;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Sanitize code content to prevent prompt injection attacks.
 * Strips or escapes common LLM control sequences that could manipulate model behavior.
 */
function sanitizeCodeContent(content: string): string {
	// Patterns that could be used for prompt injection
	// These are common chat template markers and control sequences
	const injectionPatterns = [
		// Llama/Mistral style
		/\[INST\]/gi,
		/\[\/INST\]/gi,
		/<<SYS>>/gi,
		/<\/SYS>>/gi,
		/\[SYS\]/gi,
		/\[\/SYS\]/gi,
		// ChatML style (OpenAI, etc.)
		/<\|im_start\|>/gi,
		/<\|im_end\|>/gi,
		/<\|system\|>/gi,
		/<\|user\|>/gi,
		/<\|assistant\|>/gi,
		// End of sequence tokens
		/<\/s>/gi,
		/<\|endoftext\|>/gi,
		/<\|eot_id\|>/gi,
		// Role markers that could confuse the model
		/^System:\s*/gim,
		/^SYSTEM:\s*/gim,
		/^Assistant:\s*/gim,
		/^ASSISTANT:\s*/gim,
		/^Human:\s*/gim,
		/^HUMAN:\s*/gim,
		/^User:\s*/gim,
		/^USER:\s*/gim,
	];

	let sanitized = content;
	for (const pattern of injectionPatterns) {
		// Replace with escaped version (add backslash to break the pattern)
		sanitized = sanitized.replace(pattern, (match) => {
			// Insert a zero-width space to break the pattern without changing appearance much
			if (match.startsWith("<")) {
				return "<\u200B" + match.slice(1);
			}
			if (match.startsWith("[")) {
				return "[\u200B" + match.slice(1);
			}
			// For role markers, prefix with a comment indicator
			return "# " + match;
		});
	}

	return sanitized;
}

/**
 * Truncate content to fit within token limits
 */
function truncateContent(content: string, maxChars: number): string {
	if (content.length <= maxChars) {
		return content;
	}

	// Try to truncate at a line boundary
	const truncated = content.slice(0, maxChars);
	const lastNewline = truncated.lastIndexOf("\n");

	if (lastNewline > maxChars * 0.8) {
		return truncated.slice(0, lastNewline) + "\n// ... truncated";
	}

	return truncated + "\n// ... truncated";
}

/**
 * Select representative chunks for pattern extraction
 */
function selectRepresentativeChunks(
	chunks: CodeChunk[],
	maxCount: number,
): CodeChunk[] {
	if (chunks.length <= maxCount) {
		return chunks;
	}

	// Group by chunk type
	const byType = new Map<string, CodeChunk[]>();
	for (const chunk of chunks) {
		const key = chunk.chunkType;
		if (!byType.has(key)) {
			byType.set(key, []);
		}
		byType.get(key)!.push(chunk);
	}

	// Take proportionally from each type
	const result: CodeChunk[] = [];
	const typesCount = byType.size;
	const perType = Math.max(1, Math.floor(maxCount / typesCount));

	for (const [, typeChunks] of byType) {
		// Sort by size (prefer medium-sized chunks)
		const sorted = typeChunks.sort((a, b) => {
			const aSize = a.content.length;
			const bSize = b.content.length;
			// Prefer chunks between 200-1000 chars
			const aScore = aSize >= 200 && aSize <= 1000 ? 1 : 0;
			const bScore = bSize >= 200 && bSize <= 1000 ? 1 : 0;
			return bScore - aScore;
		});

		result.push(...sorted.slice(0, perType));
	}

	return result.slice(0, maxCount);
}

/**
 * Get the appropriate system prompt for a document type
 */
export function getSystemPrompt(documentType: DocumentType): string {
	return SYSTEM_PROMPTS[documentType];
}
