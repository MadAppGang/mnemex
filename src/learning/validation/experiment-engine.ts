/**
 * Experiment Engine
 *
 * Orchestrates A/B validation experiments including parallel execution,
 * result aggregation, and decision making.
 *
 * @module learning/validation/experiment-engine
 */

import type {
	ValidationScenario,
	ValidationExperiment,
	ExperimentResults,
	AggregateResults,
	ScenarioResults,
	ExperimentDecision,
	ExperimentDecisionAction,
	ExecutionTask,
	ExecutionResult,
	ExecutionStatus,
	RunConfig,
	ExperimentGroup,
	RecordedSession,
	TierConfig,
	ValidationTier,
	StatisticalComparison,
} from "./types.js";
import { VALIDATION_TIERS } from "./types.js";
import type { ValidationStore } from "./validation-store.js";
import type { ScenarioLibrary } from "./scenario-library.js";
import { StatisticsEngine } from "./statistics-engine.js";
import type { EnvironmentManager } from "./environment-manager.js";
import { SessionRecorder, CriteriaEvaluator } from "./session-recorder.js";
import { SyntheticAgent } from "./synthetic-agent.js";
import type { AgentDriver } from "./agent-driver.js";

// ============================================================================
// Experiment Engine
// ============================================================================

/**
 * Orchestrates validation experiments with A/B testing.
 */
export class ExperimentEngine {
	private store: ValidationStore;
	private scenarioLibrary: ScenarioLibrary;
	private statisticsEngine: StatisticsEngine;
	private executor: ParallelExecutor;
	private decisionEngine: DecisionEngine;

	constructor(options: ExperimentEngineOptions) {
		this.store = options.store;
		this.scenarioLibrary = options.scenarioLibrary;
		this.statisticsEngine = options.statisticsEngine ?? new StatisticsEngine();
		this.executor = new ParallelExecutor(options.executorConfig ?? {});
		this.decisionEngine = new DecisionEngine(this.statisticsEngine);
	}

	// ============================================================================
	// Experiment Lifecycle
	// ============================================================================

	/**
	 * Create and run a new experiment
	 */
	async runExperiment(config: ExperimentConfig): Promise<ExperimentResults> {
		// Create experiment record
		const experiment = this.createExperiment(config);
		this.store.createExperiment(experiment);

		try {
			// Update status to running
			this.store.updateExperimentStatus(experiment.experimentId, "running");

			// Get scenarios to run
			const scenarios = this.getScenarios(config.scenarios);

			// Build execution tasks
			const tasks = this.buildTasks(experiment, scenarios);

			// Execute all tasks
			const results = await this.executor.execute(tasks, config.driverFactory);

			// Aggregate results
			const aggregated = this.aggregateResults(
				experiment.experimentId,
				results,
			);

			// Make decision
			const decision = this.decisionEngine.decide(aggregated);

			// Save results
			const experimentResults: ExperimentResults = {
				experimentId: experiment.experimentId,
				baseline: aggregated.baseline,
				treatment: aggregated.treatment,
				comparison: aggregated.comparison,
				decision,
				completedAt: Date.now(),
			};

			this.store.saveExperimentResults(experimentResults);
			this.store.updateExperimentStatus(experiment.experimentId, "complete");

			return experimentResults;
		} catch (error) {
			this.store.updateExperimentStatus(experiment.experimentId, "failed");
			throw error;
		}
	}

	/**
	 * Run a validation tier (smoke, standard, deep, release)
	 */
	async runTier(
		tier: ValidationTier,
		improvements: string[],
		driverFactory: DriverFactory,
	): Promise<ExperimentResults> {
		const tierConfig = VALIDATION_TIERS[tier];

		const scenarios =
			tierConfig.scenarios === "all"
				? this.scenarioLibrary.getIds()
				: tierConfig.scenarios;

		return this.runExperiment({
			improvementIds: improvements,
			scenarios,
			runsPerScenario: tierConfig.runsPerScenario,
			driverFactory,
			timeout: tierConfig.maxDurationMs,
		});
	}

	// ============================================================================
	// Experiment Setup
	// ============================================================================

	private createExperiment(config: ExperimentConfig): ValidationExperiment {
		const experimentId = this.generateExperimentId();
		const now = Date.now();

		return {
			experimentId,
			improvementIds: config.improvementIds,
			scenarios: config.scenarios,
			runsPerScenario: config.runsPerScenario,
			status: "pending",
			createdAt: now,
			updatedAt: now,
		};
	}

	private getScenarios(scenarioIds: string[]): ValidationScenario[] {
		return this.scenarioLibrary.getByIds(scenarioIds);
	}

	private buildTasks(
		experiment: ValidationExperiment,
		scenarios: ValidationScenario[],
	): ExecutionTask[] {
		const tasks: ExecutionTask[] = [];

		for (const scenario of scenarios) {
			for (let run = 0; run < experiment.runsPerScenario; run++) {
				// Baseline (control) task
				tasks.push({
					scenarioId: scenario.id,
					runIndex: run,
					config: {
						experimentId: experiment.experimentId,
						group: "control",
						improvements: [],
					},
				});

				// Treatment task
				tasks.push({
					scenarioId: scenario.id,
					runIndex: run,
					config: {
						experimentId: experiment.experimentId,
						group: "treatment",
						improvements: experiment.improvementIds,
					},
				});
			}
		}

		return tasks;
	}

	// ============================================================================
	// Result Aggregation
	// ============================================================================

	private aggregateResults(
		experimentId: string,
		results: ExecutionResult[],
	): AggregatedExperimentResults {
		// Separate by group
		const baselineResults = results.filter(
			(r) => r.task.config.group === "control" && r.session,
		);
		const treatmentResults = results.filter(
			(r) => r.task.config.group === "treatment" && r.session,
		);

		const baselineSessions = baselineResults
			.map((r) => r.session!)
			.filter(Boolean);
		const treatmentSessions = treatmentResults
			.map((r) => r.session!)
			.filter(Boolean);

		// Calculate aggregates
		const baseline = this.calculateAggregates(baselineSessions);
		const treatment = this.calculateAggregates(treatmentSessions);

		// Statistical comparison
		const comparison = this.statisticsEngine.compareMetrics(
			baselineSessions,
			treatmentSessions,
		);

		return { baseline, treatment, comparison };
	}

	private calculateAggregates(sessions: RecordedSession[]): AggregateResults {
		const totalRuns = sessions.length;
		const successfulRuns = sessions.filter(
			(s) => s.outcome === "success",
		).length;
		const failedRuns = sessions.filter((s) => s.outcome === "failure").length;

		const avgCorrectionRate = this.average(
			sessions,
			(s) => s.metrics.correctionRate,
		);
		const avgErrorRate = this.average(sessions, (s) => s.metrics.errorRate);
		const avgAutonomyRate = this.average(
			sessions,
			(s) => s.metrics.autonomyRate,
		);
		const avgDurationMs = this.average(sessions, (s) => s.durationMs);

		// Group by scenario
		const byScenario = new Map<string, ScenarioResults>();
		const grouped = this.groupBy(sessions, (s) => s.scenarioId);

		for (const [scenarioId, scenarioSessions] of Object.entries(grouped)) {
			byScenario.set(scenarioId, {
				scenarioId,
				runs: scenarioSessions.length,
				successRate:
					scenarioSessions.filter((s) => s.outcome === "success").length /
					scenarioSessions.length,
				avgCorrectionRate: this.average(
					scenarioSessions,
					(s) => s.metrics.correctionRate,
				),
				avgDurationMs: this.average(scenarioSessions, (s) => s.durationMs),
			});
		}

		return {
			totalRuns,
			successfulRuns,
			failedRuns,
			successRate: totalRuns > 0 ? successfulRuns / totalRuns : 0,
			avgCorrectionRate,
			avgErrorRate,
			avgAutonomyRate,
			avgDurationMs,
			byScenario,
		};
	}

	// ============================================================================
	// Utility Functions
	// ============================================================================

	private generateExperimentId(): string {
		const timestamp = Date.now().toString(36);
		const random = Math.random().toString(36).slice(2, 8);
		return `exp_${timestamp}_${random}`;
	}

	private average<T>(items: T[], getter: (item: T) => number): number {
		if (items.length === 0) return 0;
		return items.reduce((sum, item) => sum + getter(item), 0) / items.length;
	}

	private groupBy<T>(
		items: T[],
		keyGetter: (item: T) => string,
	): Record<string, T[]> {
		return items.reduce(
			(groups, item) => {
				const key = keyGetter(item);
				(groups[key] = groups[key] ?? []).push(item);
				return groups;
			},
			{} as Record<string, T[]>,
		);
	}
}

// ============================================================================
// Parallel Executor
// ============================================================================

/**
 * Executes validation tasks in parallel with worker pool.
 */
export class ParallelExecutor {
	private concurrency: number;
	private timeout: number;
	private retryCount: number;

	constructor(config: Partial<ExecutorConfig> = {}) {
		this.concurrency = config.concurrency ?? 4;
		this.timeout = config.timeout ?? 300000; // 5 minutes
		this.retryCount = config.retryCount ?? 1;
	}

	/**
	 * Execute all tasks with controlled concurrency
	 */
	async execute(
		tasks: ExecutionTask[],
		driverFactory: DriverFactory,
	): Promise<ExecutionResult[]> {
		const results: ExecutionResult[] = [];
		const pending = [...tasks];

		// Process in batches based on concurrency
		while (pending.length > 0) {
			const batch = pending.splice(0, this.concurrency);

			const batchResults = await Promise.all(
				batch.map((task) => this.executeTask(task, driverFactory)),
			);

			results.push(...batchResults);
		}

		return results;
	}

	/**
	 * Execute a single task with timeout and retry
	 */
	private async executeTask(
		task: ExecutionTask,
		driverFactory: DriverFactory,
	): Promise<ExecutionResult> {
		const startTime = Date.now();
		let lastError: Error | undefined;

		for (let attempt = 0; attempt <= this.retryCount; attempt++) {
			try {
				const session = await this.runWithTimeout(
					() => this.runTask(task, driverFactory),
					this.timeout,
				);

				return {
					task,
					status: "fulfilled",
					session,
					durationMs: Date.now() - startTime,
				};
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error));

				// Don't retry on timeout
				if (lastError.message.includes("timeout")) {
					return {
						task,
						status: "timeout",
						error: lastError,
						durationMs: Date.now() - startTime,
					};
				}
			}
		}

		return {
			task,
			status: "rejected",
			error: lastError,
			durationMs: Date.now() - startTime,
		};
	}

	/**
	 * Run a single validation task
	 */
	private async runTask(
		task: ExecutionTask,
		driverFactory: DriverFactory,
	): Promise<RecordedSession> {
		// Create driver and environment
		const driver = await driverFactory(task.config);

		// Get scenario
		// Note: In practice, this would need access to scenario library
		// For now, we assume the driver handles scenario setup

		// Create session recorder
		const recorder = new SessionRecorder({
			scenarioId: task.scenarioId,
			experimentId: task.config.experimentId,
			experimentGroup: task.config.group,
		});

		// Run validation loop
		// Note: Full implementation would involve SyntheticAgent interaction loop
		// This is a simplified version

		// Finalize and return
		return recorder.finalize([], "success");
	}

	/**
	 * Run with timeout (clears timer on completion to prevent memory leaks)
	 */
	private async runWithTimeout<T>(
		fn: () => Promise<T>,
		timeout: number,
	): Promise<T> {
		let timeoutId: ReturnType<typeof setTimeout>;

		const timeoutPromise = new Promise<never>((_, reject) => {
			timeoutId = setTimeout(() => reject(new Error("Task timeout")), timeout);
		});

		try {
			const result = await Promise.race([fn(), timeoutPromise]);
			clearTimeout(timeoutId!);
			return result;
		} catch (error) {
			clearTimeout(timeoutId!);
			throw error;
		}
	}
}

// ============================================================================
// Decision Engine
// ============================================================================

/**
 * Makes graduation/rollback decisions based on experiment results.
 */
export class DecisionEngine {
	private statisticsEngine: StatisticsEngine;

	constructor(statisticsEngine: StatisticsEngine) {
		this.statisticsEngine = statisticsEngine;
	}

	/**
	 * Decide whether to graduate, rollback, extend, or continue
	 */
	decide(results: AggregatedExperimentResults): ExperimentDecision {
		const { baseline, treatment, comparison } = results;

		// Check for regressions (any significant negative change)
		const regressions = this.findRegressions(comparison);
		if (regressions.length > 0) {
			return {
				action: "rollback",
				confidence: this.calculateConfidence(regressions, comparison),
				reason: `Significant regression detected in: ${regressions.join(", ")}`,
				significantMetrics: regressions,
			};
		}

		// Check for improvements
		const improvements = this.findImprovements(comparison);

		if (improvements.length >= 2) {
			// Strong evidence of improvement
			return {
				action: "graduate",
				confidence: this.calculateConfidence(improvements, comparison),
				reason: `Significant improvement in: ${improvements.join(", ")}`,
				significantMetrics: improvements,
			};
		}

		if (improvements.length === 1) {
			// Single improvement - need more data
			return {
				action: "extend",
				confidence: 0.6,
				reason: `Single metric improved (${improvements[0]}). Recommend extending experiment for more data.`,
				significantMetrics: improvements,
			};
		}

		// No significant changes
		const sampleSize = baseline.totalRuns + treatment.totalRuns;
		if (sampleSize < 40) {
			return {
				action: "extend",
				confidence: 0.5,
				reason: "Insufficient sample size. Recommend extending experiment.",
				significantMetrics: [],
			};
		}

		return {
			action: "continue",
			confidence: 0.7,
			reason: "No significant changes detected. Changes may be neutral.",
			significantMetrics: [],
		};
	}

	/**
	 * Find metrics with significant regression
	 */
	private findRegressions(comparison: StatisticalComparison): string[] {
		const regressions: string[] = [];

		if (
			comparison.correctionRate.statisticallySignificant &&
			!comparison.correctionRate.improved
		) {
			regressions.push("correctionRate");
		}

		if (
			comparison.successRate.statisticallySignificant &&
			!comparison.successRate.improved
		) {
			regressions.push("successRate");
		}

		if (
			comparison.autonomyRate.statisticallySignificant &&
			!comparison.autonomyRate.improved
		) {
			regressions.push("autonomyRate");
		}

		if (
			comparison.errorRate.statisticallySignificant &&
			!comparison.errorRate.improved
		) {
			regressions.push("errorRate");
		}

		return regressions;
	}

	/**
	 * Find metrics with significant improvement
	 */
	private findImprovements(comparison: StatisticalComparison): string[] {
		const improvements: string[] = [];

		if (
			comparison.correctionRate.statisticallySignificant &&
			comparison.correctionRate.improved
		) {
			improvements.push("correctionRate");
		}

		if (
			comparison.successRate.statisticallySignificant &&
			comparison.successRate.improved
		) {
			improvements.push("successRate");
		}

		if (
			comparison.autonomyRate.statisticallySignificant &&
			comparison.autonomyRate.improved
		) {
			improvements.push("autonomyRate");
		}

		if (
			comparison.errorRate.statisticallySignificant &&
			comparison.errorRate.improved
		) {
			improvements.push("errorRate");
		}

		return improvements;
	}

	/**
	 * Calculate decision confidence
	 */
	private calculateConfidence(
		significantMetrics: string[],
		comparison: StatisticalComparison,
	): number {
		if (significantMetrics.length === 0) return 0.5;

		// Average (1 - p-value) for significant metrics
		let sumConfidence = 0;

		for (const metric of significantMetrics) {
			const metricComparison =
				comparison[metric as keyof StatisticalComparison];
			if (
				typeof metricComparison === "object" &&
				"pValue" in metricComparison
			) {
				sumConfidence += 1 - metricComparison.pValue;
			}
		}

		return Math.min(sumConfidence / significantMetrics.length, 0.99);
	}
}

// ============================================================================
// Supporting Types
// ============================================================================

export interface ExperimentEngineOptions {
	store: ValidationStore;
	scenarioLibrary: ScenarioLibrary;
	statisticsEngine?: StatisticsEngine;
	executorConfig?: Partial<ExecutorConfig>;
}

export interface ExperimentConfig {
	improvementIds: string[];
	scenarios: string[];
	runsPerScenario: number;
	driverFactory: DriverFactory;
	timeout?: number;
}

export interface ExecutorConfig {
	concurrency: number;
	timeout: number;
	retryCount: number;
}

export type DriverFactory = (config: RunConfig) => Promise<AgentDriver>;

interface AggregatedExperimentResults {
	baseline: AggregateResults;
	treatment: AggregateResults;
	comparison: StatisticalComparison;
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create an experiment engine
 */
export function createExperimentEngine(
	options: ExperimentEngineOptions,
): ExperimentEngine {
	return new ExperimentEngine(options);
}
