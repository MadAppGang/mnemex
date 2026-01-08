/**
 * Pipeline State Machine
 *
 * Manages benchmark execution state with support for:
 * - Phase transitions with validation
 * - Resumability from any phase
 * - Progress tracking
 * - Error recovery
 */

import {
	InvalidPhaseTransitionError,
	IncompletePhaseError,
	StateError,
} from "../errors.js";
import type { BenchmarkDatabase } from "../storage/benchmark-db.js";
import type {
	BenchmarkPhase,
	BenchmarkStatus,
	BenchmarkRun,
	BenchmarkProgressCallback,
} from "../types.js";

// ============================================================================
// Phase Definitions
// ============================================================================

/** Ordered list of all benchmark phases */
export const PHASES: readonly BenchmarkPhase[] = [
	"extraction",
	"generation",
	"evaluation:iterative", // Runs first to refine summaries before other evaluations
	"evaluation:judge",
	"evaluation:contrastive",
	"evaluation:retrieval",
	"evaluation:downstream",
	"evaluation:self",
	"aggregation",
	"reporting",
] as const;

/** Phase dependencies - which phases must complete before a phase can start */
export const PHASE_DEPENDENCIES: Record<BenchmarkPhase, BenchmarkPhase[]> = {
	extraction: [],
	generation: ["extraction"],
	"evaluation:iterative": ["generation"],
	"evaluation:judge": ["evaluation:iterative"], // Uses refined summaries
	"evaluation:contrastive": ["evaluation:iterative"],
	"evaluation:retrieval": ["evaluation:iterative"],
	"evaluation:downstream": ["evaluation:iterative"],
	"evaluation:self": ["evaluation:iterative"],
	aggregation: [
		"evaluation:iterative",
		"evaluation:judge",
		"evaluation:contrastive",
		"evaluation:retrieval",
		"evaluation:downstream",
		"evaluation:self",
	],
	reporting: ["aggregation"],
};

/** Human-readable phase names */
export const PHASE_NAMES: Record<BenchmarkPhase, string> = {
	extraction: "Code Extraction",
	generation: "Summary Generation",
	"evaluation:iterative": "Iterative Refinement",
	"evaluation:judge": "LLM-as-Judge Evaluation",
	"evaluation:contrastive": "Contrastive Matching",
	"evaluation:retrieval": "Retrieval Evaluation",
	"evaluation:downstream": "Downstream Tasks",
	"evaluation:self": "Self-Evaluation",
	aggregation: "Score Aggregation",
	reporting: "Report Generation",
};

// ============================================================================
// State Machine
// ============================================================================

export interface PhaseState {
	phase: BenchmarkPhase;
	total: number;
	completed: number;
	isComplete: boolean;
	error?: string;
}

export interface PipelineState {
	runId: string;
	status: BenchmarkStatus;
	currentPhase?: BenchmarkPhase;
	phases: Map<BenchmarkPhase, PhaseState>;
	startedAt: string;
	pausedAt?: string;
	completedAt?: string;
	error?: string;
}

export class PipelineStateMachine {
	private db: BenchmarkDatabase;
	private runId: string;
	private state: PipelineState;
	private progressCallback?: BenchmarkProgressCallback;

	constructor(
		db: BenchmarkDatabase,
		run: BenchmarkRun,
		progressCallback?: BenchmarkProgressCallback,
	) {
		this.db = db;
		this.runId = run.id;
		this.progressCallback = progressCallback;

		// Initialize state from run
		this.state = {
			runId: run.id,
			status: run.status,
			currentPhase: run.currentPhase,
			phases: new Map(),
			startedAt: run.startedAt,
			pausedAt: run.pausedAt,
			completedAt: run.completedAt,
			error: run.error,
		};

		// Load phase progress from database
		this.loadPhaseProgress();
	}

	private loadPhaseProgress(): void {
		for (const phase of PHASES) {
			const progress = this.db.getPhaseProgress(this.runId, phase);
			if (progress) {
				this.state.phases.set(phase, {
					phase,
					total: progress.total,
					completed: progress.completed,
					isComplete: progress.isComplete,
				});
			}
		}
	}

	// ==========================================================================
	// State Queries
	// ==========================================================================

	getState(): PipelineState {
		return { ...this.state };
	}

	getCurrentPhase(): BenchmarkPhase | undefined {
		return this.state.currentPhase;
	}

	getStatus(): BenchmarkStatus {
		return this.state.status;
	}

	getError(): string | undefined {
		return this.state.error;
	}

	getPhaseState(phase: BenchmarkPhase): PhaseState | undefined {
		return this.state.phases.get(phase);
	}

	isPhaseComplete(phase: BenchmarkPhase): boolean {
		return this.state.phases.get(phase)?.isComplete ?? false;
	}

	areAllDependenciesComplete(phase: BenchmarkPhase): boolean {
		const dependencies = PHASE_DEPENDENCIES[phase];
		return dependencies.every((dep) => this.isPhaseComplete(dep));
	}

	getNextPhase(): BenchmarkPhase | null {
		// Find the first incomplete phase whose dependencies are satisfied
		for (const phase of PHASES) {
			if (
				!this.isPhaseComplete(phase) &&
				this.areAllDependenciesComplete(phase)
			) {
				return phase;
			}
		}
		return null;
	}

	getIncompletePhases(): BenchmarkPhase[] {
		return PHASES.filter((phase) => !this.isPhaseComplete(phase));
	}

	isComplete(): boolean {
		return PHASES.every((phase) => this.isPhaseComplete(phase));
	}

	canResume(): boolean {
		return (
			this.state.status === "paused" ||
			this.state.status === "failed" ||
			this.state.status === "pending"
		);
	}

	// ==========================================================================
	// Phase Transitions
	// ==========================================================================

	startPhase(phase: BenchmarkPhase, totalItems: number): void {
		// Validate transition
		if (!this.areAllDependenciesComplete(phase)) {
			const incomplete = PHASE_DEPENDENCIES[phase].filter(
				(dep) => !this.isPhaseComplete(dep),
			);
			throw new IncompletePhaseError(
				phase,
				`Dependencies not complete: ${incomplete.join(", ")}`,
			);
		}

		// Update state
		this.state.currentPhase = phase;
		this.state.status = "running";
		this.state.phases.set(phase, {
			phase,
			total: totalItems,
			completed: 0,
			isComplete: false,
		});

		// Persist to database
		this.db.updateRunStatus(this.runId, "running", phase);
		this.db.startPhase(this.runId, phase, totalItems);

		// Notify callback
		this.notifyProgress(phase, 0, totalItems);
	}

	updateProgress(
		phase: BenchmarkPhase,
		completed: number,
		lastProcessedId?: string,
		details?: string,
	): void {
		const phaseState = this.state.phases.get(phase);
		if (!phaseState) {
			throw new StateError(`Phase ${phase} has not been started`);
		}

		phaseState.completed = completed;

		// Persist to database
		this.db.updatePhaseProgress(this.runId, phase, completed, lastProcessedId);

		// Notify callback
		this.notifyProgress(phase, completed, phaseState.total, details);
	}

	completePhase(phase: BenchmarkPhase): void {
		const phaseState = this.state.phases.get(phase);
		if (!phaseState) {
			throw new StateError(`Phase ${phase} has not been started`);
		}

		phaseState.isComplete = true;
		phaseState.completed = phaseState.total;

		// Persist to database
		this.db.completePhase(this.runId, phase);

		// Check if all phases complete
		if (this.isComplete()) {
			this.complete();
		}
	}

	failPhase(phase: BenchmarkPhase, error: string): void {
		const phaseState = this.state.phases.get(phase);
		if (phaseState) {
			phaseState.error = error;
		}

		this.state.status = "failed";
		this.state.error = error;

		// Persist to database
		this.db.updateRunStatus(this.runId, "failed", phase, error);
	}

	pause(): void {
		if (this.state.status !== "running") {
			throw new StateError(`Cannot pause: status is ${this.state.status}`);
		}

		this.state.status = "paused";
		this.state.pausedAt = new Date().toISOString();

		// Persist to database
		this.db.updateRunStatus(this.runId, "paused", this.state.currentPhase);
	}

	resume(): BenchmarkPhase | null {
		if (!this.canResume()) {
			throw new StateError(`Cannot resume: status is ${this.state.status}`);
		}

		this.state.status = "running";
		this.state.pausedAt = undefined;

		const nextPhase = this.getNextPhase();
		if (nextPhase) {
			this.state.currentPhase = nextPhase;
			this.db.updateRunStatus(this.runId, "running", nextPhase);
		}

		return nextPhase;
	}

	complete(): void {
		this.state.status = "completed";
		this.state.completedAt = new Date().toISOString();

		// Persist to database
		this.db.updateRunStatus(this.runId, "completed");
	}

	fail(error: string): void {
		this.state.status = "failed";
		this.state.error = error;

		// Persist to database
		this.db.updateRunStatus(
			this.runId,
			"failed",
			this.state.currentPhase,
			error,
		);
	}

	// ==========================================================================
	// Progress Reporting
	// ==========================================================================

	private notifyProgress(
		phase: BenchmarkPhase,
		completed: number,
		total: number,
		details?: string,
	): void {
		if (this.progressCallback) {
			this.progressCallback(phase, completed, total, details);
		}
	}

	setProgressCallback(callback: BenchmarkProgressCallback): void {
		this.progressCallback = callback;
	}

	// ==========================================================================
	// Validation
	// ==========================================================================

	validateTransition(
		from: BenchmarkPhase | undefined,
		to: BenchmarkPhase,
	): void {
		// If starting the same phase we're "in", this isn't a transition -
		// it's the initial start of that phase (resume() sets currentPhase
		// before the phase actually runs)
		if (from === to) {
			// Just check dependencies are met
			if (!this.areAllDependenciesComplete(to)) {
				const incomplete = PHASE_DEPENDENCIES[to].filter(
					(dep) => !this.isPhaseComplete(dep),
				);
				throw new IncompletePhaseError(
					to,
					`Dependencies not complete: ${incomplete.join(", ")}`,
				);
			}
			return;
		}

		// If coming from a different phase, it must be complete
		if (from && !this.isPhaseComplete(from)) {
			throw new IncompletePhaseError(from, "Phase not complete");
		}

		// Target phase dependencies must be complete
		if (!this.areAllDependenciesComplete(to)) {
			throw new InvalidPhaseTransitionError(from ?? "extraction", to);
		}
	}

	// ==========================================================================
	// Resumption Helpers
	// ==========================================================================

	getResumePoint(phase: BenchmarkPhase): {
		lastProcessedId?: string;
		completed: number;
		total: number;
	} | null {
		const progress = this.db.getPhaseProgress(this.runId, phase);
		if (!progress) return null;

		return {
			lastProcessedId: progress.lastProcessedId,
			completed: progress.completed,
			total: progress.total,
		};
	}

	/** Get a summary of the pipeline state for display */
	getSummary(): {
		status: BenchmarkStatus;
		currentPhase?: string;
		progress: Array<{
			phase: string;
			name: string;
			status: "pending" | "in_progress" | "complete" | "error";
			completed: number;
			total: number;
		}>;
	} {
		const progress = PHASES.map((phase) => {
			const state = this.state.phases.get(phase);
			let status: "pending" | "in_progress" | "complete" | "error" = "pending";

			if (state?.error) {
				status = "error";
			} else if (state?.isComplete) {
				status = "complete";
			} else if (this.state.currentPhase === phase) {
				status = "in_progress";
			}

			return {
				phase,
				name: PHASE_NAMES[phase],
				status,
				completed: state?.completed ?? 0,
				total: state?.total ?? 0,
			};
		});

		return {
			status: this.state.status,
			currentPhase: this.state.currentPhase
				? PHASE_NAMES[this.state.currentPhase]
				: undefined,
			progress,
		};
	}
}

// ============================================================================
// Factory Function
// ============================================================================

export function createPipelineStateMachine(
	db: BenchmarkDatabase,
	run: BenchmarkRun,
	progressCallback?: BenchmarkProgressCallback,
): PipelineStateMachine {
	return new PipelineStateMachine(db, run, progressCallback);
}
