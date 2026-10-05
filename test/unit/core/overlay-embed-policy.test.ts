/**
 * The overlay's embed call policy (code review 1, HIGH 1).
 *
 * The overlay embeds with the SAME raw client that embedded the query, and
 * that client carries the indexing retry ladder (6 attempts, 1+2+4+8+16 s per
 * TEXT). On the search path that ladder made one refused chunk cost minutes,
 * and one `[]` slot ended the whole pass. Now:
 *
 *   P-1  every overlay embed call carries `{ maxAttempts: 1, signal }` — a
 *        per-CALL policy; the client itself is untouched (stub)
 *   P-2  one chunk answered `[]` (the real clients' partial shape) → THAT file
 *        is `failed(embed)`, its index rows stay visible; the other file is
 *        served and the deleted file suppressed; no zero-length row (#15)
 *   P-3  a FATAL provider failure → `skipped/embed-failed` at the FIRST call
 *   P-4  every text of one file's call refused, non-fatally
 *        (`TotalEmbeddingFailureError`) → that file fails, the pass goes on
 *
 * The same through the REAL `OllamaEmbeddingsClient` and a fake Ollama server,
 * counted on the wire:
 *
 *   R-1  503 for every overlay text → ONE request per text (no ladder), each
 *        file `failed(embed)`, the pass back in well under the ladder's 31 s.
 *        The provider accepted nothing, but the pass still suppresses a
 *        deletion, so it did not give up: `on`, not `skipped/embed-failed`
 *        (condition (d) of `providerWideRefusal`; TEST-31 has no deletion)
 *   R-2  an EMPTY vector for one text → one request for it, its file
 *        `failed(embed)`, the other file served
 *   R-3  the provider stalls → the DEFAULT 8 s budget bounds the pass: back
 *        within 8 s + 1.5 s, the stalled request CANCELLED (the server sees
 *        the client abandon it), the files pending, the deletion suppressed
 *
 * Code review 2, MEDIUM 5 — the clients that send PARALLEL batches:
 *
 *   PB-1  OpenRouter and Voyage, one overlay call split into four concurrent
 *         requests: one answered 401 at once (fatal), three stalled. The pass
 *         is `skipped/embed-failed` promptly AND zero requests are left
 *         outstanding: every sibling's signal fired (counted at `fetch`)
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { chunkFileByPath } from "../../../src/core/chunker.js";
import {
	OllamaEmbeddingsClient,
	OpenRouterEmbeddingsClient,
	VoyageEmbeddingsClient,
} from "../../../src/core/embeddings.js";
import { TotalEmbeddingFailureError } from "../../../src/core/embeddings-errors.js";
import {
	OVERLAY_REBUILD_BUDGET_MS,
	prepareDirtyOverlay,
} from "../../../src/core/overlay/dirty-overlay.js";
import type { OverlayReport } from "../../../src/core/overlay/types.js";
import { overlayHeaderLines } from "../../../src/output/agent.js";
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
	vectorFor,
} from "../../helpers/fake-ollama-embed-server.js";

/**
 * `overlay_gaps` as an `--agent` consumer parses it: split on the documented
 * "; " separator. A gap text containing "; " comes back as two entries.
 */
function agentGapEntries(report: OverlayReport): string[] {
	const line = overlayHeaderLines({ ...report, suppressedRows: 0 }).find((l) =>
		l.startsWith("overlay_gaps="),
	);
	return line?.slice("overlay_gaps=".length).split("; ") ?? [];
}

/**
 * `overlay_gap_details` split the way an `--agent` consumer splits it: on
 * `; `, each entry percent-decoded (`;`, `%` and a path's `:` are escaped
 * inside fields, so a raw `; ` is always a separator — outer review 2, LOW 4).
 */
function agentDetailEntries(report: OverlayReport): string[] {
	const line = overlayHeaderLines({ ...report, suppressedRows: 0 }).find((l) =>
		l.startsWith("overlay_gap_details="),
	);
	const value = line?.slice("overlay_gap_details=".length) ?? "";
	return value === "" ? [] : value.split("; ").map(decodeURIComponent);
}

let fx: OverlayFixture | null = null;
let server: FakeEmbedServer | null = null;
const spies: Array<{ mockRestore(): void }> = [];
afterEach(() => {
	for (const spy of spies.splice(0)) spy.mockRestore();
	server?.stop();
	server = null;
	fx?.cleanup();
	fx = null;
});

/** a.ts and b.ts edited, gone.ts deleted: two files to build, one to suppress. */
async function threeWay(bMarker = ""): Promise<OverlayFixture> {
	fx = await createOverlayFixture({
		"src/a.ts": tsSource("a", 2),
		"src/b.ts": tsSource("b", 2),
		"src/gone.ts": tsSource("gone", 1),
	});
	indexAll(fx, ["src/a.ts", "src/b.ts", "src/gone.ts"]);
	fx.write("src/a.ts", tsSource("a", 2, "edited"));
	fx.write(
		"src/b.ts",
		tsSource("b", 2, "edited").replace(
			"b function 1",
			`b function 1 ${bMarker}`,
		),
	);
	fx.remove("src/gone.ts");
	return fx;
}

async function chunkCount(f: OverlayFixture, rel: string): Promise<number> {
	return (await chunkFileByPath(f.read(rel).toString("utf8"), rel, "h")).length;
}

/** The overlay ctx with the REAL Ollama client against the fake server. */
function ollamaCtx(f: OverlayFixture, s: FakeEmbedServer) {
	const client = new OllamaEmbeddingsClient({
		model: "fake-embed",
		endpoint: s.url,
	});
	return f.ctx({
		queryClient: client,
		indexIdentity: { model: "fake-embed", provider: "ollama" },
		queryIdentity: { model: "fake-embed", provider: "ollama" },
		queryVector: vectorFor("the query", DIM),
	});
}

describe("the overlay's call policy (stub provider)", () => {
	test("P-1: every overlay embed call carries { maxAttempts: 1, signal }", async () => {
		const f = await threeWay();
		await prepareDirtyOverlay(f.ctx());
		expect(f.stub.attempts).toBeGreaterThan(0);
		for (const policy of f.stub.policies) {
			expect(policy?.maxAttempts).toBe(1);
			expect(policy?.signal).toBeInstanceOf(AbortSignal);
		}
	});

	test("P-2: one chunk answered [] → that FILE fails, the rest is served, the deletion suppressed (A)", async () => {
		const f = await threeWay("POISON");
		f.stub.emptyFor = (text) => text.includes("POISON");
		const result = await prepareDirtyOverlay(f.ctx());
		expect(result.report).toMatchObject({
			state: "on",
			reason: "dirty",
			files: 1,
			filesFailed: 1,
			filesDeleted: 1,
		});
		expect(result.candidates?.servedPaths).toEqual(["src/a.ts"]);
		// b.ts's index rows stay visible: it is NOT suppressed.
		expect(result.candidates?.suppressedPaths).toEqual([
			"src/a.ts",
			"src/gone.ts",
		]);
		// O4: the failure is a token; which file, a detail.
		expect(result.report.gaps).toContain("file-failed-embed");
		expect(result.report.gapDetails).toContainEqual(
			expect.objectContaining({ token: "file-failed-embed", path: "src/b.ts" }),
		);
		// Nothing of b.ts was written, and no row anywhere is zero-length.
		const rows = await f.overlayRows();
		expect(rows.some((r) => r.filePath === "src/b.ts")).toBe(false);
		for (const row of rows) {
			expect((row.vector as ArrayLike<number>).length).toBe(DIM);
		}
	});

	test("P-3: a FATAL failure stops the pass at the first call → skipped/embed-failed", async () => {
		const f = await threeWay();
		f.stub.failAfter = 0;
		f.stub.failWith = () =>
			new Error("Cannot connect to Ollama at http://x. Is Ollama running?");
		const result = await prepareDirtyOverlay(f.ctx());
		expect(result.report).toMatchObject({
			state: "skipped",
			reason: "embed-failed",
		});
		expect(result.candidates).toBeUndefined();
		expect(f.stub.attempts).toBe(1);
	});

	test("P-4: one file's texts all refused, non-fatally → that file fails, the other is served (A)", async () => {
		const f = await threeWay("POISON");
		const original = f.stub.embed.bind(f.stub);
		f.stub.embed = async (texts, onProgress, options) => {
			if (texts.some((t) => t.includes("POISON"))) {
				f.stub.policies.push(options);
				throw new TotalEmbeddingFailureError(
					"Stub",
					texts.length,
					"Chunk 1: 503 service unavailable",
				);
			}
			return original(texts, onProgress, options);
		};
		const result = await prepareDirtyOverlay(f.ctx());
		expect(result.report.state).toBe("on");
		expect(result.report.filesFailed).toBe(1);
		expect(result.candidates?.servedPaths).toEqual(["src/a.ts"]);
		expect(result.candidates?.suppressedPaths).toContain("src/gone.ts");
	});
});

describe("through the REAL Ollama client, counted on the wire", () => {
	test("R-1: 503 for every overlay text → one request per text, no ladder, files failed(embed)", async () => {
		const f = await threeWay();
		server = startFakeOllamaEmbedServer({ dimension: DIM });
		server.failAfterNext(0, "503");
		const texts =
			(await chunkCount(f, "src/a.ts")) + (await chunkCount(f, "src/b.ts"));
		const started = Date.now();
		const result = await prepareDirtyOverlay(ollamaCtx(f, server));
		const elapsed = Date.now() - started;
		expect(server.refused()).toBe(texts); // ONE request per text
		expect(result.report).toMatchObject({
			state: "on",
			reason: "dirty",
			files: 0,
			filesFailed: 2,
			filesDeleted: 1,
			embedded: 0, // refused texts are not embedded (Phase 6)
		});
		expect(result.candidates?.suppressedPaths).toEqual(["src/gone.ts"]);
		// The ladder alone is 31 s per text; a warm-up probe costs 0.5 s.
		expect(elapsed).toBeLessThan(5000);
	}, 20_000);

	test("R-2: an EMPTY vector for one text → one request for it; its file fails, the other is served", async () => {
		const f = await threeWay("POISON");
		server = startFakeOllamaEmbedServer({ dimension: DIM });
		server.emptyVectorFor("POISON");
		const result = await prepareDirtyOverlay(ollamaCtx(f, server));
		expect(server.refused()).toBe(1); // asked once, never retried
		expect(result.report).toMatchObject({
			state: "on",
			files: 1,
			filesFailed: 1,
			filesDeleted: 1,
		});
		expect(result.candidates?.servedPaths).toEqual(["src/a.ts"]);
		const rows = await f.overlayRows();
		expect(rows.some((r) => r.filePath === "src/b.ts")).toBe(false);
	}, 20_000);

	test("R-3: a stalled provider → the default 8 s budget bounds the pass, and the request is CANCELLED", async () => {
		const f = await threeWay();
		server = startFakeOllamaEmbedServer({ dimension: DIM });
		server.failAfterNext(0, "stall");
		const MARGIN_MS = 1500; // git + classify + open + write + read; NFR-1b is 10 s
		const started = Date.now();
		const result = await prepareDirtyOverlay(ollamaCtx(f, server));
		const elapsed = Date.now() - started;
		expect(elapsed).toBeGreaterThanOrEqual(OVERLAY_REBUILD_BUDGET_MS - 50);
		expect(elapsed).toBeLessThan(OVERLAY_REBUILD_BUDGET_MS + MARGIN_MS);
		expect(result.report).toMatchObject({
			state: "on",
			reason: "dirty",
			files: 0,
			filesFailed: 0,
			filesDeleted: 1,
		});
		expect(result.report.filesPending).toBe(2);
		expect(result.report.gaps).toContain("embed-deadline");
		// Under `--agent` every token parses back as ONE entry, and so does
		// the deadline's DETAIL (code review 3, LOW 3b's class: "; " is the
		// separator between entries).
		expect(agentGapEntries(result.report)).toEqual([...result.report.gaps]);
		const deadline = result.report.gapDetails.filter(
			(d) => d.token === "embed-deadline",
		);
		expect(deadline).toHaveLength(1);
		expect(
			agentDetailEntries(result.report).filter((g) =>
				g.startsWith("embed-deadline:"),
			),
		).toEqual([`embed-deadline: ${deadline[0]?.message}`]);
		expect(result.candidates?.suppressedPaths).toEqual(["src/gone.ts"]);
		// Cancelled, not raced: the server saw the client abandon it.
		for (let i = 0; i < 50 && server.inFlight() > 0; i++) {
			await Bun.sleep(20);
		}
		expect(server.inFlight()).toBe(0);
		expect(server.aborted()).toBe(1);
	}, 30_000);
});

describe("parallel batches: a fatal answer cancels the siblings (code review 2, MEDIUM 5)", () => {
	const PARALLEL: Array<
		[string, () => OpenRouterEmbeddingsClient | VoyageEmbeddingsClient]
	> = [
		[
			"openrouter",
			() =>
				new OpenRouterEmbeddingsClient({ apiKey: "test-key", model: "m/x" }),
		],
		[
			"voyage",
			() =>
				new VoyageEmbeddingsClient({
					apiKey: "test-key",
					model: "voyage-code-3",
				}),
		],
	];

	test.each(PARALLEL)(
		"PB-1 %s: one 401 among concurrent requests → embed-failed, ZERO requests left outstanding (A)",
		async (_name, make) => {
			fx = await createOverlayFixture({ "src/big.ts": tsSource("big", 1) });
			const f = fx;
			indexAll(f, ["src/big.ts"]);
			// ≥ 61 chunks: one overlay call (64) = four 20-text requests at once.
			f.write("src/big.ts", tsSource("big", 64, "edited"));
			expect(await chunkCount(f, "src/big.ts")).toBeGreaterThanOrEqual(61);

			const signals: AbortSignal[] = [];
			const stalled: Array<() => void> = [];
			let outstanding = 0;
			const spy = spyOn(globalThis, "fetch").mockImplementation((async (
				_input: string | URL | Request,
				init?: RequestInit,
			) => {
				const signal = init?.signal ?? undefined;
				if (signal !== undefined) signals.push(signal);
				if (signals.length === 1) {
					return new Response("invalid api key", { status: 401 });
				}
				outstanding++;
				return await new Promise<Response>((resolve, reject) => {
					let settled = false;
					const settle = () => {
						if (settled) return;
						settled = true;
						outstanding--;
					};
					signal?.addEventListener(
						"abort",
						() => {
							settle();
							reject(signal.reason);
						},
						{ once: true },
					);
					// Test teardown only: never reached while the code is right.
					stalled.push(() => {
						settle();
						resolve(new Response("late", { status: 503 }));
					});
				});
			}) as typeof fetch);
			spies.push(spy);

			const client = make();
			const identity = {
				model: client.getModel(),
				provider: client.getProvider(),
			};
			const started = Date.now();
			try {
				const result = await prepareDirtyOverlay(
					f.ctx({
						queryClient: client,
						indexIdentity: identity,
						queryIdentity: identity,
						limits: { rebuildBudgetMs: 30_000 },
					}),
				);
				expect(result.report).toMatchObject({
					state: "skipped",
					reason: "embed-failed",
				});
				expect(Date.now() - started).toBeLessThan(5000);
				await Bun.sleep(20); // let the aborts' rejections run
				expect(signals.length).toBe(4);
				expect(outstanding).toBe(0);
				expect(signals.slice(1).every((s) => s.aborted)).toBe(true);
			} finally {
				for (const finish of stalled.splice(0)) finish();
			}
		},
		15_000,
	);
});
