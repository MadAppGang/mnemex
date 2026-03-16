/**
 * AnalysisView
 *
 * Code analysis with three sub-tabs:
 *   1. Dead Code   - symbols with zero callers + low PageRank
 *   2. Test Gaps   - high-importance symbols without test coverage
 *   3. Impact      - transitive callers of a symbol
 */

import { useState, useCallback, useEffect } from "react";
import { useKeyboard } from "@opentui/react";
import { useAppContext } from "../context.js";
import { useAnalysis } from "../hooks/useAnalysis.js";
import { ScoreBar } from "../components/ScoreBar.js";
import { theme } from "../theme.js";
import type { AnalysisTab } from "../hooks/useAnalysis.js";
import type {
	DeadCodeResult,
	TestGapResult,
	ImpactAnalysis,
} from "../../core/analysis/analyzer.js";

// ============================================================================
// Dead Code Sub-view
// ============================================================================

interface DeadCodePaneProps {
	results: DeadCodeResult[];
	selectedIndex: number;
}

function DeadCodePane({ results, selectedIndex }: DeadCodePaneProps) {
	if (results.length === 0) {
		return (
			<box padding={2} flexDirection="column">
				<text fg={theme.success}>{"No dead code found."}</text>
				<text fg={theme.dimmed}>
					{"Run 'mnemex index' first if results seem empty."}
				</text>
			</box>
		);
	}

	return (
		<box flexDirection="column" width="100%" height="100%">
			{/* Header row */}
			<box flexDirection="row" paddingLeft={1} height={1}>
				<text fg={theme.muted} width={30}>
					{"Symbol"}
				</text>
				<text fg={theme.muted} width={14}>
					{"Kind"}
				</text>
				<text fg={theme.muted} width={32}>
					{"File"}
				</text>
				<text fg={theme.muted}>{"PageRank"}</text>
			</box>

			<scrollbox width="100%" height="100%">
				{results.map((item, i) => {
					const isSelected = i === selectedIndex;
					const { symbol } = item;
					const filePart =
						symbol.filePath.length > 30
							? "..." + symbol.filePath.slice(-27)
							: symbol.filePath;
					return (
						<box key={symbol.id} flexDirection="row" paddingLeft={1} height={1}>
							<text fg={isSelected ? theme.primary : theme.text} width={30}>
								{symbol.name}
							</text>
							<text fg={theme.info} width={14}>
								{symbol.kind}
							</text>
							<text fg={isSelected ? theme.text : theme.muted} width={32}>
								{filePart}
							</text>
							<text fg={theme.dimmed}>{symbol.pagerankScore.toFixed(4)}</text>
						</box>
					);
				})}
			</scrollbox>

			{/* Summary footer */}
			<box paddingLeft={1} height={1}>
				<text fg={theme.muted}>
					{`${results.length} dead symbol${results.length !== 1 ? "s" : ""} (PageRank < 0.001)`}
				</text>
			</box>
		</box>
	);
}

// ============================================================================
// Test Gaps Sub-view
// ============================================================================

interface TestGapsPaneProps {
	results: TestGapResult[];
	selectedIndex: number;
}

function TestGapsPane({ results, selectedIndex }: TestGapsPaneProps) {
	if (results.length === 0) {
		return (
			<box padding={2} flexDirection="column">
				<text fg={theme.success}>{"No test gaps found."}</text>
				<text fg={theme.dimmed}>
					{"All high-importance symbols appear to have test coverage."}
				</text>
			</box>
		);
	}

	return (
		<box flexDirection="column" width="100%" height="100%">
			{/* Header row */}
			<box flexDirection="row" paddingLeft={1} height={1}>
				<text fg={theme.muted} width={28}>
					{"Symbol"}
				</text>
				<text fg={theme.muted} width={10}>
					{"PageRank"}
				</text>
				<text fg={theme.muted} width={10}>
					{"Callers"}
				</text>
				<text fg={theme.muted} width={14}>
					{"TestCallers"}
				</text>
				<text fg={theme.muted}>{"File"}</text>
			</box>

			<scrollbox width="100%" height="100%">
				{results.map((item, i) => {
					const isSelected = i === selectedIndex;
					const { symbol, callerCount, testCallerCount } = item;
					const filePart = symbol.filePath.split("/").pop() ?? symbol.filePath;
					return (
						<box key={symbol.id} flexDirection="row" paddingLeft={1} height={1}>
							<text fg={isSelected ? theme.primary : theme.text} width={28}>
								{symbol.name}
							</text>
							<text fg={theme.warning} width={10}>
								{symbol.pagerankScore.toFixed(3)}
							</text>
							<text fg={theme.info} width={10}>
								{String(callerCount)}
							</text>
							<text
								fg={testCallerCount === 0 ? theme.error : theme.success}
								width={14}
							>
								{String(testCallerCount)}
							</text>
							<text fg={isSelected ? theme.text : theme.muted}>{filePart}</text>
						</box>
					);
				})}
			</scrollbox>

			<box paddingLeft={1} height={1}>
				<text fg={theme.muted}>
					{`${results.length} symbol${results.length !== 1 ? "s" : ""} with test gaps`}
				</text>
			</box>
		</box>
	);
}

// ============================================================================
// Impact Sub-view
// ============================================================================

interface ImpactPaneProps {
	impact: ImpactAnalysis | null;
	symbolQuery: string;
	onChange: (value: string) => void;
	loading: boolean;
	inputFocused: boolean;
}

function ImpactPane({
	impact,
	symbolQuery,
	onChange,
	loading,
	inputFocused,
}: ImpactPaneProps) {
	return (
		<box flexDirection="column" width="100%" height="100%">
			{/* Input row */}
			<box flexDirection="row" height={1} paddingLeft={1}>
				<text fg={theme.muted}>{"Analyze: "}</text>
				<input
					value={symbolQuery}
					placeholder="symbol name, Enter to analyze..."
					onChange={onChange}
					focused={inputFocused}
					width="100%"
					textColor={theme.text}
				/>
			</box>

			{loading && (
				<box paddingLeft={1}>
					<text fg={theme.info}>{"Analyzing impact..."}</text>
				</box>
			)}

			{!loading && !impact && (
				<box padding={2}>
					<text fg={theme.dimmed}>
						{"Enter a symbol name to analyze transitive callers."}
					</text>
				</box>
			)}

			{!loading && impact && (
				<box flexDirection="column" flexGrow={1} overflow="hidden">
					{/* Summary */}
					<box flexDirection="row" paddingLeft={1} paddingTop={1} height={1}>
						<text fg={theme.muted}>{"Direct callers: "}</text>
						<text fg={theme.primary}>
							{String(impact.directCallers.length)}
						</text>
						<text fg={theme.muted}>{"  Total affected: "}</text>
						<text fg={theme.warning}>{String(impact.totalAffected)}</text>
						<text fg={theme.muted}>{"  Files: "}</text>
						<text fg={theme.info}>{String(impact.byFile.size)}</text>
					</box>

					{/* Tree */}
					<scrollbox width="100%" height="100%">
						{/* Root */}
						<box paddingLeft={1} height={1}>
							<text fg={theme.primary}>{impact.target.name}</text>
							<text fg={theme.dimmed}>{"  (root)  "}</text>
							<text fg={theme.muted}>
								{impact.target.filePath.split("/").pop()}
							</text>
						</box>

						{/* Direct callers */}
						{impact.directCallers.map((sym) => (
							<box key={sym.id} paddingLeft={1} height={1}>
								<text fg={theme.dimmed}>{"  --> "}</text>
								<text fg={theme.text} width={28}>
									{sym.name}
								</text>
								<text fg={theme.dimmed}>{"  depth:1  "}</text>
								<text fg={theme.muted}>{sym.filePath.split("/").pop()}</text>
							</box>
						))}

						{/* Transitive callers (depth > 1) */}
						{impact.transitiveCallers
							.filter((r) => r.depth > 1)
							.map((r) => (
								<box
									key={r.symbol.id + ":" + r.depth}
									paddingLeft={1}
									height={1}
								>
									<text fg={theme.dimmed}>{"  ".repeat(r.depth) + "--> "}</text>
									<text fg={theme.text} width={28}>
										{r.symbol.name}
									</text>
									<text fg={theme.dimmed}>{`  depth:${r.depth}  `}</text>
									<text fg={theme.muted}>
										{r.symbol.filePath.split("/").pop()}
									</text>
								</box>
							))}
					</scrollbox>
				</box>
			)}
		</box>
	);
}

// ============================================================================
// Main AnalysisView Component
// ============================================================================

export function AnalysisView() {
	const {
		tracker,
		inputFocused,
		setInputFocused,
		activeTab: currentTab,
	} = useAppContext();
	const {
		deadCode,
		testGaps,
		impact,
		activeTab,
		setActiveTab,
		loading,
		error,
		analyzeImpact,
		refreshDeadCode,
		refreshTestGaps,
	} = useAnalysis(tracker);

	const [selectedIndex, setSelectedIndex] = useState(0);
	const [impactQuery, setImpactQuery] = useState("");
	const [impactInputFocused, setImpactInputFocused] = useState(false);

	// Sync with global inputFocused
	useEffect(() => {
		if (currentTab === "analysis") {
			setInputFocused(impactInputFocused);
		}
		return () => {
			if (currentTab === "analysis") setInputFocused(false);
		};
	}, [impactInputFocused, currentTab, setInputFocused]);

	const tabLabels: Record<AnalysisTab, string> = {
		"dead-code": "Dead Code",
		"test-gaps": "Test Gaps",
		impact: "Impact",
	};

	const runImpact = useCallback(() => {
		if (impactQuery.trim()) {
			analyzeImpact(impactQuery.trim());
		}
	}, [impactQuery, analyzeImpact]);

	const currentListLength =
		activeTab === "dead-code"
			? deadCode.length
			: activeTab === "test-gaps"
				? testGaps.length
				: 0;

	useKeyboard((key) => {
		if (key.name === "escape") {
			if (impactInputFocused) {
				setImpactInputFocused(false);
			}
			return;
		}
		if (!impactInputFocused && activeTab === "impact" && key.name === "/") {
			setImpactInputFocused(true);
			return;
		}
		if (impactInputFocused) {
			if (key.name === "return") {
				runImpact();
				setImpactInputFocused(false);
			}
			return;
		}

		// 1/2/3 or number shortcuts switch sub-tabs
		if (key.name === "1") {
			setActiveTab("dead-code");
			setSelectedIndex(0);
			return;
		}
		if (key.name === "2") {
			setActiveTab("test-gaps");
			setSelectedIndex(0);
			return;
		}
		if (key.name === "3") {
			setActiveTab("impact");
			return;
		}

		if (activeTab === "impact") {
			// Enter triggers impact analysis
			if (key.name === "return") {
				runImpact();
			}
			return;
		}

		// j/k navigation in list views
		if (key.name === "j" || key.name === "down") {
			setSelectedIndex((prev) => Math.min(prev + 1, currentListLength - 1));
			return;
		}
		if (key.name === "k" || key.name === "up") {
			setSelectedIndex((prev) => Math.max(prev - 1, 0));
			return;
		}

		// r: refresh
		if (key.name === "r") {
			if (activeTab === "dead-code") {
				refreshDeadCode();
			} else if (activeTab === "test-gaps") {
				refreshTestGaps();
			}
			return;
		}
	});

	return (
		<box flexDirection="column" width="100%" height="100%">
			{/* Sub-tab bar */}
			<box flexDirection="row" height={1} paddingLeft={1}>
				{(["dead-code", "test-gaps", "impact"] as AnalysisTab[]).map(
					(tab, i) => (
						<box key={tab} paddingRight={2}>
							<text fg={activeTab === tab ? theme.primary : theme.muted}>
								{activeTab === tab
									? `[${i + 1}:${tabLabels[tab]}]`
									: ` ${i + 1}:${tabLabels[tab]} `}
							</text>
						</box>
					),
				)}
				{loading && <text fg={theme.info}>{"  Loading..."}</text>}
			</box>

			{/* Error */}
			{error && (
				<box paddingLeft={1} height={1}>
					<text fg={theme.error}>{`Error: ${error}`}</text>
				</box>
			)}

			{/* Content */}
			<box flexDirection="column" flexGrow={1} overflow="hidden">
				{activeTab === "dead-code" && (
					<DeadCodePane results={deadCode} selectedIndex={selectedIndex} />
				)}
				{activeTab === "test-gaps" && (
					<TestGapsPane results={testGaps} selectedIndex={selectedIndex} />
				)}
				{activeTab === "impact" && (
					<ImpactPane
						impact={impact}
						symbolQuery={impactQuery}
						onChange={setImpactQuery}
						loading={loading}
						inputFocused={impactInputFocused}
					/>
				)}
			</box>
		</box>
	);
}
