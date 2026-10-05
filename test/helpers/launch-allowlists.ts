/**
 * THE TWO PROCESS-LAUNCH ALLOWLISTS, in one module so that the regex sweep
 * (`test/unit/core/keychain.test.ts`) and the import-resolving graph rule
 * (`test/unit/core/launch-capability-graph.test.ts`) read the SAME tables.
 * Two copies would drift, and the round-8 finding was precisely that a static
 * guarantee had drifted from what was enforced.
 *
 * Neither list is a "known-safe call sites" list. Each entry is a FILE that is
 * permitted to hold a capability, with a one-line reason a reviewer can
 * disagree with. Both consumers fail on a STALE entry (file gone, or no
 * capability in it any more), so neither table can rot.
 */

/**
 * The ONE production file that PERFORMS a mnemex entry-point launch. Every
 * process it starts is chosen by the exporting function, not by the caller
 * (`spawnMnemexDetached`, `spawnMnemexAwaited`, `spawnSelfDetached`,
 * `runSelfSync`); round 6 removed the last generic command-taking export.
 */
export const ENTRY_LAUNCHER = "src/core/entry-point-launcher.ts";

/**
 * KIND 1 — PRIMITIVE. Every production file that may obtain a process-launch
 * PRIMITIVE (`node:child_process`, `Bun.spawn*`, `Bun.$`, `$`/`spawn` from
 * `"bun"`, `process.binding`, a third-party runner), with the reason. Keys are
 * repo-relative.
 */
export const PROCESS_LAUNCH_ALLOWLIST: Readonly<Record<string, string>> = {
	[ENTRY_LAUNCHER]:
		"THE launcher: the only file that PERFORMS a mnemex entry-point launch (behind the runtime veto); a bounded set of callers may REQUEST one through its purpose-specific exports — see LAUNCHER_CALLER_ALLOWLIST",
	"src/core/keychain.ts":
		"the keychain port: the only file that may spawn /usr/bin/security (deny-by-default + sentinel + latch + budget)",
	"src/cli.ts":
		"`mnemex rg`: the bundled ripgrep binary at an absolute path from @vscode/ripgrep",
	"src/mcp/tools/search-pattern.ts":
		"`which`, `rg` and `grep` for the pattern-search MCP tool",
	"src/lsp/client.ts":
		"the LSP server named by caller-supplied config (typescript-language-server, gopls, ...)",
	"src/updater/index.ts":
		"npm/bun/brew acting ON the package (`install -g mnemex@latest`, `brew upgrade mnemex`); does not execute the entry point",
	"src/tui/setup/hardware.ts":
		"hardware probes: sysctl/system_profiler, nvidia-smi, rocm-smi",
	"src/tui/setup/screens/CloudSetup.tsx":
		"read-only `git remote get-url origin`",
	"src/tui/setup/screens/ModelSelect.tsx": "`ollama pull <model>`",
	"src/tui/admin/CreateKeyView.tsx":
		"`pbcopy` — clipboard write of a freshly created API key",
	"src/tui/components/command/BenchmarkResults.tsx":
		"`open`/`start`/`xdg-open` on a benchmark report path",
	"src/learning/validation/environment-manager.ts":
		"Bun `$` tags for git and docker; `DockerEnvironment.exec` runs INSIDE a container, never on the host",
	"src/cloud/config.ts":
		"read-only `git remote get-url origin` via promisified exec",
	"src/cloud/git-diff.ts":
		"read-only `git diff`/`git log` via promisified exec, with GIT_PAGER=cat; and the local dirty overlay's `git --no-optional-locks status -z` via execFile (no shell, GIT_* stripped, GIT_OPTIONAL_LOCKS=0) — the overlay reaches git only through this file",
};

/**
 * KIND 2 — LAUNCHER CALLER. Every production file that may hold a VALUE
 * binding to an export of `ENTRY_LAUNCHER` (import it, alias it, or receive
 * it through a re-export chain), with the reason. Calling one is a launch
 * REQUEST; the launcher still decides what runs and the runtime veto still
 * applies. A file on this list that stops holding the capability is a stale
 * entry and fails the no-rot check.
 *
 * NOT on the list, and deliberately so: `src/editor/editor.ts` imports only
 * `type DetachedEntryPointLauncher`. A type import is erased and can launch
 * nothing; `SymbolEditor` receives its launcher as a constructor argument from
 * `src/mcp/server.ts`, which IS listed. If the editor ever imports a value
 * from the launcher, the graph rule flags it and this table must be argued
 * with, not silently extended.
 */
export const LAUNCHER_CALLER_ALLOWLIST: Readonly<Record<string, string>> = {
	"src/mcp/reindexer.ts":
		"exports the injected production launcher for `DebounceReindexer`; it delegates to `spawnMnemexDetached(args, cwd)` and chooses only the argv",
	"src/mcp/server.ts":
		"imports `spawnMnemexDetached`/`spawnMnemexAwaited` ONLY to inject them into `DebounceReindexer`, `SymbolEditor` and `runBlockingIndex`; calls none itself (import-only, reported as info)",
	"src/hooks/handlers/session-start.ts":
		'`runSelfSync(["status", "--nologo"])` — asks the running build for index status at session start',
	"src/hooks/handlers/pre-tool-use.ts":
		"`runSelfSync(args)` — asks the running build a search question before a tool call",
	"src/hooks/handlers/post-tool-use.ts":
		'`spawnSelfDetached(["index", "--quiet"])` — background reindex of the running build after an edit',
};
