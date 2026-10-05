/**
 * `.git` layouts CONSTRUCTED with `fs`, byte-for-byte what git writes for each
 * shape, for the pure-fs layout reader (`src/core/git-layout.ts`).
 *
 * Built at test time in a temp directory rather than committed under
 * `test/testdata/`: git refuses to track a nested `.git` entry, so a committed
 * fixture would be missing from every fresh clone and the tests would pass
 * against nothing. `git-sandbox.ts` builds the same shapes with real git, for the
 * equality checks against `git rev-parse`.
 *
 * Writes nothing outside the directories it is given.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";

export interface Checkout {
	/** The directory holding the `.git` entry (or the bare repo itself). */
	worktree: string;
	/** That checkout's own git dir. */
	gitDir: string;
}

/** A git dir as `git init` leaves it: `HEAD`, `objects/`, `refs/`. */
export function makeGitDir(
	dir: string,
	head = "ref: refs/heads/main\n",
): string {
	mkdirSync(join(dir, "objects"), { recursive: true });
	mkdirSync(join(dir, "refs", "heads"), { recursive: true });
	writeFileSync(join(dir, "HEAD"), head);
	return dir;
}

/** Shape 1, main worktree: `<worktree>/.git` is a DIRECTORY. */
export function makeMainRepo(
	worktree: string,
	head = "ref: refs/heads/main\n",
): Checkout {
	mkdirSync(worktree, { recursive: true });
	return { worktree, gitDir: makeGitDir(join(worktree, ".git"), head) };
}

export interface LinkedWorktreeOptions {
	/** Write the `.git` file's target relative to the worktree (git writes absolute). */
	relativeGitfile?: boolean;
	/** Terminate the `.git` file with `\r\n`, as a Windows checkout does. */
	crlf?: boolean;
	/** Write `commondir` as an absolute path instead of git's `../..`. */
	absoluteCommondir?: boolean;
	/** The worktree's own HEAD. Defaults to a branch named after the worktree. */
	head?: string;
}

/**
 * Shape 2, linked worktree, as `git worktree add` writes it: `<worktree>/.git`
 * is a FILE holding `gitdir: <common>/worktrees/<name>`, and that directory
 * holds `HEAD`, `commondir` (`../..`) and `gitdir`.
 */
export function makeLinkedWorktree(
	main: Checkout,
	worktree: string,
	options: LinkedWorktreeOptions = {},
): Checkout {
	const name = basename(worktree);
	const gitDir = join(main.gitDir, "worktrees", name);
	mkdirSync(worktree, { recursive: true });
	mkdirSync(gitDir, { recursive: true });
	writeFileSync(
		join(gitDir, "HEAD"),
		options.head ?? `ref: refs/heads/${name}\n`,
	);
	writeFileSync(
		join(gitDir, "commondir"),
		options.absoluteCommondir ? `${main.gitDir}\n` : "../..\n",
	);
	writeFileSync(join(gitDir, "gitdir"), `${join(worktree, ".git")}\n`);
	const target = options.relativeGitfile ? relative(worktree, gitDir) : gitDir;
	writeFileSync(
		join(worktree, ".git"),
		`gitdir: ${target}${options.crlf ? "\r\n" : "\n"}`,
	);
	return { worktree, gitDir };
}

/**
 * Shape 3, submodule, as `git submodule add` writes it: `<super>/<path>/.git` is
 * a FILE holding a RELATIVE `gitdir: ../../.git/modules/<path>`, and the module
 * dir is a full git dir with NO `commondir`.
 */
export function makeSubmodule(superRepo: Checkout, subPath: string): Checkout {
	const worktree = join(superRepo.worktree, subPath);
	const gitDir = makeGitDir(join(superRepo.gitDir, "modules", subPath));
	mkdirSync(worktree, { recursive: true });
	writeFileSync(
		join(worktree, ".git"),
		`gitdir: ${relative(worktree, gitDir)}\n`,
	);
	return { worktree, gitDir };
}

/**
 * Shape 4, dangling gitdir: a linked worktree whose gitdir was pruned or moved.
 * The `.git` file points at `missingGitDir`, which does not exist.
 */
export function makeDanglingWorktree(
	worktree: string,
	missingGitDir: string,
): void {
	mkdirSync(worktree, { recursive: true });
	writeFileSync(join(worktree, ".git"), `gitdir: ${missingGitDir}\n`);
}

/** Shape 5, bare repository: the directory IS the git dir, with no `.git` entry. */
export function makeBareRepo(dir: string): Checkout {
	return { worktree: dir, gitDir: makeGitDir(dir) };
}
