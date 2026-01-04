/**
 * llms.txt Documentation Provider
 *
 * Fetches AI-friendly documentation from llms.txt/llms-full.txt files.
 * These are structured markdown files published by framework maintainers
 * specifically for LLM consumption.
 *
 * Standard: https://llmstxt.org/
 * Examples: Vue (vuejs.org/llms-full.txt), Nuxt, LangChain
 */

import type { DocProviderType } from "../../types.js";
import type { FetchedDoc, FetchOptions, LibrarySource } from "../types.js";
import { BaseDocProvider, LibraryNotFoundError, withRetry } from "./base.js";
import { LIBRARY_SOURCES } from "../registry.js";

// ============================================================================
// Types
// ============================================================================

/** Parsed section from llms.txt file */
interface LlmsTxtSection {
	title: string;
	content: string;
	level: number; // Heading level (1-6)
	subsections?: LlmsTxtSection[];
}

// ============================================================================
// Provider Implementation
// ============================================================================

export class LlmsTxtProvider extends BaseDocProvider {
	name: DocProviderType = "llms_txt";
	priority = 2; // Secondary provider

	constructor(cacheTTLHours = 24) {
		super(cacheTTLHours);
	}

	/**
	 * Check if this provider supports the given library.
	 * Looks up the library in the registry for an llmsTxt URL.
	 */
	async supports(library: string): Promise<boolean> {
		const source = this.getLibrarySource(library);
		if (source?.llmsTxt) return true;

		// Try common URL patterns
		const url = await this.discoverLlmsTxtUrl(library);
		return !!url;
	}

	/**
	 * Fetch documentation for a library
	 */
	async fetch(library: string, options?: FetchOptions): Promise<FetchedDoc[]> {
		// Check cache first
		const cached = this.getCached(library, options?.version);
		if (cached) return cached;

		// Get llms.txt URL
		const url = await this.getLlmsTxtUrl(library);
		if (!url) {
			// Return empty array for unsupported libraries instead of throwing
			return [];
		}

		// Fetch and parse the file
		const content = await this.fetchLlmsTxt(url);
		const sections = this.parseLlmsTxt(content);

		// Convert to FetchedDoc format
		const docs = this.sectionsToFetchedDocs(library, sections, url);

		// Report progress
		if (options?.onProgress) {
			options.onProgress(docs.length, docs.length);
		}

		// Cache and return
		this.setCache(library, options?.version, docs);
		return docs;
	}

	/**
	 * Look up library source info from registry
	 */
	private getLibrarySource(library: string): LibrarySource | undefined {
		return LIBRARY_SOURCES[library.toLowerCase()];
	}

	/**
	 * Get the llms.txt URL for a library
	 */
	private async getLlmsTxtUrl(library: string): Promise<string | undefined> {
		// Check registry first
		const source = this.getLibrarySource(library);
		if (source?.llmsTxt) return source.llmsTxt;

		// Try to discover URL
		return this.discoverLlmsTxtUrl(library);
	}

	/**
	 * Try to discover llms.txt URL for a library
	 * Uses common URL patterns and the llms-text.ai API
	 */
	private async discoverLlmsTxtUrl(
		library: string,
	): Promise<string | undefined> {
		// Common URL patterns to try
		const patterns = [
			`https://${library}.dev/llms-full.txt`,
			`https://${library}.dev/llms.txt`,
			`https://${library}js.org/llms-full.txt`,
			`https://${library}js.org/llms.txt`,
			`https://${library}.io/llms-full.txt`,
			`https://${library}.io/llms.txt`,
		];

		// Try each pattern with timeout
		for (const url of patterns) {
			try {
				const controller = new AbortController();
				const timeoutId = setTimeout(() => controller.abort(), 5000); // 5s for HEAD requests
				try {
					const response = await fetch(url, { method: "HEAD", signal: controller.signal });
					if (response.ok) return url;
				} finally {
					clearTimeout(timeoutId);
				}
			} catch {
				// Continue to next pattern
			}
		}

		// Try llms-text.ai search API with timeout
		try {
			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), 10000);
			try {
				const searchUrl = `https://llms-text.ai/api/search-llms?q=${encodeURIComponent(library)}`;
				const response = await fetch(searchUrl, { signal: controller.signal });
				if (response.ok) {
					const results = (await response.json()) as Array<{
						url: string;
						name: string;
					}>;
					if (results.length > 0) {
						// Find best match
						const match = results.find(
							(r) =>
								r.name.toLowerCase().includes(library.toLowerCase()) ||
								r.url.toLowerCase().includes(library.toLowerCase()),
						);
						return match?.url || results[0].url;
					}
				}
			} finally {
				clearTimeout(timeoutId);
			}
		} catch {
			// API not available, continue without it
		}

		return undefined;
	}

	/**
	 * Fetch llms.txt file content
	 */
	private async fetchLlmsTxt(url: string): Promise<string> {
		return withRetry(
			async () => {
				const controller = new AbortController();
				const timeoutId = setTimeout(() => controller.abort(), 10000);

				try {
					const response = await fetch(url, { signal: controller.signal });
					if (!response.ok) {
						throw new Error(`Failed to fetch llms.txt: ${response.status}`);
					}
					return response.text();
				} finally {
					clearTimeout(timeoutId);
				}
			},
			{
				maxAttempts: 3,
				shouldRetry: (error) =>
					error instanceof Error && error.name === "AbortError",
			},
		);
	}

	/**
	 * Parse llms.txt markdown into sections
	 */
	private parseLlmsTxt(content: string): LlmsTxtSection[] {
		const lines = content.split("\n");
		const sections: LlmsTxtSection[] = [];
		let currentSection: LlmsTxtSection | null = null;
		let contentBuffer: string[] = [];

		const flushContent = () => {
			if (currentSection) {
				currentSection.content = contentBuffer.join("\n").trim();
				sections.push(currentSection);
			}
			contentBuffer = [];
		};

		for (const line of lines) {
			// Check for heading
			const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
			if (headingMatch) {
				flushContent();
				currentSection = {
					title: headingMatch[2].trim(),
					content: "",
					level: headingMatch[1].length,
				};
			} else if (currentSection) {
				contentBuffer.push(line);
			} else {
				// Content before first heading - create intro section
				if (line.trim()) {
					if (!currentSection) {
						currentSection = {
							title: "Introduction",
							content: "",
							level: 1,
						};
					}
					contentBuffer.push(line);
				}
			}
		}

		flushContent();
		return sections;
	}

	/**
	 * Convert parsed sections to FetchedDoc format
	 */
	private sectionsToFetchedDocs(
		library: string,
		sections: LlmsTxtSection[],
		sourceUrl: string,
	): FetchedDoc[] {
		return sections.map((section, index) => ({
			id: `llms_txt:${library}:${index}`,
			title: section.title,
			content: section.content,
			section: section.level === 1 ? undefined : section.title,
			url: sourceUrl,
		}));
	}
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create an llms.txt provider instance
 */
export function createLlmsTxtProvider(cacheTTLHours?: number): LlmsTxtProvider {
	return new LlmsTxtProvider(cacheTTLHours);
}
