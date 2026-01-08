/**
 * Pipeline Orchestrator
 *
 * Coordinates the execution of all benchmark phases.
 * Handles:
 * - Sequential phase execution
 * - Parallel evaluation execution (where dependencies allow)
 * - Error recovery and resumption
 * - Progress reporting
 */

import type { BenchmarkDatabase } from "../storage/benchmark-db.js";
import type {
	BenchmarkConfig,
	BenchmarkPhase,
	BenchmarkProgressCallback,
	BenchmarkRun,
	BenchmarkReport,
	BenchmarkCodeUnit,
	GeneratedSummary,
	EvaluationResult,
	NormalizedScores,
} from "../types.js";
import { PipelineStateMachine, PHASES, PHASE_NAMES } from "./state.js";
import { wrapError, BenchmarkError } from "../errors.js";

// ============================================================================
// Phase Executor Interface
// ============================================================================

/** Context passed to phase executors */
export interface PhaseContext {
	db: BenchmarkDatabase;
	run: BenchmarkRun;
	config: BenchmarkConfig;
	stateMachine: PipelineStateMachine;
}

/** Result of a phase execution */
export interface PhaseResult {
	success: boolean;
	itemsProcessed: number;
	error?: string;
	/** Detailed failure information for display after phase completes */
	failures?: Array<{ model: string; count: number; error: string }>;
	/** Reason for skipping (when itemsProcessed=0 and success=true) */
	skipReason?: string;
}

/** Phase executor function signature */
export type PhaseExecutor = (context: PhaseContext) => Promise<PhaseResult>;

// ============================================================================
// Orchestrator
// ============================================================================

export interface OrchestratorOptions {
	/** Progress callback for all phases */
	onProgress?: BenchmarkProgressCallback;
	/** Callback when a phase completes (with results including failures) */
	onPhaseComplete?: (phase: BenchmarkPhase, result: PhaseResult) => void;
	/** Whether to run evaluation phases in parallel */
	parallelEvaluation?: boolean;
	/** Abort signal for cancellation */
	abortSignal?: AbortSignal;
}

export class PipelineOrchestrator {
	private db: BenchmarkDatabase;
	private stateMachine: PipelineStateMachine;
	private config: BenchmarkConfig;
	private benchmarkRun: BenchmarkRun;
	private options: OrchestratorOptions;
	private phaseExecutors: Map<BenchmarkPhase, PhaseExecutor>;

	constructor(
		db: BenchmarkDatabase,
		benchmarkRun: BenchmarkRun,
		options: OrchestratorOptions = {},
	) {
		this.db = db;
		this.benchmarkRun = benchmarkRun;
		this.config = benchmarkRun.config;
		this.options = options;

		this.stateMachine = new PipelineStateMachine(
			db,
			benchmarkRun,
			options.onProgress,
		);
		this.phaseExecutors = new Map();
	}

	// ==========================================================================
	// Executor Registration
	// ==========================================================================

	registerExecutor(phase: BenchmarkPhase, executor: PhaseExecutor): void {
		this.phaseExecutors.set(phase, executor);
	}

	registerAllExecutors(executors: Record<BenchmarkPhase, PhaseExecutor>): void {
		for (const [phase, executor] of Object.entries(executors)) {
			this.phaseExecutors.set(phase as BenchmarkPhase, executor);
		}
	}

	// ==========================================================================
	// Execution
	// ==========================================================================

	async run(): Promise<BenchmarkReport> {
		try {
			// Start or resume the benchmark
			if (this.stateMachine.canResume()) {
				this.stateMachine.resume();
			}

			// Execute phases in order
			await this.executePhases();

			// Return final report
			return this.generateReport();
		} catch (error) {
			const wrappedError = wrapError(
				error,
				this.stateMachine.getCurrentPhase(),
			);
			this.stateMachine.fail(wrappedError.message);
			throw wrappedError;
		}
	}

	async runPhase(phase: BenchmarkPhase): Promise<PhaseResult> {
		const executor = this.phaseExecutors.get(phase);
		if (!executor) {
			throw new BenchmarkError(
				`No executor registered for phase: ${phase}`,
				"MISSING_EXECUTOR",
			);
		}

		// Validate we can run this phase
		this.stateMachine.validateTransition(
			this.stateMachine.getCurrentPhase(),
			phase,
		);

		const context: PhaseContext = {
			db: this.db,
			run: this.benchmarkRun,
			config: this.config,
			stateMachine: this.stateMachine,
		};

		try {
			const result = await executor(context);

			// If executor returned early without starting the phase (itemsProcessed=0),
			// trigger a progress notification so CLI can show "skipped"
			if (
				result.itemsProcessed === 0 &&
				!this.stateMachine.getPhaseState(phase)
			) {
				this.stateMachine.startPhase(phase, 0);
			}

			if (result.success) {
				this.stateMachine.completePhase(phase);
			} else {
				// Ensure we fail the phase even if no error message is provided
				this.stateMachine.failPhase(
					phase,
					result.error || "Phase failed without error message",
				);
			}

			// Notify about phase completion (with failures if any)
			this.options.onPhaseComplete?.(phase, result);

			return result;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.stateMachine.failPhase(phase, message);
			throw error;
		}
	}

	private async executePhases(): Promise<void> {
		// Check for abort
		if (this.options.abortSignal?.aborted) {
			throw new BenchmarkError("Benchmark aborted", "ABORTED");
		}

		// Get the next phase to execute
		let nextPhase = this.stateMachine.getNextPhase();

		while (nextPhase) {
			// Check for abort before each phase
			if (this.options.abortSignal?.aborted) {
				this.stateMachine.pause();
				throw new BenchmarkError("Benchmark aborted", "ABORTED");
			}

			// Check if the benchmark has failed (don't continue after failure)
			if (this.stateMachine.getStatus() === "failed") {
				const error = this.stateMachine.getError() || "Benchmark failed";
				throw new BenchmarkError(error, "PHASE_FAILED");
			}

			// Check if we have an executor for this phase
			if (!this.phaseExecutors.has(nextPhase)) {
				// Skip phases without executors (disabled evaluations)
				this.stateMachine.startPhase(nextPhase, 0);
				this.stateMachine.completePhase(nextPhase);
				nextPhase = this.stateMachine.getNextPhase();
				continue;
			}

			// Check if we can run evaluation phases in parallel
			if (
				this.options.parallelEvaluation &&
				nextPhase.startsWith("evaluation:")
			) {
				await this.executeEvaluationPhasesParallel();
			} else {
				await this.runPhase(nextPhase);
			}

			nextPhase = this.stateMachine.getNextPhase();
		}
	}

	private async executeEvaluationPhasesParallel(): Promise<void> {
		const evaluationPhases: BenchmarkPhase[] = [
			"evaluation:judge",
			"evaluation:contrastive",
			"evaluation:retrieval",
			"evaluation:downstream",
		];

		// Filter to only enabled evaluations and those not yet complete
		const phasesToRun = evaluationPhases.filter((phase) => {
			if (this.stateMachine.isPhaseComplete(phase)) return false;

			// Check if evaluation is enabled in config
			switch (phase) {
				case "evaluation:judge":
					return this.config.evaluation.judge.enabled;
				case "evaluation:contrastive":
					return this.config.evaluation.contrastive.enabled;
				case "evaluation:retrieval":
					return this.config.evaluation.retrieval.enabled;
				case "evaluation:downstream":
					return this.config.evaluation.downstream.enabled;
				default:
					return true;
			}
		});

		if (phasesToRun.length === 0) return;

		// Run enabled phases in parallel
		const results = await Promise.allSettled(
			phasesToRun.map((phase) => this.runPhase(phase)),
		);

		// Check for failures
		const failures = results.filter(
			(r): r is PromiseRejectedResult => r.status === "rejected",
		);

		if (failures.length > 0) {
			const errors = failures.map((f) => f.reason?.message || String(f.reason));
			throw new BenchmarkError(
				`Evaluation phases failed: ${errors.join("; ")}`,
				"EVALUATION_FAILED",
			);
		}
	}

	// ==========================================================================
	// Report Generation
	// ==========================================================================

	private generateReport(): BenchmarkReport {
		// This will be implemented by the reporter module
		// For now, return a placeholder structure
		const scores = this.db.getAggregatedScores(this.benchmarkRun.id);

		return {
			metadata: {
				benchmarkId: this.benchmarkRun.id,
				name: this.benchmarkRun.name,
				runDate: this.benchmarkRun.startedAt,
				duration: this.calculateDuration(),
				codebase: this.benchmarkRun.codebaseInfo,
				configuration: this.config,
			},
			rankings: this.generateRankings(scores),
			detailed: {
				byModel: scores,
				byLanguage: new Map(),
				byCodeType: new Map(),
			},
			comparisons: [],
			statistics: {
				significanceTests: [],
			},
			failures: {
				byModel: new Map(),
				commonPatterns: [],
			},
			costs: {
				byModel: new Map(),
				total: 0,
			},
		};
	}

	private calculateDuration(): string {
		const start = new Date(this.benchmarkRun.startedAt);
		const end = this.benchmarkRun.completedAt
			? new Date(this.benchmarkRun.completedAt)
			: new Date();
		const durationMs = end.getTime() - start.getTime();

		const hours = Math.floor(durationMs / (1000 * 60 * 60));
		const minutes = Math.floor((durationMs % (1000 * 60 * 60)) / (1000 * 60));
		const seconds = Math.floor((durationMs % (1000 * 60)) / 1000);

		if (hours > 0) {
			return `${hours}h ${minutes}m ${seconds}s`;
		} else if (minutes > 0) {
			return `${minutes}m ${seconds}s`;
		} else {
			return `${seconds}s`;
		}
	}

	private generateRankings(
		scores: Map<string, NormalizedScores>,
	): BenchmarkReport["rankings"] {
		const rankings = Array.from(scores.entries())
			.map(([modelId, score]) => ({
				rank: 0,
				modelId,
				modelName:
					this.config.generators.find((g) => g.id === modelId)?.displayName ||
					modelId,
				overallScore: score.overall,
				scores: {
					judge: score.judge.combined,
					contrastive: score.contrastive.combined,
					retrieval: score.retrieval.combined,
					downstream: score.downstream.combined,
				},
			}))
			.sort((a, b) => b.overallScore - a.overallScore);

		// Assign ranks
		rankings.forEach((r, i) => {
			r.rank = i + 1;
		});

		return rankings;
	}

	// ==========================================================================
	// State Access
	// ==========================================================================

	getStateMachine(): PipelineStateMachine {
		return this.stateMachine;
	}

	pause(): void {
		this.stateMachine.pause();
	}

	getSummary(): ReturnType<PipelineStateMachine["getSummary"]> {
		return this.stateMachine.getSummary();
	}
}

// ============================================================================
// Factory Function
// ============================================================================

export function createOrchestrator(
	db: BenchmarkDatabase,
	run: BenchmarkRun,
	options?: OrchestratorOptions,
): PipelineOrchestrator {
	return new PipelineOrchestrator(db, run, options);
}
