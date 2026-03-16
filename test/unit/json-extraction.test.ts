/**
 * Tests for LLM JSON extraction logic.
 *
 * The extractJSON method must handle messy LLM responses including:
 * - Markdown code fences
 * - Multiple JSON objects (prompt echoing + actual output)
 * - Trailing commas
 * - Prefix/suffix text around JSON
 */

import { describe, it, expect } from "bun:test";

// Re-implement the extractJSON logic from client.ts for isolated testing
function findAllTopLevelJSON(content: string): string[] {
	const results: string[] = [];
	let i = 0;

	while (i < content.length) {
		const char = content[i];
		if (char !== "{" && char !== "[") {
			i++;
			continue;
		}

		const closeChar = char === "{" ? "}" : "]";
		let depth = 0;
		let inString = false;
		let escapeNext = false;
		let end = -1;

		for (let j = i; j < content.length; j++) {
			const c = content[j];

			if (escapeNext) {
				escapeNext = false;
				continue;
			}

			if (c === "\\") {
				escapeNext = true;
				continue;
			}

			if (c === '"') {
				inString = !inString;
				continue;
			}

			if (inString) continue;

			if (c === char) depth++;
			else if (c === closeChar) {
				depth--;
				if (depth === 0) {
					end = j + 1;
					break;
				}
			}
		}

		if (end > i) {
			results.push(content.slice(i, end));
			i = end;
		} else {
			i++;
		}
	}

	return results;
}

function extractJSON(content: string): unknown {
	// Strategy 1: Try parsing as-is
	try {
		return JSON.parse(content);
	} catch {
		// continue
	}

	// Strategy 2: Remove markdown code fences
	let cleaned = content
		.replace(/```(?:json|javascript|typescript|ts|js)?\s*/gi, "")
		.replace(/```/g, "")
		.trim();

	try {
		return JSON.parse(cleaned);
	} catch {
		// continue
	}

	// Strategy 3: Find ALL top-level JSON structures and try each
	const candidates = findAllTopLevelJSON(cleaned);

	for (let i = candidates.length - 1; i >= 0; i--) {
		const candidate = candidates[i];
		try {
			return JSON.parse(candidate);
		} catch {
			const fixed = candidate.replace(/,\s*([}\]])/g, "$1");
			try {
				return JSON.parse(fixed);
			} catch {
				// next
			}
		}
	}

	// Strategy 4: Last resort
	const jsonStartBrace = cleaned.indexOf("{");
	const jsonStartBracket = cleaned.indexOf("[");
	let jsonStart = -1;

	if (jsonStartBrace !== -1 && jsonStartBracket !== -1) {
		jsonStart = Math.min(jsonStartBrace, jsonStartBracket);
	} else if (jsonStartBrace !== -1) {
		jsonStart = jsonStartBrace;
	} else if (jsonStartBracket !== -1) {
		jsonStart = jsonStartBracket;
	}

	if (jsonStart === -1) return null;

	cleaned = cleaned.slice(jsonStart);

	const lastBrace = cleaned.lastIndexOf("}");
	const lastBracket = cleaned.lastIndexOf("]");
	const lastClose = Math.max(lastBrace, lastBracket);
	if (lastClose > 0) {
		const trimmed = cleaned.slice(0, lastClose + 1);
		try {
			return JSON.parse(trimmed);
		} catch {
			try {
				return JSON.parse(trimmed.replace(/,\s*([}\]])/g, "$1"));
			} catch {
				// give up
			}
		}
	}

	return null;
}

describe("JSON Extraction", () => {
	it("should parse clean JSON", () => {
		const result = extractJSON('{"summary": "hello"}');
		expect(result).toEqual({ summary: "hello" });
	});

	it("should handle markdown code fences", () => {
		const result = extractJSON('```json\n{"summary": "hello"}\n```');
		expect(result).toEqual({ summary: "hello" });
	});

	it("should handle prefix text before JSON", () => {
		const result = extractJSON(
			'Here is the JSON summary:\n{"summary": "hello"}',
		);
		expect(result).toEqual({ summary: "hello" });
	});

	it("should handle suffix text after JSON", () => {
		const result = extractJSON('{"summary": "hello"}\n\nI hope this helps!');
		expect(result).toEqual({ summary: "hello" });
	});

	it("should handle trailing commas", () => {
		const result = extractJSON('{"summary": "hello", "items": ["a", "b",],}');
		expect(result).toEqual({ summary: "hello", items: ["a", "b"] });
	});

	it("should handle multiple JSON objects (pick last)", () => {
		// Simulates when the LLM echoes prompt JSON templates then outputs its own
		const response = `The file contains this JSON template:
{"template": "example", "fields": ["a", "b"]}

Here is my analysis:
{"summary": "This file defines enrichment prompts", "responsibilities": ["Prompt generation"]}`;

		const result = extractJSON(response) as any;
		expect(result.summary).toBe("This file defines enrichment prompts");
	});

	it("should handle JSON with nested braces in strings", () => {
		const result = extractJSON(
			'{"summary": "Uses pattern {key: value}", "count": 1}',
		);
		expect(result).toEqual({
			summary: "Uses pattern {key: value}",
			count: 1,
		});
	});

	it("should handle JSON arrays", () => {
		const result = extractJSON('[{"name": "a"}, {"name": "b"}]');
		expect(result).toEqual([{ name: "a" }, { name: "b" }]);
	});

	it("should handle response with echoed prompt JSON + actual output JSON", () => {
		// This is the enrichment.ts failure case: the LLM sees JSON templates
		// in the source code and may echo them before producing its own output
		const response = `\`\`\`json
{
  "summary": "One paragraph describing the file's main purpose",
  "responsibilities": ["Main responsibility 1"],
  "exports": ["exportedFunction1"],
  "dependencies": ["imported/module"],
  "patterns": ["Pattern used 1"]
}
\`\`\`

Actually, here is the correct analysis:

{
  "summary": "Defines prompt templates for LLM-based code enrichment",
  "responsibilities": ["Define system prompts for each document type", "Build user prompts for file and symbol summaries"],
  "exports": ["SYSTEM_PROMPTS", "buildFileSummaryPrompt", "buildSymbolSummaryPrompt"],
  "dependencies": ["../../types.js"],
  "patterns": ["Template pattern", "String interpolation"]
}`;

		const result = extractJSON(response) as any;
		// Should pick the last (more specific) JSON object
		expect(result.summary).toContain("prompt templates");
	});

	it("should return null for non-JSON content", () => {
		const result = extractJSON("This is just plain text with no JSON.");
		expect(result).toBeNull();
	});

	it("should handle escaped quotes in strings", () => {
		const result = extractJSON('{"summary": "Uses \\"quoted\\" values"}');
		expect(result).toEqual({ summary: 'Uses "quoted" values' });
	});
});
