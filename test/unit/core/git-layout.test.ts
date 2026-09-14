/**
 * The pure-fs `.git` layout reader against the five shapes git writes
 * (architecture §2.1, §2.2, §8 Phase 1): main worktree, linked worktree,
 * submodule, dangling gitdir, bare repository.
 *
 * Every fixture is CONSTRUCTED with `fs` (test/helpers/git-shapes.ts), because
 * git refuses to track a nested `.git` entry. The same shapes are checked
 * against real `git rev-parse` output in git-layout-real-git.test.ts; this
 * file covers the edge shapes git will not produce on demand (CRLF, relative
 * and absolute pointers, oversized and malformed files, the walk bound).
 *
 * Each test states the edit to `src/core/git-layout.ts` that turns it red.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	GIT_POINTER_FILE_MAX_BYTES,
	MAX_PARENT_WALK,
	readCurrentHead,
	readGitLayout,
	unknownHeadLabel,
} from "../../../src/core/git-layout.js";
import {
	makeBareRepo,
	makeDanglingWorktree,
	makeGitDir,
	makeLinkedWorktree,
	makeMainRepo,
	makeSubmodule,
} from "../../helpers/git-shapes.js";

let root: string;
let counter = 0;

/** A fresh, realpath-resolved directory per test, so no two fixtures share state. */
function freshDir(): string {
	counter += 1;
	const dir = join(root, `case-${counter}`);
	mkdirSync(dir);
	return dir;
}

function layoutOf(startPath: string) {
	const result = readGitLayout(startPath);
	if (result.layout === null) {
		throw new Error(
			`expected a layout for ${startPath}, got degradedReason=${result.degradedReason}`,
		);
	}
	return result.layout;
}

beforeAll(() => {
	root = realpathSync.native(mkdtempSync(join(tmpdir(), "mnemex-git-layout-")));
	// PRECONDITION: the temp root must not itself be inside a repository, or
	// every "outside a repository" assertion below would be meaningless.
	expect(readGitLayout(root)).toEqual({ layout: null, degradedReason: null });
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("the five .git shapes", () => {
	test("1. main worktree: `.git` is a directory, found from any depth", () => {
		// Falsified by: deleting the `entry?.isDirectory()` branch in
		// discoverLayout — the walk then finds no `.git` it recognises and
		// returns a null layout.
		const main = makeMainRepo(join(freshDir(), "repo"));
		const deep = join(main.worktree, "src", "core", "deep");
		mkdirSync(deep, { recursive: true });

		const expected = {
			worktreeRoot: main.worktree,
			gitDir: main.gitDir,
			gitCommonDir: main.gitDir,
			isLinkedWorktree: false,
			isBare: false,
		};
		expect(layoutOf(main.worktree)).toEqual(expected);
		expect(layoutOf(deep)).toEqual(expected);
	});

	test("2. linked worktree: `.git` is a FILE, and `commondir` leads to the shared git dir", () => {
		// Falsified by: skipping the `commondir` read (gitCommonDir = gitDir) —
		// gitCommonDir becomes `<common>/worktrees/wt` and isLinkedWorktree false.
		const dir = freshDir();
		const main = makeMainRepo(join(dir, "main"));
		const wt = makeLinkedWorktree(main, join(dir, "wt"));

		expect(layoutOf(wt.worktree)).toEqual({
			worktreeRoot: wt.worktree,
			gitDir: join(main.gitDir, "worktrees", "wt"),
			gitCommonDir: main.gitDir,
			isLinkedWorktree: true,
			isBare: false,
		});
	});

	test("2b. linked worktree with a RELATIVE gitfile terminated by CRLF resolves identically", () => {
		// Falsified by: dropping `.trim()` on the gitdir value (the `\r` survives
		// into the path, the stat fails, and the result degrades), or resolving a
		// relative value against the start path instead of the `.git` file's
		// directory (the subdirectory start below then misses).
		const dir = freshDir();
		const main = makeMainRepo(join(dir, "main"));
		const wt = makeLinkedWorktree(main, join(dir, "wt-crlf"), {
			relativeGitfile: true,
			crlf: true,
		});
		const sub = join(wt.worktree, "pkg", "lib");
		mkdirSync(sub, { recursive: true });

		for (const start of [wt.worktree, sub]) {
			const layout = layoutOf(start);
			expect(layout.worktreeRoot).toBe(wt.worktree);
			expect(layout.gitDir).toBe(wt.gitDir);
			expect(layout.gitCommonDir).toBe(main.gitDir);
			expect(layout.isLinkedWorktree).toBe(true);
		}
	});

	test("2c. linked worktree with an ABSOLUTE commondir", () => {
		// Falsified by: joining the commondir value onto gitDir unconditionally
		// (`join(gitDir, "/abs/path")` yields `<gitDir>/abs/path`, which is missing).
		const dir = freshDir();
		const main = makeMainRepo(join(dir, "main"));
		const wt = makeLinkedWorktree(main, join(dir, "wt-abs"), {
			absoluteCommondir: true,
		});
		expect(layoutOf(wt.worktree).gitCommonDir).toBe(main.gitDir);
	});

	test("3. submodule: `.git` FILE with no `commondir` — the module dir is its own common dir", () => {
		// Falsified by: deriving a common dir from any `.git` file as if it were a
		// linked worktree (e.g. two levels up from gitDir, which gives
		// `<super>/.git/modules`), or walking past the submodule to the
		// superproject — either way the submodule's store would land in the
		// wrong repository.
		const dir = freshDir();
		const superRepo = makeMainRepo(join(dir, "super"));
		const sub = makeSubmodule(superRepo, join("libs", "sub"));

		expect(layoutOf(sub.worktree)).toEqual({
			worktreeRoot: sub.worktree,
			gitDir: join(superRepo.gitDir, "modules", "libs", "sub"),
			gitCommonDir: join(superRepo.gitDir, "modules", "libs", "sub"),
			isLinkedWorktree: false,
			isBare: false,
		});
	});

	test("4. dangling gitdir: a pruned worktree degrades loudly, naming the missing path", () => {
		// Falsified by: removing the isDirectory() validation in layoutFrom — a
		// layout is then returned for a git dir that no longer exists, and a store
		// would be created under it.
		const dir = freshDir();
		const missing = join(dir, "gone", ".git", "worktrees", "wt");
		makeDanglingWorktree(join(dir, "wt"), missing);

		expect(readGitLayout(join(dir, "wt"))).toEqual({
			layout: null,
			degradedReason: `gitdir-missing:${missing}`,
		});
	});

	test("4b. a commondir that points nowhere degrades the same way, naming the common dir", () => {
		// Falsified by: validating gitDir but not gitCommonDir.
		const dir = freshDir();
		const main = makeMainRepo(join(dir, "main"));
		const wt = makeLinkedWorktree(main, join(dir, "wt"));
		writeFileSync(join(wt.gitDir, "commondir"), "../../../nowhere\n");

		// commondir resolves against the worktree's gitdir, main/.git/worktrees/wt,
		// so three levels up is main/: the same resolution git performs.
		expect(readGitLayout(wt.worktree)).toEqual({
			layout: null,
			degradedReason: `gitdir-missing:${join(main.worktree, "nowhere")}`,
		});
	});

	test("5. bare repository: the directory IS the git dir, found from inside it too", () => {
		// Falsified by: deleting the holdsGitDirectory() check — a bare repo has
		// no `.git` entry anywhere, so the walk ends with a null layout.
		const bare = makeBareRepo(join(freshDir(), "bare.git"));
		const expected = {
			worktreeRoot: bare.worktree,
			gitDir: bare.gitDir,
			gitCommonDir: bare.gitDir,
			isLinkedWorktree: false,
			isBare: true,
		};
		expect(layoutOf(bare.worktree)).toEqual(expected);
		expect(layoutOf(join(bare.worktree, "refs", "heads"))).toEqual(expected);
	});
});

describe("outside any repository (FR-7)", () => {
	test("a plain directory is a null layout with NO degraded reason", () => {
		// Falsified by: returning a degraded reason for the ordinary non-git case
		// — `doctor` would then report every plain directory as broken.
		const dir = freshDir();
		expect(readGitLayout(dir)).toEqual({ layout: null, degradedReason: null });
	});

	test("a directory with HEAD but no objects/ or refs/ is not mistaken for a bare repo", () => {
		// Falsified by: weakening holdsGitDirectory() to test HEAD alone.
		const dir = freshDir();
		writeFileSync(join(dir, "HEAD"), "ref: refs/heads/main\n");
		mkdirSync(join(dir, "objects"));
		expect(readGitLayout(dir)).toEqual({ layout: null, degradedReason: null });
	});
});

describe("degrades, never throws", () => {
	test("a `.git` FILE without a `gitdir:` line", () => {
		// Falsified by: treating the whole file content as a path.
		const dir = freshDir();
		writeFileSync(join(dir, ".git"), "this is not a gitfile\n");
		expect(readGitLayout(dir)).toEqual({
			layout: null,
			degradedReason: `gitfile-invalid:${join(dir, ".git")}`,
		});
	});

	test("a `gitdir:` line with an empty value", () => {
		// Falsified by: accepting "" — it resolves to the worktree itself, which
		// is a directory, so a bogus layout would be returned.
		const dir = freshDir();
		writeFileSync(join(dir, ".git"), "gitdir:    \n");
		expect(readGitLayout(dir)).toEqual({
			layout: null,
			degradedReason: `gitfile-invalid:${join(dir, ".git")}`,
		});
	});

	test("an oversized `.git` file is invalid, not read", () => {
		// Falsified by: removing the byte cap in readFirstLine — the first line
		// then parses and a layout is returned from a file past the bound.
		const dir = freshDir();
		const main = makeMainRepo(join(dir, "main"));
		const line = `gitdir: ${main.gitDir}\n`;
		writeFileSync(
			join(dir, ".git"),
			line + "#".repeat(GIT_POINTER_FILE_MAX_BYTES + 1 - line.length),
		);
		expect(readGitLayout(dir)).toEqual({
			layout: null,
			degradedReason: `gitfile-invalid:${join(dir, ".git")}`,
		});
	});

	test("an empty `commondir` file", () => {
		// Falsified by: treating an empty commondir as absent — the worktree's
		// store would then land in its private gitdir, splitting the repository.
		const dir = freshDir();
		const main = makeMainRepo(join(dir, "main"));
		const wt = makeLinkedWorktree(main, join(dir, "wt"));
		writeFileSync(join(wt.gitDir, "commondir"), "\n");
		expect(readGitLayout(wt.worktree)).toEqual({
			layout: null,
			degradedReason: `commondir-invalid:${join(wt.gitDir, "commondir")}`,
		});
	});

	test("hostile start paths return a value", () => {
		// Falsified by: removing the try/catch in statOrNull — a NUL byte makes
		// statSync throw ERR_INVALID_ARG_VALUE.
		for (const start of [
			join(root, "does", "not", "exist"),
			"",
			"\u0000",
			`${root}/\u0000/x`,
		]) {
			expect(() => readGitLayout(start)).not.toThrow();
		}
	});
});

describe("bounds, canonical paths and ignored environment", () => {
	test(`the walk examines at most MAX_PARENT_WALK (${MAX_PARENT_WALK}) directories, the start included`, () => {
		// Falsified by: changing the bound, or an off-by-one in the loop — one of
		// the two starts below flips.
		const main = makeMainRepo(join(freshDir(), "repo"));
		const nested = (depth: number) =>
			join(main.worktree, ...Array.from({ length: depth }, () => "d"));
		mkdirSync(nested(MAX_PARENT_WALK), { recursive: true });

		// MAX_PARENT_WALK - 1 levels below the root: the root is the 64th directory examined.
		expect(
			readGitLayout(nested(MAX_PARENT_WALK - 1)).layout?.worktreeRoot,
		).toBe(main.worktree);
		// One level deeper: the root would be the 65th, so it is never examined.
		expect(readGitLayout(nested(MAX_PARENT_WALK))).toEqual({
			layout: null,
			degradedReason: null,
		});
	});

	test("a symlinked checkout resolves to the real paths, so one repository has one store", () => {
		// Falsified by: dropping the realpath of the start path — worktreeRoot is
		// then the symlink's spelling and a second store path appears.
		const dir = freshDir();
		const main = makeMainRepo(join(dir, "real"));
		const link = join(dir, "link");
		symlinkSync(main.worktree, link);

		expect(layoutOf(link)).toEqual(layoutOf(main.worktree));
		expect(layoutOf(link).worktreeRoot).toBe(main.worktree);
	});

	test("GIT_DIR and GIT_COMMON_DIR are ignored (§2.2)", () => {
		// Falsified by: honouring either variable — the layout then points at the
		// decoy repository.
		const dir = freshDir();
		const main = makeMainRepo(join(dir, "main"));
		const decoy = makeMainRepo(join(dir, "decoy"));
		const saved = {
			GIT_DIR: process.env.GIT_DIR,
			GIT_COMMON_DIR: process.env.GIT_COMMON_DIR,
		};
		process.env.GIT_DIR = decoy.gitDir;
		process.env.GIT_COMMON_DIR = decoy.gitDir;
		try {
			expect(layoutOf(main.worktree).gitCommonDir).toBe(main.gitDir);
		} finally {
			for (const [key, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});
});

describe("readCurrentHead", () => {
	const SHA = "0123456789abcdef0123456789abcdef01234567";

	test("a branch, including a name with slashes", () => {
		// Falsified by: taking the last path segment as the label ("x", not "feature/x").
		const main = makeMainRepo(
			join(freshDir(), "repo"),
			"ref: refs/heads/feature/x\n",
		);
		expect(readCurrentHead(layoutOf(main.worktree))).toEqual({
			label: "feature/x",
			kind: "branch",
			ref: "refs/heads/feature/x",
		});
	});

	test("a linked worktree reads ITS OWN HEAD, not the main checkout's", () => {
		// Falsified by: reading `<gitCommonDir>/HEAD` — every worktree would then
		// report "main" (§2.1, "the single easiest thing to get wrong").
		const dir = freshDir();
		const main = makeMainRepo(join(dir, "main"));
		const wt = makeLinkedWorktree(main, join(dir, "wt"), {
			head: "ref: refs/heads/feature/y\n",
		});
		expect(readCurrentHead(layoutOf(main.worktree)).label).toBe("main");
		expect(readCurrentHead(layoutOf(wt.worktree)).label).toBe("feature/y");
	});

	test("a detached HEAD is labelled with the FULL sha", () => {
		// Falsified by: shortening the label, or classifying a sha as unknown.
		const main = makeMainRepo(join(freshDir(), "repo"), `${SHA}\n`);
		expect(readCurrentHead(layoutOf(main.worktree))).toEqual({
			label: SHA,
			kind: "detached",
			ref: null,
		});
	});

	test("a short sha is not a detached label (full sha only — §2.1)", () => {
		// Falsified by: loosening the sha pattern to accept abbreviations.
		const main = makeMainRepo(
			join(freshDir(), "repo"),
			`${SHA.slice(0, 12)}\n`,
		);
		expect(readCurrentHead(layoutOf(main.worktree)).kind).toBe("unknown");
	});

	test("an unreadable HEAD gets a PER-WORKTREE label, never a shared one (N12)", () => {
		// Falsified by: returning a constant label such as "HEAD" — the two
		// worktrees below would then share one bucket and see each other's rows.
		const dir = freshDir();
		const main = makeMainRepo(join(dir, "main"));
		const wt = makeLinkedWorktree(main, join(dir, "wt"));
		unlinkSync(join(main.gitDir, "HEAD"));
		unlinkSync(join(wt.gitDir, "HEAD"));
		// A main worktree without HEAD still has `.git/` as a directory, so the
		// layout itself resolves; only the head is unreadable.
		const mainLayout = layoutOf(main.worktree);
		const wtLayout = layoutOf(wt.worktree);

		const expectedLabel = (gitDir: string) =>
			`HEAD@${createHash("sha1").update(gitDir).digest("hex").slice(0, 12)}`;
		expect(readCurrentHead(mainLayout)).toEqual({
			label: expectedLabel(main.gitDir),
			kind: "unknown",
			ref: null,
		});
		expect(readCurrentHead(wtLayout).label).toBe(expectedLabel(wt.gitDir));
		expect(readCurrentHead(mainLayout).label).not.toBe(
			readCurrentHead(wtLayout).label,
		);
		expect(unknownHeadLabel(main.gitDir)).toBe(expectedLabel(main.gitDir));
	});

	test("a symbolic ref outside refs/heads/ is unknown, not a branch", () => {
		// Pins the documented behaviour: only `refs/heads/*` is a branch (§2.1
		// lists three kinds and no others). Falsified by: accepting any `ref:` value.
		const main = makeMainRepo(
			join(freshDir(), "repo"),
			"ref: refs/remotes/origin/main\n",
		);
		expect(readCurrentHead(layoutOf(main.worktree)).kind).toBe("unknown");
	});

	test("HEAD is re-read on every call — never memoized (§2.5)", () => {
		// Falsified by: caching the head per layout or per gitDir — the second
		// read would still answer "main" after the branch switch.
		const main = makeMainRepo(join(freshDir(), "repo"));
		const layout = layoutOf(main.worktree);
		expect(readCurrentHead(layout).label).toBe("main");
		writeFileSync(join(main.gitDir, "HEAD"), "ref: refs/heads/other\n");
		expect(readCurrentHead(layout).label).toBe("other");
	});

	test("a bare repository's HEAD reads like any other", () => {
		const bare = makeBareRepo(join(freshDir(), "bare.git"));
		makeGitDir(bare.gitDir, "ref: refs/heads/trunk\n");
		expect(readCurrentHead(layoutOf(bare.worktree)).label).toBe("trunk");
	});
});
