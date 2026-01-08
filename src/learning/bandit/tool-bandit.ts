/**
 * ToolBandit - Multi-armed bandit for adaptive tool selection.
 *
 * Uses Thompson Sampling to balance exploration vs exploitation:
 * - Explore: Try less-used tools to learn their effectiveness
 * - Exploit: Use tools known to be effective
 *
 * Key benefits:
 * - Adapts to context (different tools work better in different situations)
 * - Handles non-stationary environments (tool effectiveness changes)
 * - Provides uncertainty estimates
 */

// ============================================================================
// Types
// ============================================================================

export interface ToolBanditConfig {
	/** Initial alpha parameter (prior successes) */
	priorAlpha: number;
	/** Initial beta parameter (prior failures) */
	priorBeta: number;
	/** Discount factor for older observations */
	discountFactor: number;
	/** Minimum samples before confident recommendation */
	minSamples: number;
	/** Context weight decay */
	contextDecay: number;
}

export const DEFAULT_BANDIT_CONFIG: ToolBanditConfig = {
	priorAlpha: 1,
	priorBeta: 1,
	discountFactor: 0.99,
	minSamples: 5,
	contextDecay: 0.9,
};

export interface ToolArm {
	/** Tool name */
	tool: string;
	/** Alpha parameter (successes + prior) */
	alpha: number;
	/** Beta parameter (failures + prior) */
	beta: number;
	/** Total pulls */
	totalPulls: number;
	/** Recent success rate */
	recentSuccessRate: number;
	/** Last updated timestamp */
	lastUpdated: number;
}

export interface ContextualArm extends ToolArm {
	/** Context key */
	contextKey: string;
	/** Context features */
	contextFeatures: string[];
}

export interface BanditRecommendation {
	/** Recommended tool */
	tool: string;
	/** Sampled probability (from Thompson Sampling) */
	sampledProbability: number;
	/** Expected success rate (mean of Beta distribution) */
	expectedSuccessRate: number;
	/** Uncertainty (std dev of Beta distribution) */
	uncertainty: number;
	/** Whether this is exploration (high uncertainty) */
	isExploration: boolean;
	/** All tool scores */
	allScores: Array<{ tool: string; score: number; uncertainty: number }>;
}

export interface BanditStatistics {
	/** Total tools tracked */
	totalTools: number;
	/** Total pulls across all tools */
	totalPulls: number;
	/** Average success rate */
	avgSuccessRate: number;
	/** Best performing tool */
	bestTool: { tool: string; successRate: number } | null;
	/** Most explored tool */
	mostExplored: { tool: string; pulls: number } | null;
	/** Exploration ratio (pulls on uncertain tools) */
	explorationRatio: number;
}

// ============================================================================
// ToolBandit Class
// ============================================================================

export class ToolBandit {
	private config: ToolBanditConfig;
	private arms: Map<string, ToolArm>;
	private contextualArms: Map<string, ContextualArm>;
	private explorationPulls: number;
	private totalPulls: number;

	constructor(config: Partial<ToolBanditConfig> = {}) {
		this.config = { ...DEFAULT_BANDIT_CONFIG, ...config };
		this.arms = new Map();
		this.contextualArms = new Map();
		this.explorationPulls = 0;
		this.totalPulls = 0;
	}

	/**
	 * Get a recommendation using Thompson Sampling.
	 */
	recommend(
		availableTools: string[],
		context?: string[],
	): BanditRecommendation {
		if (availableTools.length === 0) {
			throw new Error("No tools available for recommendation");
		}

		// Sample from each tool's distribution
		const samples: Array<{ tool: string; score: number; arm: ToolArm }> = [];

		for (const tool of availableTools) {
			const arm = this.getOrCreateArm(tool, context);
			const score = this.sampleBeta(arm.alpha, arm.beta);
			samples.push({ tool, score, arm });
		}

		// Sort by sampled score
		samples.sort((a, b) => b.score - a.score);

		const best = samples[0];
		const bestArm = best.arm;

		// Calculate expected success rate (mean of Beta)
		const expectedSuccessRate = bestArm.alpha / (bestArm.alpha + bestArm.beta);

		// Calculate uncertainty (std dev of Beta)
		const variance =
			(bestArm.alpha * bestArm.beta) /
			((bestArm.alpha + bestArm.beta) ** 2 *
				(bestArm.alpha + bestArm.beta + 1));
		const uncertainty = Math.sqrt(variance);

		// Determine if this is exploration
		const isExploration =
			bestArm.totalPulls < this.config.minSamples || uncertainty > 0.15;

		return {
			tool: best.tool,
			sampledProbability: best.score,
			expectedSuccessRate,
			uncertainty,
			isExploration,
			allScores: samples.map((s) => ({
				tool: s.tool,
				score: s.score,
				uncertainty: Math.sqrt(
					(s.arm.alpha * s.arm.beta) /
						((s.arm.alpha + s.arm.beta) ** 2 * (s.arm.alpha + s.arm.beta + 1)),
				),
			})),
		};
	}

	/**
	 * Update arm with outcome.
	 */
	update(tool: string, success: boolean, context?: string[]): void {
		const arm = this.getOrCreateArm(tool, context);

		// Apply discount to existing observations
		arm.alpha = 1 + (arm.alpha - 1) * this.config.discountFactor;
		arm.beta = 1 + (arm.beta - 1) * this.config.discountFactor;

		// Update with new observation
		if (success) {
			arm.alpha += 1;
		} else {
			arm.beta += 1;
		}

		arm.totalPulls += 1;
		arm.lastUpdated = Date.now();

		// Update recent success rate (exponential moving average)
		const successValue = success ? 1 : 0;
		arm.recentSuccessRate = 0.9 * arm.recentSuccessRate + 0.1 * successValue;

		// Track totals
		this.totalPulls++;
		if (arm.totalPulls <= this.config.minSamples) {
			this.explorationPulls++;
		}

		// Also update contextual arm if context provided
		if (context && context.length > 0) {
			const contextKey = this.createContextKey(context);
			const contextualArm = this.getOrCreateContextualArm(tool, context);

			contextualArm.alpha =
				1 + (contextualArm.alpha - 1) * this.config.discountFactor;
			contextualArm.beta =
				1 + (contextualArm.beta - 1) * this.config.discountFactor;

			if (success) {
				contextualArm.alpha += 1;
			} else {
				contextualArm.beta += 1;
			}

			contextualArm.totalPulls += 1;
			contextualArm.lastUpdated = Date.now();
			contextualArm.recentSuccessRate =
				0.9 * contextualArm.recentSuccessRate + 0.1 * successValue;
		}
	}

	/**
	 * Get expected success rate for a tool.
	 */
	getExpectedSuccessRate(tool: string, context?: string[]): number {
		const arm = this.arms.get(tool);
		if (!arm) {
			return 0.5; // Unknown tool, use prior
		}

		// Try contextual arm first if context provided
		if (context && context.length > 0) {
			const contextKey = `${tool}::${this.createContextKey(context)}`;
			const contextualArm = this.contextualArms.get(contextKey);
			if (contextualArm && contextualArm.totalPulls >= this.config.minSamples) {
				return contextualArm.alpha / (contextualArm.alpha + contextualArm.beta);
			}
		}

		return arm.alpha / (arm.alpha + arm.beta);
	}

	/**
	 * Get statistics.
	 */
	getStatistics(): BanditStatistics {
		const tools = Array.from(this.arms.values());

		if (tools.length === 0) {
			return {
				totalTools: 0,
				totalPulls: this.totalPulls,
				avgSuccessRate: 0,
				bestTool: null,
				mostExplored: null,
				explorationRatio: 0,
			};
		}

		// Calculate average success rate
		const avgSuccessRate =
			tools.reduce((sum, a) => sum + a.alpha / (a.alpha + a.beta), 0) /
			tools.length;

		// Find best tool
		const sortedByRate = [...tools].sort(
			(a, b) => b.alpha / (b.alpha + b.beta) - a.alpha / (a.alpha + a.beta),
		);
		const bestTool = sortedByRate[0]
			? {
					tool: sortedByRate[0].tool,
					successRate:
						sortedByRate[0].alpha /
						(sortedByRate[0].alpha + sortedByRate[0].beta),
				}
			: null;

		// Find most explored
		const sortedByPulls = [...tools].sort(
			(a, b) => b.totalPulls - a.totalPulls,
		);
		const mostExplored = sortedByPulls[0]
			? { tool: sortedByPulls[0].tool, pulls: sortedByPulls[0].totalPulls }
			: null;

		// Exploration ratio
		const explorationRatio =
			this.totalPulls > 0 ? this.explorationPulls / this.totalPulls : 0;

		return {
			totalTools: tools.length,
			totalPulls: this.totalPulls,
			avgSuccessRate,
			bestTool,
			mostExplored,
			explorationRatio,
		};
	}

	/**
	 * Get all arms data.
	 */
	getAllArms(): ToolArm[] {
		return Array.from(this.arms.values());
	}

	/**
	 * Get arm for specific tool.
	 */
	getArm(tool: string): ToolArm | undefined {
		return this.arms.get(tool);
	}

	/**
	 * Reset all arms to prior.
	 */
	reset(): void {
		this.arms.clear();
		this.contextualArms.clear();
		this.explorationPulls = 0;
		this.totalPulls = 0;
	}

	/**
	 * Export state for persistence.
	 */
	export(): {
		arms: Array<ToolArm>;
		contextualArms: Array<ContextualArm>;
		explorationPulls: number;
		totalPulls: number;
	} {
		return {
			arms: Array.from(this.arms.values()),
			contextualArms: Array.from(this.contextualArms.values()),
			explorationPulls: this.explorationPulls,
			totalPulls: this.totalPulls,
		};
	}

	/**
	 * Import state from persistence.
	 */
	import(data: {
		arms: Array<ToolArm>;
		contextualArms: Array<ContextualArm>;
		explorationPulls: number;
		totalPulls: number;
	}): void {
		this.arms = new Map(data.arms.map((a) => [a.tool, a]));
		this.contextualArms = new Map(
			data.contextualArms.map((a) => [`${a.tool}::${a.contextKey}`, a]),
		);
		this.explorationPulls = data.explorationPulls;
		this.totalPulls = data.totalPulls;
	}

	// ========================================================================
	// Private Methods
	// ========================================================================

	/**
	 * Get or create arm for tool.
	 */
	private getOrCreateArm(tool: string, context?: string[]): ToolArm {
		// Try contextual arm first if context provided
		if (context && context.length > 0) {
			const contextKey = `${tool}::${this.createContextKey(context)}`;
			const contextualArm = this.contextualArms.get(contextKey);
			if (contextualArm && contextualArm.totalPulls >= this.config.minSamples) {
				// Return contextual arm with weighted combination
				const globalArm = this.arms.get(tool);
				if (globalArm) {
					return this.combineArms(contextualArm, globalArm);
				}
				return contextualArm;
			}
		}

		// Fall back to global arm
		let arm = this.arms.get(tool);
		if (!arm) {
			arm = {
				tool,
				alpha: this.config.priorAlpha,
				beta: this.config.priorBeta,
				totalPulls: 0,
				recentSuccessRate: 0.5,
				lastUpdated: Date.now(),
			};
			this.arms.set(tool, arm);
		}
		return arm;
	}

	/**
	 * Get or create contextual arm.
	 */
	private getOrCreateContextualArm(
		tool: string,
		context: string[],
	): ContextualArm {
		const contextKey = this.createContextKey(context);
		const key = `${tool}::${contextKey}`;

		let arm = this.contextualArms.get(key);
		if (!arm) {
			arm = {
				tool,
				contextKey,
				contextFeatures: context,
				alpha: this.config.priorAlpha,
				beta: this.config.priorBeta,
				totalPulls: 0,
				recentSuccessRate: 0.5,
				lastUpdated: Date.now(),
			};
			this.contextualArms.set(key, arm);
		}
		return arm;
	}

	/**
	 * Create context key from features.
	 */
	private createContextKey(context: string[]): string {
		return context.sort().join("|");
	}

	/**
	 * Combine contextual and global arms.
	 */
	private combineArms(contextual: ToolArm, global: ToolArm): ToolArm {
		// Weight contextual more heavily as it gets more samples
		const contextWeight = Math.min(0.8, contextual.totalPulls / 20);
		const globalWeight = 1 - contextWeight;

		return {
			tool: contextual.tool,
			alpha: contextWeight * contextual.alpha + globalWeight * global.alpha,
			beta: contextWeight * contextual.beta + globalWeight * global.beta,
			totalPulls: contextual.totalPulls,
			recentSuccessRate:
				contextWeight * contextual.recentSuccessRate +
				globalWeight * global.recentSuccessRate,
			lastUpdated: Math.max(contextual.lastUpdated, global.lastUpdated),
		};
	}

	/**
	 * Sample from Beta distribution using inverse transform.
	 */
	private sampleBeta(alpha: number, beta: number): number {
		// Use Gamma distribution method
		const gammaA = this.sampleGamma(alpha);
		const gammaB = this.sampleGamma(beta);
		return gammaA / (gammaA + gammaB);
	}

	/**
	 * Sample from Gamma distribution.
	 */
	private sampleGamma(shape: number): number {
		if (shape < 1) {
			// Use transformation for shape < 1
			const u = Math.random();
			return this.sampleGamma(1 + shape) * Math.pow(u, 1 / shape);
		}

		// Marsaglia and Tsang's method
		const d = shape - 1 / 3;
		const c = 1 / Math.sqrt(9 * d);

		while (true) {
			let x: number;
			let v: number;

			do {
				x = this.sampleNormal();
				v = 1 + c * x;
			} while (v <= 0);

			v = v * v * v;
			const u = Math.random();

			if (u < 1 - 0.0331 * (x * x) * (x * x)) {
				return d * v;
			}

			if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) {
				return d * v;
			}
		}
	}

	/**
	 * Sample from standard normal distribution (Box-Muller).
	 */
	private sampleNormal(): number {
		const u1 = Math.random();
		const u2 = Math.random();
		return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
	}
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a tool bandit with optional configuration.
 */
export function createToolBandit(
	config: Partial<ToolBanditConfig> = {},
): ToolBandit {
	return new ToolBandit(config);
}
