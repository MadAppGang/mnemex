/**
 * The local dirty overlay's types (step 3, R3). Type-only module: no runtime
 * code, so `store.ts` can name these without gaining an edge to the overlay.
 *
 * Vocabulary — the NAMED SETS of architecture §5 ("Named sets", revision 1).
 * Every other comment in `src/core/overlay/` uses these names and no others;
 * "served", unqualified, always means `served`, never "dirty".
 *
 *   G   paths git lists (any status, deletions included), in stored spelling,
 *       restricted to `isSelectedFile`.
 *   W   `manifest.watch`: paths this worktree's overlay has seen git-dirty or
 *       stale and has not since seen both git-clean AND index-current.
 *   T   tracker rows of the branch indexed at/after `manifest.trackerHighWater`
 *       (branch scope only; empty in SCOPE_ALL and on the first pass).
 *   C   G ∪ W ∪ T, restricted to `isSelectedFile`.
 *
 * Per path in C, against the tracker rows in the read's branch set:
 *
 *   indexCurrent   on disk, and a row's content_hash equals the disk hash.
 *                  The hash is the ONLY proof; tracker mtime is never read.
 *   staleDeleted   absent from disk, and rows exist.
 *   stalePresent   on disk, not indexCurrent, and (in G, in W, or rows
 *                  exist). In W with no row is an untracked file that was
 *                  committed without a reindex: still stale (review 1, HIGH 2).
 *   ignored        everything else.
 *   unclassified   not reached by the classification budget this pass;
 *                  treated as if not in C.
 *
 * `stalePresent` then partitions into exactly one of:
 *
 *   served   built.contentHash == the disk hash classified this pass AND the
 *            id proof passed: index rows suppressed, overlay rows read.
 *   failed   a per-file error this pass (read, too-large, chunk, embed,
 *            write, inconsistent): index rows visible, old overlay rows never
 *            read.
 *   pending  not reached (budget), partly embedded, or changed between
 *            classification and build: index rows visible, old rows never read.
 *
 *   suppressed = served ∪ staleDeleted, in the TRACKER's spelling.
 */

/** One overlay chunk's identity and current lines. */
export interface OverlayChunkRef {
	readonly id: string;
	readonly startLine: number;
	readonly endLine: number;
}

/** A materialised overlay row: everything hydration needs, no vector. */
export interface OverlayVectorRow extends OverlayChunkRef {
	/** Stored (repo-relative) spelling — the tracker's when it has a row. */
	readonly filePath: string;
	readonly content: string;
	readonly language: string;
	readonly chunkType: string;
	readonly name?: string;
	readonly parentName?: string;
	readonly signature?: string;
	readonly contentHash: string;
	readonly fileHash: string;
	/** L2 distance to the query vector; `0` for a row read by id only. */
	readonly _distance: number;
}

/**
 * What `prepareDirtyOverlay` hands to the search path (consumed from phase 5).
 * Every row is materialised under the overlay lock, so the merge after the
 * lock is released needs no overlay handle.
 */
export interface OverlayCandidates {
	/** `suppressed`, stored spelling. */
	readonly suppressedPaths: readonly string[];
	/** `served` (= the BM25 calibration paths), stored spelling. */
	readonly servedPaths: readonly string[];
	/** ≤ `vectorFetchLimit`, id-unique, `(_distance asc, id asc)`. */
	readonly vector: readonly OverlayVectorRow[];
	/**
	 * The depth `vector` was cut at (`vectorCandidates`' fetch limit). The
	 * search cuts it again at each pass's own depth, and never deepens past
	 * it while `vector` is full (`searchDepthCap` in `store.ts`). Absent:
	 * `searchFetchLimit(limit)`, the first pass's depth, so a search over
	 * such a list does not deepen while the list is full.
	 */
	readonly vectorFetchLimit?: number;
	/** Key `${path}\0${contentHash}`; refs in `startLine` order. */
	readonly chunksByPathHash: ReadonlyMap<string, readonly OverlayChunkRef[]>;
	/** Every served chunk, for hydrating a BM25-only overlay hit. */
	readonly rowsById: ReadonlyMap<string, OverlayVectorRow>;
}

export type OverlayState = "on" | "off" | "skipped";

/** Why the overlay did not run at all (decided by the gate, phase 6). */
export type OverlayOffReason = "flag" | "config" | "keyword-only" | "no-vector";

/**
 * Why a pass gave up and served index rows only, suppressing nothing.
 * Every one leaves the index's own result list untouched (R3.11).
 */
export type OverlaySkipReason =
	| "no-index"
	| "no-git"
	| "git-failed"
	| "too-large"
	| "busy"
	| "cache-cold-under-lock"
	| "lock-lost"
	| "embed-failed"
	| "overlay-corrupt"
	| "identity-mismatch"
	/** Anything unanticipated: still never a failed search (R3.11). */
	| "overlay-error";

/** Why an `on` pass did what it did. */
export type OverlayOnReason =
	/** Nothing in C was stale: today's index-only path (NFR-2). */
	| "index-current"
	/** Something was stale; see the file counts for what was served. */
	| "dirty";

export type OverlayReason =
	| OverlayOffReason
	| OverlaySkipReason
	| OverlayOnReason;

/** A per-file failure, listed in `overlay_gaps` as `file-failed-<failure>`. */
export type OverlayFileFailure =
	| "read"
	| "too-large"
	| "chunk"
	/**
	 * The provider refused a chunk of this file (an empty or wrong-width
	 * vector, or every text of the call refused, non-fatally). The FILE fails;
	 * the pass goes on (review 1, HIGH 1). A provider-wide failure is the
	 * pass-level `embed-failed` instead: a fatal one at the first call, or a
	 * pass in which the provider accepted NO text it was sent (see
	 * `isProviderWideRefusal` in `dirty-overlay.ts`).
	 */
	| "embed"
	| "write"
	| "inconsistent";

/**
 * R3.8's row gaps: stated whenever a pass serves at least one file
 * (`OVERLAY_ROW_GAP_TOKENS` in `dirty-overlay.ts` lists them, in order).
 */
export type OverlayRowGapToken =
	| "no-symbol-graph"
	| "no-code-units"
	| "no-summaries"
	| "bm25-unchanged-chunks-only";

/** A pass-level event that left the overlay incomplete or degraded. */
export type OverlayPassGapToken =
	/** The rebuild budget cut the pass; the rest of the files are pending. */
	| "embed-deadline"
	/** The classification budget stopped T mid-way (a lower bound). */
	| "unclassified-budget"
	/** The watch capacity stopped T mid-way (a lower bound). */
	| "unclassified-watch-capacity"
	/** The embed cache is over its cap: overlay vectors were not persisted. */
	| "embed-cache-over-cap"
	/** The overlay table failed its probe and was wiped and rebuilt. */
	| "overlay-wiped"
	| "delete-failed"
	| "optimize-failed"
	| "add-failed";

/**
 * The CLOSED vocabulary of `OverlayReport.gaps` (iteration 2, O4): bare
 * machine tokens, `[a-z0-9-]+`, matched exactly by a consumer. Free text —
 * paths, counts, error messages, provider JSON — lives in `gapDetails` and
 * never in a token. `OVERLAY_GAP_TOKENS` (`dirty-overlay.ts`) lists every
 * member.
 */
export type OverlayGapToken =
	/** A skip's cause. */
	| OverlaySkipReason
	/** A file that failed: its index rows are shown instead. */
	| `file-failed-${OverlayFileFailure}`
	| OverlayPassGapToken
	| OverlayRowGapToken;

/** The free text behind one gap event. */
export interface OverlayGapDetail {
	readonly token: OverlayGapToken;
	/** Stored spelling; per-file failures only. */
	readonly path?: string;
	/** Free text: provider JSON is allowed here and ONLY here. */
	readonly message: string;
}

export interface OverlayReport {
	readonly state: OverlayState;
	readonly reason: OverlayReason;
	/** |served| */
	readonly files: number;
	/** |indexCurrent| among C */
	readonly filesIndexCurrent: number;
	/** |staleDeleted| */
	readonly filesDeleted: number;
	readonly filesPending: number;
	readonly filesFailed: number;
	/**
	 * Members of T this pass did not classify. When the classification budget
	 * or the watch capacity stopped it mid-T, later tracker pages were never
	 * read, so this is a LOWER BOUND and `gaps` says "at least".
	 */
	readonly filesUnclassified: number;
	/** Files whose overlay rows were (re)written this pass. */
	readonly rebuilt: number;
	/**
	 * Texts the provider ACCEPTED this pass: sent as a cache miss and answered
	 * with a non-empty vector. A refused text is not counted, so this agrees
	 * with the wire (Phase 6, TEST-31's observation: it used to count every
	 * miss, and reported 1 with 0 accepted). Carried on a skip, too.
	 */
	readonly embedded: number;
	/** Texts answered by the embed cache this pass. Carried on a skip, too. */
	readonly cacheHits: number;
	/** Wall time of the locked build+write+read section, ms. */
	readonly rebuildMs: number;
	/**
	 * Machine tokens only, each ONCE, in first-occurrence order: a failed
	 * file's `file-failed-<failure>`, a skip's cause, pass-level events, and —
	 * whenever files are served — R3.8's row gaps (`OVERLAY_ROW_GAP_TOKENS`).
	 * MCP serialises this array as is; `--agent` joins it with `; `
	 * (`overlay_gaps`).
	 */
	readonly gaps: readonly OverlayGapToken[];
	/**
	 * The free text behind the tokens, one entry per EVENT (a token may
	 * repeat: two failed files give two details). MCP carries it as
	 * `overlay.gapDetails`; `--agent` as `overlay_gap_details`.
	 */
	readonly gapDetails: readonly OverlayGapDetail[];
}

/**
 * The overlay report as a SEARCH returns it (`BranchScopedSearch.overlay`):
 * the pass's report plus what the store's pre-filter hid. Always present —
 * a consumer relies on the keys, never on their absence.
 */
export interface SearchOverlayReport extends OverlayReport {
	/**
	 * Index rows (`pathKind = 'repo'`, under the branch predicate) the
	 * suppression pre-filter hid: `countRowsForStoredPaths(scope, suppressed)`.
	 * R3.3 asks for a POSITIVE count, so a test can tell "suppressed" from
	 * "nothing happened". 0 whenever nothing was suppressed.
	 */
	readonly suppressedRows: number;
}
