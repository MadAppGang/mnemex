/**
 * Query Expansion Scorer
 *
 * Scores model outputs on:
 * 1. Format compliance (0-1): valid lex:/vec:/hyde: lines
 * 2. Keyword quality (0-1): relevance and diversity of lex: terms
 * 3. Semantic quality (0-1): vec: rephrasing quality
 * 4. HyDE quality (0-1): code plausibility of hyde: output
 * 5. Latency (ms): generation time
 * 6. Total score: weighted average
 */

// ============================================================================
// Types
// ============================================================================

export interface ExpansionOutput {
	raw: string;
	lex: string | null;
	vec: string | null;
	hyde: string | null;
}

export interface QueryScore {
	queryId: string;
	query: string;
	modelName: string;
	/** Format compliance: does output contain valid lex:/vec:/hyde: lines? */
	format: number;
	/** Keyword quality: relevance and diversity of lex: terms */
	keyword: number;
	/** Semantic quality: is vec: a good rephrasing? */
	semantic: number;
	/** HyDE quality: is hyde: plausible code? */
	hyde: number;
	/** Generation latency in ms */
	latencyMs: number;
	/** Weighted total score (0-1) */
	total: number;
	/** Parsed expansion output */
	expansion: ExpansionOutput;
}

export interface ModelScores {
	modelName: string;
	paramsB: number;
	scores: QueryScore[];
	/** Averages across all queries */
	avg: {
		format: number;
		keyword: number;
		semantic: number;
		hyde: number;
		latencyMs: number;
		total: number;
	};
}

/** Scoring weights */
const WEIGHTS = {
	format: 0.2,
	keyword: 0.2,
	semantic: 0.2,
	hyde: 0.25,
	speed: 0.15,
};

/** Speed scoring: latency thresholds (ms) */
const SPEED_THRESHOLDS = {
	excellent: 500, // < 500ms = 1.0
	good: 1500, // < 1500ms = 0.7
	acceptable: 5000, // < 5000ms = 0.4
	slow: 15000, // < 15000ms = 0.1
};

// ============================================================================
// Parsing
// ============================================================================

/** Parse raw model output into structured expansion */
export function parseExpansion(raw: string): ExpansionOutput {
	const lines = raw.trim().split("\n");

	let lex: string | null = null;
	let vec: string | null = null;
	let hyde: string | null = null;

	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.toLowerCase().startsWith("lex:")) {
			lex = trimmed.slice(4).trim();
		} else if (trimmed.toLowerCase().startsWith("vec:")) {
			vec = trimmed.slice(4).trim();
		} else if (trimmed.toLowerCase().startsWith("hyde:")) {
			hyde = trimmed.slice(5).trim();
		}
	}

	return { raw, lex, vec, hyde };
}

// ============================================================================
// Individual Scorers
// ============================================================================

/** Score format compliance (0-1) */
export function scoreFormat(expansion: ExpansionOutput): number {
	let score = 0;

	// Each line present and non-empty = 0.33
	if (expansion.lex && expansion.lex.length > 0) score += 0.33;
	if (expansion.vec && expansion.vec.length > 0) score += 0.33;
	if (expansion.hyde && expansion.hyde.length > 0) score += 0.34;

	return score;
}

/** Score keyword quality (0-1) based on heuristics */
export function scoreKeywords(
	expansion: ExpansionOutput,
	originalQuery: string,
): number {
	if (!expansion.lex) return 0;

	const lexTerms = expansion.lex
		.split(/[,;|\s]+/)
		.map((t) => t.trim().toLowerCase())
		.filter((t) => t.length > 1);

	if (lexTerms.length === 0) return 0;

	const queryTerms = originalQuery
		.toLowerCase()
		.split(/\s+/)
		.filter((t) => t.length > 1);

	let score = 0;

	// Diversity: more unique terms = better (up to 10)
	const uniqueTerms = new Set(lexTerms);
	score += Math.min(uniqueTerms.size / 10, 1) * 0.4;

	// Relevance: at least some terms should relate to query
	const hasOverlap = queryTerms.some(
		(qt) =>
			lexTerms.some((lt) => lt.includes(qt) || qt.includes(lt)),
	);
	if (hasOverlap) score += 0.3;

	// Expansion: terms beyond just repeating query words
	const newTerms = lexTerms.filter(
		(lt) => !queryTerms.some((qt) => lt === qt),
	);
	if (newTerms.length > 0) score += 0.3;

	return Math.min(score, 1);
}

/** Score semantic rephrasing quality (0-1) based on heuristics */
export function scoreSemantic(
	expansion: ExpansionOutput,
	originalQuery: string,
): number {
	if (!expansion.vec) return 0;

	const vec = expansion.vec;
	let score = 0;

	// Length: should be a reasonable sentence (10-200 chars)
	if (vec.length >= 10 && vec.length <= 200) {
		score += 0.3;
	} else if (vec.length > 3) {
		score += 0.1;
	}

	// Different from original (not just echoing)
	const similarity = jaroWinkler(originalQuery.toLowerCase(), vec.toLowerCase());
	if (similarity < 0.95) {
		score += 0.3; // Good: it's actually a rephrasing
	} else {
		score += 0.05; // Just repeated the query
	}

	// Contains natural language (not just keywords)
	const hasNaturalLanguage =
		vec.includes(" ") && /[a-z]{3,}/.test(vec) && vec.length > 15;
	if (hasNaturalLanguage) score += 0.4;

	return Math.min(score, 1);
}

/** Score HyDE quality (0-1) based on code plausibility */
export function scoreHyde(expansion: ExpansionOutput): number {
	if (!expansion.hyde) return 0;

	const hyde = expansion.hyde;
	let score = 0;

	// Non-trivial length
	if (hyde.length > 20) {
		score += 0.2;
	} else if (hyde.length > 5) {
		score += 0.1;
	}

	// Contains code-like patterns
	const codePatterns = [
		/[{}()\[\]]/,           // Brackets
		/\b(function|const|let|var|class|def|import|export|return|if|for|while|async|await)\b/,  // Keywords
		/[=;:]/,                // Assignment/statement markers
		/\.\w+\(/,              // Method calls
		/\w+\s*=>/,             // Arrow functions
		/\/\//,                 // Comments
	];

	const matchCount = codePatterns.filter((p) => p.test(hyde)).length;
	score += Math.min(matchCount / 4, 1) * 0.5;

	// Multi-line is better for code snippets
	const lineCount = hyde.split("\n").length;
	if (lineCount >= 2) score += 0.15;
	if (lineCount >= 3) score += 0.15;

	return Math.min(score, 1);
}

/** Score speed (0-1) based on latency thresholds */
export function scoreSpeed(latencyMs: number): number {
	if (latencyMs <= SPEED_THRESHOLDS.excellent) return 1.0;
	if (latencyMs <= SPEED_THRESHOLDS.good) return 0.7;
	if (latencyMs <= SPEED_THRESHOLDS.acceptable) return 0.4;
	if (latencyMs <= SPEED_THRESHOLDS.slow) return 0.1;
	return 0;
}

// ============================================================================
// Composite Scorer
// ============================================================================

/** Score a single query expansion */
export function scoreExpansion(
	queryId: string,
	query: string,
	modelName: string,
	raw: string,
	latencyMs: number,
): QueryScore {
	const expansion = parseExpansion(raw);

	const format = scoreFormat(expansion);
	const keyword = scoreKeywords(expansion, query);
	const semantic = scoreSemantic(expansion, query);
	const hyde = scoreHyde(expansion);
	const speed = scoreSpeed(latencyMs);

	const total =
		format * WEIGHTS.format +
		keyword * WEIGHTS.keyword +
		semantic * WEIGHTS.semantic +
		hyde * WEIGHTS.hyde +
		speed * WEIGHTS.speed;

	return {
		queryId,
		query,
		modelName,
		format,
		keyword,
		semantic,
		hyde,
		latencyMs,
		total,
		expansion,
	};
}

/** Aggregate scores for a model across all queries */
export function aggregateModelScores(
	modelName: string,
	paramsB: number,
	scores: QueryScore[],
): ModelScores {
	if (scores.length === 0) {
		return {
			modelName,
			paramsB,
			scores: [],
			avg: { format: 0, keyword: 0, semantic: 0, hyde: 0, latencyMs: 0, total: 0 },
		};
	}

	const avg = {
		format: mean(scores.map((s) => s.format)),
		keyword: mean(scores.map((s) => s.keyword)),
		semantic: mean(scores.map((s) => s.semantic)),
		hyde: mean(scores.map((s) => s.hyde)),
		latencyMs: mean(scores.map((s) => s.latencyMs)),
		total: mean(scores.map((s) => s.total)),
	};

	return { modelName, paramsB, scores, avg };
}

// ============================================================================
// Utility Functions
// ============================================================================

function mean(values: number[]): number {
	if (values.length === 0) return 0;
	return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Jaro-Winkler similarity (0-1, 1 = identical) */
function jaroWinkler(s1: string, s2: string): number {
	if (s1 === s2) return 1;
	if (s1.length === 0 || s2.length === 0) return 0;

	const matchDistance = Math.floor(Math.max(s1.length, s2.length) / 2) - 1;
	const s1Matches = new Array(s1.length).fill(false);
	const s2Matches = new Array(s2.length).fill(false);

	let matches = 0;
	let transpositions = 0;

	for (let i = 0; i < s1.length; i++) {
		const start = Math.max(0, i - matchDistance);
		const end = Math.min(i + matchDistance + 1, s2.length);

		for (let j = start; j < end; j++) {
			if (s2Matches[j] || s1[i] !== s2[j]) continue;
			s1Matches[i] = true;
			s2Matches[j] = true;
			matches++;
			break;
		}
	}

	if (matches === 0) return 0;

	let k = 0;
	for (let i = 0; i < s1.length; i++) {
		if (!s1Matches[i]) continue;
		while (!s2Matches[k]) k++;
		if (s1[i] !== s2[k]) transpositions++;
		k++;
	}

	const jaro =
		(matches / s1.length +
			matches / s2.length +
			(matches - transpositions / 2) / matches) /
		3;

	// Winkler prefix bonus
	let prefix = 0;
	for (let i = 0; i < Math.min(4, Math.min(s1.length, s2.length)); i++) {
		if (s1[i] === s2[i]) prefix++;
		else break;
	}

	return jaro + prefix * 0.1 * (1 - jaro);
}
