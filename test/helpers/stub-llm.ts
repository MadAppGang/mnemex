/**
 * THE STUB LLM — the harness this tree has never had.
 *
 * Before phase 3b-4, `grep -rln "createEnricher" test/` found nothing: there
 * was no way to drive the enricher without a real LLM, so V3.5's third count
 * (the enriched summary, end to end) was covered only at the row-class level
 * and V3.13 (§4.6's "LLM calls == 0 on a second worktree") could not be written
 * at all. 3b-2's finding 2 and decision I-15 both point here.
 *
 * TWO SHAPES, because the two criteria need different evidence:
 *
 *   `createStubLLMClient()` — an in-process `ILLMClient`. It counts its own
 *   calls, so a test that drives `createEnricher(...)` directly can assert on
 *   `stub.calls.length`. Cheap, and the only way to reach the enricher's own
 *   seams without an indexer.
 *
 *   `startFakeLLMServer()` — an OpenAI-compatible HTTP endpoint the REAL
 *   `LocalLLMClient` talks to. A child running the real `mnemex index` is
 *   pointed at it through its own sandboxed `~/.mnemex/config.json`
 *   (`llmEndpoint`) plus `MNEMEX_LLM=local/<model>`, so nothing in `src/` is
 *   modified to make the test possible and no injection seam exists in
 *   production code. Its counter lives in the PARENT and counts requests that
 *   really arrived — strictly stronger than a file the child writes about
 *   itself, which is the distinction CLAUDE.md #24 draws between counting the
 *   thing and counting a proxy for it.
 *
 * NO TEST MAY MAKE A REAL LLM CALL. Both shapes are local; the server binds
 * 127.0.0.1 on an ephemeral port and answers from the prompt text alone.
 *
 * THE ANSWERS ARE DETERMINISTIC, derived from a hash of the prompt. Two
 * consequences, both wanted:
 *   - identical content re-enriched twice produces the SAME summary text and
 *     therefore the same summary id, which is what the branch model's tier-1
 *     hit test assumes of every id class (§4.1.1);
 *   - different content produces different summary text, so a test can tell a
 *     reused summary from a freshly bought one by reading the row.
 * Neither hides a broken reuse path: V3.13 counts CALLS, and a call that
 * happened is visible whatever it returned.
 */

import type {
	ILLMClient,
	LLMGenerateOptions,
	LLMMessage,
	LLMProvider,
	LLMResponse,
	LLMUsageStats,
} from "../../src/types.js";

// ============================================================================
// The answer, derived from the prompt
// ============================================================================

/** FNV-1a over the text, as 8 hex characters. Deterministic and cheap. */
function digest(text: string): string {
	let h = 2166136261;
	for (let i = 0; i < text.length; i++) {
		h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
	}
	return h.toString(16).padStart(8, "0");
}

/** `Symbol: <name>` / `=== SYMBOL n: <name> [kind] ===` / `File: <path>`. */
function batchedSymbolNames(prompt: string): string[] {
	const names: string[] = [];
	for (const line of prompt.split("\n")) {
		const match = /^=== SYMBOL \d+: (.+?)(?: \(part of .+?\))? \[/.exec(line);
		if (match) names.push(match[1]);
	}
	return names;
}

function batchedFilePaths(prompt: string): string[] {
	const paths: string[] = [];
	for (const line of prompt.split("\n")) {
		const match = /^=== FILE \d+: (.+?) ===$/.exec(line);
		if (match) paths.push(match[1]);
	}
	return paths;
}

function fileSummaryBody(label: string, seed: string): Record<string, unknown> {
	return {
		summary: `stub summary of ${label} [${seed}]`,
		responsibilities: [`responsibility ${seed}`],
		exports: [`export_${seed}`],
		dependencies: [],
		patterns: [`pattern ${seed}`],
	};
}

function symbolSummaryBody(
	name: string,
	seed: string,
): Record<string, unknown> {
	return {
		name,
		summary: `stub summary of symbol ${name} [${seed}]`,
		parameters: [{ name: "n", description: `parameter ${seed}` }],
		returnDescription: `returns ${seed}`,
		sideEffects: [],
		usageContext: `use ${name} when ${seed}`,
	};
}

/**
 * The JSON body the stub answers a given enrichment prompt with.
 *
 * Exported so both shapes answer identically: the in-process client and the
 * HTTP server must not be able to drift apart, or a test that passes against
 * one says nothing about the other.
 */
export function stubEnrichmentAnswer(prompt: string): string {
	const seed = digest(prompt);
	const symbolNames = batchedSymbolNames(prompt);
	if (symbolNames.length > 0) {
		return JSON.stringify(
			symbolNames.map((name) => symbolSummaryBody(name, digest(name + seed))),
		);
	}
	const filePaths = batchedFilePaths(prompt);
	if (filePaths.length > 0) {
		return JSON.stringify(
			filePaths.map((path) => ({
				filePath: path,
				...fileSummaryBody(path, digest(path + seed)),
			})),
		);
	}
	const single = /^Symbol: (.+)$/m.exec(prompt);
	if (single) {
		return JSON.stringify(symbolSummaryBody(single[1], seed));
	}
	const file = /^File: (.+)$/m.exec(prompt);
	return JSON.stringify(fileSummaryBody(file ? file[1] : "unknown", seed));
}

// ============================================================================
// Shape 1 — an in-process ILLMClient
// ============================================================================

export interface StubLLMCall {
	messages: LLMMessage[];
	options?: LLMGenerateOptions;
}

export interface StubLLMClient extends ILLMClient {
	/** Every call, in order. `calls.length` is the count to assert on. */
	readonly calls: StubLLMCall[];
	/** Drop the history, so a second run can be measured on its own. */
	resetCalls(): void;
}

export function createStubLLMClient(
	options: { provider?: LLMProvider; model?: string } = {},
): StubLLMClient {
	const calls: StubLLMCall[] = [];
	const provider: LLMProvider = options.provider ?? "local";
	const model = options.model ?? "stub-model";
	let usage: LLMUsageStats = {
		inputTokens: 0,
		outputTokens: 0,
		cost: 0,
		calls: 0,
	};

	const complete = async (
		messages: LLMMessage[],
		generateOptions?: LLMGenerateOptions,
	): Promise<LLMResponse> => {
		calls.push({ messages, options: generateOptions });
		const prompt = messages.map((m) => m.content).join("\n");
		const content = stubEnrichmentAnswer(prompt);
		usage = {
			inputTokens: usage.inputTokens + prompt.length,
			outputTokens: usage.outputTokens + content.length,
			cost: usage.cost,
			calls: usage.calls + 1,
		};
		return { content, model, usage: { inputTokens: 0, outputTokens: 0 } };
	};

	return {
		calls,
		resetCalls() {
			calls.length = 0;
		},
		complete,
		async completeJSON<T>(
			messages: LLMMessage[],
			generateOptions?: LLMGenerateOptions,
		): Promise<T> {
			const response = await complete(messages, generateOptions);
			return JSON.parse(response.content) as T;
		},
		getProvider: () => provider,
		getModel: () => model,
		testConnection: async () => true,
		getAccumulatedUsage: () => usage,
		resetAccumulatedUsage() {
			usage = { inputTokens: 0, outputTokens: 0, cost: 0, calls: 0 };
		},
		isCloud: () => false,
		getModelSizeB: async () => undefined,
	};
}

// ============================================================================
// Shape 2 — an OpenAI-compatible endpoint the REAL client talks to
// ============================================================================

export interface FakeLLMServer {
	/** Pass this as `llmEndpoint` in the child's `~/.mnemex/config.json`. */
	readonly url: string;
	/** Chat completions received. THE COUNT V3.13 asserts on. */
	calls(): number;
	/** The user prompt of every call, in order. */
	prompts(): string[];
	resetCounts(): void;
	stop(): void;
}

/**
 * `LocalLLMClient` posts to `<endpoint>/chat/completions` — see
 * `src/llm/providers/local.ts`. `url` therefore already ends in `/v1`.
 */
export function startFakeLLMServer(): FakeLLMServer {
	let count = 0;
	const seen: string[] = [];

	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		idleTimeout: 0,
		async fetch(req) {
			const { pathname } = new URL(req.url);
			if (req.method !== "POST" || !pathname.endsWith("/chat/completions")) {
				return new Response("not found", { status: 404 });
			}
			const body = (await req.json()) as {
				model?: string;
				messages?: Array<{ role: string; content: string }>;
			};
			const prompt = (body.messages ?? [])
				.filter((m) => m.role !== "system")
				.map((m) => m.content)
				.join("\n");
			count++;
			seen.push(prompt);
			return Response.json({
				id: `stub-${count}`,
				model: body.model ?? "stub-model",
				choices: [
					{
						message: {
							role: "assistant",
							content: stubEnrichmentAnswer(prompt),
						},
						finish_reason: "stop",
					},
				],
				usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
			});
		},
	});

	return {
		url: `http://127.0.0.1:${server.port}/v1`,
		calls: () => count,
		prompts: () => [...seen],
		resetCounts() {
			count = 0;
			seen.length = 0;
		},
		stop() {
			server.stop(true);
		},
	};
}
