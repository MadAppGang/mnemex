/**
 * The `src/core/project-config.ts` extraction is a MOVE: every existing caller
 * of `src/config.ts` must see the same functions, the same constants and the
 * same bytes on disk (architecture §2.3, "Circular import"; §8 Phase 1).
 *
 * Writes only into temp directories. `isLearningEnabled` is exercised with an
 * explicit project value each time, so it never falls through to the user's
 * global config.
 *
 * Each test states the edit that turns it red.
 */

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as config from "../../../src/config.js";
import * as projectConfig from "../../../src/core/project-config.js";

let root: string;
let counter = 0;

function freshDir(): string {
	counter += 1;
	const dir = join(root, `case-${counter}`);
	mkdirSync(dir);
	return dir;
}

beforeAll(() => {
	root = realpathSync.native(mkdtempSync(join(tmpdir(), "mnemex-projcfg-")));
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("src/config.ts re-exports the moved symbols unchanged", () => {
	// Static access on purpose: `config[name]` would defeat tree shaking and
	// trips biome's noDynamicNamespaceImportAccess.
	const moved: Array<[string, unknown, unknown]> = [
		[
			"loadProjectConfig",
			config.loadProjectConfig,
			projectConfig.loadProjectConfig,
		],
		[
			"saveProjectConfig",
			config.saveProjectConfig,
			projectConfig.saveProjectConfig,
		],
		[
			"PROJECT_CONFIG_DIR",
			config.PROJECT_CONFIG_DIR,
			projectConfig.PROJECT_CONFIG_DIR,
		],
		[
			"PROJECT_CONFIG_FILE",
			config.PROJECT_CONFIG_FILE,
			projectConfig.PROJECT_CONFIG_FILE,
		],
		[
			"PROJECT_ROOT_CONFIG_FILE",
			config.PROJECT_ROOT_CONFIG_FILE,
			projectConfig.PROJECT_ROOT_CONFIG_FILE,
		],
		["INDEX_DB_FILE", config.INDEX_DB_FILE, projectConfig.INDEX_DB_FILE],
		["VECTORS_DIR", config.VECTORS_DIR, projectConfig.VECTORS_DIR],
	];

	for (const [name, fromConfig, fromLeaf] of moved) {
		test(`config.${name} IS project-config.${name}`, () => {
			// Falsified by: a second copy left behind in config.ts — the two would
			// then be different objects and could drift apart.
			expect(fromConfig).toBe(fromLeaf);
		});
	}

	test("the constant values are the ones callers were built against", () => {
		// Falsified by: editing any value during the move.
		expect({
			PROJECT_CONFIG_DIR: config.PROJECT_CONFIG_DIR,
			PROJECT_CONFIG_FILE: config.PROJECT_CONFIG_FILE,
			PROJECT_ROOT_CONFIG_FILE: config.PROJECT_ROOT_CONFIG_FILE,
			INDEX_DB_FILE: config.INDEX_DB_FILE,
			VECTORS_DIR: config.VECTORS_DIR,
		}).toEqual({
			PROJECT_CONFIG_DIR: ".mnemex",
			PROJECT_CONFIG_FILE: "config.json",
			PROJECT_ROOT_CONFIG_FILE: "mnemex.json",
			INDEX_DB_FILE: "index.db",
			VECTORS_DIR: "vectors",
		});
	});
});

describe("behaviour is byte-identical", () => {
	test("saveProjectConfig writes the same bytes as before, merging into the default skeleton", () => {
		// Falsified by: any change to the merge, the default skeleton, or the
		// JSON formatting — asserted on the file's BYTES, not on a re-read.
		const dir = freshDir();
		config.saveProjectConfig(dir, { indexVersion: 3 });
		config.saveProjectConfig(dir, { enrichment: false });
		const bytes = readFileSync(join(dir, ".mnemex", "config.json"), "utf-8");
		expect(bytes).toBe(
			JSON.stringify(
				{
					excludePatterns: [],
					includePatterns: [],
					indexVersion: 3,
					enrichment: false,
				},
				null,
				2,
			),
		);
		expect(config.loadProjectConfig(dir)).toEqual(JSON.parse(bytes));
	});

	test("mnemex.json wins over .mnemex/config.json", () => {
		const dir = freshDir();
		writeFileSync(
			join(dir, "mnemex.json"),
			JSON.stringify({ indexDir: "root" }),
		);
		mkdirSync(join(dir, ".mnemex"));
		writeFileSync(
			join(dir, ".mnemex", "config.json"),
			JSON.stringify({ indexDir: "dot" }),
		);
		expect(config.loadProjectConfig(dir)?.indexDir).toBe("root");
	});

	test("a malformed mnemex.json warns and falls back to .mnemex/config.json", () => {
		const dir = freshDir();
		writeFileSync(join(dir, "mnemex.json"), "{ not json");
		mkdirSync(join(dir, ".mnemex"));
		writeFileSync(
			join(dir, ".mnemex", "config.json"),
			JSON.stringify({ indexDir: "dot" }),
		);
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			expect(config.loadProjectConfig(dir)?.indexDir).toBe("dot");
			expect(warn).toHaveBeenCalledTimes(1);
		} finally {
			warn.mockRestore();
		}
	});

	test("no config at all is null", () => {
		expect(config.loadProjectConfig(freshDir())).toBeNull();
	});
});

describe("saveProjectConfig still invalidates the learning cache", () => {
	test("an in-process rewrite of `learning` is seen by the next isLearningEnabled()", () => {
		// The old saveProjectConfig called resetLearningEnabledCache() directly;
		// the moved one runs listeners, and config.ts registers the reset.
		// Falsified by: deleting `onProjectConfigSaved(resetLearningEnabledCache)`
		// from src/config.ts — the second read then returns the cached `true`.
		const dir = freshDir();
		config.saveProjectConfig(dir, { learning: true });
		expect(config.isLearningEnabled(dir)).toBe(true); // now cached
		config.saveProjectConfig(dir, { learning: false });
		expect(config.isLearningEnabled(dir)).toBe(false);
		config.resetLearningEnabledCache();
	});

	test("listeners are a Set: a second registrant does not evict the first, and unsubscribe works", () => {
		// Falsified by: a single-slot hook — registering `second` would silently
		// replace config.ts's learning-cache reset.
		const dir = freshDir();
		let second = 0;
		const unsubscribe = projectConfig.onProjectConfigSaved(() => {
			second += 1;
		});
		try {
			config.saveProjectConfig(dir, { learning: true });
			expect(config.isLearningEnabled(dir)).toBe(true);
			config.saveProjectConfig(dir, { learning: false });
			expect(second).toBe(2);
			expect(config.isLearningEnabled(dir)).toBe(false);
		} finally {
			unsubscribe();
			config.resetLearningEnabledCache();
		}
		config.saveProjectConfig(dir, { learning: true });
		expect(second).toBe(2);
	});
});
