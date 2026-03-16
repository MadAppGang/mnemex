/**
 * Score aggregation and severity classification
 */

import type { CriterionResult } from "./types.js";

/**
 * Aggregate criterion scores into overall health score
 * Uses weighted average
 */
export function aggregateScore(criteria: CriterionResult[]): number {
	const totalWeight = criteria.reduce((s, c) => s + c.weight, 0);
	const weightedSum = criteria.reduce((s, c) => s + c.score * c.weight, 0);
	return Math.round(weightedSum / totalWeight);
}

/**
 * Classify overall health based on score
 */
export function classifySeverity(
	score: number,
): "good" | "warning" | "critical" {
	if (score >= 80) return "good";
	if (score >= 60) return "warning";
	return "critical";
}

/**
 * Get health status emoji/symbol
 */
export function getHealthSymbol(score: number): string {
	if (score >= 85) return "✓";
	if (score >= 70) return "⚠";
	if (score >= 50) return "⚠";
	return "✗";
}

/**
 * Format health score as a bar chart
 */
export function formatHealthBar(score: number, width = 20): string {
	const filled = Math.round((score / 100) * width);
	const empty = width - filled;
	const color =
		score >= 80 ? "\x1b[32m" : score >= 60 ? "\x1b[33m" : "\x1b[31m";
	const reset = "\x1b[0m";
	return `${color}[${"█".repeat(filled)}${" ".repeat(empty)}]${reset} ${score}%`;
}
