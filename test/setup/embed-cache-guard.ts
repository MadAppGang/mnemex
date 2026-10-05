/**
 * `bun test` preload — the CHILD-PROCESS layer of the embed-cache user-path guard.
 *
 * NOT the primary guard, for exactly the reason `keychain-guard.ts` states in its
 * own header: `bun` resolves `bunfig.toml` against the CURRENT WORKING DIRECTORY
 * and does not walk up, so `cd test && bun test ../x.test.ts` never runs this
 * file. Anything that depends on it alone is not a guard.
 *
 * The primary guard is DENY BY DEFAULT inside `src/core/embed-cache.ts`
 * (`userPathEnabled`, opened only by `src/index.ts`). It needs no environment, no
 * preload and no cwd, so it holds in every one of those situations.
 *
 * What this file adds is the one case deny-by-default cannot cover: a test that
 * SPAWNS the production entry point, whose first act is to open the gate inside
 * the child. `MNEMEX_EMBED_CACHE_TEST_GUARD=1` makes `enableUserEmbedCachePath()`
 * a no-op, and a child inherits it. `test/helpers/child-env.ts` sets the same
 * sentinel EXPLICITLY at every spawn site precisely because inheriting it from a
 * preload is what failed for the keychain (CLAUDE.md #24, finding A2) — this is
 * the redundant layer, not the load-bearing one.
 *
 * Deliberately does NOT set `MNEMEX_EMBED_CACHE_PATH`. Redirecting the whole
 * suite to a temp file would make every test that forgot to sandbox itself pass
 * quietly, which is the "silently redirect" failure mode the guard exists to
 * refuse: a test that meant to use a temp path and did not is a bug worth
 * surfacing.
 */

process.env.MNEMEX_EMBED_CACHE_TEST_GUARD = "1";
