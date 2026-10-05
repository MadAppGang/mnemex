/**
 * The LOCAL dirty overlay's preparation pass (step 3, R3; architecture §2 step
 * 7 and §5, revision 1). Reached from ONE place: `Indexer.searchScoped`,
 * behind {@link resolveOverlayGate}. Every local search surface converges there
 * (CLI `search`, MCP `search_code`, MCP `search` through `SemanticBackend`, the
 * TUI); `mnemex rg` passes `overlay: "off"`.
 *
 * One call = one pass:
 *
 *   1  identity   the index's {model, provider} and the client that embedded
 *                 the query must agree; the manifest must match both.
 *   2  git        `getWorktreeStatus()` (`--no-optional-locks`, `-z`, `-uall`).
 *   3  snapshot   the manifest read WITHOUT the lock (rename-atomic, so whole);
 *                 C = isSelectedFile(G ∪ W ∪ T).
 *   4  classify   no lock: disk hash (memoised on our own stat), tracker rows
 *                 in ≤ 64-path regions, a yield between.
 *   5  nothing stale → no candidates (today's path, NFR-2); bookkeeping is
 *                 written only if it changed, under a try-lock.
 *   6  embed cache opened BEFORE the lock, by the memo rule (MEDIUM 4).
 *   7  under the overlay lock: re-read the manifest, open a FRESH table,
 *      build, strict delete, add, optimize, id proof, read, write the
 *      manifest — and the manifest is written before the lock is released,
 *      on success and on a thrown write alike.
 *
 * The NAMED SETS (G, W, T, C, indexCurrent, staleDeleted, stalePresent,
 * served, failed, pending, unclassified, suppressed) are defined once, in
 * `./types.ts`, and used here by those names only.
 *
 * FAILURE ISOLATION (R3.11). This never throws, except for the two classes
 * that are CODE bugs: an embed-cache user-path refusal (a test that did not
 * sandbox its cache) and `EmbedCacheSoundnessError`. Every other failure is a
 * report state with the index's rows left visible, or a per-file `failed`.
 *
 * LIVENESS (NFR-5, CLAUDE.md #31). Every loop over files, paths, batches or
 * regions ends with `await clock.yieldIfDue()` and contains no `continue`
 * (swept: S-Y). `yieldIfDue` is `yieldToEventLoop()` once `OVERLAY_YIELD_SLICE_MS`
 * has passed since the last real yield: a `setTimeout(0)` yield costs ~1.26 ms
 * in Bun 1.4 (measured: 2000 yields = 2 517 ms), so a yield per path would
 * spend 2.5 s of NFR-1's budget at the 2000-file cap doing nothing. The
 * heartbeat bound needs a bound on blocking between REAL yields — at most the
 * slice plus one item, and one item's read+hash+parse is one region, bounded
 * by `OVERLAY_MAX_FILE_BYTES` — not a yield per item. Measured from outside
 * the process by Y-1.
 */

import { readFileSync, type Stats, statSync } from "node:fs";
import { join } from "node:path";
import {
	GitDiffChangeDetector,
	type WorktreeStatusResult,
} from "../../cloud/git-diff.js";
import type {
	ChunkWithEmbedding,
	CodeChunk,
	EmbedCallOptions,
	IEmbeddingsClient,
} from "../../types.js";
import { BRANCH_ID_SHARED } from "../branch-registry.js";
import {
	type CachingEmbeddingsClient,
	createCachingEmbeddingsClient,
	EmbedCacheSoundnessError,
} from "../caching-embeddings-client.js";
import { chunkFileByPath } from "../chunker.js";
import {
	type EmbedCacheLike,
	openEmbedCache,
	resolveEmbedCacheMode,
	USER_PATH_REFUSAL_PREFIX,
} from "../embed-cache.js";
import {
	embeddingTextFingerprint,
	isFatalEmbeddingFailure,
} from "../embeddings.js";
import { TotalEmbeddingFailureError } from "../embeddings-errors.js";
import { type FileSelection, isSelectedFile } from "../file-selection.js";
import { CURRENT_INDEX_VERSION } from "../index-version.js";
import {
	createDirtyOverlayLock,
	type IndexLock,
	OverlayLockLostError,
	processHoldsIndexLock,
} from "../lock.js";
import { createVectorStore, type IVectorStore } from "../store.js";
import {
	getDirtyOverlayManifestPathFor,
	getDirtyOverlayVectorsPathFor,
	type StoreLocation,
} from "../store-location.js";
import { yieldToEventLoop } from "../sync-region.js";
import {
	FILES_SINCE_MAX_PAGE,
	hashFileBytes,
	type IFileTracker,
	INDEXED_STATES_MAX_PATHS,
	type IndexedFileState,
} from "../tracker.js";
import {
	type BuiltChunk,
	type BuiltFile,
	emptyOverlayManifest,
	type HashMemoEntry,
	type OverlayEmbeddingIdentity,
	type OverlayManifest,
	readOverlayManifest,
	serializeOverlayManifest,
	type TrackerHighWater,
	wipeOverlayData,
	writeOverlayManifest,
} from "./manifest.js";
import type {
	OverlayCandidates,
	OverlayChunkRef,
	OverlayFileFailure,
	OverlayGapDetail,
	OverlayGapToken,
	OverlayOffReason,
	OverlayReason,
	OverlayReport,
	OverlayRowGapToken,
	OverlaySkipReason,
	OverlayVectorRow,
} from "./types.js";

// ════════════════════════════════════════════════════════════════════════════
// Caps and budgets (architecture §5 "Caps and budgets")
// ════════════════════════════════════════════════════════════════════════════

/**
 * |G| over this → `skipped/too-large`, counted while G is built. After
 * classification, |G ∪ stale(W)| over it is the same skip; W's index-current
 * members never count (review 1, MEDIUM 4). It also bounds what `T` may add
 * (MEDIUM 5), so `watch` — which it bounds too — is never truncated in use.
 */
export const OVERLAY_MAX_DIRTY_FILES = 2000;

/**
 * One file's read+hash+parse is ONE synchronous region, so its size bounds
 * the region (MEDIUM 4). Provisionally 1 MiB in the design; MEASURED in phase
 * 4 (read + sha256 + `chunkFileByPath`, this machine, load average ~4):
 *
 *     1 MiB   TypeScript  56 ms median    Python 123-141 ms    Go 116-120 ms
 *   512 KiB   TypeScript  31 ms median    (≈ half the above for Python/Go)
 *
 * 1 MiB fits CLAUDE.md #31's 250 ms work allowance with ~1.8x margin on the
 * slowest grammar, which load erodes; 512 KiB keeps ~3.5x. The largest file
 * in this repository is 282 KiB.
 */
export const OVERLAY_MAX_FILE_BYTES = 512 * 1024;

/**
 * Embedding time per pass. Checked BETWEEN embed batches (MEDIUM 3), so one
 * large file cannot overrun it, AND enforced INSIDE each batch: the embed call
 * carries an `AbortSignal` that fires when this budget is spent, which ends the
 * provider request and any back-off sleep (review 1, HIGH 1). NFR-1b's 10 s =
 * git + classification + this + write + optimize + read; the 2 s difference is
 * that headroom and is not to be "fixed" upward (LOW 10).
 */
export const OVERLAY_REBUILD_BUDGET_MS = 8000;

/**
 * Attempts per provider request on the overlay's embed calls: ONE, no retry
 * ladder (review 1, HIGH 1). The ladder exists for indexing, where a transient
 * 5xx is worth 31 s per text; on the search path it is what made one refused
 * chunk stall a search for minutes. The client is shared with indexing, so
 * this is a per-call `EmbedCallOptions`, never a client setting.
 */
export const OVERLAY_EMBED_MAX_ATTEMPTS = 1;

/** Classification time for `T` only; G and W are always classified in full. */
export const OVERLAY_CLASSIFY_BUDGET_MS = 1000;

/** Chunks per embed call: one cache lookup region (`LOOKUP_CHUNK`). */
export const OVERLAY_EMBED_BATCH = 64;

/** Rows per `addChunks`. */
export const OVERLAY_WRITE_BATCH = 256;

/**
 * R3.8's honest gaps, as MACHINE TOKENS: appended to `report.gaps`, one entry
 * each, whenever a pass serves at least one file. The core owns them, so the
 * MCP `overlay` block and `--agent`'s `overlay_gaps` carry the same spelling.
 * A token is a bare identifier: the explanation lives here and in the docs,
 * never inside the token, so a consumer can match it exactly.
 *
 *   no-symbol-graph             overlay rows have no symbol graph, so the
 *                               dead-code penalty does not judge them
 *   no-code-units               no code units: a small function's overlay
 *                               chunk can be a nameless `module` chunk
 *                               (empty `name=`; Phase 6 ruling 2)
 *   no-summaries                no LLM summaries on overlay rows
 *   bm25-unchanged-chunks-only  only an UNCHANGED overlay chunk borrows its
 *                               index twin's BM25 score; a changed or new one
 *                               is vector-only (ruling 4)
 */
export const OVERLAY_ROW_GAP_TOKENS = [
	"no-symbol-graph",
	"no-code-units",
	"no-summaries",
	"bm25-unchanged-chunks-only",
] as const satisfies readonly OverlayRowGapToken[];

/**
 * Every member of `OverlayGapToken`, once (iteration 2, O4). A `Record` over
 * the union, so adding a member to the type without listing it here is a
 * compile error, and listing a non-member is one too.
 */
const GAP_TOKEN_MEMBERS: Record<OverlayGapToken, true> = {
	// a skip's cause
	"no-index": true,
	"no-git": true,
	"git-failed": true,
	"too-large": true,
	busy: true,
	"cache-cold-under-lock": true,
	"lock-lost": true,
	"embed-failed": true,
	"overlay-corrupt": true,
	"identity-mismatch": true,
	"overlay-error": true,
	// a failed file
	"file-failed-read": true,
	"file-failed-too-large": true,
	"file-failed-chunk": true,
	"file-failed-embed": true,
	"file-failed-write": true,
	"file-failed-inconsistent": true,
	// pass-level events
	"embed-deadline": true,
	"unclassified-budget": true,
	"unclassified-watch-capacity": true,
	"embed-cache-over-cap": true,
	"overlay-wiped": true,
	"delete-failed": true,
	"optimize-failed": true,
	"add-failed": true,
	// R3.8's row gaps
	"no-symbol-graph": true,
	"no-code-units": true,
	"no-summaries": true,
	"bm25-unchanged-chunks-only": true,
};

/** The closed vocabulary of `overlay_gaps` / MCP `overlay.gaps`. */
export const OVERLAY_GAP_TOKENS: readonly OverlayGapToken[] = Object.keys(
	GAP_TOKEN_MEMBERS,
) as OverlayGapToken[];

/**
 * The ONE writer of a report's `gaps` and `gapDetails` (iteration 2, O4).
 *
 * `gaps` used to mix bare tokens with `path: failure (message)` lines and
 * free-text pass gaps — raw provider JSON included — under a key documented
 * as machine tokens, and the CLI re-parsed that prose with a regex. Now a gap
 * is a TOKEN from the closed `OverlayGapToken` set, recorded once in
 * first-occurrence order, and its free text is a DETAIL, one per event.
 * `overlay-gap-sweep.test.ts` holds every report-gap write in this file to
 * this class (no raw `gaps.push`, no hand-built `gaps:` literal).
 */
export class GapRecorder {
	private readonly tokens: OverlayGapToken[] = [];
	private readonly details: OverlayGapDetail[] = [];

	/**
	 * Record one gap event. A detail is appended when there is anything to
	 * say beyond the token: a message, or the path of a failed file.
	 */
	noteGap(token: OverlayGapToken, message?: string, path?: string): void {
		if (!this.tokens.includes(token)) this.tokens.push(token);
		if (message === undefined && path === undefined) return;
		this.details.push({
			token,
			...(path === undefined ? {} : { path }),
			message: message ?? "",
		});
	}

	has(token: OverlayGapToken): boolean {
		return this.tokens.includes(token);
	}

	/** Everything `other` recorded, after what this one holds. */
	absorb(other: GapRecorder): void {
		for (const token of other.tokens) {
			if (!this.tokens.includes(token)) this.tokens.push(token);
		}
		this.details.push(...other.details);
	}

	/** The two report fields, as copies. */
	fields(): Pick<OverlayReport, "gaps" | "gapDetails"> {
		return { gaps: [...this.tokens], gapDetails: [...this.details] };
	}
}

/**
 * How long a pass waits for another pass's lock before `skipped/busy`. A pass
 * in the SAME process first waits up to this long at the in-process gate,
 * then up to this long again for the file lock (review 2, MEDIUM 4): never
 * more than twice this in total, however long the holder takes.
 */
export const OVERLAY_LOCK_WAIT_MS = 2000;
export const OVERLAY_LOCK_POLL_MS = 50;

/**
 * The overlay's `git status` is killed after this (review 2, MEDIUM 4): a
 * wedged git used to hold its search for ever. It bounds a HANG, it does not
 * police a slow listing — NFR-1b's whole 10 s, since a listing slower than
 * that leaves no pass anything to do. On expiry the pass is
 * `skipped/git-failed` and the index rows stay visible.
 */
export const OVERLAY_GIT_STATUS_TIMEOUT_MS = 10_000;

/**
 * The longest a work loop runs between REAL event-loop yields (plus one item).
 * See the file header for why it is a slice and not a yield per item.
 */
export const OVERLAY_YIELD_SLICE_MS = 25;

/**
 * The time-sliced yield every work loop ends with (S-Y). Exported for its own
 * test: a `yieldIfDue` that never yields would satisfy the sweep and starve
 * the heartbeat, so the test asserts a real timer callback runs.
 */
export class YieldClock {
	private last = Date.now();

	constructor(private readonly sliceMs: number = OVERLAY_YIELD_SLICE_MS) {}

	async yieldIfDue(): Promise<void> {
		if (Date.now() - this.last < this.sliceMs) return;
		await yieldToEventLoop();
		this.last = Date.now();
	}
}

/**
 * The racy-timestamp guard, as git uses for its own index: a hash is memoised
 * only for a file whose mtime is older than this, because a save within the
 * filesystem's timestamp granularity can leave (mtime, size) unchanged.
 */
export const HASH_MEMO_RACY_MS = 2000;

export interface OverlayLimits {
	readonly maxDirtyFiles: number;
	readonly maxFileBytes: number;
	readonly rebuildBudgetMs: number;
	readonly classifyBudgetMs: number;
	readonly lockWaitMs: number;
	readonly gitStatusTimeoutMs: number;
}

export const DEFAULT_OVERLAY_LIMITS: OverlayLimits = {
	maxDirtyFiles: OVERLAY_MAX_DIRTY_FILES,
	maxFileBytes: OVERLAY_MAX_FILE_BYTES,
	rebuildBudgetMs: OVERLAY_REBUILD_BUDGET_MS,
	classifyBudgetMs: OVERLAY_CLASSIFY_BUDGET_MS,
	lockWaitMs: OVERLAY_LOCK_WAIT_MS,
	gitStatusTimeoutMs: OVERLAY_GIT_STATUS_TIMEOUT_MS,
};

// ════════════════════════════════════════════════════════════════════════════
// Context and result
// ════════════════════════════════════════════════════════════════════════════

/** An embedding identity as the caller knows it. */
export interface EmbeddingIdentity {
	readonly model: string;
	/** `null` for a pre-0.34 index, which recorded no provider (gotcha #16). */
	readonly provider: string | null;
}

export interface DirtyOverlayContext {
	/** The worktree's resolved location: `pathRoot` and the overlay paths. */
	readonly loc: StoreLocation;
	/** The indexer's own universe (`isSelectedFile`). */
	readonly selection: FileSelection;
	readonly tracker: Pick<
		IFileTracker,
		"getIndexedFileStates" | "getFilesIndexedSince" | "getIndexedHighWater"
	>;
	/**
	 * The read's branch set: `[branchId]` in branch scope, every registry id
	 * the scope was resolved from in `SCOPE_ALL`.
	 */
	readonly branchIds: readonly number[];
	/** Branch scope's id, for `T`; `null` in `SCOPE_ALL` (no `T`). */
	readonly trackerBranchId: number | null;
	/** The tracker's stored `embeddingModel`/`embeddingProvider`; null = no index. */
	readonly indexIdentity: EmbeddingIdentity | null;
	/**
	 * The model and provider the query client was BUILT with (the adopted
	 * model under `use-indexed`) — compared with `indexIdentity` as strings,
	 * the way the tracker stores them.
	 */
	readonly queryIdentity: { readonly model: string; readonly provider: string };
	/**
	 * The RAW client that embedded the query (`rawEmbeddingsClient` from
	 * `initialize(true)`), never a fresh `createEmbeddingsClient(config)`
	 * (HIGH 4). The overlay wraps it with the embed cache.
	 */
	readonly queryClient: IEmbeddingsClient;
	readonly queryVector: readonly number[];
	/** The user's search: `limit` and the language/path predicates. */
	readonly search: {
		readonly limit?: number;
		readonly language?: string;
		readonly filePath?: string;
		readonly pathPattern?: string;
	};
	/** `loadGlobalConfig().embedCache`; undefined = on. */
	readonly embedCacheConfigEnabled?: boolean;
	/** Embed-cache file; default `openEmbedCache()`'s (env, then the user file). */
	readonly embedCachePath?: string;
	/** Seam: the worktree listing. Default: `getWorktreeStatus()` at `pathRoot`. */
	readonly gitStatus?: () => Promise<WorktreeStatusResult>;
	/** Seam: caps and budgets. */
	readonly limits?: Partial<OverlayLimits>;
}

export interface DirtyOverlayResult {
	/** Undefined unless something is served or suppressed: then today's path. */
	readonly candidates: OverlayCandidates | undefined;
	readonly report: OverlayReport;
}

// ════════════════════════════════════════════════════════════════════════════
// Internals
// ════════════════════════════════════════════════════════════════════════════

/** A failure that ends the pass with every index row visible. */
class PassSkip extends Error {
	constructor(
		readonly reason: OverlaySkipReason,
		message: string,
	) {
		super(message);
		this.name = "PassSkip";
	}
}

/** The two error classes that are code bugs and must surface (R3.11). */
function isCodeBug(err: unknown): boolean {
	return (
		err instanceof EmbedCacheSoundnessError ||
		(err instanceof Error && err.message.startsWith(USER_PATH_REFUSAL_PREFIX))
	);
}

/** Rethrow what must propagate: code bugs and a lost lock. */
function rethrowFatal(err: unknown): void {
	if (isCodeBug(err) || err instanceof OverlayLockLostError) throw err;
}

const messageOf = (err: unknown) =>
	err instanceof Error ? err.message : String(err);

type DiskState =
	| { readonly kind: "absent" }
	| { readonly kind: "unreadable"; readonly message: string }
	| { readonly kind: "too-large"; readonly size: number }
	| {
			readonly kind: "present";
			readonly hash: string;
			/** The stat this pass took: the racy-window rule reads it. */
			readonly mtimeMs: number;
	  };

type Klass = "indexCurrent" | "staleDeleted" | "stalePresent" | "ignored";

/** One member of C, as this pass sees it. */
interface Candidate {
	/** NFC key: one file however git and the tracker spell it. */
	readonly key: string;
	/** The first spelling seen (G, then W, then T): what is read from disk. */
	readonly diskPath: string;
	inG: boolean;
	/**
	 * In W: this worktree's overlay saw it dirty or stale and has not since
	 * seen it git-clean AND index-current. A W member with no tracker row is
	 * never index-current, so it stays stale (review 1, HIGH 2).
	 */
	inW: boolean;
	/**
	 * Added to W by ANOTHER pass after this pass's snapshot (review 1, HIGH 3).
	 * This pass's git listing predates that pass's observation, so it has no
	 * evidence that the path is git-clean: it keeps the path in W whatever it
	 * classifies it as.
	 */
	imported: boolean;
	/**
	 * Index-current by its bytes, but saved inside this pass's racy window:
	 * at or after `git status` started, less `HASH_MEMO_RACY_MS` (review 2,
	 * HIGH 1). The listing predates the save, so "git did not list it" is no
	 * evidence that it is git-clean: it stays in W' for the next pass to judge.
	 */
	racy: boolean;
	/**
	 * Index-current because there is nothing to index: no tracker row, and
	 * the overlay's own build of these exact bytes was ZERO chunks — the
	 * real indexer stamps no row for such a file (review 2, MEDIUM 2).
	 */
	emptyBuilt: boolean;
	disk: DiskState;
	/** Tracker rows in the branch set, each in the TRACKER's spelling. */
	rows: IndexedFileState[];
	klass: Klass;
	/** The spelling overlay rows and the manifest use: the tracker's when a row exists. */
	storedPath: string;
	/** Set once a stalePresent file fails this pass. */
	failure?: OverlayFileFailure;
	failureMessage?: string;
}

const nfc = (path: string) => path.normalize("NFC");

function sameStat(a: Stats, b: Stats): boolean {
	return (
		a.mtimeMs === b.mtimeMs &&
		a.ctimeMs === b.ctimeMs &&
		a.size === b.size &&
		a.ino === b.ino
	);
}

function memoMatches(entry: HashMemoEntry | undefined, stat: Stats): boolean {
	return (
		entry !== undefined &&
		entry.mtimeMs === stat.mtimeMs &&
		entry.ctimeMs === stat.ctimeMs &&
		entry.size === stat.size &&
		entry.ino === stat.ino
	);
}

/** Built chunk refs, in `startLine` order. */
function refsOf(chunks: readonly BuiltChunk[]): OverlayChunkRef[] {
	return chunks
		.map((c) => ({ id: c.id, startLine: c.startLine, endLine: c.endLine }))
		.sort((a, b) => a.startLine - b.startLine || (a.id < b.id ? -1 : 1));
}

// ════════════════════════════════════════════════════════════════════════════
// The gate (architecture §5 "Reachability", MEDIUM 13)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Whether a search may run an overlay pass at all, decided on the EFFECTIVE
 * state of that search, not on its flags alone (MEDIUM 13):
 *
 *   flag          `--no-dirty` / `SearchOptions.overlay === "off"` (and `rg`)
 *   config        `dirtyOverlay: false`, project over global
 *   keyword-only  `--keyword`, OR vectors disabled in config — the search the
 *                 indexer actually runs (`options.keywordOnly || !vectorEnabled`)
 *   no-vector     no query vector to compare overlay rows against
 *
 * First match wins, in that order, so the reason names the most deliberate
 * off-switch. `null` = run the pass.
 */
export function resolveOverlayGate(input: {
	readonly flag: "auto" | "off" | undefined;
	readonly configEnabled: boolean;
	readonly keywordOnly: boolean;
	readonly queryVector: readonly number[] | undefined;
}): OverlayOffReason | null {
	if (input.flag === "off") return "flag";
	if (!input.configEnabled) return "config";
	if (input.keywordOnly) return "keyword-only";
	if (input.queryVector === undefined || input.queryVector.length <= 1) {
		return "no-vector";
	}
	return null;
}

/** The report of a search whose gate kept the overlay off. */
export function overlayOffReport(reason: OverlayOffReason): OverlayReport {
	return emptyReport("off", reason);
}

function emptyReport(
	state: OverlayReport["state"],
	reason: OverlayReason,
): OverlayReport {
	return {
		state,
		reason,
		files: 0,
		filesIndexCurrent: 0,
		filesDeleted: 0,
		filesPending: 0,
		filesFailed: 0,
		filesUnclassified: 0,
		rebuilt: 0,
		embedded: 0,
		cacheHits: 0,
		rebuildMs: 0,
		...new GapRecorder().fields(),
	};
}

function skipped(
	reason: OverlaySkipReason,
	message?: string,
): DirtyOverlayResult {
	const gaps = new GapRecorder();
	gaps.noteGap(reason, message);
	return {
		candidates: undefined,
		report: { ...emptyReport("skipped", reason), ...gaps.fields() },
	};
}

// ════════════════════════════════════════════════════════════════════════════
// The pass
// ════════════════════════════════════════════════════════════════════════════

/**
 * One overlay pass. See the file header. Never throws except for the two
 * code-bug classes.
 */
export async function prepareDirtyOverlay(
	ctx: DirtyOverlayContext,
): Promise<DirtyOverlayResult> {
	try {
		return await new OverlayPass(ctx).run();
	} catch (err) {
		if (isCodeBug(err)) throw err;
		if (err instanceof PassSkip) return skipped(err.reason, err.message);
		if (err instanceof OverlayLockLostError) {
			return skipped("lock-lost", err.message);
		}
		return skipped("overlay-error", messageOf(err));
	}
}

/**
 * In-process single-flight, per overlay (review 1, MEDIUM 6), around the
 * LOCKED SECTION only (review 2, MEDIUM 4). Two searches in ONE process
 * (parallel `search_code` calls to one MCP server) used to race for
 * `.overlay.lock`; the loser waited 2 s and served stale index rows for the
 * very file the winner was rebuilding. Now the second waits for the first's
 * locked section and then runs its own, which finds the first one's work
 * built. The file lock still serialises PROCESSES.
 *
 * Steps 1-6 (git, snapshot, classification) run concurrently: a pass over a
 * clean worktree never reaches the gate, so N parallel clean searches cost
 * the slowest listing, not the sum of them. The wait is BOUNDED by the lock
 * wait: after it the pass goes to the file lock as before, which waits once
 * more and then reports `busy` with every index row visible. A wedged holder
 * therefore costs a follower at most `2 × lockWaitMs`, never for ever.
 *
 * Each entrant waits only for the one before it (whose gate opens when ITS
 * locked section ends, so order is kept) — never a chain through a wedged
 * pass, and the map holds one promise per overlay.
 */
const lockGates = new Map<string, Promise<void>>();

interface GateTicket {
	/** Milliseconds spent waiting at the gate. */
	readonly waitedMs: number;
	release(): void;
}

async function enterGate(key: string, waitMs: number): Promise<GateTicket> {
	const prior = lockGates.get(key);
	let open: () => void = () => {};
	const mine = new Promise<void>((resolve) => {
		open = resolve;
	});
	lockGates.set(key, mine);
	const started = Date.now();
	if (prior !== undefined) {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const expiry = new Promise<void>((resolve) => {
			timer = setTimeout(resolve, waitMs);
		});
		try {
			await Promise.race([prior, expiry]);
		} finally {
			clearTimeout(timer);
		}
	}
	return {
		waitedMs: Date.now() - started,
		release: () => {
			open();
			if (lockGates.get(key) === mine) lockGates.delete(key);
		},
	};
}

class OverlayPass {
	/** The pass's one yield clock (S-Y); the locked section shares it. */
	readonly clock = new YieldClock();
	private readonly limits: OverlayLimits;
	private readonly vectorsDir: string;
	private readonly manifestPath: string;
	private readonly candidates = new Map<string, Candidate>();
	/** Members of T the classification budget did not reach. */
	private unclassified = 0;
	private nextHighWater: TrackerHighWater | null = null;
	/** The memo to carry: reused entries, and new stable ones. */
	private readonly nextMemo = new Map<string, HashMemoEntry>();
	private identity: OverlayEmbeddingIdentity | null = null;
	/** The manifest classification was derived from (read without the lock). */
	private snapshot: OverlayManifest | null = null;
	/** Pass-level gaps found before the locked section (reported with it). */
	private readonly passGaps = new GapRecorder();
	/**
	 * When this pass's `git status` was STARTED (`Date.now()`). A file whose
	 * mtime is at or after this, less `HASH_MEMO_RACY_MS`, may have been saved
	 * after the listing was taken (review 2, HIGH 1).
	 */
	private statusStartedAt = Number.POSITIVE_INFINITY;
	/**
	 * Built entries this pass knows of, by stored path: the snapshot's, and
	 * under the lock the re-read manifest's (review 2, MEDIUM 2).
	 */
	private readonly knownBuilt = new Map<string, BuiltFile>();
	/** Time spent at the in-process gate; it comes out of the rebuild budget. */
	private queuedMs = 0;

	constructor(private readonly ctx: DirtyOverlayContext) {
		this.limits = { ...DEFAULT_OVERLAY_LIMITS, ...ctx.limits };
		this.vectorsDir = getDirtyOverlayVectorsPathFor(ctx.loc);
		this.manifestPath = getDirtyOverlayManifestPathFor(ctx.loc);
	}

	async run(): Promise<DirtyOverlayResult> {
		const ctx = this.ctx;
		// The gate (phase 6) turns these off first; refusing here too keeps a
		// direct caller from building vectors no query can compare against.
		if (ctx.queryVector.length <= 1) {
			return { candidates: undefined, report: emptyReport("off", "no-vector") };
		}

		// 1. Identity (HIGH 4, gotcha #16).
		const index = ctx.indexIdentity;
		if (index === null) return skipped("no-index");
		if (
			index.model !== ctx.queryIdentity.model ||
			(index.provider !== null && index.provider !== ctx.queryIdentity.provider)
		) {
			return skipped(
				"identity-mismatch",
				`index ${index.model}/${index.provider ?? "?"} vs query ${ctx.queryIdentity.model}/${ctx.queryIdentity.provider}`,
			);
		}
		this.identity = {
			model: index.model,
			provider: index.provider ?? ctx.queryIdentity.provider,
			dimension: ctx.queryVector.length,
			fingerprint: embeddingTextFingerprint(ctx.queryClient),
		};

		// 2. git.
		if (ctx.loc.gitLayout === null) return skipped("no-git");
		this.statusStartedAt = Date.now();
		const status = await (
			ctx.gitStatus ??
			(() =>
				new GitDiffChangeDetector(ctx.loc.pathRoot).getWorktreeStatus({
					timeoutMs: this.limits.gitStatusTimeoutMs,
				}))
		)();
		if (!status.ok) return skipped(status.reason, status.message);

		// 3. Snapshot, no lock.
		const snapshotRead = readOverlayManifest(this.manifestPath);
		const snapshot =
			snapshotRead.kind === "ok" &&
			snapshotRead.manifest.pathRoot === ctx.loc.pathRoot
				? snapshotRead.manifest
				: null;
		this.snapshot = snapshot;
		for (const [path, entry] of Object.entries(snapshot?.files ?? {})) {
			this.knownBuilt.set(path, entry.built);
		}

		// `isSelectedFile` lstat()s each path and its ancestors: work, so these
		// loops end with the clock like every other. The cap is on G ALONE,
		// counted as G is built, so a huge listing stops at the first path over
		// it (review 1, MEDIUM 4).
		const g = new Map<string, string>();
		let gOver = false;
		for (let i = 0; i < status.entries.length && !gOver; i++) {
			const entry = status.entries[i];
			if (entry !== undefined && isSelectedFile(ctx.selection, entry.path)) {
				g.set(nfc(entry.path), entry.path);
				gOver = g.size > this.limits.maxDirtyFiles;
			}
			await this.clock.yieldIfDue();
		}
		if (gOver) {
			return skipped(
				"too-large",
				`more than ${this.limits.maxDirtyFiles} files listed by git`,
			);
		}
		const w = new Map<string, string>();
		for (const path of snapshot?.watch ?? []) {
			if (isSelectedFile(ctx.selection, path) && !g.has(nfc(path))) {
				w.set(nfc(path), path);
			}
			await this.clock.yieldIfDue();
		}

		// 4. Classify G ∪ W in full, then T under its budget AND the watch
		// capacity left after G ∪ stale(W).
		const memo = snapshot?.hashMemo ?? {};
		for (const [key, path] of g) this.addCandidate(key, path, "G");
		for (const [key, path] of w) this.addCandidate(key, path, "W");
		await this.classify([...this.candidates.values()], memo);
		// W only counts what is STILL dirty or stale: its index-current members
		// are dropped by this pass, so they can never lock the overlay out.
		const retained = this.retainedCount();
		if (retained > this.limits.maxDirtyFiles) {
			return skipped(
				"too-large",
				`${retained} dirty or stale files > ${this.limits.maxDirtyFiles}`,
			);
		}
		await this.classifyT(snapshot, memo);

		const all = [...this.candidates.values()];
		const stalePresent = all.filter((c) => c.klass === "stalePresent");
		const staleDeleted = all.filter((c) => c.klass === "staleDeleted");

		// 5. Nothing stale: today's index-only path (NFR-2). Bookkeeping only.
		if (stalePresent.length === 0 && staleDeleted.length === 0) {
			await this.bookkeepingOnly(snapshot);
			return {
				candidates: undefined,
				report: {
					...emptyReport("on", "index-current"),
					filesIndexCurrent: all.filter((c) => c.klass === "indexCurrent")
						.length,
					filesUnclassified: this.unclassified,
					...this.passGaps.fields(),
				},
			};
		}

		// 6. The embed cache, BEFORE the lock, by the memo rule.
		const cache = this.openCache();

		// 7. The locked section.
		return await this.locked(stalePresent, staleDeleted, all, cache, false);
	}

	private addCandidate(key: string, path: string, from: "G" | "W" | "T"): void {
		const existing = this.candidates.get(key);
		if (existing !== undefined) {
			existing.inG ||= from === "G";
			existing.inW ||= from === "W";
			return;
		}
		this.candidates.set(key, {
			key,
			diskPath: path,
			inG: from === "G",
			inW: from === "W",
			imported: false,
			racy: false,
			emptyBuilt: false,
			disk: { kind: "absent" },
			rows: [],
			klass: "ignored",
			storedPath: path,
		});
	}

	// ── 4. classification ────────────────────────────────────────────────────

	/** Disk state and tracker rows for `cands`, ≤ 64 per tracker region. */
	private async classify(
		cands: readonly Candidate[],
		memo: Readonly<Record<string, HashMemoEntry>>,
	): Promise<void> {
		for (let i = 0; i < cands.length; i += INDEXED_STATES_MAX_PATHS) {
			await this.classifyBatch(
				cands.slice(i, i + INDEXED_STATES_MAX_PATHS),
				memo,
			);
			await this.clock.yieldIfDue();
		}
	}

	private async classifyBatch(
		batch: readonly Candidate[],
		memo: Readonly<Record<string, HashMemoEntry>>,
	): Promise<void> {
		for (const cand of batch) {
			cand.disk = this.diskStateOf(cand, memo);
			await this.clock.yieldIfDue();
		}
		const states = this.ctx.tracker.getIndexedFileStates(
			this.ctx.branchIds,
			batch.map((c) => c.diskPath),
		);
		for (const cand of batch) {
			this.settle(cand, states.get(cand.diskPath) ?? []);
		}
	}

	/** The disk state of one candidate: OUR read, OUR hash, OUR stat (HIGH 3). */
	private diskStateOf(
		cand: Candidate,
		memo: Readonly<Record<string, HashMemoEntry>>,
	): DiskState {
		const abs = join(this.ctx.loc.pathRoot, cand.diskPath);
		let before: Stats;
		try {
			before = statSync(abs);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") {
				return { kind: "absent" };
			}
			return { kind: "unreadable", message: messageOf(err) };
		}
		if (!before.isFile()) return { kind: "absent" };
		if (before.size > this.limits.maxFileBytes) {
			return { kind: "too-large", size: before.size };
		}
		const known = memo[cand.diskPath];
		if (memoMatches(known, before) && known !== undefined) {
			this.nextMemo.set(cand.diskPath, known);
			return { kind: "present", hash: known.hash, mtimeMs: before.mtimeMs };
		}
		let bytes: Buffer;
		let after: Stats;
		try {
			bytes = readFileSync(abs);
			after = statSync(abs);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") {
				return { kind: "absent" };
			}
			return { kind: "unreadable", message: messageOf(err) };
		}
		const hash = hashFileBytes(bytes);
		// Recorded only when nothing moved during the read AND the mtime is out
		// of the racy window; reused only on an exact stat match.
		if (
			sameStat(before, after) &&
			Date.now() - after.mtimeMs > HASH_MEMO_RACY_MS
		) {
			this.nextMemo.set(cand.diskPath, {
				mtimeMs: after.mtimeMs,
				ctimeMs: after.ctimeMs,
				size: after.size,
				ino: after.ino,
				hash,
			});
		}
		return { kind: "present", hash, mtimeMs: after.mtimeMs };
	}

	/** The classification table (types.ts), and the spelling rule (MEDIUM 6). */
	private settle(cand: Candidate, rows: IndexedFileState[]): void {
		cand.rows = rows;
		if (rows.length > 0) {
			cand.storedPath = [...rows.map((r) => r.path)].sort()[0] as string;
		}
		const disk = cand.disk;
		const hasRows = rows.length > 0;
		if (disk.kind === "absent") {
			cand.klass = hasRows ? "staleDeleted" : "ignored";
			return;
		}
		cand.racy = false;
		cand.emptyBuilt = false;
		if (
			disk.kind === "present" &&
			rows.some((r) => r.contentHash === disk.hash)
		) {
			cand.klass = "indexCurrent";
			// Not listed by git, yet saved after (or just before) the listing
			// began: kept in W' for the next pass (review 2, HIGH 1).
			cand.racy =
				!cand.inG && disk.mtimeMs >= this.statusStartedAt - HASH_MEMO_RACY_MS;
			return;
		}
		// No row, and our own build of these very bytes was zero chunks: the
		// indexer stamps no row for it either, so "no row" IS its indexed
		// state (review 2, MEDIUM 2). Git-dirty files stay in G and are served
		// as before; this only lets a committed one leave W.
		const built = this.knownBuilt.get(cand.storedPath);
		if (
			!cand.inG &&
			!hasRows &&
			disk.kind === "present" &&
			built !== undefined &&
			built.contentHash === disk.hash &&
			built.chunks.length === 0
		) {
			cand.klass = "indexCurrent";
			cand.emptyBuilt = true;
			return;
		}
		// A W member with no row is still stale: it was seen dirty (an untracked
		// file, say) and nothing has indexed it since — committing it does not
		// (review 1, HIGH 2).
		if (!(cand.inG || cand.inW || hasRows)) {
			cand.klass = "ignored";
			return;
		}
		cand.klass = "stalePresent";
		if (disk.kind === "too-large") {
			cand.failure = "too-large";
			cand.failureMessage = `${disk.size} bytes > ${this.limits.maxFileBytes}`;
		} else if (disk.kind === "unreadable") {
			cand.failure = "read";
			cand.failureMessage = disk.message;
		}
	}

	/**
	 * `T`: rows indexed at/after the high-water mark, keyset-paged, classified
	 * until the budget runs out (HIGH 9). Branch scope only; the first pass in
	 * a worktree only records the mark.
	 */
	private async classifyT(
		snapshot: OverlayManifest | null,
		memo: Readonly<Record<string, HashMemoEntry>>,
	): Promise<void> {
		const branchId = this.ctx.trackerBranchId;
		if (branchId === null) {
			this.nextHighWater = null;
			return;
		}
		const previous = snapshot?.trackerHighWater ?? null;
		if (previous === null || previous.branchId !== branchId) {
			const top = this.ctx.tracker.getIndexedHighWater(branchId);
			// An empty branch starts from the beginning, so everything indexed
			// after this pass is in T.
			this.nextHighWater = {
				branchId,
				indexedAt: top?.indexedAt ?? "",
				path: top?.path ?? "",
			};
			return;
		}
		this.nextHighWater = previous;
		const started = Date.now();
		let after: TrackerHighWater = previous;
		let exhausted = false;
		for (;;) {
			const page = this.ctx.tracker.getFilesIndexedSince(
				branchId,
				after,
				FILES_SINCE_MAX_PAGE,
			);
			const outcome = await this.classifyTPage(page, started, branchId, memo);
			after = outcome.reached ?? after;
			this.nextHighWater = after;
			exhausted = outcome.exhausted;
			if (exhausted || page.length < FILES_SINCE_MAX_PAGE) break;
			await this.clock.yieldIfDue();
		}
	}

	private async classifyTPage(
		page: readonly { path: string; indexedAt: string }[],
		started: number,
		branchId: number,
		memo: Readonly<Record<string, HashMemoEntry>>,
	): Promise<{ reached: TrackerHighWater | null; exhausted: boolean }> {
		let reached: TrackerHighWater | null = null;
		for (let i = 0; i < page.length; i += INDEXED_STATES_MAX_PATHS) {
			const slice = page.slice(i, i + INDEXED_STATES_MAX_PATHS);
			const outOfTime = Date.now() - started > this.limits.classifyBudgetMs;
			// MEDIUM 5: never take in more of T than `watch` can keep. Every NEW
			// row of the slice is assumed stale, so nothing classified is
			// dropped by a truncation while the mark moves past it; what does
			// not fit stays AFTER the mark and is read again next pass. A row
			// already in C adds nothing to W' and costs no room (review 2, LOW 8).
			const retained = this.retainedCount();
			const incoming = slice.filter(
				(r) => !this.candidates.has(nfc(r.path)),
			).length;
			const outOfRoom = retained + incoming > this.limits.maxDirtyFiles;
			if (outOfTime || outOfRoom) {
				this.unclassified += page.length - i;
				// Later pages were not read, so the count is a lower bound (LOW
				// 9b). Out of room, it is not "the next pass's" either: T stays
				// suspended for as long as this many files are retained.
				if (outOfTime) {
					this.passGaps.noteGap(
						"unclassified-budget",
						`at least ${page.length - i} tracker file(s) left for the next pass (classification budget)`,
					);
				} else {
					this.passGaps.noteGap(
						"unclassified-watch-capacity",
						`at least ${page.length - i} tracker file(s) not classified while ${retained} dirty or stale file(s) fill the watch capacity of ${this.limits.maxDirtyFiles} (the tracker mark does not move until fewer are retained)`,
					);
				}
				return { reached, exhausted: true };
			}
			const fresh = await this.newTCandidates(slice);
			await this.classifyBatch(fresh, memo);
			const last = slice[slice.length - 1];
			if (last !== undefined) {
				reached = { branchId, indexedAt: last.indexedAt, path: last.path };
			}
			await this.clock.yieldIfDue();
		}
		return { reached, exhausted: false };
	}

	/** T rows not already in C and inside the universe, as new candidates. */
	private async newTCandidates(
		rows: readonly { path: string }[],
	): Promise<Candidate[]> {
		const fresh: Candidate[] = [];
		for (const row of rows) {
			const key = nfc(row.path);
			if (
				!this.candidates.has(key) &&
				isSelectedFile(this.ctx.selection, row.path)
			) {
				this.addCandidate(key, row.path, "T");
				const cand = this.candidates.get(key);
				if (cand !== undefined) fresh.push(cand);
			}
			await this.clock.yieldIfDue();
		}
		return fresh;
	}

	// ── bookkeeping ──────────────────────────────────────────────────────────

	/**
	 * Whether `cand` stays in W': git lists it, it is stale, another pass
	 * added it after our snapshot (HIGH 3), or it was saved inside this
	 * pass's racy window (review 2, HIGH 1). A zero-chunk file with no row
	 * never stays: the index and the overlay both hold nothing for it, so
	 * there is nothing a later pass could find stale (review 2, MEDIUM 2).
	 */
	private static retains(cand: Candidate): boolean {
		if (cand.emptyBuilt) return false;
		return (
			cand.inG ||
			cand.imported ||
			cand.racy ||
			cand.klass === "stalePresent" ||
			cand.klass === "staleDeleted"
		);
	}

	/** |W'| so far: what `nextWatch` would keep if the pass ended now. */
	private retainedCount(): number {
		let n = 0;
		for (const cand of this.candidates.values()) {
			if (OverlayPass.retains(cand)) n++;
		}
		return n;
	}

	/**
	 * Why W' no longer fits the watch capacity, or `null` when it does. Asked
	 * under the lock after `reconcile`, whose import of a newer pass's watch
	 * set is the one growth the pre-lock checks cannot see (outer review 2).
	 */
	watchOverflow(): string | null {
		const retained = this.retainedCount();
		if (retained <= this.limits.maxDirtyFiles) return null;
		return (
			`${retained} dirty, stale or watched files after importing a newer ` +
			`pass's watch set > ${this.limits.maxDirtyFiles}`
		);
	}

	/**
	 * W' (types.ts); hashMemo ⊆ W'. Bounded, and by construction never cut:
	 * the pass skips when G ∪ stale(W) is over the cap, T takes in only what
	 * fits (MEDIUM 4, 5), and the locked section skips when `reconcile`'s
	 * import overflows it (`watchOverflow`, outer review 2). The slice is the
	 * invariant's backstop.
	 */
	private nextWatch(): string[] {
		const keep = [...this.candidates.values()].filter(OverlayPass.retains);
		// G members first, so a cap never drops the user's own dirty set.
		keep.sort((a, b) => Number(b.inG) - Number(a.inG));
		return keep
			.slice(0, this.limits.maxDirtyFiles)
			.map((c) => c.diskPath)
			.sort();
	}

	private nextManifest(files: ReadonlyMap<string, BuiltFile>): OverlayManifest {
		const watch = this.nextWatch();
		const hashMemo: Record<string, HashMemoEntry> = {};
		for (const path of watch) {
			const entry = this.nextMemo.get(path);
			if (entry !== undefined) hashMemo[path] = entry;
		}
		const out: Record<string, { built: BuiltFile }> = {};
		for (const [path, built] of [...files].sort(([a], [b]) =>
			a < b ? -1 : a > b ? 1 : 0,
		)) {
			out[path] = { built };
		}
		return {
			...emptyOverlayManifest(this.ctx.loc.pathRoot, CURRENT_INDEX_VERSION),
			embedding: this.identity,
			trackerHighWater: this.nextHighWater,
			watch,
			hashMemo,
			files: out,
		};
	}

	/**
	 * The manifest a pass may keep: same format, index version, worktree and
	 * embedding identity. Anything else is wiped (data only, never the lock).
	 */
	private compatible(manifest: OverlayManifest): boolean {
		const id = this.identity;
		const e = manifest.embedding;
		return (
			manifest.indexVersion === CURRENT_INDEX_VERSION &&
			manifest.pathRoot === this.ctx.loc.pathRoot &&
			(e === null ||
				(id !== null &&
					e.model === id.model &&
					e.provider === id.provider &&
					e.dimension === id.dimension &&
					e.fingerprint === id.fingerprint))
		);
	}

	/**
	 * Step 5: nothing stale. If the bookkeeping changed — or a previous pass
	 * left built rows that are now garbage — write it under a TRY-lock; busy
	 * skips it and changes nothing else.
	 */
	private async bookkeepingOnly(
		snapshot: OverlayManifest | null,
	): Promise<void> {
		const hasBuilt =
			snapshot !== null && Object.keys(snapshot.files).length > 0;
		const next = this.nextManifest(new Map());
		const unchanged =
			snapshot !== null &&
			!hasBuilt &&
			this.compatible(snapshot) &&
			serializeOverlayManifest({ ...snapshot, embedding: this.identity }) ===
				serializeOverlayManifest(next);
		if (unchanged) return;
		await this.locked([], [], [...this.candidates.values()], null, true);
	}

	// ── 6. the embed cache ───────────────────────────────────────────────────

	/**
	 * MEDIUM 4: the full open is not constant-bounded, so it never runs while
	 * this process holds a store/global index lock — the memo or nothing then.
	 * Outside every lock it is the normal open (null on failure: degrade).
	 */
	private openCache(): EmbedCacheLike | null {
		if (resolveEmbedCacheMode(this.ctx.embedCacheConfigEnabled) === "off") {
			return null;
		}
		if (processHoldsIndexLock()) {
			const memo = openEmbedCache(this.ctx.embedCachePath, {
				ifAlreadyOpen: true,
			});
			if (memo === null) {
				throw new PassSkip(
					"cache-cold-under-lock",
					"an index lock is held in this process and the embed cache is not open",
				);
			}
			return this.withinBudget(memo);
		}
		const cache = openEmbedCache(this.ctx.embedCachePath);
		return cache === null ? null : this.withinBudget(cache);
	}

	/**
	 * Review 1, MEDIUM 8: eviction runs only at the end of an index run, and
	 * the overlay writes the machine-global cache from SEARCH. A search-only
	 * workflow therefore grew the file past its cap without bound. Once the
	 * file is over its cap, the overlay stops ADDING entries (it still reads,
	 * still refreshes LRU stamps, still records a learned dimension) and says
	 * so; the next index run's `enforceBudget()` brings it back under. No
	 * eviction on the search path, no global lock, no new blocking region but
	 * the one bounded size read.
	 */
	private withinBudget(cache: EmbedCacheLike): EmbedCacheLike {
		if (cache.isOverBudget?.() !== true) return cache;
		this.passGaps.noteGap(
			"embed-cache-over-cap",
			"overlay vectors not persisted until the next index run evicts",
		);
		return {
			get: (key, provider, dimension, fingerprint) =>
				cache.get(key, provider, dimension, fingerprint),
			putMany: (_entries, touched, dims) => cache.putMany([], touched, dims),
			knownDimension: (model, provider) =>
				cache.knownDimension(model, provider),
			recordDimension: (model, provider, dimension) =>
				cache.recordDimension(model, provider, dimension),
			evictKeys: (rows) => cache.evictKeys(rows),
			pendingEvictions: () => cache.pendingEvictions(),
			noteDimensionCorrection: () => cache.noteDimensionCorrection?.(),
			stats: () => cache.stats(),
			enforceBudget: () => cache.enforceBudget(),
			close: () => cache.close(),
		};
	}

	// ── 7. the locked section ────────────────────────────────────────────────

	private async locked(
		stalePresent: Candidate[],
		staleDeleted: Candidate[],
		all: Candidate[],
		cache: EmbedCacheLike | null,
		bookkeepingOnly: boolean,
	): Promise<DirtyOverlayResult> {
		// Bookkeeping is a TRY-lock and an optimisation: it never waits, at the
		// gate or at the file.
		if (bookkeepingOnly) {
			return await this.lockedOnce(
				stalePresent,
				staleDeleted,
				all,
				cache,
				true,
			);
		}
		const ticket = await enterGate(this.manifestPath, this.limits.lockWaitMs);
		this.queuedMs = ticket.waitedMs;
		try {
			return await this.lockedOnce(
				stalePresent,
				staleDeleted,
				all,
				cache,
				false,
			);
		} finally {
			ticket.release();
		}
	}

	private async lockedOnce(
		stalePresent: Candidate[],
		staleDeleted: Candidate[],
		all: Candidate[],
		cache: EmbedCacheLike | null,
		bookkeepingOnly: boolean,
	): Promise<DirtyOverlayResult> {
		const lock = createDirtyOverlayLock(this.ctx.loc);
		const acquired = await lock.acquire({
			waitTimeout: bookkeepingOnly ? 0 : this.limits.lockWaitMs,
			pollInterval: OVERLAY_LOCK_POLL_MS,
		});
		if (!acquired.acquired) {
			if (bookkeepingOnly) return skipped("busy"); // the caller ignores it
			return skipped(
				acquired.reason === "error" ? "overlay-error" : "busy",
				acquired.errorMessage,
			);
		}
		const section = new LockedSection(
			this,
			lock,
			cache,
			stalePresent,
			staleDeleted,
			all,
			bookkeepingOnly,
		);
		return await section.run();
	}

	// Accessors for the locked section (same pass, same named sets).
	get yieldClock(): YieldClock {
		return this.clock;
	}
	get context(): DirtyOverlayContext {
		return this.ctx;
	}
	/**
	 * The limits the locked section works to: the rebuild budget less the time
	 * spent at the in-process gate, so one search stays bounded by ONE budget.
	 */
	get passLimits(): OverlayLimits {
		return {
			...this.limits,
			rebuildBudgetMs: Math.max(0, this.limits.rebuildBudgetMs - this.queuedMs),
		};
	}
	/** The configured rebuild budget, before the gate's share came out of it. */
	get fullRebuildBudgetMs(): number {
		return this.limits.rebuildBudgetMs;
	}
	get queuedAtGateMs(): number {
		return this.queuedMs;
	}
	get paths(): { vectorsDir: string; manifestPath: string } {
		return { vectorsDir: this.vectorsDir, manifestPath: this.manifestPath };
	}
	get embeddingIdentity(): OverlayEmbeddingIdentity {
		if (this.identity === null) throw new Error("identity not resolved");
		return this.identity;
	}
	get unclassifiedCount(): number {
		return this.unclassified;
	}
	isCompatible(manifest: OverlayManifest): boolean {
		return this.compatible(manifest);
	}
	manifestFor(files: ReadonlyMap<string, BuiltFile>): OverlayManifest {
		return this.nextManifest(files);
	}
	get gapsBeforeLock(): GapRecorder {
		return this.passGaps;
	}

	/** Whether the manifest re-read under the lock is not the one we classified from. */
	changedSinceSnapshot(reread: OverlayManifest): boolean {
		const snap = this.snapshot;
		return (
			snap === null ||
			serializeOverlayManifest(snap) !== serializeOverlayManifest(reread)
		);
	}

	/**
	 * Review 1, HIGH 3. Another pass wrote the manifest after our snapshot, so
	 * our W' and mark were derived from an older one. Writing them blindly
	 * dropped its watch entries while the mark stayed past their tracker rows:
	 * a file it watched was then never a candidate again.
	 *
	 * So, under the lock: EVERY path it watches is IMPORTED — classified now
	 * (its stale members are served or suppressed by THIS pass, and its built
	 * rows are not garbage-collected) and kept in W' whatever it classifies
	 * as, because our git listing predates its observation. That includes a
	 * path our own snapshot watched too (review 2, HIGH 1): skipping those as
	 * "already ours" let a path both passes watched fall out of W'. It is
	 * conservative — the next pass, with no overlap, decides on its own
	 * listing. The mark becomes the later of the two: rows between the marks
	 * were classified by one pass or the other, and what either found stale is
	 * now in W'.
	 *
	 * Returns the candidates whose class is now stale, for the locked section.
	 */
	async reconcile(reread: OverlayManifest): Promise<Candidate[]> {
		for (const [path, entry] of Object.entries(reread.files)) {
			this.knownBuilt.set(path, entry.built);
		}
		const recheck: Candidate[] = [];
		// EVERY path it watches, including those our own snapshot watched too
		// (review 2, HIGH 1): our classification of a path we both watch rests
		// on the same older listing, so it is no more evidence than for a new one.
		for (const path of reread.watch) {
			const key = nfc(path);
			if (isSelectedFile(this.ctx.selection, path)) {
				const known = this.candidates.get(key);
				// New to this pass, or classified by it as neither stale: either
				// way its class is re-derived now. Already-stale members are in
				// this pass's sets and stay as they are.
				const wasStale =
					known !== undefined &&
					(known.klass === "stalePresent" || known.klass === "staleDeleted");
				this.addCandidate(key, path, "W");
				const cand = this.candidates.get(key);
				if (cand !== undefined) {
					cand.imported = true;
					if (!wasStale) recheck.push(cand);
				}
			}
			await this.clock.yieldIfDue();
		}
		await this.classify(recheck, reread.hashMemo);
		this.nextHighWater = laterMark(this.nextHighWater, reread.trackerHighWater);
		return recheck.filter(
			(c) => c.klass === "stalePresent" || c.klass === "staleDeleted",
		);
	}
}

/**
 * The later of two keyset marks on the same branch — the tracker's order,
 * `(indexed_at, path)`. A mark for another branch (or none) is not comparable
 * and leaves `ours` as it is; SCOPE_ALL (`ours === null`) records none.
 */
function laterMark(
	ours: TrackerHighWater | null,
	theirs: TrackerHighWater | null,
): TrackerHighWater | null {
	if (ours === null || theirs === null || theirs.branchId !== ours.branchId) {
		return ours;
	}
	if (theirs.indexedAt !== ours.indexedAt) {
		return theirs.indexedAt > ours.indexedAt ? theirs : ours;
	}
	return theirs.path > ours.path ? theirs : ours;
}

/** A file whose chunks are embedded and ready to write. */
interface Completed {
	readonly cand: Candidate;
	readonly hash: string;
	readonly chunks: ChunkWithEmbedding[];
}

/**
 * Everything that happens while the overlay lock is held: §2 step 7 a-h.
 * The manifest is written in `finally` BEFORE the table is closed and the
 * lock released (HIGH 1), unless the lock was lost.
 */
class LockedSection {
	private files = new Map<string, BuiltFile>();
	private manifestDirty = false;
	private manifestWritten = false;
	private lockLost = false;
	private store: IVectorStore | null = null;
	private client: CachingEmbeddingsClient | null = null;
	private readonly gaps = new GapRecorder();
	private readonly pendingKeys = new Set<string>();
	private rebuilt = 0;
	private readonly started = Date.now();

	constructor(
		private readonly pass: OverlayPass,
		private readonly lock: IndexLock,
		private readonly cache: EmbedCacheLike | null,
		private readonly stalePresent: Candidate[],
		private readonly staleDeleted: Candidate[],
		private readonly all: Candidate[],
		private readonly bookkeepingOnly: boolean,
	) {}

	async run(): Promise<DirtyOverlayResult> {
		try {
			return await this.body();
		} catch (err) {
			if (isCodeBug(err)) throw err;
			if (err instanceof OverlayLockLostError) {
				this.lockLost = true;
				return skipped("lock-lost", err.message);
			}
			if (err instanceof PassSkip)
				return this.skippedAfterWork(err.reason, err.message);
			return skipped("overlay-error", messageOf(err));
		} finally {
			// HIGH 1: the files whose writes completed are recorded even when a
			// later step threw — and never by a holder that lost the lock.
			if (!this.lockLost && this.manifestDirty && !this.manifestWritten) {
				try {
					this.writeManifest();
				} catch {
					// Lost or unwritable: the next pass re-derives everything.
				}
			}
			try {
				await this.store?.close();
			} catch {
				// Dropping the handle is all close() does; nothing to report.
			}
			this.store = null;
			this.lock.release();
		}
	}

	private writeManifest(): void {
		this.lock.assertStillHeld();
		writeOverlayManifest(
			this.pass.paths.manifestPath,
			this.pass.manifestFor(this.files),
		);
		this.manifestWritten = true;
	}

	private async body(): Promise<DirtyOverlayResult> {
		const { vectorsDir, manifestPath } = this.pass.paths;

		// a. Re-read UNDER the lock; a mismatch wipes data, never the lock.
		const read = readOverlayManifest(manifestPath);
		const newer =
			read.kind === "ok" &&
			this.pass.isCompatible(read.manifest) &&
			this.pass.changedSinceSnapshot(read.manifest);
		if (this.bookkeepingOnly && newer) {
			// Another pass wrote after our snapshot: its bookkeeping is newer
			// than ours and its built rows are its own. Ours was an
			// optimisation; dropping it loses nothing (HIGH 3).
			return {
				candidates: undefined,
				report: emptyReport("on", "index-current"),
			};
		}
		if (
			read.kind === "corrupt" ||
			(read.kind === "ok" && !this.pass.isCompatible(read.manifest))
		) {
			this.wipe();
		} else if (read.kind === "ok") {
			for (const [path, entry] of Object.entries(read.manifest.files)) {
				this.files.set(path, entry.built);
			}
			if (newer) {
				for (const cand of await this.pass.reconcile(read.manifest)) {
					this.adopt(cand);
				}
				// Outer review 2: the capacity checks ran before the lock, against
				// the snapshot. The import can push W' past the cap, and
				// `nextWatch` would then cut an imported path while the mark
				// moves past its tracker row — a path silently out of the watch
				// set with its stale index rows back. Skip instead, BEFORE
				// `manifestDirty`: nothing is written, so the newer manifest
				// stays exactly as its pass wrote it.
				const overflow = this.pass.watchOverflow();
				if (overflow !== null) throw new PassSkip("too-large", overflow);
			}
		}
		this.manifestDirty = true;

		// b. A FRESH table handle, opened after the lock was taken.
		this.store = await this.openStore(vectorsDir);

		const keepStored = new Set(this.stalePresent.map((c) => c.storedPath));
		const gcPaths = [...this.files.keys()].filter((p) => !keepStored.has(p));

		if (this.bookkeepingOnly) {
			if (gcPaths.length > 0) await this.writeRows([], gcPaths);
			this.writeManifest();
			return {
				candidates: undefined,
				report: emptyReport("on", "index-current"),
			};
		}

		// c. Build what is stale and not already built at this exact hash.
		const toBuild = this.stalePresent.filter(
			(c) =>
				c.failure === undefined &&
				c.disk.kind === "present" &&
				this.files.get(c.storedPath)?.contentHash !== c.disk.hash,
		);
		const completed = await this.build(toBuild);
		const refusal = this.providerWideRefusal(completed);
		if (refusal !== null) throw new PassSkip("embed-failed", refusal);

		// d + e. Strict delete, add, optimize.
		await this.writeRows(completed, gcPaths);

		// f. Id proof, g. read, h. manifest.
		const served = await this.proveServed();
		const candidates = await this.read(served);
		this.writeManifest();
		return { candidates, report: this.report(served) };
	}

	/** A candidate `reconcile` found stale under the lock joins this pass's sets. */
	private adopt(cand: Candidate): void {
		if (!this.all.includes(cand)) this.all.push(cand);
		const into =
			cand.klass === "stalePresent" ? this.stalePresent : this.staleDeleted;
		if (!into.includes(cand)) into.push(cand);
	}

	private wipe(): void {
		const { vectorsDir, manifestPath } = this.pass.paths;
		this.lock.assertStillHeld();
		wipeOverlayData(vectorsDir, manifestPath);
		this.files.clear();
	}

	/**
	 * A fresh overlay store. An open/read error, or a table whose width is not
	 * this identity's, wipes and retries ONCE; a second failure is
	 * `skipped/overlay-corrupt` (HIGH 5).
	 */
	private async openStore(vectorsDir: string): Promise<IVectorStore> {
		const dimension = this.pass.embeddingIdentity.dimension;
		for (let attempt = 1; attempt <= 2; attempt++) {
			const store = createVectorStore({
				vectorsDir,
				pathRoot: this.pass.context.loc.pathRoot,
				role: "overlay",
			});
			const problem = await this.probe(store, dimension);
			if (problem === null) return store;
			await store.close();
			if (attempt === 2) {
				throw new PassSkip("overlay-corrupt", problem);
			}
			this.gaps.noteGap("overlay-wiped", problem);
			this.wipe();
			await this.pass.yieldClock.yieldIfDue();
		}
		throw new PassSkip("overlay-corrupt", "unreachable");
	}

	private async probe(
		store: IVectorStore,
		dimension: number,
	): Promise<string | null> {
		try {
			await store.initialize();
			const width = await store.vectorWidth();
			if (width !== null && width !== dimension) {
				return `table width ${width} != ${dimension}`;
			}
			// A read that touches data files, not only the schema.
			await store.rowsByIds(
				[...this.files.values()]
					.flatMap((b) => b.chunks.map((c) => c.id))
					.slice(0, 1),
			);
			return null;
		} catch (err) {
			rethrowFatal(err);
			return messageOf(err);
		}
	}

	// ── c. build ─────────────────────────────────────────────────────────────

	private embedder(): CachingEmbeddingsClient {
		if (this.client === null) {
			const ctx = this.pass.context;
			// The SAME raw client that embedded the query (HIGH 4), wrapped with
			// the machine-global cache (R3.5).
			this.client = createCachingEmbeddingsClient(ctx.queryClient, {
				cache: this.cache,
				configEnabled: ctx.embedCacheConfigEnabled,
				clientFingerprint: embeddingTextFingerprint(ctx.queryClient),
			});
		}
		return this.client;
	}

	/**
	 * PROVIDER-WIDE REFUSAL (Phase 6, TEST-31; architecture D-12 limit 8).
	 *
	 * A FATAL failure (`isFatalEmbeddingFailure`, or a throw not known to be
	 * per-chunk) already stops the pass at its first call. This is the other
	 * shape: answers that are each "per-text" (an HTTP 500, an empty slot, a
	 * non-fatal `TotalEmbeddingFailureError`) arriving for EVERY text. It is
	 * decided over the WHOLE build, after every file was tried, so the order
	 * of files cannot change it. The pass is `skipped/embed-failed` iff ALL of:
	 *
	 *   (a) at least one file failed `embed` this pass — so at least one text
	 *       reached the provider and came back without a usable vector;
	 *   (b) the provider ACCEPTED ZERO texts this pass
	 *       (`stats().accepted === 0`: no response carried a non-empty
	 *       vector; cache hits never reached the provider and do not count);
	 *   (c) nothing was left untried (`pendingKeys` empty): a budget cut means
	 *       the provider was slow, not that it refused everything;
	 *   (d) the pass has NOTHING ELSE TO CONTRIBUTE: no file completed (e.g.
	 *       from cache hits alone), none is already built at the hash classified
	 *       this pass, and no deleted file awaits suppression.
	 *
	 * (a)+(b) say the provider refused everything it was asked; (c)+(d) say
	 * skipping loses nothing. When (d) fails — TEST-32's second search, where
	 * the earlier-built file is still served and only the refused file is sent
	 * — the pass did NOT give up, so it stays `on` and each refused file is
	 * `failed(embed)` (its own gap says "failed for all N texts"). One
	 * accepted text anywhere fails (b): the provider works, the refusal is
	 * per-file (TEST-32's first search, P-2, P-4, R-2). With one file refused
	 * and nothing else in play, "this file" and "the provider" cannot be told
	 * apart; the pass-level answer is given because the overlay contributes
	 * nothing either way, and both leave the index rows visible.
	 *
	 * A skip serves nothing, suppresses nothing and writes no row.
	 */
	private providerWideRefusal(completed: readonly Completed[]): string | null {
		const refused = this.stalePresent.filter((c) => c.failure === "embed");
		if (refused.length === 0) return null; // (a)
		const stats = this.client?.stats();
		if (stats === undefined || stats.accepted > 0) return null; // (b)
		if (this.pendingKeys.size > 0) return null; // (c)
		const alreadyBuilt = this.stalePresent.some(
			(c) =>
				c.failure === undefined &&
				c.disk.kind === "present" &&
				this.files.get(c.storedPath)?.contentHash === c.disk.hash,
		);
		if (completed.length > 0 || alreadyBuilt || this.staleDeleted.length > 0) {
			return null; // (d)
		}
		const first = refused[0];
		return (
			"the provider accepted none of the overlay texts sent this pass, " +
			`${refused.length} file(s) refused` +
			(first?.failureMessage ? ` (first: ${first.failureMessage})` : "")
		);
	}

	private async build(toBuild: readonly Candidate[]): Promise<Completed[]> {
		const completed: Completed[] = [];
		const budget = { started: Date.now(), batches: 0, exhausted: false };
		for (const cand of toBuild) {
			const done = await this.buildFile(cand, budget);
			if (done !== null) completed.push(done);
			await this.pass.yieldClock.yieldIfDue();
		}
		return completed;
	}

	/** Read ONCE, hash that buffer, chunk, embed in budgeted batches. */
	private async buildFile(
		cand: Candidate,
		budget: { started: number; batches: number; exhausted: boolean },
	): Promise<Completed | null> {
		if (budget.exhausted) {
			this.pendingKeys.add(cand.key);
			return null;
		}
		const limits = this.pass.passLimits;
		const abs = join(this.pass.context.loc.pathRoot, cand.diskPath);
		let bytes: Buffer;
		try {
			bytes = readFileSync(abs);
		} catch (err) {
			this.fail(cand, "read", messageOf(err));
			return null;
		}
		if (bytes.length > limits.maxFileBytes) {
			this.fail(cand, "too-large", `${bytes.length} bytes`);
			return null;
		}
		const hash = hashFileBytes(bytes);
		if (cand.disk.kind !== "present" || hash !== cand.disk.hash) {
			// Changed between classification and build: next pass.
			this.pendingKeys.add(cand.key);
			return null;
		}
		let chunks: CodeChunk[];
		try {
			chunks = await chunkFileByPath(
				bytes.toString("utf-8"),
				cand.storedPath,
				hash,
			);
		} catch (err) {
			this.fail(cand, "chunk", messageOf(err));
			return null;
		}

		const dimension = this.pass.embeddingIdentity.dimension;
		const deadline = budget.started + limits.rebuildBudgetMs;
		const embedded: ChunkWithEmbedding[] = [];
		let fileFailed = false;
		for (
			let i = 0;
			i < chunks.length && !budget.exhausted && !fileFailed;
			i += OVERLAY_EMBED_BATCH
		) {
			// MEDIUM 3: the budget is checked BETWEEN batches, so one large file
			// cannot overrun it. The pass's first batch always STARTS — and,
			// since review 1, every batch is also cut off AT the deadline.
			if (budget.batches > 0 && Date.now() > deadline) {
				budget.exhausted = true;
			} else {
				const batch = chunks.slice(i, i + OVERLAY_EMBED_BATCH);
				const outcome = await this.embedBatch(batch, dimension, deadline);
				if (outcome.kind === "deadline") {
					budget.exhausted = true;
					this.noteDeadline();
				} else if (outcome.kind === "refused") {
					this.fail(cand, "embed", outcome.message);
					fileFailed = true;
				} else {
					embedded.push(...outcome.chunks);
					budget.batches++;
				}
				this.lock.recordProgress();
			}
			await this.pass.yieldClock.yieldIfDue();
		}
		if (fileFailed) return null;
		if (embedded.length < chunks.length) {
			// Partly embedded: its vectors are in the cache, the rest next pass.
			this.pendingKeys.add(cand.key);
			return null;
		}
		return { cand, hash, chunks: embedded };
	}

	/**
	 * One embed call through the cache, under the overlay's call policy
	 * (review 1, HIGH 1): ONE attempt per provider request, and an abort at
	 * `deadline` that ends the request and any back-off sleep — the call is
	 * cancelled, not raced.
	 *
	 *   deadline reached            → `deadline`: this file and the rest pending
	 *   a fatal provider failure    → PassSkip(`embed-failed`): the provider is
	 *     (`isFatalEmbeddingFailure`, unusable for every request, so the pass
	 *     or an error not known to    stops at the FIRST one
	 *     be per-chunk)
	 *   every text refused, non-    → `refused`: this FILE is `failed(embed)`
	 *     fatal (Total…Error)
	 *   one slot `[]` or the wrong  → `refused`: this FILE is `failed(embed)`;
	 *     width                       never a row (CLAUDE.md #15), and the
	 *                                 other files are still served
	 */
	private async embedBatch(
		batch: CodeChunk[],
		dimension: number,
		deadline: number,
	): Promise<
		| { readonly kind: "ok"; readonly chunks: ChunkWithEmbedding[] }
		| { readonly kind: "deadline" }
		| { readonly kind: "refused"; readonly message: string }
	> {
		const controller = new AbortController();
		const timer = setTimeout(
			() => controller.abort(new Error("overlay rebuild budget reached")),
			Math.max(0, deadline - Date.now()),
		);
		const policy: EmbedCallOptions = {
			signal: controller.signal,
			maxAttempts: OVERLAY_EMBED_MAX_ATTEMPTS,
		};
		let result: {
			embeddings: number[][];
			keys?: string[];
			warnings?: string[];
		};
		try {
			result = await this.embedder().embedContentOf(
				batch,
				"chunks",
				undefined,
				policy,
			);
		} catch (err) {
			const deadlineReached = controller.signal.aborted;
			// Review 2, MEDIUM 5: the clients that send PARALLEL requests
			// (OpenRouter, Voyage) reject on the first fatal answer while the
			// others are still in flight. Abort them now, through the signal
			// every request of this call is linked to, rather than leave them
			// running to their own 60 s timeout. This call's policy only: the
			// indexing path passes no signal and is untouched.
			if (!deadlineReached) {
				controller.abort(
					new Error("overlay embed call failed; cancelling its other requests"),
				);
			}
			rethrowFatal(err);
			if (deadlineReached) return { kind: "deadline" };
			const message = messageOf(err);
			if (
				err instanceof TotalEmbeddingFailureError &&
				!isFatalEmbeddingFailure(message)
			) {
				return { kind: "refused", message };
			}
			throw new PassSkip("embed-failed", message);
		} finally {
			clearTimeout(timer);
		}
		const bad = batch.findIndex((_, i) => {
			const vector = result.embeddings[i];
			// `!==`, never truthiness: a zero-length vector is the case (#15).
			return vector === undefined || vector.length !== dimension;
		});
		if (bad >= 0) {
			const width = result.embeddings[bad]?.length ?? 0;
			const why = result.warnings?.[0];
			return {
				kind: "refused",
				message: `chunk at line ${batch[bad]?.startLine ?? "?"}: a vector of width ${width} for a ${dimension}-wide index${why === undefined ? "" : ` (${why})`}`,
			};
		}
		return {
			kind: "ok",
			chunks: batch.map((chunk, i) => ({
				...chunk,
				vector: result.embeddings[i] as number[],
				embedKey: result.keys?.[i] ?? "",
			})),
		};
	}

	/**
	 * One gap line per pass for a budget cut, however many files it left
	 * pending — naming the share the in-process gate took, so "provider slow"
	 * and "waited behind another search" read differently (review 2, LOW 11).
	 */
	private noteDeadline(): void {
		if (this.gaps.has("embed-deadline")) return;
		const queued = this.pass.queuedAtGateMs;
		this.gaps.noteGap(
			"embed-deadline",
			`rebuild budget ${this.pass.fullRebuildBudgetMs} ms reached, the rest is pending` +
				(queued > 0
					? ` (${queued} ms were spent queued behind another search in this process)`
					: ""),
		);
	}

	private fail(
		cand: Candidate,
		failure: OverlayFileFailure,
		message: string,
	): void {
		cand.failure = failure;
		cand.failureMessage = message;
	}

	// ── d + e. strict delete, add, optimize ──────────────────────────────────

	/**
	 * ONE strict delete over every completed path plus the GC paths, then one
	 * `addChunks` per ≤ 256-row batch (MEDIUM 10). `built` is set only after a
	 * file's delete and adds all resolved; a failure removes the entries
	 * involved, because the table may hold either revision (HIGH 10).
	 */
	private async writeRows(
		completed: readonly Completed[],
		gcPaths: readonly string[],
	): Promise<void> {
		const store = this.store;
		if (store === null) return;
		const deletePaths = [
			...new Set([...completed.map((c) => c.cand.storedPath), ...gcPaths]),
		];
		if (deletePaths.length === 0) return;

		this.lock.assertStillHeld();
		try {
			await store.deleteRowsByStoredPathsStrict(deletePaths);
		} catch (err) {
			rethrowFatal(err);
			for (const path of deletePaths) this.files.delete(path);
			for (const done of completed)
				this.fail(done.cand, "write", messageOf(err));
			this.gaps.noteGap("delete-failed", messageOf(err));
			return;
		}
		for (const path of deletePaths) this.files.delete(path);
		this.lock.recordProgress();

		const writeOk = await this.addAll(store, completed);
		if (writeOk) {
			this.lock.assertStillHeld();
			try {
				await store.optimize({ retentionMs: 0 });
			} catch (err) {
				rethrowFatal(err);
				this.gaps.noteGap("optimize-failed", messageOf(err));
			}
		}
	}

	/** Adds in ≤ 256-row batches; false when a batch failed (writing stopped). */
	private async addAll(
		store: IVectorStore,
		completed: readonly Completed[],
	): Promise<boolean> {
		const rows = completed.flatMap((done) =>
			done.chunks.map((chunk) => ({ chunk, done })),
		);
		const remaining = new Map<Completed, number>(
			completed.map((done) => [done, done.chunks.length]),
		);
		// A file with no chunks is complete as soon as its delete resolved.
		for (const done of completed) {
			if (done.chunks.length === 0) this.markBuilt(done);
		}
		let stoppedAt = -1;
		for (let i = 0; i < rows.length; i += OVERLAY_WRITE_BATCH) {
			const batch = rows.slice(i, i + OVERLAY_WRITE_BATCH);
			const outcome = await this.addBatch(store, batch, remaining);
			if (!outcome) {
				stoppedAt = i;
				break;
			}
			this.lock.recordProgress();
			await this.pass.yieldClock.yieldIfDue();
		}
		if (stoppedAt < 0) return true;
		// Files in batches never attempted: their old rows are deleted and the
		// new ones not written. Not their fault — pending, rebuilt next pass
		// from the cache.
		for (const { done } of rows.slice(stoppedAt)) {
			if (done.cand.failure === undefined) this.pendingKeys.add(done.cand.key);
		}
		return false;
	}

	private async addBatch(
		store: IVectorStore,
		batch: readonly { chunk: ChunkWithEmbedding; done: Completed }[],
		remaining: Map<Completed, number>,
	): Promise<boolean> {
		this.lock.assertStillHeld();
		try {
			await store.addChunks(
				batch.map((r) => r.chunk),
				{ branchId: BRANCH_ID_SHARED, pathKind: "repo" },
			);
		} catch (err) {
			rethrowFatal(err);
			for (const { done } of batch)
				this.fail(done.cand, "write", messageOf(err));
			this.gaps.noteGap("add-failed", messageOf(err));
			return false;
		}
		for (const { done } of batch) {
			const left = (remaining.get(done) ?? 0) - 1;
			remaining.set(done, left);
			if (left === 0 && done.cand.failure === undefined) this.markBuilt(done);
		}
		return true;
	}

	private markBuilt(done: Completed): void {
		this.files.set(done.cand.storedPath, {
			contentHash: done.hash,
			chunks: done.chunks.map((c) => ({
				id: c.id,
				contentHash: c.contentHash,
				startLine: c.startLine,
				endLine: c.endLine,
			})),
		});
		this.rebuilt++;
	}

	// ── f. the id proof ──────────────────────────────────────────────────────

	/**
	 * `served`: stalePresent, not failed, not pending, `built.contentHash` ==
	 * the hash classified this pass, and EVERY built id present in the table
	 * (HIGH 1, 5, 10). A missing id is `failed(inconsistent)` and its entry is
	 * removed, so the next pass rebuilds it.
	 */
	private async proveServed(): Promise<Candidate[]> {
		const store = this.store;
		if (store === null) return [];
		const eligible = this.stalePresent.filter(
			(c) =>
				c.failure === undefined &&
				!this.pendingKeys.has(c.key) &&
				c.disk.kind === "present" &&
				this.files.get(c.storedPath)?.contentHash === c.disk.hash,
		);
		const ids = eligible.flatMap(
			(c) => this.files.get(c.storedPath)?.chunks.map((k) => k.id) ?? [],
		);
		const present = await store.existingIds(ids);
		const served: Candidate[] = [];
		for (const cand of eligible) {
			const built = this.files.get(cand.storedPath);
			const missing = (built?.chunks ?? []).filter((k) => !present.has(k.id));
			if (missing.length > 0) {
				this.fail(
					cand,
					"inconsistent",
					`${missing.length} built row(s) missing from the overlay table`,
				);
				this.files.delete(cand.storedPath);
			} else {
				served.push(cand);
			}
			await this.pass.yieldClock.yieldIfDue();
		}
		return served;
	}

	// ── g. the read ──────────────────────────────────────────────────────────

	private async read(
		served: readonly Candidate[],
	): Promise<OverlayCandidates | undefined> {
		const store = this.store;
		if (store === null) return undefined;
		if (served.length === 0 && this.staleDeleted.length === 0) return undefined;

		const chunksByPathHash = new Map<string, OverlayChunkRef[]>();
		const servedIds: string[] = [];
		for (const cand of served) {
			const built = this.files.get(cand.storedPath);
			const byHash = new Map<string, BuiltChunk[]>();
			for (const chunk of built?.chunks ?? []) {
				servedIds.push(chunk.id);
				const list = byHash.get(chunk.contentHash);
				if (list === undefined) byHash.set(chunk.contentHash, [chunk]);
				else list.push(chunk);
			}
			for (const [hash, list] of byHash) {
				chunksByPathHash.set(`${cand.storedPath}\0${hash}`, refsOf(list));
			}
			await this.pass.yieldClock.yieldIfDue();
		}

		const ctx = this.pass.context;
		const vector = await store.vectorCandidates(
			[...ctx.queryVector],
			servedIds,
			ctx.search,
		);
		const rows = await store.rowsByIds(servedIds);
		const rowsById = new Map<string, OverlayVectorRow>(
			rows.map((row) => [row.id, row]),
		);

		const suppressed = new Set<string>();
		for (const cand of [...served, ...this.staleDeleted]) {
			suppressed.add(cand.storedPath);
			for (const row of cand.rows) suppressed.add(row.path);
		}
		return {
			suppressedPaths: [...suppressed].sort(),
			servedPaths: served.map((c) => c.storedPath).sort(),
			vector,
			chunksByPathHash,
			rowsById,
		};
	}

	// ── the report ───────────────────────────────────────────────────────────

	private report(served: readonly Candidate[]): OverlayReport {
		const failed = this.stalePresent.filter((c) => c.failure !== undefined);
		const servedKeys = new Set(served.map((c) => c.key));
		const pending = this.stalePresent.filter(
			(c) => c.failure === undefined && !servedKeys.has(c.key),
		);
		const stats = this.client?.stats();
		const gaps = new GapRecorder();
		for (const c of failed) {
			gaps.noteGap(
				`file-failed-${c.failure as OverlayFileFailure}`,
				c.failureMessage ?? "",
				c.storedPath,
			);
		}
		gaps.absorb(this.pass.gapsBeforeLock);
		gaps.absorb(this.gaps);
		// R3.8, stated rather than faked, whenever a row is served.
		if (served.length > 0) {
			for (const token of OVERLAY_ROW_GAP_TOKENS) gaps.noteGap(token);
		}
		return {
			state: "on",
			reason: "dirty",
			files: served.length,
			filesIndexCurrent: this.all.filter((c) => c.klass === "indexCurrent")
				.length,
			filesDeleted: this.staleDeleted.length,
			filesPending: pending.length,
			filesFailed: failed.length,
			filesUnclassified: this.pass.unclassifiedCount,
			rebuilt: this.rebuilt,
			// ACCEPTED, not sent: a refused text is a miss and not an embedding.
			embedded: stats?.accepted ?? 0,
			cacheHits: stats?.hits ?? 0,
			rebuildMs: Date.now() - this.started,
			...gaps.fields(),
		};
	}

	/**
	 * A skip from INSIDE the locked section still reports the provider work
	 * it did — what was accepted, what the cache answered, how long it held
	 * the lock — rather than zeroes. A skip writes nothing, so `rebuilt` and
	 * the file counts stay 0.
	 */
	private skippedAfterWork(
		reason: OverlaySkipReason,
		message: string,
	): DirtyOverlayResult {
		const result = skipped(reason, message);
		const stats = this.client?.stats();
		return {
			candidates: undefined,
			report: {
				...result.report,
				embedded: stats?.accepted ?? 0,
				cacheHits: stats?.hits ?? 0,
				rebuildMs: Date.now() - this.started,
			},
		};
	}
}
