/**
 * Black-box harness for the step-3 test plan
 * (ai-docs/sessions/dev-feature-step3-ranking-overlay-20261001-115855-a33fe887/tests/test-plan.md).
 *
 * Everything here drives the BUILT `dist/index.js` (CLI or `--mcp` over stdio)
 * against real git repositories in a temp sandbox. Nothing under `src/` is
 * imported or read. The only test helpers used are the two safety helpers the
 * plan names: `keychainSafeChildEnv()` and `isInside()`.
 *
 * Safety (CLAUDE.md #24, #31):
 *  - every child env is built by `keychainSafeChildEnv()` and carries a
 *    sandboxed HOME, MNEMEX_EMBED_CACHE_PATH and MNEMEX_GLOBAL_LOCK_PATH;
 *  - a decoy `security` binary is first on PATH so a relatively-resolved
 *    keychain spawn would leave a marker file (asserted absent per test);
 *  - fixture git runs with GIT_CONFIG_GLOBAL=/dev/null and commit.gpgsign=false
 *    (these are throwaway temp repos, never project commits);
 *  - embeddings come from an in-process fake Ollama `/api/embed` server that
 *    journals every text it receives. Counts are asserted on that journal (the
 *    wire), never on the binary's own report alone.
 *
 * Children are spawned ASYNCHRONOUSLY: the fake server lives in this process,
 * and a synchronous spawn would block the event loop that answers it.
 */

import { expect } from "bun:test";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import {
	EMBED_CACHE_CHILD_GUARD_ENV,
	KEYCHAIN_CHILD_GUARD_ENV,
	keychainSafeChildEnv,
} from "../../helpers/child-env";
import { isInside } from "../../helpers/sandbox-guard";

export const WORKTREE_ROOT = resolve(import.meta.dir, "../../..");
/**
 * The binary under test. `S3BB_DIST` (absolute path) points the suite at another
 * build — used only to show a regression test RED against a pre-fix binary.
 */
export const DIST =
	process.env.S3BB_DIST ?? join(WORKTREE_ROOT, "dist", "index.js");

// ─── Fake embedding server ───────────────────────────────────────────────

export const DIM = 256;
export const PROBE_TEXT = "test";

const STOPWORDS = new Set([
	"export",
	"function",
	"return",
	"const",
	"let",
	"var",
	"number",
	"string",
	"boolean",
	"void",
	"if",
	"else",
	"for",
	"of",
	"in",
	"import",
	"from",
	"new",
	"the",
	"undefined",
	"null",
	"true",
	"false",
	"record",
	"object",
	"keys",
	"length",
]);

/** camelCase / snake_case / prose → lower-case word tokens, stopwords removed. */
export function tokens(text: string): string[] {
	const out: string[] = [];
	for (const word of text.match(/[A-Za-z]+/g) ?? []) {
		for (const part of word.split(
			/(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/,
		)) {
			const t = part.toLowerCase();
			if (t.length >= 2 && !STOPWORDS.has(t)) out.push(t);
		}
	}
	return out;
}

function fnv1a(s: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h >>> 0;
}

/** Deterministic bag-of-tokens vector: lexical overlap == cosine similarity. */
export function fakeVector(text: string): number[] {
	const v = new Array<number>(DIM).fill(0);
	for (const t of tokens(text)) v[fnv1a(t) % DIM] += 1;
	let norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
	if (norm === 0) {
		v.fill(1);
		norm = Math.sqrt(DIM);
	}
	return v.map((x) => x / norm);
}

export type EmbedMode =
	| { kind: "ok" }
	/** Serve the dimension probe and these exact texts; HTTP 500 for every other text. */
	| { kind: "refuse-after-query"; allow: string[] }
	/** HTTP 500 for any request containing a text that includes `token`. */
	| { kind: "refuse-matching"; token: string };

export interface JournalEntry {
	t: number;
	path: string;
	model: string;
	inputs: string[];
	status: number;
}

export class FakeEmbedder {
	journal: JournalEntry[] = [];
	mode: EmbedMode = { kind: "ok" };
	latencyMs = 0;
	private server: ReturnType<typeof Bun.serve> | null;

	private constructor() {
		this.server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: (req) => this.handle(req),
		});
	}

	static start(): FakeEmbedder {
		return new FakeEmbedder();
	}

	get url(): string {
		if (!this.server) throw new Error("fake embedder is stopped");
		return `http://127.0.0.1:${this.server.port}`;
	}

	get port(): number {
		if (!this.server) throw new Error("fake embedder is stopped");
		return this.server.port as number;
	}

	reset(): void {
		this.journal = [];
	}

	stop(): void {
		this.server?.stop(true);
		this.server = null;
	}

	private refuses(inputs: string[]): boolean {
		const m = this.mode;
		if (m.kind === "ok") return false;
		if (m.kind === "refuse-after-query") {
			return inputs.some((t) => t !== PROBE_TEXT && !m.allow.includes(t));
		}
		return inputs.some((t) => t.includes(m.token));
	}

	private async handle(req: Request): Promise<Response> {
		const url = new URL(req.url);
		if (req.method === "GET") {
			if (url.pathname === "/api/tags") {
				return Response.json({
					models: [
						{
							name: "nomic-embed-text:latest",
							model: "nomic-embed-text:latest",
						},
					],
				});
			}
			return Response.json({});
		}
		let body: { model?: string; input?: unknown; prompt?: unknown } = {};
		try {
			body = (await req.json()) as typeof body;
		} catch {
			return Response.json({ error: "bad json" }, { status: 400 });
		}
		if (url.pathname !== "/api/embed" && url.pathname !== "/api/embeddings") {
			return Response.json({});
		}
		const raw = body.input ?? body.prompt;
		const inputs = (Array.isArray(raw) ? raw : [raw]).map((x) => String(x));
		if (this.latencyMs > 0) await Bun.sleep(this.latencyMs);
		const refused = this.refuses(inputs);
		this.journal.push({
			t: Date.now(),
			path: url.pathname,
			model: String(body.model ?? ""),
			inputs,
			status: refused ? 500 : 200,
		});
		if (refused) {
			return Response.json(
				{ error: "fake embedder: refused by test" },
				{ status: 500 },
			);
		}
		if (url.pathname === "/api/embeddings") {
			return Response.json({ embedding: fakeVector(inputs[0] ?? "") });
		}
		return Response.json({
			model: body.model,
			embeddings: inputs.map((t) => fakeVector(t)),
		});
	}
}

/** Every text sent to the provider except the per-process probe and the given queries. */
export function overlayTexts(
	journal: JournalEntry[],
	...queries: string[]
): string[] {
	const out: string[] = [];
	for (const e of journal) {
		for (const t of e.inputs) {
			if (t === PROBE_TEXT || queries.includes(t)) continue;
			out.push(t);
		}
	}
	return out;
}

export function allTexts(journal: JournalEntry[]): string[] {
	return journal.flatMap((e) => e.inputs);
}

// ─── Sandbox ─────────────────────────────────────────────────────────────

export interface Sandbox {
	root: string;
	home: string;
	repos: string;
	embedCache: string;
	globalLock: string;
	bin: string;
	securityMarker: string;
	embedder: FakeEmbedder;
	cleanup(): void;
}

export function createSandbox(): Sandbox {
	const tmp = realpathSync(tmpdir());
	const root = realpathSync(mkdtempSync(join(tmp, "mnemex-s3bb-")));
	if (!isInside(root, tmp))
		throw new Error(`sandbox ${root} is not inside ${tmp}`);
	const home = join(root, "home");
	const repos = join(root, "repos");
	const bin = join(root, "bin");
	mkdirSync(join(home, ".mnemex"), { recursive: true });
	mkdirSync(repos, { recursive: true });
	mkdirSync(bin, { recursive: true });
	const securityMarker = join(root, "security-decoy-invoked.txt");
	const decoy = join(bin, "security");
	writeFileSync(
		decoy,
		`#!/bin/sh\necho "$@" >> '${securityMarker}'\nexit 44\n`,
	);
	chmodSync(decoy, 0o755);
	const embedder = FakeEmbedder.start();
	const sb: Sandbox = {
		root,
		home,
		repos,
		embedCache: join(root, "embed-cache.db"),
		globalLock: join(root, "global.lock"),
		bin,
		securityMarker,
		embedder,
		cleanup() {
			embedder.stop();
			rmSync(root, { recursive: true, force: true });
		},
	};
	writeGlobalConfig(sb, {});
	return sb;
}

/** Writes `<sandbox HOME>/.mnemex/config.json` directly (no mnemex save path). */
export function writeGlobalConfig(
	sb: Sandbox,
	extra: Record<string, unknown>,
): void {
	const cfg = {
		embeddingProvider: "ollama",
		ollamaEndpoint: sb.embedder.url,
		defaultModel: "nomic-embed-text",
		excludePatterns: [],
		docs: { enabled: false },
		keychain: false,
		...extra,
	};
	if (!isInside(sb.home, sb.root))
		throw new Error("refusing to write a config outside the sandbox");
	writeFileSync(
		join(sb.home, ".mnemex", "config.json"),
		`${JSON.stringify(cfg, null, 2)}\n`,
	);
}

/** Asserts a decoy `security` was never run in this sandbox (CLAUDE.md #24). */
export function assertNoSecuritySpawn(sb: Sandbox): void {
	expect(existsSync(sb.securityMarker)).toBe(false);
}

/**
 * Inherited variables that would make a child non-hermetic: provider keys and
 * endpoints, git redirection, and the agent-session markers (AI_AGENT,
 * CLAUDECODE, CLAUDE_*) that switch mnemex to agent output when the suite
 * itself runs inside an AI agent.
 */
const STRIP_ENV =
	/^(MNEMEX_|CLAUDEMEM_|GIT_|OLLAMA_|OPENROUTER_|VOYAGE_|ANTHROPIC_|CONTEXT7_|LMSTUDIO_|CLAUDE_|CLAUDECODE$|AI_AGENT$|TERM_THEME$)/;

/** The sandbox variables every child carries (fed to keychainSafeChildEnv at each spawn site). */
export function sandboxVars(sb: Sandbox): Record<string, string> {
	return {
		HOME: sb.home,
		MNEMEX_TEST_SANDBOX_HOME: sb.home,
		MNEMEX_EMBED_CACHE_PATH: sb.embedCache,
		MNEMEX_GLOBAL_LOCK_PATH: sb.globalLock,
		MNEMEX_DOCS_ENABLED: "false",
	};
}

/**
 * Post-processes a `keychainSafeChildEnv(...)` result: drops inherited
 * non-hermetic variables, puts the decoy `security` first on PATH, applies the
 * scenario's `extra`, and re-asserts the guards and the sandbox paths.
 */
export function hermetic(
	sb: Sandbox,
	env: Record<string, string>,
	extra: Record<string, string> = {},
): Record<string, string> {
	const keep = new Set([
		...Object.keys(KEYCHAIN_CHILD_GUARD_ENV),
		...Object.keys(EMBED_CACHE_CHILD_GUARD_ENV),
		...Object.keys(sandboxVars(sb)),
	]);
	for (const key of Object.keys(env)) {
		if (STRIP_ENV.test(key) && !keep.has(key)) delete env[key];
	}
	env.PATH = `${sb.bin}:${env.PATH ?? "/usr/bin:/bin"}`;
	Object.assign(env, extra);
	for (const [k, v] of Object.entries({
		...KEYCHAIN_CHILD_GUARD_ENV,
		...EMBED_CACHE_CHILD_GUARD_ENV,
	})) {
		if (env[k] !== v) throw new Error(`child env lost guard ${k}`);
	}
	if (
		!isInside(env.HOME ?? "/", sb.root) ||
		!isInside(env.MNEMEX_EMBED_CACHE_PATH ?? "/", sb.root)
	) {
		throw new Error("child env HOME / embed cache escaped the sandbox");
	}
	return env;
}

// ─── Running the built binary ────────────────────────────────────────────

export interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
	ms: number;
}

export interface RunOptions {
	cwd?: string;
	env?: Record<string, string>;
	timeoutMs?: number;
}

export function startMnemex(
	sb: Sandbox,
	args: string[],
	opts: RunOptions = {},
): { done: Promise<RunResult>; startedAt: number } {
	const startedAt = performance.now();
	const proc = Bun.spawn({
		cmd: [process.execPath, "--env-file=/dev/null", DIST, ...args],
		cwd: opts.cwd ?? sb.root,
		env: hermetic(sb, keychainSafeChildEnv(sandboxVars(sb)), opts.env),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const timer = setTimeout(
		() => proc.kill("SIGKILL"),
		opts.timeoutMs ?? 90_000,
	);
	const done = (async () => {
		const [stdout, stderr] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		const code = await proc.exited;
		clearTimeout(timer);
		return { code, stdout, stderr, ms: performance.now() - startedAt };
	})();
	return { done, startedAt };
}

/**
 * Runs the binary on a pseudo-terminal (`script(1)`), for the HUMAN output
 * surface: observed, a piped stdout or NO_COLOR switches mnemex to agent output.
 */
export async function runMnemexTty(
	sb: Sandbox,
	args: string[],
	opts: RunOptions = {},
): Promise<RunResult> {
	if (process.platform !== "darwin")
		throw new Error("runMnemexTty: macOS script(1) only");
	const startedAt = performance.now();
	const proc = Bun.spawn({
		// script(1) gives the child a pty; `env` makes the child set the guard
		// variables ITSELF as well as inheriting them (CLAUDE.md #24).
		cmd: [
			"script",
			"-q",
			"/dev/null",
			"/usr/bin/env",
			"MNEMEX_KEYCHAIN_TEST_GUARD=1",
			"MNEMEX_DISABLE_KEYCHAIN=1",
			"MNEMEX_EMBED_CACHE_TEST_GUARD=1",
			process.execPath,
			"--env-file=/dev/null",
			DIST,
			...args,
		],
		cwd: opts.cwd ?? sb.root,
		env: hermetic(sb, keychainSafeChildEnv(sandboxVars(sb)), {
			TERM: "xterm-256color",
			...(opts.env ?? {}),
		}),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const timer = setTimeout(
		() => proc.kill("SIGKILL"),
		opts.timeoutMs ?? 90_000,
	);
	const [stdout, stderr] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	const code = await proc.exited;
	clearTimeout(timer);
	return { code, stdout, stderr, ms: performance.now() - startedAt };
}

export async function runMnemex(
	sb: Sandbox,
	args: string[],
	opts: RunOptions = {},
): Promise<RunResult> {
	return startMnemex(sb, args, opts).done;
}

export async function indexRepo(
	sb: Sandbox,
	path: string,
	extra: string[] = [],
	opts: RunOptions = {},
): Promise<{ res: RunResult; header: Map<string, string> }> {
	const res = await runMnemex(
		sb,
		["--agent", "index", path, "--no-llm", ...extra],
		{
			cwd: path,
			timeoutMs: 180_000,
			...opts,
		},
	);
	if (res.code !== 0) {
		throw new Error(`index failed (${res.code})\n${res.stdout}\n${res.stderr}`);
	}
	return { res, header: parseAgent(res.stdout).header };
}

// ─── `--agent search` output ─────────────────────────────────────────────

export const OVERLAY_KEYS = [
	"overlay",
	"overlay_reason",
	"overlay_files",
	"overlay_files_index_current",
	"overlay_files_deleted",
	"overlay_files_pending",
	"overlay_files_failed",
	"overlay_files_unclassified",
	"overlay_rebuilt",
	"overlay_embedded",
	"overlay_cache_hits",
	"overlay_suppressed_rows",
	"overlay_rebuild_ms",
	"overlay_gaps",
] as const;
export const PENALTY_KEYS = [
	"penalty_lookups",
	"penalty_same_file",
	"penalty_applied",
] as const;

const ROW_KEYS = [
	"file",
	"line",
	"end_line",
	"score",
	"type",
	"name",
	"branches",
	"source",
	"penalty",
	"summary",
];

export interface Row {
	raw: string;
	order: string[];
	fields: Map<string, string>;
	file: string;
	line: number;
	endLine: number;
	type: string;
	name: string;
	source?: string;
	penalty?: string;
	dirty: boolean;
	dead: boolean;
	span: string;
}

export interface AgentOutput {
	header: Map<string, string>;
	headerCounts: Map<string, number>;
	rows: Row[];
	lines: string[];
}

export function parseRow(line: string): Row {
	const body = line.slice("result ".length);
	const re = new RegExp(`(?:^| )(${ROW_KEYS.join("|")})=`, "g");
	const marks: { key: string; start: number; valueStart: number }[] = [];
	let m: RegExpExecArray | null = re.exec(body);
	while (m !== null) {
		const key = m[1] as string;
		if (marks.some((x) => x.key === "summary")) break; // summary is last; its text is opaque
		marks.push({ key, start: m.index, valueStart: m.index + m[0].length });
		m = re.exec(body);
	}
	const fields = new Map<string, string>();
	const order: string[] = [];
	for (let i = 0; i < marks.length; i++) {
		const cur = marks[i] as (typeof marks)[number];
		const end =
			i + 1 < marks.length
				? (marks[i + 1] as (typeof marks)[number]).start
				: body.length;
		fields.set(cur.key, body.slice(cur.valueStart, end));
		order.push(cur.key);
	}
	if (!fields.has("file") || !fields.has("line") || !fields.has("end_line")) {
		throw new Error(`unparseable result row: ${line}`);
	}
	const file = fields.get("file") as string;
	const lineNo = Number(fields.get("line"));
	const endLine = Number(fields.get("end_line"));
	return {
		raw: line,
		order,
		fields,
		file,
		line: lineNo,
		endLine,
		type: fields.get("type") ?? "",
		name: fields.get("name") ?? "",
		source: fields.get("source"),
		penalty: fields.get("penalty"),
		dirty: fields.get("source") === "dirty",
		dead: fields.get("penalty") === "dead",
		span: `${file}\0${lineNo}\0${endLine}`,
	};
}

export function parseAgent(stdout: string): AgentOutput {
	const header = new Map<string, string>();
	const headerCounts = new Map<string, number>();
	const rows: Row[] = [];
	const lines = stdout.split("\n");
	for (const line of lines) {
		if (line.startsWith("result ")) {
			rows.push(parseRow(line));
			continue;
		}
		const kv = /^([a-z_]+)=(.*)$/.exec(line);
		if (kv) {
			const k = kv[1] as string;
			header.set(k, kv[2] as string);
			headerCounts.set(k, (headerCounts.get(k) ?? 0) + 1);
		}
	}
	return { header, headerCounts, rows, lines };
}

export function num(out: AgentOutput, key: string): number {
	const v = out.header.get(key);
	if (v === undefined) throw new Error(`header key ${key} missing`);
	const n = Number(v);
	if (!Number.isFinite(n))
		throw new Error(`header key ${key}=${v} is not a number`);
	return n;
}

/**
 * TEST-28 + TEST-03 invariants, asserted on EVERY successful `--agent search`:
 * all 14 overlay keys and 3 penalty keys exactly once; `penalty_applied ≤
 * penalty_same_file`; displayed `penalty=dead` rows ≤ `penalty_applied`;
 * `source=`/`penalty=` after `name=` and before `summary=`.
 */
export function assertSearchContract(out: AgentOutput): void {
	for (const k of [...OVERLAY_KEYS, ...PENALTY_KEYS]) {
		expect({ key: k, count: out.headerCounts.get(k) ?? 0 }).toEqual({
			key: k,
			count: 1,
		});
	}
	const applied = num(out, "penalty_applied");
	const sameFile = num(out, "penalty_same_file");
	expect(applied).toBeLessThanOrEqual(sameFile);
	expect(out.rows.filter((r) => r.dead).length).toBeLessThanOrEqual(applied);
	expect(["on", "off", "skipped"]).toContain(
		out.header.get("overlay") as string,
	);
	for (const r of out.rows) {
		const nameAt = r.order.indexOf("name");
		const summaryAt = r.order.indexOf("summary");
		for (const k of ["source", "penalty"]) {
			const at = r.order.indexOf(k);
			if (at === -1) continue;
			expect(at).toBeGreaterThan(nameAt);
			if (summaryAt !== -1) expect(at).toBeLessThan(summaryAt);
		}
		if (r.dirty) expect(r.dead).toBe(false); // R3.8: no graph, no penalty
	}
}

export interface SearchRun {
	res: RunResult;
	out: AgentOutput;
	journal: JournalEntry[];
	overlayTexts: string[];
}

export interface SearchOptions extends RunOptions {
	limit?: number;
	flags?: string[];
	/** Do not assert the contract (for runs expected to fail). */
	raw?: boolean;
}

/** `--agent search <q> -p <repo> --no-reindex --limit N [flags]`; journal reset first. */
export async function search(
	sb: Sandbox,
	repo: string,
	query: string,
	opts: SearchOptions = {},
): Promise<SearchRun> {
	sb.embedder.reset();
	const args = [
		"--agent",
		"search",
		query,
		"-p",
		repo,
		"--no-reindex",
		"--limit",
		String(opts.limit ?? 10),
	];
	const res = await runMnemex(sb, [...args, ...(opts.flags ?? [])], {
		cwd: repo,
		...opts,
	});
	const journal = [...sb.embedder.journal];
	const out = parseAgent(res.stdout);
	if (!opts.raw) {
		if (res.code !== 0)
			throw new Error(
				`search exited ${res.code}\n${res.stdout}\n${res.stderr}`,
			);
		assertSearchContract(out);
	}
	return { res, out, journal, overlayTexts: overlayTexts(journal, query) };
}

export function duplicateSpans(rows: Row[]): number {
	return rows.length - new Set(rows.map((r) => r.span)).size;
}

/** Rows of `file` (absolute) whose span covers line `at`. */
export function rowsCovering(rows: Row[], file: string, at: number): Row[] {
	return rows.filter((r) => r.file === file && r.line <= at && at <= r.endLine);
}

export function rankOf(rows: Row[], pred: (r: Row) => boolean): number {
	const i = rows.findIndex(pred);
	return i === -1 ? Number.POSITIVE_INFINITY : i + 1;
}

/** Result lines only, for byte comparisons between two runs. */
export function resultLines(out: AgentOutput): string[] {
	return out.rows.map((r) => r.raw);
}

// ─── Git and fixtures ────────────────────────────────────────────────────

export function git(sb: Sandbox, cwd: string, ...args: string[]): string {
	const res = Bun.spawnSync({
		cmd: [
			"git",
			"-c",
			"user.name=s3bb",
			"-c",
			"user.email=s3bb@example.invalid",
			"-c",
			"commit.gpgsign=false",
			"-c",
			"tag.gpgsign=false",
			"-c",
			"init.defaultBranch=main",
			...args,
		],
		cwd,
		env: {
			PATH: process.env.PATH ?? "/usr/bin:/bin",
			HOME: sb.home,
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_NOSYSTEM: "1",
			LANG: "C.UTF-8",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	if (res.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${res.stderr.toString()}`);
	}
	return res.stdout.toString();
}

export function writeFiles(root: string, files: Record<string, string>): void {
	for (const [rel, content] of Object.entries(files)) {
		const p = join(root, rel);
		mkdirSync(dirname(p), { recursive: true });
		writeFileSync(p, content);
	}
}

/** `git init` + `.gitignore` (`.mnemex/`, `mnemex.json` + extra) + files + one commit. Returns the realpath. */
export function makeRepo(
	sb: Sandbox,
	name: string,
	files: Record<string, string>,
	opts: { ignore?: string[]; noGit?: boolean } = {},
): string {
	const dir = join(sb.repos, name);
	mkdirSync(dir, { recursive: true });
	const path = realpathSync(dir);
	if (opts.noGit) {
		writeFiles(path, files);
		return path;
	}
	git(sb, path, "init", "-q");
	writeFiles(path, {
		".gitignore": `${[".mnemex/", "mnemex.json", ...(opts.ignore ?? [])].join("\n")}\n`,
		...files,
	});
	git(sb, path, "add", "-A");
	git(sb, path, "commit", "-q", "-m", "init");
	return path;
}

export function commitAll(sb: Sandbox, repo: string, msg = "change"): void {
	git(sb, repo, "add", "-A");
	git(sb, repo, "commit", "-q", "-m", msg);
}

export function porcelain(sb: Sandbox, repo: string): string {
	return git(sb, repo, "status", "--porcelain");
}

/** Line (1-based) of the first line in `file` containing `needle`. */
export function lineOf(file: string, needle: string): number {
	const lines = readFileSync(file, "utf8").split("\n");
	const i = lines.findIndex((l) => l.includes(needle));
	if (i === -1) throw new Error(`${needle} not in ${file}`);
	return i + 1;
}

export function fn(
	name: string,
	body: string,
	opts: { exported?: boolean; params?: string } = {},
): string {
	const exp = opts.exported === false ? "" : "export ";
	return `${exp}function ${name}(${opts.params ?? "value: number"}): number {\n${body
		.split("\n")
		.map((l) => `  ${l}`)
		.join("\n")}\n}\n`;
}

/** F-small (plan H-11). */
export function fSmall(): Record<string, string> {
	return {
		"src/billing.ts": [
			"export function legacyRefundPath(amount: number): number {",
			"  const refundFee = amount * 0.02;",
			"  return amount - refundFee;",
			"}",
			"",
			"export function computeInvoiceTotal(items: number[]): number {",
			"  let invoiceTotal = 0;",
			"  for (const item of items) invoiceTotal += item;",
			"  return invoiceTotal;",
			"}",
			"",
			"export function shippingWeightBand(kg: number): string {",
			'  if (kg < 1) return "light";',
			'  return "heavy";',
			"}",
			"",
		].join("\n"),
		"src/shipping.ts": [
			"export function estimateParcelTransit(days: number): number {",
			"  const parcelTransitDays = days + 2;",
			"  return parcelTransitDays;",
			"}",
			"",
			"export function courierZoneLookup(zone: string): number {",
			"  const courierZone = zone.length;",
			"  return courierZone * 11;",
			"}",
			"",
		].join("\n"),
		"src/legacy.ts": [
			"export function obsoleteTariffMatrix(row: number): number {",
			"  const tariffMatrixCell = row * 17;",
			"  return tariffMatrixCell;",
			"}",
			"",
			"export function retiredDutyTable(code: number): number {",
			"  const dutyTableEntry = code - 4;",
			"  return dutyTableEntry;",
			"}",
			"",
		].join("\n"),
		"src/util/format.ts": [
			"export function formatCurrencyLabel(cents: number): string {",
			"  const currencyLabel = `$${cents / 100}`;",
			"  return currencyLabel;",
			"}",
			"",
			"export function padReceiptColumn(text: string): string {",
			"  const receiptColumn = text.padEnd(12);",
			"  return receiptColumn;",
			"}",
			"",
		].join("\n"),
	};
}

/** `n` filler files of 10 unrelated functions each (keeps PageRank mass realistic). */
export function fillerFiles(
	prefix: string,
	n: number,
	perFile = 10,
): Record<string, string> {
	const files: Record<string, string> = {};
	for (let f = 0; f < n; f++) {
		const parts: string[] = [];
		for (let i = 0; i < perFile; i++) {
			const id = `${prefix}${letters(f)}${letters(i + 7)}`;
			parts.push(
				fn(
					`${id}Filler`,
					`const ${id}Slot = value * ${f + 3} + ${i};\nreturn ${id}Slot;`,
				),
			);
		}
		files[`filler/${prefix}${f}.ts`] = parts.join("\n");
	}
	return files;
}

/** 0 → "Qa", 1 → "Qb", …: letter-only ids (digits do not tokenize). */
export function letters(n: number): string {
	const a = "abcdefghijklmnopqrstuvwxyz";
	let s = "";
	let x = n;
	do {
		s = a[x % 26] + s;
		x = Math.floor(x / 26);
	} while (x > 0);
	return `Q${s}`;
}

// ─── Disk observation ────────────────────────────────────────────────────

const SNAPSHOT_EXCLUDE = `${sep}home${sep}Library${sep}Caches${sep}bun`;

/** path → size:sha256 (files), "dir", or "link:target"; excludes bun's own cache under HOME. */
export function snapshot(root: string): Map<string, string> {
	const out = new Map<string, string>();
	const walk = (dir: string) => {
		for (const name of readdirSync(dir)) {
			const p = join(dir, name);
			if (p.slice(root.length).startsWith(SNAPSHOT_EXCLUDE)) continue;
			const st = lstatSync(p);
			if (st.isSymbolicLink()) out.set(p, `link:${readlinkSync(p)}`);
			else if (st.isDirectory()) {
				out.set(p, "dir");
				walk(p);
			} else
				out.set(
					p,
					`${st.size}:${createHash("sha256").update(readFileSync(p)).digest("hex")}`,
				);
		}
	};
	walk(root);
	return out;
}

export function diffSnapshots(
	a: Map<string, string>,
	b: Map<string, string>,
): string[] {
	const diffs: string[] = [];
	for (const [k, v] of a)
		if (b.get(k) !== v) diffs.push(`${b.has(k) ? "changed" : "removed"} ${k}`);
	for (const k of b.keys()) if (!a.has(k)) diffs.push(`added ${k}`);
	return diffs;
}

/** `child` is `parent` or below it (realpath-insensitive callers must pass realpaths). */
export function isInsidePath(child: string, parent: string): boolean {
	return isInside(child, parent);
}

export function findDirs(root: string, name: string): string[] {
	const out: string[] = [];
	const walk = (dir: string) => {
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const e of entries) {
			const p = join(dir, e);
			let st: ReturnType<typeof lstatSync>;
			try {
				st = lstatSync(p);
			} catch {
				continue;
			}
			if (!st.isDirectory()) continue;
			if (e === name) out.push(p);
			else walk(p);
		}
	};
	walk(root);
	return out;
}

export function filesUnder(root: string): string[] {
	const out: string[] = [];
	const walk = (dir: string) => {
		for (const e of readdirSync(dir)) {
			const p = join(dir, e);
			const st = lstatSync(p);
			if (st.isDirectory()) walk(p);
			else out.push(p);
		}
	};
	if (existsSync(root)) walk(root);
	return out;
}

export function duBytes(root: string): number {
	return filesUnder(root).reduce((a, p) => a + statSync(p).size, 0);
}

export function median(xs: number[]): number {
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.floor(s.length / 2)] as number;
}

// ─── MCP over stdio ──────────────────────────────────────────────────────

export class McpClient {
	private nextId = 1;
	private pending = new Map<number, (msg: Record<string, unknown>) => void>();
	private buffer = "";
	private constructor(private readonly proc: ReturnType<typeof Bun.spawn>) {}

	static async start(
		sb: Sandbox,
		cwd: string,
		env: Record<string, string> = {},
	): Promise<McpClient> {
		const proc = Bun.spawn({
			cmd: [process.execPath, "--env-file=/dev/null", DIST, "--mcp"],
			cwd,
			env: hermetic(sb, keychainSafeChildEnv(sandboxVars(sb)), env),
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		const client = new McpClient(proc);
		client.pump();
		// drain stderr so the child never blocks on a full pipe
		void new Response(proc.stderr as ReadableStream).text();
		await client.request("initialize", {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "step3-blackbox", version: "1" },
		});
		client.notify("notifications/initialized", {});
		return client;
	}

	private async pump(): Promise<void> {
		const reader = (this.proc.stdout as ReadableStream<Uint8Array>).getReader();
		const dec = new TextDecoder();
		for (;;) {
			const { value, done } = await reader.read();
			if (done) return;
			this.buffer += dec.decode(value, { stream: true });
			let nl = this.buffer.indexOf("\n");
			while (nl !== -1) {
				const line = this.buffer.slice(0, nl).trim();
				this.buffer = this.buffer.slice(nl + 1);
				if (line) {
					try {
						const msg = JSON.parse(line) as Record<string, unknown>;
						const id = msg.id as number | undefined;
						if (id !== undefined && this.pending.has(id)) {
							(this.pending.get(id) as (m: Record<string, unknown>) => void)(
								msg,
							);
							this.pending.delete(id);
						}
					} catch {
						// non-protocol line on stdout would be a CLAUDE.md #14 defect; ignored here
					}
				}
				nl = this.buffer.indexOf("\n");
			}
		}
	}

	private write(obj: unknown): void {
		const sink = this.proc.stdin as import("bun").FileSink;
		sink.write(`${JSON.stringify(obj)}\n`);
		sink.flush();
	}

	notify(method: string, params: unknown): void {
		this.write({ jsonrpc: "2.0", method, params });
	}

	request(
		method: string,
		params: unknown,
		timeoutMs = 90_000,
	): Promise<Record<string, unknown>> {
		const id = this.nextId++;
		return new Promise((resolvePromise, reject) => {
			const timer = setTimeout(
				() => reject(new Error(`MCP ${method} timed out`)),
				timeoutMs,
			);
			this.pending.set(id, (msg) => {
				clearTimeout(timer);
				resolvePromise(msg);
			});
			this.write({ jsonrpc: "2.0", id, method, params });
		});
	}

	/** tools/call → the parsed JSON of the first text content block (or the raw text). */
	async call(
		name: string,
		args: Record<string, unknown>,
	): Promise<{ json: unknown; text: string; isError: boolean }> {
		const msg = await this.request("tools/call", { name, arguments: args });
		if (msg.error)
			throw new Error(`MCP ${name} error: ${JSON.stringify(msg.error)}`);
		const result = msg.result as {
			content?: { type: string; text?: string }[];
			isError?: boolean;
		};
		const text =
			(result.content ?? []).find((c) => c.type === "text")?.text ?? "";
		let json: unknown = null;
		try {
			json = JSON.parse(text);
		} catch {
			json = null;
		}
		return { json, text, isError: result.isError === true };
	}

	async close(): Promise<void> {
		try {
			(this.proc.stdin as import("bun").FileSink).end();
		} catch {
			// already closed
		}
		this.proc.kill();
		await this.proc.exited;
	}
}
