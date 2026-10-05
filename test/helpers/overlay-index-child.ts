/**
 * CUR-2's child (step 3, P-E1): a REAL `Indexer.index()` with a save injected
 * between the indexer's read of one file and whatever it hashes.
 *
 * WHY A CHILD. `index()` reads `~/.mnemex/config.json` and opens the embedding
 * cache, and Bun's `homedir()` ignores a runtime `HOME` reassignment, so only a
 * process STARTED with a sandboxed `HOME` is safe (CLAUDE.md #25, #31).
 *
 * THE INJECTION. `readFileSync` is spied (Bun's `spyOn` rebinds the named
 * import every module holds). The FIRST read of `<target>` returns the file's
 * bytes as they are, and only then the file is rewritten with `<newContent>`.
 * In a fresh index nothing reads a new file before the chunking read (the
 * tracker's `getChanges` hashes only files it already has a row for), so the
 * write lands exactly between "the bytes that get chunked" and anything read
 * after them. Before P-E1 the indexer hashed a SECOND read, which then saw the
 * new bytes and recorded their hash beside the old bytes' chunks.
 *
 * NOTHING HERE JUDGES. It prints `RESULT <json>`; the parent reads the tracker
 * and the store through connections of its own.
 *
 * argv: <projectDir> <targetAbsPath> <newContentFile>
 */

import { spyOn } from "bun:test";
import * as fs from "node:fs";
import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { createIndexer } from "../../src/core/indexer.js";
import { exitUnlessSandboxed } from "./sandbox-guard.js";

exitUnlessSandboxed(homedir(), process.env.MNEMEX_TEST_SANDBOX_HOME, tmpdir());

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

const [projectDir, target, newContentFile] = process.argv.slice(2);
if (!projectDir || !target || !newContentFile) {
	console.error(
		"usage: overlay-index-child <projectDir> <target> <newContentFile>",
	);
	process.exit(64);
}

const newContent = fs.readFileSync(newContentFile);
const original = fs.readFileSync;
const realTarget = realpathSync.native(target);
let targetReads = 0;
let injected = false;

spyOn(fs, "readFileSync").mockImplementation(((
	path: fs.PathOrFileDescriptor,
	options?: unknown,
) => {
	const value = (original as (p: unknown, o?: unknown) => unknown)(
		path,
		options,
	);
	if (typeof path === "string" && (path === target || path === realTarget)) {
		targetReads++;
		if (!injected) {
			injected = true;
			// The save lands AFTER the read whose bytes are about to be chunked.
			fs.writeFileSync(realTarget, newContent);
		}
	}
	return value;
}) as typeof fs.readFileSync);

const indexer = createIndexer({
	projectPath: projectDir,
	enableEnrichment: false,
});
try {
	const result = await indexer.index(false);
	console.log(
		`RESULT ${JSON.stringify({
			filesIndexed: result.filesIndexed,
			errors: result.errors,
			targetReads,
			injected,
		})}`,
	);
} finally {
	await indexer.close();
}
