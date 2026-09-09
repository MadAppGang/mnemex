/**
 * Persistent, content-addressed embedding cache (Phase 1 — storage only).
 *
 * Owns: the key formula, the SQLite file, the schema, the LRU sweep and the three
 * vetoes. Knows NOTHING about chunks, indexers, LanceDB or embeddings clients —
 * the caching proxy (Phase 2, `caching-embeddings-client.ts`) is what connects
 * this to `IEmbeddingsClient`, and the indexer is what connects that to a run.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * IMPORT ALLOWLIST — node builtins and `./sqlite.js`, and NOTHING ELSE.
 *
 * Not `../config.js`, not `./indexer.js`, not `./embeddings.js`, nothing under
 * `src/mcp/`. A machine-global write-path component must not be able to widen
 * `config.ts`'s dependency graph: the one pre-existing failure in this repo's
 * test suite is an import-order fault through
 * `config.ts:1665` → `mcp/tools/deps.ts:114` → `mcp/tools/search.ts:295`, and it
 * must not widen. `src/core/keychain.ts` follows the same rule deliberately
 * (CLAUDE.md #24). Enforced by `test/unit/core/embed-cache-imports.test.ts`.
 *
 * Consequence: this module reads its own env opt-outs (no import needed) and
 * receives every policy value that lives in config — the enable flag, the client
 * fingerprint — as a PARAMETER from the indexer, which already imports both.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Gotchas this file is written against:
 *   #15 a zero-length vector is a corrupt-index generator. Refused on WRITE and
 *       on READ, compared against `0` explicitly — never `if (vec.length)`.
 *   #21 a per-instance guard on a per-request object never fires. Two-level
 *       memo: the INSTANCE on the resolved path, the DDL on the sqlite
 *       file+inode (`tracker.ts`'s convention), in-memory databases excluded.
 *   #22 no string interpolation into SQL. Every statement is parameterised; the
 *       ONE exception is `PRAGMA busy_timeout`, which cannot bind a parameter —
 *       see `applyClamp()`, which renders an integer computed from module
 *       constants and asserts that it is one.
 *   #24 launches no process and touches no credential. Its DEFAULT PATH is a
 *       real user file, so the same deny-by-default shape guards it — see
 *       "THE USER-PATH GATE" below.
 *   #27 blocking time is bounded by a PRE-FLIGHT clamp, never a post-hoc check.
 *       See "THE BLOCKING BOUND" below.
 *   #31 the cache is machine-global: one file for every repo on the machine.
 */

import { createHash } from "node:crypto";
import { mkdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import type { SQLiteDatabase, Statement } from "./sqlite.js";
import { createDatabaseSync } from "./sqlite.js";

// ════════════════════════════════════════════════════════════════════════════
// Key (FR-1)
// ════════════════════════════════════════════════════════════════════════════

/**
 * THE ONLY implementation of the key formula: `sha256(model \0 dimension \0 text)`.
 *
 * NOT `chunker.ts`'s `contentHash`: `name` and `chunkType` are inside that hash
 * but are NOT in the embedded text, so keying on it would split the cache across
 * entries whose vectors are byte-identical.
 *
 * The separator is NUL because neither a model name nor a decimal dimension can
 * contain one, so no (model, dim, text) triple can collide with another by
 * re-spelling the boundary.
 *
 * The PROVIDER is deliberately NOT in the formula — it is part of the table's
 * PRIMARY KEY instead (§4.1), so one model name used under two providers gives
 * two coexisting rows rather than two rows evicting each other every run
 * (CLAUDE.md #16's scenario: a bare `nomic-embed-text` that resolves to Ollama
 * on one machine and OpenRouter on another).
 */
export function embedCacheKey(
	model: string,
	dimension: number,
	text: string,
): string {
	return createHash("sha256")
		.update(`${model}\0${dimension}\0${text}`, "utf8")
		.digest("hex");
}

// ════════════════════════════════════════════════════════════════════════════
// Modes, tiers, policy
// ════════════════════════════════════════════════════════════════════════════

/** USER/ENV policy only. Never returns "memory" — that is a tier, not a mode. */
export type EmbedCacheMode = "persistent" | "off";

/**
 * RUNTIME state. Degradation moves the TIER, never the mode, so a disk failure
 * can never be mistaken for the user's opt-out (and so it cannot switch off the
 * proxy's in-process L0 as a side effect).
 */
export type EmbedCacheTier = "sqlite" | "l0" | "none";

/** Env opt-out. Read here because this module may not import `config.ts`. */
export const ENV_DISABLE = "MNEMEX_DISABLE_EMBED_CACHE";
/** Path redirect, for tests and for users who want the file elsewhere. */
export const ENV_PATH = "MNEMEX_EMBED_CACHE_PATH";

/**
 * `MNEMEX_DISABLE_EMBED_CACHE=1` ⇒ "off"; `configEnabled === false` ⇒ "off";
 * otherwise "persistent".
 *
 * `=== false`, never falsy: `undefined` means "the user never set it", which is
 * ON. This is the same discipline as CLAUDE.md #25's "an explicit `undefined`
 * means UNTOUCHED".
 */
export function resolveEmbedCacheMode(configEnabled?: boolean): EmbedCacheMode {
	const disabled = process.env[ENV_DISABLE];
	if (disabled !== undefined && disabled !== "" && disabled !== "0") {
		return "off";
	}
	if (configEnabled === false) return "off";
	return "persistent";
}

/**
 * `MNEMEX_EMBED_CACHE_PATH` or `~/.mnemex/embed-cache.db`.
 *
 * `homedir()` is read at CALL time, never into a module-level const — mirrors
 * `getGlobalLockPath()` (`lock.ts:647`). A module const cannot be redirected,
 * and Bun's `homedir()` ignores a runtime `HOME` reassignment
 * (see `test/helpers/sandbox-guard.ts`).
 */
export function getEmbedCachePath(): string {
	const override = process.env[ENV_PATH];
	if (override !== undefined && override.length > 0) return override;
	return join(homedir(), ".mnemex", "embed-cache.db");
}

// ════════════════════════════════════════════════════════════════════════════
// THE USER-PATH GATE — deny by default, opened by the entry point alone
// ════════════════════════════════════════════════════════════════════════════

/**
 * WHY THIS EXISTS.
 *
 * The default cache path is MACHINE-GLOBAL (`~/.mnemex/embed-cache.db`,
 * CLAUDE.md #31), so the moment this feature landed, EVERY test that reaches
 * `Indexer.index()` became a potential writer of the user's real cache file.
 * That is not hypothetical: the Phase 8 measurement run found a 36,864-byte
 * `~/.mnemex/embed-cache.db` on the maintainer's machine, created by the
 * committed test suite via `test/unit/core/probes/indexer-model-mismatch.probe.ts`
 * — a probe that predates this feature and was correct until the default path
 * became a user path.
 *
 * It is the same class CLAUDE.md #25 records for `~/.mnemex/config.json` ("a
 * review probe that reassigned HOME at runtime wrote to a real user's config
 * file"), and the mechanism is the one CLAUDE.md #24 established for the
 * keychain: make the unsafe thing IMPOSSIBLE BY DEFAULT, then let the one
 * production composition root opt in.
 *
 * Deliberately NOT an environment variable, for the reason #24 gives: an env var
 * is inherited by every child, which is the propagation that made the previous
 * keychain guard fragile. It also needs no `bunfig.toml` preload and no working
 * directory — `bun` resolves `bunfig.toml` against the CURRENT WORKING DIRECTORY
 * and does not walk up, so `cd test && bun test ../x.test.ts` gets no preload at
 * all and this gate still holds.
 */
let userPathEnabled = false;

/** Vetoes {@link enableUserEmbedCachePath} inside a CHILD that runs the entry point. */
const TEST_GUARD_ENV = "MNEMEX_EMBED_CACHE_TEST_GUARD";

/** Prefix every refusal carries, so a test can assert on the message. */
export const USER_PATH_REFUSAL_PREFIX =
	"embed-cache: refusing to open the user cache";

/**
 * Production opt-in. Called exactly once, from `src/index.ts`, before any command
 * dispatch — the same single caller, and the same one-line shape, as
 * `enableRealKeychainAccess()`.
 *
 * Vetoed by the test sentinel, so a test that SPAWNS the real entry point (which
 * would otherwise turn the gate on inside the child, #24's first bypass) still
 * cannot write the user's cache. `test/helpers/child-env.ts` sets that sentinel
 * at every spawn site; `test/setup/embed-cache-guard.ts` sets it for the suite.
 */
export function enableUserEmbedCachePath(): void {
	if (process.env[TEST_GUARD_ENV] === "1") return;
	userPathEnabled = true;
}

/**
 * DISABLE-ONLY test seam. There is deliberately no exported way to set the gate
 * to `true` other than the production opt-in above, which the sentinel vetoes —
 * #24's second bypass was exactly a `set…ForTests(true)` that could write the
 * production gate.
 */
export function disableUserEmbedCachePathForTests(): void {
	userPathEnabled = false;
}

/** Read at CALL time, never captured at module load. */
export function userEmbedCachePathEnabled(): boolean {
	return userPathEnabled;
}

/**
 * `realpath`, falling back to the deepest ancestor that exists.
 *
 * Same algorithm, and the same two reasons, as `test/helpers/sandbox-guard.ts`:
 * a path that does not exist yet cannot be `realpath`'d at all, and comparing
 * unresolved paths gets symlinked spellings of one directory wrong. Duplicated
 * rather than imported because this module's import allowlist is node builtins
 * and `./sqlite.js` — see the header.
 */
function resolveDeepest(path: string): string {
	const segments: string[] = [];
	let current = resolve(path);
	for (;;) {
		try {
			const real = realpathSync(current);
			return segments.length === 0 ? real : join(real, ...segments.reverse());
		} catch {
			const parent = dirname(current);
			if (parent === current) return resolve(path); // reached the root
			segments.push(current.slice(parent.length + 1));
			current = parent;
		}
	}
}

/**
 * THE predicate: why opening `target` is refused, or `null` if it is allowed.
 *
 * A pure function of its three inputs, separate from the gate it guards, for the
 * reason `sandbox-guard.ts` gives: it can then be tested against arbitrary paths
 * WITHOUT a process that actually writes one of them.
 *
 * The rule is about the PATH, not about how the path was derived. An explicit
 * `MNEMEX_EMBED_CACHE_PATH` that points back into `~/.mnemex` is refused too —
 * a redirect that redirects nowhere is the bug this is looking for.
 *
 * There is deliberately no "…unless HOME is inside tmpdir" escape. A sandboxed
 * `HOME` is a claim made by the test that set it, and the explicit opt-out
 * (`MNEMEX_EMBED_CACHE_PATH`) costs one line either way.
 *
 * @param target   the file `openEmbedCache` is about to create/open
 * @param homeDir  what `os.homedir()` returns — the value `getEmbedCachePath()` uses
 * @param enabled  whether the production entry point opened the gate
 */
export function userEmbedCachePathRefusal(
	target: string,
	homeDir: string,
	enabled: boolean,
): string | null {
	if (enabled) return null;
	const userDir = resolveDeepest(join(homeDir, ".mnemex"));
	const resolved = resolveDeepest(target);
	const inside =
		resolved === userDir || resolved.startsWith(`${userDir}${sep}`);
	if (!inside) return null;
	return (
		`${USER_PATH_REFUSAL_PREFIX} at ${resolved}.\n` +
		"The embedding cache is machine-global (CLAUDE.md #31), so this is a REAL " +
		"user file that a test must never touch.\n" +
		`Point ${ENV_PATH} at a temp directory (or set ${ENV_DISABLE}=1) before the ` +
		"code under test opens the cache.\n" +
		"Only src/index.ts may open this path, via enableUserEmbedCachePath()."
	);
}

// ════════════════════════════════════════════════════════════════════════════
// THE BLOCKING BOUND — constants, regions, and the arithmetic
// ════════════════════════════════════════════════════════════════════════════

/**
 * Why any of this exists.
 *
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

/**
 * Resting `PRAGMA busy_timeout`, and the busy-wait allowance for a WHOLE region.
 *
 * NOT the per-statement value: see `applyClamp()`. `busy_timeout` is a
 * per-statement timeout, so a region of 64 statements at 250 ms each could burn
 * 16 s. The clamp therefore DIVIDES this allowance across the region's blocking
 * statements, which is what makes the region — not the statement — the bounded
 * unit.
 */
export const BUSY_TIMEOUT_MS = 250;

/**
 * Total busy-wait per PROCESS (not per call — CLAUDE.md #27's shape). On
 * exhaustion the clamp reaches 0 and the next `SQLITE_BUSY` latches the
 * persistent tier off for the rest of the process (the keychain circuit
 * breaker's precedent).
 */
export const CONTENTION_BUDGET_MS = 1000;

/** Design target for the WORK inside any one region. Measured, not assumed. */
export const MAX_SYNC_REGION_MS = 250;

/** Point lookups per region — a YIELD boundary for the caller, not just a stamp. */
export const LOOKUP_CHUNK = 64;
/** `putMany` transaction size (~768 KB of blob at 768 dims). */
export const WRITE_CHUNK = 256;
/** Eviction transaction size. */
export const EVICT_CHUNK = 512;
/** Pages per `PRAGMA incremental_vacuum(N)` — NEVER the bare form. */
export const VACUUM_PAGES = 2048;
/** Wall-clock cap on one run's eviction; the next run continues where it stopped. */
export const EVICT_DEADLINE_MS = 2000;
/** Default file-size cap (2 GiB), governing `page_count * page_size`. */
export const DEFAULT_MAX_CACHE_BYTES = 2 * 1024 * 1024 * 1024;
/** Evict down to this fraction of the cap, so runs do not thrash at the edge. */
export const EVICT_TARGET_RATIO = 0.9;
/**
 * A row whose `last_used_at` is newer than this is NOT rewritten by a touch.
 * Without it an all-hits run rewrites every row it reads.
 */
export const TOUCH_RESOLUTION_MS = 60_000;

/**
 * A bounded synchronous region: a contiguous run of statements the caller
 * executes without yielding.
 *
 * `blockingStatements` is the number of statements in the region that can
 * INDEPENDENTLY wait on the busy handler. Inside a transaction only the first
 * write can: once it holds the write lock, the later statements do not
 * re-contend for it. The numbers below are therefore conservative.
 */
export interface SyncRegion {
	readonly name: "R1" | "R2" | "R3" | "R4";
	readonly blockingStatements: number;
}

/** Lookup slice: `LOOKUP_CHUNK` independent point SELECTs. */
export const REGION_LOOKUP: SyncRegion = {
	name: "R1",
	blockingStatements: LOOKUP_CHUNK,
};
/** Write slice: one transaction (INSERT, touch UPDATE, optional dims UPSERT). */
export const REGION_WRITE: SyncRegion = { name: "R2", blockingStatements: 3 };
/** Evict slice: a bounded SELECT outside the transaction, then one DELETE txn. */
export const REGION_EVICT: SyncRegion = { name: "R3", blockingStatements: 2 };
/** Vacuum slice: one `PRAGMA incremental_vacuum(N)`. */
export const REGION_VACUUM: SyncRegion = { name: "R4", blockingStatements: 1 };

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ARITHMETIC — in CLAUDE.md #27's form, against the REAL constants.
 *
 * Constants, read from `src/core/lock.ts` (a test re-reads them from that file's
 * source so this cannot drift — they are module-private there and cannot be
 * imported without widening this file's import list):
 *
 *     DEFAULT_STALE_TIMEOUT     = 10000   (lock.ts:91)
 *     DEFAULT_PROGRESS_TIMEOUT  = 300000  (lock.ts:99)
 *     HEARTBEAT_INTERVAL        = 1000    (lock.ts:101)
 *
 * THE CORRECTION THIS CARRIES (plan review r3, HIGH, found by both reviewers
 * independently). Revision 2 of the design clamped `busy_timeout` ONCE PER
 * REGION to `min(250, remaining)` and derived
 * `B_max = CONTENTION_BUDGET_MS + MAX_SYNC_REGION_MS = 1250`. That does not
 * bound anything: `busy_timeout` is a PER-STATEMENT timeout, the budget is only
 * consulted at region entry, and R1 holds 64 statements — so one region could
 * block 64 × 250 ms = 16 s while the derivation said 1 250 ms. Revision 1's
 * `B_max = 500` was right by accident and wrong in its reasoning; revision 2
 * re-derived a number that rests on the same confusion pointing the other way.
 *
 * THE MECHANISM THAT ACTUALLY BOUNDS IT — one expression at region entry:
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
 * The per-process budget is now a second, independent mechanism — it decides
 * WHEN TO DEGRADE, and the heartbeat bound no longer rests on it. That is the
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
 * Two notes that keep the number honest rather than decorative:
 *
 *   - `B_max` is THIS FEATURE's contribution, not the process total. LanceDB
 *     writes and tree-sitter parsing block too; they do so today and this
 *     change does not lengthen them. The 8.5 s of headroom absorbs the sum.
 *   - `MAX_SYNC_REGION_MS` is a target that is MEASURED, not assumed —
 *     `scripts/measure-embed-cache-regions.cjs` reports the p99 of R1–R4 on both
 *     sqlite drivers. If one exceeds 250 ms, its size constant is halved.
 *     `stats().maxSyncRegionMs` reports the runtime maximum as TELEMETRY ONLY:
 *     it is the class's self-report about its own blocking, the same category
 *     as a millisecond budget standing in for a spawn count (CLAUDE.md #24), so
 *     the assertion is a `setInterval` tick gap measured from outside.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ════════════════════════════════════════════════════════════════════════════
// Port and data types
// ════════════════════════════════════════════════════════════════════════════

export interface EmbedCacheEntry {
	key: string;
	model: string;
	provider: string;
	dimension: number;
	fingerprint: string;
	vector: readonly number[];
}

/** A row to have its `last_used_at` refreshed. */
export interface TouchKey {
	key: string;
	provider: string;
}

/**
 * A row that FAILED A VETO, carrying the identity it had when it failed.
 *
 * Deliberately more than `TouchKey`, and this is a correction to §3.1's
 * signature rather than an embellishment. A vetoed row is a MISS, so the text is
 * re-embedded and written back under the SAME `(key, provider)` in the same
 * batch. A delete-by-primary-key would then remove the row that was just
 * written — a permanent 0 % hit rate for exactly the texts a veto touches, with
 * full write amplification and no error. Deleting on the full vetoed identity
 * cannot do that: the fresh row differs in at least one of `dim`, `fingerprint`
 * or `bytes` BY CONSTRUCTION, since those are the three things a veto compares.
 * Pinned by `evict does not delete a row that was rewritten in the same batch`.
 */
export interface VetoedRow extends TouchKey {
	dim: number;
	fingerprint: string;
	bytes: number;
}

export interface ModelDims {
	model: string;
	provider: string;
	dimension: number;
}

export interface EmbedCacheStats {
	hits: number;
	misses: number;
	writes: number;
	refusedZeroLength: number;
	refusedDimension: number;
	refusedFingerprint: number;
	dimensionCorrections: number;
	tier: EmbedCacheTier;
	degraded: string | null;
	/** Telemetry only — never an assertion. See THE ARITHMETIC above. */
	maxSyncRegionMs: number;
	/** Busy-wait charged to this process so far, against CONTENTION_BUDGET_MS. */
	contentionUsedMs: number;
}

export interface EmbedCacheEvictionReport {
	fileBytesBefore: number;
	fileBytesAfter: number;
	rowsEvicted: number;
	bytesFreed: number;
	vacuumCalls: number;
	stoppedAtDeadline: boolean;
	/** Null when nothing prevented the sweep from running. */
	skipped: string | null;
}

/**
 * The structural port the caching proxy depends on. It is an interface so a test
 * can substitute a counting fake; the proxy never names the class.
 */
export interface EmbedCacheLike {
	get(
		key: string,
		provider: string,
		dimension: number,
		fingerprint: string,
	): number[] | undefined;
	putMany(
		entries: readonly EmbedCacheEntry[],
		touched: readonly TouchKey[],
		dims?: ModelDims,
	): void;
	knownDimension(model: string, provider: string): number | undefined;
	recordDimension(model: string, provider: string, dimension: number): void;
	evictKeys(rows: readonly VetoedRow[]): void;
	/** Drains the rows `get()` vetoed since the last call. */
	pendingEvictions(): VetoedRow[];
	/**
	 * Telemetry for the proxy's Rule R. OPTIONAL on the port because it is
	 * reporting, not behaviour: a fake that omits it is still a correct cache,
	 * and `dimensionCorrections` is owned authoritatively by the proxy's own
	 * `stats()`. `EmbedCache` implements it (see `noteDimensionCorrection`).
	 */
	noteDimensionCorrection?(): void;
	stats(): EmbedCacheStats;
	enforceBudget(): Promise<EmbedCacheEvictionReport>;
	close(): void;
}

// ════════════════════════════════════════════════════════════════════════════
// Float32 codec (§4.3)
// ════════════════════════════════════════════════════════════════════════════

/**
 * LanceDB's JS client infers `FixedSizeList<Float32>` for a `number[]` vector
 * column — that is where `assertQueryableTableDimension` reads `listSize` from
 * (`store.ts:455-467`) — so a JS float64 that reaches `addChunks` is narrowed to
 * f32 BY LANCEDB ANYWAY. Round-tripping f64 → f32 → f64 through this cache
 * therefore yields a value that narrows to the IDENTICAL f32 in the table:
 * same bytes on disk, same distances, same ranking. (`Math.fround` is
 * idempotent.) `test/unit/core/embed-cache-codec.test.ts` asserts the Arrow
 * child type is `Float32`, so the premise is checked rather than believed.
 */
const IS_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/** Encode to little-endian float32 bytes. */
export function encodeVectorF32(vector: readonly number[]): Uint8Array {
	const f32 = new Float32Array(vector.length);
	for (let i = 0; i < vector.length; i++) f32[i] = vector[i] as number;
	return new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
}

/** Decode little-endian float32 bytes. Throws on a length that is not a multiple of 4. */
export function decodeVectorF32(bytes: Uint8Array): number[] {
	if (bytes.byteLength % 4 !== 0) {
		throw new Error(
			`embed-cache: blob of ${bytes.byteLength} bytes is not float32-aligned`,
		);
	}
	// Copy into a fresh, 4-byte-aligned buffer: a BLOB handed back by either
	// driver may be a view at an arbitrary byteOffset, and Float32Array cannot
	// wrap an unaligned one.
	const f32 = new Float32Array(bytes.byteLength / 4);
	new Uint8Array(f32.buffer).set(bytes);
	return Array.from(f32);
}

/**
 * ASSUMPTION 4 (§11), and the reason this helper exists at all.
 *
 * `better-sqlite3` historically accepts only a `Buffer` for a BLOB parameter,
 * not any `Uint8Array`; `bun:sqlite` takes a `Uint8Array`. The repo SHIPS BOTH
 * driver paths (`sqlite.ts:36`), so this is a real portability risk rather than
 * a hypothetical one. `Buffer.from(view.buffer, offset, length)` is a VIEW, not
 * a copy, so the wrap is free.
 *
 * `Buffer` is a global under both runtimes, so this needs no import and the
 * allowlist stays as it is. Verified from BOTH runtimes by
 * `test/unit/core/embed-cache-drivers.test.ts`, which runs the real
 * `better-sqlite3` in a Node child because it cannot be loaded under Bun at all
 * (bun 1.4.0 aborts with `NAPI FATAL ERROR` on `new Database()`).
 */
export function toBlobParam(view: Uint8Array): Uint8Array {
	if (typeof globalThis.Bun !== "undefined") return view;
	return Buffer.from(view.buffer, view.byteOffset, view.byteLength);
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

// ════════════════════════════════════════════════════════════════════════════
// Schema
// ════════════════════════════════════════════════════════════════════════════

/** Bumped only if the SQLite schema changes shape. */
export const CACHE_SCHEMA_VERSION = 1;

const DDL = [
	`CREATE TABLE IF NOT EXISTS embeddings (
		key           TEXT    NOT NULL,
		provider      TEXT    NOT NULL,
		model         TEXT    NOT NULL,
		dim           INTEGER NOT NULL,
		fingerprint   TEXT    NOT NULL,
		vector        BLOB    NOT NULL,
		bytes         INTEGER NOT NULL,
		created_at    INTEGER NOT NULL,
		last_used_at  INTEGER NOT NULL,
		PRIMARY KEY (key, provider)
	)`,
	"CREATE INDEX IF NOT EXISTS idx_embeddings_lru ON embeddings(last_used_at)",
	`CREATE TABLE IF NOT EXISTS model_dims (
		model      TEXT    NOT NULL,
		provider   TEXT    NOT NULL,
		dim        INTEGER NOT NULL,
		learned_at INTEGER NOT NULL,
		PRIMARY KEY (model, provider)
	)`,
	"CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)",
];

// ════════════════════════════════════════════════════════════════════════════
// Row shapes as the drivers return them
// ════════════════════════════════════════════════════════════════════════════

interface EntryRow {
	dim: number;
	fingerprint: string;
	bytes: number;
	vector: Uint8Array;
}

interface LruRow {
	rid: number;
	bytes: number;
}

// ════════════════════════════════════════════════════════════════════════════
// EmbedCache
// ════════════════════════════════════════════════════════════════════════════

export interface EmbedCacheOpenOptions {
	/** File-size cap. Tests use a small one; production uses the default. */
	maxBytes?: number;
	/**
	 * Wall-clock cap on ONE run's eviction sweep. Defaults to
	 * `EVICT_DEADLINE_MS`; overridable so a test can size a sweep past it (and
	 * so `mnemex doctor` could one day sweep harder outside an index run).
	 */
	evictDeadlineMs?: number;
}

export class EmbedCache implements EmbedCacheLike {
	private readonly db: SQLiteDatabase;
	private readonly stmts: {
		selEntry: Statement;
		insEntry: Statement;
		touch: Statement;
		selDims: Statement;
		upsertDims: Statement;
		delVetoed: Statement;
		selLru: Statement;
		delRowid: Statement;
	};

	private tier: EmbedCacheTier = "sqlite";
	private degraded: string | null = null;
	private closed = false;

	private hits = 0;
	private misses = 0;
	private writes = 0;
	private refusedZeroLength = 0;
	private refusedDimension = 0;
	private refusedFingerprint = 0;
	private dimensionCorrections = 0;

	private contentionUsedMs = 0;
	private appliedBusyTimeoutMs = BUSY_TIMEOUT_MS;
	private maxSyncRegionMs = 0;
	/** Elapsed accumulated across the current R1 window, for telemetry. */
	private lookupWindowMs = 0;
	private lookupsInWindow = 0;

	private readonly pending: VetoedRow[] = [];

	readonly path: string;
	readonly maxBytes: number;
	readonly evictDeadlineMs: number;

	constructor(
		db: SQLiteDatabase,
		path: string,
		options: EmbedCacheOpenOptions = {},
	) {
		this.db = db;
		this.path = path;
		this.maxBytes = options.maxBytes ?? DEFAULT_MAX_CACHE_BYTES;
		this.evictDeadlineMs = options.evictDeadlineMs ?? EVICT_DEADLINE_MS;
		this.stmts = {
			selEntry: db.prepare(
				"SELECT dim, fingerprint, bytes, vector FROM embeddings WHERE key = ? AND provider = ?",
			),
			insEntry: db.prepare(
				"INSERT OR REPLACE INTO embeddings (key, provider, model, dim, fingerprint, vector, bytes, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			),
			touch: db.prepare(
				"UPDATE embeddings SET last_used_at = ? WHERE key = ? AND provider = ? AND last_used_at < ?",
			),
			selDims: db.prepare(
				"SELECT dim FROM model_dims WHERE model = ? AND provider = ?",
			),
			upsertDims: db.prepare(
				"INSERT OR REPLACE INTO model_dims (model, provider, dim, learned_at) VALUES (?, ?, ?, ?)",
			),
			// The full vetoed identity, not the primary key — see `VetoedRow`.
			delVetoed: db.prepare(
				"DELETE FROM embeddings WHERE key = ? AND provider = ? AND dim = ? AND fingerprint = ? AND bytes = ?",
			),
			selLru: db.prepare(
				"SELECT rowid AS rid, bytes FROM embeddings ORDER BY last_used_at ASC LIMIT ?",
			),
			delRowid: db.prepare("DELETE FROM embeddings WHERE rowid = ?"),
		};
	}

	// ── The clamp (CLAUDE.md #27's shape: pre-flight, never post-hoc) ────────

	/**
	 * Set `busy_timeout` so that the WHOLE region — not one statement — is
	 * bounded. See THE ARITHMETIC above for why the division is the load-bearing
	 * part and why revision 2's once-per-region clamp was not a bound at all.
	 *
	 * This is the ONE place in this module where a value is rendered into SQL
	 * text (CLAUDE.md #22): `PRAGMA` cannot bind a parameter. The value is
	 * `Math.floor` of arithmetic over module constants — never anything a caller
	 * supplies — and the assertion below proves it is a non-negative integer
	 * before it is rendered.
	 */
	private applyClamp(region: SyncRegion): void {
		const remaining = Math.max(0, CONTENTION_BUDGET_MS - this.contentionUsedMs);
		const regionAllowanceMs = Math.min(BUSY_TIMEOUT_MS, remaining);
		const perStatementMs = Math.floor(
			regionAllowanceMs / region.blockingStatements,
		);
		if (perStatementMs === this.appliedBusyTimeoutMs) return;
		if (!Number.isInteger(perStatementMs) || perStatementMs < 0) {
			throw new Error(
				`embed-cache: refusing to render a non-integer busy_timeout (${perStatementMs})`,
			);
		}
		this.db.exec(`PRAGMA busy_timeout = ${perStatementMs}`);
		this.appliedBusyTimeoutMs = perStatementMs;
	}

	/**
	 * Charge a region's contention to the per-process budget.
	 *
	 * Contention that ends in success is not directly observable — SQLite does
	 * not report how long a statement waited — so this charges the region's
	 * elapsed time IN EXCESS of `MAX_SYNC_REGION_MS`, which is by definition the
	 * time that is not accounted work, plus the full clamped allowance whenever a
	 * statement actually returned `SQLITE_BUSY`. That over-estimates, and
	 * over-estimating can only make the cache degrade EARLIER, never later. The
	 * heartbeat bound does not rest on this number (it rests on the clamp); the
	 * budget only decides when to stop waiting altogether.
	 */
	private chargeRegion(
		region: SyncRegion,
		elapsedMs: number,
		hitBusy: boolean,
	): void {
		let charge = Math.max(0, elapsedMs - MAX_SYNC_REGION_MS);
		if (hitBusy)
			charge += this.appliedBusyTimeoutMs * region.blockingStatements;
		this.contentionUsedMs += charge;
	}

	/** Latch the persistent tier off for the rest of the process. */
	private degrade(reason: string): void {
		if (this.tier === "sqlite") this.tier = "l0";
		this.degraded ??= reason;
	}

	private isBusy(err: unknown): boolean {
		const message = err instanceof Error ? err.message : String(err);
		return (
			message.includes("SQLITE_BUSY") || message.includes("database is locked")
		);
	}

	/**
	 * Run one bounded synchronous region: clamp, time, charge, and degrade on any
	 * failure. Returns `fallback` when the persistent tier is off or the region
	 * threw — the cache is an optimisation, so the only thing a failure may ever
	 * cost is a recompute.
	 */
	private runRegion<T>(region: SyncRegion, fn: () => T, fallback: T): T {
		if (this.tier !== "sqlite" || this.closed) return fallback;
		let hitBusy = false;
		const started = Date.now();
		try {
			this.applyClamp(region);
			return fn();
		} catch (err) {
			hitBusy = this.isBusy(err);
			this.degrade(
				`${region.name}: ${err instanceof Error ? err.message : String(err)}`,
			);
			return fallback;
		} finally {
			const elapsed = Date.now() - started;
			if (region.name === "R1") {
				// R1's region is the caller's LOOKUP_CHUNK window, not one lookup.
				this.lookupWindowMs += elapsed;
				this.lookupsInWindow++;
				if (this.lookupsInWindow >= LOOKUP_CHUNK) {
					if (this.lookupWindowMs > this.maxSyncRegionMs) {
						this.maxSyncRegionMs = this.lookupWindowMs;
					}
					this.lookupWindowMs = 0;
					this.lookupsInWindow = 0;
				}
			} else if (elapsed > this.maxSyncRegionMs) {
				this.maxSyncRegionMs = elapsed;
			}
			this.chargeRegion(region, elapsed, hitBusy);
		}
	}

	// ── Reads ────────────────────────────────────────────────────────────────

	/**
	 * One point lookup on the primary key, with the three vetoes applied.
	 *
	 * Does NOT write: `last_used_at` is refreshed by `putMany`'s touch pass, so
	 * no read ever upgrades to a write and a deferred transaction never has to
	 * upgrade a read snapshot.
	 *
	 * A vetoed row is a MISS and is COLLECTED for a deferred, chunked delete
	 * (`pendingEvictions()` → `evictKeys()`), never deleted inside the lookup
	 * loop — that would interleave a write transaction into region R1.
	 */
	get(
		key: string,
		provider: string,
		dimension: number,
		fingerprint: string,
	): number[] | undefined {
		// `bun:sqlite` returns `null` for "no row", `better-sqlite3` returns
		// `undefined`. Both are "miss"; neither may be trusted to be the other.
		const row = this.runRegion<EntryRow | undefined | null>(
			REGION_LOOKUP,
			() =>
				this.stmts.selEntry.get(key, provider) as EntryRow | undefined | null,
			undefined,
		);
		if (row === undefined || row === null) {
			this.misses++;
			return undefined;
		}

		const blob = row.vector;
		// CLAUDE.md #15: compare against 0 explicitly. `0` is falsy and is the one
		// value worth catching; `if (blob.byteLength)` would let it through.
		if (blob === undefined || blob.byteLength === 0) {
			this.refusedZeroLength++;
			this.veto(key, provider, row);
			this.misses++;
			return undefined;
		}
		if (
			row.dim !== dimension ||
			row.bytes !== dimension * 4 ||
			blob.byteLength !== dimension * 4
		) {
			this.refusedDimension++;
			this.veto(key, provider, row);
			this.misses++;
			return undefined;
		}
		if (row.fingerprint !== fingerprint) {
			this.refusedFingerprint++;
			this.veto(key, provider, row);
			this.misses++;
			return undefined;
		}

		const vector = decodeVectorF32(blob);
		// Belt and braces: a decode that produced nothing is never served.
		if (vector.length === 0) {
			this.refusedZeroLength++;
			this.veto(key, provider, row);
			this.misses++;
			return undefined;
		}
		this.hits++;
		return vector;
	}

	private veto(key: string, provider: string, row: EntryRow): void {
		this.pending.push({
			key,
			provider,
			dim: row.dim,
			fingerprint: row.fingerprint,
			bytes: row.bytes,
		});
	}

	pendingEvictions(): VetoedRow[] {
		return this.pending.splice(0, this.pending.length);
	}

	/**
	 * The dimension this model produced last time, WITHOUT a network call — this
	 * is what makes a warm run cost zero embedding calls.
	 *
	 * A stored `0` is not a dimension. It cannot be written by
	 * `recordDimension`, and if one is ever found it is reported as unknown
	 * rather than used to build keys (CLAUDE.md #15).
	 */
	knownDimension(model: string, provider: string): number | undefined {
		const row = this.runRegion<{ dim: number } | undefined | null>(
			REGION_LOOKUP,
			() =>
				this.stmts.selDims.get(model, provider) as
					| { dim: number }
					| undefined
					| null,
			undefined,
		);
		if (row === undefined || row === null) return undefined;
		if (typeof row.dim !== "number" || row.dim === 0) return undefined;
		return row.dim;
	}

	// ── Writes ───────────────────────────────────────────────────────────────

	/**
	 * ONE bounded transaction that executes WRITE STATEMENTS ONLY — no `SELECT`
	 * ever runs inside it.
	 *
	 * Both drivers open a DEFERRED transaction (a bare `BEGIN` at `sqlite.ts:64`
	 * for bun; `better-sqlite3`'s default `transaction()` at `:99`), and a
	 * deferred transaction that reads first and writes second returns
	 * `SQLITE_BUSY_SNAPSHOT` on conflict — the one BUSY kind that does NOT invoke
	 * the busy handler, so the clamp would not bound it. Writing first makes the
	 * transaction take its write lock at its first statement, where
	 * `busy_timeout` does apply.
	 *
	 * Chunked BY THE CALLER at `WRITE_CHUNK`; this method does not loop over
	 * regions and does not yield.
	 *
	 * Statement order is fixed: INSERT OR REPLACE → touch UPDATE (whose
	 * `TOUCH_RESOLUTION_MS` threshold is in the WHERE clause, never a prior read)
	 * → `model_dims` UPSERT.
	 */
	putMany(
		entries: readonly EmbedCacheEntry[],
		touched: readonly TouchKey[],
		dims?: ModelDims,
	): void {
		if (this.tier !== "sqlite" || this.closed) return;

		// Vetoes are applied BEFORE the transaction so a refusal costs no lock.
		const now = Date.now();
		const rows: Array<
			[
				string,
				string,
				string,
				number,
				string,
				Uint8Array,
				number,
				number,
				number,
			]
		> = [];
		for (const e of entries) {
			// CLAUDE.md #15, write side: a zero-length vector is never stored.
			if (e.vector.length === 0) {
				this.refusedZeroLength++;
				continue;
			}
			if (e.dimension === 0 || e.vector.length !== e.dimension) {
				this.refusedDimension++;
				continue;
			}
			const blob = encodeVectorF32(e.vector);
			if (blob.byteLength === 0) {
				this.refusedZeroLength++;
				continue;
			}
			rows.push([
				e.key,
				e.provider,
				e.model,
				e.dimension,
				e.fingerprint,
				toBlobParam(blob),
				blob.byteLength,
				now,
				now,
			]);
		}

		const dimsUsable =
			dims !== undefined && dims.dimension !== 0 && dims.dimension > 0;
		if (rows.length === 0 && touched.length === 0 && !dimsUsable) return;

		const touchFloor = now - TOUCH_RESOLUTION_MS;
		const written = this.runRegion(
			REGION_WRITE,
			() =>
				this.db.transaction(() => {
					for (const r of rows) this.stmts.insEntry.run(...r);
					for (const t of touched) {
						this.stmts.touch.run(now, t.key, t.provider, touchFloor);
					}
					if (dimsUsable && dims !== undefined) {
						this.stmts.upsertDims.run(
							dims.model,
							dims.provider,
							dims.dimension,
							now,
						);
					}
					return rows.length;
				}),
			0,
		);
		this.writes += written;
	}

	/**
	 * §4.2's WRITER RULE: called ONLY with a length taken from a response vector
	 * this process actually received. There is no other writer of `model_dims`,
	 * anywhere, ever — and a `0` is refused here as well as at the caller, since
	 * a poisoned row in a machine-global file is never invalidated (FR-5).
	 */
	recordDimension(model: string, provider: string, dimension: number): void {
		if (dimension === 0 || !Number.isInteger(dimension) || dimension < 0) {
			this.refusedDimension++;
			return;
		}
		this.runRegion(
			REGION_WRITE,
			() =>
				this.db.transaction(() => {
					this.stmts.upsertDims.run(model, provider, dimension, Date.now());
				}),
			undefined,
		);
	}

	/**
	 * Delete rows that failed a veto, in one bounded transaction. Chunked by the
	 * caller at `EVICT_CHUNK`.
	 *
	 * Deletes on the FULL vetoed identity, so a row rewritten in the same batch
	 * survives — see `VetoedRow`.
	 */
	evictKeys(rows: readonly VetoedRow[]): void {
		if (rows.length === 0) return;
		this.runRegion(
			REGION_EVICT,
			() =>
				this.db.transaction(() => {
					for (const r of rows) {
						this.stmts.delVetoed.run(
							r.key,
							r.provider,
							r.dim,
							r.fingerprint,
							r.bytes,
						);
					}
				}),
			undefined,
		);
	}

	/** For the proxy's Rule R telemetry. */
	noteDimensionCorrection(): void {
		this.dimensionCorrections++;
	}

	// ── LRU (§8.1) ───────────────────────────────────────────────────────────

	private fileBytes(): number {
		return this.runRegion(
			REGION_VACUUM,
			() => {
				const pc = this.db.prepare("PRAGMA page_count").get() as {
					page_count: number;
				};
				const ps = this.db.prepare("PRAGMA page_size").get() as {
					page_size: number;
				};
				return (pc?.page_count ?? 0) * (ps?.page_size ?? 0);
			},
			0,
		);
	}

	private freelistPages(): number {
		return this.runRegion(
			REGION_VACUUM,
			() => {
				const row = this.db.prepare("PRAGMA freelist_count").get() as {
					freelist_count: number;
				};
				return row?.freelist_count ?? 0;
			},
			0,
		);
	}

	/**
	 * LRU sweep to `EVICT_TARGET_RATIO` of the cap. Runs INSIDE both index locks
	 * (§6.2 rule 5), which is what keeps every cache write serialised by the
	 * machine-global lock; each region is bounded and yields, and the whole sweep
	 * is additionally capped by `EVICT_DEADLINE_MS` so one pathological run
	 * cannot hold the lock while it frees a gigabyte. Eviction is idempotent and
	 * incremental, so stopping early costs nothing but a larger file until the
	 * next run.
	 */
	async enforceBudget(): Promise<EmbedCacheEvictionReport> {
		const before = this.fileBytes();
		const report: EmbedCacheEvictionReport = {
			fileBytesBefore: before,
			fileBytesAfter: before,
			rowsEvicted: 0,
			bytesFreed: 0,
			vacuumCalls: 0,
			stoppedAtDeadline: false,
			skipped: null,
		};
		if (this.tier !== "sqlite" || this.closed) {
			report.skipped = this.degraded ?? "tier is not sqlite";
			return report;
		}
		if (before <= this.maxBytes) {
			report.skipped = "under cap";
			return report;
		}

		const target = Math.floor(this.maxBytes * EVICT_TARGET_RATIO);
		const deadline = Date.now() + this.evictDeadlineMs;

		// The loop's termination condition is the FILE SIZE, re-read each pass —
		// not a running total of the `bytes` column. Those are different units:
		// `bytes` is payload, while the cap governs `page_count * page_size`,
		// which also carries the primary-key b-tree, the LRU index and page
		// slack. Deciding on payload over-evicts by exactly that overhead, and
		// at small sizes it empties the cache: measured, 2 000 rows of 256 B in a
		// ~1 MB file against a 512 KiB cap deleted ALL 2 000 rows to "free" a
		// number it could never reach. Vacuuming inside the loop is what makes
		// `page_count` track the deletes, so the real condition is observable.
		let fileBytes = before;
		while (fileBytes > target) {
			if (Date.now() > deadline) {
				report.stoppedAtDeadline = true;
				break;
			}
			// REGION R3. The SELECT runs OUTSIDE the transaction, so no write
			// transaction ever begins with a read.
			const batch = this.runRegion<LruRow[]>(
				REGION_EVICT,
				() => this.stmts.selLru.all(EVICT_CHUNK) as LruRow[],
				[],
			);
			if (batch.length === 0) break;
			const freed = this.runRegion(
				REGION_EVICT,
				() =>
					this.db.transaction(() => {
						let bytes = 0;
						for (const r of batch) {
							this.stmts.delRowid.run(r.rid);
							bytes += r.bytes ?? 0;
						}
						return bytes;
					}),
				0,
			);
			if (this.tier !== "sqlite") break;
			report.rowsEvicted += batch.length;
			report.bytesFreed += freed;
			await yieldToEventLoop();

			// REGION R4, interleaved: return the freed pages to the file so the
			// loop condition above sees them.
			const vacuumed = this.runRegion(
				REGION_VACUUM,
				() => {
					this.db.exec(`PRAGMA incremental_vacuum(${VACUUM_PAGES})`);
					return true;
				},
				false,
			);
			if (!vacuumed) break;
			report.vacuumCalls++;
			await yieldToEventLoop();
			fileBytes = this.fileBytes();
		}

		let freePages = this.freelistPages();
		while (freePages > 0) {
			if (Date.now() > deadline) {
				report.stoppedAtDeadline = true;
				break;
			}
			// REGION R4. An EXPLICIT page count, never the bare form — the bare
			// form vacuums every free page of a 2 GiB file in one blocking call.
			const ok = this.runRegion(
				REGION_VACUUM,
				() => {
					this.db.exec(`PRAGMA incremental_vacuum(${VACUUM_PAGES})`);
					return true;
				},
				false,
			);
			if (!ok) break;
			report.vacuumCalls++;
			const remaining = this.freelistPages();
			// A vacuum that freed NOTHING will never free anything: on a database
			// whose header says `auto_vacuum = NONE`, `incremental_vacuum` is a
			// silent no-op and this loop would otherwise spin to the deadline on
			// every single run. Stop instead of burning the budget.
			if (remaining >= freePages) break;
			freePages = remaining;
			await yieldToEventLoop();
		}

		report.fileBytesAfter = this.fileBytes();
		return report;
	}

	// ── Lifecycle and telemetry ──────────────────────────────────────────────

	stats(): EmbedCacheStats {
		return {
			hits: this.hits,
			misses: this.misses,
			writes: this.writes,
			refusedZeroLength: this.refusedZeroLength,
			refusedDimension: this.refusedDimension,
			refusedFingerprint: this.refusedFingerprint,
			dimensionCorrections: this.dimensionCorrections,
			tier: this.tier,
			degraded: this.degraded,
			maxSyncRegionMs: this.maxSyncRegionMs,
			contentionUsedMs: this.contentionUsedMs,
		};
	}

	isClosed(): boolean {
		return this.closed;
	}

	/**
	 * L4: the handle is releasable. The indexer does not call it — `mnemex doctor`
	 * and tests do, and any caller that deletes or replaces the file in-process
	 * must, or the instance memo hands out a handle to a file that is gone.
	 */
	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.tier = "none";
		try {
			this.db.close();
		} catch {
			// A close that fails leaves nothing worth reporting: the handle is gone
			// from the memo either way.
		}
		for (const [key, cache] of openCaches) {
			if (cache === this) openCaches.delete(key);
		}
	}
}

// ════════════════════════════════════════════════════════════════════════════
// Two-level memoisation (CLAUDE.md #21) and the open sequence
// ════════════════════════════════════════════════════════════════════════════

/**
 * LEVEL 1 — the INSTANCE memo. Its key is resolvable BEFORE anything is opened,
 * which is the whole point: the level-2 key requires running a PRAGMA on an
 * ALREADY-OPEN database, i.e. exactly the cost this level exists to avoid.
 *
 * CLAUDE.md #21: do not ask whether a guard is correct, ask how often the
 * enclosing object is constructed. An `EmbedCache` is created per index run and
 * an MCP server can index repeatedly in one process, so a per-instance flag
 * would guard nothing.
 */
const openCaches = new Map<string, EmbedCache>();

/**
 * LEVEL 2 — the DDL memo, keyed exactly as `tracker.ts:341-364` keys its own:
 * `PRAGMA database_list` reports main's CANONICAL path, and reports `""` for
 * in-memory and anonymous databases — which are distinct private databases that
 * each genuinely need their own schema and must NEVER be memoised or shared.
 * The inode is folded in so a file deleted and recreated at one path counts as a
 * different database.
 */
const initializedSchemas = new Set<string>();

/** Paths already reported as unusable, so the warning is printed once. */
const warnedPaths = new Set<string>();

function schemaMemoKey(db: SQLiteDatabase): string | null {
	let file: string;
	try {
		const rows = db.prepare("PRAGMA database_list").all() as Array<{
			name?: string;
			file?: string;
		}>;
		const main = rows.find((row) => row.name === "main") ?? rows[0];
		if (typeof main?.file !== "string" || main.file.length === 0) return null;
		file = main.file;
	} catch {
		return null;
	}
	try {
		return `${file}:${statSync(file).ino}`;
	} catch {
		return file;
	}
}

/**
 * Every spelling of an in-memory or anonymous database. These are never
 * memoised at EITHER level: two `:memory:` opens are two different databases,
 * and collapsing them would hand the second one another connection's schema and
 * another connection's rows.
 */
export function isInMemoryPath(path: string): boolean {
	if (path === ":memory:" || path === "") return true;
	if (path.startsWith("file::memory:")) return true;
	return /[?&]mode=memory/.test(path);
}

/** Stable level-1 key: collapses symlinked and relative spellings of one file. */
function instanceMemoKey(path: string): string {
	try {
		return realpathSync.native(path);
	} catch {
		// The file does not exist yet — resolve() still collapses `..` and `./`,
		// and the entry is replaced by the realpath spelling on the next open.
		return resolve(path);
	}
}

/**
 * Open the cache, creating it if absent. Returns `null` when the cache cannot be
 * used — the caller DEGRADES, never throws, because the only thing a cache
 * failure may ever cost is a recompute.
 *
 * The whole sequence runs OUTSIDE both index locks (§6.2 rule 4, the pre-lock
 * hoist `index()` already performs for `docsConfigPreLock`), which is what makes
 * it unnecessary to budget: it is the one region here whose duration is not
 * constant-bounded, because the WAL pragma takes a brief exclusive lock and
 * steps 1-2 run before `busy_timeout` is set at all.
 *
 * Called from ONE place in production: `Indexer.index()`, before
 * `globalLock.acquire()`. Never from `initialize()`, never from a search path —
 * `Indexer.clear()` must not create and DDL a file it will never use.
 */
export function openEmbedCache(
	path?: string,
	options: EmbedCacheOpenOptions = {},
): EmbedCache | null {
	if (resolveEmbedCacheMode() === "off") return null;
	if (!IS_LITTLE_ENDIAN) {
		warnOnce(
			"big-endian",
			"embed cache disabled: the vector codec is little-endian float32",
		);
		return null;
	}

	const target = path ?? getEmbedCachePath();

	// THE ONE choke point. Every file this module can create is created below, so
	// refusing here refuses all of them.
	//
	// This THROWS, and it is the only throw in a function whose whole contract is
	// "return null and degrade". The distinction is deliberate: a degradation is
	// what an unusable cache costs (one recompute), while reaching the user's real
	// machine-global file from a test is a BUG IN THE TEST — silently redirecting
	// it, or silently disabling the cache, would leave that bug in place and make
	// the suite quietly stop testing the thing it thinks it tests. A refusal is
	// unreachable in production because `src/index.ts` opens the gate before any
	// command dispatch (pinned by `embed-cache-user-path-guard.test.ts`).
	const refusal = userEmbedCachePathRefusal(
		target,
		homedir(),
		userEmbedCachePathEnabled(),
	);
	if (refusal !== null) throw new Error(refusal);

	const inMemory = isInMemoryPath(target);
	const memoKey = inMemory ? null : instanceMemoKey(target);

	if (memoKey !== null) {
		const existing = openCaches.get(memoKey);
		if (existing !== undefined && !existing.isClosed()) return existing;
		if (existing !== undefined) openCaches.delete(memoKey);
	}

	let db: SQLiteDatabase | null = null;
	try {
		// 1. The directory, at the same mode as GLOBAL_CONFIG_DIR (config.ts:951).
		if (!inMemory) mkdirSync(dirname(target), { recursive: true, mode: 0o700 });

		// 2. Open.
		db = createDatabaseSync(target);

		// 3. The clamp's resting value — 250, NOT 2000. A long busy_timeout is
		//    exactly the unbounded wait the region bound exists to prevent.
		db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);

		// 4. INCREMENTAL auto-vacuum, BEFORE the journal-mode pragma and before
		//    any table exists.
		//
		//    THE ORDER IS LOAD-BEARING AND THE DESIGN HAD IT WRONG. `auto_vacuum`
		//    lives in the database header and can only be changed while the
		//    database is empty (or by a full `VACUUM`). Setting `journal_mode =
		//    WAL` first writes that header, after which this pragma is silently
		//    ignored — `PRAGMA auto_vacuum` still reads 0. Measured, both orders,
		//    5 000 rows deleted from a 5 039-page file:
		//
		//      WAL first: auto_vacuum=0, incremental_vacuum is a NO-OP, freelist
		//                 stays at 5 029 forever, page_count 5 039 -> 5 039, and
		//                 the vacuum loop spins until EVICT_DEADLINE_MS on EVERY
		//                 run (51+ calls, capped only by the deadline).
		//      this order: auto_vacuum=2, 3 calls drain the freelist,
		//                 page_count 5 039 -> 4.
		//
		//    Pinned by "a fresh cache has auto_vacuum = INCREMENTAL" and by the
		//    eviction test that asserts the file actually SHRANK.
		db.exec("PRAGMA auto_vacuum = INCREMENTAL");

		// 5. WAL, via prepare().get(): the pragma RETURNS A ROW and `exec` would
		//    discard it, which hides a refusal.
		if (!inMemory) db.prepare("PRAGMA journal_mode = WAL").get();

		// 6. A torn write costs a recompute, never correctness.
		db.exec("PRAGMA synchronous = NORMAL");

		// 7. DDL, at most once per database file+inode per process.
		const ddlKey = schemaMemoKey(db);
		if (ddlKey === null || !initializedSchemas.has(ddlKey)) {
			for (const statement of DDL) db.exec(statement);
			const meta = db.prepare(
				"INSERT OR IGNORE INTO meta (k, v) VALUES (?, ?)",
			);
			meta.run("schema_version", String(CACHE_SCHEMA_VERSION));
			meta.run("created_at", String(Date.now()));
			meta.run("vector_encoding", "f32le");
			meta.run(
				"max_bytes",
				String(options.maxBytes ?? DEFAULT_MAX_CACHE_BYTES),
			);
			if (ddlKey !== null) initializedSchemas.add(ddlKey);
		}

		const cache = new EmbedCache(db, target, options);
		if (memoKey !== null) {
			// Re-key on the realpath now that the file certainly exists, so a later
			// open by another spelling finds this instance.
			openCaches.set(instanceMemoKey(target), cache);
		}
		return cache;
	} catch (err) {
		try {
			db?.close();
		} catch {
			// Nothing to do: the handle is being abandoned either way.
		}
		warnOnce(
			target,
			`embed cache disabled for ${target}: ${err instanceof Error ? err.message : String(err)}\n` +
				`  A corrupt cache is never auto-deleted. If this persists: rm ${target}`,
		);
		return null;
	}
}

function warnOnce(key: string, message: string): void {
	if (warnedPaths.has(key)) return;
	warnedPaths.add(key);
	process.stderr.write(`[mnemex] ${message}\n`);
}

/**
 * Forget every memoised instance and DDL pass, closing the instances.
 *
 * For tests, and for any caller that deletes or replaces the database file
 * in-process — the path would otherwise still look both open and initialised.
 */
export function resetEmbedCacheForTests(): void {
	for (const cache of [...openCaches.values()]) cache.close();
	openCaches.clear();
	initializedSchemas.clear();
	warnedPaths.clear();
}

/** Test seam: how many instances the level-1 memo is holding. */
export function openEmbedCacheCountForTests(): number {
	return openCaches.size;
}
