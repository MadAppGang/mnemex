/**
 * Doctor output formatting
 *
 * Human-readable and machine-parseable output formats
 */

import type { DoctorResult, ContextFileDiagnosis } from "./types.js";
import {
	classifySeverity,
	formatHealthBar,
	getHealthSymbol,
} from "./scorer.js";

/**
 * Color constants for terminal output
 */
const c = {
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	dim: "\x1b[2m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	red: "\x1b[31m",
	cyan: "\x1b[36m",
	orange: "\x1b[38;5;209m",
};

/**
 * Format doctor report for human-readable output
 */
export function formatDoctorReport(result: DoctorResult): string {
	const lines: string[] = [];

	// Header
	lines.push("");
	lines.push(`${c.orange}${c.bold}  MNEMEX CONTEXT FILE DOCTOR${c.reset}`);
	lines.push("");
	lines.push(`  Project: ${result.projectPath}`);
	lines.push(`  Timestamp: ${new Date(result.timestamp).toLocaleString()}`);
	lines.push("");

	// Overall health
	const healthSymbol = getHealthSymbol(result.overallHealth);
	const healthBar = formatHealthBar(result.overallHealth, 25);
	const severity = classifySeverity(result.overallHealth);
	const severityColor =
		severity === "good" ? c.green : severity === "warning" ? c.yellow : c.red;

	lines.push(
		`  ${c.bold}Overall Health${c.reset} ${severityColor}${healthSymbol}${c.reset}`,
	);
	lines.push(`  ${healthBar}`);
	lines.push("");

	// Files found
	if (result.filesFound.length === 0) {
		lines.push(`  ${c.yellow}⚠ No context files found${c.reset}`);
		lines.push("");
		lines.push("  Consider creating:");
		lines.push("    - CLAUDE.md (main developer guide)");
		lines.push("    - AGENTS.md (for Claude Code integration)");
		lines.push("    - .cursorrules (for Cursor IDE)");
	} else {
		lines.push(
			`  ${c.bold}Files Analyzed${c.reset} (${result.filesFound.length})`,
		);
		lines.push("");

		// Per-file analysis
		for (const diagnosis of result.diagnoses) {
			const fileSymbol = getHealthSymbol(diagnosis.overallScore);
			const fileSeverity = classifySeverity(diagnosis.overallScore);
			const fileSevColor =
				fileSeverity === "good"
					? c.green
					: fileSeverity === "warning"
						? c.yellow
						: c.red;

			lines.push(
				`    ${fileSevColor}${fileSymbol}${c.reset} ${c.cyan}${diagnosis.file.relativePath}${c.reset}`,
			);
			lines.push(
				`       Score: ${diagnosis.overallScore}% | ${diagnosis.file.lineCount} lines | ${diagnosis.file.tokenEstimate} tokens`,
			);
			lines.push(
				`       Cost: ${diagnosis.costOverhead.budgetPercent.toFixed(1)}% of typical query budget`,
			);

			// Show critical issues
			const criticalCriteria = diagnosis.criteria.filter(
				(c) => c.severity === "critical",
			);
			if (criticalCriteria.length > 0) {
				lines.push(`       ${c.red}Issues:${c.reset}`);
				for (const crit of criticalCriteria) {
					for (const issue of crit.issues) {
						lines.push(`         - ${issue}`);
					}
				}
			}

			lines.push("");
		}
	}

	// Top recommendations
	if (result.topRecommendations.length > 0) {
		lines.push(`  ${c.bold}Top Recommendations${c.reset}`);
		lines.push("");
		for (let i = 0; i < result.topRecommendations.length; i++) {
			lines.push(`    ${i + 1}. ${result.topRecommendations[i]}`);
		}
		lines.push("");
	}

	// Research citations
	if (result.researchCitations.length > 0) {
		lines.push(`  ${c.dim}${c.bold}Research Basis${c.reset}`);
		lines.push("");
		for (const citation of result.researchCitations) {
			lines.push(`    ${c.dim}${citation}${c.reset}`);
		}
		lines.push("");
	}

	// Footer
	lines.push(
		`  ${c.dim}Run 'mnemex doctor --help' for more information${c.reset}`,
	);
	lines.push("");

	return lines.join("\n");
}

/**
 * Format doctor report as JSON for machine parsing
 */
export function formatDoctorJSON(result: DoctorResult): string {
	return JSON.stringify(result, null, 2);
}

/**
 * Format diagnosis summary for compact output (agent mode)
 */
export function formatDoctorCompact(result: DoctorResult): string {
	const lines: string[] = [];

	lines.push(`health: ${result.overallHealth}%`);

	if (result.filesFound.length === 0) {
		lines.push("files: 0 context files found");
	} else {
		const scores = result.diagnoses
			.map((d) => `${d.file.relativePath}:${d.overallScore}`)
			.join(", ");
		lines.push(`files: ${scores}`);
	}

	if (result.topRecommendations.length > 0) {
		lines.push(`top: ${result.topRecommendations[0]}`);
	}

	return lines.join(" | ");
}
