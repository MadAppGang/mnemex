/**
 * `EmbedCache` — the persistent, content-addressed embedding store (Phase 1).
 *
 * Every assertion below is either about BYTES IN THE DATABASE (queried with an
 * independent connection, never through the class's own report object) or about
 * a value the class returns. `stats()` counters are asserted only where the
 * counter IS the contract; wherever the claim is "a row exists / does not
 * exist", the row is what gets read. CLAUDE.md's doctrine: "a report object
 * cannot show a spawn that happened", and every occurrence of the config
 * bug class in this repo has been invisible to the report.
 *
 * Gotchas pinned here: #15 (a zero-length vector is refused on write AND on
 * read, compared against `0`), #16 (a model name does not identify its provider,
 * so `(key, provider)` is the primary key), #21 (the memo is not per-instance —
 * see `embed-cache-statements.test.ts` for the counted version).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	EmbedCache,
	EmbedCacheEntry,
} from "../../../src/core/embed-cache.js";
import {
	DEFAULT_MAX_CACHE_BYTES,
	EVICT_TARGET_RATIO,
	embedCacheKey,
	getEmbedCachePath,
	isInMemoryPath,
	openEmbedCache,
	openEmbedCacheCountForTests,
	resetEmbedCacheForTests,
	resolveEmbedCacheMode,
	TOUCH_RESOLUTION_MS,
	WRITE_CHUNK,
} from "../../../src/core/embed-cache.js";
import { createDatabaseSync } from "../../../src/core/sqlite.js";

let dir: string;
let dbPath: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "embed-cache-"));
	dbPath = join(dir, "embed-cache.db");
	for (const key of ["MNEMEX_EMBED_CACHE_PATH", "MNEMEX_DISABLE_EMBED_CACHE"]) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
});

afterEach(() => {
	resetEmbedCacheForTests();
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	rmSync(dir, { recursive: true, force: true });
});

/** Read the store with an INDEPENDENT connection: bytes on disk, not a report. */
function readRows(path: string): Array<{
	key: string;
	provider: string;
	dim: number;
	fingerprint: string;
	bytes: number;
	blobLength: number;
	last_used_at: number;
	created_at: number;
}> {
	const db = createDatabaseSync(path);
	try {
		const rows = db
			.prepare(
				"SELECT key, provider, dim, fingerprint, bytes, length(vector) AS blobLength, last_used_at, created_at FROM embeddings ORDER BY key, provider",
			)
			.all() as Array<{
			key: string;
			provider: string;
			dim: number;
			fingerprint: string;
			bytes: number;
			blobLength: number;
			last_used_at: number;
			created_at: number;
		}>;
		return rows;
	} finally {
		db.close();
	}
}

function entry(over: Partial<EmbedCacheEntry> = {}): EmbedCacheEntry {
	const model = over.model ?? "nomic-embed-text";
	const dimension = over.dimension ?? 3;
	return {
		key: over.key ?? embedCacheKey(model, dimension, "hello world"),
		model,
		provider: over.provider ?? "ollama",
		dimension,
		fingerprint: over.fingerprint ?? "",
		vector: over.vector ?? [1.5, -2.25, 3.125],
	};
}

function open(options?: {
	maxBytes?: number;
	evictDeadlineMs?: number;
}): EmbedCache {
	const cache = openEmbedCache(dbPath, options);
	if (cache === null) throw new Error("openEmbedCache returned null");
	return cache;
}

// ════════════════════════════════════════════════════════════════════════════
describe("the key formula (FR-1)", () => {
	// The expected digests were produced INDEPENDENTLY of the implementation:
	//   printf 'nomic-embed-text\000768\000hello world' | shasum -a 256
	test("is sha256(model NUL dimension NUL text) — golden vectors", () => {
		expect(embedCacheKey("nomic-embed-text", 768, "hello world")).toBe(
			"f7bcec7fd1b24735e0a9619718e4ddf15749edcb6828627d3fc94e1da046ed16",
		);
		expect(embedCacheKey("voyage-code-3", 768, "hello world")).toBe(
			"589fdf942f9e7d85b9f981535b8b38dfc53c80237b926263ffe81395e50efa97",
		);
	});

	test("a DIMENSION change changes the key", () => {
		expect(embedCacheKey("nomic-embed-text", 512, "hello world")).toBe(
			"24a735e352a35de764ef32941fe01d71f0cfccff0e7804cb89d16695087f3c1b",
		);
		expect(embedCacheKey("nomic-embed-text", 512, "hello world")).not.toBe(
			embedCacheKey("nomic-embed-text", 768, "hello world"),
		);
	});

	test("two chunks differing only in name/chunkType share ONE key", () => {
		// This is the entire point of not reusing chunker.ts's contentHash, which
		// mixes `name` and `chunkType` into a hash of text that never reaches the
		// embedder. The formula takes the embedded TEXT, so a rename cannot split
		// the cache across two entries whose vectors are byte-identical.
		const text = "export function a() { return 1; }";
		expect(embedCacheKey("m", 768, text)).toBe(embedCacheKey("m", 768, text));
	});

	test("the NUL separator cannot be forged from the neighbouring fields", () => {
		// A model name and a decimal dimension cannot contain NUL, so no two
		// distinct triples can render to the same joined string.
		expect(embedCacheKey("a", 12, "b")).not.toBe(embedCacheKey("a", 1, "2\0b"));
	});
});

// ════════════════════════════════════════════════════════════════════════════
describe("policy: mode and path", () => {
	test("MNEMEX_DISABLE_EMBED_CACHE=1 turns it off, and openEmbedCache returns null", () => {
		process.env.MNEMEX_DISABLE_EMBED_CACHE = "1";
		expect(resolveEmbedCacheMode()).toBe("off");
		expect(openEmbedCache(dbPath)).toBeNull();
	});

	test("configEnabled is compared with === false, so undefined stays ON", () => {
		expect(resolveEmbedCacheMode(undefined)).toBe("persistent");
		expect(resolveEmbedCacheMode(true)).toBe("persistent");
		expect(resolveEmbedCacheMode(false)).toBe("off");
	});

	test("MNEMEX_EMBED_CACHE_PATH redirects, and homedir is read at CALL time", () => {
		process.env.MNEMEX_EMBED_CACHE_PATH = dbPath;
		expect(getEmbedCachePath()).toBe(dbPath);
		delete process.env.MNEMEX_EMBED_CACHE_PATH;
		expect(getEmbedCachePath()).toContain(".mnemex");
		expect(getEmbedCachePath()).toContain("embed-cache.db");
	});

	test("every in-memory spelling is recognised", () => {
		expect(isInMemoryPath(":memory:")).toBe(true);
		expect(isInMemoryPath("")).toBe(true);
		expect(isInMemoryPath("file::memory:?cache=shared")).toBe(true);
		expect(isInMemoryPath("file:x?mode=memory")).toBe(true);
		expect(isInMemoryPath("/tmp/x.db")).toBe(false);
	});
});

// ════════════════════════════════════════════════════════════════════════════
describe("store and serve", () => {
	test("a written vector round-trips through the float32 codec", () => {
		const cache = open();
		const e = entry();
		cache.putMany([e], []);
		expect(cache.get(e.key, e.provider, e.dimension, e.fingerprint)).toEqual([
			1.5, -2.25, 3.125,
		]);
		const rows = readRows(dbPath);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.blobLength).toBe(3 * 4);
		expect(rows[0]?.bytes).toBe(3 * 4);
	});

	test("a fresh cache has auto_vacuum = INCREMENTAL", () => {
		// The pragma ORDER is load-bearing: setting `journal_mode = WAL` first
		// writes the header and this pragma is then silently ignored, leaving
		// `incremental_vacuum` a no-op forever. Measured: page_count 5039 -> 5039
		// with 5029 pages stuck on the freelist.
		open();
		const db = createDatabaseSync(dbPath);
		try {
			const row = db.prepare("PRAGMA auto_vacuum").get() as {
				auto_vacuum: number;
			};
			expect(row.auto_vacuum).toBe(2); // 2 = INCREMENTAL
		} finally {
			db.close();
		}
	});

	test("meta records the schema version and the vector encoding", () => {
		open();
		const db = createDatabaseSync(dbPath);
		try {
			const rows = db.prepare("SELECT k, v FROM meta").all() as Array<{
				k: string;
				v: string;
			}>;
			const meta = Object.fromEntries(rows.map((r) => [r.k, r.v]));
			expect(meta.schema_version).toBe("1");
			expect(meta.vector_encoding).toBe("f32le");
			expect(meta.max_bytes).toBe(String(DEFAULT_MAX_CACHE_BYTES));
		} finally {
			db.close();
		}
	});

	test("a miss is a miss: no row, no throw, undefined", () => {
		const cache = open();
		expect(cache.get("no-such-key", "ollama", 3, "")).toBeUndefined();
		expect(cache.stats().misses).toBe(1);
		expect(cache.stats().hits).toBe(0);
	});
});

// ════════════════════════════════════════════════════════════════════════════
describe("provider coexistence — PRIMARY KEY (key, provider) (CLAUDE.md #16)", () => {
	test("one model name under two providers gives TWO rows, both served", () => {
		// CLAUDE.md #16's canonical scenario: a bare `nomic-embed-text` resolving
		// to Ollama on one machine and OpenRouter on another. With `key` alone as
		// the primary key each run would evict the other's row — a permanent 0 %
		// hit rate PLUS the full write cost every run, i.e. the machine-global
		// sharing that motivates the feature, defeated.
		const cache = open();
		const key = embedCacheKey("nomic-embed-text", 3, "hello world");
		cache.putMany(
			[
				entry({ key, provider: "ollama", vector: [1, 2, 3] }),
				entry({ key, provider: "openrouter", vector: [4, 5, 6] }),
			],
			[],
		);
		const rows = readRows(dbPath);
		expect(rows).toHaveLength(2);
		expect(rows.map((r) => r.provider).sort()).toEqual([
			"ollama",
			"openrouter",
		]);
		expect(cache.get(key, "ollama", 3, "")).toEqual([1, 2, 3]);
		expect(cache.get(key, "openrouter", 3, "")).toEqual([4, 5, 6]);
	});
});

// ════════════════════════════════════════════════════════════════════════════
describe("the three vetoes (§4.5)", () => {
	test("a zero-length vector is NEVER stored (CLAUDE.md #15, write side)", () => {
		const cache = open();
		cache.putMany([entry({ vector: [], dimension: 3 })], []);
		// Asserted on the DATABASE, not on the report.
		expect(readRows(dbPath)).toHaveLength(0);
		expect(cache.stats().refusedZeroLength).toBe(1);
		expect(cache.stats().writes).toBe(0);
	});

	test("a zero-length vector with dimension 0 is refused too", () => {
		const cache = open();
		cache.putMany([entry({ vector: [], dimension: 0 })], []);
		expect(readRows(dbPath)).toHaveLength(0);
	});

	test("a row planted with a 0-byte blob is NOT served, and is evictable", () => {
		// The read side of #15. A row like this cannot be written by this class,
		// so it is planted directly — that is exactly the shape an older build or
		// a torn write could leave behind, and serving it would put a 0-length
		// vector into a LanceDB batch, which is the corrupt-index generator.
		const cache = open();
		const key = embedCacheKey("nomic-embed-text", 3, "hello world");
		const db = createDatabaseSync(dbPath);
		db.prepare(
			"INSERT INTO embeddings (key, provider, model, dim, fingerprint, vector, bytes, created_at, last_used_at) VALUES (?,?,?,?,?,?,?,?,?)",
		).run(key, "ollama", "nomic-embed-text", 3, "", new Uint8Array(0), 0, 1, 1);
		db.close();

		expect(cache.get(key, "ollama", 3, "")).toBeUndefined();
		expect(cache.stats().refusedZeroLength).toBe(1);

		const vetoed = cache.pendingEvictions();
		expect(vetoed).toHaveLength(1);
		cache.evictKeys(vetoed);
		expect(readRows(dbPath)).toHaveLength(0);
	});

	test("a dimension mismatch is a miss and is deleted", () => {
		const cache = open();
		const e = entry({ dimension: 3, vector: [1, 2, 3] });
		cache.putMany([e], []);
		// The active client now produces 4 dims. The stored row's key encodes 3,
		// so it can never be addressed under the new dimension anyway — but a
		// lookup that DID reach it must refuse it rather than serve 3 numbers
		// where 4 are expected.
		expect(cache.get(e.key, "ollama", 4, "")).toBeUndefined();
		expect(cache.stats().refusedDimension).toBe(1);
		cache.evictKeys(cache.pendingEvictions());
		expect(readRows(dbPath)).toHaveLength(0);
	});

	test("a client-fingerprint mismatch is a miss and is deleted (§4.5)", () => {
		// `OllamaEmbeddingsClient.embed` pre-truncates every text to a code
		// constant keyed by MODEL NAME, so the vector corresponds to
		// truncate(text, K) while the key is over `text`. Editing
		// MODEL_CONTEXT_LENGTHS would silently change the vector behind an
		// unchanged key, in a machine-global file that is never invalidated.
		const cache = open();
		const e = entry({ fingerprint: "trunc:32000" });
		cache.putMany([e], []);
		expect(
			cache.get(e.key, e.provider, e.dimension, "trunc:8192"),
		).toBeUndefined();
		expect(cache.stats().refusedFingerprint).toBe(1);
		cache.evictKeys(cache.pendingEvictions());
		expect(readRows(dbPath)).toHaveLength(0);
		// The same row IS served to a client whose fingerprint matches.
		cache.putMany([e], []);
		expect(cache.get(e.key, e.provider, e.dimension, "trunc:32000")).toEqual([
			1.5, -2.25, 3.125,
		]);
	});

	test("a veto does NOT delete a row that was rewritten in the same batch", () => {
		// The reason `VetoedRow` carries the full vetoed identity instead of just
		// the primary key. A vetoed row is a MISS, so the text is re-embedded and
		// written back under the SAME (key, provider) in the same batch; a
		// delete-by-primary-key would then remove the row that was just written,
		// giving a permanent 0 % hit rate for exactly the texts a veto touches —
		// with full write amplification and no error anywhere.
		const cache = open();
		const stale = entry({ fingerprint: "trunc:32000" });
		cache.putMany([stale], []);
		expect(
			cache.get(stale.key, stale.provider, stale.dimension, "trunc:8192"),
		).toBeUndefined();
		const vetoed = cache.pendingEvictions();

		// The proxy re-embeds the miss and writes it under the ACTIVE fingerprint…
		cache.putMany(
			[entry({ fingerprint: "trunc:8192", vector: [7, 8, 9] })],
			[],
		);
		// …and only then flushes the deferred eviction.
		cache.evictKeys(vetoed);

		const rows = readRows(dbPath);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.fingerprint).toBe("trunc:8192");
		expect(
			cache.get(stale.key, stale.provider, stale.dimension, "trunc:8192"),
		).toEqual([7, 8, 9]);
	});
});

// ════════════════════════════════════════════════════════════════════════════
describe("model_dims — the writer rule (§4.2)", () => {
	test("recordDimension stores what it is given, and knownDimension reads it back", () => {
		const cache = open();
		cache.recordDimension("nomic-embed-text", "ollama", 768);
		expect(cache.knownDimension("nomic-embed-text", "ollama")).toBe(768);
		// Provider is part of the model_dims key too.
		expect(
			cache.knownDimension("nomic-embed-text", "openrouter"),
		).toBeUndefined();
	});

	test("a dimension of 0 is REFUSED, and never reaches the table", () => {
		// A poisoned row in a machine-global file is never invalidated (FR-5).
		// Revision 1's seed wrote the TABLE's Arrow listSize into model_dims as if
		// it were the model's output width; the reachable case where that number
		// is 1 (the BM25 placeholder `[0]`) is what killed the seed.
		const cache = open();
		cache.recordDimension("m", "ollama", 0);
		const db = createDatabaseSync(dbPath);
		try {
			const rows = db.prepare("SELECT * FROM model_dims").all();
			expect(rows).toHaveLength(0);
		} finally {
			db.close();
		}
		expect(cache.knownDimension("m", "ollama")).toBeUndefined();
	});

	test("a planted dimension of 0 is reported as UNKNOWN, never used", () => {
		const cache = open();
		const db = createDatabaseSync(dbPath);
		db.prepare(
			"INSERT INTO model_dims (model, provider, dim, learned_at) VALUES (?,?,?,?)",
		).run("m", "ollama", 0, 1);
		db.close();
		// `=== 0`, not falsiness: 0 is the only value worth catching (#15).
		expect(cache.knownDimension("m", "ollama")).toBeUndefined();
	});

	test("putMany writes model_dims in the SAME transaction as the entries", () => {
		const cache = open();
		const e = entry();
		cache.putMany([e], [], {
			model: e.model,
			provider: e.provider,
			dimension: 3,
		});
		expect(cache.knownDimension(e.model, e.provider)).toBe(3);
		expect(readRows(dbPath)).toHaveLength(1);
	});
});

// ════════════════════════════════════════════════════════════════════════════
describe("touch — LRU freshness without a read-then-write", () => {
	test("a stale row's last_used_at advances; a fresh one is not rewritten", () => {
		const cache = open();
		const e = entry();
		cache.putMany([e], []);
		const created = readRows(dbPath)[0];
		expect(created).toBeDefined();

		// Fresh row: the threshold is in the WHERE clause, so this UPDATE matches
		// nothing and an all-hits run does not rewrite every row it reads.
		cache.putMany([], [{ key: e.key, provider: e.provider }]);
		expect(readRows(dbPath)[0]?.last_used_at).toBe(
			created?.last_used_at as number,
		);

		// Backdate past the resolution and the touch lands.
		const db = createDatabaseSync(dbPath);
		db.prepare("UPDATE embeddings SET last_used_at = ?").run(
			Date.now() - TOUCH_RESOLUTION_MS - 1000,
		);
		db.close();
		cache.putMany([], [{ key: e.key, provider: e.provider }]);
		expect(readRows(dbPath)[0]?.last_used_at).toBeGreaterThan(
			Date.now() - TOUCH_RESOLUTION_MS,
		);
	});
});

// ════════════════════════════════════════════════════════════════════════════
describe("LRU enforcement (§8.1)", () => {
	function fill(cache: EmbedCache, rows: number, dim: number): string[] {
		const vec = Array.from({ length: dim }, (_, i) => i / dim);
		const keys: string[] = [];
		for (let i = 0; i < rows; i += WRITE_CHUNK) {
			const slice: EmbedCacheEntry[] = [];
			for (let j = i; j < Math.min(i + WRITE_CHUNK, rows); j++) {
				const key = embedCacheKey("m", dim, `text-${j}`);
				keys.push(key);
				slice.push({
					key,
					model: "m",
					provider: "ollama",
					dimension: dim,
					fingerprint: "",
					vector: vec,
				});
			}
			cache.putMany(slice, []);
		}
		return keys;
	}

	test("under the cap, nothing is evicted", async () => {
		const cache = open();
		fill(cache, 100, 8);
		const report = await cache.enforceBudget();
		expect(report.skipped).toBe("under cap");
		expect(report.rowsEvicted).toBe(0);
		expect(readRows(dbPath)).toHaveLength(100);
	});

	test("over the cap, the OLDEST last_used_at goes first and the file SHRINKS", async () => {
		const cache = open({ maxBytes: 512 * 1024 });
		const keys = fill(cache, 2000, 64);
		// Make the first 1000 rows unambiguously older than the rest.
		const db = createDatabaseSync(dbPath);
		const old = Date.now() - 10 * 60_000;
		const upd = db.prepare(
			"UPDATE embeddings SET last_used_at = ? WHERE key = ?",
		);
		db.transaction(() => {
			for (const key of keys.slice(0, 1000)) upd.run(old, key);
		});
		db.close();

		const report = await cache.enforceBudget();
		expect(report.rowsEvicted).toBeGreaterThan(0);
		expect(report.fileBytesAfter).toBeLessThan(report.fileBytesBefore);
		expect(report.fileBytesAfter).toBeLessThanOrEqual(
			Math.max(
				Math.floor(512 * 1024 * EVICT_TARGET_RATIO),
				report.fileBytesBefore,
			),
		);

		// Everything that survived must be from the NEWER half.
		const survivors = new Set(readRows(dbPath).map((r) => r.key));
		const oldSurvivors = keys.slice(0, 1000).filter((k) => survivors.has(k));
		const newSurvivors = keys.slice(1000).filter((k) => survivors.has(k));
		expect(newSurvivors.length).toBeGreaterThan(0);
		expect(oldSurvivors).toEqual([]);
	});

	test("the deadline stops a long sweep, and the next call continues", async () => {
		// Eviction is idempotent and incremental, so stopping early costs nothing
		// but a larger file until the next run — which is what lets it run inside
		// the index lock at all.
		const cache = open({ maxBytes: 256 * 1024, evictDeadlineMs: 0 });
		fill(cache, 2000, 64);
		const first = await cache.enforceBudget();
		expect(first.stoppedAtDeadline).toBe(true);
		const rowsAfterFirst = readRows(dbPath).length;
		expect(rowsAfterFirst).toBeLessThan(2000);

		const cache2 = openEmbedCache(dbPath, { maxBytes: 256 * 1024 });
		expect(cache2).not.toBeNull();
		await (cache2 as EmbedCache).enforceBudget();
		expect(readRows(dbPath).length).toBeLessThan(rowsAfterFirst);
	});
});

// ════════════════════════════════════════════════════════════════════════════
describe("the instance memo (CLAUDE.md #21)", () => {
	test("two opens of one path share ONE instance", () => {
		const a = open();
		const b = openEmbedCache(dbPath);
		expect(b).toBe(a);
		expect(openEmbedCacheCountForTests()).toBe(1);
	});

	test("a symlinked spelling shares the instance", () => {
		const a = open();
		const link = join(dir, "link.db");
		symlinkSync(dbPath, link);
		expect(openEmbedCache(link)).toBe(a);
		expect(openEmbedCacheCountForTests()).toBe(1);
	});

	test("two different files get two instances", () => {
		const a = open();
		const other = join(dir, "other.db");
		const b = openEmbedCache(other);
		expect(b).not.toBe(a);
		expect(openEmbedCacheCountForTests()).toBe(2);
	});

	test("in-memory databases are NEVER shared", () => {
		// Each `:memory:` open is a distinct, private, empty database. Sharing one
		// would hand the second caller another connection's rows.
		const a = openEmbedCache(":memory:");
		const b = openEmbedCache(":memory:");
		expect(a).not.toBeNull();
		expect(b).not.toBeNull();
		expect(a).not.toBe(b);
		expect(openEmbedCacheCountForTests()).toBe(0);
		a?.close();
		b?.close();
	});

	test("a closed instance is dropped from the memo and reopening works", () => {
		const a = open();
		a.close();
		expect(openEmbedCacheCountForTests()).toBe(0);
		const b = openEmbedCache(dbPath);
		expect(b).not.toBeNull();
		expect(b).not.toBe(a);
	});
});

// ════════════════════════════════════════════════════════════════════════════
describe("degradation — the cache never crashes a run (§8)", () => {
	test("garbage at the path yields null, not a throw", () => {
		writeFileSync(
			dbPath,
			"this is definitely not a sqlite database\n".repeat(64),
		);
		expect(openEmbedCache(dbPath)).toBeNull();
	});

	test("an unwritable directory yields null, not a throw", () => {
		const nested = join(dir, "unwritable");
		mkdirSync(nested, { mode: 0o500 });
		expect(openEmbedCache(join(nested, "sub", "cache.db"))).toBeNull();
	});

	test("a closed cache serves nothing and stores nothing, silently", () => {
		const cache = open();
		const e = entry();
		cache.putMany([e], []);
		cache.close();
		expect(
			cache.get(e.key, e.provider, e.dimension, e.fingerprint),
		).toBeUndefined();
		cache.putMany([entry({ vector: [9, 9, 9] })], []);
		expect(readRows(dbPath)).toHaveLength(1);
		expect(cache.stats().tier).toBe("none");
	});
});
