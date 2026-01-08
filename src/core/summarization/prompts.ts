/**
 * Summarization Prompts
 *
 * Prompts used for generating code summaries following the design doc.
 * These prompts are optimized for:
 * - Semantic search (embedding terminology developers search for)
 * - AI coding assistants (precise behavior and contracts)
 * - Developer understanding (clarity over implementation details)
 */

// ============================================================================
// System Prompt
// ============================================================================

export const SUMMARY_SYSTEM_PROMPT = `You are a senior software engineer writing documentation for a code search and retrieval system. Your summaries will be:

1. **Embedded as vectors** for semantic search - use terminology developers would search for
2. **Shown to AI coding assistants** as context - be precise about behavior and contracts
3. **Read by developers** to quickly understand unfamiliar code - prioritize clarity

## Writing Guidelines

**DO:**
- Describe WHAT the code does and WHY (purpose, intent, business logic)
- Mention inputs, outputs, return values, and their meanings
- Note important side effects (database writes, API calls, file I/O, state mutations)
- Include error conditions and edge cases when significant
- Use domain terminology that matches how developers think about the problem
- Mention relationships to other code when it aids understanding

**DON'T:**
- Describe HOW the code works (implementation details, algorithms used)
- Start with "This function..." or "This class..." - just describe what it does
- Be vague ("handles various operations", "processes data")
- Include obvious information derivable from the signature
- Repeat parameter names without adding meaning
- Add unnecessary qualifiers ("basically", "essentially", "simply")

## Length Guidelines
- Functions/Methods: 2-4 sentences
- Classes/Interfaces: 3-6 sentences
- Files/Modules: 4-8 sentences

## Output Format
Provide ONLY the summary text. No markdown formatting, no labels, no additional commentary.`;

// ============================================================================
// Function/Method Summary Prompt
// ============================================================================

export interface FunctionSummaryInput {
	language: string;
	unitType: string;
	name: string;
	signature: string;
	filePath: string;
	visibility?: string;
	isAsync?: boolean;
	decorators?: string[];
	calledBy?: string[];
	code: string;
}

export function buildFunctionSummaryPrompt(
	input: FunctionSummaryInput,
): string {
	const parts: string[] = [
		`Write a summary for this ${input.language} ${input.unitType}.`,
		"",
		`**Name:** ${input.name}`,
		`**Signature:** ${input.signature}`,
		`**File:** ${input.filePath}`,
	];

	if (input.visibility) {
		parts.push(`**Visibility:** ${input.visibility}`);
	}

	if (input.isAsync) {
		parts.push(`**Async:** Yes`);
	}

	if (input.decorators && input.decorators.length > 0) {
		parts.push(`**Decorators:** ${input.decorators.join(", ")}`);
	}

	if (input.calledBy && input.calledBy.length > 0) {
		parts.push("");
		parts.push(`**Called by:** ${input.calledBy.join(", ")}`);
	}

	parts.push("");
	parts.push("```" + input.language);
	parts.push(input.code);
	parts.push("```");
	parts.push("");
	parts.push("Summary:");

	return parts.join("\n");
}

// ============================================================================
// Class/Interface Summary Prompt
// ============================================================================

export interface ClassSummaryInput {
	language: string;
	unitType: string;
	name: string;
	filePath: string;
	extendsFrom?: string;
	implementsInterfaces?: string[];
	methodSummaries: Array<{ name: string; summary: string }>;
	properties?: Array<{ name: string; type?: string; visibility?: string }>;
	usedBy?: string[];
	code: string;
}

export function buildClassSummaryPrompt(input: ClassSummaryInput): string {
	const parts: string[] = [
		`Write a summary for this ${input.language} ${input.unitType}.`,
		"",
		`**Name:** ${input.name}`,
		`**File:** ${input.filePath}`,
	];

	if (input.extendsFrom) {
		parts.push(`**Extends:** ${input.extendsFrom}`);
	}

	if (input.implementsInterfaces && input.implementsInterfaces.length > 0) {
		parts.push(`**Implements:** ${input.implementsInterfaces.join(", ")}`);
	}

	// Add method summaries (first sentence only for brevity)
	if (input.methodSummaries.length > 0) {
		parts.push("");
		parts.push("**Public Methods:**");
		for (const method of input.methodSummaries) {
			const firstSentence = method.summary.split(/[.!?]/)[0];
			parts.push(`- ${method.name}: ${firstSentence}`);
		}
	}

	// Add properties
	if (input.properties && input.properties.length > 0) {
		parts.push("");
		parts.push("**Properties:**");
		for (const prop of input.properties) {
			const vis = prop.visibility ? ` (${prop.visibility})` : "";
			const type = prop.type ? `: ${prop.type}` : "";
			parts.push(`- ${prop.name}${type}${vis}`);
		}
	}

	if (input.usedBy && input.usedBy.length > 0) {
		parts.push("");
		parts.push(`**Used by:** ${input.usedBy.join(", ")}`);
	}

	parts.push("");
	parts.push("```" + input.language);
	parts.push(input.code);
	parts.push("```");
	parts.push("");
	parts.push("Summary:");

	return parts.join("\n");
}

// ============================================================================
// File/Module Summary Prompt
// ============================================================================

export interface FileSummaryInput {
	language: string;
	filePath: string;
	moduleName?: string;
	exports: Array<{ name: string; type: string; summary?: string }>;
	internals?: Array<{ name: string; type: string }>;
	externalDeps?: string[];
	internalDeps?: string[];
	importedBy?: string[];
}

export function buildFileSummaryPrompt(input: FileSummaryInput): string {
	const parts: string[] = [
		`Write a summary for this ${input.language} file.`,
		"",
		`**Path:** ${input.filePath}`,
	];

	if (input.moduleName) {
		parts.push(`**Module/Package:** ${input.moduleName}`);
	}

	// Exports
	if (input.exports.length > 0) {
		parts.push("");
		parts.push("**Exports:**");
		for (const exp of input.exports) {
			const summary = exp.summary ? `: ${exp.summary.split(/[.!?]/)[0]}` : "";
			parts.push(`- ${exp.name} (${exp.type})${summary}`);
		}
	}

	// Internal helpers
	if (input.internals && input.internals.length > 0) {
		parts.push("");
		parts.push("**Internal (non-exported):**");
		for (const internal of input.internals) {
			parts.push(`- ${internal.name} (${internal.type})`);
		}
	}

	// Dependencies
	if (input.externalDeps || input.internalDeps) {
		parts.push("");
		parts.push("**Dependencies:**");
		if (input.externalDeps && input.externalDeps.length > 0) {
			parts.push(`External: ${input.externalDeps.join(", ")}`);
		}
		if (input.internalDeps && input.internalDeps.length > 0) {
			parts.push(`Internal: ${input.internalDeps.join(", ")}`);
		}
	}

	// Dependents
	if (input.importedBy && input.importedBy.length > 0) {
		parts.push("");
		parts.push("**Imported by:**");
		for (const imp of input.importedBy) {
			parts.push(`- ${imp}`);
		}
	}

	parts.push("");
	parts.push("Summary:");

	return parts.join("\n");
}

// ============================================================================
// Language-Specific Helpers
// ============================================================================

export interface GoFunctionSummaryInput extends FunctionSummaryInput {
	packageName: string;
	receiver?: string;
	isExported: boolean;
	returnsError?: boolean;
	errorInfo?: string;
}

export function buildGoFunctionSummaryPrompt(
	input: GoFunctionSummaryInput,
): string {
	const parts: string[] = [
		`Write a summary for this Go function.`,
		"",
		`**Name:** ${input.name}`,
		`**Signature:** ${input.signature}`,
		`**File:** ${input.filePath}`,
		`**Package:** ${input.packageName}`,
	];

	if (input.receiver) {
		parts.push(`**Receiver:** ${input.receiver}`);
	} else {
		parts.push(`**Receiver:** None (standalone function)`);
	}

	parts.push(`**Exported:** ${input.isExported ? "Yes" : "No"}`);

	if (input.returnsError) {
		const errorDetail = input.errorInfo || "Yes";
		parts.push("");
		parts.push(`**Returns error:** ${errorDetail}`);
	}

	parts.push("");
	parts.push("```go");
	parts.push(input.code);
	parts.push("```");
	parts.push("");
	parts.push("Summary:");

	return parts.join("\n");
}
