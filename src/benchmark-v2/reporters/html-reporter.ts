/**
 * HTML Reporter
 *
 * Outputs benchmark results as a standalone HTML document
 * with interactive charts and sortable tables.
 */

import { writeFileSync } from "fs";
import type {
	BenchmarkRun,
	BenchmarkConfig,
	AggregatedScore,
} from "../types.js";
import type { ModelAggregation } from "../scorers/aggregator.js";
import type { CorrelationMatrix } from "../scorers/statistics.js";
import { detectSameProviderBias, getModelProvider } from "../index.js";

// ============================================================================
// HTML Reporter
// ============================================================================

export interface HTMLReporterOptions {
	includeInteractiveCharts?: boolean;
	theme?: "light" | "dark";
}

export class HTMLReporter {
	private options: HTMLReporterOptions;

	constructor(options: HTMLReporterOptions = {}) {
		this.options = {
			includeInteractiveCharts: options.includeInteractiveCharts ?? true,
			theme: options.theme ?? "light",
		};
	}

	/**
	 * Generate HTML report
	 */
	generate(input: {
		run: BenchmarkRun;
		config: BenchmarkConfig;
		aggregations: Map<string, ModelAggregation>;
		scores: AggregatedScore[];
		correlationMatrix?: CorrelationMatrix;
	}): string {
		const { run, config, aggregations, scores, correlationMatrix } = input;

		return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>LLM Benchmark Report - ${run.name}</title>
    ${this.generateStyles()}
    ${this.options.includeInteractiveCharts ? this.generateChartLibrary() : ""}
</head>
<body class="${this.options.theme}">
    <div class="container">
        ${this.generateHeader(run)}
        ${this.generateExecutiveSummary(run, scores, aggregations)}
        ${this.generateRankingsSection(scores)}
        ${this.options.includeInteractiveCharts ? this.generateChartSection(scores) : ""}
        ${this.generateDetailedResults(aggregations, scores)}
        ${correlationMatrix ? this.generateCorrelationSection(correlationMatrix) : ""}
        ${this.generateMethodology(
					config,
					scores.map((s) => s.modelId),
				)}
        ${this.generateFooter(run)}
    </div>
    ${this.options.includeInteractiveCharts ? this.generateChartScripts(scores, correlationMatrix) : ""}
</body>
</html>`;
	}

	/**
	 * Write report to file
	 */
	writeToFile(report: string, filePath: string): void {
		writeFileSync(filePath, report, "utf-8");
	}

	// ============================================================================
	// HTML Sections
	// ============================================================================

	private generateStyles(): string {
		return `<style>
        :root {
            --bg-primary: #ffffff;
            --bg-secondary: #f8f9fa;
            --text-primary: #212529;
            --text-secondary: #6c757d;
            --border-color: #dee2e6;
            --accent-color: #0d6efd;
            --success-color: #198754;
            --warning-color: #ffc107;
        }

        .dark {
            --bg-primary: #1a1a2e;
            --bg-secondary: #16213e;
            --text-primary: #eaeaea;
            --text-secondary: #a0a0a0;
            --border-color: #404040;
            --accent-color: #4dabf7;
        }

        * { box-sizing: border-box; margin: 0; padding: 0; }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: var(--bg-primary);
            color: var(--text-primary);
            line-height: 1.6;
            padding: 2rem;
        }

        .container {
            max-width: 1200px;
            margin: 0 auto;
        }

        h1, h2, h3 { margin-bottom: 1rem; }
        h1 { font-size: 2rem; border-bottom: 2px solid var(--accent-color); padding-bottom: 0.5rem; }
        h2 { font-size: 1.5rem; margin-top: 2rem; }
        h3 { font-size: 1.2rem; margin-top: 1.5rem; }

        .summary-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 1rem;
            margin: 1.5rem 0;
        }

        .summary-card {
            background: var(--bg-secondary);
            border-radius: 8px;
            padding: 1.5rem;
            text-align: center;
        }

        .summary-card .value {
            font-size: 2rem;
            font-weight: bold;
            color: var(--accent-color);
        }

        .summary-card .label {
            color: var(--text-secondary);
            font-size: 0.9rem;
        }

        table {
            width: 100%;
            border-collapse: collapse;
            margin: 1rem 0;
        }

        th, td {
            padding: 0.75rem;
            text-align: left;
            border-bottom: 1px solid var(--border-color);
        }

        th {
            background: var(--bg-secondary);
            font-weight: 600;
            cursor: pointer;
        }

        th:hover { background: var(--border-color); }

        tr:hover { background: var(--bg-secondary); }

        .rank-badge {
            display: inline-block;
            width: 28px;
            height: 28px;
            border-radius: 50%;
            text-align: center;
            line-height: 28px;
            font-weight: bold;
            font-size: 0.9rem;
        }

        .rank-1 { background: #ffd700; color: #000; }
        .rank-2 { background: #c0c0c0; color: #000; }
        .rank-3 { background: #cd7f32; color: #fff; }

        .progress-bar {
            height: 8px;
            background: var(--bg-secondary);
            border-radius: 4px;
            overflow: hidden;
        }

        .progress-fill {
            height: 100%;
            background: var(--accent-color);
            border-radius: 4px;
            transition: width 0.3s ease;
        }

        .chart-container {
            background: var(--bg-secondary);
            border-radius: 8px;
            padding: 1rem;
            margin: 1rem 0;
            min-height: 300px;
        }

        .method-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 1rem;
            margin: 1rem 0;
        }

        .method-card {
            background: var(--bg-secondary);
            border-radius: 8px;
            padding: 1.5rem;
        }

        .method-card h4 {
            margin-bottom: 0.5rem;
            color: var(--accent-color);
        }

        footer {
            margin-top: 3rem;
            padding-top: 1rem;
            border-top: 1px solid var(--border-color);
            color: var(--text-secondary);
            font-size: 0.9rem;
        }

        .tabs {
            display: flex;
            border-bottom: 2px solid var(--border-color);
            margin-bottom: 1rem;
        }

        .tab {
            padding: 0.75rem 1.5rem;
            cursor: pointer;
            border-bottom: 2px solid transparent;
            margin-bottom: -2px;
        }

        .tab.active {
            border-bottom-color: var(--accent-color);
            font-weight: 600;
        }

        .tab-content { display: none; }
        .tab-content.active { display: block; }
    </style>`;
	}

	private generateChartLibrary(): string {
		return `<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>`;
	}

	private generateHeader(run: BenchmarkRun): string {
		return `<header>
        <h1>🔬 LLM Summary Benchmark Report</h1>
        <p><strong>Run:</strong> ${run.name} | <strong>Date:</strong> ${new Date(run.startedAt).toLocaleDateString()} | <strong>Status:</strong> ${run.status}</p>
    </header>`;
	}

	private generateExecutiveSummary(
		run: BenchmarkRun,
		scores: AggregatedScore[],
		aggregations: Map<string, ModelAggregation>,
	): string {
		const topModel = scores[0];

		let totalEvaluations = 0;
		for (const agg of aggregations.values()) {
			totalEvaluations +=
				agg.judge.pointwise.overall.count +
				agg.contrastive.embedding.count +
				agg.contrastive.llm.count;
		}

		return `<section>
        <h2>📊 Executive Summary</h2>
        <div class="summary-grid">
            <div class="summary-card">
                <div class="value">${scores.length}</div>
                <div class="label">Models Evaluated</div>
            </div>
            <div class="summary-card">
                <div class="value">${run.codebaseInfo?.sampledCodeUnits || "N/A"}</div>
                <div class="label">Code Units</div>
            </div>
            <div class="summary-card">
                <div class="value">${totalEvaluations}</div>
                <div class="label">Total Evaluations</div>
            </div>
            <div class="summary-card">
                <div class="value" style="font-size: 1.2rem">${topModel?.modelId || "N/A"}</div>
                <div class="label">🏆 Top Model</div>
            </div>
        </div>
    </section>`;
	}

	private generateRankingsSection(scores: AggregatedScore[]): string {
		const rows = scores
			.map(
				(score) => `<tr>
            <td><span class="rank-badge ${score.rank <= 3 ? `rank-${score.rank}` : ""}">${score.rank}</span></td>
            <td><strong>${score.modelId}</strong></td>
            <td>
                <div>${(score.overallScore * 100).toFixed(1)}%</div>
                <div class="progress-bar"><div class="progress-fill" style="width: ${score.overallScore * 100}%"></div></div>
            </td>
            <td>${(score.retrievalMRR * 100).toFixed(1)}%</td>
            <td>${(score.contrastiveAccuracy * 100).toFixed(1)}%</td>
            <td>${((score.judgeScore / 5) * 100).toFixed(1)}%</td>
        </tr>`,
			)
			.join("");

		return `<section>
        <h2>🏆 Quality Rankings</h2>
        <p style="color: var(--text-secondary); margin-bottom: 1rem;">
            How well summaries serve LLM agents for code understanding.
            Weights: Retrieval 45%, Contrastive 30%, Judge 25%.
        </p>
        <table>
            <thead>
                <tr>
                    <th>Rank</th>
                    <th>Model</th>
                    <th>Overall</th>
                    <th>Retrieval (45%)</th>
                    <th>Contrastive (30%)</th>
                    <th>Judge (25%)</th>
                </tr>
            </thead>
            <tbody>
                ${rows}
            </tbody>
        </table>
    </section>`;
	}

	private generateChartSection(scores: AggregatedScore[]): string {
		return `<section>
        <h2>📈 Visualizations</h2>
        <div class="tabs">
            <div class="tab active" onclick="showTab('bar-chart')">Bar Chart</div>
            <div class="tab" onclick="showTab('radar-chart')">Radar Chart</div>
        </div>
        <div id="bar-chart" class="tab-content active">
            <div class="chart-container">
                <canvas id="barChart"></canvas>
            </div>
        </div>
        <div id="radar-chart" class="tab-content">
            <div class="chart-container">
                <canvas id="radarChart"></canvas>
            </div>
        </div>
    </section>`;
	}

	private generateDetailedResults(
		aggregations: Map<string, ModelAggregation>,
		scores: AggregatedScore[],
	): string {
		const modelDetails = scores
			.slice(0, 5)
			.map((score) => {
				const agg = aggregations.get(score.modelId);
				if (!agg) return "";

				return `<div class="method-card">
                <h4>${score.modelId}</h4>
                <p><strong>Judge Score:</strong> ${agg.judge.pointwise.overall.mean.toFixed(2)}/5</p>
                <p><strong>Pairwise:</strong> ${agg.judge.pairwise.wins}W / ${agg.judge.pairwise.losses}L / ${agg.judge.pairwise.ties}T</p>
                <p><strong>Contrastive:</strong> ${(agg.contrastive.combined * 100).toFixed(1)}%</p>
                <p><strong>MRR:</strong> ${(agg.retrieval.mrr * 100).toFixed(1)}%</p>
            </div>`;
			})
			.join("");

		return `<section>
        <h2>📋 Detailed Results (Top 5)</h2>
        <div class="method-grid">
            ${modelDetails}
        </div>
    </section>`;
	}

	private generateCorrelationSection(matrix: CorrelationMatrix): string {
		const rows = matrix.metrics
			.map((metric, i) => {
				const cells = matrix.values[i]
					.map((v) => {
						const color =
							v > 0.7
								? "rgba(25, 135, 84, 0.3)"
								: v > 0.4
									? "rgba(255, 193, 7, 0.3)"
									: "rgba(220, 53, 69, 0.2)";
						return `<td style="background: ${color}">${v.toFixed(2)}</td>`;
					})
					.join("");
				return `<tr><td><strong>${metric}</strong></td>${cells}</tr>`;
			})
			.join("");

		return `<section>
        <h2>🔗 Correlation Matrix</h2>
        <p>How well different evaluation methods agree with each other:</p>
        <table>
            <thead>
                <tr>
                    <th></th>
                    ${matrix.metrics.map((m) => `<th>${m}</th>`).join("")}
                </tr>
            </thead>
            <tbody>
                ${rows}
            </tbody>
        </table>
    </section>`;
	}

	private generateMethodology(
		config: BenchmarkConfig,
		generatorIds?: string[],
	): string {
		const judgeModels =
			config.evaluation.judge.judgeModels || config.judges || [];
		const generators = generatorIds || [];
		const biasedPairs = detectSameProviderBias(generators, judgeModels);

		const biasWarning =
			biasedPairs.length > 0
				? `
        <div style="background: #fff3cd; border: 1px solid #ffc107; border-radius: 8px; padding: 1rem; margin-top: 1rem;">
            <h4 style="color: #856404; margin-bottom: 0.5rem;">⚠️ Same-Provider Bias Warning</h4>
            <p style="color: #856404; margin-bottom: 0.5rem;">
                Some models are being judged by models from the same provider (e.g., Claude judging Claude).
                These scores may be biased as models from the same family may rate each other favorably.
            </p>
            <ul style="color: #856404; margin: 0; padding-left: 1.5rem;">
                ${biasedPairs.map((p) => `<li>${p.generator} judged by ${p.judge} (${p.provider})</li>`).join("")}
            </ul>
        </div>`
				: "";

		return `<section>
        <h2>📖 Methodology</h2>
        <h3>Quality Metrics (determine ranking)</h3>
        <p style="color: var(--text-secondary); margin-bottom: 1rem;">
            These metrics measure how well summaries serve LLM agents for code understanding.
        </p>
        <div class="method-grid">
            <div class="method-card">
                <h4>🔍 Retrieval (45%)</h4>
                <p><strong>Can agents FIND the right code?</strong></p>
                <p>Metrics: P@K, MRR</p>
                <p>K values: ${config.evaluation.retrieval.kValues?.join(", ") || "1, 3, 5, 10"}</p>
            </div>
            <div class="method-card">
                <h4>🎯 Contrastive (30%)</h4>
                <p><strong>Can agents DISTINGUISH similar code?</strong></p>
                <p>Method: ${config.evaluation.contrastive.method || "both"}</p>
                <p>Distractors: ${config.evaluation.contrastive.distractorCount || 9}</p>
            </div>
            <div class="method-card">
                <h4>📋 Judge (25%)</h4>
                <p><strong>Is the summary accurate and complete?</strong></p>
                <p>5-point scale across 5 criteria</p>
                <p>Judges: ${judgeModels.join(", ") || "N/A"}</p>
            </div>
        </div>
        ${biasWarning}
        <h3 style="margin-top: 2rem;">Operational Metrics (reported separately)</h3>
        <p style="color: var(--text-secondary); margin-bottom: 1rem;">
            Production efficiency metrics for cost/speed decisions. Don't affect quality ranking.
        </p>
        <div class="method-grid">
            <div class="method-card">
                <h4>⚡ Latency</h4>
                <p>Avg time to generate summaries</p>
                <p>Lower = faster indexing</p>
            </div>
            <div class="method-card">
                <h4>💰 Cost</h4>
                <p>Total generation cost per model</p>
                <p>Lower = cheaper production</p>
            </div>
            <div class="method-card">
                <h4>🔄 Refinement</h4>
                <p>Avg rounds to achieve target rank</p>
                <p>Lower = better first-try quality</p>
            </div>
            <div class="method-card">
                <h4>🔁 Self-Eval</h4>
                <p>Can model use its own summaries?</p>
                <p>Internal consistency check</p>
            </div>
        </div>
    </section>`;
	}

	private generateFooter(run: BenchmarkRun): string {
		const duration = run.completedAt
			? Math.round(
					(new Date(run.completedAt).getTime() -
						new Date(run.startedAt).getTime()) /
						1000 /
						60,
				)
			: "N/A";

		return `<footer>
        <p>Generated by claudemem benchmark v2.0.0 | Run ID: ${run.id} | Duration: ${duration} minutes</p>
    </footer>`;
	}

	private generateChartScripts(
		scores: AggregatedScore[],
		correlationMatrix?: CorrelationMatrix,
	): string {
		const labels = scores.slice(0, 10).map((s) => s.modelId);
		const overallData = scores
			.slice(0, 10)
			.map((s) => (s.overallScore * 100).toFixed(1));
		const judgeData = scores
			.slice(0, 10)
			.map((s) => ((s.judgeScore / 5) * 100).toFixed(1));
		const contrastiveData = scores
			.slice(0, 10)
			.map((s) => (s.contrastiveAccuracy * 100).toFixed(1));
		const retrievalData = scores
			.slice(0, 10)
			.map((s) => (s.retrievalMRR * 100).toFixed(1));
		const downstreamData = scores
			.slice(0, 10)
			.map((s) => (s.downstreamScore * 100).toFixed(1));

		return `<script>
        // Tab switching
        function showTab(tabId) {
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            event.target.classList.add('active');
            document.getElementById(tabId).classList.add('active');
        }

        // Bar Chart
        new Chart(document.getElementById('barChart'), {
            type: 'bar',
            data: {
                labels: ${JSON.stringify(labels)},
                datasets: [{
                    label: 'Overall Score (%)',
                    data: [${overallData.join(", ")}],
                    backgroundColor: 'rgba(13, 110, 253, 0.7)',
                    borderColor: 'rgba(13, 110, 253, 1)',
                    borderWidth: 1
                }]
            },
            options: {
                responsive: true,
                scales: {
                    y: {
                        beginAtZero: true,
                        max: 100
                    }
                }
            }
        });

        // Radar Chart
        new Chart(document.getElementById('radarChart'), {
            type: 'radar',
            data: {
                labels: ['Judge', 'Contrastive', 'Retrieval', 'Downstream'],
                datasets: ${JSON.stringify(
									scores.slice(0, 5).map((s, i) => ({
										label: s.modelId,
										data: [
											parseFloat(((s.judgeScore / 5) * 100).toFixed(1)),
											parseFloat((s.contrastiveAccuracy * 100).toFixed(1)),
											parseFloat((s.retrievalMRR * 100).toFixed(1)),
											parseFloat((s.downstreamScore * 100).toFixed(1)),
										],
										borderColor: `hsl(${i * 72}, 70%, 50%)`,
										backgroundColor: `hsla(${i * 72}, 70%, 50%, 0.2)`,
									})),
								)}
            },
            options: {
                responsive: true,
                scales: {
                    r: {
                        beginAtZero: true,
                        max: 100
                    }
                }
            }
        });
    </script>`;
	}
}

// ============================================================================
// Factory Function
// ============================================================================

export function createHTMLReporter(
	options?: HTMLReporterOptions,
): HTMLReporter {
	return new HTMLReporter(options);
}
