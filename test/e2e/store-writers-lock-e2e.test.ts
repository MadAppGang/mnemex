/**
 * V2.6 and V2.7 — the writers other than `mnemex index` (`observe`,
 * `docs clear`) hold the store lock, with decision D5's per-writer policy:
 *
 *   observe      waits 2 s for a held lock, then DEGRADES: exits 0, warns, and
 *                writes nothing;
 *   docs clear   waits the normal 30 s, then REFUSES loudly and exits non-zero,
 *                deleting nothing.
 *
 * And on a fresh clone with no store directory, `observe` and `docs clear`
 * work on first use instead of failing with ENOENT / `reason: "error"` (V2.6).
 *
 * Falsified by (V2.7): giving `observe` the 30 s refusal. It then returns
 * after 30 s, not about 2, and the timing assertion fires.
 *
 * THE LOCK IS HELD BY ANOTHER PROCESS (`store-lock-holder-child.ts`), and
 * every count is read through THIS process's own LanceDB and SQLite
 * connections. Nothing here trusts a child's report of what it did.
 *
 * Runs the SOURCE entry point (`bun --env-file=/dev/null src/index.ts`, CLAUDE.md
 * #23), so it does not depend on a build. Every child env comes from
 * `keychainSafeChildEnv()`, with HOME and the embed cache in a temp directory
 * and every inherited GIT_* variable dropped. Embeddings come from a local fake
 * Ollama server, pointed at through the child's temp HOME config.
 */

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

/** D5's observe wait. The observe run must take at least this long when blocked. */
const OBSERVE_WAIT_MS = 2_000;
/** D5's docs-clear wait. */
const CLEAR_WAIT_MS = 30_000;
/**
 * Upper bound for a blocked observe, INCLUDING process start-up under load.
 * Far below the 30 s refusal, so the falsifier cannot pass it.
 */
const OBSERVE_CEILING_MS = 15_000;

let sb: GitSandbox;
let origin: string;
let home: string;
let server: FakeEmbedServer;
let clones = 0;

beforeAll(() => {
	sb = createGitSandbox("store-writers-");
	origin = join(sb.root, "origin");
	mkdirSync(origin);
	sb.git(origin, "init", "-q");
	writeFileSync(join(origin, "alpha.ts"), "export const alpha = 1;\n");
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

/** A fresh clone: no store directory at all. */
function freshClone(): string {
	const dest = join(sb.root, `clone-${++clones}`);
	sb.git(sb.root, "clone", "-q", origin, dest);
	return dest;
}

/** The child env: the blessed guard, plus a sandbox, minus any inherited GIT_*. */
// No `= {}` default on `extra`: the keychain sweep recognises a guard-supplying
// helper by its body, and a `{` in the parameter list is read as that body.
function childEnv(extra?: Record<string, string>): Record<string, string> {
	const env = keychainSafeChildEnv({
		HOME: home,
		MNEMEX_EMBED_CACHE_PATH: join(sb.root, "embed-cache.db"),
		MNEMEX_GLOBAL_LOCK_PATH: join(sb.root, "global.lock"),
		MNEMEX_MODEL: MODEL,
		...extra,
	});
	for (const key of Object.keys(env)) {
		if (key.startsWith("GIT_")) delete env[key];
	}
	return env;
}

interface CliRun {
	code: number;
	stdout: string;
	stderr: string;
	elapsedMs: number;
}

async function runCli(args: string[], cwd: string): Promise<CliRun> {
	const started = Date.now();
	const proc = Bun.spawn(["bun", "--env-file=/dev/null", ENTRY, ...args], {
		cwd,
		env: childEnv(),
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
	token: string;
	lockPath: string;
	release(): Promise<void>;
}

/** Another PROCESS takes the store lock for `project` and keeps it. */
async function holdStoreLock(project: string): Promise<Holder> {
	const proc = Bun.spawn(["bun", HOLDER, project], {
		cwd: project,
		env: childEnv(),
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
	const [status, , token, lockPath] = text.trim().split(" ");
	if (status !== "HELD" || !token || !lockPath) {
		throw new Error(`holder did not take the lock: ${text}`);
	}
	return {
		token,
		lockPath,
		async release() {
			proc.stdin.end();
			await proc.exited;
		},
	};
}

/**
 * The STORE directory for a clone, SPELLED OUT rather than resolved.
 *
 * From Phase 3c the store is `<gitCommonDir>/mnemex`. `git clone` makes a main
 * checkout, whose `.git` is a DIRECTORY and whose common dir is therefore
 * `<clone>/.git` — so this is the exact path, computed by the test. Deliberately
 * NOT `resolveStoreLocation(clone).storeDir`: this file's whole point is to find
 * the writers' bytes in a directory the TEST decided on, never in one the code
 * under test chose (the co-location discipline `store-one-resolver.test.ts`
 * states).
 */
function storeOf(clone: string): string {
	return join(clone, ".git", "mnemex");
}

async function observationRows(project: string): Promise<number> {
	const vectors = join(storeOf(project), "vectors");
	if (!existsSync(vectors)) return 0;
	const db = await lancedb.connect(vectors);
	try {
		if (!(await db.tableNames()).includes("code_chunks")) return 0;
		const table = await db.openTable("code_chunks");
		const n = await table.countRows("documentType = 'session_observation'");
		table.close();
		return n;
	} finally {
		db.close();
	}
}

function docsRows(project: string): number {
	const db = new Database(join(storeOf(project), "index.db"), {
		readonly: true,
	});
	try {
		return (
			db.query("SELECT count(*) AS n FROM indexed_docs").get() as { n: number }
		).n;
	} finally {
		db.close();
	}
}

// ════════════════════════════════════════════════════════════════════════════
describe("V2.6 — a fresh clone with no store directory", () => {
	test("observe acquires on first use and records the row", async () => {
		const clone = freshClone();
		expect(existsSync(storeOf(clone))).toBe(false);

		// `--agent` so the output shape does not depend on how the CLI detects
		// an agent session in the environment it inherits.
		const run = await runCli(
			[
				"observe",
				"the store lock guards observations",
				"--file",
				"alpha.ts",
				"--agent",
			],
			clone,
		);

		expect(run.stderr).not.toContain("could not be taken");
		expect(run.code).toBe(0);
		expect(run.stdout).toContain("observation_id=");
		expect(run.stdout).not.toContain("recorded=false");
		expect(await observationRows(clone)).toBe(1);
	}, 60_000);

	test("docs clear with nothing indexed exits 0 instead of failing", async () => {
		const clone = freshClone();
		const run = await runCli(["docs", "clear"], clone);
		expect(run.code).toBe(0);
		expect(run.stdout).toContain("No index found");
	}, 60_000);
});

// ════════════════════════════════════════════════════════════════════════════
describe("V2.7 — while ANOTHER process holds the store lock", () => {
	test("observe returns in about 2 s, warns and writes nothing; docs clear refuses non-zero and deletes nothing", async () => {
		const clone = freshClone();

		// Baseline, lock free: one observation, one indexed library.
		const seed = await runCli(
			["observe", "baseline observation", "--file", "alpha.ts"],
			clone,
		);
		expect(seed.code).toBe(0);
		expect(await observationRows(clone)).toBe(1);
		const tracker = createFileTracker(join(storeOf(clone), "index.db"), clone);
		tracker.markDocsIndexed("left-pad", null, "llms_txt", "hash", ["c1"]);
		tracker.close();
		expect(docsRows(clone)).toBe(1);

		const holder = await holdStoreLock(clone);
		try {
			const [observe, clear] = await Promise.all([
				runCli(["observe", "blocked observation", "--file", "alpha.ts"], clone),
				runCli(["docs", "clear"], clone),
			]);

			// observe: degraded, on D5's clock, not the 30 s refusal's.
			expect(observe.code).toBe(0);
			expect(observe.stderr).toContain("Observation not recorded");
			expect(observe.stderr).toContain(`PID `);
			expect(observe.elapsedMs).toBeGreaterThanOrEqual(OBSERVE_WAIT_MS);
			expect(observe.elapsedMs).toBeLessThan(OBSERVE_CEILING_MS);
			expect(await observationRows(clone)).toBe(1);

			// docs clear: refused, loudly, after the normal wait.
			expect(clear.code).not.toBe(0);
			expect(clear.stderr).toContain("Refusing to clear documentation");
			expect(clear.elapsedMs).toBeGreaterThanOrEqual(CLEAR_WAIT_MS);
			expect(docsRows(clone)).toBe(1);

			// Neither writer stole or disturbed the holder's lock.
			expect(JSON.parse(readFileSync(holder.lockPath, "utf8")).token).toBe(
				holder.token,
			);
		} finally {
			await holder.release();
		}

		// The refusal was not vacuous: with the lock free, the same command
		// does delete, and the same observe does record.
		const cleared = await runCli(["docs", "clear"], clone);
		expect(cleared.code).toBe(0);
		expect(docsRows(clone)).toBe(0);
		const recorded = await runCli(
			["observe", "unblocked observation", "--file", "alpha.ts"],
			clone,
		);
		expect(recorded.code).toBe(0);
		expect(await observationRows(clone)).toBe(2);
	}, 180_000);
});
