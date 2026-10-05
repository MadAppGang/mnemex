/**
 * TIER 2 (architecture §4.1.2), and the specific gap the 3b-2 brief asks to be
 * answered with a MEASUREMENT rather than an opinion.
 *
 * `phase-3b-inputs.md` section 4: "**Code units are never reused from
 * LanceDB.** `getChunksWithVectors` filters `documentType = 'code_chunk'`.
 * 3b's two-tier hit test covers code units, so check that it actually closes
 * this gap."
 *
 * THE SHAPE THAT ISOLATES IT. Insert one line at the TOP of a file. Every chunk
 * and every code unit below it shifts down a line, so:
 *   - every CHUNK id changes (`filePath:startLine:endLine:content`);
 *   - every function UNIT id changes (`filePath:unitType:name:startRow` plus
 *     the unit's content hash since I-14 — the start row moves, so the id does
 *     either way, which is what keeps this a TIER-2 measurement);
 *   - and NOT ONE of their texts changes.
 * Tier 1 therefore misses everything and tier 2 must catch everything. §4.1.2's
 * honest prediction for this case is "N new rows and 0 embedding requests".
 *
 * THE COUNTER IS EXTERNAL and per ITEM: a fake Ollama endpoint that counts the
 * TEXTS it was asked to embed. A request count cannot answer this — one request
 * carries a batch — and `IndexResult.embedCache` is the indexer's report about
 * itself. The MACHINE-GLOBAL embedding cache is switched OFF for the run under
 * test, because it would serve the same reuse from a different place (#31) and
 * the question here is what the STORE contributes.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startFakeOllamaEmbedServer } from "../../helpers/fake-ollama-embed-server.js";
import { createGitSandbox } from "../../helpers/git-sandbox.js";
import {
	runCli,
	sandboxHome,
	storeRows,
	writeSource,
} from "../../helpers/v4-fixtures.js";

const TEST_TIMEOUT_MS = 300_000;
const MODEL = "ollama/fake-embed";

describe("tier 2: a header insert costs rows, not embeddings", () => {
	test(
		"code CHUNKS and code UNITS are both served from the store, measured per item",
		async () => {
			const sb = createGitSandbox("tier2-");
			const server = startFakeOllamaEmbedServer();
			try {
				const project = join(sb.root, "project");
				mkdirSync(project);
				writeFileSync(
					join(project, "mnemex.json"),
					JSON.stringify({ enrichment: false }),
				);
				for (let i = 0; i < 4; i++) writeSource(project, `src/f${i}.ts`, 4);
				const scratch = join(sb.root, "scratch");
				const home = sandboxHome(scratch);
				mkdirSync(join(home, ".mnemex"), { recursive: true });
				writeFileSync(
					join(home, ".mnemex", "config.json"),
					JSON.stringify({
						embeddingProvider: "ollama",
						ollamaEndpoint: server.url,
						defaultModel: MODEL,
					}),
				);
				// The machine-global cache OFF, so the only reuse available is the
				// store's own. With it on, the cache would answer first (its key is
				// `sha256(model \0 dimension \0 text)` — the same text, so the same
				// key) and this measurement would say nothing about tier 2.
				const extra = {
					MNEMEX_MODEL: MODEL,
					MNEMEX_DISABLE_EMBED_CACHE: "1",
				};

				const first = await runCli(
					["index", "--agent", "--no-llm", project],
					scratch,
					project,
					extra,
				);
				expect(first.exitCode, first.stderr).toBe(0);
				const coldItems = server.embedInputs();
				expect(coldItems).toBeGreaterThan(0);

				const rowsBefore = await storeRows(join(project, ".mnemex", "vectors"));
				const unitsBefore = rowsBefore.filter(
					(r) => r.documentType === "code_unit",
				).length;
				expect(unitsBefore).toBeGreaterThan(0);

				// ── The header insert: every id moves, no text does ──────────────
				server.resetCounts();
				for (let i = 0; i < 4; i++) {
					const path = join(project, "src", `f${i}.ts`);
					writeFileSync(path, `// shifted\n${readFileSync(path, "utf8")}`);
				}

				const second = await runCli(
					["index", "--agent", "--no-llm", project],
					scratch,
					project,
					extra,
				);
				expect(second.exitCode, second.stderr).toBe(0);
				const warmItems = server.embedInputs();

				const rowsAfter = await storeRows(join(project, ".mnemex", "vectors"));
				const unitsAfter = rowsAfter.filter(
					(r) => r.documentType === "code_unit",
				).length;

				// The ids really did move, which is what makes this a tier-2
				// measurement and not a tier-1 one.
				const idsBefore = new Set(rowsBefore.map((r) => String(r.id)));
				const shifted = rowsAfter.filter((r) => !idsBefore.has(String(r.id)));

				// THE EXPECTATION, DERIVED FROM THE DATA rather than hardcoded: a
				// text the store has never held HAS to reach the provider. The
				// inserted line is inside the file-level unit and inside whichever
				// chunk covers the top of the file, so those rows are genuinely
				// new content; every other row's text is byte-identical to one the
				// store already had, and tier 2 must serve all of them.
				const textsBefore = new Set(
					rowsBefore.map((r) => `${r.documentType}\u0000${r.content}`),
				);
				const newTexts = rowsAfter.filter(
					(r) => !textsBefore.has(`${r.documentType}\u0000${r.content}`),
				);
				const newUnitTexts = newTexts.filter(
					(r) => r.documentType === "code_unit",
				).length;

				// THE MEASUREMENT, printed so the numbers are in the record and not
				// only in an assertion.
				console.log(
					`tier-2 header insert: coldEmbedItems=${coldItems} warmEmbedItems=${warmItems} ` +
						`idsChanged=${shifted.length}/${rowsAfter.length} ` +
						`textsChanged=${newTexts.length} (code_unit ${newUnitTexts}) ` +
						`unitsBefore=${unitsBefore} unitsAfter=${unitsAfter}`,
				);

				// Nearly every id moved, so tier 1 served almost none of this and
				// the reuse below is tier 2's. The few that did not move are rows
				// whose position did not change either — and NONE of them carries
				// content the store did not already hold, which is the property
				// that makes serving them from tier 1 correct.
				expect(shifted.length).toBeGreaterThan(rowsAfter.length / 2);
				const reusedIdNewText = rowsAfter.filter(
					(r) =>
						idsBefore.has(String(r.id)) &&
						!textsBefore.has(`${r.documentType}\u0000${r.content}`),
				);
				expect(reusedIdNewText.map((r) => String(r.id))).toEqual([]);
				// And exactly the rows whose TEXT is new reached the provider.
				// §4.1.2's "N new rows and 0 embedding requests", with the "0"
				// read as "nothing whose text the store already held".
				expect(warmItems).toBe(newTexts.length);
				// The half `phase-3b-inputs.md` section 4 says was missing: code
				// units. `getChunksWithVectors` filters `documentType =
				// 'code_chunk'`, so before this phase every one of the
				// `unitsAfter - newUnitTexts` units below would have been
				// re-embedded. Now none of them is.
				expect(unitsAfter - newUnitTexts).toBeGreaterThan(0);

				// The row COUNT is stable: the shifted rows replaced their
				// predecessors rather than joining them (NARROW_CHUNKS and
				// NARROW_UNITS), which is the other half of §4.1.2's prediction.
				expect(unitsAfter).toBe(unitsBefore);
				expect(rowsAfter.length).toBe(rowsBefore.length);
			} finally {
				server.stop();
				sb.cleanup();
			}
		},
		TEST_TIMEOUT_MS,
	);
});
