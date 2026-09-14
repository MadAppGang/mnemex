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
 * And (Phase 1 fix pass): flipping `STORE_SCOPE_DEFAULT` to "git-common-dir"
 * turns the pre-3c-default test red.
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

describe("the pre-3c default on real repositories: row 3 is gated (§8 Phase 2)", () => {
	test("with no override, every checkout's storeDir is today's getIndexDir, kind worktree-local", () => {
		// The oracle is the committed `getIndexDir` through its public function.
		// Falsified by: flipping STORE_SCOPE_DEFAULT to "git-common-dir" before
		// 3c — every repository case then resolves under git's common dir.
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
					kind: "worktree-local",
				});
				expect(loc.storeDir).toBe(getIndexDir(cwd));
				// Not vacuous: git really does see a repository here.
				expect(loc.gitLayout).not.toBeNull();
			}
			// ...so each worktree keeps its own store, exactly as today.
			const stores = [main, wtSibling, wtNested, wtDetached].map(
				(cwd) => resolveStoreLocation(cwd).storeDir,
			);
			expect(new Set(stores).size).toBe(4);
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
