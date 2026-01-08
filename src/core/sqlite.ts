/**
 * SQLite Abstraction Layer
 *
 * Provides a unified interface that works with both:
 * - bun:sqlite (when running in Bun - dev mode or compiled binary)
 * - better-sqlite3 (when running in Node.js - npm install)
 */

// Detect if we're running in Bun
const isBun = typeof globalThis.Bun !== "undefined";

// Type definitions for our abstraction
export interface RunResult {
	changes: number;
	lastInsertRowid: number | bigint;
}

export interface Statement {
	run(...params: unknown[]): RunResult;
	get(...params: unknown[]): unknown;
	all(...params: unknown[]): unknown[];
}

export interface SQLiteDatabase {
	exec(sql: string): void;
	prepare(sql: string): Statement;
	close(): void;
	/** Execute a function within a transaction (auto-commits or rolls back) */
	transaction<T>(fn: () => T): T;
}

/**
 * Create a SQLite database connection (synchronous)
 * Uses bun:sqlite in Bun, better-sqlite3 in Node.js
 */
export function createDatabaseSync(path: string): SQLiteDatabase {
	if (isBun) {
		// Use Bun's built-in SQLite
		// @ts-ignore - bun:sqlite is only available in Bun
		const { Database } = require("bun:sqlite");
		const db = new Database(path);

		return {
			exec: (sql: string) => db.exec(sql),
			prepare: (sql: string) => {
				const stmt = db.prepare(sql);
				return {
					run: (...params: unknown[]): RunResult => {
						stmt.run(...params);
						// Bun's sqlite doesn't return changes directly from run()
						// Use the database's changes() method
						return {
							changes: db.query("SELECT changes() as c").get().c as number,
							lastInsertRowid: db
								.query("SELECT last_insert_rowid() as id")
								.get().id as number,
						};
					},
					get: (...params: unknown[]) => stmt.get(...params),
					all: (...params: unknown[]) => stmt.all(...params),
				};
			},
			close: () => db.close(),
			transaction: <T>(fn: () => T): T => {
				db.exec("BEGIN");
				try {
					const result = fn();
					db.exec("COMMIT");
					return result;
				} catch (error) {
					db.exec("ROLLBACK");
					throw error;
				}
			},
		};
	} else {
		// Use better-sqlite3 for Node.js
		// @ts-ignore - dynamic require
		const BetterSqlite3 = require("better-sqlite3");
		const db = new BetterSqlite3(path);

		return {
			exec: (sql: string) => db.exec(sql),
			prepare: (sql: string) => {
				const stmt = db.prepare(sql);
				return {
					run: (...params: unknown[]): RunResult => {
						const result = stmt.run(...params);
						return {
							changes: result.changes,
							lastInsertRowid: result.lastInsertRowid,
						};
					},
					get: (...params: unknown[]) => stmt.get(...params),
					all: (...params: unknown[]) => stmt.all(...params),
				};
			},
			close: () => db.close(),
			transaction: <T>(fn: () => T): T => {
				// better-sqlite3 has native transaction support
				return db.transaction(fn)();
			},
		};
	}
}
