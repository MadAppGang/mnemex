/**
 * HelpOverlay Component
 *
 * Modal showing keybindings for the current view.
 * Shown when user presses ?.
 */

import type { TabId } from "../context.js";
import { theme } from "../theme.js";

// ============================================================================
// Keybinding Definitions
// ============================================================================

interface Keybinding {
	key: string;
	description: string;
}

const globalBindings: Keybinding[] = [
	{ key: "1-5", description: "Jump to tab" },
	{ key: "Tab / Shift+Tab", description: "Next / prev tab" },
	{ key: "q", description: "Quit" },
	{ key: "?", description: "Toggle this help" },
];

const viewBindings: Record<TabId, Keybinding[]> = {
	search: [
		{ key: "/", description: "Focus search input" },
		{ key: "j / k", description: "Move selection down / up" },
		{ key: "Enter", description: "Expand/collapse result" },
		{ key: "s", description: "Navigate to Graph view for symbol" },
		{ key: "Ctrl+H", description: "Query history" },
	],
	map: [
		{ key: "j / k", description: "Navigate down / up" },
		{ key: "Enter / Right", description: "Expand directory or file" },
		{ key: "Left", description: "Collapse current node" },
		{ key: "s", description: "Navigate to Graph for symbol" },
		{ key: "c", description: "Show callers panel" },
		{ key: "Ctrl+F", description: "Focus filter input" },
		{ key: "g / G", description: "Jump to top / bottom" },
	],
	graph: [
		{
			key: "Tab",
			description: "Cycle active pane (Callers -> Def -> Callees)",
		},
		{ key: "Enter", description: "Drill into symbol" },
		{ key: "Backspace / Alt+Left", description: "Go back" },
		{ key: "Alt+Right", description: "Go forward" },
		{ key: "v", description: "Toggle code preview" },
		{ key: "i", description: "Go to Analysis > Impact for this symbol" },
		{ key: "x", description: "Toggle context mode" },
	],
	analysis: [
		{ key: "1", description: "Dead Code sub-view" },
		{ key: "2", description: "Test Gaps sub-view" },
		{ key: "3", description: "Impact sub-view" },
		{ key: "j / k", description: "Navigate results" },
		{ key: "Enter", description: "View symbol details" },
		{ key: "Ctrl+E", description: "Export results" },
	],
	doctor: [
		{ key: "j / k", description: "Navigate files" },
		{ key: "Enter", description: "Select file for detail" },
		{ key: "r", description: "Refresh diagnostics" },
		{ key: "g", description: "Generate optimized CLAUDE.md" },
	],
};

// ============================================================================
// Props
// ============================================================================

export interface HelpOverlayProps {
	view: TabId;
	onClose: () => void;
}

// ============================================================================
// Binding Row Component
// ============================================================================

interface BindingRowProps {
	keyText: string;
	description: string;
}

function BindingRow({ keyText, description }: BindingRowProps) {
	return (
		<box flexDirection="row" paddingLeft={2} height={1}>
			<text fg={theme.primary} width={24}>
				{keyText}
			</text>
			<text fg={theme.text}>{description}</text>
		</box>
	);
}

// ============================================================================
// Component
// ============================================================================

export function HelpOverlay({ view, onClose }: HelpOverlayProps) {
	const viewLabel = view.charAt(0).toUpperCase() + view.slice(1);

	return (
		<box
			position="absolute"
			top={2}
			left={4}
			width={60}
			flexDirection="column"
			borderStyle="double"
			padding={1}
		>
			<box paddingBottom={1}>
				<text fg={theme.primary}>{"Keybindings - " + viewLabel + " View"}</text>
			</box>

			<box paddingBottom={1}>
				<text fg={theme.muted}>Global</text>
			</box>
			{globalBindings.map((b) => (
				<box key={b.key}>
					<BindingRow keyText={b.key} description={b.description} />
				</box>
			))}

			<box paddingTop={1} paddingBottom={1}>
				<text fg={theme.muted}>{viewLabel + " View"}</text>
			</box>
			{viewBindings[view].map((b) => (
				<box key={b.key}>
					<BindingRow keyText={b.key} description={b.description} />
				</box>
			))}

			<box paddingTop={1}>
				<text fg={theme.dimmed}>Press ? or Esc to close</text>
			</box>
		</box>
	);
}
