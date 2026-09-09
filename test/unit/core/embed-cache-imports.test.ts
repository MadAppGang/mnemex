/**
 * THE IMPORT ALLOWLIST — a CI-visible guard, not an intention.
 *
 * The cache is a machine-global write-path component. It must not be able to
 * widen `config.ts`'s dependency graph, because the one pre-existing failure in
 * this repository's suite is an import-order fault through
 * `config.ts:1665` -> `mcp/tools/deps.ts:114` -> `mcp/tools/search.ts:295`, and
 * a second edge into that graph is how a latent fragility becomes a broken
 * build. `src/core/keychain.ts` follows the same rule deliberately: it owns
 * `guardedProcessReason()` precisely because it "has no imports, so no cycle"
 * (CLAUDE.md #24).
 *
 * This reads source and executes none of it, so it cannot be satisfied by a
 * runtime accident. The detector is falsified against fixture text at the bottom
 * — a rule that matches nothing proves nothing.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "..", "..", "src");

/** Node builtins this project's leaf modules may use. */
const NODE_BUILTINS = /^node:(crypto|fs|os|path|util|url|buffer)$/;

interface Rule {
	file: string;
	/** Local specifiers allowed, exactly. An empty list means NO imports at all. */
	allowedLocal: string[];
	allowNodeBuiltins: boolean;
	/** When false, the file need not exist yet (a later phase creates it). */
	required: boolean;
}

const RULES: Rule[] = [
	{
		file: "core/embed-cache.ts",
		allowedLocal: ["./sqlite.js"],
		allowNodeBuiltins: true,
		required: true,
	},
	{
		// The leaf exists for ONE reason: so the caching proxy can catch
		// `TotalEmbeddingFailureError` by identity without importing
		// `embeddings.ts`. An import here would defeat the entire arrangement.
		file: "core/embeddings-errors.ts",
		allowedLocal: [],
		allowNodeBuiltins: false,
		required: true,
	},
	{
		// Phase 2. The rule existed from Phase 1, before the file did; Phase 2
		// makes it REQUIRED and drops `./sqlite.js`, which the proxy turned out not
		// to need — it reaches SQLite only through `EmbedCacheLike`.
		//
		// `./embeddings.js` is the one that matters here and it is on FORBIDDEN
		// below: the proxy must catch `TotalEmbeddingFailureError` by identity, and
		// the whole reason `embeddings-errors.ts` exists as a no-import leaf is so
		// that catching it does not require importing the module that throws it.
		file: "core/caching-embeddings-client.ts",
		allowedLocal: ["../types.js", "./embed-cache.js", "./embeddings-errors.js"],
		allowNodeBuiltins: true,
		required: true,
	},
	{
		// The seam the cache depends on. It reaches ONE level further than the
		// others — the two driver packages, `require()`d inside the factory so
		// only the one for the running runtime is ever resolved — and nothing
		// else. If it ever grows a project import, the allowlist above becomes a
		// claim about a graph nobody is checking.
		file: "core/sqlite.ts",
		allowedLocal: ["bun:sqlite", "better-sqlite3"],
		allowNodeBuiltins: false,
		required: true,
	},
];

/** Specifiers that must never appear in ANY of the files above. */
const FORBIDDEN = [
	/^\.\.\/config\.js$/,
	/^\.\/indexer\.js$/,
	/^\.\/embeddings\.js$/,
	/^\.\.\/cli\.js$/,
	/^\.\.\/mcp\//,
];

function stripComments(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * Every module specifier the file acquires a dependency through, in any form:
 * a static import, a side-effect import, a re-export, a dynamic `import()` and
 * `require()`. Type-only imports are INCLUDED deliberately — the compiler erases
 * them, but the next edit that needs a value from the same module will quietly
 * drop the `type` keyword, and by then the allowlist has already been passed.
 */
export function importedSpecifiers(source: string): string[] {
	const clean = stripComments(source);
	const found = new Set<string>();
	const patterns = [
		/\bimport\s+[\s\S]*?\bfrom\s*["']([^"']+)["']/g,
		/\bexport\s+[\s\S]*?\bfrom\s*["']([^"']+)["']/g,
		/\bimport\s*["']([^"']+)["']/g,
		/\bimport\s*\(\s*["']([^"']+)["']/g,
		/\brequire\s*\(\s*["']([^"']+)["']/g,
	];
	for (const re of patterns) {
		for (const match of clean.matchAll(re)) {
			if (match[1] !== undefined) found.add(match[1]);
		}
	}
	return [...found];
}

describe("the new cache modules import nothing that can widen config.ts's graph", () => {
	for (const rule of RULES) {
		const path = join(SRC, rule.file);
		const present = existsSync(path);

		test(`${rule.file}: every specifier is on the allowlist`, () => {
			if (!present) {
				expect(rule.required).toBe(false);
				return;
			}
			const specifiers = importedSpecifiers(readFileSync(path, "utf8"));
			const offenders = specifiers.filter((s) => {
				if (rule.allowNodeBuiltins && NODE_BUILTINS.test(s)) return false;
				return !rule.allowedLocal.includes(s);
			});
			expect(offenders).toEqual([]);
		});

		test(`${rule.file}: none of the forbidden specifiers appear`, () => {
			if (!present) {
				expect(rule.required).toBe(false);
				return;
			}
			const specifiers = importedSpecifiers(readFileSync(path, "utf8"));
			const offenders = specifiers.filter((s) =>
				FORBIDDEN.some((re) => re.test(s)),
			);
			expect(offenders).toEqual([]);
		});
	}

	test("embeddings-errors.ts has ZERO imports of any kind", () => {
		const source = readFileSync(join(SRC, "core/embeddings-errors.ts"), "utf8");
		expect(importedSpecifiers(source)).toEqual([]);
	});

	test("the cache is NOT opened from embeddings.ts (grok M1's widening risk)", () => {
		// Putting `openEmbedCache()` or the proxy construction behind
		// `createEmbeddingsClient()` would pull the cache into `embeddings.ts`'s
		// graph — which already imports `config.ts` — and make this whole
		// allowlist unenforceable. The cache is opened by `Indexer.index()` and
		// the proxy is installed by `Indexer.initialize()`, at one place each.
		const source = stripComments(
			readFileSync(join(SRC, "core/embeddings.ts"), "utf8"),
		);
		expect(source).not.toMatch(/\bopenEmbedCache\b/);
		expect(source).not.toMatch(/\bCachingEmbeddingsClient\b/);
		expect(importedSpecifiers(source)).not.toContain("./embed-cache.js");
		expect(importedSpecifiers(source)).not.toContain(
			"./caching-embeddings-client.js",
		);
	});
});

describe("guarding the guard — the detector sees every import form", () => {
	// Each string is a real way to acquire a dependency. A detector that missed
	// any one of them would pass a file that had already widened the graph.
	const forms: Array<[string, string]> = [
		["static default", 'import config from "../config.js";'],
		["static named", 'import { loadGlobalConfig } from "../config.js";'],
		[
			"multi-line named",
			'import {\n\tloadGlobalConfig,\n\tgetExcludePatterns,\n} from "../config.js";',
		],
		["namespace", 'import * as cfg from "../config.js";'],
		["type-only", 'import type { GlobalConfig } from "../config.js";'],
		["side-effect", 'import "../config.js";'],
		["re-export", 'export { loadGlobalConfig } from "../config.js";'],
		["re-export star", 'export * from "../config.js";'],
		["dynamic", 'const c = await import("../config.js");'],
		["require", 'const c = require("../config.js");'],
	];

	for (const [label, source] of forms) {
		test(`catches a ${label} import`, () => {
			expect(importedSpecifiers(source)).toContain("../config.js");
		});
	}

	test("does NOT count a specifier that only appears inside a comment", () => {
		const source = [
			'// import { x } from "../config.js";',
			'/* import "../config.js"; */',
			'import { createDatabaseSync } from "./sqlite.js";',
		].join("\n");
		expect(importedSpecifiers(source)).toEqual(["./sqlite.js"]);
	});
});
