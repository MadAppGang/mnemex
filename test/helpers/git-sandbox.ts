/**
 * Real git repositories in a temp directory, for the tests that compare the
 * pure-fs layout reader with what git itself answers.
 *
 * Tests MAY spawn git: the process-launch allowlist governs `src/`, and the
 * layout reader in `src/` spawns nothing (NFR-3). What these spawns must not do
 * is reach anything of the developer's, so every child gets:
 *
 *   - `keychainSafeChildEnv()` as its base (CLAUDE.md #24). git is not a mnemex
 *     entry point, but the guard costs nothing and keeps this file out of any
 *     argument about what a child might run.
 *   - EVERY inherited `GIT_*` variable removed. A suite run from a git hook
 *     inherits `GIT_DIR` (often the relative `.git`), which would point these
 *     commands at the developer's repository instead of the fixture.
 *   - `HOME` and `XDG_CONFIG_HOME` inside the sandbox, `GIT_CONFIG_GLOBAL=/dev/null`
 *     and `GIT_CONFIG_NOSYSTEM=1`. No user or system config means no commit
 *     signing and no credential helper. The macOS system gitconfig configures
 *     `credential.helper=osxkeychain`, which no test may reach.
 *   - `GIT_TERMINAL_PROMPT=0`, so nothing can block on a prompt.
 *
 * Nothing is written outside the sandbox root.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keychainSafeChildEnv } from "./child-env.js";

/** Config every invocation carries, so no ambient setting changes the fixture. */
const GIT_BASE_ARGS = [
	"-c",
	"init.defaultBranch=main",
	"-c",
	"commit.gpgsign=false",
	"-c",
	"tag.gpgsign=false",
	"-c",
	"core.autocrlf=false",
	// `git submodule add <local path>` clones over the file protocol, which
	// git >= 2.38.1 refuses by default.
	"-c",
	"protocol.file.allow=always",
];

const GIT_TIMEOUT_MS = 30_000;

export interface GitResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
}

export interface GitSandbox {
	/** realpath-resolved temp directory; every fixture lives under it. */
	root: string;
	/** Runs git in `cwd`; throws with stderr on a non-zero exit. Returns trimmed stdout. */
	git(cwd: string, ...args: string[]): string;
	/** Runs git in `cwd` and returns the result whatever the exit code. */
	tryGit(cwd: string, ...args: string[]): GitResult;
	cleanup(): void;
}

/** The environment every sandboxed git child gets. See the file header. */
export function gitChildEnv(home: string): Record<string, string> {
	const env = keychainSafeChildEnv();
	for (const key of Object.keys(env)) {
		if (key.startsWith("GIT_")) delete env[key];
	}
	return {
		...env,
		HOME: home,
		XDG_CONFIG_HOME: join(home, ".config"),
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_TERMINAL_PROMPT: "0",
		GIT_AUTHOR_NAME: "mnemex test",
		GIT_AUTHOR_EMAIL: "test@example.invalid",
		GIT_COMMITTER_NAME: "mnemex test",
		GIT_COMMITTER_EMAIL: "test@example.invalid",
	};
}

export function createGitSandbox(prefix = "mnemex-git-"): GitSandbox {
	const root = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
	const home = join(root, "home");
	mkdirSync(home);
	const env = gitChildEnv(home);

	const tryGit = (cwd: string, ...args: string[]): GitResult => {
		const proc = Bun.spawnSync(["git", ...GIT_BASE_ARGS, ...args], {
			cwd,
			env,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			timeout: GIT_TIMEOUT_MS,
		});
		return {
			exitCode: proc.exitCode,
			stdout: proc.stdout.toString().trim(),
			stderr: proc.stderr.toString().trim(),
		};
	};

	return {
		root,
		tryGit,
		git(cwd, ...args) {
			const result = tryGit(cwd, ...args);
			if (result.exitCode !== 0) {
				throw new Error(
					`git ${args.join(" ")} (cwd ${cwd}) exited ${result.exitCode}: ${result.stderr}`,
				);
			}
			return result.stdout;
		},
		cleanup() {
			rmSync(root, { recursive: true, force: true });
		},
	};
}
