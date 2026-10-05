/**
 * D-1 and GL-1 (step 3, R3) — `getWorktreeStatus()`, the dirty overlay's view
 * of the working tree.
 *
 * D-1, the listing. Real git, real repositories (`git-sandbox.ts`). The dirty
 * set is "tracked modified + untracked-not-ignored" (user decision, Phase 1),
 * read with `-z` so no path is quoted, `-uall` so an untracked DIRECTORY yields
 * its files, `--no-renames` so a rename is a deletion plus an addition (both
 * paths matter: the old one's index rows must be hidden, the new one served),
 * and `--ignore-submodules=all`. Every inherited `GIT_*` is stripped, so a
 * search run from a git hook cannot be redirected at another repository.
 *
 * GL-1, the bytes. `git status` REFRESHES `.git/index` when it sees changed
 * stat data — measured on git 2.56.0: after a `touch`, a plain `git status`
 * moved the index file's mtime. Every search runs this, including each
 * debounced TUI keystroke, so without `--no-optional-locks` (and
 * `GIT_OPTIONAL_LOCKS=0`) mnemex would compete with the user's own
 * `commit`/`add`/`rebase` for `index.lock`. Asserted on the index file's mtime
 * and bytes on disk, not on what the method reports.
 *
 * FALSIFIED BY: (D-1) the pre-existing `getDirtyFiles()`, run on the same
 * repository below, loses each shape; dropping `-uall` returns the directory;
 * keeping `GIT_DIR` reads the wrong repository. (GL-1) dropping BOTH the flag
 * and the env var moves the index mtime.
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
	chmodSync,
	mkdirSync,
	readFileSync,
	renameSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	GitDiffChangeDetector,
	parsePorcelainZ,
	WORKTREE_STATUS_ARGS,
	worktreeStatusEnv,
} from "../../../src/cloud/git-diff.js";
import {
	createGitSandbox,
	type GitSandbox,
} from "../../helpers/git-sandbox.js";

let box: GitSandbox;
let repo: string;
let other: string;

/** Tests run the method under test with THIS process's env; keep it hermetic. */
const savedEnv = { ...process.env };
afterEach(() => {
	for (const key of Object.keys(process.env)) {
		if (!(key in savedEnv)) delete process.env[key];
	}
	Object.assign(process.env, savedEnv);
});

function hermeticGitEnv(): void {
	// The method strips GIT_*, so the sandbox's GIT_CONFIG_GLOBAL cannot reach
	// it; a sandbox HOME keeps the developer's ~/.gitconfig out instead.
	process.env.HOME = join(box.root, "home");
	process.env.XDG_CONFIG_HOME = join(box.root, "home", ".config");
}

beforeAll(() => {
	box = createGitSandbox("mnemex-wtstatus-");
	repo = join(box.root, "repo");
	other = join(box.root, "other");
	for (const dir of [repo, other]) {
		mkdirSync(dir, { recursive: true });
		box.git(dir, "init", "-q");
	}
	writeFileSync(join(repo, "tracked.ts"), "export const a = 1;\n");
	writeFileSync(join(repo, "to-rename.ts"), "export const r = 1;\n");
	writeFileSync(join(repo, "clean.ts"), "export const c = 1;\n");
	writeFileSync(join(repo, ".gitignore"), "ignored/\n");
	box.git(repo, "add", "-A");
	box.git(repo, "commit", "-q", "-m", "init");

	// A submodule with a change inside it: --ignore-submodules=all hides it.
	writeFileSync(join(other, "sub.ts"), "export const s = 1;\n");
	box.git(other, "add", "-A");
	box.git(other, "commit", "-q", "-m", "sub");
	box.git(repo, "submodule", "add", "-q", other, "subm");
	box.git(repo, "commit", "-q", "-m", "add submodule");
	writeFileSync(join(repo, "subm", "sub.ts"), "export const s = 2;\n");

	// The dirty shapes.
	writeFileSync(join(repo, "tracked.ts"), "export const a = 2;\n");
	renameSync(join(repo, "to-rename.ts"), join(repo, "renamed.ts"));
	mkdirSync(join(repo, "newdir", "deep"), { recursive: true });
	writeFileSync(join(repo, "newdir", "deep", "x.ts"), "export const x = 1;\n");
	writeFileSync(join(repo, "with space.ts"), "export const w = 1;\n");
	writeFileSync(join(repo, "café.ts"), "export const u = 1;\n");
	writeFileSync(join(repo, "new\nline.ts"), "export const n = 1;\n");
	mkdirSync(join(repo, "ignored"), { recursive: true });
	writeFileSync(join(repo, "ignored", "i.ts"), "export const i = 1;\n");
});

afterAll(() => {
	box.cleanup();
});

describe("D-1 — the -z parser", () => {
	test("plain entries, a rename record, and a directory entry", () => {
		const raw =
			" M a.ts\0?? dir/b c.ts\0R  new.ts\0old.ts\0?? nested/\0 D gone.ts\0";
		expect(parsePorcelainZ(raw)).toEqual([
			{ path: "a.ts", index: " ", worktree: "M" },
			{ path: "dir/b c.ts", index: "?", worktree: "?" },
			// A rename can only appear if renames were on; both paths are kept.
			{ path: "new.ts", index: "R", worktree: " " },
			{ path: "old.ts", index: "D", worktree: " " },
			{ path: "gone.ts", index: " ", worktree: "D" },
		]);
	});

	test("an empty listing is no entries", () => {
		expect(parsePorcelainZ("")).toEqual([]);
	});
});

describe("D-1 — getWorktreeStatus on a real repository", () => {
	test("every dirty shape, exactly, and nothing else (A)", async () => {
		hermeticGitEnv();
		const result = await new GitDiffChangeDetector(repo).getWorktreeStatus();
		if (!result.ok) throw new Error(`${result.reason}: ${result.message}`);
		const paths = result.entries.map((e) => e.path).sort();
		expect(paths).toEqual(
			[
				"café.ts",
				"new\nline.ts",
				"newdir/deep/x.ts",
				"renamed.ts",
				"to-rename.ts",
				"tracked.ts",
				"with space.ts",
			].sort(),
		);
		const byPath = new Map(result.entries.map((e) => [e.path, e]));
		// rename = D old + ?? new
		expect(byPath.get("to-rename.ts")?.worktree).toBe("D");
		expect(byPath.get("renamed.ts")?.index).toBe("?");
		expect(byPath.get("tracked.ts")?.worktree).toBe("M");
		// The submodule's own change, and the ignored file, are absent.
		expect(paths.some((p) => p.startsWith("subm"))).toBe(false);
		expect(paths.some((p) => p.startsWith("ignored"))).toBe(false);
	});

	test("an inherited GIT_DIR cannot redirect it at another repository", async () => {
		hermeticGitEnv();
		process.env.GIT_DIR = join(other, ".git");
		process.env.GIT_WORK_TREE = other;
		process.env.GIT_INDEX_FILE = join(other, ".git", "index");
		const result = await new GitDiffChangeDetector(repo).getWorktreeStatus();
		if (!result.ok) throw new Error(`${result.reason}: ${result.message}`);
		expect(result.entries.map((e) => e.path)).toContain("tracked.ts");
	});

	test("outside a repository: no-git, never a throw", async () => {
		hermeticGitEnv();
		const outside = join(box.root, "not-a-repo");
		mkdirSync(outside, { recursive: true });
		const result = await new GitDiffChangeDetector(outside).getWorktreeStatus();
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("no-git");
	});

	test("an overflowing listing is too-large, not git-failed", async () => {
		hermeticGitEnv();
		const result = await new GitDiffChangeDetector(repo).getWorktreeStatus({
			maxBuffer: 16,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("too-large");
	});

	test("contrast: the pre-existing getDirtyFiles() loses these shapes", async () => {
		// Not a requirement on getDirtyFiles (it is unchanged, cloud-only); the
		// record of WHY a new method exists. Each line is a shape it gets wrong.
		hermeticGitEnv();
		const old = (await new GitDiffChangeDetector(repo).getDirtyFiles()).map(
			(f) => f.filePath,
		);
		expect(old).not.toContain("newdir/deep/x.ts"); // reports the directory
		expect(old).not.toContain("café.ts"); // quoted + octal-escaped
		expect(old).not.toContain("new\nline.ts"); // quoted
	});
});

describe("D-1 — the invocation", () => {
	test("argv carries --no-optional-locks and the listing flags", () => {
		expect([...WORKTREE_STATUS_ARGS]).toEqual([
			"--no-optional-locks",
			"status",
			"--porcelain=v1",
			"-z",
			"-uall",
			"--no-renames",
			"--ignore-submodules=all",
		]);
	});

	test("env: every GIT_* stripped, then GIT_OPTIONAL_LOCKS=0 and GIT_PAGER=cat", () => {
		const env = worktreeStatusEnv({
			PATH: "/usr/bin",
			GIT_DIR: "/elsewhere/.git",
			GIT_WORK_TREE: "/elsewhere",
			GIT_INDEX_FILE: "/elsewhere/.git/index",
			GIT_OPTIONAL_LOCKS: "1",
			HOME: "/h",
		});
		expect(env).toEqual({
			PATH: "/usr/bin",
			HOME: "/h",
			GIT_OPTIONAL_LOCKS: "0",
			GIT_PAGER: "cat",
		});
	});

	test("the REAL child receives that argv and env (decoy git first on PATH)", async () => {
		hermeticGitEnv();
		const realGit = Bun.which("git");
		if (realGit === null) throw new Error("git not on PATH");
		const bin = join(box.root, "decoy-bin");
		mkdirSync(bin, { recursive: true });
		const argvFile = join(box.root, "decoy-argv");
		const envFile = join(box.root, "decoy-env");
		writeFileSync(
			join(bin, "git"),
			`#!/bin/sh\nprintf '%s\\n' "$@" > '${argvFile}'\nenv > '${envFile}'\nexec '${realGit}' "$@"\n`,
		);
		chmodSync(join(bin, "git"), 0o755);
		process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
		process.env.GIT_DIR = join(other, ".git");

		const result = await new GitDiffChangeDetector(repo).getWorktreeStatus();
		expect(result.ok).toBe(true);
		const argv = readFileSync(argvFile, "utf8").trim().split("\n");
		expect(argv).toEqual([...WORKTREE_STATUS_ARGS]);
		const env = readFileSync(envFile, "utf8").split("\n");
		expect(env).toContain("GIT_OPTIONAL_LOCKS=0");
		expect(env).toContain("GIT_PAGER=cat");
		expect(env.some((line) => line.startsWith("GIT_DIR="))).toBe(false);
	});
});

describe("GT-2 — a hung git status is bounded (code review 2, MEDIUM 4)", () => {
	test("a git that never answers is killed at timeoutMs → git-failed, not a hang", async () => {
		hermeticGitEnv();
		const bin = join(box.root, "hung-bin");
		mkdirSync(bin, { recursive: true });
		writeFileSync(join(bin, "git"), "#!/bin/sh\nexec /bin/sleep 10\n");
		chmodSync(join(bin, "git"), 0o755);
		process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;

		const started = Date.now();
		const result = await new GitDiffChangeDetector(repo).getWorktreeStatus({
			timeoutMs: 300,
		});
		const elapsed = Date.now() - started;
		expect(result).toMatchObject({ ok: false, reason: "git-failed" });
		expect(result.ok ? "" : result.message).toContain("timed out after 300 ms");
		expect(elapsed).toBeLessThan(3000);
	}, 30_000);
});

describe("GL-1 — a status pass never rewrites .git/index (A, bytes on disk)", () => {
	test("tracked file touched: index mtime and bytes unchanged", async () => {
		hermeticGitEnv();
		const index = join(repo, ".git", "index");
		// Make the stat data stale the way an editor save does, with the index
		// itself old enough that git would consider refreshing it.
		const past = new Date(Date.now() - 60_000);
		utimesSync(index, past, past);
		const future = new Date(Date.now() + 5_000);
		utimesSync(join(repo, "clean.ts"), future, future);
		const before = statSync(index).mtimeMs;
		const bytesBefore = readFileSync(index);

		const result = await new GitDiffChangeDetector(repo).getWorktreeStatus();
		expect(result.ok).toBe(true);

		expect(statSync(index).mtimeMs).toBe(before);
		expect(readFileSync(index).equals(bytesBefore)).toBe(true);
	});
});
