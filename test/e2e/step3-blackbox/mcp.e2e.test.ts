/**
 * Step 3 black-box — MCP surface (test-plan TEST-05, TEST-06, TEST-09 (MCP),
 * TEST-25, TEST-26). Drives `dist/index.js --mcp` over stdio.
 *
 * Response shapes (observed through tools/list and tools/call, not read from src/):
 *  - `context`  → JSON { fileResolution: { match, file }, enclosingSymbol, imports, relatedSymbols, … }
 *  - `search`   → JSON { results: [{ file, line, lineEnd, symbol, source? }], overlay: { state, … }, … }
 *  - `search_code` → markdown result blocks ("### n. `path`:start-end", "Source: uncommitted …")
 *                    followed by a JSON status object.
 */
import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	billingWithoutLegacy,
	billingWithQuokka,
	TELEMETRY,
	twinsFixture,
} from "./fixtures";
import {
	assertNoSecuritySpawn,
	createSandbox,
	fSmall,
	indexRepo,
	McpClient,
	makeRepo,
	overlayTexts,
	type Sandbox,
} from "./harness";

interface CodeBlock {
	file: string;
	start: number;
	end: number;
	uncommitted: boolean;
	body: string;
}

/** Parses `search_code`'s markdown blocks and its trailing JSON object. */
function parseSearchCode(text: string): {
	blocks: CodeBlock[];
	status: Record<string, unknown> | null;
} {
	const blocks: CodeBlock[] = [];
	const sections = text.split(/\n(?=### \d+\. )/);
	for (const sec of sections) {
		const m = /^### \d+\. `([^`]+)`:(\d+)-(\d+)/.exec(sec);
		if (!m) continue;
		blocks.push({
			file: m[1] as string,
			start: Number(m[2]),
			end: Number(m[3]),
			uncommitted: /^Source: uncommitted/m.test(sec),
			body: sec,
		});
	}
	let status: Record<string, unknown> | null = null;
	const at = text.lastIndexOf("\n{");
	if (at !== -1) {
		try {
			status = JSON.parse(text.slice(at + 1)) as Record<string, unknown>;
		} catch {
			status = null;
		}
	}
	return { blocks, status };
}

interface SearchJson {
	results: {
		file: string;
		line: number;
		lineEnd: number;
		symbol: string | null;
		source?: string;
	}[];
	overlay?: { state: string; reason?: string; files?: number };
}

async function withMcp(
	files: Record<string, string>,
	fn: (sb: Sandbox, repo: string, mcp: McpClient) => Promise<void>,
	prepare?: (sb: Sandbox, repo: string) => void,
): Promise<void> {
	const sb = createSandbox();
	let mcp: McpClient | null = null;
	try {
		const repo = makeRepo(sb, "repo", files);
		await indexRepo(sb, repo);
		prepare?.(sb, repo);
		mcp = await McpClient.start(sb, repo);
		await fn(sb, repo, mcp);
		assertNoSecuritySpawn(sb);
	} finally {
		await mcp?.close();
		sb.cleanup();
	}
}

const CONTEXT_FILES = {
	...fSmall(),
	"src/a/index.ts":
		"export function alphaIndexEntry(n: number): number {\n  return n + 1;\n}\n",
	"src/b/index.ts":
		"export function betaIndexEntry(n: number): number {\n  return n + 2;\n}\n",
};

const comparable = (j: unknown) => {
	const o = j as Record<string, unknown>;
	return {
		fileResolution: o.fileResolution,
		enclosingSymbol: o.enclosingSymbol,
		imports: o.imports,
		relatedSymbols: o.relatedSymbols,
	};
};

test("TEST-05: MCP context — repo-relative and absolute `file` give the same non-empty answer", async () => {
	await withMcp(CONTEXT_FILES, async (_sb, repo, mcp) => {
		const rel = await mcp.call("context", { file: "src/billing.ts", line: 7 });
		const abs = await mcp.call("context", {
			file: join(repo, "src/billing.ts"),
			line: 7,
		});
		expect(rel.isError).toBe(false);
		expect(abs.isError).toBe(false);
		const r = comparable(rel.json);
		expect((r.enclosingSymbol as { name?: string } | null)?.name).toBe(
			"computeInvoiceTotal",
		);
		expect((r.fileResolution as { match?: string }).match).toBe("exact");
		expect(comparable(abs.json)).toEqual(r);
	});
}, 180_000);

test("TEST-06: MCP context — unique bare filename resolves by suffix; ambiguous answers nothing and names candidates", async () => {
	await withMcp(CONTEXT_FILES, async (_sb, _repo, mcp) => {
		const unique = await mcp.call("context", { file: "format.ts", line: 2 });
		const u = comparable(unique.json);
		expect(u.fileResolution).toEqual({
			match: "suffix",
			file: "src/util/format.ts",
		});
		expect((u.enclosingSymbol as { name?: string } | null)?.name).toBe(
			"formatCurrencyLabel",
		);

		const amb = await mcp.call("context", { file: "index.ts", line: 1 });
		const a = comparable(amb.json);
		expect(a.enclosingSymbol ?? null).toBeNull();
		const resolution = JSON.stringify(a.fileResolution);
		expect(resolution).toContain("src/a/index.ts");
		expect(resolution).toContain("src/b/index.ts");
	});
}, 180_000);

test("TEST-09 (MCP): search_code and search return one result per span, back-filled to the limit", async () => {
	await withMcp(twinsFixture(), async (_sb, _repo, mcp) => {
		for (const q of ["latitude clamp", "word frequency"]) {
			const sc = parseSearchCode(
				(
					await mcp.call("search_code", {
						query: q,
						limit: 10,
						autoIndex: false,
					})
				).text,
			);
			const spans = sc.blocks.map((b) => `${b.file}:${b.start}-${b.end}`);
			expect({
				q,
				tool: "search_code",
				n: spans.length,
				dup: spans.length - new Set(spans).size,
			}).toEqual({
				q,
				tool: "search_code",
				n: 10,
				dup: 0,
			});
			const se = (await mcp.call("search", { query: q, limit: 10 }))
				.json as SearchJson;
			const spans2 = se.results.map((r) => `${r.file}:${r.line}-${r.lineEnd}`);
			expect({
				q,
				tool: "search",
				n: spans2.length,
				dup: spans2.length - new Set(spans2).size,
			}).toEqual({
				q,
				tool: "search",
				n: 10,
				dup: 0,
			});
		}
	});
}, 180_000);

test("TEST-25: MCP search_code and search include dirty work and report the overlay", async () => {
	await withMcp(
		fSmall(),
		async (_sb, repo, mcp) => {
			const billing = join(repo, "src/billing.ts");
			const sc = parseSearchCode(
				(
					await mcp.call("search_code", {
						query: "quokka ledger reconcile",
						limit: 10,
						autoIndex: false,
					})
				).text,
			);
			expect(
				(sc.status?.overlay as { state?: string } | undefined)?.state,
			).toBe("on");
			const planted = sc.blocks.filter(
				(b) => b.file === billing && b.body.includes("quokkaLedgerReconcile"),
			);
			expect(planted.length).toBe(1);
			expect(planted[0]?.uncommitted).toBe(true);
			expect(
				sc.blocks.filter((b) => b.file === billing && !b.uncommitted),
			).toEqual([]);

			const se = (
				await mcp.call("search", { query: "wombat telemetry flush", limit: 10 })
			).json as SearchJson;
			expect(se.overlay?.state).toBe("on");
			const tel = se.results.filter(
				(r) => r.file === join(repo, "src/telemetry.ts"),
			);
			expect(tel.length).toBeGreaterThan(0);
			for (const r of tel) expect(r.source).toBe("dirty");
		},
		(_sb, repo) => {
			writeFileSync(join(repo, "src/billing.ts"), billingWithQuokka());
			writeFileSync(join(repo, "src/telemetry.ts"), TELEMETRY);
		},
	);
}, 180_000);

test("TEST-26: MCP honours dirtyOverlay:false on both tools", async () => {
	await withMcp(
		fSmall(),
		async (sb, _repo, mcp) => {
			const q = "legacy refund path";
			sb.embedder.reset();
			const sc = parseSearchCode(
				(
					await mcp.call("search_code", {
						query: q,
						limit: 10,
						autoIndex: false,
					})
				).text,
			);
			expect(
				(sc.status?.overlay as { state?: string } | undefined)?.state,
			).toBe("off");
			expect(sc.blocks.filter((b) => b.uncommitted)).toEqual([]);
			expect(sc.blocks.some((b) => b.body.includes("`legacyRefundPath`"))).toBe(
				true,
			); // stale row visible
			expect(overlayTexts(sb.embedder.journal, q)).toEqual([]);

			const se = (await mcp.call("search", { query: q, limit: 10 }))
				.json as SearchJson;
			expect(se.overlay?.state).toBe("off");
			expect(se.results.filter((r) => r.source === "dirty")).toEqual([]);
		},
		(_sb, repo) => {
			writeFileSync(join(repo, "src/billing.ts"), billingWithoutLegacy());
			writeFileSync(
				join(repo, "mnemex.json"),
				`${JSON.stringify({ dirtyOverlay: false })}\n`,
			);
		},
	);
}, 180_000);
