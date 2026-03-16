/**
 * Monitor Mode App
 *
 * Passive display that auto-updates when Claude Code uses mnemex MCP tools.
 * Unlike the interactive UI mode, monitor mode has no manual input — everything
 * is driven by activity recorded by the MCP server.
 *
 * Usage: mnemex monitor [path]
 */

import { useState, useCallback } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { AppProvider, useAppContext } from "./context.js";
import { ResultDetailView } from "./components/ResultDetailView.js";
import { StatusBar } from "./components/StatusBar.js";
import {
	type ActivityRecord,
	useActivityMonitor,
} from "./hooks/useActivityMonitor.js";
import { theme } from "./theme.js";
import type { SearchResult } from "../types.js";

// ============================================================================
// Monitor Inner (inside AppContext)
// ============================================================================

function MonitorInner() {
	const { tracker, projectPath, quit } = useAppContext();
	const { height } = useTerminalDimensions();

	const [currentResult, setCurrentResult] = useState<SearchResult | null>(null);
	const [activityInfo, setActivityInfo] = useState<{
		type: string;
		metadata: Record<string, unknown>;
		timestamp: string;
	} | null>(null);

	// Handle incoming activity — extract search result for direct rendering
	const handleActivity = useCallback((record: ActivityRecord) => {
		setActivityInfo({
			type: record.type,
			metadata: record.metadata,
			timestamp: record.timestamp,
		});

		if (record.type === "search_code" && record.metadata.topResult) {
			const top = record.metadata.topResult as any;
			if (top && top.chunk) {
				setCurrentResult({
					chunk: top.chunk,
					score: top.score ?? 0,
					vectorScore: top.vectorScore ?? 0,
					keywordScore: top.keywordScore ?? 0,
					summary: top.summary,
					fileSummary: top.fileSummary,
				});
			}
		}
	}, []);

	useActivityMonitor(projectPath, tracker, handleActivity);

	// q or Ctrl+C to quit
	useKeyboard((key) => {
		if (key.name === "q" && !key.ctrl && !key.meta) {
			quit();
		}
	});

	const mainHeight = height - 1; // subtract StatusBar

	return (
		<box flexDirection="column" width="100%" height="100%">
			<box flexDirection="column" height={mainHeight} overflow="hidden">
				{currentResult ? (
					<ResultDetailView
						result={currentResult}
						onClose={() => setCurrentResult(null)}
					/>
				) : (
					<WaitingView activityInfo={activityInfo} />
				)}
			</box>
			<StatusBar />
		</box>
	);
}

// ============================================================================
// Waiting View (shown when no search result to display)
// ============================================================================

function WaitingView({
	activityInfo,
}: {
	activityInfo: {
		type: string;
		metadata: Record<string, unknown>;
		timestamp: string;
	} | null;
}) {
	const { width, height } = useTerminalDimensions();

	if (activityInfo && activityInfo.type !== "search_code") {
		// Show non-search activity summary
		return (
			<box flexDirection="column" width="100%" height="100%" padding={2}>
				<box height={1}>
					<text fg={theme.primary}>{"  mnemex monitor"}</text>
				</box>
				<box height={1} />
				<box height={1}>
					<text fg={theme.info}>{`  Last activity: ${activityInfo.type}`}</text>
				</box>
				<box height={1}>
					<text fg={theme.muted}>
						{`  ${formatActivitySummary(activityInfo.type, activityInfo.metadata)}`}
					</text>
				</box>
				<box height={1} />
				<box height={1}>
					<text fg={theme.dimmed}>
						{"  Waiting for search_code to display detail view..."}
					</text>
				</box>
				<box height={1} />
				<box height={1}>
					<text fg={theme.dimmed}>{"  Press q to quit"}</text>
				</box>
			</box>
		);
	}

	return (
		<box flexDirection="column" width="100%" height="100%" padding={2}>
			<box height={1}>
				<text fg={theme.primary}>{"  mnemex monitor"}</text>
			</box>
			<box height={1} />
			<box height={1}>
				<text fg={theme.muted}>
					{"  Waiting for Claude Code to use mnemex..."}
				</text>
			</box>
			<box height={1} />
			<box height={1}>
				<text fg={theme.dimmed}>
					{"  This display updates automatically when Claude Code calls"}
				</text>
			</box>
			<box height={1}>
				<text fg={theme.dimmed}>
					{"  search_code, analyze_impact, or other MCP tools."}
				</text>
			</box>
			<box height={1} />
			<box height={1}>
				<text fg={theme.dimmed}>{"  Press q to quit"}</text>
			</box>
		</box>
	);
}

function formatActivitySummary(
	type: string,
	metadata: Record<string, unknown>,
): string {
	switch (type) {
		case "analyze_impact":
			return `Impact analysis for "${metadata.symbol}" — ${metadata.affectedCount} callers affected`;
		case "find_dead_code":
			return `Found ${metadata.count} potentially dead symbols`;
		case "find_test_gaps":
			return `Found ${metadata.count} symbols without test coverage`;
		case "index_codebase":
			return `Indexed ${metadata.filesIndexed} files, ${metadata.chunksCreated} chunks`;
		case "get_status":
			return `Status: ${metadata.totalFiles} files, ${metadata.totalChunks} chunks`;
		default:
			return JSON.stringify(metadata);
	}
}

// ============================================================================
// Root Monitor Component
// ============================================================================

export interface MonitorAppProps {
	projectPath: string;
	quit: () => void;
}

export function MonitorApp({ projectPath, quit }: MonitorAppProps) {
	return (
		<AppProvider projectPath={projectPath} quit={quit} monitorMode>
			<MonitorInner />
		</AppProvider>
	);
}
