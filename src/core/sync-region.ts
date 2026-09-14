/**
 * The blocking bound for synchronous SQLite work done while the index lock is
 * held — ONE mechanism, shared by every SQLite owner that needs it.
 *
 * Extracted from `embed-cache.ts`, where the bound was derived and proven
 * (CLAUDE.md #31), so the file tracker reuses the SAME arithmetic rather than a
 * copy of it. `embed-cache.ts` re-exports the names its importers already use,
 * so its behaviour, its tests and `scripts/measure-embed-cache-regions.cjs` are
 * unchanged.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IMPORT ALLOWLIST — NOTHING. Not a project module, not even a node builtin.
 *
 * `embed-cache.ts` may import only node builtins, `./sqlite.js` and this file,
 * so that a machine-global write-path component cannot widen `config.ts`'s
 * dependency graph. Anything imported HERE becomes an edge from the cache and
 * from the tracker at once; a leaf with no imports cannot be that edge.
 * Enforced by `test/unit/core/embed-cache-imports.test.ts`.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * WHAT STAYS WITH EACH SQLITE OWNER, deliberately not here:
 *   - its CONTENTION BUDGET (`embed-cache.ts`'s `CONTENTION_BUDGET_MS`). Each
 *     file owns its own. The budget only decides WHEN TO DEGRADE — the heartbeat
 *     bound does not rest on it — so it is a PARAMETER of `clampedBusyTimeoutMs`.
 *   - its REGION TABLE and chunk sizes. `blockingStatements` is a claim about one
 *     owner's statements, and changing any size invalidates the arithmetic below
 *     (CLAUDE.md #31), so each owner declares its own and redoes it.
 *   - the connection, the "re-issue the pragma only when it changes" memo, and
 *     what a region does on failure.
 */

// ════════════════════════════════════════════════════════════════════════════
// Why any of this exists
// ════════════════════════════════════════════════════════════════════════════

/**
 * `isLockStale()` (`lock.ts:157-187`) has TWO rules, and the tighter one is the
 * one that binds here:
 *
 *   PRIMARY   now - (lastProgressAt ?? heartbeat) > DEFAULT_PROGRESS_TIMEOUT   (300 000 ms)
 *   SECONDARY now - heartbeat                     > DEFAULT_STALE_TIMEOUT      ( 10 000 ms)
 *
 * `heartbeat` is written ONLY by `startHeartbeat()`'s 1 s `setInterval`
 * (`lock.ts:592-606`); `recordProgress()` writes `lastProgressAt` only. Every
 * SQLite call behind `sqlite.ts` is SYNCHRONOUS, so it blocks the event loop,
 * and a blocked loop cannot run that interval. This is CLAUDE.md #27's mechanism
 * verbatim with synchronous SQLite in place of `Bun.spawnSync`: exceed the
 * secondary rule and a SECOND indexer reclaims a held lock and runs concurrently.
 */

// ════════════════════════════════════════════════════════════════════════════
// Constants — NOT to be changed without redoing THE ARITHMETIC below
// ════════════════════════════════════════════════════════════════════════════

/**
 * Resting `PRAGMA busy_timeout`, and the busy-wait allowance for a WHOLE region.
 *
 * NOT the per-statement value: see `clampedBusyTimeoutMs()`. `busy_timeout` is
 * a per-statement timeout, so a region of 64 statements at 250 ms each could
 * burn 16 s. The clamp therefore DIVIDES this allowance across the region's
 * blocking statements, which is what makes the region — not the statement — the
 * bounded unit.
 */
export const BUSY_TIMEOUT_MS = 250;

/** Design target for the WORK inside any one region. Measured, not assumed. */
export const MAX_SYNC_REGION_MS = 250;

// ════════════════════════════════════════════════════════════════════════════
// Regions
// ════════════════════════════════════════════════════════════════════════════

/**
 * A bounded synchronous region: a contiguous run of statements the caller
 * executes without yielding.
 *
 * `blockingStatements` is the number of statements in the region that can
 * INDEPENDENTLY wait on the busy handler. Inside a transaction only the first
 * write can: once it holds the write lock, the later statements do not
 * re-contend for it. The numbers each owner declares are therefore
 * conservative.
 *
 * `name` is `embed-cache.ts`'s four regions. The tracker's regions widen this
 * union when the tracker adopts the bound; the extraction does not.
 */
export interface SyncRegion {
	readonly name: "R1" | "R2" | "R3" | "R4";
	readonly blockingStatements: number;
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ARITHMETIC — in CLAUDE.md #27's form, against the REAL constants.
 *
 * Constants, read from `src/core/lock.ts` (`embed-cache-blocking.test.ts`
 * re-reads them from that file's source so this cannot drift — they are
 * module-private there and cannot be imported without widening this file's
 * import list):
 *
 *     DEFAULT_STALE_TIMEOUT     = 10000   (lock.ts:91)
 *     DEFAULT_PROGRESS_TIMEOUT  = 300000  (lock.ts:99)
 *     HEARTBEAT_INTERVAL        = 1000    (lock.ts:101)
 *
 * THE CORRECTION THIS CARRIES (plan review r3, HIGH, found by both reviewers
 * independently). Revision 2 of the embed-cache design clamped `busy_timeout`
 * ONCE PER REGION to `min(250, remaining)` and derived
 * `B_max = CONTENTION_BUDGET_MS + MAX_SYNC_REGION_MS = 1250`. That does not
 * bound anything: `busy_timeout` is a PER-STATEMENT timeout, the budget is only
 * consulted at region entry, and the cache's R1 holds 64 statements — so one
 * region could block 64 × 250 ms = 16 s while the derivation said 1 250 ms.
 * Revision 1's `B_max = 500` was right by accident and wrong in its reasoning;
 * revision 2 re-derived a number that rests on the same confusion pointing the
 * other way.
 *
 * THE MECHANISM THAT ACTUALLY BOUNDS IT — one expression at region entry
 * (`clampedBusyTimeoutMs`):
 *
 *     perStatementMs = floor( min(BUSY_TIMEOUT_MS, remainingBudget)
 *                             / region.blockingStatements )
 *
 * so, for a region the caller respects the size of:
 *
 *     region busy-wait  ≤  blockingStatements × perStatementMs
 *                       ≤  min(BUSY_TIMEOUT_MS, remaining)
 *                       ≤  BUSY_TIMEOUT_MS = 250 ms                    …[1]
 *
 * [1] holds for EVERY region independently of the process budget, of how many
 * regions ran before it, and of how the contention is distributed inside it.
 * The per-process budget is a second, independent mechanism — it decides WHEN
 * TO DEGRADE, and the heartbeat bound does not rest on it. That is the
 * difference between this and revision 2: the falsifier for [1] is a region
 * size, which the code controls, not an assumption about distribution.
 *
 *     B_max = 250  (busy-wait, WHOLE region, by [1])
 *           + 250  (work, MAX_SYNC_REGION_MS — measured per region, both drivers)
 *           = 500 ms
 *
 *     max age of `heartbeat` when ANOTHER process reads it
 *         = HEARTBEAT_INTERVAL + B_max + one lock-file write
 *         =       1000         +  500  +        ~1
 *         = 1501 ms   <   DEFAULT_STALE_TIMEOUT = 10000 ms
 *                                       margin  = 8499 ms  (8.5 s)
 *
 *     against the PRIMARY rule: 300000 / 500 = 600× margin.
 *
 *     compare CLAUDE.md #27:  6000 + 1000 = 7000 < 10000, margin 3000 ms.
 *
 * The step from one region's `B_max` to the heartbeat age holds only if the
 * event loop runs BETWEEN regions: two regions back to back with no
 * `await yieldToEventLoop()` between them block for the sum, and the line above
 * then bounds one region and nothing else.
 *
 * Two notes that keep the number honest rather than decorative:
 *
 *   - `B_max` is ONE region's contribution, not the process total. LanceDB
 *     writes and tree-sitter parsing block too; they do so today and this
 *     mechanism does not lengthen them. The 8.5 s of headroom absorbs the sum.
 *   - `MAX_SYNC_REGION_MS` is a target that is MEASURED, not assumed —
 *     `scripts/measure-embed-cache-regions.cjs` reports the p99 of the cache's
 *     R1–R4 on both sqlite drivers. If one exceeds 250 ms, its size constant is
 *     halved. `EmbedCache.stats().maxSyncRegionMs` reports the runtime maximum
 *     as TELEMETRY ONLY: it is the class's self-report about its own blocking,
 *     the same category as a millisecond budget standing in for a spawn count
 *     (CLAUDE.md #24), so the assertion is a `setInterval` tick gap measured
 *     from outside.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ════════════════════════════════════════════════════════════════════════════
// The clamp (CLAUDE.md #27's shape: pre-flight, never post-hoc)
// ════════════════════════════════════════════════════════════════════════════

/**
 * The per-statement `busy_timeout` that bounds the WHOLE region — THE
 * ARITHMETIC's one expression. The DIVISION by `region.blockingStatements` is
 * the load-bearing part; without it the allowance bounds one statement, not the
 * region.
 *
 * Pure. The caller owns the connection, its own contention budget and the
 * "only re-issue when it changes" memo, and renders the result through
 * `busyTimeoutPragma()`.
 */
export function clampedBusyTimeoutMs(
	region: SyncRegion,
	contentionBudgetMs: number,
	contentionUsedMs: number,
): number {
	const remaining = Math.max(0, contentionBudgetMs - contentionUsedMs);
	const regionAllowanceMs = Math.min(BUSY_TIMEOUT_MS, remaining);
	return Math.floor(regionAllowanceMs / region.blockingStatements);
}

/**
 * Render `PRAGMA busy_timeout = N`.
 *
 * This is the ONE statement a SQLite owner renders instead of binding
 * (CLAUDE.md #22): `PRAGMA` cannot bind a parameter. The value is `Math.floor`
 * of arithmetic over constants — never anything a caller supplies — and this
 * refuses anything but a non-negative integer before rendering it. A region
 * declared with `blockingStatements: 0` yields `Infinity` or `NaN`, and throws
 * here instead of reaching SQL.
 *
 * `owner` prefixes the error ("embed-cache", …), so a refusal names the file.
 */
export function busyTimeoutPragma(ms: number, owner: string): string {
	if (!Number.isInteger(ms) || ms < 0) {
		throw new Error(
			`${owner}: refusing to render a non-integer busy_timeout (${ms})`,
		);
	}
	return `PRAGMA busy_timeout = ${ms}`;
}

// ════════════════════════════════════════════════════════════════════════════
// Yield
// ════════════════════════════════════════════════════════════════════════════

/**
 * Return control to the event loop's TIMERS phase, so a due `setInterval` — the
 * lock heartbeat — can run before the next synchronous region starts.
 *
 * The design pins the PROPERTY, not the primitive: `embed-cache-blocking.test.ts`
 * measures interval starvation directly with a 1 s `setInterval`, so whichever
 * primitive this uses has to actually deliver it.
 */
export function yieldToEventLoop(): Promise<void> {
	return new Promise<void>((r) => {
		setTimeout(r, 0);
	});
}
