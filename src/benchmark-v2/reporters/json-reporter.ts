/**
 * JSON Reporter
 *
 * Outputs benchmark results in machine-readable JSON format.
 */

import { writeFileSync } from "fs";
import type {
	BenchmarkRun,
	BenchmarkConfig,
	GeneratedSummary,
	EvaluationResult,
	AggregatedScore,
	PairwiseResult,
} from "../types.js";
import type {
	ModelAggregation,
	CriterionStats,
} from "../scorers/aggregator.js";
import type {
	CorrelationMatrix,
	InterRaterAgreement,
} from "../scorers/statistics.js";

// ============================================================================
// Types
// ============================================================================

export interface JSONReport {
	meta: ReportMeta;
	summary: ExecutiveSummary;
	rankings: ModelRanking[];
	detailedResults: DetailedModelResults[];
	analysis: AnalysisSection;
	rawData?: RawDataSection;
}

export interface ReportMeta {
	benchmarkVersion: string;
	runId: string;
	runName: string;
	startedAt: string;
	completedAt: string;
	config: BenchmarkConfig;
}

export interface ExecutiveSummary {
	totalModels: number;
	totalCodeUnits: number;
	totalSummaries: number;
	totalEvaluations: number;
	topModel: string;
	topModelScore: number;
	evaluationMethodsUsed: string[];
}

export interface ModelRanking {
	rank: number;
	modelId: string;
	overallScore: number;
	judgeScore: number;
	contrastiveAccuracy: number;
	retrievalMRR: number;
	downstreamScore: number;
}

export interface DetailedModelResults {
	modelId: string;
	rank: number;
	judge: {
		pointwise: {
			accuracy: CriterionStats;
			completeness: CriterionStats;
			semanticRichness: CriterionStats;
			abstraction: CriterionStats;
			conciseness: CriterionStats;
			overall: CriterionStats;
		};
		pairwise: {
			wins: number;
			losses: number;
			ties: number;
			winRate: number;
		};
	};
	contrastive: {
		embedding: { accuracy: number; count: number };
		llm: { accuracy: number; count: number };
		combined: number;
	};
	retrieval: {
		mrr: number;
		precision: Record<number, number>;
	};
	downstream: {
		completion: { bleuScore: number; exactMatch: number; count: number };
		bugLocalization: { accuracy: number; count: number };
		functionSelection: { accuracy: number; count: number };
		overall: number;
	};
}

export interface AnalysisSection {
	correlationMatrix: CorrelationMatrix;
	interRaterAgreement?: InterRaterAgreement;
	significantDifferences: SignificantDifference[];
}

export interface SignificantDifference {
	modelA: string;
	modelB: string;
	metric: string;
	difference: number;
	significant: boolean;
}

export interface RawDataSection {
	summaries: GeneratedSummary[];
	evaluationResults: EvaluationResult[];
	pairwiseResults: PairwiseResult[];
}

// ============================================================================
// JSON Reporter
// ============================================================================

export interface JSONReporterOptions {
	includeRawData?: boolean;
	prettyPrint?: boolean;
}

export class JSONReporter {
	private options: JSONReporterOptions;

	constructor(options: JSONReporterOptions = {}) {
		this.options = {
			includeRawData: options.includeRawData ?? false,
			prettyPrint: options.prettyPrint ?? true,
		};
	}

	/**
	 * Generate JSON report
	 */
	generate(input: {
		run: BenchmarkRun;
		config: BenchmarkConfig;
		aggregations: Map<string, ModelAggregation>;
		scores: AggregatedScore[];
		correlationMatrix: CorrelationMatrix;
		interRaterAgreement?: InterRaterAgreement;
		summaries?: GeneratedSummary[];
		evaluationResults?: EvaluationResult[];
		pairwiseResults?: PairwiseResult[];
	}): JSONReport {
		const {
			run,
			config,
			aggregations,
			scores,
			correlationMatrix,
			interRaterAgreement,
			summaries,
			evaluationResults,
			pairwiseResults,
		} = input;

		const report: JSONReport = {
			meta: this.buildMeta(run, config),
			summary: this.buildExecutiveSummary(run, scores, aggregations),
			rankings: this.buildRankings(scores),
			detailedResults: this.buildDetailedResults(aggregations, scores),
			analysis: {
				correlationMatrix,
				interRaterAgreement,
				significantDifferences: [], // Would need statistical tests
			},
		};

		if (
			this.options.includeRawData &&
			summaries &&
			evaluationResults &&
			pairwiseResults
		) {
			report.rawData = {
				summaries,
				evaluationResults,
				pairwiseResults,
			};
		}

		return report;
	}

	/**
	 * Write report to file
	 */
	writeToFile(report: JSONReport, filePath: string): void {
		const json = this.options.prettyPrint
			? JSON.stringify(report, null, 2)
			: JSON.stringify(report);
		writeFileSync(filePath, json, "utf-8");
	}

	/**
	 * Convert report to string
	 */
	toString(report: JSONReport): string {
		return this.options.prettyPrint
			? JSON.stringify(report, null, 2)
			: JSON.stringify(report);
	}

	// ============================================================================
	// Private Methods
	// ============================================================================

	private buildMeta(run: BenchmarkRun, config: BenchmarkConfig): ReportMeta {
		return {
			benchmarkVersion: "2.0.0",
			runId: run.id,
			runName: run.name,
			startedAt: run.startedAt,
			completedAt: run.completedAt || new Date().toISOString(),
			config,
		};
	}

	private buildExecutiveSummary(
		run: BenchmarkRun,
		scores: AggregatedScore[],
		aggregations: Map<string, ModelAggregation>,
	): ExecutiveSummary {
		const topModel = scores.length > 0 ? scores[0] : null;

		// Determine which evaluation methods were used
		const methodsUsed: string[] = [];
		for (const agg of aggregations.values()) {
			if (agg.judge.pointwise.overall.count > 0) {
				if (!methodsUsed.includes("judge")) methodsUsed.push("judge");
			}
			if (
				agg.contrastive.embedding.count > 0 ||
				agg.contrastive.llm.count > 0
			) {
				if (!methodsUsed.includes("contrastive"))
					methodsUsed.push("contrastive");
			}
			if (agg.retrieval.mrr > 0) {
				if (!methodsUsed.includes("retrieval")) methodsUsed.push("retrieval");
			}
			if (agg.downstream.overall > 0) {
				if (!methodsUsed.includes("downstream")) methodsUsed.push("downstream");
			}
		}

		// Calculate totals
		let totalSummaries = 0;
		let totalEvaluations = 0;
		for (const agg of aggregations.values()) {
			totalSummaries += agg.judge.pointwise.overall.count;
			totalEvaluations +=
				agg.judge.pointwise.overall.count +
				agg.contrastive.embedding.count +
				agg.contrastive.llm.count +
				agg.downstream.completion.count +
				agg.downstream.bugLocalization.count +
				agg.downstream.functionSelection.count;
		}

		return {
			totalModels: scores.length,
			totalCodeUnits: run.codebaseInfo?.sampledCodeUnits || 0,
			totalSummaries,
			totalEvaluations,
			topModel: topModel?.modelId || "N/A",
			topModelScore: topModel?.overallScore || 0,
			evaluationMethodsUsed: methodsUsed,
		};
	}

	private buildRankings(scores: AggregatedScore[]): ModelRanking[] {
		return scores.map((score) => ({
			rank: score.rank,
			modelId: score.modelId,
			overallScore: score.overallScore,
			judgeScore: score.judgeScore,
			contrastiveAccuracy: score.contrastiveAccuracy,
			retrievalMRR: score.retrievalMRR,
			downstreamScore: score.downstreamScore,
		}));
	}

	private buildDetailedResults(
		aggregations: Map<string, ModelAggregation>,
		scores: AggregatedScore[],
	): DetailedModelResults[] {
		const results: DetailedModelResults[] = [];

		for (const score of scores) {
			const agg = aggregations.get(score.modelId);
			if (!agg) continue;

			results.push({
				modelId: score.modelId,
				rank: score.rank,
				judge: {
					pointwise: agg.judge.pointwise,
					pairwise: {
						wins: agg.judge.pairwise.wins,
						losses: agg.judge.pairwise.losses,
						ties: agg.judge.pairwise.ties,
						winRate: agg.judge.pairwise.winRate,
					},
				},
				contrastive: agg.contrastive,
				retrieval: {
					mrr: agg.retrieval.mrr,
					precision: agg.retrieval.precision,
				},
				downstream: agg.downstream,
			});
		}

		return results;
	}
}

// ============================================================================
// Factory Function
// ============================================================================

export function createJSONReporter(
	options?: JSONReporterOptions,
): JSONReporter {
	return new JSONReporter(options);
}
