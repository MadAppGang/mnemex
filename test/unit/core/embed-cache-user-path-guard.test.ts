/**
 * The embedding cache must never write the REAL user's `~/.mnemex/embed-cache.db`
 * from a test — and the proof is the BYTES AT THAT PATH, never a report object.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT THIS CLOSES
 *
 * The cache is machine-global (CLAUDE.md #31): one SQLite file at
 * `~/.mnemex/embed-cache.db`, shared by every repo, clone and worktree on the
 * machine. `Indexer.index()` opens it before either lock, with no path argument.
 * So the day that default landed, EVERY test that reaches `index()` became a
 * writer of a real user file.
 *
 * It happened immediately. The Phase 8 measurement run found a 36,864-byte
 * `~/.mnemex/embed-cache.db` on the maintainer's machine, mtime that day, created
 * by the committed test suite through
 * `test/unit/core/probes/indexer-model-mismatch.probe.ts` — a probe written
 * BEFORE this feature, which set `MNEMEX_GLOBAL_LOCK_PATH` and
 * `MNEMEX_DOCS_ENABLED` precisely because it knew about the other machine-global
 * resources. Nothing about it was wrong. The default moved underneath it.
 *
 * That is the class CLAUDE.md #25 already records for `~/.mnemex/config.json`
 * ("a review probe that reassigned HOME at runtime wrote to a real user's config
 * file"), and `test/helpers/sandbox-guard.ts` exists because of that incident.
 *
 * ---------------------------------------------------------------------------
 * WHY A GUARD AND NOT A ONE-LINE FIX IN THE PROBE
 *
 * A per-file fix leaves the next test free to do the same thing, and the next
 * test will be written by someone who does not know the default is a user path.
 * So this follows CLAUDE.md #24's shape for the keychain: DENY BY DEFAULT in
 * `src/core/embed-cache.ts` (needs no environment, no preload and no cwd), the
 * production entry point opts in (`src/index.ts`), and a child that runs that
 * entry point is vetoed by a sentinel it inherits.
 *
 * It REFUSES rather than redirecting. A test that meant to point
 * `MNEMEX_EMBED_CACHE_PATH` at a temp file and forgot is a bug worth surfacing;
 * a silent redirect would hide it and a silent disable would make the suite stop
 * testing the thing it thinks it tests.
 *
 * ---------------------------------------------------------------------------
 * WHY THE EVIDENCE IS BYTES
 *
 * CLAUDE.md #25: "assert on the bytes on disk … never on `report.outcomes` or
 * `stub.calls`. Every occurrence of this bug class has been invisible to the
 * report." A refusal object cannot show a file that was written, and a spawn that
 * refused and a spawn that wrote are indistinguishable from the outside.
 *
 * And a guard that cannot be shown to fail is not a guard, so the last describe
 * block runs the SAME child against a BUNDLE of the same module with the throw
 * cut out, over a decoy home, and asserts the fingerprint DID change. That is the
 * red half, committed, and it never touches the user's file — the technique
 * CLAUDE.md #24 records for falsifying a no-spawn assertion without spawning.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
	disableUserEmbedCachePathForTests,
	openEmbedCache,
	USER_PATH_REFUSAL_PREFIX,
	userEmbedCachePathEnabled,
	userEmbedCachePathRefusal,
} from "../../../src/core/embed-cache.js";
import { keychainSafeChildEnv } from "../../helpers/child-env.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CHILD = join(REPO, "test", "helpers", "embed-cache-user-path-child.ts");
const PROBE = join(
	REPO,
	"test",
	"unit",
	"core",
	"probes",
	"indexer-model-mismatch.probe.ts",
);

/** The real user file, and both sidecars SQLite creates beside it. */
const USER_CACHE = join(homedir(), ".mnemex", "embed-cache.db");
const USER_CACHE_FILES = [USER_CACHE, `${USER_CACHE}-wal`, `${USER_CACHE}-shm`];

// ── The evidence: bytes, not reports ────────────────────────────────────────

interface FileFingerprint {
	path: string;
	exists: boolean;
	size: number | null;
	mtimeMs: number | null;
	sha256: string | null;
}

/**
 * Existence, size, mtime AND content hash.
 *
 * All four, because each alone has a hole: a rewrite can preserve size, a
 * same-second write can preserve a coarse mtime, and a file that did not exist
 * has neither. The observed defect was a CREATION, which `exists` catches
 * outright; the others cover a modification of an already-present file.
 */
function fingerprint(path: string): FileFingerprint {
	if (!existsSync(path)) {
		return { path, exists: false, size: null, mtimeMs: null, sha256: null };
	}
	const stat = statSync(path);
	return {
		path,
		exists: true,
		size: stat.size,
		mtimeMs: stat.mtimeMs,
		sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
	};
}

function fingerprintAll(paths: readonly string[]): FileFingerprint[] {
	return paths.map(fingerprint);
}

/** Every file in a directory, so a sidecar appearing counts as a change. */
function fingerprintDir(dir: string): FileFingerprint[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.sort()
		.map((name) => fingerprint(join(dir, name)));
}

interface ChildResult {
	module: string;
	cwd: string;
	home: string | null;
	homedir: string;
	pathEnv: string | null;
	disableEnv: string | null;
	guardEnv: string | null;
	path: string;
	refused: boolean;
	message: string | null;
	opened: boolean;
	exists: boolean;
	size: number | null;
}

/**
 * Run the adversary child.
 *
 * `MNEMEX_EMBED_CACHE_TEST_GUARD` is stripped from every one of these children,
 * so the guard cannot be said to have been an inherited environment variable
 * doing the work — the child reports `guardEnv` and every caller below asserts it
 * was `null`. Safe to strip because this child is not an entry point: it never
 * calls `enableUserEmbedCachePath()`, which is the only thing the sentinel vetoes.
 */
async function runChild(options: {
	module?: string;
	cwd?: string;
	home?: string;
}): Promise<ChildResult> {
	const env = keychainSafeChildEnv(
		options.home === undefined ? {} : { HOME: options.home },
	);
	// The child must really target the default path: no redirect, no opt-out,
	// and nothing inherited that could be mistaken for the guard.
	delete env.MNEMEX_EMBED_CACHE_PATH;
	delete env.MNEMEX_DISABLE_EMBED_CACHE;
	delete env.MNEMEX_EMBED_CACHE_TEST_GUARD;

	const args = ["run", CHILD];
	if (options.module !== undefined) args.push(options.module);
	const proc = Bun.spawn(["bun", ...args], {
		cwd: options.cwd ?? REPO,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	const line = stdout.split("\n").find((l) => l.startsWith("__RESULT__"));
	if (line === undefined) {
		throw new Error(`child printed no result:\n${stdout}\n${stderr}`);
	}
	return JSON.parse(line.slice("__RESULT__".length)) as ChildResult;
}

// ════════════════════════════════════════════════════════════════════════════

describe("the predicate", () => {
	// A pure function of (target, homeDir, enabled), separate from the gate it
	// guards, for the reason `sandbox-guard.ts` gives: it can be tested against
	// arbitrary paths WITHOUT a process that actually writes one of them.

	const HOME = "/Users/somebody";
	const DEFAULT = join(HOME, ".mnemex", "embed-cache.db");

	test("refuses the default user path when the gate is closed", () => {
		const refusal = userEmbedCachePathRefusal(DEFAULT, HOME, false);
		expect(refusal).toContain(USER_PATH_REFUSAL_PREFIX);
		// It has to say which file, and how to get out of it — a refusal nobody
		// can act on gets deleted by the next person who hits it.
		expect(refusal).toContain(DEFAULT);
		expect(refusal).toContain("MNEMEX_EMBED_CACHE_PATH");
	});

	test("refuses ANY path under ~/.mnemex, not just the default name", () => {
		// The rule is about the path, not about how it was derived. An explicit
		// redirect that points back into the user's directory redirects nowhere.
		expect(
			userEmbedCachePathRefusal(join(HOME, ".mnemex", "other.db"), HOME, false),
		).toContain(USER_PATH_REFUSAL_PREFIX);
		expect(
			userEmbedCachePathRefusal(
				join(HOME, ".mnemex", "nested", "x.db"),
				HOME,
				false,
			),
		).toContain(USER_PATH_REFUSAL_PREFIX);
	});

	test("sees through `..` back into the user directory", () => {
		const sneaky = join(HOME, "elsewhere", "..", ".mnemex", "embed-cache.db");
		expect(userEmbedCachePathRefusal(sneaky, HOME, false)).toContain(
			USER_PATH_REFUSAL_PREFIX,
		);
	});

	test("allows a temp path — the opt-in every test should use", () => {
		expect(
			userEmbedCachePathRefusal(
				join(tmpdir(), "whatever", "embed-cache.db"),
				HOME,
				false,
			),
		).toBeNull();
	});

	test("allows a sibling directory whose name merely starts with .mnemex", () => {
		// `startsWith` on a raw string would match `~/.mnemex-backup`.
		expect(
			userEmbedCachePathRefusal(
				join(HOME, ".mnemex-backup", "embed-cache.db"),
				HOME,
				false,
			),
		).toBeNull();
	});

	test("allows the user path once the entry point has opened the gate", () => {
		expect(userEmbedCachePathRefusal(DEFAULT, HOME, true)).toBeNull();
	});

	test("the gate is CLOSED in this test process", () => {
		// The whole suite depends on this: nothing under `src/**` except
		// `src/index.ts` opens it, and `bun test` does not run `src/index.ts`.
		expect(userEmbedCachePathEnabled()).toBe(false);
	});
});

describe("in-process: openEmbedCache refuses the user path", () => {
	test("an explicit path at the user file throws, and writes nothing", () => {
		disableUserEmbedCachePathForTests();
		const before = fingerprintAll(USER_CACHE_FILES);

		expect(() => openEmbedCache(USER_CACHE)).toThrow(
			/refusing to open the user cache/,
		);

		expect(fingerprintAll(USER_CACHE_FILES)).toEqual(before);
	});
});

describe("a fresh process cannot create the user's cache", () => {
	// The bytes-on-disk test. Non-vacuous by construction: the child computes and
	// reports the path it was about to open, and the assertions below check that
	// it really was the user's own file.

	test("no preload, no sentinel, no redirect — it refuses and the bytes do not move", async () => {
		const before = fingerprintAll(USER_CACHE_FILES);

		const result = await runChild({});

		// The preconditions really were absent — otherwise this passes for the
		// wrong reason.
		expect(result.pathEnv).toBeNull();
		expect(result.disableEnv).toBeNull();
		expect(result.guardEnv).toBeNull();
		// And it really was aiming at the user's file.
		expect(result.path).toBe(USER_CACHE);
		expect(result.homedir).toBe(homedir());

		expect(result.refused).toBe(true);
		expect(result.opened).toBe(false);
		expect(result.message).toContain(USER_PATH_REFUSAL_PREFIX);

		expect(fingerprintAll(USER_CACHE_FILES)).toEqual(before);
	}, 60_000);

	test("…and from a subdirectory, where bunfig.toml is never read", async () => {
		// CLAUDE.md #24: `bun` resolves `bunfig.toml` against the CURRENT WORKING
		// DIRECTORY and does not walk up. A preload cannot be the guard; this is
		// the case that proved it for the keychain, run again for the cache.
		const before = fingerprintAll(USER_CACHE_FILES);

		const result = await runChild({ cwd: join(REPO, "test") });

		expect(result.cwd).toBe(join(REPO, "test"));
		expect(result.guardEnv).toBeNull();
		expect(result.refused).toBe(true);
		expect(fingerprintAll(USER_CACHE_FILES)).toEqual(before);
	}, 60_000);
});

describe("a child that IS the entry point", () => {
	// The ONE case deny-by-default cannot cover, and the one external review found
	// for the keychain (CLAUDE.md #24, first bypass): `src/index.ts` opens the gate
	// itself, so a test that spawns it would otherwise write the user's cache with
	// the gate wide open. The sentinel in `keychainSafeChildEnv()` is the veto.

	test("the sentinel makes its own opt-in a no-op, and `index` refuses", async () => {
		const dir = mkdtempSync(join(tmpdir(), "mnemex-entrypoint-cache-"));
		try {
			const home = join(dir, "home");
			const project = join(dir, "project");
			mkdirSync(home);
			mkdirSync(project);
			const before = fingerprintAll(USER_CACHE_FILES);

			// HOME is sandboxed IN THE CHILD'S ENV — Bun's `homedir()` ignores a
			// runtime reassignment (`test/helpers/sandbox-guard.ts`). So the real
			// user's cache is not even the target here: this test is about the gate,
			// and the fingerprints below are the belt.
			const env = keychainSafeChildEnv({
				HOME: home,
				MNEMEX_GLOBAL_LOCK_PATH: join(dir, "global.lock"),
				MNEMEX_DOCS_ENABLED: "false",
				// `handleIndex` refuses without a key before it ever calls `index()`,
				// and a sandboxed HOME has no config. This one is never used: the
				// cache is opened before anything is embedded, which is exactly why
				// the refusal below arrives first.
				OPENROUTER_API_KEY: "not-a-real-key",
			});
			delete env.MNEMEX_EMBED_CACHE_PATH;
			delete env.MNEMEX_DISABLE_EMBED_CACHE;
			// Both sentinels are kept HERE, and asserted rather than assumed: this
			// child runs the real composition root, which opens both gates itself.
			// (The keychain sweep in `keychain.test.ts` also requires an entry-point
			// spawn to supply its guard at the call site, and reads this assertion.)
			expect(env.MNEMEX_KEYCHAIN_TEST_GUARD).toBe("1");
			expect(env.MNEMEX_DISABLE_KEYCHAIN).toBe("1");
			expect(env.MNEMEX_EMBED_CACHE_TEST_GUARD).toBe("1");

			const proc = Bun.spawn(
				["bun", join(REPO, "src", "index.ts"), "index", "--no-llm"],
				{
					cwd: project,
					env,
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			const output = `${stdout}\n${stderr}`;

			expect(exitCode, output).not.toBe(0);
			expect(output).toContain(USER_PATH_REFUSAL_PREFIX);
			// It reached the cache open through the real production path, and the
			// path it named was the one `homedir()` gave the child.
			expect(output).toContain(join(home, ".mnemex", "embed-cache.db"));
			expect(fingerprintAll(USER_CACHE_FILES)).toEqual(before);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 120_000);
});

describe("the probe that wrote the user's cache", () => {
	test("passes, from a subdirectory, without touching the real file", async () => {
		// `indexer-model-mismatch.probe.ts` is the file that actually created
		// `~/.mnemex/embed-cache.db`. Run it the way `bun` would from a directory
		// with no `bunfig.toml`: no preload, so only the in-module gate and the
		// probe's own `MNEMEX_EMBED_CACHE_PATH` are standing.
		const before = fingerprintAll(USER_CACHE_FILES);

		const env = keychainSafeChildEnv();
		delete env.MNEMEX_EMBED_CACHE_PATH;
		delete env.MNEMEX_DISABLE_EMBED_CACHE;
		delete env.MNEMEX_EMBED_CACHE_TEST_GUARD;

		const proc = Bun.spawn(
			["bun", "test", `./${relative(join(REPO, "test"), PROBE)}`],
			{ cwd: join(REPO, "test"), env, stdout: "pipe", stderr: "pipe" },
		);
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);

		expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
		// bun test writes its summary to stderr.
		expect(stderr).toContain("0 fail");
		expect(fingerprintAll(USER_CACHE_FILES)).toEqual(before);
	}, 120_000);
});

describe("the assertion above can go red", () => {
	/**
	 * A guard that cannot be shown to fail is not a guard.
	 *
	 * The mutation runs the SAME child against a BUNDLE of `embed-cache.ts` with
	 * the refusal cut out, pointed at a DECOY home — so the red half is real
	 * bytes, produced by real code, and the user's own file is never a
	 * participant. This is CLAUDE.md #24's technique for falsifying a no-spawn
	 * assertion without spawning: copy the module, repoint the constant.
	 *
	 * The decoy cache is ABSENT before each run because the observed defect was a
	 * CREATION — the maintainer's machine had no `embed-cache.db` until the test
	 * suite made one.
	 */

	// The bundler re-indents and may split the statement across lines, so the
	// anchor is a pattern, and the count is asserted — a mutation that silently
	// stopped matching would make this whole block prove nothing.
	const THROW = /if \(refusal !== null\)\s*throw new Error\(refusal\);/g;

	async function bundle(dir: string): Promise<{
		intact: string;
		neutered: string;
	}> {
		const intact = join(dir, "intact.mjs");
		const build = Bun.spawnSync(
			[
				"bun",
				"build",
				join(REPO, "src", "core", "embed-cache.ts"),
				"--target",
				"bun",
				"--format",
				"esm",
				"--outfile",
				intact,
			],
			{ cwd: REPO, env: keychainSafeChildEnv() },
		);
		expect(build.exitCode, build.stderr.toString()).toBe(0);

		const source = readFileSync(intact, "utf8");
		expect(source.match(THROW) ?? []).toHaveLength(1);
		const neutered = join(dir, "neutered.mjs");
		await Bun.write(neutered, source.replace(THROW, "/* guard removed */"));
		return { intact, neutered };
	}

	test("intact refuses; the SAME child with the guard removed creates the file", async () => {
		const dir = mkdtempSync(join(tmpdir(), "embed-cache-guard-mutation-"));
		try {
			const { intact, neutered } = await bundle(dir);
			const home = join(dir, "decoy-home");
			const cacheDir = join(home, ".mnemex");
			mkdirSync(cacheDir, { recursive: true });
			const expected = join(cacheDir, "embed-cache.db");

			// GREEN: the committed code, on a decoy home that stands in for a real
			// one. Nothing appears in the directory.
			const before = fingerprintDir(cacheDir);
			expect(before).toEqual([]);

			const guarded = await runChild({ module: intact, home });
			expect(
				guarded.homedir,
				"bun's homedir() must follow the child's HOME",
			).toBe(home);
			expect(guarded.path).toBe(expected);
			expect(guarded.refused).toBe(true);
			expect(fingerprintDir(cacheDir)).toEqual(before);

			// RED: one line removed, everything else identical. The file appears —
			// which is what makes the `toEqual(before)` assertions above capable of
			// failing rather than trivially true.
			const unguarded = await runChild({ module: neutered, home });
			expect(unguarded.refused).toBe(false);
			expect(unguarded.opened).toBe(true);
			expect(unguarded.path).toBe(expected);

			const after = fingerprintDir(cacheDir);
			expect(after).not.toEqual(before);
			expect(existsSync(expected)).toBe(true);
			expect(statSync(expected).size).toBeGreaterThan(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 120_000);
});

describe("the wiring", () => {
	/** Every `.ts` under `src/`, excluding nothing. */
	function sourceFiles(dir: string): string[] {
		const out: string[] = [];
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) out.push(...sourceFiles(full));
			else if (entry.name.endsWith(".ts")) out.push(full);
		}
		return out;
	}

	/** Lines that are code, not prose. Enough to tell a call from a comment. */
	function codeLines(source: string): string[] {
		return source.split("\n").filter((line) => {
			const t = line.trim();
			return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*");
		});
	}

	test("src/index.ts is the ONLY file that opens the gate", () => {
		const definer = join("core", "embed-cache.ts");
		const callers: string[] = [];
		for (const file of sourceFiles(join(REPO, "src"))) {
			const rel = relative(join(REPO, "src"), file);
			if (rel === definer) continue;
			if (
				codeLines(readFileSync(file, "utf8")).some((l) =>
					/\benableUserEmbedCachePath\s*\(/.test(l),
				)
			) {
				callers.push(rel);
			}
		}
		expect(callers).toEqual(["index.ts"]);
	});

	test("the entry point opens it — otherwise every real index run refuses", () => {
		// The other direction of the same rule. Deny-by-default with no opt-in is
		// not a guard, it is a broken feature.
		const source = readFileSync(join(REPO, "src", "index.ts"), "utf8");
		expect(codeLines(source).join("\n")).toContain(
			"enableUserEmbedCachePath()",
		);
	});

	test("openEmbedCache is the one choke point", () => {
		// The guard is worth exactly as much as the claim that nothing else in the
		// module opens a database.
		const source = readFileSync(
			join(REPO, "src", "core", "embed-cache.ts"),
			"utf8",
		);
		const opens = codeLines(source).filter((l) =>
			/\bcreateDatabaseSync\s*\(/.test(l),
		);
		expect(opens).toHaveLength(1);
	});

	test("every test child carries the sentinel", () => {
		// The one case deny-by-default cannot cover: a child that IS the entry
		// point and opens its own gate (CLAUDE.md #24's first bypass, for the
		// keychain). `keychainSafeChildEnv()` is THE child environment builder,
		// and the keychain sweep already forces entry-point spawns through it.
		expect(keychainSafeChildEnv().MNEMEX_EMBED_CACHE_TEST_GUARD).toBe("1");
		expect(
			keychainSafeChildEnv({ MNEMEX_EMBED_CACHE_TEST_GUARD: "0" })
				.MNEMEX_EMBED_CACHE_TEST_GUARD,
			"a caller's extra must not be able to weaken it",
		).toBe("1");
	});

	test("bunfig preloads the sentinel too — the redundant layer", () => {
		const bunfig = readFileSync(join(REPO, "bunfig.toml"), "utf8");
		expect(bunfig).toContain("./test/setup/embed-cache-guard.ts");
	});
});
