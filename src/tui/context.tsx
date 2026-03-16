/**
 * TUI App Context
 *
 * Provides shared state for the entire TUI application:
 * - FileTracker singleton
 * - Active tab
 * - Navigation history (for graph drill-in/back)
 * - Error state
 * - Last MCP activity (for StatusBar monitor indicator)
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
	type ReactNode,
	createContext,
	useCallback,
	useContext,
	useState,
} from "react";
import { getIndexVersion } from "../core/index-version.js";
import { FileTracker } from "../core/tracker.js";
import {
	type ActivityRecord,
	useActivityMonitor,
} from "./hooks/useActivityMonitor.js";

// ============================================================================
// Types
// ============================================================================

export type TabId = "search" | "map" | "graph" | "analysis" | "doctor";

export interface AppContextValue {
	/** FileTracker singleton for the current project */
	tracker: FileTracker;
	/** The project root path */
	projectPath: string;
	/** Currently active tab */
	activeTab: TabId;
	/** Switch to a different tab */
	setActiveTab: (tab: TabId) => void;
	/** Navigation history for graph drill-in */
	navHistory: string[];
	/** Push a symbol name to navigation history */
	pushNav: (symbolName: string) => void;
	/** Go back in navigation history */
	popNav: () => string | undefined;
	/** Current error message, if any */
	error: string | null;
	/** Set global error message */
	setError: (msg: string | null) => void;
	/** Whether help overlay is visible */
	showHelp: boolean;
	/** Toggle help overlay */
	toggleHelp: () => void;
	/** Whether an input field is focused (suppresses global shortcuts) */
	inputFocused: boolean;
	/** Set input focus state */
	setInputFocused: (focused: boolean) => void;
	/** Index format version (1 = legacy, 2 = with code units) */
	indexVersion: number;
	/** Cleanly shut down the TUI (unmount + renderer destroy) */
	quit: () => void;
	/** Most recent MCP activity record — used by StatusBar indicator */
	lastActivity: ActivityRecord | null;
	/** Whether running in passive monitor mode (affects StatusBar hints) */
	monitorMode: boolean;
}

// ============================================================================
// Context
// ============================================================================

const AppContext = createContext<AppContextValue | null>(null);

// ============================================================================
// Provider
// ============================================================================

export interface AppProviderProps {
	projectPath: string;
	quit: () => void;
	monitorMode?: boolean;
	children: ReactNode;
}

export function AppProvider({
	projectPath,
	quit,
	monitorMode = false,
	children,
}: AppProviderProps) {
	const [activeTab, setActiveTab] = useState<TabId>("search");
	const [navHistory, setNavHistory] = useState<string[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [showHelp, setShowHelp] = useState(false);
	const [inputFocused, setInputFocused] = useState(false);
	const [indexVersion] = useState(() => getIndexVersion(projectPath));
	const [lastActivity, setLastActivity] = useState<ActivityRecord | null>(null);

	// Create FileTracker singleton — memoized so it survives re-renders.
	// Without memoization, every state change creates a new tracker instance,
	// which cascades through useCallback/useEffect dependencies and causes
	// useActivityMonitor to re-run (truncating JSONL + resetting byte offsets).
	const [tracker] = useState(() => {
		const dbDir = join(projectPath, ".mnemex");
		if (!existsSync(dbDir)) {
			mkdirSync(dbDir, { recursive: true });
		}
		const dbPath = join(dbDir, "index.db");
		return new FileTracker(dbPath, projectPath);
	});

	const pushNav = useCallback((symbolName: string) => {
		setNavHistory((prev: string[]) => [...prev, symbolName]);
	}, []);

	const popNav = useCallback((): string | undefined => {
		let popped: string | undefined;
		setNavHistory((prev: string[]) => {
			const copy = [...prev];
			popped = copy.pop();
			return copy;
		});
		return popped;
	}, []);

	const toggleHelp = useCallback(() => {
		setShowHelp((prev: boolean) => !prev);
	}, []);

	// In UI mode, activity monitor only updates the StatusBar indicator
	const handleActivity = useCallback((record: ActivityRecord) => {
		setLastActivity(record);
	}, []);

	// Mount the activity monitor (feeds StatusBar in UI mode)
	useActivityMonitor(projectPath, tracker, handleActivity);

	const value: AppContextValue = {
		tracker,
		projectPath,
		activeTab,
		setActiveTab,
		navHistory,
		pushNav,
		popNav,
		error,
		setError,
		showHelp,
		toggleHelp,
		inputFocused,
		setInputFocused,
		indexVersion,
		quit,
		lastActivity,
		monitorMode,
	};

	return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

// ============================================================================
// Hook
// ============================================================================

export function useAppContext(): AppContextValue {
	const ctx = useContext(AppContext);
	if (!ctx) {
		throw new Error("useAppContext must be used inside AppProvider");
	}
	return ctx;
}
