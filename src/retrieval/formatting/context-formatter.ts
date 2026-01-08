/**
 * Context Formatter
 *
 * Formats search results for LLM consumption with strategic positioning:
 * - Primary results at START (highest attention)
 * - Summaries at END (moderate attention)
 * - Supporting context in MIDDLE (lowest attention - "lost in middle" effect)
 *
 * This addresses the known issue with LLM attention patterns where
 * information in the middle of long contexts is often overlooked.
 */

import type {
	CodeUnit,
	FormattedContext,
	QueryIntent,
	RerankedSearchResult,
} from "../../types.js";

// ============================================================================
// Types
// ============================================================================

export interface FormatterOptions {
	/** Maximum total tokens to include (default: 8000) */
	maxTokens?: number;
	/** Estimate of characters per token (default: 4) */
	charsPerToken?: number;
	/** Include file path headers (default: true) */
	includeHeaders?: boolean;
	/** Include line numbers (default: false) */
	includeLineNumbers?: boolean;
	/** Format style */
	style?: "markdown" | "xml" | "plain";
}

export interface FormatInput {
	/** Primary relevant code units */
	primary: CodeUnit[];
	/** Supporting context (may be placed in middle) */
	supporting?: CodeUnit[];
	/** File/class summaries for overview */
	summaries?: Array<{ name: string; summary: string; path: string }>;
	/** Query intent for context */
	queryIntent: QueryIntent;
}

// ============================================================================
// Constants
// ============================================================================

/** Token budget allocations */
const TOKEN_ALLOCATIONS = {
	primary: 0.5, // 50% for primary results
	supporting: 0.25, // 25% for supporting context
	summaries: 0.25, // 25% for summaries
};

// ============================================================================
// Context Formatter Class
// ============================================================================

export class ContextFormatter {
	private options: Required<FormatterOptions>;

	constructor(options: FormatterOptions = {}) {
		this.options = {
			maxTokens: options.maxTokens ?? 8000,
			charsPerToken: options.charsPerToken ?? 4,
			includeHeaders: options.includeHeaders ?? true,
			includeLineNumbers: options.includeLineNumbers ?? false,
			style: options.style ?? "markdown",
		};
	}

	/**
	 * Format results for LLM context window
	 */
	format(input: FormatInput): FormattedContext {
		const { primary, supporting = [], summaries = [], queryIntent } = input;
		const maxChars = this.options.maxTokens * this.options.charsPerToken;

		// Calculate budgets
		const primaryBudget = Math.floor(maxChars * TOKEN_ALLOCATIONS.primary);
		const supportingBudget = Math.floor(
			maxChars * TOKEN_ALLOCATIONS.supporting,
		);
		const summariesBudget = Math.floor(maxChars * TOKEN_ALLOCATIONS.summaries);

		// Format each section
		const primaryFormatted = this.formatCodeUnits(
			primary,
			primaryBudget,
			"primary",
		);
		const supportingFormatted =
			supporting.length > 0
				? this.formatCodeUnits(supporting, supportingBudget, "supporting")
				: undefined;
		const summariesFormatted = this.formatSummaries(summaries, summariesBudget);

		// Count unique files
		const allPaths = new Set([
			...primary.map((u) => u.filePath),
			...supporting.map((u) => u.filePath),
		]);

		return {
			primary: primaryFormatted,
			supporting: supportingFormatted,
			summaries: summariesFormatted,
			metadata: {
				resultCount: primary.length + supporting.length,
				fileCount: allPaths.size,
				queryIntent,
				tokenEstimate:
					this.estimateTokens(primaryFormatted) +
					this.estimateTokens(supportingFormatted || "") +
					this.estimateTokens(summariesFormatted),
			},
		};
	}

	/**
	 * Format for direct LLM insertion (positioned for attention)
	 */
	formatForLLM(input: FormatInput): string {
		const formatted = this.format(input);
		const parts: string[] = [];

		// Section 1: Primary (START - highest attention)
		if (formatted.primary) {
			parts.push(this.wrapSection("Relevant Code", formatted.primary));
		}

		// Section 2: Supporting (MIDDLE - lower attention)
		if (formatted.supporting) {
			parts.push(this.wrapSection("Additional Context", formatted.supporting));
		}

		// Section 3: Summaries (END - moderate attention)
		if (formatted.summaries) {
			parts.push(this.wrapSection("File Overview", formatted.summaries));
		}

		return parts.join("\n\n");
	}

	/**
	 * Format code units within token budget
	 */
	private formatCodeUnits(
		units: CodeUnit[],
		maxChars: number,
		section: string,
	): string {
		const chunks: string[] = [];
		let totalChars = 0;

		for (const unit of units) {
			const formatted = this.formatSingleUnit(unit);
			const chars = formatted.length;

			if (totalChars + chars > maxChars) {
				// Try to include a truncated version if there's room
				const remaining = maxChars - totalChars;
				if (remaining > 200) {
					const truncated = this.truncateUnit(unit, remaining);
					chunks.push(truncated);
				}
				break;
			}

			chunks.push(formatted);
			totalChars += chars;
		}

		return chunks.join("\n\n");
	}

	/**
	 * Format a single code unit
	 */
	private formatSingleUnit(unit: CodeUnit): string {
		const parts: string[] = [];

		// Header
		if (this.options.includeHeaders) {
			const header = this.formatHeader(unit);
			parts.push(header);
		}

		// Content
		const content = this.formatContent(unit);
		parts.push(content);

		return parts.join("\n");
	}

	/**
	 * Format unit header
	 */
	private formatHeader(unit: CodeUnit): string {
		const location =
			unit.startLine && unit.endLine
				? `:${unit.startLine}-${unit.endLine}`
				: "";

		switch (this.options.style) {
			case "xml":
				return `<code path="${unit.filePath}${location}" type="${unit.unitType}" name="${unit.name || ""}">`;
			case "markdown":
				return `### ${unit.name || unit.unitType} \`${unit.filePath}${location}\``;
			default:
				return `// ${unit.filePath}${location} - ${unit.name || unit.unitType}`;
		}
	}

	/**
	 * Format unit content
	 */
	private formatContent(unit: CodeUnit): string {
		let content = unit.content;

		// Add line numbers if requested
		if (this.options.includeLineNumbers && unit.startLine) {
			const lines = content.split("\n");
			content = lines
				.map(
					(line, i) =>
						`${(unit.startLine + i).toString().padStart(4)} | ${line}`,
				)
				.join("\n");
		}

		// Wrap in code fence for markdown
		if (this.options.style === "markdown") {
			return "```" + (unit.language || "") + "\n" + content + "\n```";
		}

		// Close XML tag
		if (this.options.style === "xml") {
			return content + "\n</code>";
		}

		return content;
	}

	/**
	 * Truncate a unit to fit within character limit
	 */
	private truncateUnit(unit: CodeUnit, maxChars: number): string {
		const headerLen = this.formatHeader(unit).length + 20; // Buffer
		const contentBudget = maxChars - headerLen;

		if (contentBudget < 100) {
			return ""; // Not enough room
		}

		// Truncate content
		const lines = unit.content.split("\n");
		const truncatedLines: string[] = [];
		let totalChars = 0;

		for (const line of lines) {
			if (totalChars + line.length + 1 > contentBudget) {
				truncatedLines.push("// ... truncated ...");
				break;
			}
			truncatedLines.push(line);
			totalChars += line.length + 1;
		}

		const truncatedUnit = { ...unit, content: truncatedLines.join("\n") };
		return this.formatSingleUnit(truncatedUnit);
	}

	/**
	 * Format summaries section
	 */
	private formatSummaries(
		summaries: Array<{ name: string; summary: string; path: string }>,
		maxChars: number,
	): string {
		if (summaries.length === 0) {
			return "";
		}

		const chunks: string[] = [];
		let totalChars = 0;

		for (const summary of summaries) {
			let formatted: string;

			switch (this.options.style) {
				case "xml":
					formatted = `<summary file="${summary.path}">\n${summary.name}: ${summary.summary}\n</summary>`;
					break;
				case "markdown":
					formatted = `**${summary.name}** (\`${summary.path}\`)\n${summary.summary}`;
					break;
				default:
					formatted = `${summary.name} (${summary.path}): ${summary.summary}`;
			}

			if (totalChars + formatted.length > maxChars) {
				break;
			}

			chunks.push(formatted);
			totalChars += formatted.length;
		}

		return chunks.join("\n\n");
	}

	/**
	 * Wrap section in appropriate container
	 */
	private wrapSection(title: string, content: string): string {
		if (!content) return "";

		switch (this.options.style) {
			case "xml":
				return `<${title.toLowerCase().replace(/\s+/g, "_")}>\n${content}\n</${title.toLowerCase().replace(/\s+/g, "_")}>`;
			case "markdown":
				return `## ${title}\n\n${content}`;
			default:
				return `=== ${title} ===\n\n${content}`;
		}
	}

	/**
	 * Estimate token count
	 */
	private estimateTokens(text: string): number {
		return Math.ceil(text.length / this.options.charsPerToken);
	}
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a context formatter
 */
export function createContextFormatter(
	options?: FormatterOptions,
): ContextFormatter {
	return new ContextFormatter(options);
}
