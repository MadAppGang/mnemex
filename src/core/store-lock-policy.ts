/**
 * The lock policy for the store's writers OTHER than `mnemex index` (decision
 * D5, `architecture.md` §5.2).
 *
 * `observe`, `docs fetch` and `docs clear` used to write to LanceDB holding no
 * lock at all. They now take the same store lock the indexer takes
 * (`createStoreLock`, beside the data), each with a wait chosen for its profile:
 *
 *   observe      wait OBSERVE_LOCK_WAIT_MS (2 s), then DEGRADE: skip the append
 *                and warn once. A single-row append on an interactive MCP/hook
 *                path is not worth a perceived hang behind an index run.
 *   docs fetch   hold the lock for the WRITE phase only, never across the network
 *                fetch or the embedding call. Holding an index lock across
 *                network I/O is unbounded by construction.
 *   docs clear   wait STORE_WRITER_LOCK_WAIT_MS (30 s), then REFUSE loudly and
 *                exit non-zero. It is destructive and user-initiated.
 *
 * Fail-closed in every case: none of them writes without the lock.
 *
 * IMPORTS: `./lock.js` and a type from `./store-location.js`, nothing else, so
 * the policy can be tested without LanceDB, config or a credential read.
 */

import { createStoreLock, type IIndexLock, type LockResult } from "./lock.js";
import type { StoreLocation } from "./store-location.js";

/** D5: `observe` waits this long, then skips the append rather than hang. */
export const OBSERVE_LOCK_WAIT_MS = 2_000;

/** D5: `docs fetch` (write phase) and `docs clear` wait this long, then refuse. */
export const STORE_WRITER_LOCK_WAIT_MS = 30_000;

/**
 * How often a waiting writer re-tries. A tenth of the observe wait, so a lock
 * released a moment after the first try is noticed well inside the 2 s.
 */
export const STORE_WRITER_POLL_MS = 200;

export interface StoreLockPolicy {
	/** How long to wait for the current holder (ms) before giving up. */
	waitTimeout: number;
	/** Recorded on the lock, so `inspectLock` and the MCP status say what holds it. */
	phase: string;
	/** Called while waiting; the CLI uses it to say who it is waiting for. */
	onWaiting?: (holderPid: number, waitedMs: number) => void;
}

export type StoreLockOutcome<T> =
	| { acquired: true; value: T }
	| { acquired: false; refusal: LockResult; lockPath: string };

/**
 * Run `fn` holding the store lock for `loc`, or do not run it at all.
 *
 * The lock is released in a `finally`, including when `fn` throws; the error
 * then propagates. `fn` receives the lock so a longer write can stamp
 * `recordProgress()` per unit of work (CLAUDE.md #20).
 */
export async function withStoreLock<T>(
	loc: StoreLocation,
	policy: StoreLockPolicy,
	fn: (lock: IIndexLock) => Promise<T>,
): Promise<StoreLockOutcome<T>> {
	const lock = createStoreLock(loc);
	const result = await lock.acquire({
		waitTimeout: policy.waitTimeout,
		pollInterval: STORE_WRITER_POLL_MS,
		onWaiting: policy.onWaiting,
	});
	if (!result.acquired) {
		return { acquired: false, refusal: result, lockPath: lock.path };
	}
	try {
		lock.setPhase(policy.phase);
		return { acquired: true, value: await fn(lock) };
	} finally {
		lock.release();
	}
}

/** One line naming who holds the lock, or why it could not be taken. */
export function describeStoreLockRefusal(
	refusal: LockResult,
	lockPath: string,
): string {
	if (refusal.reason === "error") {
		return `the store lock at ${lockPath} could not be taken: ${refusal.errorMessage ?? "unknown error"}`;
	}
	const holder =
		refusal.holderPid !== undefined
			? `PID ${refusal.holderPid}`
			: "another process";
	const heldFor =
		refusal.runningFor !== undefined
			? ` (held for ${Math.round(refusal.runningFor / 1000)}s)`
			: "";
	return `${holder} holds the store lock at ${lockPath}${heldFor}`;
}
