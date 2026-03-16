/**
 * Model Pricing
 *
 * Fetches model pricing from OpenRouter's public API to fill in
 * cost data for models that didn't report usage costs (e.g. free
 * tier models or models with $0 reported cost).
 */

interface OpenRouterModel {
	id: string;
	pricing?: {
		prompt?: string; // cost per token as string
		completion?: string;
	};
}

interface ModelPricing {
	promptPerToken: number;
	completionPerToken: number;
}

let cachedPricing: Map<string, ModelPricing> | null = null;

/**
 * Fetch model pricing from OpenRouter's public /api/v1/models endpoint.
 * Results are cached for the process lifetime.
 */
export async function fetchOpenRouterPricing(): Promise<
	Map<string, ModelPricing>
> {
	if (cachedPricing) return cachedPricing;

	cachedPricing = new Map();

	try {
		const response = await fetch("https://openrouter.ai/api/v1/models", {
			signal: AbortSignal.timeout(10000),
		});

		if (!response.ok) return cachedPricing;

		const data = (await response.json()) as { data?: OpenRouterModel[] };
		if (!data.data) return cachedPricing;

		for (const model of data.data) {
			const prompt = parseFloat(model.pricing?.prompt || "0");
			const completion = parseFloat(model.pricing?.completion || "0");
			if (prompt > 0 || completion > 0) {
				cachedPricing.set(model.id, {
					promptPerToken: prompt,
					completionPerToken: completion,
				});
			}
		}
	} catch {
		// Network errors are non-fatal — pricing is optional
	}

	return cachedPricing;
}

/**
 * Estimate cost for a model based on token counts and OpenRouter pricing.
 * Returns 0 if pricing is unavailable.
 */
export function estimateCost(
	pricing: Map<string, ModelPricing>,
	modelId: string,
	inputTokens: number,
	outputTokens: number,
): number {
	// Try exact match first, then try with openrouter/ prefix stripped
	const p =
		pricing.get(modelId) || pricing.get(modelId.replace(/^openrouter\//, ""));
	if (!p) return 0;
	return p.promptPerToken * inputTokens + p.completionPerToken * outputTokens;
}
