/**
 * V3.13 — "second worktree of an enriched tree: LLM call count == 0", end to
 * end, through the BUILT `mnemex index` (architecture §7, §4.6, decision I-15).
 *
 * HOW THE COUNT IS TAKEN, and why it is taken that way. §7 asks for "a stub
 * client with a file-backed counter". This counts one step further out: the
 * child runs the REAL `LocalLLMClient` against an OpenAI-compatible endpoint
 * the PARENT is serving, so the number is requests that really arrived at a
 * socket in this process — not a file the child wrote about itself. Nothing in
 * `src/` is modified to make it possible and there is no injection seam in
 * production code: the child is pointed at the endpoint the way a user points
 * mnemex at LM Studio, through `~/.mnemex/config.json` in its own sandboxed
 * HOME plus `MNEMEX_LLM`.
 *
 * Embeddings go to the existing fake Ollama endpoint, so the run needs no
 * network, no model and no keychain. Every child's environment comes from
 * `sandboxEnv()` → `keychainSafeChildEnv()` (CLAUDE.md #24, #25, #31).
 *
 * BOTH DIRECTIONS, in one run: worktree B pays NOTHING for the tree it shares,
 * and pays again the moment a file genuinely differs. A reuse path that reuses
 * everything is indistinguishable from one broken in the expensive direction.
 *
 * It also carries V3.5's THIRD count — the enriched summary, per revision —
 * which 3b-2's finding 2 could not cover because this tree had no way to drive
 * the enricher without a real LLM.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startFakeOllamaEmbedServer } from "../../helpers/fake-ollama-embed-server.js";
import { createGitSandbox } from "../../helpers/git-sandbox.js";
import { startFakeLLMServer } from "../../helpers/stub-llm.js";
import {
	type ChildRun,
	runCli,
	sandboxHome,
	storeRows,
	writeSource,
} from "../../helpers/v4-fixtures.js";

const TEST_TIMEOUT_MS = 420_000;
const EMBED_MODEL = "ollama/fake-embed";

/** `key=value` from an `--agent` run. */
function agentValue(run: ChildRun, key: string): string | null {
	for (const line of run.stdout.split("\n")) {
		if (line.startsWith(`${key}=`)) return line.slice(key.length + 1);
	}
	return null;
}

function agentNumber(run: ChildRun, key: string): number | null {
	const value = agentValue(run, key);
	return value === null ? null : Number(value);
}

function summaryRowsFor(
	rows: Array<Record<string, unknown>>,
	path: string,
): Array<Record<string, unknown>> {
	return rows.filter(
		(r) =>
			r.filePath === path &&
			(r.documentType === "file_summary" ||
				r.documentType === "symbol_summary"),
	);
}

function allSummaryRows(
	rows: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
	return rows.filter(
		(r) =>
			r.documentType === "file_summary" || r.documentType === "symbol_summary",
	);
}

/** One read through a SQLite connection neither child ever held. */
function withIndexDb<T>(indexDb: string, fn: (db: Database) => T): T {
	const db = new Database(indexDb, { readonly: true });
	try {
		return fn(db);
	} finally {
		db.close();
	}
}

describe("V3.13 — a second worktree buys no summaries, and buys the ones that changed", () => {
	test(
		"LLM calls == 0 on worktree B; non-zero for the file B actually changed",
		async () => {
			const sb = createGitSandbox("enrich-reuse-e2e-");
			const embed = startFakeOllamaEmbedServer();
			const llm = startFakeLLMServer();
			try {
				const main = join(sb.root, "main");
				mkdirSync(main);
				sb.git(main, "init", "-q", "-b", "main");
				// Vectors ON (enrichment needs the embeddings client) and
				// enrichment ON — the whole point of this run.
				writeFileSync(
					join(main, "mnemex.json"),
					JSON.stringify({ vector: true, enrichment: true }),
				);
				for (let i = 0; i < 3; i++) writeSource(main, `src/f${i}.ts`, 2);
				sb.git(main, "add", "-A");
				sb.git(main, "commit", "-q", "-m", "init");

				const scratch = join(sb.root, "scratch");
				const home = sandboxHome(scratch);
				mkdirSync(join(home, ".mnemex"), { recursive: true });
				writeFileSync(
					join(home, ".mnemex", "config.json"),
					JSON.stringify({
						embeddingProvider: "ollama",
						ollamaEndpoint: embed.url,
						defaultModel: EMBED_MODEL,
						// Where the REAL LocalLLMClient posts its completions.
						llmEndpoint: llm.url,
					}),
				);
				const store = join(sb.root, "shared-store");
				const extra = {
					MNEMEX_MODEL: EMBED_MODEL,
					MNEMEX_LLM: "local/stub-model",
					MNEMEX_INDEX_DIR: store,
					MNEMEX_DISABLE_EMBED_CACHE: "1",
				};
				const vectors = join(store, "vectors");
				const indexDb = join(store, "index.db");

				// ── Worktree A: the tree is enriched for the first time ────────
				const first = await runCli(
					["index", "--agent", main],
					scratch,
					main,
					extra,
				);
				expect(first.exitCode, first.stderr).toBe(0);
				const coldCalls = llm.calls();
				expect(coldCalls).toBeGreaterThan(0);
				// DERIVED from the run's own file count rather than hardcoded:
				// `mnemex.json` is an indexable file too, so the tree is four
				// files, not the three sources this test writes.
				const indexedFiles = agentNumber(first, "indexed_files");
				expect(indexedFiles).toBeGreaterThan(0);
				expect(agentNumber(first, "enrichment_files_reused")).toBe(0);
				expect(agentNumber(first, "enrichment_files_enriched")).toBe(
					indexedFiles,
				);
				expect(agentNumber(first, "enrichment_files_refused")).toBe(0);

				const rowsAfterA = await storeRows(vectors);
				const summariesA = allSummaryRows(rowsAfterA);
				expect(summariesA.length).toBeGreaterThan(0);
				const branchA = agentNumber(first, "branch_id");
				expect(branchA).toBe(1);

				// ── Worktree B: same content, one store, a different branch ────
				llm.resetCounts();
				const feat = join(sb.root, "feat");
				sb.git(main, "worktree", "add", "-q", "-b", "feat", feat);

				const second = await runCli(
					["index", "--agent", feat],
					scratch,
					feat,
					extra,
				);
				expect(second.exitCode, second.stderr).toBe(0);

				// V3.13. A COUNT OF REQUESTS THAT ARRIVED, in this process.
				expect(llm.calls()).toBe(0);
				expect(agentNumber(second, "enrichment_files_reused")).toBe(
					indexedFiles,
				);
				expect(agentNumber(second, "enrichment_files_enriched")).toBe(0);
				expect(agentNumber(second, "enrichment_files_refused")).toBe(0);
				expect(agentNumber(second, "enrichment_docs_reused")).toBe(
					summariesA.length,
				);

				// NOT A SILENCE: the rows did not double, they WIDENED, and branch
				// 2 holds every summary id branch 1 does — through connections
				// neither child ever had.
				const rowsAfterB = await storeRows(vectors);
				expect(allSummaryRows(rowsAfterB).length).toBe(summariesA.length);
				const branchB = agentNumber(second, "branch_id");
				expect(branchB).toBe(2);
				const summaryIds = summariesA.map((r) => String(r.id)).sort();
				const memberOfB = withIndexDb(indexDb, (db) =>
					(
						db
							.prepare(
								"SELECT chunk_id FROM chunk_branches WHERE branch_id = 2 ORDER BY chunk_id",
							)
							.all() as Array<{ chunk_id: string }>
					).map((r) => r.chunk_id),
				);
				for (const id of summaryIds) expect(memberOfB).toContain(id);
				const documentsOfB = withIndexDb(indexDb, (db) =>
					(
						db
							.prepare(
								"SELECT id FROM documents WHERE branch_id = 2 ORDER BY id",
							)
							.all() as Array<{ id: string }>
					).map((r) => r.id),
				);
				expect(documentsOfB.sort()).toEqual(summaryIds);
				// The drain wrote the mirror, so a search from either branch sees
				// them: every summary row now carries BOTH ids.
				for (const row of allSummaryRows(rowsAfterB)) {
					expect(row.branchIds).toBe(",1,2,");
				}

				// ── THE OTHER DIRECTION: one file on B genuinely changes ───────
				llm.resetCounts();
				const changed = join(feat, "src", "f1.ts");
				writeFileSync(
					changed,
					`${readFileSync(changed, "utf8")}\nexport const addedOnFeat = 42;\n`,
				);
				const third = await runCli(
					["index", "--agent", feat],
					scratch,
					feat,
					extra,
				);
				expect(third.exitCode, third.stderr).toBe(0);

				// It paid for exactly the file that changed, and for nothing else.
				//
				// `files_reused` is NOT 0 here, and the reason is worth reading:
				// `invalidateForCommit` runs on every index run and queues
				// re-enrichment for every path in HEAD's diff against its first
				// parent — this fixture's single commit, so the whole tree. Those
				// files reach the enricher on every run, and before §4.6 every one
				// of them was sent to the LLM again. Measured on a two-commit
				// fixture where HEAD's diff is one file:
				// `probes/enrichment-per-run-bill.probe.ts` reports `llmCalls=1`
				// per no-op run without the reuse path and `llmCalls=0` with it.
				expect(llm.calls()).toBeGreaterThan(0);
				expect(agentNumber(third, "enrichment_files_enriched")).toBe(1);
				expect(agentNumber(third, "enrichment_files_reused")).toBe(
					(indexedFiles ?? 0) - 1,
				);
				expect(agentNumber(third, "enrichment_files_refused")).toBe(0);
				// Every prompt that arrived was about the changed file.
				for (const prompt of llm.prompts()) {
					expect(prompt).toContain("f1");
					expect(prompt).not.toContain("f0_0");
				}

				// Branch 1's summaries for that path survive, branch 2 has its
				// own, and no row is shared between the two revisions.
				const rowsAfterChange = await storeRows(vectors);
				const forChanged = summaryRowsFor(rowsAfterChange, "src/f1.ts");
				const memberships = new Set(forChanged.map((r) => String(r.branchIds)));
				expect(memberships.has(",1,")).toBe(true);
				expect(memberships.has(",2,")).toBe(true);
				expect(memberships.has(",1,2,")).toBe(false);
			} finally {
				llm.stop();
				embed.stop();
				sb.cleanup();
			}
		},
		TEST_TIMEOUT_MS,
	);
});

describe("V3.5's third count — the enriched summary, end to end", () => {
	test(
		"a file modified twice on one branch keeps only the CURRENT revision's summaries",
		async () => {
			const sb = createGitSandbox("enrich-v35-");
			const embed = startFakeOllamaEmbedServer();
			const llm = startFakeLLMServer();
			try {
				const project = join(sb.root, "project");
				mkdirSync(project);
				sb.git(project, "init", "-q", "-b", "main");
				writeFileSync(
					join(project, "mnemex.json"),
					JSON.stringify({ vector: true, enrichment: true }),
				);
				writeSource(project, "src/a.ts", 2, "rev1");
				sb.git(project, "add", "-A");
				sb.git(project, "commit", "-q", "-m", "init");

				const scratch = join(sb.root, "scratch");
				const home = sandboxHome(scratch);
				mkdirSync(join(home, ".mnemex"), { recursive: true });
				writeFileSync(
					join(home, ".mnemex", "config.json"),
					JSON.stringify({
						embeddingProvider: "ollama",
						ollamaEndpoint: embed.url,
						defaultModel: EMBED_MODEL,
						llmEndpoint: llm.url,
					}),
				);
				const extra = {
					MNEMEX_MODEL: EMBED_MODEL,
					MNEMEX_LLM: "local/stub-model",
					MNEMEX_DISABLE_EMBED_CACHE: "1",
				};
				const vectors = join(project, ".mnemex", "vectors");

				const counts: number[] = [];
				for (const token of ["rev1", "rev2", "rev3"]) {
					writeSource(project, "src/a.ts", 2, token);
					const run = await runCli(
						["index", "--agent", project],
						scratch,
						project,
						extra,
					);
					expect(run.exitCode, run.stderr).toBe(0);
					counts.push(
						summaryRowsFor(await storeRows(vectors), "src/a.ts").length,
					);
				}

				// THE COUNT: the third revision's summaries only. Without
				// NARROW_SUMMARIES this is the SUM over three revisions.
				expect(counts[0]).toBeGreaterThan(0);
				expect(counts[1]).toBe(counts[0]);
				expect(counts[2]).toBe(counts[0]);
				// And they really are the current revision's: the stub's answer is
				// a function of the prompt, so a stale summary would carry an older
				// revision's digest.
				const current = summaryRowsFor(await storeRows(vectors), "src/a.ts");
				expect(current.length).toBe(counts[0]);
				for (const row of current) {
					expect(String(row.content).length).toBeGreaterThan(0);
				}
			} finally {
				llm.stop();
				embed.stop();
				sb.cleanup();
			}
		},
		TEST_TIMEOUT_MS,
	);
});
