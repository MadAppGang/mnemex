/**
 * V2.5 — eight processes race `acquire()` on ONE store, with no global lock.
 * Exactly one token may ever appear in the lock file, and exactly one process
 * may write.
 *
 * Falsified by: reverting `open(wx)` to read-then-write. The old sequence let a
 * contender read "absent", lose the CPU while another wrote and verified, then
 * write and verify its own record, so two processes held the lock at once.
 *
 * The evidence is gathered from outside the contenders. THIS process polls the
 * lock file for every token it ever carries, and each contender that believes
 * it won appends one line to a shared O_APPEND log: the "write". Neither
 * relies on a contender's own report of whether it was alone.
 *
 * Every child gets `keychainSafeChildEnv()` with HOME and the embed cache
 * pointed into a temp directory. The child imports only the lock and the seam.
 */

import { afterAll, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keychainSafeChildEnv } from "../../helpers/child-env.js";

const CHILD = join(
	import.meta.dir,
	"..",
	"..",
	"helpers",
	"store-lock-race-child.ts",
);
const CONTENDERS = 8;
const ROUNDS = 3;
/** Long enough that a second "holder" would overlap the first in the log. */
const HOLD_MS = 800;
/** Time for eight `bun` children to start before the barrier drops. */
const START_MARGIN_MS = 3_000;

const root = realpathSync(mkdtempSync(join(tmpdir(), "store-lock-race-")));
const home = join(root, "home");
mkdirSync(home);

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

interface ChildReport {
	pid: number;
	acquired: boolean;
	reason: string | null;
	arrivedEarlyMs: number;
}

async function runRound(round: number) {
	const project = join(root, `round-${round}`);
	mkdirSync(project);
	const logPath = join(root, `writes-${round}.log`);
	const lockPath = join(project, ".mnemex", ".indexing.lock");
	const startAt = Date.now() + START_MARGIN_MS;

	const children = Array.from({ length: CONTENDERS }, () =>
		Bun.spawn(
			["bun", CHILD, project, String(startAt), String(HOLD_MS), logPath],
			{
				env: keychainSafeChildEnv({
					HOME: home,
					MNEMEX_EMBED_CACHE_PATH: join(root, "embed-cache.db"),
				}),
				stdout: "pipe",
				stderr: "pipe",
			},
		),
	);

	// The third process: every token the lock file ever carries.
	const tokensSeen = new Set<string>();
	let finished = false;
	const allExited = Promise.all(children.map((c) => c.exited)).then(() => {
		finished = true;
	});
	while (!finished) {
		try {
			const token = JSON.parse(readFileSync(lockPath, "utf8")).token;
			if (typeof token === "string") tokensSeen.add(token);
		} catch {
			// absent, or read mid-write
		}
		await Bun.sleep(1);
	}
	await allExited;

	const reports: ChildReport[] = [];
	for (const child of children) {
		const out = (await new Response(child.stdout).text()).trim();
		const err = (await new Response(child.stderr).text()).trim();
		if (child.exitCode !== 0 || out === "") {
			throw new Error(`contender exited ${child.exitCode}: ${err || out}`);
		}
		reports.push(JSON.parse(out) as ChildReport);
	}
	const writes = existsSync(logPath)
		? readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean)
		: [];
	return { reports, writes, tokensSeen };
}

describe("V2.5 — eight contenders, one store, no global lock", () => {
	test(
		`exactly one of ${CONTENDERS} holds, in each of ${ROUNDS} rounds`,
		async () => {
			for (let round = 0; round < ROUNDS; round++) {
				const { reports, writes, tokensSeen } = await runRound(round);
				const winners = reports.filter((r) => r.acquired);
				const onTime = reports.filter((r) => r.arrivedEarlyMs > 0).length;
				const summary = `round ${round}: winners=${winners.length} writes=${writes.length} tokens=${tokensSeen.size} onTime=${onTime}`;

				// It was a race: at least two contenders were waiting at the
				// barrier when it dropped. Otherwise "one winner" proves nothing.
				expect(onTime, summary).toBeGreaterThanOrEqual(2);

				// Exactly one process wrote...
				expect(writes, summary).toHaveLength(1);
				// ...exactly one believed it held the lock...
				expect(winners, summary).toHaveLength(1);
				// ...and the lock file only ever carried that one holder's token.
				const [writerPid, writerToken] = (writes[0] as string).split(" ");
				expect(Number(writerPid)).toBe(winners[0]?.pid as number);
				expect([...tokensSeen], summary).toEqual([writerToken as string]);

				// Every loser was told the truth: someone else is running.
				for (const loser of reports.filter((r) => !r.acquired)) {
					expect(loser.reason).toBe("already_running");
				}
			}
		},
		ROUNDS * (START_MARGIN_MS + HOLD_MS + 10_000),
	);
});
