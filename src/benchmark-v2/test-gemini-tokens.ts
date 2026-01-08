/**
 * Test Gemini with various max_tokens settings
 */

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

if (!OPENROUTER_API_KEY) {
	console.error("OPENROUTER_API_KEY not set");
	process.exit(1);
}

const PAIRWISE_PROMPT = `Compare these two summaries of the same code and pick the better one.

CODE:
\`\`\`typescript
function debounce<T extends (...args: any[]) => any>(fn: T, delay: number): T {
  let timeoutId: NodeJS.Timeout;
  return ((...args: Parameters<T>) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), delay);
  }) as T;
}
\`\`\`

SUMMARY A:
"A debounce function that delays execution."

SUMMARY B:
"Creates a debounced version of a function that delays invocation until after 'delay' milliseconds have elapsed since the last call."

Which summary is better? Respond ONLY with JSON, no markdown:
{"winner": "A" or "B", "confidence": "high/medium/low", "reasoning": "brief"}`;

async function testWithTokenLimit(
	model: string,
	maxTokens: number,
): Promise<void> {
	console.log(`\n${model} with max_tokens=${maxTokens}:`);

	const response = await fetch(
		"https://openrouter.ai/api/v1/chat/completions",
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${OPENROUTER_API_KEY}`,
				"HTTP-Referer": "https://github.com/claudemem",
			},
			body: JSON.stringify({
				model,
				messages: [{ role: "user", content: PAIRWISE_PROMPT }],
				max_tokens: maxTokens,
				temperature: 0,
			}),
		},
	);

	if (!response.ok) {
		console.log(`  ERROR: ${response.status} - ${await response.text()}`);
		return;
	}

	const data = (await response.json()) as any;
	const content = data.choices?.[0]?.message?.content || "(empty)";
	const finishReason = data.choices?.[0]?.finish_reason;
	const completionTokens = data.usage?.completion_tokens;

	console.log(`  finish_reason: ${finishReason}`);
	console.log(`  completion_tokens: ${completionTokens}`);
	console.log(`  content length: ${content.length}`);
	console.log(
		`  content: "${content.slice(0, 200)}${content.length > 200 ? "..." : ""}"`,
	);
}

async function main() {
	console.log("Testing Gemini with various token limits\n");

	const models = [
		"google/gemini-2.0-flash-001",
		"google/gemini-2.5-pro-preview-05-06",
		"google/gemini-3-flash-preview",
		"google/gemini-3-pro-preview",
	];

	const tokenLimits = [300, 500, 1000, 2000, 4000];

	for (const model of models) {
		console.log(`\n${"=".repeat(60)}`);
		console.log(`Model: ${model}`);
		console.log("=".repeat(60));

		for (const tokens of tokenLimits) {
			try {
				await testWithTokenLimit(model, tokens);
			} catch (e) {
				console.log(`  FETCH ERROR: ${e}`);
			}
			await new Promise((r) => setTimeout(r, 500));
		}
	}

	console.log("\n\nDone!");
	process.exit(0);
}

main();

// Make this file a module to avoid global scope conflicts
export {};
