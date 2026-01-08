/**
 * DevDocs Documentation Provider
 *
 * Fetches documentation from DevDocs.io API.
 * Provides consistent, offline-friendly documentation.
 * Best for: Fallback when Context7/llms.txt unavailable
 *
 * API: https://devdocs.io/docs.json (index), /docs/{name}/db.json (content)
 */

import { DEVDOCS_API_URL } from "../../config.js";
import type { DocProviderType } from "../../types.js";
import type { FetchedDoc, FetchOptions, LibrarySource } from "../types.js";
import { BaseDocProvider, LibraryNotFoundError, withRetry } from "./base.js";
import { LIBRARY_SOURCES } from "../registry.js";

// ============================================================================
// Types
// ============================================================================

/** DevDocs documentation index entry */
interface DevDocsIndexEntry {
	name: string; // e.g., "React"
	slug: string; // e.g., "react"
	type: string; // e.g., "javascript"
	version?: string;
	release?: string;
	mtime: number;
	db_size: number;
}

/** DevDocs documentation entry from db.json */
interface DevDocsEntry {
	name: string;
	path: string;
	type: string;
}

/** DevDocs db.json structure */
interface DevDocsDatabase {
	entries: DevDocsEntry[];
	types: Array<{ name: string; count: number }>;
}

// ============================================================================
// Provider Implementation
// ============================================================================

export class DevDocsProvider extends BaseDocProvider {
	name: DocProviderType = "devdocs";
	priority = 3; // Fallback provider

	/** Cached index of available docs */
	private docsIndex: DevDocsIndexEntry[] | null = null;
	private indexFetchedAt = 0;

	constructor(cacheTTLHours = 24) {
		super(cacheTTLHours);
	}

	/**
	 * Check if this provider supports the given library.
	 * Looks up in DevDocs index.
	 */
	async supports(library: string): Promise<boolean> {
		const slug = await this.resolveSlug(library);
		return !!slug;
	}

	/**
	 * Fetch documentation for a library
	 */
	async fetch(library: string, options?: FetchOptions): Promise<FetchedDoc[]> {
		// Check cache first
		const cached = this.getCached(library, options?.version);
		if (cached) return cached;

		// Resolve to DevDocs slug
		const slug = await this.resolveSlug(library, options?.version);
		if (!slug) {
			throw new LibraryNotFoundError(library, "devdocs");
		}

		// Fetch documentation database
		const docs = await this.fetchDocsDatabase(slug, library, options);

		// Cache and return
		this.setCache(library, options?.version, docs);
		return docs;
	}

	/**
	 * Resolve a library name to DevDocs slug
	 * e.g., "react" → "react", "vue" with version "3" → "vue~3"
	 */
	private async resolveSlug(
		library: string,
		version?: string,
	): Promise<string | undefined> {
		// Check registry first
		const source = this.getLibrarySource(library);
		if (source?.devdocs) return source.devdocs;

		// Get or fetch the docs index
		const index = await this.getDocsIndex();

		// Try direct match
		let match = index.find((d) => d.slug === library.toLowerCase());
		if (match) {
			// If version specified, look for versioned variant
			if (version) {
				const major = version.replace(/^v/, "").split(".")[0];
				const versionedSlug = `${library}~${major}`;
				const versionedMatch = index.find((d) => d.slug === versionedSlug);
				if (versionedMatch) return versionedSlug;
			}
			return match.slug;
		}

		// Try partial match on name
		match = index.find((d) => d.name.toLowerCase() === library.toLowerCase());
		if (match) return match.slug;

		return undefined;
	}

	/**
	 * Get library source info from registry
	 */
	private getLibrarySource(library: string): LibrarySource | undefined {
		return LIBRARY_SOURCES[library.toLowerCase()];
	}

	/**
	 * Get or fetch the DevDocs index
	 */
	private async getDocsIndex(): Promise<DevDocsIndexEntry[]> {
		// Check if cached index is still valid (1 hour TTL for index)
		const indexTTL = 60 * 60 * 1000;
		if (this.docsIndex && Date.now() - this.indexFetchedAt < indexTTL) {
			return this.docsIndex;
		}

		// Fetch fresh index
		this.docsIndex = await this.fetchDocsIndex();
		this.indexFetchedAt = Date.now();
		return this.docsIndex;
	}

	/**
	 * Fetch the DevDocs index
	 */
	private async fetchDocsIndex(): Promise<DevDocsIndexEntry[]> {
		return withRetry(
			async () => {
				const controller = new AbortController();
				const timeoutId = setTimeout(() => controller.abort(), 10000);

				try {
					const response = await fetch(`${DEVDOCS_API_URL}/docs.json`, {
						signal: controller.signal,
					});
					if (!response.ok) {
						throw new Error(
							`Failed to fetch DevDocs index: ${response.status}`,
						);
					}
					return response.json() as Promise<DevDocsIndexEntry[]>;
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
	 * Fetch documentation database for a slug
	 */
	private async fetchDocsDatabase(
		slug: string,
		library: string,
		options?: FetchOptions,
	): Promise<FetchedDoc[]> {
		const db = await withRetry(
			async () => {
				const controller = new AbortController();
				const timeoutId = setTimeout(() => controller.abort(), 10000);

				try {
					const response = await fetch(
						`${DEVDOCS_API_URL}/docs/${slug}/db.json`,
						{
							signal: controller.signal,
						},
					);
					if (!response.ok) {
						throw new Error(`Failed to fetch DevDocs db: ${response.status}`);
					}
					return response.json() as Promise<DevDocsDatabase>;
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

		// Get entry content (DevDocs stores HTML content separately)
		// For now, we'll use the index entries as documentation
		// In a full implementation, we'd fetch the actual HTML content
		const maxPages = options?.maxPages || 10;
		const entries = db.entries.slice(0, maxPages);

		// Report progress
		if (options?.onProgress) {
			options.onProgress(entries.length, db.entries.length);
		}

		// Convert to FetchedDoc format
		return entries.map((entry, index) => ({
			id: `devdocs:${slug}:${index}`,
			title: entry.name,
			content: `Documentation for ${entry.name}\n\nPath: ${entry.path}\nType: ${entry.type}`,
			section: entry.type,
			url: `${DEVDOCS_API_URL}/${slug}/${entry.path}`,
		}));
	}
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a DevDocs provider instance
 */
export function createDevDocsProvider(cacheTTLHours?: number): DevDocsProvider {
	return new DevDocsProvider(cacheTTLHours);
}
