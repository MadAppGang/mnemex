/**
 * TUI Root App Component
 *
 * Provides AppContext, tab navigation, global keyboard handling,
 * and renders the active view with StatusBar.
 */

import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { AppProvider, useAppContext, type TabId } from "./context.js";
import { TabBar } from "./components/TabBar.js";
import { StatusBar } from "./components/StatusBar.js";
import { HelpOverlay } from "./components/HelpOverlay.js";
import { ErrorBanner } from "./components/ErrorBanner.js";
import { SearchView } from "./views/SearchView.js";
import { MapView } from "./views/MapView.js";
import { GraphView } from "./views/GraphView.js";
import { AnalysisView } from "./views/AnalysisView.js";
import { DoctorView } from "./views/DoctorView.js";

// ============================================================================
// App Props
// ============================================================================

export interface AppProps {
	projectPath: string;
	quit: () => void;
}

// ============================================================================
// Inner App (inside context)
// ============================================================================

function AppInner() {
	const {
		activeTab,
		setActiveTab,
		showHelp,
		toggleHelp,
		error,
		setError,
		inputFocused,
		quit,
	} = useAppContext();
	const { height } = useTerminalDimensions();

	// Global keyboard handling - suppressed when an input field is focused
	useKeyboard((key) => {
		// Escape always works: unfocus input is handled by the view itself
		// Ctrl+C always works: handled by renderer exitOnCtrlC

		// When input is focused, only handle Escape and Tab (for tab switching)
		if (inputFocused) {
			// Tab still switches views even when typing
			if (key.name === "tab" && !key.shift) {
				const tabs: TabId[] = ["search", "map", "graph", "analysis", "doctor"];
				const idx = tabs.indexOf(activeTab);
				setActiveTab(tabs[(idx + 1) % tabs.length]);
				return;
			}
			if (key.name === "tab" && key.shift) {
				const tabs: TabId[] = ["search", "map", "graph", "analysis", "doctor"];
				const idx = tabs.indexOf(activeTab);
				setActiveTab(tabs[(idx - 1 + tabs.length) % tabs.length]);
				return;
			}
			// All other keys go to the focused input - don't intercept
			return;
		}

		// --- Below here: only when NO input is focused ---

		// Tab / Shift+Tab to cycle through tabs
		if (key.name === "tab" && !key.shift) {
			const tabs: TabId[] = ["search", "map", "graph", "analysis", "doctor"];
			const idx = tabs.indexOf(activeTab);
			setActiveTab(tabs[(idx + 1) % tabs.length]);
			return;
		}
		if (key.name === "tab" && key.shift) {
			const tabs: TabId[] = ["search", "map", "graph", "analysis", "doctor"];
			const idx = tabs.indexOf(activeTab);
			setActiveTab(tabs[(idx - 1 + tabs.length) % tabs.length]);
			return;
		}

		// Number shortcuts 1-5 to jump to tabs
		if (key.name === "1") {
			setActiveTab("search");
			return;
		}
		if (key.name === "2") {
			setActiveTab("map");
			return;
		}
		if (key.name === "3") {
			setActiveTab("graph");
			return;
		}
		if (key.name === "4") {
			setActiveTab("analysis");
			return;
		}
		if (key.name === "5") {
			setActiveTab("doctor");
			return;
		}

		// ? to toggle help
		if (key.name === "?") {
			toggleHelp();
			return;
		}

		// q to quit
		if (key.name === "q" && !key.ctrl && !key.meta) {
			quit();
		}
	});

	const mainHeight = height - 2; // subtract tab bar and status bar

	return (
		<box flexDirection="column" width="100%" height="100%">
			<TabBar />

			<box flexDirection="column" height={mainHeight} overflow="hidden">
				<ActiveView tab={activeTab} />
			</box>

			<StatusBar />

			{showHelp && <HelpOverlay view={activeTab} onClose={toggleHelp} />}

			{error && (
				<ErrorBanner message={error} onDismiss={() => setError(null)} />
			)}
		</box>
	);
}

// ============================================================================
// Active View Router
// ============================================================================

interface ActiveViewProps {
	tab: TabId;
}

function ActiveView({ tab }: ActiveViewProps) {
	switch (tab) {
		case "search":
			return <SearchView />;
		case "map":
			return <MapView />;
		case "graph":
			return <GraphView />;
		case "analysis":
			return <AnalysisView />;
		case "doctor":
			return <DoctorView />;
		default:
			return (
				<box flexDirection="column" width="100%" height="100%" padding={1}>
					<text fg="#6B7280">Unknown view: {tab}</text>
				</box>
			);
	}
}

// ============================================================================
// Root App Component
// ============================================================================

export function App({ projectPath, quit }: AppProps) {
	return (
		<AppProvider projectPath={projectPath} quit={quit}>
			<AppInner />
		</AppProvider>
	);
}
