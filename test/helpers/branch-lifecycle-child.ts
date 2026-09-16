/**
 * N REAL index runs in a sandboxed child, with the clock moved forward — the
 * process boundary V3.8's three checkpoints need (architecture §4.3).
 *
 * WHY A CHILD. `index()` reads `~/.mnemex/config.json` and opens the machine-
 * global embed cache, and Bun's `homedir()` ignores a runtime `HOME`
 * reassignment (CLAUDE.md #25, #31). Only a child process can be pointed
 * somewhere safe, and `sandbox-guard.ts` refuses to start unless it provably
 * has been.
 *
 * WHY THE CLOCK IS INJECTED HERE AND NOT PASSED IN AN ENV VAR. `clock.ts`'s
 * `__setClockForTests` swaps a VALUE (what time the registry believes it is);
 * it gates nothing, so it is not CLAUDE.md #24's shape. An env var would be a
 * production read of test state, inherited by every further child.
 *
 * WHY N RUNS IN ONE PROCESS. `BRANCH_CONFIRM_INTERVAL` is 20, so a checkpoint
 * costs 20 runs and the criterion needs two checkpoints. Paying a process
 * launch each time is the difference between a 30 s test and a 5 minute one.
 * The `Indexer` is constructed fresh per run anyway, so nothing is memoized
 * across them that would not be memoized across processes — except the store
 * location cache, which is keyed on the same inputs a second process would
 * read.
 *
 * NOTHING HERE JUDGES. It runs and prints what happened; the parent asserts
 * through its own connections.
 *
 * argv: <projectDir> <runs> <clockOffsetMs>
 */

import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { __setClockForTests } from "../../src/core/clock.js";
import { createIndexer } from "../../src/core/indexer.js";
import { exitUnlessSandboxed } from "./sandbox-guard.js";

exitUnlessSandboxed(homedir(), process.env.MNEMEX_TEST_SANDBOX_HOME, tmpdir());

function insideTmp(path: string | undefined): boolean {
	if (path === undefined) return false;
	return [tmpdir(), realpathSync.native(tmpdir())].some((t) =>
		path.startsWith(t),
	);
}
for (const name of ["MNEMEX_EMBED_CACHE_PATH", "MNEMEX_GLOBAL_LOCK_PATH"]) {
	if (!insideTmp(process.env[name])) {
		console.error(`${name} must point inside tmpdir()`);
		process.exit(64);
	}
}

const [projectDir, runsArg, offsetArg] = process.argv.slice(2);
const runs = Number(runsArg);
const offsetMs = Number(offsetArg ?? "0");
if (!projectDir || !Number.isSafeInteger(runs) || runs < 1) {
	console.error(
		"usage: branch-lifecycle-child <projectDir> <runs> [clockOffsetMs]",
	);
	process.exit(64);
}

// Every timestamp the registry writes and every comparison the confirm pass
// makes moves by this much. `Date.now()` is still the real clock everywhere
// else, which is what keeps the run's own durations honest.
if (offsetMs !== 0) __setClockForTests(() => Date.now() + offsetMs);

const summaries: Array<Record<string, unknown>> = [];
for (let i = 0; i < runs; i++) {
	const indexer = createIndexer({
		projectPath: projectDir,
		enableEnrichment: false,
	});
	try {
		const result = await indexer.index(false);
		summaries.push({
			run: i + 1,
			filesIndexed: result.filesIndexed,
			branch: result.branch ?? null,
		});
	} finally {
		await indexer.close();
	}
}

console.log(
	`RESULT ${JSON.stringify({
		runs,
		offsetMs,
		// The last run's branch report, plus every run that DID something to the
		// lifecycle — a 20-run checkpoint prints 20 near-identical lines
		// otherwise, and the parent asserts on the store, not on these.
		last: summaries[summaries.length - 1],
		lifecycle: summaries.filter((s) => {
			const branch = s.branch as Record<string, unknown> | null;
			return (
				branch !== null &&
				(Number(branch.branchesUnconfirmed) > 0 ||
					Number(branch.branchesTombstoned) > 0 ||
					Number(branch.sweepRowsDeleted) > 0 ||
					Number(branch.sweepBranchesFinalized) > 0)
			);
		}),
	})}`,
);
process.exit(0);
