/**
 * Step 3 black-box — R2: one span, one result slot (test-plan TEST-07..10).
 * The MCP half of TEST-09 lives in mcp.e2e.test.ts.
 */
import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { TWIN_NAMES, twinsFixture, twinsGeoEdited } from "./fixtures";
import {
	assertNoSecuritySpawn,
	createSandbox,
	duplicateSpans,
	indexRepo,
	makeRepo,
	num,
	type Sandbox,
	search,
} from "./harness";

async function withTwins(
	fn: (sb: Sandbox, repo: string) => Promise<void>,
): Promise<void> {
	const sb = createSandbox();
	try {
		const repo = makeRepo(sb, "twins", twinsFixture());
		await indexRepo(sb, repo);
		await fn(sb, repo);
		assertNoSecuritySpawn(sb);
	} finally {
		sb.cleanup();
	}
}

const QUERIES = [
	"latitude clamp",
	"slugify title",
	"word frequency",
	"polygon area",
	"route simplify",
];

test("TEST-07: zero duplicate spans and full back-fill (vector path)", async () => {
	await withTwins(async (sb, repo) => {
		for (const q of QUERIES) {
			const s = await search(sb, repo, q, { limit: 10 });
			expect({ q, dup: duplicateSpans(s.out.rows) }).toEqual({ q, dup: 0 });
			expect({
				q,
				rows: s.out.rows.length,
				count: num(s.out, "result_count"),
			}).toEqual({
				q,
				rows: 10,
				count: 10,
			});
		}
	});
}, 180_000);

test("TEST-08: a kept twin keeps its identity (type=function, name=<fn>, rank 1)", async () => {
	await withTwins(async (sb, repo) => {
		for (const name of ["haversineSpan", "stripAccents", "geohashEncode"]) {
			const s = await search(sb, repo, name, { limit: 10 });
			const top = s.out.rows[0];
			expect({ name, type: top?.type, got: top?.name }).toEqual({
				name,
				type: "function",
				got: name,
			});
		}
		expect(TWIN_NAMES.length).toBe(14);
	});
}, 180_000);

test("TEST-09 (CLI keyword path): zero duplicate spans and full back-fill", async () => {
	await withTwins(async (sb, repo) => {
		for (const q of ["value return", "const value"]) {
			const s = await search(sb, repo, q, { limit: 10, flags: ["--keyword"] });
			expect({ q, dup: duplicateSpans(s.out.rows) }).toEqual({ q, dup: 0 });
			expect({ q, rows: s.out.rows.length }).toEqual({ q, rows: 10 });
		}
	});
}, 180_000);

test("TEST-10: twin collapse holds while the overlay serves a file", async () => {
	await withTwins(async (sb, repo) => {
		writeFileSync(join(repo, "src/geo.ts"), twinsGeoEdited());
		for (const q of ["latitude clamp", "polygon area", "word frequency"]) {
			const s = await search(sb, repo, q, { limit: 10 });
			expect(s.out.header.get("overlay")).toBe("on");
			expect(num(s.out, "overlay_files")).toBe(1);
			expect({ q, dup: duplicateSpans(s.out.rows) }).toEqual({ q, dup: 0 });
			for (const r of s.out.rows.filter(
				(x) => x.file === join(repo, "src/geo.ts"),
			)) {
				expect({ row: r.raw, dirty: r.dirty }).toEqual({
					row: r.raw,
					dirty: true,
				});
			}
		}
	});
}, 180_000);
