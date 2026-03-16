/**
 * TabBar Component
 *
 * Top navigation bar showing 5 tabs with number shortcuts.
 * Active tab highlighted with primary orange color.
 */

import { useAppContext, type TabId } from "../context.js";
import { theme } from "../theme.js";

// ============================================================================
// Tab Definitions
// ============================================================================

interface TabDef {
	id: TabId;
	label: string;
	shortcut: string;
}

const TABS: TabDef[] = [
	{ id: "search", label: "Search", shortcut: "1" },
	{ id: "map", label: "Map", shortcut: "2" },
	{ id: "graph", label: "Graph", shortcut: "3" },
	{ id: "analysis", label: "Analysis", shortcut: "4" },
	{ id: "doctor", label: "Doctor", shortcut: "5" },
];

// ============================================================================
// Component
// ============================================================================

export function TabBar() {
	const { activeTab, setActiveTab } = useAppContext();

	return (
		<box
			flexDirection="row"
			width="100%"
			height={1}
			justifyContent="space-between"
		>
			<box flexDirection="row">
				{TABS.map((tab, i) => {
					const isActive = tab.id === activeTab;
					return (
						<box
							key={tab.id}
							flexDirection="row"
							paddingLeft={i === 0 ? 1 : 2}
							paddingRight={2}
						>
							{isActive ? (
								<text fg={theme.tabActive}>{"[" + tab.label + "]"}</text>
							) : (
								<text fg={theme.tabInactive}>{" " + tab.label + " "}</text>
							)}
						</box>
					);
				})}
			</box>

			<box paddingRight={1}>
				<text fg={theme.muted}>q:quit ?:help Tab:next</text>
			</box>
		</box>
	);
}
