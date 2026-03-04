/**
 * Standalone entry point for the claudemem cloud server.
 * Runs schema migration on boot, then starts the HTTP server.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { startServer } from "./index.js";
import { createDatabase } from "./db.js";
import { loadConfig } from "./config.js";

async function main() {
	const config = loadConfig();

	// Run schema migration (retry up to 3 times for Neon cold-start)
	console.log("[boot] Running schema migration...");
	const schemaPath = resolve(dirname(new URL(import.meta.url).pathname), "schema.sql");
	const schema = readFileSync(schemaPath, "utf-8");
	for (let attempt = 1; attempt <= 3; attempt++) {
		const migrationSql = createDatabase(config.databaseUrl);
		try {
			await migrationSql.unsafe(schema);
			console.log("[boot] Schema migration complete.");
			break;
		} catch (err) {
			console.error(`[boot] Migration attempt ${attempt}/3 failed:`, err);
			if (attempt === 3) {
				console.error("[boot] All migration attempts failed, starting server anyway (tables may already exist).");
			} else {
				await new Promise(r => setTimeout(r, 3000));
			}
		} finally {
			await migrationSql.end();
		}
	}

	// Start server
	const { baseUrl } = await startServer(config);
	console.log(`[boot] Server ready at ${baseUrl}`);

	// Database usage snapshots — emit every 60 minutes as a structured log line
	const SNAPSHOT_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

	async function emitDbSnapshot(): Promise<void> {
		const snapshotSql = createDatabase(config.databaseUrl);
		try {
			const rows = await snapshotSql<
				{
					total_chunks: string;
					total_commits: string;
					total_repos: string;
					total_orgs: string;
					total_enrichment_docs: string;
				}[]
			>`
				SELECT
					(SELECT COUNT(*) FROM chunks)::text AS total_chunks,
					(SELECT COUNT(*) FROM commits)::text AS total_commits,
					(SELECT COUNT(*) FROM repos)::text AS total_repos,
					(SELECT COUNT(*) FROM orgs)::text AS total_orgs,
					(SELECT COUNT(*) FROM enrichment_docs)::text AS total_enrichment_docs
			`;
			const snap = rows[0];
			if (snap) {
				console.log(
					JSON.stringify({
						type: "db_snapshot",
						ts: new Date().toISOString(),
						totalChunks: Number.parseInt(snap.total_chunks, 10),
						totalCommits: Number.parseInt(snap.total_commits, 10),
						totalRepos: Number.parseInt(snap.total_repos, 10),
						totalOrgs: Number.parseInt(snap.total_orgs, 10),
						totalEnrichmentDocs: Number.parseInt(snap.total_enrichment_docs, 10),
					}),
				);
			}
		} catch (err) {
			console.error("[snapshot] Failed to emit db snapshot:", err);
		} finally {
			await snapshotSql.end();
		}
	}

	// Emit once on startup, then every hour
	emitDbSnapshot().catch(() => {});
	const snapshotTimer = setInterval(() => {
		emitDbSnapshot().catch(() => {});
	}, SNAPSHOT_INTERVAL_MS);
	snapshotTimer.unref(); // Don't prevent process exit

	// Graceful shutdown
	const shutdown = async () => {
		console.log("[boot] Shutting down...");
		const { stopServer } = await import("./index.js");
		await stopServer();
		process.exit(0);
	};

	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
}

main().catch((err) => {
	console.error("[boot] Fatal:", err);
	process.exit(1);
});
