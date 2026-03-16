/**
 * StatusBar Component
 *
 * Bottom bar showing project path + index status on the left
 * and context-sensitive keybinding hints on the right.
 * Also shows a live MCP activity indicator when in monitor mode.
 */

import { basename } from "node:path";
import { useEffect, useState } from "react";
import { CURRENT_INDEX_VERSION } from "../../core/index-version.js";
import { type TabId, useAppContext } from "../context.js";
import { theme } from "../theme.js";

// ============================================================================
// Keybinding Hints per View
// ============================================================================

const hints: Record<TabId, string> = {
	search: "/ search  j/k navigate  Enter expand  s symbol  ? help",
	map: "j/k navigate  Enter expand  Left collapse  s symbol  ? help",
	graph: "Tab:pane  Enter:drill  Backspace:back  ? help",
	analysis: "j/k navigate  Enter details  1-3 sub-tab  ? help",
	doctor: "j/k navigate  Enter select  r refresh  ? help",
};

// ============================================================================
// Relative Time Formatter
// ============================================================================

function formatRelativeTime(isoTimestamp: string): string {
	try {
		const elapsed = Math.floor(
			(Date.now() - new Date(isoTimestamp).getTime()) / 1000,
		);
		if (elapsed < 5) return "just now";
		if (elapsed < 60) return `${elapsed}s ago`;
		if (elapsed < 3600) return `${Math.floor(elapsed / 60)}m ago`;
		return `${Math.floor(elapsed / 3600)}h ago`;
	} catch {
		return "";
	}
}

// ============================================================================
// Component
// ============================================================================

export function StatusBar() {
	const { projectPath, activeTab, indexVersion, lastActivity, monitorMode } =
		useAppContext();
	const projectName = basename(projectPath);
	const isOutdated = indexVersion < CURRENT_INDEX_VERSION;

	// Re-render every 5 seconds to keep relative time accurate
	const [, setTick] = useState(0);
	useEffect(() => {
		if (!lastActivity) return;
		const interval = setInterval(() => setTick((t) => t + 1), 5000);
		return () => clearInterval(interval);
	}, [lastActivity]);

	const mcpIndicator = lastActivity
		? `MCP: ${lastActivity.type} ${formatRelativeTime(lastActivity.timestamp)}`
		: null;

	return (
		<box
			flexDirection="row"
			width="100%"
			height={1}
			justifyContent="space-between"
		>
			<box paddingLeft={1} flexDirection="row">
				<text fg={theme.muted}>{monitorMode ? "monitor" : projectName}</text>
				<text fg={theme.dimmed}> v{indexVersion}</text>
				{isOutdated && !monitorMode && (
					<text fg={theme.warning}>
						{" [outdated - run: mnemex index --force]"}
					</text>
				)}
				{mcpIndicator && <text fg={theme.info}>{`  ${mcpIndicator}`}</text>}
			</box>

			<box paddingRight={1}>
				<text fg={theme.dimmed}>
					{monitorMode ? "q quit  Esc back" : hints[activeTab]}
				</text>
			</box>
		</box>
	);
}
