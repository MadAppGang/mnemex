/**
 * Structured Index State
 *
 * Pure, read-only inspector for the current indexing situation. Companion to
 * buildFreshness(): where buildFreshness() reports the six flat freshness keys
 * from the in-memory state manager, buildIndexState() returns a richer, structured
 * block derived from cross-process truth (the lock file) + index.db presence +
 * tracker stats + the state manager.
 *
 * Read-only invariants:
 *  - Never mutates or removes the lock file (uses inspectLock, a liveness-probe only).
 *  - Never calls indexer.getStatus() (that triggers initialize(true), spinning up the
 *    embeddings client / vector store, which can throw). Stats mirror status.ts.
 *  - Requires NO reindexer / completionDetector (they are undefined outside --watch).
 */

import { existsSync, statSync } from "node:fs";
import { inspectLock } from "../core/lock.js";
import {
	getIndexDbPathFor,
	getLockPathFor,
	resolveStoreLocation,
} from "../core/store-location.js";
import type { ToolDeps } from "./tools/deps.js";

/** One of six mutually-exclusive index situations. */
export type IndexStatus =
	| "indexing_in_progress" // live lock, pid alive AND making forward progress
	| "indexing_hung" // live lock, pid alive but NO forward progress (LanceDB write hang); auto-reclaimed by next index
	| "stale_lock" // lock present but pid DEAD
	| "no_index" // no index.db
	| "stale" // index.db present, freshness=stale, no live lock
	| "fresh"; // index.db present, freshness=fresh, no live lock

/** Stats about the on-disk index. Always present (best-effort; safe fallbacks). */
export interface IndexInfo {
	/** Absolute path to the index directory (config.indexDir). */
	path: string;
	/** Files tracked in index.db. 0 if index absent or tracker unloadable. */
	indexedFileCount: number;
	/**
	 * Chunk count. NOT available from tracker.getStats() (which returns only
	 * { totalFiles, lastIndexed }). Computing it requires the vector store, which is
	 * expensive and may throw. Safe fallback: 0.
	 */
	chunkCount: number;
	/** Languages present in the index. Fallback: [] (not cheaply available read-only). */
	languages: string[];
	/** Size of index.db on disk in bytes. 0 if absent/unstatable. */
	indexSizeBytes: number;
	/** ISO timestamp of last successful index completion, or null. */
	lastIndexed: string | null;
	/** ISO timestamp staleness began (from stateManager), or null. */
	staleSince: string | null;
	/** Relative paths of files changed since last index (from stateManager). */
	filesChanged: string[];
}

/** Live/stale indexer detail derived from the lock file. null when no lock present. */
export interface IndexingInfo {
	/** Holder PID from the lock file. */
	pid: number;
	/** Human-readable start time (ISO) from the lock file (startedAt). */
	startedAt: string;
	/** ms since the lock's startTime (Date.now() - startTime). */
	elapsedMs: number;
	/** ISO timestamp of the lock's last heartbeat. */
	lastHeartbeat: string;
	/** heartbeat within HEARTBEAT_FRESH_TIMEOUT of now. Informational only. */
	isHeartbeatFresh: boolean;
	/**
	 * ISO timestamp of the lock's last forward progress (real indexing work).
	 * Falls back to the heartbeat timestamp for locks written by an older binary.
	 */
	lastProgressAt: string;
	/**
	 * forward progress within the progress timeout of now. A live pid with
	 * isProgressing=false is the hung-indexer signal (=> status indexing_hung).
	 */
	isProgressing: boolean;
	/** Whether the holder PID is alive (process.kill(pid, 0)). */
	pidAlive: boolean;
	/**
	 * Short label of WHAT the holder is doing (e.g. "writing:lance"), set by the
	 * indexer at phase transitions. undefined for locks written by an older binary
	 * (or before the first setPhase). Reporting only — never affects the status
	 * decision (which is driven by isProgressing / lastProgressAt).
	 */
	phase?: string;
	/**
	 * ms the holder has been in the current phase (now - phaseStartedAt). Present
	 * only when the lock carries a phase timestamp; undefined otherwise. Lets the
	 * report say "hung in phase 'writing:lance' for 6m".
	 */
	phaseStuckMs?: number;
	/**
	 * Command that started the indexer. The lock file does NOT carry this today
	 * ({ pid, startTime, heartbeat, startedAt } only). Always null in this refactor;
	 * populating it requires the lock WRITER (acquire()) to record it — out of scope.
	 */
	command: string | null;
}

/** The single object returned by buildIndexState and spread into tool responses. */
export interface IndexState {
	status: IndexStatus;
	/** True whenever an index.db exists (so cached results are usable), in ALL branches. */
	canReturnCachedResults: boolean;
	index: IndexInfo;
	/** Non-null only when a lock file is present (live or stale). */
	indexing: IndexingInfo | null;
	/** Case-specific, conservative. stale_lock recommendation is informational only. */
	recommendations: string[];
	/** One-line human-readable summary of the current state. */
	message: string;
}

/**
 * Heartbeat-freshness window for the informational isHeartbeatFresh flag.
 * Deliberately LARGER than acquisition's 10s stale window (DEFAULT_STALE_TIMEOUT) because:
 *  - the flag is purely informational; pid-alive ALWAYS => indexing_in_progress, so a
 *    "not fresh" flag never changes the status verdict;
 *  - the detached reindex heartbeat is a 1s setInterval that can stall when the event
 *    loop is busy, so a tight window yields false "not fresh".
 * 30s satisfies the validation matrix: case 1 (just-written heartbeat) => true;
 * case 2b (60s-old heartbeat) => false.
 */
export const HEARTBEAT_FRESH_TIMEOUT = 30000;

/**
 * Companion to buildFreshness(). Read-only. Async (cache.get() is async).
 * Derives everything from: lock file (via inspectLock) + index.db presence + tracker
 * stats + stateManager.getFreshness(). Requires NO reindexer/completionDetector.
 *
 * Deliberately does NOT re-emit the six buildFreshness keys (freshness, lastIndexed,
 * staleSince, filesChanged, reindexingInProgress, responseTimeMs); callers spread BOTH
 * objects and the spreads must not collide. The lastIndexed/staleSince/filesChanged
 * values live here only NESTED under `index.*`.
 *
 * @param startTime accepted for symmetry with buildFreshness; timing lives in
 *                  buildFreshness's responseTimeMs, so this builder emits no timing field.
 */
export async function buildIndexState(
	deps: ToolDeps,
	_startTime: number,
): Promise<IndexState> {
	const { config, stateManager, cache } = deps;

	const freshness = stateManager.getFreshness();

	// index.db and the lock come from ONE resolved store location, the same
	// derivation as createStoreLock (decision I-8), so they cannot name two
	// different stores.
	const storeLocation = resolveStoreLocation(config.workspaceRoot);
	const indexDbPath = getIndexDbPathFor(storeLocation);
	const hasIndex = existsSync(indexDbPath);
	const lockPath = getLockPathFor(storeLocation);
	const inspect = inspectLock(lockPath, HEARTBEAT_FRESH_TIMEOUT);

	// ── Read-only stats (mirror status.ts; never throws) ──────────────────────
	let indexSizeBytes = 0;
	let indexedFileCount = 0;
	let lastIndexed: string | null = freshness.lastIndexed; // authoritative (stateManager)
	const chunkCount = 0; // SAFE FALLBACK — not available from tracker.getStats()
	const languages: string[] = []; // SAFE FALLBACK — not cheaply available read-only

	if (hasIndex) {
		try {
			indexSizeBytes = statSync(indexDbPath).size;
		} catch {
			// Ignore stat errors
		}
		try {
			const { tracker } = await cache.get();
			const stats = tracker.getStats();
			indexedFileCount = stats.totalFiles;
			if (!lastIndexed && stats.lastIndexed) {
				lastIndexed = stats.lastIndexed;
			}
		} catch {
			// "index.db present but tracker unloadable" edge case: degrade counts to
			// fallbacks but KEEP canReturnCachedResults = true (driven by file existence).
		}
	}

	const index: IndexInfo = {
		path: config.indexDir,
		indexedFileCount,
		chunkCount,
		languages,
		indexSizeBytes,
		lastIndexed,
		staleSince: freshness.staleSince,
		filesChanged: freshness.filesChanged,
	};

	// canReturnCachedResults is independent of status — set BEFORE the switch.
	const canReturnCachedResults = hasIndex;

	let indexing: IndexingInfo | null = null;
	let status: IndexStatus;
	const recommendations: string[] = [];
	let message: string;

	if (inspect.present) {
		// A lock file exists (live, hung, or stale).
		indexing = {
			pid: inspect.pid,
			startedAt: inspect.startedAt,
			elapsedMs: inspect.elapsedMs,
			lastHeartbeat: new Date(inspect.heartbeat).toISOString(),
			isHeartbeatFresh: inspect.isHeartbeatFresh,
			lastProgressAt: new Date(inspect.lastProgressAt).toISOString(),
			isProgressing: inspect.isProgressing,
			pidAlive: inspect.pidAlive,
			// Phase fields are surfaced as-is (no fallback): undefined for older locks.
			phase: inspect.phase,
			phaseStuckMs: inspect.phaseStuckMs,
			command: null,
		};

		if (!inspect.pidAlive) {
			// pid is dead => the lock is definitively stale (holder gone).
			status = "stale_lock";
			recommendations.push(
				`Lock file present but holder PID ${inspect.pid} is not running — the lock appears stale.`,
			);
			recommendations.push(
				`This is informational; no lock was removed. If you are sure no indexer is running, clear it manually (e.g. run 'mnemex index --force-unlock' or delete ${lockPath}).`,
			);
			if (canReturnCachedResults) {
				recommendations.push(
					"Cached results from the previous index are still available.",
				);
			}
			message = `Stale lock detected (PID ${inspect.pid} not running).`;
		} else if (inspect.isProgressing) {
			// pid alive AND advancing lastProgressAt => genuinely indexing.
			status = "indexing_in_progress";
			const elapsedSec = Math.round(inspect.elapsedMs / 1000);
			recommendations.push(
				`An indexer (PID ${inspect.pid}) is currently running (started ${inspect.startedAt}, ~${elapsedSec}s ago).`,
			);
			if (canReturnCachedResults) {
				recommendations.push(
					"Cached results are available now and may be slightly out of date.",
				);
			}
			recommendations.push(
				"To wait for completion, call reindex with blocking:true, or retry shortly.",
			);
			message = `Indexing in progress (PID ${inspect.pid}, heartbeat ${
				inspect.isHeartbeatFresh ? "fresh" : "stale"
			}).`;
		} else {
			// pid alive but NO forward progress within the progress timeout =>
			// hung (e.g. wedged in a LanceDB write). The heartbeat may still look
			// fresh, which is exactly why heartbeat alone misses this.
			status = "indexing_hung";
			const sinceProgressSec = Math.max(
				0,
				Math.round((Date.now() - inspect.lastProgressAt) / 1000),
			);
			// Phase enrichment is ADDITIVE and conditional: only mention the phase
			// when the lock carries one (older locks have none). The literal
			// substrings "HUNG"/"reclaimed automatically" are preserved on BOTH
			// paths so the report stays stable and the hung decision is unchanged.
			const inPhase = inspect.phase ? ` in phase '${inspect.phase}'` : "";
			recommendations.push(
				`Indexer (PID ${inspect.pid}) appears HUNG${inPhase}: it is alive but has made no indexing progress for ~${sinceProgressSec}s.`,
			);
			recommendations.push(
				`It will be reclaimed automatically by the next index run; or force-unlock now (run 'mnemex index --force-unlock' or delete ${lockPath}).`,
			);
			if (canReturnCachedResults) {
				recommendations.push(
					"Cached results from the previous index are still available in the meantime.",
				);
			}
			message = `Indexer appears hung (PID ${inspect.pid}${inPhase}, no progress for ~${sinceProgressSec}s).`;
		}
	} else {
		// No (parseable) lock file.
		if (!hasIndex) {
			status = "no_index";
			recommendations.push(
				"No index found. Run index_codebase (or 'mnemex index') to create one.",
			);
			message = "No index available.";
		} else if (freshness.freshness === "stale") {
			status = "stale";
			recommendations.push(
				`Index is stale (${freshness.filesChanged.length} file(s) changed since last index).`,
			);
			recommendations.push(
				"Results may be out of date; call reindex to refresh.",
			);
			message = "Index available but stale.";
		} else {
			status = "fresh";
			message = "Index is fresh.";
		}
	}

	return {
		status,
		canReturnCachedResults,
		index,
		indexing,
		recommendations,
		message,
	};
}
