/**
 * StatusMessage
 *
 * Renders a single-line status notification with an icon and colored text.
 * Used as a footer row inside CommandOutputApp for success/error/info/warning
 * messages at the end of a command's output.
 *
 * Examples:
 *   ✓ Indexed 42 files in 3.2s
 *   ✗ Failed to connect to embedding API
 *   ℹ No index found — run: mnemex index
 *   ⚠ Index is outdated, re-run: mnemex index --force
 */

import { theme } from "../../theme.js";

// ============================================================================
// Types
// ============================================================================

export type StatusType = "success" | "error" | "info" | "warning";

// ============================================================================
// Props
// ============================================================================

export interface StatusMessageProps {
	/** Visual severity level — controls icon and text color */
	type: StatusType;
	/** The message to display */
	message: string;
}

// ============================================================================
// Helpers
// ============================================================================

/** Map message type to leading icon character */
const ICONS: Record<StatusType, string> = {
	success: "✓",
	error: "✗",
	info: "ℹ",
	warning: "⚠",
};

/** Map message type to theme color */
const COLORS: Record<StatusType, string> = {
	success: theme.success,
	error: theme.error,
	info: theme.info,
	warning: theme.warning,
};

// ============================================================================
// Component
// ============================================================================

/**
 * Inline status line: icon + message in the appropriate color.
 *
 * Uses <text> with nested <span> so that the icon and message share
 * the same text renderable (no layout gaps between them).
 */
export function StatusMessage({ type, message }: StatusMessageProps) {
	const icon = ICONS[type];
	const color = COLORS[type];

	return (
		<box flexDirection="row" paddingTop={1}>
			<text>
				<span fg={color}>{`${icon} ${message}`}</span>
			</text>
		</box>
	);
}
