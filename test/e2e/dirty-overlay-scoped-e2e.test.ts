/**
 * EC-1, full form (step 3, phase 6; MEDIUM 4): `Indexer.searchScoped` with a
 * STORE lock held in the same process and the embed cache's memo cold. The
 * overlay must not run the cache's full open — the one region that is not
 * constant-bounded — under an index lock: it reports `skipped` with reason
 * `cache-cold-under-lock`, and a spy on `openEmbedCache` sees memo-only calls
 * and zero full opens. With the lock released, the same search opens the cache
 * and serves the dirty file (the control that shows the spy is live).
 *
 * M7 (code review 1, MEDIUM 7): the overlay's vector read receives the SAME
 * filter options as the index search — `limit`, `language`, `pathPattern` and
 * `filePath` — so no filter can reach one channel and not the other.
 *
 * The child (`overlay-search-child.ts`) runs with `sandboxEnv()`; the index is
 * built by the BUILT entry point (`bun run build` first).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
	type OverlayCliProject,
	overlayCliProject,
	tsFunctions,
} from "../helpers/overlay-cli-fixture.js";
import { collect, sandboxEnv } from "../helpers/v4-fixtures.js";

const CHILD = join(import.meta.dir, "..", "helpers", "overlay-search-child.ts");

let current: OverlayCliProject | null = null;
afterEach(() => {
	current?.cleanup();
	current = null;
});

describe("EC-1: store lock held in-process, cache memo cold", () => {
	test("no full openEmbedCache, overlay skipped/cache-cold-under-lock; released -> served", async () => {
		const p = await overlayCliProject("ec1-", {
			"src/alpha.ts": tsFunctions("alpha", 3),
		});
		current = p;
		p.write("src/alpha.ts", tsFunctions("alpha", 3, "n + 2"));
		const run = await collect(
			Bun.spawn(
				[
					process.execPath,
					"--env-file=/dev/null",
					CHILD,
					"ec1",
					p.project,
					"alpha helper",
				],
				{
					cwd: p.project,
					env: sandboxEnv(p.scratch),
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
				},
			),
		);
		expect(run.exitCode, run.stderr).toBe(0);
		const r = run.result as {
			underLock: { state: string; reason: string };
			fullOpensUnderLock: number;
			memoOnlyCallsUnderLock: number;
			released: { state: string; reason: string; files: number };
			fullOpensAfter: number;
			dirtyRows: number;
		};
		expect(r.underLock).toMatchObject({
			state: "skipped",
			reason: "cache-cold-under-lock",
		});
		expect(r.fullOpensUnderLock).toBe(0);
		expect(r.memoOnlyCallsUnderLock).toBeGreaterThan(0);
		expect(r.released).toMatchObject({
			state: "on",
			reason: "dirty",
			files: 1,
		});
		expect(r.fullOpensAfter).toBe(1);
		expect(r.dirtyRows).toBeGreaterThan(0);
	}, 120_000);
});

describe("M7: one filter object for both channels", () => {
	test("the overlay's vector read gets exactly the index search's filters, filePath included", async () => {
		const p = await overlayCliProject("m7-", {
			"src/alpha.ts": tsFunctions("alpha", 3),
		});
		current = p;
		p.write("src/alpha.ts", tsFunctions("alpha", 3, "n + 2"));
		const run = await collect(
			Bun.spawn(
				[
					process.execPath,
					"--env-file=/dev/null",
					CHILD,
					"m7",
					p.project,
					"alpha helper",
				],
				{
					cwd: p.project,
					env: sandboxEnv(p.scratch),
					stdin: "ignore",
					stdout: "pipe",
					stderr: "pipe",
				},
			),
		);
		expect(run.exitCode, run.stderr).toBe(0);
		const r = run.result as {
			overlay: { state: string; reason: string };
			index: Array<Record<string, unknown>>;
			overlayRead: Array<Record<string, unknown>>;
		};
		// The overlay ran, so its read happened and can be compared.
		expect(r.overlay).toMatchObject({ state: "on", reason: "dirty" });
		expect(r.index.length).toBe(1);
		expect(r.overlayRead.length).toBe(1);
		expect(r.index[0]).toEqual({
			limit: 5,
			language: undefined,
			filePath: "src/alpha.ts",
			pathPattern: "src/**",
		});
		expect(r.overlayRead[0]).toEqual(r.index[0]);
	}, 120_000);
});
