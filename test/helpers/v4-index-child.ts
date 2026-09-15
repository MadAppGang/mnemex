/**
 * A REAL `Indexer` in a sandboxed child, for the index-v4 criteria that need a
 * process boundary: the ghost-chunk regression (architecture §4.2), V3.20's
 * kill, V4.2's result object, V4.5, and V4.7's in-process schema memo.
 *
 * NOTHING HERE JUDGES. It runs, and prints what happened as data. The parent
 * asserts through connections of its own (CLAUDE.md #24, #31).
 *
 * argv: <mode> <projectDir>
 *
 *   index         one `index(false)` with NO `onProgress` (V4.2: the data channel
 *                 must not depend on rendering). Prints `RESULT <json>`.
 *   rebuild-memo  V4.7: `initialize()`, which constructs the FileTracker and so
 *                 records its per-process schema memo, then `rebuildStore()`.
 *                 Reads `PRAGMA table_info(files)` and tries two inserts through
 *                 THAT tracker's own connection. Prints `RESULT <json>`.
 *
 * The project's own config turns vectors and enrichment off (`vector: false`,
 * `enrichment: false`) and the parent turns docs off by env. Nothing can then
 * reach the network or the keychain: the real parser, tracker and LanceDB store
 * run with a `[0]` placeholder vector, the production BM25-only mode.
 */

import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { createIndexer } from "../../src/core/indexer.js";
import type { SQLiteDatabase } from "../../src/core/sqlite.js";
import { exitUnlessSandboxed } from "./sandbox-guard.js";

// `index()` reads ~/.mnemex/config.json and opens the embedding cache: refuse to
// start unless HOME is provably a temp directory (CLAUDE.md #25, #31).
exitUnlessSandboxed(homedir(), process.env.MNEMEX_TEST_SANDBOX_HOME, tmpdir());

/** Under tmpdir() in either spelling: a git sandbox's root is realpath'd. */
function insideTmp(path: string | undefined): boolean {
	if (path === undefined) return false;
	return [tmpdir(), realpathSync.native(tmpdir())].some((t) =>
		path.startsWith(t),
	);
}
for (const name of ["MNEMEX_EMBED_CACHE_PATH", "MNEMEX_GLOBAL_LOCK_PATH"]) {
	if (!insideTmp(process.env[name])) {
		console.error(`${name} must point inside tmpdir()`);
		process.exit(64);
	}
}

const [mode, projectDir] = process.argv.slice(2);
if (!projectDir || (mode !== "index" && mode !== "rebuild-memo")) {
	console.error("usage: v4-index-child <index|rebuild-memo> <projectDir>");
	process.exit(64);
}

if (mode === "index") {
	const indexer = createIndexer({
		projectPath: projectDir,
		enableEnrichment: false,
	});
	try {
		const result = await indexer.index(false);
		console.log(
			`RESULT ${JSON.stringify({
				filesIndexed: result.filesIndexed,
				chunksCreated: result.chunksCreated,
				errors: result.errors,
				// Present-or-absent is the property (V4.8), so it is reported as both.
				hasUpgradedField: result.upgradedFromIndexVersion !== undefined,
				upgradedFromIndexVersion: result.upgradedFromIndexVersion ?? null,
			})}`,
		);
	} finally {
		await indexer.close();
	}
} else {
	const indexer = createIndexer({
		projectPath: projectDir,
		enableEnrichment: false,
	});
	// Private members, reached on purpose: V4.7 is about this exact in-process
	// order, which no public surface exposes.
	const internals = indexer as unknown as {
		initialize(): Promise<void>;
		rebuildStore(): Promise<void>;
		fileTracker: { getDatabase(): SQLiteDatabase };
	};
	await internals.initialize();
	const db = internals.fileTracker.getDatabase();
	await internals.rebuildStore();
	const columns = (
		db.prepare("PRAGMA table_info(files)").all() as Array<{ name: string }>
	).map((c) => c.name);
	const insert = (branchId: number): string => {
		try {
			db.prepare(
				"INSERT INTO files (branch_id, path, content_hash, mtime, chunk_ids, indexed_at) VALUES (?, 'a.ts', 'h', 1, '[]', 't')",
			).run(branchId);
			return "ok";
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
	};
	console.log(
		`RESULT ${JSON.stringify({ columns, first: insert(1), second: insert(2) })}`,
	);
	await indexer.close();
}
process.exit(0);
