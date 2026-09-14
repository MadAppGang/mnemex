/**
 * `hooks install` / `uninstall` / `status` in every checkout shape git hands us
 * (architecture §8 Phase 2).
 *
 * The defect: `GitHookManager` took `<projectPath>/.git` to be a DIRECTORY. In a
 * linked worktree it is a FILE holding `gitdir: <common>/worktrees/<name>`, so
 * `mkdirSync(<file>/hooks)` failed and the post-commit hook could not be
 * installed from any linked worktree. Git reads hooks from `<gitCommonDir>/hooks`
 * for every worktree of a repository, so that is where the hook must go.
 *
 * Every claim about an install is asserted on the FILE ON DISK, never on a
 * return value, and the directory it is expected in is git's own answer
 * (`git rev-parse --git-path hooks`), not the layout reader's.
 *
 * This test spawns git and nothing else, through test/helpers/git-sandbox.ts
 * (keychain-safe env, inherited GIT_* stripped, HOME inside the sandbox). The
 * only commit is made before any hook exists, so the hook — which would run
 * whatever `mnemex` is on PATH — never fires.
 *
 * FALSIFIED by restoring `join(projectPath, ".git")` as the base of the hooks
 * directory: the linked-worktree install goes red (recorded in the session's
 * implementation-log-hooks.md).
 */

import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	test,
} from "bun:test";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { readGitLayout } from "../../../src/core/git-layout.js";
import { createGitHookManager } from "../../../src/git/hook-manager.js";
import {
	createGitSandbox,
	type GitSandbox,
} from "../../helpers/git-sandbox.js";

const HOOK_MARKER = "# mnemex-auto-index";

let sb: GitSandbox;
let main: string;
let linked: string;
/** Where git itself reads hooks from. Asked of git, not of the code under test. */
let gitHooksDir: string;

function gitHooksPath(cwd: string): string {
	return sb.git(
		cwd,
		"rev-parse",
		"--path-format=absolute",
		"--git-path",
		"hooks",
	);
}

function hookFile(): string {
	return join(gitHooksDir, "post-commit");
}

beforeAll(() => {
	sb = createGitSandbox("mnemex-hooks-");

	main = join(sb.root, "main");
	mkdirSync(join(main, "src"), { recursive: true });
	sb.git(main, "init", "-q");
	writeFileSync(join(main, "a.txt"), "a\n");
	sb.git(main, "add", "a.txt");
	sb.git(main, "commit", "-q", "-m", "init");

	linked = join(sb.root, "wt-linked");
	sb.git(main, "worktree", "add", "-q", "-b", "linked", linked);

	gitHooksDir = gitHooksPath(main);
});

afterEach(() => {
	// One hook file is shared by every worktree; each test starts without it.
	rmSync(hookFile(), { force: true });
});

afterAll(() => {
	sb.cleanup();
});

describe("hooks install from a LINKED worktree", () => {
	test("the fixture is the defect's shape: `.git` is a file, and git reads hooks from the common dir", () => {
		expect(statSync(join(linked, ".git")).isFile()).toBe(true);
		expect(gitHooksPath(linked)).toBe(gitHooksDir);
		expect(gitHooksDir).toBe(join(main, ".git", "hooks"));
	});

	test("creates the hook under <gitCommonDir>/hooks, on disk", async () => {
		await createGitHookManager(linked).install();

		expect(existsSync(hookFile())).toBe(true);
		expect(readFileSync(hookFile(), "utf-8")).toContain(HOOK_MARKER);
		expect(statSync(hookFile()).mode & 0o111).toBe(0o111);

		// Not in the worktree's PRIVATE git dir, which git never reads hooks from.
		const privateGitDir = sb.git(linked, "rev-parse", "--absolute-git-dir");
		expect(privateGitDir).not.toBe(join(main, ".git"));
		expect(existsSync(join(privateGitDir, "hooks"))).toBe(false);
		// And the `.git` file is untouched.
		expect(statSync(join(linked, ".git")).isFile()).toBe(true);
	});
});

describe("ONE hook, whichever worktree runs the command", () => {
	test("installed from the linked worktree, status from the main worktree reports installed", async () => {
		await createGitHookManager(linked).install();
		expect(existsSync(hookFile())).toBe(true);

		const status = await createGitHookManager(main).status();
		expect(status.installed).toBe(true);
		expect(status.path).toBe(hookFile());
	});

	test("installed from the main worktree, status from the linked worktree reports installed", async () => {
		await createGitHookManager(main).install();
		expect(existsSync(hookFile())).toBe(true);

		const status = await createGitHookManager(linked).status();
		expect(status.installed).toBe(true);
		expect(status.path).toBe(hookFile());
	});

	test("uninstall from the other worktree removes the file", async () => {
		await createGitHookManager(linked).install();
		expect(existsSync(hookFile())).toBe(true);

		await createGitHookManager(main).uninstall();
		expect(existsSync(hookFile())).toBe(false);
		expect((await createGitHookManager(linked).status()).installed).toBe(false);
	});

	test("installing from both worktrees leaves one copy of the hook, not two", async () => {
		await createGitHookManager(linked).install();
		await createGitHookManager(main).install();

		const content = readFileSync(hookFile(), "utf-8");
		expect(content.split(HOOK_MARKER).length - 1).toBe(1);
	});
});

describe("main worktree (`.git` is a directory) — unchanged", () => {
	test("install writes <main>/.git/hooks/post-commit; status sees it; uninstall removes it", async () => {
		expect(statSync(join(main, ".git")).isDirectory()).toBe(true);
		const hook = join(main, ".git", "hooks", "post-commit");
		const manager = createGitHookManager(main);

		await manager.install();
		expect(existsSync(hook)).toBe(true);
		expect(readFileSync(hook, "utf-8")).toContain(HOOK_MARKER);
		expect(statSync(hook).mode & 0o111).toBe(0o111);
		expect((await manager.status()).installed).toBe(true);
		expect(manager.isGitRepository()).toBe(true);

		await manager.uninstall();
		expect(existsSync(hook)).toBe(false);
		expect((await manager.status()).installed).toBe(false);
	});
});

describe("everything else behaves as today (`<projectPath>/.git`)", () => {
	test("a non-git directory: install refuses with today's message and creates nothing", async () => {
		const dir = join(sb.root, "not-a-repo");
		mkdirSync(dir);
		// Precondition: nothing git-shaped anywhere above the fixture either.
		expect(readGitLayout(dir)).toEqual({ layout: null, degradedReason: null });
		const manager = createGitHookManager(dir);

		await expect(manager.install()).rejects.toThrow("Not a git repository");
		expect(existsSync(join(dir, ".git"))).toBe(false);
		expect(await manager.status()).toEqual({ installed: false });
		await manager.uninstall();
		expect(existsSync(join(dir, ".git"))).toBe(false);
		expect(manager.isGitRepository()).toBe(false);
	});

	test("a subdirectory of a checkout: refuses as today, and writes nothing into the repository's hooks", async () => {
		// git runs the hook from the worktree ROOT, so a hook installed on a
		// subdirectory project's behalf would index the whole checkout.
		const dir = join(main, "src");
		const manager = createGitHookManager(dir);

		await expect(manager.install()).rejects.toThrow("Not a git repository");
		expect(existsSync(hookFile())).toBe(false);
		expect(existsSync(join(dir, ".git"))).toBe(false);
		expect(await manager.status()).toEqual({ installed: false });
	});

	test("a bare repository: refuses as today", async () => {
		const bare = join(sb.root, "bare.git");
		sb.git(sb.root, "init", "-q", "--bare", bare);

		await expect(createGitHookManager(bare).install()).rejects.toThrow(
			"Not a git repository",
		);
		expect(existsSync(join(bare, "hooks", "post-commit"))).toBe(false);
	});

	test("a pruned linked worktree (degraded layout): install fails, writes nothing, status is not-installed", async () => {
		const wt = join(sb.root, "wt-pruned");
		sb.git(main, "worktree", "add", "-q", "-b", "pruned", wt);
		// What a moved or pruned worktree leaves behind: the `.git` file survives,
		// its target does not.
		rmSync(join(main, ".git", "worktrees", "wt-pruned"), {
			recursive: true,
			force: true,
		});
		const layout = readGitLayout(wt);
		expect(layout.layout).toBeNull();
		expect(layout.layout === null ? layout.degradedReason : null).toStartWith(
			"gitdir-missing:",
		);

		const gitFileBefore = readFileSync(join(wt, ".git"), "utf-8");
		const manager = createGitHookManager(wt);

		await expect(manager.install()).rejects.toThrow();
		expect(readFileSync(join(wt, ".git"), "utf-8")).toBe(gitFileBefore);
		expect(existsSync(hookFile())).toBe(false);
		expect(await manager.status()).toEqual({ installed: false });
	});
});

describe("hooks install from inside a SUBMODULE", () => {
	// A submodule's `.git` is a FILE (`gitdir: ../../.git/modules/<path>`) whose
	// target has NO `commondir`: the same ENOTDIR shape as a linked worktree, and
	// fixed by the same change. The module dir is its own common dir, and it is
	// where git reads the submodule's hooks. Nothing else pinned that.
	let superRepo: string;
	let submodule: string;
	/** Where git reads the SUBMODULE's hooks from. Asked of git, from inside it. */
	let subHooksDir: string;

	function subHookFile(): string {
		return join(subHooksDir, "post-commit");
	}

	beforeAll(() => {
		const subSource = join(sb.root, "sub-source");
		mkdirSync(subSource);
		sb.git(subSource, "init", "-q");
		writeFileSync(join(subSource, "lib.txt"), "lib\n");
		sb.git(subSource, "add", "lib.txt");
		sb.git(subSource, "commit", "-q", "-m", "init");

		// Every commit here is made before any hook exists, so none can fire.
		superRepo = join(sb.root, "super");
		mkdirSync(superRepo);
		sb.git(superRepo, "init", "-q");
		writeFileSync(join(superRepo, "a.txt"), "a\n");
		sb.git(superRepo, "add", "a.txt");
		sb.git(superRepo, "commit", "-q", "-m", "init");
		sb.git(superRepo, "submodule", "add", "-q", subSource, "libs/sub");
		sb.git(superRepo, "commit", "-q", "-m", "add submodule");
		submodule = join(superRepo, "libs", "sub");

		subHooksDir = gitHooksPath(submodule);
	});

	afterEach(() => {
		rmSync(subHookFile(), { force: true });
	});

	test("the fixture is the defect's shape: `.git` is a file, its git dir has no `commondir`, and git's hooks dir is not the superproject's", () => {
		expect(statSync(join(submodule, ".git")).isFile()).toBe(true);
		const subGitDir = sb.git(submodule, "rev-parse", "--absolute-git-dir");
		expect(existsSync(join(subGitDir, "commondir"))).toBe(false);
		expect(subHooksDir).not.toBe(gitHooksPath(superRepo));
	});

	test("creates the hook where git reads the submodule's hooks, on disk", async () => {
		const gitFileBefore = readFileSync(join(submodule, ".git"), "utf-8");

		await createGitHookManager(submodule).install();

		expect(existsSync(subHookFile())).toBe(true);
		expect(readFileSync(subHookFile(), "utf-8")).toContain(HOOK_MARKER);
		expect(statSync(subHookFile()).mode & 0o111).toBe(0o111);

		// Not the superproject's hook: git would run that on SUPERPROJECT commits.
		expect(existsSync(join(gitHooksPath(superRepo), "post-commit"))).toBe(
			false,
		);
		// And the `.git` file is untouched.
		expect(readFileSync(join(submodule, ".git"), "utf-8")).toBe(gitFileBefore);

		const status = await createGitHookManager(submodule).status();
		expect(status.installed).toBe(true);
		expect(status.path).toBe(subHookFile());
	});
});
