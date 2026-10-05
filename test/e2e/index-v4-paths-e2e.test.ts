/**
 * Index version 4 through the BUILT entry point (`dist/index.js`, so run
 * `bun run build` first; CLAUDE.md #13).
 *
 *   V1.6  `search --agent` returns repo paths ABSOLUTE and existing on disk,
 *         asserted from a cwd that is NOT the worktree root. A `docs:<pkg>` row
 *         comes back unchanged (architecture §3.1, decision D4). FALSIFIED by
 *         deleting the read seam's conversion: relative paths, which do not
 *         exist from that cwd.
 *   V4.3  the v3 -> v4 rebuild makes NO embedding requests, because the
 *         machine-global embedding cache is keyed on text, not path (§6.2). The
 *         counter is the fake provider's own request count, read by this process
 *         from outside the child. The CONTROL clears the cache and the count goes
 *         non-zero, which shows the counter is live.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createVectorStore } from "../../src/core/store.js";
import { startFakeOllamaEmbedServer } from "../helpers/fake-ollama-embed-server.js";
import { createGitSandbox } from "../helpers/git-sandbox.js";
import {
	agentResultPaths,
	BM25_ONLY,
	mainCheckoutStoreDir,
	runCli,
	sandboxHome,
	writeSource,
} from "../helpers/v4-fixtures.js";

const TEST_TIMEOUT_MS = 240_000;
const MODEL = "ollama/fake-embed";
const TOKEN = "zebraquokka";

describe("V1.6: search output paths are absolute and exist, from any cwd", () => {
	test(
		"a repo hit is absolute and on disk; a docs:<pkg> hit is exactly as stored",
		async () => {
			const sb = createGitSandbox("v16-");
			try {
				const project = join(sb.root, "project");
				mkdirSync(project);
				sb.git(project, "init", "-q");
				writeFileSync(join(project, "mnemex.json"), JSON.stringify(BM25_ONLY));
				writeSource(project, "src/deep/finder.ts", 2, TOKEN);
				writeSource(project, "src/other.ts", 2);
				sb.git(project, "add", "-A");
				sb.git(project, "commit", "-q", "-m", "init");
				const scratch = join(sb.root, "scratch");

				const indexed = await runCli(
					["index", "--agent", "--no-llm", project],
					scratch,
					project,
				);
				expect(indexed.exitCode, indexed.stderr).toBe(0);

				// An external-docs row, written as the docs phase writes one: synthetic,
				// shared. Through a store of this process's own on the same directory.
				const store = createVectorStore({
					vectorsDir: join(mainCheckoutStoreDir(project), "vectors"),
					pathRoot: project,
				});
				await store.initialize();
				await store.addChunks(
					[
						{
							id: "docs-row",
							contentHash: "docs-hash",
							content: `The ${TOKEN} package documentation.`,
							filePath: "docs:quokka-lib",
							startLine: 0,
							endLine: 0,
							language: "markdown",
							chunkType: "module",
							fileHash: "docs-file",
							vector: [0],
						},
					],
					{ pathKind: "synthetic", branchId: 0 },
				);
				await store.close();

				const searched = await runCli(
					["search", TOKEN, "-p", project, "--agent", "--no-reindex"],
					scratch,
					sb.root, // NOT the worktree root
				);
				expect(searched.exitCode, searched.stderr).toBe(0);
				const paths = agentResultPaths(searched.stdout);
				const repoPaths = paths.filter((p) => !p.startsWith("docs:"));
				expect(repoPaths.length).toBeGreaterThan(0);
				for (const path of repoPaths) {
					expect(isAbsolute(path)).toBe(true);
					expect(existsSync(path)).toBe(true);
				}
				expect(repoPaths).toContain(join(project, "src", "deep", "finder.ts"));
				expect(paths).toContain("docs:quokka-lib");
			} finally {
				sb.cleanup();
			}
		},
		TEST_TIMEOUT_MS,
	);
});

describe("V4.3: the rebuild is served from the embedding cache", () => {
	async function upgradeRun(clearCacheFirst: boolean): Promise<{
		warm: number;
		rebuild: number;
		stdout: string;
	}> {
		const sb = createGitSandbox("v43-");
		const servers = [
			startFakeOllamaEmbedServer(),
			startFakeOllamaEmbedServer(),
		];
		try {
			const project = join(sb.root, "project");
			mkdirSync(project);
			writeFileSync(
				join(project, "mnemex.json"),
				JSON.stringify({ enrichment: false }),
			);
			for (let i = 0; i < 6; i++) writeSource(project, `src/m${i}.ts`, 3);
			const scratch = join(sb.root, "scratch");
			const extra = { MNEMEX_MODEL: MODEL };
			const home = sandboxHome(scratch);
			const configure = (url: string) =>
				writeFileSync(
					join(home, ".mnemex", "config.json"),
					JSON.stringify({
						embeddingProvider: "ollama",
						ollamaEndpoint: url,
						defaultModel: MODEL,
					}),
				);
			mkdirSync(join(home, ".mnemex"), { recursive: true });

			// Warm: a v4 index fills the cache.
			configure(servers[0].url);
			const warm = await runCli(
				["index", "--agent", "--no-llm", project],
				scratch,
				project,
			);
			expect(warm.exitCode, warm.stderr).toBe(0);

			// Make the store a v3 one the way a v3 build stamped it: no store.json,
			// the version in config.json. The next run must rebuild.
			// This fixture's `project` is a PLAIN DIRECTORY (no `init` above), so
			// its store is `<project>/.mnemex` under row 4 — the row Phase 3c's
			// flip does not touch, which is FR-7's promise that no non-git user's
			// store moves. The V1.6 fixture above IS a repository and uses
			// `mainCheckoutStoreDir`; the difference is deliberate, not an
			// oversight.
			const storeDir = join(project, ".mnemex");
			rmSync(join(storeDir, "store.json"));
			writeFileSync(
				join(storeDir, "config.json"),
				JSON.stringify({ indexVersion: 3 }),
			);
			if (clearCacheFirst)
				rmSync(join(scratch, "embed-cache.db"), { force: true });

			configure(servers[1].url);
			const rebuild = await runCli(
				["index", "--agent", "--no-llm", project],
				scratch,
				project,
			);
			expect(rebuild.exitCode, rebuild.stderr).toBe(0);
			return {
				warm: servers[0].embedRequests(),
				rebuild: servers[1].embedRequests(),
				stdout: rebuild.stdout,
			};
		} finally {
			for (const server of servers) server.stop();
			sb.cleanup();
		}
	}

	test(
		"zero embedding requests reach the provider across the v3 -> v4 rebuild",
		async () => {
			const run = await upgradeRun(false);
			expect(run.warm).toBeGreaterThan(0);
			expect(run.stdout).toMatch(/^upgraded_from_index_version=3$/m);
			expect(run.rebuild).toBe(0);
		},
		TEST_TIMEOUT_MS,
	);

	test(
		"control: with the cache cleared, the same rebuild DOES reach the provider",
		async () => {
			const run = await upgradeRun(true);
			expect(run.stdout).toMatch(/^upgraded_from_index_version=3$/m);
			expect(run.rebuild).toBeGreaterThan(0);
		},
		TEST_TIMEOUT_MS,
	);
});
