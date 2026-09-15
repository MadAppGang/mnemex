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

import { existsSync, mkdirSync, statSync } from "node:fs";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useRef,
	useState,
} from "react";
import { getIndexVersion, needsUpgrade } from "../core/index-version.js";
import { Indexer } from "../core/indexer.js";
import {
	getIndexDbPathFor,
	resolveStoreLocation,
} from "../core/store-location.js";
import { FileTracker } from "../core/tracker.js";
import { ProgressStore } from "../output/progress-store.js";
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
	/** True when no index exists or the index is outdated */
	indexNeeded: boolean;
	/** Why the index is needed: "missing" or "outdated" */
	indexReason: "missing" | "outdated" | null;
	/** True while indexing is actively running */
	indexing: boolean;
	/** ProgressStore for the active indexing run (null when not indexing) */
	progressStore: ProgressStore | null;
	/** Trigger the indexing process */
	startIndexing: () => void;
}

// ============================================================================
// Context
// ============================================================================

const AppContext = createContext<AppContextValue | null>(null);

// ============================================================================
// Index Detection
// ============================================================================

/**
 * Returns why the index is needed, or null if the index is ready.
 * Checks for the DB file existence/size and version.
 */
function checkIndexReason(projectPath: string): "missing" | "outdated" | null {
	// The seam's index.db, so an overridden store is found (decision I-8).
	const dbPath = getIndexDbPathFor(resolveStoreLocation(projectPath));
	if (!existsSync(dbPath)) return "missing";
	try {
		const stat = statSync(dbPath);
		if (stat.size < 1024) return "missing"; // basically empty
	} catch {
		return "missing";
	}
	if (needsUpgrade(resolveStoreLocation(projectPath))) return "outdated";
	return null;
}

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
	const [indexVersion, setIndexVersion] = useState(() =>
		getIndexVersion(resolveStoreLocation(projectPath)),
	);
	const [lastActivity, setLastActivity] = useState<ActivityRecord | null>(null);
	const [indexReason, setIndexReason] = useState(() =>
		checkIndexReason(projectPath),
	);
	const indexNeeded = indexReason !== null;
	const [indexing, setIndexing] = useState(false);
	const [progressStore, setProgressStore] = useState<ProgressStore | null>(
		null,
	);
	// Keep a stable ref to avoid stale closure issues in startIndexing
	const progressStoreRef = useRef<ProgressStore | null>(null);

	// Create FileTracker singleton — memoized so it survives re-renders.
	// Without memoization, every state change creates a new tracker instance,
	// which cascades through useCallback/useEffect dependencies and causes
	// useActivityMonitor to re-run (truncating JSONL + resetting byte offsets).
	//
	// The directory and its index.db come from ONE resolved location, the
	// seam's, as for every other reader (decision I-8): MNEMEX_INDEX_DIR and
	// ProjectConfig.indexDir move both. A hand-built `<project>/.mnemex` opened
	// an EMPTY tracker whenever either was set, and left a stray index.db behind.
	const [tracker] = useState(() => {
		const loc = resolveStoreLocation(projectPath);
		if (!existsSync(loc.storeDir)) {
			mkdirSync(loc.storeDir, { recursive: true });
		}
		return new FileTracker(getIndexDbPathFor(loc), projectPath);
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

	const startIndexing = useCallback(() => {
		if (indexing) return;

		const store = new ProgressStore();
		progressStoreRef.current = store;
		setProgressStore(store);
		setIndexing(true);

		const indexer = new Indexer({
			projectPath,
			onProgress: (current, total, detail, inProgress) => {
				store.update(current, total, detail, inProgress);
			},
		});

		indexer
			.index(true)
			.then(() => {
				store.finish();
				// Re-read the version from config after indexing completes
				setIndexVersion(getIndexVersion(resolveStoreLocation(projectPath)));
				setIndexReason(null);
				setIndexing(false);
			})
			.catch((err: unknown) => {
				store.finish();
				setIndexing(false);
				setError(err instanceof Error ? err.message : "Indexing failed");
			});
	}, [indexing, projectPath]);

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
		indexNeeded,
		indexReason,
		indexing,
		progressStore,
		startIndexing,
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
