/**
 * `openEmbedCache(path, { ifAlreadyOpen: true })` (step 3, MEDIUM 4).
 *
 * The full open is the one embed-cache region that is not constant-bounded
 * (directory create, file open, the WAL pragma's exclusive lock, DDL — all
 * before `busy_timeout` exists), so it is safe only OUTSIDE both index locks.
 * The dirty overlay runs on the search path, and an MCP server can hold the
 * store lock in one request while another searches. Under a held index lock
 * the overlay therefore asks for the level-1 memo ONLY: the instance already
 * open in this process, or `null` — never a fresh open.
 *
 * Asserted on the bytes at the path (no file created on a cold memo), not on a
 * report object. The refusal of the user path still THROWS under the option:
 * it is a test bug, not a degradation (CLAUDE.md #31).
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	openEmbedCache,
	resetEmbedCacheForTests,
	USER_PATH_REFUSAL_PREFIX,
} from "../../../src/core/embed-cache.js";

const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "mnemex-ecmemo-")));
afterEach(() => resetEmbedCacheForTests());
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("openEmbedCache({ ifAlreadyOpen })", () => {
	test("cold memo: null, and NO file is created (bytes on disk)", () => {
		const path = join(dir, "cold.db");
		expect(openEmbedCache(path, { ifAlreadyOpen: true })).toBeNull();
		expect(existsSync(path)).toBe(false);
	});

	test("warm memo: the SAME instance a full open returned", () => {
		const path = join(dir, "warm.db");
		const opened = openEmbedCache(path);
		expect(opened).not.toBeNull();
		expect(openEmbedCache(path, { ifAlreadyOpen: true })).toBe(opened);
	});

	test("a closed memo entry is not handed out", () => {
		const path = join(dir, "closed.db");
		openEmbedCache(path)?.close();
		expect(openEmbedCache(path, { ifAlreadyOpen: true })).toBeNull();
	});

	test("the user-path refusal still THROWS under the option", () => {
		const prev = process.env.MNEMEX_EMBED_CACHE_PATH;
		delete process.env.MNEMEX_EMBED_CACHE_PATH;
		try {
			expect(() => openEmbedCache(undefined, { ifAlreadyOpen: true })).toThrow(
				USER_PATH_REFUSAL_PREFIX,
			);
		} finally {
			if (prev !== undefined) process.env.MNEMEX_EMBED_CACHE_PATH = prev;
		}
	});
});
