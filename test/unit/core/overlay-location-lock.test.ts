/**
 * L-1, S-L and the overlay lock's ownership rules (step 3, R3.6, R3.7, R3.12).
 *
 * L-1 — two worktrees of one clone get two DISTINCT overlay directories, each
 * under its own worktree, never under the git common dir, and never under the
 * shared (`git-common-dir`) store. Built from REAL `git worktree add`, resolved
 * through the real seam (`resolveStoreLocation`).
 *
 * S-L — no file but `store-location.ts` spells an overlay path component.
 * See `test/helpers/overlay-path-sweep.ts` for the rules, and for why the
 * census is asserted before the silence.
 *
 * Lock — `createDirtyOverlayLock` is an `IndexLock` on the resolver's path;
 * `assertStillHeld()` throws once the lock file was replaced (a reclaim);
 * `processHoldsIndexLock()` counts held store/global locks and NOT overlay
 * locks (the embed-cache open rule depends on exactly that distinction).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import type { Parser } from "web-tree-sitter";
import {
	createDirtyOverlayLock,
	createGlobalIndexLock,
	createStoreLock,
	IndexLock,
	OverlayLockLostError,
	processHoldsIndexLock,
} from "../../../src/core/lock.js";
import {
	__resetStoreLocationCacheForTests,
	getDirtyOverlayDirFor,
	getDirtyOverlayLockPathFor,
	getDirtyOverlayManifestPathFor,
	getDirtyOverlayVectorsPathFor,
	getWorktreeDirFor,
	resolveStoreLocation,
} from "../../../src/core/store-location.js";
import { getParserManager } from "../../../src/parsers/parser-manager.js";
import {
	createGitSandbox,
	type GitSandbox,
} from "../../helpers/git-sandbox.js";
import {
	type SweepFile,
	sweepOverlayPaths,
} from "../../helpers/overlay-path-sweep.js";

const REPO = join(import.meta.dir, "..", "..", "..");

let box: GitSandbox;
let main: string;
let linked: string;

beforeAll(() => {
	box = createGitSandbox("mnemex-l1-");
	main = join(box.root, "main");
	linked = join(box.root, "linked");
	mkdirSync(main, { recursive: true });
	box.git(main, "init", "-q");
	writeFileSync(join(main, "a.ts"), "export const a = 1;\n");
	box.git(main, "add", "-A");
	box.git(main, "commit", "-q", "-m", "init");
	box.git(main, "worktree", "add", "-q", "-b", "feature", linked);
	__resetStoreLocationCacheForTests();
});

afterAll(() => {
	__resetStoreLocationCacheForTests();
	box.cleanup();
});

function isInside(child: string, parent: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
}

describe("L-1 — one overlay per worktree, never in the shared store (A)", () => {
	test("two worktrees: distinct dirs, each under its OWN worktree dir", () => {
		const a = resolveStoreLocation(main);
		const b = resolveStoreLocation(linked);
		// Precondition: the two DO share a store (step 2's D-1).
		expect(a.kind).toBe("git-common-dir");
		expect(a.storeDir).toBe(b.storeDir);

		const da = getDirtyOverlayDirFor(a);
		const db = getDirtyOverlayDirFor(b);
		expect(da).not.toBe(db);
		expect(da).toBe(join(getWorktreeDirFor(a), "dirty-overlay"));
		expect(db).toBe(join(getWorktreeDirFor(b), "dirty-overlay"));
		expect(isInside(da, realpathSync.native(main))).toBe(true);
		expect(isInside(db, realpathSync.native(linked))).toBe(true);
		for (const dir of [da, db]) {
			expect(isInside(dir, a.storeDir)).toBe(false);
			expect(isInside(dir, a.gitLayout?.gitCommonDir ?? "/nowhere")).toBe(
				false,
			);
		}
	});

	test("lock, vectors and manifest all live INSIDE the one overlay dir", () => {
		const loc = resolveStoreLocation(linked);
		const dir = getDirtyOverlayDirFor(loc);
		expect(getDirtyOverlayLockPathFor(loc)).toBe(join(dir, ".overlay.lock"));
		expect(getDirtyOverlayVectorsPathFor(loc)).toBe(join(dir, "vectors"));
		expect(getDirtyOverlayManifestPathFor(loc)).toBe(
			join(dir, "manifest.json"),
		);
		expect(createDirtyOverlayLock(loc).path).toBe(
			getDirtyOverlayLockPathFor(loc),
		);
	});
});

// ════════════════════════════════════════════════════════════════════════════

function sourceFiles(): SweepFile[] {
	const out: SweepFile[] = [];
	const walk = (dir: string) => {
		for (const e of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, e.name);
			if (e.isDirectory()) walk(full);
			else if (/\.tsx?$/.test(e.name) && !e.name.endsWith(".d.ts")) {
				out.push({
					path: relative(REPO, full),
					source: readFileSync(full, "utf8"),
				});
			}
		}
	};
	walk(join(REPO, "src"));
	return out;
}

let tsParser: Parser;
let tsxParser: Parser;
const parserFor = (path: string) =>
	path.endsWith(".tsx") ? tsxParser : tsParser;

describe("S-L — overlay path components are spelled in ONE file", () => {
	beforeAll(async () => {
		const manager = getParserManager();
		await manager.initialize();
		const ts = await manager.getParser("typescript");
		const tsx = await manager.getParser("tsx");
		if (!ts || !tsx)
			throw new Error("grammars missing: bun run download-grammars");
		tsParser = ts;
		tsxParser = tsx;
	});

	test("sight: every src file parsed, every line covered (CLAUDE.md #32)", () => {
		const { census } = sweepOverlayPaths(sourceFiles(), parserFor);
		console.log(
			`S-L census: files=${census.files} linesScanned=${census.linesScanned} fileLines=${census.fileLines} parseErrors=${census.parseErrors} errorLines=${census.errorLines} strings=${census.stringsScanned} moduleSpecifiersExempt=${census.moduleSpecifiersExempt} filesWithErrors=${census.filesWithErrors.length}`,
		);
		expect(census.files).toBeGreaterThan(300);
		expect(census.linesScanned).toBe(census.fileLines);
		expect(census.stringsScanned).toBeGreaterThan(10_000);
		// Grammar gaps exist (see the helper); they must stay a handful of
		// lines, each re-read as raw text. A jump here means the grammar lost
		// sight of real code and the fallback is now doing the sweep's job.
		expect(census.errorLines).toBeLessThan(200);
	});

	test("planted INSIDE a parse-error span still fires (the raw fallback)", () => {
		// `export type *` is one of the measured grammar gaps.
		const planted: SweepFile = {
			path: "src/core/doctor/index.ts",
			source: 'export type * from "./types.js"; const d = "dirty-overlay";\n',
		};
		const { findings, census } = sweepOverlayPaths([planted], parserFor);
		expect(census.errorLines).toBeGreaterThan(0);
		expect(findings.map((f) => `${f.rule}:${f.line}`)).toEqual(["SL-name:1"]);
	});

	test("planted: a hand-built overlay path anywhere in src fires SL-name", () => {
		const planted: SweepFile = {
			path: "src/core/indexer.ts",
			source: `const a = s.replace(/'/g, "''");\nconst d = join(projectPath, ".mnemex", "dirty-overlay");\n`,
		};
		const { findings } = sweepOverlayPaths([planted], parserFor);
		expect(findings.map((f) => `${f.rule}:${f.line}`)).toEqual(["SL-name:2"]);
	});

	test("planted: a template-literal lock path fires SL-name", () => {
		const planted: SweepFile = {
			path: "src/mcp/tools/search.ts",
			// A template literal in the fixture source, built so the test file
			// itself holds no `${…}` inside a plain string.
			source: `const p = \`$\{dir}/.overlay.lock\`;\n`,
		};
		expect(
			sweepOverlayPaths([planted], parserFor).findings.map((f) => f.rule),
		).toEqual(["SL-name"]);
	});

	test("planted: the overlay module joining its own components fires SL-overlay", () => {
		const planted: SweepFile = {
			path: "src/core/overlay/dirty-overlay.ts",
			source:
				'const m = join(dir, "manifest.json");\nconst v = join(root, ".mnemex", "x");\n',
		};
		expect(
			sweepOverlayPaths([planted], parserFor).findings.map(
				(f) => `${f.rule}:${f.text}`,
			),
		).toEqual(["SL-overlay:manifest.json", "SL-overlay:.mnemex"]);
	});

	test("planted at the END of the real resolver's neighbour fires", () => {
		const files = sourceFiles();
		const lock = files.find((f) => f.path === "src/core/lock.ts");
		if (!lock) throw new Error("lock.ts not found");
		const mutated = {
			...lock,
			source: `${lock.source}\nconst x = "dirty-overlay";\n`,
		};
		const { findings } = sweepOverlayPaths([mutated], parserFor);
		expect(findings).toHaveLength(1);
		expect(findings[0].file).toBe("src/core/lock.ts");
	});

	test("a MODULE SPECIFIER naming the overlay module is exempt; the same string as data still fires", () => {
		// Phase 6: `indexer.ts` imports `./overlay/dirty-overlay.js`. That is a
		// module name, not a path to the overlay's data. Exempt by POSITION.
		const planted: SweepFile = {
			path: "src/core/indexer.ts",
			source: [
				'import { prepareDirtyOverlay } from "./overlay/dirty-overlay.js";',
				'export { resolveOverlayGate } from "./overlay/dirty-overlay.js";',
				'const lazy = await import("./overlay/dirty-overlay.js");',
				'const data = join(root, "./overlay/dirty-overlay.js");',
				"",
			].join("\n"),
		};
		const { findings, census } = sweepOverlayPaths([planted], parserFor);
		expect(census.moduleSpecifiersExempt).toBe(3);
		expect(findings.map((f) => `${f.rule}:${f.line}`)).toEqual(["SL-name:4"]);
	});

	test("the real tree: no findings", () => {
		expect(sweepOverlayPaths(sourceFiles(), parserFor).findings).toEqual([]);
	});
});

// ════════════════════════════════════════════════════════════════════════════

describe("the overlay lock — ownership and the index-lock count", () => {
	test("assertStillHeld passes while held, throws once the file was replaced", async () => {
		const loc = resolveStoreLocation(main);
		const lock = createDirtyOverlayLock(loc);
		expect((await lock.acquire({ waitTimeout: 0 })).acquired).toBe(true);
		try {
			lock.assertStillHeld();
			// A reclaim: the name now points at another holder's file.
			unlinkSync(lock.path);
			writeFileSync(lock.path, '{"pid":1,"token":"someone-else"}');
			expect(() => lock.assertStillHeld()).toThrow(OverlayLockLostError);
		} finally {
			lock.release();
		}
		// release() did not remove the other holder's file.
		expect(readFileSync(lock.path, "utf8")).toContain("someone-else");
		rmSync(lock.path);
	});

	test("assertStillHeld on a lock that is not held throws", () => {
		const lock = createDirtyOverlayLock(resolveStoreLocation(main));
		expect(() => lock.assertStillHeld()).toThrow(OverlayLockLostError);
	});

	test("processHoldsIndexLock counts store/global locks, never overlay locks", async () => {
		const loc = resolveStoreLocation(main);
		expect(processHoldsIndexLock()).toBe(false);

		const overlay = createDirtyOverlayLock(loc);
		expect((await overlay.acquire({ waitTimeout: 0 })).acquired).toBe(true);
		expect(processHoldsIndexLock()).toBe(false);

		const store = createStoreLock(loc);
		expect((await store.acquire({ waitTimeout: 0 })).acquired).toBe(true);
		expect(processHoldsIndexLock()).toBe(true);
		store.release();
		expect(processHoldsIndexLock()).toBe(false);
		store.release(); // idempotent: never goes negative
		expect(processHoldsIndexLock()).toBe(false);

		const prev = process.env.MNEMEX_GLOBAL_LOCK_PATH;
		process.env.MNEMEX_GLOBAL_LOCK_PATH = join(box.root, "global.lock");
		try {
			const global = createGlobalIndexLock();
			expect((await global.acquire({ waitTimeout: 0 })).acquired).toBe(true);
			expect(processHoldsIndexLock()).toBe(true);
			global.release();
		} finally {
			if (prev === undefined) delete process.env.MNEMEX_GLOBAL_LOCK_PATH;
			else process.env.MNEMEX_GLOBAL_LOCK_PATH = prev;
		}
		expect(processHoldsIndexLock()).toBe(false);

		// A bare IndexLock (tests, tools) counts as an index lock: the safe side.
		const bare = new IndexLock(join(box.root, "bare.lock"));
		expect((await bare.acquire({ waitTimeout: 0 })).acquired).toBe(true);
		expect(processHoldsIndexLock()).toBe(true);
		bare.release();
		overlay.release();
		expect(processHoldsIndexLock()).toBe(false);
	});
});
