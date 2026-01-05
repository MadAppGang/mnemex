/**
 * PromptOptimizer - Refines prompts based on correction patterns.
 *
 * When users frequently correct agent behavior in specific ways,
 * this module generates prompt revisions that encode the corrections
 * to prevent future mistakes.
 *
 * Optimizations include:
 * - Adding missing context or constraints
 * - Clarifying ambiguous instructions
 * - Adding examples of correct behavior
 * - Encoding learned preferences
 */

import type {
	DetectedPattern,
	CorrectionEvent,
	Improvement,
	ImprovementData,
} from "../interaction/types.js";

// ============================================================================
// Types
// ============================================================================

export interface PromptOptimizerConfig {
	/** Minimum corrections to suggest optimization */
	minCorrections: number;
	/** Minimum correction score average */
	minAvgCorrectionScore: number;
	/** Maximum prompt addition length */
	maxAdditionLength: number;
	/** Maximum examples to include */
	maxExamples: number;
}

export const DEFAULT_OPTIMIZER_CONFIG: PromptOptimizerConfig = {
	minCorrections: 3,
	minAvgCorrectionScore: 0.6,
	maxAdditionLength: 500,
	maxExamples: 3,
};

export interface PromptOptimization {
	/** Unique identifier */
	optimizationId: string;
	/** Type of optimization */
	optimizationType:
		| "constraint"
		| "example"
		| "clarification"
		| "preference"
		| "warning";
	/** Original prompt segment (if applicable) */
	originalSegment?: string;
	/** Proposed addition or revision */
	proposedText: string;
	/** Where to insert in prompt */
	insertionPoint: "prepend" | "append" | "replace" | "section";
	/** Section name if insertionPoint is 'section' */
	sectionName?: string;
	/** Evidence from corrections */
	evidence: CorrectionEvidence[];
	/** Confidence score (0-1) */
	confidence: number;
	/** Estimated impact (0-1) */
	estimatedImpact: number;
}

export interface CorrectionEvidence {
	/** Session where correction occurred */
	sessionId: string;
	/** What user corrected */
	correctionType: string;
	/** Score of the correction */
	correctionScore: number;
	/** What agent did wrong */
	agentAction?: string;
	/** What user wanted instead */
	userPreference?: string;
}

export interface PromptOptimizationResult {
	optimizations: PromptOptimization[];
	skippedPatterns: Array<{
		pattern: DetectedPattern;
		reason: string;
	}>;
}

// ============================================================================
// PromptOptimizer Class
// ============================================================================

export class PromptOptimizer {
	private config: PromptOptimizerConfig;
	private optimizationCounter = 0;

	constructor(config: Partial<PromptOptimizerConfig> = {}) {
		this.config = { ...DEFAULT_OPTIMIZER_CONFIG, ...config };
	}

	/**
	 * Generate prompt optimizations from correction patterns.
	 */
	optimizeFromPatterns(patterns: DetectedPattern[]): PromptOptimizationResult {
		const optimizations: PromptOptimization[] = [];
		const skippedPatterns: Array<{ pattern: DetectedPattern; reason: string }> =
			[];

		for (const pattern of patterns) {
			// Only process error and misuse patterns
			if (pattern.patternType !== "error" && pattern.patternType !== "misuse") {
				skippedPatterns.push({
					pattern,
					reason: `Pattern type '${pattern.patternType}' not suitable for prompt optimization`,
				});
				continue;
			}

			// Check occurrences
			if (pattern.occurrenceCount < this.config.minCorrections) {
				skippedPatterns.push({
					pattern,
					reason: `Occurrences ${pattern.occurrenceCount} below threshold ${this.config.minCorrections}`,
				});
				continue;
			}

			// Generate optimization
			const optimization = this.generateOptimization(pattern);
			if (optimization) {
				optimizations.push(optimization);
			}
		}

		return { optimizations, skippedPatterns };
	}

	/**
	 * Generate prompt optimizations from correction events.
	 */
	optimizeFromCorrections(corrections: CorrectionEvent[]): PromptOptimization[] {
		// Group corrections by trigger pattern
		const grouped = this.groupCorrections(corrections);

		const optimizations: PromptOptimization[] = [];

		for (const [pattern, correctionGroup] of grouped) {
			// Check minimum corrections
			if (correctionGroup.length < this.config.minCorrections) {
				continue;
			}

			// Check average score
			const avgScore =
				correctionGroup.reduce((sum, c) => sum + c.correctionScore, 0) /
				correctionGroup.length;
			if (avgScore < this.config.minAvgCorrectionScore) {
				continue;
			}

			// Generate optimization
			const optimization = this.generateFromCorrectionGroup(
				pattern,
				correctionGroup
			);
			optimizations.push(optimization);
		}

		return optimizations;
	}

	/**
	 * Generate a constraint-type optimization.
	 */
	generateConstraint(
		constraintText: string,
		evidence: CorrectionEvidence[]
	): PromptOptimization {
		return {
			optimizationId: this.generateId(),
			optimizationType: "constraint",
			proposedText: `IMPORTANT: ${constraintText}`,
			insertionPoint: "prepend",
			evidence,
			confidence: this.calculateConfidence(evidence),
			estimatedImpact: this.estimateImpact(evidence),
		};
	}

	/**
	 * Generate an example-type optimization.
	 */
	generateExample(
		goodExample: string,
		badExample: string,
		evidence: CorrectionEvidence[]
	): PromptOptimization {
		const text = [
			"## Example",
			"",
			"✅ Correct approach:",
			goodExample,
			"",
			"❌ Avoid:",
			badExample,
		].join("\n");

		return {
			optimizationId: this.generateId(),
			optimizationType: "example",
			proposedText: text.substring(0, this.config.maxAdditionLength),
			insertionPoint: "section",
			sectionName: "Examples",
			evidence,
			confidence: this.calculateConfidence(evidence),
			estimatedImpact: this.estimateImpact(evidence),
		};
	}

	/**
	 * Generate a warning-type optimization.
	 */
	generateWarning(
		warningText: string,
		evidence: CorrectionEvidence[]
	): PromptOptimization {
		return {
			optimizationId: this.generateId(),
			optimizationType: "warning",
			proposedText: `⚠️ WARNING: ${warningText}`,
			insertionPoint: "prepend",
			evidence,
			confidence: this.calculateConfidence(evidence),
			estimatedImpact: this.estimateImpact(evidence),
		};
	}

	/**
	 * Convert optimization to Improvement proposal.
	 */
	toImprovement(
		optimization: PromptOptimization,
		patternId: string
	): Improvement {
		const now = Date.now();

		const improvementData: ImprovementData = {
			name: `prompt-${optimization.optimizationType}-${optimization.optimizationId.slice(-6)}`,
			description: `Prompt ${optimization.optimizationType}: ${this.truncate(optimization.proposedText, 100)}`,
			originalPrompt: optimization.originalSegment,
			revisedPrompt: optimization.proposedText,
			evidence: {
				patternId,
				occurrences: optimization.evidence.length,
				confidence: optimization.confidence,
			},
		};

		return {
			improvementId: `prompt_${now}_${Math.random().toString(36).substr(2, 9)}`,
			patternId,
			improvementType: "prompt",
			improvementData,
			status: "proposed",
			safetyScore: this.calculateSafetyScore(optimization),
			impactScore: optimization.estimatedImpact,
			createdAt: now,
		};
	}

	/**
	 * Apply optimization to existing prompt.
	 */
	applyOptimization(
		existingPrompt: string,
		optimization: PromptOptimization
	): string {
		switch (optimization.insertionPoint) {
			case "prepend":
				return `${optimization.proposedText}\n\n${existingPrompt}`;

			case "append":
				return `${existingPrompt}\n\n${optimization.proposedText}`;

			case "replace":
				if (optimization.originalSegment) {
					return existingPrompt.replace(
						optimization.originalSegment,
						optimization.proposedText
					);
				}
				return existingPrompt;

			case "section":
				return this.insertSection(
					existingPrompt,
					optimization.sectionName ?? "Additional Guidance",
					optimization.proposedText
				);

			default:
				return existingPrompt;
		}
	}

	// ========================================================================
	// Private Methods
	// ========================================================================

	/**
	 * Generate unique optimization ID.
	 */
	private generateId(): string {
		return `opt_${Date.now()}_${++this.optimizationCounter}`;
	}

	/**
	 * Generate optimization from pattern.
	 */
	private generateOptimization(
		pattern: DetectedPattern
	): PromptOptimization | null {
		const errorSignature = pattern.patternData.errorSignature;
		const tools = pattern.patternData.tools ?? [];
		const description = pattern.patternData.description;

		// Create evidence from pattern
		const evidence: CorrectionEvidence[] = (
			pattern.patternData.exampleSessions ?? []
		)
			.slice(0, this.config.maxExamples)
			.map((sessionId) => ({
				sessionId,
				correctionType: pattern.patternType,
				correctionScore: pattern.patternData.confidence ?? 0.8,
				agentAction: errorSignature,
			}));

		// Determine optimization type based on pattern
		if (errorSignature?.includes("permission")) {
			return this.generateWarning(
				`Check permissions before using ${tools.join(", ")}. Pattern observed ${pattern.occurrenceCount} times.`,
				evidence
			);
		}

		if (errorSignature?.includes("validation") || errorSignature?.includes("invalid")) {
			return this.generateConstraint(
				`Validate inputs before ${tools.join(", ")}. ${description}`,
				evidence
			);
		}

		if (errorSignature?.includes("not found") || errorSignature?.includes("missing")) {
			return this.generateConstraint(
				`Verify resources exist before ${tools.join(", ")}. ${description}`,
				evidence
			);
		}

		// Default: generate a general warning
		return this.generateWarning(
			`${description}. Observed ${pattern.occurrenceCount} times.`,
			evidence
		);
	}

	/**
	 * Group corrections by trigger pattern.
	 */
	private groupCorrections(
		corrections: CorrectionEvent[]
	): Map<string, CorrectionEvent[]> {
		const groups = new Map<string, CorrectionEvent[]>();

		for (const correction of corrections) {
			// Create pattern key from trigger and agent action
			const key = this.createCorrectionKey(correction);
			const existing = groups.get(key) || [];
			existing.push(correction);
			groups.set(key, existing);
		}

		return groups;
	}

	/**
	 * Create a key for grouping similar corrections.
	 */
	private createCorrectionKey(correction: CorrectionEvent): string {
		// Extract key elements from trigger and action
		const trigger = correction.triggerEvent ?? "unknown";
		const action = correction.agentAction ?? "unknown";

		// Normalize to create grouping key
		const normalizedTrigger = this.normalizeForGrouping(trigger);
		const normalizedAction = this.normalizeForGrouping(action);

		return `${normalizedTrigger}::${normalizedAction}`;
	}

	/**
	 * Normalize text for grouping (remove specifics, keep pattern).
	 */
	private normalizeForGrouping(text: string): string {
		return text
			.toLowerCase()
			.replace(/[0-9]+/g, "N") // Replace numbers
			.replace(/['"][^'"]+['"]/g, "STR") // Replace strings
			.replace(/\s+/g, " ") // Normalize whitespace
			.trim()
			.substring(0, 100);
	}

	/**
	 * Generate optimization from correction group.
	 */
	private generateFromCorrectionGroup(
		patternKey: string,
		corrections: CorrectionEvent[]
	): PromptOptimization {
		// Extract common elements
		const evidence: CorrectionEvidence[] = corrections
			.slice(0, this.config.maxExamples)
			.map((c) => ({
				sessionId: c.sessionId,
				correctionType: this.determineCorrectionType(c),
				correctionScore: c.correctionScore,
				agentAction: c.agentAction,
				userPreference: c.triggerEvent,
			}));

		// Determine dominant signal
		const dominantSignal = this.findDominantSignal(corrections);

		// Generate appropriate optimization
		switch (dominantSignal) {
			case "lexical":
				return this.generateConstraint(
					this.extractConstraintFromLexical(corrections),
					evidence
				);

			case "overwrite":
				return this.generateExample(
					this.extractGoodExample(corrections),
					this.extractBadExample(corrections),
					evidence
				);

			case "pivot":
				return this.generateWarning(
					this.extractPivotWarning(corrections),
					evidence
				);

			case "reask":
			default:
				return {
					optimizationId: this.generateId(),
					optimizationType: "clarification",
					proposedText: this.generateClarification(corrections),
					insertionPoint: "append",
					evidence,
					confidence: this.calculateConfidence(evidence),
					estimatedImpact: this.estimateImpact(evidence),
				};
		}
	}

	/**
	 * Determine correction type from event.
	 */
	private determineCorrectionType(correction: CorrectionEvent): string {
		const signals = correction.signals;
		if (signals.overwrite > 0.5) return "overwrite";
		if (signals.lexical > 0.5) return "lexical";
		if (signals.pivot > 0.5) return "pivot";
		if (signals.reask > 0.5) return "reask";
		return "mixed";
	}

	/**
	 * Find dominant signal across corrections.
	 */
	private findDominantSignal(
		corrections: CorrectionEvent[]
	): keyof CorrectionEvent["signals"] {
		const totals = { lexical: 0, pivot: 0, overwrite: 0, reask: 0 };

		for (const c of corrections) {
			totals.lexical += c.signals.lexical;
			totals.pivot += c.signals.pivot;
			totals.overwrite += c.signals.overwrite;
			totals.reask += c.signals.reask;
		}

		const entries = Object.entries(totals) as Array<
			[keyof typeof totals, number]
		>;
		entries.sort((a, b) => b[1] - a[1]);

		return entries[0][0];
	}

	/**
	 * Extract constraint from lexical corrections.
	 */
	private extractConstraintFromLexical(corrections: CorrectionEvent[]): string {
		// Look for common patterns in trigger events
		const triggers = corrections
			.map((c) => c.triggerEvent)
			.filter(Boolean) as string[];

		// Find common words indicating constraint
		const constraintWords = ["don't", "never", "always", "must", "should"];
		const found = triggers.find((t) =>
			constraintWords.some((w) => t.toLowerCase().includes(w))
		);

		if (found) {
			return this.extractConstraintPhrase(found);
		}

		// Default constraint
		return `Avoid the pattern that caused ${corrections.length} user corrections.`;
	}

	/**
	 * Extract constraint phrase from trigger text.
	 */
	private extractConstraintPhrase(trigger: string): string {
		// Simple extraction - in production would use NLP
		const lower = trigger.toLowerCase();

		if (lower.includes("don't") || lower.includes("do not")) {
			const match = trigger.match(/don'?t\s+(.+?)(?:\.|,|$)/i);
			if (match) return `Do not ${match[1].trim()}`;
		}

		if (lower.includes("always")) {
			const match = trigger.match(/always\s+(.+?)(?:\.|,|$)/i);
			if (match) return `Always ${match[1].trim()}`;
		}

		if (lower.includes("never")) {
			const match = trigger.match(/never\s+(.+?)(?:\.|,|$)/i);
			if (match) return `Never ${match[1].trim()}`;
		}

		return trigger.substring(0, 200);
	}

	/**
	 * Extract good example from corrections.
	 */
	private extractGoodExample(corrections: CorrectionEvent[]): string {
		// The trigger event often shows what user wanted
		const triggers = corrections
			.map((c) => c.triggerEvent)
			.filter(Boolean) as string[];

		if (triggers.length > 0) {
			return triggers[0].substring(0, 200);
		}

		return "User's preferred approach (extracted from corrections)";
	}

	/**
	 * Extract bad example from corrections.
	 */
	private extractBadExample(corrections: CorrectionEvent[]): string {
		// The agent action shows what agent did wrong
		const actions = corrections
			.map((c) => c.agentAction)
			.filter(Boolean) as string[];

		if (actions.length > 0) {
			return actions[0].substring(0, 200);
		}

		return "Agent's incorrect approach (extracted from corrections)";
	}

	/**
	 * Extract warning from pivot corrections.
	 */
	private extractPivotWarning(corrections: CorrectionEvent[]): string {
		const actions = corrections
			.map((c) => c.agentAction)
			.filter(Boolean) as string[];

		if (actions.length > 0) {
			return `Reconsider approach before: ${actions[0].substring(0, 150)}`;
		}

		return `Strategy pivot detected ${corrections.length} times - consider alternative approaches.`;
	}

	/**
	 * Generate clarification from reask corrections.
	 */
	private generateClarification(corrections: CorrectionEvent[]): string {
		const triggers = corrections
			.map((c) => c.triggerEvent)
			.filter(Boolean) as string[];

		if (triggers.length > 0) {
			return `Clarification needed: ${triggers[0].substring(0, 200)}. Users reasked ${corrections.length} times.`;
		}

		return `Consider asking for clarification in similar situations (${corrections.length} reasks detected).`;
	}

	/**
	 * Insert section into prompt.
	 */
	private insertSection(
		prompt: string,
		sectionName: string,
		content: string
	): string {
		// Check if section exists
		const sectionRegex = new RegExp(`^##\\s*${sectionName}`, "im");
		if (sectionRegex.test(prompt)) {
			// Append to existing section
			return prompt.replace(sectionRegex, `## ${sectionName}\n\n${content}\n\n##`);
		}

		// Add new section at end
		return `${prompt}\n\n## ${sectionName}\n\n${content}`;
	}

	/**
	 * Calculate confidence from evidence.
	 */
	private calculateConfidence(evidence: CorrectionEvidence[]): number {
		if (evidence.length === 0) return 0;

		const avgScore =
			evidence.reduce((sum, e) => sum + e.correctionScore, 0) / evidence.length;

		// Boost confidence with more evidence
		const evidenceBoost = Math.min(1, evidence.length / 10);

		return avgScore * 0.7 + evidenceBoost * 0.3;
	}

	/**
	 * Estimate impact of optimization.
	 */
	private estimateImpact(evidence: CorrectionEvidence[]): number {
		// More evidence = higher impact
		const countFactor = Math.min(1, evidence.length / 20);

		// Higher correction scores = higher impact
		const avgScore =
			evidence.length > 0
				? evidence.reduce((sum, e) => sum + e.correctionScore, 0) /
					evidence.length
				: 0;

		return countFactor * 0.5 + avgScore * 0.5;
	}

	/**
	 * Calculate safety score for optimization.
	 */
	private calculateSafetyScore(optimization: PromptOptimization): number {
		// Prompt optimizations are generally safe
		let score = 0.95;

		// Constraints and warnings are safest
		if (
			optimization.optimizationType === "constraint" ||
			optimization.optimizationType === "warning"
		) {
			score = 0.98;
		}

		// Replace operations are riskier
		if (optimization.insertionPoint === "replace") {
			score *= 0.9;
		}

		// Lower confidence = lower safety
		score *= optimization.confidence;

		return Math.min(1.0, score);
	}

	/**
	 * Truncate text to length.
	 */
	private truncate(text: string, maxLength: number): string {
		if (text.length <= maxLength) return text;
		return text.substring(0, maxLength - 3) + "...";
	}
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a prompt optimizer with optional configuration.
 */
export function createPromptOptimizer(
	config: Partial<PromptOptimizerConfig> = {}
): PromptOptimizer {
	return new PromptOptimizer(config);
}
