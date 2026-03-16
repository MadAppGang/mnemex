/**
 * MetricsTable
 *
 * Reusable tabular data display for benchmark metrics.
 * Supports optional green/red highlighting for best/worst values.
 *
 * Columns define: header, width, data key, optional formatter, and highlight mode.
 * Rows are plain Record<string, any> objects.
 */

import { theme } from "../../theme.js";

// ============================================================================
// Types
// ============================================================================

export interface MetricsColumn {
	/** Column header text */
	header: string;
	/** Display width in characters */
	width: number;
	/** Key to look up in row data */
	key: string;
	/** Optional custom formatter. Receives (value, row) */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	format?: (val: any, row: any) => string;
	/**
	 * Highlight mode:
	 *   'higher-better' — green for max, red for min
	 *   'lower-better'  — green for min, red for max (latency, cost, rounds)
	 *   'none'          — no color differentiation
	 */
	highlight?: "higher-better" | "lower-better" | "none";
}

export interface MetricsTableProps {
	columns: MetricsColumn[];
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	rows: Array<Record<string, any>>;
	/** When true, highlight best/worst per column (only useful with >1 row) */
	shouldHighlight?: boolean;
}

// ============================================================================
// Helpers
// ============================================================================

/** Pad or truncate a string to exactly `width` characters */
function pad(s: string, width: number): string {
	if (s.length >= width) return s.slice(0, width);
	return s + " ".repeat(width - s.length);
}

// ============================================================================
// CellText Component
// ============================================================================

interface CellTextProps {
	text: string;
	isMax: boolean;
	isMin: boolean;
	highlight: "higher-better" | "lower-better" | "none";
	shouldHighlight: boolean;
}

function CellText({
	text,
	isMax,
	isMin,
	highlight,
	shouldHighlight,
}: CellTextProps) {
	if (!shouldHighlight || highlight === "none") {
		return <text fg={theme.text}>{text}</text>;
	}

	if (highlight === "higher-better") {
		if (isMax) return <text fg={theme.success}>{text}</text>;
		if (isMin) return <text fg={theme.error}>{text}</text>;
		return <text fg={theme.text}>{text}</text>;
	}

	// lower-better: green = min (best), red = max (worst)
	if (isMin) return <text fg={theme.success}>{text}</text>;
	if (isMax) return <text fg={theme.error}>{text}</text>;
	return <text fg={theme.text}>{text}</text>;
}

// ============================================================================
// MetricsTable Component
// ============================================================================

const round = (v: number) => Math.round(v * 1000) / 1000;

export function MetricsTable({
	columns,
	rows,
	shouldHighlight = false,
}: MetricsTableProps) {
	// Pre-compute numeric min/max per column for highlighting
	const colStats = columns.map((col) => {
		if (col.highlight === "none" || !shouldHighlight) {
			return { min: 0, max: 0 };
		}
		const nums = rows
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			.map((r: Record<string, any>) => {
				const raw = r[col.key];
				return typeof raw === "number" ? raw : NaN;
			})
			.filter((v: number) => !isNaN(v) && v > 0);
		if (nums.length === 0) return { min: 0, max: 0 };
		return {
			min: round(Math.min(...nums)),
			max: round(Math.max(...nums)),
		};
	});

	// Build header row string
	const headerStr =
		"  " + columns.map((col) => pad(col.header, col.width)).join(" ");

	// Build separator row string
	const separatorStr =
		"  " + columns.map((col) => "─".repeat(col.width - 1)).join(" ");

	return (
		<box flexDirection="column">
			{/* Header */}
			<box height={1}>
				<text fg={theme.muted}>{headerStr}</text>
			</box>

			{/* Separator */}
			<box height={1}>
				<text fg={theme.dimmed}>{separatorStr}</text>
			</box>

			{/* Data rows */}
			{rows.map((row, rowIdx) => {
				// Build cell strings and determine highlight status
				const cells = columns.map((col, colIdx) => {
					const raw = row[col.key];
					const formatted = col.format
						? col.format(raw, row)
						: String(raw ?? "N/A");
					const padded = pad(formatted, col.width);

					const numVal =
						typeof raw === "number" && !isNaN(raw) && raw > 0 ? raw : NaN;
					const stats = colStats[colIdx];
					const isMax =
						!isNaN(numVal) &&
						round(numVal) === stats.max &&
						stats.min !== stats.max;
					const isMin =
						!isNaN(numVal) &&
						round(numVal) === stats.min &&
						stats.min !== stats.max;

					return {
						text: padded,
						isMax,
						isMin,
						highlight: col.highlight ?? "none",
					};
				});

				return (
					<box key={rowIdx} flexDirection="row" height={1}>
						<text fg={theme.text}>{"  "}</text>
						{cells.map((cell, cellIdx) => (
							<CellText
								key={cellIdx}
								text={cell.text + (cellIdx < cells.length - 1 ? " " : "")}
								isMax={cell.isMax}
								isMin={cell.isMin}
								highlight={
									cell.highlight as "higher-better" | "lower-better" | "none"
								}
								shouldHighlight={shouldHighlight}
							/>
						))}
					</box>
				);
			})}
		</box>
	);
}
