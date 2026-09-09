/**
 * Runs the embedding-cache wiring probe in its own bun process.
 *
 * Two reasons for the subprocess, not one:
 *
 *  1. The probe fakes the embeddings provider with `mock.module`, which in bun
 *     replaces the module registry for the whole PROCESS and is not undone by
 *     `mock.restore()` — nor by re-registering the real module, because every
 *     importer evaluated in the meantime has already bound the fake. The same
 *     containment `indexer-model-mismatch.test.ts` uses, for the same reason.
 *
 *  2. `index()` reads `GlobalConfig.embedCache` from `~/.mnemex/config.json`.
 *     A developer whose real config says `embedCache: false` would otherwise run
 *     this whole suite with the cache off — several tests would still pass, and
 *     the ones that matter would fail for a reason that looks like a bug in the
 *     feature. `GLOBAL_CONFIG_DIR` is a module-level const from `homedir()` and
 *     Bun's `homedir()` ignores a runtime `HOME` reassignment, so the only
 *     sandbox that works is a child whose `HOME` was in its environment before
 *     it started. The probe refuses to run unless `homedir()` agrees with
 *     `MNEMEX_TEST_SANDBOX_HOME` and is inside `tmpdir()`.
 *
 * The child's own output is the failure report — this wrapper only relays it.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { keychainSafeChildEnv } from "../../helpers/child-env.js";

const PROBE = join(
	dirname(fileURLToPath(import.meta.url)),
	"probes",
	"indexer-embed-cache.probe.ts",
);

describe("embedding-cache indexer wiring (isolated process)", () => {
	test("the probe suite passes", async () => {
		const sandboxHome = mkdtempSync(join(tmpdir(), "mnemex-probe-home-"));
		try {
			const proc = Bun.spawn(["bun", "test", PROBE], {
				stdout: "pipe",
				stderr: "pipe",
				env: keychainSafeChildEnv({
					HOME: sandboxHome,
					MNEMEX_TEST_SANDBOX_HOME: sandboxHome,
				}),
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);

			if (exitCode !== 0) {
				throw new Error(`probe suite failed:\n${stdout}\n${stderr}`);
			}
			// bun test writes its summary to stderr.
			expect(stderr).toContain("0 fail");
		} finally {
			rmSync(sandboxHome, { recursive: true, force: true });
		}
	}, 600_000);
});
