/**
 * A fresh process that tries to open the embedding cache at the DEFAULT path, so
 * the parent can assert that it CANNOT — and that the bytes at that path did not
 * move.
 *
 * The adversary for the defect this guard closes: `~/.mnemex/embed-cache.db` is
 * machine-global (CLAUDE.md #31), and every test that reaches `Indexer.index()`
 * opens it by default. One such test — `indexer-model-mismatch.probe.ts`, which
 * predates the cache — created a 36,864-byte cache in a real user's home
 * directory. Nothing about that probe was wrong; the DEFAULT became a user path
 * underneath it.
 *
 * Deliberately spawned:
 *  - with no `MNEMEX_EMBED_CACHE_PATH`, so it really does target the user file;
 *  - without ever calling `enableUserEmbedCachePath()`, which only `src/index.ts`
 *    does — this child is not an entry point;
 *  - optionally from a working directory where `bunfig.toml` is NOT found, so
 *    `[test] preload` never runs. The primary guard must not need it.
 *
 * It REPORTS what it observed rather than asserting, so the parent can prove the
 * preconditions were genuinely absent: a child that silently inherited a redirect
 * would otherwise "pass" for the wrong reason.
 *
 * Usage: bun run test/helpers/embed-cache-user-path-child.ts [moduleToImport]
 *
 * `moduleToImport` defaults to `src/core/embed-cache.ts`. The parent passes a
 * BUNDLE of that module — one intact, one with the guard cut out — to prove the
 * bytes-on-disk assertion is capable of going red.
 *
 * Prints one JSON line on stdout after `__RESULT__`.
 */

import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const target =
	process.argv[2] ??
	join(import.meta.dir, "..", "..", "src", "core", "embed-cache.ts");

const mod = (await import(pathToFileURL(target).href)) as {
	openEmbedCache: (path?: string) => unknown;
	getEmbedCachePath: () => string;
};

const path = mod.getEmbedCachePath();
let refused = false;
let message: string | null = null;
let opened = false;

try {
	opened = mod.openEmbedCache() !== null;
} catch (error) {
	refused = true;
	message = error instanceof Error ? error.message : String(error);
}

const out = {
	module: target,
	cwd: process.cwd(),
	// Proof the preconditions were genuinely absent in this process.
	home: process.env.HOME ?? null,
	homedir: homedir(),
	pathEnv: process.env.MNEMEX_EMBED_CACHE_PATH ?? null,
	disableEnv: process.env.MNEMEX_DISABLE_EMBED_CACHE ?? null,
	guardEnv: process.env.MNEMEX_EMBED_CACHE_TEST_GUARD ?? null,
	// The file it was about to write, and whether that file exists now.
	path,
	refused,
	message,
	opened,
	exists: existsSync(path),
	size: existsSync(path) ? statSync(path).size : null,
};

process.stdout.write(`__RESULT__${JSON.stringify(out)}\n`);
