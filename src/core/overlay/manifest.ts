/**
 * The dirty overlay's manifest (step 3, R3.4): what the overlay table holds,
 * per file, and the bookkeeping that lets each search pass be incremental.
 *
 *   { format: 1, indexVersion, pathRoot,
 *     embedding: { model, provider, dimension, fingerprint },
 *     trackerHighWater: { branchId, indexedAt, path } | null,
 *     watch: [<stored path>…],
 *     hashMemo: { <path>: { mtimeMs, ctimeMs, size, ino, hash } },
 *     files: { <stored path>: { built: { contentHash, chunks: [{ id, contentHash, startLine, endLine }] } } } }
 *
 * `built.contentHash` is the hash of the exact bytes that were chunked and
 * embedded. An entry is set only after its table delete AND add both resolved,
 * and removed when either failed, because the table may then hold either
 * revision. A crash anywhere leaves either an older manifest (its hash no
 * longer equals disk → rebuild) or rows the manifest does not name (never
 * read); the id proof in `dirty-overlay.ts` catches the remaining case.
 *
 * Read WITHOUT the lock (a snapshot, for candidate selection) and re-read
 * UNDER it before anything is decided from it. Writes go through
 * `writeFileAtomicallySync` (rename-atomic: a reader sees a whole file) and
 * happen only while the overlay lock is held — atomic replacement does not
 * serialise read-modify-write, the lock does (`atomic-file.ts`).
 *
 * Anything that does not validate is `corrupt`, and the caller wipes. A
 * manifest is a cache of what the table holds; losing it costs a rebuild,
 * never correctness.
 */

import { existsSync, readFileSync, rmSync } from "node:fs";
import { writeFileAtomicallySync } from "../atomic-file.js";

export const OVERLAY_MANIFEST_FORMAT = 1;

/** The model, provider, width and text transform the overlay's vectors were built with. */
export interface OverlayEmbeddingIdentity {
	readonly model: string;
	readonly provider: string;
	readonly dimension: number;
	readonly fingerprint: string;
}

/**
 * OUR stat around OUR read (HIGH 3): reused only on an exact
 * `(mtimeMs, ctimeMs, size, ino)` match, recorded only when the stats before
 * and after the read agree and the mtime is older than the racy window.
 */
export interface HashMemoEntry {
	readonly mtimeMs: number;
	readonly ctimeMs: number;
	readonly size: number;
	readonly ino: number;
	readonly hash: string;
}

export interface BuiltChunk {
	readonly id: string;
	readonly contentHash: string;
	readonly startLine: number;
	readonly endLine: number;
}

export interface BuiltFile {
	readonly contentHash: string;
	readonly chunks: readonly BuiltChunk[];
}

export interface TrackerHighWater {
	readonly branchId: number;
	readonly indexedAt: string;
	readonly path: string;
}

export interface OverlayManifest {
	readonly format: typeof OVERLAY_MANIFEST_FORMAT;
	readonly indexVersion: number;
	readonly pathRoot: string;
	readonly embedding: OverlayEmbeddingIdentity | null;
	readonly trackerHighWater: TrackerHighWater | null;
	readonly watch: readonly string[];
	readonly hashMemo: Readonly<Record<string, HashMemoEntry>>;
	readonly files: Readonly<Record<string, { readonly built: BuiltFile }>>;
}

export type ManifestRead =
	| { readonly kind: "absent" }
	| { readonly kind: "ok"; readonly manifest: OverlayManifest }
	| { readonly kind: "corrupt"; readonly message: string };

export function emptyOverlayManifest(
	pathRoot: string,
	indexVersion: number,
): OverlayManifest {
	return {
		format: OVERLAY_MANIFEST_FORMAT,
		indexVersion,
		pathRoot,
		embedding: null,
		trackerHighWater: null,
		watch: [],
		hashMemo: {},
		files: {},
	};
}

// ── validation ──────────────────────────────────────────────────────────────

const isObject = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === "string";
const isInt = (v: unknown): v is number =>
	typeof v === "number" && Number.isSafeInteger(v);
const isFiniteNumber = (v: unknown): v is number =>
	typeof v === "number" && Number.isFinite(v);

function validIdentity(v: unknown): boolean {
	if (v === null) return true;
	return (
		isObject(v) &&
		isString(v.model) &&
		isString(v.provider) &&
		isInt(v.dimension) &&
		v.dimension > 1 &&
		isString(v.fingerprint)
	);
}

function validHighWater(v: unknown): boolean {
	if (v === null) return true;
	return (
		isObject(v) &&
		isInt(v.branchId) &&
		v.branchId >= 0 &&
		isString(v.indexedAt) &&
		isString(v.path)
	);
}

function validMemo(v: unknown): boolean {
	return (
		isObject(v) &&
		isFiniteNumber(v.mtimeMs) &&
		isFiniteNumber(v.ctimeMs) &&
		isInt(v.size) &&
		isFiniteNumber(v.ino) &&
		isString(v.hash)
	);
}

function validChunk(v: unknown): boolean {
	return (
		isObject(v) &&
		isString(v.id) &&
		isString(v.contentHash) &&
		isInt(v.startLine) &&
		isInt(v.endLine)
	);
}

function validEntry(v: unknown): boolean {
	if (!isObject(v) || !isObject(v.built)) return false;
	const built = v.built;
	return (
		isString(built.contentHash) &&
		Array.isArray(built.chunks) &&
		built.chunks.every(validChunk)
	);
}

/** Structural validation: every field, every entry. Anything else is corrupt. */
export function parseOverlayManifest(text: string): ManifestRead {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (err) {
		return {
			kind: "corrupt",
			message: `not JSON: ${err instanceof Error ? err.message : String(err)}`,
		};
	}
	const corrupt = (message: string): ManifestRead => ({
		kind: "corrupt",
		message,
	});
	if (!isObject(raw)) return corrupt("not an object");
	if (raw.format !== OVERLAY_MANIFEST_FORMAT) return corrupt("format");
	if (!isInt(raw.indexVersion)) return corrupt("indexVersion");
	if (!isString(raw.pathRoot)) return corrupt("pathRoot");
	if (!validIdentity(raw.embedding)) return corrupt("embedding");
	if (!validHighWater(raw.trackerHighWater)) return corrupt("trackerHighWater");
	if (!Array.isArray(raw.watch) || !raw.watch.every(isString)) {
		return corrupt("watch");
	}
	if (
		!isObject(raw.hashMemo) ||
		!Object.values(raw.hashMemo).every(validMemo)
	) {
		return corrupt("hashMemo");
	}
	if (!isObject(raw.files) || !Object.values(raw.files).every(validEntry)) {
		return corrupt("files");
	}
	return { kind: "ok", manifest: raw as unknown as OverlayManifest };
}

export function readOverlayManifest(path: string): ManifestRead {
	if (!existsSync(path)) return { kind: "absent" };
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (err) {
		// Vanished between the check and the read: the same as absent.
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			return { kind: "absent" };
		}
		return {
			kind: "corrupt",
			message: err instanceof Error ? err.message : String(err),
		};
	}
	return parseOverlayManifest(text);
}

/**
 * Canonical JSON: keys of every object sorted, so two manifests with the same
 * content serialise to the same bytes and "changed?" is a string compare.
 */
export function serializeOverlayManifest(manifest: OverlayManifest): string {
	return `${JSON.stringify(manifest, (_key, value) => {
		if (isObject(value)) {
			const sorted: Record<string, unknown> = {};
			for (const key of Object.keys(value).sort()) sorted[key] = value[key];
			return sorted;
		}
		return value;
	})}\n`;
}

/** Rename-atomic, durable. Callers hold the overlay lock. */
export function writeOverlayManifest(
	path: string,
	manifest: OverlayManifest,
): void {
	writeFileAtomicallySync(path, serializeOverlayManifest(manifest));
}

/**
 * Remove the overlay's DATA — the LanceDB directory and the manifest — and
 * nothing else. Never the overlay directory, never the lock file: the caller
 * holds that lock, and deleting it would let a second pass take the lock while
 * this one is still writing (HIGH 5).
 */
export function wipeOverlayData(
	vectorsDir: string,
	manifestPath: string,
): void {
	rmSync(vectorsDir, { recursive: true, force: true });
	rmSync(manifestPath, { force: true });
}
