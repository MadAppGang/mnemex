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
 * and later writes carry it forward without looking at it. Phase 3b adds
 * `confirmRunCounter`, `sweep` and `widen`, and `journalMode` and
 * `storeRebuildAt` arrive with the code that reads them. A reader treats an
 * absent field as its default, so adding them is not a format change and
 * `formatVersion` stays 1.
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
