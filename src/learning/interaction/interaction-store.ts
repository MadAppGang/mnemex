/**
 * InteractionStore - SQLite storage for user-agent interaction events.
 *
 * Responsibilities:
 * - Store agent sessions and tool events
 * - Track code changes for "Correction Gap" analysis
 * - Store detected patterns and improvements
 * - Manage data retention and cleanup
 */

import type { SQLiteDatabase } from "../../core/sqlite.js";
import type {
	InteractionConfig,
	AgentSession,
	ToolEvent,
	CodeChange,
	CorrectionEvent,
	DetectedPattern,
	Improvement,
	SessionStatistics,
	PatternStatistics,
	ImprovementStatistics,
	SessionOutcome,
	PatternType,
	PatternSeverity,
	ImprovementType,
	ImprovementStatus,
	CorrectionSignals,
	PatternData,
	ImprovementData,
	ToolErrorType,
	CorrectionType,
} from "./types.js";
import { DEFAULT_INTERACTION_CONFIG } from "./types.js";

// ============================================================================
// InteractionStore Class
// ============================================================================

export class InteractionStore {
	private db: SQLiteDatabase;
	private config: InteractionConfig;
	private initialized = false;

	constructor(db: SQLiteDatabase, config: Partial<InteractionConfig> = {}) {
		this.db = db;
		this.config = { ...DEFAULT_INTERACTION_CONFIG, ...config };
	}

	/**
	 * Initialize interaction tables in the database.
	 * Call this during database setup.
	 */
	initializeSchema(): void {
		if (this.initialized) return;

		this.db.exec(`
			-- Agent sessions
			CREATE TABLE IF NOT EXISTS agent_sessions (
				session_id TEXT PRIMARY KEY,
				timestamp INTEGER NOT NULL,
				project_path TEXT NOT NULL,
				duration INTEGER,
				tool_count INTEGER DEFAULT 0,
				intervention_count INTEGER DEFAULT 0,
				autonomous_count INTEGER DEFAULT 0,
				outcome TEXT
			);

			-- Tool execution events
			CREATE TABLE IF NOT EXISTS tool_events (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				session_id TEXT NOT NULL,
				tool_use_id TEXT NOT NULL,
				tool_name TEXT NOT NULL,
				tool_input_hash TEXT,
				success INTEGER NOT NULL DEFAULT 1,
				error_type TEXT,
				duration_ms INTEGER,
				execution_order INTEGER NOT NULL,
				timestamp INTEGER NOT NULL,
				FOREIGN KEY (session_id) REFERENCES agent_sessions(session_id)
			);

			-- Code changes for Correction Gap analysis
			CREATE TABLE IF NOT EXISTS code_changes (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				session_id TEXT NOT NULL,
				file_path TEXT NOT NULL,
				author TEXT NOT NULL,
				diff_hash TEXT,
				lines_added INTEGER DEFAULT 0,
				lines_removed INTEGER DEFAULT 0,
				timestamp INTEGER NOT NULL,
				agent_change_id INTEGER,
				correction_type TEXT,
				FOREIGN KEY (session_id) REFERENCES agent_sessions(session_id),
				FOREIGN KEY (agent_change_id) REFERENCES code_changes(id)
			);

			-- Detected corrections (multi-signal)
			CREATE TABLE IF NOT EXISTS corrections (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				session_id TEXT NOT NULL,
				correction_score REAL NOT NULL,
				signals TEXT NOT NULL,
				trigger_event TEXT,
				agent_action TEXT,
				timestamp INTEGER NOT NULL,
				FOREIGN KEY (session_id) REFERENCES agent_sessions(session_id)
			);

			-- Detected patterns
			CREATE TABLE IF NOT EXISTS patterns (
				pattern_id TEXT PRIMARY KEY,
				pattern_type TEXT NOT NULL,
				pattern_hash TEXT NOT NULL,
				pattern_data TEXT NOT NULL,
				occurrence_count INTEGER DEFAULT 1,
				last_seen INTEGER NOT NULL,
				severity TEXT NOT NULL,
				project_scope TEXT
			);

			-- Generated improvements
			CREATE TABLE IF NOT EXISTS improvements (
				improvement_id TEXT PRIMARY KEY,
				pattern_id TEXT NOT NULL,
				improvement_type TEXT NOT NULL,
				improvement_data TEXT NOT NULL,
				status TEXT NOT NULL DEFAULT 'proposed',
				safety_score REAL,
				impact_score REAL,
				created_at INTEGER NOT NULL,
				approved_at INTEGER,
				deployed_at INTEGER,
				FOREIGN KEY (pattern_id) REFERENCES patterns(pattern_id)
			);

			-- Improvement metrics (for A/B testing)
			CREATE TABLE IF NOT EXISTS improvement_metrics (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				improvement_id TEXT NOT NULL,
				metric_type TEXT NOT NULL,
				value REAL NOT NULL,
				timestamp INTEGER NOT NULL,
				FOREIGN KEY (improvement_id) REFERENCES improvements(improvement_id)
			);

			-- Indexes for efficient querying
			CREATE INDEX IF NOT EXISTS idx_sessions_timestamp ON agent_sessions(timestamp);
			CREATE INDEX IF NOT EXISTS idx_sessions_project ON agent_sessions(project_path);
			CREATE INDEX IF NOT EXISTS idx_tool_events_session ON tool_events(session_id);
			CREATE INDEX IF NOT EXISTS idx_tool_events_timestamp ON tool_events(timestamp);
			CREATE INDEX IF NOT EXISTS idx_tool_events_tool ON tool_events(tool_name);
			CREATE INDEX IF NOT EXISTS idx_code_changes_session ON code_changes(session_id);
			CREATE INDEX IF NOT EXISTS idx_code_changes_file ON code_changes(file_path);
			CREATE INDEX IF NOT EXISTS idx_corrections_session ON corrections(session_id);
			CREATE INDEX IF NOT EXISTS idx_corrections_score ON corrections(correction_score);
			CREATE INDEX IF NOT EXISTS idx_patterns_type ON patterns(pattern_type);
			CREATE INDEX IF NOT EXISTS idx_patterns_hash ON patterns(pattern_hash);
			CREATE INDEX IF NOT EXISTS idx_improvements_status ON improvements(status);
			CREATE INDEX IF NOT EXISTS idx_improvements_pattern ON improvements(pattern_id);
		`);

		this.initialized = true;
	}

	// ========================================================================
	// Session Operations
	// ========================================================================

	/**
	 * Create or update an agent session.
	 */
	upsertSession(session: AgentSession): void {
		const stmt = this.db.prepare(`
			INSERT INTO agent_sessions
			(session_id, timestamp, project_path, duration, tool_count,
			 intervention_count, autonomous_count, outcome)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(session_id) DO UPDATE SET
				duration = excluded.duration,
				tool_count = excluded.tool_count,
				intervention_count = excluded.intervention_count,
				autonomous_count = excluded.autonomous_count,
				outcome = excluded.outcome
		`);

		stmt.run(
			session.sessionId,
			session.timestamp,
			session.projectPath,
			session.duration || null,
			session.toolCount,
			session.interventionCount,
			session.autonomousCount,
			session.outcome || null,
		);
	}

	/**
	 * Get a session by ID.
	 */
	getSession(sessionId: string): AgentSession | null {
		const stmt = this.db.prepare(
			"SELECT * FROM agent_sessions WHERE session_id = ?",
		);
		const row = stmt.get(sessionId) as Record<string, unknown> | undefined;
		return row ? this.rowToSession(row) : null;
	}

	/**
	 * Get recent sessions.
	 */
	getRecentSessions(limit = 50): AgentSession[] {
		const stmt = this.db.prepare(`
			SELECT * FROM agent_sessions
			ORDER BY timestamp DESC
			LIMIT ?
		`);
		const rows = stmt.all(limit) as Array<Record<string, unknown>>;
		return rows.map((row) => this.rowToSession(row));
	}

	/**
	 * Get sessions for a specific project.
	 */
	getSessionsByProject(projectPath: string, limit = 100): AgentSession[] {
		const stmt = this.db.prepare(`
			SELECT * FROM agent_sessions
			WHERE project_path = ?
			ORDER BY timestamp DESC
			LIMIT ?
		`);
		const rows = stmt.all(projectPath, limit) as Array<Record<string, unknown>>;
		return rows.map((row) => this.rowToSession(row));
	}

	/**
	 * Update session outcome.
	 */
	updateSessionOutcome(sessionId: string, outcome: SessionOutcome): void {
		const stmt = this.db.prepare(
			"UPDATE agent_sessions SET outcome = ? WHERE session_id = ?",
		);
		stmt.run(outcome, sessionId);
	}

	/**
	 * Increment session counters.
	 */
	incrementSessionCounters(
		sessionId: string,
		toolCount: number,
		interventionCount: number,
		autonomousCount: number,
	): void {
		const stmt = this.db.prepare(`
			UPDATE agent_sessions SET
				tool_count = tool_count + ?,
				intervention_count = intervention_count + ?,
				autonomous_count = autonomous_count + ?
			WHERE session_id = ?
		`);
		stmt.run(toolCount, interventionCount, autonomousCount, sessionId);
	}

	// ========================================================================
	// Tool Event Operations
	// ========================================================================

	/**
	 * Record a tool execution event.
	 */
	recordToolEvent(event: Omit<ToolEvent, "id">): number {
		const stmt = this.db.prepare(`
			INSERT INTO tool_events
			(session_id, tool_use_id, tool_name, tool_input_hash, success,
			 error_type, duration_ms, execution_order, timestamp)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);

		const result = stmt.run(
			event.sessionId,
			event.toolUseId,
			event.toolName,
			event.toolInputHash || null,
			event.success ? 1 : 0,
			event.errorType || null,
			event.durationMs || null,
			event.executionOrder,
			event.timestamp,
		);

		return Number(result.lastInsertRowid);
	}

	/**
	 * Get tool events for a session.
	 */
	getToolEventsBySession(sessionId: string): ToolEvent[] {
		const stmt = this.db.prepare(`
			SELECT * FROM tool_events
			WHERE session_id = ?
			ORDER BY execution_order ASC
		`);
		const rows = stmt.all(sessionId) as Array<Record<string, unknown>>;
		return rows.map((row) => this.rowToToolEvent(row));
	}

	/**
	 * Get tool sequence for a session (just tool names in order).
	 */
	getToolSequence(sessionId: string): string[] {
		const stmt = this.db.prepare(`
			SELECT tool_name FROM tool_events
			WHERE session_id = ?
			ORDER BY execution_order ASC
		`);
		const rows = stmt.all(sessionId) as Array<{ tool_name: string }>;
		return rows.map((row) => row.tool_name);
	}

	/**
	 * Get tool usage statistics.
	 */
	getToolUsageStats(limit = 20): Array<{ toolName: string; count: number }> {
		const stmt = this.db.prepare(`
			SELECT tool_name, COUNT(*) as count
			FROM tool_events
			GROUP BY tool_name
			ORDER BY count DESC
			LIMIT ?
		`);
		const rows = stmt.all(limit) as Array<{
			tool_name: string;
			count: number;
		}>;
		return rows.map((row) => ({
			toolName: row.tool_name,
			count: row.count,
		}));
	}

	/**
	 * Get error rates by tool.
	 */
	getToolErrorRates(): Array<{
		toolName: string;
		total: number;
		failures: number;
		rate: number;
	}> {
		const stmt = this.db.prepare(`
			SELECT
				tool_name,
				COUNT(*) as total,
				SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as failures
			FROM tool_events
			GROUP BY tool_name
			HAVING total > 5
			ORDER BY (failures * 1.0 / total) DESC
		`);
		const rows = stmt.all() as Array<{
			tool_name: string;
			total: number;
			failures: number;
		}>;
		return rows.map((row) => ({
			toolName: row.tool_name,
			total: row.total,
			failures: row.failures,
			rate: row.failures / row.total,
		}));
	}

	// ========================================================================
	// Code Change Operations
	// ========================================================================

	/**
	 * Record a code change.
	 */
	recordCodeChange(change: Omit<CodeChange, "id">): number {
		const stmt = this.db.prepare(`
			INSERT INTO code_changes
			(session_id, file_path, author, diff_hash, lines_added, lines_removed,
			 timestamp, agent_change_id, correction_type)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);

		const result = stmt.run(
			change.sessionId,
			change.filePath,
			change.author,
			change.diffHash || null,
			change.linesAdded,
			change.linesRemoved,
			change.timestamp,
			change.agentChangeId || null,
			change.correctionType || null,
		);

		return Number(result.lastInsertRowid);
	}

	/**
	 * Get recent agent changes for a file (for Correction Gap detection).
	 */
	getRecentAgentChanges(
		sessionId: string,
		filePath: string,
		windowMs = 300000,
	): CodeChange[] {
		const cutoff = Date.now() - windowMs;
		const stmt = this.db.prepare(`
			SELECT * FROM code_changes
			WHERE session_id = ? AND file_path = ? AND author = 'agent'
			AND timestamp > ?
			ORDER BY timestamp DESC
		`);
		const rows = stmt.all(sessionId, filePath, cutoff) as Array<
			Record<string, unknown>
		>;
		return rows.map((row) => this.rowToCodeChange(row));
	}

	/**
	 * Get code changes by session.
	 */
	getCodeChangesBySession(sessionId: string): CodeChange[] {
		const stmt = this.db.prepare(`
			SELECT * FROM code_changes
			WHERE session_id = ?
			ORDER BY timestamp ASC
		`);
		const rows = stmt.all(sessionId) as Array<Record<string, unknown>>;
		return rows.map((row) => this.rowToCodeChange(row));
	}

	/**
	 * Get "Correction Gap" statistics.
	 * Returns files where users frequently modify agent's code.
	 */
	getCorrectionGapStats(
		limit = 20,
	): Array<{ filePath: string; corrections: number; total: number }> {
		const stmt = this.db.prepare(`
			SELECT
				file_path,
				SUM(CASE WHEN author = 'user' AND agent_change_id IS NOT NULL THEN 1 ELSE 0 END) as corrections,
				COUNT(*) as total
			FROM code_changes
			GROUP BY file_path
			HAVING corrections > 0
			ORDER BY corrections DESC
			LIMIT ?
		`);
		const rows = stmt.all(limit) as Array<{
			file_path: string;
			corrections: number;
			total: number;
		}>;
		return rows.map((row) => ({
			filePath: row.file_path,
			corrections: row.corrections,
			total: row.total,
		}));
	}

	// ========================================================================
	// Correction Operations
	// ========================================================================

	/**
	 * Record a detected correction.
	 */
	recordCorrection(correction: Omit<CorrectionEvent, "id">): number {
		const stmt = this.db.prepare(`
			INSERT INTO corrections
			(session_id, correction_score, signals, trigger_event, agent_action, timestamp)
			VALUES (?, ?, ?, ?, ?, ?)
		`);

		const result = stmt.run(
			correction.sessionId,
			correction.correctionScore,
			JSON.stringify(correction.signals),
			correction.triggerEvent || null,
			correction.agentAction || null,
			correction.timestamp,
		);

		return Number(result.lastInsertRowid);
	}

	/**
	 * Get corrections for a session.
	 */
	getCorrectionsBySession(sessionId: string): CorrectionEvent[] {
		const stmt = this.db.prepare(`
			SELECT * FROM corrections
			WHERE session_id = ?
			ORDER BY timestamp ASC
		`);
		const rows = stmt.all(sessionId) as Array<Record<string, unknown>>;
		return rows.map((row) => this.rowToCorrection(row));
	}

	/**
	 * Get recent high-confidence corrections.
	 */
	getRecentCorrections(
		minScore = 0.6,
		limit = 50,
	): CorrectionEvent[] {
		const stmt = this.db.prepare(`
			SELECT * FROM corrections
			WHERE correction_score >= ?
			ORDER BY timestamp DESC
			LIMIT ?
		`);
		const rows = stmt.all(minScore, limit) as Array<Record<string, unknown>>;
		return rows.map((row) => this.rowToCorrection(row));
	}

	// ========================================================================
	// Pattern Operations
	// ========================================================================

	/**
	 * Upsert a detected pattern.
	 */
	upsertPattern(pattern: DetectedPattern): void {
		const stmt = this.db.prepare(`
			INSERT INTO patterns
			(pattern_id, pattern_type, pattern_hash, pattern_data, occurrence_count,
			 last_seen, severity, project_scope)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(pattern_id) DO UPDATE SET
				occurrence_count = occurrence_count + 1,
				last_seen = excluded.last_seen,
				severity = excluded.severity
		`);

		stmt.run(
			pattern.patternId,
			pattern.patternType,
			pattern.patternHash,
			JSON.stringify(pattern.patternData),
			pattern.occurrenceCount,
			pattern.lastSeen,
			pattern.severity,
			pattern.projectScope || null,
		);
	}

	/**
	 * Get a pattern by ID.
	 */
	getPattern(patternId: string): DetectedPattern | null {
		const stmt = this.db.prepare("SELECT * FROM patterns WHERE pattern_id = ?");
		const row = stmt.get(patternId) as Record<string, unknown> | undefined;
		return row ? this.rowToPattern(row) : null;
	}

	/**
	 * Find pattern by hash (deduplication).
	 */
	getPatternByHash(patternHash: string): DetectedPattern | null {
		const stmt = this.db.prepare(
			"SELECT * FROM patterns WHERE pattern_hash = ?",
		);
		const row = stmt.get(patternHash) as Record<string, unknown> | undefined;
		return row ? this.rowToPattern(row) : null;
	}

	/**
	 * Get patterns by type.
	 */
	getPatternsByType(patternType: PatternType, limit = 50): DetectedPattern[] {
		const stmt = this.db.prepare(`
			SELECT * FROM patterns
			WHERE pattern_type = ?
			ORDER BY occurrence_count DESC
			LIMIT ?
		`);
		const rows = stmt.all(patternType, limit) as Array<Record<string, unknown>>;
		return rows.map((row) => this.rowToPattern(row));
	}

	/**
	 * Get top patterns across all types.
	 */
	getTopPatterns(limit = 20): DetectedPattern[] {
		const stmt = this.db.prepare(`
			SELECT * FROM patterns
			ORDER BY occurrence_count DESC, last_seen DESC
			LIMIT ?
		`);
		const rows = stmt.all(limit) as Array<Record<string, unknown>>;
		return rows.map((row) => this.rowToPattern(row));
	}

	// ========================================================================
	// Improvement Operations
	// ========================================================================

	/**
	 * Create an improvement proposal.
	 */
	createImprovement(improvement: Improvement): void {
		const stmt = this.db.prepare(`
			INSERT INTO improvements
			(improvement_id, pattern_id, improvement_type, improvement_data,
			 status, safety_score, impact_score, created_at, approved_at, deployed_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);

		stmt.run(
			improvement.improvementId,
			improvement.patternId,
			improvement.improvementType,
			JSON.stringify(improvement.improvementData),
			improvement.status,
			improvement.safetyScore || null,
			improvement.impactScore || null,
			improvement.createdAt,
			improvement.approvedAt || null,
			improvement.deployedAt || null,
		);
	}

	/**
	 * Update improvement status.
	 */
	updateImprovementStatus(
		improvementId: string,
		status: ImprovementStatus,
	): void {
		const now = Date.now();
		let updateFields = "status = ?";

		if (status === "approved") {
			updateFields += ", approved_at = ?";
		} else if (status === "deployed") {
			updateFields += ", deployed_at = ?";
		}

		const stmt = this.db.prepare(
			`UPDATE improvements SET ${updateFields} WHERE improvement_id = ?`,
		);

		if (status === "approved" || status === "deployed") {
			stmt.run(status, now, improvementId);
		} else {
			stmt.run(status, improvementId);
		}
	}

	/**
	 * Update improvement scores.
	 */
	updateImprovementScores(
		improvementId: string,
		safetyScore: number,
		impactScore?: number,
	): void {
		const stmt = this.db.prepare(`
			UPDATE improvements
			SET safety_score = ?, impact_score = ?
			WHERE improvement_id = ?
		`);
		stmt.run(safetyScore, impactScore || null, improvementId);
	}

	/**
	 * Get improvements by status.
	 */
	getImprovementsByStatus(status: ImprovementStatus): Improvement[] {
		const stmt = this.db.prepare(`
			SELECT * FROM improvements
			WHERE status = ?
			ORDER BY created_at DESC
		`);
		const rows = stmt.all(status) as Array<Record<string, unknown>>;
		return rows.map((row) => this.rowToImprovement(row));
	}

	/**
	 * Get improvements ready for auto-deploy.
	 */
	getAutoDeployableImprovements(): Improvement[] {
		const threshold = this.config.autoDeploySafetyThreshold;
		const stmt = this.db.prepare(`
			SELECT * FROM improvements
			WHERE status = 'approved' AND safety_score >= ?
			ORDER BY safety_score DESC, created_at ASC
		`);
		const rows = stmt.all(threshold) as Array<Record<string, unknown>>;
		return rows.map((row) => this.rowToImprovement(row));
	}

	// ========================================================================
	// Statistics
	// ========================================================================

	/**
	 * Get session statistics.
	 */
	getSessionStatistics(): SessionStatistics {
		const totalSessions = (
			this.db.prepare("SELECT COUNT(*) as count FROM agent_sessions").get() as {
				count: number;
			}
		).count;

		const totalToolEvents = (
			this.db.prepare("SELECT COUNT(*) as count FROM tool_events").get() as {
				count: number;
			}
		).count;

		const totalCorrections = (
			this.db.prepare("SELECT COUNT(*) as count FROM corrections").get() as {
				count: number;
			}
		).count;

		const avgStats = this.db
			.prepare(
				`
			SELECT
				AVG(intervention_count * 1.0 / NULLIF(tool_count, 0)) as avg_intervention_rate,
				AVG(duration) as avg_duration
			FROM agent_sessions
			WHERE tool_count > 0
		`,
			)
			.get() as { avg_intervention_rate: number | null; avg_duration: number | null };

		const outcomeRows = this.db
			.prepare(
				`
			SELECT outcome, COUNT(*) as count
			FROM agent_sessions
			WHERE outcome IS NOT NULL
			GROUP BY outcome
		`,
			)
			.all() as Array<{ outcome: SessionOutcome; count: number }>;

		const outcomeBreakdown: Record<SessionOutcome, number> = {
			success: 0,
			partial: 0,
			failure: 0,
			abandoned: 0,
		};
		for (const row of outcomeRows) {
			outcomeBreakdown[row.outcome] = row.count;
		}

		const topToolsUsed = this.getToolUsageStats(10);
		const recentSessions = this.getRecentSessions(10);

		return {
			totalSessions,
			totalToolEvents,
			totalCorrections,
			avgInterventionRate: avgStats.avg_intervention_rate || 0,
			avgSessionDuration: avgStats.avg_duration || 0,
			outcomeBreakdown,
			topToolsUsed,
			recentSessions,
		};
	}

	/**
	 * Get pattern statistics.
	 */
	getPatternStatistics(): PatternStatistics {
		const totalPatterns = (
			this.db.prepare("SELECT COUNT(*) as count FROM patterns").get() as {
				count: number;
			}
		).count;

		const typeRows = this.db
			.prepare(
				`
			SELECT pattern_type, COUNT(*) as count
			FROM patterns
			GROUP BY pattern_type
		`,
			)
			.all() as Array<{ pattern_type: PatternType; count: number }>;

		const patternsByType: Record<PatternType, number> = {
			error: 0,
			workflow: 0,
			misuse: 0,
			opportunity: 0,
		};
		for (const row of typeRows) {
			patternsByType[row.pattern_type] = row.count;
		}

		const severityRows = this.db
			.prepare(
				`
			SELECT severity, COUNT(*) as count
			FROM patterns
			GROUP BY severity
		`,
			)
			.all() as Array<{ severity: PatternSeverity; count: number }>;

		const patternsBySeverity: Record<PatternSeverity, number> = {
			critical: 0,
			medium: 0,
			low: 0,
		};
		for (const row of severityRows) {
			patternsBySeverity[row.severity] = row.count;
		}

		const topPatterns = this.getTopPatterns(10);

		return {
			totalPatterns,
			patternsByType,
			patternsBySeverity,
			topPatterns,
		};
	}

	/**
	 * Get improvement statistics.
	 */
	getImprovementStatistics(): ImprovementStatistics {
		const totalImprovements = (
			this.db.prepare("SELECT COUNT(*) as count FROM improvements").get() as {
				count: number;
			}
		).count;

		const typeRows = this.db
			.prepare(
				`
			SELECT improvement_type, COUNT(*) as count
			FROM improvements
			GROUP BY improvement_type
		`,
			)
			.all() as Array<{ improvement_type: ImprovementType; count: number }>;

		const improvementsByType: Record<ImprovementType, number> = {
			skill: 0,
			subagent: 0,
			prompt: 0,
		};
		for (const row of typeRows) {
			improvementsByType[row.improvement_type] = row.count;
		}

		const statusRows = this.db
			.prepare(
				`
			SELECT status, COUNT(*) as count
			FROM improvements
			GROUP BY status
		`,
			)
			.all() as Array<{ status: ImprovementStatus; count: number }>;

		const improvementsByStatus: Record<ImprovementStatus, number> = {
			proposed: 0,
			testing: 0,
			approved: 0,
			deployed: 0,
			rolled_back: 0,
		};
		for (const row of statusRows) {
			improvementsByStatus[row.status] = row.count;
		}

		const avgScores = this.db
			.prepare(
				`
			SELECT AVG(safety_score) as avg_safety, AVG(impact_score) as avg_impact
			FROM improvements
			WHERE safety_score IS NOT NULL
		`,
			)
			.get() as { avg_safety: number | null; avg_impact: number | null };

		return {
			totalImprovements,
			improvementsByType,
			improvementsByStatus,
			avgSafetyScore: avgScores.avg_safety || 0,
			avgImpactScore: avgScores.avg_impact || 0,
		};
	}

	// ========================================================================
	// Cleanup
	// ========================================================================

	/**
	 * Prune old data based on retention policy.
	 */
	pruneOldData(): { sessions: number; events: number; corrections: number } {
		const rawCutoff =
			Date.now() - this.config.rawEventRetentionDays * 24 * 60 * 60 * 1000;
		const summaryCutoff =
			Date.now() - this.config.summaryRetentionDays * 24 * 60 * 60 * 1000;

		// Delete old tool events (raw data)
		const eventsResult = this.db
			.prepare("DELETE FROM tool_events WHERE timestamp < ?")
			.run(rawCutoff);

		// Delete old corrections (raw data)
		const correctionsResult = this.db
			.prepare("DELETE FROM corrections WHERE timestamp < ?")
			.run(rawCutoff);

		// Delete old code changes (raw data)
		this.db
			.prepare("DELETE FROM code_changes WHERE timestamp < ?")
			.run(rawCutoff);

		// Delete old sessions (summaries)
		const sessionsResult = this.db
			.prepare("DELETE FROM agent_sessions WHERE timestamp < ?")
			.run(summaryCutoff);

		return {
			sessions: sessionsResult.changes,
			events: eventsResult.changes,
			corrections: correctionsResult.changes,
		};
	}

	// ========================================================================
	// Private Helpers
	// ========================================================================

	private rowToSession(row: Record<string, unknown>): AgentSession {
		return {
			sessionId: row.session_id as string,
			timestamp: row.timestamp as number,
			projectPath: row.project_path as string,
			duration: row.duration as number | undefined,
			toolCount: row.tool_count as number,
			interventionCount: row.intervention_count as number,
			autonomousCount: row.autonomous_count as number,
			outcome: row.outcome as SessionOutcome | undefined,
		};
	}

	private rowToToolEvent(row: Record<string, unknown>): ToolEvent {
		return {
			id: row.id as number,
			sessionId: row.session_id as string,
			toolUseId: row.tool_use_id as string,
			toolName: row.tool_name as string,
			toolInputHash: row.tool_input_hash as string | undefined,
			success: Boolean(row.success),
			errorType: row.error_type as ToolErrorType | undefined,
			durationMs: row.duration_ms as number | undefined,
			executionOrder: row.execution_order as number,
			timestamp: row.timestamp as number,
		};
	}

	private rowToCodeChange(row: Record<string, unknown>): CodeChange {
		return {
			id: row.id as number,
			sessionId: row.session_id as string,
			filePath: row.file_path as string,
			author: row.author as "agent" | "user",
			diffHash: row.diff_hash as string | undefined,
			linesAdded: row.lines_added as number,
			linesRemoved: row.lines_removed as number,
			timestamp: row.timestamp as number,
			agentChangeId: row.agent_change_id as number | undefined,
			correctionType: row.correction_type as CorrectionType | undefined,
		};
	}

	private rowToCorrection(row: Record<string, unknown>): CorrectionEvent {
		return {
			id: row.id as number,
			sessionId: row.session_id as string,
			correctionScore: row.correction_score as number,
			signals: JSON.parse(row.signals as string) as CorrectionSignals,
			triggerEvent: row.trigger_event as string | undefined,
			agentAction: row.agent_action as string | undefined,
			timestamp: row.timestamp as number,
		};
	}

	private rowToPattern(row: Record<string, unknown>): DetectedPattern {
		return {
			patternId: row.pattern_id as string,
			patternType: row.pattern_type as PatternType,
			patternHash: row.pattern_hash as string,
			patternData: JSON.parse(row.pattern_data as string) as PatternData,
			occurrenceCount: row.occurrence_count as number,
			lastSeen: row.last_seen as number,
			severity: row.severity as PatternSeverity,
			projectScope: row.project_scope as string | undefined,
		};
	}

	private rowToImprovement(row: Record<string, unknown>): Improvement {
		return {
			improvementId: row.improvement_id as string,
			patternId: row.pattern_id as string,
			improvementType: row.improvement_type as ImprovementType,
			improvementData: JSON.parse(
				row.improvement_data as string,
			) as ImprovementData,
			status: row.status as ImprovementStatus,
			safetyScore: row.safety_score as number | undefined,
			impactScore: row.impact_score as number | undefined,
			createdAt: row.created_at as number,
			approvedAt: row.approved_at as number | undefined,
			deployedAt: row.deployed_at as number | undefined,
		};
	}
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create an InteractionStore instance.
 */
export function createInteractionStore(
	db: SQLiteDatabase,
	config?: Partial<InteractionConfig>,
): InteractionStore {
	const store = new InteractionStore(db, config);
	store.initializeSchema();
	return store;
}
