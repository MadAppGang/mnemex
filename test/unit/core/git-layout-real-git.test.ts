/**
 * The layout reader against REAL git (architecture §2.2, §8 Phase 1).
 *
 * `src/core/git-layout.ts` re-implements what `git rev-parse --git-common-dir`
 * answers, so it could not use a subprocess (NFR-3). The risk of re-implementing
 * it is answered here: real repositories and worktrees are built by real git in
 * a temp directory, and for every shape the reader's answer must EQUAL git's.
 *
 * This test spawns git and nothing else. The sandbox (test/helpers/git-sandbox.ts)
 * strips inherited `GIT_*`, points `HOME` and git config into the temp
 * directory, and builds its env from `keychainSafeChildEnv()`.
 *
 * FALSIFIED by (run during Phase 1 and recorded in the implementation log):
 * skipping the `commondir` read in `layoutFrom` — both linked-worktree cases go
 * red with gitCommonDir `<common>/worktrees/<name>` where git says `<common>`.
 * And (Phase 3c): setting `STORE_SCOPE_DEFAULT` back to "worktree" turns every
 * row of the row-3 test red, on all seven real checkouts.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getIndexDir } from "../../../src/config.js";
import {
	type GitLayout,
	readCurrentHead,
	readGitLayout,
} from "../../../src/core/git-layout.js";
import {
	__resetStoreLocationCacheForTests,
	pickStoreDir,
	readStoreInputs,
	resolveStoreLocation,
} from "../../../src/core/store-location.js";
import {
	createGitSandbox,
	type GitSandbox,
} from "../../helpers/git-sandbox.js";

let sb: GitSandbox;
let main: string;
let wtSibling: string;
let wtNested: string;
let wtDetached: string;
let submodule: string;
let bare: string;
let wtDangling: string;

function commitFile(cwd: string, name: string): void {
	writeFileSync(join(cwd, name), `${name}\n`);
	sb.git(cwd, "add", name);
	sb.git(cwd, "commit", "-q", "-m", `add ${name}`);
}

/** Git's own answer, absolute and realpath-resolved, for comparison. */
function gitPath(cwd: string, ...args: string[]): string {
	return realpathSync.native(
		sb.git(cwd, "rev-parse", "--path-format=absolute", ...args),
	);
}

function layoutOf(cwd: string): GitLayout {
	const result = readGitLayout(cwd);
	if (result.layout === null) {
		throw new Error(`no layout for ${cwd}: ${result.degradedReason}`);
	}
	return result.layout;
}

beforeAll(() => {
	sb = createGitSandbox("mnemex-git-real-");

	main = join(sb.root, "main");
	mkdirSync(join(main, "src", "deep"), { recursive: true });
	sb.git(main, "init", "-q");
	commitFile(main, "a.txt");

	// N41: a linked worktree is not required to live under the main checkout.
	wtSibling = join(sb.root, "wt-sibling");
	sb.git(main, "worktree", "add", "-q", "-b", "feature/x", wtSibling);
	// ...and it may also live INSIDE it, as this repository's own worktrees do.
	wtNested = join(main, ".claude", "worktrees", "wt-nested");
	sb.git(main, "worktree", "add", "-q", "-b", "nested", wtNested);
	wtDetached = join(sb.root, "wt-detached");
	sb.git(main, "worktree", "add", "-q", "--detach", wtDetached);

	const subSource = join(sb.root, "sub-source");
	mkdirSync(subSource);
	sb.git(subSource, "init", "-q");
	commitFile(subSource, "lib.txt");
	sb.git(main, "submodule", "add", "-q", subSource, "libs/sub");
	sb.git(main, "commit", "-q", "-m", "add submodule");
	submodule = join(main, "libs", "sub");

	bare = join(sb.root, "bare.git");
	sb.git(sb.root, "init", "-q", "--bare", bare);

	wtDangling = join(sb.root, "wt-dangling");
	sb.git(main, "worktree", "add", "-q", "-b", "dangling", wtDangling);
	// What a moved or pruned worktree leaves behind: the `.git` file survives,
	// its target does not.
	rmSync(join(main, ".git", "worktrees", "wt-dangling"), {
		recursive: true,
		force: true,
	});
});

afterAll(() => {
	sb.cleanup();
});

describe("readGitLayout equals `git rev-parse` on real repositories", () => {
	const cases: Array<[string, () => string]> = [
		["main worktree root", () => main],
		["main worktree subdirectory", () => join(main, "src", "deep")],
		["linked worktree beside the main checkout", () => wtSibling],
		["linked worktree nested inside the main checkout", () => wtNested],
		["detached linked worktree", () => wtDetached],
		["submodule", () => submodule],
		["bare repository", () => bare],
	];

	for (const [label, cwdOf] of cases) {
		test(`${label}: gitCommonDir, gitDir, isBare and isLinkedWorktree match git`, () => {
			const cwd = cwdOf();
			const layout = layoutOf(cwd);
			const gitCommonDir = gitPath(cwd, "--git-common-dir");
			const gitDir = gitPath(cwd, "--git-dir");

			expect(layout.gitCommonDir).toBe(gitCommonDir);
			expect(layout.gitDir).toBe(gitDir);
			expect(layout.isBare).toBe(
				sb.git(cwd, "rev-parse", "--is-bare-repository") === "true",
			);
			expect(layout.isLinkedWorktree).toBe(gitDir !== gitCommonDir);
		});
	}

	for (const [label, cwdOf] of cases.filter(([l]) => l !== "bare repository")) {
		test(`${label}: worktreeRoot matches --show-toplevel`, () => {
			const cwd = cwdOf();
			expect(layoutOf(cwd).worktreeRoot).toBe(
				realpathSync.native(sb.git(cwd, "rev-parse", "--show-toplevel")),
			);
		});
	}

	test("the linked-worktree cases really are linked (the fixture is not vacuous)", () => {
		// Guards the equality tests above: if `git worktree add` had silently
		// produced something else, `gitDir !== gitCommonDir` would be false on
		// both sides and the equality would prove nothing about `commondir`.
		expect(layoutOf(wtSibling).isLinkedWorktree).toBe(true);
		expect(layoutOf(wtNested).isLinkedWorktree).toBe(true);
		expect(layoutOf(wtSibling).gitCommonDir).toBe(layoutOf(main).gitDir);
	});

	test("dangling gitdir: git itself refuses, and the reader degrades with the missing path", () => {
		const git = sb.tryGit(wtDangling, "rev-parse", "--git-common-dir");
		expect(git.exitCode).not.toBe(0);

		expect(readGitLayout(wtDangling)).toEqual({
			layout: null,
			degradedReason: `gitdir-missing:${join(main, ".git", "worktrees", "wt-dangling")}`,
		});
	});
});

describe("readCurrentHead equals git's view of HEAD", () => {
	test("each worktree reports its own branch", () => {
		for (const cwd of [main, wtSibling, wtNested]) {
			const head = readCurrentHead(layoutOf(cwd));
			expect(head.kind).toBe("branch");
			expect(head.ref).toBe(sb.git(cwd, "symbolic-ref", "HEAD"));
			expect(head.label).toBe(sb.git(cwd, "symbolic-ref", "--short", "HEAD"));
		}
		expect(readCurrentHead(layoutOf(wtSibling)).label).toBe("feature/x");
	});

	test("a detached worktree reports the full sha git reports", () => {
		expect(readCurrentHead(layoutOf(wtDetached))).toEqual({
			label: sb.git(wtDetached, "rev-parse", "HEAD"),
			kind: "detached",
			ref: null,
		});
	});

	test("a real `git switch` is seen on the next read, with no cache to reset", () => {
		const layout = layoutOf(wtSibling);
		sb.git(wtSibling, "switch", "-q", "-c", "feature/switched");
		try {
			expect(readCurrentHead(layout).label).toBe("feature/switched");
		} finally {
			sb.git(wtSibling, "switch", "-q", "feature/x");
		}
	});
});

/** Runs `body` with MNEMEX_INDEX_DIR unset and a fresh memo, restoring both. */
function withoutEnvOverride(body: () => void): void {
	const saved = process.env.MNEMEX_INDEX_DIR;
	delete process.env.MNEMEX_INDEX_DIR;
	__resetStoreLocationCacheForTests();
	try {
		body();
	} finally {
		if (saved === undefined) delete process.env.MNEMEX_INDEX_DIR;
		else process.env.MNEMEX_INDEX_DIR = saved;
		__resetStoreLocationCacheForTests();
	}
}

describe("the 3c default on REAL repositories: row 3 is on, and git is the oracle", () => {
	test("every checkout resolves under git's own --git-common-dir, kind git-common-dir", () => {
		// INVERTED IN 3c. This asserted `kind: "worktree-local"` and four
		// DISTINCT stores; it now asserts the opposite of both, against the same
		// seven real checkouts. The oracle is git itself — `--git-common-dir`
		// read per checkout — not the seam's own idea of a common dir.
		//
		// Falsified by: setting STORE_SCOPE_DEFAULT back to "worktree", which
		// turns every row here red; and by building row 3 from `gitDir` instead
		// of `gitCommonDir`, which turns the linked-worktree rows red only.
		withoutEnvOverride(() => {
			const repos = [
				main,
				join(main, "src", "deep"),
				wtSibling,
				wtNested,
				wtDetached,
				submodule,
				bare,
			];
			for (const cwd of repos) {
				const loc = resolveStoreLocation(cwd);
				expect({ cwd, kind: loc.kind }).toEqual({
					cwd,
					kind: "git-common-dir",
				});
				expect(loc.storeDir).toBe(getIndexDir(cwd));
				// Not vacuous: git really does see a repository here.
				expect(loc.gitLayout).not.toBeNull();
				// The store is under what GIT says the common dir is.
				expect(loc.storeDir).toBe(
					join(gitPath(cwd, "--git-common-dir"), "mnemex"),
				);
			}
			// ...so the four checkouts of ONE repository now share ONE store.
			// This is FR-1, on real `git worktree add` output, and it is the
			// exact assertion that read `.size).toBe(4)` before the flip.
			const stores = [main, wtSibling, wtNested, wtDetached].map(
				(cwd) => resolveStoreLocation(cwd).storeDir,
			);
			expect(new Set(stores).size).toBe(1);
			// A subdirectory of the main checkout joins them, rather than
			// minting a store of its own as it did before 3c.
			expect(resolveStoreLocation(join(main, "src", "deep")).storeDir).toBe(
				resolveStoreLocation(main).storeDir,
			);
			// The submodule and the bare repo are SEPARATE repositories and keep
			// separate stores — the sharing is per clone, not per directory tree.
			expect(resolveStoreLocation(submodule).storeDir).not.toBe(
				resolveStoreLocation(main).storeDir,
			);
			expect(resolveStoreLocation(bare).storeDir).not.toBe(
				resolveStoreLocation(main).storeDir,
			);
		});
	});

	test("the PRE-3c answer is still computable, and production no longer gives it", () => {
		// The bisect path, and the executable record of what the flip changed.
		withoutEnvOverride(() => {
			const old = [main, wtSibling, wtNested, wtDetached].map(
				(cwd) => pickStoreDir(readStoreInputs(cwd), "worktree").storeDir,
			);
			expect(new Set(old).size).toBe(4);
			for (const cwd of [main, wtSibling, wtNested, wtDetached]) {
				expect(pickStoreDir(readStoreInputs(cwd), "worktree").kind).toBe(
					"worktree-local",
				);
				expect(resolveStoreLocation(cwd).storeDir).not.toBe(
					pickStoreDir(readStoreInputs(cwd), "worktree").storeDir,
				);
			}
		});
	});
});

describe("pickStoreDir on real worktrees under the git-common-dir scope (V1.1 at the seam, what 3c turns on)", () => {
	test("every worktree of one repository resolves ONE storeDir, under git's common dir", () => {
		// Falsified by: building row 3 from gitDir instead of gitCommonDir —
		// each worktree then gets its own store and the equality fails.
		withoutEnvOverride(() => {
			const expected = join(gitPath(main, "--git-common-dir"), "mnemex");
			const locations = [main, wtSibling, wtNested, wtDetached].map((cwd) =>
				pickStoreDir(readStoreInputs(cwd), "git-common-dir"),
			);
			for (const loc of locations) {
				expect(loc.kind).toBe("git-common-dir");
				expect(loc.storeDir).toBe(expected);
			}
			// ...while the per-worktree directory stays per worktree (§2.4).
			expect(new Set(locations.map((l) => l.worktreeDir)).size).toBe(4);
			expect(locations[1]?.pathRoot).toBe(wtSibling);
		});
	});
});
