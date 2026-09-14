/**
 * Decision I-9: memories stranded by the MNEMEX_INDEX_DIR double-join produce
 * ONE warning, on stderr, and nothing else.
 *
 * Every scenario runs in a CHILD process that performs the server's own
 * composition: `loadMcpConfig()` from the child's cwd, `createLogger`, then
 * `openMcpMemoryStore` — the function `startMcpServer` calls. Three reasons:
 *
 *   - "nothing on stdout" is asserted on the child's real fd 1, so `console.log`,
 *     a dotenv banner or a direct `process.stdout.write` would all show up. A
 *     monkeypatched `process.stdout.write` sees only the last of those.
 *   - "once per process" is asserted per process: the child calls the store
 *     opener three times and exactly one warning may come out.
 *   - the module's latch is never reset by a test, so no test seam exists.
 *
 * Every legacy file is snapshotted byte-for-byte before the child runs and
 * compared after. The recovery command is a suggestion; the snapshot proves it
 * was not run.
 *
 * Falsified by: making `findStrandedMemories` return `null` unconditionally.
 * The two warning tests go red; see implementation-log.md, I-9.
 */

import { afterAll, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { findStrandedMemories } from "../../../src/mcp/stranded-memories.js";
import { MemoryStore } from "../../../src/memory/store.js";
import { keychainSafeChildEnv } from "../../helpers/child-env.js";

const REPO = resolve(import.meta.dir, "../../..");
// NOT realpath'd: on macOS this is `/var/…` while the child's `process.cwd()`
// is `/private/var/…`, which is exactly the spelling split the check must see through.
const root = mkdtempSync(join(tmpdir(), "mnemex-stranded-"));
const home = join(root, "home");
mkdirSync(home);

const CHILD = join(root, "child.ts");
writeFileSync(
	CHILD,
	`import { loadMcpConfig } from ${JSON.stringify(join(REPO, "src/mcp/config.ts"))};
import { createLogger } from ${JSON.stringify(join(REPO, "src/mcp/logger.ts"))};
import { openMcpMemoryStore } from ${JSON.stringify(join(REPO, "src/mcp/stranded-memories.ts"))};
const config = loadMcpConfig();
const logger = createLogger(config.logLevel);
for (let i = 0; i < 3; i++) openMcpMemoryStore(config, logger);
`,
);

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

let counter = 0;
function freshDirs(): { ws: string; abs: string } {
	counter += 1;
	const ws = join(root, `ws-${counter}`);
	const abs = join(root, `abs-${counter}`);
	mkdirSync(ws);
	return { ws, abs };
}

/** Where HEAD wrote: `join(process.cwd(), value)`, with the child's cwd spelling. */
function legacyDirFor(ws: string, value: string): string {
	return join(realpathSync(ws), value);
}

/** relpath -> base64 bytes, or "<dir>". Every file and directory under `dir`. */
function snapshot(dir: string): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (d: string): void => {
		for (const name of readdirSync(d).sort()) {
			const p = join(d, name);
			const rel = relative(dir, p);
			if (statSync(p).isDirectory()) {
				out[rel] = "<dir>";
				walk(p);
			} else {
				out[rel] = readFileSync(p).toString("base64");
			}
		}
	};
	walk(dir);
	return out;
}

interface ChildRun {
	exitCode: number | null;
	stdoutBytes: number;
	stderr: string;
	warnings: string[];
}

function runServerComposition(
	ws: string,
	indexDir: string | undefined,
): ChildRun {
	const env = keychainSafeChildEnv({
		HOME: home,
		MNEMEX_LOG_LEVEL: "warn",
		MNEMEX_INDEX_DIR: indexDir,
	});
	if (indexDir === undefined) delete env.MNEMEX_INDEX_DIR;
	const child = Bun.spawnSync(["bun", CHILD], {
		cwd: ws,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const stderr = child.stderr.toString();
	return {
		exitCode: child.exitCode,
		stdoutBytes: child.stdout.length,
		stderr,
		warnings: stderr.split("\n").filter((l) => l.includes("stranded")),
	};
}

function seedMemories(dir: string, keys: string[]): void {
	const store = new MemoryStore(dir);
	for (const key of keys) store.write(key, `authored content for ${key}\n`);
}

function mdFiles(dir: string): string[] {
	try {
		return readdirSync(join(dir, "memories"))
			.filter((n) => n.endsWith(".md"))
			.sort();
	} catch {
		return [];
	}
}

describe("I-9: stranded MCP memories", () => {
	test("absolute MNEMEX_INDEX_DIR + legacy memories: ONE warning naming both paths and the command", () => {
		const { ws, abs } = freshDirs();
		const legacy = legacyDirFor(ws, abs);
		seedMemories(legacy, ["alpha", "beta"]);
		const before = snapshot(legacy);

		const run = runServerComposition(ws, abs);

		expect(run.exitCode).toBe(0);
		expect(run.stdoutBytes).toBe(0);
		// Three opens in one process, one warning.
		expect(run.warnings).toHaveLength(1);
		const line = run.warnings[0] as string;
		expect(line.startsWith("[mnemex] [WARN] ")).toBe(true);
		expect(line).toContain(`2 MCP memories stranded in ${legacy}/memories.`);
		expect(line).toContain(`now read from ${abs}/memories.`);
		expect(line).toContain(
			`To recover them, run: rmdir '${abs}/memories' && mv '${legacy}/memories' '${abs}/memories'`,
		);
		// Nothing moved, nothing deleted, nothing written.
		expect(snapshot(legacy)).toEqual(before);
		expect(mdFiles(abs)).toEqual([]);
	});

	test("absolute value, current location already has memories: merge guidance, still nothing moved", () => {
		const { ws, abs } = freshDirs();
		const legacy = legacyDirFor(ws, abs);
		seedMemories(legacy, ["alpha"]);
		seedMemories(abs, ["gamma"]);
		const before = snapshot(legacy);
		const currentBefore = snapshot(abs);

		const run = runServerComposition(ws, abs);

		expect(run.exitCode).toBe(0);
		expect(run.stdoutBytes).toBe(0);
		expect(run.warnings).toHaveLength(1);
		const line = run.warnings[0] as string;
		expect(line).toContain(`1 MCP memory stranded in ${legacy}/memories.`);
		expect(line).toContain(
			`run \`mv -n '${legacy}/memories/'*.md '${abs}/memories/'\``,
		);
		expect(line).toContain(`${legacy}/memories/memories.json`);
		expect(snapshot(legacy)).toEqual(before);
		expect(snapshot(abs)).toEqual(currentBefore);
	});

	test("MNEMEX_INDEX_DIR unset: no warning", () => {
		const { ws } = freshDirs();
		// Memories exist, at the one location that applies when unset.
		const current = join(ws, ".mnemex");
		seedMemories(current, ["alpha"]);
		const before = snapshot(current);

		const run = runServerComposition(ws, undefined);

		expect(run.exitCode).toBe(0);
		expect(run.stdoutBytes).toBe(0);
		expect(run.stderr).toBe("");
		expect(snapshot(current)).toEqual(before);
	});

	test("relative MNEMEX_INDEX_DIR: no warning, although HEAD's directory holds memories", () => {
		const { ws } = freshDirs();
		// HEAD's directory and today's are the SAME directory here. It holds
		// memories, so only the "differs" condition can suppress the warning.
		const legacy = legacyDirFor(ws, "custom-store");
		seedMemories(legacy, ["alpha", "beta"]);
		const before = snapshot(legacy);

		const run = runServerComposition(ws, "custom-store");

		expect(run.exitCode).toBe(0);
		expect(run.stdoutBytes).toBe(0);
		expect(run.stderr).toBe("");
		expect(snapshot(legacy)).toEqual(before);
	});

	test("one directory under two spellings is not 'different'", () => {
		// The child above cannot show this: its `process.cwd()` is already the
		// realpath (measured), so both sides come out spelled identically. Here
		// the workspace root is `tmpdir()`'s `/var/…` spelling and `memoryDir`
		// the `/private/var/…` one — unequal strings, one directory. Where
		// `tmpdir()` is not a symlink the strings match and this still holds.
		const { ws } = freshDirs();
		const legacy = legacyDirFor(ws, "custom-store");
		seedMemories(legacy, ["alpha"]);
		const before = snapshot(legacy);

		expect(
			findStrandedMemories(ws, realpathSync(legacy), "custom-store"),
		).toBeNull();
		expect(snapshot(legacy)).toEqual(before);
	});

	test("absolute value, legacy directory holds no memory FILES: no warning", () => {
		const { ws, abs } = freshDirs();
		const legacy = legacyDirFor(ws, abs);
		// What HEAD really left behind: `memories/` created eagerly by the store's
		// constructor, an index with no entries, an interrupted atomic write, and
		// an index entry whose file is gone. A directory exists; no memory does.
		const mem = join(legacy, "memories");
		mkdirSync(mem, { recursive: true });
		writeFileSync(
			join(mem, "memories.json"),
			JSON.stringify({
				memories: {
					ghost: {
						createdAt: "2026-01-01T00:00:00Z",
						updatedAt: "2026-01-01T00:00:00Z",
					},
				},
			}),
		);
		writeFileSync(join(mem, "alpha.md.tmp-0123456789ab"), "partial");
		const before = snapshot(legacy);

		const run = runServerComposition(ws, abs);

		expect(run.exitCode).toBe(0);
		expect(run.stdoutBytes).toBe(0);
		expect(run.stderr).toBe("");
		expect(snapshot(legacy)).toEqual(before);
	});

	test("startMcpServer opens its memory store through openMcpMemoryStore", () => {
		// The child above runs openMcpMemoryStore; this pins that the server does too.
		const source = readFileSync(join(REPO, "src/mcp/server.ts"), "utf8");
		expect(source).toContain("openMcpMemoryStore(config, logger)");
		expect(source).not.toMatch(/new\s+MemoryStore\s*\(/);
	});
});
