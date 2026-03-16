/**
 * BenchmarkList - Interactive Full-Screen TUI for browsing benchmark runs
 *
 * Standalone interactive app for listing and selecting benchmark runs.
 * Launched via renderBenchmarkListTui() with useAlternateScreen: true.
 *
 * Layout:
 *   [Full-width list]     - selectable rows showing run info + inline error counts
 *   [Error detail panel]  - expandable panel showing errors for selected run
 *   [Status bar]          - keybinding hints
 *
 * Keyboard:
 *   j/down    - next row
 *   k/up      - previous row
 *   Enter     - view full results for selected run
 *   e         - expand/collapse error details for selected run
 *   q         - quit
 */

import { useState } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { theme } from "../../theme.js";

// ============================================================================
// Types
// ============================================================================

export interface RunError {
	phase: string;
	model: string;
	count: number;
	error: string;
}

export interface BenchmarkRunSummary {
	id: string;
	status: string;
	startedAt: string;
	completedAt?: string;
	generators: string[];
	judges: string[];
	codeUnitCount: number;
	projectName: string;
	errors: RunError[];
	topModel?: { name: string; score: number };
	durationMs?: number;
}

export interface BenchmarkListAppProps {
	runs: BenchmarkRunSummary[];
	onSelect: (runId: string) => void;
	quit: () => void;
}

// ============================================================================
// Helpers
// ============================================================================

function relativeTime(dateStr: string): string {
	const now = Date.now();
	const then = new Date(dateStr).getTime();
	const diffMs = now - then;
	const diffSec = Math.floor(diffMs / 1000);
	const diffMin = Math.floor(diffSec / 60);
	const diffHr = Math.floor(diffMin / 60);
	const diffDay = Math.floor(diffHr / 24);

	if (diffDay > 30) return new Date(dateStr).toLocaleDateString();
	if (diffDay > 0) return `${diffDay}d ago`;
	if (diffHr > 0) return `${diffHr}h ago`;
	if (diffMin > 0) return `${diffMin}m ago`;
	return "just now";
}

function statusColor(status: string): string {
	switch (status) {
		case "completed":
			return theme.success;
		case "running":
			return theme.warning;
		case "failed":
			return theme.error;
		case "paused":
			return theme.info;
		default:
			return theme.muted;
	}
}

function statusDot(status: string): string {
	switch (status) {
		case "completed":
			return "\u25CF"; // ●
		case "running":
			return "\u25CB"; // ○
		case "failed":
			return "\u2718"; // ✘
		case "paused":
			return "\u25D0"; // ◐
		default:
			return "\u25CB";
	}
}

function truncate(s: string, max: number): string {
	if (s.length <= max) return s;
	return s.slice(0, max - 1) + "\u2026";
}

function formatModels(models: Array<{ id?: string } | string>): string {
	return models
		.map((m) => {
			const id = typeof m === "string" ? m : m.id || String(m);
			return id.split("/").pop() || id;
		})
		.join(", ");
}

function totalErrorCount(errors: RunError[]): number {
	return errors.reduce((sum, e) => sum + e.count, 0);
}

function formatDuration(ms: number): string {
	const totalSec = Math.floor(ms / 1000);
	const h = Math.floor(totalSec / 3600);
	const m = Math.floor((totalSec % 3600) / 60);
	const s = totalSec % 60;
	if (h > 0) return `${h}h ${m}m ${s}s`;
	if (m > 0) return `${m}m ${s}s`;
	return `${s}s`;
}

/** Wrap a comma-separated list into lines that fit maxWidth. Breaks at ", " boundaries. */
function wrapList(text: string, maxWidth: number): string[] {
	if (text.length <= maxWidth) return [text];
	const lines: string[] = [];
	let pos = 0;
	while (pos < text.length) {
		if (text.length - pos <= maxWidth) {
			lines.push(text.slice(pos));
			break;
		}
		const segment = text.slice(pos, pos + maxWidth + 1);
		let breakAt = segment.lastIndexOf(", ");
		if (breakAt > 0) {
			breakAt += 2; // include ", "
		} else {
			breakAt = segment.lastIndexOf(" ");
			if (breakAt > 0) breakAt += 1;
			else breakAt = maxWidth;
		}
		lines.push(text.slice(pos, pos + breakAt));
		pos += breakAt;
	}
	return lines;
}

/** Compute card height for a run given available text width. */
function cardHeight(run: BenchmarkRunSummary, textWidth: number): number {
	const models = formatModels(run.generators);
	const judges = formatModels(run.judges);
	const mLines = wrapList(models, textWidth).length;
	const jLines = wrapList(judges, textWidth).length;
	// line1 + model lines + judge lines + stats line + divider
	return 1 + mLines + jLines + 1 + 1;
}

const phaseNames: Record<string, string> = {
	generate: "Generation",
	"judge-pointwise": "Judge (Pointwise)",
	"judge-pairwise": "Judge (Pairwise)",
	"self-eval": "Self-Evaluation",
	"iterative-refinement": "Iterative Refinement",
	extract: "Code Extraction",
	"evaluation:judge": "Judge Evaluation",
};

// ============================================================================
// Error Detail Panel
// ============================================================================

function ErrorDetailPanel({
	errors,
	maxHeight,
}: {
	errors: RunError[];
	maxHeight: number;
}) {
	const total = totalErrorCount(errors);

	// Group by phase
	const byPhase = new Map<string, RunError[]>();
	for (const err of errors) {
		if (!byPhase.has(err.phase)) byPhase.set(err.phase, []);
		byPhase.get(err.phase)!.push(err);
	}

	return (
		<box
			flexDirection="column"
			border
			borderStyle="rounded"
			borderColor={theme.error}
			title={` Errors (${total}) `}
			titleAlignment="left"
			marginX={1}
			height={Math.min(maxHeight, errors.length * 3 + 4)}
		>
			<scrollbox
				height={Math.min(maxHeight - 2, errors.length * 3 + 2)}
				focused
			>
				<box flexDirection="column" paddingX={1}>
					{Array.from(byPhase.entries()).map(([phase, phaseErrors]) => {
						const phaseTotal = phaseErrors.reduce((s, e) => s + e.count, 0);
						const phaseName = phaseNames[phase] || phase;
						return (
							<box key={phase} flexDirection="column" marginBottom={1}>
								<box height={1}>
									<text fg={theme.warning}>
										<strong>
											{phaseName +
												" \u2014 " +
												phaseTotal +
												" failure" +
												(phaseTotal !== 1 ? "s" : "")}
										</strong>
									</text>
								</box>
								{phaseErrors.map((err, i) => (
									<box
										key={`${phase}-${i}`}
										flexDirection="column"
										paddingLeft={2}
									>
										<box height={1}>
											<text fg={theme.error}>
												{(err.model !== "unknown"
													? truncate(err.model, 30) + ": "
													: "") +
													err.count +
													" failed"}
											</text>
										</box>
										<box paddingLeft={2} height={1}>
											<text fg={theme.muted}>{truncate(err.error, 120)}</text>
										</box>
									</box>
								))}
							</box>
						);
					})}
				</box>
			</scrollbox>
		</box>
	);
}

// ============================================================================
// BenchmarkListApp
// ============================================================================

export function BenchmarkListApp({
	runs,
	onSelect,
	quit,
}: BenchmarkListAppProps) {
	const { width, height } = useTerminalDimensions();
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [expandedErrors, setExpandedErrors] = useState(false);

	const selectedRun = runs[selectedIndex];
	const selectedHasErrors = selectedRun && selectedRun.errors.length > 0;

	// Error panel height when expanded
	const errorPanelHeight =
		expandedErrors && selectedHasErrors
			? Math.min(Math.floor(height * 0.4), selectedRun.errors.length * 3 + 4)
			: 0;

	// Layout constants
	const labelWidth = 11; // "   Models  ".length
	const contentWidth = Math.max(20, width - 4);
	const textWidth = Math.max(10, contentWidth - labelWidth);

	// Precompute card heights (variable due to wrapping)
	const cardHeights = runs.map((r) => cardHeight(r, textWidth));

	// Available height for card list: total - title(2) - statusBar(1) - errorPanel
	const availHeight = height - 2 - 1 - errorPanelHeight;

	// Compute scroll offset so selectedIndex is visible
	let scrollOffset = 0;
	let cumH = 0;
	for (let i = 0; i <= selectedIndex; i++) cumH += cardHeights[i];
	if (cumH > availHeight) {
		// Walk backwards from selectedIndex to find first card that fits
		let h = cardHeights[selectedIndex];
		scrollOffset = selectedIndex;
		for (let i = selectedIndex - 1; i >= 0; i--) {
			if (h + cardHeights[i] > availHeight) break;
			h += cardHeights[i];
			scrollOffset = i;
		}
	}

	// Determine how many cards fit from scrollOffset
	let visibleCount = 0;
	let usedH = 0;
	for (let i = scrollOffset; i < runs.length; i++) {
		if (usedH + cardHeights[i] > availHeight) break;
		usedH += cardHeights[i];
		visibleCount++;
	}
	const visibleRuns = runs.slice(
		scrollOffset,
		scrollOffset + Math.max(1, visibleCount),
	);

	useKeyboard((key) => {
		if (key.name === "q" && !key.ctrl && !key.meta) {
			quit();
			return;
		}

		if (key.name === "down" || key.name === "j") {
			setSelectedIndex((prev) => Math.min(prev + 1, runs.length - 1));
			return;
		}

		if (key.name === "up" || key.name === "k") {
			setSelectedIndex((prev) => Math.max(prev - 1, 0));
			return;
		}

		// 'e' toggles error detail panel
		if (key.name === "e") {
			if (selectedHasErrors) {
				setExpandedErrors((prev) => !prev);
			}
			return;
		}

		// Escape closes error panel
		if (key.name === "escape") {
			if (expandedErrors) {
				setExpandedErrors(false);
			}
			return;
		}

		if (key.name === "return") {
			if (runs.length > 0) {
				onSelect(runs[selectedIndex].id);
			}
			return;
		}
	});

	if (runs.length === 0) {
		return (
			<box flexDirection="column" width={width} height={height}>
				<box flexDirection="column" flexGrow={1} paddingX={2} paddingTop={1}>
					<box height={1}>
						<text fg={theme.primary}>
							<strong>{"\u2630 Benchmark Runs"}</strong>
						</text>
					</box>
					<box height={2} />
					<box height={1}>
						<text fg={theme.warning}>{"No benchmark runs found."}</text>
					</box>
					<box height={1}>
						<text fg={theme.muted}>
							{"Run a benchmark first: mnemex benchmark ..."}
						</text>
					</box>
				</box>
				<box flexDirection="row" width="100%" height={1}>
					<box paddingRight={1}>
						<text fg={theme.text}>{"q:quit"}</text>
					</box>
				</box>
			</box>
		);
	}

	const indent = " ".repeat(labelWidth);
	const divider = "\u2500 ".repeat(Math.floor(contentWidth / 2));

	return (
		<box flexDirection="column" width={width} height={height}>
			{/* Title */}
			<box paddingX={2} paddingTop={1} height={2}>
				<text fg={theme.primary}>
					<strong>
						{"\u2630 Benchmark Runs  " +
							runs.length +
							" run" +
							(runs.length !== 1 ? "s" : "")}
					</strong>
				</text>
			</box>

			{/* Run list (card layout) */}
			<box flexDirection="column" flexGrow={1} paddingX={1}>
				{visibleRuns.map((run, vi) => {
					const actualIndex = scrollOffset + vi;
					const isSelected = actualIndex === selectedIndex;
					const dot = statusDot(run.status);
					const time = relativeTime(run.startedAt);
					const models = formatModels(run.generators);
					const judges = formatModels(run.judges);
					const errCount = totalErrorCount(run.errors);

					// Line 1: pointer + dot + project ... time · duration · units
					const metaParts = [time];
					if (run.durationMs != null)
						metaParts.push(formatDuration(run.durationMs));
					metaParts.push(run.codeUnitCount + " units");
					const metaStr = metaParts.join("  \u00b7  ");
					const pointer = isSelected ? " \u25b8 " : "   ";
					const line1Left = pointer + dot + " " + run.projectName;
					const line1Pad = Math.max(
						2,
						contentWidth - line1Left.length - metaStr.length,
					);
					const line1 = line1Left + " ".repeat(line1Pad) + metaStr;

					// Wrapped model lines
					const modelLines = wrapList(models, textWidth);

					// Wrapped judge lines
					const judgeLines = wrapList(judges, textWidth);

					// Stats line parts
					const errColor = errCount > 0 ? theme.error : theme.success;
					const errStr =
						errCount > 0 ? errCount + " errors" : "\u2713 no errors";
					const bestColor = run.topModel
						? run.topModel.score >= 0.7
							? theme.success
							: run.topModel.score >= 0.4
								? theme.warning
								: theme.error
						: theme.muted;

					const bgColor = isSelected ? theme.selected : undefined;

					return (
						<box key={run.id} flexDirection="column" width="100%">
							{/* Line 1: status + project ... meta */}
							<box height={1} width="100%" backgroundColor={bgColor}>
								<text fg={theme.text}>
									{isSelected ? <strong>{line1}</strong> : line1}
								</text>
							</box>

							{/* Model lines (wrapped) — label muted, names in text color */}
							{modelLines.map((ml, i) => (
								<box
									key={`m${i}`}
									height={1}
									width="100%"
									backgroundColor={bgColor}
									flexDirection="row"
								>
									<box>
										<text fg={theme.muted}>
											{i === 0 ? "   Models  " : indent}
										</text>
									</box>
									<box>
										<text fg={theme.text}>{ml}</text>
									</box>
								</box>
							))}

							{/* Judge lines (wrapped) — label muted, names in text color */}
							{judgeLines.map((jl, i) => (
								<box
									key={`j${i}`}
									height={1}
									width="100%"
									backgroundColor={bgColor}
									flexDirection="row"
								>
									<box>
										<text fg={theme.muted}>
											{i === 0 ? "   Judges  " : indent}
										</text>
									</box>
									<box>
										<text fg={theme.text}>{jl}</text>
									</box>
								</box>
							))}

							{/* Stats line: Best + errors — flexDirection row for colors */}
							<box
								height={1}
								width="100%"
								backgroundColor={bgColor}
								flexDirection="row"
							>
								<box>
									<text fg={theme.muted}>{"   "}</text>
								</box>
								{run.topModel ? (
									<>
										<box>
											<text fg={theme.muted}>{"Best: "}</text>
										</box>
										<box>
											<text fg={bestColor}>
												{run.topModel.name +
													" " +
													run.topModel.score.toFixed(2)}
											</text>
										</box>
										<box>
											<text fg={theme.muted}>{"  \u00b7  "}</text>
										</box>
									</>
								) : null}
								<box>
									<text fg={errColor}>{errStr}</text>
								</box>
							</box>

							{/* Divider */}
							<box height={1} width="100%">
								<text fg={theme.border}>{" " + divider}</text>
							</box>
						</box>
					);
				})}
			</box>

			{/* Error detail panel (expanded) */}
			{expandedErrors && selectedHasErrors && (
				<ErrorDetailPanel
					errors={selectedRun.errors}
					maxHeight={Math.floor(height * 0.4)}
				/>
			)}

			{/* Status bar */}
			<box flexDirection="row" width="100%" height={1}>
				<box paddingLeft={2} backgroundColor={theme.primary}>
					<text fg="#000000">
						<strong>
							{" " + (selectedIndex + 1) + "/" + runs.length + " "}
						</strong>
					</text>
				</box>
				<box paddingLeft={1}>
					<text fg={theme.muted}>
						{truncate(runs[selectedIndex]?.id || "", 36)}
					</text>
				</box>
				<box flexGrow={1} />
				<box paddingRight={2}>
					<text fg={theme.text}>
						{"\u2191\u2193/j/k:navigate  Enter:view results" +
							(selectedHasErrors
								? "  e:" + (expandedErrors ? "collapse" : "errors")
								: "") +
							"  q:quit"}
					</text>
				</box>
			</box>
		</box>
	);
}
