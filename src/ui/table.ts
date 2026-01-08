/**
 * Table Rendering Utilities
 *
 * Creates formatted tables with highlighting for CLI benchmark results.
 */

import { colors as c } from "./colors.js";

/** Column definition for table */
export interface TableColumn {
	header: string;
	width: number;
	align?: "left" | "right";
}

/** Cell value with optional highlighting */
export interface CellValue {
	value: string;
	highlight?: "best" | "worst" | "neutral";
}

/**
 * Truncate string with ellipsis
 */
export function truncate(s: string, max: number): string {
	return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/**
 * Format number as percentage
 */
export function formatPercent(value: number, decimals = 0): string {
	return `${value.toFixed(decimals)}%`;
}

/**
 * Format duration in seconds
 */
export function formatDuration(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Format cost in dollars
 */
export function formatCost(cost: number | undefined | null): string {
	if (cost === undefined || cost === null) return "N/A";
	if (cost === 0) return "FREE";
	return `$${cost.toFixed(5)}`;
}

/**
 * Format context length (e.g., 32000 -> "32K")
 */
export function formatContextLength(ctx: number): string {
	return ctx >= 1000 ? `${Math.round(ctx / 1000)}K` : String(ctx);
}

/**
 * Apply cell highlighting based on best/worst
 */
function applyCellHighlight(
	value: string,
	highlight?: "best" | "worst" | "neutral",
): string {
	if (highlight === "best") return `${c.green}${value}${c.reset}`;
	if (highlight === "worst") return `${c.red}${value}${c.reset}`;
	return value;
}

/**
 * Render a results table
 */
export function renderTable(
	columns: TableColumn[],
	rows: Array<{ cells: CellValue[]; error?: string }>,
): void {
	// Calculate total width
	const totalWidth = columns.reduce((sum, col) => sum + col.width + 1, 0) - 1;

	// Print header
	const headerLine = columns
		.map((col) => col.header.padEnd(col.width))
		.join(" ");
	console.log(`  ${headerLine}`);
	console.log("  " + "─".repeat(totalWidth));

	// Print rows
	for (const row of rows) {
		if (row.error) {
			const firstCell = row.cells[0]?.value || "Unknown";
			console.log(
				`  ${c.red}${truncate(firstCell, columns[0]?.width || 28).padEnd(columns[0]?.width || 28)} ERROR${c.reset}`,
			);
			console.log(`    ${c.dim}${row.error}${c.reset}`);
			continue;
		}

		const cells = row.cells.map((cell, i) => {
			const col = columns[i];
			const value =
				col.align === "right"
					? cell.value.padStart(col.width)
					: cell.value.padEnd(col.width);
			return applyCellHighlight(value, cell.highlight);
		});

		console.log(`  ${cells.join(" ")}`);
	}
}

/**
 * Determine highlight based on ranking
 */
export function getHighlight(
	value: number,
	min: number,
	max: number,
	higherIsBetter: boolean,
): "best" | "worst" | "neutral" {
	if (min === max) return "neutral";
	const best = higherIsBetter ? max : min;
	const worst = higherIsBetter ? min : max;
	if (value === best) return "best";
	if (value === worst) return "worst";
	return "neutral";
}

/**
 * Print a summary section
 */
export function renderSummary(
	items: Array<{ emoji: string; label: string; value: string }>,
): void {
	console.log(`\n${c.bold}Summary:${c.reset}`);
	for (const item of items) {
		console.log(
			`  ${c.green}${item.emoji} ${item.label}:${c.reset} ${item.value}`,
		);
	}
}

/**
 * Print section header
 */
export function renderHeader(title: string): void {
	console.log(`\n${c.bold}${title}${c.reset}\n`);
}

/**
 * Print info line
 */
export function renderInfo(text: string): void {
	console.log(`${c.dim}${text}${c.reset}`);
}

/**
 * Print benchmark title banner
 */
export function renderBenchmarkBanner(title: string, subtitle?: string): void {
	console.log(`\n${c.orange}${c.bold}${title}${c.reset}`);
	if (subtitle) {
		console.log(`${c.dim}${subtitle}${c.reset}`);
	}
	console.log();
}

/**
 * Print success message
 */
export function renderSuccess(message: string): void {
	console.log(`${c.green}${c.bold}✓ ${message}${c.reset}`);
}

/**
 * Print error message
 */
export function renderError(message: string): void {
	console.log(`${c.red}${c.bold}✗ ${message}${c.reset}`);
}
