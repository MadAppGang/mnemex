/**
 * V3.15: REG-1 under real concurrency (architecture §3.4, N1).
 *
 * Two children race 200 iterations each against ONE store. Every iteration takes
 * the real store lock, opens the registry, allocates a new label, writes a
 * `files` row carrying the id, flushes and releases
 * (`test/helpers/registry-race-child.ts`). A lost update, where two writers
 * each read `nextId`, mutate their own copy and rename, has two silent outcomes:
 * two labels on one id, or an erased allocation whose rows no entry names.
 * Both are asserted on BYTES and ROWS, never through a report object:
 *
 *   (a) `nextId` equals 1 + max(id), and never decreased in any sample the
 *       parent took from the bytes while the children raced;
 *   (b) no two entries share an id, and no two children were handed one id;
 *   (c) no two live entries share a label;
 *   (d) every `branch_id` in `files` (independent sqlite) has an entry;
 *   plus: every allocation a child reported is in the final file with the id
 *   it was given (no lost update), and no sample was ever a torn file.
 *
 * The confirm pass (W-R2) the design pairs with the allocator is Phase 3b's, so
 * both contenders allocate here.
 *
 * FALSIFIED (recorded in the implementation log): opening the registry BEFORE
 * the lock is acquired, with the runtime token check removed so that it can be.
 * The runtime check alone refuses that open (branch-registry.test.ts).
 */

import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createGitSandbox } from "../../helpers/git-sandbox.js";
import { spawnRaceChild } from "../../helpers/v4-fixtures.js";

const ITERATIONS = 200;
const TEST_TIMEOUT_MS = 240_000;

interface Alloc {
	label: string;
	id: number;
}

function allocsOf(stdout: string): Alloc[] {
	return stdout
		.split("\n")
		.filter((l) => l.startsWith("ALLOC "))
		.map((l) => JSON.parse(l.slice("ALLOC ".length)) as Alloc);
}

test(
	`REG-1: ${ITERATIONS} x 2 racing allocations lose nothing and share nothing`,
	async () => {
		const sb = createGitSandbox("v315-");
		try {
			const project = join(sb.root, "project");
			mkdirSync(project);
			const scratch = join(sb.root, "scratch");
			const registryPath = join(project, ".mnemex", "branches.json");

			const spawn = (prefix: string) =>
				spawnRaceChild(project, prefix, ITERATIONS, scratch);
			const children = [spawn("a"), spawn("b")];

			const samples: number[] = [];
			let tornReads = 0;
			let racing = true;
			const sampler = (async () => {
				while (racing) {
					if (existsSync(registryPath)) {
						try {
							samples.push(
								JSON.parse(readFileSync(registryPath, "utf8")).nextId,
							);
						} catch {
							tornReads++;
						}
					}
					await Bun.sleep(2);
				}
			})();
			const outputs = await Promise.all(
				children.map((c) => new Response(c.stdout as ReadableStream).text()),
			);
			const errors = await Promise.all(
				children.map((c) => new Response(c.stderr as ReadableStream).text()),
			);
			const codes = await Promise.all(children.map((c) => c.exited));
			racing = false;
			await sampler;

			expect(codes, errors.join("\n")).toEqual([0, 0]);
			const allocs = outputs.flatMap(allocsOf);
			expect(allocs).toHaveLength(2 * ITERATIONS);

			const file = JSON.parse(readFileSync(registryPath, "utf8")) as {
				nextId: number;
				branches: Array<{
					id: number;
					label: string;
					deletedAt: string | null;
				}>;
			};
			const ids = file.branches.map((b) => b.id);

			// (a)
			expect(file.nextId).toBe(1 + Math.max(...ids));
			expect(samples.length).toBeGreaterThan(0);
			const decreases = samples.filter((n, i) => i > 0 && n < samples[i - 1]);
			expect(decreases).toEqual([]);
			expect(tornReads).toBe(0);
			// (b)
			expect(new Set(ids).size).toBe(ids.length);
			expect(new Set(allocs.map((a) => a.id)).size).toBe(allocs.length);
			// (c)
			const live = file.branches
				.filter((b) => b.deletedAt === null)
				.map((b) => b.label);
			expect(new Set(live).size).toBe(live.length);
			// No lost update: every reported allocation is in the file, with its id.
			const idOf = new Map(file.branches.map((b) => [b.label, b.id]));
			expect(allocs.filter((a) => idOf.get(a.label) !== a.id)).toEqual([]);
			// (d)
			const db = new Database(join(project, ".mnemex", "index.db"));
			try {
				const rowIds = (
					db.prepare("SELECT DISTINCT branch_id FROM files").all() as Array<{
						branch_id: number;
					}>
				).map((r) => r.branch_id);
				expect(rowIds.length).toBe(2 * ITERATIONS);
				expect(rowIds.filter((id) => !ids.includes(id))).toEqual([]);
			} finally {
				db.close();
			}
		} finally {
			sb.cleanup();
		}
	},
	TEST_TIMEOUT_MS,
);
