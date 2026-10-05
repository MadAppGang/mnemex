/**
 * The overlay report says what happened, in machine form (Phase 6 black-box
 * failures TEST-12, TEST-27, TEST-31, and the `overlay_embedded` observation).
 *
 *   G-1  a pass that SERVES files carries each R3.8 gap as its own machine
 *        token — `no-symbol-graph`, `no-code-units`, `no-summaries`,
 *        `bm25-unchanged-chunks-only` — in the report (so MCP's `overlay`
 *        block has them) AND as whole entries of `--agent`'s `overlay_gaps`
 *   G-2  a pass that serves nothing carries none of them
 *
 *   W-1  PROVIDER-WIDE refusal: every overlay text the provider was asked for
 *        came back without a vector (one file's miss beside cache hits, the
 *        other file cold) and nothing else to contribute →
 *        `skipped/embed-failed`, no overlay row written — not `on` with two
 *        per-file failures
 *   W-2  the same through non-fatal `TotalEmbeddingFailureError` throws
 *   W-3  ONE accepted text anywhere in the pass → the refusal is per-file:
 *        `on`, that file `failed(embed)`, the other served (TEST-32's shape)
 *   W-4  everything refused, but a DELETION still to suppress → `on`, the
 *        deletion suppressed: skipping would lose it
 *   W-5  everything refused, but a file BUILT BY AN EARLIER PASS is still
 *        served (TEST-32's second search) → `on`, that file served, the
 *        refused one `failed(embed)`
 *   W-6  everything sent refused, but a file built from cache hits ALONE is
 *        served → `on`
 *
 *   E-1  `embedded` counts texts the provider RETURNED A VECTOR FOR, not texts
 *        sent: a refused text is not "embedded"
 *   E-2  a skip after real provider work still reports that work honestly
 *        (0 accepted, the cache hits it did use)
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createCachingEmbeddingsClient } from "../../../src/core/caching-embeddings-client.js";
import { chunkFileByPath } from "../../../src/core/chunker.js";
import { openEmbedCache } from "../../../src/core/embed-cache.js";
import { TotalEmbeddingFailureError } from "../../../src/core/embeddings-errors.js";
import { prepareDirtyOverlay } from "../../../src/core/overlay/dirty-overlay.js";
import type { OverlayReport } from "../../../src/core/overlay/types.js";
import { overlayHeaderLines } from "../../../src/output/agent.js";
import {
	createOverlayFixture,
	indexAll,
	type OverlayFixture,
	StubEmbedder,
	tsSource,
} from "../../helpers/dirty-overlay-fixture.js";

/**
 * The contract's spelling (architecture.md "Contracts (R3.9)", Phase 6
 * ruling 2). Written out here rather than imported, so a renamed constant in
 * `src/` cannot quietly move the contract with it.
 */
const R38_TOKENS = [
	"no-symbol-graph",
	"no-code-units",
	"no-summaries",
	"bm25-unchanged-chunks-only",
];

let fx: OverlayFixture | null = null;
afterEach(() => {
	fx?.cleanup();
	fx = null;
});

async function fixture(files: Record<string, string>): Promise<OverlayFixture> {
	fx = await createOverlayFixture(files);
	indexAll(fx, Object.keys(files));
	return fx;
}

/** `overlay_gaps` split the way an `--agent` consumer splits it. */
function agentGapEntries(report: OverlayReport): string[] {
	const line = overlayHeaderLines({ ...report, suppressedRows: 0 }).find((l) =>
		l.startsWith("overlay_gaps="),
	);
	const value = line?.slice("overlay_gaps=".length) ?? "";
	return value === "" ? [] : value.split("; ");
}

/** Warm the machine-global cache with `rel`'s CURRENT chunks, as indexing does. */
async function warmCacheWith(f: OverlayFixture, rel: string): Promise<number> {
	const chunks = await chunkFileByPath(f.read(rel).toString("utf8"), rel, "h");
	const warmer = createCachingEmbeddingsClient(new StubEmbedder(), {
		cache: openEmbedCache(f.embedCachePath),
		clientFingerprint: "",
	});
	await warmer.embedContentOf(chunks, "chunks");
	return chunks.length;
}

describe("R3.8's gaps are machine tokens (TEST-12, TEST-27)", () => {
	test("G-1: a pass that serves files carries each token as its own entry, in the report and in --agent (A)", async () => {
		const f = await fixture({ "src/a.ts": tsSource("a", 2) });
		f.write("src/a.ts", tsSource("a", 2, "edited"));
		const result = await prepareDirtyOverlay(f.ctx());
		expect(result.report.files).toBe(1);
		// The report itself — what MCP's `overlay` block serialises.
		for (const token of R38_TOKENS) {
			expect(result.report.gaps).toContain(token);
		}
		// `--agent`: each token is a WHOLE `; `-separated entry, not a phrase
		// inside one.
		const entries = agentGapEntries(result.report);
		for (const token of R38_TOKENS) {
			expect(entries).toContain(token);
		}
		// Rendered once, not once by the core and again by the renderer.
		expect(entries.filter((e) => e === "no-code-units")).toHaveLength(1);
	});

	test("G-2: a pass that serves nothing carries none of them", async () => {
		const f = await fixture({ "src/a.ts": tsSource("a", 2) });
		const clean = await prepareDirtyOverlay(f.ctx());
		expect(clean.report).toMatchObject({ state: "on", files: 0 });
		const entries = agentGapEntries(clean.report);
		for (const token of R38_TOKENS) {
			expect(clean.report.gaps).not.toContain(token);
			expect(entries).not.toContain(token);
		}
	});
});

describe("a provider-wide refusal skips the pass (TEST-31)", () => {
	test("W-1: every text sent came back without a vector, one file beside cache hits → skipped/embed-failed, nothing suppressed (A)", async () => {
		const f = await fixture({ "src/a.ts": tsSource("a", 5) });
		const warmed = await warmCacheWith(f, "src/a.ts");
		// a.ts: one function edited → its other chunks are cache hits, and
		// exactly one text reaches the provider. b.ts: new, all cold.
		f.write(
			"src/a.ts",
			tsSource("a", 5).replace("a function 3 ", "a function 3 EDIT"),
		);
		f.write("src/b.ts", tsSource("b", 2));
		// The real clients' partial shape (and the caching client's downgrade
		// when hits exist): a refused text is an EMPTY slot, not a throw.
		f.stub.emptyFor = () => true;

		const result = await prepareDirtyOverlay(f.ctx());

		expect(f.stub.texts).toBeGreaterThan(0); // the provider WAS asked
		expect(result.report).toMatchObject({
			state: "skipped",
			reason: "embed-failed",
			files: 0,
			embedded: 0,
		});
		// O4: the skip's cause is the token; its message a detail.
		expect(result.report.gaps[0]).toBe("embed-failed");
		expect(result.report.gapDetails[0]?.token).toBe("embed-failed");
		expect(result.report.gapDetails[0]?.message).not.toBe("");
		// Index rows stay visible: no candidates at all, nothing suppressed.
		expect(result.candidates).toBeUndefined();
		expect(await f.overlayRows()).toEqual([]);
		// E-2: the cache hits the pass DID use are reported, not zeroed.
		expect(result.report.cacheHits).toBe(warmed - 1);
	});

	test("W-2: every call refused non-fatally (TotalEmbeddingFailureError) → skipped/embed-failed (A)", async () => {
		const f = await fixture({
			"src/a.ts": tsSource("a", 2),
			"src/b.ts": tsSource("b", 2),
		});
		f.write("src/a.ts", tsSource("a", 2, "edited"));
		f.write("src/b.ts", tsSource("b", 2, "edited"));
		let refusedCalls = 0;
		f.stub.embed = async (texts, _onProgress, options) => {
			f.stub.policies.push(options);
			refusedCalls++;
			throw new TotalEmbeddingFailureError(
				"Stub",
				texts.length,
				"Chunk 1: HTTP 500 refused",
			);
		};
		const result = await prepareDirtyOverlay(f.ctx());
		// Each file was tried: the decision is made over the WHOLE pass.
		expect(refusedCalls).toBe(2);
		expect(result.report).toMatchObject({
			state: "skipped",
			reason: "embed-failed",
			embedded: 0,
		});
		expect(result.candidates).toBeUndefined();
		expect(await f.overlayRows()).toEqual([]);
	});

	test("W-3: one accepted text anywhere keeps the refusal per-file → on, failed(embed), the other served", async () => {
		const f = await fixture({
			"src/a.ts": tsSource("a", 2),
			"src/b.ts": tsSource("b", 2),
		});
		f.write("src/a.ts", tsSource("a", 2, "edited"));
		f.write(
			"src/b.ts",
			tsSource("b", 2, "edited").replace("b function 1", "b function 1 POISON"),
		);
		f.stub.emptyFor = (text) => text.includes("POISON");
		const result = await prepareDirtyOverlay(f.ctx());
		expect(result.report).toMatchObject({
			state: "on",
			reason: "dirty",
			files: 1,
			filesFailed: 1,
		});
		expect(result.candidates?.servedPaths).toEqual(["src/a.ts"]);
		expect(result.report.gaps).toContain("file-failed-embed");
		expect(result.report.gapDetails).toContainEqual(
			expect.objectContaining({ token: "file-failed-embed", path: "src/b.ts" }),
		);
	});

	test("W-4: everything refused, but a deletion to suppress → on, the deletion suppressed (skipping would lose it)", async () => {
		const f = await fixture({
			"src/a.ts": tsSource("a", 2),
			"src/gone.ts": tsSource("gone", 1),
		});
		f.write("src/a.ts", tsSource("a", 2, "edited"));
		f.remove("src/gone.ts");
		f.stub.emptyFor = () => true;
		const result = await prepareDirtyOverlay(f.ctx());
		expect(result.report).toMatchObject({
			state: "on",
			reason: "dirty",
			files: 0,
			filesFailed: 1,
			filesDeleted: 1,
			embedded: 0,
		});
		expect(result.candidates?.suppressedPaths).toEqual(["src/gone.ts"]);
	});

	test("W-5: everything refused, but an earlier pass's build is still served → on, served + failed(embed) (TEST-32's 2nd search)", async () => {
		const f = await fixture({ "src/a.ts": tsSource("a", 2) });
		f.write("src/a.ts", tsSource("a", 2, "edited"));
		const first = await prepareDirtyOverlay(f.ctx());
		expect(first.candidates?.servedPaths).toEqual(["src/a.ts"]);
		// a.ts is built at its current hash; only the new file needs the
		// provider now, and the provider refuses everything.
		f.write("src/b.ts", tsSource("b", 2));
		f.stub.emptyFor = () => true;
		const textsBefore = f.stub.texts;
		const second = await prepareDirtyOverlay(f.ctx());
		expect(f.stub.texts).toBeGreaterThan(textsBefore); // b.ts was sent
		expect(second.report).toMatchObject({
			state: "on",
			reason: "dirty",
			files: 1,
			filesFailed: 1,
			embedded: 0,
		});
		expect(second.candidates?.servedPaths).toEqual(["src/a.ts"]);
		expect(second.report.gaps).toContain("file-failed-embed");
		expect(second.report.gapDetails).toContainEqual(
			expect.objectContaining({ token: "file-failed-embed", path: "src/b.ts" }),
		);
	});

	test("W-6: everything sent was refused, but a file built from cache hits ALONE is served → on", async () => {
		const f = await fixture({ "src/a.ts": tsSource("a", 2) });
		// a.ts's edited revision is already in the machine-global cache (e.g.
		// another worktree embedded it), so it needs no provider call at all.
		f.write("src/a.ts", tsSource("a", 2, "edited"));
		const warmed = await warmCacheWith(f, "src/a.ts");
		f.write("src/b.ts", tsSource("b", 2));
		f.stub.emptyFor = () => true;
		const result = await prepareDirtyOverlay(f.ctx());
		expect(result.report).toMatchObject({
			state: "on",
			reason: "dirty",
			files: 1,
			filesFailed: 1,
			embedded: 0,
			cacheHits: warmed,
		});
		expect(result.candidates?.servedPaths).toEqual(["src/a.ts"]);
	});
});

describe("outer review 2, MEDIUM 1: the refusal rule with the embed cache OFF", () => {
	/**
	 * W-7. The only dirty file is refused for ONE of its chunks while the
	 * provider answers the rest — so the provider works, and the refusal is
	 * per-file. With the cache on this was always `on` + `file-failed-embed`.
	 * Shipped with `"embedCache": false`: `accepted` read 0, clause (b) held,
	 * and the pass became `skipped/embed-failed` with "the provider accepted
	 * none of the overlay texts sent this pass" — false.
	 */
	for (const embedCacheConfigEnabled of [undefined, false]) {
		test(`W-7: one chunk refused, the rest answered, cache ${embedCacheConfigEnabled === false ? "OFF" : "on"} → on, failed(embed), not a provider-wide skip`, async () => {
			const f = await fixture({ "src/a.ts": tsSource("a", 3) });
			f.write(
				"src/a.ts",
				tsSource("a", 3, "edited").replace(
					"a function 1",
					"a function 1 POISON",
				),
			);
			f.stub.emptyFor = (text) => text.includes("POISON");
			const result = await prepareDirtyOverlay(
				f.ctx({ embedCacheConfigEnabled }),
			);
			const answered = f.stub.calls
				.flat()
				.filter((t) => !t.includes("POISON")).length;
			expect(answered).toBeGreaterThan(0);
			expect(result.report).toMatchObject({
				state: "on",
				reason: "dirty",
				filesFailed: 1,
				embedded: answered,
			});
			expect(result.report.gaps).toContain("file-failed-embed");
			expect(await f.overlayRows()).toEqual([]);
		});
	}
});

describe("overlay_embedded counts what the provider ACCEPTED", () => {
	test("E-1: a refused text is sent but not embedded (A)", async () => {
		const f = await fixture({
			"src/a.ts": tsSource("a", 2),
			"src/b.ts": tsSource("b", 2),
		});
		f.write("src/a.ts", tsSource("a", 2, "edited"));
		f.write(
			"src/b.ts",
			tsSource("b", 2, "edited").replace("b function 1", "b function 1 POISON"),
		);
		f.stub.emptyFor = (text) => text.includes("POISON");
		const result = await prepareDirtyOverlay(f.ctx());
		const sent = f.stub.texts;
		const refused = f.stub.calls.flat().filter((t) => t.includes("POISON"));
		expect(refused).toHaveLength(1);
		expect(sent).toBeGreaterThan(1);
		expect(result.report.embedded).toBe(sent - refused.length);
	});
});
