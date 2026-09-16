/**
 * Code Indexer
 *
 * Orchestrates the indexing process: file discovery, chunking,
 * embedding generation, and storage.
 */

import {
	existsSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
} from "node:fs";
import { join, relative } from "node:path";
import {
	ensureProjectDir,
	getDocsConfig,
	getEmbeddingModel,
	getExcludePatterns,
	getIndexDbPath,
	getModelMismatchMode,
	getVectorStorePath,
	isDocsEnabled,
	isEnrichmentEnabled,
	isVectorEnabled,
	loadGlobalConfig,
	loadProjectConfig,
} from "../config.js";
import { createDocsFetcher, type DocsFetcher } from "../docs/index.js";
import { createLLMClient } from "../llm/client.js";
import { getParserManager } from "../parsers/parser-manager.js";
import {
	shouldExclude as sharedShouldExclude,
	shouldInclude as sharedShouldInclude,
} from "../shared/pattern-matcher.js";
import type {
	ChunkWithEmbedding,
	CodeChunk,
	CodeUnit,
	CodeUnitWithEmbedding,
	EmbeddingProvider,
	EmbedResult,
	EnrichedIndexResult,
	EnrichmentResult,
	IEmbeddingsClient,
	ILLMClient,
	IndexEmbedCacheStats,
	IndexResult,
	IndexStatus,
	SearchOptions,
	SearchResult,
	SupportedLanguage,
} from "../types.js";
import {
	type CodeUnitExtractor,
	createCodeUnitExtractor,
} from "./ast/code-unit-extractor.js";
import {
	BRANCH_SOFT_LIMIT,
	type ConfirmScanResult,
	confirmScan,
	isLiveEntry,
	shouldConfirmBranches,
} from "./branch-lifecycle.js";
import {
	canonicalBranchIds,
	describeRemoval,
	drainWidenIntents,
	narrowIds,
	recoverCrashResidue,
	removeFileFromBranch,
} from "./branch-membership.js";
import {
	BRANCH_ID_SHARED,
	type BranchRegistry,
	combineBranchIdSources,
	openRegistry,
	readBranchRegistry,
} from "./branch-registry.js";
import {
	graphBranchIdForRead,
	labelBranchIds,
	resolveBranchScopeForRead,
} from "./branch-scope.js";
import { branchHoldsNoRows } from "./branch-state.js";
import {
	completeInterruptedSweep,
	type NarrowBranchResult,
	narrowBranch,
	type SweepResult,
	sweepTombstonedBranches,
} from "./branch-sweep.js";
import {
	CachingEmbeddingsClient,
	createCachingEmbeddingsClient,
} from "./caching-embeddings-client.js";
import { chunkFileByPath } from "./chunker.js";
import {
	type EmbedCacheLike,
	type EmbedCacheTier,
	openEmbedCache,
	resolveEmbedCacheMode,
} from "./embed-cache.js";
import {
	createEmbeddingsClient,
	embeddingTextFingerprint,
	testModelAvailability,
} from "./embeddings.js";
import {
	createEnricher,
	type Enricher,
	type FileToEnrich,
} from "./enrichment/index.js";
import { readCurrentHead } from "./git-layout.js";
import { CURRENT_INDEX_VERSION, setIndexVersion } from "./index-version.js";
import {
	formatInvalidationCounts,
	invalidateForCommit,
} from "./invalidation.js";
import {
	createGlobalIndexLock,
	createStoreLock,
	type IIndexLock,
	type IndexLock,
	type LockOptions,
} from "./lock.js";
import { createReferenceGraphManager } from "./reference-graph.js";
import { createRepoMapGenerator } from "./repo-map.js";
import { toRepoRelative } from "./repo-path.js";
import {
	createVectorStore,
	type IVectorStore,
	type RowMembership,
} from "./store.js";
import { resolveStoreLocation, type StoreLocation } from "./store-location.js";
import {
	probeOldStore,
	readStoreRebuildAt,
	readStoreState,
	type SweepCursor,
	stampStoreRebuild,
	writeStoreState,
} from "./store-meta.js";
import { createSymbolExtractor } from "./symbol-extractor.js";
import { yieldToEventLoop } from "./sync-region.js";
import {
	type ChunkIndexRow,
	computeFileHash,
	computeHash,
	createFileTracker,
	type FileChanges,
	type FileStamp,
	type IFileTracker,
} from "./tracker.js";

// ============================================================================
// Index version 4 helpers
// ============================================================================

/**
 * §6.1's probe of the store being replaced: the store directory first, then
 * the per-worktree directory. Until Phase 3c they are the same directory
 * unless indexing starts below the worktree root. From 3c on the store moves
 * under the git common dir, and the per-worktree directory is the store being
 * replaced. `null` means fresh, with nothing to upgrade and nothing to report.
 */
function probeStoreBeingReplaced(
	loc: StoreLocation,
): { readonly dir: string; readonly recordedVersion: number | null } | null {
	for (const dir of [loc.storeDir, loc.worktreeDir]) {
		const probe = probeOldStore(dir);
		if (probe.exists) return { dir, recordedVersion: probe.recordedVersion };
	}
	return null;
}

/** `realpathSync.native(path)`, or `path` itself when that fails. */
function realpathOrSelf(path: string): string {
	try {
		return realpathSync.native(path);
	} catch {
		return path;
	}
}

// ============================================================================
// The id algebra's bookkeeping (architecture §4.1.1)
// ============================================================================

/** One `chunk_index` registration. `path` is already in STORED form (§3.1). */
function chunkIndexRowFor(
	chunkId: string,
	path: string,
	contentHash: string,
	rowClass: ChunkIndexRow["rowClass"],
): ChunkIndexRow {
	return { chunkId, pathKind: "repo", path, contentHash, rowClass };
}

/** `newIds` per file, for NARROW_CHUNKS. Every chunk, widened or inserted. */
function chunkIdsByFile(
	chunks: ReadonlyArray<{ chunk: { id: string }; filePath: string }>,
): Map<string, Set<string>> {
	const byFile = new Map<string, Set<string>>();
	for (const { chunk, filePath } of chunks) {
		const ids = byFile.get(filePath);
		if (ids === undefined) byFile.set(filePath, new Set([chunk.id]));
		else ids.add(chunk.id);
	}
	return byFile;
}

/** `newIds` per file, for NARROW_UNITS. */
function unitIdsByFile(
	units: ReadonlyArray<{ unit: { id: string }; filePath: string }>,
): Map<string, Set<string>> {
	const byFile = new Map<string, Set<string>>();
	for (const { unit, filePath } of units) {
		const ids = byFile.get(filePath);
		if (ids === undefined) byFile.set(filePath, new Set([unit.id]));
		else ids.add(unit.id);
	}
	return byFile;
}

/**
 * The `files` stamps R5b commits for one batch: one per file that was NOT
 * deferred, carrying the file's WHOLE chunk id set (widened and inserted).
 *
 * `mtime` is read here, outside every region — a `statSync` inside one would be
 * blocking that the region's clamp does not bound. A file that vanished between
 * the chunking and this call stamps `Date.now()`, which makes the next run's
 * mtime comparison miss and fall through to the content-hash compare: extra
 * hashing, never a wrong answer (§3.5).
 */
function fileStampsFor(
	chunks: ReadonlyArray<{
		chunk: { id: string };
		filePath: string;
		fileHash: string;
	}>,
	deferred: ReadonlySet<string>,
	storedPathOf: ReadonlyMap<string, string>,
	pathRoot: string,
): FileStamp[] {
	const stamps: FileStamp[] = [];
	const seen = new Map<string, FileStamp>();
	for (const { chunk, filePath, fileHash } of chunks) {
		if (deferred.has(filePath)) continue;
		const existing = seen.get(filePath);
		if (existing !== undefined) {
			existing.chunkIds.push(chunk.id);
			continue;
		}
		const storedPath =
			storedPathOf.get(filePath) ?? toRepoRelative(pathRoot, filePath);
		if (storedPath === null) continue;
		let mtime: number;
		try {
			mtime = statSync(filePath).mtimeMs;
		} catch {
			mtime = Date.now();
		}
		const stamp: FileStamp = {
			storedPath,
			contentHash: fileHash,
			mtime,
			chunkIds: [chunk.id],
		};
		seen.set(filePath, stamp);
		stamps.push(stamp);
	}
	return stamps;
}

// ============================================================================
// Errors
// ============================================================================

/**
 * Error thrown when search uses a different embedding model than indexing
 */
export class EmbeddingModelMismatchError extends Error {
	constructor(
		public storedModel: string,
		public requestedModel: string,
	) {
		super(
			`Embedding model mismatch!\n` +
				`  Index was created with: ${storedModel}\n` +
				`  You're trying to use: ${requestedModel}\n\n` +
				`Solutions:\n` +
				`  1. Use the same model: mnemex search --model ${storedModel} "query"\n` +
				`  2. Reindex with new model: mnemex index --force --model ${requestedModel}\n` +
				`  3. Let mnemex auto-detect: mnemex search "query" (uses stored model)`,
		);
		this.name = "EmbeddingModelMismatchError";
	}
}

/**
 * Error thrown when the model an index was built with cannot be reached.
 *
 * Raised only under `onModelMismatch: "use-indexed"`, which keeps the stored
 * vectors and adopts the model that produced them. If that model cannot embed,
 * there is no honest way to continue: a query embedded by any other model
 * lands in a different vector space and the results would be noise. Failing
 * here leaves the index untouched, so both exits below stay open.
 */
export class IndexedModelUnavailableError extends Error {
	constructor(
		public storedModel: string,
		public providerError: string,
		public storedProvider?: EmbeddingProvider,
	) {
		// An index written before providers were recorded gives the reader a
		// second, likelier explanation than "the model is down": the request went
		// to whatever provider the config names today, which may never have heard
		// of this model. Saying so is the difference between a fixable error and
		// one whose stated remedies ("start the provider") change nothing.
		const provenance = storedProvider
			? `  Provider on record: ${storedProvider}\n`
			: `  This index predates provider recording, so the request used the provider your config names now.\n` +
				`  That is very likely the real problem, not the model being down.\n`;
		super(
			`The index was built with ${storedModel}, and that model is unavailable.\n` +
				provenance +
				`  Provider error: ${providerError}\n\n` +
				`Nothing was changed — the index is intact. Solutions:\n` +
				`  1. Make ${storedModel} reachable (start its provider, or pull the model)\n` +
				`  2. Rebuild with the model your config names:\n` +
				`     mnemex index --force   (or set "onModelMismatch": "force-model" in config)`,
		);
		this.name = "IndexedModelUnavailableError";
	}
}

/**
 * Narrow a provider name read back out of index metadata.
 *
 * Metadata is free-form text written by some earlier version of mnemex, so it
 * is not trustworthy as a union member. An unreadable value is dropped rather
 * than passed on, which lands on the same path as an index too old to have
 * recorded a provider at all — one behaviour to reason about, not two.
 */
function asEmbeddingProvider(
	value: string | null,
): EmbeddingProvider | undefined {
	const providers: EmbeddingProvider[] = [
		"openrouter",
		"ollama",
		"lmstudio",
		"local",
		"voyage",
	];
	return providers.find((p) => p === value);
}

/**
 * Decisions of one kind that W-R2 actually APPLIED.
 *
 * Applied, never proposed: a decision the lock-held registry dropped did not
 * happen, and a report that counted proposals would tell the user a branch was
 * tombstoned when it was not.
 */
function countDecisions(
	confirmation: { applied: readonly { set: string }[] } | null,
	set: "unconfirmedSince" | "deletedAt",
): number {
	if (confirmation === null) return 0;
	return confirmation.applied.filter((decision) => decision.set === set).length;
}

/**
 * Error thrown when indexing is already in progress by another process.
 *
 * `scope` distinguishes the PER-PROJECT lock ("project", default) from the
 * MACHINE-GLOBAL single-indexer lock ("global"). The 4th constructor arg is
 * optional and defaults to "project" so existing 3-arg call sites/tests are
 * unaffected.
 */
export class IndexLockError extends Error {
	constructor(
		public holderPid: number | undefined,
		public runningFor: number | undefined,
		public reason: "already_running" | "timeout" | "error",
		public scope: "project" | "global" = "project",
	) {
		const runningForSec =
			runningFor !== undefined ? Math.round(runningFor / 1000) : 0;
		const isGlobal = scope === "global";
		let message: string;
		if (reason === "error") {
			message =
				`Failed to acquire ${isGlobal ? "the machine-wide" : "the"} index lock.\n` +
				`  There may be a filesystem error or permissions issue.\n` +
				`  Try running with --force-unlock to clear any stale locks.`;
		} else if (reason === "timeout") {
			message = isGlobal
				? `Timed out waiting for a machine-wide index to complete.\n` +
					`  Another indexer (PID ${holderPid}) has been running for ${runningForSec}s.\n` +
					`  If it is stuck, use --force-unlock in that repo to clear its lock.`
				: `Timed out waiting for indexing to complete.\n` +
					`  Another process (PID ${holderPid}) has been indexing for ${runningForSec}s.\n` +
					`  If the process is stuck, use --force-unlock to clear the lock.`;
		} else {
			message = isGlobal
				? `A machine-wide index (PID ${holderPid}) is already running.\n` +
					`  It has been running for ${runningForSec}s.\n` +
					`  Only one indexer runs at a time across all repos on this machine.`
				: `Another process (PID ${holderPid}) is currently indexing.\n` +
					`  It has been running for ${runningForSec}s.\n` +
					`  Use --wait to wait for it to finish, or --force-unlock if it's stuck.`;
		}
		super(message);
		this.name = "IndexLockError";
	}
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Default max time (ms) a FOREGROUND indexer waits for the machine-global lock
 * before giving up. Generous because a legitimately-running index of a large repo
 * (embed + LanceDB write, possibly rate-limited) can take many minutes. Background
 * reindexers override this with `{ waitTimeout: 0 }` (try-acquire-bail).
 */
const DEFAULT_GLOBAL_LOCK_WAIT = 15 * 60 * 1000; // 15 minutes

// ============================================================================
// Types
// ============================================================================

interface IndexerOptions {
	/** Project root path */
	projectPath: string;
	/** Embedding model to use */
	model?: string;
	/** Additional exclude patterns */
	excludePatterns?: string[];
	/** Include only these patterns */
	includePatterns?: string[];
	/** Progress callback (inProgress = items currently being processed, for animation) */
	onProgress?: (
		current: number,
		total: number,
		file: string,
		inProgress?: number,
	) => void;
	/** Force re-index all files */
	force?: boolean;
	/** Enable LLM enrichment (default: from config) */
	enableEnrichment?: boolean;
	/** Concurrency for LLM enrichment requests (default: 10) */
	enrichmentConcurrency?: number;
	/** Lock options for concurrent access control (the PER-PROJECT lock) */
	lockOptions?: LockOptions;
	/**
	 * Lock options for the MACHINE-GLOBAL single-indexer lock. Defaults to WAIT
	 * (up to DEFAULT_GLOBAL_LOCK_WAIT). Pass `{ waitTimeout: 0 }` for
	 * try-acquire-bail — background reindexers (spawned `mnemex index --if-idle`)
	 * use this so they don't pile up as idle waiters when a machine-wide index is
	 * already running; they exit cleanly and the next debounce trigger retries.
	 */
	globalLockOptions?: LockOptions;
	/** Callback when waiting for another process to finish indexing (per-project) */
	onWaitingForLock?: (holderPid: number, waitedMs: number) => void;
	/** Callback when waiting for the machine-global indexer to finish */
	onWaitingForGlobalLock?: (holderPid: number, waitedMs: number) => void;
}

// ============================================================================
// Loop sizes for tracker work inside the index lock (SR-2)
// ============================================================================
//
// Every tracker call is ONE synchronous SQLite region, bounded by `tracker.ts`
// (`sync-region.ts`, THE ARITHMETIC: <= 500 ms each). That bound becomes a
// HEARTBEAT bound only if the event loop reaches its timers phase between two
// regions (SR-2, CLAUDE.md #31) — so every loop below that calls the tracker
// ends each region with `await yieldToEventLoop()`. Any other `await` does not
// count: an await on an already-resolved promise is a microtask, and the lock's
// 1 s heartbeat interval cannot run between microtasks.
//
// Swept by `test/unit/core/indexer-loop-sweep.test.ts`; measured from outside
// the process by `test/unit/core/indexer-heartbeat.test.ts` (V2.4).

/**
 * Rows per symbol/reference write: ONE `BEGIN IMMEDIATE` region (R-txn — R3 in
 * architecture §5.3's constants table) per `GRAPH_CHUNK` rows, a yield after
 * each.
 *
 * It lives HERE, at the call site, because `tracker.ts` has no region-size
 * constant: each tracker method is one region over whatever the caller passes,
 * so the caller decides the size. Move it into `tracker.ts` if R3 gets a
 * batched API of its own.
 *
 * Measured: one `insertSymbols` region costs ~0.4 ms at 128 rows and ~136 ms at
 * 50 000. At realistic sizes the YIELD, not this number, is what bounds the
 * heartbeat; this keeps each region near its measured cost.
 */
export const GRAPH_CHUNK = 128;

/**
 * Files per `getChanges()` call.
 *
 * `getChanges` is synchronous over every file it is given: one R1 SELECT over
 * the whole `files` table, a `statSync` per file, a content hash for every file
 * whose mtime moved, and an R-txn refreshing those mtimes. A shared store's
 * first run in a new worktree sees every mtime differ, so one call hashes the
 * whole repository in one block. The caller therefore feeds it slices, with a
 * yield between them.
 *
 * Every call re-reads the whole table (R1 has no chunk constant), so the NUMBER
 * of calls is capped at CHANGES_MAX_SLICES: the slice grows past CHANGES_SLICE
 * only beyond 128 000 files, instead of re-reading a million-row table 500
 * times.
 */
export const CHANGES_SLICE = 2000;
export const CHANGES_MAX_SLICES = 64;

// ============================================================================
// Indexer Class
// ============================================================================

/**
 * What one scoped search answered, D1's response-level flag included.
 *
 * `branchUnknown` is not a property of any row, so it cannot ride on
 * `SearchResult`. It must reach the MCP `search_code` response and `--agent`,
 * not only one CLI line (D1, required item 2).
 */
export interface BranchScopedSearch {
	readonly results: SearchResult[];
	/** D1: HEAD has no live registry entry, so the branch filter was DROPPED. */
	readonly branchUnknown: boolean;
	/** The HEAD label this search resolved, or null outside a repository. */
	readonly branchLabel: string | null;
	/**
	 * The registry KNOWS this branch and the store holds no row under its id —
	 * decision I-17 item 2, the state `branchUnknown` cannot report.
	 *
	 * `search` was the one surface that did not carry it. The graph commands say
	 * "this branch is not indexed"; the most-used command in the tool returned an
	 * empty list in silence, which is D1's own "empty fails INVISIBLY" argument
	 * landing on the wrong side. Always `false` when `branchUnknown` is true,
	 * outside a repository, and when there is no index at all — each of those is
	 * a different state with its own message. See `src/core/branch-state.ts` for
	 * what "empty" is computed from, and why it is computed from ROWS.
	 */
	readonly branchEmpty: boolean;
	/**
	 * V1.7 / §4.5: the store was rebuilt WHOLE after this branch was last
	 * indexed, which is WHY {@link branchEmpty} is true.
	 *
	 * Never true unless `branchEmpty` is — it is the explanation, not the signal
	 * (decision I-17 item 3). The rows-based signal covers every way of reaching
	 * an empty branch, including the ones no producer stamps a marker for; this
	 * adds the reason for the one case that is stamped, so a user is told
	 * "another worktree rebuilt this index" instead of "your branch is empty".
	 */
	readonly storeRebuiltElsewhere: boolean;
}

/**
 * `mnemex clear`'s blast radius, chosen by the caller and reported by the run.
 *
 * `"branch"` is the DEFAULT, for D3's reason: when an operation's blast radius
 * grows because the store became shared, the default must shrink, not stay.
 */
export type ClearScope = "branch" | "store";

/** What `Indexer.clear()` actually removed. */
export interface ClearResult {
	/**
	 * What the run DID, not what was asked. A store with no git layout reports
	 * `"store"` for a `"branch"` request, because there is one tree there and
	 * saying otherwise would be a lie (the same rule `force_scope` follows).
	 */
	readonly scope: ClearScope;
	/** The branch whose rows went, for a branch-scoped clear. */
	readonly branchLabel?: string | null;
	/** `chunk_branches` rows removed. 0 for a whole-store rebuild, which drops the table. */
	readonly membershipRowsRemoved: number;
	/** LanceDB rows deleted because no branch pointed at them any more. */
	readonly rowsDeleted: number;
	/** LanceDB rows another branch still holds, whose membership mirror was rewritten. */
	readonly rowsNarrowed?: number;
}

export class Indexer {
	private projectPath: string;
	private model: string;
	private modelExplicitlySet: boolean;
	private excludePatterns: string[];
	private includePatterns: string[];
	private onProgress?: (
		current: number,
		total: number,
		file: string,
		inProgress?: number,
	) => void;
	private enableEnrichment: boolean;
	private enrichmentConcurrency: number;
	private vectorEnabled: boolean;
	private lockOptions?: LockOptions;
	private globalLockOptions?: LockOptions;
	private onWaitingForLock?: (holderPid: number, waitedMs: number) => void;
	private onWaitingForGlobalLock?: (
		holderPid: number,
		waitedMs: number,
	) => void;

	/**
	 * THE SEAM. On every non-search initialisation this is a
	 * `CachingEmbeddingsClient` wrapping `rawEmbeddingsClient`; on a search
	 * initialisation it IS `rawEmbeddingsClient`, so the read path is byte-for-byte
	 * what it was before the cache existed (NFR-1).
	 *
	 * Assigned in exactly ONE place: `installEmbeddingsClient()`.
	 */
	private embeddingsClient: IEmbeddingsClient | null = null;
	/**
	 * The concrete provider client, never wrapped. The enricher takes THIS one:
	 * its entries are LLM-generated summaries that can never hit a
	 * content-addressed cache, so wrapping it would only add lookups that always
	 * miss.
	 *
	 * Assigned in exactly ONE place: `installEmbeddingsClient()`. Keeping both
	 * fields under one assignment is what stops the seam and the raw client from
	 * ever describing two different models — which is what happens when only the
	 * first of the two `createEmbeddingsClient()` sites is converted, because the
	 * second one (the `use-indexed` adoption) replaces the client wholesale.
	 */
	private rawEmbeddingsClient: IEmbeddingsClient | null = null;
	/**
	 * The machine-global embedding cache, opened by `index()` BEFORE either lock
	 * and `null` on every other path — including `clear()`, which initialises a
	 * client and never embeds, and must not create and DDL a file it will not use.
	 */
	private embedCache: EmbedCacheLike | null = null;
	/**
	 * `GlobalConfig.embedCache`, resolved once per `index()` run. `undefined`
	 * means the user never set it, which is ON — read with `=== false`, never for
	 * falsiness.
	 */
	private embedCacheConfigEnabled: boolean | undefined;
	/**
	 * Set by the index-v4 rebuild branch to the version being upgraded FROM, and
	 * surfaced on `IndexResult.upgradedFromIndexVersion`. `undefined` when the old
	 * store recorded no version (V4.8). Reset at the start of every run.
	 */
	private upgradedFromIndexVersion: number | undefined;
	private vectorStore: IVectorStore | null = null;
	private fileTracker: IFileTracker | null = null;
	private llmClient: ILLMClient | null = null;
	private enricher: Enricher | null = null;
	private indexLock: IndexLock | null = null;
	private globalLock: IIndexLock | null = null;
	private docsFetcher: DocsFetcher | null = null;
	/**
	 * Resolved BEFORE the index lock is acquired, and never re-resolved inside it.
	 *
	 * `getDocsConfig` -> `getContext7ApiKey()` -> a `Bun.spawnSync` against the
	 * macOS Keychain, and `Bun.spawnSync` BLOCKS the event loop, so the index lock's
	 * 1 s heartbeat cannot fire while it is outstanding. `isLockStale`'s secondary
	 * rule reclaims a lock whose heartbeat is older than 10 s regardless of pid
	 * liveness, so a stalled keychain inside the locked region can put a SECOND
	 * indexer on the same LanceDB store.
	 *
	 * WHAT THIS DOES NOT DO, corrected from an earlier claim that said otherwise:
	 * it does NOT eliminate keychain access from the locked region. `initialize()`
	 * runs INSIDE the lock and still resolves credentials there —
	 * `createEmbeddingsClient` -> `getApiKey`/`getVoyageApiKey`, and
	 * `createLLMClient` -> `getAnthropicApiKey`/`getApiKey`/`getOllamaApiKey`. The
	 * property that actually holds the bound is `KEYCHAIN_PROCESS_BUDGET_MS`'s
	 * PRE-FLIGHT CLAMP (`runGuarded` in `keychain.ts`): the sum of all `deps.run`
	 * time in a process is <= 6000 ms by construction and the longest contiguous
	 * block is one `SPAWN_TIMEOUT_MS` (3000 ms), so worst-case heartbeat staleness
	 * stays at 1000 + 6000 = 7000 ms against `DEFAULT_STALE_TIMEOUT` of 10000.
	 *
	 * Anyone raising `SPAWN_TIMEOUT_MS` or `KEYCHAIN_PROCESS_BUDGET_MS` must redo
	 * that arithmetic. Hoisting is a bonus here, not the guarantee.
	 */
	private docsConfigPreLock: ReturnType<typeof getDocsConfig> | null = null;
	/**
	 * §4.3 Phase A, hoisted out of BOTH locks and out of every `SyncRegion`.
	 *
	 * `null` means the pass is not running in this index run: no git layout, the
	 * interval has not come round, or the registry could not be read (which the
	 * lock-held open reports properly, with the remedy). A non-null value is a
	 * DECISION LIST and nothing more — `applyBranchDecisions` re-reads the
	 * registry under the lock and drops any decision the registry has outgrown.
	 *
	 * The split is REG-1's (§3.4). Revision 1 of the design hoisted the writes
	 * with the reads and all five round-2 reviewers raised it: `branches.json`
	 * is written only while the store lock is held, and the `packed-refs` read
	 * is the one part that must stay out of it.
	 *
	 * Reset at the start of every run: one `Indexer` serves more than one run
	 * (the MCP auto-reindex reuses one), and a stale scan describes a registry
	 * that has since been written.
	 */
	private confirmScanPreLock: ConfirmScanResult | null = null;
	private codeUnitExtractor: CodeUnitExtractor | null = null;

	/**
	 * Set when a search would embed its query with a model the index was not
	 * built with — see initialize(). Held rather than thrown so that the callers
	 * which never embed anything (status, keyword-only search) keep working.
	 */
	private searchModelMismatch: { stored: string; configured: string } | null =
		null;

	/**
	 * Set when this indexer used the model recorded in the INDEX instead of the
	 * configured one. Carried as state so it can be returned as data: a progress
	 * notice reaches no surface reliably (--agent passes no callback, the TTY
	 * renderer overwrites detail with "done", the MCP tool passes no callback),
	 * and a silent model substitution is the exact class of behaviour this
	 * release removes.
	 */
	private modelAdoption: { model: string; configuredModel: string } | null =
		null;

	/**
	 * Model/provider pairs already proved reachable by this indexer. One CLI
	 * search calls initialize(true) more than once (getStatus, then search), and
	 * each call would otherwise pay for the same probe again. Only successes are
	 * remembered: a failure must stay re-checkable, or starting the provider
	 * would not fix anything until the process restarts.
	 */
	private probedModels = new Set<string>();

	// Smart incremental reindexing: cache of old chunk vectors by contentHash
	// Used to reuse embeddings for unchanged content, saving API costs
	private oldChunksCache: Map<string, Map<string, number[]>> = new Map();

	constructor(options: IndexerOptions) {
		this.projectPath = options.projectPath;
		this.modelExplicitlySet = !!options.model;
		this.model = options.model || getEmbeddingModel(options.projectPath);
		// Get exclude patterns from config (includes defaults, gitignore, etc.)
		this.excludePatterns = [
			...getExcludePatterns(options.projectPath),
			...(options.excludePatterns || []),
		];
		// Get config options
		const projectConfig = loadProjectConfig(options.projectPath);
		this.includePatterns =
			options.includePatterns || projectConfig?.includePatterns || [];

		this.onProgress = options.onProgress;

		// Enrichment enabled by default (from config), can be overridden
		this.enableEnrichment =
			options.enableEnrichment ?? isEnrichmentEnabled(options.projectPath);
		this.enrichmentConcurrency = options.enrichmentConcurrency ?? 10;

		// Vector embeddings enabled by default (from config)
		this.vectorEnabled = isVectorEnabled(options.projectPath);

		// Lock options for concurrent access control
		this.lockOptions = options.lockOptions;
		this.globalLockOptions = options.globalLockOptions;
		this.onWaitingForLock = options.onWaitingForLock;
		this.onWaitingForGlobalLock = options.onWaitingForGlobalLock;
	}

	/**
	 * The model this indexer actually used, and where it came from.
	 *
	 * `adopted` is true when it came from the index rather than from config.
	 * Callers that never run index() — a plain search — read it after search()
	 * or getStatus(), which is when the adoption on the retrieval path happens.
	 */
	getEffectiveModel(): {
		model: string;
		adopted: boolean;
		configuredModel?: string;
	} {
		if (this.modelAdoption) {
			return {
				model: this.modelAdoption.model,
				adopted: true,
				configuredModel: this.modelAdoption.configuredModel,
			};
		}
		return { model: this.model, adopted: false };
	}

	/** Remember that `model` was used in place of the configured `configuredModel`. */
	private recordModelAdoption(model: string, configuredModel: string): void {
		this.modelAdoption = { model, configuredModel };
	}

	/**
	 * Throw IndexedModelUnavailableError unless this exact model/provider pair
	 * can embed. Call ONLY on a detected mismatch — it costs a round-trip.
	 */
	private async assertModelAvailable(
		model: string,
		provider: EmbeddingProvider | undefined,
	): Promise<void> {
		const key = `${provider ?? "<unset>"}|${model}`;
		if (this.probedModels.has(key)) return;

		const availability = await testModelAvailability(model, provider);
		if (!availability.ok) {
			throw new IndexedModelUnavailableError(
				model,
				availability.error ?? "unknown error",
				provider,
			);
		}
		this.probedModels.add(key);
	}

	/**
	 * THE ONLY place either embeddings-client field is assigned.
	 *
	 * Both `createEmbeddingsClient()` sites go through it — the one in
	 * `initialize()` and the one in the `use-indexed` adoption branch of
	 * `indexInternal()` — so the raw client and the seam can never describe two
	 * different models. That failure is silent and expensive: the adoption branch
	 * replaces the client wholesale, so a proxy installed only in `initialize()`
	 * would either be destroyed there, or would keep embedding with the
	 * CONFIGURED model while the run records the ADOPTED one — writing vectors
	 * under the wrong model identity into a cache that is shared by every repo on
	 * the machine.
	 *
	 * `forSearch` leaves the seam UNWRAPPED. `search()` and `getStatus()` call
	 * `initialize(true)` and must keep today's read path byte-for-byte (NFR-1);
	 * `initialize()` is not memoised and `index()` always calls it with the
	 * default `false`, so an index run after a search re-wraps correctly.
	 *
	 * Enrichment stays outside the seam by taking `rawEmbeddingsClient`.
	 */
	private installEmbeddingsClient(
		raw: IEmbeddingsClient,
		forSearch: boolean,
	): void {
		this.rawEmbeddingsClient = raw;
		this.embeddingsClient = forSearch
			? raw
			: createCachingEmbeddingsClient(raw, {
					// `null` on every path but `index()`; the proxy then serves the
					// in-process L0 memo only, which costs nothing and creates no file.
					cache: this.embedCache,
					configEnabled: this.embedCacheConfigEnabled,
					// Computed HERE because the proxy may not import `embeddings.ts`.
					clientFingerprint: embeddingTextFingerprint(raw),
				});
	}

	/**
	 * The seam, narrowed to the three members the index path needs that are not
	 * on `IEmbeddingsClient` — `embedContentOf`, `keyFor` and `stats`.
	 *
	 * Non-null and a `CachingEmbeddingsClient` on every non-search
	 * initialisation, because `installEmbeddingsClient` wraps unconditionally
	 * when `forSearch` is false — including when the cache is off, where the
	 * proxy's mode is "off" and it passes straight through to the inner client.
	 *
	 * Throws rather than falling back, deliberately: a fallback would be a second
	 * embedding code path that no test exercises and that would silently bypass
	 * the NFR-2 assertion in `embedContentOf`. This throw is unreachable by
	 * construction and says so.
	 */
	private cachingSeam(): CachingEmbeddingsClient {
		const client = this.embeddingsClient;
		if (!(client instanceof CachingEmbeddingsClient)) {
			throw new Error("index path reached without the caching seam installed");
		}
		return client;
	}

	/** The RUNTIME tier — degradation moves this, never the user's mode. */
	private embedCacheTier(): EmbedCacheTier {
		return this.embeddingsClient instanceof CachingEmbeddingsClient
			? this.embeddingsClient.stats().tier
			: "none";
	}

	/** What the cache did this run, for `IndexResult`. Null when it never ran. */
	private embedCacheResultStats(): IndexEmbedCacheStats | undefined {
		if (!(this.embeddingsClient instanceof CachingEmbeddingsClient)) {
			return undefined;
		}
		const stats = this.embeddingsClient.stats();
		return {
			tier: stats.tier,
			hits: stats.hits,
			misses: stats.misses,
			writes: stats.writes,
		};
	}

	/**
	 * Initialize all components
	 * @param forSearch - If true, use stored embedding model (for retrieval consistency)
	 */
	private async initialize(forSearch = false): Promise<void> {
		// Ensure project directory exists
		ensureProjectDir(this.projectPath);

		// Initialize parser manager
		const parserManager = getParserManager();
		await parserManager.initialize();

		// Initialize code unit extractor (always available, falls back to file-level unit)
		this.codeUnitExtractor = createCodeUnitExtractor();

		// Create file tracker first (to read stored metadata)
		const indexDbPath = getIndexDbPath(this.projectPath);
		this.fileTracker = createFileTracker(indexDbPath, this.projectPath);

		// Create embeddings client only when vector mode is enabled
		if (this.vectorEnabled) {
			// For search operations, use the stored embedding model to ensure consistency
			let modelToUse = this.model;
			let providerToUse: EmbeddingProvider | undefined;
			// Cleared on every initialize(): this object is reused across an
			// auto-reindex and the search that follows it, and the reindex may have
			// resolved the very mismatch a previous pass recorded.
			this.searchModelMismatch = null;
			if (forSearch) {
				const storedModel = this.fileTracker.getMetadata("embeddingModel");
				if (storedModel) {
					// If user explicitly requested a different model, throw clear error
					if (this.modelExplicitlySet && this.model !== storedModel) {
						throw new EmbeddingModelMismatchError(storedModel, this.model);
					}
					// Otherwise `onModelMismatch` decides. 'use-indexed' adopts the
					// stored model — the only way to query vectors built by it — and
					// takes the provider from the index too, because a bare model name
					// resolves against today's config and would be sent to the wrong
					// provider (see the adopt path in indexInternal).
					if (getModelMismatchMode(this.projectPath) === "use-indexed") {
						modelToUse = storedModel;
						providerToUse = asEmbeddingProvider(
							this.fileTracker.getMetadata("embeddingProvider"),
						);
						// Prove the adopted model can embed BEFORE anything uses it.
						// index() probes on its own path, but a search does not always
						// run index(): --agent skips the auto-reindex, --no-reindex
						// skips it, and the MCP tool swallows its failure. Without this
						// the first sign of an unreachable model is whatever the query
						// layer says about the vector it got back — observed:
						// "No vector column found to match with the query vector
						// dimension: 0", which names neither the model nor the cause.
						//
						// Only on a real mismatch. When the two agree — the normal
						// search, every time — there is nothing to prove and no
						// network call is made.
						if (storedModel !== this.model) {
							await this.assertModelAvailable(storedModel, providerToUse);
							// A search adopts without ever calling index(), so this is
							// the only place the retrieval path can record the fact for
							// the CLI and the MCP tool to report.
							this.recordModelAdoption(storedModel, this.model);
						}
					} else if (storedModel !== this.model) {
						// 'force-model' asked for the configured model everywhere, and
						// the reindex normally rebuilds the index with it before any
						// search. When that reindex did NOT run — --agent skips it,
						// --no-reindex skips it, the MCP tool treats its failure as
						// non-fatal — embedding the query with the configured model
						// searches a different vector space than the table holds. If
						// the widths differ that is a LanceDB error; if they happen to
						// match (768 is common) it is silent nonsense. Record it and
						// let search() refuse; status and keyword-only search stay
						// usable because neither embeds a query.
						this.searchModelMismatch = {
							stored: storedModel,
							configured: this.model,
						};
					}
				}
			}

			// Create embeddings client with appropriate model.
			// Through installEmbeddingsClient, which is the ONLY assignment to
			// either client field — see its docstring.
			this.installEmbeddingsClient(
				createEmbeddingsClient({
					model: modelToUse,
					provider: providerToUse,
				}),
				forSearch,
			);
		}

		// Create vector store
		const vectorStorePath = getVectorStorePath(this.projectPath);
		this.vectorStore = createVectorStore({
			vectorsDir: vectorStorePath,
			pathRoot: resolveStoreLocation(this.projectPath).pathRoot,
		});
		await this.vectorStore.initialize();

		// Initialize enrichment if enabled (requires vector mode for embeddings).
		//
		// NOT on the read paths. `search()` and `getStatus()` call
		// `initialize(true)` and never enrich, yet they were constructing the
		// default LLM client — which on darwin reads Claude Code's OAuth token out
		// of the login keychain. So `mnemex search` and `mnemex status` each paid a
		// credential read, and a provider that cannot be reached made them THROW
		// "Enrichment failed to initialize" for a query that needs no LLM at all.
		// External review flagged the construction; the read path not needing it is
		// the reason it should never have been there.
		if (!forSearch && this.enableEnrichment && this.vectorEnabled) {
			try {
				this.llmClient = await createLLMClient({}, this.projectPath);
				// The RAW client, not the seam. Enrichment embeds LLM-generated
				// summaries, which are new text every time and can never hit a
				// content-addressed cache, so wrapping it would buy a lookup that
				// always misses and a write that is never read.
				this.enricher = createEnricher(
					this.llmClient,
					this.rawEmbeddingsClient!,
					this.vectorStore,
					this.fileTracker,
				);
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				throw new Error(
					`Enrichment failed to initialize: ${msg}\n` +
						`LLM enrichment is enabled by default and requires a running LLM provider.\n` +
						`Either:\n` +
						`  • Start your LLM provider (e.g. LM Studio, Ollama)\n` +
						`  • Or run with --no-llm to skip enrichment`,
				);
			}
		}

		// Initialize docs fetcher if enabled. The pre-lock config is PASSED IN rather
		// than only stored: `createDocsFetcher(projectPath)` re-resolves it — a
		// second `getContext7ApiKey()`, inside the lock — so hoisting it and then not
		// using it here bought nothing.
		if (isDocsEnabled(this.projectPath) && this.vectorEnabled) {
			this.docsFetcher = createDocsFetcher(
				this.projectPath,
				this.docsConfigPreLock ?? undefined,
			);
		}
	}

	/** Maximum files to process per batch (limits memory usage) */
	private static readonly FILES_PER_BATCH = 500;

	/**
	 * Index the codebase.
	 *
	 * `force` rebuilds THIS BRANCH (§4.5 / D3): every row the current branch
	 * holds is narrowed out of it and re-indexed, and a row another branch still
	 * holds survives, narrowed rather than deleted. `forceAll` is the deliberate
	 * whole-store rebuild — the old meaning of `force`, which destroyed every
	 * branch's rows silently (decision I-16).
	 *
	 * `forceAll` implies `force`: there is no whole-store rebuild that does not
	 * also re-index this branch.
	 */
	async index(force = false, forceAll = false): Promise<EnrichedIndexResult> {
		const startTime = Date.now();

		// Ensure project directory exists before acquiring lock
		ensureProjectDir(this.projectPath);

		// Resolve anything that can reach the macOS Keychain BEFORE acquiring a lock.
		// See `docsConfigPreLock`.
		//
		// GATED on docs actually being used. `getDocsConfig` calls
		// `getContext7ApiKey()`, so calling it unconditionally added a keychain
		// lookup — and, on a locked keychain, a stall — to every index run of every
		// project with docs or vectors disabled, which is work for a feature that is
		// switched off. The two predicates are plain config reads and cost nothing.
		this.docsConfigPreLock =
			this.vectorEnabled && isDocsEnabled(this.projectPath)
				? getDocsConfig(this.projectPath)
				: null;

		// Open the embedding cache BEFORE either lock, for the same reason the docs
		// config is resolved here: the open sequence is the one region of this
		// feature whose duration is not constant-bounded. It creates the directory,
		// opens the file, and takes a brief exclusive lock for the WAL pragma —
		// all before `busy_timeout` is set at all. Inside the locks that would be
		// unbounded blocking against `isLockStale`'s 10 s heartbeat rule; outside
		// them it is not in the budget at all.
		//
		// `null` on failure, always: the cache is an optimisation and the only
		// thing a failure of it may ever cost is a recompute. The config opt-out is
		// resolved first so a user who turned the cache off does not get a SQLite
		// file created and DDL'd for something that will never be read.
		this.embedCacheConfigEnabled = loadGlobalConfig().embedCache;
		this.embedCache =
			resolveEmbedCacheMode(this.embedCacheConfigEnabled) === "off"
				? null
				: openEmbedCache();

		// ── §4.3 Phase A: the branch-confirmation scan, HOISTED ────────────────
		//
		// A bounded directory walk plus a capped stream of `packed-refs`. It runs
		// here, before either lock and outside every `SyncRegion`, for the reason
		// §2.2 gives: it is a cold-path read whose duration is not
		// constant-bounded, and inside the lock that is time the 1 s heartbeat
		// cannot fire in. It WRITES NOTHING — what it returns is a decision list
		// that `applyBranchDecisions` validates and applies under the lock
		// (REG-1). Hoisting the writes with the reads is what revision 1 of the
		// design did, and it put three `branches.json` writes outside the lock.
		this.confirmScanPreLock = await this.scanBranchesPreLock();

		// LOCK ORDERING (deadlock-safe): ALWAYS acquire the MACHINE-GLOBAL lock
		// FIRST, then the PER-PROJECT lock; release in REVERSE (project first, then
		// global). Because every indexer follows the same global-before-project
		// order, two indexers can never hold one lock while waiting on the other.
		//
		// The global lock serializes indexers across DIFFERENT repos on this machine
		// so N Claude Code sessions don't run N concurrent detached reindexers all
		// competing for the one machine + one shared embeddings API quota.
		this.globalLock = createGlobalIndexLock();
		const globalResult = await this.globalLock.acquire({
			waitTimeout: DEFAULT_GLOBAL_LOCK_WAIT,
			...this.globalLockOptions,
			onWaiting: this.onWaitingForGlobalLock,
		});

		if (!globalResult.acquired) {
			// Bail case (typically background --if-idle, waitTimeout:0): a machine-wide
			// index is already running. Do NOT proceed to index and do NOT hang.
			this.globalLock = null;
			throw new IndexLockError(
				globalResult.holderPid,
				globalResult.runningFor,
				globalResult.reason as "already_running" | "timeout" | "error",
				"global",
			);
		}

		// Acquire per-project lock to prevent concurrent indexing of THIS repo.
		this.indexLock = createStoreLock(resolveStoreLocation(this.projectPath));
		const lockResult = await this.indexLock.acquire({
			...this.lockOptions,
			onWaiting: this.onWaitingForLock,
		});

		if (!lockResult.acquired) {
			// Release the global lock we already hold before bailing (reverse order).
			this.indexLock = null;
			this.globalLock.release();
			this.globalLock = null;
			throw new IndexLockError(
				lockResult.holderPid,
				lockResult.runningFor,
				lockResult.reason as "already_running" | "timeout" | "error",
			);
		}

		try {
			return await this.indexInternal(force, forceAll, startTime);
		} finally {
			// Always release locks when done, in REVERSE acquire order:
			// per-project first, then machine-global.
			this.indexLock.release();
			this.indexLock = null;
			this.globalLock.release();
			this.globalLock = null;
		}
	}

	/**
	 * §4.3 Phase A, and the decision of whether to run it at all.
	 *
	 * Reads only, and NEVER throws: a registry this cannot parse is reported by
	 * `openRegistry` under the lock, where the error carries the store path and
	 * the remedy. Failing here would replace that with a failure from a pass the
	 * user did not ask for.
	 */
	private async scanBranchesPreLock(): Promise<ConfirmScanResult | null> {
		const loc = resolveStoreLocation(this.projectPath);
		if (loc.gitLayout === null) return null;
		try {
			const entries = readBranchRegistry(loc).branches;
			const live = entries.filter(isLiveEntry);
			// The counter is what this run WILL write, so the run that takes it to
			// a multiple of the interval is the one that scans.
			const runNumber = readStoreState(loc).confirmRunCounter + 1;
			if (
				!shouldConfirmBranches(
					runNumber,
					live.length,
					live.filter((entry) => entry.ephemeral).length,
				)
			) {
				return null;
			}
			return await confirmScan(loc.gitLayout, entries);
		} catch {
			return null;
		}
	}

	/**
	 * Stamp forward progress on BOTH the per-project and machine-global locks.
	 * Keeping the global lock's `lastProgressAt` fresh while genuinely working stops
	 * it from being falsely reclaimed; when the indexer truly wedges, both stop
	 * advancing and the global holder is correctly reclaimed after the progress
	 * timeout. No-op on whichever lock this process does not own.
	 */
	private reportProgress(): void {
		for (const lock of [this.indexLock, this.globalLock]) {
			lock?.recordProgress();
		}
	}

	/**
	 * Record the current phase on BOTH the per-project and machine-global locks so
	 * a hang is attributable to a phase on either. Reporting only — does NOT affect
	 * the hung decision (which is driven by lastProgressAt / reportProgress).
	 */
	private reportPhase(phase: string): void {
		for (const lock of [this.indexLock, this.globalLock]) {
			lock?.setPhase(phase);
		}
	}

	/** Manifest files that trigger docs re-fetch when changed */
	private static readonly MANIFEST_FILES = new Set([
		"package.json",
		"requirements.txt",
		"pyproject.toml",
		"go.mod",
		"Cargo.toml",
	]);

	/**
	 * Internal indexing logic (called after lock acquired)
	 */
	private async indexInternal(
		force: boolean,
		forceAll: boolean,
		startTime: number,
	): Promise<EnrichedIndexResult> {
		// `--force-all` is `--force` plus a whole-store rebuild, so everything
		// below that reads `force` sees it. The two stay separate variables
		// because the SCOPE of the clear is what they disagree about (§4.5).
		if (forceAll) force = true;
		// What the CALLER asked for, captured before the corruption branch below
		// sets `force` for its own reasons. `--force` is an explicit instruction to
		// rebuild, so it decides the model the same way an explicit `--model` does
		// — and it is the escape hatch both mismatch errors advertise. Without
		// this, `mnemex index --force` on an unreachable stored model re-probes
		// that same model and throws the identical error: a documented remedy that
		// loops. A corruption-driven rebuild is NOT a caller instruction and must
		// not be read as one, which is why this is captured first.
		const forceRequested = force;

		// Per run: one Indexer can serve more than one run (the MCP auto-reindex
		// reuses one), and one run's upgrade report must not leak into the next.
		this.upgradedFromIndexVersion = undefined;

		// §6.1's probe of the store being replaced, taken BEFORE initialize()
		// creates `index.db`. After it, every fresh store would find a database
		// and look like an upgrade.
		const loc = resolveStoreLocation(this.projectPath);
		const pathRoot = loc.pathRoot;
		const oldStore = probeStoreBeingReplaced(loc);

		await this.initialize();

		// ── Branch identity (architecture §3.4), before ANY row of this run exists ──
		// A store with no git layout has no registry: every row is shared (0).
		// Inside a repository the id is the registry's REAL id for the current
		// HEAD. A NEW label is allocated AND renamed to disk before resolveId
		// returns (W-R1), so no row can carry an id `branches.json` does not hold.
		// Opened here, under the store lock index() took, and nowhere else (REG-1).
		let registry: BranchRegistry | null = null;
		let branchId = BRANCH_ID_SHARED;
		/** §4.1.5's comparison point: the label this run's rows are stamped with. */
		let headLabelAtStart: string | null = null;
		if (loc.gitLayout !== null) {
			if (
				this.indexLock === null ||
				this.fileTracker === null ||
				this.vectorStore === null
			) {
				throw new Error(
					"indexInternal: the store lock is not held, or the store is not open",
				);
			}
			// C1 mechanism 2, over EVERY store that carries a branch id (3a-2's
			// finding 4). Read here, before `openRegistry`, because reading
			// LanceDB is asynchronous and the raise happens synchronously on the
			// lock-held open.
			const rowSources = combineBranchIdSources(
				this.fileTracker,
				await this.vectorStore.highestBranchId(),
			);
			registry = openRegistry(loc, this.indexLock, rowSources);
			const head = readCurrentHead(loc.gitLayout);
			headLabelAtStart = head.label;
			branchId = registry.resolveId(head);
		}
		/** Every repo row this run writes: a repo path, under this run's branch. */
		const repoRows: RowMembership = { pathKind: "repo", branchId };

		// ── §4.3 Phase B (W-R2), immediately after W-R1 ───────────────────────
		//
		// The hoisted scan's decisions, applied against the registry AS RE-READ
		// UNDER THIS LOCK. Each one is validated and DROPPED if its entry has
		// moved since the scan — a different `lastSeen`, already tombstoned,
		// already unconfirmed, or resolved by this very run (D7's `pinnedThisRun`,
		// which is why this must come after `resolveId` and not before).
		const confirmation =
			registry !== null && this.confirmScanPreLock !== null
				? registry.applyBranchDecisions(this.confirmScanPreLock.decisions)
				: null;

		// `store.json`'s lifecycle state, read under the lock. The pre-lock read
		// in `scanBranchesPreLock` decided only WHETHER to scan; this one is the
		// authoritative copy that the sweep resumes from and that this run writes
		// back before `release()`.
		const storeState = registry === null ? null : readStoreState(loc);
		let sweepCursor: SweepCursor | null = storeState?.sweep ?? null;

		// ── Rule R's other half ───────────────────────────────────────────────
		//
		// A branch that was tombstoned and is now checked out again keeps its id
		// (rule R, in `resolveId`). §3.4 says the rows the sweep already removed
		// are rebuilt by this run "because a branch whose `files` rows were
		// deleted reports every file NEW". Under §4.3's order that is not yet
		// true: the sweep deletes `files` LAST, once membership has drained, so a
		// HALF-swept branch still has `files` rows whose content hash matches the
		// tree. `getChanges` would then report nothing to do and the chunk rows
		// the sweep deleted would never come back.
		//
		// So the interrupted operation is FINISHED here, and only when the cursor
		// names this branch — a tombstone the sweep never reached costs nothing.
		if (
			registry?.resolved?.resurrected === true &&
			sweepCursor?.branchId === branchId
		) {
			this.reportPhase("branch-sweep:resurrect");
			const cleared = await completeInterruptedSweep(
				this.fileTracker!,
				branchId,
				{ onProgress: () => this.reportProgress() },
			);
			sweepCursor = null;
			this.onProgress?.(
				0,
				0,
				`[branch] '${headLabelAtStart}' was being reclaimed and is checked out again; ` +
					`${cleared.files} file record(s) were dropped so this run rebuilds what the sweep removed`,
			);
		}

		// Resolve the commit anchor ONCE for the whole run. Everything written
		// below (files via markIndexed, documents via the enricher) is stamped
		// with this SHA, so there is no per-file git subprocess.
		//
		// Non-git projects and git failures return null, which leaves the
		// provenance columns NULL — "unknown", which reads as valid. Provenance
		// is an enrichment on the index and is never a reason to fail a run.
		const head = await this.fileTracker!.recordHeadCommit();

		// Walk the diff of the commit that produced this state and invalidate the
		// memories it made wrong. This is the path a post-commit hook drives
		// (`mnemex index`), and it runs BEFORE enrichment so anything queued for
		// re-derivation is picked up by this same run.
		//
		// One `git diff` per run, not per file. Returns null and changes nothing
		// outside a git repository or on any git failure — never a new way for an
		// index run to fail.
		const invalidation = await invalidateForCommit(
			this.projectPath,
			this.fileTracker!,
			branchId,
			{ head },
		);
		if (invalidation) {
			this.fileTracker!.recordActivity("invalidation", {
				...invalidation,
			});
			this.onProgress?.(
				0,
				0,
				`[invalidating] ${formatInvalidationCounts(invalidation)}`,
			);
		}

		// Read the index's identity BEFORE anything can erase it. The corruption
		// branch below calls fileTracker.clear(), which does `DELETE FROM metadata`
		// — the row these two values live in. Reading them afterwards returns null
		// on every corrupt index, which would make the whole mismatch decision
		// below dead code on exactly the case that motivated it.
		const previousModel = this.fileTracker!.getMetadata("embeddingModel");
		const previousProvider = asEmbeddingProvider(
			this.fileTracker!.getMetadata("embeddingProvider"),
		);

		// An index whose vector column is FixedSizeList[0] answers no query at all,
		// so there is nothing to weigh: dropping it loses no capability, and
		// leaving it means every search fails. That is why it rebuilds without
		// asking, unlike a model change — there the stored vectors are valid, just
		// built by another model, so the rebuild is a real cost trade.
		const wasCorrupt = await this.vectorStore!.isUnqueryable();

		// A store written in BM25-ONLY mode holds the `[0]` placeholder in every
		// row, and this run produces real vectors. Detected HERE, with the other
		// two rebuild signals, and for the same reason: `addChunks` already
		// clears the table when an incoming width disagrees with the stored one,
		// but by then the tier-1 hit test has decided. Under the branch model
		// that decision is load-bearing — every unchanged chunk would be WIDENED
		// into this run (the rows exist, and are registered), the mismatch clear
		// would then drop them, and the run would end holding only the chunks it
		// happened to embed. Deciding before mutating is what the corruption and
		// model-mismatch branches below already do.
		const placeholderStore =
			!wasCorrupt &&
			this.vectorEnabled &&
			(await this.vectorStore!.vectorWidth()) === 1;

		// ── Out-of-date store detection (§6.1): three independent signals, all
		// read before any mutation below can clear the evidence. `=== false`,
		// never falsiness: the LanceDB probe's `null` means "no table", which is a
		// fresh index. The tracker probe is the only one that sees the SQLite half.
		// It decides even when something else already forces a rebuild, because
		// `clear()` keeps a v3 `files` table, and the first v4 write into it fails.
		//
		// The two SHAPE probes answer "is this store pre-v4"; the VERSION
		// comparison is generic and is what carries every later bump — v5 (I-14,
		// the content-addressed code-unit id) rides on it with no branch of its
		// own, because it changes stored ids rather than the schema.
		const lanceHasBranchIds =
			wasCorrupt || this.vectorStore === null
				? null
				: await this.vectorStore.hasBranchIdsColumn();
		const trackerNeedsV4 =
			this.fileTracker !== null && this.fileTracker.trackerNeedsV4Schema();
		const upgradeStore =
			trackerNeedsV4 ||
			(oldStore !== null &&
				((oldStore.recordedVersion !== null &&
					oldStore.recordedVersion < CURRENT_INDEX_VERSION) ||
					lanceHasBranchIds === false));

		// The index records the model that built it (read above). When that is not
		// the model this run would use, `onModelMismatch` decides which one gives
		// way — see getModelMismatchMode() for why the default keeps the index.
		const mismatch = !!previousModel && previousModel !== this.model;
		// An explicit `--model` or `--force` is an instruction, not a preference:
		// it outranks the policy, exactly as `--model` does on the search path
		// (where initialize() turns the same disagreement into
		// EmbeddingModelMismatchError).
		const mode = !mismatch
			? undefined
			: this.modelExplicitlySet || forceRequested
				? "force-model"
				: getModelMismatchMode(this.projectPath);

		// DECIDE AND VALIDATE BEFORE MUTATING ANYTHING.
		//
		// The availability probe can throw IndexedModelUnavailableError, whose
		// message promises "Nothing was changed — the index is intact". That
		// promise is only true if nothing has been cleared yet — and the
		// corruption repair below clears both the store and the tracker. Running
		// the probe first keeps the message honest for every combination,
		// including corrupt-and-mismatched, rather than teaching the error to
		// describe damage it already did.
		//
		// The stored PROVIDER matters as much as the stored model.
		// createEmbeddingsClient() infers the provider from the model string and
		// falls back to the ambient config when nothing matches, so a bare name
		// like "nomic-embed-text" would be requested from whatever provider the
		// config names today — Voyage asked for an Ollama model. Indexes written
		// before this change have no provider on record; there is nothing to infer
		// from, so try the model alone and let the error say so.
		const willAdopt = mismatch && mode === "use-indexed";
		if (willAdopt) {
			await this.assertModelAvailable(previousModel!, previousProvider);
		}

		// ── From here on, mutations. ──────────────────────────────────────────
		// True once the store has been emptied by any branch below, so the
		// `if (force)` block does not empty it a second time. Keyed on "did we
		// clear", never on "was there a reason to" — adopting clears nothing, and
		// a `--force` run that skipped its clear would re-index into a non-empty
		// table.
		//
		// ── WHY THESE THREE CALL `rebuildStore()` AND NOT `clear()` ──────────
		//
		// §4.5's producer table routes every whole-store producer through
		// `rebuildStore()`, and until this phase these three called
		// `vectorStore.clear()` + `fileTracker.clear()` instead. MEASURED: on a
		// store holding two branches, a model change emptied every branch's
		// chunks, membership and `files` and left the SIBLING branch holding 7
		// `symbols` rows — `clear()` is a `DELETE FROM` over seven tables and
		// `symbols`, `symbol_references` and `graph_metadata` are not among
		// them. The current branch does not show it, because
		// `extractSymbolGraph(force)` calls `clearSymbolGraph()` for ITS branch;
		// every other branch keeps a symbol graph whose chunks no longer exist,
		// so `map` and `dead-code` there answer from rows `search` cannot see.
		//
		// `rebuildStore()` drops both halves — `dropTable` on LanceDB and
		// §3.5.1's DROP pass on the five tree-scoped tables — which is also what
		// stops a zombie v3 schema surviving a repair (§4.5). Its first action is
		// the same `store.clear()`, which still bypasses `ensureTableOpen()`, so
		// CLAUDE.md #15's repair path stays reachable.
		let alreadyCleared = false;

		if (placeholderStore) {
			this.onProgress?.(
				0,
				0,
				"[repairing] this index was built with vectors disabled, so every row holds a placeholder — rebuilding it with embeddings now",
			);
			await this.rebuildStore();
			alreadyCleared = true;
			force = true;
		}

		if (wasCorrupt) {
			// onProgress, not console.log: the MCP search tool runs this same
			// index() in-process, and stdout there is the JSON-RPC stream.
			this.onProgress?.(
				0,
				0,
				"[repairing] the vector index had a 0-dimension vector column, so no query could read it — rebuilding it now",
			);
			await this.rebuildStore();
			alreadyCleared = true;
			force = true;
		}

		if (mismatch && mode === "force-model") {
			// Reported through onProgress, never console.log: the MCP search tool
			// runs this same index() in-process and stdout there is the JSON-RPC
			// stream (see the `[invalidating]` notice above for the precedent).
			this.onProgress?.(
				0,
				0,
				`[model] ${previousModel} → ${this.model}: the stored vectors came from the old model, rebuilding the whole index`,
			);
			if (!alreadyCleared) {
				await this.rebuildStore();
				alreadyCleared = true;
			}
			force = true; // Treat as force reindex
		}

		if (willAdopt) {
			// 'use-indexed': the stored vectors are fine, they just belong to
			// another model. Adopt that model; nothing is cleared for it.
			this.recordModelAdoption(previousModel!, this.model);
			this.model = previousModel!;
			// THE SECOND createEmbeddingsClient() SITE, and the one that is easy to
			// miss: this branch is the production default for a model mismatch and
			// it replaces the client wholesale. It goes through the same single
			// assignment point, with forSearch=false, so the seam and the raw client
			// both move to the adopted model together.
			this.installEmbeddingsClient(
				createEmbeddingsClient({
					model: this.model,
					provider: previousProvider,
				}),
				false,
			);
			// The enricher captured the OLD client by value in initialize(), so
			// without this it would keep embedding summaries with the configured
			// model and mix two vector spaces into one table.
			// `this.rawEmbeddingsClient` is in the condition rather than asserted:
			// the `installEmbeddingsClient` call directly above assigns it
			// unconditionally, so this is a narrowing, not a guard — and it is the
			// one non-null assertion this feature would have ADDED to a site that
			// had none (the pre-cache code passed `this.embeddingsClient` here,
			// which was already non-optional).
			if (this.enricher && this.llmClient && this.rawEmbeddingsClient) {
				this.enricher = createEnricher(
					this.llmClient,
					this.rawEmbeddingsClient,
					this.vectorStore!,
					this.fileTracker!,
				);
			}

			// One of FOUR channels for this fact, none of which reaches every
			// surface alone: --agent has no progress callback, the TTY renderer
			// truncates detail and then overwrites it with "done", and the MCP tool
			// passes no callback at all. The authoritative one is the result object
			// (see `embeddingModel` / `adoptedIndexedModel` on IndexResult).
			this.onProgress?.(
				0,
				0,
				`[model] using ${this.model}, the model this index was built with, instead of ${this.modelAdoption?.configuredModel} ` +
					`(set onModelMismatch: "force-model" to rebuild with ${this.modelAdoption?.configuredModel})`,
			);
		}

		// ── The store was built by an older index version ─────────────────────
		//
		// A plain rebuild, once. No seeding pass and no in-place migration
		// (CLAUDE.md #31). Both halves go through `rebuildStore()`. LanceDB's table
		// is dropped: a v4 batch carries 25 fields and a live v3 table has 23. The
		// tracker's six tree-scoped tables are DROPPED and re-created (§3.5.1),
		// because no ALTER can change the primary key of `files`. Re-chunking is
		// served from the embedding cache, which is keyed on text, not on path
		// (§6.2).
		//
		// Reported in DATA (`upgradedFromIndexVersion`): two of the four entry
		// points pass no onProgress, so the notice below reaches at most two. The
		// version comes from `probeOldStore`, which says `null`, never 1, when the
		// old store recorded none (V4.8).
		//
		// THE NOTICE NAMES NO FEATURE. It used to say "predates repo-relative
		// paths and branch membership", which was true of the one upgrade that
		// existed and became false the moment a second one did (v4 -> v5 is a
		// stored-id change and nothing to do with paths). A line that names the
		// versions is true of every bump, and the version is the fact a user can
		// act on.
		if (upgradeStore) {
			this.upgradedFromIndexVersion = oldStore?.recordedVersion ?? undefined;
			const fromVersion =
				this.upgradedFromIndexVersion !== undefined
					? `index version ${this.upgradedFromIndexVersion}`
					: "an older version of mnemex";
			// onProgress, not console.log: the MCP search tool runs this same
			// index() in-process and stdout there is the JSON-RPC stream.
			this.onProgress?.(
				0,
				0,
				`[migrating] this index was built by ${fromVersion}; the current one is ${CURRENT_INDEX_VERSION}. ` +
					"Rebuilding it once; chunks the embedding cache already holds are not re-embedded.",
			);
			await this.rebuildStore();
			alreadyCleared = true;
			force = true;
		}

		// ── `--force-all`: the DELIBERATE whole-store rebuild (§4.5 / D3) ─────
		//
		// The one whole-store clear a user asks for BY NAME. The four above it
		// are repairs and migrations — a 0-dimension vector column, a
		// placeholder-vector store, a model change, an index version bump — and
		// each of those is a property of the STORE rather than of a tree, which
		// is why none of them narrows either.
		//
		// `rebuildStore()`, not `clear()`: a `DELETE FROM` leaves the tree-scoped
		// SCHEMA behind (§4.5), and a `clear()` leaves `symbols`,
		// `symbol_references` and `graph_metadata` untouched for every branch —
		// which is how the old `--force` left a sibling branch holding a symbol
		// graph whose chunks it had just destroyed.
		//
		// `alreadyCleared` guards it in both directions: an upgrade that already
		// rebuilt does not rebuild twice, and the `if (force)` block below does
		// not then narrow a branch out of a store that no longer holds anything.
		if (forceAll && !alreadyCleared) {
			this.onProgress?.(
				0,
				0,
				"[rebuilding] --force-all: rebuilding the whole store, every branch",
			);
			await this.rebuildStore();
			alreadyCleared = true;
		}

		// ── R-recovery (§4.1.4): re-drive whatever a crashed run left ─────────
		//
		// Inside the store lock, BEFORE any write of this run. `'add'` residue is
		// UNDONE (nothing refers to those rows) and `'remove'` residue is
		// COMPLETED (the file's new id set was already authoritative, so undoing
		// would resurrect the ghost chunks the removal existed to delete).
		//
		// PLACED AFTER the corruption, model-change and upgrade branches, where
		// §4.1's diagram puts it before them. The requirement is "before any
		// write of this run", which this satisfies; running it EARLIER would ask
		// it to delete rows out of the 0-dimension table `ensureTableOpen`
		// refuses to open (CLAUDE.md #15), making the repair path unreachable.
		// Every one of those branches clears the journal with the store it
		// clears, so recovery after them is a no-op rather than lost work.
		this.reportPhase("recovering");
		const crashResidue = await recoverCrashResidue(
			this.fileTracker!,
			this.vectorStore!,
		);
		if (crashResidue.added > 0 || crashResidue.removed > 0) {
			this.reportProgress();
			this.onProgress?.(
				0,
				0,
				`[recovering] a previous run was interrupted: ${crashResidue.added} appended row(s) removed, ` +
					`${crashResidue.removed} removal(s) completed`,
			);
		}

		// Discover files
		this.reportPhase("discovering");
		// Walked from the project's REAL path, so every discovered path has the
		// spelling the seam gives `pathRoot` (decision I-3) and `toRepoRelative`
		// stays a lexical `relative()`, with no realpath per file.
		const projectRealPath = realpathOrSelf(this.projectPath);
		const discovered = this.discoverFiles(projectRealPath);
		// §3.1: a file with no stored path under pathRoot is SKIPPED and reported
		// as `outside-path-root`, never written under a `..` path. It is filtered
		// before getChanges, so it can be neither compared nor a deletion
		// candidate.
		const storedPathOf = new Map<string, string>();
		const outsidePathRoot: string[] = [];
		for (const file of discovered) {
			const storedPath = toRepoRelative(pathRoot, file);
			if (storedPath === null) outsidePathRoot.push(file);
			else storedPathOf.set(file, storedPath);
		}
		const allFiles = [...storedPathOf.keys()];

		// Get changes
		let filesToIndex: string[];
		let deletedFiles: string[] = [];
		let manifestFilesChanged = force; // Always refresh docs on force reindex
		/** What a branch-scoped `--force` removed, for the result and for M5. */
		let forceNarrow: NarrowBranchResult | null = null;

		if (force) {
			// Force re-index all files
			filesToIndex = allFiles;
			// Clear existing data (skip if one of the four whole-store producers
			// above already did it: corruption repair, placeholder-vector repair,
			// a model change, an index-version upgrade, or `--force-all`).
			if (!alreadyCleared) {
				if (registry !== null && branchId !== BRANCH_ID_SHARED) {
					// ── D3 (§4.5): `--force` narrows THIS BRANCH ─────────────────
					//
					// The old code here was `vectorStore.clear()` (a `dropTable`)
					// plus `fileTracker.clear()`, neither of which takes a branch —
					// so one worktree that had indexed two branches lost BOTH to a
					// `--force` on either, and lost them silently, because the
					// destroyed branch keeps its registry entry and `branchUnknown`
					// therefore never fires (decision I-16).
					//
					// W-R6 FIRST: the record of when this branch was last indexed
					// stops being true before the rows go, not after.
					registry.clearIndexStamp(branchId);
					this.reportPhase("branch-force");
					forceNarrow = await narrowBranch(
						this.fileTracker!,
						this.vectorStore!,
						branchId,
						{
							// CLAUDE.md #20: `reportProgress` advances `lastProgressAt`,
							// the SOLE input to the hung/stale decision, and this loop
							// can run for as long as the branch is large. A pass that
							// stamps only at the end is the silent-but-healthy run #20
							// was written about.
							onProgress: (rows) => {
								this.reportProgress();
								this.onProgress?.(
									rows,
									rows,
									`[branch-force] ${rows} membership row(s) cleared for this branch`,
								);
							},
						},
					);
				} else {
					// No git layout: every row of this store carries the shared
					// marker (§3.2.1), so there is exactly one tree and "this
					// branch" and "the whole store" are the same set of rows.
					// `clear()` is that set, reached far more cheaply than by
					// paging every id through `narrowIds` — and it is the path
					// CLAUDE.md #15's repair depends on, because it does not go
					// through `ensureTableOpen()`.
					await this.vectorStore!.clear();
					this.fileTracker!.clear();
				}
			}
		} else {
			// Incremental indexing
			const changes = await this.getChangesInSlices(branchId, allFiles);
			filesToIndex = [...changes.newFiles, ...changes.modifiedFiles];
			deletedFiles = changes.deletedFiles;

			// Check if any manifest files changed (to decide if docs phase should run)
			for (const file of filesToIndex) {
				const basename = file.split("/").pop() || "";
				if (Indexer.MANIFEST_FILES.has(basename)) {
					manifestFilesChanged = true;
					break;
				}
			}

			// Remove deleted files from THIS BRANCH (§4.2).
			//
			// `removeFileFromBranch` narrows all three row classes to the empty
			// set: a row another branch still points at keeps its row and loses
			// one id from its mirror, and only a row nobody points at any more is
			// deleted. A file deleted on branch B must not remove branch A's rows.
			//
			// ORDER IS LOAD-BEARING (W1): the rows go first, the tracker row
			// second. Once the tracker row is gone `getChanges` never offers this
			// file again, so residue left by the opposite order is permanent
			// rather than self-healing.
			//
			// THE WARNING NOW COUNTS PER ROW CLASS (3a-2's finding 2). A total is
			// not enough: with only `addChunks` broken, the code-unit rows still
			// deleted, so the total was non-zero, the zero-row warning stayed
			// silent, and 6 chunk rows survived. A class that removed NOTHING
			// while another removed something is the partial-ghost signal.
			for (const deletedFile of deletedFiles) {
				const removal = await removeFileFromBranch(
					this.fileTracker!,
					this.vectorStore!,
					branchId,
					"repo",
					deletedFile,
				);
				// SR-2: the yield comes FIRST. `removeFileFromBranch` ran regions,
				// and the warning path reads a value derived from them.
				await yieldToEventLoop();
				if (removal.partialGhost) {
					console.warn(
						`Warning: removing ${describeRemoval(deletedFile, removal)} — one row class removed ` +
							"nothing while another removed rows. The survivors stay searchable and nothing revisits them.",
					);
				}
				await yieldToEventLoop();
				this.fileTracker!.removeFile(branchId, deletedFile);
				await yieldToEventLoop();
			}

			// SMART INCREMENTAL: collect old chunks for modified files, for vector
			// reuse by contentHash.
			//
			// THE DELETE THAT USED TO BE HERE IS GONE (§4.1.1). It was
			// `deleteByFile(modifiedFile)` — an unscoped delete by path, which in
			// a shared store removes every OTHER branch's rows for that path too.
			// Its job is now `NARROW_CHUNKS`, which runs per file AFTER this
			// batch's chunks are stored and removes exactly `oldIds \ newIds` for
			// THIS branch. Deleting first is also what made the append safe
			// before; now the tier-1 hit test does, by never appending an id the
			// store already holds.
			//
			// Reused from LanceDB only when the persistent cache is NOT serving
			// this run. On the healthy path the cache covers the same reuse
			// across files and repos, and one seam is what makes the hit rate
			// measurable; on any degraded or off path this is the only reuse
			// there is, and it needs no cache file, no network call and no known
			// dimension. The tier is read once, before the loop.
			const reuseFromLance = this.embedCacheTier() !== "sqlite";
			for (const modifiedFile of changes.modifiedFiles) {
				if (reuseFromLance) {
					// An absolute path: the store converts it to the stored form.
					const oldChunks =
						await this.vectorStore!.getChunksWithVectors(modifiedFile);
					if (oldChunks.length > 0) {
						// Store old chunks indexed by contentHash for O(1) lookup
						// Key by absolute path to match during embedding phase
						const oldChunksMap = new Map<string, number[]>();
						for (const chunk of oldChunks) {
							if (chunk.contentHash && chunk.vector.length > 1) {
								// >1 to exclude placeholder [0]
								oldChunksMap.set(chunk.contentHash, chunk.vector);
							}
						}
						this.oldChunksCache.set(modifiedFile, oldChunksMap);
					}
				}
				this.fileTracker!.resetEnrichmentState(branchId, modifiedFile);
				// SR-2: the next turn's region must not follow this one unyielded.
				await yieldToEventLoop();
			}
		}

		// Process files in batches to limit memory usage
		// Each batch: parse → embed → store → release memory
		const skippedFiles: string[] = [];
		const errors: Array<{ file: string; error: string }> = outsidePathRoot.map(
			(file) => ({
				file: relative(projectRealPath, file),
				error: "outside-path-root",
			}),
		);
		/**
		 * Files whose tracker stamp was deferred and whose rows were removed
		 * again, so the next run redoes them. Relative paths, for the report.
		 */
		const deferredFiles = new Set<string>();
		let totalFilesIndexed = 0;
		let totalChunksCreated = 0;
		let totalCodeUnitsCreated = 0;
		let totalCost = 0;
		let totalTokens = 0;
		/** Tier-1 hits this branch gained without a row or an embedding (§4.1.1). */
		let totalChunksWidened = 0;
		let totalUnitsWidened = 0;
		/**
		 * Code units whose id was already registered but whose CONTENT had
		 * changed, so the row was rewritten in place rather than widened.
		 *
		 * Before I-14 this counted a design defect: a code-unit id carried no
		 * content, so two revisions collided. Since I-14 it counts the belt
		 * firing, and its expected value is 0 — a non-zero reading means either a
		 * 64-bit id collision or a crash between a refresh and its registration.
		 * It is not surfaced on `IndexResult` yet (I-15's "two small ones").
		 */
		let totalUnitsRefreshed = 0;
		/**
		 * Ids `chunk_index` named that LanceDB did not have, DEMOTED from WIDEN
		 * to INSERT by the existence projection. Non-zero means P1 was broken and
		 * this run repaired it; reported, never silent.
		 */
		let totalIdsDemoted = 0;
		/**
		 * M2 (I-7 FINAL): rows read beyond the distinct ids read — a duplicate id
		 * left by a crash. Recorded in DATA and NOT repaired inline with
		 * delete-then-add; recovery owns cleanup.
		 */
		let duplicateChunkRows = 0;

		// Track files for enrichment (file -> chunks mapping)
		const fileChunksForEnrichment: FileToEnrich[] = [];

		// PARALLEL MODE: Run AST extraction and enrichment in parallel
		// Conditions: embedding is local (uses GPU/CPU) AND LLM is cloud (uses network)
		const canParallelizeEnrichment =
			this.enableEnrichment &&
			this.enricher &&
			this.vectorEnabled &&
			this.embeddingsClient?.isLocal() &&
			this.llmClient?.isCloud();

		const totalBatches = Math.ceil(
			filesToIndex.length / Indexer.FILES_PER_BATCH,
		);

		for (let batchNum = 0; batchNum < totalBatches; batchNum++) {
			const batchStart = batchNum * Indexer.FILES_PER_BATCH;
			const batchEnd = Math.min(
				batchStart + Indexer.FILES_PER_BATCH,
				filesToIndex.length,
			);
			const batchFiles = filesToIndex.slice(batchStart, batchEnd);

			// Phase 1: Parse and chunk batch of files
			const batchChunks: Array<{
				chunk: CodeChunk;
				filePath: string;
				fileHash: string;
			}> = [];

			for (let i = 0; i < batchFiles.length; i++) {
				const filePath = batchFiles[i];
				const relativePath = relative(projectRealPath, filePath);
				const storedPath =
					storedPathOf.get(filePath) ?? toRepoRelative(pathRoot, filePath);
				const globalIndex = batchStart + i + 1;

				// Report progress (parsing phase) - show "X/Y" with filename, or just "X/Y files" at completion
				if (this.onProgress) {
					const batchInfo =
						totalBatches > 1 ? ` [batch ${batchNum + 1}/${totalBatches}]` : "";
					const isLast = globalIndex === filesToIndex.length;
					const detail = isLast
						? `${globalIndex}/${filesToIndex.length} files`
						: `${globalIndex}/${filesToIndex.length} ${relativePath}`;
					this.onProgress(
						globalIndex,
						filesToIndex.length,
						`[parsing]${batchInfo} ${detail}`,
					);
				}

				if (storedPath === null) {
					errors.push({ file: relativePath, error: "outside-path-root" });
					continue;
				}

				try {
					const content = readFileSync(filePath, "utf-8");
					const fileHash = computeFileHash(filePath);
					// The STORED path, so the chunk id hashes it (§3.1): one relative path
					// gives one id in every worktree.
					const chunks = await chunkFileByPath(content, storedPath, fileHash);

					if (chunks.length === 0) {
						skippedFiles.push(relativePath);
					} else {
						for (const chunk of chunks) {
							batchChunks.push({ chunk, filePath, fileHash });
						}
					}
				} catch (error) {
					const errorMsg =
						error instanceof Error ? error.message : String(error);
					errors.push({ file: relativePath, error: errorMsg });
				}
			}

			// Skip embedding/storing if no chunks in this batch
			if (batchChunks.length === 0) {
				continue;
			}

			// ── Phase 1b: the two-tier hit test (§4.1.1, §4.1.2) ──────────────
			//
			// TIER 1 — the store already holds this exact row (same path, same
			// lines, same content), so this branch WIDENS: no embedding, no new
			// row, one membership row and one drain intent. Two questions, not
			// one: `chunk_index` says whether the id is registered, and an id
			// PROJECTION over LanceDB says whether the row is really there. The
			// second is P1's belt (§4.1.4): a `chunk_index` row with no row
			// behind it is permanently unsearchable content that every probe in
			// this design reports as healthy, and each id that fails it is
			// DEMOTED to INSERT, which self-heals it.
			//
			// TIER 2 — the store holds this exact CONTENT at this path under a
			// different id (a line shifted above it). The embedding is a function
			// of the text alone, so the vector is copied and a NEW row is written
			// with the new id and the new line range: zero embedding requests,
			// one new row. Tier 2 does NOT widen, because a contentHash match at
			// a different id means the stored row's startLine/endLine describe
			// the other revision's line numbers.
			const hitTestIds = batchChunks.map((c) => c.chunk.id);
			// SR-2: the batch loop wraps around, so the previous turn's last region
			// is still pending when this one's first is reached.
			await yieldToEventLoop();
			const registeredIds = this.fileTracker!.knownChunkRows(hitTestIds);
			const liveIds = await this.vectorStore!.existingIds([
				...registeredIds.keys(),
			]);
			totalIdsDemoted += [...registeredIds.keys()].filter(
				(id) => !liveIds.has(id),
			).length;
			// A code CHUNK's id hashes `filePath:startLine:endLine:content`, so an
			// id match IS a content match and the stored hash can only agree. The
			// check is written anyway, in one shape with the code-unit pass below,
			// so a future id scheme cannot quietly turn a widen into a stale row.
			const isChunkHit = (c: (typeof batchChunks)[number]): boolean =>
				liveIds.has(c.chunk.id) &&
				registeredIds.get(c.chunk.id) === (c.chunk.contentHash || "");
			/** Chunks this branch only has to point AT. */
			const widenChunks = batchChunks.filter(isChunkHit);
			/** Chunks that need a row, and therefore a vector. */
			const insertChunks = batchChunks.filter((c) => !isChunkHit(c));
			totalChunksWidened += widenChunks.length;

			// Tier 2's vectors, merged into the SAME per-file reuse map the
			// same-branch path uses (`oldChunksCache`, keyed by contentHash), so
			// there is one reuse channel below rather than two.
			await yieldToEventLoop();
			await this.seedTierTwoVectors(pathRoot, storedPathOf, insertChunks);

			// Phase 2: Embed batch chunks (skip if vector mode disabled)
			// SMART INCREMENTAL: Reuse vectors from cache for unchanged chunks
			const batchInfo =
				totalBatches > 1 ? ` [batch ${batchNum + 1}/${totalBatches}]` : "";
			let validChunks: Array<{
				chunk: CodeChunk;
				filePath: string;
				fileHash: string;
				vector: number[];
				embedKey: string;
			}>;

			/**
			 * Files in THIS batch that lost at least one chunk to an empty vector.
			 *
			 * Their tracker stamp is deferred and their rows are removed again, so
			 * the next run redoes them from scratch. Both halves are required: a
			 * deferral that skipped only `markIndexed` would leave rows in LanceDB
			 * and no row in the tracker, `getChanges` classifies a file with no
			 * tracker row as NEW, new files never reach the modified-files
			 * `deleteByFile`, and `addChunks` appends — so every later run would
			 * append another copy, permanently and per run.
			 */
			const filesWithMissingVectors = new Set<string>();

			if (this.vectorEnabled) {
				// Separate chunks into: cached (reuse vector) vs new (need embedding)
				const chunksNeedingEmbedding: Array<{
					chunk: CodeChunk;
					filePath: string;
					fileHash: string;
					originalIndex: number;
				}> = [];
				const cachedChunks: Array<{
					chunk: CodeChunk;
					filePath: string;
					fileHash: string;
					vector: number[];
					embedKey: string;
				}> = [];

				for (let i = 0; i < insertChunks.length; i++) {
					const { chunk, filePath, fileHash } = insertChunks[i];
					// Cache is keyed by absolute path (filePath is already absolute)
					const cachedVectors = this.oldChunksCache.get(filePath);

					if (
						cachedVectors &&
						chunk.contentHash &&
						cachedVectors.has(chunk.contentHash)
					) {
						// REUSE: Same content found in cache - skip embedding API call!
						const reusedVector = cachedVectors.get(chunk.contentHash)!;
						cachedChunks.push({
							chunk,
							filePath,
							fileHash,
							vector: reusedVector,
							// FR-2 holds on this path too: the row carries the key the
							// seam WOULD have computed for it, from the seam's own
							// formula, at the reused vector's actual width. The formula
							// still lives in exactly one file.
							embedKey: this.cachingSeam().keyFor(
								chunk.content,
								reusedVector.length,
							),
						});
					} else {
						// NEW: Content changed or new chunk - needs embedding
						chunksNeedingEmbedding.push({
							chunk,
							filePath,
							fileHash,
							originalIndex: i,
						});
					}
				}

				const reusedCount = cachedChunks.length;
				const newCount = chunksNeedingEmbedding.length;

				if (this.onProgress) {
					const reuseInfo = reusedCount > 0 ? ` (${reusedCount} reused)` : "";
					this.onProgress(
						0,
						insertChunks.length,
						`[embedding]${batchInfo} ${newCount} new${reuseInfo}...`,
					);
				}

				// Only call embedding API for chunks that actually need it
				let newlyEmbeddedChunks: Array<{
					chunk: CodeChunk;
					filePath: string;
					fileHash: string;
					vector: number[];
					embedKey: string;
				}> = [];

				if (chunksNeedingEmbedding.length > 0) {
					const items = chunksNeedingEmbedding.map((c) => c.chunk);
					let embedResult: EmbedResult;

					try {
						// Pass progress callback to track embedding progress
						this.reportPhase("embedding");
						// `embedContentOf`, not `embed(texts)`: the cache key is over
						// the chunk's OWN content, so the texts are derived inside the
						// seam and re-checked against the items at dispatch. A transform
						// inserted between the two would otherwise make every key
						// address a vector for text that was never embedded.
						embedResult = await this.cachingSeam().embedContentOf(
							items,
							"chunks",
							(completed, total, inProgress, cachedHits) => {
								// Stamp the lock per item, not just once per batch below.
								// A single batch against a network embedding provider can run
								// for minutes; stamping only at batch end left
								// `lastProgressAt` untouched past the 5-minute hung threshold
								// (measured: 363s) on a perfectly healthy run, making the
								// lock reclaimable mid-index.
								this.reportProgress();
								if (this.onProgress) {
									const reuseInfo =
										reusedCount > 0 ? ` (${reusedCount} reused)` : "";
									// `completed` counts every slot the seam RESOLVED, cache
									// hits included, so the word "new" becomes a false claim
									// the moment the cache serves anything: an all-hits batch
									// would report "500/500 new" for work that never reached
									// the provider. `(N cached)` is what makes a fast run
									// legible instead of looking free or stalled.
									//
									// `(N reused)` is the OTHER reuse path (LanceDB vectors,
									// §7.5's L1) and is only ever populated when the
									// persistent tier is off or degraded. Both can therefore
									// be non-zero at once on the degraded tier, and both are
									// shown, because they came from different places.
									const cached = cachedHits ?? 0;
									const origin = cached > 0 ? `(${cached} cached)` : "new";
									this.onProgress(
										completed + reusedCount,
										total + reusedCount,
										`[embedding]${batchInfo} ${completed}/${total} ${origin}${reuseInfo}`,
										inProgress,
									);
								}
							},
						);
					} catch (error) {
						const errorMsg =
							error instanceof Error ? error.message : String(error);
						throw new Error(`Embedding generation failed: ${errorMsg}`);
					}

					// Track cost and tokens
					if (embedResult.cost) totalCost += embedResult.cost;
					if (embedResult.totalTokens) totalTokens += embedResult.totalTokens;

					// Verify we got embeddings for all chunks
					if (embedResult.embeddings.length !== items.length) {
						throw new Error(
							`Embedding count mismatch: expected ${items.length}, got ${embedResult.embeddings.length}`,
						);
					}

					// Forward progress: an embed batch completed.
					this.reportProgress();

					// Map embeddings back to chunks
					newlyEmbeddedChunks = chunksNeedingEmbedding
						.map((c, i) => ({
							chunk: c.chunk,
							filePath: c.filePath,
							fileHash: c.fileHash,
							vector: embedResult.embeddings[i],
							embedKey: embedResult.keys?.[i] ?? "",
						}))
						.filter((c) => {
							// `=== 0`, never truthiness (CLAUDE.md #15).
							//
							// A chunk with no vector is still DROPPED, exactly as before,
							// but its file is now remembered. The seam can serve a batch
							// from cache and leave the failed misses empty rather than
							// throwing the whole run away — and stamping such a file at
							// its current hash would delete those chunks from the index
							// permanently, because no later incremental run looks at an
							// unchanged file again.
							if (c.vector.length === 0) {
								filesWithMissingVectors.add(c.filePath);
								return false;
							}
							return true;
						});
				}

				// Combine cached + newly embedded chunks
				validChunks = [...cachedChunks, ...newlyEmbeddedChunks];
			} else {
				// Vector mode disabled - store chunks with placeholder vector (BM25 only)
				// LanceDB requires non-empty vectors, so we use a single-element placeholder
				validChunks = insertChunks.map((c) => ({
					...c,
					vector: [0], // Placeholder - BM25 search only (vector search disabled)
					// Nothing was embedded, so there is no key. The placeholder never
					// reaches the cache — this branch is the `else` of the vector test
					// and calls no embeddings client at all.
					embedKey: "",
				}));
			}

			// Phase 3: Store batch chunks.
			//
			// A DEFERRED FILE IS DROPPED FROM THE BATCH BEFORE R5a, not deleted
			// after the append (§4.1.4, round 3). The loop that used to
			// `deleteByFile` those files afterwards is gone, and it was wrong both
			// ways under the journal: R5b would register ids whose rows it had
			// just deleted (a P1 break), and a crash-recovery would undo the good
			// files that shared its intent batch. Dropped here they stay
			// NEW/MODIFIED, with no row, no membership and no `files` stamp, and
			// the next run redoes them.
			const storableChunks = validChunks.filter(
				(c) => !filesWithMissingVectors.has(c.filePath),
			);
			const chunksWithEmbeddings: ChunkWithEmbedding[] = storableChunks.map(
				(c) => ({
					...c.chunk,
					vector: c.vector,
					embedKey: c.embedKey,
				}),
			);

			if (this.onProgress) {
				const batchInfo =
					totalBatches > 1 ? ` [batch ${batchNum + 1}/${totalBatches}]` : "";
				this.onProgress(
					0,
					chunksWithEmbeddings.length,
					`[storing]${batchInfo} ${chunksWithEmbeddings.length} chunks...`,
				);
			}

			// R5a (§4.1.4): the append is BRACKETED. A crash between here and R5b
			// leaves intents naming exactly the ids that may have been appended,
			// and the next run's recovery deletes them — which is what makes
			// `table.add` being a bare append harmless rather than load-bearing.
			const insertedChunkIds = chunksWithEmbeddings.map((c) => c.id);
			await yieldToEventLoop();
			this.fileTracker!.beginAddIntents(branchId, insertedChunkIds);
			await yieldToEventLoop();

			// Phase marker placed IMMEDIATELY before the (un-cancellable) LanceDB
			// write so a hang here is attributable to "writing:lance" in the report.
			this.reportPhase("writing:lance");
			await this.vectorStore!.addChunks(chunksWithEmbeddings, repoRows);

			// R5b (§4.1.4): ONE transaction — register the appended ids, commit
			// this branch's membership for the INSERT *and* the WIDEN ids, record
			// the WIDEN ids' drain work, stamp the `files` rows, clear the 'add'
			// intents. A WIDEN-ONLY file gets its `files` row here too, which is
			// what stops the next run classifying it NEW forever.
			const widenedChunkIds = widenChunks
				.filter((c) => !filesWithMissingVectors.has(c.filePath))
				.map((c) => c.chunk.id);
			// A DEMOTED id needs the drain too, and this is not obvious. It was
			// registered, so OTHER branches may hold it in `chunk_branches`; its
			// row was missing, so it is being re-INSERTED — with this branch's
			// `,<id>,` and nothing else. Without a `'widen'` intent the mirror
			// would then omit every other holder, and each of them would lose
			// sight of a chunk it still holds. Caught by V3.6's belt row, which
			// compares the mirror against the membership in both directions.
			const mirrorNeededFor = insertedChunkIds.filter((id) =>
				registeredIds.has(id),
			);
			this.fileTracker!.commitAddBatch(branchId, {
				registered: storableChunks.map((c) =>
					chunkIndexRowFor(
						c.chunk.id,
						storedPathOf.get(c.filePath) ??
							toRepoRelative(pathRoot, c.filePath) ??
							c.chunk.filePath,
						c.chunk.contentHash || computeHash(c.chunk.content),
						"code_chunk",
					),
				),
				memberIds: [...insertedChunkIds, ...widenedChunkIds],
				widenIds: [...widenedChunkIds, ...mirrorNeededFor],
				files: fileStampsFor(
					batchChunks,
					filesWithMissingVectors,
					storedPathOf,
					pathRoot,
				),
				clearAddIntentIds: insertedChunkIds,
			});
			await yieldToEventLoop();

			// Forward progress: a batch of chunks was written to the vector store.
			this.reportProgress();

			// NARROW_CHUNKS (§4.1.1) — the step revision 0 of the design did not
			// have, and whose absence was a CRITICAL. Chunk ids are content AND
			// position addressed, so the second edit of a file on one branch
			// produces new ids while the previous revision's ids keep pointing at
			// this branch FOREVER. The orphan sweep cannot collect them: its test
			// is "membership is empty" and those rows have non-empty membership.
			// The result is ghost chunks on the SAME branch, growing per edit.
			//
			// It runs HERE, after this batch's chunks are stored, and it is never
			// gated on a "nothing changed" short-circuit — the property the old
			// `deleteByFile(modifiedFile)` comment protected, transferred verbatim.
			for (const [filePath, newIds] of chunkIdsByFile(batchChunks)) {
				if (filesWithMissingVectors.has(filePath)) continue;
				const storedPath =
					storedPathOf.get(filePath) ?? toRepoRelative(pathRoot, filePath);
				if (storedPath === null) continue;
				const oldIds = this.fileTracker!.chunkIdsForPath(
					branchId,
					"repo",
					storedPath,
					"code_chunk",
				).map((row) => row.chunkId);
				await yieldToEventLoop();
				const stale = oldIds.filter((id) => !newIds.has(id));
				const narrowed = await narrowIds(
					this.fileTracker!,
					this.vectorStore!,
					branchId,
					stale,
				);
				duplicateChunkRows += narrowed.duplicateRows;
				await yieldToEventLoop();
			}

			// Report storing completion
			if (this.onProgress) {
				const total = chunksWithEmbeddings.length;
				this.onProgress(total, total, `[storing] ${total} chunks stored`);
			}

			// Check if vector store auto-cleared due to dimension mismatch
			// If so, we need to also clear file tracker for consistency
			if (this.vectorStore!.dimensionMismatchCleared) {
				this.fileTracker!.clear();
			}

			// Phase 2b: Extract code units with AST metadata (once per file, not per chunk)
			// Runs in same batch loop, produces code_unit records in addition to code_chunk records
			if (this.codeUnitExtractor) {
				// Re-label: this block does AST extraction and a second embedding pass.
				// It previously inherited the "writing:lance" label from the chunk write
				// above, which misattributed stalls here to the LanceDB write path.
				this.reportPhase("code-units");
				const filesProcessedForUnits = new Set<string>();
				/** Files whose extraction finished, so their unit id set is final. */
				const filesWithUnitsExtracted = new Set<string>();
				const batchUnitsToEmbed: Array<{
					unit: CodeUnit;
					filePath: string;
					fileHash: string;
				}> = [];

				// EVERY file of the batch, not only the ones that got new rows.
				// On a second worktree almost every file is a tier-1 hit, so
				// `validChunks` is nearly empty while every one of those files
				// still has code units whose membership this branch has to gain.
				// Iterating `validChunks` here would leave the second branch with
				// chunks and no units for its whole tree.
				for (const { filePath, fileHash } of batchChunks) {
					if (filesProcessedForUnits.has(filePath)) continue;
					// A deferred file was dropped from the batch before R5a and will
					// be redone from scratch next run, so writing code units for it
					// now would create rows whose file has no tracker stamp —
					// `addCodeUnits` appends the same way `addChunks` does.
					if (filesWithMissingVectors.has(filePath)) continue;
					filesProcessedForUnits.add(filePath);

					const language = getParserManager().getLanguage(
						filePath,
					) as SupportedLanguage;
					if (!language) continue;

					try {
						const content = readFileSync(filePath, "utf-8");
						const unitPath =
							storedPathOf.get(filePath) ?? toRepoRelative(pathRoot, filePath);
						if (unitPath === null) continue;
						// The STORED path: unit ids hash it, as chunk ids do.
						const units = await this.codeUnitExtractor.extractUnits(
							content,
							unitPath,
							language,
							fileHash,
						);
						for (const unit of units) {
							batchUnitsToEmbed.push({ unit, filePath, fileHash });
						}
						// Extraction SUCCEEDED, so this file's unit id set is
						// authoritative and NARROW_UNITS may run for it — even when
						// it produced zero units, which is the file that lost its
						// last function. A file whose extraction threw, or that has
						// no parser, is deliberately absent: `newIds` there is not a
						// statement about the file, and narrowing against it would
						// delete every unit the branch has for it.
						filesWithUnitsExtracted.add(filePath);
					} catch (error) {
						// Code unit extraction failure is non-fatal
						const relativePath = relative(projectRealPath, filePath);
						console.warn(
							`Warning: Code unit extraction failed for ${relativePath}: ` +
								`${error instanceof Error ? error.message : String(error)}`,
						);
					}
				}

				// The SAME two-tier hit test as the chunk pass (§3.2.1: code-unit
				// ids go through it too, because they are registered in the same
				// `chunk_index`). Before this phase, code units were never reused
				// from LanceDB at all: `getChunksWithVectors` filters
				// `documentType = 'code_chunk'`, so a unit whose content had not
				// changed was re-embedded on every incremental run and re-appended
				// on every second branch.
				const unitIds = batchUnitsToEmbed.map((u) => u.unit.id);
				await yieldToEventLoop();
				const registeredUnitIds = this.fileTracker!.knownChunkRows(unitIds);
				const liveUnitIds = await this.vectorStore!.existingIds([
					...registeredUnitIds.keys(),
				]);
				totalIdsDemoted += [...registeredUnitIds.keys()].filter(
					(id) => !liveUnitIds.has(id),
				).length;
				/** Every unit's own content hash, computed once for three uses. */
				const unitContentHash = new Map(
					batchUnitsToEmbed.map((u) => [
						u.unit.id,
						computeHash(u.unit.content),
					]),
				);
				// THREE outcomes, and since I-14 the third is a BELT that should
				// never fire. `codeUnitRowId` hashes the unit's content, so an id
				// match implies a content match and two revisions of one function
				// are two rows — which is what lets each branch point at its own.
				// The comparison is kept because a 16-hex id is 64 bits and because
				// the refresh's own registration is a second transaction (below);
				// either can produce a known id whose stored hash disagrees, and
				// refreshing in place is the safe reading of that. Zero is the
				// expected value of `totalUnitsRefreshed` on every ordinary run.
				const unitsToWiden = batchUnitsToEmbed.filter(
					(u) =>
						liveUnitIds.has(u.unit.id) &&
						registeredUnitIds.get(u.unit.id) === unitContentHash.get(u.unit.id),
				);
				const unitsToRefresh = batchUnitsToEmbed.filter(
					(u) =>
						liveUnitIds.has(u.unit.id) &&
						registeredUnitIds.get(u.unit.id) !== unitContentHash.get(u.unit.id),
				);
				const unitsToInsert = batchUnitsToEmbed.filter(
					(u) => !liveUnitIds.has(u.unit.id),
				);
				totalUnitsWidened += unitsToWiden.length;
				totalUnitsRefreshed += unitsToRefresh.length;
				/** Insert AND refresh both need a vector for their new content. */
				const unitsNeedingRows = [...unitsToInsert, ...unitsToRefresh];
				/** Tier 2: a vector the store already holds for this exact text. */
				await yieldToEventLoop();
				const unitVectorReuse = await this.tierTwoUnitVectors(unitsNeedingRows);
				await yieldToEventLoop();

				/** What actually reached LanceDB, for the R5b registration below. */
				let unitsToStore: CodeUnitWithEmbedding[] = [];

				// Embed code units if any were extracted and vector mode is enabled
				if (
					unitsNeedingRows.length > 0 &&
					this.vectorEnabled &&
					this.embeddingsClient
				) {
					const unitBatchInfo =
						totalBatches > 1 ? ` [batch ${batchNum + 1}/${totalBatches}]` : "";
					if (this.onProgress) {
						this.onProgress(
							0,
							unitsNeedingRows.length,
							`[units]${unitBatchInfo} embedding ${unitsNeedingRows.length} code units...`,
						);
					}

					// Tier 2 first: a unit whose text the store already holds at this
					// path lends its vector and reaches no provider at all.
					const unitsNeedingEmbedding = unitsNeedingRows.filter(
						({ unit }) => !unitVectorReuse.has(unit.id),
					);
					const unitItems = unitsNeedingEmbedding.map(({ unit }) => unit);
					let unitEmbedResult: EmbedResult;

					try {
						// Same seam as the chunk pass, same reason: the key is over the
						// unit's own content, derived inside the seam.
						unitEmbedResult = await this.cachingSeam().embedContentOf(
							unitItems,
							"code-units",
							(completed, total, inProgress, cachedHits) => {
								// Same reason as the chunk embed above: this call runs while
								// the phase is still labelled "writing:lance", and without a
								// per-item stamp the lock sat untouched for 351s here on a
								// healthy run — past the 5-minute hung threshold.
								this.reportProgress();
								if (this.onProgress) {
									const cached = cachedHits ?? 0;
									const cachedInfo = cached > 0 ? ` (${cached} cached)` : "";
									this.onProgress(
										completed,
										total,
										`[units]${unitBatchInfo} ${completed}/${total} units${cachedInfo}`,
										inProgress,
									);
								}
							},
						);
					} catch (error) {
						// Unit embedding failure is non-fatal - code_chunk records already stored
						console.warn(
							`Warning: Code unit embedding failed: ` +
								`${error instanceof Error ? error.message : String(error)}`,
						);
						unitEmbedResult = { embeddings: [] };
					}

					if (unitEmbedResult.embeddings.length === unitItems.length) {
						if (unitEmbedResult.cost) totalCost += unitEmbedResult.cost;
						if (unitEmbedResult.totalTokens)
							totalTokens += unitEmbedResult.totalTokens;

						// Forward progress: a unit embed batch completed.
						this.reportProgress();

						const embeddedById = new Map<string, number[]>();
						const keyById = new Map<string, string>();
						unitsNeedingEmbedding.forEach(({ unit }, idx) => {
							embeddedById.set(unit.id, unitEmbedResult.embeddings[idx]);
							keyById.set(unit.id, unitEmbedResult.keys?.[idx] ?? "");
						});

						unitsToStore = unitsNeedingRows
							.map(({ unit }) => {
								const reused = unitVectorReuse.get(unit.id);
								return {
									...unit,
									vector: reused ?? embeddedById.get(unit.id) ?? [],
									// FR-2: a reused vector carries the key the seam WOULD
									// have computed for it, from the seam's own formula, at
									// the reused vector's actual width.
									embedKey: reused
										? this.cachingSeam().keyFor(unit.content, reused.length)
										: (keyById.get(unit.id) ?? ""),
								};
							})
							// `> 0`, i.e. `=== 0` inverted: a unit with no vector is
							// dropped as before. Unit embedding is already non-fatal
							// (its failure is caught above), so there is nothing to
							// defer — the chunks for the file are stored either way.
							.filter((u) => u.vector.length > 0);
					}
				} else if (unitsNeedingRows.length > 0 && !this.vectorEnabled) {
					// BM25-only mode: store units with placeholder vector
					unitsToStore = unitsNeedingRows.map(({ unit }) => ({
						...unit,
						vector: [0],
						embedKey: "",
					}));
				}

				// R5a / the append / R5b, once for both modes (§4.1.4). The
				// WIDEN ids ride in the same R5b as the INSERT ids, exactly as the
				// chunk pass does, so a unit this branch merely points at gets its
				// membership and its drain intent in one transaction.
				const refreshIds = new Set(unitsToRefresh.map((u) => u.unit.id));
				const unitsAppended = unitsToStore.filter((u) => !refreshIds.has(u.id));
				const unitsRewritten = unitsToStore.filter((u) => refreshIds.has(u.id));
				const insertedUnitIds = unitsAppended.map((u) => u.id);
				const widenedUnitIds = unitsToWiden.map((u) => u.unit.id);
				// As above: a demoted unit id may be held by other branches.
				const unitMirrorNeededFor = insertedUnitIds.filter((id) =>
					registeredUnitIds.has(id),
				);
				if (
					insertedUnitIds.length > 0 ||
					widenedUnitIds.length > 0 ||
					unitsRewritten.length > 0
				) {
					this.fileTracker!.beginAddIntents(branchId, insertedUnitIds);
					await yieldToEventLoop();
					if (unitsAppended.length > 0) {
						this.reportPhase("writing:lance");
						await this.vectorStore!.addCodeUnits(unitsAppended, repoRows);
						totalCodeUnitsCreated += unitsAppended.length;
						this.reportProgress();
						if (this.onProgress) {
							this.onProgress(
								unitsAppended.length,
								unitsAppended.length,
								`[units] ${unitsAppended.length} units stored`,
							);
						}
					}
					this.fileTracker!.commitAddBatch(branchId, {
						registered: unitsAppended.map((unit) =>
							chunkIndexRowFor(
								unit.id,
								unit.filePath,
								computeHash(unit.content),
								"code_unit",
							),
						),
						memberIds: [...insertedUnitIds, ...widenedUnitIds],
						widenIds: [...widenedUnitIds, ...unitMirrorNeededFor],
						// No `files` stamp: the chunk pass already wrote it for every
						// file of this batch, in the transaction that committed its
						// chunk membership.
						files: [],
						clearAddIntentIds: insertedUnitIds,
					});
					await yieldToEventLoop();

					// THE REFRESH, registered SECOND on purpose. A crash between the
					// rewrite and the registration leaves the row holding the NEW
					// content under the OLD hash, which the next run reads as a
					// content mismatch and rewrites again — idempotent. Registering
					// first would leave the opposite: the new hash over the old
					// content, which every later run would read as a tier-1 hit.
					if (unitsRewritten.length > 0) {
						const rewrittenIds = unitsRewritten.map((u) => u.id);
						const holders = this.fileTracker!.membershipsOf(rewrittenIds);
						await yieldToEventLoop();
						const mirror = new Map<string, string>();
						for (const id of rewrittenIds) {
							// The row may be held by OTHER branches; the mirror it is
							// written with must keep every one of them.
							mirror.set(
								id,
								canonicalBranchIds([...(holders.get(id) ?? []), branchId]),
							);
						}
						this.reportPhase("writing:lance");
						await this.vectorStore!.refreshCodeUnits(
							unitsRewritten,
							mirror,
							"repo",
						);
						this.reportProgress();
						this.fileTracker!.commitAddBatch(branchId, {
							registered: unitsRewritten.map((unit) =>
								chunkIndexRowFor(
									unit.id,
									unit.filePath,
									computeHash(unit.content),
									"code_unit",
								),
							),
							memberIds: rewrittenIds,
							widenIds: rewrittenIds,
							files: [],
							clearAddIntentIds: [],
						});
						await yieldToEventLoop();
					}
				}

				// NARROW_UNITS (§4.1.1) — AFTER the producer of this class, never
				// before. Run earlier it would delete every code unit of the file,
				// because `newIds` for the class is still empty at that point (N4).
				const newUnitIdsByFile = unitIdsByFile(batchUnitsToEmbed);
				for (const filePath of filesWithUnitsExtracted) {
					const unitIds = newUnitIdsByFile.get(filePath) ?? new Set<string>();
					const storedPath =
						storedPathOf.get(filePath) ?? toRepoRelative(pathRoot, filePath);
					if (storedPath === null) continue;
					const oldUnitIds = this.fileTracker!.chunkIdsForPath(
						branchId,
						"repo",
						storedPath,
						"code_unit",
					).map((row) => row.chunkId);
					await yieldToEventLoop();
					const narrowed = await narrowIds(
						this.fileTracker!,
						this.vectorStore!,
						branchId,
						oldUnitIds.filter((id) => !unitIds.has(id)),
					);
					duplicateChunkRows += narrowed.duplicateRows;
					await yieldToEventLoop();
				}
			}

			// Phase 4: account for this batch.
			//
			// THE `files` STAMP IS NOT HERE ANY MORE. It rides in R5b above, in
			// the transaction that commits this batch's membership (§4.1.4): the
			// stamp may precede the mirror only because the `'widen'` intent
			// committed beside it is what guarantees the mirror. It is also what
			// gives a WIDEN-ONLY file a `files` row at all — without one, the next
			// run classifies it NEW forever, and it never has new chunks to store.
			let deferredInBatch = 0;
			for (const filePath of filesWithMissingVectors) {
				// DEFERRED: at least one chunk of this file came back with an empty
				// vector, so it was dropped from the batch before R5a and has no
				// row, no membership and no stamp. The next run redoes it.
				deferredFiles.add(relative(projectRealPath, filePath));
				deferredInBatch++;
			}

			totalFilesIndexed += chunkIdsByFile(batchChunks).size - deferredInBatch;
			// A deferred file was never stored, so counting its chunks here would
			// report an index the store does not hold. Widened chunks ARE counted:
			// the branch now points at them, which is what the number is about.
			totalChunksCreated += batchChunks.filter(
				(c) => !filesWithMissingVectors.has(c.filePath),
			).length;

			// Collect files for enrichment
			if (this.enableEnrichment && this.enricher) {
				// Group chunks by file for enrichment
				const fileChunksMap = new Map<
					string,
					{ content: string; chunks: CodeChunk[]; language: string }
				>();

				// EVERY chunk of the batch, widened as well as inserted: enrichment
				// is a property of the FILE, and on a second worktree almost every
				// file is a tier-1 hit, so `validChunks` would be nearly empty and
				// the branch would get no summaries at all.
				for (const { chunk, filePath } of batchChunks) {
					if (filesWithMissingVectors.has(filePath)) continue;
					if (!fileChunksMap.has(filePath)) {
						const content = readFileSync(filePath, "utf-8");
						fileChunksMap.set(filePath, {
							content,
							chunks: [],
							language: chunk.language,
						});
					}
					fileChunksMap.get(filePath)!.chunks.push(chunk);
				}

				for (const [filePath, { content, chunks, language }] of fileChunksMap) {
					const storedPath =
						storedPathOf.get(filePath) ?? toRepoRelative(pathRoot, filePath);
					if (storedPath === null) continue;
					fileChunksForEnrichment.push({
						filePath: storedPath,
						fileContent: content,
						codeChunks: chunks,
						language,
					});
				}
			}

			// Memory is released when batchChunks, embeddings, chunksWithEmbeddings go out of scope
		}

		// Set index version after successful chunk + code unit indexing
		// Placed before enrichment so a partial enrichment failure doesn't prevent version write
		// In store.json, beside the data it describes, under the store lock.
		setIndexVersion(loc, CURRENT_INDEX_VERSION);

		// Collect previously-indexed files that still need enrichment
		if (this.enableEnrichment && this.enricher && this.fileTracker) {
			const alreadyQueued = new Set(
				fileChunksForEnrichment.map((f) => f.filePath),
			);
			const unenrichedPaths = this.fileTracker.getFilesNeedingEnrichment(
				branchId,
				"file_summary",
			);

			for (const relPath of unenrichedPaths) {
				if (alreadyQueued.has(relPath)) continue;
				// A stored path, made absolute under THIS worktree's root (§3.6).
				const absPath = join(pathRoot, relPath);
				if (!existsSync(absPath)) continue;

				try {
					const content = readFileSync(absPath, "utf-8");
					const fileHash = computeFileHash(absPath);
					const chunks = await chunkFileByPath(content, relPath, fileHash);
					if (chunks.length === 0) continue;

					fileChunksForEnrichment.push({
						filePath: relPath,
						fileContent: content,
						codeChunks: chunks,
						language: chunks[0].language,
					});
				} catch {
					// Skip files that can't be read/chunked
				}
			}
		}

		// Phase 4.5 & 5: AST Extraction and Enrichment
		// Run in parallel when embedding is local and LLM is cloud (no resource contention)
		let enrichmentResult: EnrichmentResult | undefined;

		const runEnrichment = async (): Promise<void> => {
			if (
				!this.enableEnrichment ||
				!this.enricher ||
				fileChunksForEnrichment.length === 0
			) {
				return;
			}
			try {
				enrichmentResult = await this.enricher.enrichFiles(
					fileChunksForEnrichment,
					{
						concurrency: this.enrichmentConcurrency,
						// Summaries are a function of the tree: this run's branch (§3.2.1).
						membership: repoRows,
						onProgress: (completed, total, phase, status, inProgress) => {
							// Stamp the lock as well as the UI. Without this the whole
							// enrichment phase advances `heartbeat` but never
							// `lastProgressAt`, so a long (but healthy) enrichment run
							// looks hung: past DEFAULT_PROGRESS_TIMEOUT (5 min) the next
							// acquire() reclaims the lock and a second indexer can run
							// concurrently against the same store.
							this.reportProgress();
							if (this.onProgress) {
								this.onProgress(
									completed,
									total,
									`[${phase}] ${status}`,
									inProgress,
								);
							}
						},
					},
				);
			} catch (error) {
				console.warn(
					"⚠️  Enrichment failed:",
					error instanceof Error ? error.message : error,
				);
			}
		};

		const runASTExtraction = async (): Promise<void> => {
			if (filesToIndex.length > 0) {
				await this.extractSymbolGraph(branchId, filesToIndex, force, pathRoot);
			}
		};

		// Label the phase for what actually runs. This block always does AST
		// extraction and only sometimes enrichment, so reporting "enriching"
		// unconditionally made a stall here look like an LLM problem even with
		// enrichment disabled.
		const enrichmentWillRun =
			this.enableEnrichment &&
			!!this.enricher &&
			fileChunksForEnrichment.length > 0;
		this.reportPhase(enrichmentWillRun ? "analyzing+enriching" : "analyzing");

		if (canParallelizeEnrichment) {
			// Parallel: AST extraction and enrichment run concurrently
			// AST uses CPU, enrichment uses cloud LLM - no contention
			await Promise.all([runASTExtraction(), runEnrichment()]);
		} else {
			// Sequential: AST first, then enrichment
			await runASTExtraction();
			await runEnrichment();
		}

		// Add enrichment cost to total
		if (enrichmentResult?.cost) {
			totalCost += enrichmentResult.cost;
		}

		// Phase 6: Fetch external documentation for dependencies
		// Only run if manifest files changed (or force reindex), to avoid unnecessary network calls
		if (this.docsFetcher?.isEnabled() && manifestFilesChanged) {
			try {
				this.reportPhase("fetching:docs");
				const docsResult = await this.fetchExternalDocs();
				if (docsResult.cost) {
					totalCost += docsResult.cost;
				}
			} catch (error) {
				console.warn(
					"⚠️  Documentation fetching failed:",
					error instanceof Error ? error.message : error,
				);
			}
		}

		// ── WIDEN DRAIN (§4.1.3b) ─────────────────────────────────────────────
		//
		// It runs WHETHER OR NOT anything changed. Nothing gates it on a
		// non-empty change set: the first run in a second worktree finds every
		// file unchanged for its branch and every row needing a widen, so a
		// change-gated pass would leave that worktree seeing a permanent subset
		// of the store. Gating it IS V3.18's falsifier.
		//
		// LAST of the writers, so this run's own intents — chunks, units and
		// enriched summaries — are drained inside the same run rather than one
		// run later.
		this.reportPhase("branch-membership");
		const widenDrain = await drainWidenIntents(
			this.fileTracker!,
			this.vectorStore!,
			{
				// CLAUDE.md #20: `reportProgress` advances `lastProgressAt`, which is
				// the SOLE input to the hung/stale decision. A pass that stamps only
				// at the end is the 351-363 s silent-but-healthy run #20 was written
				// about, and this one can rewrite 20 000 rows.
				onBatch: (rowsWidened) => {
					this.reportProgress();
					// No total: computing one would cost a `count(*)` region per
					// batch, which is exactly the kind of work a progress line must
					// not add to the loop it is reporting on.
					this.onProgress?.(
						rowsWidened,
						rowsWidened,
						`[branch-membership] ${rowsWidened} row(s) widened`,
					);
				},
			},
		);
		duplicateChunkRows += widenDrain.duplicateRows;
		totalIdsDemoted += widenDrain.missingRows;

		// ── THE ORPHAN SWEEP (§4.3) ───────────────────────────────────────────
		//
		// AFTER the drain, deliberately. The drain rewrites the mirror of every
		// row this run widened; a sweep that ran first could delete a row the
		// drain still had an intent for, which the drain would then report as an
		// M3 miss — true, reported, and pure noise.
		//
		// Bounded by `ORPHAN_SWEEP_BUDGET` and resumable from `store.json`, so a
		// store with a million rows to reclaim gives back a slice per run instead
		// of one very long run. Nothing here is gated on a change set: a branch
		// is reclaimed by whatever run comes next, on whatever branch.
		let sweep: SweepResult | null = null;
		if (registry !== null) {
			this.reportPhase("branch-sweep");
			sweep = await sweepTombstonedBranches(
				this.fileTracker!,
				this.vectorStore!,
				registry,
				{
					cursor: sweepCursor,
					// CLAUDE.md #20: `reportProgress` advances `lastProgressAt`, the
					// SOLE input to the hung/stale decision. A pass that stamps only
					// at the end is the silent-but-healthy run #20 was written about.
					onProgress: (rows) => {
						this.reportProgress();
						this.onProgress?.(
							rows,
							rows,
							`[branch-sweep] ${rows} membership row(s) reclaimed`,
						);
					},
				},
			);
			sweepCursor = sweep.cursor;
			if (sweep.branchesFinalized.length > 0 || sweep.rowsDeleted > 0) {
				this.onProgress?.(
					0,
					0,
					`[branch-sweep] reclaimed ${sweep.rowsDeleted} row(s) from ` +
						`${sweep.branchesDrained.length} deleted branch(es)`,
				);
			}
		}

		// M5 (I-7 FINAL) — ONE optimize() at the END of the drain, never per
		// batch. Every row a merge rewrites leaves the FTS index; recall is NOT
		// lost (`fullTextSearch` scans the unindexed tail, 982/982 measured), but
		// filtered FTS goes from 0.7 ms to 60-72 ms. `optimize()` folds the tail
		// back in and compacts; 180-700 ms at 20 000-26 000 rows.
		//
		// ── WHAT M5 DOES *NOT* DO, MEASURED ─────────────────────────────────
		// This comment used to say the same call closed an NFR-5 exposure, by
		// restoring BM25 scores the rewrite had shifted "by up to 5 %". It does
		// not, and it never needed to: on a 26 288-row copy of a real store with
		// EVERY row rewritten, BM25 scores were bit-identical before and after —
		// 0 of 1 200 cells moved, and 0 of 1 200 again after a forced
		// `createIndex(replace:true)`. The ranking moved because tied rows come
		// back in STORAGE order, which is `stabilizeRetrieverOrder`'s business in
		// `store.ts`, not this call's. Deleting that claim rather than acting on
		// it is deliberate: a forced rebuild here was measured at 302-314 ms for
		// an IDENTICAL reading, i.e. pure cost.
		//
		// The SWEEP's narrow rewrites mirrors through the same `mergeInsert`, so
		// its rows leave the FTS index in exactly the same way and are folded
		// back in by the same call. So does `--force`'s `narrowBranch` (§4.5),
		// which is the same `narrowIds` over a live branch — a force that
		// narrowed a shared row and was not folded back would leave that row out
		// of the filtered FTS index until some later run happened to optimize.
		if (
			widenDrain.rowsWidened > 0 ||
			(sweep !== null && sweep.rowsNarrowed + sweep.rowsDeleted > 0) ||
			(forceNarrow !== null &&
				forceNarrow.rowsNarrowed + forceNarrow.rowsDeleted > 0)
		) {
			this.reportPhase("branch-membership:optimize");
			await this.vectorStore!.optimize();
			this.reportProgress();
		}
		if (widenDrain.budgetExhausted || widenDrain.remaining > 0) {
			// Since the budget became a floor over the backlog read at drain entry,
			// this is no longer the routine end of a big first index — it means a
			// previous run crashed or aborted mid-drain. Said plainly, and still
			// carried in DATA (`branch_widen_remaining`) for the two entry points
			// that render no progress line at all.
			this.onProgress?.(
				0,
				0,
				`[branch-membership] membership widening incomplete (${widenDrain.remaining} of ${widenDrain.backlog} rows left by an interrupted run) — run \`mnemex index\` again`,
			);
		}

		// Save metadata
		this.reportPhase("finalizing");
		this.fileTracker!.setMetadata("embeddingModel", this.model);
		// The model name alone does not identify what produced these vectors:
		// createEmbeddingsClient() resolves a bare name like "nomic-embed-text"
		// against whatever provider the ambient config names at the time, so the
		// same string means Ollama today and Voyage after a config change. Record
		// the provider the client actually resolved to, so a later run can adopt
		// this index's model without guessing where to send it.
		const usedProvider = this.embeddingsClient?.getProvider();
		if (usedProvider) {
			this.fileTracker!.setMetadata("embeddingProvider", usedProvider);
		}
		this.fileTracker!.setMetadata("lastIndexed", new Date().toISOString());

		// Clean up: Release cached old chunks to free memory
		this.oldChunksCache.clear();

		// Keep the machine-global cache under its size cap, INSIDE both locks.
		//
		// Not after the `finally` that releases them: process B sits in the global
		// lock's poll loop and takes it the instant A releases, so A's DELETE
		// transactions and incremental vacuum would run concurrently with B's
		// indexing against the one shared cache file. B's first write would wait
		// the clamped busy_timeout, get SQLITE_BUSY, and latch its persistent tier
		// off for its whole run — the multi-worktree case this feature exists for,
		// switching itself off. Inside the lock the global lock is what serialises
		// indexers machine-wide, so there is no such contention.
		//
		// Bounded, yielding and deadline-capped by the cache itself; a run that
		// hits the deadline stops and the next one continues, because eviction is
		// idempotent and incremental. Never a reason to fail a run.
		if (this.embedCache) {
			try {
				this.reportPhase("embed-cache:evicting");
				await this.embedCache.enforceBudget();
				this.reportProgress();
			} catch (error) {
				console.warn(
					"⚠️  Embedding cache eviction failed:",
					error instanceof Error ? error.message : error,
				);
			}
		}

		// ── §4.1.5: HEAD is RE-READ before the stamp ──────────────────────────
		//
		// The branch id and the head sha were resolved before the write loop, and
		// the loop then discovered, chunked and embedded for minutes. A checkout
		// mid-run leaves this run stamping branch A's id over files read from
		// branch B's tree. One <256 B read is what stops it claiming so.
		//
		// NOTHING IS ROLLED BACK, and nothing needs to be: the tracker rows record
		// the content hash of what was actually READ, so the next run's ordinary
		// diff re-indexes exactly the files that came from the wrong tree. What
		// the flag adds is that this happens on the NEXT run rather than whenever
		// someone notices.
		let headChangedDuringRun = false;
		if (registry !== null && loc.gitLayout !== null) {
			const headNow = readCurrentHead(loc.gitLayout);
			if (headNow.label !== headLabelAtStart) {
				headChangedDuringRun = true;
				registry.markNeedsReindex(branchId);
				this.onProgress?.(
					0,
					0,
					`[branch] HEAD moved from ${headLabelAtStart} to ${headNow.label} during this run; ` +
						"the branch was NOT stamped as indexed and the next run will redo the files that were read from the other tree",
				);
			} else {
				registry.stamp(branchId, head?.sha ?? null, new Date().toISOString());
			}
		}

		// The registry's end-of-run rename: `lastSeen` for a label this store
		// already knew, plus W-R3's stamp. A NEW label's allocation is not waiting
		// for it, because W-R1 renamed that before any row carried the id.
		registry?.flush();

		// `store.json`'s lifecycle fields, once, before `release()`. The counter
		// advances only on a run that reached here: a run that threw has not
		// confirmed anything, and counting it would skip a pass.
		if (storeState !== null) {
			writeStoreState(loc, {
				confirmRunCounter: storeState.confirmRunCounter + 1,
				sweep: sweepCursor,
			});
		}

		/**
		 * Live entries, for the soft-limit warning. Read from the registry rather
		 * than counted during the run: entries come and go by four different
		 * paths in one run (allocate, resurrect, tombstone, rule C), and a
		 * running total would be four places to forget.
		 */
		const liveBranches =
			registry?.entries().filter((entry) => entry.deletedAt === null).length ??
			0;
		if (liveBranches > BRANCH_SOFT_LIMIT) {
			// A WARNING, never a failure (§4.3: "Ceiling: none"). The registry is
			// read on every search, so a large one is a latency question, not a
			// correctness one.
			this.onProgress?.(
				0,
				0,
				`[branch] this store holds ${liveBranches} branches (soft limit ${BRANCH_SOFT_LIMIT}) — ` +
					"run `mnemex branches prune` to reclaim the ones git no longer has",
			);
		}

		const durationMs = Date.now() - startTime;

		return {
			filesIndexed: totalFilesIndexed,
			chunksCreated: totalChunksCreated,
			codeUnitsCreated: totalCodeUnitsCreated,
			durationMs,
			// The authoritative channel for "which model did this actually use".
			// Every surface renders from here; the onProgress notices above are a
			// convenience on top, not the record.
			embeddingModel: this.model,
			adoptedIndexedModel: !!this.modelAdoption,
			configuredModel: this.modelAdoption?.configuredModel,
			skippedFiles,
			errors,
			// Deferred files are DATA, not a progress line: --agent has no progress
			// callback and the MCP tool passes none at all, and a run that quietly
			// left files unindexed is exactly the thing a caller must be able to see.
			filesDeferred: deferredFiles.size > 0 ? [...deferredFiles] : undefined,
			upgradedFromIndexVersion: this.upgradedFromIndexVersion,
			// ── §6.3's store-location report, built in Phase 3c ───────────────
			//
			// `storeDir` is unconditional: the flip is the moment "where is my
			// index?" stops having a guessable answer, and a field a consumer can
			// rely on being present is worth more than one it has to test for.
			// The other three are absent unless they are true, because each of
			// them is an EVENT — a store was replaced, a layout was degraded, a
			// config value was ignored — and an event reported as `false` on every
			// ordinary run is noise a reader learns to skip.
			storeDir: loc.storeDir,
			storeKind: loc.kind,
			// V4.1's half that 3a-2 deferred to 3c, for the reason it deferred it:
			// before the flip the probed directory and `storeDir` were always the
			// same one, so there was nothing this could ever have reported.
			//
			// ── ABANDONMENT IS NOT UPGRADE, AND 3c IS WHERE THEY SEPARATE ─────
			//
			// §6.1 writes this as `abandonedStoreDir = (probe.dir !== storeDir) ?
			// probe.dir : undefined`, INSIDE its `if (isUpgrade)` block. Gating it
			// on the upgrade is not part of that expression; it was implicit,
			// because before the flip `probe.dir !== storeDir` could not happen at
			// all — the probe looks at `storeDir` first, so it only returns a
			// different directory when `storeDir` holds no store and the
			// per-worktree one does, which is a state the pre-3c default could not
			// produce.
			//
			// FOUND BY TEST, with the gate in place: a store already at
			// CURRENT_INDEX_VERSION sitting at the old location (anyone who had
			// `indexDir` pinned there and removed it, and anyone tracking this
			// branch) relocated to the shared store and reported NOTHING —
			// `upgradeStore` is false, so no `upgraded_from_index_version` and, with
			// the gate, no `abandoned_store_dir` either. A whole index left behind
			// in a directory nothing will ever clean up, silently. That is the
			// class of failure §6.3's data channel exists to prevent, and it is
			// worse here than a missed upgrade notice, because an upgrade at least
			// rebuilds in place.
			//
			// `probe.dir !== storeDir` is exactly "this run is leaving a store
			// behind", whatever the reason, so the condition is §6.1's own and the
			// gate is gone.
			abandonedStoreDir:
				oldStore !== null && oldStore.dir !== loc.storeDir
					? oldStore.dir
					: undefined,
			degradedReason: loc.degradedReason ?? undefined,
			ignoredLegacyIndexDir: loc.ignoredLegacyIndexDir ? true : undefined,
			embedCache: this.embedCacheResultStats(),
			branch: {
				branchId,
				label: headLabelAtStart,
				idsWidened: totalChunksWidened + totalUnitsWidened,
				rowsWidened: widenDrain.rowsWidened,
				widenRemaining: widenDrain.remaining,
				widenBacklog: widenDrain.backlog,
				recoveredCrashResidue:
					crashResidue.added > 0 || crashResidue.removed > 0
						? crashResidue
						: undefined,
				duplicateRows: duplicateChunkRows > 0 ? duplicateChunkRows : undefined,
				idsDemoted: totalIdsDemoted > 0 ? totalIdsDemoted : undefined,
				headChangedDuringRun: headChangedDuringRun ? true : undefined,
				// I-15: the cheapest LIVE check that I-14 worked. Expected 0 on
				// every ordinary run — a non-zero reading is a 64-bit id collision
				// or a crash between a refresh and its registration. An internal
				// counter cannot be read from a user's machine.
				unitsRefreshed: totalUnitsRefreshed,
				// §4.3's lifecycle accounting. Emitted whenever there is a registry
				// at all, including as zeros, so a consumer can rely on the keys.
				branchCount: liveBranches,
				confirmationRan: confirmation !== null,
				confirmationDeferred:
					this.confirmScanPreLock?.deferred === true ? true : undefined,
				branchesUnconfirmed: countDecisions(confirmation, "unconfirmedSince"),
				branchesTombstoned: countDecisions(confirmation, "deletedAt"),
				missingBranchRefs:
					this.confirmScanPreLock !== null &&
					this.confirmScanPreLock.missingRefs.length > 0
						? [...this.confirmScanPreLock.missingRefs]
						: undefined,
				sweepRowsDeleted: sweep?.rowsDeleted ?? 0,
				sweepRowsNarrowed: sweep?.rowsNarrowed ?? 0,
				sweepBranchesFinalized: sweep?.branchesFinalized.length ?? 0,
				sweepRemaining: sweep?.remaining ?? 0,
				// §4.5 / D3. WHICH force this run performed, in DATA: a user who
				// typed `--force` and a repair that rebuilt the store both arrive
				// here as `force === true`, and the blast radius is the difference.
				// Absent when no force happened at all.
				forceScope: force
					? forceNarrow !== null
						? "branch"
						: "store"
					: undefined,
				forceRowsDeleted: forceNarrow?.rowsDeleted,
				forceRowsNarrowed: forceNarrow?.rowsNarrowed,
			},
			cost: totalCost > 0 ? totalCost : undefined,
			totalTokens: totalTokens > 0 ? totalTokens : undefined,
			enrichment: enrichmentResult,
		};
	}

	/**
	 * Search the indexed codebase, through the branch HEAD points at right now.
	 *
	 * Returns the results TOGETHER with D1's response-level flag, because
	 * `branchUnknown` is a property of the response and not of any row: a caller
	 * that only sees `SearchResult[]` cannot report it, and D1's whole argument
	 * is that a silent empty (or a silent superset) is the failure mode worth
	 * preventing. `search()` below keeps the old shape for the callers that do
	 * not surface it; the CLI and the MCP tool use this one.
	 *
	 * The scope is resolved PER CALL, never cached (§2.5, V3.10).
	 */
	async searchScoped(
		query: string,
		options: SearchOptions = {},
	): Promise<BranchScopedSearch> {
		// Initialize with forSearch=true to use stored embedding model
		await this.initialize(true);

		// Force keyword-only mode when vector embeddings are disabled
		const useKeywordOnly = options.keywordOnly || !this.vectorEnabled;

		// Refuse to embed a query into a vector space the table does not hold.
		// Recorded by initialize() under 'force-model' when the rebuild that would
		// have reconciled the two did not run; a wrong-space query returns ranked
		// nonsense with no error whenever the dimensions happen to agree.
		if (!useKeywordOnly && this.searchModelMismatch) {
			throw new EmbeddingModelMismatchError(
				this.searchModelMismatch.stored,
				this.searchModelMismatch.configured,
			);
		}

		// Generate query embedding (skip if keyword-only mode or vector disabled)
		let queryVector: number[] | undefined;
		if (!useKeywordOnly && this.embeddingsClient) {
			queryVector = await this.embeddingsClient.embedOne(query);
		}

		// The branch this read is scoped to. D1 (§4.4.2): a HEAD with no registry
		// entry drops the filter and sets `branchUnknown`, rather than returning
		// nothing — returning nothing fails INVISIBLY, and an agent reads "no
		// results" as "this code does not exist" and writes it again.
		const branch = resolveBranchScopeForRead(
			resolveStoreLocation(this.projectPath),
		);

		// Search
		const results = await this.vectorStore!.search(
			query,
			queryVector,
			branch.scope,
			{
				...options,
				keywordOnly: useKeywordOnly,
			},
		);

		// D1's per-row attribution: ids -> registry labels, from the snapshot the
		// scope was resolved against. The registry is ~10 entries and already
		// read, so this is a lookup, not a query.
		for (const r of results) {
			if (r.branchIds !== undefined) {
				r.branches = labelBranchIds(r.branchIds, branch.labels);
			}
		}

		// Dead code deprioritization: penalize symbols with 0 callers
		// This prevents agents from being directed to unused/dead code
		if (this.fileTracker && results.length > 1) {
			const DEAD_CODE_PENALTY = 0.6; // 40% score reduction
			const graph = this.fileTracker.graph(graphBranchIdForRead(branch));
			for (const r of results) {
				if (!r.chunk.name) continue;
				const syms = graph.getSymbolByName(r.chunk.name);
				// Find the symbol in the same file
				const sym =
					syms.find((s) => s.filePath === r.chunk.filePath) ?? syms[0];
				if (sym && sym.inDegree === 0 && sym.pagerankScore < 0.001) {
					r.score *= DEAD_CODE_PENALTY;
				}
			}
			// Re-sort after penalty
			results.sort((a, b) => b.score - a.score);
		}

		// ── `branchEmpty` reaches SEARCH (decision I-17 item 2) ──────────────
		//
		// The asymmetry this closes: the nine graph commands say "this branch is
		// known but holds no rows"; `search`, the most-used command in the tool,
		// returned `[]` in silence. D1's entire argument is that an empty result
		// fails INVISIBLY, and that argument does not weaken when the cause is an
		// empty branch rather than an unknown one — a user whose worktree was
		// emptied by a colleague's `--force-all` got an explicit `dead-code` and a
		// silent `search`.
		//
		// ONE definition of "empty" (`branchHoldsNoRows`), shared with
		// `resolveBranchReadState`, not a second predicate. Computed on the
		// tracker THIS call already has open, so unlike the graph commands' path
		// it costs no second SQLite connection — two counts on a warm schema memo,
		// against the ~0.15 ms the standalone path measures for open + count +
		// close.
		//
		// Only when the results are EMPTY. A non-empty result set cannot have come
		// from a branch that holds nothing, so computing it would be two queries
		// spent to learn `false`. Only for a resolved live branch, for the reason
		// `branch-state.ts` gives: outside a repository there is no branch to be
		// empty, and an unknown branch is already reported as unknown.
		const branchEmpty =
			results.length === 0 &&
			!branch.branchUnknown &&
			branch.scope.kind === "branch" &&
			this.fileTracker !== null
				? branchHoldsNoRows(this.fileTracker, branch.scope.branchId)
				: false;

		// ── V1.7: WHY it is empty, when the store itself can say ──────────────
		//
		// §4.5's marker, consumed. `branchEmpty` (from ROWS) is the signal and
		// stays the authority — it is true of every way of reaching this state,
		// including an interrupted `--force` and a partly-drained sweep, which no
		// producer stamps, and rows cannot be lost to a hand-edited `store.json`.
		// This only narrows the REASON: a whole-store rebuild that happened AFTER
		// this branch was last indexed is why its rows are gone, and "another
		// worktree rebuilt the store" is something a user can act on where "this
		// branch is empty" sends them looking for a bug.
		//
		// Computed ONLY when the branch is already known to be empty, so it can
		// never contradict the rows-based signal or stand in for it — decision
		// I-17 item 3's condition for building it at all. `lastIndexedAt === null`
		// counts: a branch whose stamp was cleared by a rebuild it did not survive
		// is the same story.
		const storeRebuiltElsewhere =
			branchEmpty &&
			(() => {
				const rebuiltAt = readStoreRebuildAt(
					resolveStoreLocation(this.projectPath),
				);
				if (rebuiltAt === null) return false;
				return (
					branch.lastIndexedAt === null || rebuiltAt > branch.lastIndexedAt
				);
			})();

		return {
			results,
			branchUnknown: branch.branchUnknown,
			branchLabel: branch.label,
			branchEmpty,
			storeRebuiltElsewhere,
		};
	}

	/**
	 * `searchScoped` without the response-level flags, for callers that do not
	 * surface them. Every row still carries its `branches` attribution.
	 */
	async search(
		query: string,
		options: SearchOptions = {},
	): Promise<SearchResult[]> {
		return (await this.searchScoped(query, options)).results;
	}

	/**
	 * Get index status
	 */
	async getStatus(): Promise<IndexStatus> {
		const indexDbPath = getIndexDbPath(this.projectPath);

		if (!existsSync(indexDbPath)) {
			return {
				exists: false,
				totalFiles: 0,
				totalChunks: 0,
				languages: [],
			};
		}

		// Initialize with forSearch=true (not indexing, just reading status)
		await this.initialize(true);

		const trackerStats = this.fileTracker!.getStats(
			graphBranchIdForRead(
				resolveBranchScopeForRead(resolveStoreLocation(this.projectPath)),
			),
		);

		// A corrupt index must be REPORTED, not thrown, so the caller can route
		// to the repair in index() above. Throwing here would abort every
		// caller before it ever reached the code that fixes the problem.
		if (await this.vectorStore!.isUnqueryable()) {
			return {
				exists: true,
				corrupt: true,
				totalFiles: trackerStats.totalFiles,
				totalChunks: 0,
				embeddingModel:
					this.fileTracker!.getMetadata("embeddingModel") || undefined,
				languages: [],
			};
		}

		const storeStats = await this.vectorStore!.getStats();

		const embeddingModel = this.fileTracker!.getMetadata("embeddingModel");
		const lastIndexed = this.fileTracker!.getMetadata("lastIndexed");

		return {
			exists: true,
			totalFiles: trackerStats.totalFiles,
			totalChunks: storeStats.totalChunks,
			lastUpdated: lastIndexed ? new Date(lastIndexed) : undefined,
			embeddingModel: embeddingModel || undefined,
			languages: storeStats.languages,
		};
	}

	/**
	 * Drop BOTH halves of the store for a whole-store rebuild (architecture
	 * §4.5, §3.5.1): LanceDB's table, and the tracker's six tree-scoped tables,
	 * which are DROPPED and re-created in their current shape. `clear()`'s
	 * `DELETE FROM` alone would keep an old schema alive, which is how a zombie
	 * schema survives a rebuild. The repo-scoped `metadata` is then emptied, as
	 * every other whole-store rebuild empties it, and the run re-stamps it.
	 *
	 * The branch registry is NOT touched. Ids are never reused, and the rows this
	 * run writes carry the id it already resolved.
	 */
	/**
	 * TIER 2 for code chunks (§4.1.2): for every chunk that needs a row, find a
	 * stored row with the SAME content at the SAME path and lend its vector.
	 *
	 * Merged into `oldChunksCache` — the map the same-branch reuse path already
	 * consults, keyed by absolute file path then by contentHash — so the
	 * embedding phase below has ONE reuse channel to read rather than two. The
	 * same-branch population wins where both have an entry, which is the same
	 * vector either way.
	 *
	 * Tier 2 never widens. A contentHash match at a different id means the
	 * stored row's `startLine`/`endLine` describe the OTHER revision's line
	 * numbers, so reusing the ROW would serve a result pointing at the wrong
	 * lines; only the vector is reused, into a new row with the new range.
	 */
	private async seedTierTwoVectors(
		pathRoot: string,
		storedPathOf: ReadonlyMap<string, string>,
		insertChunks: ReadonlyArray<{ chunk: CodeChunk; filePath: string }>,
	): Promise<void> {
		const byFile = new Map<string, Map<string, string>>();
		for (const { chunk, filePath } of insertChunks) {
			if (!chunk.contentHash) continue;
			const forFile = byFile.get(filePath);
			if (forFile === undefined) {
				byFile.set(filePath, new Map([[chunk.contentHash, chunk.id]]));
			} else {
				forFile.set(chunk.contentHash, chunk.id);
			}
		}
		for (const [filePath, wanted] of byFile) {
			const storedPath =
				storedPathOf.get(filePath) ?? toRepoRelative(pathRoot, filePath);
			if (storedPath === null) continue;
			const hits = this.fileTracker!.findByContentKey("repo", storedPath, [
				...wanted.keys(),
			]);
			await yieldToEventLoop();
			if (hits.size === 0) continue;
			const vectors = await this.vectorStore!.getVectorsByIds([
				...hits.values(),
			]);
			if (vectors.size === 0) continue;
			const cache = this.oldChunksCache.get(filePath) ?? new Map();
			for (const [contentHash, storedId] of hits) {
				const vector = vectors.get(storedId);
				if (vector !== undefined && !cache.has(contentHash)) {
					cache.set(contentHash, vector);
				}
			}
			this.oldChunksCache.set(filePath, cache);
		}
	}

	/**
	 * TIER 2 for code units, by unit id.
	 *
	 * This is the gap `phase-3b-inputs.md` §4 names: `getChunksWithVectors`
	 * filters `documentType = 'code_chunk'`, so a code unit could never be
	 * reused from LanceDB at all — not across branches, and not across two
	 * revisions of one file. `chunk_index.content_hash` carries the unit's own
	 * text hash, so the same lookup that serves chunks serves units.
	 */
	private async tierTwoUnitVectors(
		units: ReadonlyArray<{ unit: CodeUnit }>,
	): Promise<Map<string, number[]>> {
		const reuse = new Map<string, number[]>();
		if (units.length === 0) return reuse;
		const byPath = new Map<string, Map<string, string>>();
		for (const { unit } of units) {
			const hash = computeHash(unit.content);
			const forPath = byPath.get(unit.filePath);
			if (forPath === undefined) {
				byPath.set(unit.filePath, new Map([[hash, unit.id]]));
			} else if (!forPath.has(hash)) {
				forPath.set(hash, unit.id);
			}
		}
		for (const [storedPath, wanted] of byPath) {
			const hits = this.fileTracker!.findByContentKey("repo", storedPath, [
				...wanted.keys(),
			]);
			await yieldToEventLoop();
			if (hits.size === 0) continue;
			const vectors = await this.vectorStore!.getVectorsByIds([
				...hits.values(),
			]);
			for (const [hash, storedId] of hits) {
				const vector = vectors.get(storedId);
				const unitId = wanted.get(hash);
				if (vector !== undefined && unitId !== undefined) {
					reuse.set(unitId, vector);
				}
			}
		}
		return reuse;
	}

	private async rebuildStore(): Promise<void> {
		const store = this.vectorStore;
		const tracker = this.fileTracker;
		if (store === null || tracker === null) {
			throw new Error(
				"rebuildStore: the store is not open; initialize() first",
			);
		}
		await store.clear();
		tracker.rebuildTreeScopedSchemaForV4();
		// Two tracker regions back to back, and NO yield between them. This is not
		// a loop, so it is two regions' worth of blocking, never N: the reasoning
		// `getChanges` documents. SR-2 is a rule about loops, and the loop sweep's
		// mutation test rejects a yield whose removal it could not detect.
		tracker.clear();
		// ── §4.5's marker, stamped HERE rather than at each producer (V1.7) ───
		//
		// §4.5 says `storeRebuildAt` "is stamped by every store-wide producer"
		// and lists five. That is a rule an implementer has to remember at each
		// site, and this build has already watched exactly that kind of rule fail:
		// the SAME producer table said all five route through `rebuildStore()`,
		// and three of them called `clear()` for months while the table read
		// correct (3b-3b's finding 2). A list of obligations is not a mechanism.
		//
		// `rebuildStore()` IS the whole-store producer — every one of the six
		// (placeholder repair, corruption repair, `force-model`, the version
		// upgrade, `--force-all`, `mnemex clear --all`) reaches the store through
		// this function and nothing else drops the table. Stamping here makes a
		// producer that forgets the marker unconstructible, instead of merely
		// forbidden. A branch-scoped narrow does not come through here, which is
		// the distinction the marker exists to draw.
		//
		// Every caller holds the store lock (it is reached only from
		// `indexInternal`, which `index()` wraps, and from `clear()`, which takes
		// it itself), so this satisfies §3.6's lock-held write discipline.
		stampStoreRebuild(resolveStoreLocation(this.projectPath));
	}

	/**
	 * `mnemex clear` — remove this branch's rows, or the whole store.
	 *
	 * ── WHY THIS IS A PRECONDITION FOR PHASE 3c, NOT A POLISH ITEM ────────────
	 * (`phase-3b-inputs.md` §10, decision I-17 item 1.)
	 *
	 * Until 3c this was:
	 *
	 *     await this.initialize();
	 *     await this.vectorStore!.clear();   // dropTable — EVERY branch
	 *     this.fileTracker!.clear();         // DELETE FROM — seven tables
	 *
	 * Three defects in four lines, each of which `--force` had and had fixed in
	 * 3b-3b while this command, which has one caller and had zero tests, kept
	 * all three:
	 *
	 *   1. NO LOCK, AT ALL. On a per-worktree store that is a local mistake: the
	 *      only thing it can race is your own index run. From 3c the store is
	 *      shared, so this becomes an UNLOCKED destructive command against a
	 *      store another worktree may be indexing at that moment — the precise
	 *      hazard FR-2 and the whole lock design exist to prevent, reached
	 *      through a command no phase had scoped.
	 *   2. WHOLE-STORE BY DEFAULT. Same silent data loss I-16 found in `--force`:
	 *      every sibling branch's rows go, the siblings keep their registry
	 *      entries, so `branchUnknown` never fires and their next search is empty
	 *      with no signal. D3's rule applies unchanged — when an operation's
	 *      blast radius grows because the store became shared, the DEFAULT must
	 *      shrink rather than stay.
	 *   3. `clear()` DOES NOT CLEAR THE SYMBOL GRAPH. `FileTracker.clear()`'s
	 *      `DELETE FROM` pass does not include `symbols`, `symbol_references` or
	 *      `graph_metadata` (3b-3b's finding 2, measured: a sibling left with 7
	 *      symbol rows and 0 chunks). That state is worse than empty, because
	 *      `map` and `dead-code` then answer from rows `search` cannot see. The
	 *      whole-store path goes through `rebuildStore()` for exactly that
	 *      reason, as §4.5's producer table always said it should.
	 *
	 * ── THE SHAPE, WHICH IS `--force` / `--force-all`'s ───────────────────────
	 * `scope: "branch"` narrows this branch and leaves rows another branch still
	 * holds — `narrowBranch`, the same function `--force` drives, minus the
	 * re-index that follows it there. `scope: "store"` is `rebuildStore()`, and
	 * it stamps `storeRebuildAt` like every other whole-store producer (§4.5), so
	 * a sibling worktree's next search can say WHY it is empty.
	 *
	 * A store with no git layout takes the whole-store path whatever the caller
	 * asked for: every row there carries `BRANCH_ID_SHARED` (§3.2.1), so "this
	 * branch" and "the whole store" are the same set of rows, and reporting a
	 * branch scope for it would be a lie. Same ruling as 3b-3b's decision 2.
	 *
	 * The store lock is held across the whole read-modify-write, and it FAILS
	 * CLOSED: an unavailable lock throws `IndexLockError` and nothing is touched.
	 * The MACHINE-GLOBAL lock is deliberately NOT taken — it serialises embedding
	 * quota across repositories, and this command embeds nothing.
	 */
	async clear(
		options: { readonly scope?: ClearScope } = {},
	): Promise<ClearResult> {
		const requested = options.scope ?? "branch";
		ensureProjectDir(this.projectPath);
		await this.initialize();

		const loc = resolveStoreLocation(this.projectPath);
		const lock = createStoreLock(loc);
		const acquired = await lock.acquire({
			...this.lockOptions,
			onWaiting: this.onWaitingForLock,
		});
		if (!acquired.acquired) {
			throw new IndexLockError(
				acquired.holderPid,
				acquired.runningFor,
				acquired.reason as "already_running" | "timeout" | "error",
			);
		}
		this.indexLock = lock;
		try {
			// No git layout: one tree, so the two scopes name the same rows.
			if (loc.gitLayout === null || requested === "store") {
				await this.rebuildStore(); // stamps storeRebuildAt (§4.5, V1.7)
				return { scope: "store", membershipRowsRemoved: 0, rowsDeleted: 0 };
			}

			// Under the lock, and nowhere else (REG-1). The registry is opened for
			// the id and for W-R6's stamp clear; nothing is allocated that is not
			// already there, because `resolveId` resurrects rather than reallocates.
			const rowSources = combineBranchIdSources(
				this.fileTracker!,
				await this.vectorStore!.highestBranchId(),
			);
			const registry = openRegistry(loc, lock, rowSources);
			const head = readCurrentHead(loc.gitLayout);
			const branchId = registry.resolveId(head);
			if (branchId === BRANCH_ID_SHARED) {
				await this.rebuildStore();
				return { scope: "store", membershipRowsRemoved: 0, rowsDeleted: 0 };
			}
			// W-R6 FIRST, as in `--force`: the record of when this branch was last
			// indexed stops being true before its rows go, not after.
			registry.clearIndexStamp(branchId);
			const narrowed = await narrowBranch(
				this.fileTracker!,
				this.vectorStore!,
				branchId,
				{
					// CLAUDE.md #20: `reportProgress` advances `lastProgressAt`, the
					// SOLE input to the hung/stale decision, and this loop runs for as
					// long as the branch is large.
					onProgress: (rows) => {
						this.reportProgress();
						this.onProgress?.(
							rows,
							rows,
							`[clear] ${rows} membership row(s) cleared for this branch`,
						);
					},
				},
			);
			return {
				scope: "branch",
				branchLabel: head.label,
				membershipRowsRemoved: narrowed.membershipRowsRemoved,
				rowsDeleted: narrowed.rowsDeleted,
				rowsNarrowed: narrowed.rowsNarrowed,
			};
		} finally {
			lock.release();
			this.indexLock = null;
		}
	}

	/**
	 * Check if another process is currently indexing this project
	 */
	isIndexingInProgress(): {
		inProgress: boolean;
		holderPid?: number;
		runningFor?: number;
	} {
		const lock = createStoreLock(resolveStoreLocation(this.projectPath));
		const status = lock.isLocked();
		return {
			inProgress: status.locked,
			holderPid: status.holderPid,
			runningFor: status.runningFor,
		};
	}

	/**
	 * Force release a stale lock (use when a previous indexing process died)
	 */
	forceUnlock(): boolean {
		const lock = createStoreLock(resolveStoreLocation(this.projectPath));
		return lock.forceRelease();
	}

	/**
	 * Get the stored embedding model for a project without full initialization.
	 * Useful for quick checks before search operations.
	 */
	static getStoredEmbeddingModel(projectPath: string): string | null {
		const indexDbPath = getIndexDbPath(projectPath);
		if (!existsSync(indexDbPath)) {
			return null;
		}
		const tracker = createFileTracker(indexDbPath, projectPath);
		const model = tracker.getMetadata("embeddingModel");
		tracker.close();
		return model;
	}

	/**
	 * Discover files to index, as absolute paths under `root`: the project's
	 * real path, so they share `pathRoot`'s spelling. Symlinks are not followed
	 * (a `Dirent` for one is neither a file nor a directory), so a symlink out of
	 * the tree is never discovered.
	 */
	private discoverFiles(root: string): string[] {
		const files: string[] = [];
		const parserManager = getParserManager();
		const supportedExtensions = new Set(parserManager.getSupportedExtensions());

		const walk = (dir: string) => {
			const entries = readdirSync(dir, { withFileTypes: true });

			for (const entry of entries) {
				const fullPath = join(dir, entry.name);
				const relativePath = relative(root, fullPath);

				// Check exclude patterns
				if (
					sharedShouldExclude(
						relativePath,
						entry.isDirectory(),
						this.excludePatterns,
					)
				) {
					continue;
				}

				if (entry.isDirectory()) {
					walk(fullPath);
				} else if (entry.isFile()) {
					// Check include patterns if specified
					if (
						this.includePatterns.length > 0 &&
						!sharedShouldInclude(relativePath, this.includePatterns)
					) {
						continue;
					}

					// Get file extension and check if supported by parser
					const ext = `.${entry.name.split(".").pop()?.toLowerCase()}`;
					if (supportedExtensions.has(ext)) {
						files.push(fullPath);
					}
				}
			}
		};

		walk(root);
		return files;
	}

	/**
	 * `FileTracker.getChanges()` over `allFiles`, in slices with a yield between
	 * them — see CHANGES_SLICE for why one call over a whole repository is a
	 * heartbeat hazard.
	 *
	 * The same answer as one call. new/modified/unchanged concatenate in input
	 * order. DELETED needs care: each call reports every tracked path that is not
	 * in THAT slice, so a path is deleted iff EVERY slice reports it — the
	 * intersection, kept in the first slice's order.
	 */
	private async getChangesInSlices(
		branchId: number,
		allFiles: string[],
	): Promise<FileChanges> {
		const size = Math.max(
			CHANGES_SLICE,
			Math.ceil(allFiles.length / CHANGES_MAX_SLICES),
		);
		const newFiles: string[] = [];
		const modifiedFiles: string[] = [];
		const unchangedFiles: string[] = [];
		let deletedFiles: string[] | null = null;
		// At least one call, so an empty file list still reports every tracked
		// path as deleted.
		for (let start = 0; start === 0 || start < allFiles.length; start += size) {
			const part = this.fileTracker!.getChanges(
				branchId,
				allFiles.slice(start, start + size),
			);
			for (const f of part.newFiles) newFiles.push(f);
			for (const f of part.modifiedFiles) modifiedFiles.push(f);
			for (const f of part.unchangedFiles) unchangedFiles.push(f);
			if (deletedFiles === null) {
				deletedFiles = part.deletedFiles;
			} else {
				const stillMissing = new Set(part.deletedFiles);
				deletedFiles = deletedFiles.filter((p) => stillMissing.has(p));
			}
			await yieldToEventLoop();
		}
		return {
			newFiles,
			modifiedFiles,
			deletedFiles: deletedFiles ?? [],
			unchangedFiles,
		};
	}

	/**
	 * Extract symbol graph from indexed files
	 * Phase 4.5 of the indexing pipeline
	 */
	private async extractSymbolGraph(
		branchId: number,
		filesToIndex: string[],
		force: boolean,
		pathRoot: string,
	): Promise<void> {
		const symbolExtractor = createSymbolExtractor();
		// This run's branch, for every symbol-graph statement below. `--force`
		// clears THIS branch's graph, not the store's (D3, §4.5).
		const graph = this.fileTracker!.graph(branchId);
		const graphManager = createReferenceGraphManager(
			this.fileTracker!,
			branchId,
		);
		const parserManager = getParserManager();

		// Delete old symbols/references for files being re-indexed
		if (!force) {
			for (const filePath of filesToIndex) {
				graph.deleteSymbolsByFile(filePath);
				// SR-2: one R-txn per file, and nothing else in this loop.
				await yieldToEventLoop();
			}
		} else {
			// Full reindex - clear all symbol data
			graph.clearSymbolGraph();
		}

		// Extract symbols and references from each file
		if (this.onProgress) {
			this.onProgress(
				0,
				filesToIndex.length,
				"[analyzing] extracting symbols...",
			);
		}

		let processedFiles = 0;
		for (const filePath of filesToIndex) {
			const language = parserManager.getLanguage(filePath);
			if (!language) {
				continue;
			}

			try {
				const content = readFileSync(filePath, "utf-8");
				// The symbol's STORED path, repo-relative like every other one (§3.1).
				const relativePath = toRepoRelative(pathRoot, filePath);
				if (relativePath === null) {
					throw new Error(
						`outside-path-root: ${filePath} is not under ${pathRoot}`,
					);
				}

				// Extract symbols
				const symbols = await symbolExtractor.extractSymbols(
					content,
					relativePath,
					language as SupportedLanguage,
				);

				if (symbols.length > 0) {
					// R3: one BEGIN IMMEDIATE region per GRAPH_CHUNK rows with a yield
					// after each, where one region per file was unbounded in the file's
					// symbol count. A failure part-way leaves the chunks already
					// committed — the same partial state a failed insertReferences
					// after a successful insertSymbols always left.
					for (let i = 0; i < symbols.length; i += GRAPH_CHUNK) {
						graph.insertSymbols(symbols.slice(i, i + GRAPH_CHUNK));
						await yieldToEventLoop();
					}

					// Extract references
					const references = await symbolExtractor.extractReferences(
						content,
						relativePath,
						language as SupportedLanguage,
						symbols,
					);

					for (let i = 0; i < references.length; i += GRAPH_CHUNK) {
						graph.insertReferences(references.slice(i, i + GRAPH_CHUNK));
						await yieldToEventLoop();
					}
				}
			} catch (error) {
				// Symbol extraction errors shouldn't fail indexing
				console.warn(
					`Warning: Failed to extract symbols from ${filePath}:`,
					error instanceof Error ? error.message : error,
				);
			}

			// One file's work per yield — on the error path too, where a region may
			// have run and thrown. The awaits above do NOT yield:
			// `parserManager.parse()` returns a cached parser, so they resolve as
			// microtasks and tree-sitter parses synchronously. Measured: 400 files
			// through extractSymbols + extractReferences ran 2 377 ms with ZERO ticks
			// of a 20 ms interval, so without this the whole symbol phase is one
			// block and starves the lock heartbeat on any sizeable repository.
			await yieldToEventLoop();

			processedFiles++;
			if (processedFiles % 50 === 0) {
				// Keep `lastProgressAt` advancing through symbol extraction too — on a
				// large repo this loop alone can exceed the 5-minute hung threshold
				// and get the lock reclaimed out from under us.
				this.reportProgress();
				if (this.onProgress) {
					this.onProgress(
						processedFiles,
						filesToIndex.length,
						`[analyzing] ${processedFiles}/${filesToIndex.length} files`,
					);
				}
			}
		}

		// Resolve cross-file references
		this.reportProgress();
		if (this.onProgress) {
			this.onProgress(0, 1, "[analyzing] resolving references...");
		}
		const resolvedCount = await graphManager.resolveReferences();

		// Compute PageRank scores
		this.reportProgress();
		if (this.onProgress) {
			this.onProgress(0, 1, "[analyzing] computing importance scores...");
		}
		await graphManager.computeAndStorePageRank();
		this.reportProgress();

		// Generate and cache repo map
		const repoMapGen = createRepoMapGenerator(this.fileTracker!, branchId);
		const repoMap = repoMapGen.generate({ maxTokens: 4000 });
		this.fileTracker!.setMetadata("repoMap", repoMap);
		this.fileTracker!.setMetadata(
			"repoMapGeneratedAt",
			new Date().toISOString(),
		);

		// Store graph stats
		const stats = graph.getSymbolGraphStats();
		this.fileTracker!.setMetadata("symbolGraphStats", JSON.stringify(stats));

		if (this.onProgress) {
			this.onProgress(
				filesToIndex.length,
				filesToIndex.length,
				`[analyzing] ${stats.totalSymbols} symbols, ${resolvedCount} refs resolved`,
			);
		}
	}

	/**
	 * Fetch external documentation for project dependencies
	 * Phase 6 of the indexing pipeline
	 *
	 * Uses parallel fetching for better performance when fetching many libraries.
	 */
	private async fetchExternalDocs(): Promise<{
		librariesFetched: number;
		chunksAdded: number;
		cost?: number;
	}> {
		if (
			!this.docsFetcher ||
			!this.embeddingsClient ||
			!this.vectorStore ||
			!this.fileTracker
		) {
			return { librariesFetched: 0, chunksAdded: 0 };
		}

		// Pre-resolved outside the locked region on the `index()` path. The `??`
		// fallback covers the other three `initialize()` entry points, which do not
		// hold the lock, and is bounded by the keychain process budget either way.
		const config = this.docsConfigPreLock ?? getDocsConfig(this.projectPath);
		const cacheTTLMs = (config.cacheTTL || 24) * 60 * 60 * 1000;

		// Detect dependencies
		const deps = await this.docsFetcher.detectDependencies(this.projectPath);
		if (deps.length === 0) {
			return { librariesFetched: 0, chunksAdded: 0 };
		}

		// Filter to dependencies that need refresh. A loop, not `filter()`: each
		// check is a tracker read region, and an array iterator cannot yield
		// between elements (SR-2).
		const depsToFetch: typeof deps = [];
		for (const dep of deps) {
			if (
				this.fileTracker!.needsDocsRefresh(
					dep.name,
					dep.majorVersion,
					cacheTTLMs,
				)
			) {
				depsToFetch.push(dep);
			}
			await yieldToEventLoop();
		}

		if (depsToFetch.length === 0) {
			if (this.onProgress) {
				this.onProgress(
					deps.length,
					deps.length,
					`[docs] ${deps.length} libraries up-to-date`,
				);
			}
			return { librariesFetched: 0, chunksAdded: 0 };
		}

		if (this.onProgress) {
			this.onProgress(
				0,
				depsToFetch.length,
				`[docs] fetching ${depsToFetch.length} libraries...`,
			);
		}

		// Thread-safe counters (JS is single-threaded for sync ops)
		let librariesFetched = 0;
		let totalChunksAdded = 0;
		let totalCost = 0;
		let completed = 0;
		const inProgress = new Set<string>();
		const concurrency = this.enrichmentConcurrency; // Use same concurrency as enrichment

		// Process a single dependency
		const processDep = async (dep: (typeof depsToFetch)[0]): Promise<void> => {
			inProgress.add(dep.name);

			// Report progress with active items
			if (this.onProgress) {
				const active = inProgress.size;
				const activeList = Array.from(inProgress).slice(0, 3).join(", ");
				const moreCount = active > 3 ? ` +${active - 3}` : "";
				this.onProgress(
					completed,
					depsToFetch.length,
					`[docs] ${completed}/${depsToFetch.length} (${active} active) ${activeList}${moreCount}`,
					active,
				);
			}

			try {
				// Fetch and chunk documentation
				const chunks = await this.docsFetcher!.fetchAndChunk(dep.name, {
					version: dep.majorVersion,
				});

				if (chunks.length === 0) {
					return;
				}

				// Virtual path for documentation chunks
				const docsPath = `docs:${dep.name}`;

				// Delete old chunks for this library first
				await this.vectorStore!.deleteByFile(docsPath);

				// Embed the chunks — through the seam's content-derived entry point,
				// like the chunk and code-unit passes. Docs are inside the cache
				// deliberately: a package's documentation is byte-identical for every
				// repo that depends on it, which is the case a machine-global cache
				// exists for.
				const embedResult = await this.cachingSeam().embedContentOf(
					chunks,
					"docs",
					// Per-item stamp so a long docs-embedding batch cannot outlast the
					// hung threshold; the batch-end stamp below alone is not enough.
					() => this.reportProgress(),
				);

				// Forward progress: a docs embed batch completed.
				this.reportProgress();

				if (embedResult.cost) {
					totalCost += embedResult.cost;
				}

				// Add chunks to vector store
				const fileHash = computeHash(chunks.map((c) => c.content).join(""));
				const chunksWithEmbeddings: import("../types.js").ChunkWithEmbedding[] =
					chunks.map((chunk, idx) => ({
						id: chunk.id,
						content: chunk.content,
						filePath: docsPath,
						startLine: 0,
						endLine: 0,
						language: "markdown",
						chunkType: "module" as const, // Use module for docs
						contentHash: computeHash(chunk.content),
						fileHash,
						vector: embedResult.embeddings[idx],
						// Docs chunks go through the same seam, so they carry the same
						// audit key. Their content is shared across every repo that
						// depends on the package, which is exactly where a
						// machine-global cache pays.
						embedKey: embedResult.keys?.[idx] ?? "",
						// Store doc-specific metadata in name field for now
						name: chunk.title,
						signature: chunk.sourceUrl,
					}));

				this.reportPhase("writing:lance");
				// External docs are the repository's, not a tree's: shared (§3.2.1).
				await this.vectorStore!.addChunks(chunksWithEmbeddings, {
					pathKind: "synthetic",
					branchId: BRANCH_ID_SHARED,
				});

				// Forward progress: docs chunks were written to the vector store.
				this.reportProgress();

				// Mark as indexed in tracker. SR-2: these invocations run
				// concurrently and two can resume in one turn of the event loop, so
				// this region yields first instead of trusting the awaits above.
				await yieldToEventLoop();
				this.fileTracker!.markDocsIndexed(
					dep.name,
					dep.majorVersion || null,
					chunks[0].provider,
					fileHash,
					chunks.map((c) => c.id),
				);

				librariesFetched++;
				totalChunksAdded += chunks.length;
			} catch (error) {
				console.warn(
					`  ⚠️  Failed to fetch docs for ${dep.name}:`,
					error instanceof Error ? error.message : error,
				);
			} finally {
				inProgress.delete(dep.name);
				completed++;
			}
		};

		// Process in parallel batches (same pattern as enricher)
		for (let i = 0; i < depsToFetch.length; i += concurrency) {
			const batch = depsToFetch.slice(i, i + concurrency);
			await Promise.all(batch.map(processDep));
			// SR-2: the last invocation's region, then the next batch's first.
			await yieldToEventLoop();
		}

		if (this.onProgress) {
			this.onProgress(
				depsToFetch.length,
				depsToFetch.length,
				`[docs] ${librariesFetched} libraries, ${totalChunksAdded} chunks`,
			);
		}

		return {
			librariesFetched,
			chunksAdded: totalChunksAdded,
			cost: totalCost > 0 ? totalCost : undefined,
		};
	}

	/**
	 * Close all resources
	 */
	async close(): Promise<void> {
		if (this.vectorStore) {
			await this.vectorStore.close();
		}
		if (this.fileTracker) {
			this.fileTracker.close();
		}
	}
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create an indexer for a project
 */
export function createIndexer(options: IndexerOptions): Indexer {
	return new Indexer(options);
}

/**
 * Quick index function
 */
export async function indexProject(
	projectPath: string,
	options: Partial<IndexerOptions> = {},
): Promise<IndexResult> {
	const indexer = createIndexer({ projectPath, ...options });
	try {
		return await indexer.index(options.force !== false);
	} finally {
		await indexer.close();
	}
}

/**
 * Quick search function
 */
export async function searchProject(
	projectPath: string,
	query: string,
	options: SearchOptions = {},
): Promise<SearchResult[]> {
	const indexer = createIndexer({ projectPath });
	try {
		return await indexer.search(query, options);
	} finally {
		await indexer.close();
	}
}
