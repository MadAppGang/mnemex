/**
 * MockEmbeddingsClient — implements IEmbeddingsClient with deterministic vectors.
 *
 * Returns deterministic 8-dimensional unit vectors seeded from text content.
 * The same text always produces the same vector — important for the dirty-file
 * test where the overlay vector must be semantically similar to the cloud counterpart.
 *
 * Dimension matches the test server's embeddingDim: 8 from setup.ts.
 */

import type {
	IEmbeddingsClient,
	EmbedResult,
	EmbeddingProvider,
} from "../../../../src/types.js";

// ============================================================================
// MockEmbeddingsClient
// ============================================================================

export class MockEmbeddingsClient implements IEmbeddingsClient {
	private readonly _dimension: number;

	constructor(dimension = 8) {
		this._dimension = dimension;
	}

	/**
	 * Generate a deterministic unit vector from text content.
	 * Uses a simple hash of the text to pick a seed value.
	 */
	private textToVector(text: string): number[] {
		// Simple deterministic hash of the text string
		let hash = 0;
		for (let i = 0; i < text.length; i++) {
			hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
		}
		return syntheticVector(hash % 1000, this._dimension);
	}

	async embedOne(text: string): Promise<number[]> {
		return this.textToVector(text);
	}

	async embed(
		texts: string[],
	): Promise<EmbedResult> {
		const embeddings = texts.map((t) => this.textToVector(t));
		return { embeddings };
	}

	getModel(): string {
		return "mock-embedding-model";
	}

	getDimension(): number | undefined {
		return this._dimension;
	}

	getProvider(): EmbeddingProvider {
		return "local";
	}

	isLocal(): boolean {
		return true;
	}
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Generate a deterministic unit vector of the given dimension using sin-based seeding.
 * Exported so it can be used in multi-user-factory.ts with a consistent algorithm.
 */
export function syntheticVector(seed: number, dimension = 8): number[] {
	const v = Array.from(
		{ length: dimension },
		(_, i) => Math.sin(seed * 1.7 + i * 0.5),
	);
	const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
	return v.map((x) => x / norm);
}
