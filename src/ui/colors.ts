/**
 * Terminal Color Constants
 *
 * Shared color definitions for consistent CLI styling across all benchmark tools.
 */

/** ANSI escape codes for terminal colors */
export const colors = {
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	dim: "\x1b[2m",

	// Primary colors
	red: "\x1b[31m",
	green: "\x1b[38;5;78m",
	yellow: "\x1b[33m",
	cyan: "\x1b[36m",
	magenta: "\x1b[35m",
	purple: "\x1b[38;5;141m",
	orange: "\x1b[38;5;209m",
	gray: "\x1b[90m",

	// Semantic aliases
	success: "\x1b[38;5;78m",
	error: "\x1b[31m",
	warning: "\x1b[33m",
	info: "\x1b[36m",
	highlight: "\x1b[38;5;209m",
} as const;

/** Shorthand for colors (for compact code) */
export const c = colors;

/**
 * Apply color to text
 */
export function colorize(text: string, color: keyof typeof colors): string {
	return `${colors[color]}${text}${colors.reset}`;
}

/**
 * Apply multiple styles
 */
export function styled(
	text: string,
	...styles: (keyof typeof colors)[]
): string {
	const prefix = styles.map((s) => colors[s]).join("");
	return `${prefix}${text}${colors.reset}`;
}
