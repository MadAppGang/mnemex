/**
 * A dirty-overlay pass in a CHILD process, for the two properties that need a
 * process boundary (step 3, phase 4):
 *
 *   k1 <repo> <trackerDb> <embedCache> <endpoint>
 *       K-1: one pass whose raw client is a REAL Ollama client pointed at the
 *       parent's counting fake server. Two of these run at once; the parent
 *       counts what reached the server. Every `IndexLock.acquire` is recorded
 *       by path, so the parent can see that no store or global lock was taken.
 *
 *   y1 <repo> <trackerDb> <embedCache> <files>
 *       Y-1: holds a STORE lock (as an MCP server mid-index does) for the whole
 *       pass, with the embed cache memo warm (as `index()` leaves it), and
 *       builds an overlay over `<files>` dirty files with an in-process stub
 *       embedder. The PARENT samples the store lock file's heartbeat from
 *       outside; this process only reports.
 *
 * Nothing here judges. It prints `RESULT <json>`.
 */

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { DEFAULT_EXCLUDE_PATTERNS } from "../../src/config.js";
import { openEmbedCache } from "../../src/core/embed-cache.js";
import { createEmbeddingsClient } from "../../src/core/embeddings.js";
import { createFileSelection } from "../../src/core/file-selection.js";
import { createStoreLock, IndexLock } from "../../src/core/lock.js";
import { prepareDirtyOverlay } from "../../src/core/overlay/dirty-overlay.js";
import { resolveStoreLocation } from "../../src/core/store-location.js";
import { createFileTracker } from "../../src/core/tracker.js";
import { getParserManager } from "../../src/parsers/parser-manager.js";
import type {
	EmbeddingProvider,
	EmbedResult,
	IEmbeddingsClient,
} from "../../src/types.js";
import { vectorFor } from "./fake-ollama-embed-server.js";
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

const [mode, repo, trackerDb, embedCachePath, extra] = process.argv.slice(2);
if (!mode || !repo || !trackerDb || !embedCachePath || !extra) {
	console.error(
		"usage: dirty-overlay-child <k1|y1> <repo> <trackerDb> <embedCache> <endpoint|files>",
	);
	process.exit(64);
}
if (!insideTmp(embedCachePath)) {
	console.error("embedCache must point inside tmpdir()");
	process.exit(64);
}

// Every lock this process takes, by path.
const acquired: string[] = [];
const realAcquire = IndexLock.prototype.acquire;
IndexLock.prototype.acquire = async function (this: IndexLock, options) {
	const result = await realAcquire.call(this, options);
	if (result.acquired) acquired.push(this.path);
	return result;
};

class FastStub implements IEmbeddingsClient {
	texts = 0;
	async embed(texts: string[]): Promise<EmbedResult> {
		this.texts += texts.length;
		return { embeddings: texts.map((t) => vectorFor(t, 8)) };
	}
	async embedOne(text: string): Promise<number[]> {
		return vectorFor(text, 8);
	}
	getModel(): string {
		return "stub-model";
	}
	getDimension(): number {
		return 8;
	}
	getProvider(): EmbeddingProvider {
		return "openrouter";
	}
	isLocal(): boolean {
		return false;
	}
}

await getParserManager().initialize();
const loc = resolveStoreLocation(repo);
const tracker = createFileTracker(trackerDb, repo);
const selection = createFileSelection({
	projectRealPath: loc.pathRoot,
	pathRoot: loc.pathRoot,
	excludePatterns: [...DEFAULT_EXCLUDE_PATTERNS],
	includePatterns: [],
});

const base = {
	loc,
	selection,
	tracker,
	branchIds: [1],
	trackerBranchId: 1,
	search: { limit: 10 },
	embedCachePath,
};

if (mode === "k1") {
	const client = createEmbeddingsClient({
		provider: "ollama",
		model: "fake-embed",
		endpoint: extra,
	});
	const started = Date.now();
	const result = await prepareDirtyOverlay({
		...base,
		indexIdentity: { model: "fake-embed", provider: "ollama" },
		queryIdentity: { model: "fake-embed", provider: "ollama" },
		queryClient: client,
		// Not spent on the server: the parent counts overlay texts only.
		queryVector: vectorFor("the query", 8),
	});
	console.log(
		`RESULT ${JSON.stringify({
			report: result.report,
			served: result.candidates?.servedPaths ?? [],
			ms: Date.now() - started,
			locks: acquired,
		})}`,
	);
} else if (mode === "y1") {
	// As `index()` leaves it: the cache memo opened BEFORE the store lock.
	openEmbedCache(embedCachePath);
	const storeLock = createStoreLock(loc);
	const got = await storeLock.acquire({ waitTimeout: 0 });
	if (!got.acquired) {
		console.error(`store lock not acquired: ${got.reason}`);
		process.exit(65);
	}
	console.log(`LOCKED ${storeLock.path}`);
	const stub = new FastStub();
	const started = Date.now();
	const result = await prepareDirtyOverlay({
		...base,
		indexIdentity: { model: "stub-model", provider: "openrouter" },
		queryIdentity: { model: "stub-model", provider: "openrouter" },
		queryClient: stub,
		queryVector: vectorFor("the query", 8),
	});
	const ms = Date.now() - started;
	storeLock.release();
	console.log(
		`RESULT ${JSON.stringify({
			report: result.report,
			files: Number(extra),
			ms,
			texts: stub.texts,
			hash: createHash("sha256")
				.update(JSON.stringify(result.report))
				.digest("hex"),
		})}`,
	);
} else {
	console.error(`unknown mode ${mode}`);
	process.exit(64);
}
(tracker as unknown as { close(): void }).close();
