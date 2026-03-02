/**
 * Token Counter
 *
 * Estimates token counts for pack output using a simple chars/4 heuristic.
 * This is a fast approximation suitable for rough sizing estimates.
 */

import type { FileEntry, TokenReport } from "./types.js";

// ============================================================================
// Constants
// ============================================================================

/**
 * Approximate number of characters per token.
 * GPT-4 / Claude models average ~4 chars per token for English/code.
 */
const CHARS_PER_TOKEN = 4;

// ============================================================================
// Functions
// ============================================================================

/**
 * Estimate the number of tokens in a string using chars/4 heuristic.
 *
 * @param text - Text to estimate tokens for
 * @returns Estimated token count
 */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Annotate file entries with estimated token counts.
 * Modifies entries in place, setting the `estimatedTokens` field.
 *
 * @param entries - File entries to annotate (binary entries get 0 tokens)
 */
export function annotateTokenEstimates(entries: FileEntry[]): void {
	for (const entry of entries) {
		if (entry.isBinary || !entry.content) {
			entry.estimatedTokens = 0;
		} else {
			entry.estimatedTokens = estimateTokens(entry.content);
		}
	}
}

/**
 * Build a token report from annotated file entries and structure text.
 *
 * @param entries - File entries (must have estimatedTokens set)
 * @param structureText - The tree/header text (not file content)
 * @returns Token report with per-file breakdown
 */
export function buildTokenReport(
	entries: FileEntry[],
	structureText: string,
): TokenReport {
	const structureTokens = estimateTokens(structureText);

	let contentTokens = 0;
	const byFile: Array<{ relativePath: string; tokens: number }> = [];

	for (const entry of entries) {
		const tokens = entry.estimatedTokens ?? 0;
		contentTokens += tokens;
		if (!entry.isBinary) {
			byFile.push({ relativePath: entry.relativePath, tokens });
		}
	}

	// Sort by token count descending
	byFile.sort((a, b) => b.tokens - a.tokens);

	return {
		total: structureTokens + contentTokens,
		contentTokens,
		structureTokens,
		byFile,
	};
}
