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
	/**
	 * The `model` field of every embed request (warm-up probe EXCLUDED), in
	 * arrival order — what the provider was actually asked for, read from the
	 * wire rather than from the client's own report (MOD-1, step 3).
	 */
	models(): string[];
	/**
	 * Every text of every embed request, in arrival order, warm-up probe
	 * EXCLUDED — answered or not. Iteration 2, O3: "was this text sent again?"
	 */
	askedTexts(): string[];
	/** The subset of {@link askedTexts} the server ANSWERED with a vector. */
	answeredTexts(): string[];
	/** Embed requests refused because of {@link refuseAfterNext}. */
	refused(): number;
	/**
	 * Answer the next `n` embed requests, then refuse every later one until
	 * `null` is passed. The warm-up probe is never refused or counted. Lets a
	 * test embed a search's QUERY and then fail every overlay request after it
	 * (I-1 / V-R3.11 as re-scoped, step 3).
	 *
	 * The refusal is Ollama's own "model not found" 404, a SETTLED answer the
	 * client raises at once. A 5xx would be retried through the client's
	 * backoff ladder (6 attempts, 1+2+4+8+16 s) on an UNBOUNDED call — the
	 * query embedding, indexing, a fully-down endpoint (I-2). The overlay's
	 * own calls make one attempt (code review 1, HIGH 1); `failAfterNext(n,
	 * "503")` exercises that.
	 */
	refuseAfterNext(n: number | null): void;
	/**
	 * Like {@link refuseAfterNext}, with the misbehaviour chosen:
	 *   "refuse"  Ollama's 404 "model not found" — FATAL to the client;
	 *   "503"     a 503 — NOT fatal: the ladder on an unbounded call, one
	 *             request per text on the overlay's bounded one;
	 *   "stall"   never answer; the request ends only when the CLIENT aborts
	 *             it (counted by {@link aborted}) or the server stops.
	 * Every misbehaved request is counted by {@link refused}.
	 */
	failAfterNext(n: number | null, mode?: "refuse" | "503" | "stall"): void;
	/**
	 * Answer `embeddings: [[]]` (an EMPTY vector) for every embed request whose
	 * text contains `marker` — the shape a model returns for an input it will
	 * not embed. `null` turns it off. Counted by {@link refused}.
	 */
	emptyVectorFor(marker: string | null): void;
	/** Requests the CLIENT abandoned (its abort signal fired) before an answer. */
	aborted(): number;
	/** Requests received and not yet answered or abandoned. */
	inFlight(): number;
	/** Reset both counters, so a second run can be measured on its own. */
	resetCounts(): void;
	/** Answer every parked request and stop parking. */
	release(): void;
	stop(): void;
}

/** `OllamaEmbeddingsClient.warmup()` sends exactly this input. */
const WARMUP_INPUT = "test";

/**
 * Deterministic, non-zero, and different for different text. Exported so a
 * child can hold a query vector without spending a counted request on it.
 */
export function vectorFor(text: string, dimension: number): number[] {
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

/**
 * A vector that MEANS something: hashed bag of words (camelCase and snake_case
 * split, lower-cased), L2-normalised, plus a small floor so no component is 0.
 * Text sharing words with a query lands near it, so a test can assert RANKING
 * through a real search (step 3, M-4) — which `vectorFor`'s hash cannot carry:
 * there, every text is equidistant noise.
 */
export function bagOfWordsVector(text: string, dimension: number): number[] {
	const vector = new Array<number>(dimension).fill(0.01);
	const words = text
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((w) => w.length > 1);
	for (const word of words) {
		let h = 2166136261;
		for (let i = 0; i < word.length; i++) {
			h = Math.imul(h ^ word.charCodeAt(i), 16777619) >>> 0;
		}
		vector[h % dimension] += 1;
	}
	const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
	return vector.map((v) => v / norm);
}

export function startFakeOllamaEmbedServer(
	options: {
		hold?: boolean;
		dimension?: number;
		/** `"hash"` (default): `vectorFor`. `"bag-of-words"`: `bagOfWordsVector`. */
		vectors?: "hash" | "bag-of-words";
	} = {},
): FakeEmbedServer {
	const dimension = options.dimension ?? 8;
	const embedText =
		options.vectors === "bag-of-words" ? bagOfWordsVector : vectorFor;
	let holding = options.hold ?? false;
	let total = 0;
	let embeds = 0;
	let embedded = 0;
	let refusedCount = 0;
	let abortedCount = 0;
	let inFlightCount = 0;
	/** Embed requests still answered before refusing; null = never refuse. */
	let answerBudget: number | null = null;
	let failMode: "refuse" | "503" | "stall" = "refuse";
	let emptyMarker: string | null = null;
	let stopped = false;
	let onStop: () => void = () => {};
	const stopGate = new Promise<void>((resolve) => {
		onStop = resolve;
	});
	const seenModels: string[] = [];
	const asked: string[] = [];
	const answered: string[] = [];
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
				model?: string;
			};
			const inputs =
				body.input === undefined
					? [body.prompt ?? ""]
					: Array.isArray(body.input)
						? body.input
						: [body.input];
			total++;
			const isWarmup = inputs.length === 1 && inputs[0] === WARMUP_INPUT;
			if (!isWarmup) asked.push(...inputs);
			if (!isWarmup) {
				if (answerBudget !== null) {
					if (answerBudget <= 0) {
						refusedCount++;
						if (failMode === "503") {
							return new Response("service unavailable", { status: 503 });
						}
						if (failMode === "stall") {
							inFlightCount++;
							let abandoned = false;
							await Promise.race([
								stopGate,
								new Promise<void>((resolve) => {
									if (req.signal.aborted) {
										abandoned = true;
										resolve();
										return;
									}
									req.signal.addEventListener(
										"abort",
										() => {
											abandoned = true;
											resolve();
										},
										{ once: true },
									);
								}),
							]);
							inFlightCount--;
							if (abandoned) abortedCount++;
							return new Response("stalled", { status: 503 });
						}
						return new Response(
							JSON.stringify({
								error: `model "${body.model ?? ""}" not found, try pulling it first`,
							}),
							{ status: 404 },
						);
					}
					answerBudget--;
				}
				if (
					emptyMarker !== null &&
					inputs.some((text) => text.includes(emptyMarker as string))
				) {
					refusedCount++;
					return Response.json(
						pathname === "/api/embeddings"
							? { embedding: [] }
							: { embeddings: inputs.map(() => []) },
					);
				}
				seenModels.push(body.model ?? "");
				embeds++;
				embedded += inputs.length;
				if (holding) await gate;
				answered.push(...inputs);
			}
			if (pathname === "/api/embeddings") {
				return Response.json({
					embedding: embedText(inputs[0] ?? "", dimension),
				});
			}
			return Response.json({
				embeddings: inputs.map((text) => embedText(text, dimension)),
			});
		},
	});

	return {
		url: `http://127.0.0.1:${server.port}`,
		requests: () => total,
		embedRequests: () => embeds,
		embedInputs: () => embedded,
		models: () => [...seenModels],
		askedTexts: () => [...asked],
		answeredTexts: () => [...answered],
		refused: () => refusedCount,
		refuseAfterNext: (n) => {
			answerBudget = n;
			failMode = "refuse";
		},
		failAfterNext: (n, mode = "refuse") => {
			answerBudget = n;
			failMode = mode;
		},
		emptyVectorFor: (marker) => {
			emptyMarker = marker;
		},
		aborted: () => abortedCount,
		inFlight: () => inFlightCount,
		resetCounts: () => {
			total = 0;
			embeds = 0;
			embedded = 0;
			refusedCount = 0;
			abortedCount = 0;
			seenModels.length = 0;
			asked.length = 0;
			answered.length = 0;
		},
		release: () => {
			holding = false;
			openGate();
		},
		stop: () => {
			holding = false;
			openGate();
			if (!stopped) {
				stopped = true;
				onStop();
			}
			server.stop(true);
		},
	};
}
