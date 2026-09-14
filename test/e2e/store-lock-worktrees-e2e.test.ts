/**
 * V2.1, V2.2, V2.3 — two `mnemex index` runs from two DIFFERENT worktrees of one
 * repository, pointed at ONE store. Exactly one may proceed.
 *
 * Both worktrees carry `mnemex.json` `{ indexDir: <shared store> }`. That
 * override is honoured by today's data paths (`getIndexDir`) AND by the seam
 * (row 2), so the data and the lock agree without flipping the store scope.
 * Each child gets its OWN `MNEMEX_GLOBAL_LOCK_PATH`, so the machine-global
 * quota lock cannot exclude them and hide a broken store lock (architecture
 * §7, "V2.1's falsifier had to change").
 *
 * Falsified by: restoring the per-worktree lock path
 * (`join(projectPath, ".mnemex", …)`). Both children then take a lock, both
 * reach their embedding phase, and "exactly one" goes red.
 *
 * THE EVIDENCE IS GATHERED OUTSIDE THE CHILDREN (CLAUDE.md #24, #25):
 *  - each child has its own fake embedding server, and a request there means
 *    that child got past the store lock (the lock is taken before the
 *    embeddings client exists). Each server is a barrier, so the winner parks in
 *    its embedding phase and the overlap is certain rather than a race against
 *    start-up;
 *  - this process polls the lock file for every pid and token it carries;
 *  - row counts and dataset versions are read through this process's own
 *    LanceDB and SQLite connections, never from a child's report.
 *
 * Runs the SOURCE entry point (`bun --env-file=/dev/null src/index.ts`, the
 * form CLAUDE.md #23 gives for dev runs), so it does not depend on a build.
 * Every child env comes from `keychainSafeChildEnv()`, with HOME and the embed
 * cache in a temp directory and every inherited GIT_* variable dropped.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import { keychainSafeChildEnv } from "../helpers/child-env.js";
import {
	type FakeEmbedServer,
	startFakeOllamaEmbedServer,
} from "../helpers/fake-ollama-embed-server.js";
import { createGitSandbox, type GitSandbox } from "../helpers/git-sandbox.js";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const ENTRY = join(REPO_ROOT, "src", "index.ts");
const LOCK_FILE = ".indexing.lock";
const MODEL = "ollama/fake-embed";
const OBSERVE_DEADLINE_MS = 90_000;
const TEST_TIMEOUT_MS = 180_000;

// ── fixture ────────────────────────────────────────────────────────────────

interface Fixture {
	sb: GitSandbox;
	main: string;
	linked: string;
	store: string;
	scratch: string;
}

function makeFixture(): Fixture {
	const sb = createGitSandbox("store-lock-wt-");
	const main = join(sb.root, "main");
	mkdirSync(main);
	sb.git(main, "init", "-q");
	writeFileSync(
		join(main, "alpha.ts"),
		"export function alpha(n: number): number {\n\treturn n + 1;\n}\n",
	);
	writeFileSync(
		join(main, "beta.ts"),
		"export function beta(s: string): string {\n\treturn s.toUpperCase();\n}\n",
	);
	sb.git(main, "add", "-A");
	sb.git(main, "commit", "-q", "-m", "init");
	const linked = join(sb.root, "linked");
	sb.git(main, "worktree", "add", "-q", "-b", "feature", linked);

	const store = join(sb.root, "shared-store");
	for (const worktree of [main, linked]) {
		writeFileSync(
			join(worktree, "mnemex.json"),
			JSON.stringify({ indexDir: store }),
		);
	}
	const scratch = join(sb.root, "scratch");
	mkdirSync(scratch);
	return { sb, main, linked, store, scratch };
}

/** The child env: the blessed guard, plus a sandbox, minus any inherited GIT_*. */
function childEnv(extra: Record<string, string>): Record<string, string> {
	const env = keychainSafeChildEnv(extra);
	for (const key of Object.keys(env)) {
		if (key.startsWith("GIT_")) delete env[key];
	}
	return env;
}

interface IndexChild {
	label: string;
	proc: ReturnType<typeof Bun.spawn>;
	server: FakeEmbedServer;
	stderr: Promise<string>;
	stdout: Promise<string>;
}

function spawnIndex(fx: Fixture, label: string, worktree: string): IndexChild {
	const server = startFakeOllamaEmbedServer({ hold: true });
	const home = join(fx.scratch, `home-${label}`);
	mkdirSync(join(home, ".mnemex"), { recursive: true });
	writeFileSync(
		join(home, ".mnemex", "config.json"),
		JSON.stringify({
			embeddingProvider: "ollama",
			ollamaEndpoint: server.url,
			defaultModel: MODEL,
		}),
	);
	const proc = Bun.spawn(
		["bun", "--env-file=/dev/null", ENTRY, "index", "--no-llm", worktree],
		{
			cwd: worktree,
			env: childEnv({
				HOME: home,
				MNEMEX_EMBED_CACHE_PATH: join(fx.scratch, `embed-cache-${label}.db`),
				MNEMEX_GLOBAL_LOCK_PATH: join(fx.scratch, `global-${label}.lock`),
				MNEMEX_MODEL: MODEL,
				MNEMEX_DOCS_ENABLED: "false",
			}),
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	return {
		label,
		proc,
		server,
		stdout: new Response(proc.stdout as ReadableStream).text(),
		stderr: new Response(proc.stderr as ReadableStream).text(),
	};
}

// ── observation from outside ───────────────────────────────────────────────

interface LockWatch {
	pids: Set<number>;
	tokens: Set<string>;
	sample(): void;
}

function watchLock(lockPath: string): LockWatch {
	const pids = new Set<number>();
	const tokens = new Set<string>();
	return {
		pids,
		tokens,
		sample() {
			try {
				const record = JSON.parse(readFileSync(lockPath, "utf8"));
				if (typeof record.pid === "number") pids.add(record.pid);
				if (typeof record.token === "string") tokens.add(record.token);
			} catch {
				// absent, or read mid-write
			}
		},
	};
}

async function waitFor(
	condition: () => boolean,
	sample: () => void,
	what: string,
): Promise<void> {
	const deadline = Date.now() + OBSERVE_DEADLINE_MS;
	while (!condition()) {
		sample();
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(20);
	}
	sample();
}

/**
 * Everything a writer could change in the store, read through THIS process's
 * own connections. The lock file (and its transient siblings) is excluded,
 * because the holder's heartbeat rewrites it every second by design, and so is
 * `-shm`, which a reader may touch.
 */
async function storeSnapshot(store: string): Promise<string> {
	const files: string[] = [];
	if (existsSync(store)) {
		for (const rel of readdirSync(store, { recursive: true }) as string[]) {
			if (rel.includes(LOCK_FILE) || rel.endsWith("-shm")) continue;
			const st = statSync(join(store, rel));
			if (st.isFile()) files.push(`${rel} ${st.size} ${st.mtimeMs}`);
		}
	}
	files.sort();

	const lance: string[] = [];
	const vectors = join(store, "vectors");
	if (existsSync(vectors)) {
		const db = await lancedb.connect(vectors);
		for (const name of await db.tableNames()) {
			const table = await db.openTable(name);
			lance.push(
				`${name} v${await table.version()} rows=${await table.countRows()}`,
			);
			table.close();
		}
		db.close();
	}

	const sqlite: string[] = [];
	const dbPath = join(store, "index.db");
	if (existsSync(dbPath)) {
		const db = new Database(dbPath, { readonly: true });
		try {
			const tables = db
				.query("SELECT name FROM sqlite_master WHERE type = 'table'")
				.all() as Array<{ name: string }>;
			for (const { name } of tables) {
				const row = db
					.query(`SELECT count(*) AS n FROM "${name.replaceAll('"', '""')}"`)
					.get() as { n: number };
				sqlite.push(`${name}=${row.n}`);
			}
		} finally {
			db.close();
		}
	}
	return JSON.stringify({ files, lance, sqlite }, null, 1);
}

async function codeRows(store: string): Promise<number> {
	const db = await lancedb.connect(join(store, "vectors"));
	try {
		const table = await db.openTable("code_chunks");
		const rows = await table.countRows();
		table.close();
		return rows;
	} finally {
		db.close();
	}
}

// ── cleanup ────────────────────────────────────────────────────────────────

const live: IndexChild[] = [];
const fixtures: Fixture[] = [];
afterEach(async () => {
	for (const child of live.splice(0)) {
		child.server.release();
		if (child.proc.exitCode === null) child.proc.kill();
		await child.proc.exited;
		child.server.stop();
	}
	for (const fx of fixtures.splice(0)) fx.sb.cleanup();
});

const exited = (child: IndexChild) => child.proc.exitCode !== null;

// ════════════════════════════════════════════════════════════════════════════
describe("two worktrees, one store", () => {
	test(
		"V2.1 + V2.3: started together, exactly one reaches its embedding phase; the lock file is the store's",
		async () => {
			const fx = makeFixture();
			fixtures.push(fx);
			const lockPath = join(fx.store, LOCK_FILE);
			const watch = watchLock(lockPath);

			const a = spawnIndex(fx, "main", fx.main);
			const b = spawnIndex(fx, "linked", fx.linked);
			live.push(a, b);

			// Run until the race is decided one way or the other: one child exited
			// while the other parked at its barrier, both parked (two holders), or
			// both exited.
			await waitFor(
				() =>
					(exited(a) && b.server.embedRequests() > 0) ||
					(exited(b) && a.server.embedRequests() > 0) ||
					(a.server.requests() > 0 && b.server.requests() > 0) ||
					(exited(a) && exited(b)),
				watch.sample,
				"the race to be decided",
			);

			const reached = [a, b].filter((c) => c.server.requests() > 0);
			expect(
				reached.map((c) => c.label),
				"children that got past the store lock",
			).toHaveLength(1);
			const winner = reached[0] as IndexChild;
			const loser = winner === a ? b : a;

			// V2.3, on disk, while the winner holds: the one lock file is the
			// STORE's, not either worktree's.
			expect(existsSync(lockPath)).toBe(true);
			expect(existsSync(join(fx.main, ".mnemex", LOCK_FILE))).toBe(false);
			expect(existsSync(join(fx.linked, ".mnemex", LOCK_FILE))).toBe(false);

			// The loser was refused and said who holds it.
			expect(await loser.proc.exited).toBe(1);
			const loserErr = await loser.stderr;
			expect(loserErr).toContain("is currently indexing");
			expect(loserErr).toContain(`PID ${winner.proc.pid}`);
			expect(loser.server.requests()).toBe(0);

			// The lock file only ever named the winner.
			expect([...watch.pids]).toEqual([winner.proc.pid]);
			expect(watch.tokens.size).toBe(1);

			// And the winner, released, really does write: "exactly one reached the
			// write phase" is not satisfied by nobody writing.
			winner.server.release();
			expect(await winner.proc.exited).toBe(0);
			expect(await codeRows(fx.store)).toBeGreaterThan(0);
			expect(existsSync(lockPath)).toBe(false);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"V2.2: the excluded run reports already_running and changes nothing in the store",
		async () => {
			const fx = makeFixture();
			fixtures.push(fx);
			const lockPath = join(fx.store, LOCK_FILE);
			const watch = watchLock(lockPath);

			// A takes the lock and parks in its embedding phase: from here on it
			// changes nothing, so any change to the store is B's.
			const a = spawnIndex(fx, "main", fx.main);
			live.push(a);
			await waitFor(
				() => a.server.embedRequests() > 0 || exited(a),
				watch.sample,
				"main to park in its embedding phase",
			);
			expect(exited(a)).toBe(false);
			expect([...watch.pids]).toEqual([a.proc.pid]);

			await storeSnapshot(fx.store); // warm this process's own readers
			const before = await storeSnapshot(fx.store);

			const b = spawnIndex(fx, "linked", fx.linked);
			live.push(b);
			await waitFor(
				() => exited(b) || b.server.requests() > 0,
				watch.sample,
				"linked to be refused",
			);

			expect(b.server.requests(), "linked got past the store lock").toBe(0);
			expect(await b.proc.exited).toBe(1);
			const bErr = await b.stderr;
			// IndexLockError's already_running wording, naming the holder.
			expect(bErr).toContain("is currently indexing");
			expect(bErr).toContain(`PID ${a.proc.pid}`);

			// Row counts, dataset versions and every file in the store: unchanged.
			expect(await storeSnapshot(fx.store)).toBe(before);
			expect([...watch.pids]).toEqual([a.proc.pid]);

			a.server.release();
			expect(await a.proc.exited).toBe(0);
			expect(await codeRows(fx.store)).toBeGreaterThan(0);
		},
		TEST_TIMEOUT_MS,
	);
});
