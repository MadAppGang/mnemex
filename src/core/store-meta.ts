/**
 * `<storeDir>/store.json`: store-scoped state (architecture §3.6).
 *
 * WRITTEN only under the store lock, read-modify-write, one tmp+rename per run
 * (REG-1's discipline, applied to the second store-scoped file). READ anywhere.
 * Nothing in it is load-bearing after a crash, so unlike the branch registry it
 * needs no early flush.
 *
 * Fields this build writes: `formatVersion`, `indexVersion`, `gitCommonDir`,
 * `firstIndexedFrom`, `updatedAt`. `firstIndexedFrom` is DIAGNOSTIC ONLY and
 * no code may read it (§3.6, V1.5). The write that creates the file sets it,
 * and later writes carry it forward without looking at it.
 *
 * `confirmRunCounter` and `sweep` are Phase 3b-3's, written by
 * `writeStoreState` below; `journalMode` and `storeRebuildAt` arrive with the
 * code that reads them. A reader treats an absent field as its default, so
 * adding them is not a format change and `formatVersion` stays 1.
 *
 * `pathRoot` is deliberately NOT here (§3.6). A shared file can hold only one
 * worktree's root, so every consumer takes it from its own
 * `resolveStoreLocation`.
 */

import { existsSync, readFileSync } from "node:fs";
import { writeFileAtomicallySync } from "./atomic-file.js";
import { now } from "./clock.js";
import {
	getStoreMetaPathFor,
	type StoreLocation,
	storeFilesIn,
} from "./store-location.js";

export const STORE_META_FORMAT_VERSION = 1;

/** What `probeOldStore` found in a directory. */
export type OldStoreProbe =
	| {
			readonly exists: true;
			/** `null`, never 1, when the directory holds an index that records no version (V4.8). */
			readonly recordedVersion: number | null;
	  }
	| { readonly exists: false };

/**
 * The ONE sanctioned read of the legacy `config.json` `indexVersion` (§3.6,
 * N8). It takes a DIRECTORY, not a `StoreLocation`, because the store being
 * replaced may be one the seam no longer resolves to.
 *
 * "Exists" means a `store.json`, a `config.json` carrying an `indexVersion`, or
 * an `index.db`. A directory holding only a lock file or a `CACHEDIR.TAG` is
 * not an index. `recordedVersion` reads `store.json` first and falls back to
 * `config.json`. It is `null`, not 1, when neither records one, so "an index
 * that does not say what it is" is not reported as version 1. `getIndexVersion`
 * used to return that default, and that is how every fresh clone would have
 * reported `upgraded_from_index_version=1`.
 */
export function probeOldStore(dir: string): OldStoreProbe {
	const files = storeFilesIn(dir);
	const metaVersion = versionOf(readJsonRecord(files.storeMeta)?.indexVersion);
	const legacyVersion = versionOf(
		readJsonRecord(files.legacyConfig)?.indexVersion,
	);
	const exists =
		existsSync(files.storeMeta) ||
		legacyVersion !== null ||
		existsSync(files.indexDb);
	if (!exists) return { exists: false };
	return { exists: true, recordedVersion: metaVersion ?? legacyVersion };
}

/**
 * Record the index version this store was built with. Call only while holding
 * the store lock. Unknown fields are carried forward, so a field a later build
 * added is not erased by this one.
 */
export function writeStoreMeta(
	loc: StoreLocation,
	update: { readonly indexVersion: number },
): void {
	const path = getStoreMetaPathFor(loc);
	const existing = readJsonRecord(path);
	const next: Record<string, unknown> =
		existing === null
			? {
					formatVersion: STORE_META_FORMAT_VERSION,
					// The identity of the CLONE, shared by every worktree of it.
					gitCommonDir: loc.gitLayout?.gitCommonDir ?? null,
					// Which worktree created the store. Written here and never read.
					firstIndexedFrom: loc.pathRoot,
				}
			: { formatVersion: STORE_META_FORMAT_VERSION, ...existing };
	next.indexVersion = update.indexVersion;
	next.updatedAt = new Date(now()).toISOString();
	writeFileAtomicallySync(path, `${JSON.stringify(next, null, 2)}\n`);
}

/**
 * §4.5's marker: WHEN the whole store was last rebuilt. V1.7.
 *
 * ── IT IS THE EXPLANATION, NEVER THE SIGNAL (decision I-17 item 3) ───────────
 * The signal that a branch holds nothing is computed from ROWS
 * (`src/core/branch-state.ts`), and it stays the authority for three reasons
 * this marker cannot match: rows cannot lie; they are true of every way of
 * reaching the state, including an interrupted `--force` and a partly-drained
 * sweep, which no producer stamps; and a marker can be lost with a hand-edited
 * or deleted `store.json` while the rows cannot.
 *
 * What the marker adds is WHY. "This branch holds no rows" sends a user looking
 * for a bug; "the store was rebuilt from another worktree at 14:02, every
 * branch has to index itself again" sends them to `mnemex index`. Compared
 * against the branch's `lastIndexedAt` in `branches.json`: a rebuild NEWER than
 * the branch's last index means this branch's rows went with it.
 *
 * Stamped by every store-wide producer (§4.5's table): `--force-all`,
 * `mnemex clear --all`, the dimension-mismatch repair, the placeholder-vector
 * repair, `onModelMismatch: "force-model"`, and the v4/v5 migration rebuild.
 * NOT by a branch-scoped `--force` or `clear`, which is the whole distinction.
 *
 * Write it only while holding the store lock, like every other writer here.
 */
export function stampStoreRebuild(
	loc: StoreLocation,
	at: number = now(),
): void {
	const path = getStoreMetaPathFor(loc);
	const existing = readJsonRecord(path) ?? {
		formatVersion: STORE_META_FORMAT_VERSION,
		gitCommonDir: loc.gitLayout?.gitCommonDir ?? null,
		firstIndexedFrom: loc.pathRoot,
	};
	const next: Record<string, unknown> = {
		...existing,
		formatVersion: STORE_META_FORMAT_VERSION,
		storeRebuildAt: new Date(at).toISOString(),
		updatedAt: new Date(at).toISOString(),
	};
	writeFileAtomicallySync(path, `${JSON.stringify(next, null, 2)}\n`);
}

/**
 * When the store was last rebuilt whole, or `null` when it never was (or when
 * `store.json` is absent, unreadable or does not record it — all three read the
 * same, because an absent marker is not evidence of anything).
 *
 * Returns EPOCH MILLISECONDS so callers compare numbers, not ISO strings whose
 * ordering is only lexicographic by accident of format.
 */
export function readStoreRebuildAt(loc: StoreLocation): number | null {
	const raw = readJsonRecord(getStoreMetaPathFor(loc));
	const value = raw?.storeRebuildAt;
	if (typeof value !== "string") return null;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : null;
}

/**
 * The sweep's resumable cursor (§4.3). `null` when no branch is being swept.
 *
 * ITS PRESENCE IS ALSO A CLAIM: a cursor naming `branchId` means at least one
 * batch of that branch's membership has already been removed. Rule R reads it
 * to decide whether a resurrected branch needs its tree-scoped rows cleared, so
 * it is written only after work has actually happened — never speculatively at
 * the start of a branch.
 */
export interface SweepCursor {
	/** The tombstoned branch being reclaimed. */
	readonly branchId: number;
	/** The last `chunk_id` this branch's sweep removed; the next batch starts above it. */
	readonly lastChunkId: string;
	/** `chunk_branches` rows still carrying `branchId` when the run stopped. Diagnostic. */
	readonly remaining: number;
}

/** The store-scoped state this build reads and writes beside `indexVersion`. */
export interface StoreState {
	/**
	 * Index runs completed against this store. The confirmation pass fires when
	 * it reaches a multiple of `BRANCH_CONFIRM_INTERVAL` (§4.3).
	 */
	readonly confirmRunCounter: number;
	readonly sweep: SweepCursor | null;
}

const DEFAULT_STATE: StoreState = { confirmRunCounter: 0, sweep: null };

/**
 * `store.json`'s lifecycle fields, or their defaults.
 *
 * READ ANYWHERE (§3.6): the hoisted confirm scan needs the counter BEFORE the
 * store lock is taken, which is the whole reason it is in this file rather than
 * in the registry. Absent, unreadable and malformed all read as the default —
 * a counter that restarts costs at most one deferred confirmation pass, and a
 * cursor that is lost costs one re-driven sweep batch, which is idempotent.
 */
export function readStoreState(loc: StoreLocation): StoreState {
	const raw = readJsonRecord(getStoreMetaPathFor(loc));
	if (raw === null) return DEFAULT_STATE;
	const counter = raw.confirmRunCounter;
	return {
		confirmRunCounter:
			typeof counter === "number" &&
			Number.isSafeInteger(counter) &&
			counter >= 0
				? counter
				: 0,
		sweep: parseSweepCursor(raw.sweep),
	};
}

/**
 * Write the lifecycle fields back. Call ONLY while holding the store lock.
 *
 * Read-modify-write against the CURRENT bytes, not against whatever the caller
 * read at the start of its run: `writeStoreMeta` may have stamped
 * `indexVersion` in between, and a write built from a stale snapshot would take
 * it back out. Unknown fields are carried forward for the same reason.
 */
export function writeStoreState(loc: StoreLocation, state: StoreState): void {
	const path = getStoreMetaPathFor(loc);
	const existing = readJsonRecord(path) ?? {
		formatVersion: STORE_META_FORMAT_VERSION,
		gitCommonDir: loc.gitLayout?.gitCommonDir ?? null,
		firstIndexedFrom: loc.pathRoot,
	};
	const next: Record<string, unknown> = {
		...existing,
		formatVersion: STORE_META_FORMAT_VERSION,
		confirmRunCounter: state.confirmRunCounter,
		updatedAt: new Date(now()).toISOString(),
	};
	// An absent cursor is the ABSENCE of the key, not `null` in the file: a
	// reader defaults an absent field, and writing `null` would make "no sweep
	// in flight" and "this build does not know about sweeps" look different on
	// disk for no gain.
	if (state.sweep === null) delete next.sweep;
	else next.sweep = { ...state.sweep };
	writeFileAtomicallySync(path, `${JSON.stringify(next, null, 2)}\n`);
}

function parseSweepCursor(value: unknown): SweepCursor | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return null;
	}
	const raw = value as Record<string, unknown>;
	const branchId = raw.branchId;
	const lastChunkId = raw.lastChunkId;
	const remaining = raw.remaining;
	if (
		typeof branchId !== "number" ||
		!Number.isSafeInteger(branchId) ||
		branchId < 1 ||
		typeof lastChunkId !== "string"
	) {
		return null;
	}
	return {
		branchId,
		lastChunkId,
		remaining:
			typeof remaining === "number" && Number.isSafeInteger(remaining)
				? remaining
				: 0,
	};
}

/** A parsed JSON object, or null when the file is absent, unreadable or not an object. */
function readJsonRecord(path: string): Record<string, unknown> | null {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return null;
	}
	try {
		const value: unknown = JSON.parse(text);
		return typeof value === "object" && value !== null && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

function versionOf(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 1
		? value
		: null;
}
