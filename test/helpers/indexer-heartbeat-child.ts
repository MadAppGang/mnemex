/**
 * V2.4's BLOCKING process. It holds the store lock by running the REAL
 * `Indexer.index()` — twice — over a synthetic project, while the parent
 * (`test/unit/core/indexer-heartbeat.test.ts`) reads the lock file's
 * `heartbeat` field off disk. NOTHING HERE MEASURES ITSELF: this process only
 * does the work and reports what it did (row counts), never how long it
 * blocked. That is the parent's job, from outside (CLAUDE.md #24, #31).
 *
 * argv: <projectDir> <files> <functionsPerFile> <exportedFiles> <delete> <modify> <add> <phantom>
 *
 * Only the first <exportedFiles> files export their functions. The parent
 * passes all of them (its WORKLOAD comment says why): `resolveReferencesByName()`
 * is the statement that scales with EXPORTED symbols, so a pass that exported
 * almost nothing would not measure it. Its plan, which once cost
 * unresolved-references x exported symbols, is now pinned by
 * `tracker-resolve-plan.test.ts`.
 *
 * The phantom rows are seeded under `BRANCH_ID_SHARED`: the project is a temp
 * directory with no git layout, so every row the indexer itself writes there
 * carries that id too (index version 4, `files` primary key `(branch_id, path)`).
 *
 *   run 1  a first index of <files> files. The tracker is empty and the run is
 *          not forced, so it takes the INCREMENTAL path: getChanges over every
 *          file (sliced), deleteSymbolsByFile per new file, the batch loop's
 *          markIndexed per file, and extractSymbolGraph's parse + chunked graph
 *          inserts per file.
 *   run 2  after deleting <delete> files, modifying <modify>, adding <add>, and
 *          seeding <phantom> tracker rows for files that do not exist. That
 *          drives the deleted-files loop (<delete> + <phantom> iterations: the
 *          phantom rows carry no chunk ids, so their iterations are PURE tracker
 *          regions — the SR-2 shape with nothing else in between), the
 *          modified-files loop, and every loop of run 1 again at a smaller size.
 *
 * Vectors and enrichment are off (project config), and docs are off (env), so
 * no network and no keychain are reachable: the pipeline runs the real parser,
 * the real SQLite tracker and the real LanceDB store, with a placeholder `[0]`
 * vector per chunk — the production BM25-only mode.
 *
 * stdout, one `<TAG> <json>` line per event:
 *   LOCKS  { store, global }      the two lock files, printed before run 1
 *   RUN    { run, filesIndexed, chunksCreated, errors }
 *   STATE  { symbols, references, trackedFiles, phantomRemaining }
 */

import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { getIndexDbPath } from "../../src/config.js";
import { createIndexer } from "../../src/core/indexer.js";
import { getGlobalLockPath } from "../../src/core/lock.js";
import {
	getLockPathFor,
	resolveStoreLocation,
} from "../../src/core/store-location.js";
import { createFileTracker } from "../../src/core/tracker.js";
import { exitUnlessSandboxed } from "./sandbox-guard.js";

// `index()` reads ~/.mnemex/config.json and opens the embedding cache: refuse
// to start unless HOME is provably a temp directory (CLAUDE.md #25, #31).
exitUnlessSandboxed(homedir(), process.env.MNEMEX_TEST_SANDBOX_HOME, tmpdir());
if (!process.env.MNEMEX_EMBED_CACHE_PATH?.startsWith(tmpdir())) {
	console.error("MNEMEX_EMBED_CACHE_PATH must point inside tmpdir()");
	process.exit(64);
}
if (!process.env.MNEMEX_GLOBAL_LOCK_PATH?.startsWith(tmpdir())) {
	console.error("MNEMEX_GLOBAL_LOCK_PATH must point inside tmpdir()");
	process.exit(64);
}

const [projectDir, ...rest] = process.argv.slice(2);
const [files, fns, exportedFiles, toDelete, toModify, toAdd, phantom] =
	rest.map(Number);
if (
	!projectDir ||
	[files, fns, exportedFiles, toDelete, toModify, toAdd, phantom].some(
		(n) => n === undefined || !Number.isInteger(n) || n < 0,
	)
) {
	console.error(
		"usage: indexer-heartbeat-child <projectDir> <files> <functionsPerFile> <exportedFiles> <delete> <modify> <add> <phantom>",
	);
	process.exit(64);
}

/**
 * One synthetic TypeScript file: `count` functions — exported when `exported`
 * — each calling the next one in the file and one in the neighbouring file, so
 * the symbol graph gets definitions AND references to resolve.
 */
function source(
	name: string,
	index: number,
	count: number,
	exported: boolean,
): string {
	const out: string[] = [];
	for (let k = 0; k < count; k++) {
		out.push(
			`/** ${name} function ${k}. */\n` +
				`${exported ? "export " : ""}function ${name}_${k}(input: number): number {\n` +
				`\tconst local = input * ${k + 1};\n` +
				`\treturn ${name}_${(k + 1) % count}(local) + f${index + 1}_${k}(local);\n` +
				"}\n",
		);
	}
	return out.join("\n");
}

const srcDir = join(projectDir, "src");
mkdirSync(srcDir, { recursive: true });
mkdirSync(join(projectDir, ".mnemex"), { recursive: true });
writeFileSync(
	join(projectDir, ".mnemex", "config.json"),
	JSON.stringify({ vector: false, enrichment: false }),
);
for (let i = 0; i < files; i++) {
	writeFileSync(
		join(srcDir, `f${i}.ts`),
		source(`f${i}`, i, fns, i < (exportedFiles as number)),
	);
}

console.log(
	`LOCKS ${JSON.stringify({
		store: getLockPathFor(resolveStoreLocation(projectDir)),
		global: getGlobalLockPath(),
	})}`,
);

async function run(label: number): Promise<void> {
	const indexer = createIndexer({
		projectPath: projectDir,
		enableEnrichment: false,
	});
	try {
		const result = await indexer.index(false);
		console.log(
			`RUN ${JSON.stringify({
				run: label,
				filesIndexed: result.filesIndexed,
				chunksCreated: result.chunksCreated,
				errors: result.errors.length,
			})}`,
		);
	} finally {
		await indexer.close();
	}
}

await run(1);

// ── Between the runs: no lock is held, so nothing here is measured. ─────────
for (let i = 0; i < toDelete; i++) {
	unlinkSync(join(srcDir, `f${i}.ts`));
}
for (let i = toDelete; i < toDelete + toModify; i++) {
	const path = join(srcDir, `f${i}.ts`);
	writeFileSync(
		path,
		`${readFileSync(path, "utf8")}\nfunction extra_${i}(): number {\n\treturn ${i};\n}\n`,
	);
}
for (let i = 0; i < toAdd; i++) {
	writeFileSync(join(srcDir, `n${i}.ts`), source(`n${i}`, i, fns, false));
}
{
	const seed = createFileTracker(getIndexDbPath(projectDir), projectDir);
	for (let i = 0; i < phantom; i++) {
		seed.markIndexed(
			0,
			join(projectDir, "phantom", `p${i}.ts`),
			`phantom-${i}`,
			[],
		);
	}
	seed.close();
}

await run(2);

// ── What the runs left behind: data, read after the fact. ──────────────────
{
	const tracker = createFileTracker(getIndexDbPath(projectDir), projectDir);
	// The child indexes a plain temp directory with no repository layout, so
	// every row it writes carries `BRANCH_ID_SHARED` — the same id the phantom
	// seed above uses.
	const stats = tracker.graph(0).getSymbolGraphStats();
	const tracked = tracker.getAllFiles(0);
	console.log(
		`STATE ${JSON.stringify({
			symbols: stats.totalSymbols,
			references: stats.totalReferences,
			trackedFiles: tracked.length,
			phantomRemaining: tracked.filter((f) => f.path.startsWith("phantom/"))
				.length,
		})}`,
	);
	tracker.close();
}
process.exit(0);
