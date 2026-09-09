/**
 * THE environment every test child gets, and the reason there is a helper for it.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT THIS CLOSES (external review, CRITICAL 1 / CWE-284)
 *
 * `src/core/keychain.ts` denies real keychain access by default and only
 * `src/index.ts` — the production composition root — turns it on. That protects
 * every test that IMPORTS the keychain module. It cannot protect a test that
 * SPAWNS the production entry point, because the entry point's first act is to
 * enable real access in the child.
 *
 * The residual guard for that case is the private sentinel
 * `MNEMEX_KEYCHAIN_TEST_GUARD=1`, which makes `enableRealKeychainAccess()` a
 * no-op. But the only writer of that sentinel was `bunfig.toml`'s `[test] preload`,
 * and `bun` resolves `bunfig.toml` against the CURRENT WORKING DIRECTORY and does
 * not walk up for it. Measured in this repository: `cd test && bun test ../x.test.ts`
 * leaves the sentinel unset. So a suite that forwarded `process.env` to a child
 * running `dist/index.js` forwarded NOTHING, the child enabled itself, and a
 * semantic `mnemex rg` reached `/usr/bin/security` against the developer's real
 * login keychain. `tests/rg.e2e.test.ts` was exactly that suite. The incident this
 * whole constraint exists to prevent — unanswerable macOS authorization dialogs,
 * one per spawn, on an idle re-lock timer — is that path.
 *
 * The rule is therefore: NEVER rely on inherited preload state for a child.
 * Set the sentinel EXPLICITLY, in the child's env, at every spawn site. The
 * static sweep in `test/unit/core/keychain.test.ts` rejects any test file that
 * spawns an entry point without doing so, so this cannot regress quietly.
 * ---------------------------------------------------------------------------
 */

/** The two variables a child that may execute a mnemex entry point must carry. */
export const KEYCHAIN_CHILD_GUARD_ENV = {
	/**
	 * Vetoes `enableRealKeychainAccess()` inside the child, so running the real
	 * composition root does not turn the gate on.
	 */
	MNEMEX_KEYCHAIN_TEST_GUARD: "1",
	/**
	 * Second, independent layer: the POLICY layer refuses before the adapter is
	 * even consulted, so no code path in the child reaches the port at all.
	 */
	MNEMEX_DISABLE_KEYCHAIN: "1",
} as const;

/**
 * The same shape, for the second machine-global user file a child can write.
 *
 * `~/.mnemex/embed-cache.db` is shared by every repo on the machine (CLAUDE.md
 * #31). `src/core/embed-cache.ts` refuses that path by default, but — exactly as
 * above — a child running the production entry point calls
 * `enableUserEmbedCachePath()` and lifts its own gate. This sentinel makes that
 * call a no-op, so a spawned `mnemex index` refuses instead of writing the
 * developer's real cache.
 *
 * A child that legitimately needs a working cache sets `MNEMEX_EMBED_CACHE_PATH`
 * to a temp file in `extra`. The refusal is deliberately loud, not a redirect.
 */
export const EMBED_CACHE_CHILD_GUARD_ENV = {
	MNEMEX_EMBED_CACHE_TEST_GUARD: "1",
} as const;

/**
 * `process.env` plus the guard variables, with `undefined`s dropped.
 *
 * Use this for EVERY `spawn`/`spawnSync` of `bun dist/index.js`, `bun src/index.ts`
 * or an installed `mnemex` binary. `{ ...process.env }` alone is the defect.
 *
 * The name is historical — it is THE child environment, and it now carries the
 * embed-cache sentinel too. Both are guards a child can only lift by running a
 * production entry point, which is precisely what these spawns do.
 */
export function keychainSafeChildEnv(
	extra: Record<string, string | undefined> = {},
): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	for (const [key, value] of Object.entries(extra)) {
		if (value !== undefined) env[key] = value;
	}
	// Last, so a caller's `extra` can never weaken the guard by accident.
	return {
		...env,
		...KEYCHAIN_CHILD_GUARD_ENV,
		...EMBED_CACHE_CHILD_GUARD_ENV,
	};
}
