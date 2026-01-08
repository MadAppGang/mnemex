/**
 * Base Provider Interface
 *
 * Defines the contract for documentation providers.
 * Providers are tried in priority order (lower = first).
 */

import type { DocProvider, FetchedDoc, FetchOptions } from "../types.js";
import type { DocProviderType } from "../../types.js";

// ============================================================================
// Provider Error Types
// ============================================================================

/** Error thrown when a provider cannot find the requested library */
export class LibraryNotFoundError extends Error {
	constructor(
		public library: string,
		public provider: DocProviderType,
	) {
		super(`Library "${library}" not found in ${provider}`);
		this.name = "LibraryNotFoundError";
	}
}

/** Error thrown when API authentication fails */
export class AuthenticationError extends Error {
	constructor(
		public provider: DocProviderType,
		message?: string,
	) {
		super(message || `Authentication failed for ${provider}`);
		this.name = "AuthenticationError";
	}
}

/** Error thrown when rate limited */
export class RateLimitError extends Error {
	constructor(
		public provider: DocProviderType,
		public retryAfterMs?: number,
	) {
		super(`Rate limited by ${provider}`);
		this.name = "RateLimitError";
	}
}

// ============================================================================
// Base Provider Class
// ============================================================================

/**
 * Abstract base class for documentation providers.
 * Implements common functionality like caching and error handling.
 */
export abstract class BaseDocProvider implements DocProvider {
	abstract name: DocProviderType;
	abstract priority: number;

	/** Optional cache for this provider */
	protected cache: Map<string, { docs: FetchedDoc[]; fetchedAt: number }> =
		new Map();

	/** Cache TTL in milliseconds */
	protected cacheTTLMs: number;

	constructor(cacheTTLHours = 24) {
		this.cacheTTLMs = cacheTTLHours * 60 * 60 * 1000;
	}

	/**
	 * Check if this provider supports the given library.
	 * Subclasses should override for their specific logic.
	 */
	abstract supports(library: string): Promise<boolean>;

	/**
	 * Fetch documentation for a library.
	 * Subclasses must implement this method.
	 */
	abstract fetch(
		library: string,
		options?: FetchOptions,
	): Promise<FetchedDoc[]>;

	/**
	 * Generate a cache key for a library/version combo
	 */
	protected getCacheKey(library: string, version?: string): string {
		return version ? `${library}@${version}` : library;
	}

	/**
	 * Check if cached data is still valid
	 */
	protected getCached(
		library: string,
		version?: string,
	): FetchedDoc[] | undefined {
		const key = this.getCacheKey(library, version);
		const cached = this.cache.get(key);

		if (!cached) return undefined;

		const age = Date.now() - cached.fetchedAt;
		if (age > this.cacheTTLMs) {
			this.cache.delete(key);
			return undefined;
		}

		return cached.docs;
	}

	/**
	 * Store docs in cache
	 */
	protected setCache(
		library: string,
		version: string | undefined,
		docs: FetchedDoc[],
	): void {
		const key = this.getCacheKey(library, version);
		this.cache.set(key, { docs, fetchedAt: Date.now() });
	}

	/**
	 * Clear cache for a library or all cached data
	 */
	clearCache(library?: string): void {
		if (library) {
			// Clear all entries for this library (any version)
			for (const key of this.cache.keys()) {
				if (key === library || key.startsWith(`${library}@`)) {
					this.cache.delete(key);
				}
			}
		} else {
			this.cache.clear();
		}
	}
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Exponential backoff delay calculation
 */
export function calculateBackoff(
	attempt: number,
	baseMs = 1000,
	maxMs = 30000,
): number {
	const delay = Math.min(baseMs * 2 ** attempt, maxMs);
	// Add jitter (±25%)
	const jitter = delay * 0.25 * (Math.random() * 2 - 1);
	return Math.round(delay + jitter);
}

/**
 * Retry a function with exponential backoff
 */
export async function withRetry<T>(
	fn: () => Promise<T>,
	options: {
		maxAttempts?: number;
		baseDelayMs?: number;
		maxDelayMs?: number;
		shouldRetry?: (error: unknown) => boolean;
	} = {},
): Promise<T> {
	const {
		maxAttempts = 3,
		baseDelayMs = 1000,
		maxDelayMs = 30000,
		shouldRetry = () => true,
	} = options;

	let lastError: unknown;

	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		try {
			return await fn();
		} catch (error) {
			lastError = error;

			// Don't retry certain errors
			if (error instanceof AuthenticationError) throw error;
			if (error instanceof LibraryNotFoundError) throw error;
			if (!shouldRetry(error)) throw error;

			// Last attempt - don't delay, just throw
			if (attempt === maxAttempts - 1) break;

			// Wait before retrying
			const delay = calculateBackoff(attempt, baseDelayMs, maxDelayMs);
			await new Promise((resolve) => setTimeout(resolve, delay));
		}
	}

	throw lastError;
}
