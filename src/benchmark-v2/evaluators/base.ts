/**
 * Base Evaluator
 *
 * Common interface and utilities for all evaluation types.
 */

import type { ILLMClient } from "../../types.js";
import type {
	BenchmarkCodeUnit,
	GeneratedSummary,
	EvaluationType,
	EvaluatorContext,
	IEvaluator,
} from "../types.js";

// ============================================================================
// Base Evaluator Interface
// ============================================================================

export abstract class BaseEvaluator<TResult> implements IEvaluator<TResult> {
	protected llmClient?: ILLMClient;

	constructor(llmClient?: ILLMClient) {
		this.llmClient = llmClient;
	}

	abstract evaluate(
		summary: GeneratedSummary,
		codeUnit: BenchmarkCodeUnit,
		context: EvaluatorContext,
	): Promise<TResult>;

	abstract getType(): EvaluationType;

	/**
	 * Helper to parse JSON from LLM response
	 * Handles various LLM response formats including markdown code blocks
	 */
	protected parseJSONResponse<T>(response: string): T {
		let jsonStr = response.trim();

		// Strategy 1: Try to extract JSON from markdown code blocks (greedy - last closing ```)
		const jsonMatch = response.match(
			/```(?:json)?\s*([\s\S]*?)```(?![\s\S]*```)/,
		);
		if (jsonMatch) {
			jsonStr = jsonMatch[1].trim();
		} else {
			// Strategy 2: Strip opening ```json if present (handles missing closing ```)
			const openMatch = jsonStr.match(/^```(?:json)?\s*([\s\S]*)/);
			if (openMatch) {
				jsonStr = openMatch[1].trim();
				// Also try to strip trailing ``` if present
				jsonStr = jsonStr.replace(/```\s*$/, "").trim();
			}
		}

		// Strategy 3: Find first { and last } to extract JSON object
		if (!jsonStr.startsWith("{") && !jsonStr.startsWith("[")) {
			const firstBrace = jsonStr.indexOf("{");
			const lastBrace = jsonStr.lastIndexOf("}");
			if (firstBrace !== -1 && lastBrace > firstBrace) {
				jsonStr = jsonStr.slice(firstBrace, lastBrace + 1);
			}
		}

		try {
			return JSON.parse(jsonStr);
		} catch (error) {
			// Try to repair truncated JSON
			const repaired = this.repairTruncatedJSON(jsonStr);
			if (repaired) {
				try {
					return JSON.parse(repaired);
				} catch {
					// Fall through to original error
				}
			}

			// Provide more helpful error message
			const preview =
				jsonStr.slice(0, 200) + (jsonStr.length > 200 ? "..." : "");
			const suffix = jsonStr.slice(-50);
			throw new Error(
				`JSON Parse error: ${error instanceof Error ? error.message : error}. ` +
					`Response preview: "${preview}" ... ends with: "${suffix}"`,
			);
		}
	}

	/**
	 * Attempt to repair truncated JSON by closing open brackets/braces
	 */
	private repairTruncatedJSON(json: string): string | null {
		// Count open brackets and braces
		let braces = 0;
		let brackets = 0;
		let inString = false;
		let escape = false;

		for (const char of json) {
			if (escape) {
				escape = false;
				continue;
			}
			if (char === "\\") {
				escape = true;
				continue;
			}
			if (char === '"') {
				inString = !inString;
				continue;
			}
			if (!inString) {
				if (char === "{") braces++;
				else if (char === "}") braces--;
				else if (char === "[") brackets++;
				else if (char === "]") brackets--;
			}
		}

		// If we have unclosed structures, try to close them
		if (braces > 0 || brackets > 0) {
			let repaired = json;
			// Close any unclosed string
			if (inString) repaired += '"';
			// Close brackets and braces
			repaired += "]".repeat(brackets) + "}".repeat(braces);
			return repaired;
		}

		return null;
	}

	/**
	 * Helper to truncate code for prompts
	 */
	protected truncateCode(code: string, maxLength: number = 2000): string {
		if (code.length > maxLength) {
			return code.slice(0, maxLength) + "\n// ... (truncated)";
		}
		return code;
	}
}

// ============================================================================
// Model Family Detection (for judge selection)
// ============================================================================

const MODEL_FAMILIES: Record<string, string[]> = {
	anthropic: [
		"claude-3-opus",
		"claude-3-sonnet",
		"claude-3-haiku",
		"claude-3.5-sonnet",
		"claude-3-5-sonnet",
		"claude-sonnet",
		"claude-haiku",
		"claude-opus",
	],
	openai: [
		"gpt-4",
		"gpt-4-turbo",
		"gpt-4o",
		"gpt-4o-mini",
		"gpt-3.5",
		"o1-preview",
		"o1-mini",
	],
	google: ["gemini-pro", "gemini-1.5-pro", "gemini-1.5-flash", "gemini-ultra"],
	meta: ["llama-3", "llama-3.1", "llama-3.2", "llama-3-8b", "llama-3-70b"],
	mistral: ["mistral-large", "mistral-medium", "mistral-small", "mixtral"],
};

/**
 * Check if two models are from the same family
 * (used to prevent self-judging)
 */
export function isSameModelFamily(model1: string, model2: string): boolean {
	const m1Lower = model1.toLowerCase();
	const m2Lower = model2.toLowerCase();

	for (const family of Object.values(MODEL_FAMILIES)) {
		const m1InFamily = family.some((f) => m1Lower.includes(f));
		const m2InFamily = family.some((f) => m2Lower.includes(f));
		if (m1InFamily && m2InFamily) {
			return true;
		}
	}

	return false;
}

/**
 * Get model family name
 */
export function getModelFamily(modelId: string): string | null {
	const lower = modelId.toLowerCase();

	for (const [family, patterns] of Object.entries(MODEL_FAMILIES)) {
		if (patterns.some((p) => lower.includes(p))) {
			return family;
		}
	}

	return null;
}

/**
 * Select judges for a model, excluding same-family models
 */
export function selectJudges(
	generatorModel: string,
	availableJudges: string[],
	minJudges: number = 2,
): string[] {
	// Filter out same-family models
	const eligible = availableJudges.filter(
		(j) => !isSameModelFamily(j, generatorModel),
	);

	if (eligible.length < minJudges) {
		throw new Error(
			`Insufficient judge models: need ${minJudges}, have ${eligible.length} (after excluding same family)`,
		);
	}

	// Prefer diverse model families
	const families = new Map<string, string[]>();
	for (const judge of eligible) {
		const family = getModelFamily(judge) || "unknown";
		if (!families.has(family)) {
			families.set(family, []);
		}
		families.get(family)!.push(judge);
	}

	// Take one from each family first, then fill
	const selected: string[] = [];
	for (const judges of families.values()) {
		if (judges.length > 0 && selected.length < eligible.length) {
			selected.push(judges[0]);
		}
	}

	// Fill remaining slots if needed
	const remaining = eligible.filter((j) => !selected.includes(j));
	while (selected.length < Math.min(3, eligible.length)) {
		if (remaining.length > 0) {
			selected.push(remaining.shift()!);
		} else {
			break;
		}
	}

	return selected;
}
