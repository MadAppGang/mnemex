/**
 * FeedbackStore - SQLite storage for search feedback events.
 *
 * Responsibilities:
 * - Store explicit feedback from MCP tool calls
 * - Track query history for refinement detection
 * - Store and retrieve learned weights
 * - Manage file boost factors
 */

import type { SQLiteDatabase } from "../../core/sqlite.js";
import type {
	SearchFeedbackEvent,
	QueryHistoryEntry,
	LearnedWeights,
	LearningStatistics,
	FeedbackType,
	LearningConfig,
} from "../types.js";
import { DEFAULT_LEARNING_CONFIG } from "../types.js";
import type { DocumentType, SearchUseCase } from "../../types.js";

// ============================================================================
// FeedbackStore Class
// ============================================================================

export class FeedbackStore {
	private db: SQLiteDatabase;
	private config: LearningConfig;
	private initialized = false;

	// Rate limiting to prevent database flooding
	private rateLimiter = new Map<string, { count: number; resetAt: number }>();
	private readonly RATE_LIMIT = 100; // max events per session per window
	private readonly RATE_WINDOW_MS = 60_000; // 1 minute window

	constructor(db: SQLiteDatabase, config: Partial<LearningConfig> = {}) {
		this.db = db;
		this.config = { ...DEFAULT_LEARNING_CONFIG, ...config };
	}

	/**
	 * Initialize feedback tables in the database.
	 * Call this during database setup.
	 */
	initializeSchema(): void {
		if (this.initialized) return;

		this.db.exec(`
			-- Explicit feedback from MCP tool / CLI
			CREATE TABLE IF NOT EXISTS search_feedback (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				query TEXT NOT NULL,
				query_hash TEXT NOT NULL,
				session_id TEXT NOT NULL,
				result_ids TEXT NOT NULL,
				accepted_ids TEXT NOT NULL DEFAULT '[]',
				rejected_ids TEXT NOT NULL DEFAULT '[]',
				feedback_type TEXT NOT NULL,
				feedback_source TEXT NOT NULL,
				use_case TEXT,
				context TEXT,
				created_at TEXT NOT NULL
			);

			-- Query history for refinement detection
			CREATE TABLE IF NOT EXISTS query_history (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				query TEXT NOT NULL,
				session_id TEXT NOT NULL,
				result_count INTEGER NOT NULL,
				use_case TEXT,
				timestamp TEXT NOT NULL
			);

			-- Learned adaptive weights
			CREATE TABLE IF NOT EXISTS adaptive_weights (
				key TEXT PRIMARY KEY,
				value REAL NOT NULL,
				sample_count INTEGER DEFAULT 0,
				last_updated TEXT NOT NULL
			);

			-- Per-file boost factors
			CREATE TABLE IF NOT EXISTS file_boosts (
				file_path TEXT PRIMARY KEY,
				boost_factor REAL DEFAULT 1.0,
				sample_count INTEGER DEFAULT 0,
				last_updated TEXT NOT NULL
			);

			-- Query pattern to intent mappings
			CREATE TABLE IF NOT EXISTS query_patterns (
				pattern TEXT PRIMARY KEY,
				intent TEXT NOT NULL,
				confidence REAL DEFAULT 0.5,
				sample_count INTEGER DEFAULT 0,
				last_updated TEXT NOT NULL
			);

			-- Indexes for efficient querying
			CREATE INDEX IF NOT EXISTS idx_feedback_query_hash ON search_feedback(query_hash);
			CREATE INDEX IF NOT EXISTS idx_feedback_session ON search_feedback(session_id);
			CREATE INDEX IF NOT EXISTS idx_feedback_created ON search_feedback(created_at);
			CREATE INDEX IF NOT EXISTS idx_feedback_type ON search_feedback(feedback_type);
			CREATE INDEX IF NOT EXISTS idx_query_history_session ON query_history(session_id);
			CREATE INDEX IF NOT EXISTS idx_query_history_timestamp ON query_history(timestamp);
		`);

		this.initialized = true;
	}

	// ========================================================================
	// Rate Limiting
	// ========================================================================

	/**
	 * Check if session has exceeded rate limit.
	 * @throws Error if rate limit exceeded
	 */
	private checkRateLimit(sessionId: string): void {
		const now = Date.now();
		const entry = this.rateLimiter.get(sessionId);

		if (!entry || now > entry.resetAt) {
			// New window or expired - reset counter
			this.rateLimiter.set(sessionId, { count: 1, resetAt: now + this.RATE_WINDOW_MS });
			return;
		}

		if (entry.count >= this.RATE_LIMIT) {
			throw new Error(
				`Rate limit exceeded for session ${sessionId}: ${this.RATE_LIMIT} events per ${this.RATE_WINDOW_MS / 1000}s`,
			);
		}

		entry.count++;
	}

	// ========================================================================
	// Feedback Event Operations
	// ========================================================================

	/**
	 * Record a search feedback event.
	 * @throws Error if rate limit exceeded for session
	 */
	recordFeedback(event: Omit<SearchFeedbackEvent, "id" | "createdAt">): void {
		// Check rate limit before recording
		this.checkRateLimit(event.sessionId);

		const stmt = this.db.prepare(`
			INSERT INTO search_feedback
			(query, query_hash, session_id, result_ids, accepted_ids, rejected_ids,
			 feedback_type, feedback_source, use_case, context, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);

		stmt.run(
			event.query,
			event.queryHash,
			event.sessionId,
			JSON.stringify(event.resultIds),
			JSON.stringify(event.acceptedIds),
			JSON.stringify(event.rejectedIds),
			event.feedbackType,
			event.feedbackSource,
			event.useCase || null,
			event.context ? JSON.stringify(event.context) : null,
			new Date().toISOString(),
		);
	}

	/**
	 * Get recent feedback events.
	 */
	getRecentFeedback(limit = 100): SearchFeedbackEvent[] {
		const stmt = this.db.prepare(`
			SELECT * FROM search_feedback
			ORDER BY created_at DESC
			LIMIT ?
		`);

		const rows = stmt.all(limit) as Array<Record<string, unknown>>;
		return rows.map((row) => this.rowToFeedbackEvent(row));
	}

	/**
	 * Get feedback for a specific query hash.
	 */
	getFeedbackByQueryHash(queryHash: string): SearchFeedbackEvent[] {
		const stmt = this.db.prepare(`
			SELECT * FROM search_feedback
			WHERE query_hash = ?
			ORDER BY created_at DESC
		`);

		const rows = stmt.all(queryHash) as Array<Record<string, unknown>>;
		return rows.map((row) => this.rowToFeedbackEvent(row));
	}

	/**
	 * Get feedback filtered by use case.
	 */
	getFeedbackByUseCase(
		useCase: SearchUseCase,
		limit = 500,
	): SearchFeedbackEvent[] {
		const stmt = this.db.prepare(`
			SELECT * FROM search_feedback
			WHERE use_case = ?
			ORDER BY created_at DESC
			LIMIT ?
		`);

		const rows = stmt.all(useCase, limit) as Array<Record<string, unknown>>;
		return rows.map((row) => this.rowToFeedbackEvent(row));
	}

	// ========================================================================
	// Query History Operations
	// ========================================================================

	/**
	 * Record a query in history.
	 */
	recordQuery(
		query: string,
		sessionId: string,
		resultCount: number,
		useCase?: SearchUseCase,
	): void {
		const stmt = this.db.prepare(`
			INSERT INTO query_history (query, session_id, result_count, use_case, timestamp)
			VALUES (?, ?, ?, ?, ?)
		`);

		stmt.run(
			query,
			sessionId,
			resultCount,
			useCase || null,
			new Date().toISOString(),
		);
	}

	/**
	 * Get recent queries in a session for refinement detection.
	 */
	getRecentQueriesInSession(
		sessionId: string,
		windowMs = 60000,
	): QueryHistoryEntry[] {
		const cutoff = new Date(Date.now() - windowMs).toISOString();

		const stmt = this.db.prepare(`
			SELECT * FROM query_history
			WHERE session_id = ? AND timestamp > ?
			ORDER BY timestamp DESC
		`);

		const rows = stmt.all(sessionId, cutoff) as Array<Record<string, unknown>>;
		return rows.map((row) => ({
			id: row.id as number,
			query: row.query as string,
			sessionId: row.session_id as string,
			resultCount: row.result_count as number,
			useCase: row.use_case as SearchUseCase | undefined,
			timestamp: row.timestamp as string,
		}));
	}

	// ========================================================================
	// Adaptive Weight Operations
	// ========================================================================

	/**
	 * Get an adaptive weight value.
	 */
	getWeight(key: string, defaultValue: number): number {
		const stmt = this.db.prepare(
			"SELECT value FROM adaptive_weights WHERE key = ?",
		);
		const row = stmt.get(key) as { value: number } | undefined;
		return row?.value ?? defaultValue;
	}

	/**
	 * Get weight with sample count.
	 */
	getWeightWithSamples(
		key: string,
		defaultValue: number,
	): { value: number; sampleCount: number } {
		const stmt = this.db.prepare(
			"SELECT value, sample_count FROM adaptive_weights WHERE key = ?",
		);
		const row = stmt.get(key) as
			| { value: number; sample_count: number }
			| undefined;
		return {
			value: row?.value ?? defaultValue,
			sampleCount: row?.sample_count ?? 0,
		};
	}

	/**
	 * Update an adaptive weight.
	 */
	updateWeight(key: string, value: number, sampleCount: number): void {
		const stmt = this.db.prepare(`
			INSERT OR REPLACE INTO adaptive_weights (key, value, sample_count, last_updated)
			VALUES (?, ?, ?, ?)
		`);

		stmt.run(key, value, sampleCount, new Date().toISOString());
	}

	/**
	 * Get all adaptive weights.
	 */
	getAllWeights(): Map<string, { value: number; sampleCount: number }> {
		const stmt = this.db.prepare(
			"SELECT key, value, sample_count FROM adaptive_weights",
		);
		const rows = stmt.all() as Array<{
			key: string;
			value: number;
			sample_count: number;
		}>;

		const weights = new Map<string, { value: number; sampleCount: number }>();
		for (const row of rows) {
			weights.set(row.key, {
				value: row.value,
				sampleCount: row.sample_count,
			});
		}
		return weights;
	}

	// ========================================================================
	// File Boost Operations
	// ========================================================================

	/**
	 * Get boost factor for a file.
	 */
	getFileBoost(filePath: string): number {
		const stmt = this.db.prepare(
			"SELECT boost_factor FROM file_boosts WHERE file_path = ?",
		);
		const row = stmt.get(filePath) as { boost_factor: number } | undefined;
		return row?.boost_factor ?? 1.0;
	}

	/**
	 * Get boost factor with sample count for a file.
	 */
	getFileBoostWithSamples(
		filePath: string,
	): { boost: number; sampleCount: number } {
		const stmt = this.db.prepare(
			"SELECT boost_factor, sample_count FROM file_boosts WHERE file_path = ?",
		);
		const row = stmt.get(filePath) as
			| { boost_factor: number; sample_count: number }
			| undefined;
		return {
			boost: row?.boost_factor ?? 1.0,
			sampleCount: row?.sample_count ?? 0,
		};
	}

	/**
	 * Update boost factor for a file.
	 */
	updateFileBoost(
		filePath: string,
		boostFactor: number,
		sampleCount: number,
	): void {
		const clamped = Math.max(
			this.config.minFileBoost,
			Math.min(this.config.maxFileBoost, boostFactor),
		);

		const stmt = this.db.prepare(`
			INSERT OR REPLACE INTO file_boosts (file_path, boost_factor, sample_count, last_updated)
			VALUES (?, ?, ?, ?)
		`);

		stmt.run(filePath, clamped, sampleCount, new Date().toISOString());
	}

	/**
	 * Get all file boosts.
	 */
	getAllFileBoosts(): Map<string, number> {
		const stmt = this.db.prepare(
			"SELECT file_path, boost_factor FROM file_boosts",
		);
		const rows = stmt.all() as Array<{
			file_path: string;
			boost_factor: number;
		}>;

		const boosts = new Map<string, number>();
		for (const row of rows) {
			boosts.set(row.file_path, row.boost_factor);
		}
		return boosts;
	}

	/**
	 * Get top boosted files.
	 */
	getTopBoostedFiles(limit = 10): Array<{ filePath: string; boost: number }> {
		const stmt = this.db.prepare(`
			SELECT file_path, boost_factor FROM file_boosts
			ORDER BY boost_factor DESC
			LIMIT ?
		`);

		const rows = stmt.all(limit) as Array<{
			file_path: string;
			boost_factor: number;
		}>;
		return rows.map((row) => ({
			filePath: row.file_path,
			boost: row.boost_factor,
		}));
	}

	// ========================================================================
	// Query Pattern Operations
	// ========================================================================

	/**
	 * Get intent for a query pattern.
	 */
	getPatternIntent(
		pattern: string,
	): { intent: string; confidence: number } | null {
		const stmt = this.db.prepare(
			"SELECT intent, confidence FROM query_patterns WHERE pattern = ?",
		);
		const row = stmt.get(pattern) as
			| { intent: string; confidence: number }
			| undefined;
		return row ? { intent: row.intent, confidence: row.confidence } : null;
	}

	/**
	 * Update query pattern intent.
	 */
	updatePatternIntent(
		pattern: string,
		intent: string,
		confidence: number,
		sampleCount: number,
	): void {
		const stmt = this.db.prepare(`
			INSERT OR REPLACE INTO query_patterns (pattern, intent, confidence, sample_count, last_updated)
			VALUES (?, ?, ?, ?, ?)
		`);

		stmt.run(pattern, intent, confidence, sampleCount, new Date().toISOString());
	}

	// ========================================================================
	// Statistics
	// ========================================================================

	/**
	 * Get learning statistics.
	 */
	getStatistics(): LearningStatistics {
		const totalEvents = (
			this.db.prepare("SELECT COUNT(*) as count FROM search_feedback").get() as {
				count: number;
			}
		).count;

		const eventsByType: Record<FeedbackType, number> = {
			explicit: 0,
			refinement: 0,
			implicit: 0,
		};

		const typeRows = this.db
			.prepare(
				`
			SELECT feedback_type, COUNT(*) as count
			FROM search_feedback
			GROUP BY feedback_type
		`,
			)
			.all() as Array<{ feedback_type: FeedbackType; count: number }>;

		for (const row of typeRows) {
			eventsByType[row.feedback_type] = row.count;
		}

		const useCaseRows = this.db
			.prepare(
				`
			SELECT use_case, COUNT(*) as count
			FROM search_feedback
			WHERE use_case IS NOT NULL
			GROUP BY use_case
		`,
			)
			.all() as Array<{ use_case: string; count: number }>;

		const eventsByUseCase: Record<string, number> = {};
		for (const row of useCaseRows) {
			eventsByUseCase[row.use_case] = row.count;
		}

		const uniqueQueries = (
			this.db
				.prepare(
					"SELECT COUNT(DISTINCT query_hash) as count FROM search_feedback",
				)
				.get() as { count: number }
		).count;

		const topQueries = this.db
			.prepare(
				`
			SELECT query, COUNT(*) as count
			FROM search_feedback
			GROUP BY query_hash
			ORDER BY count DESC
			LIMIT 10
		`,
			)
			.all() as Array<{ query: string; count: number }>;

		const topBoostedFiles = this.getTopBoostedFiles(10);

		const lastFeedback = this.db
			.prepare(
				"SELECT created_at FROM search_feedback ORDER BY created_at DESC LIMIT 1",
			)
			.get() as { created_at: string } | undefined;

		const lastTraining = this.db
			.prepare(
				"SELECT last_updated FROM adaptive_weights ORDER BY last_updated DESC LIMIT 1",
			)
			.get() as { last_updated: string } | undefined;

		// Calculate average acceptance rate using SQL aggregation (avoid N+1 query)
		// Wrapped in try-catch to handle corrupted JSON in database
		let averageAcceptanceRate = 0;
		let totalResults = 0;
		let totalAccepted = 0;
		if (totalEvents > 0) {
			try {
				const aggStmt = this.db.prepare(`
					SELECT
						SUM(json_array_length(result_ids)) as total_results,
						SUM(json_array_length(accepted_ids)) as total_accepted
					FROM (
						SELECT result_ids, accepted_ids FROM search_feedback
						ORDER BY created_at DESC
						LIMIT 100
					)
				`);
				const agg = aggStmt.get() as {
					total_results: number | null;
					total_accepted: number | null;
				};
				totalResults = agg.total_results ?? 0;
				totalAccepted = agg.total_accepted ?? 0;
				averageAcceptanceRate =
					totalResults > 0 ? totalAccepted / totalResults : 0;
			} catch (error) {
				// JSON may be corrupted in database - fall back to 0
				console.error(
					`[FeedbackStore] Failed to calculate acceptance rate: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}

		return {
			totalFeedbackEvents: totalEvents,
			eventsByType,
			eventsByUseCase,
			uniqueQueries,
			averageAcceptanceRate,
			totalResults,
			totalAccepted,
			acceptanceRate: averageAcceptanceRate,
			topQueries,
			topBoostedFiles,
			lastFeedbackAt: lastFeedback ? new Date(lastFeedback.created_at) : null,
			lastTrainingAt: lastTraining ? new Date(lastTraining.last_updated) : null,
		};
	}

	// ========================================================================
	// Cleanup
	// ========================================================================

	/**
	 * Prune old feedback events beyond maxSamples.
	 */
	pruneOldFeedback(): number {
		const stmt = this.db.prepare(`
			DELETE FROM search_feedback
			WHERE id NOT IN (
				SELECT id FROM search_feedback
				ORDER BY created_at DESC
				LIMIT ?
			)
		`);

		const result = stmt.run(this.config.maxSamples);
		return result.changes;
	}

	/**
	 * Clear all learning data (for reset).
	 */
	clearAll(): void {
		this.db.exec(`
			DELETE FROM search_feedback;
			DELETE FROM query_history;
			DELETE FROM adaptive_weights;
			DELETE FROM file_boosts;
			DELETE FROM query_patterns;
		`);
	}

	// ========================================================================
	// Private Helpers
	// ========================================================================

	/**
	 * Safely parse JSON with error handling.
	 * Returns defaultValue if parsing fails instead of crashing.
	 */
	private safeJsonParse<T>(
		json: string,
		defaultValue: T,
		context: string,
	): T {
		try {
			return JSON.parse(json);
		} catch (error) {
			console.error(
				`[FeedbackStore] Failed to parse JSON in ${context}: ${json.slice(0, 100)}${json.length > 100 ? "..." : ""}`,
			);
			return defaultValue;
		}
	}

	private rowToFeedbackEvent(row: Record<string, unknown>): SearchFeedbackEvent {
		return {
			id: row.id as number,
			query: row.query as string,
			queryHash: row.query_hash as string,
			sessionId: row.session_id as string,
			resultIds: this.safeJsonParse(row.result_ids as string, [], "result_ids"),
			acceptedIds: this.safeJsonParse(row.accepted_ids as string, [], "accepted_ids"),
			rejectedIds: this.safeJsonParse(row.rejected_ids as string, [], "rejected_ids"),
			feedbackType: row.feedback_type as FeedbackType,
			feedbackSource: row.feedback_source as "mcp" | "cli" | "api",
			useCase: row.use_case as SearchUseCase | undefined,
			context: row.context
				? this.safeJsonParse(row.context as string, undefined, "context")
				: undefined,
			createdAt: row.created_at as string,
		};
	}
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a FeedbackStore instance.
 */
export function createFeedbackStore(
	db: SQLiteDatabase,
	config?: Partial<LearningConfig>,
): FeedbackStore {
	const store = new FeedbackStore(db, config);
	store.initializeSchema();
	return store;
}
