/**
 * Integration test for Gemini judge responses
 *
 * Run with: bun run src/benchmark-v2/test-gemini-judge.ts
 */

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

if (!OPENROUTER_API_KEY) {
	console.error("OPENROUTER_API_KEY not set");
	process.exit(1);
}

const MODELS_TO_TEST = [
	"google/gemini-2.0-flash-001",
	"google/gemini-2.5-flash-preview-05-20",
	"google/gemini-2.5-pro-preview-05-06",
];

// Sample judge prompt (similar to what we use in benchmarks)
const SYSTEM_PROMPT = `You are an expert code reviewer evaluating the quality of code summaries.
Rate the summary on a scale of 1-5 for each criterion.
Respond with JSON only, no markdown.`;

const USER_PROMPT = `Evaluate this summary of a TypeScript function:

CODE:
\`\`\`typescript
function calculateTotal(items: Item[]): number {
  return items.reduce((sum, item) => sum + item.price * item.quantity, 0);
}
\`\`\`

SUMMARY:
"Calculates the total price by multiplying each item's price by quantity and summing all values."

Respond with this exact JSON structure:
{
  "scores": {
    "accuracy": <1-5>,
    "completeness": <1-5>,
    "clarity": <1-5>
  },
  "reasoning": "<brief explanation>"
}`;

async function testModel(model: string): Promise<void> {
	console.log(`\n${"=".repeat(60)}`);
	console.log(`Testing: ${model}`);
	console.log("=".repeat(60));

	const body = {
		model,
		messages: [
			{ role: "system", content: SYSTEM_PROMPT },
			{ role: "user", content: USER_PROMPT },
		],
		max_tokens: 500,
		temperature: 0.1,
	};

	console.log("\nRequest:");
	console.log(`  model: ${model}`);
	console.log(`  max_tokens: ${body.max_tokens}`);
	console.log(`  temperature: ${body.temperature}`);

	try {
		const startTime = Date.now();
		const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Authorization": `Bearer ${OPENROUTER_API_KEY}`,
				"HTTP-Referer": "https://github.com/claudemem",
				"X-Title": "claudemem-test",
			},
			body: JSON.stringify(body),
		});

		const latency = Date.now() - startTime;

		console.log(`\nResponse Status: ${response.status} ${response.statusText}`);
		console.log(`Latency: ${latency}ms`);

		// Log all headers
		console.log("\nResponse Headers:");
		response.headers.forEach((value, key) => {
			if (key.toLowerCase().includes("rate") ||
				key.toLowerCase().includes("limit") ||
				key.toLowerCase().includes("retry") ||
				key.toLowerCase().includes("x-")) {
				console.log(`  ${key}: ${value}`);
			}
		});

		const text = await response.text();

		if (!response.ok) {
			console.log(`\nError Response Body:`);
			console.log(text);
			return;
		}

		let data: any;
		try {
			data = JSON.parse(text);
		} catch {
			console.log(`\nRaw Response (not JSON):`);
			console.log(text);
			return;
		}

		console.log("\nParsed Response:");
		console.log(`  id: ${data.id}`);
		console.log(`  model: ${data.model}`);
		console.log(`  choices: ${data.choices?.length || 0}`);

		if (data.choices && data.choices.length > 0) {
			const choice = data.choices[0];
			console.log(`\nChoice[0]:`);
			console.log(`  finish_reason: ${choice.finish_reason}`);
			console.log(`  message.role: ${choice.message?.role}`);
			console.log(`  message.content length: ${choice.message?.content?.length || 0}`);
			console.log(`  message.content (first 500 chars):`);
			const content = choice.message?.content || "(empty)";
			console.log(`    "${content.slice(0, 500)}${content.length > 500 ? '...' : ''}"`);

			// Try to parse as JSON
			if (content && content.trim()) {
				try {
					// Extract JSON from markdown if present
					const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
					const jsonStr = jsonMatch ? jsonMatch[1].trim() : content.trim();
					const parsed = JSON.parse(jsonStr);
					console.log(`\nParsed JSON successfully:`);
					console.log(JSON.stringify(parsed, null, 2));
				} catch (e) {
					console.log(`\nFailed to parse as JSON: ${e instanceof Error ? e.message : e}`);
				}
			}
		}

		if (data.usage) {
			console.log(`\nUsage:`);
			console.log(`  prompt_tokens: ${data.usage.prompt_tokens}`);
			console.log(`  completion_tokens: ${data.usage.completion_tokens}`);
			console.log(`  total_tokens: ${data.usage.total_tokens}`);
		}

		// Fetch generation stats for cost
		if (data.id) {
			await new Promise(r => setTimeout(r, 500)); // Wait for stats
			try {
				const genResponse = await fetch(
					`https://openrouter.ai/api/v1/generation?id=${data.id}`,
					{
						headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}` },
					}
				);
				if (genResponse.ok) {
					const genData = await genResponse.json() as any;
					if (genData.data) {
						console.log(`\nGeneration Stats:`);
						console.log(`  total_cost: $${genData.data.total_cost?.toFixed(6) || 'N/A'}`);
						console.log(`  tokens_prompt: ${genData.data.tokens_prompt}`);
						console.log(`  tokens_completion: ${genData.data.tokens_completion}`);
					}
				}
			} catch {
				// Ignore
			}
		}

	} catch (error) {
		console.log(`\nFetch Error: ${error instanceof Error ? error.message : error}`);
	}
}

async function runPairwiseTest(model: string): Promise<void> {
	console.log(`\n${"=".repeat(60)}`);
	console.log(`Pairwise Test: ${model}`);
	console.log("=".repeat(60));

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
"Creates a debounced version of a function that delays invocation until after 'delay' milliseconds have elapsed since the last call. Clears any pending timeout on each new call."

Which summary is better? Respond with JSON:
{
  "winner": "A" or "B",
  "confidence": "high" or "medium" or "low",
  "reasoning": "<brief explanation>"
}`;

	const body = {
		model,
		messages: [
			{ role: "user", content: PAIRWISE_PROMPT },
		],
		max_tokens: 300,
		temperature: 0.1,
	};

	try {
		const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Authorization": `Bearer ${OPENROUTER_API_KEY}`,
				"HTTP-Referer": "https://github.com/claudemem",
				"X-Title": "claudemem-test",
			},
			body: JSON.stringify(body),
		});

		console.log(`Status: ${response.status}`);

		if (!response.ok) {
			console.log(`Error: ${await response.text()}`);
			return;
		}

		const data = await response.json() as any;
		const content = data.choices?.[0]?.message?.content || "(empty)";
		const finishReason = data.choices?.[0]?.finish_reason;

		console.log(`finish_reason: ${finishReason}`);
		console.log(`content length: ${content.length}`);
		console.log(`content: "${content}"`);

	} catch (error) {
		console.log(`Error: ${error instanceof Error ? error.message : error}`);
	}
}

async function main() {
	console.log("Gemini Judge Integration Test");
	console.log("Testing various Gemini models via OpenRouter\n");

	for (const model of MODELS_TO_TEST) {
		await testModel(model);
		await new Promise(r => setTimeout(r, 1000)); // Rate limit delay
	}

	// Also test pairwise
	console.log("\n\n" + "=".repeat(60));
	console.log("PAIRWISE COMPARISON TESTS");
	console.log("=".repeat(60));

	for (const model of MODELS_TO_TEST) {
		await runPairwiseTest(model);
		await new Promise(r => setTimeout(r, 1000));
	}

	console.log("\n\nDone!");
	process.exit(0);
}

main();

// Make this file a module to avoid global scope conflicts
export {};
