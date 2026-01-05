/**
 * CorrectionScorer - Multi-signal detection of user corrections.
 *
 * Corrections are detected probabilistically using multiple signals:
 * - Lexical: Keywords like "no", "actually", "wrong" in user messages
 * - Pivot: Sudden change in tool strategy after failure
 * - Overwrite: User edits same file region after agent
 * - Reask: User repeats similar prompt
 *
 * The correction score (0.0 to 1.0) indicates confidence that
 * a correction occurred. Higher scores = more likely correction.
 */

import type { CorrectionSignals, CorrectionEvent } from "../interaction/types.js";

// ============================================================================
// Configuration
// ============================================================================

/** Default weights for correction signals (must sum to 1.0) */
export const DEFAULT_CORRECTION_WEIGHTS = {
	lexical: 0.3,
	pivot: 0.2,
	overwrite: 0.35,
	reask: 0.15,
} as const;

/** Keywords that suggest correction/disagreement */
export const LEXICAL_CORRECTION_KEYWORDS = [
	// Disagreement
	"no",
	"wrong",
	"incorrect",
	"actually",
	"instead",
	"not",
	"shouldn't",
	"shouldn't",
	"don't",
	"stop",
	// Correction phrases
	"i meant",
	"i wanted",
	"that's wrong",
	"that's not",
	"fix this",
	"fix that",
	"undo",
	"revert",
	"go back",
	// Frustration
	"why did you",
	"why didn't",
	"you forgot",
	"you missed",
	"you should have",
];

/** Strong correction keywords (higher weight) */
export const STRONG_CORRECTION_KEYWORDS = [
	"wrong",
	"incorrect",
	"undo",
	"revert",
	"that's not what i asked",
	"that's not right",
];

/** Filler words to ignore in similarity calculations */
const FILLER_WORDS = new Set([
	"the",
	"a",
	"an",
	"is",
	"are",
	"was",
	"were",
	"be",
	"been",
	"being",
	"have",
	"has",
	"had",
	"do",
	"does",
	"did",
	"will",
	"would",
	"could",
	"should",
	"may",
	"might",
	"must",
	"shall",
	"can",
	"to",
	"of",
	"in",
	"for",
	"on",
	"with",
	"at",
	"by",
	"from",
	"as",
	"into",
	"through",
	"during",
	"before",
	"after",
	"above",
	"below",
	"between",
	"and",
	"but",
	"or",
	"nor",
	"so",
	"yet",
	"both",
	"either",
	"neither",
	"not",
	"only",
	"just",
	"also",
	"i",
	"me",
	"my",
	"you",
	"your",
	"it",
	"its",
	"this",
	"that",
	"these",
	"those",
	"please",
	"thanks",
	"thank",
]);

// ============================================================================
// Types
// ============================================================================

export interface CorrectionScorerConfig {
	weights: typeof DEFAULT_CORRECTION_WEIGHTS;
	/** Minimum score threshold to consider it a correction */
	minCorrectionThreshold: number;
	/** Time window (ms) for pivot detection */
	pivotTimeWindowMs: number;
	/** Similarity threshold for reask detection (0-1) */
	reaskSimilarityThreshold: number;
}

export const DEFAULT_SCORER_CONFIG: CorrectionScorerConfig = {
	weights: DEFAULT_CORRECTION_WEIGHTS,
	minCorrectionThreshold: 0.4,
	pivotTimeWindowMs: 60000, // 1 minute
	reaskSimilarityThreshold: 0.6,
};

export interface ScoringContext {
	/** Current user message */
	userMessage: string;
	/** Recent user messages for reask detection */
	recentUserMessages?: string[];
	/** Current tool being used */
	currentTool?: string;
	/** Previous tool used */
	previousTool?: string;
	/** Whether previous tool failed */
	previousToolFailed?: boolean;
	/** File path being edited (if applicable) */
	filePath?: string;
	/** Recent agent edits to the file */
	recentAgentEdits?: Array<{
		filePath: string;
		startLine?: number;
		endLine?: number;
		timestamp: number;
	}>;
	/** Current edit info (if user is editing) */
	currentEdit?: {
		startLine?: number;
		endLine?: number;
	};
	/** Time since last tool use (ms) */
	timeSinceLastToolMs?: number;
}

// ============================================================================
// CorrectionScorer Class
// ============================================================================

export class CorrectionScorer {
	private config: CorrectionScorerConfig;

	constructor(config: Partial<CorrectionScorerConfig> = {}) {
		this.config = { ...DEFAULT_SCORER_CONFIG, ...config };
	}

	/**
	 * Calculate correction score from context signals.
	 *
	 * @param context - Scoring context with available signals
	 * @returns Correction event with score and individual signals
	 */
	score(context: ScoringContext): Partial<CorrectionEvent> {
		const signals: CorrectionSignals = {
			lexical: this.scoreLexical(context.userMessage),
			pivot: this.scorePivot(context),
			overwrite: this.scoreOverwrite(context),
			reask: this.scoreReask(context),
		};

		// Calculate weighted score
		const correctionScore =
			signals.lexical * this.config.weights.lexical +
			signals.pivot * this.config.weights.pivot +
			signals.overwrite * this.config.weights.overwrite +
			signals.reask * this.config.weights.reask;

		return {
			correctionScore,
			signals,
			triggerEvent: context.userMessage.substring(0, 500),
			timestamp: Date.now(),
		};
	}

	/**
	 * Score lexical correction signals from user message.
	 * Looks for keywords indicating disagreement or correction.
	 */
	scoreLexical(message: string): number {
		if (!message) return 0;

		const lowerMessage = message.toLowerCase();
		let score = 0;

		// Check strong correction keywords (full weight)
		for (const keyword of STRONG_CORRECTION_KEYWORDS) {
			if (lowerMessage.includes(keyword)) {
				return 1.0; // Strong signal = max score
			}
		}

		// Check regular correction keywords
		let matchCount = 0;
		for (const keyword of LEXICAL_CORRECTION_KEYWORDS) {
			if (lowerMessage.includes(keyword)) {
				matchCount++;
			}
		}

		// Scale score by number of matches (diminishing returns)
		if (matchCount > 0) {
			score = Math.min(1.0, 0.3 + matchCount * 0.2);
		}

		// Boost if message starts with correction word
		const firstWord = lowerMessage.split(/\s+/)[0];
		if (["no", "wrong", "actually", "wait", "stop"].includes(firstWord)) {
			score = Math.min(1.0, score + 0.3);
		}

		return score;
	}

	/**
	 * Score pivot signal - sudden change in approach after failure.
	 */
	scorePivot(context: ScoringContext): number {
		// No pivot if no previous tool info
		if (!context.previousTool || !context.currentTool) {
			return 0;
		}

		// Check if previous tool failed
		if (!context.previousToolFailed) {
			return 0;
		}

		// Check if tools are different (suggesting a change in approach)
		if (context.previousTool === context.currentTool) {
			return 0.2; // Same tool after failure = slight correction signal
		}

		// Different tool after failure = stronger signal
		const isRelatedTool = this.areToolsRelated(
			context.previousTool,
			context.currentTool
		);

		if (isRelatedTool) {
			return 0.5; // Related tool = moderate pivot
		}

		return 0.8; // Unrelated tool = strong pivot
	}

	/**
	 * Score overwrite signal - user editing same region as agent.
	 */
	scoreOverwrite(context: ScoringContext): number {
		if (!context.filePath || !context.recentAgentEdits) {
			return 0;
		}

		// Find agent edits to same file
		const sameFileEdits = context.recentAgentEdits.filter(
			(edit) => edit.filePath === context.filePath
		);

		if (sameFileEdits.length === 0) {
			return 0;
		}

		// Check for overlapping line ranges
		if (context.currentEdit?.startLine !== undefined) {
			for (const agentEdit of sameFileEdits) {
				if (this.linesOverlap(context.currentEdit, agentEdit)) {
					// Strong overwrite signal - exact same region
					return 1.0;
				}
			}
			// Same file but different region
			return 0.4;
		}

		// User editing same file agent recently edited
		return 0.6;
	}

	/**
	 * Score reask signal - user repeating similar request.
	 */
	scoreReask(context: ScoringContext): number {
		if (!context.recentUserMessages || context.recentUserMessages.length === 0) {
			return 0;
		}

		const currentTokens = this.tokenize(context.userMessage);
		if (currentTokens.size === 0) {
			return 0;
		}

		let maxSimilarity = 0;

		for (const prevMessage of context.recentUserMessages) {
			const prevTokens = this.tokenize(prevMessage);
			const similarity = this.jaccardSimilarity(currentTokens, prevTokens);

			if (similarity > maxSimilarity) {
				maxSimilarity = similarity;
			}
		}

		// Scale similarity to score
		if (maxSimilarity >= this.config.reaskSimilarityThreshold) {
			return Math.min(1.0, maxSimilarity);
		}

		// Partial credit for moderate similarity
		if (maxSimilarity >= 0.3) {
			return maxSimilarity * 0.5;
		}

		return 0;
	}

	/**
	 * Check if correction score meets threshold.
	 */
	isCorrection(score: number): boolean {
		return score >= this.config.minCorrectionThreshold;
	}

	/**
	 * Get human-readable explanation of signals.
	 */
	explainSignals(signals: CorrectionSignals): string[] {
		const explanations: string[] = [];

		if (signals.lexical > 0.5) {
			explanations.push("User message contains correction keywords");
		} else if (signals.lexical > 0) {
			explanations.push("User message suggests possible disagreement");
		}

		if (signals.pivot > 0.5) {
			explanations.push("User switched approach after tool failure");
		} else if (signals.pivot > 0) {
			explanations.push("Previous tool operation failed");
		}

		if (signals.overwrite > 0.5) {
			explanations.push("User editing same region agent modified");
		} else if (signals.overwrite > 0) {
			explanations.push("User editing file agent recently touched");
		}

		if (signals.reask > 0.5) {
			explanations.push("User repeating similar request");
		} else if (signals.reask > 0) {
			explanations.push("User request has some similarity to recent messages");
		}

		return explanations;
	}

	// ========================================================================
	// Private Helpers
	// ========================================================================

	/**
	 * Check if two tools are related (same category).
	 */
	private areToolsRelated(tool1: string, tool2: string): boolean {
		const toolCategories: Record<string, string[]> = {
			file: ["Read", "Write", "Edit", "Glob"],
			search: ["Grep", "Glob", "Read"],
			execute: ["Bash", "Task"],
			web: ["WebFetch", "WebSearch"],
		};

		for (const category of Object.values(toolCategories)) {
			if (category.includes(tool1) && category.includes(tool2)) {
				return true;
			}
		}

		return false;
	}

	/**
	 * Check if line ranges overlap.
	 */
	private linesOverlap(
		range1: { startLine?: number; endLine?: number },
		range2: { startLine?: number; endLine?: number }
	): boolean {
		const start1 = range1.startLine ?? 0;
		const end1 = range1.endLine ?? range1.startLine ?? Infinity;
		const start2 = range2.startLine ?? 0;
		const end2 = range2.endLine ?? range2.startLine ?? Infinity;

		return start1 <= end2 && start2 <= end1;
	}

	/**
	 * Tokenize text for similarity comparison.
	 */
	private tokenize(text: string): Set<string> {
		const tokens = text
			.toLowerCase()
			.replace(/[^\w\s]/g, " ")
			.split(/\s+/)
			.filter((t) => t.length > 2 && !FILLER_WORDS.has(t));

		return new Set(tokens);
	}

	/**
	 * Calculate Jaccard similarity between token sets.
	 */
	private jaccardSimilarity(set1: Set<string>, set2: Set<string>): number {
		if (set1.size === 0 || set2.size === 0) {
			return 0;
		}

		let intersection = 0;
		for (const token of set1) {
			if (set2.has(token)) {
				intersection++;
			}
		}

		const union = set1.size + set2.size - intersection;
		return intersection / union;
	}
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a correction scorer with optional configuration.
 */
export function createCorrectionScorer(
	config: Partial<CorrectionScorerConfig> = {}
): CorrectionScorer {
	return new CorrectionScorer(config);
}
