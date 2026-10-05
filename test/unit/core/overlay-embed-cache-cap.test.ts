/**
 * The overlay is a writer of the machine-global embed cache on the SEARCH
 * path, where nothing evicts (code review 1, MEDIUM 8). Eviction runs at the
 * end of an index run only, so a search-only workflow grew the file past its
 * cap without bound.
 *
 *   CAP-E1  once the cache file is over its cap, overlay passes add NO entries:
 *           its size, read through a SEPARATE SQLite connection (the class's
 *           own report is not evidence), stops growing; the overlay still
 *           serves, and says why nothing was persisted
 *
 * No eviction on the search path and no global lock — the next index run's
 * `enforceBudget()` brings the file back under.
 */

import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import {
	openEmbedCache,
	resetEmbedCacheForTests,
} from "../../../src/core/embed-cache.js";
import { prepareDirtyOverlay } from "../../../src/core/overlay/dirty-overlay.js";
import {
	createOverlayFixture,
	indexAll,
	type OverlayFixture,
	tsSource,
} from "../../helpers/dirty-overlay-fixture.js";

let fx: OverlayFixture | null = null;
afterEach(() => {
	fx?.cleanup();
	fx = null;
});

/** `page_count * page_size` — the quantity the cap governs — from outside. */
function footprint(path: string): number {
	const db = new Database(path, { readonly: true });
	try {
		const pc = db.query("PRAGMA page_count").get() as { page_count: number };
		const ps = db.query("PRAGMA page_size").get() as { page_size: number };
		return pc.page_count * ps.page_size;
	} finally {
		db.close();
	}
}

test("CAP-E1: over its cap, the cache stops growing from overlay writes; the overlay still serves (A)", async () => {
	const f = await createOverlayFixture({ "src/a.ts": tsSource("a", 4) });
	fx = f;
	indexAll(f, ["src/a.ts"]);

	// The empty file's size, then a cap 8 KiB above it.
	openEmbedCache(f.embedCachePath);
	const empty = footprint(f.embedCachePath);
	resetEmbedCacheForTests();
	const cap = empty + 8 * 1024;
	openEmbedCache(f.embedCachePath, { maxBytes: cap }); // the memo the overlay reuses

	const sizes: number[] = [];
	const gapsAfter: string[] = [];
	let crossedAt = -1;
	for (let i = 0; i < 80 && (crossedAt < 0 || i < crossedAt + 8); i++) {
		// Every edit changes every chunk's text: every pass misses.
		f.write("src/a.ts", tsSource("a", 4, `v${i}`));
		const result = await prepareDirtyOverlay(f.ctx());
		expect(result.candidates?.servedPaths).toEqual(["src/a.ts"]);
		sizes.push(footprint(f.embedCachePath));
		if (crossedAt < 0 && (sizes.at(-1) as number) > cap) crossedAt = i;
		if (crossedAt >= 0 && i > crossedAt) {
			gapsAfter.push(result.report.gaps.join("\n"));
		}
	}
	console.log(
		`CAP-E1: cap=${cap} crossed at pass ${crossedAt}; sizes=${sizes.join(",")}`,
	);
	expect(crossedAt).toBeGreaterThanOrEqual(0); // the test saw the cap crossed
	// Every pass after the one that crossed: not one byte more.
	expect(sizes.at(-1)).toBe(sizes[crossedAt]);
	expect(sizes.length).toBeGreaterThanOrEqual(crossedAt + 8);
	// And each of those passes said why it persisted nothing.
	expect(gapsAfter.length).toBe(7);
	for (const gaps of gapsAfter) expect(gaps).toContain("embed-cache-over-cap");
});
