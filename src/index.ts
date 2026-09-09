#!/usr/bin/env -S bun --env-file=/dev/null
// ^ --env-file=/dev/null stops bun's OWN .env auto-load (bun loads cwd .env,
//   .env.local and .env.$NODE_ENV into process.env before any user code runs);
//   dotenv below is then the only .env loader. Compiled binaries get the same
//   flag via --compile-exec-argv (package.json build:binary*, release.yml).
//   Spell it exactly this way: --no-env-file works in a shebang but leaks
//   through --compile-exec-argv. Without it a cwd .env could supply
//   TERM_THEME / MNEMEX_THEME indistinguishably from the real environment (FR3).

/**
 * mnemex - Local code indexing tool for Claude Code
 *
 * Entry point that supports two modes:
 * - CLI mode (default): Interactive command-line interface
 * - MCP mode (--mcp): Model Context Protocol server for Claude Code integration
 */

import { config } from "dotenv";
import { enableUserEmbedCachePath } from "./core/embed-cache.js";
import { enableRealKeychainAccess } from "./core/keychain.js";
import { runMigrations } from "./migration.js";
import { captureStartupEnv } from "./ui/theme-env.js";

// Snapshot TERM_THEME / MNEMEX_THEME / COLORFGBG / TERM from the REAL process
// environment before dotenv can inject keys from ./.env (theme feature, FR3).
// Two layers keep .env out of the theme: the shebang above stops bun's own
// auto-load, and this call runs before dotenv, the only remaining loader.
// Keep it above config().
captureStartupEnv();

// Load environment variables from .env file.
// quiet: true is required — dotenv >= 17 prints an "injected env" banner to
// stdout by default, which corrupts machine-readable output (notably `mnemex rg`,
// which must stay byte-identical to ripgrep) and any --agent mode consumer.
config({ quiet: true });

// THE ONLY PLACE real macOS Keychain access is turned on.
//
// `src/core/keychain.ts`'s adapter denies by default, so every process that is
// not this binary — a test in any working directory, a helper script, a fresh
// `bun somefile.ts` — refuses to spawn `/usr/bin/security` with no environment
// variable, no preload and no cwd involved. Do not call this from anywhere else,
// and do not replace it with an env var: an env var is inherited by every child,
// which is exactly the propagation that made the previous guard fragile.
//
// It is itself a no-op when MNEMEX_KEYCHAIN_TEST_GUARD=1, so a test that spawns
// this binary with the inherited environment still cannot reach the keychain.
enableRealKeychainAccess();

// THE ONLY PLACE the machine-global embedding cache at `~/.mnemex/embed-cache.db`
// is allowed to be opened.
//
// Same shape, same reason: `src/core/embed-cache.ts` refuses that path by
// default, so a test in any working directory — with no preload, no env var and
// no cwd involved — cannot create or write the user's real cache file. It is a
// no-op when MNEMEX_EMBED_CACHE_TEST_GUARD=1, so a test that SPAWNS this binary
// with a built child environment (test/helpers/child-env.ts) still cannot.
//
// The cache is an optimisation, but the file is a user's: a test that meant to
// point MNEMEX_EMBED_CACHE_PATH at a temp directory and forgot gets a refusal,
// not a silent redirect.
enableUserEmbedCachePath();

// Migrate .claudemem/ → .mnemex/ for existing users (silent, non-blocking)
runMigrations();

const args = process.argv.slice(2);

/**
 * Last-resort handler for anything that escapes an entry point.
 *
 * `runCli` already catches the error types it knows and prints one clean line
 * for each; those paths are unaffected. This exists for the rest, which until
 * now reached bun's default handler and were rendered as four frames of
 * minified `dist/index.js` paths, two "missing sourcemaps" notes and a bun
 * version banner — for operational failures whose message already says exactly
 * what to do ("Ollama has no model 'x': … try pulling it first").
 *
 * Rules this obeys:
 *  - stderr, never stdout. The MCP branch's stdout is the JSON-RPC stream, and
 *    a stray byte there corrupts the protocol (CLAUDE.md gotcha #14). stderr is
 *    correct in every mode, so there is no per-mode variant to get wrong.
 *  - the message verbatim. Several of these errors are deliberately multi-line
 *    and structured (IndexedModelUnavailableError names the model, the provider
 *    error and both ways out); re-wrapping or per-line prefixing would break the
 *    shape their authors chose.
 *  - a non-Error throw is still reported, via String(err), rather than silently
 *    becoming "undefined".
 *
 * The stack is not lost, only demoted: MNEMEX_DEBUG=1 prints it. That name
 * follows the user-facing MNEMEX_* env convention (MNEMEX_MODEL, MNEMEX_LLM,
 * MNEMEX_DOCS_ENABLED); the DEBUG_* names elsewhere in the tree are
 * area-scoped internals, not a product-wide switch.
 */
function fatal(err: unknown): never {
	const message = err instanceof Error ? err.message : String(err);
	process.stderr.write(`\n${message}\n`);

	if (process.env.MNEMEX_DEBUG && err instanceof Error && err.stack) {
		process.stderr.write(`\n${err.stack}\n`);
	}

	process.exit(1);
}

// Check for MCP server mode
const isMcpMode = args.includes("--mcp");
const isAutocompleteServerMode = args.includes("--autocomplete-server");

if (isAutocompleteServerMode) {
	// Autocomplete server mode (JSONL-RPC over stdio)
	const projectIdx = args.indexOf("--project");
	const projectPath = projectIdx !== -1 ? args[projectIdx + 1] : undefined;

	import("./autocomplete/server.js")
		.then((module) => module.startAutocompleteServer({ projectPath }))
		.catch(fatal);
} else if (isMcpMode) {
	// MCP server mode - lazy load to keep CLI startup fast
	import("./mcp/server.js")
		.then((module) => module.startMcpServer())
		.catch(fatal);
} else {
	// CLI mode
	import("./cli.js").then((module) => module.runCli(args)).catch(fatal);
}
