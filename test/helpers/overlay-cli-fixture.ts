/**
 * A git project indexed by the BUILT entry point with REAL (fake-served)
 * embeddings, for the dirty overlay's end-to-end checks (step 3, phase 6).
 *
 * Every child runs through `runCli` (`v4-fixtures.ts`): `dist/index.js`,
 * `keychainSafeChildEnv()`, a sandbox HOME, `MNEMEX_EMBED_CACHE_PATH` and
 * `MNEMEX_GLOBAL_LOCK_PATH` inside the scratch directory (CLAUDE.md #24, #31).
 * The embedding provider is the in-process counting fake
 * (`fake-ollama-embed-server.ts`), so every claim about embedding cost or
 * model identity is read off the wire, from outside the child.
 *
 * `bun run build` is a precondition (CLAUDE.md #13).
 */

import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	type FakeEmbedServer,
	startFakeOllamaEmbedServer,
} from "./fake-ollama-embed-server.js";
import { createGitSandbox, type GitSandbox } from "./git-sandbox.js";
import { type ChildRun, runCli, sandboxHome } from "./v4-fixtures.js";

export const OVERLAY_E2E_MODEL = "ollama/fake-embed";

/** A small TypeScript file: `count` exported functions named `${stem}_<i>`. */
export function tsFunctions(
	stem: string,
	count: number,
	body = "n + 1",
): string {
	let text = "";
	for (let i = 0; i < count; i++) {
		text +=
			`export function ${stem}_${i}(n: number): number {\n` +
			`\t// ${stem} helper number ${i}\n` +
			`\treturn ${body};\n` +
			"}\n\n";
	}
	return text;
}

export interface OverlayCliProject {
	readonly sandbox: GitSandbox;
	/** realpath-resolved worktree root. */
	readonly project: string;
	readonly scratch: string;
	readonly server: FakeEmbedServer;
	/** `dist/index.js <args>` in `cwd` (default: the project). */
	cli(args: string[], cwd?: string): Promise<ChildRun>;
	write(rel: string, text: string, root?: string): void;
	remove(rel: string, root?: string): void;
	/** Rewrite the sandbox's `~/.mnemex/config.json` (merged over the base). */
	globalConfig(extra: Record<string, unknown>): void;
	/** Rewrite the project's `mnemex.json` (merged over the base). */
	projectConfig(extra: Record<string, unknown>, root?: string): void;
	/** The worktree's dirty-overlay directory, found by walking the store. */
	overlayDirs(): string[];
	cleanup(): void;
}

/** Every directory named `dirty-overlay` under `root`. */
export function findOverlayDirs(root: string): string[] {
	const found: string[] = [];
	const walk = (dir: string) => {
		let entries: import("node:fs").Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (!e.isDirectory()) continue;
			const full = join(dir, e.name);
			if (e.name === "dirty-overlay") found.push(full);
			else walk(full);
		}
	};
	walk(root);
	return found.sort();
}

/**
 * A committed project with `files`, indexed once (vectors ON, enrichment off)
 * by the built binary against a fake Ollama endpoint.
 */
export async function overlayCliProject(
	prefix: string,
	files: Readonly<Record<string, string>>,
	options: { model?: string; projectConfig?: Record<string, unknown> } = {},
): Promise<OverlayCliProject> {
	const sandbox = createGitSandbox(prefix);
	const project = join(sandbox.root, "repo");
	const scratch = join(sandbox.root, "scratch");
	// Bag-of-words vectors: a query lands near text that shares its words, so
	// ranking through a real search means something (M-4).
	const server = startFakeOllamaEmbedServer({
		vectors: "bag-of-words",
		dimension: 64,
	});
	const model = options.model ?? OVERLAY_E2E_MODEL;
	const baseProject = { enrichment: false, ...options.projectConfig };
	const baseGlobal = {
		embeddingProvider: "ollama",
		ollamaEndpoint: server.url,
		defaultModel: model,
	};
	try {
		sandbox.git(sandbox.root, "init", "-q", "repo");
		writeFileSync(join(project, ".gitignore"), ".mnemex/\n");
		writeFileSync(
			join(project, "mnemex.json"),
			`${JSON.stringify(baseProject, null, 2)}\n`,
		);
		for (const [rel, text] of Object.entries(files)) {
			const full = join(project, rel);
			mkdirSync(dirname(full), { recursive: true });
			writeFileSync(full, text);
		}
		sandbox.git(project, "add", "-A");
		sandbox.git(project, "commit", "-q", "-m", "initial");
		const home = sandboxHome(scratch);
		mkdirSync(join(home, ".mnemex"), { recursive: true });
		const writeGlobal = (extra: Record<string, unknown>) =>
			writeFileSync(
				join(home, ".mnemex", "config.json"),
				JSON.stringify({ ...baseGlobal, ...extra }),
			);
		writeGlobal({});

		const cli = (args: string[], cwd = project) => runCli(args, scratch, cwd);
		const indexed = await cli(["index", "--agent", "--no-llm"]);
		if (indexed.exitCode !== 0) {
			throw new Error(`index failed: ${indexed.stderr}\n${indexed.stdout}`);
		}
		return {
			sandbox,
			project,
			scratch,
			server,
			cli,
			write: (rel, text, root = project) => {
				const full = join(root, rel);
				mkdirSync(dirname(full), { recursive: true });
				writeFileSync(full, text);
			},
			remove: (rel, root = project) => rmSync(join(root, rel)),
			globalConfig: writeGlobal,
			projectConfig: (extra, root = project) =>
				writeFileSync(
					join(root, "mnemex.json"),
					`${JSON.stringify({ ...baseProject, ...extra }, null, 2)}\n`,
				),
			overlayDirs: () => findOverlayDirs(sandbox.root),
			cleanup: () => {
				server.stop();
				sandbox.cleanup();
			},
		};
	} catch (err) {
		server.stop();
		sandbox.cleanup();
		throw err;
	}
}

/** `key=value` header lines of `--agent` output (lines with no space before `=`). */
export function agentHeader(stdout: string): Map<string, string> {
	const header = new Map<string, string>();
	for (const line of stdout.split("\n")) {
		if (line.startsWith("result ") || line.startsWith("observation ")) continue;
		const eq = line.indexOf("=");
		if (eq <= 0 || line.slice(0, eq).includes(" ")) continue;
		header.set(line.slice(0, eq), line.slice(eq + 1));
	}
	return header;
}

/** The `result …` lines of `--agent` output. */
export function agentRows(stdout: string): string[] {
	return stdout.split("\n").filter((l) => l.startsWith("result "));
}
