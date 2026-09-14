/**
 * Append one session observation to the store, under the store lock.
 *
 * The one write path for `mnemex observe` and the MCP `observe` tool, so both
 * follow decision D5: wait `OBSERVE_LOCK_WAIT_MS` (2 s) for the store lock, then
 * DEGRADE. The append is skipped and the caller warns once. Nothing is written
 * without the lock.
 *
 * The embedding is computed by the caller BEFORE this is called. It is a
 * network call, and the lock is held for the write alone.
 *
 * Both callers used to pass the PROJECT path to `createVectorStore`, which takes
 * the VECTORS path. That opened a LanceDB database in the project root, a store
 * no search reads. Here the vectors path is resolved the same way the indexer
 * resolves it.
 */

import { getVectorStorePath } from "../config.js";
import type { DocumentWithEmbedding } from "../types.js";
import { createVectorStore } from "./store.js";
import { resolveStoreLocation } from "./store-location.js";
import {
	describeStoreLockRefusal,
	OBSERVE_LOCK_WAIT_MS,
	withStoreLock,
} from "./store-lock-policy.js";

export type ObserveOutcome =
	| { recorded: true }
	| {
			recorded: false;
			/** `store_locked`: another writer held it past the wait. `lock_error`: it could not be taken at all. */
			reason: "store_locked" | "lock_error";
			holderPid?: number;
			/** One line for the user: who holds the lock, or what failed. */
			detail: string;
	  };

export async function appendObservation(
	projectPath: string,
	doc: DocumentWithEmbedding,
): Promise<ObserveOutcome> {
	const storeLocation = resolveStoreLocation(projectPath);
	const outcome = await withStoreLock(
		storeLocation,
		{ waitTimeout: OBSERVE_LOCK_WAIT_MS, phase: "observe" },
		async (lock) => {
			const store = createVectorStore({
				vectorsDir: getVectorStorePath(projectPath),
				pathRoot: storeLocation.pathRoot,
			});
			try {
				await store.addDocuments([doc]);
				lock.recordProgress();
			} finally {
				await store.close();
			}
		},
	);
	if (outcome.acquired) return { recorded: true };
	return {
		recorded: false,
		reason: outcome.refusal.reason === "error" ? "lock_error" : "store_locked",
		holderPid: outcome.refusal.holderPid,
		detail: describeStoreLockRefusal(outcome.refusal, outcome.lockPath),
	};
}

let observeSkipWarned = false;

/**
 * `true` the first time it is called in this process, `false` after. D5 says a
 * skipped observation warns ONCE: in a long-lived MCP server, one warning per
 * index run is signal, and one per call is noise.
 */
export function claimObserveSkipWarning(): boolean {
	if (observeSkipWarned) return false;
	observeSkipWarned = true;
	return true;
}
