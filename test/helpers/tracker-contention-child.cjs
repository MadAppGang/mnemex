/**
 * A second PROCESS on a tracker `index.db` that another process is writing to —
 * the adversary for V2.8 and V2.11 (architecture §7 and §5.3).
 *
 * CommonJS so that ONE script runs under both drivers: `bun` requires
 * `src/core/tracker.ts` directly (bun:sqlite), and `node` requires a CJS bundle
 * of it (better-sqlite3) — the device `embed-cache-drivers.test.ts` uses.
 *
 * It REPORTS what it observed and the parent asserts. Two channels are read by
 * the parent from OUTSIDE this process:
 *   - `beatFile`: a timestamp appended by a 10 ms `setInterval` — the lock
 *     heartbeat's shape. A synchronous region blocks this event loop, so the
 *     longest gap between two ticks is the longest block. That is measured, not
 *     reported by the class about itself (CLAUDE.md #24, #31).
 *   - stdout: `READY <journalMode>` once the tracker is open (the `*-after-go`
 *     modes, which then wait for `goFile`), `ROW <path>` per row a read returned,
 *     and exactly one `__RESULT__{json}` line.
 *
 * Usage:
 *   <bun|node> tracker-contention-child.cjs <module> <mode> <dbPath> <root> <beatFile> [goFile]
 *
 * Modes:
 *   seed             construct; setMetadata seed; markIndexed each extra argv path;
 *                    close; exit. A PROCESS EXIT, because bun's `close()` with
 *                    unfinalized statements leaves a zombie connection that still
 *                    holds the WAL's shared memory — measured: it blocks
 *                    `journal_mode = DELETE` until a GC finalizes the statements
 *   open             construct; read back `seed` and `pending`; the resting busy_timeout
 *   read-after-go    construct; READY; wait for goFile; getAllFiles(); ROW per row
 *   writes-after-go  construct; READY; wait for goFile; 8 × setMetadata, yielding between
 *
 * Exit code: 0 when every tracker operation succeeded, 3 when one threw, 4 on a
 * harness fault.
 */
"use strict";

const { appendFileSync, existsSync } = require("node:fs");

const [modulePath, mode, dbPath, root, beatFile, goFile] =
	process.argv.slice(2);
const { FileTracker } = require(modulePath);

const runtime = {
	bun: typeof Bun === "undefined" ? null : Bun.version,
	node: process.versions.node,
};

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorInfo(error) {
	if (!error) return null;
	return {
		name: error.name ?? null,
		message: error.message ?? String(error),
		code: error.code ?? null,
		region: error.region ?? null,
	};
}

function report(result) {
	process.stdout.write(
		`__RESULT__${JSON.stringify({ runtime, mode, ...result })}\n`,
	);
}

async function waitForGo() {
	while (!existsSync(goFile)) await sleep(10);
}

/** Read through the RAW handle, outside every region: the value at rest. */
function restingBusyTimeout(tracker) {
	const row = tracker.getDatabase().prepare("PRAGMA busy_timeout").get();
	return row ? Number(Object.values(row)[0]) : null;
}

async function main() {
	const beat = setInterval(() => {
		appendFileSync(beatFile, `${Date.now()}\n`);
	}, 10);
	// A few ticks BEFORE the operation, so a block has a "before" to measure from.
	await sleep(60);

	let tracker = null;
	let openError = null;
	try {
		tracker = new FileTracker(dbPath, root);
	} catch (error) {
		openError = error;
	}

	let result;
	if (tracker === null) {
		result = { constructed: false, error: errorInfo(openError) };
	} else if (mode === "seed") {
		tracker.setMetadata("seed", "committed");
		for (const file of process.argv.slice(8)) {
			tracker.markIndexed(`${root}/${file}`, `hash-${file}`, [`chunk-${file}`]);
		}
		result = {
			constructed: true,
			error: null,
			journalMode: tracker.journalMode,
		};
	} else if (mode === "open") {
		result = {
			constructed: true,
			error: null,
			journalMode: tracker.journalMode,
			seed: tracker.getMetadata("seed"),
			pending: tracker.getMetadata("pending"),
			restingBusyTimeout: restingBusyTimeout(tracker),
		};
	} else if (mode === "read-after-go") {
		process.stdout.write(`READY ${tracker.journalMode}\n`);
		await waitForGo();
		try {
			const rows = tracker.getAllFiles();
			for (const row of rows) process.stdout.write(`ROW ${row.path}\n`);
			result = {
				constructed: true,
				journalMode: tracker.journalMode,
				rows: rows.length,
				error: null,
			};
		} catch (error) {
			result = {
				constructed: true,
				journalMode: tracker.journalMode,
				rows: null,
				error: errorInfo(error),
			};
		}
	} else if (mode === "writes-after-go") {
		process.stdout.write(`READY ${tracker.journalMode}\n`);
		await waitForGo();
		const attempts = [];
		for (let i = 0; i < 8; i++) {
			const started = Date.now();
			try {
				tracker.setMetadata(`child-${i}`, "written");
				attempts.push({ ok: true, ms: Date.now() - started, error: null });
			} catch (error) {
				attempts.push({
					ok: false,
					ms: Date.now() - started,
					error: errorInfo(error),
				});
			}
			// SR-2 on the CALLER's side: yield between two regions.
			await sleep(0);
		}
		const failed = attempts.find((a) => !a.ok);
		result = {
			constructed: true,
			attempts,
			error: failed ? failed.error : null,
		};
	} else {
		throw new Error(`unknown mode ${mode}`);
	}

	if (tracker !== null) tracker.close();
	await sleep(60);
	clearInterval(beat);
	report(result);
	process.exitCode = result.error ? 3 : 0;
}

main().catch((error) => {
	report({ fatal: errorInfo(error) });
	process.exitCode = 4;
});
