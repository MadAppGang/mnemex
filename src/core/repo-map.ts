/**
 * Repo Map Generator
 *
 * Generates a token-budgeted structural overview of the codebase.
 * Uses PageRank scores to prioritize important symbols.
 *
 * Output format (example):
 *
 * src/core/indexer.ts:
 *   class Indexer
 *     async index(force?: boolean): Promise<EnrichedIndexResult>
 *     async search(query: string): Promise<SearchResult[]>
 *   function createIndexer(options): Indexer
 *
 * src/core/store.ts:
 *   class VectorStore
 *     async addChunks(chunks[]): Promise<void>
 *     async search(query, vector): Promise<SearchResult[]>
 */

import type { IFileTracker } from "./tracker.js";
import type {
	SymbolDefinition,
	SymbolKind,
	RepoMapOptions,
	RepoMapEntry,
} from "../types.js";

// ============================================================================
// Constants
// ============================================================================

/** Characters per token estimate for code */
const CHARS_PER_TOKEN = 4;

/** Indentation for nested items */
const INDENT = "  ";

/** Maximum symbols per file in the map */
const MAX_SYMBOLS_PER_FILE = 20;

// ============================================================================
// Repo Map Generator Class
// ============================================================================

export class RepoMapGenerator {
	private tracker: IFileTracker;

	constructor(tracker: IFileTracker) {
		this.tracker = tracker;
	}

	/**
	 * Generate a text-based repo map within token budget
	 */
	generate(options: RepoMapOptions = {}): string {
		const {
			maxTokens = 2000,
			includeSignatures = true,
			pathPattern,
			topNByPagerank,
		} = options;

		// Get symbols sorted by PageRank
		let symbols = this.tracker.getTopSymbols(topNByPagerank || 5000);

		// Filter by path pattern if provided
		if (pathPattern) {
			const pattern = new RegExp(
				pathPattern.replace(/\*/g, ".*").replace(/\//g, "\\/"),
			);
			symbols = symbols.filter((s) => pattern.test(s.filePath));
		}

		// Group symbols by file
		const fileMap = this.groupByFile(symbols);

		// Sort files by total PageRank (importance)
		const sortedFiles = this.sortFilesByImportance(fileMap);

		// Build output with token budgeting
		const lines: string[] = [];
		let currentTokens = 0;
		const maxChars = maxTokens * CHARS_PER_TOKEN;

		for (const filePath of sortedFiles) {
			const fileSymbols = fileMap.get(filePath)!;
			const fileLines = this.formatFile(
				filePath,
				fileSymbols,
				includeSignatures,
			);
			const fileChars = fileLines.join("\n").length;
			const fileTokens = fileChars / CHARS_PER_TOKEN;

			// Check if we can fit this file
			if (currentTokens + fileTokens > maxTokens) {
				// Try to fit at least the file header
				const headerLine = `${filePath}: (${fileSymbols.length} symbols)`;
				const headerTokens = headerLine.length / CHARS_PER_TOKEN;

				if (currentTokens + headerTokens < maxTokens) {
					lines.push(headerLine);
					currentTokens += headerTokens;
				}
				continue;
			}

			lines.push(...fileLines);
			currentTokens += fileTokens;
		}

		return lines.join("\n");
	}

	/**
	 * Generate structured repo map data (for programmatic use)
	 */
	generateStructured(options: RepoMapOptions = {}): RepoMapEntry[] {
		const { pathPattern, topNByPagerank } = options;

		let symbols = this.tracker.getTopSymbols(topNByPagerank || 5000);

		if (pathPattern) {
			const pattern = new RegExp(
				pathPattern.replace(/\*/g, ".*").replace(/\//g, "\\/"),
			);
			symbols = symbols.filter((s) => pattern.test(s.filePath));
		}

		const fileMap = this.groupByFile(symbols);

		const entries: RepoMapEntry[] = [];

		for (const [filePath, fileSymbols] of fileMap) {
			entries.push({
				filePath,
				symbols: fileSymbols.slice(0, MAX_SYMBOLS_PER_FILE).map((s) => ({
					name: s.name,
					kind: s.kind,
					signature: s.signature,
					line: s.startLine,
					pagerankScore: s.pagerankScore,
				})),
			});
		}

		// Sort by total PageRank of symbols
		return entries.sort(
			(a, b) =>
				b.symbols.reduce((sum, s) => sum + s.pagerankScore, 0) -
				a.symbols.reduce((sum, s) => sum + s.pagerankScore, 0),
		);
	}

	/**
	 * Generate a focused repo map for a specific query
	 * Returns symbols most relevant to the query terms
	 */
	generateForQuery(query: string, options: RepoMapOptions = {}): string {
		const { maxTokens = 500 } = options;

		// Extract terms from query
		const terms = query
			.toLowerCase()
			.split(/\s+/)
			.filter((t) => t.length > 2);

		// Get all symbols and score by relevance
		const allSymbols = this.tracker.getTopSymbols(10000);

		const scoredSymbols = allSymbols.map((symbol) => {
			let relevance = 0;

			// Check name match
			const nameLower = symbol.name.toLowerCase();
			for (const term of terms) {
				if (nameLower.includes(term)) {
					relevance += 10;
				}
			}

			// Check signature match
			if (symbol.signature) {
				const sigLower = symbol.signature.toLowerCase();
				for (const term of terms) {
					if (sigLower.includes(term)) {
						relevance += 5;
					}
				}
			}

			// Check file path match
			const pathLower = symbol.filePath.toLowerCase();
			for (const term of terms) {
				if (pathLower.includes(term)) {
					relevance += 3;
				}
			}

			// Boost by PageRank
			relevance *= 1 + symbol.pagerankScore * 100;

			return { symbol, relevance };
		});

		// Sort by relevance
		scoredSymbols.sort((a, b) => b.relevance - a.relevance);

		// Take top relevant symbols
		const relevantSymbols = scoredSymbols
			.filter((s) => s.relevance > 0)
			.slice(0, 50)
			.map((s) => s.symbol);

		// Generate map for these symbols
		const fileMap = this.groupByFile(relevantSymbols);
		const sortedFiles = this.sortFilesByImportance(fileMap);

		const lines: string[] = [];
		let currentTokens = 0;

		for (const filePath of sortedFiles) {
			const fileSymbols = fileMap.get(filePath)!;
			const fileLines = this.formatFile(filePath, fileSymbols, true);
			const fileTokens = fileLines.join("\n").length / CHARS_PER_TOKEN;

			if (currentTokens + fileTokens > maxTokens) {
				break;
			}

			lines.push(...fileLines);
			currentTokens += fileTokens;
		}

		return lines.join("\n");
	}

	/**
	 * Group symbols by file path
	 */
	private groupByFile(
		symbols: SymbolDefinition[],
	): Map<string, SymbolDefinition[]> {
		const map = new Map<string, SymbolDefinition[]>();

		for (const symbol of symbols) {
			if (!map.has(symbol.filePath)) {
				map.set(symbol.filePath, []);
			}
			map.get(symbol.filePath)!.push(symbol);
		}

		// Sort symbols within each file by line number
		for (const [, fileSymbols] of map) {
			fileSymbols.sort((a, b) => a.startLine - b.startLine);
		}

		return map;
	}

	/**
	 * Sort files by total PageRank importance
	 */
	private sortFilesByImportance(
		fileMap: Map<string, SymbolDefinition[]>,
	): string[] {
		const fileScores = new Map<string, number>();

		for (const [filePath, symbols] of fileMap) {
			const totalScore = symbols.reduce((sum, s) => sum + s.pagerankScore, 0);
			fileScores.set(filePath, totalScore);
		}

		return [...fileMap.keys()].sort(
			(a, b) => (fileScores.get(b) || 0) - (fileScores.get(a) || 0),
		);
	}

	/**
	 * Format a single file's symbols for the repo map
	 */
	private formatFile(
		filePath: string,
		symbols: SymbolDefinition[],
		includeSignatures: boolean,
	): string[] {
		const lines: string[] = [`${filePath}:`];

		// Separate top-level and nested symbols
		const topLevel = symbols.filter((s) => !s.parentId);
		const nested = new Map<string, SymbolDefinition[]>();

		for (const s of symbols) {
			if (s.parentId) {
				if (!nested.has(s.parentId)) {
					nested.set(s.parentId, []);
				}
				nested.get(s.parentId)!.push(s);
			}
		}

		// Limit symbols per file
		const displaySymbols = topLevel.slice(0, MAX_SYMBOLS_PER_FILE);

		for (const symbol of displaySymbols) {
			lines.push(this.formatSymbol(symbol, 1, includeSignatures));

			// Add nested symbols (methods)
			const children = nested.get(symbol.id) || [];
			for (const child of children.slice(0, 10)) {
				lines.push(this.formatSymbol(child, 2, includeSignatures));
			}
		}

		return lines;
	}

	/**
	 * Format a single symbol
	 */
	private formatSymbol(
		symbol: SymbolDefinition,
		indent: number,
		includeSignature: boolean,
	): string {
		const prefix = INDENT.repeat(indent);

		if (includeSignature && symbol.signature) {
			// Clean up signature for display
			let sig = symbol.signature;

			// Truncate very long signatures
			if (sig.length > 100) {
				sig = sig.slice(0, 97) + "...";
			}

			return `${prefix}${sig}`;
		}

		// Fall back to kind + name
		return `${prefix}${symbol.kind} ${symbol.name}`;
	}

	/**
	 * Estimate token count for a string
	 */
	private estimateTokens(text: string): number {
		return Math.ceil(text.length / CHARS_PER_TOKEN);
	}
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a repo map generator
 */
export function createRepoMapGenerator(
	tracker: IFileTracker,
): RepoMapGenerator {
	return new RepoMapGenerator(tracker);
}
