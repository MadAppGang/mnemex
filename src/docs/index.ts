/**
 * Documentation Module
 *
 * Provides multi-source documentation fetching for project dependencies.
 * Supports Context7, llms.txt, and DevDocs providers with automatic
 * fallback and version matching.
 */

import { getContext7ApiKey, getDocsConfig, isDocsEnabled } from "../config.js";
import type { DocProviderType, DocsConfig } from "../types.js";
import type {
	DocChunk,
	DocProvider,
	FetchedDoc,
	FetchOptions,
} from "./types.js";
import { DocChunker, createDocChunker } from "./doc-chunker.js";
import { LibraryMapper, createLibraryMapper } from "./library-mapper.js";
import {
	Context7Provider,
	DevDocsProvider,
	LlmsTxtProvider,
	createContext7Provider,
	createDevDocsProvider,
	createLlmsTxtProvider,
} from "./providers/index.js";

// ============================================================================
// Re-exports
// ============================================================================

// Types (all types from types.ts)
export type {
	FetchedDoc,
	FetchOptions,
	DocProvider,
	PackageEcosystem,
	VersionConstraint,
	DetectedDependency,
	LibrarySource,
	DocChunk,
	IndexedDocState,
} from "./types.js";

// Providers
export * from "./providers/index.js";

// Registry
export * from "./registry.js";

// Version parsing (excluding PackageEcosystem which is already in types.ts)
export {
	parseVersion,
	extractMajorVersion,
	parseNpmVersion,
	parsePythonVersion,
	parseGoVersion,
	parseCargoVersion,
	parseVersionForEcosystem,
} from "./version-parser.js";

// Library mapping
export { LibraryMapper, createLibraryMapper } from "./library-mapper.js";

// Chunking
export { DocChunker, createDocChunker } from "./doc-chunker.js";

// ============================================================================
// Provider Factory
// ============================================================================

/**
 * Create all enabled documentation providers based on configuration
 */
export function createProviders(config?: DocsConfig): DocProvider[] {
	const providers: DocProvider[] = [];
	const enabledProviders = config?.providers || [
		"context7",
		"llms_txt",
		"devdocs",
	];
	const cacheTTL = config?.cacheTTL || 24;

	// Add providers in priority order
	if (enabledProviders.includes("context7")) {
		const apiKey = config?.context7ApiKey || getContext7ApiKey();
		if (apiKey) {
			providers.push(createContext7Provider(apiKey, cacheTTL));
		}
	}

	if (enabledProviders.includes("llms_txt")) {
		providers.push(createLlmsTxtProvider(cacheTTL));
	}

	if (enabledProviders.includes("devdocs")) {
		providers.push(createDevDocsProvider(cacheTTL));
	}

	// Sort by priority (lower = first)
	return providers.sort((a, b) => a.priority - b.priority);
}

// ============================================================================
// Documentation Fetcher
// ============================================================================

/**
 * High-level documentation fetcher that handles provider fallback
 * and dependency detection.
 */
export class DocsFetcher {
	private providers: DocProvider[];
	private mapper: LibraryMapper;
	private chunker: DocChunker;
	private config: DocsConfig;

	/**
	 * Create a DocsFetcher with explicit config or from project path
	 * @param configOrPath - Either a DocsConfig object or a project path string
	 */
	constructor(configOrPath: DocsConfig | string) {
		if (typeof configOrPath === "string") {
			this.config = getDocsConfig(configOrPath);
		} else {
			this.config = configOrPath;
		}
		this.providers = createProviders(this.config);
		this.mapper = createLibraryMapper();
		this.chunker = createDocChunker();
	}

	/**
	 * Check if documentation fetching is enabled
	 */
	isEnabled(): boolean {
		return this.providers.length > 0;
	}

	/**
	 * Get available providers
	 */
	getProviders(): DocProvider[] {
		return this.providers;
	}

	/**
	 * Detect dependencies in the project
	 */
	async detectDependencies(projectPath: string) {
		return this.mapper.detectDependencies(projectPath);
	}

	/**
	 * Fetch documentation for a library using provider fallback
	 */
	async fetchLibrary(
		library: string,
		options?: FetchOptions,
	): Promise<{ docs: FetchedDoc[]; provider: DocProviderType } | null> {
		// Check exclusions
		if (this.config.excludeLibraries?.includes(library.toLowerCase())) {
			return null;
		}

		// Try each provider in priority order
		for (const provider of this.providers) {
			try {
				if (await provider.supports(library)) {
					const docs = await provider.fetch(library, {
						...options,
						maxPages: options?.maxPages || this.config.maxPagesPerLibrary,
					});

					if (docs.length > 0) {
						return { docs, provider: provider.name };
					}
				}
			} catch (error) {
				// Log error but continue to next provider
				console.warn(
					`[docs] ${provider.name} failed for ${library}: ${error instanceof Error ? error.message : error}`,
				);
			}
		}

		return null;
	}

	/**
	 * Fetch and chunk documentation for a library
	 */
	async fetchAndChunk(
		library: string,
		options?: FetchOptions,
	): Promise<DocChunk[]> {
		const result = await this.fetchLibrary(library, options);

		if (!result) {
			return [];
		}

		return this.chunker.chunkAll(result.docs, {
			provider: result.provider,
			library,
			version: options?.version,
		});
	}

	/**
	 * Fetch documentation for all detected dependencies
	 */
	async fetchAllDependencies(
		projectPath: string,
		options?: {
			onProgress?: (current: number, total: number, library: string) => void;
		},
	): Promise<Map<string, DocChunk[]>> {
		const deps = await this.detectDependencies(projectPath);
		const results = new Map<string, DocChunk[]>();

		for (let i = 0; i < deps.length; i++) {
			const dep = deps[i];

			if (options?.onProgress) {
				options.onProgress(i + 1, deps.length, dep.name);
			}

			const chunks = await this.fetchAndChunk(dep.name, {
				version: dep.majorVersion,
			});

			if (chunks.length > 0) {
				results.set(dep.name, chunks);
			}
		}

		return results;
	}
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a DocsFetcher instance
 */
export function createDocsFetcher(
	projectPath: string,
	config?: DocsConfig,
): DocsFetcher {
	// If explicit config provided, use it; otherwise load from project path
	return new DocsFetcher(config || projectPath);
}

/**
 * Check if documentation fetching is enabled for a project
 */
export { isDocsEnabled };
