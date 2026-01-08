/**
 * Benchmark Results Display Module
 *
 * Reusable display functions for benchmark results.
 * Used by both `benchmark` command (after run) and `benchmark-show` command.
 */

import type { BenchmarkDatabase } from "./storage/benchmark-db.js";
import type { NormalizedScores } from "./types.js";

// Colors for output
const c = {
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	dim: "\x1b[2m",
	cyan: "\x1b[36m",
	green: "\x1b[38;5;78m",
	yellow: "\x1b[33m",
	red: "\x1b[31m",
	orange: "\x1b[38;5;209m",
};

// Helper functions
const truncateName = (s: string, max = 24) => {
	const short = s.split("/").pop() || s;
	return short.length > max ? short.slice(0, max - 1) + "…" : short;
};

const fmtPct = (v: number) => (isNaN(v) ? "N/A" : `${(v * 100).toFixed(0)}%`);

const fmtLatency = (ms: number) => {
	if (isNaN(ms) || ms === 0) return "N/A";
	if (ms < 1000) return `${ms.toFixed(0)}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
};

const isLocalModel = (modelId: string) =>
	modelId.startsWith("lmstudio/") ||
	modelId.startsWith("ollama/") ||
	modelId.startsWith("local/");

const isSubscriptionModel = (modelId: string) =>
	modelId.startsWith("cc/") || modelId.startsWith("claude-code/");

const fmtCost = (cost: number, modelId?: string) => {
	if (modelId && isLocalModel(modelId)) return "LOCAL";
	if (modelId && isSubscriptionModel(modelId)) return "SUB";
	if (isNaN(cost) || cost === 0) return "N/A";
	if (cost < 0.01) return `$${(cost * 100).toFixed(2)}¢`;
	if (cost < 1) return `$${cost.toFixed(3)}`;
	return `$${cost.toFixed(2)}`;
};

const round = (v: number) => Math.round(v * 1000) / 1000;

const highlight = (
	val: string,
	isMax: boolean,
	isMin: boolean,
	shouldHL: boolean,
) => {
	if (!shouldHL) return val;
	if (isMax) return `${c.green}${val}${c.reset}`;
	if (isMin) return `${c.red}${val}${c.reset}`;
	return val;
};

const highlightLatency = (
	val: string,
	isMin: boolean,
	isMax: boolean,
	shouldHL: boolean,
) => {
	if (!shouldHL) return val;
	if (isMin) return `${c.green}${val}${c.reset}`;
	if (isMax) return `${c.red}${val}${c.reset}`;
	return val;
};

/**
 * Detect same-provider bias in judge/generator pairs
 */
function detectSameProviderBias(
	generators: string[],
	judges: string[],
): Array<{ generator: string; judge: string }> {
	const biased: Array<{ generator: string; judge: string }> = [];
	const getProvider = (modelId: string) => modelId.split("/")[0];

	for (const gen of generators) {
		for (const judge of judges) {
			if (getProvider(gen) === getProvider(judge)) {
				biased.push({ generator: gen, judge });
			}
		}
	}
	return biased;
}

export interface DisplayOptions {
	/** Show per-judge breakdown tables */
	showPerJudgeBreakdown?: boolean;
	/** Show self-eval details */
	showSelfEval?: boolean;
	/** Show iterative refinement details */
	showIterativeDetails?: boolean;
	/** Codebase type info for display */
	codebaseType?: {
		language: string;
		category: string;
		stack: string;
		label: string;
	};
}

/**
 * Display comprehensive benchmark results to console
 */
export async function displayBenchmarkResults(
	db: BenchmarkDatabase,
	runId: string,
	generatorSpecs: string[],
	judgeModels: string[],
	options: DisplayOptions = {},
): Promise<void> {
	const scores = db.getAggregatedScores(runId);
	const evalResults = db.getEvaluationResults(runId, "judge");
	const summaries = db.getSummaries(runId);

	// Calculate latency and cost per model
	const latencyByModel = new Map<string, number>();
	const costByModel = new Map<string, number>();

	for (const modelId of scores.keys()) {
		const modelSummaries = summaries.filter((s) => s.modelId === modelId);
		if (modelSummaries.length > 0) {
			const totalLatency = modelSummaries.reduce(
				(sum, s) => sum + (s.generationMetadata?.latencyMs || 0),
				0,
			);
			latencyByModel.set(modelId, totalLatency / modelSummaries.length);

			const totalCost = modelSummaries.reduce(
				(sum, s) => sum + (s.generationMetadata?.cost || 0),
				0,
			);
			costByModel.set(modelId, totalCost);
		}
	}

	if (scores.size === 0) {
		console.log(`${c.yellow}No scores available for this run${c.reset}`);
		return;
	}

	// Convert to array and sort by overall score
	const scoreArray = Array.from(scores.values()).sort(
		(a, b) => b.overall - a.overall,
	);
	const shouldHighlight = scoreArray.length > 1;

	// Show codebase type banner if available
	if (options.codebaseType) {
		const ct = options.codebaseType;
		const typeLabel =
			ct.stack !== "unknown" && ct.stack !== ct.language
				? `${ct.language} ${ct.category} (${ct.stack})`
				: ct.label;
		console.log(`${c.dim}Codebase: ${c.reset}${c.bold}${typeLabel}${c.reset}`);
		console.log();
	}

	// ═══════════════════════════════════════════════════════════════════
	// QUALITY SCORES TABLE
	// ═══════════════════════════════════════════════════════════════════
	console.log(
		`${c.orange}${c.bold}╔═══════════════════════════════════════════════════════════════════════════╗${c.reset}`,
	);
	console.log(
		`${c.orange}${c.bold}║${c.reset}                         ${c.bold}QUALITY SCORES${c.reset}                                 ${c.orange}${c.bold}║${c.reset}`,
	);
	console.log(
		`${c.orange}${c.bold}╚═══════════════════════════════════════════════════════════════════════════╝${c.reset}`,
	);
	console.log();
	console.log(
		`${c.dim}How well summaries serve LLM agents for code understanding. Higher is better.${c.reset}`,
	);
	console.log();

	// Calculate min/max for quality metrics
	const stats = {
		retr: {
			max: round(Math.max(...scoreArray.map((s) => s.retrieval.combined))),
			min: round(Math.min(...scoreArray.map((s) => s.retrieval.combined))),
		},
		contr: {
			max: round(Math.max(...scoreArray.map((s) => s.contrastive.combined))),
			min: round(Math.min(...scoreArray.map((s) => s.contrastive.combined))),
		},
		judge: {
			max: round(Math.max(...scoreArray.map((s) => s.judge.combined))),
			min: round(Math.min(...scoreArray.map((s) => s.judge.combined))),
		},
		overall: {
			max: round(Math.max(...scoreArray.map((s) => s.overall))),
			min: round(Math.min(...scoreArray.map((s) => s.overall))),
		},
	};

	// Get latency/cost values for stats (filter out 0/NaN)
	const latencyValues = scoreArray
		.map((s) => latencyByModel.get(s.modelId) || 0)
		.filter((v) => v > 0);
	const costValues = scoreArray
		.map((s) => costByModel.get(s.modelId) || 0)
		.filter((v) => v > 0);

	const timeStats = {
		min: latencyValues.length > 0 ? Math.min(...latencyValues) : 0,
		max: latencyValues.length > 0 ? Math.max(...latencyValues) : 0,
	};
	const costStats = {
		min: costValues.length > 0 ? Math.min(...costValues) : 0,
		max: costValues.length > 0 ? Math.max(...costValues) : 0,
	};

	// Quality table header
	console.log(
		`  ${"Model".padEnd(26)} ${"Retr.".padEnd(9)} ${"Contr.".padEnd(9)} ${"Judge".padEnd(9)} ${"Overall".padEnd(9)} ${"Time".padEnd(8)} ${"Cost".padEnd(8)}`,
	);
	console.log(
		`  ${"─".repeat(26)} ${"─".repeat(8)} ${"─".repeat(8)} ${"─".repeat(8)} ${"─".repeat(8)} ${"─".repeat(7)} ${"─".repeat(7)}`,
	);

	for (const s of scoreArray) {
		const name = truncateName(s.modelId).padEnd(26);
		const retr = highlight(
			fmtPct(s.retrieval.combined).padEnd(9),
			round(s.retrieval.combined) === stats.retr.max,
			round(s.retrieval.combined) === stats.retr.min &&
				stats.retr.min !== stats.retr.max,
			shouldHighlight,
		);
		const contr = highlight(
			fmtPct(s.contrastive.combined).padEnd(9),
			round(s.contrastive.combined) === stats.contr.max,
			round(s.contrastive.combined) === stats.contr.min &&
				stats.contr.min !== stats.contr.max,
			shouldHighlight,
		);
		const judge = highlight(
			fmtPct(s.judge.combined).padEnd(9),
			round(s.judge.combined) === stats.judge.max,
			round(s.judge.combined) === stats.judge.min &&
				stats.judge.min !== stats.judge.max,
			shouldHighlight,
		);
		const overall = highlight(
			fmtPct(s.overall).padEnd(9),
			round(s.overall) === stats.overall.max,
			round(s.overall) === stats.overall.min &&
				stats.overall.min !== stats.overall.max,
			shouldHighlight,
		);

		// Time and cost (lower is better, so swap max/min for highlighting)
		const latency = latencyByModel.get(s.modelId) || 0;
		const cost = costByModel.get(s.modelId) || 0;
		const time = highlight(
			fmtLatency(latency).padEnd(8),
			latency > 0 && latency === timeStats.min, // green = fastest
			latency > 0 &&
				latency === timeStats.max &&
				timeStats.min !== timeStats.max, // red = slowest
			shouldHighlight,
		);
		const costStr = highlight(
			fmtCost(cost, s.modelId).padEnd(8),
			cost > 0 && cost === costStats.min, // green = cheapest
			cost > 0 && cost === costStats.max && costStats.min !== costStats.max, // red = most expensive
			shouldHighlight,
		);

		console.log(
			`  ${name} ${retr} ${contr} ${judge} ${overall} ${time} ${costStr}`,
		);
	}

	// Quality explanations
	console.log();
	console.log(`${c.dim}Quality metrics (used for ranking):${c.reset}`);
	console.log(
		`${c.dim}  • Retr. (45%):  Can agents FIND the right code? (P@K, MRR)${c.reset}`,
	);
	console.log(
		`${c.dim}  • Contr. (30%): Can agents DISTINGUISH similar code?${c.reset}`,
	);
	console.log(
		`${c.dim}  • Judge (25%):  Is summary accurate and complete?${c.reset}`,
	);

	// ═══════════════════════════════════════════════════════════════════
	// OPERATIONAL METRICS TABLE
	// ═══════════════════════════════════════════════════════════════════
	console.log();
	console.log(
		`${c.cyan}${c.bold}┌───────────────────────────────────────────────────────────────────────────┐${c.reset}`,
	);
	console.log(
		`${c.cyan}${c.bold}│${c.reset}                      ${c.bold}OPERATIONAL METRICS${c.reset}                                ${c.cyan}${c.bold}│${c.reset}`,
	);
	console.log(
		`${c.cyan}${c.bold}└───────────────────────────────────────────────────────────────────────────┘${c.reset}`,
	);
	console.log();
	console.log(
		`${c.dim}Production efficiency metrics. Don't affect quality ranking.${c.reset}`,
	);
	console.log();

	// Calculate operational stats (reuse timeStats/costStats from quality section)
	const opStats = {
		latency:
			latencyValues.length > 0
				? {
						max: round(Math.max(...latencyValues)),
						min: round(Math.min(...latencyValues)),
					}
				: { max: 0, min: 0 },
		cost:
			costValues.length > 0
				? {
						max: round(Math.max(...costValues)),
						min: round(Math.min(...costValues)),
					}
				: { max: 0, min: 0 },
		refine: {
			max: round(
				Math.max(...scoreArray.map((s) => s.iterative?.avgRounds ?? 0)),
			),
			min: round(
				Math.min(...scoreArray.map((s) => s.iterative?.avgRounds ?? 0)),
			),
		},
		selfEval: {
			max: round(Math.max(...scoreArray.map((s) => s.self?.overall ?? 0))),
			min: round(Math.min(...scoreArray.map((s) => s.self?.overall ?? 0))),
		},
	};

	// Operational table
	console.log(
		`  ${"Model".padEnd(26)} ${"Latency".padEnd(10)} ${"Cost".padEnd(10)} ${"Refine".padEnd(10)} ${"Self-Eval".padEnd(10)}`,
	);
	console.log(
		`  ${"─".repeat(26)} ${"─".repeat(9)} ${"─".repeat(9)} ${"─".repeat(9)} ${"─".repeat(9)}`,
	);

	for (const s of scoreArray) {
		const name = truncateName(s.modelId).padEnd(26);
		const modelLatency = latencyByModel.get(s.modelId) || 0;
		const latency = highlightLatency(
			fmtLatency(modelLatency).padEnd(10),
			round(modelLatency) === opStats.latency.min &&
				opStats.latency.min !== opStats.latency.max,
			round(modelLatency) === opStats.latency.max &&
				opStats.latency.min !== opStats.latency.max,
			shouldHighlight,
		);
		const modelCost = costByModel.get(s.modelId) || 0;
		const cost = highlightLatency(
			fmtCost(modelCost, s.modelId).padEnd(10),
			round(modelCost) === opStats.cost.min &&
				opStats.cost.min !== opStats.cost.max,
			round(modelCost) === opStats.cost.max &&
				opStats.cost.min !== opStats.cost.max,
			shouldHighlight,
		);
		const avgRounds = s.iterative?.avgRounds ?? 0;
		const refineStr = s.iterative ? `${avgRounds.toFixed(1)} rnd` : "N/A";
		const refine = s.iterative
			? highlightLatency(
					refineStr.padEnd(10),
					round(avgRounds) === opStats.refine.min &&
						opStats.refine.min !== opStats.refine.max,
					round(avgRounds) === opStats.refine.max &&
						opStats.refine.min !== opStats.refine.max,
					shouldHighlight,
				)
			: refineStr.padEnd(10);
		const selfScore = s.self?.overall ?? 0;
		const selfStr = s.self ? fmtPct(selfScore) : "N/A";
		const selfEval = s.self
			? highlight(
					selfStr.padEnd(10),
					round(selfScore) === opStats.selfEval.max,
					round(selfScore) === opStats.selfEval.min &&
						opStats.selfEval.min !== opStats.selfEval.max,
					shouldHighlight,
				)
			: selfStr.padEnd(10);
		console.log(`  ${name} ${latency} ${cost} ${refine} ${selfEval}`);
	}

	// Operational explanations
	console.log();
	console.log(
		`${c.dim}Operational metrics (for production decisions):${c.reset}`,
	);
	console.log(
		`${c.dim}  • Latency:   Avg generation time (lower = faster)${c.reset}`,
	);
	console.log(
		`${c.dim}  • Cost:      Total generation cost (lower = cheaper)${c.reset}`,
	);
	console.log(
		`${c.dim}  • Refine:    Avg refinement rounds needed (lower = better first-try quality)${c.reset}`,
	);
	console.log(
		`${c.dim}  • Self-Eval: Can model use its own summaries? (internal consistency check)${c.reset}`,
	);

	// ═══════════════════════════════════════════════════════════════════
	// JUDGE BREAKDOWN TABLE
	// ═══════════════════════════════════════════════════════════════════
	console.log();
	console.log(
		`${c.yellow}${c.bold}┌──────────────────────────────────────────────────────────────────────────┐${c.reset}`,
	);
	console.log(
		`${c.yellow}${c.bold}│${c.reset}                         ${c.bold}JUDGE BREAKDOWN${c.reset}                              ${c.yellow}${c.bold}│${c.reset}`,
	);
	console.log(
		`${c.yellow}${c.bold}└──────────────────────────────────────────────────────────────────────────┘${c.reset}`,
	);
	console.log();
	console.log(
		`${c.dim}LLM judges rate summary quality on 5 criteria (1-5 scale, shown as %).${c.reset}`,
	);
	console.log();

	const criteriaStats = {
		accuracy: {
			max: Math.max(...scoreArray.map((s) => s.judge.pointwise)),
			min: Math.min(...scoreArray.map((s) => s.judge.pointwise)),
		},
		pairwise: {
			max: Math.max(...scoreArray.map((s) => s.judge.pairwise)),
			min: Math.min(...scoreArray.map((s) => s.judge.pairwise)),
		},
	};

	console.log(
		`  ${"Model".padEnd(26)} ${"Pointwise".padEnd(10)} ${"Pairwise".padEnd(10)} ${"Combined".padEnd(10)}`,
	);
	console.log(
		`  ${"─".repeat(26)} ${"─".repeat(9)} ${"─".repeat(9)} ${"─".repeat(9)}`,
	);

	for (const s of scoreArray) {
		const name = truncateName(s.modelId).padEnd(26);
		const pointwise = highlight(
			fmtPct(s.judge.pointwise).padEnd(10),
			s.judge.pointwise === criteriaStats.accuracy.max,
			s.judge.pointwise === criteriaStats.accuracy.min &&
				criteriaStats.accuracy.min !== criteriaStats.accuracy.max,
			shouldHighlight,
		);
		const pairwise = highlight(
			fmtPct(s.judge.pairwise).padEnd(10),
			s.judge.pairwise === criteriaStats.pairwise.max,
			s.judge.pairwise === criteriaStats.pairwise.min &&
				criteriaStats.pairwise.min !== criteriaStats.pairwise.max,
			shouldHighlight,
		);
		const combined = highlight(
			fmtPct(s.judge.combined).padEnd(10),
			s.judge.combined === stats.judge.max,
			s.judge.combined === stats.judge.min &&
				stats.judge.min !== stats.judge.max,
			shouldHighlight,
		);
		console.log(`  ${name} ${pointwise} ${pairwise} ${combined}`);
	}

	console.log();
	console.log(`${c.dim}Scoring methods:${c.reset}`);
	console.log(
		`${c.dim}  • Pointwise: Each summary rated independently (accuracy, completeness, conciseness)${c.reset}`,
	);
	console.log(
		`${c.dim}  • Pairwise:  Head-to-head comparison (which summary better describes the code?)${c.reset}`,
	);
	console.log(
		`${c.dim}  • Combined:  Weighted mix of pointwise (40%) and pairwise (60%)${c.reset}`,
	);

	// ═══════════════════════════════════════════════════════════════════
	// PER-JUDGE BREAKDOWN (if multiple judges)
	// ═══════════════════════════════════════════════════════════════════
	if (
		judgeModels.length > 1 &&
		evalResults.length > 0 &&
		options.showPerJudgeBreakdown !== false
	) {
		console.log();
		console.log(
			`${c.yellow}${c.bold}┌──────────────────────────────────────────────────────────────────────────┐${c.reset}`,
		);
		console.log(
			`${c.yellow}${c.bold}│${c.reset}                        ${c.bold}PER-JUDGE BREAKDOWN${c.reset}                            ${c.yellow}${c.bold}│${c.reset}`,
		);
		console.log(
			`${c.yellow}${c.bold}└──────────────────────────────────────────────────────────────────────────┘${c.reset}`,
		);
		console.log();
		console.log(
			`${c.dim}How each judge model scored the generators (shows judge agreement/bias).${c.reset}`,
		);
		console.log();

		// Detect same-provider bias
		const biasedPairs = detectSameProviderBias(generatorSpecs, judgeModels);
		const biasSet = new Set(
			biasedPairs.map((p) => `${p.generator}:${p.judge}`),
		);

		// Group eval results by judge model
		const byJudge = new Map<string, Map<string, number[]>>();
		for (const judgeId of judgeModels) {
			byJudge.set(judgeId, new Map());
		}

		for (const evalResult of evalResults) {
			if (!evalResult.judgeResults) continue;
			const judgeId = evalResult.judgeResults.judgeModelId;
			const judgeMap = byJudge.get(judgeId);
			if (!judgeMap) continue;

			// Get the summary to find the generator model
			const summary = summaries.find((s) => s.id === evalResult.summaryId);
			if (!summary) continue;

			if (!judgeMap.has(summary.modelId)) {
				judgeMap.set(summary.modelId, []);
			}
			judgeMap
				.get(summary.modelId)!
				.push(evalResult.judgeResults.weightedAverage);
		}

		// Display per-judge table
		const judgeHeader = `  ${"Generator".padEnd(26)} ${judgeModels.map((j) => truncateName(j, 12).padEnd(14)).join("")}`;
		console.log(judgeHeader);
		console.log(
			`  ${"─".repeat(26)} ${judgeModels.map(() => "─".repeat(13)).join(" ")}`,
		);

		// Calculate per-judge stats
		const judgeStats = new Map<string, { max: number; min: number }>();
		for (const judgeId of judgeModels) {
			const judgeMap = byJudge.get(judgeId)!;
			const avgs = Array.from(judgeMap.values()).map((scores) =>
				scores.length > 0
					? scores.reduce((a, b) => a + b, 0) / scores.length / 5
					: 0,
			);
			judgeStats.set(judgeId, {
				max: Math.max(...avgs),
				min: Math.min(...avgs),
			});
		}

		for (const genId of generatorSpecs) {
			const genName = truncateName(genId).padEnd(26);
			const judgeScores = judgeModels
				.map((judgeId) => {
					const judgeMap = byJudge.get(judgeId)!;
					const modelScores = judgeMap.get(genId) || [];
					const avg =
						modelScores.length > 0
							? modelScores.reduce((a, b) => a + b, 0) / modelScores.length / 5
							: 0;
					const judgeStatEntry = judgeStats.get(judgeId)!;
					const isBiased = biasSet.has(`${genId}:${judgeId}`);
					const scoreStr = fmtPct(avg);
					if (isBiased) {
						return `${c.yellow}${scoreStr}*${c.reset}`.padEnd(
							14 + c.yellow.length + c.reset.length,
						);
					}
					return highlight(
						scoreStr.padEnd(14),
						avg === judgeStatEntry.max,
						avg === judgeStatEntry.min &&
							judgeStatEntry.min !== judgeStatEntry.max,
						shouldHighlight,
					);
				})
				.join("");
			console.log(`  ${genName} ${judgeScores}`);
		}

		console.log();
		console.log(
			`${c.dim}Note: Similar scores across judges = reliable. Large differences = potential bias.${c.reset}`,
		);

		if (biasedPairs.length > 0) {
			console.log(
				`${c.yellow}*${c.reset} ${c.dim}Same provider as judge - potential self-bias${c.reset}`,
			);
		}
	}

	// ═══════════════════════════════════════════════════════════════════
	// SELF-EVAL DETAILS (if available)
	// ═══════════════════════════════════════════════════════════════════
	const hasSelfResults = scoreArray.some((s) => s.self);
	if (hasSelfResults && options.showSelfEval !== false) {
		console.log();
		console.log(
			`${c.cyan}${c.bold}┌──────────────────────────────────────────────────────────────────────────┐${c.reset}`,
		);
		console.log(
			`${c.cyan}${c.bold}│${c.reset}                      ${c.bold}SELF-EVALUATION DETAILS${c.reset}                          ${c.cyan}${c.bold}│${c.reset}`,
		);
		console.log(
			`${c.cyan}${c.bold}└──────────────────────────────────────────────────────────────────────────┘${c.reset}`,
		);
		console.log();
		console.log(
			`${c.dim}Can models effectively use their own summaries for code tasks?${c.reset}`,
		);
		console.log();

		const selfStats = {
			retrieval: {
				max: Math.max(
					...scoreArray.filter((s) => s.self).map((s) => s.self!.retrieval),
				),
				min: Math.min(
					...scoreArray.filter((s) => s.self).map((s) => s.self!.retrieval),
				),
			},
			funcSel: {
				max: Math.max(
					...scoreArray
						.filter((s) => s.self)
						.map((s) => s.self!.functionSelection),
				),
				min: Math.min(
					...scoreArray
						.filter((s) => s.self)
						.map((s) => s.self!.functionSelection),
				),
			},
			overall: {
				max: Math.max(
					...scoreArray.filter((s) => s.self).map((s) => s.self!.overall),
				),
				min: Math.min(
					...scoreArray.filter((s) => s.self).map((s) => s.self!.overall),
				),
			},
		};

		console.log(
			`  ${"Model".padEnd(26)} ${"Retrieval".padEnd(10)} ${"Func.Sel.".padEnd(10)} ${"Overall".padEnd(10)}`,
		);
		console.log(
			`  ${"─".repeat(26)} ${"─".repeat(9)} ${"─".repeat(9)} ${"─".repeat(9)}`,
		);

		for (const s of scoreArray) {
			if (!s.self) continue;
			const name = truncateName(s.modelId).padEnd(26);
			const retr = highlight(
				fmtPct(s.self.retrieval).padEnd(10),
				s.self.retrieval === selfStats.retrieval.max,
				s.self.retrieval === selfStats.retrieval.min &&
					selfStats.retrieval.min !== selfStats.retrieval.max,
				shouldHighlight,
			);
			const funcSel = highlight(
				fmtPct(s.self.functionSelection).padEnd(10),
				s.self.functionSelection === selfStats.funcSel.max,
				s.self.functionSelection === selfStats.funcSel.min &&
					selfStats.funcSel.min !== selfStats.funcSel.max,
				shouldHighlight,
			);
			const overall = highlight(
				fmtPct(s.self.overall).padEnd(10),
				s.self.overall === selfStats.overall.max,
				s.self.overall === selfStats.overall.min &&
					selfStats.overall.min !== selfStats.overall.max,
				shouldHighlight,
			);
			console.log(`  ${name} ${retr} ${funcSel} ${overall}`);
		}

		console.log();
		console.log(`${c.dim}Self-eval tasks:${c.reset}`);
		console.log(
			`${c.dim}  • Retrieval:  Given a query, can the model pick its own summary from distractors?${c.reset}`,
		);
		console.log(
			`${c.dim}  • Func.Sel.:  Given a task, can the model identify the right function from summaries?${c.reset}`,
		);
		console.log(
			`${c.dim}  • Overall:    Weighted average (60% retrieval, 40% function selection)${c.reset}`,
		);
	}

	// ═══════════════════════════════════════════════════════════════════
	// ITERATIVE REFINEMENT DETAILS (if available)
	// ═══════════════════════════════════════════════════════════════════
	const hasIterativeResults = scoreArray.some((s) => s.iterative);
	if (hasIterativeResults && options.showIterativeDetails !== false) {
		console.log();
		console.log(
			`${c.cyan}${c.bold}┌──────────────────────────────────────────────────────────────────────────┐${c.reset}`,
		);
		console.log(
			`${c.cyan}${c.bold}│${c.reset}                    ${c.bold}ITERATIVE REFINEMENT DETAILS${c.reset}                        ${c.cyan}${c.bold}│${c.reset}`,
		);
		console.log(
			`${c.cyan}${c.bold}└──────────────────────────────────────────────────────────────────────────┘${c.reset}`,
		);
		console.log();
		console.log(
			`${c.dim}How many refinement rounds were needed to achieve target retrieval rank?${c.reset}`,
		);
		console.log();

		const iterStats = {
			rounds: {
				max: Math.max(
					...scoreArray
						.filter((s) => s.iterative)
						.map((s) => s.iterative!.avgRounds),
				),
				min: Math.min(
					...scoreArray
						.filter((s) => s.iterative)
						.map((s) => s.iterative!.avgRounds),
				),
			},
			successRate: {
				max: Math.max(
					...scoreArray
						.filter((s) => s.iterative)
						.map((s) => s.iterative!.successRate),
				),
				min: Math.min(
					...scoreArray
						.filter((s) => s.iterative)
						.map((s) => s.iterative!.successRate),
				),
			},
			score: {
				max: Math.max(
					...scoreArray
						.filter((s) => s.iterative)
						.map((s) => s.iterative!.avgRefinementScore),
				),
				min: Math.min(
					...scoreArray
						.filter((s) => s.iterative)
						.map((s) => s.iterative!.avgRefinementScore),
				),
			},
		};

		console.log(
			`  ${"Model".padEnd(26)} ${"Avg Rounds".padEnd(11)} ${"Success".padEnd(10)} ${"Score".padEnd(10)}`,
		);
		console.log(
			`  ${"─".repeat(26)} ${"─".repeat(10)} ${"─".repeat(9)} ${"─".repeat(9)}`,
		);

		for (const s of scoreArray) {
			if (!s.iterative) continue;
			const name = truncateName(s.modelId).padEnd(26);
			const roundsStr = `${s.iterative.avgRounds.toFixed(1)} rnd`;
			const rounds = highlightLatency(
				roundsStr.padEnd(11),
				round(s.iterative.avgRounds) === iterStats.rounds.min &&
					iterStats.rounds.min !== iterStats.rounds.max,
				round(s.iterative.avgRounds) === iterStats.rounds.max &&
					iterStats.rounds.min !== iterStats.rounds.max,
				shouldHighlight,
			);
			const successRate = highlight(
				fmtPct(s.iterative.successRate).padEnd(10),
				s.iterative.successRate === iterStats.successRate.max,
				s.iterative.successRate === iterStats.successRate.min &&
					iterStats.successRate.min !== iterStats.successRate.max,
				shouldHighlight,
			);
			const score = highlight(
				fmtPct(s.iterative.avgRefinementScore).padEnd(10),
				s.iterative.avgRefinementScore === iterStats.score.max,
				s.iterative.avgRefinementScore === iterStats.score.min &&
					iterStats.score.min !== iterStats.score.max,
				shouldHighlight,
			);
			console.log(`  ${name} ${rounds} ${successRate} ${score}`);
		}

		console.log();
		console.log(`${c.dim}Iterative metrics:${c.reset}`);
		console.log(
			`${c.dim}  • Avg Rounds: Average refinement iterations needed (0 = passed first try, lower = better)${c.reset}`,
		);
		console.log(
			`${c.dim}  • Success:    Rate of achieving target retrieval rank within max rounds${c.reset}`,
		);
		console.log(
			`${c.dim}  • Score:      Brokk-style score: 1/log₂(rounds+2) - rewards fewer iterations${c.reset}`,
		);
	}

	// ═══════════════════════════════════════════════════════════════════
	// SUMMARY
	// ═══════════════════════════════════════════════════════════════════
	console.log();
	console.log(
		`${c.green}${c.bold}┌──────────────────────────────────────────────────────────────────────────┐${c.reset}`,
	);
	console.log(
		`${c.green}${c.bold}│${c.reset}                            ${c.bold}SUMMARY${c.reset}                                     ${c.green}${c.bold}│${c.reset}`,
	);
	console.log(
		`${c.green}${c.bold}└──────────────────────────────────────────────────────────────────────────┘${c.reset}`,
	);
	console.log();

	// Quality leaders
	const topQuality = scoreArray[0];
	const topRetrieval = [...scoreArray].sort(
		(a, b) => b.retrieval.combined - a.retrieval.combined,
	)[0];
	const topContrast = [...scoreArray].sort(
		(a, b) => b.contrastive.combined - a.contrastive.combined,
	)[0];
	const topJudge = [...scoreArray].sort(
		(a, b) => b.judge.combined - a.judge.combined,
	)[0];

	console.log(`  ${c.cyan}Quality leaders:${c.reset}`);
	console.log(
		`    🏆 Overall:   ${truncateName(topQuality.modelId, 25)} (${fmtPct(topQuality.overall)})`,
	);
	console.log(
		`    🔍 Retrieval: ${truncateName(topRetrieval.modelId, 25)} (${fmtPct(topRetrieval.retrieval.combined)})`,
	);
	console.log(
		`    ⚖️  Contrast:  ${truncateName(topContrast.modelId, 25)} (${fmtPct(topContrast.contrastive.combined)})`,
	);
	console.log(
		`    ⭐ Judge:     ${truncateName(topJudge.modelId, 25)} (${fmtPct(topJudge.judge.combined)})`,
	);

	// Operational leaders
	const fastestModel = scoreArray.reduce((a, b) => {
		const latA = latencyByModel.get(a.modelId) || Infinity;
		const latB = latencyByModel.get(b.modelId) || Infinity;
		return latA < latB ? a : b;
	});

	const cheapestModel = scoreArray.reduce((a, b) => {
		const costA = costByModel.get(a.modelId) || Infinity;
		const costB = costByModel.get(b.modelId) || Infinity;
		if (isLocalModel(a.modelId) || isSubscriptionModel(a.modelId)) return b;
		if (isLocalModel(b.modelId) || isSubscriptionModel(b.modelId)) return a;
		return costA < costB ? a : b;
	});

	console.log();
	console.log(`  ${c.cyan}Operational leaders:${c.reset}`);
	const fastestLatency = latencyByModel.get(fastestModel.modelId) || 0;
	console.log(
		`    ⚡ Fastest:  ${truncateName(fastestModel.modelId, 25)} (${fmtLatency(fastestLatency)})`,
	);
	const cheapestCost = costByModel.get(cheapestModel.modelId) || 0;
	if (
		!isLocalModel(cheapestModel.modelId) &&
		!isSubscriptionModel(cheapestModel.modelId)
	) {
		console.log(
			`    💰 Cheapest: ${truncateName(cheapestModel.modelId, 25)} (${fmtCost(cheapestCost)})`,
		);
	}

	// Calculate generation cost (from summaries)
	let generationCost = 0;
	for (const cost of costByModel.values()) {
		generationCost += cost;
	}

	// Calculate judge cost (pointwise + pairwise)
	let pointwiseCost = 0;
	for (const result of evalResults) {
		if (result.judgeResults?.cost) {
			pointwiseCost += result.judgeResults.cost;
		}
	}

	let pairwiseCost = 0;
	const pairwiseResults = db.getPairwiseResults(runId);
	for (const result of pairwiseResults) {
		if (result.cost) {
			pairwiseCost += result.cost;
		}
	}

	const judgeCost = pointwiseCost + pairwiseCost;
	const totalCost = generationCost + judgeCost;

	// Display cost breakdown
	console.log();
	console.log(`  ${c.cyan}Benchmark cost:${c.reset}`);

	const formatCost = (cost: number) => {
		if (cost === 0) return "N/A";
		if (cost < 0.01) return `$${(cost * 100).toFixed(2)}¢`;
		if (cost < 1) return `$${cost.toFixed(3)}`;
		return `$${cost.toFixed(2)}`;
	};

	if (totalCost > 0) {
		console.log(`    📝 Generation: ${formatCost(generationCost)}`);
		console.log(`    ⚖️  Judge:      ${formatCost(judgeCost)}`);
		console.log(`    💵 Total:      ${formatCost(totalCost)}`);
	} else {
		console.log(`    💵 Total:      N/A (local/subscription models)`);
	}

	console.log();
}
