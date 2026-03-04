#!/usr/bin/env bun
/**
 * Dataset Generator for Query Expansion Fine-Tuning
 *
 * Uses multiple LLMs via OpenRouter to generate diverse lex/vec/hyde
 * training examples from seed queries. Multi-model generation produces
 * higher-quality data through natural variation.
 *
 * Usage:
 *   bun run finetune/scripts/generate-data.ts [options]
 *
 * Options:
 *   --seeds <path>       Path to seed queries JSONL (default: finetune/seeds/code-queries.jsonl)
 *   --output <path>      Output JSONL path (default: finetune/data/train.jsonl)
 *   --models <list>      Comma-separated model IDs (default: all 7)
 *   --limit <n>          Max seeds to process (default: all)
 *   --concurrency <n>    Parallel requests per model (default: 3)
 *   --dry-run            Show plan without making API calls
 *   --resume             Skip seeds that already have output in the output file
 */

import { existsSync, readFileSync, writeFileSync, appendFileSync } from "fs";
import { join, dirname } from "path";

// ============================================================================
// Types
// ============================================================================

interface SeedQuery {
	id: string;
	query: string;
	language?: string;
	category?: string;
	source?: string;
}

interface GeneratedExample {
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
	/** SFT-ready messages format */
	messages: Array<{ role: string; content: string }>;
}

interface ModelConfig {
	id: string;
	name: string;
	maxTokens: number;
	temperature: number;
}

// ============================================================================
// Constants
// ============================================================================

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

const MODELS: ModelConfig[] = [
	{ id: "minimax/minimax-m2.5", name: "MiniMax-M2.5", maxTokens: 8192, temperature: 0.4 },
	{ id: "moonshotai/kimi-k2.5", name: "Kimi-K2.5", maxTokens: 16384, temperature: 0.4 },
	{ id: "z-ai/glm-5", name: "GLM-5", maxTokens: 8192, temperature: 0.4 },
	{ id: "anthropic/claude-haiku-4.5", name: "Haiku-4.5", maxTokens: 1024, temperature: 0.3 },
	{ id: "google/gemini-3.1-flash-lite-preview", name: "Gemini-Flash-Lite", maxTokens: 1024, temperature: 0.4 },
	{ id: "openai/gpt-5.3-codex", name: "GPT-5.3-Codex", maxTokens: 1024, temperature: 0.3 },
	{ id: "qwen/qwen3.5-plus-02-15", name: "Qwen3.5-Plus", maxTokens: 8192, temperature: 0.4 },
];

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

// ============================================================================
// CLI
// ============================================================================

interface Config {
	seedsPath: string;
	outputPath: string;
	models: ModelConfig[];
	limit: number;
	concurrency: number;
	dryRun: boolean;
	resume: boolean;
}

function parseArgs(): Config {
	const args = process.argv.slice(2);
	let seedsPath = "finetune/seeds/code-queries.jsonl";
	let outputPath = "finetune/data/train.jsonl";
	let selectedModels = [...MODELS];
	let limit = Infinity;
	let concurrency = 3;
	let dryRun = false;
	let resume = false;

	for (let i = 0; i < args.length; i++) {
		switch (args[i]) {
			case "--seeds":
				seedsPath = args[++i];
				break;
			case "--output":
				outputPath = args[++i];
				break;
			case "--models": {
				const ids = args[++i].split(",").map((s) => s.trim());
				selectedModels = ids.map((id) => {
					const found = MODELS.find((m) => m.id === id || m.name.toLowerCase().includes(id.toLowerCase()));
					if (!found) {
						console.error(`Unknown model: ${id}`);
						console.error(`Available: ${MODELS.map((m) => m.id).join(", ")}`);
						process.exit(1);
					}
					return found;
				});
				break;
			}
			case "--limit":
				limit = parseInt(args[++i], 10);
				break;
			case "--concurrency":
				concurrency = parseInt(args[++i], 10);
				break;
			case "--dry-run":
				dryRun = true;
				break;
			case "--resume":
				resume = true;
				break;
			default:
				console.error(`Unknown option: ${args[i]}`);
				process.exit(1);
		}
	}

	return { seedsPath, outputPath, models: selectedModels, limit, concurrency, dryRun, resume };
}

// ============================================================================
// OpenRouter API
// ============================================================================

async function callOpenRouter(
	model: ModelConfig,
	query: string,
	apiKey: string,
): Promise<{ output: string; latencyMs: number }> {
	const TIMEOUT_MS = 90000; // 90s hard timeout
	const start = performance.now();

	const fetchPromise = fetch(OPENROUTER_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
			"HTTP-Referer": "https://github.com/claudemem",
			"X-Title": "claudemem-datagen",
		},
		body: JSON.stringify({
			model: model.id,
			messages: [
				{ role: "system", content: SYSTEM_PROMPT },
				{ role: "user", content: `Query: ${query}` },
			],
			temperature: model.temperature,
			max_tokens: model.maxTokens,
		}),
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});

	// Hard timeout via Promise.race as a safety net
	const timeoutPromise = new Promise<never>((_, reject) =>
		setTimeout(() => reject(new Error(`Hard timeout after ${TIMEOUT_MS}ms`)), TIMEOUT_MS + 5000),
	);

	const response = await Promise.race([fetchPromise, timeoutPromise]);
	const latencyMs = Math.round(performance.now() - start);

	if (!response.ok) {
		const body = await response.text();
		// Rate limit — wait and signal retry
		if (response.status === 429) {
			const retryAfter = response.headers.get("retry-after");
			const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 30000;
			await new Promise((r) => setTimeout(r, waitMs));
			throw new Error(`Rate limited, waited ${waitMs}ms`);
		}
		throw new Error(`API ${response.status}: ${body.slice(0, 200)}`);
	}

	const data = await response.json();
	const output = data.choices?.[0]?.message?.content || "";
	return { output, latencyMs };
}

// ============================================================================
// Parsing & Validation
// ============================================================================

function parseExpansion(raw: string): { lex: string; vec: string; hyde: string } | null {
	// Strip markdown fences and thinking tags
	let cleaned = raw
		.replace(/```[\s\S]*?```/g, (match) => {
			// If the fence contains lex:/vec:/hyde:, extract the content
			const inner = match.replace(/```\w*\n?/g, "").replace(/```/g, "").trim();
			if (inner.includes("lex:") && inner.includes("vec:")) return inner;
			return match;
		})
		.replace(/<think>[\s\S]*?<\/think>/gi, "")
		.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
		.trim();

	// Try to find lex:/vec:/hyde: lines (tolerant of leading whitespace, bullets, dashes)
	const lexMatch = cleaned.match(/^\s*[-*]?\s*lex:\s*(.+)$/m);
	const vecMatch = cleaned.match(/^\s*[-*]?\s*vec:\s*(.+)$/m);
	const hydeMatch = cleaned.match(/^\s*[-*]?\s*hyde:\s*([\s\S]+?)(?=\n\s*[-*]?\s*(?:lex:|vec:)|$)/m);

	if (!lexMatch || !vecMatch || !hydeMatch) return null;

	const lex = lexMatch[1].trim();
	const vec = vecMatch[1].trim();
	const hyde = hydeMatch[1].trim();

	// Basic validation
	if (lex.length < 3 || vec.length < 10 || hyde.length < 10) return null;

	return { lex, vec, hyde };
}

function categorizeQuery(query: string): string {
	const q = query.toLowerCase();
	if (/error|exception|traceback|fail|crash|bug|fix/.test(q)) return "error";
	if (/function|class|method|variable|import|module|component/.test(q)) return "symbol";
	if (/react|express|prisma|next\.?js|zod|docker|jest|tailwind|vue|angular/.test(q)) return "framework";
	if (/unused|dead.?code|duplicate|deprecated|circular|security|performance/.test(q)) return "code-review";
	return "concept";
}

// ============================================================================
// Seed Generation (if no seeds file exists)
// ============================================================================

const CODE_QUERY_SEEDS: SeedQuery[] = [
	// Symbol queries
	{ id: "s001", query: "useEffect cleanup function", category: "symbol", language: "typescript" },
	{ id: "s002", query: "handleSubmit event handler", category: "symbol", language: "typescript" },
	{ id: "s003", query: "database connection pool", category: "symbol", language: "typescript" },
	{ id: "s004", query: "JWT token verification middleware", category: "symbol", language: "typescript" },
	{ id: "s005", query: "file upload multipart handler", category: "symbol", language: "typescript" },
	{ id: "s006", query: "websocket message handler", category: "symbol", language: "typescript" },
	{ id: "s007", query: "cache invalidation strategy", category: "symbol", language: "typescript" },
	{ id: "s008", query: "rate limiter middleware", category: "symbol", language: "typescript" },
	{ id: "s009", query: "pagination helper function", category: "symbol", language: "typescript" },
	{ id: "s010", query: "error boundary component", category: "symbol", language: "typescript" },
	{ id: "s011", query: "useReducer state management", category: "symbol", language: "typescript" },
	{ id: "s012", query: "custom hook for fetch", category: "symbol", language: "typescript" },
	{ id: "s013", query: "redux slice for auth", category: "symbol", language: "typescript" },
	{ id: "s014", query: "graphql resolver function", category: "symbol", language: "typescript" },
	{ id: "s015", query: "middleware chain express", category: "symbol", language: "typescript" },
	{ id: "s016", query: "singleton pattern database", category: "symbol", language: "typescript" },
	{ id: "s017", query: "factory method for services", category: "symbol", language: "typescript" },
	{ id: "s018", query: "observer pattern event emitter", category: "symbol", language: "typescript" },
	{ id: "s019", query: "decorator for logging", category: "symbol", language: "python" },
	{ id: "s020", query: "context manager for file operations", category: "symbol", language: "python" },
	{ id: "s021", query: "async generator for streaming", category: "symbol", language: "python" },
	{ id: "s022", query: "dataclass for configuration", category: "symbol", language: "python" },
	{ id: "s023", query: "abstract base class for repositories", category: "symbol", language: "python" },
	{ id: "s024", query: "property getter setter validation", category: "symbol", language: "python" },
	{ id: "s025", query: "goroutine worker pool", category: "symbol", language: "go" },
	{ id: "s026", query: "channel select pattern", category: "symbol", language: "go" },
	{ id: "s027", query: "interface implementation check", category: "symbol", language: "go" },
	{ id: "s028", query: "struct embedding composition", category: "symbol", language: "go" },
	{ id: "s029", query: "error wrapping sentinel errors", category: "symbol", language: "go" },
	{ id: "s030", query: "trait implementation for serialization", category: "symbol", language: "rust" },

	// Error queries
	{ id: "e001", query: "fix TypeError cannot read property of undefined", category: "error", language: "typescript" },
	{ id: "e002", query: "resolve ECONNREFUSED localhost connection", category: "error", language: "typescript" },
	{ id: "e003", query: "module not found cannot resolve import", category: "error", language: "typescript" },
	{ id: "e004", query: "CORS origin not allowed headers", category: "error", language: "typescript" },
	{ id: "e005", query: "out of memory heap allocation failed", category: "error", language: "typescript" },
	{ id: "e006", query: "database connection timeout pool exhausted", category: "error", language: "typescript" },
	{ id: "e007", query: "promise rejected unhandled async error", category: "error", language: "typescript" },
	{ id: "e008", query: "circular dependency detected import cycle", category: "error", language: "typescript" },
	{ id: "e009", query: "type error argument not assignable", category: "error", language: "typescript" },
	{ id: "e010", query: "permission denied EACCES file access", category: "error", language: "typescript" },
	{ id: "e011", query: "segfault null pointer dereference", category: "error", language: "rust" },
	{ id: "e012", query: "borrow checker lifetime mismatch", category: "error", language: "rust" },
	{ id: "e013", query: "deadlock mutex contention", category: "error", language: "go" },
	{ id: "e014", query: "race condition data race detected", category: "error", language: "go" },
	{ id: "e015", query: "stack overflow infinite recursion", category: "error", language: "python" },
	{ id: "e016", query: "KeyError dictionary missing key", category: "error", language: "python" },
	{ id: "e017", query: "IndentationError unexpected indent", category: "error", language: "python" },
	{ id: "e018", query: "ImportError no module named", category: "error", language: "python" },
	{ id: "e019", query: "SSL certificate verification failed", category: "error", language: "python" },
	{ id: "e020", query: "docker container OOMKilled restart", category: "error", language: "yaml" },

	// Concept queries
	{ id: "c001", query: "authentication middleware pattern", category: "concept", language: "typescript" },
	{ id: "c002", query: "rate limiting implementation", category: "concept", language: "typescript" },
	{ id: "c003", query: "caching strategy invalidation", category: "concept", language: "typescript" },
	{ id: "c004", query: "retry logic exponential backoff", category: "concept", language: "typescript" },
	{ id: "c005", query: "connection pooling database", category: "concept", language: "typescript" },
	{ id: "c006", query: "event driven architecture pub sub", category: "concept", language: "typescript" },
	{ id: "c007", query: "dependency injection service container", category: "concept", language: "typescript" },
	{ id: "c008", query: "pagination cursor offset limit", category: "concept", language: "typescript" },
	{ id: "c009", query: "graceful shutdown signal handling", category: "concept", language: "typescript" },
	{ id: "c010", query: "streaming response server sent events", category: "concept", language: "typescript" },
	{ id: "c011", query: "CQRS command query separation", category: "concept", language: "typescript" },
	{ id: "c012", query: "saga pattern distributed transactions", category: "concept", language: "typescript" },
	{ id: "c013", query: "circuit breaker fault tolerance", category: "concept", language: "typescript" },
	{ id: "c014", query: "blue green deployment zero downtime", category: "concept", language: "yaml" },
	{ id: "c015", query: "feature flag toggle implementation", category: "concept", language: "typescript" },
	{ id: "c016", query: "optimistic locking concurrency control", category: "concept", language: "typescript" },
	{ id: "c017", query: "message queue producer consumer", category: "concept", language: "typescript" },
	{ id: "c018", query: "idempotency key deduplication", category: "concept", language: "typescript" },
	{ id: "c019", query: "health check endpoint readiness probe", category: "concept", language: "typescript" },
	{ id: "c020", query: "structured logging correlation id", category: "concept", language: "typescript" },
	{ id: "c021", query: "tree shaking dead code elimination bundler", category: "concept", language: "typescript" },
	{ id: "c022", query: "lazy loading code splitting dynamic import", category: "concept", language: "typescript" },
	{ id: "c023", query: "virtual scroll infinite list performance", category: "concept", language: "typescript" },
	{ id: "c024", query: "debounce throttle input handler", category: "concept", language: "typescript" },
	{ id: "c025", query: "memoization useMemo useCallback", category: "concept", language: "typescript" },
	{ id: "c026", query: "web worker offload computation", category: "concept", language: "typescript" },
	{ id: "c027", query: "service worker offline caching", category: "concept", language: "typescript" },
	{ id: "c028", query: "CSP content security policy headers", category: "concept", language: "typescript" },
	{ id: "c029", query: "OAuth2 PKCE authorization flow", category: "concept", language: "typescript" },
	{ id: "c030", query: "password hashing bcrypt argon2", category: "concept", language: "typescript" },

	// Framework queries
	{ id: "f001", query: "React context vs Redux state management", category: "framework", language: "typescript" },
	{ id: "f002", query: "Express middleware chain next function", category: "framework", language: "typescript" },
	{ id: "f003", query: "Prisma ORM query findMany where", category: "framework", language: "typescript" },
	{ id: "f004", query: "Next.js server component data fetching", category: "framework", language: "typescript" },
	{ id: "f005", query: "Zod schema validation parse transform", category: "framework", language: "typescript" },
	{ id: "f006", query: "tRPC router procedure mutation", category: "framework", language: "typescript" },
	{ id: "f007", query: "Tailwind responsive breakpoints", category: "framework", language: "typescript" },
	{ id: "f008", query: "Jest mock module spyOn testing", category: "framework", language: "typescript" },
	{ id: "f009", query: "Docker compose multi service networking", category: "framework", language: "yaml" },
	{ id: "f010", query: "GitHub Actions CI workflow matrix", category: "framework", language: "yaml" },
	{ id: "f011", query: "FastAPI dependency injection endpoint", category: "framework", language: "python" },
	{ id: "f012", query: "SQLAlchemy async session query", category: "framework", language: "python" },
	{ id: "f013", query: "Pydantic model validator field", category: "framework", language: "python" },
	{ id: "f014", query: "Celery task queue retry", category: "framework", language: "python" },
	{ id: "f015", query: "pytest fixture parametrize mark", category: "framework", language: "python" },
	{ id: "f016", query: "Django ORM queryset filter annotate", category: "framework", language: "python" },
	{ id: "f017", query: "Flask blueprint route decorator", category: "framework", language: "python" },
	{ id: "f018", query: "gin router middleware group", category: "framework", language: "go" },
	{ id: "f019", query: "GORM model association preload", category: "framework", language: "go" },
	{ id: "f020", query: "cobra CLI command flag binding", category: "framework", language: "go" },
	{ id: "f021", query: "actix web handler extractor", category: "framework", language: "rust" },
	{ id: "f022", query: "tokio async runtime spawn", category: "framework", language: "rust" },
	{ id: "f023", query: "serde serialize deserialize derive", category: "framework", language: "rust" },
	{ id: "f024", query: "Vue composition API ref reactive", category: "framework", language: "typescript" },
	{ id: "f025", query: "Svelte store writable subscribe", category: "framework", language: "typescript" },
	{ id: "f026", query: "Angular dependency injection provider", category: "framework", language: "typescript" },
	{ id: "f027", query: "Kubernetes deployment replica set", category: "framework", language: "yaml" },
	{ id: "f028", query: "Terraform provider resource module", category: "framework", language: "hcl" },
	{ id: "f029", query: "Webpack loader plugin configuration", category: "framework", language: "typescript" },
	{ id: "f030", query: "Vite config plugin alias resolve", category: "framework", language: "typescript" },

	// Code review queries
	{ id: "r001", query: "find unused imports dead code", category: "code-review", language: "typescript" },
	{ id: "r002", query: "detect circular dependencies modules", category: "code-review", language: "typescript" },
	{ id: "r003", query: "dead code detection unreachable", category: "code-review", language: "typescript" },
	{ id: "r004", query: "security vulnerability SQL injection", category: "code-review", language: "typescript" },
	{ id: "r005", query: "code duplication similar functions", category: "code-review", language: "typescript" },
	{ id: "r006", query: "performance bottleneck N+1 query", category: "code-review", language: "typescript" },
	{ id: "r007", query: "missing error handling try catch", category: "code-review", language: "typescript" },
	{ id: "r008", query: "type safety any assertion unsafe cast", category: "code-review", language: "typescript" },
	{ id: "r009", query: "memory leak event listener cleanup", category: "code-review", language: "typescript" },
	{ id: "r010", query: "race condition async concurrent access", category: "code-review", language: "typescript" },
	{ id: "r011", query: "hardcoded secrets credentials in code", category: "code-review", language: "typescript" },
	{ id: "r012", query: "missing input validation sanitization", category: "code-review", language: "typescript" },
	{ id: "r013", query: "unhandled promise rejection async", category: "code-review", language: "typescript" },
	{ id: "r014", query: "inconsistent naming convention style", category: "code-review", language: "typescript" },
	{ id: "r015", query: "excessive function complexity cyclomatic", category: "code-review", language: "typescript" },
	{ id: "r016", query: "missing test coverage critical path", category: "code-review", language: "typescript" },
	{ id: "r017", query: "deprecated API usage migration needed", category: "code-review", language: "typescript" },
	{ id: "r018", query: "unsafe deserialization untrusted data", category: "code-review", language: "python" },
	{ id: "r019", query: "global mutable state thread safety", category: "code-review", language: "python" },
	{ id: "r020", query: "improper resource cleanup context manager", category: "code-review", language: "python" },

	// Additional diverse queries
	{ id: "d001", query: "implement binary search tree", category: "concept", language: "typescript" },
	{ id: "d002", query: "parse JSON stream line by line", category: "concept", language: "typescript" },
	{ id: "d003", query: "recursive directory traversal", category: "concept", language: "typescript" },
	{ id: "d004", query: "URL routing path parameter extraction", category: "concept", language: "typescript" },
	{ id: "d005", query: "environment variable configuration loader", category: "concept", language: "typescript" },
	{ id: "d006", query: "date time timezone conversion utility", category: "concept", language: "typescript" },
	{ id: "d007", query: "regex email validation pattern", category: "concept", language: "typescript" },
	{ id: "d008", query: "CSV parser streaming large files", category: "concept", language: "typescript" },
	{ id: "d009", query: "image resize thumbnail generation", category: "concept", language: "python" },
	{ id: "d010", query: "PDF text extraction parsing", category: "concept", language: "python" },
	{ id: "d011", query: "cron job scheduler periodic task", category: "concept", language: "typescript" },
	{ id: "d012", query: "email sending SMTP template", category: "concept", language: "typescript" },
	{ id: "d013", query: "webhook receiver signature verification", category: "concept", language: "typescript" },
	{ id: "d014", query: "API versioning header path strategy", category: "concept", language: "typescript" },
	{ id: "d015", query: "database migration schema versioning", category: "concept", language: "typescript" },
	{ id: "d016", query: "search autocomplete trie implementation", category: "concept", language: "typescript" },
	{ id: "d017", query: "bloom filter probabilistic membership", category: "concept", language: "go" },
	{ id: "d018", query: "consistent hashing ring distribution", category: "concept", language: "go" },
	{ id: "d019", query: "protobuf gRPC service definition", category: "concept", language: "go" },
	{ id: "d020", query: "OpenTelemetry tracing span context", category: "concept", language: "typescript" },
];

function ensureSeedsFile(path: string): void {
	if (existsSync(path)) return;

	const dir = dirname(path);
	const { mkdirSync } = require("fs");
	mkdirSync(dir, { recursive: true });

	const lines = CODE_QUERY_SEEDS.map((s) => JSON.stringify(s)).join("\n") + "\n";
	writeFileSync(path, lines);
	console.log(`Generated ${CODE_QUERY_SEEDS.length} seed queries → ${path}`);
}

// ============================================================================
// Main Pipeline
// ============================================================================

interface Stats {
	total: number;
	success: number;
	parseFail: number;
	apiError: number;
	byModel: Map<string, { success: number; fail: number; totalMs: number }>;
	byCategory: Map<string, number>;
}

async function processQuery(
	seed: SeedQuery,
	model: ModelConfig,
	apiKey: string,
	stats: Stats,
): Promise<GeneratedExample | null> {
	try {
		const { output, latencyMs } = await callOpenRouter(model, seed.query, apiKey);

		const parsed = parseExpansion(output);
		if (!parsed) {
			stats.parseFail++;
			const modelStats = stats.byModel.get(model.id)!;
			modelStats.fail++;
			console.log(`  ✗ [${model.name}] "${seed.query.slice(0, 35)}..." → parse failed`);
			return null;
		}

		stats.success++;
		const modelStats = stats.byModel.get(model.id)!;
		modelStats.success++;
		modelStats.totalMs += latencyMs;

		const category = seed.category || categorizeQuery(seed.query);
		stats.byCategory.set(category, (stats.byCategory.get(category) || 0) + 1);

		const assistantContent = `lex: ${parsed.lex}\nvec: ${parsed.vec}\nhyde: ${parsed.hyde}`;

		return {
			id: `${seed.id}-${model.name.toLowerCase().replace(/[^a-z0-9]/g, "")}`,
			seed_query: seed.query,
			model: model.id,
			language: seed.language || "typescript",
			category,
			lex: parsed.lex,
			vec: parsed.vec,
			hyde: parsed.hyde,
			raw_output: output,
			latency_ms: latencyMs,
			timestamp: new Date().toISOString(),
			messages: [
				{ role: "system", content: SYSTEM_PROMPT },
				{ role: "user", content: `Query: ${seed.query}` },
				{ role: "assistant", content: assistantContent },
			],
		};
	} catch (error) {
		stats.apiError++;
		const modelStats = stats.byModel.get(model.id)!;
		modelStats.fail++;
		const msg = error instanceof Error ? error.message : String(error);
		console.log(`  ✗ [${model.name}] "${seed.query.slice(0, 35)}..." → ${msg.slice(0, 60)}`);
		return null;
	}
}

async function runBatch(
	seeds: SeedQuery[],
	model: ModelConfig,
	apiKey: string,
	concurrency: number,
	stats: Stats,
	outputPath: string,
): Promise<number> {
	let written = 0;
	const batches: SeedQuery[][] = [];

	// Split into batches of `concurrency`
	for (let i = 0; i < seeds.length; i += concurrency) {
		batches.push(seeds.slice(i, i + concurrency));
	}

	for (let bi = 0; bi < batches.length; bi++) {
		const batch = batches[bi];
		try {
			const results = await Promise.all(
				batch.map((seed) => processQuery(seed, model, apiKey, stats)),
			);

			for (const result of results) {
				if (result) {
					appendFileSync(outputPath, JSON.stringify(result) + "\n");
					written++;
				}
			}
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			console.log(`  ✗ Batch ${bi + 1}/${batches.length} crashed: ${msg.slice(0, 80)}`);
			// Continue with next batch instead of crashing
		}

		// Delay between batches to avoid rate limiting
		if (bi < batches.length - 1) {
			await new Promise((r) => setTimeout(r, 1000));
		}
	}

	return written;
}

async function main() {
	const config = parseArgs();
	const apiKey = process.env.OPENROUTER_API_KEY;

	if (!apiKey) {
		console.error("OPENROUTER_API_KEY environment variable required");
		process.exit(1);
	}

	// Ensure seeds exist
	ensureSeedsFile(config.seedsPath);

	// Load seeds
	const seedLines = readFileSync(config.seedsPath, "utf-8")
		.split("\n")
		.filter((l) => l.trim());
	let seeds: SeedQuery[] = seedLines.map((l) => JSON.parse(l));

	if (config.limit < seeds.length) {
		seeds = seeds.slice(0, config.limit);
	}

	// Load existing output for resume
	const existingIds = new Set<string>();
	if (config.resume && existsSync(config.outputPath)) {
		const existingLines = readFileSync(config.outputPath, "utf-8")
			.split("\n")
			.filter((l) => l.trim());
		for (const line of existingLines) {
			try {
				const obj = JSON.parse(line);
				existingIds.add(obj.id);
			} catch {}
		}
		console.log(`Resume: ${existingIds.size} existing examples found`);
	}

	const totalExamples = seeds.length * config.models.length;

	console.log(`Dataset Generator`);
	console.log(`=================`);
	console.log(`Seeds:       ${seeds.length}`);
	console.log(`Models:      ${config.models.length} (${config.models.map((m) => m.name).join(", ")})`);
	console.log(`Concurrency: ${config.concurrency} per model`);
	console.log(`Total:       ${totalExamples} examples (${seeds.length} seeds × ${config.models.length} models)`);
	console.log(`Output:      ${config.outputPath}`);

	if (config.dryRun) {
		console.log(`\n[DRY RUN] Would generate ${totalExamples} examples`);
		console.log(`\nCategory distribution of seeds:`);
		const catCounts = new Map<string, number>();
		for (const s of seeds) {
			const cat = s.category || categorizeQuery(s.query);
			catCounts.set(cat, (catCounts.get(cat) || 0) + 1);
		}
		for (const [cat, count] of [...catCounts.entries()].sort()) {
			console.log(`  ${cat}: ${count} (×${config.models.length} models = ${count * config.models.length})`);
		}
		return;
	}

	// Initialize stats
	const stats: Stats = {
		total: totalExamples,
		success: 0,
		parseFail: 0,
		apiError: 0,
		byModel: new Map(),
		byCategory: new Map(),
	};
	for (const model of config.models) {
		stats.byModel.set(model.id, { success: 0, fail: 0, totalMs: 0 });
	}

	// Initialize output file if not resuming
	if (!config.resume || !existsSync(config.outputPath)) {
		writeFileSync(config.outputPath, "");
	}

	const startTime = Date.now();

	// Process each model sequentially (models are independent, queries within a model run with concurrency)
	for (let mi = 0; mi < config.models.length; mi++) {
		const model = config.models[mi];
		console.log(`\n${"=".repeat(60)}`);
		console.log(`[${mi + 1}/${config.models.length}] ${model.name} (${model.id})`);
		console.log(`${"=".repeat(60)}`);

		// Filter seeds for resume
		const pendingSeeds = seeds.filter((s) => {
			const exampleId = `${s.id}-${model.name.toLowerCase().replace(/[^a-z0-9]/g, "")}`;
			return !existingIds.has(exampleId);
		});

		if (pendingSeeds.length === 0) {
			console.log(`  All ${seeds.length} seeds already processed, skipping`);
			continue;
		}

		if (pendingSeeds.length < seeds.length) {
			console.log(`  ${seeds.length - pendingSeeds.length} already done, processing ${pendingSeeds.length} remaining`);
		}

		const written = await runBatch(pendingSeeds, model, apiKey, config.concurrency, stats, config.outputPath);
		const modelStats = stats.byModel.get(model.id)!;
		const avgMs = modelStats.success > 0 ? Math.round(modelStats.totalMs / modelStats.success) : 0;

		console.log(`  → ${written} examples written (${modelStats.success} ok, ${modelStats.fail} failed, avg ${avgMs}ms)`);
	}

	const totalTime = Math.round((Date.now() - startTime) / 1000);

	// Summary
	console.log(`\n${"=".repeat(60)}`);
	console.log(`Generation Complete (${totalTime}s)`);
	console.log(`${"=".repeat(60)}`);
	console.log(`\nSuccess: ${stats.success}/${stats.total} (${((stats.success / stats.total) * 100).toFixed(1)}%)`);
	console.log(`Parse failures: ${stats.parseFail}`);
	console.log(`API errors: ${stats.apiError}`);

	console.log(`\nPer-model breakdown:`);
	for (const model of config.models) {
		const ms = stats.byModel.get(model.id)!;
		const avgMs = ms.success > 0 ? Math.round(ms.totalMs / ms.success) : 0;
		const rate = ((ms.success / (ms.success + ms.fail)) * 100).toFixed(0);
		console.log(`  ${model.name.padEnd(20)} ${ms.success}/${ms.success + ms.fail} (${rate}%) avg=${avgMs}ms`);
	}

	console.log(`\nPer-category breakdown:`);
	for (const [cat, count] of [...stats.byCategory.entries()].sort()) {
		console.log(`  ${cat.padEnd(15)} ${count}`);
	}

	console.log(`\nOutput: ${config.outputPath}`);

	// Count total lines in output
	const finalLines = readFileSync(config.outputPath, "utf-8").split("\n").filter((l) => l.trim()).length;
	console.log(`Total examples in file: ${finalLines}`);
}

main().catch((error) => {
	console.error("Fatal error:", error);
	process.exit(1);
});
