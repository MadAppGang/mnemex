/**
 * TUI Theme
 *
 * Color constants and style configuration for the terminal UI.
 * Matches the existing ui/colors.ts palette (orange branding).
 */

// ============================================================================
// Color Palette
// ============================================================================

export const theme = {
	// Brand colors
	primary: "#FF8C57", // orange (matches existing branding)
	secondary: "#8B5CF6", // purple
	success: "#4ADE80", // green
	error: "#EF4444", // red
	warning: "#FBBF24", // yellow
	info: "#22D3EE", // cyan
	muted: "#6B7280", // gray
	text: "#E5E7EB", // light gray
	bg: "#1A1A2E", // dark background
	border: "#374151", // border gray
	highlight: "#FF8C57", // same as primary
	dimmed: "#4B5563", // darker gray for inactive elements
	selected: "#1E3A5F", // dark blue for selected items
	tabActive: "#FF8C57", // active tab color
	tabInactive: "#6B7280", // inactive tab color

	// btop-inspired additions
	borderDim: "#2D3748", // very dim border for secondary panels
	labelDim: "#4A5568", // dim label color (column headers etc.)
	valueBright: "#F9FAFB", // bright white for key values
	accentCyan: "#22D3EE", // accent for highlights
	accentGreen: "#4ADE80", // accent for success/active
	selectedBright: "#E5E7EB", // bright text when selected
	headerBg: "#0F172A", // very dark bg for header areas
	dangerBorder: "#7F1D1D", // dark red border for danger dialogs
	dangerText: "#FCA5A5", // soft red for danger text
	secretBright: "#FCD34D", // bright amber for secrets (stands out)
	shortcutKey: "#FF8C57", // orange for shortcut letters
	shortcutBracket: "#374151", // dim for shortcut brackets
} as const;

// ============================================================================
// Score Bar Configuration
// ============================================================================

/** Characters used to render the score bar */
export const scoreBarChars = {
	filled: "\u2588", // █
	empty: "\u2591", // ░
	half: "\u2584", // ▄
} as const;

/** Get color for a score 0-1 */
export function getScoreColor(score: number): string {
	if (score >= 0.7) return theme.success;
	if (score >= 0.4) return theme.warning;
	return theme.error;
}

// ============================================================================
// Border Styles
// ============================================================================

export type BorderStyle = "rounded" | "single" | "double" | "none";

export const borderStyles = {
	panel: "rounded" as BorderStyle,
	input: "single" as BorderStyle,
	overlay: "double" as BorderStyle,
} as const;

// ============================================================================
// Layout Constants
// ============================================================================

export const layout = {
	tabBarHeight: 1,
	statusBarHeight: 1,
	inputHeight: 1,
	minWidth: 80,
	wideWidth: 120, // threshold for wide layout
} as const;
