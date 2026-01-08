/**
 * OpenRouter embedding model discovery
 *
 * Discovers available embedding models from OpenRouter API,
 * with caching and filtering for free/cheap options.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
	CACHE_MAX_AGE_DAYS,
	OPENROUTER_EMBEDDING_MODELS_URL,
	getModelsCachePath,
} from "../config.js";
import type { EmbeddingModel } from "../types.js";

// ============================================================================
// Types
// ============================================================================

interface OpenRouterModel {
	id: string;
	name: string;
	description?: string;
	pricing?: {
		prompt?: string;
		completion?: string;
	};
	context_length?: number;
	architecture?: {
		modality?: string;
		input_modalities?: string[];
		output_modalities?: string[];
	};
	top_provider?: {
		context_length?: number;
	};
}

interface ModelsCache {
	lastUpdated: string;
	models: EmbeddingModel[];
}

// ============================================================================
// Curated Model Picks
// ============================================================================

/**
 * Curated embedding model picks based on real benchmarks
 * Tested on code search tasks with NDCG/MRR metrics
 */
export const CURATED_PICKS = {
	/** Best Code Quality - Voyage Code 3 (177% NDCG in benchmarks) */
	bestQuality: {
		id: "voyage-code-3",
		name: "Voyage Code 3",
		provider: "Voyage",
		contextLength: 32000,
		dimension: 1024,
		pricePerMillion: 0.18,
		isFree: false,
		isRecommended: true,
	} as EmbeddingModel,

	/** Best Value - Voyage 3.5 Lite (165% NDCG at $0.02/M) */
	bestValue: {
		id: "voyage-3.5-lite",
		name: "Voyage 3.5 Lite",
		provider: "Voyage",
		contextLength: 32000,
		dimension: 1024,
		pricePerMillion: 0.02,
		isFree: false,
		isRecommended: true,
	} as EmbeddingModel,

	/** Best Balanced - Good quality via OpenRouter */
	bestBalanced: {
		id: "google/gemini-embedding-001",
		name: "Gemini Embedding",
		provider: "Google",
		contextLength: 2048,
		dimension: 3072,
		pricePerMillion: 0.0,
		isFree: true,
		isRecommended: true,
	} as EmbeddingModel,

	/** Fastest - Mistral Embed (1.84s in benchmarks) */
	fastest: {
		id: "mistralai/mistral-embed-2312",
		name: "Mistral Embed",
		provider: "Mistral",
		contextLength: 8192,
		dimension: 1024,
		pricePerMillion: 0.1,
		isFree: false,
		isRecommended: true,
	} as EmbeddingModel,

	/** Best Local - For Ollama users */
	bestLocal: {
		id: "ollama/nomic-embed-text",
		name: "Nomic Embed Text",
		provider: "Ollama",
		contextLength: 8192,
		dimension: 768,
		pricePerMillion: 0,
		isFree: true,
		isRecommended: true,
	} as EmbeddingModel,
};

/** Legacy export for compatibility */
export const TOP_RECOMMENDED_MODEL = CURATED_PICKS.bestQuality;

/**
 * All curated models as array
 */
export const RECOMMENDED_MODELS: EmbeddingModel[] = [
	CURATED_PICKS.bestQuality,
	CURATED_PICKS.bestValue,
	CURATED_PICKS.bestBalanced,
	CURATED_PICKS.fastest,
	CURATED_PICKS.bestLocal,
];

// ============================================================================
// Cache Management
// ============================================================================

/**
 * Check if the models cache is stale
 */
function isCacheStale(): boolean {
	const cachePath = getModelsCachePath();

	if (!existsSync(cachePath)) {
		return true;
	}

	try {
		const content = readFileSync(cachePath, "utf-8");
		const cache: ModelsCache = JSON.parse(content);

		if (!cache.lastUpdated) {
			return true;
		}

		const lastUpdated = new Date(cache.lastUpdated);
		const now = new Date();
		const ageInDays =
			(now.getTime() - lastUpdated.getTime()) / (1000 * 60 * 60 * 24);

		return ageInDays > CACHE_MAX_AGE_DAYS;
	} catch {
		return true;
	}
}

/**
 * Load models from cache
 */
function loadFromCache(): EmbeddingModel[] | null {
	const cachePath = getModelsCachePath();

	if (!existsSync(cachePath)) {
		return null;
	}

	try {
		const content = readFileSync(cachePath, "utf-8");
		const cache: ModelsCache = JSON.parse(content);
		return cache.models;
	} catch {
		return null;
	}
}

/**
 * Save models to cache
 */
function saveToCache(models: EmbeddingModel[]): void {
	const cachePath = getModelsCachePath();

	const cache: ModelsCache = {
		lastUpdated: new Date().toISOString(),
		models,
	};

	try {
		// Ensure directory exists
		const { mkdirSync } = require("node:fs");
		const { dirname } = require("node:path");
		mkdirSync(dirname(cachePath), { recursive: true });

		writeFileSync(cachePath, JSON.stringify(cache, null, 2), "utf-8");
	} catch (error) {
		console.warn("Failed to save models cache:", error);
	}
}

// ============================================================================
// API Functions
// ============================================================================

/**
 * Fetch embedding models from OpenRouter API
 * Uses the dedicated /embeddings/models endpoint
 */
async function fetchModelsFromAPI(): Promise<EmbeddingModel[]> {
	try {
		const response = await fetch(OPENROUTER_EMBEDDING_MODELS_URL);

		if (!response.ok) {
			throw new Error(`API returned ${response.status}`);
		}

		const data = (await response.json()) as { data: OpenRouterModel[] };
		const allModels = data.data || [];

		// Transform to our format (all models from this endpoint are embedding models)
		return allModels.map((model): EmbeddingModel => {
			const promptPrice = parseFloat(model.pricing?.prompt || "0");
			const pricePerMillion = promptPrice * 1000000;

			return {
				id: model.id,
				name: model.name,
				provider: model.id.split("/")[0],
				contextLength:
					model.context_length || model.top_provider?.context_length || 8192,
				pricePerMillion,
				isFree: pricePerMillion === 0,
			};
		});
	} catch (error) {
		console.error("Failed to fetch models from OpenRouter:", error);
		return [];
	}
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Discover available embedding models
 *
 * Returns models from cache if fresh, otherwise fetches from API
 */
export async function discoverEmbeddingModels(
	forceRefresh = false,
): Promise<EmbeddingModel[]> {
	// Check cache first
	if (!forceRefresh && !isCacheStale()) {
		const cached = loadFromCache();
		if (cached && cached.length > 0) {
			return cached;
		}
	}

	// Fetch from API
	console.error("🔄 Fetching embedding models from OpenRouter...");
	const apiModels = await fetchModelsFromAPI();

	if (apiModels.length > 0) {
		// Sort: free first, then by price
		apiModels.sort((a, b) => {
			if (a.isFree && !b.isFree) return -1;
			if (!a.isFree && b.isFree) return 1;
			return a.pricePerMillion - b.pricePerMillion;
		});

		// Cache the result
		saveToCache(apiModels);

		console.error(`✅ Found ${apiModels.length} embedding models`);
		return apiModels;
	}

	// Fall back to empty (no hardcoded fallback)
	console.warn("⚠️  No embedding models found from API");
	return [];
}

/**
 * Get free embedding models only
 */
export async function getFreeEmbeddingModels(): Promise<EmbeddingModel[]> {
	const all = await discoverEmbeddingModels();
	return all.filter((m) => m.isFree);
}

/**
 * Get a specific model by ID
 */
export async function getModelById(
	modelId: string,
): Promise<EmbeddingModel | null> {
	const all = await discoverEmbeddingModels();
	return all.find((m) => m.id === modelId) || null;
}

/**
 * Search models by name or ID
 */
export async function searchModels(query: string): Promise<EmbeddingModel[]> {
	const all = await discoverEmbeddingModels();
	const lowerQuery = query.toLowerCase();

	return all.filter(
		(m) =>
			m.id.toLowerCase().includes(lowerQuery) ||
			m.name.toLowerCase().includes(lowerQuery) ||
			m.provider.toLowerCase().includes(lowerQuery),
	);
}

/**
 * Get the best free model for code embeddings
 */
export function getBestFreeModel(): EmbeddingModel | null {
	// Check if any recommended models are free
	const freeRecommended = RECOMMENDED_MODELS.filter((m) => m.isFree);
	if (freeRecommended.length > 0) {
		return freeRecommended[0];
	}

	// Otherwise return the cheapest recommended model
	const sorted = [...RECOMMENDED_MODELS].sort(
		(a, b) => a.pricePerMillion - b.pricePerMillion,
	);
	return sorted[0] || null;
}

/**
 * Format model info for display
 */
export function formatModelInfo(model: EmbeddingModel): string {
	const price = model.isFree
		? "FREE"
		: `$${model.pricePerMillion.toFixed(3)}/1M`;

	const context = model.contextLength
		? `${Math.round(model.contextLength / 1000)}K`
		: "N/A";

	return `${model.name} (${model.provider}) - ${price} - ${context} tokens`;
}
