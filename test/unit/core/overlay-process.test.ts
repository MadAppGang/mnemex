/**
 * K-1 and Y-1 (step 3, R3.12 and NFR-5) — the two overlay properties that need
 * a process boundary. Children: `test/helpers/dirty-overlay-child.ts`, each
 * with `sandboxEnv()` (keychain guards, sandboxed HOME, embed cache and global
 * lock inside the scratch directory).
 *
 * K-1 — two searches in two processes rebuild the same overlay at once. The
 * overlay lock makes the second one wait (2 s) and then go index-only, so the
 * provider sees each changed chunk ONCE, not twice. Counted on the wire by the
 * fake `/api/embed` server, which PARKS every request until released — so the
 * two passes provably overlap instead of racing process start-up. Neither
 * child takes a store or global lock (R3.12).
 *
 * Y-1 — a 200-file overlay build in a process that HOLDS A STORE LOCK (an MCP
 * server mid-index). The store lock's heartbeat is read from the lock FILE by
 * THIS process on its own 100 ms timer; the child only reports. Upper bound:
 *
 *     true max heartbeat age  ≤  max sampled age + this process's max tick gap
 *
 * asserted below HEARTBEAT_INTERVAL + B_max = 1500 ms, the heartbeat-age bound
 * `sync-region.ts` derives (1501 ms with the lock-file write). The child runs with the embed
 * cache OFF: then nothing but the overlay's own yields returns to the event
 * loop during the build, so removing them must show here (CLAUDE.md #24: a
 * measurement from outside, never a self-report).
 */

import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chunkFileByPath } from "../../../src/core/chunker.js";
import { getLockPathFor } from "../../../src/core/store-location.js";
import {
	createOverlayFixture,
	indexAll,
	type OverlayFixture,
	tsSource,
} from "../../helpers/dirty-overlay-fixture.js";
import { startFakeOllamaEmbedServer } from "../../helpers/fake-ollama-embed-server.js";
import { collect, sandboxEnv } from "../../helpers/v4-fixtures.js";

const REPO = join(import.meta.dir, "..", "..", "..");
const CHILD = join(REPO, "test", "helpers", "dirty-overlay-child.ts");

function lockConstant(name: string): number {
	const source = readFileSync(join(REPO, "src", "core", "lock.ts"), "utf8");
	const match = source.match(new RegExp(`const ${name} = (\\d+)`));
	if (!match?.[1]) throw new Error(`lock.ts: ${name} not found`);
	return Number(match[1]);
}
const HEARTBEAT_INTERVAL = lockConstant("HEARTBEAT_INTERVAL");
/** `sync-region.ts`, THE ARITHMETIC: busy-wait 250 + work 250 per region. */
const B_MAX_MS = 500;

// Each test owns its fixture and cleans it up itself (the fixture refuses to
// overlap another); this only catches a test that threw before its finally.
const fixtures: OverlayFixture[] = [];
afterAll(() => {
	for (const f of fixtures.splice(0)) f.cleanup();
});

function release(fx: OverlayFixture): void {
	const at = fixtures.indexOf(fx);
	if (at >= 0) fixtures.splice(at, 1);
	fx.cleanup();
}

function spawnChild(
	fx: OverlayFixture,
	mode: "k1" | "y1",
	extraArg: string,
	extraEnv: Record<string, string> = {},
) {
	return Bun.spawn(
		[
			process.execPath,
			"--env-file=/dev/null",
			CHILD,
			mode,
			fx.repo,
			join(fx.box.root, "index.db"),
			fx.embedCachePath,
			extraArg,
		],
		{
			cwd: fx.repo,
			env: sandboxEnv(fx.box.root, extraEnv),
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
}

describe("K-1 — concurrent passes embed each chunk once", () => {
	test("two child processes → N provider texts, not 2N; no store/global lock (A, wire count)", async () => {
		const fx = await createOverlayFixture({
			"src/a.ts": tsSource("a", 3),
			"src/b.ts": tsSource("b", 3),
		});
		fixtures.push(fx);
		indexAll(fx, ["src/a.ts", "src/b.ts"]);
		const dirtyA = tsSource("a", 3, "edited");
		const dirtyB = tsSource("b", 3, "edited");
		fx.write("src/a.ts", dirtyA);
		fx.write("src/b.ts", dirtyB);
		const n =
			(await chunkFileByPath(dirtyA, "src/a.ts", "x")).length +
			(await chunkFileByPath(dirtyB, "src/b.ts", "x")).length;

		const server = startFakeOllamaEmbedServer({ hold: true, dimension: 8 });
		try {
			const one = spawnChild(fx, "k1", server.url);
			const two = spawnChild(fx, "k1", server.url);
			// Wait until one pass is parked inside its embed call, holding the lock…
			const deadline = Date.now() + 30_000;
			while (server.embedRequests() < 1 && Date.now() < deadline) {
				await Bun.sleep(20);
			}
			expect(server.embedRequests()).toBeGreaterThanOrEqual(1);
			// …long enough for the other to give up its 2 s lock wait.
			await Bun.sleep(3000);
			server.release();
			const runs = await Promise.all([collect(one), collect(two)]);
			for (const run of runs) {
				expect(run.stderr).not.toContain("must point inside tmpdir");
				expect(run.exitCode).toBe(0);
			}
			const reports = runs.map(
				(r) => r.result?.report as Record<string, unknown>,
			);
			console.log(
				`K-1: n=${n} embedInputs=${server.embedInputs()} reasons=${reports.map((r) => `${r.state}/${r.reason}`).join(",")}`,
			);
			expect(server.embedInputs()).toBe(n);
			expect(reports.map((r) => r.reason).sort()).toEqual(["busy", "dirty"]);
			// Every lock either child took was the overlay's own: the busy one
			// took none, the other exactly the overlay lock.
			const locks = runs.flatMap((run) => run.result?.locks as string[]);
			expect(locks).toEqual([fx.lockPath]);
		} finally {
			server.stop();
			release(fx);
		}
	}, 60_000);
});

describe("Y-1 — the store lock's heartbeat stays fresh during a 200-file build", () => {
	test("measured from OUTSIDE the blocking process, under a held store lock (A)", async () => {
		const FILES = 200;
		const files: Record<string, string> = {};
		// ~2.1 KB per function (≈ 525 tokens, under the chunker's 600): parse
		// cost grows with bytes, chunk count with functions, so this doubles the
		// synchronous work per file without doubling the rows LanceDB handles.
		const body = (i: number) =>
			Array.from(
				{ length: 55 },
				(_, j) => `\tconst v${j} = input * ${i + j} + scale - ${j};`,
			).join("\n");
		const source = (stem: string, variant: string) =>
			Array.from(
				{ length: 50 },
				(_, i) =>
					`/** ${stem} ${i} ${variant} */\nexport function ${stem}_${i}(input: number, scale: number): number {\n${body(i)}\n\treturn input + scale;\n}\n`,
			).join("\n");
		for (let i = 0; i < FILES; i++) {
			files[`src/f${i}.ts`] = source(`f${i}`, "v0");
		}
		const fx = await createOverlayFixture(files, "mnemex-y1-");
		fixtures.push(fx);
		indexAll(fx, Object.keys(files));
		for (let i = 0; i < FILES; i++) {
			fx.write(`src/f${i}.ts`, source(`f${i}`, "v1"));
		}
		const lockFile = getLockPathFor(fx.loc);

		const child = spawnChild(fx, "y1", String(FILES), {
			MNEMEX_DISABLE_EMBED_CACHE: "1",
		});

		let maxAge = 0;
		let maxGap = 0;
		let samples = 0;
		let lastTick = Date.now();
		let held = false;
		const sampler = setInterval(() => {
			const now = Date.now();
			maxGap = Math.max(maxGap, now - lastTick);
			lastTick = now;
			try {
				const data = JSON.parse(readFileSync(lockFile, "utf8")) as {
					heartbeat: number;
				};
				held = true;
				samples++;
				maxAge = Math.max(maxAge, now - data.heartbeat);
			} catch {
				// Not created yet, or released.
			}
		}, 100);
		const run = await collect(child);
		clearInterval(sampler);

		expect(run.stderr).not.toContain("must point inside tmpdir");
		expect(run.exitCode).toBe(0);
		const report = run.result?.report as Record<string, number | string>;
		const upperBound = maxAge + maxGap;
		console.log(
			`Y-1: files=${FILES} served=${report.files} ms=${run.result?.ms} samples=${samples} maxSampledAge=${maxAge} maxParentGap=${maxGap} upperBound=${upperBound}`,
		);
		expect(held).toBe(true);
		expect(report.files).toBe(FILES);
		// Non-vacuous: the build ran long enough for the timer to matter.
		expect(Number(run.result?.ms)).toBeGreaterThan(2 * HEARTBEAT_INTERVAL);
		// CLAUDE.md #31's own bound: HEARTBEAT_INTERVAL + B_max (500 ms).
		expect(upperBound).toBeLessThan(HEARTBEAT_INTERVAL + B_MAX_MS);
		release(fx);
	}, 180_000);
});
