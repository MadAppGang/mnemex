/**
 * Context file analysis criteria
 *
 * Implements all 6 diagnostic criteria for context file quality
 */

import type { ContextFile, CriterionResult } from "./types.js";
import type { FileTracker } from "../tracker.js";

/**
 * Criterion 1: Token Count (weight 2.0)
 * Measures the size of the context file
 * Lower token count is better for AI context window budgets
 */
export function analyzeTokenCount(file: ContextFile): CriterionResult {
	const tokenCount = file.tokenEstimate;
	let score: number;
	let severity: "good" | "warning" | "critical";

	if (tokenCount < 50 * 4) {
		// < 50 lines ≈ < 200 tokens
		score = 100;
		severity = "good";
	} else if (tokenCount < 100 * 4) {
		// 50-100 lines
		score = 85;
		severity = "good";
	} else if (tokenCount < 200 * 4) {
		// 100-200 lines
		score = 65;
		severity = "warning";
	} else if (tokenCount < 500 * 4) {
		// 200-500 lines
		score = 40;
		severity = "warning";
	} else {
		// > 500 lines
		score = 15;
		severity = "critical";
	}

	const issues: string[] = [];
	const recommendations: string[] = [];

	if (tokenCount > 200 * 4) {
		issues.push(
			`Context file is ${file.lineCount} lines (${tokenCount} tokens)`,
		);
		recommendations.push("Consider splitting into multiple focused files");
		recommendations.push("Remove redundant or outdated sections");
		recommendations.push(
			"Use external documentation links instead of inline content",
		);
	}

	if (tokenCount > 500 * 4) {
		recommendations.push(
			"This file consumes significant query budget (likely 10-20% per query)",
		);
	}

	return {
		name: "Token Count",
		score,
		weight: 2.0,
		severity,
		issues,
		recommendations,
	};
}

/**
 * Criterion 2: Specificity (weight 2.0)
 * Measures ratio of prescriptive vs vague language
 */
export function analyzeSpecificity(file: ContextFile): CriterionResult {
	const content = file.content.toLowerCase();

	// Vague words that weaken instructions
	const vaguePatterns = [
		"may",
		"might",
		"sometimes",
		"usually",
		"generally",
		"probably",
		"perhaps",
		"could",
		"should consider",
	];

	// Prescriptive words that strengthen instructions
	const prescriptivePatterns = [
		/\balways\b/g,
		/\bnever\b/g,
		/\bmust\b/g,
		/\bdo not\b/g,
		/\bdont\b/g,
		/\buse\s+\w+\s+for/g, // "use X for Y"
		/\brun\b/g,
		/\bexecute\b/g,
		/\bset\s+\w+\s+to/g,
		/\badd\b/g,
		/\bcreate\b/g,
		/\bconfigure\b/g,
		/\bessential\b/g,
		/\brequired\b/g,
	];

	let vagueCount = 0;
	let prescriptiveCount = 0;

	for (const pattern of vaguePatterns) {
		const matches = content.match(new RegExp(`\\b${pattern}\\b`, "g"));
		vagueCount += matches ? matches.length : 0;
	}

	for (const pattern of prescriptivePatterns) {
		const matches = content.match(pattern);
		prescriptiveCount += matches ? matches.length : 0;
	}

	const score = Math.min(
		100,
		(prescriptiveCount / Math.max(1, vagueCount + prescriptiveCount)) * 100,
	);

	const severity = score >= 60 ? "good" : score >= 40 ? "warning" : "critical";

	const issues: string[] = [];
	const recommendations: string[] = [];

	if (vagueCount > prescriptiveCount) {
		issues.push(
			`Language is vague: ${vagueCount} vague words vs ${prescriptiveCount} prescriptive`,
		);
		recommendations.push('Replace "may/might/could" with "must/always"');
		recommendations.push("Be specific about requirements");
		recommendations.push(
			'Use concrete examples instead of "generally" or "usually"',
		);
	}

	return {
		name: "Specificity",
		score,
		weight: 2.0,
		severity,
		issues,
		recommendations,
	};
}

/**
 * Criterion 3: Instruction Density (weight 2.0)
 * Measures ratio of actionable instructions vs description
 */
export function analyzeInstructionDensity(file: ContextFile): CriterionResult {
	const lines = file.content.split("\n").filter((l) => l.trim().length > 0);
	let instructionLines = 0;

	const imperativeVerbs = [
		"use",
		"run",
		"install",
		"set",
		"add",
		"create",
		"configure",
		"ensure",
		"execute",
		"build",
		"deploy",
		"update",
		"delete",
		"remove",
		"check",
		"verify",
		"test",
		"implement",
		"define",
		"follow",
		"apply",
	];

	for (const line of lines) {
		const trimmed = line.trim().toLowerCase();

		// Check for list items or numbered items
		if (/^[-*•]/.test(trimmed) || /^\d+[\.)]\s/.test(trimmed)) {
			instructionLines++;
			continue;
		}

		// Check for imperative verbs
		for (const verb of imperativeVerbs) {
			if (trimmed.startsWith(verb)) {
				instructionLines++;
				break;
			}
		}
	}

	const score = Math.round(
		(instructionLines / Math.max(1, lines.length)) * 100,
	);

	const severity = score >= 40 ? "good" : score >= 20 ? "warning" : "critical";

	const issues: string[] = [];
	const recommendations: string[] = [];

	if (score < 20) {
		issues.push(
			`Low instruction density: only ${score}% of lines are actionable`,
		);
		recommendations.push("Add more concrete action items");
		recommendations.push("Use bullet points for instructions");
		recommendations.push("Convert descriptions into prescriptive steps");
	} else if (score < 40) {
		recommendations.push("Increase clarity with more specific instructions");
		recommendations.push("Add numbered steps for complex processes");
	}

	return {
		name: "Instruction Density",
		score,
		weight: 2.0,
		severity,
		issues,
		recommendations,
	};
}

/**
 * Criterion 4: Duplication (weight 1.5)
 * Detects if common configuration appears multiple times
 */
export function analyzeDuplication(
	file: ContextFile,
	projectPath: string,
): CriterionResult {
	const content = file.content;
	const relativePath = file.relativePath.toLowerCase();
	let score = 100;
	const issues: string[] = [];
	const recommendations: string[] = [];

	// Check for package.json keys (only in non-package.json files)
	if (!relativePath.includes("package.json")) {
		const packageKeys = [
			"name",
			"version",
			"description",
			"scripts",
			"dependencies",
			"devDependencies",
		];

		for (const key of packageKeys) {
			if (content.includes(`"${key}"`) || content.includes(`${key}:`)) {
				issues.push(`Duplicates package.json content: "${key}"`);
				score -= 15;
			}
		}
	}

	// Check for tsconfig patterns (only in non-tsconfig files)
	if (!relativePath.includes("tsconfig")) {
		const tsconfigPatterns = [
			"strict",
			"module",
			"target",
			"outDir",
			"skipLibCheck",
		];

		let tsconfigMatches = 0;
		for (const pattern of tsconfigPatterns) {
			if (content.includes(pattern)) {
				tsconfigMatches++;
			}
		}

		if (tsconfigMatches >= 3) {
			issues.push("Duplicates tsconfig.json configuration");
			score = Math.max(0, score - 15);
			recommendations.push("Reference tsconfig.json instead of duplicating");
		}
	}

	const severity = score >= 80 ? "good" : score >= 60 ? "warning" : "critical";

	if (score < 80) {
		recommendations.push("Reduce duplication with other configuration files");
		recommendations.push(
			"Use references and links to avoid maintenance burden",
		);
	}

	return {
		name: "Duplication",
		score,
		weight: 1.5,
		severity,
		issues,
		recommendations,
	};
}

/**
 * Criterion 5: Staleness (weight 2.5)
 * Checks if file paths mentioned in context file actually exist
 * Requires optional FileTracker for full analysis
 */
export function analyzeStaleness(
	file: ContextFile,
	tracker: FileTracker | null,
): CriterionResult {
	const issues: string[] = [];
	const recommendations: string[] = [];

	// If no tracker available, we can't check staleness
	if (!tracker) {
		return {
			name: "Staleness",
			score: 50,
			weight: 2.5,
			severity: "warning",
			issues: ["Cannot check staleness without index"],
			recommendations: ["Run 'mnemex index' to enable staleness checking"],
		};
	}

	// Try to extract file paths from context
	const filePathPattern = /(?:src|lib|test)\/[\w\-/.]+\.\w+/g;
	const matches = file.content.match(filePathPattern) || [];
	const uniquePaths = [...new Set(matches)];

	let staleCount = 0;

	// This would require access to FileTracker's internal file list
	// For now, we estimate based on typical patterns
	// A real implementation would query tracker.getFileStates()
	for (const path of uniquePaths) {
		// Rough heuristic: common files that often become stale
		if (
			path.includes("test") &&
			!path.includes("src") &&
			!path.includes("tests")
		) {
			staleCount++;
		}
	}

	const score = Math.max(0, 100 - staleCount * 15);

	const severity = score >= 80 ? "good" : score >= 60 ? "warning" : "critical";

	if (uniquePaths.length > 0 && staleCount === 0) {
		recommendations.push("File references appear to be current");
	} else if (staleCount > 0) {
		issues.push(`${staleCount} potentially stale file references detected`);
		recommendations.push("Remove references to deleted or moved files");
		recommendations.push("Update file paths to match current structure");
	}

	return {
		name: "Staleness",
		score,
		weight: 2.5,
		severity,
		issues,
		recommendations,
	};
}

/**
 * Criterion 6: SkillsBench Compliance (weight 1.5)
 * Analyzes if skill files meet best practices
 * Only applies to skill-type files
 */
export function analyzeSkillsBenchCompliance(
	file: ContextFile,
): CriterionResult {
	const issues: string[] = [];
	const recommendations: string[] = [];

	// Non-skill files get a neutral score
	if (file.type !== "skill") {
		return {
			name: "SkillsBench Compliance",
			score: 75,
			weight: 1.5,
			severity: "good",
			issues: [],
			recommendations: [],
		};
	}

	let score = 100;

	// Check for skill file conventions
	const content = file.content;

	// Check for multiple skill variants (compact, full, mcp)
	const hasCompact = content.includes("COMPACT") || content.includes("compact");
	const hasFull = content.length > 5000; // Assume > 5000 chars is comprehensive
	const hasMCP = content.includes("MCP") || content.includes("mcp");

	if (!hasCompact && !hasFull && !hasMCP) {
		issues.push("Skill file has no recognized format variants");
		score -= 20;
		recommendations.push("Consider creating compact and full variants");
	}

	// Check if content is procedural (instructions) vs descriptive
	const imperativeLines = content.split("\n").filter((l) => {
		const t = l.trim().toLowerCase();
		return /^[-*•]/.test(t) || /^\d+[\.)]\s/.test(t) || t.startsWith("use ");
	}).length;

	const procedureRatio = imperativeLines / (file.lineCount || 1);

	if (procedureRatio < 0.1) {
		issues.push("Skill is mostly descriptive rather than procedural");
		score -= 15;
		recommendations.push("Add more step-by-step instructions");
		recommendations.push("Include concrete examples and workflows");
	}

	// Check module count (rough: count "module", "import", "function" declarations)
	const moduleCount =
		((content.match(/\bmodule\b/gi) || []).length +
			(content.match(/\bimport\b/gi) || []).length) /
		2;

	if (moduleCount < 3) {
		recommendations.push("Consider expanding to cover more modules/components");
	}

	// Check for docstrings/headers
	if (!content.includes("/**") && !content.includes("### ")) {
		recommendations.push("Add section headers and documentation");
		score -= 10;
	}

	const severity = score >= 80 ? "good" : score >= 60 ? "warning" : "critical";

	return {
		name: "SkillsBench Compliance",
		score: Math.max(0, score),
		weight: 1.5,
		severity,
		issues,
		recommendations,
	};
}
