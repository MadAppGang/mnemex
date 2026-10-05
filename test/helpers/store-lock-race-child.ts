/**
 * One contender in the V2.5 race: take the store lock for `<startPath>` at
 * exactly `<startAtEpochMs>`, and if it is won, "write" by appending one line
 * to `<logPath>`, hold for `<holdMs>`, release.
 *
 * argv: <startPath> <startAtEpochMs> <holdMs> <logPath>
 *
 * Imports the lock and the seam only: no entry point, no keychain, no config.
 * Prints one JSON line on stdout: { pid, acquired, reason, arrivedEarlyMs }.
 */

import { appendFileSync } from "node:fs";
import { createStoreLock } from "../../src/core/lock.js";
import { resolveStoreLocation } from "../../src/core/store-location.js";

const [startPath, startAtRaw, holdRaw, logPath] = process.argv.slice(2);
if (!startPath || !startAtRaw || !holdRaw || !logPath) {
	console.error(
		"usage: store-lock-race-child <startPath> <startAt> <holdMs> <logPath>",
	);
	process.exit(64);
}

// Resolve and construct BEFORE the barrier, so every contender starts the race
// at the syscall that decides it.
const lock = createStoreLock(resolveStoreLocation(startPath));
const startAt = Number(startAtRaw);
const arrivedEarlyMs = startAt - Date.now();

// Spin rather than sleep: a timer wakes on the scheduler's schedule, and a race
// whose contenders start milliseconds apart barely races.
while (Date.now() < startAt) {
	// busy-wait
}

const result = await lock.acquire({ waitTimeout: 0 });
if (result.acquired) {
	// The one thing exactly one contender may do.
	appendFileSync(logPath, `${process.pid} ${lock.ownershipToken}\n`);
	await Bun.sleep(Number(holdRaw));
	lock.release();
}

process.stdout.write(
	`${JSON.stringify({
		pid: process.pid,
		acquired: result.acquired,
		reason: result.reason ?? null,
		arrivedEarlyMs,
	})}\n`,
);
