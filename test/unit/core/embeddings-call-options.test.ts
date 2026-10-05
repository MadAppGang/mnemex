/**
 * `EmbedCallOptions` is honoured by EVERY production embeddings client (code
 * review 1, HIGH 1).
 *
 * The parameter is optional and trailing, so a client whose `embed` declares
 * fewer parameters still satisfies `IEmbeddingsClient` (CLAUDE.md #32): the
 * compiler pins the ARGUMENT, never its USE. This pins the use, per client,
 * on the requests that reach `fetch`:
 *
 *   OPT-1  `maxAttempts: 1` → exactly ONE request for the text, no back-off
 *   OPT-2  an abort mid-request → the request's own signal fires, `embed`
 *          rejects promptly, nothing is retried
 *   OPT-3  CONTROL — no options → the client's own ladder, unchanged: six
 *          attempts (the back-off sleep is stubbed so this costs no time).
 *          This is the path indexing and the query embedding take.
 *
 * No network: `fetch` is replaced for the test. Keys are passed explicitly,
 * so no credential lookup runs (CLAUDE.md #24).
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
	LocalEmbeddingsClient,
	OllamaEmbeddingsClient,
	OpenRouterEmbeddingsClient,
	VoyageEmbeddingsClient,
} from "../../../src/core/embeddings.js";
import type { IEmbeddingsClient } from "../../../src/types.js";

type Restorable = { mockRestore(): void };
const spies: Restorable[] = [];
afterEach(() => {
	for (const spy of spies.splice(0)) spy.mockRestore();
});

const ENDPOINT = "http://127.0.0.1:9";

const CLIENTS: Array<[string, () => IEmbeddingsClient]> = [
	[
		"openrouter",
		() => new OpenRouterEmbeddingsClient({ apiKey: "test-key", model: "m/x" }),
	],
	[
		"voyage",
		() =>
			new VoyageEmbeddingsClient({
				apiKey: "test-key",
				model: "voyage-code-3",
			}),
	],
	[
		"ollama",
		() => new OllamaEmbeddingsClient({ endpoint: ENDPOINT, model: "m" }),
	],
	[
		"local",
		() => new LocalEmbeddingsClient({ endpoint: ENDPOINT, model: "m" }),
	],
];

/** A warm-up probe (Ollama, Local): answered, so the client is warm. */
function isWarmup(body: string): boolean {
	const parsed = JSON.parse(body) as { input?: unknown };
	return parsed.input === "test";
}

function warmupAnswer(url: string): Response {
	return url.endsWith("/api/embed")
		? Response.json({ model: "m", embeddings: [[0.1, 0.2]] })
		: Response.json({ data: [{ embedding: [0.1, 0.2], index: 0 }] });
}

/** Replace fetch; `answer` decides every non-warm-up request. */
function fakeFetch(
	answer: (signal: AbortSignal | undefined) => Promise<Response>,
): { calls: Array<{ signal: AbortSignal | undefined }> } {
	const calls: Array<{ signal: AbortSignal | undefined }> = [];
	const spy = spyOn(globalThis, "fetch").mockImplementation((async (
		input: string | URL | Request,
		init?: RequestInit,
	) => {
		const url = String(input);
		const body = String(init?.body ?? "{}");
		if (isWarmup(body)) return warmupAnswer(url);
		const signal = init?.signal ?? undefined;
		calls.push({ signal });
		return answer(signal);
	}) as typeof fetch);
	spies.push(spy);
	return { calls };
}

const unavailable = async () => new Response("unavailable", { status: 503 });

describe.each(CLIENTS)("%s", (_name, make) => {
	test("OPT-1: maxAttempts 1 → one request, no back-off", async () => {
		const { calls } = fakeFetch(unavailable);
		const client = make();
		const started = Date.now();
		await expect(
			client.embed(["some code"], undefined, { maxAttempts: 1 }),
		).rejects.toThrow();
		expect(calls.length).toBe(1);
		// No ladder step (the first is 1 s). The Ollama warm-up's own 0.5 s
		// settle is the only sleep left.
		expect(Date.now() - started).toBeLessThan(900);
	}, 5_000);

	test("OPT-2: an abort ends the in-flight request and the call, nothing retried", async () => {
		const controller = new AbortController();
		let abortedAt = 0;
		const { calls } = fakeFetch(
			(signal) =>
				new Promise<Response>((_resolve, reject) => {
					signal?.addEventListener("abort", () => reject(signal.reason), {
						once: true,
					});
					// The caller gives up while THIS request is in flight.
					setTimeout(() => {
						abortedAt = Date.now();
						controller.abort(new Error("deadline"));
					}, 50);
				}),
		);
		const client = make();
		await expect(
			client.embed(["some code"], undefined, {
				signal: controller.signal,
				maxAttempts: 1,
			}),
		).rejects.toThrow("deadline");
		expect(abortedAt).toBeGreaterThan(0);
		expect(Date.now() - abortedAt).toBeLessThan(200);
		expect(calls.length).toBe(1);
		expect(calls[0]?.signal?.aborted).toBe(true);
	}, 5_000);

	test("OPT-3 (control): no options → the client's own six-attempt ladder", async () => {
		const { calls } = fakeFetch(unavailable);
		const client = make();
		const sleeps: number[] = [];
		const sleep = spyOn(
			client as unknown as { sleep(ms: number): Promise<void> },
			"sleep",
		).mockImplementation(async (ms: number) => {
			sleeps.push(ms);
		});
		spies.push(sleep);
		await expect(client.embed(["some code"])).rejects.toThrow();
		expect(calls.length).toBe(6);
		// The back-off between them is the ladder's: 1, 2, 4, 8, 16 s.
		expect(sleeps.filter((ms) => ms >= 1000)).toEqual([
			1000, 2000, 4000, 8000, 16000,
		]);
	}, 5_000);
});

// ════════════════════════════════════════════════════════════════════════════
// OPT-4 (iteration 2, O3) — `onAnswered` reports every answered text AS IT
// LANDS, so an abort later in the same call cannot take it with it. Pinned
// per client for the same reason as OPT-1..3: a client that never calls it
// still type-checks.
// ════════════════════════════════════════════════════════════════════════════

/** Texts per request each client sends (Ollama: one per text). */
const PER_REQUEST: Record<string, number> = {
	openrouter: 20,
	voyage: 20,
	ollama: 1,
	local: 10,
};

function inputsOf(body: string): string[] {
	const parsed = JSON.parse(body) as { input?: unknown; prompt?: unknown };
	const input = parsed.input ?? parsed.prompt;
	return Array.isArray(input) ? (input as string[]) : [String(input)];
}

function vectorOf(text: string): number[] {
	return [text.length, 1, 2];
}

describe.each(CLIENTS)("%s", (name, make) => {
	test("OPT-4: answered texts are reported through onAnswered before a later abort", async () => {
		const perRequest = PER_REQUEST[name] as number;
		// One full request answered, then the next request hangs until abort.
		const texts = Array.from(
			{ length: perRequest + 3 },
			(_, i) => `text number ${i}`,
		);
		const controller = new AbortController();
		let answeredRequests = 0;
		const spy = spyOn(globalThis, "fetch").mockImplementation((async (
			input: string | URL | Request,
			init?: RequestInit,
		) => {
			const url = String(input);
			const body = String(init?.body ?? "{}");
			if (isWarmup(body)) return warmupAnswer(url);
			const signal = init?.signal ?? undefined;
			if (answeredRequests >= 1) {
				return new Promise<Response>((_resolve, reject) => {
					signal?.addEventListener("abort", () => reject(signal.reason), {
						once: true,
					});
					setTimeout(() => controller.abort(new Error("deadline")), 30);
				});
			}
			answeredRequests++;
			const inputs = inputsOf(body);
			if (url.endsWith("/api/embed")) {
				return Response.json({ model: "m", embeddings: inputs.map(vectorOf) });
			}
			return Response.json({
				data: inputs.map((t, index) => ({ embedding: vectorOf(t), index })),
				usage: { total_tokens: 1 },
			});
		}) as typeof fetch);
		spies.push(spy);

		const seen: Array<[number, number[]]> = [];
		const client = make();
		await expect(
			client.embed(texts, undefined, {
				signal: controller.signal,
				maxAttempts: 1,
				onAnswered: (index, vector) => seen.push([index, [...vector]]),
			}),
		).rejects.toThrow("deadline");

		// Exactly the first request's texts, each at ITS index in `texts`,
		// each with the vector the provider sent for it.
		expect(seen.map(([i]) => i).sort((a, b) => a - b)).toEqual(
			Array.from({ length: perRequest }, (_, i) => i),
		);
		for (const [i, vector] of seen) {
			expect(vector).toEqual(vectorOf(texts[i] as string));
		}
	}, 5_000);
});
