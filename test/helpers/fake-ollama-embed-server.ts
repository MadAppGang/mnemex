/**
 * A stand-in for Ollama's embedding endpoints, so a test can run a real
 * `mnemex index` or `mnemex observe` child with no network and no model.
 *
 * `hold: true` makes it a BARRIER. Every embed request after the client's
 * warm-up probe is parked until `release()`. A child that reaches its
 * embedding phase then sits there, holding the store lock, for as long as the
 * test needs. That turns "two indexers overlap" into a certainty instead of a
 * race against process start-up time.
 *
 * The counters are read by the TEST process, from outside the child. They are
 * how a test learns that a child got past the store lock (every request
 * arrives after the lock is taken: `Indexer.index()` acquires it before
 * `initialize()` builds the embeddings client), without asking the child.
 *
 * Point a child at it through that child's own temp HOME:
 * `~/.mnemex/config.json` = `{ embeddingProvider: "ollama", ollamaEndpoint:
 * server.url, defaultModel: "ollama/<name>" }`.
 */

export interface FakeEmbedServer {
	readonly url: string;
	/** Every request received, the warm-up probe included. */
	requests(): number;
	/** Embed requests received, EXCLUDING the warm-up probe: these are the ones parked. */
	embedRequests(): number;
	/**
	 * TEXTS embedded, excluding the warm-up probe — the external per-ITEM
	 * counter §4.1.2's measurement needs. A request count cannot answer "how
	 * many chunks reached the provider", because one request carries a batch.
	 */
	embedInputs(): number;
	/** Reset both counters, so a second run can be measured on its own. */
	resetCounts(): void;
	/** Answer every parked request and stop parking. */
	release(): void;
	stop(): void;
}

/** `OllamaEmbeddingsClient.warmup()` sends exactly this input. */
const WARMUP_INPUT = "test";

/** Deterministic, non-zero, and different for different text. */
function vectorFor(text: string, dimension: number): number[] {
	let h = 2166136261;
	for (let i = 0; i < text.length; i++) {
		h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
	}
	const vector: number[] = [];
	for (let d = 0; d < dimension; d++) {
		h = Math.imul(h ^ (d + 1), 16777619) >>> 0;
		vector.push(((h % 1000) + 1) / 1000);
	}
	return vector;
}

export function startFakeOllamaEmbedServer(
	options: { hold?: boolean; dimension?: number } = {},
): FakeEmbedServer {
	const dimension = options.dimension ?? 8;
	let holding = options.hold ?? false;
	let total = 0;
	let embeds = 0;
	let embedded = 0;
	let openGate: () => void = () => {};
	const gate = new Promise<void>((resolve) => {
		openGate = resolve;
	});

	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		// A parked request must outlive Bun's default 10 s idle timeout.
		idleTimeout: 0,
		async fetch(req) {
			const { pathname } = new URL(req.url);
			if (
				req.method !== "POST" ||
				(pathname !== "/api/embed" && pathname !== "/api/embeddings")
			) {
				return new Response("not found", { status: 404 });
			}
			const body = (await req.json()) as {
				input?: string | string[];
				prompt?: string;
			};
			const inputs =
				body.input === undefined
					? [body.prompt ?? ""]
					: Array.isArray(body.input)
						? body.input
						: [body.input];
			total++;
			const isWarmup = inputs.length === 1 && inputs[0] === WARMUP_INPUT;
			if (!isWarmup) {
				embeds++;
				embedded += inputs.length;
				if (holding) await gate;
			}
			if (pathname === "/api/embeddings") {
				return Response.json({
					embedding: vectorFor(inputs[0] ?? "", dimension),
				});
			}
			return Response.json({
				embeddings: inputs.map((text) => vectorFor(text, dimension)),
			});
		},
	});

	return {
		url: `http://127.0.0.1:${server.port}`,
		requests: () => total,
		embedRequests: () => embeds,
		embedInputs: () => embedded,
		resetCounts: () => {
			total = 0;
			embeds = 0;
			embedded = 0;
		},
		release: () => {
			holding = false;
			openGate();
		},
		stop: () => {
			holding = false;
			openGate();
			server.stop(true);
		},
	};
}
