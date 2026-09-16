/**
 * Fixtures and child launchers for the index-version-4 process tests: the
 * ghost-chunk regression (architecture §4.2), V3.15, V3.20, V4.* and V1.6.
 *
 * EVERY child launched here gets:
 *
 *   - `keychainSafeChildEnv()` (CLAUDE.md #24);
 *   - HOME, MNEMEX_TEST_SANDBOX_HOME, MNEMEX_EMBED_CACHE_PATH and
 *     MNEMEX_GLOBAL_LOCK_PATH inside the test's own scratch directory (#25, #31);
 *   - docs off;
 *   - no inherited `GIT_*`. A suite can run from a git hook, and the hook's
 *     GIT_DIR would point every child at the developer's own repository.
 *
 * Every launcher builds its env AT ITS OWN SPAWN SITE, as `sandboxEnv(...)`.
 * The keychain sweep (`keychain.test.ts`, "a test that spawns an ENTRY POINT
 * must set the guard variables itself") checks the spawn call itself, and an env
 * passed in from a caller would be a claim it cannot verify.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import { keychainSafeChildEnv } from "./child-env.js";

const REPO_ROOT = join(import.meta.dir, "..", "..");
export const INDEX_CHILD = join(
	REPO_ROOT,
	"test",
	"helpers",
	"v4-index-child.ts",
);
export const RACE_CHILD = join(
	REPO_ROOT,
	"test",
	"helpers",
	"registry-race-child.ts",
);
/** V3.8's N-runs-with-an-injected-clock child (§4.3). */
export const LIFECYCLE_CHILD = join(
	REPO_ROOT,
	"test",
	"helpers",
	"branch-lifecycle-child.ts",
);
/** V3.19's force-scope child (§4.5 / D3). */
export const FORCE_SCOPE_CHILD = join(
	REPO_ROOT,
	"test",
	"helpers",
	"force-scope-child.ts",
);
export const DIST_ENTRY = join(REPO_ROOT, "dist", "index.js");

/** Project config that keeps a run in BM25 mode: no network, no keychain. */
export const BM25_ONLY = { vector: false, enrichment: false } as const;

/** The zero-row delete warning the indexer prints to stderr (indexer.ts). */
export const ZERO_ROW_DELETE_WARNING = "removed 0 of its";

/** The child's HOME under `scratch`, where a test may write ~/.mnemex/config.json. */
export function sandboxHome(scratch: string): string {
	return join(scratch, "home");
}

/**
 * The child environment. `extra` has no `= {}` default ON PURPOSE: the keychain
 * sweep recognises a guard-supplying function by its body being the first brace
 * after its name, and a default object literal would come first.
 */
export function sandboxEnv(
	scratch: string,
	extra?: Record<string, string>,
): Record<string, string> {
	const home = sandboxHome(scratch);
	mkdirSync(home, { recursive: true });
	const env = keychainSafeChildEnv({
		HOME: home,
		MNEMEX_TEST_SANDBOX_HOME: home,
		MNEMEX_EMBED_CACHE_PATH: join(scratch, "embed-cache.db"),
		MNEMEX_GLOBAL_LOCK_PATH: join(scratch, "global-indexing.lock"),
		MNEMEX_DOCS_ENABLED: "0",
		...extra,
	});
	for (const key of Object.keys(env)) {
		if (key.startsWith("GIT_")) delete env[key];
	}
	// A store override only when the test asks for one.
	if (extra?.MNEMEX_INDEX_DIR === undefined) delete env.MNEMEX_INDEX_DIR;
	return env;
}

export interface ChildRun {
	exitCode: number | null;
	signalCode: string | null;
	stdout: string;
	stderr: string;
	/** The child's `RESULT <json>` line, parsed; null when it printed none. */
	result: Record<string, unknown> | null;
}

export type Child = ReturnType<typeof Bun.spawn>;

export function spawnIndexChild(
	mode: "index" | "rebuild-memo",
	projectDir: string,
	scratch: string,
	cwd: string,
	extra?: Record<string, string>,
): Child {
	return Bun.spawn(
		[process.execPath, "--env-file=/dev/null", INDEX_CHILD, mode, projectDir],
		{
			cwd,
			env: sandboxEnv(scratch, extra),
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
}

export async function collect(proc: Child): Promise<ChildRun> {
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout as ReadableStream).text(),
		new Response(proc.stderr as ReadableStream).text(),
	]);
	const exitCode = await proc.exited;
	const line = stdout.split("\n").find((l) => l.startsWith("RESULT "));
	return {
		exitCode,
		signalCode: proc.signalCode ?? null,
		stdout,
		stderr,
		result: line ? JSON.parse(line.slice("RESULT ".length)) : null,
	};
}

export function runIndexChild(
	mode: "index" | "rebuild-memo",
	projectDir: string,
	scratch: string,
	cwd: string,
	extra?: Record<string, string>,
): Promise<ChildRun> {
	return collect(spawnIndexChild(mode, projectDir, scratch, cwd, extra));
}

/** The BUILT entry point, as a user runs it. Needs `bun run build` first. */
export function runCli(
	args: string[],
	scratch: string,
	cwd: string,
	extra?: Record<string, string>,
): Promise<ChildRun> {
	return collect(
		Bun.spawn([process.execPath, "--env-file=/dev/null", DIST_ENTRY, ...args], {
			cwd,
			env: sandboxEnv(scratch, extra),
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		}),
	);
}

/**
 * V3.8: `runs` real index runs in ONE child, with the registry's clock moved
 * forward by `clockOffsetMs`. See `branch-lifecycle-child.ts` for why the clock
 * is injected inside the child rather than passed through the environment.
 */
export function runLifecycleChild(
	projectDir: string,
	runs: number,
	clockOffsetMs: number,
	scratch: string,
	extra?: Record<string, string>,
): Promise<ChildRun> {
	return collect(
		Bun.spawn(
			[
				process.execPath,
				"--env-file=/dev/null",
				LIFECYCLE_CHILD,
				projectDir,
				String(runs),
				String(clockOffsetMs),
			],
			{
				cwd: projectDir,
				env: sandboxEnv(scratch, extra),
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			},
		),
	);
}

/**
 * V3.19: one real `index(force, forceAll)` in a child, or the corruption
 * repair's signal (§4.5 / D3). See `force-scope-child.ts` for why the
 * corruption case produces the SIGNAL rather than a `FixedSizeList[0]` fixture.
 */
export function runForceScopeChild(
	mode: "force" | "force-all" | "corrupt",
	projectDir: string,
	scratch: string,
	extra?: Record<string, string>,
): Promise<ChildRun> {
	return collect(
		Bun.spawn(
			[
				process.execPath,
				"--env-file=/dev/null",
				FORCE_SCOPE_CHILD,
				mode,
				projectDir,
			],
			{
				cwd: projectDir,
				env: sandboxEnv(scratch, extra),
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			},
		),
	);
}

/** V3.15's contender: `test/helpers/registry-race-child.ts`. */
export function spawnRaceChild(
	projectDir: string,
	prefix: string,
	iterations: number,
	scratch: string,
): Child {
	return Bun.spawn(
		[
			process.execPath,
			"--env-file=/dev/null",
			RACE_CHILD,
			projectDir,
			prefix,
			String(iterations),
		],
		{
			cwd: projectDir,
			env: sandboxEnv(scratch),
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
}

/** A TypeScript file of `functions` small exported functions, unique per path. */
export function writeSource(
	root: string,
	relPath: string,
	functions = 3,
	token = "",
): void {
	const full = join(root, relPath);
	mkdirSync(dirname(full), { recursive: true });
	const stem = relPath.replace(/[^A-Za-z0-9]/g, "_");
	const parts: string[] = [];
	for (let i = 0; i < functions; i++) {
		parts.push(
			`/** ${stem} ${i} ${token} */\n` +
				`export function ${stem}_${i}(n: number): number {\n` +
				`\treturn n * ${i + 1} + ${stem.length};\n}\n`,
		);
	}
	writeFileSync(full, parts.join("\n"));
}

/** The store's rows, through a LanceDB connection the indexer never touched. */
export async function storeRows(
	vectorsDir: string,
): Promise<Array<Record<string, unknown>>> {
	const db = await lancedb.connect(vectorsDir);
	if (!(await db.tableNames()).includes("code_chunks")) return [];
	const table = await db.openTable("code_chunks");
	return (await table.query().toArray()) as Array<Record<string, unknown>>;
}

/** Every `result file=<path>` of `search --agent` output. */
export function agentResultPaths(stdout: string): string[] {
	return stdout
		.split("\n")
		.filter((line) => line.startsWith("result file="))
		.map((line) => line.slice("result file=".length).split(" line=")[0]);
}
