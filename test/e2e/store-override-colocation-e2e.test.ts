/**
 * Decision I-8 through the CLI, on disk: a lock and the data it protects
 * resolve from ONE function.
 *
 * Before I-8 the store lock honoured MNEMEX_INDEX_DIR and the data paths did
 * not, so a run with the variable set wrote `<project>/.mnemex` while taking
 * `<override>/.indexing.lock`: one store, two locks. Here, with the variable set:
 *
 *   1. `index`, `symbol` (the CLI's own tracker helper), `search`, `observe` and
 *      `docs refresh` all write and read the OVERRIDE, counted through THIS
 *      process's own LanceDB and SQLite connections, and the default directory
 *      receives none of it. Without the variable the same project has no index,
 *      so nothing above was served from anywhere else.
 *   2. While ANOTHER process holds the override's lock, `index` is refused,
 *      `observe` degrades, and `docs refresh` (the fourth unlocked writer I-8
 *      brings under the lock) refuses loudly, non-zero, and changes nothing.
 *   3. With the variable UNSET the store, and its lock, stay at `<project>/.mnemex`.
 *   4. `hooks install` in a linked worktree prints where the hook really is.
 *
 * Runs the SOURCE entry point (`bun --env-file=/dev/null src/index.ts`, CLAUDE.md
 * #23), so it needs no build. Every child env comes from `keychainSafeChildEnv()`,
 * with HOME, the embed cache and the global lock inside the sandbox, every
 * inherited GIT_* variable dropped, and MNEMEX_INDEX_DIR set only where a test
 * sets it. Embeddings come from a local fake Ollama server.
 */

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import { createFileTracker } from "../../src/core/tracker.js";
import { keychainSafeChildEnv } from "../helpers/child-env.js";
import {
	type FakeEmbedServer,
	startFakeOllamaEmbedServer,
} from "../helpers/fake-ollama-embed-server.js";
import { createGitSandbox, type GitSandbox } from "../helpers/git-sandbox.js";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const ENTRY = join(REPO_ROOT, "src", "index.ts");
const HOLDER = join(
	import.meta.dir,
	"..",
	"helpers",
	"store-lock-holder-child.ts",
);
const MODEL = "ollama/fake-embed";
const INDEX_DIR_ENV = "MNEMEX_INDEX_DIR";

/** D5's refusal wait for `docs clear`, which `docs refresh` now shares. */
const REFUSE_WAIT_MS = 30_000;
/** A blocked observe waits 2 s; this ceiling includes start-up under load. */
const OBSERVE_CEILING_MS = 15_000;

/** What a store directory holds. None of it may appear in the one the store left. */
const STORE_ARTIFACTS = [
	"index.db",
	"vectors",
	".indexing.lock",
	"CACHEDIR.TAG",
];

let sb: GitSandbox;
let origin: string;
let home: string;
let server: FakeEmbedServer;
let counter = 0;

beforeAll(() => {
	sb = createGitSandbox("override-coloc-");
	origin = join(sb.root, "origin");
	mkdirSync(origin);
	sb.git(origin, "init", "-q");
	writeFileSync(
		join(origin, "alpha.ts"),
		"export function alphaValue(): number {\n\treturn 1;\n}\n",
	);
	sb.git(origin, "add", "-A");
	sb.git(origin, "commit", "-q", "-m", "init");

	server = startFakeOllamaEmbedServer();
	home = join(sb.root, "home-cli");
	mkdirSync(join(home, ".mnemex"), { recursive: true });
	writeFileSync(
		join(home, ".mnemex", "config.json"),
		JSON.stringify({
			embeddingProvider: "ollama",
			ollamaEndpoint: server.url,
			defaultModel: MODEL,
		}),
	);
});

afterAll(() => {
	server?.stop();
	sb?.cleanup();
});

function freshClone(): string {
	const dest = join(sb.root, `clone-${++counter}`);
	sb.git(sb.root, "clone", "-q", origin, dest);
	return dest;
}

/**
 * The child env: the blessed guard, plus a sandbox, minus any inherited GIT_*
 * and any inherited MNEMEX_INDEX_DIR. The variable is present only when a test
 * passes it, so "unset" in a test means unset in the child.
 */
// No `= {}` default on `extra`: the keychain sweep recognises a guard-supplying
// helper by its body, and a `{` in the parameter list is read as that body.
function childEnv(extra?: Record<string, string>): Record<string, string> {
	const env = keychainSafeChildEnv({
		HOME: home,
		MNEMEX_EMBED_CACHE_PATH: join(sb.root, "embed-cache.db"),
		MNEMEX_GLOBAL_LOCK_PATH: join(sb.root, "global.lock"),
		MNEMEX_MODEL: MODEL,
		MNEMEX_DOCS_ENABLED: "false",
		...extra,
	});
	for (const key of Object.keys(env)) {
		if (key.startsWith("GIT_")) delete env[key];
	}
	if (extra?.[INDEX_DIR_ENV] === undefined) delete env[INDEX_DIR_ENV];
	return env;
}

interface CliRun {
	code: number;
	stdout: string;
	stderr: string;
	elapsedMs: number;
}

async function runCli(
	args: string[],
	cwd: string,
	extra?: Record<string, string>,
): Promise<CliRun> {
	const started = Date.now();
	const proc = Bun.spawn(["bun", "--env-file=/dev/null", ENTRY, ...args], {
		cwd,
		env: childEnv(extra),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, stdout, stderr, elapsedMs: Date.now() - started };
}

interface Holder {
	pid: string;
	token: string;
	lockPath: string;
	release(): Promise<void>;
}

/** Another PROCESS takes the store lock for `project`, resolved in ITS env. */
async function holdStoreLock(
	project: string,
	extra?: Record<string, string>,
): Promise<Holder> {
	const proc = Bun.spawn(["bun", HOLDER, project], {
		cwd: project,
		env: childEnv(extra),
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
	let text = "";
	const deadline = Date.now() + 30_000;
	while (!text.includes("\n")) {
		if (Date.now() > deadline) throw new Error("holder never reported");
		const { value, done } = await reader.read();
		if (done) break;
		text += new TextDecoder().decode(value);
	}
	reader.releaseLock();
	const [status, pid, token, lockPath] = text.trim().split(" ");
	if (status !== "HELD" || !pid || !token || !lockPath) {
		throw new Error(`holder did not take the lock: ${text}`);
	}
	return {
		pid,
		token,
		lockPath,
		async release() {
			proc.stdin.end();
			await proc.exited;
		},
	};
}

async function lanceRows(store: string, where?: string): Promise<number> {
	const vectors = join(store, "vectors");
	if (!existsSync(vectors)) return 0;
	const db = await lancedb.connect(vectors);
	try {
		if (!(await db.tableNames()).includes("code_chunks")) return 0;
		const table = await db.openTable("code_chunks");
		try {
			return await table.countRows(where);
		} finally {
			table.close();
		}
	} finally {
		db.close();
	}
}

function sqlRows(store: string, table: string): number {
	const db = new Database(join(store, "index.db"), { readonly: true });
	try {
		return (
			db.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }
		).n;
	} finally {
		db.close();
	}
}

/** One indexed library in the store's tracker, written by THIS process. */
function seedDocsRow(store: string, project: string): void {
	const tracker = createFileTracker(join(store, "index.db"), project);
	try {
		tracker.markDocsIndexed("left-pad", null, "llms_txt", "hash", ["c1"]);
	} finally {
		tracker.close();
	}
}

/**
 * Store artifacts that appeared in a directory an override should have emptied.
 *
 * Checks BOTH candidates, because Phase 3c moved the no-override default and an
 * override has to beat the NEW one as well as the old: `<project>/.mnemex` (the
 * pre-3c default, and still the per-worktree directory) and
 * `<project>/.git/mnemex` (row 3, the default from 3c). An override that leaked
 * into either has failed, and checking only the one that used to be the default
 * would have stopped watching the only one a leak can now land in.
 */
function leakedIntoDefault(project: string): string[] {
	const leaked: string[] = [];
	for (const dir of [
		join(project, ".mnemex"),
		join(project, ".git", "mnemex"),
	]) {
		for (const f of STORE_ARTIFACTS) {
			if (existsSync(join(dir, f))) leaked.push(join(dir, f));
		}
	}
	return leaked;
}

/** A clone indexed into a fresh override directory, with the env that names it. */
async function indexedOverride(): Promise<{
	clone: string;
	store: string;
	env: Record<string, string>;
}> {
	const clone = freshClone();
	// The sandbox root is realpath-resolved, so this is the seam's spelling.
	const store = join(sb.root, `override-${++counter}`);
	const env = { [INDEX_DIR_ENV]: store };
	const run = await runCli(["index", "--no-llm", clone], clone, env);
	expect({ code: run.code, stderr: run.stderr }).toEqual({
		code: 0,
		stderr: expect.any(String),
	});
	return { clone, store, env };
}

// ════════════════════════════════════════════════════════════════════════════
describe("MNEMEX_INDEX_DIR set: every CLI entry point uses the OVERRIDE store", () => {
	test("index, symbol, search, observe and docs refresh write and read the override; the default dir gets nothing", async () => {
		const { clone, store, env } = await indexedOverride();

		// index: the rows are in the override.
		expect(await lanceRows(store)).toBeGreaterThan(0);
		expect(sqlRows(store, "files")).toBeGreaterThan(0);
		expect(leakedIntoDefault(clone)).toEqual([]);

		// symbol: the CLI's own tracker helper (the duplicate getFileTracker).
		const symbol = await runCli(
			["symbol", "alphaValue", "--agent"],
			clone,
			env,
		);
		expect(symbol.code).toBe(0);
		expect(symbol.stdout).toContain("alphaValue");

		// search: the indexer's read path.
		const search = await runCli(
			["search", "alpha value", "--agent", "--no-reindex"],
			clone,
			env,
		);
		expect(search.code).toBe(0);
		expect(search.stdout).toContain("alpha.ts");

		// observe: one row, in the override.
		const observe = await runCli(
			["observe", "one resolver, one store", "--file", "alpha.ts", "--agent"],
			clone,
			env,
		);
		expect(observe.code).toBe(0);
		expect(observe.stdout).not.toContain("recorded=false");
		expect(await lanceRows(store, "documentType = 'session_observation'")).toBe(
			1,
		);

		// docs refresh, lock free: it finds the override's tracker and clears it.
		seedDocsRow(store, clone);
		expect(sqlRows(store, "indexed_docs")).toBe(1);
		const refresh = await runCli(["docs", "refresh"], clone, env);
		expect(refresh.code).toBe(0);
		expect(refresh.stdout).toContain("Documentation cache cleared");
		expect(sqlRows(store, "indexed_docs")).toBe(0);

		expect(leakedIntoDefault(clone)).toEqual([]);

		// Control: without the variable this project has no index at all, so
		// every read above was served by the override and nothing else.
		const unset = await runCli(["symbol", "alphaValue", "--agent"], clone);
		expect(unset.code).not.toBe(0);
		expect(`${unset.stdout}${unset.stderr}`).toContain("No index found");
	}, 180_000);
});

// ════════════════════════════════════════════════════════════════════════════
describe("while ANOTHER process holds the OVERRIDE's lock", () => {
	test("index is refused, observe degrades, docs refresh refuses non-zero, and the override store is unchanged", async () => {
		const { clone, store, env } = await indexedOverride();
		seedDocsRow(store, clone);
		const snapshot = async () => ({
			chunks: await lanceRows(store),
			observations: await lanceRows(
				store,
				"documentType = 'session_observation'",
			),
			files: sqlRows(store, "files"),
			docs: sqlRows(store, "indexed_docs"),
		});
		const before = await snapshot();
		expect(before.docs).toBe(1);

		// The holder resolves the lock in its own env, through the seam.
		const holder = await holdStoreLock(clone, env);
		try {
			expect(realpathSync(holder.lockPath)).toBe(join(store, ".indexing.lock"));
			const [index, observe, refresh] = await Promise.all([
				runCli(["index", "--no-llm", clone], clone, env),
				runCli(
					["observe", "blocked observation", "--file", "alpha.ts"],
					clone,
					env,
				),
				runCli(["docs", "refresh"], clone, env),
			]);

			// index: its lock is the override's, so it sees the holder.
			expect(index.code).not.toBe(0);
			expect(`${index.stdout}${index.stderr}`).toContain(`PID ${holder.pid}`);

			// observe: D5's degrade, on its own clock.
			expect(observe.code).toBe(0);
			expect(observe.stderr).toContain("Observation not recorded");
			expect(observe.elapsedMs).toBeLessThan(OBSERVE_CEILING_MS);

			// docs refresh: refused, loudly, after the normal wait.
			expect(refresh.code).not.toBe(0);
			expect(refresh.stderr).toContain("Refusing to refresh documentation");
			expect(refresh.stderr).toContain("Nothing was changed");
			expect(refresh.elapsedMs).toBeGreaterThanOrEqual(REFUSE_WAIT_MS);

			// Nothing changed, counted through this process's connections.
			expect(await snapshot()).toEqual(before);
			expect(JSON.parse(readFileSync(holder.lockPath, "utf8")).token).toBe(
				holder.token,
			);
		} finally {
			await holder.release();
		}

		// Not vacuous: with the lock free, the same command clears the row.
		const cleared = await runCli(["docs", "refresh"], clone, env);
		expect(cleared.code).toBe(0);
		expect(sqlRows(store, "indexed_docs")).toBe(0);
	}, 240_000);
});

// ════════════════════════════════════════════════════════════════════════════
describe("no override: the store is the repository's, and the lock is with it", () => {
	test("the data and its lock are both at <gitCommonDir>/mnemex", async () => {
		// RE-TARGETED IN 3c. With no override this falls to row 3, which is now
		// `<gitCommonDir>/mnemex` rather than `<clone>/.mnemex`. The property
		// being asserted is UNCHANGED and is the one that matters here (FR-2):
		// wherever the store is, the lock is in the same directory, so two
		// processes that agree about the data agree about the lock.
		//
		// `git clone` makes a main checkout, so its common dir is `<clone>/.git`
		// — spelled out, not resolved, like every other expectation in this file.
		const clone = freshClone();
		const run = await runCli(["index", "--no-llm", clone], clone);
		expect(run.code).toBe(0);
		const store = join(clone, ".git", "mnemex");
		expect(await lanceRows(store)).toBeGreaterThan(0);
		expect(sqlRows(store, "files")).toBeGreaterThan(0);
		// And nothing was left at the pre-3c location.
		expect(existsSync(join(clone, ".mnemex", "index.db"))).toBe(false);

		const holder = await holdStoreLock(clone);
		try {
			expect(realpathSync(holder.lockPath)).toBe(join(store, ".indexing.lock"));
			const blocked = await runCli(["index", "--no-llm", clone], clone);
			expect(blocked.code).not.toBe(0);
			expect(`${blocked.stdout}${blocked.stderr}`).toContain(
				`PID ${holder.pid}`,
			);
		} finally {
			await holder.release();
		}
	}, 120_000);
});

// ════════════════════════════════════════════════════════════════════════════
describe("hooks: the CLI prints where the hook really is", () => {
	test("install and status from a linked worktree name <main>/.git/hooks/post-commit", async () => {
		const main = freshClone();
		const worktree = join(sb.root, `worktree-${++counter}`);
		sb.git(main, "worktree", "add", "-q", worktree);
		const expectedHook = join(main, ".git", "hooks", "post-commit");

		const install = await runCli(["hooks", "install"], worktree);
		expect(install.code).toBe(0);
		expect(existsSync(expectedHook)).toBe(true);
		const printed = install.stdout.match(/Location: (\S+)/)?.[1];
		expect(printed).toBeDefined();
		expect(realpathSync(printed as string)).toBe(realpathSync(expectedHook));
		// The old hardcoded, relative line is gone.
		expect(install.stdout).not.toContain("Location: .git/hooks/post-commit");

		const status = await runCli(["hooks", "status"], worktree);
		expect(status.code).toBe(0);
		const reported = status.stdout.match(/Location: +(\S+)/)?.[1];
		expect(reported).toBeDefined();
		expect(realpathSync(reported as string)).toBe(realpathSync(expectedHook));
	}, 60_000);
});
