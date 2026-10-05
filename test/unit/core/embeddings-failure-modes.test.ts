/**
 * How the embeddings clients report a failure that is NOT about one chunk.
 *
 * This is the root cause of the corruption incident this workstream started
 * from. `OllamaEmbeddingsClient.embed` caught a per-text error, pushed `[]` in
 * that text's place and carried on — deliberate, so one bad file cannot lose a
 * whole index run. But a model that was never pulled fails for EVERY text, so
 * every text got `[]`:
 *
 *   - on an index run that writes a `FixedSizeList[0]` vector column, which no
 *     query can ever read (CLAUDE.md gotcha #15) — the corruption
 *     `assertVectorDimension` and `UnqueryableVectorIndexError` exist to cope
 *     with, arriving with no error at all;
 *   - on a search it produces a 0-dimension query vector, and LanceDB answers
 *     "No vector column found to match with the query vector dimension: 0",
 *     which names neither the model nor the cause.
 *
 * Verified against a live Ollama while writing these tests:
 *
 *   $ curl -i -X POST localhost:11434/api/embed \
 *       -d '{"model":"never-pulled-embed","input":"test"}'
 *   HTTP/1.1 404 Not Found
 *   {"error":"model \"never-pulled-embed\" not found, try pulling it first"}
 *
 * 404 — the same status the client used to read as "this server is too old for
 * /api/embed", which made it retry the identical question against the legacy
 * endpoint and get the identical 404. The body is the only discriminator.
 *
 * `fetch` is replaced per test and restored in afterEach; nothing here talks to
 * a real provider.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	embeddingTextFingerprint,
	getModelContextLength,
	OllamaEmbeddingsClient,
	OpenRouterEmbeddingsClient,
} from "../../../src/core/embeddings.js";
import { TotalEmbeddingFailureError } from "../../../src/core/embeddings-errors.js";
import type {
	EmbeddingProvider,
	IEmbeddingsClient,
} from "../../../src/types.js";

const realFetch = globalThis.fetch;

/** Bodies Ollama actually returns, so the tests fail the way production did. */
const MODEL_NOT_FOUND_BODY = JSON.stringify({
	error: 'model "never-pulled-embed" not found, try pulling it first',
});

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

/** A valid OpenAI-shaped embedding response for `count` inputs. */
function openAiEmbeddings(count: number) {
	return {
		data: Array.from({ length: count }, (_, index) => ({
			index,
			embedding: [0.1, 0.2, 0.3],
		})),
		model: "test-model",
	};
}

let requests: string[] = [];

/**
 * Neutralize the retry backoff.
 *
 * A failing OpenRouter batch is retried 6 times with exponential delays — 31s
 * per batch, which is the right production behaviour and the wrong thing to sit
 * through in a unit test. These tests are about how a failure is CLASSIFIED,
 * not about the schedule, so the waiting is removed rather than reduced (which
 * would only make the suite slow and flaky instead of slow).
 */
function withInstantRetries<T>(client: T): T {
	(client as { sleep: (ms: number) => Promise<void> }).sleep = async () => {};
	return client;
}

beforeEach(() => {
	requests = [];
});

afterEach(() => {
	globalThis.fetch = realFetch;
});

describe("Ollama: a model that was never pulled", () => {
	beforeEach(() => {
		globalThis.fetch = (async (url: string | URL | Request) => {
			requests.push(String(url));
			// Both /api/embed and /api/embeddings answer this way — checked live.
			return new Response(MODEL_NOT_FOUND_BODY, { status: 404 });
		}) as typeof fetch;
	});

	test("throws instead of returning one empty vector per text", async () => {
		const client = withInstantRetries(
			new OllamaEmbeddingsClient({
				model: "never-pulled-embed",
				endpoint: "http://localhost:11434",
			}),
		);

		const error = await client.embed(["alpha", "beta", "gamma"]).then(
			() => null,
			(e: unknown) => e,
		);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("never-pulled-embed");
	});

	test("does not mistake the 404 for an old server and retry on the legacy endpoint", async () => {
		// The old code flipped to /api/embeddings here, asked the same impossible
		// question, and fed the answer into the per-chunk skip.
		const client = withInstantRetries(
			new OllamaEmbeddingsClient({
				model: "never-pulled-embed",
				endpoint: "http://localhost:11434",
			}),
		);

		await client.embed(["alpha"]).catch(() => {});

		expect(requests.some((url) => url.endsWith("/api/embeddings"))).toBe(false);
	});

	test("embedOne never yields the 0-dimension query vector", async () => {
		const client = withInstantRetries(
			new OllamaEmbeddingsClient({
				model: "never-pulled-embed",
				endpoint: "http://localhost:11434",
			}),
		);

		expect(client.embedOne("query")).rejects.toBeInstanceOf(Error);
	});
});

describe("total failure is never a per-text condition", () => {
	test("every batch failing throws, even for a retryable reason", async () => {
		// A 500 is exactly the kind of error the skip behaviour is for. At a 100%
		// failure rate it stops being one: there is no good text to keep.
		globalThis.fetch = (async () =>
			new Response("upstream exploded", { status: 500 })) as typeof fetch;

		const client = withInstantRetries(
			new OpenRouterEmbeddingsClient({
				model: "test-model",
				apiKey: "test-key",
			}),
		);

		const error = await client.embed(["alpha", "beta"]).then(
			() => null,
			(e: unknown) => e,
		);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("all 2 texts");

		// BY IDENTITY, not by message. The caching seam has to tell this apart
		// from every other embedding failure to decide whether a batch can be
		// served from cache with empty slots for the misses (some hits) or must
		// stay fatal (no hits) — and it may not import `embeddings.ts`, because
		// that would pull `config.ts` into the cache's import graph. So the class
		// lives in a leaf both modules can see.
		expect(error).toBeInstanceOf(TotalEmbeddingFailureError);
		const total = error as TotalEmbeddingFailureError;
		expect(total.provider).toBe("OpenRouter");
		expect(total.total).toBe(2);
		// The MESSAGE IS UNCHANGED from the anonymous Error this replaced, so
		// anything matching on the string is unaffected.
		expect(total.message).toContain(
			"embeddings failed for all 2 texts, so this is not a per-text problem.",
		);
		expect(total.message).toContain("First failure:");
	}, 60_000);

	test("a PARTIAL failure still skips and warns — the deliberate behaviour", async () => {
		// MAX_BATCH_SIZE is 20, so 21 texts make two batches. The first succeeds,
		// the second does not: the run must keep the 20 good vectors.
		let call = 0;
		globalThis.fetch = (async () => {
			call++;
			if (call === 1) return jsonResponse(openAiEmbeddings(20));
			return new Response("upstream exploded", { status: 500 });
		}) as typeof fetch;

		const client = withInstantRetries(
			new OpenRouterEmbeddingsClient({
				model: "test-model",
				apiKey: "test-key",
			}),
		);

		const result = await client.embed(
			Array.from({ length: 21 }, (_, i) => `text-${i}`),
		);

		expect(result.embeddings).toHaveLength(21);
		expect(result.embeddings[0]).toEqual([0.1, 0.2, 0.3]);
		expect(result.embeddings[20]).toEqual([]);
		expect(result.warnings?.join(" ")).toContain("1/21 chunks skipped");
	}, 60_000);
});

describe("embedOne", () => {
	test("refuses an empty vector even when the provider reports success", async () => {
		// A provider that answers 200 with nothing usable is still unusable; the
		// caller would otherwise query with a zero-length vector.
		globalThis.fetch = (async () =>
			jsonResponse({
				data: [{ index: 0, embedding: [] }],
				model: "test-model",
			})) as typeof fetch;

		const client = withInstantRetries(
			new OpenRouterEmbeddingsClient({
				model: "test-model",
				apiKey: "test-key",
			}),
		);

		const error = await client.embedOne("query").then(
			() => null,
			(e: unknown) => e,
		);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("test-model");
	}, 60_000);
});

describe("embeddingTextFingerprint — the one declared below-seam transform", () => {
	function clientLike(
		provider: EmbeddingProvider,
		model: string,
	): IEmbeddingsClient {
		return {
			getModel: () => model,
			getProvider: () => provider,
			getDimension: () => undefined,
			isLocal: () => provider === "ollama",
			embed: async () => ({ embeddings: [] }),
			embedOne: async () => [1],
		};
	}

	test("ollama reports its truncation limit, because it truncates", () => {
		// `OllamaEmbeddingsClient.embed` pre-truncates every text to
		// `getModelContextLength(model)`, so the vector corresponds to
		// truncate(text, K) while the cache key is over `text`. K is a CODE
		// CONSTANT keyed by model name, not a property of the model's identity,
		// so it has to travel with the row or an edit to the table silently
		// changes the vector behind an unchanged key.
		expect(
			embeddingTextFingerprint(clientLike("ollama", "nomic-embed-text")),
		).toBe(`trunc:${getModelContextLength("nomic-embed-text")}`);
	});

	test("a model with no table entry still reports the default it will use", () => {
		// The dangerous case is a model that FALLS THROUGH to the 8192 default:
		// adding it to the table later changes the truncation without changing
		// the model name. The fingerprint moves with it, so those rows are
		// vetoed instead of silently reused.
		const unknown = "some-model-nobody-listed";
		expect(getModelContextLength(unknown)).toBe(8192);
		expect(embeddingTextFingerprint(clientLike("ollama", unknown))).toBe(
			"trunc:8192",
		);
	});

	test("a client that transforms nothing reports the empty string", () => {
		for (const provider of ["openrouter", "voyage", "local"] as const) {
			expect(embeddingTextFingerprint(clientLike(provider, "any-model"))).toBe(
				"",
			);
		}
	});
});
