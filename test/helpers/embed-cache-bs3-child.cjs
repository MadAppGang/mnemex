/**
 * The `better-sqlite3` half of ASSUMPTION 4 (architecture §11), run in a NODE
 * child because it cannot be run anywhere else.
 *
 * `src/core/sqlite.ts` ships two driver paths and picks by runtime: `bun:sqlite`
 * under Bun, `better-sqlite3` under Node. `bun test` always runs under Bun, so
 * the second path is unreachable in-process — and it is worse than unreachable:
 * `require("better-sqlite3")` followed by `new Database()` ABORTS bun 1.4.0 with
 * `panic: NAPI FATAL ERROR: Error::New napi_get_last_error_info`, taking the
 * whole test runner with it. A Node child is the only way to exercise it.
 *
 * The assumption under test: both drivers accept the BLOB parameter the cache
 * binds. `better-sqlite3` historically wants a `Buffer` rather than any
 * `Uint8Array`, which is why `toBlobParam()` exists.
 *
 * Takes: <bundled-embed-cache.cjs> <db-path>
 * Prints: one line of JSON on stdout.
 */

const path = process.argv[2];
const dbPath = process.argv[3];

function main() {
	const mod = require(path);
	const out = {
		runtime: {
			node: process.versions.node,
			// Must be absent: if this is a Bun process the test proves nothing.
			bun: process.versions.bun ?? null,
		},
	};

	const cache = mod.openEmbedCache(dbPath);
	if (cache === null) {
		out.error = "openEmbedCache returned null";
		process.stdout.write(`${JSON.stringify(out)}\n`);
		process.exit(1);
	}

	const model = "nomic-embed-text";
	const dim = 5;
	const vector = [1.5, -2.25, 3.125, 0.5, -0.0625];
	const key = mod.embedCacheKey(model, dim, "hello from node");

	cache.putMany(
		[
			{
				key,
				model,
				provider: "ollama",
				dimension: dim,
				fingerprint: "trunc:32000",
				vector,
			},
		],
		[],
		{ model, provider: "ollama", dimension: dim },
	);

	out.key = key;
	out.readBack = cache.get(key, "ollama", dim, "trunc:32000");
	out.knownDimension = cache.knownDimension(model, "ollama");
	out.stats = cache.stats();

	// Does this driver accept a bare Uint8Array, or does it need the Buffer wrap?
	// Recorded rather than asserted: the answer is a property of the installed
	// better-sqlite3, and `toBlobParam` has to be right for BOTH answers.
	const BetterSqlite3 = require("better-sqlite3");
	const probe = new BetterSqlite3(":memory:");
	probe.exec("CREATE TABLE t (k TEXT PRIMARY KEY, v BLOB NOT NULL)");
	const f32 = new Float32Array(vector);
	const view = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
	try {
		probe.prepare("INSERT INTO t (k,v) VALUES (?,?)").run("raw", view);
		out.acceptsBareUint8Array = true;
	} catch (err) {
		out.acceptsBareUint8Array = false;
		out.bareUint8ArrayError = String(err);
	}
	try {
		probe
			.prepare("INSERT INTO t (k,v) VALUES (?,?)")
			.run("wrapped", mod.toBlobParam(view));
		out.acceptsToBlobParam = true;
	} catch (err) {
		out.acceptsToBlobParam = false;
		out.toBlobParamError = String(err);
	}
	const row = probe.prepare("SELECT v FROM t WHERE k = ?").get("wrapped");
	out.wrappedByteLength = row ? row.v.length : null;
	out.toBlobParamCtor = mod.toBlobParam(view).constructor.name;
	probe.close();

	cache.close();
	process.stdout.write(`${JSON.stringify(out)}\n`);
}

try {
	main();
} catch (err) {
	process.stdout.write(
		`${JSON.stringify({ error: String(err), stack: err?.stack })}\n`,
	);
	process.exit(1);
}
