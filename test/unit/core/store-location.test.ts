/**
 * `resolveStoreLocation` — the seam's precedence, D2, FR-7 and memoization
 * (architecture §2.3, §2.5, §8 Phase 1).
 *
 * Constructed `.git` shapes (test/helpers/git-shapes.ts) in a temp directory.
 * The real-git version of the worktree case lives in git-layout-real-git.test.ts.
 *
 * `MNEMEX_INDEX_DIR` is removed before every test and restored after, and the
 * memo is reset, so no test sees another's resolution.
 *
 * Row 3 is GATED (§8): `resolveStoreLocation` uses the pre-3c scope
 * `"worktree"`, so the git-common-dir behaviour is exercised through the pure
 * `pickStoreDir(readStoreInputs(p), "git-common-dir")`. That keeps 3c's
 * one-line flip covered by a passing test before 3c exists, with no setter on
 * the production default.
 *
 * Each test states the edit to `src/core/store-location.ts` that turns it red.
 */

import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getIndexDir, saveProjectConfig } from "../../../src/config.js";
import {
	__resetStoreLocationCacheForTests,
	GIT_STORE_DIR_NAME,
	getBranchRegistryPathFor,
	getDocsCachePathFor,
	getIndexDbPathFor,
	getLockPathFor,
	getStoreMetaPathFor,
	getVectorStorePathFor,
	INDEX_DIR_ENV_VAR,
	LEGACY_DEFAULT_INDEX_DIR,
	pickStoreDir,
	readStoreInputs,
	resolveStoreLocation,
	STORE_LOCATION_CACHE_MAX,
	type StoreKind,
	type StoreLocation,
	type StoreScope,
} from "../../../src/core/store-location.js";
import {
	makeBareRepo,
	makeDanglingWorktree,
	makeLinkedWorktree,
	makeMainRepo,
	makeSubmodule,
} from "../../helpers/git-shapes.js";

let root: string;
let counter = 0;
let savedEnv: string | undefined;

function freshDir(): string {
	counter += 1;
	const dir = join(root, `case-${counter}`);
	mkdirSync(dir);
	return dir;
}

function writeRootConfig(dir: string, config: unknown): void {
	writeFileSync(join(dir, "mnemex.json"), JSON.stringify(config));
}

function writeDotConfig(dir: string, config: unknown): void {
	mkdirSync(join(dir, ".mnemex"), { recursive: true });
	writeFileSync(join(dir, ".mnemex", "config.json"), JSON.stringify(config));
}

/** The precedence under an explicit scope, unmemoized. */
function at(path: string, scope: StoreScope): StoreLocation {
	return pickStoreDir(readStoreInputs(path), scope);
}

const SCOPES: readonly StoreScope[] = ["worktree", "git-common-dir"];

/** What row 3 yields inside a repository with no override, per scope. */
const ROW3_KIND: Record<StoreScope, StoreKind> = {
	worktree: "worktree-local",
	"git-common-dir": "git-common-dir",
};

/** The six config shapes a directory can have, for parity with `getIndexDir`. */
const CONFIG_VARIANTS: Array<[string, (dir: string) => void]> = [
	["no project config", () => {}],
	[
		"a relative indexDir in mnemex.json",
		(d) => writeRootConfig(d, { indexDir: "custom/idx" }),
	],
	[
		"an absolute indexDir in mnemex.json",
		(d) => writeRootConfig(d, { indexDir: join(d, "abs-idx") }),
	],
	[
		"a relative indexDir in .mnemex/config.json",
		(d) => writeDotConfig(d, { indexDir: "idx2" }),
	],
	[
		"the literal legacy default (D2 is behaviour-neutral here)",
		(d) => writeRootConfig(d, { indexDir: ".mnemex" }),
	],
	[
		"a near-miss of the legacy default",
		(d) => writeRootConfig(d, { indexDir: "./.mnemex" }),
	],
];

beforeAll(() => {
	root = realpathSync.native(mkdtempSync(join(tmpdir(), "mnemex-store-loc-")));
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
	savedEnv = process.env[INDEX_DIR_ENV_VAR];
	delete process.env[INDEX_DIR_ENV_VAR];
	__resetStoreLocationCacheForTests();
});

afterEach(() => {
	if (savedEnv === undefined) delete process.env[INDEX_DIR_ENV_VAR];
	else process.env[INDEX_DIR_ENV_VAR] = savedEnv;
	__resetStoreLocationCacheForTests();
});

describe("row 4 — outside any repository, today's behaviour (FR-7)", () => {
	test("a plain directory keeps its store in <dir>/.mnemex, and nothing is degraded", () => {
		// Falsified by: any change to row 4's path, or reporting a degraded
		// reason for the ordinary non-git case.
		const dir = freshDir();
		expect(resolveStoreLocation(dir)).toEqual({
			storeDir: join(dir, ".mnemex"),
			worktreeDir: join(dir, ".mnemex"),
			pathRoot: dir,
			kind: "plain-directory",
			gitLayout: null,
			degradedReason: null,
			ignoredLegacyIndexDir: false,
			envIndexDir: undefined,
		});
	});

	// The strongest form of "falls back to today's behaviour": the seam and the
	// production resolver it will replace, `getIndexDir` in src/config.ts, agree
	// on every config shape a non-git directory can have. (The env override is
	// excluded because `getIndexDir` has never read it.)
	for (const [label, setup] of CONFIG_VARIANTS) {
		test(`agrees with today's getIndexDir: ${label}`, () => {
			// Falsified by: changing row 4, or resolving a relative override
			// against anything but the directory — the two answers then differ.
			const dir = freshDir();
			setup(dir);
			expect(resolveStoreLocation(dir).storeDir).toBe(getIndexDir(dir));
		});
	}
});

describe("row 3 is GATED — the pre-3c default keeps the store per worktree (§8 Phase 2)", () => {
	test("main worktree, no override: today's getIndexDir, kind worktree-local", () => {
		// The Phase 2 promise: wiring a caller to the seam moves no store.
		// Falsified by: flipping STORE_SCOPE_DEFAULT to "git-common-dir" before
		// 3c — storeDir becomes <root>/.git/mnemex and kind "git-common-dir".
		const main = makeMainRepo(join(freshDir(), "main"));
		const loc = resolveStoreLocation(main.worktree);
		expect(loc.kind).toBe("worktree-local");
		expect(loc.storeDir).toBe(getIndexDir(main.worktree));
		expect(loc.storeDir).toBe(join(main.worktree, ".mnemex"));
		// Step 1 still ran: the layout and pathRoot are those of the repository.
		expect(loc.worktreeDir).toBe(join(main.worktree, ".mnemex"));
		expect(loc.pathRoot).toBe(main.worktree);
		expect(loc.gitLayout?.gitCommonDir).toBe(main.gitDir);
		expect(loc.degradedReason).toBeNull();
	});

	test("a linked worktree keeps its OWN store, as it does today", () => {
		// Falsified by: the flip above — both worktrees then share one storeDir.
		const dir = freshDir();
		const main = makeMainRepo(join(dir, "main"));
		const wt = makeLinkedWorktree(main, join(dir, "wt"));
		const a = resolveStoreLocation(main.worktree);
		const b = resolveStoreLocation(wt.worktree);
		expect(b.kind).toBe("worktree-local");
		expect(a.storeDir).toBe(getIndexDir(main.worktree));
		expect(b.storeDir).toBe(getIndexDir(wt.worktree));
		expect(b.storeDir).not.toBe(a.storeDir);
	});

	test("from a subdirectory: the store is <subdir>/.mnemex like getIndexDir(<subdir>), pathRoot is the root", () => {
		// Row 4's formula, deliberately (see pickStoreDir). Falsified by: building
		// the worktree-local store from pathRoot — it then differs from today's
		// getIndexDir for any caller that passes a subdirectory.
		const main = makeMainRepo(join(freshDir(), "main"));
		const sub = join(main.worktree, "src", "core");
		mkdirSync(sub, { recursive: true });
		const loc = resolveStoreLocation(sub);
		expect(loc.kind).toBe("worktree-local");
		expect(loc.storeDir).toBe(getIndexDir(sub));
		expect(loc.pathRoot).toBe(main.worktree);
	});

	for (const [label, setup] of CONFIG_VARIANTS) {
		test(`inside a repository, agrees with today's getIndexDir: ${label}`, () => {
			// The same parity table as row 4, inside a repository. Falsified by: the
			// flip (the no-config and legacy-default cases move under .git), or by
			// any change to how rows 1-2 resolve a relative value.
			const main = makeMainRepo(join(freshDir(), "main"));
			setup(main.worktree);
			expect(resolveStoreLocation(main.worktree).storeDir).toBe(
				getIndexDir(main.worktree),
			);
		});
	}

	test("resolveStoreLocation IS pickStoreDir under the worktree scope", () => {
		const dir = freshDir();
		const main = makeMainRepo(join(dir, "main"));
		const wt = makeLinkedWorktree(main, join(dir, "wt"));
		for (const p of [main.worktree, wt.worktree, dir]) {
			expect(resolveStoreLocation(p)).toEqual(at(p, "worktree"));
		}
	});
});

describe("row 3 under the git-common-dir scope — what 3c turns on (via pickStoreDir)", () => {
	test("main worktree: store under .git/mnemex, per-worktree dir under the root", () => {
		// Falsified by: returning plain-directory for a repository (row 3 skipped).
		const main = makeMainRepo(join(freshDir(), "main"));
		const loc = at(main.worktree, "git-common-dir");
		expect(loc.kind).toBe("git-common-dir");
		expect(loc.storeDir).toBe(join(main.gitDir, GIT_STORE_DIR_NAME));
		expect(loc.worktreeDir).toBe(join(main.worktree, ".mnemex"));
		expect(loc.pathRoot).toBe(main.worktree);
		expect(loc.gitLayout?.gitCommonDir).toBe(main.gitDir);
		expect(loc.degradedReason).toBeNull();
	});

	test("a linked worktree shares the main checkout's storeDir, and keeps its own worktreeDir", () => {
		// Falsified by: building row 3 from gitDir instead of gitCommonDir — the
		// two storeDirs then differ, which is today's per-worktree split.
		const dir = freshDir();
		const main = makeMainRepo(join(dir, "main"));
		const wt = makeLinkedWorktree(main, join(dir, "wt"));

		const a = at(main.worktree, "git-common-dir");
		const b = at(wt.worktree, "git-common-dir");
		expect(b.storeDir).toBe(a.storeDir);
		expect(b.worktreeDir).toBe(join(wt.worktree, ".mnemex"));
		expect(b.worktreeDir).not.toBe(a.worktreeDir);
		expect(b.pathRoot).toBe(wt.worktree);
	});

	test("from a subdirectory, pathRoot is the worktree root, not the start path", () => {
		// Falsified by: pathRoot = startPath inside a repository — stored paths
		// would then be relative to wherever the command happened to run.
		const main = makeMainRepo(join(freshDir(), "main"));
		const sub = join(main.worktree, "src", "core");
		mkdirSync(sub, { recursive: true });
		const loc = at(sub, "git-common-dir");
		expect(loc.pathRoot).toBe(main.worktree);
		expect(loc.worktreeDir).toBe(join(main.worktree, ".mnemex"));
		expect(loc.storeDir).toBe(join(main.gitDir, GIT_STORE_DIR_NAME));
	});

	test("a bare repository keeps its store inside itself", () => {
		// Falsified by: losing the bare-repo branch in readGitLayout — the store
		// then falls through to row 4 as <bare>/.mnemex.
		const bare = makeBareRepo(join(freshDir(), "bare.git"));
		const loc = at(bare.worktree, "git-common-dir");
		expect(loc.kind).toBe("git-common-dir");
		expect(loc.storeDir).toBe(join(bare.gitDir, GIT_STORE_DIR_NAME));
	});

	test("a submodule's store lands in its own module dir, not the superproject's", () => {
		// Falsified by: resolving the superproject's common dir for a `.git` file.
		const superRepo = makeMainRepo(join(freshDir(), "super"));
		const sub = makeSubmodule(superRepo, join("libs", "sub"));
		expect(at(sub.worktree, "git-common-dir").storeDir).toBe(
			join(sub.gitDir, GIT_STORE_DIR_NAME),
		);
		expect(at(superRepo.worktree, "git-common-dir").storeDir).toBe(
			join(superRepo.gitDir, GIT_STORE_DIR_NAME),
		);
	});

	test("a dangling gitdir falls back to row 4 under EITHER scope, and reports why", () => {
		// Falsified by: dropping degradedReason from the location — `doctor`
		// could then not explain why this worktree is not sharing a store.
		const dir = freshDir();
		const missing = join(dir, "gone", "worktrees", "wt");
		const wt = join(dir, "wt");
		makeDanglingWorktree(wt, missing);
		expect(at(wt, "worktree")).toEqual(at(wt, "git-common-dir"));
		expect(at(wt, "git-common-dir")).toEqual({
			storeDir: join(wt, ".mnemex"),
			worktreeDir: join(wt, ".mnemex"),
			pathRoot: wt,
			kind: "plain-directory",
			gitLayout: null,
			degradedReason: `gitdir-missing:${missing}`,
			ignoredLegacyIndexDir: false,
			envIndexDir: undefined,
		});
	});
});

describe("rows 1-2 — overrides relocate the store, never pathRoot", () => {
	test("MNEMEX_INDEX_DIR, absolute: used as-is", () => {
		// Falsified by: joining an absolute value onto pathRoot (the double-join
		// that `src/mcp/config.ts` does today).
		const main = makeMainRepo(join(freshDir(), "main"));
		const target = join(root, "elsewhere-abs");
		process.env[INDEX_DIR_ENV_VAR] = target;
		const loc = resolveStoreLocation(main.worktree);
		expect(loc.kind).toBe("env-override");
		expect(loc.storeDir).toBe(target);
		expect(loc.pathRoot).toBe(main.worktree);
	});

	test("MNEMEX_INDEX_DIR, relative: joined onto the WORKTREE ROOT, even from a subdirectory", () => {
		// Falsified by: resolving against the start path — the store would move
		// with the command's cwd.
		const main = makeMainRepo(join(freshDir(), "main"));
		const sub = join(main.worktree, "pkg");
		mkdirSync(sub);
		process.env[INDEX_DIR_ENV_VAR] = "custom-store";
		const loc = resolveStoreLocation(sub);
		expect(loc.storeDir).toBe(join(main.worktree, "custom-store"));
		expect(loc.pathRoot).toBe(main.worktree);
	});

	test("MNEMEX_INDEX_DIR beats ProjectConfig.indexDir", () => {
		// Falsified by: swapping rows 1 and 2.
		const main = makeMainRepo(join(freshDir(), "main"));
		writeRootConfig(main.worktree, { indexDir: "from-config" });
		process.env[INDEX_DIR_ENV_VAR] = "from-env";
		expect(resolveStoreLocation(main.worktree).storeDir).toBe(
			join(main.worktree, "from-env"),
		);
	});

	test("an empty MNEMEX_INDEX_DIR is unset, under either scope", () => {
		// Falsified by: treating "" as a relative path — storeDir would become
		// the worktree root itself.
		const main = makeMainRepo(join(freshDir(), "main"));
		process.env[INDEX_DIR_ENV_VAR] = "";
		for (const scope of SCOPES) {
			expect(at(main.worktree, scope).kind).toBe(ROW3_KIND[scope]);
		}
	});

	test("rows 1 and 2 are the same under both scopes: the scope gates row 3 only", () => {
		// Falsified by: consulting the scope before the overrides — an override
		// user's store would then move in 3c.
		const main = makeMainRepo(join(freshDir(), "main"));
		writeRootConfig(main.worktree, { indexDir: "cfg-store" });
		expect(at(main.worktree, "worktree")).toEqual(
			at(main.worktree, "git-common-dir"),
		);
		expect(at(main.worktree, "worktree").kind).toBe("config-override");

		process.env[INDEX_DIR_ENV_VAR] = join(root, "env-store");
		expect(at(main.worktree, "worktree")).toEqual(
			at(main.worktree, "git-common-dir"),
		);
		expect(at(main.worktree, "worktree").kind).toBe("env-override");
	});

	test("ProjectConfig.indexDir from mnemex.json, read at the worktree root from a subdirectory", () => {
		// Falsified by: reading project config at the start path — the subdir
		// has no mnemex.json, so the override would be missed.
		const main = makeMainRepo(join(freshDir(), "main"));
		writeRootConfig(main.worktree, { indexDir: "cfg-store" });
		const sub = join(main.worktree, "deep");
		mkdirSync(sub);
		const loc = resolveStoreLocation(sub);
		expect(loc.kind).toBe("config-override");
		expect(loc.storeDir).toBe(join(main.worktree, "cfg-store"));
		expect(loc.ignoredLegacyIndexDir).toBe(false);
	});

	test("ProjectConfig.indexDir from <worktreeDir>/config.json, and mnemex.json wins over it", () => {
		// Falsified by: reversing the two config files' precedence.
		const main = makeMainRepo(join(freshDir(), "main"));
		writeDotConfig(main.worktree, { indexDir: "dot-store" });
		expect(resolveStoreLocation(main.worktree).storeDir).toBe(
			join(main.worktree, "dot-store"),
		);

		__resetStoreLocationCacheForTests();
		writeRootConfig(main.worktree, { indexDir: "root-store" });
		expect(resolveStoreLocation(main.worktree).storeDir).toBe(
			join(main.worktree, "root-store"),
		);
	});

	test("an absolute ProjectConfig.indexDir is used as-is", () => {
		const main = makeMainRepo(join(freshDir(), "main"));
		const target = join(root, "cfg-abs");
		writeRootConfig(main.worktree, { indexDir: target });
		expect(resolveStoreLocation(main.worktree).storeDir).toBe(target);
	});

	test("a non-string indexDir in a hand-edited file is ignored, not thrown on", () => {
		// Falsified by: calling string methods on the value unchecked, as
		// `getIndexDir` does (`.startsWith` on a number throws).
		for (const indexDir of [5, null, [], {}, true]) {
			const main = makeMainRepo(join(freshDir(), "main"));
			writeRootConfig(main.worktree, { indexDir });
			for (const scope of SCOPES) {
				const loc = at(main.worktree, scope);
				expect(loc.kind).toBe(ROW3_KIND[scope]);
				expect(loc.ignoredLegacyIndexDir).toBe(false);
			}
			expect(() => resolveStoreLocation(main.worktree)).not.toThrow();
		}
	});
});

describe("envIndexDir — MNEMEX_INDEX_DIR as read, so the seam stays its ONE reader (I-8, I-9)", () => {
	test("holds the raw value, unnormalised: absolute, relative and unset", () => {
		// Falsified by: filling envIndexDir from anything but inputs.envIndexDir
		// (normalize, resolve or realpath it, or copy storeDir). I-9 rebuilds
		// HEAD's legacy path as `join(workspaceRoot, raw)`, so a rewritten value
		// names a directory HEAD never wrote.
		const main = makeMainRepo(join(freshDir(), "main"));
		const sub = join(main.worktree, "pkg");
		mkdirSync(sub);
		// Through a symlink, with `..`, a doubled and a trailing slash: realpath,
		// normalize and resolve would each change this string.
		const real = join(root, "env-raw-target");
		mkdirSync(real);
		const link = join(root, "env-raw-link");
		symlinkSync(real, link);
		const cases: Array<[string, string | undefined]> = [
			["absolute", `${link}/x/..//`],
			["relative", "./custom//store/"],
			["unset", undefined],
		];
		for (const [label, raw] of cases) {
			if (raw === undefined) delete process.env[INDEX_DIR_ENV_VAR];
			else process.env[INDEX_DIR_ENV_VAR] = raw;
			const loc = resolveStoreLocation(sub);
			expect([label, loc.envIndexDir]).toStrictEqual([label, raw]);
			expect(Object.isFrozen(loc)).toBe(true);
		}

		// Two spellings of one directory: one storeDir, and each memoized
		// location still reports its OWN spelling (the memo key is the raw value).
		process.env[INDEX_DIR_ENV_VAR] = "custom-store";
		const plain = resolveStoreLocation(sub);
		process.env[INDEX_DIR_ENV_VAR] = "./custom-store";
		const dotted = resolveStoreLocation(sub);
		expect(dotted.storeDir).toBe(plain.storeDir);
		expect([plain.envIndexDir, dotted.envIndexDir]).toEqual([
			"custom-store",
			"./custom-store",
		]);
	});
});

describe("D2 — the literal legacy default is ignored, and ONLY the literal (V1.9)", () => {
	test(`the constant is exactly ${JSON.stringify(LEGACY_DEFAULT_INDEX_DIR)}`, () => {
		// Pins the magic string itself. Falsified by: editing the constant.
		expect(LEGACY_DEFAULT_INDEX_DIR).toBe(".mnemex");
	});

	test('indexDir ".mnemex" inside a repository is treated as unset under the 3c scope, and says so', () => {
		// Falsified by: honouring the literal — the store would stay per
		// worktree and FR-1 would silently not apply to this user.
		const main = makeMainRepo(join(freshDir(), "main"));
		writeRootConfig(main.worktree, { indexDir: ".mnemex" });
		const loc = at(main.worktree, "git-common-dir");
		expect(loc.kind).toBe("git-common-dir");
		expect(loc.storeDir).toBe(join(main.gitDir, GIT_STORE_DIR_NAME));
		expect(loc.ignoredLegacyIndexDir).toBe(true);
	});

	test('indexDir ".mnemex" inside a repository, pre-3c: the same directory as today, and flagged', () => {
		// Before 3c, ignoring the literal and honouring it name one directory, so
		// D2 is behaviour-neutral until the flip. The flag is set regardless, so
		// `doctor` can warn ahead of the release that changes it.
		const main = makeMainRepo(join(freshDir(), "main"));
		writeRootConfig(main.worktree, { indexDir: ".mnemex" });
		const loc = resolveStoreLocation(main.worktree);
		expect(loc.kind).toBe("worktree-local");
		expect(loc.storeDir).toBe(getIndexDir(main.worktree));
		expect(loc.ignoredLegacyIndexDir).toBe(true);
	});

	test('indexDir ".mnemex" outside a repository: same directory as today, and flagged', () => {
		const dir = freshDir();
		writeRootConfig(dir, { indexDir: ".mnemex" });
		const loc = resolveStoreLocation(dir);
		expect(loc.kind).toBe("plain-directory");
		expect(loc.storeDir).toBe(join(dir, ".mnemex"));
		expect(loc.ignoredLegacyIndexDir).toBe(true);
	});

	// N25: the accepted weakness of a magic string, pinned as documented
	// behaviour rather than left to be discovered. These still split the store.
	const nearMisses = ["./.mnemex", ".mnemex/", "\\.mnemex", ".\\.mnemex"];
	for (const value of nearMisses) {
		test(`near miss ${JSON.stringify(value)} is HONOURED as an override`, () => {
			// Falsified by: normalising before comparing — "./.mnemex" and
			// ".mnemex/" then flip to ignored.
			const main = makeMainRepo(join(freshDir(), "main"));
			writeRootConfig(main.worktree, { indexDir: value });
			const loc = resolveStoreLocation(main.worktree);
			expect(loc.kind).toBe("config-override");
			expect(loc.storeDir).toBe(join(main.worktree, value));
			expect(loc.ignoredLegacyIndexDir).toBe(false);
		});
	}

	test("when MNEMEX_INDEX_DIR wins, the config is not consulted and nothing is flagged", () => {
		// The flag means "D2 ignored this value". With the env override set, the
		// config value was outranked, not ignored under D2.
		const main = makeMainRepo(join(freshDir(), "main"));
		writeRootConfig(main.worktree, { indexDir: ".mnemex" });
		process.env[INDEX_DIR_ENV_VAR] = "env-store";
		const loc = resolveStoreLocation(main.worktree);
		expect(loc.kind).toBe("env-override");
		expect(loc.ignoredLegacyIndexDir).toBe(false);
	});
});

describe("memoization (§2.5)", () => {
	test("one frozen object per real path, whatever the spelling", () => {
		// Falsified by: keying the memo on the caller's spelling (the symlink
		// then misses), or not freezing (a caller could corrupt everyone's answer).
		const dir = freshDir();
		const main = makeMainRepo(join(dir, "main"));
		const link = join(dir, "link");
		symlinkSync(main.worktree, link);

		const a = resolveStoreLocation(main.worktree);
		expect(resolveStoreLocation(main.worktree)).toBe(a);
		expect(resolveStoreLocation(link)).toBe(a);
		expect(resolveStoreLocation(`${main.worktree}/./`)).toBe(a);
		expect(Object.isFrozen(a)).toBe(true);
		expect(Object.isFrozen(a.gitLayout)).toBe(true);
	});

	test("the reset seam drops the memo", () => {
		const main = makeMainRepo(join(freshDir(), "main"));
		const a = resolveStoreLocation(main.worktree);
		__resetStoreLocationCacheForTests();
		const b = resolveStoreLocation(main.worktree);
		expect(b).not.toBe(a);
		expect(b).toEqual(a);
	});

	test(`FIFO eviction at STORE_LOCATION_CACHE_MAX (${STORE_LOCATION_CACHE_MAX})`, () => {
		// Falsified by: removing the eviction (the first entry survives the
		// 65th insert) or evicting at the wrong size (it goes early).
		const base = freshDir();
		const paths = Array.from(
			{ length: STORE_LOCATION_CACHE_MAX + 1 },
			(_, i) => {
				const p = join(base, `p${i}`);
				mkdirSync(p);
				return p;
			},
		);
		const first = resolveStoreLocation(paths[0] as string);
		for (const p of paths.slice(1, STORE_LOCATION_CACHE_MAX)) {
			resolveStoreLocation(p);
		}
		// Exactly full: the first entry is still cached.
		expect(resolveStoreLocation(paths[0] as string)).toBe(first);
		const last = resolveStoreLocation(
			paths[STORE_LOCATION_CACHE_MAX - 1] as string,
		);
		// One more distinct path evicts the OLDEST insert, which is the first.
		resolveStoreLocation(paths[STORE_LOCATION_CACHE_MAX] as string);
		expect(resolveStoreLocation(paths[0] as string)).not.toBe(first);
		expect(
			resolveStoreLocation(paths[STORE_LOCATION_CACHE_MAX - 1] as string),
		).toBe(last);
	});
});

describe("the memo is never staler than today's unmemoized getIndexDir for what THIS process changes", () => {
	test("a changed MNEMEX_INDEX_DIR is seen by the next resolution (set → changed → unset → set)", () => {
		// Falsified by: keying the memo on realpath alone — the second
		// resolution then returns the first value's cached location.
		const original = process.env[INDEX_DIR_ENV_VAR];
		const main = makeMainRepo(join(freshDir(), "main"));
		const first = join(root, "env-first");
		const second = join(root, "env-second");
		try {
			process.env[INDEX_DIR_ENV_VAR] = first;
			const a = resolveStoreLocation(main.worktree);
			expect(a.storeDir).toBe(first);
			// Not vacuous: an unchanged value IS served from the memo.
			expect(resolveStoreLocation(main.worktree)).toBe(a);

			process.env[INDEX_DIR_ENV_VAR] = second;
			expect(resolveStoreLocation(main.worktree).storeDir).toBe(second);

			delete process.env[INDEX_DIR_ENV_VAR];
			const unset = resolveStoreLocation(main.worktree);
			expect(unset.kind).toBe("worktree-local");
			expect(unset.storeDir).toBe(getIndexDir(main.worktree));

			process.env[INDEX_DIR_ENV_VAR] = first;
			expect(resolveStoreLocation(main.worktree).storeDir).toBe(first);
		} finally {
			if (original === undefined) delete process.env[INDEX_DIR_ENV_VAR];
			else process.env[INDEX_DIR_ENV_VAR] = original;
		}
	});

	test("an empty MNEMEX_INDEX_DIR and an unset one are separate keys that resolve alike", () => {
		const original = process.env[INDEX_DIR_ENV_VAR];
		const main = makeMainRepo(join(freshDir(), "main"));
		try {
			delete process.env[INDEX_DIR_ENV_VAR];
			const unset = resolveStoreLocation(main.worktree);
			process.env[INDEX_DIR_ENV_VAR] = "";
			const empty = resolveStoreLocation(main.worktree);
			// Alike in every derived field. They differ only in envIndexDir, which
			// reports the input as read, not the decision made from it.
			const { envIndexDir: emptyRaw, ...emptyDerived } = empty;
			const { envIndexDir: unsetRaw, ...unsetDerived } = unset;
			expect(emptyDerived).toEqual(unsetDerived);
			expect(emptyRaw).toBe("");
			expect(unsetRaw).toBeUndefined();
		} finally {
			if (original === undefined) delete process.env[INDEX_DIR_ENV_VAR];
			else process.env[INDEX_DIR_ENV_VAR] = original;
		}
	});

	test("saveProjectConfig({ indexDir }) in the same process is seen by the next resolution", () => {
		// The Phase 2 regression this closes: once getIndexDir delegates here,
		// `saveProjectConfig({ indexDir })` then `getIndexDir` must return the
		// NEW directory, as it does today. Falsified by: removing
		// `onProjectConfigSaved(clearLocationCache)` from store-location.ts.
		const main = makeMainRepo(join(freshDir(), "main"));
		const before = resolveStoreLocation(main.worktree);
		expect(before.kind).toBe("worktree-local");
		// Not vacuous: the first answer IS memoized.
		expect(resolveStoreLocation(main.worktree)).toBe(before);

		const target = join(root, "saved-idx");
		saveProjectConfig(main.worktree, { indexDir: target });
		const after = resolveStoreLocation(main.worktree);
		expect(after.kind).toBe("config-override");
		expect(after.storeDir).toBe(target);
		expect(after.storeDir).toBe(getIndexDir(main.worktree));
	});

	test("a second in-process save is seen too (the listener stays registered)", () => {
		// Falsified by: a one-shot registration, or a listener that unsubscribes
		// itself after the first save.
		const dir = freshDir();
		saveProjectConfig(dir, { indexDir: "one" });
		expect(resolveStoreLocation(dir).storeDir).toBe(join(dir, "one"));
		saveProjectConfig(dir, { indexDir: "two" });
		expect(resolveStoreLocation(dir).storeDir).toBe(join(dir, "two"));
	});
});

describe("path helpers — everything store-scoped is under storeDir (§2.4)", () => {
	test("each helper names its file under storeDir", () => {
		// Falsified by: any helper built from worktreeDir or pathRoot — the lock,
		// in particular, must follow the data it guards (FR-2).
		const main = makeMainRepo(join(freshDir(), "main"));
		const loc = resolveStoreLocation(main.worktree);
		expect(getIndexDbPathFor(loc)).toBe(join(loc.storeDir, "index.db"));
		expect(getVectorStorePathFor(loc)).toBe(join(loc.storeDir, "vectors"));
		expect(getLockPathFor(loc)).toBe(join(loc.storeDir, ".indexing.lock"));
		expect(getDocsCachePathFor(loc)).toBe(join(loc.storeDir, "docs-cache"));
		expect(getStoreMetaPathFor(loc)).toBe(join(loc.storeDir, "store.json"));
		expect(getBranchRegistryPathFor(loc)).toBe(
			join(loc.storeDir, "branches.json"),
		);
	});
});

describe("never throws", () => {
	test("nonexistent, empty and NUL-bearing start paths all resolve to a location", () => {
		// Falsified by: removing the realpath fallback in canonicalStartPath.
		for (const start of [join(root, "no", "such", "dir"), "", "\u0000"]) {
			__resetStoreLocationCacheForTests();
			let loc: ReturnType<typeof resolveStoreLocation> | undefined;
			expect(() => {
				loc = resolveStoreLocation(start);
			}).not.toThrow();
			expect(typeof loc?.storeDir).toBe("string");
		}
	});
});
