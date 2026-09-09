/**
 * Does an index run ever SAY what the embedding cache did, and what it cost?
 *
 * Three facts are produced by `Indexer.index()` and, until this phase, were
 * carried on `IndexResult` and rendered nowhere:
 *
 *   - `embedCache`  — hits/misses/writes and the runtime TIER. The tier is the
 *     only channel a user has for degradation: all three degradation paths
 *     (unwritable directory, corrupt file, SQLITE_BUSY latch) emit one stderr
 *     line on a path where stderr is routinely --agent output nobody reads, and
 *     then run at in-process-only speed for ever.
 *   - `upgradedFromIndexVersion` — the run rebuilt the whole repository and
 *     re-embedded it once. This is the AUTHORITATIVE channel by design: the git
 *     post-commit hook and the MCP search tool's auto-reindex pass no
 *     `onProgress`, so the `[migrating]` notice reaches at most two of the four
 *     entry points.
 *   - `filesDeferred` — files whose rows were rolled back after an embedding
 *     failure and whose tracker stamp was withheld. Self-healing, not free.
 *
 * The human formatters are pure and exported for the same reason
 * `reportAdoptedModel` is: the rendering, not the datum, is what regresses.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
	formatDeferredFilesLine,
	formatEmbedCacheLine,
	formatIndexUpgradeLine,
} from "../../../src/cli.js";
import { agentOutput } from "../../../src/output/agent.js";
import type {
	EnrichedIndexResult,
	IndexEmbedCacheStats,
} from "../../../src/types.js";

const realLog = console.log;

afterEach(() => {
	console.log = realLog;
});

/** Run `fn`, returning everything it printed. */
function capture(fn: () => void): string {
	let stdout = "";
	console.log = (...args: unknown[]) => {
		stdout += `${args.join(" ")}\n`;
	};
	try {
		fn();
	} finally {
		console.log = realLog;
	}
	return stdout;
}

function indexResult(over: Partial<EnrichedIndexResult>): EnrichedIndexResult {
	return {
		filesIndexed: 1,
		chunksCreated: 1,
		durationMs: 10,
		skippedFiles: [],
		errors: [],
		...over,
	};
}

function stats(over: Partial<IndexEmbedCacheStats>): IndexEmbedCacheStats {
	return { tier: "sqlite", hits: 0, misses: 0, writes: 0, ...over };
}

// ════════════════════════════════════════════════════════════════════════════
// The human surface
// ════════════════════════════════════════════════════════════════════════════

describe("the embed-cache summary line", () => {
	test("names both counts, and does not cry degradation on the healthy tier", () => {
		const line = formatEmbedCacheLine(
			stats({ tier: "sqlite", hits: 4210, misses: 96, writes: 96 }),
		);

		expect(line).toContain("4210 cached");
		expect(line).toContain("96 embedded");
		expect(line).not.toContain("in-process");
	});

	test("a degraded run SAYS SO — it is the only surface that ever does", () => {
		// Tier l0 means the persistent file could not be opened, or was latched
		// off by contention. The run still succeeds and is still correct; it is
		// just paying full price for every vector, for ever, silently.
		const line = formatEmbedCacheLine(
			stats({ tier: "l0", hits: 3, misses: 7 }),
		);

		expect(line).toContain("in-process only");
		expect(line).toContain("persistent cache could not be used");
	});

	test("the user's own opt-out prints nothing at all", () => {
		// `tier: "none"` is MNEMEX_DISABLE_EMBED_CACHE / "embedCache": false. A
		// line of zeroes every run tells someone who switched it off nothing.
		expect(formatEmbedCacheLine(stats({ tier: "none" }))).toBeNull();
	});

	test("a run with no cache stats prints nothing", () => {
		expect(formatEmbedCacheLine(undefined)).toBeNull();
	});

	test("zero hits is still a line — it is the cold run, not a missing one", () => {
		// `0` is falsy and this is the first real run of a fresh cache, which is
		// exactly the run whose numbers explain why it was slow.
		const line = formatEmbedCacheLine(
			stats({ tier: "sqlite", hits: 0, misses: 5000, writes: 5000 }),
		);

		expect(line).toContain("0 cached");
		expect(line).toContain("5000 embedded");
	});
});

describe("the upgrade summary line", () => {
	test("names the version it rebuilt from, and the cost", () => {
		const line = formatIndexUpgradeLine(2);

		expect(line).toContain("index version 2");
		expect(line).toContain("re-embed");
	});

	test("an ordinary run says nothing about upgrading", () => {
		expect(formatIndexUpgradeLine(undefined)).toBeNull();
	});

	test("version 0 is rendered, not swallowed as falsy", () => {
		// `getIndexVersion` returns 1 for an unstamped index today, so 0 is not
		// reachable — which is the point: the predicate is `=== undefined`, and a
		// truthiness test here would be a bug waiting for a version scheme change
		// (CLAUDE.md #15's rule, in a different file).
		expect(formatIndexUpgradeLine(0)).toContain("index version 0");
	});
});

describe("the deferred-files summary line", () => {
	test("counts them and says the next run redoes them", () => {
		const line = formatDeferredFilesLine(["src/a.ts", "src/b.ts"]);

		expect(line).toContain("2 files");
		expect(line).toContain("next run");
	});

	test("one file reads as one file", () => {
		expect(formatDeferredFilesLine(["src/a.ts"])).toContain("1 file (");
	});

	test("an empty list is silence, not '0 files'", () => {
		expect(formatDeferredFilesLine([])).toBeNull();
		expect(formatDeferredFilesLine(undefined)).toBeNull();
	});
});

// ════════════════════════════════════════════════════════════════════════════
// The machine surface (--agent)
// ════════════════════════════════════════════════════════════════════════════

describe("--agent emits the cache accounting", () => {
	test("all four fields, from the result and nothing else", () => {
		const stdout = capture(() =>
			agentOutput.indexComplete(
				indexResult({
					embedCache: {
						tier: "sqlite",
						hits: 4210,
						misses: 96,
						writes: 96,
					},
				}),
			),
		);

		expect(stdout).toContain("embed_cache_tier=sqlite");
		expect(stdout).toContain("embed_cache_hits=4210");
		expect(stdout).toContain("embed_cache_misses=96");
		expect(stdout).toContain("embed_cache_writes=96");
	});

	test("`tier=none` is EMITTED — a control run has to be able to see it", () => {
		// Measurement C indexes with MNEMEX_DISABLE_EMBED_CACHE=1 and compares.
		// If the opt-out were rendered as an absent field, that run could not tell
		// "the cache was off" from "this build has no cache at all".
		const stdout = capture(() =>
			agentOutput.indexComplete(
				indexResult({
					embedCache: { tier: "none", hits: 0, misses: 500, writes: 0 },
				}),
			),
		);

		expect(stdout).toContain("embed_cache_tier=none");
		expect(stdout).toContain("embed_cache_hits=0");
	});

	test("a run that never built the seam emits no cache fields", () => {
		const stdout = capture(() => agentOutput.indexComplete(indexResult({})));

		expect(stdout).not.toContain("embed_cache");
	});

	test("the upgrade is machine-readable, because two entry points render nothing", () => {
		const stdout = capture(() =>
			agentOutput.indexComplete(indexResult({ upgradedFromIndexVersion: 2 })),
		);

		expect(stdout).toContain("upgraded_from_index_version=2");
	});

	test("an ordinary run claims no upgrade", () => {
		const stdout = capture(() => agentOutput.indexComplete(indexResult({})));

		expect(stdout).not.toContain("upgraded_from_index_version");
	});

	test("deferred files are counted AND named", () => {
		// The count alone cannot be acted on: the caller needs to know which
		// files are missing from the index it is about to query.
		const stdout = capture(() =>
			agentOutput.indexComplete(
				indexResult({ filesDeferred: ["src/a.ts", "src/b.ts"] }),
			),
		);

		expect(stdout).toContain("files_deferred=2");
		expect(stdout).toContain("deferred_file=src/a.ts");
		expect(stdout).toContain("deferred_file=src/b.ts");
	});

	test("every new line is still key=value — the whole contract of --agent", () => {
		const stdout = capture(() =>
			agentOutput.indexComplete(
				indexResult({
					embedCache: { tier: "l0", hits: 1, misses: 2, writes: 2 },
					upgradedFromIndexVersion: 2,
					filesDeferred: ["src/a.ts"],
				}),
			),
		);

		const lines = stdout.split("\n").filter((l) => l.length > 0);
		expect(lines.length).toBeGreaterThan(3);
		for (const line of lines) {
			expect(line).toMatch(/^[a-z0-9_]+=/);
		}
	});
});
