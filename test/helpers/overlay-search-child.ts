/**
 * `Indexer.searchScoped` with a STORE LOCK held in this process (step 3,
 * phase 6: EC-1's full form, MEDIUM 4).
 *
 * The case is the MCP server's: one request holds the store lock (an
 * auto-index) while another runs a search, so the overlay must not perform
 * the embed cache's one unbounded region — the full `openEmbedCache` — under
 * that lock. A CLI search never holds the lock while it searches, so this
 * needs an in-process seam, and a child because the real `Indexer` reads
 * `~/.mnemex/config.json` through `homedir()` (CLAUDE.md #25). The parent
 * spawns it with `sandboxEnv()`. Nothing here judges: it prints `RESULT <json>`.
 *
 *   overlay-search-child ec1 <project> <query>
 *   overlay-search-child m7  <project> <query>
 *
 * `ec1`: every `openEmbedCache` call is recorded with its options; a call
 * WITHOUT `{ ifAlreadyOpen: true }` is a full open.
 *
 * `m7` (code review 1, MEDIUM 7): one search with a path filter, recording the
 * options object the INDEX search received and the one the overlay's vector
 * read received. `filePath` is not on the public `SearchOptions` today; it is
 * passed through a cast, as the first caller to thread it would, to show it
 * reaches both channels or neither.
 */

import { spyOn } from "bun:test";
import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import * as embedCache from "../../src/core/embed-cache.js";
import { createIndexer } from "../../src/core/indexer.js";
import { createStoreLock } from "../../src/core/lock.js";
import { VectorStore } from "../../src/core/store.js";
import { resolveStoreLocation } from "../../src/core/store-location.js";
import type { SearchOptions } from "../../src/types.js";
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

const [mode, project, query] = process.argv.slice(2);
if ((mode !== "ec1" && mode !== "m7") || !project || !query) {
	console.error("usage: overlay-search-child ec1|m7 <project> <query>");
	process.exit(64);
}

if (mode === "m7") {
	const pick = (o: unknown) => {
		const v = (o ?? {}) as Record<string, unknown>;
		return {
			limit: v.limit,
			language: v.language,
			filePath: v.filePath,
			pathPattern: v.pathPattern,
		};
	};
	const indexSearch = spyOn(VectorStore.prototype, "search");
	const overlayRead = spyOn(VectorStore.prototype, "vectorCandidates");
	const indexer = createIndexer({ projectPath: project });
	let overlay: unknown;
	try {
		overlay = (
			await indexer.searchScoped(query, {
				limit: 5,
				pathPattern: "src/**",
				filePath: "src/alpha.ts",
			} as SearchOptions)
		).overlay;
	} finally {
		await indexer.close();
	}
	console.log(
		`RESULT ${JSON.stringify({
			overlay,
			index: indexSearch.mock.calls.map((c) => pick(c[3])),
			overlayRead: overlayRead.mock.calls.map((c) => pick(c[2])),
		})}`,
	);
	process.exit(0);
}

const opens = spyOn(embedCache, "openEmbedCache");
const fullOpens = () =>
	opens.mock.calls.filter(
		(call) =>
			(call[1] as { ifAlreadyOpen?: boolean } | undefined)?.ifAlreadyOpen !==
			true,
	).length;

const storeLock = createStoreLock(resolveStoreLocation(project));
const held = await storeLock.acquire({ waitTimeout: 0 });
if (!held.acquired) {
	console.error("could not take the store lock");
	process.exit(65);
}
let underLock: unknown;
let fullOpensUnderLock: number;
try {
	const indexer = createIndexer({ projectPath: project });
	try {
		underLock = (await indexer.searchScoped(query, { limit: 5 })).overlay;
	} finally {
		await indexer.close();
	}
	fullOpensUnderLock = fullOpens();
} finally {
	storeLock.release();
}

// Control: the same search with no lock held opens the cache and serves.
const indexer = createIndexer({ projectPath: project });
let released: unknown;
let dirtyRows = 0;
try {
	const scoped = await indexer.searchScoped(query, { limit: 5 });
	released = scoped.overlay;
	dirtyRows = scoped.results.filter((r) => r.source === "dirty").length;
} finally {
	await indexer.close();
}

console.log(
	`RESULT ${JSON.stringify({
		underLock,
		fullOpensUnderLock,
		memoOnlyCallsUnderLock: opens.mock.calls.length - fullOpensUnderLock,
		released,
		fullOpensAfter: fullOpens(),
		dirtyRows,
	})}`,
);
process.exit(0);
