/**
 * A dirty-overlay pass's whole world, in a temp directory, for the overlay
 * tests (step 3, phase 4):
 *
 *   - a REAL git repository (`git-sandbox.ts`), committed, which the tests
 *     then dirty the way a user does;
 *   - a REAL `FileTracker` holding "indexed" rows: `index(rel)` records the
 *     file's CURRENT bytes' hash under branch 1, as `Indexer.index()` would;
 *   - a counting stub embedder standing in for the raw query client — every
 *     text that reaches the "provider" is counted, so cache hits and rebuild
 *     scope are asserted as numbers;
 *   - the embed cache at a temp path (CLAUDE.md #31: never the user's file);
 *   - `HOME`/`XDG_CONFIG_HOME` pointed into the sandbox while the fixture is
 *     alive, because the overlay's own `git status` inherits this process's
 *     env (it strips `GIT_*`, so the sandbox's GIT_CONFIG_GLOBAL cannot reach it).
 *
 * Nothing here judges; the tests assert on the overlay table's rows, the
 * manifest's bytes and the counters.
 */

import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import { DEFAULT_EXCLUDE_PATTERNS } from "../../src/config.js";
import { chunkFileByPath } from "../../src/core/chunker.js";
import { resetEmbedCacheForTests } from "../../src/core/embed-cache.js";
import { createFileSelection } from "../../src/core/file-selection.js";
import type { DirtyOverlayContext } from "../../src/core/overlay/dirty-overlay.js";
import type { OverlayManifest } from "../../src/core/overlay/manifest.js";
import {
	__resetStoreLocationCacheForTests,
	getDirtyOverlayDirFor,
	getDirtyOverlayLockPathFor,
	getDirtyOverlayManifestPathFor,
	getDirtyOverlayVectorsPathFor,
	resolveStoreLocation,
	type StoreLocation,
} from "../../src/core/store-location.js";
import {
	createFileTracker,
	type IFileTracker,
} from "../../src/core/tracker.js";
import { getParserManager } from "../../src/parsers/parser-manager.js";
import type {
	EmbedCallOptions,
	EmbeddingProgressCallback,
	EmbeddingProvider,
	EmbedResult,
	IEmbeddingsClient,
} from "../../src/types.js";
import { createGitSandbox, type GitSandbox } from "./git-sandbox.js";

export const BRANCH = 1;
export const DIM = 8;

/** Deterministic, non-zero, different for different text. */
export function stubVector(text: string, dimension = DIM): number[] {
	const digest = createHash("sha256").update(text).digest();
	return Array.from(
		{ length: dimension },
		(_, i) => (digest[i] ?? 1) / 255 + 0.01,
	);
}

/** The raw query client, counted. */
export class StubEmbedder implements IEmbeddingsClient {
	/** Every batch the "provider" received. */
	readonly calls: string[][] = [];
	/** The call policy of EVERY embed() — answered or thrown — in order. */
	readonly policies: Array<EmbedCallOptions | undefined> = [];
	/** Throw on every embed() after this many have succeeded. */
	failAfter: number | null = null;
	/** The error `failAfter` throws (default: a non-fatal, unclassified one). */
	failWith: () => Error = () => new Error("stub provider: connection refused");
	/**
	 * Answer `[]` for each text this matches — the real clients' PARTIAL
	 * result shape: a non-fatal per-text failure is an empty slot, not a throw
	 * (`OllamaEmbeddingsClient.embed` pushes `[]` and goes on).
	 */
	emptyFor: ((text: string) => boolean) | null = null;
	/** Runs before each embed() — a seam for mid-pass injections. */
	beforeEmbed: ((texts: string[]) => void | Promise<void>) | null = null;

	constructor(
		readonly model = "stub-model",
		readonly provider: EmbeddingProvider = "openrouter",
		readonly dimension = DIM,
	) {}

	get texts(): number {
		return this.calls.reduce((n, c) => n + c.length, 0);
	}

	/** embed() calls made, answered or not. */
	get attempts(): number {
		return this.policies.length;
	}

	async embed(
		texts: string[],
		_onProgress?: EmbeddingProgressCallback,
		options?: EmbedCallOptions,
	): Promise<EmbedResult> {
		this.policies.push(options);
		if (this.beforeEmbed) await this.beforeEmbed(texts);
		if (this.failAfter !== null && this.calls.length >= this.failAfter) {
			throw this.failWith();
		}
		this.calls.push([...texts]);
		const empty = this.emptyFor;
		return {
			embeddings: texts.map((t) =>
				empty?.(t) === true ? [] : stubVector(t, this.dimension),
			),
		};
	}

	async embedOne(text: string): Promise<number[]> {
		return stubVector(text, this.dimension);
	}

	getModel(): string {
		return this.model;
	}
	getDimension(): number {
		return this.dimension;
	}
	getProvider(): EmbeddingProvider {
		return this.provider;
	}
	isLocal(): boolean {
		return false;
	}
}

/** A TypeScript file of `n` functions, each large enough to be its own chunk. */
export function tsSource(stem: string, n: number, variant = ""): string {
	const parts: string[] = [];
	for (let i = 0; i < n; i++) {
		parts.push(
			`/** ${stem} function ${i} ${variant} */\n` +
				`export function ${stem}_${i}(input: number, scale: number): number {\n` +
				`\tconst doubled = input * 2 + scale * ${i};\n` +
				`\tconst tripled = doubled * 3 - ${i + 1};\n` +
				`\tif (tripled > 1000) {\n\t\treturn tripled / scale + ${i};\n\t}\n` +
				`\treturn doubled + tripled + ${variant.length};\n}\n`,
		);
	}
	return parts.join("\n");
}

/** The sandbox HOME of the fixture that currently owns `process.env`, if any. */
let liveFixtureHome: string | null = null;

export interface OverlayFixture {
	readonly box: GitSandbox;
	readonly repo: string;
	readonly loc: StoreLocation;
	readonly tracker: IFileTracker;
	readonly embedCachePath: string;
	readonly stub: StubEmbedder;
	readonly overlayDir: string;
	readonly manifestPath: string;
	readonly vectorsDir: string;
	readonly lockPath: string;
	write(rel: string, text: string): void;
	read(rel: string): Buffer;
	remove(rel: string): void;
	commit(message?: string): void;
	/**
	 * Record `rel`'s CURRENT bytes as indexed. Stamps a row UNCONDITIONALLY,
	 * which is what `Indexer.index()` does only for a file that chunks to at
	 * least one chunk; every caller of this indexes such a file. For a file
	 * that may chunk to zero, use {@link indexAsIndexer}.
	 */
	index(rel: string, hashOverride?: string): void;
	/**
	 * `Indexer.index()`'s REAL stamping rule (code review 2, MEDIUM 2): chunk
	 * the bytes with the indexer's own `chunkFileByPath`, and record a tracker
	 * row only when that yields a chunk. Zero chunks (an empty `__init__.py`,
	 * `// TODO`) → `skippedFiles`, no `files` row (`indexer.ts`, `fileStampsFor`).
	 * Returns the chunk count.
	 */
	indexAsIndexer(rel: string): Promise<number>;
	/**
	 * Move `rel`'s mtime `ms` into the past: the save happened that long
	 * before the next pass's `git status`, i.e. outside the overlay's racy
	 * window (`HASH_MEMO_RACY_MS`). A test that means "written a while ago"
	 * says so with this; a bare `write()` is a save made just now.
	 */
	age(rel: string, ms?: number): void;
	ctx(overrides?: Partial<DirtyOverlayContext>): DirtyOverlayContext;
	manifest(): OverlayManifest | null;
	manifestBytes(): string | null;
	/** Every overlay row, read through a connection the overlay never held. */
	overlayRows(): Promise<Array<Record<string, unknown>>>;
	cleanup(): void;
}

export async function createOverlayFixture(
	files: Record<string, string>,
	prefix = "mnemex-overlay-",
): Promise<OverlayFixture> {
	await getParserManager().initialize();
	const box = createGitSandbox(prefix);
	const repo = join(box.root, "repo");
	mkdirSync(repo, { recursive: true });
	box.git(repo, "init", "-q");

	// One fixture owns the process env at a time. A second, overlapping
	// fixture would save the FIRST one's sandbox as "the original" and restore
	// it after both were gone — measured: the next suite's child inherited a
	// dead sandbox HOME. So creating one while another is alive is refused.
	if (liveFixtureHome !== null) {
		throw new Error(
			`dirty-overlay fixture: another fixture (${liveFixtureHome}) is still alive; clean it up first`,
		);
	}
	const savedHome = process.env.HOME;
	const savedXdg = process.env.XDG_CONFIG_HOME;
	const fixtureHome = join(box.root, "home");
	process.env.HOME = fixtureHome;
	process.env.XDG_CONFIG_HOME = join(box.root, "home", ".config");
	liveFixtureHome = fixtureHome;

	const write = (rel: string, text: string) => {
		const full = join(repo, rel);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, text);
	};
	for (const [rel, text] of Object.entries(files)) write(rel, text);
	box.git(repo, "add", "-A");
	box.git(repo, "commit", "-q", "-m", "init");

	__resetStoreLocationCacheForTests();
	const loc = resolveStoreLocation(repo);
	const tracker = createFileTracker(join(box.root, "index.db"), repo);
	const embedCachePath = join(box.root, "embed-cache.db");
	const stub = new StubEmbedder();
	const selection = createFileSelection({
		projectRealPath: loc.pathRoot,
		pathRoot: loc.pathRoot,
		excludePatterns: [...DEFAULT_EXCLUDE_PATTERNS],
		includePatterns: [],
	});

	const fixture: OverlayFixture = {
		box,
		repo: loc.pathRoot,
		loc,
		tracker,
		embedCachePath,
		stub,
		overlayDir: getDirtyOverlayDirFor(loc),
		manifestPath: getDirtyOverlayManifestPathFor(loc),
		vectorsDir: getDirtyOverlayVectorsPathFor(loc),
		lockPath: getDirtyOverlayLockPathFor(loc),
		write,
		read: (rel) => readFileSync(join(loc.pathRoot, rel)),
		remove: (rel) => unlinkSync(join(loc.pathRoot, rel)),
		commit: (message = "commit") => {
			box.git(repo, "add", "-A");
			box.git(repo, "commit", "-q", "-m", message);
		},
		index: (rel, hashOverride) => {
			const hash =
				hashOverride ??
				createHash("sha256")
					.update(readFileSync(join(loc.pathRoot, rel)))
					.digest("hex");
			tracker.markIndexed(BRANCH, rel, hash, []);
		},
		indexAsIndexer: async (rel) => {
			const bytes = readFileSync(join(loc.pathRoot, rel));
			const hash = createHash("sha256").update(bytes).digest("hex");
			const chunks = await chunkFileByPath(bytes.toString("utf-8"), rel, hash);
			if (chunks.length > 0) tracker.markIndexed(BRANCH, rel, hash, []);
			return chunks.length;
		},
		age: (rel, ms = 10_000) => {
			const when = (Date.now() - ms) / 1000;
			utimesSync(join(loc.pathRoot, rel), when, when);
		},
		ctx: (overrides = {}) => ({
			loc,
			selection,
			tracker,
			branchIds: [BRANCH],
			trackerBranchId: BRANCH,
			indexIdentity: { model: stub.model, provider: stub.provider },
			queryIdentity: { model: stub.model, provider: stub.provider },
			queryClient: stub,
			queryVector: stubVector("the query"),
			search: { limit: 10 },
			embedCachePath,
			...overrides,
		}),
		manifest: () => {
			const path = getDirtyOverlayManifestPathFor(loc);
			return existsSync(path)
				? (JSON.parse(readFileSync(path, "utf8")) as OverlayManifest)
				: null;
		},
		manifestBytes: () => {
			const path = getDirtyOverlayManifestPathFor(loc);
			return existsSync(path) ? readFileSync(path, "utf8") : null;
		},
		overlayRows: async () => {
			const dir = getDirtyOverlayVectorsPathFor(loc);
			if (!existsSync(dir)) return [];
			const db = await lancedb.connect(dir);
			if (!(await db.tableNames()).includes("code_chunks")) return [];
			const table = await db.openTable("code_chunks");
			return (await table.query().toArray()) as Array<Record<string, unknown>>;
		},
		cleanup: () => {
			(tracker as unknown as { close(): void }).close();
			resetEmbedCacheForTests();
			__resetStoreLocationCacheForTests();
			if (liveFixtureHome === fixtureHome) {
				if (savedHome === undefined) delete process.env.HOME;
				else process.env.HOME = savedHome;
				if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
				else process.env.XDG_CONFIG_HOME = savedXdg;
				liveFixtureHome = null;
			}
			rmSync(box.root, { recursive: true, force: true });
		},
	};
	return fixture;
}

/** Index every listed file at its current bytes. */
export function indexAll(fx: OverlayFixture, rels: readonly string[]): void {
	for (const rel of rels) fx.index(rel);
}
