/**
 * NFR-2 and NFR-3 for the store-location seam, pinned by READING source. This
 * file executes none of the modules it checks.
 *
 *   NFR-2  Resolving where a store lives must not construct an LLM or
 *          embeddings client, or reach the keychain (CLAUDE.md #24, #27).
 *          Stated as an exact import list per file (architecture §2.3) AND as
 *          the runtime import closure from the seam, which must be exactly the
 *          three seam files plus three node builtins. The closure is the claim
 *          that matters: one new import two hops away would satisfy a per-file
 *          list and still pull `config.ts` -> `secrets.ts` -> `keychain.ts` in.
 *
 *   NFR-3  No process launch. The seam reads `.git` with `fs` (§2.2), so none
 *          of these files may hold a launch capability, and none may appear in
 *          `test/helpers/launch-allowlists.ts`. Checked twice: by a primitive
 *          sweep over the three files, and by the production launch-capability
 *          analyzer (test/helpers/launch-capability-graph.ts), which resolves
 *          imports and aliases.
 *
 * Every detector is falsified against fixture text or a fixture tree at the
 * bottom. A rule that matches nothing proves nothing.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import {
	ENTRY_LAUNCHER,
	LAUNCHER_CALLER_ALLOWLIST,
	PROCESS_LAUNCH_ALLOWLIST,
} from "../../helpers/launch-allowlists.js";
import { analyzeLaunchCapabilities } from "../../helpers/launch-capability-graph.js";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");

/** The seam's files and their EXACT specifier lists (§2.1, §2.3). */
const SEAM_IMPORTS: Record<string, string[]> = {
	"src/core/store-location.ts": [
		"./git-layout.js",
		"./project-config.js",
		"node:fs",
		"node:path",
	],
	// `node:crypto` only for the sha1 in the unreadable-HEAD label (§3.4, N12).
	"src/core/git-layout.ts": ["node:crypto", "node:fs", "node:path"],
	// `../types.js` for the `ProjectConfig` TYPE; see the type-only test below.
	"src/core/project-config.ts": ["../types.js", "node:fs", "node:path"],
};
const SEAM_FILES = Object.keys(SEAM_IMPORTS).sort();

// ────────────────────────────────────────────────────────────────────────────
// Detectors
// ────────────────────────────────────────────────────────────────────────────

function stripComments(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * Every specifier the file names, in any form: static, side-effect, re-export,
 * dynamic `import()` and `require()`. Type-only imports INCLUDED: the next edit
 * that needs a value from the same module quietly drops the `type` keyword.
 */
function importedSpecifiers(source: string): string[] {
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
	return [...found].sort();
}

/**
 * Whole-statement type-only imports and re-exports, which the compiler erases.
 * BOUNDED to one clause so `export type Foo = {…}` (an alias, not a re-export)
 * cannot run on to a later `from "…"` and hide a value import.
 */
const TYPE_ONLY_STATEMENT =
	/\b(?:import|export)\s+type\s+(?:\{[^}]*\}\s*|\*\s+as\s+\w+\s+|\w+\s+)from\s*["'][^"']+["']/g;

/** Specifiers that create a RUNTIME edge. `import { type X, y }` is one. */
function runtimeSpecifiers(source: string): string[] {
	return importedSpecifiers(
		stripComments(source).replace(TYPE_ONLY_STATEMENT, ""),
	);
}

function resolveLocal(fromFile: string, specifier: string): string | null {
	const base = resolve(dirname(fromFile), specifier);
	const candidates = [
		base.replace(/\.js$/, ".ts"),
		base.replace(/\.js$/, ".tsx"),
		base,
		`${base}.ts`,
		join(base, "index.ts"),
	];
	return candidates.find((c) => existsSync(c) && statSync(c).isFile()) ?? null;
}

/**
 * Every file loaded at runtime by loading `entry`, following value imports,
 * re-exports, `import()` and `require()` transitively. Non-relative specifiers
 * are collected in `external`, and unresolvable relative ones as `unresolved:…`.
 */
function runtimeClosure(entry: string): {
	files: Set<string>;
	external: Set<string>;
} {
	const files = new Set<string>();
	const external = new Set<string>();
	const queue = [entry];
	for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
		if (files.has(file)) continue;
		files.add(file);
		for (const spec of runtimeSpecifiers(readFileSync(file, "utf8"))) {
			if (!spec.startsWith(".")) {
				external.add(spec);
				continue;
			}
			const target = resolveLocal(file, spec);
			if (target === null) external.add(`unresolved:${spec}`);
			else queue.push(target);
		}
	}
	return { files, external };
}

/**
 * Launch primitives, over comment-stripped source. Broader than the production
 * sweep on purpose: none of these files has any business mentioning the `Bun`
 * global, `globalThis`, a dynamic import or `require`, so all of those are
 * refused outright rather than analysed.
 */
const LAUNCH_PRIMITIVES: RegExp[] = [
	/child_process/,
	/\bBun\b/,
	/\bglobalThis\b/,
	/\bprocess\s*\[/,
	/\bprocess\s*\.\s*(?:binding|_linkedBinding|dlopen)\b/,
	/\bfrom\s*["']bun["']/,
	/\brequire\s*\(/,
	/\bimport\s*\(/,
	/\b(?:exec|execSync|execFile|execFileSync|spawn|spawnSync|fork)\s*\(/,
];

function launchPrimitivesIn(source: string): string[] {
	const clean = stripComments(source);
	return LAUNCH_PRIMITIVES.filter((re) => re.test(clean)).map(
		(re) => re.source,
	);
}

function seamSource(file: string): string {
	return readFileSync(join(REPO_ROOT, file), "utf8");
}

// ────────────────────────────────────────────────────────────────────────────
// NFR-2
// ────────────────────────────────────────────────────────────────────────────

describe("NFR-2 — the seam cannot reach a credential", () => {
	for (const file of SEAM_FILES) {
		test(`${file} imports exactly its allowlist`, () => {
			// Falsified by: adding ANY import to the file, or removing one (the
			// list is exact in both directions, so it cannot go stale).
			expect(importedSpecifiers(seamSource(file))).toEqual(
				[...(SEAM_IMPORTS[file] ?? [])].sort(),
			);
		});
	}

	test("project-config.ts reaches ../types.js ONLY through `import type`", () => {
		// `types.ts` itself type-imports `config.ts`. A value import would be
		// harmless today and a live edge into config.ts the day types.ts gains a
		// value. Falsified by: dropping the `type` keyword from that import.
		const source = seamSource("src/core/project-config.ts");
		expect(importedSpecifiers(source)).toContain("../types.js");
		expect(runtimeSpecifiers(source)).not.toContain("../types.js");
	});

	test("the RUNTIME closure of store-location.ts is the three seam files and three builtins, nothing else", () => {
		// Falsified by: any value import, at any depth, of a module outside the
		// seam — e.g. `import { getIndexDir } from "../config.js"` in
		// project-config.ts pulls in config.ts, secrets.ts and keychain.ts, and
		// the file list below grows by hundreds.
		const { files, external } = runtimeClosure(
			join(REPO_ROOT, "src/core/store-location.ts"),
		);
		expect([...files].map((f) => relative(REPO_ROOT, f)).sort()).toEqual(
			SEAM_FILES,
		);
		expect([...external].sort()).toEqual([
			"node:crypto",
			"node:fs",
			"node:path",
		]);
	});

	test("in particular: no keychain, secrets, config, embeddings or LLM module is reachable", () => {
		// The same property as above, stated by name so a failure reads as the
		// requirement it breaks.
		const { files } = runtimeClosure(
			join(REPO_ROOT, "src/core/store-location.ts"),
		);
		const reached = [...files].map((f) => relative(REPO_ROOT, f));
		const credentialPaths = reached.filter((f) =>
			/(?:^src\/config\.ts$|keychain|secrets|embeddings|\/llm\/|claude-code)/.test(
				f,
			),
		);
		expect(credentialPaths).toEqual([]);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Row 3's gate (§8): only store-location.ts may choose a scope
// ────────────────────────────────────────────────────────────────────────────

/** Every `.ts`/`.tsx` file under `dir`, recursively. */
function tsFilesUnder(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...tsFilesUnder(full));
		else if (/\.tsx?$/.test(entry.name)) out.push(full);
	}
	return out;
}

/** Names that let a caller pick the scope instead of taking the gated default. */
const SCOPE_BYPASS = /\bpickStoreDir\b|\bSTORE_SCOPE_DEFAULT\b/;

describe("row 3 stays gated: no production file can choose the scope", () => {
	test("pickStoreDir and STORE_SCOPE_DEFAULT are named in src/ by store-location.ts ONLY", () => {
		// `pickStoreDir(inputs, "git-common-dir")` from a Phase 2 caller would
		// move that caller's store before 3b, which §8 forbids. Production code
		// takes the gated default through resolveStoreLocation. Falsified by:
		// calling pickStoreDir from any other file in src/.
		const offenders = tsFilesUnder(join(REPO_ROOT, "src"))
			.map((f) => relative(REPO_ROOT, f))
			.filter((f) => f !== "src/core/store-location.ts")
			.filter((f) => SCOPE_BYPASS.test(stripComments(seamSource(f))));
		expect(offenders).toEqual([]);
	});

	test("the sweep fires on a call and not on prose", () => {
		expect(
			SCOPE_BYPASS.test(
				stripComments('pickStoreDir(readStoreInputs(p), "git-common-dir");'),
			),
		).toBe(true);
		expect(
			SCOPE_BYPASS.test(
				stripComments("// see pickStoreDir\n/* STORE_SCOPE_DEFAULT */"),
			),
		).toBe(false);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// NFR-3
// ────────────────────────────────────────────────────────────────────────────

describe("NFR-3 — the seam launches no process", () => {
	for (const file of SEAM_FILES) {
		test(`${file} contains no launch primitive`, () => {
			// Falsified by: `import { spawnSync } from "node:child_process"`, or
			// any `Bun.spawn*` / `Bun.$`, in the file.
			expect(launchPrimitivesIn(seamSource(file))).toEqual([]);
		});
	}

	test("none of the seam files is on either launch allowlist (§9: launch-allowlists.ts is unchanged)", () => {
		// Falsified by: adding one of them to PROCESS_LAUNCH_ALLOWLIST or
		// LAUNCHER_CALLER_ALLOWLIST — which is what shelling out would require.
		const listed = [
			...Object.keys(PROCESS_LAUNCH_ALLOWLIST),
			...Object.keys(LAUNCHER_CALLER_ALLOWLIST),
		];
		expect(SEAM_FILES.filter((f) => listed.includes(f))).toEqual([]);
	});

	test("the production launch-capability analyzer finds no capability in any seam file", async () => {
		// The import- and alias-resolving analyzer that guards all of src/, asked
		// about these three files specifically. Falsified by: any launch
		// capability in them, including one obtained through a local import or an
		// alias the regex sweep above cannot see.
		const result = await analyzeLaunchCapabilities({
			repoRoot: REPO_ROOT,
			roots: [join(REPO_ROOT, "src")],
			launcherPath: ENTRY_LAUNCHER,
			primitiveAllowlist: new Set(Object.keys(PROCESS_LAUNCH_ALLOWLIST)),
			launcherCallerAllowlist: new Set(Object.keys(LAUNCHER_CALLER_ALLOWLIST)),
		});
		// Not vacuous: the analyzer walked the tree and sees the real holders.
		expect(result.filesScanned).toBeGreaterThan(300);
		expect(result.acquired.primitive.size).toBeGreaterThan(0);

		const touchesSeam = (file: string) => SEAM_FILES.includes(file);
		expect([...result.acquired.primitive].filter(touchesSeam)).toEqual([]);
		expect([...result.acquired.launcher].filter(touchesSeam)).toEqual([]);
		expect(result.calls.filter((c) => touchesSeam(c.file))).toEqual([]);
		expect(result.violations.filter((c) => touchesSeam(c.file))).toEqual([]);
	});
});

// ────────────────────────────────────────────────────────────────────────────
// Guarding the guards
// ────────────────────────────────────────────────────────────────────────────

describe("guarding the guards — every detector fires on what it claims to catch", () => {
	test("importedSpecifiers sees every import form, and ignores comments", () => {
		const forms = [
			'import cfg from "../config.js";',
			'import {\n\tloadGlobalConfig,\n} from "../config.js";',
			'import * as cfg from "../config.js";',
			'import type { GlobalConfig } from "../config.js";',
			'import "../config.js";',
			'export { loadGlobalConfig } from "../config.js";',
			'export * from "../config.js";',
			'const c = await import("../config.js");',
			'const c = require("../config.js");',
		];
		for (const form of forms) {
			expect(importedSpecifiers(form)).toContain("../config.js");
		}
		expect(
			importedSpecifiers('// import "../config.js";\n/* import "../x.js"; */'),
		).toEqual([]);
	});

	test("runtimeSpecifiers drops only whole type-only statements", () => {
		const typeOnly = [
			'import type { A } from "./a.js";',
			'import type A from "./a.js";',
			'import type * as A from "./a.js";',
			'export type { A } from "./a.js";',
		];
		for (const form of typeOnly) expect(runtimeSpecifiers(form)).toEqual([]);

		// A mixed import is a runtime edge.
		expect(runtimeSpecifiers('import { type A, b } from "./a.js";')).toEqual([
			"./a.js",
		]);
		// The bounded pattern: a type ALIAS must not swallow the next import.
		expect(
			runtimeSpecifiers(
				'export type Foo = { a: string };\nimport { x } from "../config.js";',
			),
		).toEqual(["../config.js"]);
	});

	describe("runtimeClosure on a fixture tree", () => {
		let fixture: string;
		beforeAll(() => {
			fixture = realpathSync.native(
				mkdtempSync(join(tmpdir(), "mnemex-closure-")),
			);
			mkdirSync(join(fixture, "core"));
			const files: Record<string, string> = {
				"core/entry.ts": 'import { b } from "./b.js";\nexport const e = b;',
				// A type-only edge (must NOT be followed) and a re-export chain (must be).
				"core/b.ts":
					'import type { C } from "./c.js";\nexport { secret as b } from "./keychain.js";',
				"core/c.ts":
					'import { x } from "../config.js";\nexport type C = typeof x;',
				"core/keychain.ts":
					'import { a } from "node:child_process";\nexport const secret = a;',
				"config.ts": "export const x = 1;",
			};
			for (const [name, text] of Object.entries(files)) {
				writeFileSync(join(fixture, name), text);
			}
		});
		afterAll(() => {
			rmSync(fixture, { recursive: true, force: true });
		});

		test("follows value imports and re-exports transitively, and skips type-only edges", () => {
			const { files, external } = runtimeClosure(
				join(fixture, "core/entry.ts"),
			);
			expect([...files].map((f) => relative(fixture, f)).sort()).toEqual([
				"core/b.ts",
				"core/entry.ts",
				"core/keychain.ts",
			]);
			expect([...external]).toEqual(["node:child_process"]);
		});
	});

	test("the launch-primitive sweep fires on every spelling, and not on prose", () => {
		const spellings = [
			'import { spawnSync } from "node:child_process";',
			'import cp from "child_process";',
			'Bun.spawnSync(["git", "rev-parse"]);',
			"const runtime = Bun; runtime.spawn([]);",
			'globalThis["Bun"].spawn([]);',
			'process["binding"]("spawn_sync");',
			'import { $ } from "bun";',
			'const cp = await import("node:child_process");',
			'const cp = require("node:child_process");',
			'execSync("git rev-parse --git-common-dir");',
		];
		const missed = spellings.filter((s) => launchPrimitivesIn(s).length === 0);
		expect(missed).toEqual([]);

		expect(
			launchPrimitivesIn(
				"// never Bun.spawn or child_process here\n/* spawnSync( */\nconst x = process.env.X;",
			),
		).toEqual([]);
	});
});
