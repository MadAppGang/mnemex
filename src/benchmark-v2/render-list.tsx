/**
 * renderBenchmarkListTui
 *
 * Launches a full-screen interactive TUI to browse benchmark runs.
 * Uses useAlternateScreen: true to take over the entire terminal.
 * When the user selects a run, it transitions to the results TUI.
 *
 * Extracted into a .tsx file so JSX can be used. Called from cli.ts.
 */

import { join } from "path";
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { BenchmarkListApp } from "../tui/components/command/BenchmarkList.js";
import type { BenchmarkRunSummary } from "../tui/components/command/BenchmarkList.js";
import type { BenchmarkRun } from "./types.js";
import type { BenchmarkDatabase } from "./storage/benchmark-db.js";

export type { BenchmarkRunSummary };

/**
 * Convert BenchmarkRun objects to the summary format needed by the TUI.
 */
function toRunSummaries(
	runs: BenchmarkRun[],
	db: BenchmarkDatabase,
): BenchmarkRunSummary[] {
	return runs.map((r) => {
		// Collect errors from phase failures
		let errors: Array<{
			phase: string;
			model: string;
			count: number;
			error: string;
		}> = [];
		try {
			const phaseFailures = db.getPhaseFailureSummary(r.id);
			if (phaseFailures.length > 0) {
				errors = phaseFailures.map((pf) => ({
					phase: pf.phase,
					model: "unknown",
					count: pf.failed,
					error:
						pf.error ||
						`${pf.failed} of ${pf.total} items failed in ${pf.phase}`,
				}));
			}
		} catch {
			// Non-fatal — run may have no phase_progress data
		}

		// Compute top model from aggregated scores
		let topModel: { name: string; score: number } | undefined;
		try {
			const scores = db.getAggregatedScores(r.id);
			let best: { name: string; score: number } | undefined;
			for (const [modelId, s] of scores) {
				if (!best || s.overall > best.score) {
					best = {
						name: modelId.split("/").pop() || modelId,
						score: s.overall,
					};
				}
			}
			topModel = best;
		} catch {
			// Non-fatal
		}

		// Compute duration
		let durationMs: number | undefined;
		if (r.completedAt && r.startedAt) {
			durationMs =
				new Date(r.completedAt).getTime() - new Date(r.startedAt).getTime();
			if (durationMs < 0) durationMs = undefined;
		}

		return {
			id: r.id,
			status: r.status,
			startedAt: r.startedAt,
			completedAt: r.completedAt,
			generators: r.config.generators.map((g) => g.id),
			judges: r.config.judges,
			codeUnitCount: db.getCodeUnitCount(r.id),
			projectName:
				r.config.projectPath.split("/").pop() || r.config.projectPath,
			errors,
			topModel,
			durationMs,
		};
	});
}

/**
 * Build BenchmarkResultsData for a given run and launch the results TUI.
 * Returns "back" if the user pressed Esc, "quit" otherwise.
 */
async function showRunResults(
	runId: string,
	db: BenchmarkDatabase,
	projectPath: string,
): Promise<"back" | "quit"> {
	const run = db.getRun(runId);

	const generatorSpecs = run.config.generators.map((g: { id: string }) => g.id);
	const judgeModels = run.config.judges as string[];

	const scores = db.getAggregatedScores(runId);
	if (scores.size === 0) {
		// No scores — can't show results TUI, go back to list
		return "back";
	}

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

	const scoreArray = Array.from(scores.values()).sort(
		(a, b) => b.overall - a.overall,
	);

	// Detect codebase type
	let codebaseType:
		| { language: string; category: string; stack: string; label: string }
		| undefined;
	try {
		const { detectCodebaseType } = await import("./codebase-detector.js");
		codebaseType = await detectCodebaseType(
			run.config.projectPath || process.cwd(),
		);
	} catch {
		// Ignore
	}

	// Look for output files
	const benchmarkDir = join(projectPath, ".mnemex", "benchmark");
	const outputFiles: { json?: string; markdown?: string; html?: string } = {};
	try {
		const { readdirSync } = await import("node:fs");
		const files = readdirSync(benchmarkDir);
		const prefix = runId.slice(0, 8);
		for (const f of files) {
			if (f.includes(prefix) || f.includes(runId)) {
				const fullPath = join(benchmarkDir, f);
				if (f.endsWith(".json")) outputFiles.json = fullPath;
				if (f.endsWith(".md")) outputFiles.markdown = fullPath;
				if (f.endsWith(".html")) outputFiles.html = fullPath;
			}
		}
	} catch {
		// Ignore
	}

	// Reconstruct errors from phase_progress
	let errors:
		| Array<{ phase: string; model: string; count: number; error: string }>
		| undefined;
	try {
		const phaseFailures = db.getPhaseFailureSummary(runId);
		if (phaseFailures.length > 0) {
			errors = phaseFailures.map((pf) => ({
				phase: pf.phase,
				model: "unknown",
				count: pf.failed,
				error:
					pf.error || `${pf.failed} of ${pf.total} items failed in ${pf.phase}`,
			}));
		}
	} catch {
		// Non-fatal
	}

	const { renderBenchmarkResultsTui } = await import("./render-results.js");
	const action = await renderBenchmarkResultsTui({
		scores: scoreArray,
		latencyByModel,
		costByModel,
		generatorSpecs,
		judgeModels,
		evalResults: evalResults.map((e) => ({
			summaryId: e.summaryId,
			judgeResults: e.judgeResults,
		})),
		summaries: summaries.map((s) => ({
			id: s.id,
			modelId: s.modelId,
		})),
		codebaseType,
		totalBenchmarkCost: 0,
		outputFiles,
		errors,
	});
	return action;
}

/**
 * Renders the benchmark run list using an interactive full-screen OpenTUI.
 * When a run is selected, transitions to the results TUI.
 * Pressing Esc in results returns to the list. Pressing q quits.
 */
export async function renderBenchmarkListTui(
	runs: BenchmarkRun[],
	db: BenchmarkDatabase,
	projectPath: string,
): Promise<void> {
	if (!process.stdout.isTTY) {
		console.log(
			"[benchmark] Run list ready. Run with a TTY to see interactive TUI.",
		);
		return;
	}

	const summaries = toRunSummaries(runs, db);

	// Loop: list → results → back to list (on Esc) or quit (on q)
	// Keep a timer alive so the Node.js event loop doesn't exit between
	// renderer transitions. renderer.destroy() removes all stdin listeners
	// and signal handlers, which can leave zero active handles and cause the
	// process to exit before the next renderer is created.
	const keepalive = setInterval(() => {}, 60_000);
	try {
		// eslint-disable-next-line no-constant-condition
		while (true) {
			const selectedRunId = await showList(summaries);
			if (!selectedRunId) {
				// User pressed q in the list — quit
				return;
			}

			const action = await showRunResults(selectedRunId, db, projectPath);
			if (action === "quit") {
				return;
			}
			// action === "back" → loop back to list
		}
	} finally {
		clearInterval(keepalive);
	}
}

/**
 * Show the list TUI and return the selected run ID, or null if the user quits.
 */
async function showList(
	summaries: BenchmarkRunSummary[],
): Promise<string | null> {
	const renderer = await createCliRenderer({
		useAlternateScreen: true,
		exitOnCtrlC: true,
		onDestroy: () => {},
	});

	const root = createRoot(renderer);

	return new Promise<string | null>((resolve) => {
		const cleanup = (value: string | null) => {
			root.unmount();
			resolve(value);
			renderer.destroy();
		};

		const quit = () => cleanup(null);
		const onSelect = (runId: string) => cleanup(runId);

		root.render(
			<BenchmarkListApp runs={summaries} onSelect={onSelect} quit={quit} />,
		);
	});
}
