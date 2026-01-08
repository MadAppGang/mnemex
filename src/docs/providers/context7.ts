/**
 * Context7 Documentation Provider
 *
 * Fetches documentation from Context7 API.
 * Best for: Code examples, API reference documentation
 * Coverage: 6000+ libraries with versioning support
 *
 * API Details:
 * - Search endpoint returns JSON: GET /api/v2/search?query=...
 * - Docs endpoint returns Markdown: GET /api/v2/docs/code/{id}
 */

import { CONTEXT7_API_URL, getContext7ApiKey } from "../../config.js";
import type { DocProviderType } from "../../types.js";
import type { FetchedDoc, FetchOptions } from "../types.js";
import { LIBRARY_SOURCES } from "../registry.js";
import {
	AuthenticationError,
	BaseDocProvider,
	LibraryNotFoundError,
	RateLimitError,
	withRetry,
} from "./base.js";

// ============================================================================
// Types
// ============================================================================

/** Context7 library search result */
interface Context7SearchResult {
	id: string; // e.g., "/facebook/react" or "/websites/react_dev"
	title: string;
	description?: string;
	totalSnippets?: number;
	trustScore?: number;
}

/** Context7 search API response */
interface Context7SearchResponse {
	results: Context7SearchResult[];
}

// ============================================================================
// Provider Implementation
// ============================================================================

export class Context7Provider extends BaseDocProvider {
	name: DocProviderType = "context7";
	priority = 1; // Primary provider

	private apiKey: string | undefined;

	constructor(apiKey?: string, cacheTTLHours = 24) {
		super(cacheTTLHours);
		this.apiKey = apiKey || getContext7ApiKey();
	}

	/**
	 * Check if we have an API key configured
	 */
	isConfigured(): boolean {
		return !!this.apiKey;
	}

	/**
	 * Check if this provider supports the given library.
	 * Uses the search API to check if the library exists.
	 */
	async supports(library: string): Promise<boolean> {
		if (!this.apiKey) return false;

		try {
			const libraryId = await this.resolveLibraryId(library);
			return !!libraryId;
		} catch {
			return false;
		}
	}

	/**
	 * Fetch documentation for a library
	 */
	async fetch(library: string, options?: FetchOptions): Promise<FetchedDoc[]> {
		if (!this.apiKey) {
			throw new AuthenticationError(
				"context7",
				"Context7 API key not configured",
			);
		}

		// Check cache first
		const cached = this.getCached(library, options?.version);
		if (cached) return cached;

		// Resolve library ID (e.g., "react" → "/websites/react_dev")
		const libraryId = await this.resolveLibraryId(library);
		if (!libraryId) {
			throw new LibraryNotFoundError(library, "context7");
		}

		// Fetch documentation (returns markdown)
		const docs = await this.fetchDocs(libraryId, options);

		// Cache and return
		this.setCache(library, options?.version, docs);
		return docs;
	}

	/**
	 * Resolve a package name to Context7 library ID
	 * e.g., "react" → "/websites/react_dev"
	 */
	private async resolveLibraryId(library: string): Promise<string | undefined> {
		// If already in Context7 format (starts with /), use as-is
		if (library.startsWith("/")) {
			return library;
		}

		// Check the registry for known mappings first
		const registryEntry = LIBRARY_SOURCES[library.toLowerCase()];
		if (registryEntry?.context7) {
			// Registry stores "owner/repo" format, convert to "/owner/repo"
			const id = registryEntry.context7;
			return id.startsWith("/") ? id : `/${id}`;
		}

		// Fall back to search API
		try {
			const searchUrl = `${CONTEXT7_API_URL}/search?query=${encodeURIComponent(library)}`;
			const response = await this.searchRequest(searchUrl);

			if (!response?.results || response.results.length === 0) {
				return undefined;
			}

			// Find best match - prefer higher trust score and more snippets
			const results = response.results;

			// Look for exact title match first
			const exactMatch = results.find(
				(r) => r.title.toLowerCase() === library.toLowerCase(),
			);
			if (exactMatch) {
				return exactMatch.id;
			}

			// Otherwise return top result (already sorted by relevance)
			return results[0].id;
		} catch {
			// Search failed, library not found
			return undefined;
		}
	}

	/**
	 * Fetch documentation pages for a library
	 * Context7 returns markdown, which we parse into sections
	 */
	private async fetchDocs(
		libraryId: string,
		options?: FetchOptions,
	): Promise<FetchedDoc[]> {
		// Build URL - libraryId already has leading /
		let url = `${CONTEXT7_API_URL}/docs/code${libraryId}`;

		// Add version if specified
		if (options?.version) {
			url += `/${options.version}`;
		}

		// Add query params
		const params = new URLSearchParams();
		if (options?.topic) {
			params.set("topic", options.topic);
		}
		// Add page param if needed
		if (options?.maxPages && options.maxPages > 1) {
			params.set("page", "1");
		}

		const queryString = params.toString();
		if (queryString) {
			url += `?${queryString}`;
		}

		// Fetch markdown content
		const markdown = await this.docsRequest(url);

		if (!markdown || markdown.trim().length === 0) {
			return [];
		}

		// Parse markdown into sections
		const docs = this.parseMarkdownDocs(libraryId, markdown, options?.maxPages);

		// Report progress if callback provided
		if (options?.onProgress) {
			options.onProgress(docs.length, docs.length);
		}

		return docs;
	}

	/**
	 * Parse markdown documentation into FetchedDoc sections
	 * Context7 separates snippets with "--------------------------------"
	 */
	private parseMarkdownDocs(
		libraryId: string,
		markdown: string,
		maxDocs?: number,
	): FetchedDoc[] {
		const docs: FetchedDoc[] = [];
		const sections = markdown.split(/^-{20,}$/m);

		for (
			let i = 0;
			i < sections.length && (!maxDocs || docs.length < maxDocs);
			i++
		) {
			const section = sections[i].trim();
			if (!section) continue;

			// Extract title from first ### heading
			const titleMatch = section.match(/^###\s+(.+?)$/m);
			const title = titleMatch ? titleMatch[1].trim() : `Section ${i + 1}`;

			// Extract source URL
			const sourceMatch = section.match(/^Source:\s+(.+?)$/m);
			const sourceUrl = sourceMatch ? sourceMatch[1].trim() : undefined;

			// Remove title and source lines from content
			let content = section
				.replace(/^###\s+.+?$/m, "")
				.replace(/^Source:\s+.+?$/m, "")
				.trim();

			// Skip empty sections
			if (!content) continue;

			docs.push({
				id: `context7:${libraryId}:${i}`,
				title,
				content,
				url: sourceUrl,
			});
		}

		return docs;
	}

	/**
	 * Make search API request (returns JSON)
	 */
	private async searchRequest(url: string): Promise<Context7SearchResponse> {
		return withRetry(
			async () => {
				const controller = new AbortController();
				const timeoutId = setTimeout(() => controller.abort(), 10000);

				try {
					const response = await fetch(url, {
						headers: {
							Authorization: `Bearer ${this.apiKey}`,
							Accept: "application/json",
						},
						signal: controller.signal,
					});

					if (response.status === 401) {
						throw new AuthenticationError("context7", "Invalid API key");
					}

					if (response.status === 429) {
						const retryAfter = response.headers.get("Retry-After");
						throw new RateLimitError(
							"context7",
							retryAfter ? Number.parseInt(retryAfter) * 1000 : undefined,
						);
					}

					if (!response.ok) {
						throw new Error(`Context7 search error: ${response.status}`);
					}

					return response.json() as Promise<Context7SearchResponse>;
				} finally {
					clearTimeout(timeoutId);
				}
			},
			{
				maxAttempts: 3,
				shouldRetry: (error) => {
					if (error instanceof RateLimitError) return true;
					if (error instanceof TypeError) return true;
					// Retry on timeout (AbortError)
					if (error instanceof Error && error.name === "AbortError")
						return true;
					return false;
				},
			},
		);
	}

	/**
	 * Make docs API request (returns markdown text)
	 */
	private async docsRequest(url: string): Promise<string> {
		return withRetry(
			async () => {
				const controller = new AbortController();
				const timeoutId = setTimeout(() => controller.abort(), 10000);

				try {
					const response = await fetch(url, {
						headers: {
							Authorization: `Bearer ${this.apiKey}`,
							Accept: "text/plain, text/markdown, */*",
						},
						signal: controller.signal,
					});

					if (response.status === 401) {
						throw new AuthenticationError("context7", "Invalid API key");
					}

					if (response.status === 404) {
						throw new LibraryNotFoundError(url, "context7");
					}

					if (response.status === 429) {
						const retryAfter = response.headers.get("Retry-After");
						throw new RateLimitError(
							"context7",
							retryAfter ? Number.parseInt(retryAfter) * 1000 : undefined,
						);
					}

					if (!response.ok) {
						throw new Error(`Context7 docs error: ${response.status}`);
					}

					return response.text();
				} finally {
					clearTimeout(timeoutId);
				}
			},
			{
				maxAttempts: 3,
				shouldRetry: (error) => {
					if (error instanceof RateLimitError) return true;
					if (error instanceof TypeError) return true;
					// Retry on timeout (AbortError)
					if (error instanceof Error && error.name === "AbortError")
						return true;
					return false;
				},
			},
		);
	}
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a Context7 provider instance
 */
export function createContext7Provider(
	apiKey?: string,
	cacheTTLHours?: number,
): Context7Provider {
	return new Context7Provider(apiKey, cacheTTLHours);
}
