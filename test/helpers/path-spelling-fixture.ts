/**
 * One small, git-backed project indexed by the BUILT entry point, shared by the
 * path-spelling pins (`agent-path-spelling-pin.test.ts`) and the MCP `context`
 * pins (`context-tool-paths.test.ts`).
 *
 * Shape, chosen so every graph command prints at least one path:
 *
 *   src/lib/helper.ts   helper (exported, called by main), localTwice (exported,
 *                       called by helper: a SAME-FILE callee, so `context`'s
 *                       import list has something to exclude), unusedLocal
 *                       (unexported, no callers: dead code)
 *   src/app.ts          main (exported, calls helper)
 *   src/other/helper.ts otherHelper — a SECOND file named `helper.ts`, so a
 *                       bare `helper.ts` argument is ambiguous
 *
 * The paths are nested on purpose: a repo-relative `src/lib/helper.ts` and an
 * absolute `/…/src/lib/helper.ts` can only be told apart if the file is not at
 * the root. BM25-only (`vector: false`), so no embedding endpoint is involved.
 *
 * `bun run build` is a precondition (CLAUDE.md #13).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createGitSandbox } from "./git-sandbox.js";
import { BM25_ONLY, type ChildRun, runCli } from "./v4-fixtures.js";

export const HELPER_FILE = "src/lib/helper.ts";
export const APP_FILE = "src/app.ts";
export const OTHER_HELPER_FILE = "src/other/helper.ts";

const SOURCES: Readonly<Record<string, string>> = {
	[HELPER_FILE]: [
		"export function helper(n: number): number {",
		"\treturn localTwice(n) + 1;",
		"}",
		"",
		"export function localTwice(n: number): number {",
		"\treturn n * 2;",
		"}",
		"",
		"function unusedLocal(n: number): number {",
		"\treturn n - 1;",
		"}",
		"",
	].join("\n"),
	[APP_FILE]: [
		'import { helper } from "./lib/helper";',
		"",
		"export function main(): number {",
		"\treturn helper(41);",
		"}",
		"",
	].join("\n"),
	[OTHER_HELPER_FILE]: [
		"export function otherHelper(n: number): number {",
		"\treturn n + 100;",
		"}",
		"",
	].join("\n"),
};

/** 1-based line of `helper`'s body in HELPER_FILE; inside `helper` only. */
export const HELPER_BODY_LINE = 2;
/** 1-based line of `main`'s body in APP_FILE. */
export const MAIN_BODY_LINE = 4;

export interface IndexedProject {
	/** realpath-resolved project root (the git worktree root). */
	readonly project: string;
	/** Scratch directory: sandbox HOME, embed cache, global lock. */
	readonly scratch: string;
	readonly cli: (args: string[]) => Promise<ChildRun>;
	readonly cleanup: () => void;
}

export async function indexedSpellingProject(
	prefix: string,
): Promise<IndexedProject> {
	const sandbox = createGitSandbox(prefix);
	const project = join(sandbox.root, "repo");
	const scratch = join(sandbox.root, "scratch");
	sandbox.git(sandbox.root, "init", "repo");
	writeFileSync(join(project, ".gitignore"), ".mnemex/\n");
	writeFileSync(
		join(project, "mnemex.json"),
		`${JSON.stringify(BM25_ONLY, null, 2)}\n`,
	);
	for (const [rel, text] of Object.entries(SOURCES)) {
		const full = join(project, rel);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, text);
	}
	sandbox.git(project, "add", "-A");
	sandbox.git(project, "commit", "-m", "initial");

	const cli = (args: string[]) => runCli(args, scratch, project);
	const indexed = await cli(["index"]);
	if (indexed.exitCode !== 0) {
		sandbox.cleanup();
		throw new Error(`index failed: ${indexed.stderr}`);
	}
	return { project, scratch, cli, cleanup: () => sandbox.cleanup() };
}

/** Every `file=<path>` value on every line of `--agent` output. */
export function agentFileValues(stdout: string): string[] {
	const values: string[] = [];
	for (const line of stdout.split("\n")) {
		for (const m of line.matchAll(/(?:^| )file=(\S+)/g)) values.push(m[1]);
	}
	return values;
}
