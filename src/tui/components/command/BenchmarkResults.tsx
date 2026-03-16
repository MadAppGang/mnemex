/**
 * BenchmarkResults - Interactive Full-Screen TUI
 *
 * Standalone interactive app for displaying LLM benchmark evaluation results.
 * Launched via renderBenchmarkResultsTui() with useAlternateScreen: true.
 *
 * Layout:
 *   [Left sidebar]     - section navigation with active highlight
 *   [Right detail]     - scrollable section content with visual panels
 *   [Status bar]       - keybinding hints
 *
 * Keyboard:
 *   q         - quit
 *   Tab       - next section
 *   Shift+Tab - previous section
 *   1-7       - jump to section directly
 *   j/down    - scroll down
 *   k/up      - scroll up
 *   o         - open report (on Summary tab)
 */

import { useState, useEffect } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import type { NormalizedScores } from "../../../benchmark-v2/types.js";
import { theme, getScoreColor, scoreBarChars } from "../../theme.js";

// ============================================================================
// Data Types (public interface - kept stable)
// ============================================================================

export interface BenchmarkError {
	phase: string;
	model: string;
	count: number;
	error: string;
}

export interface BenchmarkResultsData {
	scores: NormalizedScores[];
	latencyByModel: Map<string, number>;
	costByModel: Map<string, number>;
	generatorSpecs: string[];
	judgeModels: string[];
	evalResults: Array<{
		summaryId: string;
		judgeResults?: { judgeModelId: string; weightedAverage: number };
	}>;
	summaries: Array<{ id: string; modelId: string }>;
	codebaseType?: {
		language: string;
		category: string;
		stack: string;
		label: string;
	};
	totalBenchmarkCost: number;
	outputFiles: { json?: string; markdown?: string; html?: string };
	/** Collected errors from all phases */
	errors?: BenchmarkError[];
}

export interface BenchmarkResultsProps {
	data: BenchmarkResultsData;
	onDone?: () => void;
}

// ============================================================================
// Formatting helpers
// ============================================================================

const truncateName = (s: string, max = 24): string => {
	const short = s.split("/").pop() || s;
	return short.length > max ? short.slice(0, max - 1) + "\u2026" : short;
};

const fmtPct = (v: number): string =>
	isNaN(v) ? "N/A" : `${(v * 100).toFixed(0)}%`;

const fmtLatency = (ms: number): string => {
	if (isNaN(ms) || ms === 0) return "N/A";
	if (ms < 1000) return `${ms.toFixed(0)}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
};

const isLocalModel = (modelId: string): boolean =>
	modelId.startsWith("lmstudio/") ||
	modelId.startsWith("ollama/") ||
	modelId.startsWith("local/");

const isSubscriptionModel = (modelId: string): boolean =>
	modelId.startsWith("cc/") || modelId.startsWith("claude-code/");

const fmtCost = (cost: number, modelId?: string): string => {
	if (modelId && isLocalModel(modelId)) return "LOCAL";
	if (modelId && isSubscriptionModel(modelId)) return "SUB";
	if (isNaN(cost) || cost === 0) return "N/A";
	if (cost < 0.01) return `$${(cost * 100).toFixed(2)}c`;
	if (cost < 1) return `$${cost.toFixed(3)}`;
	return `$${cost.toFixed(2)}`;
};

const fmtCostTotal = (cost: number): string => {
	if (cost === 0) return "N/A";
	if (cost < 0.01) return `$${(cost * 100).toFixed(2)}c`;
	if (cost < 1) return `$${cost.toFixed(3)}`;
	return `$${cost.toFixed(2)}`;
};

// ============================================================================
// Section IDs
// ============================================================================

type SectionId =
	| "quality"
	| "operational"
	| "judge"
	| "per-judge"
	| "self-eval"
	| "iterative"
	| "summary"
	| "errors";

interface SectionDef {
	id: SectionId;
	label: string;
	icon: string;
}

// ============================================================================
// Panel Component - btop-style panel with title in border line
// ============================================================================

interface PanelProps {
	title: string;
	borderColor?: string;
	children?: React.ReactNode;
	marginBottom?: number;
}

function Panel({ title, borderColor, children, marginBottom = 1 }: PanelProps) {
	return (
		<box
			border
			borderStyle="rounded"
			borderColor={borderColor || theme.border}
			title={` ${title} `}
			titleAlignment="left"
			width="100%"
			marginBottom={marginBottom}
		>
			<box paddingX={1} paddingY={0}>
				{children}
			</box>
		</box>
	);
}

// ============================================================================
// BarChart Component - horizontal bar for any metric
// ============================================================================

interface BarChartProps {
	value: number;
	max?: number;
	width?: number;
	label?: string;
	color?: string;
}

function BarChart({ value, max = 1, width = 20, label, color }: BarChartProps) {
	const safeMax = max > 0 ? max : 1;
	const ratio = Math.max(0, Math.min(1, value / safeMax));
	const filled = Math.round(ratio * width);
	const empty = width - filled;
	const barColor = color || getScoreColor(ratio);
	const bar =
		scoreBarChars.filled.repeat(filled) + scoreBarChars.empty.repeat(empty);
	const displayLabel = label !== undefined ? label : fmtPct(ratio);

	return (
		<box flexDirection="row" height={1}>
			<text fg={barColor}>{bar}</text>
			<text fg={theme.text}>{" " + displayLabel}</text>
		</box>
	);
}

// ============================================================================
// Leaderboard Row - rank + name + bar
// ============================================================================

interface LeaderboardRowProps {
	rank: number;
	name: string;
	score: number;
	barWidth: number;
}

function LeaderboardRow({ rank, name, score, barWidth }: LeaderboardRowProps) {
	const color = getScoreColor(score);
	const line = `#${rank}`.padEnd(4) + name.padEnd(28);

	return (
		<box flexDirection="row" height={1}>
			<text fg={rank === 1 ? theme.primary : theme.text}>{line}</text>
			<BarChart
				value={score}
				max={1}
				width={barWidth}
				color={color}
				label={fmtPct(score)}
			/>
		</box>
	);
}

// ============================================================================
// Metric Row - label + bar
// ============================================================================

interface MetricRowProps {
	label: string;
	value: number;
	max?: number;
	formattedValue: string;
	barWidth?: number;
	labelWidth?: number;
	color?: string;
}

function MetricRow({
	label,
	value,
	max = 1,
	formattedValue,
	barWidth = 10,
	labelWidth = 18,
	color,
}: MetricRowProps) {
	return (
		<box flexDirection="row" height={1}>
			<text fg={theme.muted}>{label.padEnd(labelWidth)}</text>
			<BarChart
				value={value}
				max={max}
				width={barWidth}
				label={formattedValue}
				color={color}
			/>
		</box>
	);
}

// ============================================================================
// Sidebar Navigation
// ============================================================================

interface SidebarProps {
	sections: SectionDef[];
	activeIndex: number;
	height: number;
	showBack?: boolean;
}

function Sidebar({ sections, activeIndex, height, showBack }: SidebarProps) {
	const sidebarWidth = 26;

	return (
		<box
			flexDirection="column"
			width={sidebarWidth}
			height={height}
			border
			borderStyle="rounded"
			borderColor={theme.primary}
			title={" \u2630 Navigation "}
			titleAlignment="center"
		>
			{/* Section items */}
			<box flexDirection="column" paddingTop={0}>
				{sections.map((section, i) => {
					const isActive = i === activeIndex;
					const num = `${i + 1}`;
					// Build the display line
					const indicator = isActive ? "\u25b8" : " ";
					const itemText = ` ${indicator} ${num}  ${section.icon}  ${section.label}`;
					const padded = itemText.padEnd(sidebarWidth - 2);

					if (isActive) {
						return (
							<box
								key={section.id}
								height={1}
								width="100%"
								backgroundColor={theme.primary}
							>
								<text fg="#000000" bold>
									{padded}
								</text>
							</box>
						);
					}
					return (
						<box key={section.id} height={1} width="100%">
							<text fg={theme.text}>{padded}</text>
						</box>
					);
				})}
			</box>

			{/* Spacer */}
			<box flexGrow={1} />

			{/* Keybindings panel */}
			<box flexDirection="column" paddingX={1} paddingBottom={0}>
				<box height={1}>
					<text fg={theme.muted}>{"\u2500".repeat(sidebarWidth - 4)}</text>
				</box>
				{showBack && (
					<box height={1}>
						<text fg={theme.primary}>{"b      all runs"}</text>
					</box>
				)}
				<box height={1}>
					<text fg={theme.text}>{"\u2191\u2193/Tab  next/prev"}</text>
				</box>
				<box height={1}>
					<text fg={theme.text}>{"1-" + sections.length + "     jump to"}</text>
				</box>
				<box height={1}>
					<text fg={theme.text}>{"j/k    scroll"}</text>
				</box>
				<box height={1}>
					<text fg={theme.text}>{"q      quit"}</text>
				</box>
			</box>
		</box>
	);
}

// ============================================================================
// Quality Section Content
// ============================================================================

function QualitySectionContent({
	scores,
	latencyByModel,
	costByModel,
}: {
	scores: NormalizedScores[];
	latencyByModel: Map<string, number>;
	costByModel: Map<string, number>;
}) {
	const barWidth = 20;

	return (
		<box flexDirection="column" paddingY={0} paddingX={1}>
			<Panel title="Leaderboard" borderColor={theme.primary}>
				{scores.map((s, i) => (
					<LeaderboardRow
						key={s.modelId}
						rank={i + 1}
						name={truncateName(s.modelId, 26)}
						score={s.overall}
						barWidth={barWidth}
					/>
				))}
			</Panel>

			<Panel title="Score Breakdown" borderColor={theme.secondary}>
				{scores.map((s) => {
					const lat = latencyByModel.get(s.modelId) ?? 0;
					const cost = costByModel.get(s.modelId) ?? 0;
					return (
						<box key={s.modelId} flexDirection="column" marginBottom={1}>
							<box height={1}>
								<text fg={theme.primary}>
									<strong>{truncateName(s.modelId, 28)}</strong>
								</text>
							</box>
							<box flexDirection="row">
								<box flexGrow={1} flexDirection="column">
									<MetricRow
										label="Retrieval (45%)"
										value={s.retrieval.combined}
										formattedValue={fmtPct(s.retrieval.combined)}
										barWidth={10}
										labelWidth={18}
									/>
									<MetricRow
										label="Judge (25%)"
										value={s.judge.combined}
										formattedValue={fmtPct(s.judge.combined)}
										barWidth={10}
										labelWidth={18}
									/>
								</box>
								<box flexGrow={1} flexDirection="column">
									<MetricRow
										label="Contrastive (30%)"
										value={s.contrastive.combined}
										formattedValue={fmtPct(s.contrastive.combined)}
										barWidth={10}
										labelWidth={19}
									/>
									<box height={1}>
										<text fg={theme.muted}>
											{"Time " +
												fmtLatency(lat) +
												"   Cost " +
												fmtCost(cost, s.modelId)}
										</text>
									</box>
								</box>
							</box>
						</box>
					);
				})}
			</Panel>

			<Panel title="Metric Guide" borderColor={theme.border}>
				<box height={1}>
					<text fg={theme.muted}>
						{"Retr. (45%):   Can agents FIND the right code? (P@K, MRR)"}
					</text>
				</box>
				<box height={1}>
					<text fg={theme.muted}>
						{"Contr. (30%):  Can agents DISTINGUISH similar code?"}
					</text>
				</box>
				<box height={1}>
					<text fg={theme.muted}>
						{"Judge (25%):   Is summary accurate and complete?"}
					</text>
				</box>
			</Panel>
		</box>
	);
}

// ============================================================================
// Operational Section Content
// ============================================================================

function OperationalSectionContent({
	scores,
	latencyByModel,
	costByModel,
	totalBenchmarkCost,
}: {
	scores: NormalizedScores[];
	latencyByModel: Map<string, number>;
	costByModel: Map<string, number>;
	totalBenchmarkCost: number;
}) {
	const latencies = scores
		.map((s) => latencyByModel.get(s.modelId) ?? 0)
		.filter((v) => v > 0);
	const costs = scores
		.filter((s) => !isLocalModel(s.modelId) && !isSubscriptionModel(s.modelId))
		.map((s) => costByModel.get(s.modelId) ?? 0)
		.filter((v) => v > 0);

	const maxLatency = latencies.length > 0 ? Math.max(...latencies) : 1;
	const maxCost = costs.length > 0 ? Math.max(...costs) : 1;

	const fastestModel = scores.reduce((a, b) => {
		const latA = latencyByModel.get(a.modelId) ?? Infinity;
		const latB = latencyByModel.get(b.modelId) ?? Infinity;
		return latA < latB ? a : b;
	});

	const cheapestModel = scores.reduce((a, b) => {
		if (isLocalModel(a.modelId) || isSubscriptionModel(a.modelId)) return b;
		if (isLocalModel(b.modelId) || isSubscriptionModel(b.modelId)) return a;
		const costA = costByModel.get(a.modelId) ?? Infinity;
		const costB = costByModel.get(b.modelId) ?? Infinity;
		return costA < costB ? a : b;
	});

	const showCheapest =
		!isLocalModel(cheapestModel.modelId) &&
		!isSubscriptionModel(cheapestModel.modelId);

	const fastestLatency = latencyByModel.get(fastestModel.modelId) ?? 0;
	const cheapestCost = costByModel.get(cheapestModel.modelId) ?? 0;

	return (
		<box flexDirection="column" paddingY={0} paddingX={1}>
			<Panel title="Performance" borderColor={theme.info}>
				{scores.map((s) => {
					const lat = latencyByModel.get(s.modelId) ?? 0;
					const cost = costByModel.get(s.modelId) ?? 0;
					const isLocal = isLocalModel(s.modelId);
					const isSub = isSubscriptionModel(s.modelId);

					return (
						<box key={s.modelId} flexDirection="column" marginBottom={1}>
							<box height={1}>
								<text fg={theme.primary}>
									<strong>{truncateName(s.modelId, 28)}</strong>
								</text>
							</box>
							<MetricRow
								label="Latency"
								value={lat}
								max={maxLatency}
								formattedValue={fmtLatency(lat)}
								barWidth={24}
								labelWidth={10}
								color={theme.info}
							/>
							{!isLocal && !isSub ? (
								<MetricRow
									label="Cost"
									value={cost}
									max={maxCost}
									formattedValue={fmtCost(cost, s.modelId)}
									barWidth={24}
									labelWidth={10}
									color={theme.warning}
								/>
							) : (
								<box height={1}>
									<text fg={theme.muted}>{"Cost      "}</text>
									<text fg={theme.success}>
										{isLocal ? "LOCAL (free)" : "SUBSCRIPTION"}
									</text>
								</box>
							)}
						</box>
					);
				})}
			</Panel>

			<Panel title="Leaders" borderColor={theme.border}>
				<box height={1}>
					<text fg={theme.text}>
						{"Fastest:    " +
							truncateName(fastestModel.modelId, 24).padEnd(26) +
							fmtLatency(fastestLatency)}
					</text>
				</box>
				{showCheapest && (
					<box height={1}>
						<text fg={theme.text}>
							{"Cheapest:   " +
								truncateName(cheapestModel.modelId, 24).padEnd(26) +
								fmtCost(cheapestCost)}
						</text>
					</box>
				)}
				{totalBenchmarkCost > 0 && (
					<box height={1}>
						<text fg={theme.text}>
							{"Total cost: " + fmtCostTotal(totalBenchmarkCost)}
						</text>
					</box>
				)}
			</Panel>
		</box>
	);
}

// ============================================================================
// Judge Section Content
// ============================================================================

function JudgeSectionContent({ scores }: { scores: NormalizedScores[] }) {
	return (
		<box flexDirection="column" paddingY={0} paddingX={1}>
			<Panel title="Judge Evaluation" borderColor={theme.warning}>
				{scores.map((s) => (
					<box key={s.modelId} flexDirection="column" marginBottom={1}>
						<box height={1}>
							<text fg={theme.primary}>
								<strong>{truncateName(s.modelId, 28)}</strong>
							</text>
						</box>
						<box flexDirection="column">
							<MetricRow
								label="Pointwise"
								value={s.judge.pointwise}
								formattedValue={fmtPct(s.judge.pointwise)}
								barWidth={14}
								labelWidth={12}
							/>
							<MetricRow
								label="Pairwise"
								value={s.judge.pairwise}
								formattedValue={fmtPct(s.judge.pairwise)}
								barWidth={14}
								labelWidth={12}
							/>
							<MetricRow
								label="Combined"
								value={s.judge.combined}
								formattedValue={fmtPct(s.judge.combined)}
								barWidth={14}
								labelWidth={12}
							/>
						</box>
					</box>
				))}
			</Panel>

			<Panel title="Scoring Methods" borderColor={theme.border}>
				<box height={1}>
					<text fg={theme.muted}>
						{
							"Pointwise: Each summary rated independently (accuracy, completeness)"
						}
					</text>
				</box>
				<box height={1}>
					<text fg={theme.muted}>
						{"Pairwise:  Head-to-head comparison between summaries"}
					</text>
				</box>
				<box height={1}>
					<text fg={theme.muted}>
						{"Combined:  Weighted mix: 40% pointwise + 60% pairwise"}
					</text>
				</box>
			</Panel>
		</box>
	);
}

// ============================================================================
// Per-Judge Breakdown Section (with visual bars)
// ============================================================================

// Distinct colors for each judge (up to 6, wraps after that)
const JUDGE_COLORS = [
	"#22D3EE", // cyan
	"#FBBF24", // yellow
	"#A78BFA", // purple
	"#F472B6", // pink
	"#34D399", // emerald
	"#FB923C", // orange
] as const;

function PerJudgeSectionContent({
	scores,
	judgeModels,
	generatorSpecs,
	evalResults,
	summaries,
}: {
	scores: NormalizedScores[];
	judgeModels: string[];
	generatorSpecs: string[];
	evalResults: BenchmarkResultsData["evalResults"];
	summaries: BenchmarkResultsData["summaries"];
}) {
	// Build judge -> model -> scores map
	const byJudge = new Map<string, Map<string, number[]>>();
	for (const judgeId of judgeModels) {
		byJudge.set(judgeId, new Map());
	}

	for (const evalResult of evalResults) {
		if (!evalResult.judgeResults) continue;
		const judgeId = evalResult.judgeResults.judgeModelId;
		const summary = summaries.find((s) => s.id === evalResult.summaryId);
		if (!summary) continue;
		const judgeMap = byJudge.get(judgeId);
		if (!judgeMap) continue;
		if (!judgeMap.has(summary.modelId)) {
			judgeMap.set(summary.modelId, []);
		}
		judgeMap
			.get(summary.modelId)!
			.push(evalResult.judgeResults.weightedAverage);
	}

	// Detect same-provider bias
	const biasedPairs = new Set<string>();
	const getVendor = (modelId: string): string => {
		const id = modelId.toLowerCase();
		if (id.includes("claude") || id.includes("anthropic")) return "anthropic";
		if (
			id.includes("gpt") ||
			id.includes("o1") ||
			id.includes("openai") ||
			id.includes("chatgpt")
		)
			return "openai";
		if (
			id.includes("gemini") ||
			id.includes("palm") ||
			id.includes("google") ||
			id.includes("bard")
		)
			return "google";
		if (id.includes("llama") || id.includes("meta")) return "meta";
		if (id.includes("mistral") || id.includes("mixtral")) return "mistral";
		if (id.includes("qwen") || id.includes("alibaba")) return "alibaba";
		if (id.includes("deepseek")) return "deepseek";
		return "unknown";
	};
	for (const gen of generatorSpecs) {
		for (const judge of judgeModels) {
			if (getVendor(gen) !== "unknown" && getVendor(gen) === getVendor(judge)) {
				biasedPairs.add(`${gen}:${judge}`);
			}
		}
	}

	// Suppress unused var lint
	void scores;

	// Assign a color to each judge
	const judgeColor = (idx: number) => JUDGE_COLORS[idx % JUDGE_COLORS.length];

	// Sort generators by average score across all judges (descending)
	const genAvg = (genId: string): number => {
		let sum = 0;
		let count = 0;
		for (const judgeId of judgeModels) {
			const sc = byJudge.get(judgeId)?.get(genId) || [];
			for (const v of sc) {
				sum += v;
				count++;
			}
		}
		return count > 0 ? sum / count / 5 : 0;
	};
	const sortedGens = [...generatorSpecs].sort((a, b) => genAvg(b) - genAvg(a));

	return (
		<box flexDirection="column" paddingY={0} paddingX={1}>
			{/* Legend: judge name with its color */}
			<Panel title="Judges" borderColor={theme.border}>
				<box flexDirection="row" height={1}>
					{judgeModels.map((jId, ji) => (
						<box key={jId} flexDirection="row" paddingRight={2}>
							<box>
								<text fg={judgeColor(ji)}>{"\u25CF "}</text>
							</box>
							<box>
								<text fg={judgeColor(ji)}>{truncateName(jId, 24)}</text>
							</box>
						</box>
					))}
				</box>
			</Panel>

			{/* Per-model rows, each showing all judges */}
			<Panel title="Per-Judge Comparison" borderColor={theme.warning}>
				{sortedGens.map((genId) => (
					<box key={genId} flexDirection="column" marginBottom={1}>
						{/* Model name */}
						<box height={1}>
							<text fg={theme.text}>{truncateName(genId, 40)}</text>
						</box>
						{/* One bar per judge */}
						{judgeModels.map((judgeId, ji) => {
							const sc = byJudge.get(judgeId)?.get(genId) || [];
							const avg =
								sc.length > 0
									? sc.reduce((a, b) => a + b, 0) / sc.length / 5
									: 0;
							const isBiased = biasedPairs.has(`${genId}:${judgeId}`);
							const biasTag = isBiased ? " *" : "";
							const color = judgeColor(ji);

							return (
								<box key={judgeId} flexDirection="row" height={1}>
									<box width={14}>
										<text fg={color}>
											{("  " + truncateName(judgeId, 11)).padEnd(14)}
										</text>
									</box>
									<BarChart
										value={avg}
										max={1}
										width={20}
										label={fmtPct(avg) + biasTag}
										color={color}
									/>
								</box>
							);
						})}
					</box>
				))}
			</Panel>

			<Panel title="Notes" borderColor={theme.border}>
				<box height={1}>
					<text fg={theme.muted}>
						{
							"Similar scores across judges = reliable. Large differences = potential bias."
						}
					</text>
				</box>
				{biasedPairs.size > 0 && (
					<box height={1}>
						<text fg={theme.warning}>
							{"* Same provider as judge \u2014 potential self-bias"}
						</text>
					</box>
				)}
			</Panel>
		</box>
	);
}

// ============================================================================
// Self-Eval Section Content
// ============================================================================

function SelfEvalSectionContent({ scores }: { scores: NormalizedScores[] }) {
	const selfScores = scores.filter((s) => s.self);

	return (
		<box flexDirection="column" paddingY={0} paddingX={1}>
			<Panel title="Self-Evaluation" borderColor={theme.info}>
				<box height={1} marginBottom={1}>
					<text fg={theme.muted}>
						{"Can models effectively use their own summaries for code tasks?"}
					</text>
				</box>
				{selfScores.map((s) => (
					<box key={s.modelId} flexDirection="column" marginBottom={1}>
						<box height={1}>
							<text fg={theme.primary}>
								<strong>{truncateName(s.modelId, 28)}</strong>
							</text>
						</box>
						<MetricRow
							label="Retrieval"
							value={s.self!.retrieval}
							formattedValue={fmtPct(s.self!.retrieval)}
							barWidth={16}
							labelWidth={14}
						/>
						<MetricRow
							label="Func.Sel."
							value={s.self!.functionSelection}
							formattedValue={fmtPct(s.self!.functionSelection)}
							barWidth={16}
							labelWidth={14}
						/>
						<MetricRow
							label="Overall"
							value={s.self!.overall}
							formattedValue={fmtPct(s.self!.overall)}
							barWidth={16}
							labelWidth={14}
						/>
					</box>
				))}
				{selfScores.length === 0 && (
					<box height={1}>
						<text fg={theme.muted}>{"No self-eval data available."}</text>
					</box>
				)}
			</Panel>
			<Panel title="Self-Eval Tasks" borderColor={theme.border}>
				<box height={1}>
					<text fg={theme.muted}>
						{"Retrieval:  Can model pick its own summary from distractors?"}
					</text>
				</box>
				<box height={1}>
					<text fg={theme.muted}>
						{"Func.Sel.:  Can model identify right function from summaries?"}
					</text>
				</box>
				<box height={1}>
					<text fg={theme.muted}>
						{"Overall:    Weighted: 60% retrieval + 40% function selection"}
					</text>
				</box>
			</Panel>
		</box>
	);
}

// ============================================================================
// Iterative Section Content
// ============================================================================

function IterativeSectionContent({ scores }: { scores: NormalizedScores[] }) {
	const iterScores = scores.filter((s) => s.iterative);
	const maxRounds = Math.max(
		...iterScores.map((s) => s.iterative!.avgRounds),
		1,
	);

	return (
		<box flexDirection="column" paddingY={0} paddingX={1}>
			<Panel title="Iterative Refinement" borderColor={theme.info}>
				<box height={1} marginBottom={1}>
					<text fg={theme.muted}>
						{"How many refinement rounds to achieve target retrieval rank?"}
					</text>
				</box>
				{iterScores.map((s) => (
					<box key={s.modelId} flexDirection="column" marginBottom={1}>
						<box height={1}>
							<text fg={theme.primary}>
								<strong>{truncateName(s.modelId, 28)}</strong>
							</text>
						</box>
						<MetricRow
							label="Avg Rounds"
							value={maxRounds - s.iterative!.avgRounds}
							max={maxRounds}
							formattedValue={`${s.iterative!.avgRounds.toFixed(1)} rnd`}
							barWidth={16}
							labelWidth={14}
							color={theme.info}
						/>
						<MetricRow
							label="Success"
							value={s.iterative!.successRate}
							formattedValue={fmtPct(s.iterative!.successRate)}
							barWidth={16}
							labelWidth={14}
						/>
						<MetricRow
							label="Score"
							value={s.iterative!.avgRefinementScore}
							formattedValue={fmtPct(s.iterative!.avgRefinementScore)}
							barWidth={16}
							labelWidth={14}
						/>
					</box>
				))}
				{iterScores.length === 0 && (
					<box height={1}>
						<text fg={theme.muted}>
							{"No iterative refinement data available."}
						</text>
					</box>
				)}
			</Panel>
			<Panel title="Iterative Metrics" borderColor={theme.border}>
				<box height={1}>
					<text fg={theme.muted}>
						{
							"Avg Rounds: Refinement iterations (0 = first try, lower = better)"
						}
					</text>
				</box>
				<box height={1}>
					<text fg={theme.muted}>
						{"Success:    Achieved target rank within max rounds"}
					</text>
				</box>
				<box height={1}>
					<text fg={theme.muted}>
						{"Score:      1/log2(rounds+2) \u2014 rewards fewer iterations"}
					</text>
				</box>
			</Panel>
		</box>
	);
}

// ============================================================================
// Summary Section Content (fixed: single <text> per line, no flex row splits)
// ============================================================================

function SummarySectionContent({
	data,
	shouldHighlight,
	onOpenReport,
}: {
	data: BenchmarkResultsData;
	shouldHighlight: boolean;
	onOpenReport?: (path: string) => void;
}) {
	const { scores, latencyByModel, costByModel } = data;
	const best = scores[0];
	const worst = scores[scores.length - 1];
	const maxScore = best.overall;

	const bestRetr = [...scores].sort(
		(a, b) => b.retrieval.combined - a.retrieval.combined,
	)[0];
	const bestContr = [...scores].sort(
		(a, b) => b.contrastive.combined - a.contrastive.combined,
	)[0];
	const bestJudge = [...scores].sort(
		(a, b) => b.judge.combined - a.judge.combined,
	)[0];

	// Only consider models with actual latency data
	const modelsWithLatency = scores.filter((s) => {
		const lat = latencyByModel.get(s.modelId);
		return lat !== undefined && lat > 0;
	});
	const fastestModel =
		modelsWithLatency.length > 0
			? modelsWithLatency.reduce((a, b) => {
					const latA = latencyByModel.get(a.modelId)!;
					const latB = latencyByModel.get(b.modelId)!;
					return latA < latB ? a : b;
				})
			: null;

	// Only consider models with actual cost data (> 0), excluding local/sub
	const modelsWithCost = scores.filter((s) => {
		if (isLocalModel(s.modelId) || isSubscriptionModel(s.modelId)) return false;
		const cost = costByModel.get(s.modelId);
		return cost !== undefined && cost > 0;
	});
	const cheapestModel =
		modelsWithCost.length > 0
			? modelsWithCost.reduce((a, b) => {
					const costA = costByModel.get(a.modelId)!;
					const costB = costByModel.get(b.modelId)!;
					return costA < costB ? a : b;
				})
			: null;

	const codebaseLabel =
		data.codebaseType &&
		(data.codebaseType.stack !== "unknown" &&
		data.codebaseType.stack !== data.codebaseType.language
			? `${data.codebaseType.language} ${data.codebaseType.category} (${data.codebaseType.stack})`
			: data.codebaseType.label);

	// Medal colors for podium
	const gold = "#FFD700";
	const silver = "#C0C0C0";
	const bronze = "#CD7F32";
	const podiumColors = [gold, silver, bronze];
	const podiumIcons = ["\u2605", "\u25C6", "\u25B2"]; // ★ ◆ ▲

	return (
		<box flexDirection="column" paddingY={0} paddingX={1}>
			{codebaseLabel && (
				<box height={1} marginBottom={1}>
					<text fg={theme.info} bold>
						{"\u2500\u2500 Codebase: " + codebaseLabel + " \u2500\u2500"}
					</text>
				</box>
			)}

			{/* Podium — top models ranked with bars */}
			<Panel title=" Final Standings " borderColor={gold}>
				{scores.map((s, i) => {
					const name = truncateName(s.modelId, 22);
					const barW = 24;
					const ratio = s.overall;
					const filled = Math.round(ratio * barW);
					const empty = barW - filled;
					const color = i < 3 ? podiumColors[i] : theme.muted;
					const icon = i < 3 ? podiumIcons[i] : " ";
					const rank = (i + 1).toString();
					const pct = fmtPct(s.overall);
					const winner = i === 0 ? " << WINNER" : "";
					const bar =
						scoreBarChars.filled.repeat(filled) +
						scoreBarChars.empty.repeat(empty);

					return (
						<box key={s.modelId} height={1}>
							<text fg={color} bold>
								{" " +
									icon +
									" " +
									rank +
									". " +
									name.padEnd(24) +
									bar +
									" " +
									pct.padStart(4) +
									winner}
							</text>
						</box>
					);
				})}
			</Panel>

			{/* Category Champions — single <text> per line to avoid overlap */}
			<Panel title=" Category Champions " borderColor={theme.info}>
				{[
					{
						cat: "Retrieval",
						weight: "45%",
						model: bestRetr,
						score: bestRetr.retrieval.combined,
					},
					{
						cat: "Contrastive",
						weight: "30%",
						model: bestContr,
						score: bestContr.contrastive.combined,
					},
					{
						cat: "Judge",
						weight: "25%",
						model: bestJudge,
						score: bestJudge.judge.combined,
					},
				].map(({ cat, weight, model, score }) => {
					const barW = 14;
					const filled = Math.round(score * barW);
					const empty = barW - filled;
					const bar =
						scoreBarChars.filled.repeat(filled) +
						scoreBarChars.empty.repeat(empty);
					const line =
						" " +
						cat.padEnd(14) +
						"(" +
						weight +
						") " +
						truncateName(model.modelId, 18).padEnd(20) +
						bar +
						" " +
						fmtPct(score);
					return (
						<box key={cat} height={1}>
							<text fg={theme.text}>{line}</text>
						</box>
					);
				})}
			</Panel>

			{/* Operational Awards — single <text> per line */}
			<Panel title=" Operational Awards " borderColor={theme.warning}>
				{fastestModel && (
					<box height={1}>
						<text fg={theme.text}>
							{" Fastest:  " +
								truncateName(fastestModel.modelId, 22).padEnd(24) +
								fmtLatency(latencyByModel.get(fastestModel.modelId)!)}
						</text>
					</box>
				)}
				{cheapestModel && (
					<box height={1}>
						<text fg={theme.text}>
							{" Cheapest: " +
								truncateName(cheapestModel.modelId, 22).padEnd(24) +
								fmtCost(costByModel.get(cheapestModel.modelId)!)}
						</text>
					</box>
				)}
				{data.totalBenchmarkCost > 0 && (
					<box height={1} marginTop={1}>
						<text fg={theme.muted}>
							{"   Total benchmark cost: " +
								fmtCostTotal(data.totalBenchmarkCost)}
						</text>
					</box>
				)}
			</Panel>

			{/* How We Decide — scoring methodology + recommendation */}
			<Panel title=" How We Decide " borderColor={theme.secondary}>
				<box height={1}>
					<text fg={theme.info}>{"Scoring Weights"}</text>
				</box>
				<box height={1}>
					<text fg={theme.text}>
						{
							" Retrieval    45%   Can agents FIND the right code? (Precision@K, MRR)"
						}
					</text>
				</box>
				<box height={1}>
					<text fg={theme.text}>
						{
							" Contrastive  30%   Can agents DISTINGUISH similar code from distractors?"
						}
					</text>
				</box>
				<box height={1}>
					<text fg={theme.text}>
						{
							" Judge        25%   Is the summary accurate and complete? (LLM eval)"
						}
					</text>
				</box>
				<box height={1} marginTop={1}>
					<text fg={theme.info}>{"Formula"}</text>
				</box>
				<box height={1}>
					<text fg={theme.muted}>
						{
							" Overall = 0.45 \u00d7 Retrieval + 0.30 \u00d7 Contrastive + 0.25 \u00d7 Judge"
						}
					</text>
				</box>

				{scores.length > 1 &&
					(() => {
						const winner = best;
						const runnerUp = scores[1];
						const gap = winner.overall - runnerUp.overall;
						const isClose = gap < 0.03;

						// Find what the winner is best at
						const strengths: string[] = [];
						if (winner.retrieval.combined >= bestRetr.retrieval.combined)
							strengths.push("retrieval");
						if (winner.contrastive.combined >= bestContr.contrastive.combined)
							strengths.push("contrastive");
						if (winner.judge.combined >= bestJudge.judge.combined)
							strengths.push("judge quality");

						// Find runner-up's strengths
						const runnerStrengths: string[] = [];
						if (runnerUp.retrieval.combined > winner.retrieval.combined)
							runnerStrengths.push("retrieval");
						if (runnerUp.contrastive.combined > winner.contrastive.combined)
							runnerStrengths.push("contrastive");
						if (runnerUp.judge.combined > winner.judge.combined)
							runnerStrengths.push("judge quality");

						const winnerName = truncateName(winner.modelId, 24);
						const runnerName = truncateName(runnerUp.modelId, 24);

						const recommendation = isClose
							? `${winnerName} edges out ${runnerName} by ${fmtPct(gap)} \u2014 effectively a tie.`
							: `${winnerName} leads by ${fmtPct(gap)} over ${runnerName}.`;

						const reasoning =
							strengths.length > 0
								? `Winner excels at: ${strengths.join(", ")}.`
								: runnerStrengths.length > 0
									? `${runnerName} is stronger at ${runnerStrengths.join(", ")}, but ${winnerName} wins on overall balance.`
									: `${winnerName} scores consistently across all categories.`;

						return (
							<box flexDirection="column" marginTop={1}>
								<box height={1}>
									<text fg={theme.info}>{"Recommendation"}</text>
								</box>
								<box height={1}>
									<text fg={theme.text}>{" " + recommendation}</text>
								</box>
								<box height={1}>
									<text fg={theme.text}>{" " + reasoning}</text>
								</box>
								{isClose && (
									<box height={1}>
										<text fg={theme.muted}>
											{
												" Consider cost and latency as tiebreakers for close results."
											}
										</text>
									</box>
								)}
							</box>
						);
					})()}
			</Panel>

			{/* Reports panel with keyboard shortcuts */}
			{(data.outputFiles.json ||
				data.outputFiles.markdown ||
				data.outputFiles.html) && (
				<Panel title=" Reports " borderColor={theme.border}>
					<box height={1} marginBottom={1}>
						<text fg={theme.muted}>{"Press key to open in default app:"}</text>
					</box>
					{data.outputFiles.json && (
						<box height={1}>
							<text fg={theme.text}>
								{"  [j] JSON     " + data.outputFiles.json}
							</text>
						</box>
					)}
					{data.outputFiles.markdown && (
						<box height={1}>
							<text fg={theme.text}>
								{"  [m] Markdown " + data.outputFiles.markdown}
							</text>
						</box>
					)}
					{data.outputFiles.html && (
						<box height={1}>
							<text fg={theme.text}>
								{"  [h] HTML     " + data.outputFiles.html}
							</text>
						</box>
					)}
				</Panel>
			)}
		</box>
	);
}

// ============================================================================
// Errors Section Content
// ============================================================================

function ErrorsSectionContent({ errors }: { errors: BenchmarkError[] }) {
	// Group errors by phase
	const byPhase = new Map<string, BenchmarkError[]>();
	for (const err of errors) {
		if (!byPhase.has(err.phase)) byPhase.set(err.phase, []);
		byPhase.get(err.phase)!.push(err);
	}

	const phaseNames: Record<string, string> = {
		generate: "Generation",
		"judge-pointwise": "Judge (Pointwise)",
		"judge-pairwise": "Judge (Pairwise)",
		"self-eval": "Self-Evaluation",
		"iterative-refinement": "Iterative Refinement",
		extract: "Code Extraction",
	};

	if (errors.length === 0) {
		return (
			<box flexDirection="column" paddingY={0} paddingX={1}>
				<Panel title="Errors" borderColor={theme.success}>
					<box height={1}>
						<text fg={theme.success}>
							{"No errors recorded. All phases completed successfully."}
						</text>
					</box>
				</Panel>
			</box>
		);
	}

	const totalFailures = errors.reduce((sum, e) => sum + e.count, 0);

	return (
		<box flexDirection="column" paddingY={0} paddingX={1}>
			<Panel
				title={`Errors (${totalFailures} failures)`}
				borderColor={theme.error}
			>
				<box height={1} marginBottom={1}>
					<text fg={theme.muted}>
						{"Full error details from all benchmark phases."}
					</text>
				</box>

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
									key={i}
									flexDirection="column"
									marginBottom={1}
									paddingLeft={2}
								>
									<box height={1}>
										<text fg={theme.error}>
											{truncateName(err.model, 30) +
												": " +
												err.count +
												" failed"}
										</text>
									</box>
									{/* Show full error - wrap long lines */}
									<box paddingLeft={2}>
										<text fg={theme.muted} wrap="wrap">
											{err.error}
										</text>
									</box>
								</box>
							))}
						</box>
					);
				})}
			</Panel>

			<Panel title="Error Summary" borderColor={theme.border}>
				{/* Per-model failure counts */}
				{(() => {
					const modelCounts = new Map<string, number>();
					for (const err of errors) {
						modelCounts.set(
							err.model,
							(modelCounts.get(err.model) ?? 0) + err.count,
						);
					}
					return Array.from(modelCounts.entries())
						.sort((a, b) => b[1] - a[1])
						.map(([model, count]) => (
							<box key={model} height={1}>
								<text fg={theme.text}>
									{"  " +
										truncateName(model, 28).padEnd(30) +
										count +
										" failure" +
										(count !== 1 ? "s" : "")}
								</text>
							</box>
						));
				})()}
			</Panel>
		</box>
	);
}

// ============================================================================
// BenchmarkResultsApp - Interactive Root (sidebar + detail layout)
// ============================================================================

export interface BenchmarkResultsAppProps {
	data: BenchmarkResultsData;
	quit: () => void;
	/** Called when user presses 'b' to go back to the run list */
	onBack?: () => void;
}

/**
 * Standalone interactive benchmark results app.
 * Launched with useAlternateScreen: true from renderBenchmarkResultsTui().
 * Layout: left sidebar navigation + right scrollable detail panel.
 */
export function BenchmarkResultsApp({
	data,
	quit,
	onBack,
}: BenchmarkResultsAppProps) {
	const { width, height } = useTerminalDimensions();

	const { scores, judgeModels, evalResults } = data;

	const shouldHighlight = scores.length > 1;
	const showPerJudge = judgeModels.length > 1 && evalResults.length > 0;
	const hasSelf = scores.some((s) => s.self);
	const hasIterative = scores.some((s) => s.iterative);

	const hasErrors = (data.errors?.length ?? 0) > 0;

	const allSections: SectionDef[] = [
		{ id: "quality", label: "Quality", icon: "\u2605" },
		{ id: "operational", label: "Performance", icon: "\u26a1" },
		{ id: "judge", label: "Judge Scores", icon: "\u2696" },
		...(showPerJudge
			? [{ id: "per-judge" as SectionId, label: "Per-Judge", icon: "\u2690" }]
			: []),
		...(hasSelf
			? [{ id: "self-eval" as SectionId, label: "Self-Eval", icon: "\u21ba" }]
			: []),
		...(hasIterative
			? [{ id: "iterative" as SectionId, label: "Iterative", icon: "\u27f3" }]
			: []),
		{ id: "summary", label: "Summary", icon: "\u2691" },
		...(hasErrors
			? [{ id: "errors" as SectionId, label: "Errors", icon: "\u2718" }]
			: []),
	];

	const [activeIndex, setActiveIndex] = useState(0);

	// Open report file handler
	const openFile = (path: string) => {
		import("node:child_process").then(({ exec }) => {
			const cmd =
				process.platform === "darwin"
					? "open"
					: process.platform === "win32"
						? "start"
						: "xdg-open";
			exec(`${cmd} "${path}"`);
		});
	};

	// Keyboard handling
	useKeyboard((key) => {
		if (key.name === "q" && !key.ctrl && !key.meta) {
			quit();
			return;
		}

		if ((key.name === "escape" || key.name === "b") && onBack) {
			onBack();
			return;
		}

		if ((key.name === "tab" && !key.shift) || key.name === "down") {
			setActiveIndex((prev) => (prev + 1) % allSections.length);
			return;
		}
		if ((key.name === "tab" && key.shift) || key.name === "up") {
			setActiveIndex(
				(prev) => (prev - 1 + allSections.length) % allSections.length,
			);
			return;
		}

		const numKey = parseInt(key.name, 10);
		if (!isNaN(numKey) && numKey >= 1 && numKey <= allSections.length) {
			setActiveIndex(numKey - 1);
			return;
		}

		// Report file shortcuts (only on Summary tab)
		const activeSection = allSections[activeIndex];
		if (activeSection.id === "summary") {
			if (key.name === "j" && data.outputFiles.json) {
				openFile(data.outputFiles.json);
				return;
			}
			if (key.name === "m" && data.outputFiles.markdown) {
				openFile(data.outputFiles.markdown);
				return;
			}
			if (key.name === "h" && data.outputFiles.html) {
				openFile(data.outputFiles.html);
				return;
			}
		}
	});

	const activeSection = allSections[activeIndex];
	const sidebarHeight = height - 1; // leave 1 row for status bar
	const sidebarWidth = 26; // must match Sidebar component
	const contentWidth = width - sidebarWidth;

	return (
		<box flexDirection="column" width={width} height={height}>
			{/* Main area: sidebar + content */}
			<box flexDirection="row" flexGrow={1}>
				{/* Left sidebar */}
				<Sidebar
					sections={allSections}
					activeIndex={activeIndex}
					height={sidebarHeight}
					showBack={!!onBack}
				/>

				{/* Right detail panel */}
				<box flexDirection="column" width={contentWidth} height={sidebarHeight}>
					<scrollbox width={contentWidth} height={sidebarHeight} focused>
						{activeSection.id === "quality" && (
							<QualitySectionContent
								scores={scores}
								latencyByModel={data.latencyByModel}
								costByModel={data.costByModel}
							/>
						)}
						{activeSection.id === "operational" && (
							<OperationalSectionContent
								scores={scores}
								latencyByModel={data.latencyByModel}
								costByModel={data.costByModel}
								totalBenchmarkCost={data.totalBenchmarkCost}
							/>
						)}
						{activeSection.id === "judge" && (
							<JudgeSectionContent scores={scores} />
						)}
						{activeSection.id === "per-judge" && (
							<PerJudgeSectionContent
								scores={scores}
								judgeModels={data.judgeModels}
								generatorSpecs={data.generatorSpecs}
								evalResults={data.evalResults}
								summaries={data.summaries}
							/>
						)}
						{activeSection.id === "self-eval" && (
							<SelfEvalSectionContent scores={scores} />
						)}
						{activeSection.id === "iterative" && (
							<IterativeSectionContent scores={scores} />
						)}
						{activeSection.id === "summary" && (
							<SummarySectionContent
								data={data}
								shouldHighlight={shouldHighlight}
								onOpenReport={openFile}
							/>
						)}
						{activeSection.id === "errors" && (
							<ErrorsSectionContent errors={data.errors || []} />
						)}
					</scrollbox>
				</box>
			</box>

			{/* Status bar at bottom */}
			<box flexDirection="row" width="100%" height={1}>
				<box>
					<text backgroundColor={theme.primary} fg="#000000" bold>
						{" " + activeSection.icon + " " + activeSection.label + " "}
					</text>
				</box>
				<box paddingLeft={1}>
					<text fg={theme.muted}>
						{"[" + (activeIndex + 1) + "/" + allSections.length + "]"}
					</text>
				</box>
				<box flexGrow={1} />
				<box paddingRight={1}>
					<text fg={theme.text}>
						{(onBack ? "b:back  " : "") +
							(activeSection.id === "summary"
								? "q:quit  j:JSON  m:Markdown  h:HTML  Tab:nav"
								: "q:quit  \u2191\u2193/Tab:nav  1-" +
									allSections.length +
									":jump  j/k:scroll")}
					</text>
				</box>
			</box>
		</box>
	);
}

// ============================================================================
// BenchmarkResults - Legacy non-interactive component (kept for compatibility)
// ============================================================================

/**
 * Non-interactive static rendering of benchmark results.
 * Kept for backward compatibility with CommandOutputApp usage.
 * For interactive use, prefer BenchmarkResultsApp.
 */
export function BenchmarkResults({ data, onDone }: BenchmarkResultsProps) {
	const { scores, latencyByModel, costByModel, judgeModels, evalResults } =
		data;

	const shouldHighlight = scores.length > 1;

	useEffect(() => {
		const timer = setTimeout(() => {
			onDone?.();
		}, 80);
		return () => clearTimeout(timer);
	}, [onDone]);

	return (
		<box flexDirection="column">
			<QualitySectionContent
				scores={scores}
				latencyByModel={latencyByModel}
				costByModel={costByModel}
			/>
			<box height={1} />
			<OperationalSectionContent
				scores={scores}
				latencyByModel={latencyByModel}
				costByModel={costByModel}
				totalBenchmarkCost={data.totalBenchmarkCost}
			/>
			<box height={1} />
			<JudgeSectionContent scores={scores} />
			<box height={1} />
			<SummarySectionContent data={data} shouldHighlight={shouldHighlight} />
		</box>
	);
}
