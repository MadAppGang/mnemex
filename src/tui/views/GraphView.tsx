/**
 * GraphView
 *
 * Three-pane symbol graph explorer:
 *   Left pane:   callers list
 *   Center pane: symbol definition + metadata
 *   Right pane:  callees list
 *
 * Navigation history with back/forward support.
 */

import { useState, useEffect } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useAppContext } from "../context.js";
import { useGraph } from "../hooks/useGraph.js";
import { ScoreBar } from "../components/ScoreBar.js";
import { CodePreview } from "../components/CodePreview.js";
import { theme, layout } from "../theme.js";
import type { SymbolDefinition } from "../../types.js";

// ============================================================================
// Types
// ============================================================================

type Pane = "callers" | "definition" | "callees";

// ============================================================================
// Symbol List Pane Component
// ============================================================================

interface SymbolListPaneProps {
	title: string;
	symbols: SymbolDefinition[];
	selectedIndex: number;
	isActive: boolean;
	showCode: boolean;
}

function SymbolListPane({
	title,
	symbols,
	selectedIndex,
	isActive,
	showCode,
}: SymbolListPaneProps) {
	const borderColor = isActive ? theme.primary : theme.border;

	return (
		<box
			flexDirection="column"
			flexGrow={1}
			borderStyle="single"
			borderColor={borderColor}
			height="100%"
		>
			<box paddingLeft={1} height={1}>
				<text fg={isActive ? theme.primary : theme.muted}>
					{`${title} (${symbols.length})`}
				</text>
			</box>

			{symbols.length === 0 ? (
				<box paddingLeft={1} paddingTop={1}>
					<text fg={theme.dimmed}>{"none"}</text>
				</box>
			) : (
				<scrollbox width="100%" height="100%">
					{symbols.map((sym, i) => (
						<box key={sym.id} flexDirection="column" width="100%">
							<box flexDirection="row" paddingLeft={1} height={1}>
								<text
									fg={
										i === selectedIndex && isActive ? theme.primary : theme.text
									}
									width={22}
								>
									{sym.name}
								</text>
								<text fg={theme.muted} width={10}>
									{sym.kind}
								</text>
								<text fg={theme.dimmed}>{`:${sym.startLine}`}</text>
							</box>
							<box paddingLeft={2} height={1}>
								<text fg={theme.dimmed}>
									{sym.filePath.split("/").pop() ?? sym.filePath}
								</text>
							</box>
							{showCode && i === selectedIndex && (
								<box paddingLeft={1} paddingBottom={1}>
									<CodePreview
										content={sym.signature ?? sym.name}
										filePath={sym.filePath}
										startLine={sym.startLine}
										maxLines={10}
									/>
								</box>
							)}
						</box>
					))}
				</scrollbox>
			)}
		</box>
	);
}

// ============================================================================
// Definition Pane Component
// ============================================================================

interface DefinitionPaneProps {
	symbol: SymbolDefinition | null;
	isActive: boolean;
	loading: boolean;
	showCode: boolean;
}

function DefinitionPane({
	symbol,
	isActive,
	loading,
	showCode,
}: DefinitionPaneProps) {
	const borderColor = isActive ? theme.primary : theme.border;
	const normalizedScore = symbol ? Math.min(1, symbol.pagerankScore / 0.1) : 0;

	return (
		<box
			flexDirection="column"
			flexGrow={1}
			borderStyle="single"
			borderColor={borderColor}
			height="100%"
		>
			<box paddingLeft={1} height={1}>
				<text fg={isActive ? theme.primary : theme.muted}>{"Definition"}</text>
			</box>

			{loading && (
				<box paddingLeft={1} paddingTop={1}>
					<text fg={theme.info}>{"Loading..."}</text>
				</box>
			)}

			{!loading && !symbol && (
				<box paddingLeft={1} paddingTop={1} flexDirection="column">
					<text fg={theme.dimmed}>{"No symbol selected."}</text>
					<text fg={theme.muted}>{"Type a symbol name above."}</text>
				</box>
			)}

			{!loading && symbol && (
				<box flexDirection="column" paddingLeft={1} paddingRight={1}>
					<box height={1}>
						<text fg={theme.primary} width={30}>
							{symbol.name}
						</text>
						<text fg={isActive ? theme.info : theme.dimmed}>{symbol.kind}</text>
					</box>
					<box height={1}>
						<text fg={theme.muted}>
							{`${symbol.filePath}:${symbol.startLine}`}
						</text>
					</box>
					<box height={1}>
						<text fg={theme.dimmed}>{"exported: "}</text>
						<text fg={symbol.isExported ? theme.success : theme.muted}>
							{symbol.isExported ? "yes" : "no"}
						</text>
					</box>
					<box flexDirection="row" height={1}>
						<text fg={theme.dimmed}>{"pagerank: "}</text>
						<ScoreBar score={normalizedScore} width={10} showPercent={false} />
						<text fg={theme.muted}>
							{` ${symbol.pagerankScore.toFixed(4)}`}
						</text>
					</box>
					{symbol.signature && (
						<box flexDirection="column" paddingTop={1}>
							<text fg={theme.dimmed}>{"signature:"}</text>
							<text fg={theme.text}>{symbol.signature}</text>
						</box>
					)}
					{showCode && (
						<box paddingTop={1}>
							<CodePreview
								content={symbol.signature ?? symbol.name}
								filePath={symbol.filePath}
								startLine={symbol.startLine}
								maxLines={15}
							/>
						</box>
					)}
				</box>
			)}
		</box>
	);
}

// ============================================================================
// Main GraphView Component
// ============================================================================

export function GraphView() {
	const {
		tracker,
		navHistory,
		pushNav,
		setActiveTab,
		inputFocused,
		setInputFocused,
		activeTab,
	} = useAppContext();
	const {
		focusedSymbol,
		callers,
		callees,
		loading,
		error,
		focusSymbol,
		goBack,
		goForward,
		canGoBack,
		canGoForward,
	} = useGraph(tracker);

	const { width } = useTerminalDimensions();
	const isWide = width >= layout.wideWidth;

	const [activePane, setActivePane] = useState<Pane>("definition");
	const [callerIdx, setCallerIdx] = useState(0);
	const [calleeIdx, setCalleeIdx] = useState(0);
	const [symbolQuery, setSymbolQuery] = useState(
		navHistory.length > 0 ? (navHistory[navHistory.length - 1] ?? "") : "",
	);
	const [showCode, setShowCode] = useState(false);
	const [symInputFocused, setSymInputFocused] = useState(false);

	// Sync with global inputFocused
	useEffect(() => {
		if (activeTab === "graph") {
			setInputFocused(symInputFocused);
		}
		return () => {
			if (activeTab === "graph") setInputFocused(false);
		};
	}, [symInputFocused, activeTab, setInputFocused]);

	const drillInto = (sym: SymbolDefinition) => {
		pushNav(sym.name);
		focusSymbol(sym.name);
	};

	useKeyboard((key) => {
		if (key.name === "escape") {
			if (symInputFocused) {
				setSymInputFocused(false);
			}
			return;
		}
		if (!symInputFocused && key.name === "/") {
			setSymInputFocused(true);
			return;
		}
		// When symbol input is focused, only handle Enter to submit
		if (symInputFocused) {
			if (key.name === "return" && symbolQuery.trim()) {
				pushNav(symbolQuery.trim());
				focusSymbol(symbolQuery.trim());
				setSymInputFocused(false);
			}
			return;
		}

		// --- Shortcuts only when input NOT focused ---
		if (key.name === "j" || key.name === "down") {
			if (activePane === "callers") {
				setCallerIdx((prev) => Math.min(prev + 1, callers.length - 1));
			} else if (activePane === "callees") {
				setCalleeIdx((prev) => Math.min(prev + 1, callees.length - 1));
			}
			return;
		}
		if (key.name === "k" || key.name === "up") {
			if (activePane === "callers") {
				setCallerIdx((prev) => Math.max(prev - 1, 0));
			} else if (activePane === "callees") {
				setCalleeIdx((prev) => Math.max(prev - 1, 0));
			}
			return;
		}

		// Enter: drill into selected symbol
		if (key.name === "return") {
			if (activePane === "callers" && callers[callerIdx]) {
				drillInto(callers[callerIdx]);
			} else if (activePane === "callees" && callees[calleeIdx]) {
				drillInto(callees[calleeIdx]);
			} else if (activePane === "definition" && symbolQuery.trim()) {
				pushNav(symbolQuery.trim());
				focusSymbol(symbolQuery.trim());
			}
			return;
		}

		// Alt+Left: go back
		if (key.meta && key.name === "left") {
			goBack();
			return;
		}

		// Alt+Right: go forward
		if (key.meta && key.name === "right") {
			goForward();
			return;
		}

		// [ / ] to switch pane
		if (key.name === "[") {
			const panes: Pane[] = ["callers", "definition", "callees"];
			const idx = panes.indexOf(activePane);
			setActivePane(panes[(idx - 1 + panes.length) % panes.length]);
			return;
		}
		if (key.name === "]") {
			const panes: Pane[] = ["callers", "definition", "callees"];
			const idx = panes.indexOf(activePane);
			setActivePane(panes[(idx + 1) % panes.length]);
			return;
		}

		// v: toggle code preview
		if (key.name === "v") {
			setShowCode((prev) => !prev);
			return;
		}

		// i: jump to impact analysis
		if (key.name === "i" && focusedSymbol) {
			setActiveTab("analysis");
			return;
		}
	});

	// Narrow layout: show only the active pane
	if (!isWide) {
		return (
			<box flexDirection="column" width="100%" height="100%">
				{/* Symbol input */}
				<box flexDirection="row" height={1} paddingLeft={1}>
					<text fg={theme.muted}>{"Symbol: "}</text>
					<input
						value={symbolQuery}
						placeholder="type symbol name, Enter to search..."
						onChange={setSymbolQuery}
						width="100%"
						textColor={theme.text}
					/>
				</box>

				{/* Pane selector */}
				<box flexDirection="row" height={1} paddingLeft={1}>
					{(["callers", "definition", "callees"] as Pane[]).map((p) => (
						<box key={p} paddingRight={2}>
							<text fg={activePane === p ? theme.primary : theme.muted}>
								{activePane === p ? `[${p}]` : p}
							</text>
						</box>
					))}
					<text fg={theme.dimmed}>{"  [ ] switch"}</text>
				</box>

				{error && (
					<box paddingLeft={1} height={1}>
						<text fg={theme.error}>{`Error: ${error}`}</text>
					</box>
				)}

				<box flexGrow={1} overflow="hidden">
					{activePane === "callers" && (
						<SymbolListPane
							title="Callers"
							symbols={callers}
							selectedIndex={callerIdx}
							isActive={true}
							showCode={showCode}
						/>
					)}
					{activePane === "definition" && (
						<DefinitionPane
							symbol={focusedSymbol}
							isActive={true}
							loading={loading}
							showCode={showCode}
						/>
					)}
					{activePane === "callees" && (
						<SymbolListPane
							title="Callees"
							symbols={callees}
							selectedIndex={calleeIdx}
							isActive={true}
							showCode={showCode}
						/>
					)}
				</box>

				{/* Nav history */}
				<box height={1} paddingLeft={1}>
					<text fg={theme.dimmed}>
						{`${canGoBack ? "<back  " : "       "}${canGoForward ? "forward>" : "        "}`}
					</text>
				</box>
			</box>
		);
	}

	// Wide layout: three panes side by side
	return (
		<box flexDirection="column" width="100%" height="100%">
			{/* Symbol input row */}
			<box flexDirection="row" height={1} paddingLeft={1} paddingRight={1}>
				<text fg={theme.muted}>{"Symbol: "}</text>
				<input
					value={symbolQuery}
					placeholder="type symbol name, Enter to search..."
					onChange={setSymbolQuery}
					focused={symInputFocused}
					width="100%"
					textColor={theme.text}
				/>
				<text fg={theme.dimmed}>{"  [ ] pane  v code"}</text>
				{canGoBack && <text fg={theme.dimmed}>{"  Alt+Left:back"}</text>}
				{canGoForward && <text fg={theme.dimmed}>{"  Alt+Right:fwd"}</text>}
			</box>

			{/* Error */}
			{error && (
				<box paddingLeft={1} height={1}>
					<text fg={theme.error}>{`Error: ${error}`}</text>
				</box>
			)}

			{/* Three-pane layout */}
			<box flexDirection="row" flexGrow={1} width="100%" overflow="hidden">
				<SymbolListPane
					title="Callers"
					symbols={callers}
					selectedIndex={callerIdx}
					isActive={activePane === "callers"}
					showCode={showCode}
				/>
				<DefinitionPane
					symbol={focusedSymbol}
					isActive={activePane === "definition"}
					loading={loading}
					showCode={showCode}
				/>
				<SymbolListPane
					title="Callees"
					symbols={callees}
					selectedIndex={calleeIdx}
					isActive={activePane === "callees"}
					showCode={showCode}
				/>
			</box>
		</box>
	);
}
