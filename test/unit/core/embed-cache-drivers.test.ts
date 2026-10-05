/**
 * ASSUMPTION 4 (architecture §11) — BOTH sqlite drivers accept the BLOB the
 * cache binds, and a file written by one is readable by the other.
 *
 * `src/core/sqlite.ts:36` picks its driver by runtime: `bun:sqlite` under Bun,
 * `better-sqlite3` under Node. The repo SHIPS BOTH — `bun run dev` and the
 * compiled binary take the first, an `npm install -g mnemex` takes the second —
 * so `~/.mnemex/embed-cache.db` is a file two different SQLite bindings write
 * to. `better-sqlite3` historically accepts only a `Buffer` for a BLOB
 * parameter, not any `Uint8Array`, which is what `toBlobParam()` exists for.
 *
 * WHY THIS SPAWNS. `bun test` runs under Bun, and under bun 1.4.0 the mere act
 * of constructing a `better-sqlite3` database ABORTS the process:
 *
 *     panic: NAPI FATAL ERROR: Error::New napi_get_last_error_info
 *
 * — it takes the whole test runner down, so the second path cannot be exercised
 * in-process at any cost. The child is `node`, running a CJS bundle of the cache
 * module built with `bun build --target node`. Neither spawn touches an entry
 * point or a credential; both carry `keychainSafeChildEnv()` anyway, because the
 * rule in CLAUDE.md #24 is that a child's environment is built, never inherited.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	openEmbedCache,
	resetEmbedCacheForTests,
} from "../../../src/core/embed-cache.js";
import { keychainSafeChildEnv } from "../../helpers/child-env.js";

const REPO = join(import.meta.dir, "..", "..", "..");
const CHILD = join(REPO, "test", "helpers", "embed-cache-bs3-child.cjs");

let dir: string;
let bundleSeq = 0;
const bundles: string[] = [];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "embed-cache-drivers-"));
});

afterEach(() => {
	resetEmbedCacheForTests();
	rmSync(dir, { recursive: true, force: true });
	for (const bundle of bundles.splice(0, bundles.length)) {
		rmSync(bundle, { force: true });
	}
});

/** `node` is present on every CI runner and on any machine that ran `npm i`. */
function nodeAvailable(): boolean {
	const probe = spawnSync("node", ["--version"], {
		encoding: "utf8",
		env: keychainSafeChildEnv(),
	});
	return probe.status === 0;
}

interface ChildResult {
	runtime: { node: string; bun: string | null };
	key: string;
	readBack: number[];
	knownDimension: number;
	stats: { writes: number; hits: number };
	acceptsBareUint8Array: boolean;
	bareUint8ArrayError?: string;
	acceptsToBlobParam: boolean;
	toBlobParamError?: string;
	wrappedByteLength: number;
	toBlobParamCtor: string;
	error?: string;
	stack?: string;
}

function runUnderNode(dbPath: string): ChildResult {
	// The bundle must live INSIDE the repo: Node resolves `better-sqlite3` by
	// walking up from the requiring FILE, not from the cwd, so a bundle in
	// `os.tmpdir()` cannot see `node_modules` and `openEmbedCache` returns null
	// with "Cannot find module 'better-sqlite3'" — a null that would otherwise
	// look like the cache refusing to open.
	const bundleDir = join(REPO, "node_modules", ".cache", "mnemex-embed-cache");
	mkdirSync(bundleDir, { recursive: true });
	const bundle = join(bundleDir, `bundle-${process.pid}-${bundleSeq++}.cjs`);
	bundles.push(bundle);
	const build = spawnSync(
		"bun",
		[
			"build",
			join(REPO, "src", "core", "embed-cache.ts"),
			"--target",
			"node",
			"--format",
			"cjs",
			"--external",
			"better-sqlite3",
			"--outfile",
			bundle,
		],
		{ encoding: "utf8", cwd: REPO, env: keychainSafeChildEnv() },
	);
	expect(build.status, build.stderr).toBe(0);
	expect(existsSync(bundle)).toBe(true);

	const child = spawnSync("node", [CHILD, bundle, dbPath], {
		encoding: "utf8",
		cwd: REPO,
		env: keychainSafeChildEnv(),
	});
	const stdout = child.stdout?.trim() ?? "";
	expect(stdout, `stderr: ${child.stderr}`).not.toBe("");
	return JSON.parse(stdout.split("\n").pop() as string) as ChildResult;
}

describe("both sqlite drivers behind sqlite.ts", () => {
	const VECTOR = [1.5, -2.25, 3.125, 0.5, -0.0625];

	test.skipIf(!nodeAvailable())(
		"better-sqlite3 accepts the BLOB, and the round trip is exact",
		() => {
			const dbPath = join(dir, "node-written.db");
			const result = runUnderNode(dbPath);
			expect(result.error).toBeUndefined();

			// It really was the OTHER driver: a Bun child would prove nothing.
			expect(result.runtime.bun).toBeNull();
			expect(result.runtime.node).toBeTruthy();

			expect(result.readBack).toEqual(VECTOR);
			expect(result.knownDimension).toBe(5);
			expect(result.stats.writes).toBe(1);
			expect(result.stats.hits).toBe(1);

			// The parameter this driver was handed, and what it did with it.
			expect(result.acceptsToBlobParam).toBe(true);
			expect(result.wrappedByteLength).toBe(VECTOR.length * 4);
			expect(result.toBlobParamCtor).toBe("Buffer");
		},
	);

	test.skipIf(!nodeAvailable())(
		"a cache written by better-sqlite3 is readable by bun:sqlite",
		() => {
			// The interop that makes `~/.mnemex/embed-cache.db` machine-global: an
			// npm-installed mnemex (Node) and a compiled binary (Bun) share one file.
			const dbPath = join(dir, "shared.db");
			const written = runUnderNode(dbPath);
			expect(written.error).toBeUndefined();

			const cache = openEmbedCache(dbPath);
			expect(cache).not.toBeNull();
			expect(cache?.get(written.key, "ollama", 5, "trunc:32000")).toEqual(
				VECTOR,
			);
			expect(cache?.knownDimension("nomic-embed-text", "ollama")).toBe(5);
		},
	);

	test("this process is Bun, so the in-process tests cover bun:sqlite", () => {
		// Names the coverage split explicitly: everything else in this directory
		// exercises the bun path, and only the two spawning tests above can reach
		// the other one.
		expect(typeof globalThis.Bun).not.toBe("undefined");
	});
});
