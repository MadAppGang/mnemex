/**
 * V3.15's contender (architecture §3.4, REG-1).
 *
 * argv: <projectDir> <labelPrefix> <iterations>
 *
 * Each iteration takes the REAL store lock, opens the branch registry under it,
 * allocates the label `<prefix>-<i>`, writes one `files` row carrying the id,
 * flushes the registry and releases the lock. That is the order
 * `Indexer.indexInternal` uses. Two of these run at once against one store, and
 * the parent reads `branches.json` and `index.db` itself.
 *
 * stdout: one `ALLOC {"label","id"}` line per iteration. A lost update shows as
 * an ALLOC the final file does not hold, or as two children given one id.
 */

import { join } from "node:path";
import { openRegistry } from "../../src/core/branch-registry.js";
import { createStoreLock } from "../../src/core/lock.js";
import {
	getIndexDbPathFor,
	resolveStoreLocation,
} from "../../src/core/store-location.js";
import { FileTracker } from "../../src/core/tracker.js";

const [projectDir, prefix, iterationsArg] = process.argv.slice(2);
const iterations = Number(iterationsArg);
if (!projectDir || !prefix || !Number.isInteger(iterations) || iterations < 1) {
	console.error(
		"usage: registry-race-child <projectDir> <prefix> <iterations>",
	);
	process.exit(64);
}

const loc = resolveStoreLocation(projectDir);
const tracker = new FileTracker(getIndexDbPathFor(loc), projectDir);

for (let i = 0; i < iterations; i++) {
	const lock = createStoreLock(loc);
	const taken = await lock.acquire({ waitTimeout: 120_000, pollInterval: 5 });
	if (!taken.acquired) {
		console.error(`store lock not acquired: ${taken.reason}`);
		process.exit(2);
	}
	try {
		const registry = openRegistry(loc, lock, tracker);
		const label = `${prefix}-${i}`;
		const id = registry.resolveId({
			label,
			kind: "branch",
			ref: `refs/heads/${label}`,
		});
		tracker.markIndexed(id, join(loc.pathRoot, "f", `${label}.ts`), "h", []);
		registry.flush();
		console.log(`ALLOC ${JSON.stringify({ label, id })}`);
	} finally {
		lock.release();
	}
}

tracker.close();
process.exit(0);
