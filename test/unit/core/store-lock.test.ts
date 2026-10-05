/**
 * The store lock (FR-2, architecture §5): its identity DERIVES from the resolved
 * store location, it is taken atomically, and only its owner may remove it.
 *
 *  - V2.3 (string half): `createStoreLock(loc)` is `getLockPathFor(loc)`, and
 *    that is directly under `storeDir` for every kind of location. The on-disk
 *    half is in `test/e2e/store-lock-worktrees-e2e.test.ts`.
 *  - V2.6 (lock half): a fresh clone has no store directory, and the first
 *    acquire creates it rather than failing with ENOENT / `reason: "error"`.
 *  - The ownership token: `release()`, the heartbeat and the stale-reclaim path
 *    never remove or overwrite a lock that is not theirs.
 *  - Sweeps: the lock filename is declared once, in `store-location.ts`; and
 *    `new IndexLock(` appears in `lock.ts` only, so no production caller can
 *    rebuild a lock path from a project path again.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import {
	createStoreLock,
	IndexLock,
	inspectLock,
} from "../../../src/core/lock.js";
import {
	__resetStoreLocationCacheForTests,
	getLockPathFor,
	INDEX_DIR_ENV_VAR,
	resolveStoreLocation,
} from "../../../src/core/store-location.js";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const DEAD_PID = 2_000_000_000;
const tempDirs: string[] = [];
const savedIndexDirEnv = process.env[INDEX_DIR_ENV_VAR];

function makeDir(prefix = "store-lock-"): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	tempDirs.push(dir);
	return dir;
}

function readRecord(path: string): Record<string, unknown> {
	return JSON.parse(readFileSync(path, "utf8"));
}

afterEach(() => {
	if (savedIndexDirEnv === undefined) delete process.env[INDEX_DIR_ENV_VAR];
	else process.env[INDEX_DIR_ENV_VAR] = savedIndexDirEnv;
	__resetStoreLocationCacheForTests();
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

// ════════════════════════════════════════════════════════════════════════════
describe("V2.3 — the lock path is derived from the resolved store location", () => {
	test("plain directory: <startPath>/.mnemex/.indexing.lock, under storeDir", () => {
		const project = makeDir();
		const loc = resolveStoreLocation(project);
		const lock = createStoreLock(loc);

		expect(loc.kind).toBe("plain-directory");
		expect(lock.path).toBe(getLockPathFor(loc));
		expect(dirname(lock.path)).toBe(loc.storeDir);
		expect(lock.path).toBe(join(project, ".mnemex", ".indexing.lock"));
	});

	test("MNEMEX_INDEX_DIR override: the lock moves WITH the store", () => {
		const project = makeDir();
		const store = makeDir("store-lock-shared-");
		process.env[INDEX_DIR_ENV_VAR] = store;
		const loc = resolveStoreLocation(project);
		const lock = createStoreLock(loc);

		expect(loc.kind).toBe("env-override");
		expect(dirname(lock.path)).toBe(store);
		// The old derivation, join(projectPath, ".mnemex", …), is NOT where it is.
		expect(lock.path).not.toBe(join(project, ".mnemex", ".indexing.lock"));
	});

	test("ProjectConfig.indexDir override: two projects sharing a store share ONE lock", () => {
		const store = makeDir("store-lock-shared-");
		const a = makeDir("store-lock-a-");
		const b = makeDir("store-lock-b-");
		for (const project of [a, b]) {
			writeFileSync(
				join(project, "mnemex.json"),
				JSON.stringify({ indexDir: store }),
			);
		}

		const lockA = createStoreLock(resolveStoreLocation(a));
		const lockB = createStoreLock(resolveStoreLocation(b));

		expect(lockA.path).toBe(lockB.path);
		expect(dirname(lockA.path)).toBe(store);
	});

	test("on disk: the file that appears is the one under storeDir, and only that one", async () => {
		const store = makeDir("store-lock-shared-");
		const project = makeDir();
		writeFileSync(
			join(project, "mnemex.json"),
			JSON.stringify({ indexDir: store }),
		);
		const loc = resolveStoreLocation(project);
		const lock = createStoreLock(loc);

		const result = await lock.acquire();
		try {
			expect(result.acquired).toBe(true);
			expect(readdirSync(store)).toContain(basename(lock.path));
			expect(existsSync(join(project, ".mnemex", ".indexing.lock"))).toBe(
				false,
			);
		} finally {
			lock.release();
		}
		expect(existsSync(lock.path)).toBe(false);
	});
});

// ════════════════════════════════════════════════════════════════════════════
describe("V2.6 — a fresh clone with no store directory acquires", () => {
	test("acquire creates the missing store directory instead of failing with ENOENT", async () => {
		const project = makeDir("store-lock-fresh-");
		const loc = resolveStoreLocation(project);
		expect(existsSync(loc.storeDir)).toBe(false);

		const lock = createStoreLock(loc);
		const result = await lock.acquire();
		try {
			expect(result).toEqual({ acquired: true });
			expect(existsSync(lock.path)).toBe(true);
		} finally {
			lock.release();
		}
	});

	test("a deep missing parent is created too", async () => {
		const root = makeDir();
		const lock = new IndexLock(join(root, "a", "b", "c", ".indexing.lock"));
		const result = await lock.acquire();
		try {
			expect(result.acquired).toBe(true);
		} finally {
			lock.release();
		}
	});
});

// ════════════════════════════════════════════════════════════════════════════
describe("the ownership token", () => {
	test("every lock file carries a token, and it is this holder's", async () => {
		const lock = new IndexLock(join(makeDir(), ".indexing.lock"));
		expect(lock.ownershipToken).toBeNull();
		await lock.acquire();
		try {
			const token = lock.ownershipToken;
			expect(token).toMatch(
				/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
			);
			expect(readRecord(lock.path).token).toBe(token as string);
		} finally {
			lock.release();
		}
		expect(lock.ownershipToken).toBeNull();
	});

	test("two acquisitions never share a token", async () => {
		const lock = new IndexLock(join(makeDir(), ".indexing.lock"));
		await lock.acquire();
		const first = lock.ownershipToken;
		lock.release();
		await lock.acquire();
		const second = lock.ownershipToken;
		lock.release();
		expect(first).not.toBe(second);
	});

	/** Stand-in for a reclaim: A's file moved away, a new owner's put in its place. */
	function replaceWithNewOwner(lockPath: string): string {
		renameSync(lockPath, `${lockPath}.gone`);
		const now = Date.now();
		const newOwner = {
			pid: process.pid,
			startTime: now,
			heartbeat: now,
			lastProgressAt: now,
			startedAt: new Date(now).toISOString(),
			token: "the-new-owner",
		};
		writeFileSync(lockPath, JSON.stringify(newOwner));
		return readFileSync(lockPath, "utf8");
	}

	test("release() of a holder whose lock was reclaimed leaves the NEW owner's lock", async () => {
		const lock = new IndexLock(join(makeDir(), ".indexing.lock"));
		expect((await lock.acquire()).acquired).toBe(true);
		const newOwnerBytes = replaceWithNewOwner(lock.path);

		lock.release();

		expect(existsSync(lock.path)).toBe(true);
		expect(readFileSync(lock.path, "utf8")).toBe(newOwnerBytes);
	});

	test("a reclaimed holder's heartbeat, progress and phase never touch the new owner's file", async () => {
		const lock = new IndexLock(join(makeDir(), ".indexing.lock"));
		expect((await lock.acquire()).acquired).toBe(true);
		const newOwnerBytes = replaceWithNewOwner(lock.path);

		lock.recordProgress();
		lock.setPhase("writing:lance");
		// And one real heartbeat tick.
		await Bun.sleep(1_200);

		expect(readFileSync(lock.path, "utf8")).toBe(newOwnerBytes);
		lock.release();
		expect(readFileSync(lock.path, "utf8")).toBe(newOwnerBytes);
	});

	test("release() removes our own lock and leaves no debris", async () => {
		const dir = makeDir();
		const lock = new IndexLock(join(dir, ".indexing.lock"));
		await lock.acquire();
		lock.setPhase("embedding");
		lock.release();
		expect(readdirSync(dir)).toEqual([]);
	});
});

// ════════════════════════════════════════════════════════════════════════════
describe("atomic acquisition and the stale-reclaim path", () => {
	function writeForeign(lockPath: string, fields: Record<string, unknown>) {
		const now = Date.now();
		writeFileSync(
			lockPath,
			JSON.stringify({
				pid: process.pid,
				startTime: now,
				heartbeat: now,
				lastProgressAt: now,
				startedAt: new Date(now).toISOString(),
				...fields,
			}),
		);
	}

	test("an existing live lock is never overwritten (O_EXCL, not read-then-write)", async () => {
		const lockPath = join(makeDir(), ".indexing.lock");
		writeForeign(lockPath, { token: "live-holder" });
		const before = readFileSync(lockPath, "utf8");

		const result = await new IndexLock(lockPath).acquire({ waitTimeout: 0 });

		expect(result.acquired).toBe(false);
		expect(result.reason).toBe("already_running");
		expect(readFileSync(lockPath, "utf8")).toBe(before);
	});

	test("a dead holder's lock is reclaimed", async () => {
		const lockPath = join(makeDir(), ".indexing.lock");
		writeForeign(lockPath, { pid: DEAD_PID, token: "dead-holder" });

		const lock = new IndexLock(lockPath);
		const result = await lock.acquire({ waitTimeout: 0 });
		try {
			expect(result.acquired).toBe(true);
			expect(readRecord(lockPath).token).toBe(lock.ownershipToken as string);
		} finally {
			lock.release();
		}
	});

	test("a lock written before tokens existed (pid + startTime only) is still reclaimed when dead", async () => {
		const lockPath = join(makeDir(), ".indexing.lock");
		writeForeign(lockPath, { pid: DEAD_PID });
		const lock = new IndexLock(lockPath);
		expect((await lock.acquire({ waitTimeout: 0 })).acquired).toBe(true);
		lock.release();
	});

	/**
	 * The name lock.ts elects a reclaimer with: `<lock>.reclaim-<fnv1a(identity)>`,
	 * where a tokened lock's identity is `t:<token>`. Duplicated here on purpose:
	 * if lock.ts renames its claims, the planted claim below stops blocking and
	 * the first test goes red, instead of passing without testing anything.
	 */
	function claimPathFor(lockPath: string, identity: string): string {
		let h = 0x811c9dc5;
		for (let i = 0; i < identity.length; i++) {
			h ^= identity.charCodeAt(i);
			h = Math.imul(h, 0x01000193) >>> 0;
		}
		return `${lockPath}.reclaim-${h.toString(16).padStart(8, "0")}`;
	}

	test("while another process holds the RIGHT to reclaim a stale lock, we do not touch it", async () => {
		// Layer 1 of the reclaim: the claim file. A second reclaimer that ignored
		// it is exactly the process that unlinks the first reclaimer's LIVE lock.
		// (Without the claim, this same dead lock IS reclaimed: see above.)
		const lockPath = join(makeDir(), ".indexing.lock");
		writeForeign(lockPath, { pid: DEAD_PID, token: "dead-holder" });
		const before = readFileSync(lockPath, "utf8");
		const claim = claimPathFor(lockPath, "t:dead-holder");
		writeFileSync(claim, "12345"); // a live reclaimer's, by its fresh mtime

		const result = await new IndexLock(lockPath).acquire({ waitTimeout: 0 });

		expect(result.acquired).toBe(false);
		expect(readFileSync(lockPath, "utf8")).toBe(before);
		// Someone else's claim is not ours to remove while it is fresh.
		expect(existsSync(claim)).toBe(true);
	});

	test("a claim left by a reclaimer that died is dropped once it is older than staleTimeout", async () => {
		const dir = makeDir();
		const lockPath = join(dir, ".indexing.lock");
		writeForeign(lockPath, { pid: DEAD_PID, token: "dead-holder" });
		const claim = claimPathFor(lockPath, "t:dead-holder");
		writeFileSync(claim, "12345");
		const old = (Date.now() - 60_000) / 1000;
		utimesSync(claim, old, old);

		const lock = new IndexLock(lockPath);
		const result = await lock.acquire({ waitTimeout: 0 });
		try {
			expect(result.acquired).toBe(true);
		} finally {
			lock.release();
		}
		// Neither the dead claim nor any detached copy is left behind.
		expect(readdirSync(dir)).toEqual([]);
	});

	test("an empty lock file (a creator died before writing) is held while young, reclaimed once old", async () => {
		const lockPath = join(makeDir(), ".indexing.lock");
		writeFileSync(lockPath, "");

		const young = await new IndexLock(lockPath).acquire({ waitTimeout: 0 });
		expect(young.acquired).toBe(false);
		expect(young.reason).toBe("already_running");
		expect(young.holderPid).toBeUndefined();

		const old = (Date.now() - 60_000) / 1000;
		utimesSync(lockPath, old, old);
		const lock = new IndexLock(lockPath);
		const result = await lock.acquire({ waitTimeout: 0 });
		try {
			expect(result.acquired).toBe(true);
		} finally {
			lock.release();
		}
	});

	test("a filesystem error is reported as reason:error with the cause", async () => {
		const root = makeDir();
		// A FILE where the lock's directory must be.
		writeFileSync(join(root, "not-a-dir"), "x");
		const result = await new IndexLock(
			join(root, "not-a-dir", ".indexing.lock"),
		).acquire();
		expect(result.acquired).toBe(false);
		expect(result.reason).toBe("error");
		expect(result.errorMessage).toBeTruthy();
	});

	test("inspectLock reads the record a holder writes (padding included)", async () => {
		const lock = new IndexLock(join(makeDir(), ".indexing.lock"));
		await lock.acquire();
		try {
			lock.setPhase("a-rather-long-phase-name-to-grow-the-record");
			lock.setPhase("short");
			const inspect = inspectLock(lock.path);
			expect(inspect.present).toBe(true);
			if (inspect.present) {
				expect(inspect.pid).toBe(process.pid);
				expect(inspect.phase).toBe("short");
			}
			// The shrink was padded, not truncated: the size never went down.
			expect(statSync(lock.path).size).toBeGreaterThan(0);
		} finally {
			lock.release();
		}
	});
});

// ════════════════════════════════════════════════════════════════════════════
/**
 * Strip `//` and block comments, keeping string and template literals intact,
 * so a sweep matches code and not the prose explaining it.
 */
function stripComments(source: string): string {
	let out = "";
	let i = 0;
	let quote: string | null = null;
	while (i < source.length) {
		const ch = source[i] as string;
		const next = source[i + 1];
		if (quote !== null) {
			out += ch;
			if (ch === "\\") {
				out += next ?? "";
				i += 2;
				continue;
			}
			if (ch === quote) quote = null;
			i++;
			continue;
		}
		if (ch === "/" && next === "/") {
			while (i < source.length && source[i] !== "\n") i++;
			continue;
		}
		if (ch === "/" && next === "*") {
			i += 2;
			while (i < source.length && !(source[i] === "*" && source[i + 1] === "/"))
				i++;
			i += 2;
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") quote = ch;
		out += ch;
		i++;
	}
	return out;
}

function sourceFiles(dir: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...sourceFiles(full));
		else if (/\.(ts|tsx)$/.test(entry.name)) files.push(full);
	}
	return files;
}

describe("sweeps over src/ (comment-stripped)", () => {
	const SRC = join(REPO_ROOT, "src");
	const files = sourceFiles(SRC).map((file) => ({
		file: relative(REPO_ROOT, file),
		code: stripComments(readFileSync(file, "utf8")),
	}));

	test("the lock FILENAME is declared once, in store-location.ts", () => {
		// It used to be written in three places (lock.ts, completion-detector.ts
		// and the seam). A copy is a second derivation of lock identity that can
		// drift from the one the holder uses.
		const offenders = files
			.filter(({ code }) => code.includes(".indexing.lock"))
			.map(({ file }) => file);
		expect(offenders).toEqual(["src/core/store-location.ts"]);
	});

	test("`new IndexLock(` appears in lock.ts only: every store lock goes through createStoreLock", () => {
		const offenders = files
			.filter(({ code }) => /\bnew\s+IndexLock\s*\(/.test(code))
			.map(({ file }) => file);
		expect(offenders).toEqual(["src/core/lock.ts"]);
	});

	test("the project-path lock constructors are gone", () => {
		const offenders = files
			.filter(({ code }) => /\b(createIndexLock|fromLockPath)\b/.test(code))
			.map(({ file }) => file);
		expect(offenders).toEqual([]);
	});

	test("the sweep's comment stripper keeps code and drops prose", () => {
		expect(
			stripComments('// new IndexLock(x)\nconst a = ".indexing.lock";'),
		).toBe('\nconst a = ".indexing.lock";');
		expect(stripComments("/* new IndexLock(x) */ f();")).toBe(" f();");
		expect(stripComments('const url = "http://x"; // tail')).toBe(
			'const url = "http://x"; ',
		);
	});

	test("a directory named for a project is never where a store lock goes by default", () => {
		// Guard against the sweep above being satisfied by an unused lock.ts
		// while the store lock quietly moved somewhere else.
		const project = makeDir();
		mkdirSync(join(project, ".mnemex"));
		const loc = resolveStoreLocation(project);
		expect(createStoreLock(loc).path).toBe(
			join(loc.storeDir, ".indexing.lock"),
		);
	});
});
