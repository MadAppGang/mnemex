/**
 * The overlay's GATE (step 3, phase 6; architecture §5 "Reachability", MEDIUM
 * 13) and its config key.
 *
 *   GATE  `resolveOverlayGate` decides on the EFFECTIVE search: `--no-dirty`
 *         first, then config, then keyword-only (which includes `vector:
 *         false` — the indexer passes `options.keywordOnly || !vectorEnabled`),
 *         then a missing query vector. `null` = run. The CLI forms (GATE-1,
 *         R-5) are in `test/e2e/dirty-overlay-cli-e2e.test.ts`.
 *   CFG   `isDirtyOverlayEnabled`: a project boolean wins; an absent project
 *         key defers to the global one, whose absence means ON.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	isDirtyOverlayEnabled,
	loadGlobalConfig,
} from "../../../src/config.js";
import {
	overlayOffReport,
	resolveOverlayGate,
} from "../../../src/core/overlay/dirty-overlay.js";

const VEC = [0.1, 0.2, 0.3];

describe("resolveOverlayGate", () => {
	test("open only when every condition holds", () => {
		expect(
			resolveOverlayGate({
				flag: undefined,
				configEnabled: true,
				keywordOnly: false,
				queryVector: VEC,
			}),
		).toBeNull();
		expect(
			resolveOverlayGate({
				flag: "auto",
				configEnabled: true,
				keywordOnly: false,
				queryVector: VEC,
			}),
		).toBeNull();
	});

	test("first match wins: flag > config > keyword-only > no-vector", () => {
		const all = {
			flag: "off" as const,
			configEnabled: false,
			keywordOnly: true,
			queryVector: undefined,
		};
		expect(resolveOverlayGate(all)).toBe("flag");
		expect(resolveOverlayGate({ ...all, flag: undefined })).toBe("config");
		expect(
			resolveOverlayGate({ ...all, flag: undefined, configEnabled: true }),
		).toBe("keyword-only");
		expect(
			resolveOverlayGate({
				...all,
				flag: undefined,
				configEnabled: true,
				keywordOnly: false,
			}),
		).toBe("no-vector");
	});

	test("a BM25-only placeholder vector ([0]) is not a query vector", () => {
		expect(
			resolveOverlayGate({
				flag: undefined,
				configEnabled: true,
				keywordOnly: false,
				queryVector: [0],
			}),
		).toBe("no-vector");
	});

	test("the off report is a complete, zeroed report", () => {
		expect(overlayOffReport("keyword-only")).toEqual({
			state: "off",
			reason: "keyword-only",
			files: 0,
			filesIndexCurrent: 0,
			filesDeleted: 0,
			filesPending: 0,
			filesFailed: 0,
			filesUnclassified: 0,
			rebuilt: 0,
			embedded: 0,
			cacheHits: 0,
			rebuildMs: 0,
			gaps: [],
			gapDetails: [],
		});
	});
});

describe("isDirtyOverlayEnabled", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});
	function project(config: Record<string, unknown> | null): string {
		const dir = mkdtempSync(join(tmpdir(), "dirty-cfg-"));
		dirs.push(dir);
		if (config !== null) {
			writeFileSync(join(dir, "mnemex.json"), JSON.stringify(config));
		}
		return dir;
	}

	test("a project boolean wins, both ways", () => {
		expect(isDirtyOverlayEnabled(project({ dirtyOverlay: false }))).toBe(false);
		expect(isDirtyOverlayEnabled(project({ dirtyOverlay: true }))).toBe(true);
	});

	test("absent (or non-boolean) in the project defers to the global key, default ON", () => {
		// The global file is read through `homedir()`, fixed at module load
		// (CLAUDE.md #25), so this asserts the RULE against whatever this
		// machine's global config says rather than rewriting it. The global
		// branch itself is driven in a sandboxed child by R-5 (e2e).
		const expected = loadGlobalConfig().dirtyOverlay !== false;
		expect(isDirtyOverlayEnabled(project({}))).toBe(expected);
		expect(isDirtyOverlayEnabled(project({ dirtyOverlay: "no" }))).toBe(
			expected,
		);
		expect(isDirtyOverlayEnabled(project(null))).toBe(expected);
	});
});
