#!/usr/bin/env bun
/**
 * Dataset Quality Validation & Train/Eval Split
 *
 * Checks:
 *  1. Format compliance (required fields, non-empty lex/vec/hyde)
 *  2. Deduplication (exact + fuzzy query matching)
 *  3. Keyword relevance (lex terms overlap with query)
 *  4. Vec quality (min length, not just echoing the query)
 *  5. Hyde quality (looks like code or technical content, min length)
 *  6. Category & language coverage
 *
 * Then splits into train/eval (90/10, stratified by category).
 *
 * Usage: bun run experiments/query-expansion/training/scripts/validate-dataset.ts [--fix] [--split]
 *   --fix    Remove bad examples and write cleaned file
 *   --split  Write train.jsonl and eval.jsonl splits
 */

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const INPUT = join(ROOT, "data/train.jsonl");
const CLEAN_OUTPUT = join(ROOT, "data/train-clean.jsonl");
const TRAIN_OUTPUT = join(ROOT, "data/train-split.jsonl");
const EVAL_OUTPUT = join(ROOT, "data/eval-split.jsonl");

const args = process.argv.slice(2);
const doFix = args.includes("--fix");
const doSplit = args.includes("--split");

// ─── Types ───────────────────────────────────────────────────────────
interface Example {
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

interface Issue {
	id: string;
	query: string;
	severity: "error" | "warning";
	check: string;
	detail: string;
}

// ─── Load ────────────────────────────────────────────────────────────
const lines = readFileSync(INPUT, "utf-8").trim().split("\n");
const examples: Example[] = lines.map((l) => JSON.parse(l));
console.log(`Loaded ${examples.length} examples from ${INPUT}\n`);

// ─── Validation ──────────────────────────────────────────────────────
const issues: Issue[] = [];
const passedIds = new Set<string>();

function issue(
	ex: Example,
	severity: "error" | "warning",
	check: string,
	detail: string,
) {
	issues.push({ id: ex.id, query: ex.seed_query, severity, check, detail });
}

// Normalize for fuzzy dedup
function normalize(q: string): string {
	return q
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

// Check 1: Format compliance
for (const ex of examples) {
	if (!ex.id) issue(ex, "error", "format", "missing id");
	if (!ex.seed_query?.trim()) issue(ex, "error", "format", "missing seed_query");
	if (!ex.lex?.trim()) issue(ex, "error", "format", "empty lex");
	if (!ex.vec?.trim()) issue(ex, "error", "format", "empty vec");
	if (!ex.hyde?.trim()) issue(ex, "error", "format", "empty hyde");
	if (!ex.messages || ex.messages.length !== 3)
		issue(ex, "error", "format", `messages has ${ex.messages?.length ?? 0} entries (expected 3)`);
	if (!ex.category) issue(ex, "warning", "format", "missing category");
	if (!ex.language) issue(ex, "warning", "format", "missing language");
}

// Check 2: Deduplication
const queryMap = new Map<string, string[]>(); // normalized -> ids
for (const ex of examples) {
	const key = normalize(ex.seed_query);
	const existing = queryMap.get(key);
	if (existing) {
		existing.push(ex.id);
		if (existing.length === 2) {
			// Only flag on second occurrence
			issue(ex, "warning", "dedup", `duplicate query "${ex.seed_query}" (also: ${existing[0]})`);
		} else {
			issue(ex, "warning", "dedup", `duplicate query "${ex.seed_query}" (${existing.length}th occurrence)`);
		}
	} else {
		queryMap.set(key, [ex.id]);
	}
}

// Check 3: Keyword relevance (lex terms should relate to query)
for (const ex of examples) {
	if (!ex.lex?.trim()) continue;
	const queryWords = new Set(
		normalize(ex.seed_query)
			.split(" ")
			.filter((w) => w.length > 2),
	);
	const lexWords = new Set(
		normalize(ex.lex)
			.split(/[\s,]+/)
			.filter((w) => w.length > 2),
	);

	// At least one query word should appear in lex (very lenient)
	const overlap = [...queryWords].filter((w) => lexWords.has(w));
	if (overlap.length === 0 && queryWords.size > 0) {
		issue(ex, "warning", "lex-relevance", `no query word overlap in lex: "${ex.lex.slice(0, 60)}..."`);
	}

	// Lex shouldn't be too short
	if (ex.lex.trim().split(/[\s,]+/).length < 2) {
		issue(ex, "warning", "lex-short", `lex has fewer than 2 terms: "${ex.lex}"`);
	}
}

// Check 4: Vec quality
for (const ex of examples) {
	if (!ex.vec?.trim()) continue;
	const vecLen = ex.vec.trim().split(/\s+/).length;

	// Vec should be a natural language rephrasing (at least 5 words)
	if (vecLen < 5) {
		issue(ex, "warning", "vec-short", `vec is only ${vecLen} words: "${ex.vec}"`);
	}

	// Vec shouldn't be identical to the query
	if (normalize(ex.vec) === normalize(ex.seed_query)) {
		issue(ex, "warning", "vec-echo", "vec is identical to query");
	}
}

// Check 5: Hyde quality
for (const ex of examples) {
	if (!ex.hyde?.trim()) continue;

	// Hyde should have minimum length (at least 20 chars)
	if (ex.hyde.trim().length < 20) {
		issue(ex, "warning", "hyde-short", `hyde is only ${ex.hyde.trim().length} chars: "${ex.hyde}"`);
	}

	// For code queries, hyde should look like code or technical content
	// Check for common code patterns
	const codeSignals = [
		/[{}\[\]()]/,           // brackets
		/[=<>!]+/,              // operators
		/\b(import|def|function|class|const|let|var|return|if|for|while)\b/i,
		/\b(select|create|insert|update|delete|from|where)\b/i,
		/\b(sudo|apt|npm|pip|docker|git|curl|wget)\b/i,
		/\.\w+\(/,             // method calls
		/\w+\.\w+/,            // property access
		/\/\//,                // comments
		/#/,                   // comments or shell
	];

	// Technical prose signals (for qmd-style hyde that's descriptive rather than code)
	const proseSignals = [
		/\b(configure|install|deploy|setup|implement)\b/i,
		/\b(server|client|database|api|endpoint)\b/i,
		/\b(authentication|authorization|encryption)\b/i,
		/\b(file|directory|permission|process|thread)\b/i,
	];

	const hasCode = codeSignals.some((r) => r.test(ex.hyde));
	const hasProse = proseSignals.some((r) => r.test(ex.hyde));

	if (!hasCode && !hasProse) {
		issue(ex, "warning", "hyde-quality", `hyde doesn't look like code or tech content: "${ex.hyde.slice(0, 80)}..."`);
	}
}

// ─── Report ──────────────────────────────────────────────────────────
const errors = issues.filter((i) => i.severity === "error");
const warnings = issues.filter((i) => i.severity === "warning");

console.log("═══════════════════════════════════════════════════════");
console.log("  Dataset Quality Report");
console.log("═══════════════════════════════════════════════════════\n");

// Summary counts by check
const checkCounts = new Map<string, { errors: number; warnings: number }>();
for (const i of issues) {
	const entry = checkCounts.get(i.check) || { errors: 0, warnings: 0 };
	if (i.severity === "error") entry.errors++;
	else entry.warnings++;
	checkCounts.set(i.check, entry);
}

console.log("Check Results:");
const allChecks = ["format", "dedup", "lex-relevance", "lex-short", "vec-short", "vec-echo", "hyde-short", "hyde-quality"];
for (const check of allChecks) {
	const entry = checkCounts.get(check);
	if (!entry) {
		console.log(`  ✓ ${check.padEnd(16)} — all pass`);
	} else {
		const parts = [];
		if (entry.errors > 0) parts.push(`${entry.errors} errors`);
		if (entry.warnings > 0) parts.push(`${entry.warnings} warnings`);
		console.log(`  ✗ ${check.padEnd(16)} — ${parts.join(", ")}`);
	}
}

// Print errors
if (errors.length > 0) {
	console.log(`\n── Errors (${errors.length}) ──`);
	for (const e of errors.slice(0, 20)) {
		console.log(`  [${e.id}] ${e.check}: ${e.detail}`);
	}
	if (errors.length > 20) console.log(`  ... and ${errors.length - 20} more`);
}

// Print warnings (sample)
if (warnings.length > 0) {
	console.log(`\n── Warnings (${warnings.length}) — showing first 15 ──`);
	for (const w of warnings.slice(0, 15)) {
		console.log(`  [${w.id}] ${w.check}: ${w.detail}`);
	}
	if (warnings.length > 15) console.log(`  ... and ${warnings.length - 15} more`);
}

// ─── Coverage Analysis ───────────────────────────────────────────────
console.log("\n── Coverage ──");

const categoryCounts = new Map<string, number>();
const modelCounts = new Map<string, number>();
const langCounts = new Map<string, number>();

for (const ex of examples) {
	categoryCounts.set(ex.category, (categoryCounts.get(ex.category) || 0) + 1);
	const modelKey = ex.model === "qmd/handcrafted" ? "qmd" : ex.model.split("/").pop()!;
	modelCounts.set(modelKey, (modelCounts.get(modelKey) || 0) + 1);
	langCounts.set(ex.language, (langCounts.get(ex.language) || 0) + 1);
}

console.log("\nBy category:");
for (const [cat, count] of [...categoryCounts.entries()].sort((a, b) => b[1] - a[1])) {
	const pct = ((count / examples.length) * 100).toFixed(1);
	console.log(`  ${cat.padEnd(14)} ${String(count).padStart(5)}  (${pct}%)`);
}

console.log("\nBy model:");
for (const [model, count] of [...modelCounts.entries()].sort((a, b) => b[1] - a[1])) {
	console.log(`  ${model.padEnd(22)} ${String(count).padStart(5)}`);
}

console.log("\nBy language:");
for (const [lang, count] of [...langCounts.entries()].sort((a, b) => b[1] - a[1])) {
	console.log(`  ${lang.padEnd(14)} ${String(count).padStart(5)}`);
}

// ─── Dedup stats ─────────────────────────────────────────────────────
const dupGroups = [...queryMap.entries()].filter(([, ids]) => ids.length > 1);
const totalDups = dupGroups.reduce((sum, [, ids]) => sum + ids.length - 1, 0);
console.log(`\nDuplicates: ${dupGroups.length} query groups with ${totalDups} extra copies`);

// ─── Fix mode ────────────────────────────────────────────────────────
if (doFix) {
	console.log("\n── Cleaning ──");

	const errorIds = new Set(errors.map((e) => e.id));

	// Quality scoring for dedup: pick best response per query
	// Higher score = better quality
	const MODEL_QUALITY: Record<string, number> = {
		"openai/gpt-5.3-codex": 6,
		"anthropic/claude-haiku-4.5": 5,
		"google/gemini-3.1-flash-lite-preview": 4,
		"qmd/handcrafted": 4,
		"qwen/qwen3.5-plus-02-15": 3,
		"z-ai/glm-5": 2,
		"minimax/minimax-m2.5": 1,
	};

	function qualityScore(ex: Example): number {
		let score = MODEL_QUALITY[ex.model] || 3;
		// Penalize short hyde
		if (ex.hyde.trim().length < 20) score -= 3;
		// Penalize markdown fences in hyde
		if (ex.hyde.includes("```")) score -= 2;
		// Bonus for longer, more detailed hyde
		if (ex.hyde.trim().length > 100) score += 1;
		// Penalize lazy vec patterns
		if (ex.vec.trim().split(/\s+/).length < 5) score -= 2;
		return score;
	}

	// Group by normalized query, keep highest-quality response
	const bestPerQuery = new Map<string, Example>();
	for (const ex of examples) {
		if (errorIds.has(ex.id)) continue;
		const key = normalize(ex.seed_query);
		const existing = bestPerQuery.get(key);
		if (!existing || qualityScore(ex) > qualityScore(existing)) {
			bestPerQuery.set(key, ex);
		}
	}

	const clean = [...bestPerQuery.values()];

	writeFileSync(CLEAN_OUTPUT, clean.map((e) => JSON.stringify(e)).join("\n") + "\n");
	const dupsRemoved = examples.length - errorIds.size - clean.length;
	console.log(`Removed: ${errorIds.size} errors, ${dupsRemoved} duplicates (kept best per query)`);
	console.log(`Clean dataset: ${clean.length} examples → ${CLEAN_OUTPUT}`);

	if (doSplit) {
		// Stratified split by category (90/10)
		const byCat = new Map<string, Example[]>();
		for (const ex of clean) {
			const list = byCat.get(ex.category) || [];
			list.push(ex);
			byCat.set(ex.category, list);
		}

		const trainExamples: Example[] = [];
		const evalExamples: Example[] = [];

		for (const [cat, exs] of byCat) {
			// Shuffle deterministically
			const shuffled = exs.sort((a, b) => {
				// Hash-based deterministic shuffle
				const ha = hashCode(a.id);
				const hb = hashCode(b.id);
				return ha - hb;
			});

			const splitIdx = Math.floor(shuffled.length * 0.9);
			trainExamples.push(...shuffled.slice(0, splitIdx));
			evalExamples.push(...shuffled.slice(splitIdx));
		}

		writeFileSync(TRAIN_OUTPUT, trainExamples.map((e) => JSON.stringify(e)).join("\n") + "\n");
		writeFileSync(EVAL_OUTPUT, evalExamples.map((e) => JSON.stringify(e)).join("\n") + "\n");

		console.log(`\nTrain/Eval split (90/10, stratified by category):`);
		console.log(`  Train: ${trainExamples.length} examples → ${TRAIN_OUTPUT}`);
		console.log(`  Eval:  ${evalExamples.length} examples → ${EVAL_OUTPUT}`);

		// Show per-category split
		console.log("\n  Category        Train   Eval");
		for (const [cat, exs] of [...byCat.entries()].sort((a, b) => b[1].length - a[1].length)) {
			const splitIdx = Math.floor(exs.length * 0.9);
			console.log(`  ${cat.padEnd(16)} ${String(splitIdx).padStart(5)}  ${String(exs.length - splitIdx).padStart(5)}`);
		}
	}
}

if (!doFix) {
	console.log("\n── Run with --fix to clean, --fix --split to also split ──");
}

// ─── Summary ─────────────────────────────────────────────────────────
console.log(`\n═══════════════════════════════════════════════════════`);
console.log(`  Total: ${examples.length} | Errors: ${errors.length} | Warnings: ${warnings.length}`);
console.log(`═══════════════════════════════════════════════════════`);

// ─── Helpers ─────────────────────────────────────────────────────────
function hashCode(s: string): number {
	let hash = 0;
	for (let i = 0; i < s.length; i++) {
		hash = (Math.imul(31, hash) + s.charCodeAt(i)) | 0;
	}
	return hash;
}
