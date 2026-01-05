/**
 * ShadowPredictor - Lightweight model predicting next tool selection.
 *
 * Uses n-gram language modeling on tool sequences to predict the most
 * likely next tool. This enables:
 * - Proactive resource preparation
 * - Deviation detection (warn when agent deviates from expected)
 * - Tool recommendation
 *
 * The "shadow" runs alongside the main agent, building expectations
 * without interfering with execution.
 */

import type { ToolEvent } from "../interaction/types.js";

// ============================================================================
// Types
// ============================================================================

export interface ShadowPredictorConfig {
	/** Maximum n-gram size */
	maxNgramSize: number;
	/** Minimum occurrences to include in model */
	minOccurrences: number;
	/** Smoothing factor for unseen n-grams */
	smoothingFactor: number;
	/** Context window size */
	contextWindowSize: number;
	/** Decay factor for older sequences */
	decayFactor: number;
}

export const DEFAULT_SHADOW_CONFIG: ShadowPredictorConfig = {
	maxNgramSize: 4,
	minOccurrences: 2,
	smoothingFactor: 0.1,
	contextWindowSize: 10,
	decayFactor: 0.95,
};

export interface ToolPrediction {
	/** Predicted tool name */
	tool: string;
	/** Probability (0-1) */
	probability: number;
	/** Confidence in prediction (0-1) */
	confidence: number;
	/** N-gram order used */
	ngramOrder: number;
	/** Context used for prediction */
	context: string[];
}

export interface PredictionResult {
	/** Top predictions ranked by probability */
	predictions: ToolPrediction[];
	/** Most likely next tool */
	topPrediction: ToolPrediction | null;
	/** Entropy of prediction distribution */
	entropy: number;
	/** Whether prediction is high-confidence */
	isHighConfidence: boolean;
}

export interface NGramModel {
	/** N-gram counts: context -> (next_tool -> count) */
	counts: Map<string, Map<string, number>>;
	/** Context total counts */
	totals: Map<string, number>;
	/** Tool vocabulary */
	vocabulary: Set<string>;
	/** Total sequences seen */
	totalSequences: number;
}

// ============================================================================
// ShadowPredictor Class
// ============================================================================

export class ShadowPredictor {
	private config: ShadowPredictorConfig;
	private models: Map<number, NGramModel>; // n -> model
	private recentTools: string[];
	private lastUpdated: number;

	constructor(config: Partial<ShadowPredictorConfig> = {}) {
		this.config = { ...DEFAULT_SHADOW_CONFIG, ...config };
		this.models = new Map();
		this.recentTools = [];
		this.lastUpdated = 0;

		// Initialize models for each n-gram size
		for (let n = 1; n <= this.config.maxNgramSize; n++) {
			this.models.set(n, this.createEmptyModel());
		}
	}

	/**
	 * Train model on historical tool events.
	 */
	train(events: ToolEvent[]): void {
		// Sort by timestamp
		const sortedEvents = [...events].sort((a, b) => a.timestamp - b.timestamp);

		// Group by session
		const sessions = new Map<string, ToolEvent[]>();
		for (const event of sortedEvents) {
			const existing = sessions.get(event.sessionId) || [];
			existing.push(event);
			sessions.set(event.sessionId, existing);
		}

		// Train on each session
		for (const [, sessionEvents] of sessions) {
			const tools = sessionEvents.map((e) => e.toolName);
			this.trainSequence(tools);
		}

		this.lastUpdated = Date.now();
	}

	/**
	 * Train on a single tool sequence.
	 */
	trainSequence(tools: string[]): void {
		if (tools.length < 2) return;

		// Update vocabulary
		for (let n = 1; n <= this.config.maxNgramSize; n++) {
			const model = this.models.get(n)!;
			for (const tool of tools) {
				model.vocabulary.add(tool);
			}
		}

		// Train each n-gram model
		for (let n = 1; n <= this.config.maxNgramSize; n++) {
			this.trainNgram(tools, n);
		}
	}

	/**
	 * Incrementally update model with new tool use.
	 */
	observe(tool: string): void {
		// Add to recent history
		this.recentTools.push(tool);

		// Trim to window size
		while (this.recentTools.length > this.config.contextWindowSize) {
			this.recentTools.shift();
		}

		// Update models with new observation
		if (this.recentTools.length >= 2) {
			for (let n = 1; n <= Math.min(this.config.maxNgramSize, this.recentTools.length); n++) {
				const context = this.recentTools.slice(-n - 1, -1);
				const nextTool = this.recentTools[this.recentTools.length - 1];
				this.updateNgram(context, nextTool, n);
			}
		}

		// Update vocabulary
		for (let n = 1; n <= this.config.maxNgramSize; n++) {
			this.models.get(n)!.vocabulary.add(tool);
		}
	}

	/**
	 * Predict the next tool given current context.
	 */
	predict(context?: string[]): PredictionResult {
		const effectiveContext = context ?? this.recentTools;

		if (effectiveContext.length === 0) {
			return this.emptyPrediction();
		}

		// Try from highest n-gram to lowest (backoff)
		const allPredictions: ToolPrediction[] = [];

		for (let n = Math.min(this.config.maxNgramSize, effectiveContext.length); n >= 1; n--) {
			const ngContext = effectiveContext.slice(-n);
			const predictions = this.predictWithNgram(ngContext, n);

			if (predictions.length > 0) {
				allPredictions.push(...predictions);
			}
		}

		// Merge predictions using weighted combination
		const merged = this.mergePredictions(allPredictions);

		// Sort by probability
		merged.sort((a, b) => b.probability - a.probability);

		// Calculate entropy
		const entropy = this.calculateEntropy(merged.map((p) => p.probability));

		// Determine if high confidence
		const isHighConfidence =
			merged.length > 0 &&
			merged[0].probability > 0.5 &&
			merged[0].confidence > 0.7;

		return {
			predictions: merged.slice(0, 5),
			topPrediction: merged[0] ?? null,
			entropy,
			isHighConfidence,
		};
	}

	/**
	 * Get probability of a specific tool being next.
	 */
	getProbability(tool: string, context?: string[]): number {
		const result = this.predict(context);
		const prediction = result.predictions.find((p) => p.tool === tool);
		return prediction?.probability ?? 0;
	}

	/**
	 * Get model statistics.
	 */
	getStatistics(): {
		vocabularySize: number;
		ngramCounts: Record<number, number>;
		totalSequences: number;
		lastUpdated: number;
	} {
		const ngramCounts: Record<number, number> = {};

		for (let n = 1; n <= this.config.maxNgramSize; n++) {
			const model = this.models.get(n)!;
			ngramCounts[n] = model.counts.size;
		}

		return {
			vocabularySize: this.models.get(1)!.vocabulary.size,
			ngramCounts,
			totalSequences: this.models.get(1)!.totalSequences,
			lastUpdated: this.lastUpdated,
		};
	}

	/**
	 * Reset recent context.
	 */
	resetContext(): void {
		this.recentTools = [];
	}

	/**
	 * Export model for persistence.
	 */
	export(): {
		models: Array<{
			n: number;
			counts: Array<[string, Array<[string, number]>]>;
			totals: Array<[string, number]>;
			vocabulary: string[];
			totalSequences: number;
		}>;
		recentTools: string[];
	} {
		const models: Array<{
			n: number;
			counts: Array<[string, Array<[string, number]>]>;
			totals: Array<[string, number]>;
			vocabulary: string[];
			totalSequences: number;
		}> = [];

		for (let n = 1; n <= this.config.maxNgramSize; n++) {
			const model = this.models.get(n)!;
			models.push({
				n,
				counts: Array.from(model.counts.entries()).map(([k, v]) => [
					k,
					Array.from(v.entries()),
				]),
				totals: Array.from(model.totals.entries()),
				vocabulary: Array.from(model.vocabulary),
				totalSequences: model.totalSequences,
			});
		}

		return {
			models,
			recentTools: this.recentTools,
		};
	}

	/**
	 * Import model from persistence.
	 */
	import(data: {
		models: Array<{
			n: number;
			counts: Array<[string, Array<[string, number]>]>;
			totals: Array<[string, number]>;
			vocabulary: string[];
			totalSequences: number;
		}>;
		recentTools: string[];
	}): void {
		for (const modelData of data.models) {
			const model: NGramModel = {
				counts: new Map(
					modelData.counts.map(([k, v]) => [k, new Map(v)])
				),
				totals: new Map(modelData.totals),
				vocabulary: new Set(modelData.vocabulary),
				totalSequences: modelData.totalSequences,
			};
			this.models.set(modelData.n, model);
		}

		this.recentTools = data.recentTools;
		this.lastUpdated = Date.now();
	}

	// ========================================================================
	// Private Methods
	// ========================================================================

	/**
	 * Create empty n-gram model.
	 */
	private createEmptyModel(): NGramModel {
		return {
			counts: new Map(),
			totals: new Map(),
			vocabulary: new Set(),
			totalSequences: 0,
		};
	}

	/**
	 * Train n-gram model on sequence.
	 */
	private trainNgram(tools: string[], n: number): void {
		const model = this.models.get(n)!;
		model.totalSequences++;

		for (let i = n; i < tools.length; i++) {
			const context = tools.slice(i - n, i).join(" → ");
			const nextTool = tools[i];

			// Update counts
			if (!model.counts.has(context)) {
				model.counts.set(context, new Map());
			}
			const contextCounts = model.counts.get(context)!;
			contextCounts.set(nextTool, (contextCounts.get(nextTool) ?? 0) + 1);

			// Update totals
			model.totals.set(context, (model.totals.get(context) ?? 0) + 1);
		}
	}

	/**
	 * Update n-gram model with single observation.
	 */
	private updateNgram(context: string[], nextTool: string, n: number): void {
		if (context.length < n) return;

		const model = this.models.get(n)!;
		const contextKey = context.slice(-n).join(" → ");

		// Update counts
		if (!model.counts.has(contextKey)) {
			model.counts.set(contextKey, new Map());
		}
		const contextCounts = model.counts.get(contextKey)!;
		contextCounts.set(nextTool, (contextCounts.get(nextTool) ?? 0) + 1);

		// Update totals
		model.totals.set(contextKey, (model.totals.get(contextKey) ?? 0) + 1);
	}

	/**
	 * Predict using specific n-gram model.
	 */
	private predictWithNgram(context: string[], n: number): ToolPrediction[] {
		const model = this.models.get(n)!;
		const contextKey = context.join(" → ");

		const contextCounts = model.counts.get(contextKey);
		if (!contextCounts) {
			return [];
		}

		const total = model.totals.get(contextKey) ?? 0;
		if (total < this.config.minOccurrences) {
			return [];
		}

		const predictions: ToolPrediction[] = [];
		const vocabSize = model.vocabulary.size;

		for (const [tool, count] of contextCounts) {
			// Laplace smoothing
			const smoothedCount = count + this.config.smoothingFactor;
			const smoothedTotal = total + this.config.smoothingFactor * vocabSize;
			const probability = smoothedCount / smoothedTotal;

			// Confidence based on sample size
			const confidence = Math.min(1, total / 20);

			predictions.push({
				tool,
				probability,
				confidence,
				ngramOrder: n,
				context: [...context],
			});
		}

		return predictions;
	}

	/**
	 * Merge predictions from multiple n-gram orders.
	 */
	private mergePredictions(predictions: ToolPrediction[]): ToolPrediction[] {
		// Group by tool
		const byTool = new Map<string, ToolPrediction[]>();

		for (const pred of predictions) {
			const existing = byTool.get(pred.tool) || [];
			existing.push(pred);
			byTool.set(pred.tool, existing);
		}

		// Merge each tool's predictions
		const merged: ToolPrediction[] = [];

		for (const [tool, preds] of byTool) {
			// Weight higher n-gram orders more heavily
			let totalWeight = 0;
			let weightedProb = 0;
			let maxConfidence = 0;
			let bestOrder = 1;

			for (const pred of preds) {
				const weight = Math.pow(2, pred.ngramOrder); // 2^n weighting
				totalWeight += weight;
				weightedProb += pred.probability * weight;
				maxConfidence = Math.max(maxConfidence, pred.confidence);
				if (pred.confidence > (preds.find((p) => p.ngramOrder === bestOrder)?.confidence ?? 0)) {
					bestOrder = pred.ngramOrder;
				}
			}

			const probability = weightedProb / totalWeight;
			const bestPred = preds.find((p) => p.ngramOrder === bestOrder) ?? preds[0];

			merged.push({
				tool,
				probability,
				confidence: maxConfidence,
				ngramOrder: bestOrder,
				context: bestPred.context,
			});
		}

		return merged;
	}

	/**
	 * Calculate entropy of probability distribution.
	 */
	private calculateEntropy(probabilities: number[]): number {
		let entropy = 0;

		for (const p of probabilities) {
			if (p > 0) {
				entropy -= p * Math.log2(p);
			}
		}

		return entropy;
	}

	/**
	 * Return empty prediction result.
	 */
	private emptyPrediction(): PredictionResult {
		return {
			predictions: [],
			topPrediction: null,
			entropy: 0,
			isHighConfidence: false,
		};
	}
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a shadow predictor with optional configuration.
 */
export function createShadowPredictor(
	config: Partial<ShadowPredictorConfig> = {}
): ShadowPredictor {
	return new ShadowPredictor(config);
}
