/**
 * R1 through the BUILT entry point — the absolute check (NFR-4) on the real
 * pipeline: real chunking, real symbol extraction, real PageRank, the store's
 * ABSOLUTE result paths meeting the tracker's REPO-RELATIVE symbol paths.
 *
 * Fixture: one name, `get`, defined twice —
 *   src/cache.ts               live: `readUser` in src/users.ts calls it
 *   test/cache-helpers.test.ts dead: unexported, nothing calls it
 * plus a filler file of FILLER_FUNCTIONS small functions, so that an uncalled
 * symbol's normalised PageRank falls under the penalty's 0.001 threshold the
 * way it does in a real repository (a five-symbol graph puts every node near
 * 1/5 and nothing is ever "dead").
 *
 * Asserted, all of it absolute rather than differential:
 *   - `penalty_same_file` > 0 — the shipped comparison scored 0 of 217;
 *   - the LIVE `get` carries no `penalty=dead`; the DEAD one does;
 *   - the header keys are present on every search.
 *
 * FALSIFIED BY building `dist/` with the old `?? syms[0]` comparison: the
 * same-file count is 0 and the verdicts are decided by whichever `get` SQLite
 * returns first. Executed in Phase 1; output in the session implementation log.
 *
 * `bun run build` is a precondition (CLAUDE.md #13).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	createGitSandbox,
	type GitSandbox,
} from "../../helpers/git-sandbox.js";
import {
	BM25_ONLY,
	type ChildRun,
	runCli,
	writeSource,
} from "../../helpers/v4-fixtures.js";

const TIMEOUT_MS = 300_000;
const FILLER_FUNCTIONS = 1500;

let sandbox: GitSandbox;
let project: string;
let scratch: string;
let search: ChildRun;

function write(rel: string, text: string): void {
	const full = join(project, rel);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, text);
}

beforeAll(async () => {
	sandbox = createGitSandbox("mnemex-penalty-e2e-");
	project = join(sandbox.root, "repo");
	scratch = join(sandbox.root, "scratch");
	sandbox.git(sandbox.root, "init", "repo");
	writeFileSync(join(project, ".gitignore"), ".mnemex/\n");
	writeFileSync(join(project, "mnemex.json"), JSON.stringify(BM25_ONLY));
	write(
		"src/cache.ts",
		"export function get(key: string): string {\n\treturn 'cached:' + key;\n}\n",
	);
	write(
		"src/users.ts",
		'import { get } from "./cache";\n\nexport function readUser(): string {\n\treturn get("user");\n}\n',
	);
	// UNEXPORTED, as test helpers usually are. Reference resolution binds a
	// call to an EXPORTED symbol of that name (`resolveReferencesByName`), so
	// this keeps `readUser -> get` resolved to src/cache.ts — the graph's
	// answer is not what this file tests, the penalty's reading of it is.
	write(
		"test/cache-helpers.test.ts",
		"function get(key: string): string {\n\treturn 'fake:' + key;\n}\n",
	);
	writeSource(project, "src/filler.ts", FILLER_FUNCTIONS, "filler");
	sandbox.git(project, "add", "-A");
	sandbox.git(project, "commit", "-m", "initial");

	const indexed = await runCli(["index"], scratch, project);
	if (indexed.exitCode !== 0) throw new Error(`index: ${indexed.stderr}`);
	search = await runCli(
		["--agent", "search", "get", "-n", "20"],
		scratch,
		project,
	);
}, TIMEOUT_MS);

afterAll(() => {
	sandbox?.cleanup();
});

function header(key: string): number {
	const line = search.stdout.split("\n").find((l) => l.startsWith(`${key}=`));
	if (line === undefined) throw new Error(`no ${key}= line:\n${search.stdout}`);
	return Number(line.slice(key.length + 1));
}

function getRow(relPath: string): string {
	const rows = search.stdout
		.split("\n")
		.filter(
			(l) =>
				l.startsWith(`result file=${join(project, relPath)} `) &&
				/ name=get( |$)/.test(l),
		);
	expect(rows, search.stdout).toHaveLength(1);
	return rows[0];
}

describe("search --agent: the dead-code penalty judges the symbol in the result's OWN file", () => {
	test("the search ran and returned both `get` rows", () => {
		expect(search.exitCode, search.stderr).toBe(0);
		getRow("src/cache.ts");
		getRow("test/cache-helpers.test.ts");
	});

	test("same-file lookups SUCCEED (the shipped comparison scored 0)", () => {
		expect(header("penalty_lookups")).toBeGreaterThanOrEqual(2);
		expect(header("penalty_same_file")).toBeGreaterThanOrEqual(2);
		expect(header("penalty_applied")).toBeGreaterThanOrEqual(1);
	});

	test("the live `get` is not penalised; the dead `get` is (A)", () => {
		expect(getRow("src/cache.ts")).not.toContain("penalty=dead");
		expect(getRow("test/cache-helpers.test.ts")).toContain(" penalty=dead");
	});
});
