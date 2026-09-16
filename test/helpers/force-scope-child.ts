/**
 * A REAL `Indexer` in a sandboxed child, for the `--force` scope criteria
 * (architecture §4.5 / D3, decision I-16, V3.19).
 *
 * NOTHING HERE JUDGES. It runs, and prints what happened as data. The parent
 * asserts through connections of its own (CLAUDE.md #24, #31).
 *
 * argv: <mode> <projectDir>
 *
 *   force       `index(true, false)`  — D3's branch-scoped force.
 *   force-all   `index(false, true)`  — the deliberate whole-store rebuild.
 *   corrupt     the corruption repair, which is store-wide BY NATURE and must
 *               stay that way. A `FixedSizeList[0]` vector column cannot be
 *               BUILT any more — LanceDB >= 0.33 refuses to create one
 *               (CLAUDE.md #15), so no fixture can reach this branch — so the
 *               SIGNAL is produced instead, by pointing `isUnqueryable()` at
 *               `true` on the store class the indexer constructs. Everything
 *               downstream of the signal is the production code path,
 *               unmodified, and the parent asserts on rows.
 *
 * The project's own config turns vectors and enrichment off, and the parent
 * turns docs off by env, so nothing can reach the network or the keychain.
 */

import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { createIndexer } from "../../src/core/indexer.js";
import { VectorStore } from "../../src/core/store.js";
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

const MODES = new Set(["force", "force-all", "corrupt"]);
const [mode, projectDir] = process.argv.slice(2);
if (!projectDir || !MODES.has(mode)) {
	console.error(
		"usage: force-scope-child <force|force-all|corrupt> <projectDir>",
	);
	process.exit(64);
}

if (mode === "corrupt") {
	// The ONE line of production behaviour this child changes, and it changes a
	// PROBE, not a decision: what the indexer does about it is untouched.
	VectorStore.prototype.isUnqueryable = async () => true;
}

const indexer = createIndexer({
	projectPath: projectDir,
	enableEnrichment: false,
});
try {
	const result = await indexer.index(mode === "force", mode === "force-all");
	console.log(
		`RESULT ${JSON.stringify({
			filesIndexed: result.filesIndexed,
			chunksCreated: result.chunksCreated,
			errors: result.errors,
			branch: result.branch ?? null,
		})}`,
	);
} finally {
	await indexer.close();
}
process.exit(0);
