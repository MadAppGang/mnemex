#!/usr/bin/env bun
/**
 * Convert qmd training data to claudemem format.
 *
 * qmd format:  {"query": "...", "output": [["lex", "..."], ["vec", "..."], ["hyde", "..."]]}
 * our format:  {"id", "seed_query", "model", "category", "lex", "vec", "hyde", "messages": [...]}
 *
 * Reads from training/data/sources/ and appends to training/data/train.jsonl
 */

import { readFileSync, appendFileSync, existsSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const SOURCE_DIR = join(ROOT, "data/sources");
const OUTPUT = join(ROOT, "data/train.jsonl");

const SYSTEM_PROMPT = `You are a code search query expansion engine. Given a search query, expand it into three types:
- lex: keyword variants for BM25 search (technical terms, synonyms, related identifiers)
- vec: a natural language rephrasing for semantic vector search
- hyde: a short hypothetical code snippet that would match this query

Rules:
- lex: 2-6 keywords/identifiers, comma-separated
- vec: natural language rephrasing, 10-20 words, do NOT repeat lex terms verbatim
- hyde: realistic 3-8 line code snippet, syntactically valid, not pseudocode
- Output EXACTLY 3 lines starting with lex:, vec:, hyde: in that order
- No explanations, preamble, markdown fences, or trailing text`;

interface QmdExample {
	query: string;
	output: [string, string][];
	category?: string;
}

interface OurExample {
	id: string;
	seed_query: string;
	model: string;
	language: string;
	category: string;
	lex: string;
	vec: string;
	hyde: string;
	raw_output: string;
	latency_ms: number;
	timestamp: string;
	messages: { role: string; content: string }[];
}

function categorizeQuery(query: string): string {
	const q = query.toLowerCase();

	// Symbol-like queries
	if (
		/\b(function|class|method|hook|component|module|import|export)\b/.test(q)
	)
		return "symbol";
	if (/\b(useeffect|usestate|useref|usememo)\b/.test(q)) return "symbol";

	// Error-like queries
	if (/\b(error|fix|debug|exception|crash|fail|bug|issue|broken)\b/.test(q))
		return "error";
	if (/\b(cors|injection|leak|timeout|deadlock)\b/.test(q)) return "error";

	// Framework queries
	if (
		/\b(react|vue|angular|express|django|flask|fastapi|next|nuxt|svelte)\b/.test(
			q,
		)
	)
		return "framework";
	if (
		/\b(docker|kubernetes|k8s|terraform|ansible|nginx|redis|kafka|stripe)\b/.test(
			q,
		)
	)
		return "framework";
	if (/\b(graphql|rest|grpc|websocket|oauth|jwt)\b/.test(q))
		return "framework";

	// Code review queries
	if (/\b(review|refactor|pattern|anti-?pattern|best practice|vs\b)/.test(q))
		return "code-review";
	if (/\b(monorepo|polyrepo|architecture|design)\b/.test(q))
		return "code-review";

	// Default to concept
	return "concept";
}

function detectLanguage(query: string, hyde: string): string {
	const combined = `${query} ${hyde}`.toLowerCase();

	if (/\b(python|pip|venv|django|flask|pytest|def |import )\b/.test(combined))
		return "python";
	if (
		/\b(typescript|tsx|interface |type |generic|angular)\b/.test(combined)
	)
		return "typescript";
	if (
		/\b(javascript|jsx|const |let |var |=>\s|\.then\(|require\()\b/.test(
			combined,
		)
	)
		return "javascript";
	if (/\b(golang|go |goroutine|chan |func |:= )\b/.test(combined))
		return "go";
	if (/\b(rust|cargo|fn |let mut|impl |pub fn)\b/.test(combined))
		return "rust";
	if (/\b(java|maven|gradle|public class|void )\b/.test(combined))
		return "java";
	if (/\b(ruby|gem |rails|def |end$)\b/.test(combined)) return "ruby";
	if (/\b(bash|shell|chmod|systemd|cron|sudo|apt)\b/.test(combined))
		return "bash";
	if (/\b(sql|postgres|mysql|select |insert |create table)\b/.test(combined))
		return "sql";
	if (/\b(css|flexbox|grid|scss|tailwind)\b/.test(combined)) return "css";
	if (/\b(html|dom|element|tag)\b/.test(combined)) return "html";
	if (/\b(docker|yaml|yml|config|nginx)\b/.test(combined)) return "yaml";

	return "mixed";
}

function loadJsonl(path: string): QmdExample[] {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf-8")
		.trim()
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l));
}

// Collect existing IDs to avoid duplicates
const existingIds = new Set<string>();
const existingQueries = new Set<string>();
if (existsSync(OUTPUT)) {
	for (const line of readFileSync(OUTPUT, "utf-8").trim().split("\n")) {
		if (!line.trim()) continue;
		const obj = JSON.parse(line);
		existingIds.add(obj.id);
		existingQueries.add(obj.seed_query.toLowerCase().trim());
	}
}
console.log(`Existing: ${existingIds.size} examples, ${existingQueries.size} unique queries`);

// Load qmd source files
const handcrafted = loadJsonl(join(SOURCE_DIR, "handcrafted.jsonl"));
const v3Filtered = loadJsonl(join(SOURCE_DIR, "v3_code_filtered.jsonl"));

console.log(`qmd handcrafted: ${handcrafted.length} examples`);
console.log(`qmd v3 code-filtered: ${v3Filtered.length} examples`);

// Merge and deduplicate
const allQmd = [...handcrafted, ...v3Filtered];
const seenQueries = new Set<string>();
const dedupedQmd: QmdExample[] = [];

for (const ex of allQmd) {
	const key = ex.query.toLowerCase().trim();
	if (seenQueries.has(key) || existingQueries.has(key)) continue;
	seenQueries.add(key);
	dedupedQmd.push(ex);
}

console.log(`After dedup (removing overlap with existing): ${dedupedQmd.length} examples`);

// Convert to our format
let written = 0;
let skipped = 0;

for (let i = 0; i < dedupedQmd.length; i++) {
	const ex = dedupedQmd[i];

	// Extract lex, vec, hyde from output pairs
	const lexParts: string[] = [];
	const vecParts: string[] = [];
	const hydeParts: string[] = [];

	for (const [type, text] of ex.output) {
		if (type === "lex") lexParts.push(text);
		else if (type === "vec") vecParts.push(text);
		else if (type === "hyde") hydeParts.push(text);
	}

	if (lexParts.length === 0 || vecParts.length === 0 || hydeParts.length === 0) {
		skipped++;
		continue;
	}

	// Combine multiple lex terms into comma-separated, pick first vec, keep hyde
	const lex = lexParts.join(", ");
	const vec = vecParts[0]; // Use first vec rephrasing
	const hyde = hydeParts[0]; // Use first hyde

	const category = categorizeQuery(ex.query);
	const language = detectLanguage(ex.query, hyde);

	// Build the assistant response in our lex:/vec:/hyde: format
	const assistantContent = `lex: ${lex}\nvec: ${vec}\nhyde: ${hyde}`;

	const id = `qmd-${String(i).padStart(4, "0")}`;

	const record: OurExample = {
		id,
		seed_query: ex.query,
		model: "qmd/handcrafted",
		language,
		category,
		lex,
		vec,
		hyde,
		raw_output: assistantContent,
		latency_ms: 0,
		timestamp: new Date().toISOString(),
		messages: [
			{ role: "system", content: SYSTEM_PROMPT },
			{ role: "user", content: `Query: ${ex.query}` },
			{ role: "assistant", content: assistantContent },
		],
	};

	appendFileSync(OUTPUT, JSON.stringify(record) + "\n");
	written++;
}

// Count total
const totalLines = readFileSync(OUTPUT, "utf-8").trim().split("\n").length;

console.log(`\nConverted: ${written} examples (${skipped} skipped — missing lex/vec/hyde)`);
console.log(`Total examples in ${OUTPUT}: ${totalLines}`);
