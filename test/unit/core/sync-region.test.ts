/**
 * `src/core/sync-region.ts` — the shared blocking bound (CLAUDE.md #31).
 *
 * The property worth pinning in isolation is the DIVISION. `busy_timeout` is a
 * PER-STATEMENT timeout, so a region of N blocking statements must receive
 * floor(allowance / N) per statement. Revision 2 of the embed-cache design
 * applied the allowance flat — 64 × 250 ms = 16 s for one lookup region — and
 * bounded nothing. The expected values below are LITERALS, not the formula
 * re-typed, so a test cannot agree with a wrong implementation by construction.
 *
 * FALSIFIED: with `clampedBusyTimeoutMs` returning the flat allowance (the
 * division by `region.blockingStatements` removed), the division tests go red.
 * Recorded in the session's `implementation-log-sync-region.md`.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as embedCache from "../../../src/core/embed-cache.js";
import type { SyncRegion } from "../../../src/core/sync-region.js";
import {
	BUSY_TIMEOUT_MS,
	busyTimeoutPragma,
	clampedBusyTimeoutMs,
	MAX_SYNC_REGION_MS,
	yieldToEventLoop,
} from "../../../src/core/sync-region.js";

/** `embed-cache.ts`'s CONTENTION_BUDGET_MS; anything ≥ 250 leaves the allowance at 250. */
const BUDGET_MS = 1000;

function region(blockingStatements: number): SyncRegion {
	return { name: "R1", blockingStatements };
}

describe("the clamp DIVIDES the region's allowance across its blocking statements", () => {
	// [blockingStatements, per-statement ms at full budget] — literals.
	const cases: Array<[number, number]> = [
		[1, 250],
		[2, 125], // the tracker's BEGIN IMMEDIATE + COMMIT regions
		[3, 83], // embed-cache's R2 (write)
		[15, 16], // the tracker's R0 (14 DDL + journal_mode)
		[64, 3], // embed-cache's R1 (LOOKUP_CHUNK point SELECTs)
	];
	for (const [n, expected] of cases) {
		test(`${n} blocking statement(s) → ${expected} ms each`, () => {
			expect(clampedBusyTimeoutMs(region(n), BUDGET_MS, 0)).toBe(expected);
		});
	}

	test("a multi-statement region never receives the flat allowance", () => {
		for (const n of [2, 3, 15, 64]) {
			const perStatement = clampedBusyTimeoutMs(region(n), BUDGET_MS, 0);
			expect(perStatement).not.toBe(BUSY_TIMEOUT_MS);
			expect(perStatement * n).toBeLessThanOrEqual(BUSY_TIMEOUT_MS);
		}
	});

	test("64 statements wait at most 250 ms as a region, not 16 s", () => {
		const perStatement = clampedBusyTimeoutMs(region(64), BUDGET_MS, 0);
		expect(64 * perStatement).toBeLessThanOrEqual(250);
		expect(64 * perStatement).not.toBe(64 * 250);
	});
});

describe("the process budget shrinks the allowance BEFORE it is divided", () => {
	test("a remaining budget below BUSY_TIMEOUT_MS is the allowance", () => {
		expect(clampedBusyTimeoutMs(region(2), BUDGET_MS, 900)).toBe(50);
		expect(clampedBusyTimeoutMs(region(64), BUDGET_MS, 900)).toBe(1);
	});

	test("an exhausted budget clamps to 0, and an overspent one does not go negative", () => {
		expect(clampedBusyTimeoutMs(region(1), BUDGET_MS, BUDGET_MS)).toBe(0);
		expect(clampedBusyTimeoutMs(region(3), BUDGET_MS, BUDGET_MS + 5000)).toBe(
			0,
		);
	});

	test("the budget is the caller's: a smaller one is honoured", () => {
		// Each SQLite file owns its own budget, so it is a parameter, not a constant.
		expect(clampedBusyTimeoutMs(region(1), 100, 0)).toBe(100);
		expect(clampedBusyTimeoutMs(region(4), 100, 0)).toBe(25);
	});
});

describe("busyTimeoutPragma renders only a non-negative integer (CLAUDE.md #22)", () => {
	test("renders the value", () => {
		expect(busyTimeoutPragma(3, "embed-cache")).toBe("PRAGMA busy_timeout = 3");
		expect(busyTimeoutPragma(0, "embed-cache")).toBe("PRAGMA busy_timeout = 0");
	});

	test("a region declared with ZERO blocking statements never reaches SQL", () => {
		// 250 / 0 = Infinity with budget left; 0 / 0 = NaN once it is spent.
		const withBudget = clampedBusyTimeoutMs(region(0), BUDGET_MS, 0);
		const spent = clampedBusyTimeoutMs(region(0), BUDGET_MS, BUDGET_MS);
		expect(() => busyTimeoutPragma(withBudget, "embed-cache")).toThrow(
			"embed-cache: refusing to render a non-integer busy_timeout (Infinity)",
		);
		expect(() => busyTimeoutPragma(spent, "tracker")).toThrow(
			"tracker: refusing to render a non-integer busy_timeout (NaN)",
		);
	});

	test("fractions and negatives are refused", () => {
		expect(() => busyTimeoutPragma(2.5, "x")).toThrow(/non-integer/);
		expect(() => busyTimeoutPragma(-1, "x")).toThrow(/non-integer/);
	});
});

describe("yieldToEventLoop reaches the TIMERS phase", () => {
	test("a due timer runs across it — and does NOT run across a microtask", async () => {
		let fired = false;
		setTimeout(() => {
			fired = true;
		}, 0);
		// The negative control: a microtask "yield" would not let the heartbeat
		// run, so this test must be able to tell the two apart.
		await Promise.resolve();
		expect(fired).toBe(false);
		await yieldToEventLoop();
		expect(fired).toBe(true);
	});
});

describe("the move changed no constant and left no second definition", () => {
	test("the constants keep their values", () => {
		expect(BUSY_TIMEOUT_MS).toBe(250);
		expect(MAX_SYNC_REGION_MS).toBe(250);
	});

	test("embed-cache re-exports the SAME bindings", () => {
		expect(embedCache.yieldToEventLoop).toBe(yieldToEventLoop);
		expect(embedCache.BUSY_TIMEOUT_MS).toBe(BUSY_TIMEOUT_MS);
		expect(embedCache.MAX_SYNC_REGION_MS).toBe(MAX_SYNC_REGION_MS);
	});

	test("embed-cache.ts no longer DEFINES them, nor re-implements the division", () => {
		const source = readFileSync(
			join(import.meta.dir, "..", "..", "..", "src", "core", "embed-cache.ts"),
			"utf8",
		)
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/(^|[^:])\/\/.*$/gm, "$1");
		expect(source).not.toMatch(/\bconst\s+BUSY_TIMEOUT_MS\s*=/);
		expect(source).not.toMatch(/\bconst\s+MAX_SYNC_REGION_MS\s*=/);
		expect(source).not.toMatch(/\bfunction\s+yieldToEventLoop\b/);
		expect(source).not.toMatch(/\binterface\s+SyncRegion\b/);
		expect(source).not.toMatch(/\/\s*region\.blockingStatements/);
	});
});
