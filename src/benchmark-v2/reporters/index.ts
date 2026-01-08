/**
 * Reporters Module
 *
 * Exports all report generation components:
 * - JSON: Machine-readable output
 * - Markdown: Documentation-friendly format
 * - HTML: Interactive standalone reports
 */

export {
	JSONReporter,
	createJSONReporter,
	type JSONReport,
	type JSONReporterOptions,
	type ReportMeta,
	type ExecutiveSummary,
	type ModelRanking,
	type DetailedModelResults,
	type AnalysisSection,
	type RawDataSection,
} from "./json-reporter.js";

export {
	MarkdownReporter,
	createMarkdownReporter,
	type MarkdownReporterOptions,
} from "./markdown-reporter.js";

export {
	HTMLReporter,
	createHTMLReporter,
	type HTMLReporterOptions,
} from "./html-reporter.js";

// ============================================================================
// Phase Executor
// ============================================================================

import { mkdirSync, existsSync, writeFileSync } from "fs";
import { join } from "path";
import type { PhaseContext, PhaseResult } from "../pipeline/orchestrator.js";
import { createScoreAggregator } from "../scorers/aggregator.js";
import {
	calculateCorrelationMatrix,
	analyzeInterRaterAgreement,
} from "../scorers/statistics.js";
import { createJSONReporter } from "./json-reporter.js";
import { createMarkdownReporter } from "./markdown-reporter.js";
import { createHTMLReporter } from "./html-reporter.js";

/**
 * Create the reporting phase executor
 */
export function createReportingPhaseExecutor(
	outputDir: string,
): (context: PhaseContext) => Promise<PhaseResult> {
	return async (context: PhaseContext): Promise<PhaseResult> => {
		const { db, run: contextRun, config, stateMachine } = context;

		try {
			stateMachine.startPhase("reporting", 3); // JSON, MD, HTML

			// Ensure output directory exists
			if (!existsSync(outputDir)) {
				mkdirSync(outputDir, { recursive: true });
			}

			// Get fresh run data from database (includes updated codebaseInfo)
			const run = db.getRun(contextRun.id) || contextRun;

			// Get all data
			const summaries = db.getSummaries(run.id);
			const evaluationResults = db.getEvaluationResults(run.id);
			const pairwiseResults = db.getPairwiseResults(run.id);
			const scores = db.getAggregatedScores(run.id);

			// Handle empty data case gracefully
			if (summaries.length === 0) {
				// Write a minimal report indicating no data
				const placeholderReport = {
					meta: {
						runId: run.id,
						runName: run.name,
						startedAt: run.startedAt,
						completedAt: new Date().toISOString(),
						note: "No summaries were generated. Ensure LLM clients are configured.",
					},
					rankings: [],
					scores: Object.fromEntries(scores),
				};
				writeFileSync(
					join(outputDir, `${run.id}.json`),
					JSON.stringify(placeholderReport, null, 2),
				);
				stateMachine.updateProgress(
					"reporting",
					3,
					"complete",
					"Empty report generated",
				);
				return {
					success: true,
					itemsProcessed: 1,
				};
			}

			// Rebuild aggregations for detailed reports
			const aggregator = createScoreAggregator(config);
			const aggregations = aggregator.aggregate({
				summaries,
				evaluationResults,
				pairwiseResults,
				kValues: config.evaluation.retrieval.kValues,
			});

			// Convert scores Map to AggregatedScore array
			const scoresArray = Array.from(scores.entries())
				.map(([modelId, normalizedScores]) => ({
					modelId,
					judgeScore: normalizedScores.judge.combined * 5, // Convert to 1-5 scale
					contrastiveAccuracy: normalizedScores.contrastive.combined,
					retrievalMRR: normalizedScores.retrieval.mrr,
					retrievalPrecision: {
						1: normalizedScores.retrieval.precision1,
						5: normalizedScores.retrieval.precision5,
					},
					downstreamScore: normalizedScores.downstream.combined,
					overallScore: normalizedScores.overall,
					rank: 0, // Will be assigned below
				}))
				.sort((a, b) => b.overallScore - a.overallScore)
				.map((score, index) => ({ ...score, rank: index + 1 }));

			// Calculate analysis data
			const correlationMatrix = calculateCorrelationMatrix(aggregations);
			const interRaterAgreement = analyzeInterRaterAgreement(pairwiseResults);

			// Generate JSON report
			const jsonReporter = createJSONReporter({ includeRawData: false });
			const jsonReport = jsonReporter.generate({
				run,
				config,
				aggregations,
				scores: scoresArray,
				correlationMatrix,
				interRaterAgreement,
				summaries,
				evaluationResults,
				pairwiseResults,
			});
			jsonReporter.writeToFile(jsonReport, join(outputDir, `${run.id}.json`));
			stateMachine.updateProgress(
				"reporting",
				1,
				"json",
				"JSON report generated",
			);

			// Generate Markdown report
			const mdReporter = createMarkdownReporter();
			const mdReport = mdReporter.generate({
				run,
				config,
				aggregations,
				scores: scoresArray,
				correlationMatrix,
				interRaterAgreement,
			});
			mdReporter.writeToFile(mdReport, join(outputDir, `${run.id}.md`));
			stateMachine.updateProgress(
				"reporting",
				2,
				"markdown",
				"Markdown report generated",
			);

			// Generate HTML report
			const htmlReporter = createHTMLReporter();
			const htmlReport = htmlReporter.generate({
				run,
				config,
				aggregations,
				scores: scoresArray,
				correlationMatrix,
			});
			htmlReporter.writeToFile(htmlReport, join(outputDir, `${run.id}.html`));
			stateMachine.updateProgress(
				"reporting",
				3,
				"html",
				"HTML report generated",
			);

			return {
				success: true,
				itemsProcessed: 3,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				success: false,
				itemsProcessed: 0,
				error: message,
			};
		}
	};
}
