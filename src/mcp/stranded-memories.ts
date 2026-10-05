/**
 * Decision I-9: MCP memories stranded by the MNEMEX_INDEX_DIR double-join are
 * REPORTED, once per process, and never moved.
 *
 * Before decision I-8 the MCP server built its directory as
 * `join(workspaceRoot, MNEMEX_INDEX_DIR ?? ".mnemex")`. For an ABSOLUTE value
 * that double-joins: `join("/ws", "/abs")` is `/ws/abs`, so those users' memories
 * were written to `/ws/abs/memories`. `memoryDirFor` (./config.ts) now reads
 * them from `/abs/memories`. The old files still exist and nothing reads them.
 * Memories are authored and cannot be rebuilt, so this module says so, names
 * both directories and the one command that recovers them, and does nothing
 * else: no move, no delete, no write. The command is a SUGGESTION; it is never
 * run. An automatic migration was rejected (decisions-implementation.md, I-9).
 *
 * The warning goes through the MCP logger, which writes stderr. NEVER stdout:
 * stdout is the MCP protocol channel (CLAUDE.md #14).
 */

import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveStoreLocation } from "../core/store-location.js";
import { MemoryStore } from "../memory/store.js";
import type { McpConfig } from "./config.js";
import type { Logger } from "./logger.js";

/** `MemoryStore` keeps its files in `<dir>/memories/`. */
const MEMORIES_SUBDIR = "memories";

/**
 * One stored memory on disk: `<key>.md`, with the key rule of
 * `src/memory/store.ts` (`KEY_PATTERN`, 1-128 characters). `memories.json` is
 * the listing index, NOT a memory, and `*.tmp-<hex>` is an interrupted atomic
 * write. Neither counts, so a directory holding only those is not "holding
 * memories". That matters: `MemoryStore`'s constructor creates `memories/`
 * eagerly, so at HEAD every MCP startup with an absolute MNEMEX_INDEX_DIR left
 * an EMPTY legacy directory behind whether or not a memory was ever written.
 */
const MEMORY_FILE = /^[a-zA-Z0-9_-]{1,128}\.md$/;

export interface StrandedMemories {
	/** HEAD's directory, `join(workspaceRoot, MNEMEX_INDEX_DIR)`. */
	readonly legacyDir: string;
	/** Where memories are read from now: `McpConfig.memoryDir`. */
	readonly currentDir: string;
	/** `<key>.md` files in `<legacyDir>/memories`. Always > 0. */
	readonly memoryCount: number;
	/** Whether `<currentDir>/memories` already has entries, which rules out a plain move. */
	readonly currentHasEntries: boolean;
	/** The recovery, as a suggestion. Never executed. */
	readonly recoveryCommand: string;
}

/**
 * Stranded memories, or `null`. Reads the filesystem; writes nothing; never throws.
 *
 * All three must hold: the variable is set (HEAD treated `""` as unset too),
 * HEAD's directory is a different directory from `memoryDir`, and HEAD's
 * directory holds at least one memory file.
 */
export function findStrandedMemories(
	workspaceRoot: string,
	memoryDir: string,
	rawIndexDir: string | undefined,
): StrandedMemories | null {
	if (!rawIndexDir) return null;
	// Exactly HEAD's expression, deliberately with no isAbsolute() check.
	const legacyDir = join(workspaceRoot, rawIndexDir);
	if (sameDirectory(legacyDir, memoryDir)) return null;

	const legacyMemories = join(legacyDir, MEMORIES_SUBDIR);
	const memoryCount = countMemoryFiles(legacyMemories);
	if (memoryCount === 0) return null;

	const currentMemories = join(memoryDir, MEMORIES_SUBDIR);
	const currentEntries = listEntries(currentMemories);
	const currentHasEntries =
		currentEntries !== null && currentEntries.length > 0;
	return {
		legacyDir,
		currentDir: memoryDir,
		memoryCount,
		currentHasEntries,
		recoveryCommand: recoveryCommandFor(
			legacyMemories,
			currentMemories,
			currentEntries,
		),
	};
}

/** The single log line. Names both directories and the recovery command. */
export function formatStrandedMemoriesWarning(s: StrandedMemories): string {
	const legacy = join(s.legacyDir, MEMORIES_SUBDIR);
	const current = join(s.currentDir, MEMORIES_SUBDIR);
	const noun = s.memoryCount === 1 ? "memory" : "memories";
	const recovery = s.currentHasEntries
		? `${current} already has entries, so the two indexes must be merged: ` +
			`run \`${s.recoveryCommand}\`, then copy the moved keys' entries from ` +
			`${join(legacy, "memories.json")} into ${join(current, "memories.json")}.`
		: `To recover them, run: ${s.recoveryCommand}`;
	// The variable is described, not named: only the seam names it in code
	// (decision I-8), and the static sweep holds that without exemptions.
	return (
		`${s.memoryCount} MCP ${noun} stranded in ${legacy}. Earlier versions ` +
		`joined an absolute index directory, set through the environment, onto ` +
		`the workspace root and wrote ` +
		`memories there; memories are now read from ${current}. Nothing has been ` +
		`moved or deleted. ${recovery}`
	);
}

/** One check per process, however many times the caller asks. */
let strandedCheckDone = false;

/**
 * Warn once per process if memories are stranded. Every call after the first
 * returns `null` without touching the filesystem.
 *
 * `rawIndexDir` is `StoreLocation.envIndexDir`: MNEMEX_INDEX_DIR as the seam
 * read it. This module never reads the environment; the seam is the one
 * reader (decision I-8), and test/unit/core/store-one-resolver.test.ts holds
 * it there.
 */
export function warnStrandedMemoriesOnce(
	config: Pick<McpConfig, "workspaceRoot" | "memoryDir">,
	logger: Pick<Logger, "warn">,
	rawIndexDir: string | undefined,
): StrandedMemories | null {
	if (strandedCheckDone) return null;
	strandedCheckDone = true;
	const stranded = findStrandedMemories(
		config.workspaceRoot,
		config.memoryDir,
		rawIndexDir,
	);
	if (stranded !== null) logger.warn(formatStrandedMemoriesWarning(stranded));
	return stranded;
}

/**
 * The MCP server's memory store, plus the I-9 check. `startMcpServer` calls
 * this, so the test drives the same composition the server runs.
 *
 * The store is constructed FIRST: its constructor creates `<memoryDir>/memories`,
 * and the recovery command depends on that directory's state.
 */
export function openMcpMemoryStore(
	config: Pick<McpConfig, "workspaceRoot" | "memoryDir">,
	logger: Pick<Logger, "warn">,
): MemoryStore {
	const store = new MemoryStore(config.memoryDir);
	// The memoized location `loadMcpConfig` derived `memoryDir` from: same root,
	// same variable value, so the same memo key and the same frozen object. The
	// raw value and the directory it is compared against come from one read.
	warnStrandedMemoriesOnce(
		config,
		logger,
		resolveStoreLocation(config.workspaceRoot).envIndexDir,
	);
	return store;
}

// ════════════════════════════════════════════════════════════════════════════

/**
 * Same directory by device and inode, not by spelling. On macOS `tmpdir()` is
 * `/var/…` and `process.cwd()` reports `/private/var/…`, and the filesystem is
 * case-insensitive by default, so a string comparison would call one directory
 * two and warn about memories that are exactly where they are read from.
 */
function sameDirectory(a: string, b: string): boolean {
	try {
		const sa = statSync(a, { bigint: true });
		const sb = statSync(b, { bigint: true });
		return sa.dev === sb.dev && sa.ino === sb.ino;
	} catch {
		// One side does not exist, so they cannot be the same existing directory.
		return resolve(a) === resolve(b);
	}
}

function listEntries(dir: string): string[] | null {
	try {
		return readdirSync(dir);
	} catch {
		return null;
	}
}

function countMemoryFiles(dir: string): number {
	try {
		return readdirSync(dir, { withFileTypes: true }).filter(
			(e) => MEMORY_FILE.test(e.name) && (e.isFile() || e.isSymbolicLink()),
		).length;
	} catch {
		return 0;
	}
}

/**
 * The command a user can paste, chosen so that it can never clobber a memory:
 *
 *   current dir absent     `mv L C`
 *   current dir empty      `rmdir C && mv L C`. `rmdir` refuses a non-empty
 *                          directory, so if a memory lands in C before the user
 *                          acts, nothing runs. A bare `mv L C` onto an existing
 *                          C would nest the files at `C/memories`.
 *   current dir has files  `mv -n L/*.md C/`. `-n` never overwrites; the index
 *                          (`memories.json`) needs a hand merge, which the
 *                          message spells out, because `MemoryStore` only sees
 *                          keys that are in its index.
 */
function recoveryCommandFor(
	legacyMemories: string,
	currentMemories: string,
	currentEntries: string[] | null,
): string {
	const L = shellQuote(legacyMemories);
	const C = shellQuote(currentMemories);
	if (currentEntries === null) return `mv ${L} ${C}`;
	if (currentEntries.length === 0) return `rmdir ${C} && mv ${L} ${C}`;
	return `mv -n ${shellQuote(`${legacyMemories}/`)}*.md ${shellQuote(`${currentMemories}/`)}`;
}

/** POSIX single quotes; a `'` inside becomes `'\''`. */
function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}
