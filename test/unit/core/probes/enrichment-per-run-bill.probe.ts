/**
 * How much does §4.6 save on an ORDINARY re-index of ONE branch?
 *
 * `invalidateForCommit` runs on every `mnemex index` and queues re-enrichment
 * for every path in HEAD's diff against its first parent. So a second run that
 * changes nothing still sends those files to the LLM. Measured here as LLM
 * calls per run, three runs, no file ever modified.
 */
import { mkdirSync, writeFileSync } from "node:fs";
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
const sb = createGitSandbox("enrich-bill-");
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
	for (let i = 0; i < 5; i++) writeSource(project, `src/f${i}.ts`, 2);
	sb.git(project, "add", "-A");
	sb.git(project, "commit", "-q", "-m", "init");
	// A SECOND commit touching one file, so HEAD's diff is one file rather than
	// the whole tree — the shape a real repository is in.
	writeSource(project, "src/f0.ts", 2, "second");
	sb.git(project, "add", "-A");
	sb.git(project, "commit", "-q", "-m", "touch f0");

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

	for (let run = 1; run <= 3; run++) {
		llm.resetCounts();
		const result = await runCli(
			["index", "--agent", project],
			scratch,
			project,
			extra,
		);
		const keys = result.stdout
			.split("\n")
			.filter(
				(l) => l.startsWith("enrichment_") || l.startsWith("indexed_files"),
			)
			.join(" ");
		console.log(
			`run ${run}: exit=${result.exitCode} llmCalls=${llm.calls()} ${keys}`,
		);
	}
} finally {
	llm.stop();
	embed.stop();
	sb.cleanup();
}
