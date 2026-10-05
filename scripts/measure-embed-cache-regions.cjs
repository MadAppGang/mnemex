/**
 * Region p99 measurement for the embedding cache — REQUIRED BY §6.2.
 *
 * `MAX_SYNC_REGION_MS = 250` is a design TARGET for the work inside one bounded
 * synchronous region, and the whole heartbeat bound
 * (`B_max = BUSY_TIMEOUT_MS + MAX_SYNC_REGION_MS = 500 ms`) rests on it. §6.2
 * says it must be MEASURED, on BOTH sqlite drivers, and that any region whose
 * p99 exceeds it has its size constant halved.
 *
 * Run it on both drivers by running this same file with both runtimes — the
 * bundle picks its driver from `typeof Bun`, exactly as `src/core/sqlite.ts`
 * does in production:
 *
 *   bun build src/core/embed-cache.ts --target node --format cjs \
 *     --external better-sqlite3 --outfile node_modules/.cache/ec.cjs
 *   bun  scripts/measure-embed-cache-regions.cjs node_modules/.cache/ec.cjs
 *   node scripts/measure-embed-cache-regions.cjs node_modules/.cache/ec.cjs
 *
 * The bundle must live inside the repo: Node resolves `better-sqlite3` by
 * walking up from the requiring FILE, not from the cwd.
 */

const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const bundlePath = process.argv[2];
if (!bundlePath) {
	process.stderr.write("usage: measure-embed-cache-regions.cjs <bundle.cjs>\n");
	process.exit(2);
}

const mod = require(bundlePath);
const runtime =
	typeof globalThis.Bun !== "undefined" ? "bun:sqlite" : "better-sqlite3";

const DIM = 768;
const ROWS = 20000;
const LOOKUPS = 20000;

function percentile(samples, p) {
	if (samples.length === 0) return 0;
	const sorted = [...samples].sort((a, b) => a - b);
	const index = Math.min(
		sorted.length - 1,
		Math.ceil((p / 100) * sorted.length) - 1,
	);
	return sorted[Math.max(0, index)];
}

function report(name, samples) {
	return {
		region: name,
		n: samples.length,
		p50: +percentile(samples, 50).toFixed(3),
		p95: +percentile(samples, 95).toFixed(3),
		p99: +percentile(samples, 99).toFixed(3),
		max: +Math.max(0, ...samples).toFixed(3),
	};
}

async function main() {
	const dir = mkdtempSync(join(tmpdir(), "embed-cache-measure-"));
	const dbPath = join(dir, "embed-cache.db");
	const cache = mod.openEmbedCache(dbPath, { maxBytes: 8 * 1024 * 1024 });
	if (cache === null) throw new Error("openEmbedCache returned null");

	const vector = Array.from({ length: DIM }, (_, i) => i / DIM);
	const keys = [];

	// R2 — one putMany of WRITE_CHUNK rows is one region.
	const r2 = [];
	for (let i = 0; i < ROWS; i += mod.WRITE_CHUNK) {
		const slice = [];
		for (let j = i; j < Math.min(i + mod.WRITE_CHUNK, ROWS); j++) {
			const key = mod.embedCacheKey("m", DIM, `text-${j}`);
			keys.push(key);
			slice.push({
				key,
				model: "m",
				provider: "ollama",
				dimension: DIM,
				fingerprint: "",
				vector,
			});
		}
		const t0 = performance.now();
		cache.putMany(slice, []);
		r2.push(performance.now() - t0);
	}

	// R1 — one region is LOOKUP_CHUNK point lookups.
	const r1 = [];
	for (let i = 0; i < LOOKUPS; i += mod.LOOKUP_CHUNK) {
		const t0 = performance.now();
		for (let j = 0; j < mod.LOOKUP_CHUNK; j++) {
			cache.get(keys[(i + j) % keys.length], "ollama", DIM, "");
		}
		r1.push(performance.now() - t0);
	}

	// R3 + R4 — measured from inside `enforceBudget` is not possible, so the
	// sweep is timed as a whole and divided by the regions it reports. That is
	// an AVERAGE, not a p99, and it is labelled as one.
	const t0 = performance.now();
	const eviction = await cache.enforceBudget();
	const sweepMs = performance.now() - t0;
	const regions = eviction.rowsEvicted / mod.EVICT_CHUNK + eviction.vacuumCalls;

	const out = {
		runtime,
		node: process.versions.node ?? null,
		bun: process.versions.bun ?? null,
		dim: DIM,
		rows: ROWS,
		budget: {
			MAX_SYNC_REGION_MS: mod.MAX_SYNC_REGION_MS,
			BUSY_TIMEOUT_MS: mod.BUSY_TIMEOUT_MS,
			CONTENTION_BUDGET_MS: mod.CONTENTION_BUDGET_MS,
		},
		regions: [report("R1 lookup slice", r1), report("R2 write slice", r2)],
		sweep: {
			region: "R3+R4 evict/vacuum",
			totalMs: +sweepMs.toFixed(3),
			regions: Math.round(regions),
			meanMsPerRegion: +(sweepMs / Math.max(1, regions)).toFixed(3),
			rowsEvicted: eviction.rowsEvicted,
			vacuumCalls: eviction.vacuumCalls,
			stoppedAtDeadline: eviction.stoppedAtDeadline,
		},
		maxSyncRegionMsSelfReported: cache.stats().maxSyncRegionMs,
	};

	cache.close();
	rmSync(dir, { recursive: true, force: true });
	process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);

	const worst = Math.max(
		...out.regions.map((r) => r.p99),
		out.sweep.meanMsPerRegion,
	);
	if (worst > mod.MAX_SYNC_REGION_MS) {
		process.stderr.write(
			`FAIL: a region exceeded MAX_SYNC_REGION_MS (${worst} > ${mod.MAX_SYNC_REGION_MS}). Halve its size constant.\n`,
		);
		process.exit(1);
	}
}

main().catch((err) => {
	process.stderr.write(`${err?.stack ?? String(err)}\n`);
	process.exit(1);
});
