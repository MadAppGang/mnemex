/**
 * Why does the THIRD run queue files the second run adopted? Measured, not
 * guessed. Prints the `files` table (path, branch, enrichment_state) after each
 * of three real `mnemex index` runs across two worktrees of one store.
 */
import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startFakeOllamaEmbedServer } from "../../../helpers/fake-ollama-embed-server.js";
import { createGitSandbox } from "../../../helpers/git-sandbox.js";
import { startFakeLLMServer } from "../../../helpers/stub-llm.js";
import {
	runCli,
	sandboxHome,
	writeSource,
} from "../../../helpers/v4-fixtures.js";

const EMBED_MODEL = "ollama/fake-embed";
const sb = createGitSandbox("enrich-requeue-");
const embed = startFakeOllamaEmbedServer();
const llm = startFakeLLMServer();

function dump(indexDb: string, label: string): void {
	const db = new Database(indexDb, { readonly: true });
	const rows = db
		.prepare(
			"SELECT branch_id, path, enrichment_state, content_hash FROM files ORDER BY branch_id, path",
		)
		.all() as Array<{
		branch_id: number;
		path: string;
		enrichment_state: string;
		content_hash: string;
	}>;
	console.log(`\n=== ${label} ===`);
	for (const row of rows) {
		console.log(
			`  b${row.branch_id} ${row.path.padEnd(16)} ${row.enrichment_state}`,
		);
	}
	const records = db
		.prepare("SELECT COUNT(*) AS n FROM enrichment_by_content")
		.get() as { n: number };
	console.log(`  enrichment_by_content rows: ${records.n}`);
	db.close();
}

try {
	const main = join(sb.root, "main");
	mkdirSync(main);
	sb.git(main, "init", "-q", "-b", "main");
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
	const indexDb = join(store, "index.db");

	const a = await runCli(["index", "--agent", main], scratch, main, extra);
	console.log("run A exit", a.exitCode, "llm", llm.calls());
	console.log(
		a.stdout
			.split("\n")
			.filter((l) => l.startsWith("enrichment_") || l.startsWith("indexed_"))
			.join("\n"),
	);
	dump(indexDb, "after A (branch 1)");

	llm.resetCounts();
	const feat = join(sb.root, "feat");
	sb.git(main, "worktree", "add", "-q", "-b", "feat", feat);
	const b = await runCli(["index", "--agent", feat], scratch, feat, extra);
	console.log("run B exit", b.exitCode, "llm", llm.calls());
	console.log(
		b.stdout
			.split("\n")
			.filter((l) => l.startsWith("enrichment_") || l.startsWith("indexed_"))
			.join("\n"),
	);
	dump(indexDb, "after B (branch 2 adopts)");

	llm.resetCounts();
	const changed = join(feat, "src", "f1.ts");
	writeFileSync(
		changed,
		`${readFileSync(changed, "utf8")}\nexport const addedOnFeat = 42;\n`,
	);
	const c = await runCli(["index", "--agent", feat], scratch, feat, extra);
	console.log("run C exit", c.exitCode, "llm", llm.calls());
	console.log(
		c.stdout
			.split("\n")
			.filter((l) => l.startsWith("enrichment_") || l.startsWith("indexed_"))
			.join("\n"),
	);
	console.log(
		"prompts:",
		llm.prompts().map((p) => p.split("\n")[0]),
	);
	dump(indexDb, "after C (one file changed on branch 2)");
} finally {
	llm.stop();
	embed.stop();
	sb.cleanup();
}
