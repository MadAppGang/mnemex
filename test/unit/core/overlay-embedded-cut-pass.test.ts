/**
 * Iteration 2, O3-2 — `overlay_embedded` on a BUDGET-CUT pass, counted on the
 * wire.
 *
 * The rig measured `wire − 2 > overlay_embedded` by 1-48 on every cut pass,
 * and equality on every completed one. Root cause: the cut aborts the embed
 * batch in flight; the REAL Ollama client sends one request per text and
 * dropped the vectors it had already received when the abort rejected the
 * call. So the answered prefix was uncounted AND uncached, and the next pass
 * sent it again.
 *
 * Deterministic, not a race: the fake server answers N texts and PARKS the
 * next one until the client abandons it (`failAfterNext(N, "stall")`), so the
 * budget always fires with exactly N answered.
 *
 *   O3-2a  the cut pass reports `embedded` == texts the server ANSWERED
 *   O3-2b  no answered text is ever sent again; across the passes that
 *          follow, no text is asked twice; each pass's `embedded` equals its
 *          own answered count
 *
 * The real `OllamaEmbeddingsClient` against a local fake server; temp HOME,
 * temp embed cache, temp overlay lock (the fixture's).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { OllamaEmbeddingsClient } from "../../../src/core/embeddings.js";
import { prepareDirtyOverlay } from "../../../src/core/overlay/dirty-overlay.js";
import {
	createOverlayFixture,
	DIM,
	indexAll,
	type OverlayFixture,
	tsSource,
} from "../../helpers/dirty-overlay-fixture.js";
import {
	type FakeEmbedServer,
	startFakeOllamaEmbedServer,
} from "../../helpers/fake-ollama-embed-server.js";

let fx: OverlayFixture | null = null;
let server: FakeEmbedServer | null = null;
afterEach(() => {
	server?.stop();
	server = null;
	fx?.cleanup();
	fx = null;
});

/**
 * The overlay ctx the way a real search builds it: the RAW client that
 * embedded the query (so it knows its width, as `rawEmbeddingsClient` does),
 * and that query's vector. The query request is then wiped from the server's
 * counters, so they hold the overlay's texts only (the rig's `wire − 2`).
 */
async function ollamaCtx(
	f: OverlayFixture,
	s: FakeEmbedServer,
	rebuildBudgetMs: number,
) {
	const queryClient = new OllamaEmbeddingsClient({
		model: "fake-embed",
		endpoint: s.url,
	});
	const query = await queryClient.embed(["the query"]);
	expect(queryClient.getDimension()).toBe(DIM);
	s.resetCounts();
	return f.ctx({
		queryClient,
		indexIdentity: { model: "fake-embed", provider: "ollama" },
		queryIdentity: { model: "fake-embed", provider: "ollama" },
		queryVector: query.embeddings[0] as number[],
		limits: { rebuildBudgetMs },
	});
}

describe("O3-2 — overlay_embedded on a budget-cut pass equals what the provider answered", () => {
	test("the answered prefix is counted, cached, and never sent again (A)", async () => {
		fx = await createOverlayFixture({
			"src/a.ts": tsSource("a", 8),
			"src/b.ts": tsSource("b", 8),
		});
		indexAll(fx, ["src/a.ts", "src/b.ts"]);
		fx.write("src/a.ts", tsSource("a", 8, "edited"));
		fx.write("src/b.ts", tsSource("b", 8, "edited"));
		server = startFakeOllamaEmbedServer({ dimension: DIM });

		// ── the cut pass: 5 answered, the 6th parked until the budget fires
		const ANSWERED = 5;
		const cutCtx = await ollamaCtx(fx, server, 1500);
		server.failAfterNext(ANSWERED, "stall");
		const cut = await prepareDirtyOverlay(cutCtx);
		expect(cut.report.gaps).toContain("embed-deadline");
		expect(cut.report.filesPending).toBeGreaterThan(0);
		const answeredOnCut = server.answeredTexts();
		expect(answeredOnCut).toHaveLength(ANSWERED);
		expect(server.aborted()).toBe(1); // the parked request was abandoned
		// O3-2a. Shipped: 0 — the whole aborted batch went uncounted.
		expect(cut.report.embedded).toBe(answeredOnCut.length);

		// ── the passes that follow, unconstrained, until nothing is pending
		server.failAfterNext(null);
		let passes = 0;
		let embeddedAfter = 0;
		const askedAfter: string[] = [];
		for (; passes < 5; passes++) {
			const ctx = await ollamaCtx(fx, server, 30_000); // resets the counters
			const pass = await prepareDirtyOverlay(ctx);
			askedAfter.push(...server.askedTexts());
			// Each pass's report agrees with the wire, to the text.
			expect(pass.report.embedded).toBe(server.answeredTexts().length);
			embeddedAfter += pass.report.embedded;
			if (pass.report.filesPending === 0) {
				expect(pass.report.files).toBe(2);
				break;
			}
		}
		expect(passes).toBeLessThan(5);

		// O3-2b. Shipped: the 5 answered texts were sent again.
		expect(askedAfter.filter((t) => answeredOnCut.includes(t))).toEqual([]);
		expect(new Set(askedAfter).size).toBe(askedAfter.length);
		expect(embeddedAfter).toBe(askedAfter.length);
	}, 30_000);
});

/**
 * Outer review 2, MEDIUM 1 — the same equality with the embed cache OFF
 * (`MNEMEX_DISABLE_EMBED_CACHE=1`, the env form of `"embedCache": false`).
 * Shipped: the opt-out was a bare pass-through that never counted, so every
 * pass reported `embedded: 0` however many texts the provider answered.
 *
 *   O3-2c  the cut pass AND the completed pass after it each report
 *          `embedded` == texts the server ANSWERED
 */
describe("O3-2c — overlay_embedded with the embed cache disabled", () => {
	test("cut and completed passes report what the provider answered (A)", async () => {
		const saved = process.env.MNEMEX_DISABLE_EMBED_CACHE;
		process.env.MNEMEX_DISABLE_EMBED_CACHE = "1";
		try {
			fx = await createOverlayFixture({
				"src/a.ts": tsSource("a", 8),
				"src/b.ts": tsSource("b", 8),
			});
			indexAll(fx, ["src/a.ts", "src/b.ts"]);
			fx.write("src/a.ts", tsSource("a", 8, "edited"));
			fx.write("src/b.ts", tsSource("b", 8, "edited"));
			server = startFakeOllamaEmbedServer({ dimension: DIM });

			const ANSWERED = 5;
			const cutCtx = await ollamaCtx(fx, server, 1500);
			server.failAfterNext(ANSWERED, "stall");
			const cut = await prepareDirtyOverlay(cutCtx);
			expect(cut.report.gaps).toContain("embed-deadline");
			expect(server.answeredTexts()).toHaveLength(ANSWERED);
			// Shipped: 0.
			expect(cut.report.embedded).toBe(server.answeredTexts().length);
			expect(cut.report.cacheHits).toBe(0);

			server.failAfterNext(null);
			const done = await prepareDirtyOverlay(
				await ollamaCtx(fx, server, 30_000),
			);
			expect(done.report.filesPending).toBe(0);
			expect(done.report.files).toBe(2);
			expect(server.answeredTexts().length).toBeGreaterThan(0);
			// Shipped: 0.
			expect(done.report.embedded).toBe(server.answeredTexts().length);
		} finally {
			if (saved === undefined) delete process.env.MNEMEX_DISABLE_EMBED_CACHE;
			else process.env.MNEMEX_DISABLE_EMBED_CACHE = saved;
		}
	}, 30_000);
});
