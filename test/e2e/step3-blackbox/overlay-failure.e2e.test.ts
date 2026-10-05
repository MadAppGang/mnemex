/**
 * Step 3 black-box — R3.11 failure isolation (test-plan TEST-31..33, TEST-42..44).
 * An overlay failure never fails a search; a QUERY-embedding failure is pinned
 * as today's error (re-scope, ruling 1).
 */
import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	billingWithoutLegacyEdited,
	billingWithQuokka,
	TELEMETRY,
} from "./fixtures";
import {
	allTexts,
	assertNoSecuritySpawn,
	createSandbox,
	fSmall,
	indexRepo,
	lineOf,
	makeRepo,
	num,
	rowsCovering,
	type Sandbox,
	search,
} from "./harness";

async function withSmall(
	fn: (sb: Sandbox, repo: string) => Promise<void>,
): Promise<void> {
	const sb = createSandbox();
	try {
		const repo = makeRepo(sb, "small", fSmall());
		await indexRepo(sb, repo);
		await fn(sb, repo);
		assertNoSecuritySpawn(sb);
	} finally {
		sb.cleanup();
	}
}

test("TEST-31: overlay embedding refused AFTER the query → index results, overlay=skipped, stale rows visible", async () => {
	await withSmall(async (sb, repo) => {
		writeFileSync(join(repo, "src/billing.ts"), billingWithoutLegacyEdited());
		writeFileSync(join(repo, "src/telemetry.ts"), TELEMETRY);
		const q = "legacy refund path";
		sb.embedder.mode = { kind: "refuse-after-query", allow: [q] };
		const s = await search(sb, repo, q, { limit: 10 });
		expect(s.res.code).toBe(0);
		expect(num(s.out, "result_count")).toBeGreaterThan(0);
		expect([
			s.out.header.get("overlay"),
			s.out.header.get("overlay_reason"),
		]).toEqual(["skipped", "embed-failed"]);
		expect(s.out.rows.filter((r) => r.dirty)).toEqual([]);
		expect(
			s.out.rows.some(
				(r) =>
					r.name === "legacyRefundPath" &&
					r.file === join(repo, "src/billing.ts"),
			),
		).toBe(true);
		expect(num(s.out, "overlay_suppressed_rows")).toBe(0);
		expect(
			s.journal.filter((e) => e.status === 500).length,
		).toBeGreaterThanOrEqual(1);
		expect(s.res.ms).toBeLessThan(15_000);
	});
}, 180_000);

test("TEST-32: one file's embedding refused → that file failed, the other served", async () => {
	await withSmall(async (sb, repo) => {
		const billing = join(repo, "src/billing.ts");
		writeFileSync(billing, billingWithoutLegacyEdited());
		writeFileSync(join(repo, "src/telemetry.ts"), TELEMETRY);
		sb.embedder.mode = {
			kind: "refuse-matching",
			token: "wombatTelemetryFlush",
		};
		const s = await search(sb, repo, "legacy refund path", { limit: 10 });
		expect(s.out.header.get("overlay")).toBe("on");
		expect(num(s.out, "overlay_files_failed")).toBe(1);
		expect(num(s.out, "overlay_files")).toBe(1);
		expect(s.out.header.get("overlay_gaps") ?? "").toContain("failed");
		expect(s.out.rows.some((r) => r.name === "legacyRefundPath")).toBe(false);
		expect(s.out.rows.filter((r) => r.file === billing && !r.dirty)).toEqual(
			[],
		);
		const t = await search(sb, repo, "wombat telemetry flush", { limit: 10 });
		expect(
			t.out.rows.filter((r) => r.file === join(repo, "src/telemetry.ts")),
		).toEqual([]);
		expect(num(t.out, "overlay_files_failed")).toBe(1);
	});
}, 180_000);

test("TEST-33: endpoint fully down → today's query-embedding error, unchanged (characterisation, I-2)", async () => {
	await withSmall(async (sb, repo) => {
		writeFileSync(join(repo, "src/billing.ts"), billingWithQuokka());
		sb.embedder.stop();
		const s = await search(sb, repo, "quokka ledger reconcile", { raw: true });
		expect(s.res.code).toBe(1);
		expect(s.out.rows).toEqual([]);
		expect(s.res.stdout + s.res.stderr).toContain("failed for all 1 texts");
	});
}, 180_000);

test("TEST-42: not a git repository → search works and the overlay reports why", async () => {
	const sb = createSandbox();
	try {
		const dir = makeRepo(sb, "plain", fSmall(), { noGit: true });
		await indexRepo(sb, dir);
		writeFileSync(join(dir, "src/telemetry.ts"), TELEMETRY);
		const s = await search(sb, dir, "compute invoice total", { limit: 10 });
		expect(s.out.rows.length).toBeGreaterThan(0);
		expect(["off", "skipped"]).toContain(s.out.header.get("overlay") as string);
		expect(s.out.header.get("overlay_reason") ?? "").not.toBe("");
		expect(s.overlayTexts).toEqual([]);
		assertNoSecuritySpawn(sb);
	} finally {
		sb.cleanup();
	}
}, 180_000);

test("TEST-43: keyword-only search never builds the overlay and calls no provider", async () => {
	await withSmall(async (sb, repo) => {
		writeFileSync(join(repo, "src/billing.ts"), billingWithQuokka());
		const s = await search(sb, repo, "quokka", { flags: ["--keyword"] });
		expect([
			s.out.header.get("overlay"),
			s.out.header.get("overlay_reason"),
		]).toEqual(["off", "keyword-only"]);
		expect(s.overlayTexts).toEqual([]);
		expect(s.journal.length).toBe(0);
	});
}, 180_000);

test("TEST-44: an oversized dirty file fails alone", async () => {
	await withSmall(async (sb, repo) => {
		const billing = join(repo, "src/billing.ts");
		writeFileSync(billing, billingWithQuokka());
		const lines: string[] = [];
		let i = 0;
		while (lines.join("\n").length < 1.5 * 1024 * 1024) {
			for (let k = 0; k < 1000; k++, i++)
				lines.push(`export const hugeZebraMarker${i} = ${i};`);
		}
		writeFileSync(join(repo, "src/huge.ts"), `${lines.join("\n")}\n`);
		const s = await search(sb, repo, "quokka ledger reconcile", { limit: 10 });
		expect(num(s.out, "overlay_files_failed")).toBeGreaterThanOrEqual(1);
		expect(s.out.header.get("overlay_gaps") ?? "").toContain("too-large");
		expect(
			allTexts(s.journal).filter((t) => t.includes("hugeZebraMarker")),
		).toEqual([]);
		const at = lineOf(billing, "quokkaLedgerReconcile");
		expect(rowsCovering(s.out.rows, billing, at).some((r) => r.dirty)).toBe(
			true,
		);
	});
}, 180_000);
