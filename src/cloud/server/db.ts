/**
 * PostgreSQL database connection and helpers for the cloud test server.
 * Uses the `postgres` npm package (porsager/postgres).
 */

import postgres from "postgres";

export type Sql = postgres.Sql;
// TransactionSql is Omit<Sql, ...> but TypeScript drops call signatures from Omit.
// Use postgres.Sql as the transaction type — it's structurally compatible at runtime.
export type TxSql = postgres.Sql;

/**
 * Create a postgres connection pool.
 */
export function createDatabase(connectionString: string): Sql {
	return postgres(connectionString, {
		max: 10,
		idle_timeout: 30,
		connect_timeout: 30,
	});
}

/**
 * Truncate all tables for test isolation.
 */
export async function resetDatabase(sql: Sql): Promise<void> {
	await sql`TRUNCATE TABLE api_key_usage, api_keys, enrichment_docs, commit_files, commits, chunks, repos RESTART IDENTITY CASCADE`;
}
