/**
 * Store-level fixture for `VectorStore.search` (step 3, phase 5).
 *
 * Two jobs:
 *
 *   1. N-2 — the FROZEN PRE-SPLIT SNAPSHOT. `captureSearchSnapshot` runs a fixed
 *      set of queries over a fixed store and records, per query, EVERY call the
 *      search makes on the LanceDB table and its query builders (method, args)
 *      plus the results. The snapshot in
 *      `test/testdata/store-search-n2/snapshot.json` was written by this helper
 *      against the source BEFORE `search` was split into
 *      `buildSearchFilters` → `retrieveCandidates` → `applyOverlay` →
 *      `fuseAndHydrate`; the test compares today's run with it, deep-equal.
 *   2. Shared builders (ids, vectors, chunks, units, docs) for the merge,
 *      suppression and calibration tests.
 *
 * Store-level only: no `Indexer`, no HOME, no embed cache, no global lock —
 * every store lives in a `mkdtemp` directory the caller owns.
 */

import { createHash } from "node:crypto";
import {
	BRANCH_ID_SHARED,
	type BranchScope,
} from "../../src/core/branch-scope.js";
import type { OverlayCandidates } from "../../src/core/overlay/types.js";
import type { IVectorStore, SearchOptions } from "../../src/core/store.js";
import type {
	ChunkWithEmbedding,
	CodeUnitWithEmbedding,
	DocumentWithEmbedding,
	SearchResult,
} from "../../src/types.js";

export const DIM = 8;

/** 16 lowercase hex characters, deterministic per label. */
export function hexId(label: string): string {
	return createHash("sha256").update(label).digest("hex").slice(0, 16);
}

/** 64 lowercase hex characters (a code-chunk id's real width). */
export function hexId64(label: string): string {
	return createHash("sha256").update(label).digest("hex");
}

/** First component carries the similarity: `near` 1 is `vec(1)` itself. */
export function vec(near: number): number[] {
	const v = new Array(DIM).fill(0.01);
	v[0] = 1 / near;
	return v;
}

export interface ChunkSpec {
	path: string;
	label: string;
	near: number;
	content: string;
	startLine?: number;
	endLine?: number;
	name?: string;
	chunkType?: string;
	language?: string;
	/** Defaults to a hash of `content` (the twin key the calibration uses). */
	contentHash?: string;
}

export function chunk(spec: ChunkSpec): ChunkWithEmbedding {
	const start = spec.startLine ?? 1;
	const end = spec.endLine ?? 10;
	return {
		id: hexId64(`chunk:${spec.path}:${start}:${end}:${spec.content}`),
		contentHash: spec.contentHash ?? hexId64(`content:${spec.content}`),
		content: spec.content,
		filePath: spec.path,
		startLine: start,
		endLine: end,
		language: spec.language ?? "typescript",
		chunkType: (spec.chunkType ??
			"function") as ChunkWithEmbedding["chunkType"],
		name: spec.name,
		fileHash: hexId64(`file:${spec.path}:${spec.label}`),
		vector: vec(spec.near),
	};
}

export function unit(spec: ChunkSpec): CodeUnitWithEmbedding {
	const start = spec.startLine ?? 1;
	const end = spec.endLine ?? 10;
	return {
		id: hexId(`unit:${spec.path}:${start}:${end}:${spec.label}`),
		parentId: null,
		unitType: "function",
		filePath: spec.path,
		startLine: start,
		endLine: end,
		language: spec.language ?? "typescript",
		content: spec.content,
		name: spec.name ?? spec.label,
		fileHash: hexId64(`file:${spec.path}:${spec.label}`),
		depth: 1,
		vector: vec(spec.near),
	};
}

export function doc(
	fields: Omit<DocumentWithEmbedding, "createdAt"> & { createdAt?: string },
): DocumentWithEmbedding {
	return { createdAt: "2026-10-02T00:00:00.000Z", ...fields };
}

// ============================================================================
// Recording proxy — every call the search makes on the table
// ============================================================================

export interface RecordedCall {
	on: string;
	method: string;
	args: unknown[];
}

function describeArg(value: unknown): unknown {
	if (value === null || value === undefined) return value ?? null;
	if (typeof value !== "object") return value;
	if (Array.isArray(value)) return value.map(describeArg);
	const proto = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) {
		return `<${(value as object).constructor?.name ?? "object"}>`;
	}
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(value)) out[k] = describeArg(v);
	return out;
}

function recording<T extends object>(
	target: T,
	label: string,
	log: RecordedCall[],
): T {
	return new Proxy(target, {
		get(obj, prop) {
			const value = Reflect.get(obj, prop, obj);
			if (typeof value !== "function" || typeof prop === "symbol") {
				return value;
			}
			return (...args: unknown[]) => {
				log.push({ on: label, method: prop, args: args.map(describeArg) });
				const out = value.apply(obj, args);
				if (
					out !== null &&
					typeof out === "object" &&
					!(out instanceof Promise) &&
					typeof (out as { then?: unknown }).then !== "function"
				) {
					return recording(
						out as object,
						out.constructor?.name ?? "object",
						log,
					);
				}
				return out;
			};
		},
	});
}

/**
 * Replace the store's open table with a recording proxy. Returns the live
 * log; the caller clears it (`log.length = 0`) between queries.
 */
export async function recordTableCalls(
	store: IVectorStore,
): Promise<RecordedCall[]> {
	const internals = store as unknown as {
		ensureTableOpen(): Promise<object | null>;
		table: object | null;
	};
	const table = await internals.ensureTableOpen();
	if (table === null) throw new Error("recordTableCalls: no table");
	const log: RecordedCall[] = [];
	internals.table = recording(table, "table", log);
	return log;
}

// ============================================================================
// N-2 fixture
// ============================================================================

const B1 = 1;
const B2 = 2;

/** Rich enough to exercise every branch of today's `search`. */
export async function seedN2Store(store: IVectorStore): Promise<void> {
	const repo = (branchId: number) => ({ pathKind: "repo" as const, branchId });

	const a1 = chunk({
		path: "src/alpha.ts",
		label: "a1",
		near: 1.5,
		name: "parseConfig",
		content: "export\nfunction parseConfig() { return readFile(config); }",
	});
	const a2 = chunk({
		path: "src/alpha.ts",
		label: "a2",
		near: 1.6,
		startLine: 12,
		endLine: 14,
		chunkType: "module",
		content: "export\nfunction tiny() { parseConfig(); }",
	});
	const b1 = chunk({
		path: "src/beta_util.ts",
		label: "b1",
		near: 2,
		name: "ConfigLoader",
		chunkType: "class",
		startLine: 1,
		endLine: 20,
		content: "class ConfigLoader { load() { return parseConfig(); } }",
	});
	const g1 = chunk({
		path: "src/gamma.ts",
		label: "g1",
		near: 3,
		name: "widget",
		content: "function widget() { return unrelated; }",
	});
	const t1 = chunk({
		path: "src/alpha.test.ts",
		label: "t1",
		near: 1.4,
		name: "testParse",
		content: "test('parseConfig', () => { parseConfig(); });",
	});
	const q1 = chunk({
		path: "src/o'brien.ts",
		label: "q1",
		near: 2.5,
		name: "quote",
		content: "function quote() { return parseConfig(); }",
	});
	const p1 = chunk({
		path: "lib/tool.py",
		label: "p1",
		near: 1.8,
		name: "parse_config",
		language: "python",
		content: "def parse_config():\n    return parseConfig",
	});
	await store.addChunks([a1, a2, b1, g1, t1, q1, p1], repo(B1));

	const a1b = chunk({
		path: "src/alpha.ts",
		label: "a1b",
		near: 1.2,
		name: "parseConfig",
		content:
			"export\nfunction parseConfig() { return readFileOnBranchTwo(config); }",
	});
	const d1 = chunk({
		path: "src/delta.ts",
		label: "d1",
		near: 4,
		name: "delta",
		content: "function delta() { parseConfig(); }",
	});
	await store.addChunks([a1b, d1], repo(B2));

	// Unit twins: one named twin of a1 (different text), one named twin of
	// the nameless gap chunk a2 (R2-A identity carry-over).
	await store.addCodeUnits(
		[
			unit({
				path: "src/alpha.ts",
				label: "u-a1",
				near: 1.55,
				name: "parseConfig",
				content: "function parseConfig() { return readFile(config); }",
			}),
			unit({
				path: "src/alpha.ts",
				label: "u-a2",
				near: 1.65,
				startLine: 12,
				endLine: 14,
				name: "tiny",
				content: "function tiny() { parseConfig(); }",
			}),
		],
		repo(B1),
	);

	await store.addDocuments(
		[
			doc({
				id: hexId("sym-sum-a1"),
				content: "summary: parseConfig reads the config file",
				documentType: "symbol_summary",
				filePath: "src/alpha.ts",
				sourceIds: [a1.id],
				vector: vec(1.9),
			}),
			doc({
				id: hexId("file-sum-alpha"),
				content: "file summary: alpha holds config parsing",
				documentType: "file_summary",
				filePath: "src/alpha.ts",
				sourceIds: [a1.id, a2.id],
				vector: vec(2.2),
			}),
		],
		repo(B1),
	);

	await store.addDocuments(
		[
			doc({
				id: hexId("observation-alpha"),
				content: "observation: parseConfig breaks on an empty file",
				documentType: "session_observation",
				filePath: "src/alpha.ts",
				fileHash: "",
				sourceIds: [],
				metadata: {
					observationType: "gotcha",
					affectedFiles: ["src/alpha.ts"],
				},
				vector: vec(1.7),
			}),
		],
		{ pathKind: "synthetic", branchId: BRANCH_ID_SHARED },
	);
}

export interface N2Query {
	name: string;
	query: string;
	vector: number[] | undefined;
	scope: BranchScope;
	options: SearchOptions;
}

/** `root` is the store's `pathRoot`, for the absolute-path argument case. */
export function n2Queries(root: string): N2Query[] {
	const b1: BranchScope = { kind: "branch", branchId: B1 };
	const b2: BranchScope = { kind: "branch", branchId: B2 };
	const all: BranchScope = { kind: "all" };
	return [
		{
			name: "branch1-limit5",
			query: "parseConfig",
			vector: vec(1),
			scope: b1,
			options: { limit: 5 },
		},
		{
			name: "all-limit5",
			query: "parseConfig",
			vector: vec(1),
			scope: all,
			options: { limit: 5 },
		},
		{
			name: "language",
			query: "parseConfig",
			vector: vec(1),
			scope: b1,
			options: { limit: 3, language: "typescript" },
		},
		{
			name: "pathPattern-underscore",
			query: "config",
			vector: vec(2),
			scope: b1,
			options: { pathPattern: "beta_util" },
		},
		{
			name: "no-vector",
			query: "parseConfig",
			vector: undefined,
			scope: b1,
			options: { limit: 5 },
		},
		{
			name: "keyword-only",
			query: "parseConfig",
			vector: vec(1),
			scope: b1,
			options: { keywordOnly: true },
		},
		{
			name: "branch2-fim",
			query: "parseConfig",
			vector: vec(1),
			scope: b2,
			options: { useCase: "fim", limit: 4 },
		},
		{
			name: "quote-filePath",
			query: "quote",
			vector: vec(2.5),
			scope: all,
			options: { filePath: "o'brien" },
		},
		{
			name: "navigation-limit10",
			query: "parseConfig",
			vector: vec(1),
			scope: b1,
			options: { useCase: "navigation", limit: 10 },
		},
		{
			name: "no-match",
			query: "nothingmatcheszzz",
			vector: vec(3),
			scope: b1,
			options: { limit: 2 },
		},
		{
			name: "absolute-filePath",
			query: "parseConfig",
			vector: vec(1),
			scope: b1,
			options: { filePath: `${root}/src/alpha.ts` },
		},
		{
			name: "limit1",
			query: "parseConfig",
			vector: vec(1),
			scope: b1,
			options: { limit: 1 },
		},
	];
}

export interface N2Entry {
	name: string;
	statements: RecordedCall[];
	results: SearchResult[];
}

/** Absolute paths under `root` rendered as `<root>`, so the snapshot is portable. */
export function normaliseRoot<T>(value: T, root: string): T {
	return JSON.parse(JSON.stringify(value).split(root).join("<root>")) as T;
}

/**
 * Run every N-2 query with the table recorded. `search` is called with
 * exactly four arguments, as every caller did before phase 5.
 */
export async function captureSearchSnapshot(
	store: IVectorStore,
	root: string,
): Promise<N2Entry[]> {
	const log = await recordTableCalls(store);
	const out: N2Entry[] = [];
	for (const q of n2Queries(root)) {
		log.length = 0;
		const results = await store.search(q.query, q.vector, q.scope, q.options);
		out.push(
			normaliseRoot({ name: q.name, statements: [...log], results }, root),
		);
	}
	return out;
}

// ============================================================================
// Overlay candidates, built the way `prepareDirtyOverlay`'s read step does
// ============================================================================

export interface ServedFile {
	/** Stored spelling. */
	path: string;
	chunks: ChunkWithEmbedding[];
}

/**
 * Write `served` into a real overlay-role store and materialise the
 * `OverlayCandidates` exactly as `dirty-overlay.ts`'s `read()` does:
 * `chunksByPathHash` from the built chunks, `vector` from
 * `vectorCandidates(queryVector, servedIds, search)`, `rowsById` from
 * `rowsByIds(servedIds)`, `suppressed = served ∪ deleted`.
 */
export async function overlayCandidatesFrom(input: {
	overlayStore: IVectorStore;
	queryVector: number[];
	served: ServedFile[];
	deleted?: string[];
	search?: Pick<
		SearchOptions,
		"limit" | "language" | "filePath" | "pathPattern"
	>;
}): Promise<OverlayCandidates> {
	const { overlayStore, queryVector, served } = input;
	const all = served.flatMap((f) => f.chunks);
	if (all.length > 0) {
		await overlayStore.addChunks(all, { pathKind: "repo", branchId: 0 });
	}
	const chunksByPathHash = new Map<
		string,
		{ id: string; startLine: number; endLine: number }[]
	>();
	const servedIds: string[] = [];
	for (const file of served) {
		for (const c of file.chunks) {
			servedIds.push(c.id);
			const key = `${file.path}\0${c.contentHash}`;
			const list = chunksByPathHash.get(key) ?? [];
			list.push({ id: c.id, startLine: c.startLine, endLine: c.endLine });
			list.sort((a, b) => a.startLine - b.startLine);
			chunksByPathHash.set(key, list);
		}
	}
	const vector = await overlayStore.vectorCandidates(
		queryVector,
		servedIds,
		input.search ?? {},
	);
	const rows = await overlayStore.rowsByIds(servedIds);
	const suppressed = new Set<string>([
		...served.map((f) => f.path),
		...(input.deleted ?? []),
	]);
	return {
		suppressedPaths: [...suppressed].sort(),
		servedPaths: served.map((f) => f.path).sort(),
		vector,
		chunksByPathHash,
		rowsById: new Map(rows.map((r) => [r.id, r])),
	};
}

/** An `OverlayCandidates` that holds nothing: clean / all-index-current. */
export function emptyOverlayCandidates(): OverlayCandidates {
	return {
		suppressedPaths: [],
		servedPaths: [],
		vector: [],
		chunksByPathHash: new Map(),
		rowsById: new Map(),
	};
}
