/**
 * Hold the store lock for `<startPath>` until stdin closes (or SIGTERM), so a
 * test can run a writer against a store that another PROCESS has locked.
 *
 * argv: <startPath>
 *
 * Prints `HELD <pid> <token> <lockPath>` once the lock is held, or
 * `REFUSED <reason>` and exits 2. Imports the lock and the seam only: no entry
 * point, no keychain, no config.
 */

import { createStoreLock } from "../../src/core/lock.js";
import { resolveStoreLocation } from "../../src/core/store-location.js";

const startPath = process.argv[2];
if (!startPath) {
	console.error("usage: store-lock-holder-child <startPath>");
	process.exit(64);
}

const lock = createStoreLock(resolveStoreLocation(startPath));
const result = await lock.acquire({ waitTimeout: 10_000, pollInterval: 50 });
if (!result.acquired) {
	console.log(`REFUSED ${result.reason}`);
	process.exit(2);
}

const releaseAndExit = () => {
	lock.release();
	process.exit(0);
};
process.on("SIGTERM", releaseAndExit);
process.on("SIGINT", releaseAndExit);

console.log(`HELD ${process.pid} ${lock.ownershipToken} ${lock.path}`);

// Hold until the parent closes our stdin. The open stream also keeps the event
// loop alive, so the 1 s heartbeat keeps stamping for as long as we hold.
for await (const _chunk of Bun.stdin.stream()) {
	// drain
}
releaseAndExit();
