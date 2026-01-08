/**
 * Validation Store
 *
 * SQLite-based persistent storage for validation sessions,
 * experiments, and results. Uses Bun's native SQLite support.
 *
 * @module learning/validation/validation-store
 */

import { Database } from "bun:sqlite";
import type {
	RecordedSession,
	ValidationExperiment,
	ExperimentResults,
	AggregateResults,
	ScenarioResults,
	StatisticalComparison,
	ExperimentDecision,
	SessionMetrics,
	ExperimentStatus,
	ExperimentGroup,
	SessionOutcome,
} from "./types.js";

// ============================================================================
// Validation Store
// ============================================================================

/**
 * SQLite-based storage for validation data.
 * Handles sessions, experiments, and aggregate results.
 */
export class ValidationStore {
	private db: Database;
	private readonly dbPath: string;

	constructor(dbPath: string) {
		this.dbPath = dbPath;
		this.db = new Database(dbPath);
		this.initialize();
	}

	// ============================================================================
	// Database Initialization
	// ============================================================================

	private initialize(): void {
		// Enable WAL mode for better concurrent read performance
		this.db.run("PRAGMA journal_mode = WAL");
		this.db.run("PRAGMA foreign_keys = ON");

		// Create tables
		this.createTables();
		this.createIndexes();
	}

	private createTables(): void {
		// Sessions table
		this.db.run(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        scenario_id TEXT NOT NULL,
        experiment_id TEXT,
        experiment_group TEXT,
        start_time INTEGER NOT NULL,
        end_time INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        outcome TEXT NOT NULL,
        tool_count INTEGER NOT NULL,
        correction_count INTEGER NOT NULL,
        error_count INTEGER NOT NULL,
        autonomous_actions INTEGER NOT NULL,
        correction_rate REAL NOT NULL,
        error_rate REAL NOT NULL,
        autonomy_rate REAL NOT NULL,
        tokens_used INTEGER NOT NULL,
        avg_tool_duration_ms REAL NOT NULL,
        created_at INTEGER DEFAULT (strftime('%s', 'now'))
      )
    `);

		// Session events (tool calls, corrections, responses)
		this.db.run(`
      CREATE TABLE IF NOT EXISTS session_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        event_data TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id)
      )
    `);

		// Success criteria results
		this.db.run(`
      CREATE TABLE IF NOT EXISTS criteria_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        criterion_type TEXT NOT NULL,
        criterion_data TEXT NOT NULL,
        passed INTEGER NOT NULL,
        details TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id)
      )
    `);

		// Experiments table
		this.db.run(`
      CREATE TABLE IF NOT EXISTS experiments (
        experiment_id TEXT PRIMARY KEY,
        improvement_ids TEXT NOT NULL,
        scenario_ids TEXT NOT NULL,
        runs_per_scenario INTEGER NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

		// Experiment results
		this.db.run(`
      CREATE TABLE IF NOT EXISTS experiment_results (
        experiment_id TEXT PRIMARY KEY,
        baseline_data TEXT NOT NULL,
        treatment_data TEXT NOT NULL,
        comparison_data TEXT NOT NULL,
        decision_data TEXT NOT NULL,
        completed_at INTEGER NOT NULL,
        FOREIGN KEY (experiment_id) REFERENCES experiments(experiment_id)
      )
    `);
	}

	private createIndexes(): void {
		this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_sessions_scenario
      ON sessions(scenario_id)
    `);

		this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_sessions_experiment
      ON sessions(experiment_id)
    `);

		this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_sessions_outcome
      ON sessions(outcome)
    `);

		this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_session_events_session
      ON session_events(session_id)
    `);

		this.db.run(`
      CREATE INDEX IF NOT EXISTS idx_experiments_status
      ON experiments(status)
    `);
	}

	// ============================================================================
	// Session Operations
	// ============================================================================

	/**
	 * Store a recorded session
	 */
	saveSession(session: RecordedSession): void {
		const insertSession = this.db.prepare(`
      INSERT INTO sessions (
        session_id, scenario_id, experiment_id, experiment_group,
        start_time, end_time, duration_ms, outcome,
        tool_count, correction_count, error_count, autonomous_actions,
        correction_rate, error_rate, autonomy_rate,
        tokens_used, avg_tool_duration_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

		const insertEvent = this.db.prepare(`
      INSERT INTO session_events (session_id, event_type, event_data, timestamp)
      VALUES (?, ?, ?, ?)
    `);

		const insertCriteria = this.db.prepare(`
      INSERT INTO criteria_results (session_id, criterion_type, criterion_data, passed, details)
      VALUES (?, ?, ?, ?, ?)
    `);

		// Use transaction for atomicity
		this.db.transaction(() => {
			// Insert session
			insertSession.run(
				session.sessionId,
				session.scenarioId,
				session.experimentId ?? null,
				session.experimentGroup ?? null,
				session.startTime,
				session.endTime,
				session.durationMs,
				session.outcome,
				session.metrics.toolCount,
				session.metrics.correctionCount,
				session.metrics.errorCount,
				session.metrics.autonomousActions,
				session.metrics.correctionRate,
				session.metrics.errorRate,
				session.metrics.autonomyRate,
				session.metrics.tokensUsed,
				session.metrics.avgToolDurationMs,
			);

			// Insert tool events
			for (const event of session.toolEvents) {
				insertEvent.run(
					session.sessionId,
					"tool",
					JSON.stringify(event),
					event.timestamp,
				);
			}

			// Insert corrections
			for (const correction of session.corrections) {
				insertEvent.run(
					session.sessionId,
					"correction",
					JSON.stringify(correction),
					correction.timestamp,
				);
			}

			// Insert user responses
			for (const response of session.userResponses) {
				insertEvent.run(
					session.sessionId,
					"user_response",
					JSON.stringify(response),
					response.timestamp,
				);
			}

			// Insert criteria results
			for (const result of session.successCriteria) {
				insertCriteria.run(
					session.sessionId,
					result.criterion.type,
					JSON.stringify(result.criterion),
					result.passed ? 1 : 0,
					result.details ?? null,
				);
			}
		})();
	}

	/**
	 * Get a session by ID
	 */
	getSession(sessionId: string): RecordedSession | null {
		const row = this.db
			.prepare("SELECT * FROM sessions WHERE session_id = ?")
			.get(sessionId) as SessionRow | undefined;

		if (!row) return null;

		return this.hydrateSession(row);
	}

	/**
	 * Get all sessions for a scenario
	 */
	getSessionsByScenario(scenarioId: string): RecordedSession[] {
		const rows = this.db
			.prepare(
				"SELECT * FROM sessions WHERE scenario_id = ? ORDER BY start_time DESC",
			)
			.all(scenarioId) as SessionRow[];

		return rows.map((row) => this.hydrateSession(row));
	}

	/**
	 * Get all sessions for an experiment
	 */
	getSessionsByExperiment(experimentId: string): RecordedSession[] {
		const rows = this.db
			.prepare(
				"SELECT * FROM sessions WHERE experiment_id = ? ORDER BY start_time DESC",
			)
			.all(experimentId) as SessionRow[];

		return rows.map((row) => this.hydrateSession(row));
	}

	/**
	 * Get sessions by experiment and group
	 */
	getSessionsByExperimentGroup(
		experimentId: string,
		group: ExperimentGroup,
	): RecordedSession[] {
		const rows = this.db
			.prepare(
				"SELECT * FROM sessions WHERE experiment_id = ? AND experiment_group = ? ORDER BY start_time DESC",
			)
			.all(experimentId, group) as SessionRow[];

		return rows.map((row) => this.hydrateSession(row));
	}

	private hydrateSession(row: SessionRow): RecordedSession {
		// Get events
		const events = this.db
			.prepare(
				"SELECT * FROM session_events WHERE session_id = ? ORDER BY timestamp",
			)
			.all(row.session_id) as EventRow[];

		const toolEvents = events
			.filter((e) => e.event_type === "tool")
			.map((e) => JSON.parse(e.event_data));

		const corrections = events
			.filter((e) => e.event_type === "correction")
			.map((e) => JSON.parse(e.event_data));

		const userResponses = events
			.filter((e) => e.event_type === "user_response")
			.map((e) => JSON.parse(e.event_data));

		// Get criteria results
		const criteriaRows = this.db
			.prepare("SELECT * FROM criteria_results WHERE session_id = ?")
			.all(row.session_id) as CriteriaRow[];

		const successCriteria = criteriaRows.map((c) => ({
			criterion: JSON.parse(c.criterion_data),
			passed: c.passed === 1,
			details: c.details ?? undefined,
		}));

		return {
			sessionId: row.session_id,
			scenarioId: row.scenario_id,
			experimentId: row.experiment_id ?? undefined,
			experimentGroup: row.experiment_group as ExperimentGroup | undefined,
			startTime: row.start_time,
			endTime: row.end_time,
			durationMs: row.duration_ms,
			toolEvents,
			corrections,
			userResponses,
			metrics: {
				toolCount: row.tool_count,
				correctionCount: row.correction_count,
				errorCount: row.error_count,
				autonomousActions: row.autonomous_actions,
				correctionRate: row.correction_rate,
				errorRate: row.error_rate,
				autonomyRate: row.autonomy_rate,
				tokensUsed: row.tokens_used,
				avgToolDurationMs: row.avg_tool_duration_ms,
			},
			outcome: row.outcome as SessionOutcome,
			successCriteria,
		};
	}

	// ============================================================================
	// Experiment Operations
	// ============================================================================

	/**
	 * Create a new experiment
	 */
	createExperiment(experiment: ValidationExperiment): void {
		this.db
			.prepare(`
        INSERT INTO experiments (
          experiment_id, improvement_ids, scenario_ids,
          runs_per_scenario, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
			.run(
				experiment.experimentId,
				JSON.stringify(experiment.improvementIds),
				JSON.stringify(experiment.scenarios),
				experiment.runsPerScenario,
				experiment.status,
				experiment.createdAt,
				experiment.updatedAt,
			);
	}

	/**
	 * Update experiment status
	 */
	updateExperimentStatus(experimentId: string, status: ExperimentStatus): void {
		this.db
			.prepare(
				"UPDATE experiments SET status = ?, updated_at = ? WHERE experiment_id = ?",
			)
			.run(status, Date.now(), experimentId);
	}

	/**
	 * Get an experiment by ID
	 */
	getExperiment(experimentId: string): ValidationExperiment | null {
		const row = this.db
			.prepare("SELECT * FROM experiments WHERE experiment_id = ?")
			.get(experimentId) as ExperimentRow | undefined;

		if (!row) return null;

		return {
			experimentId: row.experiment_id,
			improvementIds: JSON.parse(row.improvement_ids),
			scenarios: JSON.parse(row.scenario_ids),
			runsPerScenario: row.runs_per_scenario,
			status: row.status as ExperimentStatus,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		};
	}

	/**
	 * Get experiments by status
	 */
	getExperimentsByStatus(status: ExperimentStatus): ValidationExperiment[] {
		const rows = this.db
			.prepare(
				"SELECT * FROM experiments WHERE status = ? ORDER BY created_at DESC",
			)
			.all(status) as ExperimentRow[];

		return rows.map((row) => ({
			experimentId: row.experiment_id,
			improvementIds: JSON.parse(row.improvement_ids),
			scenarios: JSON.parse(row.scenario_ids),
			runsPerScenario: row.runs_per_scenario,
			status: row.status as ExperimentStatus,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		}));
	}

	// ============================================================================
	// Experiment Results Operations
	// ============================================================================

	/**
	 * Save experiment results
	 */
	saveExperimentResults(results: ExperimentResults): void {
		this.db
			.prepare(`
        INSERT INTO experiment_results (
          experiment_id, baseline_data, treatment_data,
          comparison_data, decision_data, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `)
			.run(
				results.experimentId,
				JSON.stringify(this.serializeAggregateResults(results.baseline)),
				JSON.stringify(this.serializeAggregateResults(results.treatment)),
				JSON.stringify(results.comparison),
				JSON.stringify(results.decision),
				results.completedAt,
			);
	}

	/**
	 * Get experiment results
	 */
	getExperimentResults(experimentId: string): ExperimentResults | null {
		const row = this.db
			.prepare("SELECT * FROM experiment_results WHERE experiment_id = ?")
			.get(experimentId) as ExperimentResultsRow | undefined;

		if (!row) return null;

		return {
			experimentId: row.experiment_id,
			baseline: this.deserializeAggregateResults(JSON.parse(row.baseline_data)),
			treatment: this.deserializeAggregateResults(
				JSON.parse(row.treatment_data),
			),
			comparison: JSON.parse(row.comparison_data) as StatisticalComparison,
			decision: JSON.parse(row.decision_data) as ExperimentDecision,
			completedAt: row.completed_at,
		};
	}

	private serializeAggregateResults(
		results: AggregateResults,
	): SerializedAggregateResults {
		return {
			...results,
			byScenario: Object.fromEntries(results.byScenario),
		};
	}

	private deserializeAggregateResults(
		data: SerializedAggregateResults,
	): AggregateResults {
		return {
			...data,
			byScenario: new Map(Object.entries(data.byScenario)),
		};
	}

	// ============================================================================
	// Aggregate Queries
	// ============================================================================

	/**
	 * Calculate aggregate results for an experiment group
	 */
	calculateAggregateResults(
		experimentId: string,
		group: ExperimentGroup,
	): AggregateResults {
		const sessions = this.getSessionsByExperimentGroup(experimentId, group);

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
		const scenarioGroups = this.groupBy(sessions, (s) => s.scenarioId);

		for (const [scenarioId, scenarioSessions] of Object.entries(
			scenarioGroups,
		)) {
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

	/**
	 * Get summary statistics for all sessions
	 */
	getSummaryStats(): SummaryStats {
		const row = this.db
			.prepare(`
        SELECT
          COUNT(*) as total_sessions,
          SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) as successful,
          SUM(CASE WHEN outcome = 'failure' THEN 1 ELSE 0 END) as failed,
          AVG(correction_rate) as avg_correction_rate,
          AVG(error_rate) as avg_error_rate,
          AVG(autonomy_rate) as avg_autonomy_rate,
          AVG(duration_ms) as avg_duration_ms
        FROM sessions
      `)
			.get() as SummaryStatsRow;

		return {
			totalSessions: row.total_sessions ?? 0,
			successfulSessions: row.successful ?? 0,
			failedSessions: row.failed ?? 0,
			avgCorrectionRate: row.avg_correction_rate ?? 0,
			avgErrorRate: row.avg_error_rate ?? 0,
			avgAutonomyRate: row.avg_autonomy_rate ?? 0,
			avgDurationMs: row.avg_duration_ms ?? 0,
		};
	}

	// ============================================================================
	// Utility Methods
	// ============================================================================

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

	/**
	 * Close the database connection
	 */
	close(): void {
		this.db.close();
	}

	/**
	 * Get the database file path
	 */
	getDbPath(): string {
		return this.dbPath;
	}
}

// ============================================================================
// Row Types
// ============================================================================

interface SessionRow {
	session_id: string;
	scenario_id: string;
	experiment_id: string | null;
	experiment_group: string | null;
	start_time: number;
	end_time: number;
	duration_ms: number;
	outcome: string;
	tool_count: number;
	correction_count: number;
	error_count: number;
	autonomous_actions: number;
	correction_rate: number;
	error_rate: number;
	autonomy_rate: number;
	tokens_used: number;
	avg_tool_duration_ms: number;
}

interface EventRow {
	id: number;
	session_id: string;
	event_type: string;
	event_data: string;
	timestamp: number;
}

interface CriteriaRow {
	id: number;
	session_id: string;
	criterion_type: string;
	criterion_data: string;
	passed: number;
	details: string | null;
}

interface ExperimentRow {
	experiment_id: string;
	improvement_ids: string;
	scenario_ids: string;
	runs_per_scenario: number;
	status: string;
	created_at: number;
	updated_at: number;
}

interface ExperimentResultsRow {
	experiment_id: string;
	baseline_data: string;
	treatment_data: string;
	comparison_data: string;
	decision_data: string;
	completed_at: number;
}

interface SummaryStatsRow {
	total_sessions: number | null;
	successful: number | null;
	failed: number | null;
	avg_correction_rate: number | null;
	avg_error_rate: number | null;
	avg_autonomy_rate: number | null;
	avg_duration_ms: number | null;
}

interface SerializedAggregateResults
	extends Omit<AggregateResults, "byScenario"> {
	byScenario: Record<string, ScenarioResults>;
}

export interface SummaryStats {
	totalSessions: number;
	successfulSessions: number;
	failedSessions: number;
	avgCorrectionRate: number;
	avgErrorRate: number;
	avgAutonomyRate: number;
	avgDurationMs: number;
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a validation store with default path
 */
export function createValidationStore(
	projectPath: string = ".",
): ValidationStore {
	const dbPath = `${projectPath}/.claudemem/validation.db`;
	return new ValidationStore(dbPath);
}
