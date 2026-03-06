/**
 * Benchmark Database
 *
 * SQLite persistence layer for benchmark runs.
 * Enables resumable benchmarks and result storage.
 */

import { randomUUID } from "crypto";
import { readFileSync, existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import { createDatabaseSync, type SQLiteDatabase } from "../../core/sqlite.js";
import {
	DatabaseError,
	RunNotFoundError,
	CorruptedDataError,
} from "../errors.js";
import type {
	BenchmarkRun,
	BenchmarkCodeUnit,
	GeneratedSummary,
	GenerationMetadata,
	EvaluationResult,
	PairwiseResult,
	GeneratedQuery,
	DistractorSet,
	CompletionTask,
	BugLocalizationTask,
	FunctionSelectionTask,
	NormalizedScores,
	BenchmarkPhase,
	BenchmarkStatus,
	BenchmarkConfig,
	CodebaseInfo,
	DBBenchmarkRun,
	DBCodeUnit,
	DBGeneratedSummary,
	DBEvaluationResult,
	DBPairwiseResult,
	DBGeneratedQuery,
} from "../types.js";

// ============================================================================
// Database Class
// ============================================================================

export class BenchmarkDatabase {
	private db: SQLiteDatabase;
	private readonly dbPath: string;

	constructor(dbPath: string) {
		this.dbPath = dbPath;

		// Ensure directory exists
		const dir = dirname(dbPath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}

		this.db = createDatabaseSync(dbPath);
		this.db.exec("PRAGMA journal_mode = WAL");
		this.db.exec("PRAGMA foreign_keys = ON");
		this.initialize();
	}

	private initialize(): void {
		try {
			// Load and execute schema from SQL file
			const schemaPath = join(
				dirname(fileURLToPath(import.meta.url)),
				"schema.sql",
			);
			const schema = readFileSync(schemaPath, "utf-8");
			this.db.exec(schema);

			// Migrate existing databases: add embedding_model column if missing
			try {
				this.db.exec(
					"ALTER TABLE evaluation_results ADD COLUMN embedding_model TEXT",
				);
			} catch {
				// Column already exists - safe to ignore
			}
		} catch (error) {
			throw new DatabaseError(
				"initialize",
				"Failed to initialize database schema",
				error instanceof Error ? error : undefined,
			);
		}
	}

	// ==========================================================================
	// Benchmark Run Operations
	// ==========================================================================

	createRun(config: BenchmarkConfig): BenchmarkRun {
		const id = randomUUID();
		const now = new Date().toISOString();

		const stmt = this.db.prepare(`
			INSERT INTO benchmark_runs (
				id, name, description, config_json, status, started_at
			) VALUES (?, ?, ?, ?, 'pending', ?)
		`);

		stmt.run(
			id,
			config.name,
			config.description ?? null,
			JSON.stringify(config),
			now,
		);

		return {
			id,
			name: config.name,
			description: config.description,
			config,
			codebaseInfo: {} as CodebaseInfo, // Will be set during extraction
			modelsUnderTest: config.generators,
			judgeModels: config.judges.map((j) => ({
				id: j,
				provider: "anthropic" as const,
				modelName: j,
				temperature: 0,
				maxTokens: 4096,
			})),
			status: "pending",
			startedAt: now,
		};
	}

	getRun(runId: string): BenchmarkRun {
		const stmt = this.db.prepare(`
			SELECT * FROM benchmark_runs WHERE id = ?
		`);

		const row = stmt.get(runId) as DBBenchmarkRun | undefined;
		if (!row) {
			throw new RunNotFoundError(runId);
		}

		return this.rowToRun(row);
	}

	updateRunStatus(
		runId: string,
		status: BenchmarkStatus,
		phase?: BenchmarkPhase,
		error?: string,
	): void {
		const updates: string[] = ["status = ?"];
		const params: (string | null)[] = [status];

		if (phase !== undefined) {
			updates.push("current_phase = ?");
			params.push(phase);
		}

		if (error !== undefined) {
			updates.push("error = ?");
			params.push(error);
		}

		if (status === "completed") {
			updates.push("completed_at = datetime('now')");
		} else if (status === "paused") {
			updates.push("paused_at = datetime('now')");
		}

		params.push(runId);

		const stmt = this.db.prepare(`
			UPDATE benchmark_runs SET ${updates.join(", ")} WHERE id = ?
		`);
		stmt.run(...params);
	}

	updateCodebaseInfo(runId: string, info: CodebaseInfo): void {
		const stmt = this.db.prepare(`
			UPDATE benchmark_runs SET codebase_info_json = ? WHERE id = ?
		`);
		stmt.run(JSON.stringify(info), runId);
	}

	listRuns(status?: BenchmarkStatus): BenchmarkRun[] {
		let query = "SELECT * FROM benchmark_runs";
		const params: string[] = [];

		if (status) {
			query += " WHERE status = ?";
			params.push(status);
		}

		query += " ORDER BY created_at DESC";

		const stmt = this.db.prepare(query);
		const rows = stmt.all(...params) as DBBenchmarkRun[];

		return rows.map((row) => this.rowToRun(row));
	}

	deleteRun(runId: string): void {
		const stmt = this.db.prepare("DELETE FROM benchmark_runs WHERE id = ?");
		stmt.run(runId);
	}

	private rowToRun(row: DBBenchmarkRun): BenchmarkRun {
		try {
			const config = JSON.parse(row.config_json) as BenchmarkConfig;
			const codebaseInfo = row.codebase_info_json
				? (JSON.parse(row.codebase_info_json) as CodebaseInfo)
				: ({} as CodebaseInfo);

			return {
				id: row.id,
				name: row.name,
				description: row.description ?? undefined,
				config,
				codebaseInfo,
				modelsUnderTest: config.generators,
				judgeModels: config.judges.map((j) => ({
					id: j,
					provider: "anthropic" as const,
					modelName: j,
					temperature: 0,
					maxTokens: 4096,
				})),
				status: row.status,
				currentPhase: row.current_phase ?? undefined,
				startedAt: row.started_at,
				completedAt: row.completed_at ?? undefined,
				pausedAt: row.paused_at ?? undefined,
				error: row.error ?? undefined,
			};
		} catch (error) {
			throw new CorruptedDataError(
				"benchmark_run",
				row.id,
				"Failed to parse JSON fields",
				error instanceof Error ? error : undefined,
			);
		}
	}

	// ==========================================================================
	// Code Unit Operations
	// ==========================================================================

	insertCodeUnit(runId: string, codeUnit: BenchmarkCodeUnit): void {
		const stmt = this.db.prepare(`
			INSERT OR REPLACE INTO code_units (
				id, run_id, path, name, type, language, content,
				metadata_json, relationships_json
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);

		stmt.run(
			codeUnit.id,
			runId,
			codeUnit.path,
			codeUnit.name,
			codeUnit.type,
			codeUnit.language,
			codeUnit.content,
			JSON.stringify(codeUnit.metadata),
			JSON.stringify(codeUnit.relationships),
		);
	}

	insertCodeUnits(runId: string, codeUnits: BenchmarkCodeUnit[]): void {
		const stmt = this.db.prepare(`
			INSERT OR REPLACE INTO code_units (
				id, run_id, path, name, type, language, content,
				metadata_json, relationships_json
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);

		this.db.transaction(() => {
			for (const unit of codeUnits) {
				stmt.run(
					unit.id,
					runId,
					unit.path,
					unit.name,
					unit.type,
					unit.language,
					unit.content,
					JSON.stringify(unit.metadata),
					JSON.stringify(unit.relationships),
				);
			}
		});
	}

	getCodeUnits(runId: string): BenchmarkCodeUnit[] {
		const stmt = this.db.prepare(`
			SELECT * FROM code_units WHERE run_id = ?
		`);

		const rows = stmt.all(runId) as DBCodeUnit[];
		return rows.map((row) => this.rowToCodeUnit(row));
	}

	getCodeUnit(id: string): BenchmarkCodeUnit | null {
		const stmt = this.db.prepare(`
			SELECT * FROM code_units WHERE id = ?
		`);

		const row = stmt.get(id) as DBCodeUnit | undefined;
		if (!row) return null;

		return this.rowToCodeUnit(row);
	}

	getCodeUnitCount(runId: string): number {
		const stmt = this.db.prepare(`
			SELECT COUNT(*) as count FROM code_units WHERE run_id = ?
		`);
		const result = stmt.get(runId) as { count: number };
		return result.count;
	}

	private rowToCodeUnit(row: DBCodeUnit): BenchmarkCodeUnit {
		try {
			return {
				id: row.id,
				path: row.path,
				name: row.name,
				type: row.type,
				language: row.language,
				content: row.content,
				metadata: JSON.parse(row.metadata_json),
				relationships: JSON.parse(row.relationships_json),
			};
		} catch (error) {
			throw new CorruptedDataError(
				"code_unit",
				row.id,
				"Failed to parse JSON fields",
				error instanceof Error ? error : undefined,
			);
		}
	}

	// ==========================================================================
	// Generated Summary Operations
	// ==========================================================================

	insertSummary(runId: string, summary: GeneratedSummary): void {
		const stmt = this.db.prepare(`
			INSERT OR REPLACE INTO generated_summaries (
				id, run_id, code_unit_id, model_id, summary, generation_metadata_json
			) VALUES (?, ?, ?, ?, ?, ?)
		`);

		stmt.run(
			summary.id,
			runId,
			summary.codeUnitId,
			summary.modelId,
			summary.summary,
			JSON.stringify(summary.generationMetadata),
		);
	}

	insertSummaries(runId: string, summaries: GeneratedSummary[]): void {
		const stmt = this.db.prepare(`
			INSERT OR REPLACE INTO generated_summaries (
				id, run_id, code_unit_id, model_id, summary, generation_metadata_json
			) VALUES (?, ?, ?, ?, ?, ?)
		`);

		this.db.transaction(() => {
			for (const summary of summaries) {
				stmt.run(
					summary.id,
					runId,
					summary.codeUnitId,
					summary.modelId,
					summary.summary,
					JSON.stringify(summary.generationMetadata),
				);
			}
		});
	}

	getSummaries(runId: string, modelId?: string): GeneratedSummary[] {
		let query = "SELECT * FROM generated_summaries WHERE run_id = ?";
		const params: string[] = [runId];

		if (modelId) {
			query += " AND model_id = ?";
			params.push(modelId);
		}

		const stmt = this.db.prepare(query);
		const rows = stmt.all(...params) as DBGeneratedSummary[];

		return rows.map((row) => this.rowToSummary(row));
	}

	getSummary(id: string): GeneratedSummary | null {
		const stmt = this.db.prepare(`
			SELECT * FROM generated_summaries WHERE id = ?
		`);

		const row = stmt.get(id) as DBGeneratedSummary | undefined;
		if (!row) return null;

		return this.rowToSummary(row);
	}

	getSummaryCount(runId: string, modelId?: string): number {
		let query =
			"SELECT COUNT(*) as count FROM generated_summaries WHERE run_id = ?";
		const params: string[] = [runId];

		if (modelId) {
			query += " AND model_id = ?";
			params.push(modelId);
		}

		const stmt = this.db.prepare(query);
		const result = stmt.get(...params) as { count: number };
		return result.count;
	}

	/**
	 * Update a summary (e.g., after iterative refinement)
	 */
	updateSummary(
		runId: string,
		summaryId: string,
		updates: { summary?: string; generationMetadata?: GenerationMetadata },
	): void {
		const setClause: string[] = [];
		const params: (string | null)[] = [];

		if (updates.summary !== undefined) {
			setClause.push("summary = ?");
			params.push(updates.summary);
		}

		if (updates.generationMetadata !== undefined) {
			setClause.push("generation_metadata_json = ?");
			params.push(JSON.stringify(updates.generationMetadata));
		}

		if (setClause.length === 0) return;

		params.push(runId, summaryId);

		const stmt = this.db.prepare(`
			UPDATE generated_summaries SET ${setClause.join(", ")}
			WHERE run_id = ? AND id = ?
		`);
		stmt.run(...params);
	}

	private rowToSummary(row: DBGeneratedSummary): GeneratedSummary {
		try {
			return {
				id: row.id,
				codeUnitId: row.code_unit_id,
				modelId: row.model_id,
				summary: row.summary,
				generationMetadata: JSON.parse(row.generation_metadata_json),
			};
		} catch (error) {
			throw new CorruptedDataError(
				"generated_summary",
				row.id,
				"Failed to parse JSON fields",
				error instanceof Error ? error : undefined,
			);
		}
	}

	// ==========================================================================
	// Evaluation Result Operations
	// ==========================================================================

	insertEvaluationResult(runId: string, result: EvaluationResult): void {
		const stmt = this.db.prepare(`
			INSERT INTO evaluation_results (
				id, run_id, summary_id, evaluation_type, results_json, evaluated_at, embedding_model
			) VALUES (?, ?, ?, ?, ?, ?, ?)
		`);

		// Build results JSON based on evaluation type
		let resultsJson: string;
		switch (result.evaluationType) {
			case "judge":
				resultsJson = JSON.stringify(result.judgeResults);
				break;
			case "contrastive":
				resultsJson = JSON.stringify(result.contrastiveResults);
				break;
			case "retrieval":
				resultsJson = JSON.stringify(result.retrievalResults);
				break;
			case "downstream":
				resultsJson = JSON.stringify(result.downstreamResults);
				break;
			case "iterative":
				resultsJson = JSON.stringify(result.iterativeResults);
				break;
			case "self":
				resultsJson = JSON.stringify(result.selfEvaluationResults);
				break;
			default:
				resultsJson = "{}";
		}

		// Extract embedding model from retrieval/contrastive results if present
		const embeddingModel =
			result.retrievalResults?.embeddingModelId ??
			result.contrastiveResults?.embeddingModel ??
			null;

		stmt.run(
			result.id,
			runId,
			result.summaryId,
			result.evaluationType,
			resultsJson,
			result.evaluatedAt,
			embeddingModel,
		);
	}

	getEvaluationResults(
		runId: string,
		evaluationType?: string,
		embeddingModel?: string,
	): EvaluationResult[] {
		let query = "SELECT * FROM evaluation_results WHERE run_id = ?";
		const params: string[] = [runId];

		if (evaluationType) {
			query += " AND evaluation_type = ?";
			params.push(evaluationType);
		}

		if (embeddingModel !== undefined) {
			query += " AND embedding_model = ?";
			params.push(embeddingModel);
		}

		const stmt = this.db.prepare(query);
		const rows = stmt.all(...params) as DBEvaluationResult[];

		return rows.map((row) => this.rowToEvaluationResult(row));
	}

	private rowToEvaluationResult(row: DBEvaluationResult): EvaluationResult {
		try {
			const results = JSON.parse(row.results_json);
			const base: EvaluationResult = {
				id: row.id,
				summaryId: row.summary_id,
				evaluationType: row.evaluation_type,
				evaluatedAt: row.evaluated_at,
			};

			switch (row.evaluation_type) {
				case "judge":
					return { ...base, judgeResults: results };
				case "contrastive":
					return { ...base, contrastiveResults: results };
				case "retrieval":
					return { ...base, retrievalResults: results };
				case "downstream":
					return { ...base, downstreamResults: results };
				case "iterative":
					return { ...base, iterativeResults: results };
				case "self":
					return { ...base, selfEvaluationResults: results };
				default:
					return base;
			}
		} catch (error) {
			throw new CorruptedDataError(
				"evaluation_result",
				row.id,
				"Failed to parse JSON fields",
				error instanceof Error ? error : undefined,
			);
		}
	}

	// ==========================================================================
	// Pairwise Result Operations
	// ==========================================================================

	insertPairwiseResult(runId: string, result: PairwiseResult): void {
		const stmt = this.db.prepare(`
			INSERT INTO pairwise_results (
				id, run_id, model_a, model_b, code_unit_id, judge_model,
				winner, confidence, position_swapped, reasoning, criteria_breakdown_json
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);

		stmt.run(
			randomUUID(),
			runId,
			result.modelA,
			result.modelB,
			result.codeUnitId,
			result.judgeModel,
			result.winner,
			result.confidence,
			result.positionSwapped ? 1 : 0,
			result.reasoning ?? null,
			result.criteriaBreakdown
				? JSON.stringify(result.criteriaBreakdown)
				: null,
		);
	}

	insertPairwiseResults(runId: string, results: PairwiseResult[]): void {
		const stmt = this.db.prepare(`
			INSERT INTO pairwise_results (
				id, run_id, model_a, model_b, code_unit_id, judge_model,
				winner, confidence, position_swapped, reasoning, criteria_breakdown_json, cost
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);

		this.db.transaction(() => {
			for (const result of results) {
				stmt.run(
					randomUUID(),
					runId,
					result.modelA,
					result.modelB,
					result.codeUnitId,
					result.judgeModel,
					result.winner,
					result.confidence,
					result.positionSwapped ? 1 : 0,
					result.reasoning ?? null,
					result.criteriaBreakdown
						? JSON.stringify(result.criteriaBreakdown)
						: null,
					result.cost ?? null,
				);
			}
		});
	}

	getPairwiseResults(runId: string): PairwiseResult[] {
		const stmt = this.db.prepare(`
			SELECT * FROM pairwise_results WHERE run_id = ?
		`);

		const rows = stmt.all(runId) as DBPairwiseResult[];
		return rows.map((row) => this.rowToPairwiseResult(row));
	}

	private rowToPairwiseResult(row: DBPairwiseResult): PairwiseResult {
		return {
			modelA: row.model_a,
			modelB: row.model_b,
			codeUnitId: row.code_unit_id,
			judgeModel: row.judge_model,
			winner: row.winner,
			confidence: row.confidence as "high" | "medium" | "low",
			positionSwapped: Boolean(row.position_swapped),
			reasoning: row.reasoning ?? undefined,
			criteriaBreakdown: row.criteria_breakdown_json
				? JSON.parse(row.criteria_breakdown_json)
				: undefined,
			cost: row.cost ?? undefined,
		};
	}

	// ==========================================================================
	// Generated Query Operations
	// ==========================================================================

	insertQueries(runId: string, queries: GeneratedQuery[]): void {
		const stmt = this.db.prepare(`
			INSERT INTO generated_queries (
				id, run_id, code_unit_id, type, query, should_find
			) VALUES (?, ?, ?, ?, ?, ?)
		`);

		this.db.transaction(() => {
			for (const query of queries) {
				stmt.run(
					query.id,
					runId,
					query.codeUnitId,
					query.type,
					query.query,
					query.shouldFind ? 1 : 0,
				);
			}
		});
	}

	getQueries(runId: string): GeneratedQuery[] {
		const stmt = this.db.prepare(`
			SELECT * FROM generated_queries WHERE run_id = ?
		`);

		const rows = stmt.all(runId) as DBGeneratedQuery[];
		return rows.map((row) => ({
			id: row.id,
			codeUnitId: row.code_unit_id,
			type: row.type,
			query: row.query,
			shouldFind: Boolean(row.should_find),
		}));
	}

	// ==========================================================================
	// Distractor Set Operations
	// ==========================================================================

	insertDistractorSets(runId: string, sets: DistractorSet[]): void {
		const stmt = this.db.prepare(`
			INSERT INTO distractor_sets (
				id, run_id, target_code_unit_id, distractor_ids_json, difficulty
			) VALUES (?, ?, ?, ?, ?)
		`);

		this.db.transaction(() => {
			for (const set of sets) {
				stmt.run(
					randomUUID(),
					runId,
					set.targetCodeUnitId,
					JSON.stringify(set.distractorIds),
					set.difficulty,
				);
			}
		});
	}

	getDistractorSets(runId: string): DistractorSet[] {
		const stmt = this.db.prepare(`
			SELECT * FROM distractor_sets WHERE run_id = ?
		`);

		interface DBDistractorSet {
			target_code_unit_id: string;
			distractor_ids_json: string;
			difficulty: string;
		}

		const rows = stmt.all(runId) as DBDistractorSet[];
		return rows.map((row) => ({
			targetCodeUnitId: row.target_code_unit_id,
			distractorIds: JSON.parse(row.distractor_ids_json),
			difficulty: row.difficulty as "easy" | "medium" | "hard",
		}));
	}

	// ==========================================================================
	// Downstream Task Operations
	// ==========================================================================

	insertCompletionTasks(runId: string, tasks: CompletionTask[]): void {
		const stmt = this.db.prepare(`
			INSERT INTO completion_tasks (
				id, run_id, code_unit_id, partial_code, full_code, requirements,
				language, relevant_summary_ids_json, test_cases_json
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);

		this.db.transaction(() => {
			for (const task of tasks) {
				stmt.run(
					task.id,
					runId,
					task.codeUnitId,
					task.partialCode,
					task.fullCode,
					task.requirements,
					task.language,
					JSON.stringify(task.relevantSummaryIds),
					task.testCases ? JSON.stringify(task.testCases) : null,
				);
			}
		});
	}

	insertBugLocalizationTasks(
		runId: string,
		tasks: BugLocalizationTask[],
	): void {
		const stmt = this.db.prepare(`
			INSERT INTO bug_localization_tasks (
				id, run_id, bug_description, actual_buggy_file, candidate_files_json
			) VALUES (?, ?, ?, ?, ?)
		`);

		this.db.transaction(() => {
			for (const task of tasks) {
				stmt.run(
					task.id,
					runId,
					task.bugDescription,
					task.actualBuggyFile,
					JSON.stringify(task.candidateFiles),
				);
			}
		});
	}

	insertFunctionSelectionTasks(
		runId: string,
		tasks: FunctionSelectionTask[],
	): void {
		const stmt = this.db.prepare(`
			INSERT INTO function_selection_tasks (
				id, run_id, task_description, correct_function, candidate_functions_json
			) VALUES (?, ?, ?, ?, ?)
		`);

		this.db.transaction(() => {
			for (const task of tasks) {
				stmt.run(
					task.id,
					runId,
					task.taskDescription,
					task.correctFunction,
					JSON.stringify(task.candidateFunctions),
				);
			}
		});
	}

	// ==========================================================================
	// Aggregated Scores Operations
	// ==========================================================================

	saveAggregatedScores(
		runId: string,
		modelId: string,
		scores: NormalizedScores,
	): void {
		const stmt = this.db.prepare(`
			INSERT OR REPLACE INTO aggregated_scores (
				id, run_id, model_id, scores_json
			) VALUES (?, ?, ?, ?)
		`);

		stmt.run(randomUUID(), runId, modelId, JSON.stringify(scores));
	}

	getAggregatedScores(runId: string): Map<string, NormalizedScores> {
		const stmt = this.db.prepare(`
			SELECT * FROM aggregated_scores WHERE run_id = ?
		`);

		interface DBAggregatedScores {
			model_id: string;
			scores_json: string;
		}

		const rows = stmt.all(runId) as DBAggregatedScores[];
		const result = new Map<string, NormalizedScores>();

		for (const row of rows) {
			result.set(row.model_id, JSON.parse(row.scores_json));
		}

		return result;
	}

	// ==========================================================================
	// Phase Progress Operations
	// ==========================================================================

	startPhase(runId: string, phase: BenchmarkPhase, totalItems: number): void {
		const stmt = this.db.prepare(`
			INSERT OR REPLACE INTO phase_progress (
				run_id, phase, items_total, items_completed
			) VALUES (?, ?, ?, 0)
		`);

		stmt.run(runId, phase, totalItems);
	}

	updatePhaseProgress(
		runId: string,
		phase: BenchmarkPhase,
		completedItems: number,
		lastProcessedId?: string,
	): void {
		const stmt = this.db.prepare(`
			UPDATE phase_progress
			SET items_completed = ?, last_processed_id = ?
			WHERE run_id = ? AND phase = ?
		`);

		stmt.run(completedItems, lastProcessedId ?? null, runId, phase);
	}

	completePhase(runId: string, phase: BenchmarkPhase): void {
		const stmt = this.db.prepare(`
			UPDATE phase_progress
			SET completed_at = datetime('now')
			WHERE run_id = ? AND phase = ?
		`);

		stmt.run(runId, phase);
	}

	getPhaseProgress(
		runId: string,
		phase: BenchmarkPhase,
	): {
		total: number;
		completed: number;
		lastProcessedId?: string;
		isComplete: boolean;
	} | null {
		const stmt = this.db.prepare(`
			SELECT * FROM phase_progress WHERE run_id = ? AND phase = ?
		`);

		interface DBPhaseProgress {
			items_total: number;
			items_completed: number;
			last_processed_id: string | null;
			completed_at: string | null;
		}

		const row = stmt.get(runId, phase) as DBPhaseProgress | undefined;
		if (!row) return null;

		return {
			total: row.items_total,
			completed: row.items_completed,
			lastProcessedId: row.last_processed_id ?? undefined,
			isComplete: row.completed_at !== null,
		};
	}

	/**
	 * Get phases where items_completed < items_total (i.e., had failures).
	 * Returns error info that can be used for the Errors tab in the TUI.
	 */
	getPhaseFailureSummary(
		runId: string,
	): Array<{ phase: string; total: number; completed: number; failed: number; error: string | null }> {
		const stmt = this.db.prepare(`
			SELECT phase, items_total, items_completed, error
			FROM phase_progress
			WHERE run_id = ? AND items_completed < items_total
		`);

		interface DBRow {
			phase: string;
			items_total: number;
			items_completed: number;
			error: string | null;
		}

		const rows = stmt.all(runId) as DBRow[];
		return rows.map((r) => ({
			phase: r.phase,
			total: r.items_total,
			completed: r.items_completed,
			failed: r.items_total - r.items_completed,
			error: r.error,
		}));
	}

	// ==========================================================================
	// Utility Methods
	// ==========================================================================

	close(): void {
		this.db.close();
	}

	/** Run a transaction with automatic rollback on error */
	transaction<T>(fn: () => T): T {
		return this.db.transaction(fn);
	}

	/** Get the database file path */
	getPath(): string {
		return this.dbPath;
	}
}

// ============================================================================
// Factory Function
// ============================================================================

/** Create a benchmark database at the given path */
export function createBenchmarkDatabase(dbPath: string): BenchmarkDatabase {
	return new BenchmarkDatabase(dbPath);
}

/** Create a benchmark database in the project's .claudemem directory */
export function createProjectBenchmarkDatabase(
	projectPath: string,
): BenchmarkDatabase {
	const dbPath = join(projectPath, ".claudemem", "benchmark.db");
	return createBenchmarkDatabase(dbPath);
}
