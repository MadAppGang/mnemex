/**
 * KeyListView — displays API keys in a table with keyboard navigation.
 *
 * Shortcuts:
 *   j / ArrowDown  — move selection down
 *   k / ArrowUp    — move selection up
 *   n              — create new key
 *   d              — delete selected key
 *   r              — refresh
 *   q              — quit
 */

import { useKeyboard } from "@opentui/react";
import type { ApiKey } from "./AdminApiClient.js";
import { theme } from "../theme.js";

// ============================================================================
// Types
// ============================================================================

export interface KeyListViewProps {
	endpoint: string;
	keys: ApiKey[];
	selectedIndex: number;
	loading: boolean;
	error: string | null;
	onSelect: (index: number) => void;
	onNew: () => void;
	onDelete: () => void;
	onRefresh: () => void;
	onQuit: () => void;
}

// ============================================================================
// Helpers
// ============================================================================

function formatDate(iso: string | null): string {
	if (!iso) return "never";
	const d = new Date(iso);
	return d.toLocaleDateString("en-US", {
		month: "short",
		day: "2-digit",
		year: "numeric",
	});
}

// ============================================================================
// Sub-components
// ============================================================================

/** btop-style footer shortcut item: [key] label */
function ShortcutItem({ letter, label }: { letter: string; label: string }) {
	return (
		<box flexDirection="row">
			<text fg={theme.shortcutBracket}>{"["}</text>
			<text fg={theme.shortcutKey}>{letter}</text>
			<text fg={theme.shortcutBracket}>{"]"}</text>
			<text fg={theme.muted}>{` ${label}  `}</text>
		</box>
	);
}

// ============================================================================
// Component
// ============================================================================

export function KeyListView({
	endpoint,
	keys,
	selectedIndex,
	loading,
	error,
	onSelect,
	onNew,
	onDelete,
	onRefresh,
	onQuit,
}: KeyListViewProps) {
	useKeyboard((key) => {
		if (key.name === "j" || key.name === "down") {
			onSelect(Math.min(selectedIndex + 1, keys.length - 1));
			return;
		}
		if (key.name === "k" || key.name === "up") {
			onSelect(Math.max(selectedIndex - 1, 0));
			return;
		}
		if (key.name === "n") {
			onNew();
			return;
		}
		if (key.name === "d" && keys.length > 0) {
			onDelete();
			return;
		}
		if (key.name === "r") {
			onRefresh();
			return;
		}
		if (key.name === "q") {
			onQuit();
			return;
		}
	});

	// Logo lines: CLAUDE part (orange) + MEM part (green)
	const logoLines = [
		["   ██████╗██╗      █████╗ ██╗   ██╗██████╗ ███████╗", "███╗   ███╗███████╗███╗   ███╗"],
		["  ██╔════╝██║     ██╔══██╗██║   ██║██╔══██╗██╔════╝", "████╗ ████║██╔════╝████╗ ████║"],
		["  ██║     ██║     ███████║██║   ██║██║  ██║█████╗  ", "██╔████╔██║█████╗  ██╔████╔██║"],
		["  ██║     ██║     ██╔══██║██║   ██║██║  ██║██╔══╝  ", "██║╚██╔╝██║██╔══╝  ██║╚██╔╝██║"],
		["  ╚██████╗███████╗██║  ██║╚██████╔╝██████╔╝███████╗", "██║ ╚═╝ ██║███████╗██║ ╚═╝ ██║"],
		["   ╚═════╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚══════╝", "╚═╝     ╚═╝╚══════╝╚═╝     ╚═╝"],
	];

	const keyCount = keys.length;
	const countLabel = keyCount === 1 ? "1 key" : `${keyCount} keys`;

	// Column widths (characters)
	const COL_NAME = 20;
	const COL_PREF = 10;
	const COL_CREATED = 13;
	const COL_LASTUSED = 13;

	const headerRow =
		"NAME".padEnd(COL_NAME) +
		"PREFIX".padEnd(COL_PREF) +
		"CREATED".padEnd(COL_CREATED) +
		"LAST USED".padEnd(COL_LASTUSED) +
		"REQ";

	const dividerRow =
		"─".repeat(COL_NAME - 1).padEnd(COL_NAME) +
		"─".repeat(COL_PREF - 1).padEnd(COL_PREF) +
		"─".repeat(COL_CREATED - 1).padEnd(COL_CREATED) +
		"─".repeat(COL_LASTUSED - 1).padEnd(COL_LASTUSED) +
		"───";

	return (
		<box flexDirection="column" width="100%" height="100%">
			{/* Logo */}
			<box flexDirection="column" paddingTop={1} paddingBottom={0}>
				{logoLines.map((parts, i) => (
					<box key={i} flexDirection="row">
						<text fg="#e67e22">{parts[0]}</text>
						<text fg="#2ecc71">{parts[1]}</text>
					</box>
				))}
			</box>

			{/* btop-style titled header bar */}
			<box flexDirection="row" paddingLeft={1} paddingTop={1} paddingBottom={0}>
				<text fg={theme.borderDim}>{"┌─"}</text>
				<text fg={theme.primary}>{" Admin "}</text>
				<text fg={theme.borderDim}>{"─"}</text>
				<text fg={theme.muted}>{" API Keys "}</text>
				<text fg={theme.borderDim}>{"─"}</text>
				<text fg={theme.labelDim}>{` ${endpoint} `}</text>
				<text fg={theme.borderDim}>{"─"}</text>
				<text fg={theme.dimmed}>{` ${countLabel} `}</text>
				<text fg={theme.borderDim}>{"─┐"}</text>
			</box>

			{/* Column headers */}
			<box paddingLeft={3} paddingRight={2} paddingTop={1}>
				<text fg={theme.labelDim}>{`  ${headerRow}`}</text>
			</box>
			<box paddingLeft={3} paddingRight={2}>
				<text fg={theme.borderDim}>{`  ${dividerRow}`}</text>
			</box>

			{/* Error banner */}
			{error && (
				<box paddingLeft={3} paddingTop={1}>
					<text fg={theme.error}>{"  ! "}</text>
					<text fg={theme.dangerText}>{error}</text>
				</box>
			)}

			{/* Loading */}
			{loading && (
				<box paddingLeft={3} paddingTop={1}>
					<text fg={theme.muted}>{"  loading..."}</text>
				</box>
			)}

			{/* Empty state */}
			{!loading && keys.length === 0 && !error && (
				<box paddingLeft={3} paddingTop={1}>
					<text fg={theme.dimmed}>{"  No API keys — press "}</text>
					<text fg={theme.shortcutKey}>{"[n]"}</text>
					<text fg={theme.dimmed}>{" to create one."}</text>
				</box>
			)}

			{/* Key rows */}
			{keys.map((k, i) => {
				const isSelected = i === selectedIndex;
				const name = k.name.padEnd(COL_NAME).slice(0, COL_NAME);
				const prefix = k.prefix.padEnd(COL_PREF);
				const created = formatDate(k.createdAt).padEnd(COL_CREATED);
				const lastUsed = formatDate(k.lastUsedAt).padEnd(COL_LASTUSED);
				const requests = String(k.usage.total).padStart(3);

				if (isSelected) {
					return (
						<box key={k.id} paddingLeft={3} paddingRight={2} flexDirection="row">
							<text fg={theme.primary}>{">"}</text>
							<text fg={theme.valueBright}>{" "}</text>
							<text fg={theme.primary}>{name}</text>
							<text fg={theme.accentCyan}>{prefix}</text>
							<text fg={theme.text}>{created}</text>
							<text fg={theme.muted}>{lastUsed}</text>
							<text fg={theme.valueBright}>{requests}</text>
						</box>
					);
				}

				return (
					<box key={k.id} paddingLeft={3} paddingRight={2} flexDirection="row">
						<text fg={theme.dimmed}>{" "}</text>
						<text fg={theme.text}>{" "}</text>
						<text fg={theme.text}>{name}</text>
						<text fg={theme.muted}>{prefix}</text>
						<text fg={theme.dimmed}>{created}</text>
						<text fg={theme.dimmed}>{lastUsed}</text>
						<text fg={theme.muted}>{requests}</text>
					</box>
				);
			})}

			{/* Spacer */}
			<box flexGrow={1} />

			{/* btop-style footer bar */}
			<box flexDirection="row" paddingLeft={1} paddingBottom={1}>
				<text fg={theme.borderDim}>{"└─ "}</text>
				<ShortcutItem letter="n" label="new" />
				<ShortcutItem letter="d" label="delete" />
				<ShortcutItem letter="r" label="refresh" />
				<ShortcutItem letter="j/k" label="navigate" />
				<ShortcutItem letter="q" label="quit" />
				<text fg={theme.borderDim}>{" ─┘"}</text>
			</box>
		</box>
	);
}
