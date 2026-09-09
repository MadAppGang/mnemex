# mnemex Development Guide

## Publishing
- We publish with CI/CD (automated releases)

## Architecture Overview

mnemex is a local semantic code search tool that combines:
- **AST parsing** (tree-sitter) for intelligent code chunking
- **Embeddings** (OpenRouter/Ollama) for semantic similarity
- **Symbol graph** with PageRank for importance ranking
- **LanceDB** for local vector storage

### Core Modules

```
src/
├── core/
│   ├── analysis/        # Code analysis (dead-code, test-gaps, impact)
│   │   ├── analyzer.ts      # CodeAnalyzer class
│   │   └── test-detector.ts # Language-aware test file detection
│   ├── graph/           # Symbol graph with PageRank
│   ├── enrichment/      # LLM-based code summaries
│   ├── indexer/         # Code indexing pipeline
│   ├── search/          # Hybrid search (vector + BM25)
│   └── watcher/         # File system watcher
├── git/                 # Git hook integration
│   └── hook-manager.ts  # Post-commit hook management
├── cli.ts               # Main CLI entry point
├── mcp-server.ts        # MCP server for Claude Code
├── ai-instructions.ts   # Role-based AI agent prompts
└── ai-skill.ts          # Skill documents for embedding
```

## Key Commands (v0.3.0)

### Symbol Graph
- `map [query]` - Repo structure with PageRank ranking
- `symbol <name>` - Find symbol definition
- `callers <name>` - What depends on this symbol
- `callees <name>` - What this symbol depends on
- `context <name>` - Full context: symbol + callers + callees

### Code Analysis
- `dead-code` - Find unused symbols (zero callers + low PageRank)
- `test-gaps` - Find untested high-PageRank symbols
- `impact <name>` - Transitive callers across all files

### Developer Experience
- `watch` - Auto-reindex on file changes (daemon)
- `hooks install` - Git post-commit hook for auto-indexing

## Development Patterns

### Adding New Commands
1. Add command case in `cli.ts` switch statement
2. Create handler function following existing patterns
3. Update help text in `printHelp()` function
4. Update README.md CLI reference section
5. Update ai-instructions.ts and ai-skill.ts for AI agents

### Code Analysis Pattern
```typescript
import { createCodeAnalyzer } from "./core/analysis/index.js";

const analyzer = await createCodeAnalyzer(projectPath);
const results = analyzer.findDeadCode({ maxPageRank: 0.001 });
```

### Test File Detection
Uses language-specific patterns:
- TypeScript/JS: `*.test.ts`, `*.spec.ts`, `__tests__/`
- Python: `test_*.py`, `*_test.py`, `tests/`
- Go: `*_test.go`
- etc.

## Testing

```bash
# Run tests
bun test

# Type check
bun run typecheck

# Build
bun run build
```

## AI Integration

### AI Instructions (ai-instructions.ts)
Role-based prompts for different agent personas:
- `architect` - System design, dead-code detection
- `developer` - Implementation, impact analysis
- `tester` - Test coverage gaps, test planning
- `debugger` - Error tracing, bug impact

### AI Skills (ai-skill.ts)
Multiple skill document variants for different contexts:
- `MNEMEX_SKILL` - Full comprehensive skill (~200 lines)
- `MNEMEX_SKILL_COMPACT` - Tight context budgets
- `MNEMEX_MCP_SKILL` - MCP server integration
- `MNEMEX_QUICK_REF` - Minimal token reference

## Evaluation

Evaluation and benchmark work lives in the sibling `../mnemex-bench/` repo. (The old `../agentbench/` pointer is dead — that directory no longer exists, and the `agentbench-eval` skill still describes that layout.)

Layout: `../mnemex-bench/experiments/` holds numbered, self-contained experiment directories, each with its own README. Currently 001–012, e.g. `009-mnemex-vs-serena`, `011-n-way-code-tool-benchmark`, `012-swebench-context-ablation`. Start at `../mnemex-bench/README.md`.

## Common Gotchas

1. **Always use `--agent`** for machine-parseable output (replaces --nologo --raw --plain)
2. **PageRank > 0.05** indicates high-importance symbols
3. **Test file detection** is language-specific (see test-detector.ts)
4. **Impact analysis** uses BFS with depth limiting to avoid infinite loops
5. **Watch mode** uses native `fs.watch` (no external deps like chokidar)
6. **OpenTUI `<text>` overlap**: Multiple `<text>` siblings in a `<box>` render at (0,0). Use single `<text>` per `<box>`, or `<box flexDirection="row">` with each `<text>` in its own `<box>`
7. **OpenTUI `screenMode: "main-screen"`** appends lines on re-render instead of overwriting — not suitable for progress bars. Use ANSI cursor-based rendering (`\x1b[${lines}A`) for progress displays. (OpenTUI ≥ 0.5 replaced the boolean `useAlternateScreen` with `screenMode: "alternate-screen" | "main-screen" | "split-footer"`.)
8. **CLI alias ordering**: Flag-style command aliases (e.g. `--watch` → `watch`) must mutate `args` BEFORE `const command = args[0]` to take effect
9. **Data directory**: mnemex uses `.mnemex/` (migrated from `.claudemem/` automatically on first run)
10. **Env vars**: `MNEMEX_MODEL`, `MNEMEX_LLM`, `MNEMEX_DOCS_ENABLED` (renamed from CLAUDEMEM_*). Also **`MNEMEX_DISABLE_KEYCHAIN=1`** — a *user-facing* opt-out for the macOS Keychain secret backend (persistent form: `"keychain": false` in `~/.mnemex/config.json`), NOT a test mechanism; and `MNEMEX_KEYCHAIN_FILE`, a user/CI redirect to a non-login keychain. Never drive a throwaway keychain from an interactive session: it re-locks on its idle timer and raises authorization dialogs whose password only the tooling knows.
11. **Wire protocol migration**: HTTP headers renamed `X-ClaudeMem-*` → `X-Mnemex-*`. Server accepts BOTH during migration window; clients send only `X-Mnemex-*`. See `src/cloud/server/middleware.ts` for dual-read logic. Do NOT remove legacy fallback until all deployed clients have upgraded.
12. **Homebrew formula**: lives in the unified tap at `../homebrew-tap/Formula/mnemex.rb` (repo `MadAppGang/homebrew-tap`). The old `homebrew/claudemem.rb` formula in this repo has been deleted.
13. **Fresh checkout needs 3 steps before `bun test` means anything**: `bun install` → `bun run download-grammars` → `bun run build`. Grammars are gitignored and fetched at build time; several e2e suites spawn the built `dist/index.js` and fail their preconditions without it. Skipping either step produces mass failures that look like code breakage. Any dependency change also invalidates `dist/` — rebuild before testing or you will misattribute staleness to the dep.
14. **`dotenv` must be loaded with `quiet: true`** (`src/index.ts`). dotenv ≥ 17 prints an "injected env" banner to stdout by default, which corrupts `mnemex rg` (contractually byte-identical to ripgrep) and every `--agent` consumer.
15. **Vector dimension is locked at table creation**: LanceDB infers schema from the first batch, so empty embeddings create a permanently unqueryable `FixedSizeList[0]` column. Four guards exist because this failed four different ways; do not remove any of them.

    **Where the empty vectors came from (the root cause, fixed in 0.34.0).** `OllamaEmbeddingsClient.embed` caught per-chunk errors, pushed `[]` and continued, re-throwing only for `ECONNREFUSED`. A model the provider does not have returns 404 for *every* chunk, so every vector was empty and the table was born `FixedSizeList[0]`. The lesson generalises past this one client: a 100% failure rate is never a per-item condition, and an embeddings client that can return `[]` is a corrupt-index generator. `isFatalEmbeddingFailure()` / `assertNotTotalFailure()` in `src/core/embeddings.ts` hold that line for the Ollama, OpenRouter and Voyage clients, and `embedOne` refuses a zero-length vector.

    **Write side**: `assertVectorDimension()` rejects a 0-dim batch at all three write paths. **Read side**: `assertQueryableTableDimension()` rejects `listSize === 0` in `ensureTableOpen()`, the one place every read and write opens the table — reaching native code with such a table panics in Rust on LanceDB 0.13 (`attempt to divide by zero`, uncatchable from JS), raises `LanceError(Schema)` on 0.33+, and returns zero rows in silence on a scan. Compare against `0`, never truthiness; `0` is falsy and is the only value worth catching. **Repair**: an already-corrupt index is now detected at open and rebuilt by the next index run — `clear()` drops the table without going through `ensureTableOpen()`, which is what keeps the repair path reachable. LanceDB ≥ 0.33 refuses to *create* a 0-dim column at all, so only an index written by an older build can be in this state — which also means the fixture cannot be constructed in a test. See `docs/lancedb-0.33-migration-research.md`.

16. **An embedding model name does not identify its provider**: `createEmbeddingsClient` infers the provider from the model *string* — `voyage*` → voyage, `ollama/` → ollama, `lmstudio/` → lmstudio, anything containing `/` → openrouter — and otherwise keeps whatever `config.embeddingProvider` says *right now*. A bare stored name like `nomic-embed-text` matches no rule, so reading it back and rebuilding a client sends it to today's configured provider, not the one that wrote it. This is why the indexer records `embeddingProvider` in tracker metadata beside `embeddingModel`, and why `onModelMismatch: "use-indexed"` passes both into `createEmbeddingsClient`. Indexes written before 0.34.0 have no provider on record; that case is reported by name rather than guessed.
17. **Native/platform deps must be `--external` in `build`**: `@lancedb/lancedb`, `better-sqlite3`, `@opentui/core`, `@opentui/react`. OpenTUI ≥ 0.5 ships 8 per-platform binaries; bundling it makes the build fail resolving the ones for other platforms.
18. **Ollama Cloud is generation-only**: `ollama-cloud/<model>` (e.g. `MNEMEX_LLM=ollama-cloud/gemma4:31b`) routes to `https://ollama.com/v1` via the "local" provider and needs `OLLAMA_API_KEY`. Its `/api/embed` route returns **401 for every model**, so it can NOT back `embeddingProvider`. Use `openrouter` (or local Ollama) for embeddings. Benchmarked on code summarization: `gemma4:31b` 714ms/22 output tokens beats `qwen3.5:397b` 10.3s/807 tokens at equal quality — prefer non-reasoning models for enrichment.
19. **`zod` is pinned via `overrides`; the MCP SDK must share ONE copy with the root.** Two zod majors visible to `src/mcp/tools/**` make the MCP SDK's `zod-compat` `AnySchema` union collapse, giving TS2589 "excessively deep" errors. Without `overrides.zod`, bun flips the SDK's nested copy between 3.x and 4.x across installs, so typecheck passes or fails depending on install order — always keep the pin.

    The tree is on zod 4. `@lmstudio/sdk` declares `^3.22.4` and throws on client construction under zod 4, so `overrides["@lmstudio/sdk"].zod` holds it at 3.x. **npm honours that nested override (verified in `package-lock.json`: root 4.4.3, lmstudio 3.25.76).** Bun used to ignore nested overrides and hand lmstudio the root zod 4; **as of bun 1.4.0 it honours them too** — `bun.lock` moved to `lockfileVersion: 3`, which records nested overrides, and now resolves `@lmstudio/sdk/zod` to 3.25.76 while root zod stays 4.4.3. So the LM Studio **model-size metadata** casualty (LM Studio chat is unaffected — it goes through the OpenAI-compatible `LocalLLMClient`) no longer applies on bun ≥ 1.4.0; `warnLMStudioSdkUnavailable()` in `src/llm/providers/local.ts` should now stay quiet. Do not "simplify" by deleting the nested override: both package managers realise it.

    **Pin the bun version in CI.** `bun-version: latest` floated from 1.3.10 to 1.4.0 and broke `main` — 1.4.0 validates that `bun.lock` records the manifest's overrides, which `lockfileVersion: 1` did not, so `--frozen-lockfile` failed on files that were fine the day before and still passed locally. Both workflows now pin `1.4.0`. Regenerating the lockfile requires the pinned version: an older bun reports "no changes" and cannot produce a lock the newer one accepts.
20. **Progress callbacks must stamp the lock, not just the UI**: `reportProgress()` advances `lastProgressAt`, which is the *sole* input to the hung/stale decision (`lock.ts`, `DEFAULT_PROGRESS_TIMEOUT` = 5 min). `heartbeat` ticks every second regardless and proves nothing. Any long-running loop (embedding, code-unit embedding, docs embedding, enrichment, symbol extraction) must call it per item — stamping only at batch end let a **healthy** run sit 351–363s without progress, past the threshold, making the lock reclaimable and allowing a second indexer onto the same store. Phase labels must also match the work actually running, or stalls get misattributed.

21. **A `private xReady = false` guard on a per-request object never fires**: three separate defects had this exact shape — `FeedbackStore.initializeSchema()`, `FileTracker`'s constructor DDL, and `ensureFtsIndex()`. Each guarded expensive-but-idempotent setup with a per-INSTANCE flag, inside a class constructed once per request, so the setup ran on every call. `IF NOT EXISTS` and `replace: true` make these operations look free; they are idempotent, which is not the same as cheap. Costs measured before fixing: FTS index rebuilt per query at **275 ms** (~50% of search latency), `FileTracker` at **346 µs**, feedback-store DDL at **190 µs**. When reviewing any such guard, do not ask whether it is correct — ask how often the enclosing object is constructed. Memoize on real resource identity (`PRAGMA database_list` file + inode is the established sqlite key here) and always exclude in-memory databases, which report `""` and genuinely need their own setup.

22. **`store.ts` needs THREE SQL-escaping rules, chosen by operator context**: LanceDB 0.33 has no parameterized predicate API (`Table.delete`, `countRows` and `Query.where` all take a pre-rendered string), so escaping is the caller's job — and any uniform rule breaks something. Equality and `IN` over arbitrary values need quote-doubling only (`escapeSqlLiteral`); `LIKE` patterns need quote-doubling **plus** backslash-escaping of `%` and `_` (`escapeFilterValue`); an `IN` over a closed union with no quotes (`DocumentType`) needs no escaping at all. SQL string literals do not process backslash escapes, so the LIKE escaper in an equality predicate renders `filePath = 'src/my\_file.ts'` and matches **zero rows** — that is what silently disabled incremental-reindex vector reuse for underscored filenames, and what made every type-filtered enriched search return nothing (10 of 11 `DocumentType` members contain an underscore). A test pins the two helpers apart; do not "unify" them. The durable fix is a predicate-builder seam that takes values rather than fragments, so the operator context picks the escaper — proposed, not built.

23. **The shebang in `src/index.ts` and `--compile-exec-argv` in the binary builds carry `--env-file=/dev/null`** because bun auto-loads cwd `.env` into `process.env` before any user code runs; without it `TERM_THEME`/`MNEMEX_THEME` from a `.env` file are indistinguishable from the real environment (FR3 of the theme feature). `dotenv` in `src/index.ts` is the only `.env` loader. Dev runs need `bun --env-file=/dev/null src/index.ts` to get the same behaviour. The spelling must be `--env-file=/dev/null` (not `--no-env-file`, which leaks through `--compile-exec-argv`).

24. **No test may spawn `/usr/bin/security`, ever — the adapter DENIES BY DEFAULT.** `src/core/keychain.ts` does not spawn until `enableRealKeychainAccess()` has been called, and `src/index.ts` is the **only** caller. Nothing under `src/**` else, and no test, turns it on. Do not replace this with an environment variable: an env var is inherited by every child, which is the propagation that made the previous guard fragile.

    The previous design was allow-by-default plus three refusals, and it looked like four independent layers. It was not. `MNEMEX_KEYCHAIN_TEST_GUARD` and `MNEMEX_DISABLE_KEYCHAIN` had ONE writer — `bunfig.toml`'s `[test] preload` — and `bun` resolves `bunfig.toml` against the **current working directory** without walking up. Measured: `cd test && bun test ../x.test.ts` leaves both unset, and a fresh process has not yet tripped the `setKeychainTestDeps` latch, so all of them were absent at once and the next read hit the real login keychain.

    The remaining layers are vetoes on top, and each covers a case deny-by-default does not: the `MNEMEX_KEYCHAIN_TEST_GUARD=1` sentinel (set by the preload AND at module scope in `test/helpers/keychain-stub.ts`) makes `enableRealKeychainAccess()` a **no-op**, which is what stops a test that spawns the real binary; the `testDepsEverInstalled` latch is never cleared, including by `setKeychainTestDeps(null)`; and `test/unit/core/keychain.test.ts` carries a static sweep over **both** test roots (`test/` and `tests/`) covering `Bun.spawn`, `node:child_process`, the Bun shell tag and a hoisted binary path, run against comment-stripped source so the prose next to it is not a false positive.

    This rule exists because driving a throwaway keychain flooded the user's screen with authorization dialogs nobody could answer. A green e2e run is **not** evidence the keychain path works — suites that spawn `dist/index.js` set the sentinel explicitly, so they exercise the degraded config-file path.

    **Three bypasses of this rule reached the tree and were found by external review, not by three Claude passes.** Each one is now closed by a mechanism AND a test that asserts on a spawn count or on bytes:

    - **A test that spawns an entry point turns the gate ON inside the child.** `src/index.ts` calls `enableRealKeychainAccess()`; deny-by-default cannot cover the shape whose whole job is to lift it. The sentinel is the veto, and `tests/rg.e2e.test.ts` forwarded `{...process.env}` without setting it — so `runMnemexRg()` -> semantic search -> `getVoyageApiKey()` -> `realRun()` reached `/usr/bin/security`. **Every helper that launches `dist/index.js`, `src/index.ts` or the installed binary must build its child env with `keychainSafeChildEnv()` (`test/helpers/child-env.ts`), never `{...process.env}`.** The sweep now rejects an entry-point spawn that does not.
    - **`setRealKeychainAccessEnabledForTests(true)` wrote the production gate.** Replaced with `disableRealKeychainAccessForTests()`, which cannot set it. The sweep rejects any re-introduction, in `src/` as well as the test roots.
    - **The DEFAULT LLM provider had its own `execSync` on a RELATIVE binary name.** `src/llm/providers/claude-code.ts` read Claude Code's OAuth token outside the port entirely: no gate, no sentinel, no budget, and a PATH hijack (CWE-426) handing a planted binary `-w` and the token. It now goes through `readGenericPassword()`. **The sweep scans `src/` too** — `src/core/keychain.ts` is the one file allowed to spawn the binary. Search and status paths no longer construct the LLM client at all (`initialize(forSearch)`), so they pay no credential read.
    - **The entry-point launcher read only the sentinel; the keychain adapter read the sentinel OR the seam latch.** A suite with no `bunfig.toml` in its cwd that called `setKeychainTestDeps(...)` then `setKeychainTestDeps(null)` was denied in-process and then launched an unguarded child. There is now ONE predicate, `guardedProcessReason()` in `src/core/keychain.ts` (which owns the latch and has no imports, so no cycle), and `src/core/entry-point-launcher.ts` imports it. `test/unit/core/launcher-latch-guard.test.ts` proves it with a child whose sentinel is genuinely absent. **Process launch in `src/` is an allowlist, not an argument regex**: any file that obtains a launch capability (`node:child_process` by any import form, `Bun.spawn*`/`Bun.$`, `$`/`spawn` from `"bun"`, a known third-party runner) must be in `PROCESS_LAUNCH_ALLOWLIST` (`test/helpers/launch-allowlists.ts`, consumed by `test/unit/core/keychain.test.ts`) with a one-line reason; the argument-shaped entry-point detector then runs over allowlisted files only. Consequence: `spawn("git", ["grep", "mnemex"])` in a non-allowlisted file fires because it is a launch, not because of the argument. Fixtures: `test/testdata/launch-allowlist/`.
    - **That regex sweep sees PRIMITIVE acquisitions only.** It cannot see a capability obtained by importing a LOCAL module, nor an alias (`const runtime = Bun`, `globalThis["Bun"]`, `process["binding"]`, `const { spawn: s } = cp`, a re-export chain) — external review found `src/mcp/reindexer.ts` importing a generic `launchEntryPointDetached(command, …)` and feeding it `"mnemex"` while the allowlist claimed the launcher was "the only file that may name or start" the entry point. The precise statement, now enforced: the launcher is the only file that PERFORMS an entry-point launch (its exports each choose their own target; the generic command-taking export is gone), and a bounded set of callers may REQUEST one — `LAUNCHER_CALLER_ALLOWLIST` (5 files, same module). `test/unit/core/launch-capability-graph.test.ts` enforces both kinds with a tree-sitter-based, import- and alias-resolving taint analysis over `src/**` (`test/helpers/launch-capability-graph.ts`; ~0.8 s for 400 files). It reads source and executes none. Documented limits (function bodies are not summarised; parameter taint is same-file only) are in `test/testdata/launch-capability/README.md`. `typescript` in this tree is 7.x (the Go port): `ts.createSourceFile` is `undefined` and its only JS API spawns the binary, so the compiler API is NOT an option for a test that forbids spawning.

    Prove this class of property with a **real spawn count**, never with a proxy for one. Two counters, covering the two ways the binary can be named:

    - `realKeychainSpawnCount()` — a monotonic counter incremented at the ONE choke point in `realRun`, immediately before `Bun.spawnSync` and **after** all three vetoes. No setter, no reset, so `setKeychainTestDeps` cannot launder it. This covers the pinned **absolute** path.
    - A **decoy** binary named `security` planted first on `PATH` whose invocation appends its argv to a marker file. This covers a **relatively**-resolved binary, which the absolute counter cannot see.

    **`keychainProcessBudgetUsedMs()` is MILLISECONDS and must never stand in for a spawn count.** This is not hypothetical — it shipped and was caught. `runGuarded` charges `Date.now() - started` around `deps.run`, and a *refused* call still traverses that timed region: 0 ms on an idle machine, **1 ms** under full-suite load. The guard test therefore passed in isolation and failed in the full run, while the security property was intact throughout. Measured during the fix: **0 spawns cost 1 ms under load; 2 real spawns cost 3-5 ms.** The ranges are adjacent, so no millisecond threshold could ever have separated them. A test in `keychain-entrypoint-guard.test.ts` now sweeps both test roots and rejects any equality-to-zero assertion on a budget reading. Using budget-as-budget (the pre-flight clamp, the timeout arithmetic in `keychain.test.ts`) remains correct; counting spawns with `stub.calls.length` also remains correct.

    Falsify a no-spawn assertion **without spawning `security`**: copy `src/core/keychain.ts` to a temp file, repoint `SECURITY_BIN` at `/usr/bin/true`, remove the vetoes, and run the child against the copy. Done during this fix — the committed assertion went red with `Expected: 0 / Received: 2`. See `test/unit/core/keychain-entrypoint-guard.test.ts`. A report object cannot show a spawn that happened, and neither can a stopwatch.

    **The same class of assumption applies to test helpers that write `~/.mnemex/config.json`.** `GLOBAL_CONFIG_DIR` is a module-level const from `homedir()`, and Bun's `homedir()` **ignores** a runtime `process.env.HOME` reassignment. A helper must be a child process with `HOME` in its env, and must prove it: `test/helpers/sandbox-guard.ts` refuses unless `homedir()` agrees with `MNEMEX_TEST_SANDBOX_HOME` and is inside `tmpdir()`. A review probe that reassigned `HOME` at runtime wrote to a real user's config file. Note also that `bun run` creates `$HOME/Library/Caches/bun` before any of our code executes, so a child pointed outside the temp tree litters whatever directory it names.

25. **Never strip a secret from `config.json` without a verified write, and remember a spread cannot delete.** `saveGlobalConfig` omits a secret field **iff** this save both received it and proved the keychain holds that exact value (verified write, or a byte-identical read). Two halves: `persistSecrets` omits it from `jsonSafe`, and `saveGlobalConfig` then **deletes it from the merged object** — `{...existing, ...jsonSafe}` takes it straight back out of `existing`, which would write the secret back in plaintext while the CLI printed "It is NOT in ~/.mnemex/config.json". Only `keychain` and `cleared` outcomes are deleted; a **failed** write must leave the incoming value in the file. The delete side is symmetric: a delete that was not confirmed reports `clear-failed` and keeps the field.

    Two corollaries, each a defect that reached the tree because the invariant was stated over one object while the code operated on a differently merged one:

    - **An explicit `undefined` means UNTOUCHED, not delete.** Only `""` clears. `{...existing, ...jsonSafe}` lets an `undefined` value overwrite a real one and `JSON.stringify` then drops the key, so `saveGlobalConfig({ openrouterApiKey: undefined })` destroyed a plaintext-only key with `outcomes: []` — no keychain call, nothing in the report. `persistSecrets` strips every `undefined`-valued key before the merge, for **all** fields, not just secrets. Removing a field is `removeGlobalConfigFields`'s job.
    - **A value that came FROM the keychain is never written to the file.** `loadGlobalConfigWithSecrets()` overlays keychain values onto the object it returns, that object comes back to `saveGlobalConfig`, and an unprovable write then kept them "safe" in `config.json` — in plaintext. Observed on a real config file, which gained live `voyageApiKey` and `context7ApiKey` values. Provenance is recorded in `hydrateSecrets` and consulted by `recordUnproven`; a user-typed value in the same save is still kept, because the two rules are decided per field.

    - **`keychain` means PROVEN BY THIS SAVE, and it is the only disposition (with `cleared`) that may delete from the file.** Provenance (`keychainSourced`) is a Set per field that is never cleared short of a proven delete, so it answers "this process saw these bytes once", not "the keychain holds them now". Recording an unproven write as `keychain` made `saveGlobalConfig` delete a **live, unrelated plaintext credential** and made the CLI report a store that never happened — defect D1's fourth variant, found by two external models from opposite ends. The I5 case now has its own disposition, **`keychain-sourced-omitted`**: it omits the value from `jsonSafe` (so no NEW plaintext copy is written) and does **not** delete from `merged` (so an EXISTING one is not destroyed on no evidence). It is reported in `omittedKeychainSourced`, never in `storedInKeychain`.

    When a test claims either property, assert on the **bytes on disk** (`test/unit/config/global-config-write.test.ts`, `test/unit/config/keychain-disposition-proof.test.ts`), never on `report.outcomes` or `stub.calls`. Every occurrence of this bug class has been invisible to the report.

25a. **ONE cross-process credential lock, and it FAILS CLOSED.** `save`, `migrate`, `prune` and `rm` all run inside `withConfigLock()` (`src/config.ts`); `status` is read-only and stays outside. An unavailable lock throws `ConfigLockUnavailableError` and the command changes nothing — the old `acquireConfigLock()` returned `null` after 2 s and `saveGlobalConfig` did its read-modify-write anyway, which is not a lock.

    The race it closes is **cross-resource** (CWE-367), so no per-resource check can close it: `prune` reads `A` from the keychain and marks the config line removable; `rm openrouter` sees the still-present plaintext `A`, so its last-copy guard permits the delete and it removes the keychain item; `prune` then deletes the line, its expected-value check passing because it only ever guarded the **file**. `A` now exists nowhere, and neither command needed `--force`. `prune` must therefore hold the lock from its raw file read through the file replacement, and `rm` across both its file read and its delete. The lock is **re-entrant within a process** because `prune` nests `removeGlobalConfigFields`, which takes the same lock. It also carries an ownership token, so a holder whose lock was reclaimed as stale cannot unlink the new owner's; and the `config.json.tmp.*` sweep now decides staleness by **mtime**, not by "a different pid is in the filename" — on Unix, unlinking a live writer's open tmp file succeeds silently.

26. **`persistSecrets` takes INCOMING fields only.** It never offers the keychain a value that came from `config.json`. A save carrying no secret (`saveGlobalConfig({ llmEndpoint })`) makes **zero** `security` calls. Widening it to the file-merged object re-creates a key-destruction path: a stale plaintext copy overwrites a value the user just edited in Keychain Access.app, with every report line saying success. Migration of file-resident plaintext is the separate, opt-in `mnemex keychain migrate` / `prune` pair, which never overwrites a stored item. **`migrate` refuses entirely when the enumeration failed**, because `KeychainEnumeration.accounts` is empty when `failed` and reading that as "nothing is stored" is the same bug through a different door. **`prune` does not enumerate at all**: it re-verifies each id with its own fresh `readKeychainAccount()`, refuses per id on a mismatch, and aborts the whole prune (writing nothing) only if a read itself fails.

27. **Keychain time is bounded per PROCESS, not per call.** `Bun.spawnSync` blocks the event loop, and a locked keychain burns each spawn's full timeout, so `lock.ts`'s 1 s heartbeat cannot fire and `isLockStale`'s 10 s secondary rule can hand a held index lock to a second indexer. Three mechanisms, with separate lifetimes: a 3 s burst memo + store-wide failure latch; a circuit breaker that `invalidateKeychainCache()` deliberately does **not** clear; and `KEYCHAIN_PROCESS_BUDGET_MS = 6000` applied as a **pre-flight clamp** on each spawn's timeout (a post-hoc check would let a spawn start at 5999 ms and block another 5 s). Worst case: 6000 blocked + up to 1000 of heartbeat phase = 7000 < 10000, i.e. 3 s of margin.

    **The bound rests on the clamp, not on hoisting.** `getDocsConfig` is resolved before `acquire()` and threaded into `createDocsFetcher`, but `initialize()` runs INSIDE the lock and still resolves credentials there (`createEmbeddingsClient` → `getApiKey`/`getVoyageApiKey`; `createLLMClient` → `getAnthropicApiKey`/`getApiKey`/`getOllamaApiKey`). An earlier comment claimed the region was spawn-free; it was not, and anyone raising `SPAWN_TIMEOUT_MS` or `KEYCHAIN_PROCESS_BUDGET_MS` while trusting that claim would reintroduce the double-indexer bug. The pre-lock hoist is a bonus, and it is gated on docs actually being enabled — calling `getDocsConfig` unconditionally added a Context7 keychain lookup to every index run of every project with docs switched off.

28. **`OLLAMA_API_KEY` is bound to the ollama.com ENDPOINT, not to the `local` provider.** `ollama-cloud/<model>` is not its own provider — it resolves to provider `"local"` pointed at `https://ollama.com/v1` (gotcha #18), and so do LM Studio and any endpoint a user persists through `mnemex init`'s custom-endpoint prompt. Resolving the key by provider type therefore attached `Authorization: Bearer <secret>` to **every** local client and shipped an Ollama Cloud credential to third-party and self-hosted servers. `src/llm/ollama-cloud.ts` owns the predicate; it parses the URL rather than substring-matching, because `https://ollama.com.evil.example` contains the host as a substring. Both **implicit** fallbacks are gated — the keychain/config lookup in `createLLMClient` and the bare `process.env.OLLAMA_API_KEY` read in `LocalLLMClient`'s constructor. An **explicitly passed** `apiKey` is always honoured, and an explicit `""` means no auth (use presence checks, not `||`). Assert this on captured request headers; a report object cannot show where a credential went.

29. **`excludePatterns` in `~/.mnemex/config.json` holds the user's ADDITIONS only.** `loadGlobalConfig` prepends all 102 `DEFAULT_EXCLUDE_PATTERNS` for the caller's convenience; writing that back grew the file by 102 entries on **every** save (measured on a real file: 408 entries, 102 unique, 306 duplicates). `saveGlobalConfig` normalises the merged object — defaults dropped, duplicates collapsed, user order preserved — which also heals an already-polluted file. Effective behaviour is unchanged because `getExcludePatterns` seeds its set with the defaults independently of the file.

30. **A boolean flag parsed by membership makes every TYPO of it mean the opposite.** `mnemex keychain migrate` decided its mode with `args.includes("--dry-run")`, so `--dry-runDD` was not an error — it fell through to the destructive default and ran a REAL migration. This is not hypothetical: it happened on the maintainer's machine one day after the feature shipped. `~/.zsh_history` records `bun run dev -- keychain migrate --dry-runDD` at epoch 1788822856, and the `voyage` and `context7` keychain items carry `cdat 20260907231416Z` — **the same second**. The user believed they had run a preview.

    `handleKeychainCommand` now rejects any unrecognised dash-argument BEFORE the credential lock and before any keychain access, using the per-subcommand `ACCEPTED_FLAGS` table (`status` and `prune` take none). It names the near-miss ("Did you mean --dry-run?"), because the failure mode is a typo, not a wrong flag. `--agent` is deliberately absent from the table: `runCli` filters it out of `args` before the handler sees it.

    Assert the property as **nothing was written** (`storedAfter`, `seamCalls`), never as an exit code alone — the pre-fix command exited 0 while writing. Falsified: neutering the check turns 5 of the 8 new tests red, including `migrate --dry-runDD refuses and writes NOTHING`. `--force`'s typo already failed safe, but only because its default points at refusing; it is pinned anyway, since the next flag's default may not.

31. **The embedding cache is MACHINE-GLOBAL, and nothing about the repository is in its key.** One SQLite file at `~/.mnemex/embed-cache.db` (`getEmbedCachePath()`, `embed-cache.ts:122-126`), shared by every repo, clone and worktree on the machine. That sharing IS the feature — a second worktree of a tree you have already indexed embeds nothing — so a "fix" that scopes the file per project deletes the reason it exists. A row is `sha256(model \0 dimension \0 text)` (`embedCacheKey`, `embed-cache.ts:68-76`), with the provider carried in the table's PRIMARY KEY beside the key rather than inside it (so one model name resolving to two providers gives two coexisting rows — #16 — instead of two rows evicting each other every run). Path, branch, commit, project and mtime are **not** in the key and nothing invalidates an entry: a rebase, a `git mv`, a re-clone and a `git worktree add` all hit the same rows, by design. Three consequences:

    - **A machine-global DEFAULT makes every test that reaches `index()` a writer of the user's real cache.** `Indexer.index()` calls `openEmbedCache()` with no path, so the moment this default landed, `~/.mnemex/embed-cache.db` was one forgotten `MNEMEX_EMBED_CACHE_PATH` away from any test in the tree. It took one: `test/unit/core/probes/indexer-model-mismatch.probe.ts` — written **before** the cache existed, and careful enough to redirect `MNEMEX_GLOBAL_LOCK_PATH` and `MNEMEX_DOCS_ENABLED` — created a 36,864-byte cache in a real user's home. Nothing in the probe was wrong; the default moved underneath it. This is #25's "a review probe … wrote to a real user's config file" with a different file, and `test/helpers/sandbox-guard.ts` already exists because of that one. The mechanism is #24's, not a per-file fix: `src/core/embed-cache.ts` **refuses** any path under `~/.mnemex` unless `enableUserEmbedCachePath()` has been called, and `src/index.ts` is its only caller (pinned by a sweep). It needs no env var, no preload and no cwd, so it also holds where `bunfig.toml` is never read (`cd test && bun test …`). A child that IS the entry point lifts its own gate, so `MNEMEX_EMBED_CACHE_TEST_GUARD=1` — set by `test/helpers/child-env.ts` at every spawn site and by the preload — makes that call a no-op. It **refuses rather than redirecting**: a test that meant to use a temp path and did not is a bug worth surfacing, and a silent redirect would leave it in place. Prove this class on the **bytes at the path** (`test/unit/core/embed-cache-user-path-guard.test.ts`), never on the refusal object; the red half runs the same child against a bundle with the throw cut out, over a decoy home, so the assertion is shown to fail without ever touching the user's file.
    - **The only invalidation that exists is the key changing.** Change the model and every entry for the old one is simply unreachable until LRU eviction reclaims it (2 GiB cap, `enforceBudget()` at the end of `indexInternal`, `indexer.ts:1906-1909`). Deleting the file is therefore always safe and costs exactly one re-embed.
    - **A transform applied to the text BELOW the seam is invisible to the key, and that is a corrupt-cache generator.** Truncation, a task prefix or an instruction template would make the cache serve a vector for text that was never embedded, under a key over the text that was. `embeddingTextFingerprint()` (`embeddings.ts`) is the ONE declaration of which clients transform their text, the cache's third veto compares it, and `truncateForModel` — zero callers today — carries a comment saying both must change in the same edit. Do not wire a text transform into a client without it.

    **Its SQLite work is bounded because `isLockStale` has TWO rules and #20's mechanism only covers one of them.** PRIMARY: `now - (lastProgressAt ?? heartbeat) > DEFAULT_PROGRESS_TIMEOUT` (300 000 ms, `lock.ts:99`, `:177-180`). SECONDARY: `now - heartbeat > DEFAULT_STALE_TIMEOUT` (10 000 ms, `lock.ts:91`, `:182-185`) — **30× tighter**. `recordProgress()` writes `lastProgressAt` only (`lock.ts:559-568`); `heartbeat` is written *only* by `startHeartbeat()`'s 1 s `setInterval` (`lock.ts:594-605`). Every call through `sqlite.ts` is SYNCHRONOUS, so it blocks the event loop, and a blocked loop cannot run that interval — #20's per-item stamping keeps the 300 s rule happy while the 10 s rule expires and a second indexer reclaims the lock. This is #27's mechanism with synchronous SQLite in place of `Bun.spawnSync`, and the arithmetic has the same shape:

    ```
    per-statement busy_timeout = floor( min(BUSY_TIMEOUT_MS, remaining budget)
                                        / region.blockingStatements )   ← applyClamp, at region entry

      ⇒ region busy-wait ≤ blockingStatements × perStatementMs ≤ 250 ms, for EVERY region

    B_max = 250  (busy-wait, whole region)
          + 250  (work: MAX_SYNC_REGION_MS — measured p99 of R1..R4 is 1.1-21.6 ms
                  on both drivers, plus one cold-file 208.8 ms outlier that three
                  repeat runs did not reproduce;
                  scripts/measure-embed-cache-regions.cjs re-runs it)
          = 500 ms

    max age of `heartbeat` when another process reads it
        = HEARTBEAT_INTERVAL + B_max + one lock-file write
        =       1000         +  500  +        ~1        = 1501 ms
        < DEFAULT_STALE_TIMEOUT = 10000                 margin 8499 ms (8.5 s)
    against the PRIMARY rule: 300000 / 500 = 600x.   (compare #27: 7000 < 10000, margin 3000)
    ```

    The clamp DIVIDES the allowance across a region's blocking statements because `busy_timeout` is **per statement**: R1 is 64 point SELECTs, so a flat 250 ms is 16 s of blocking, not 250 ms. Revision 2 of the design derived a "bound" of 1 250 ms from exactly that confusion and it bounded nothing. So: raising `BUSY_TIMEOUT_MS`, `CONTENTION_BUDGET_MS` or any region size (`LOOKUP_CHUNK` 64 / `WRITE_CHUNK` 256 / `EVICT_CHUNK` 512 / `VACUUM_PAGES` 2048) invalidates the arithmetic above — redo it. And never assert the bound with `stats().maxSyncRegionMs`: that is the class's self-report about its own blocking, the same category of evidence as a millisecond budget standing in for a spawn count (#24). Measure the gap between `setInterval` ticks from outside the process that does the blocking.

    **Upgrading an existing index to v3 costs one full re-embed of that repository, once.** `CURRENT_INDEX_VERSION = 3` adds the `embedKey` audit column, a v3 batch carries 23 fields and LanceDB 0.38 rejects it against a live 22-column table (`Found field not in schema: embedKey at row 0` — measured, and a fixture), so the v2→v3 branch (`indexer.ts:1048-1079`) is a plain `force = true` rebuild: no seeding pass, no in-place migration. **The seed was designed twice and deleted**, and that decision is worth not re-litigating cheaply: it read the vectors already in LanceDB into the cache so the rebuild would cost nothing, and it produced a CRITICAL in each of two review rounds — the second introduced by the fix for the first (a relative-vs-absolute path mismatch; never writing `model_dims`; no provider on record for the stored model name; deleting the `> 1` placeholder guard; an unverified dimension written into a machine-global row). Both failures ended in a run that printed `[migrating] seeded N vectors … rebuilding without re-embedding` and `totalTokens: 0` while building an index out of `[0]` placeholders or stale-width vectors. It optimised a ONE-TIME cost and bought nothing on run 2, nothing in the second worktree, nothing for any repo indexed afterwards. Because `index()` is not always human-driven — the git post-commit hook and the MCP search tool's auto-reindex pass no `onProgress` (`mcp/tools/search.ts:153-166` says so in as many words), so the `[migrating]` line reaches at most two of four entry points — the authoritative channel is data: `IndexResult.upgradedFromIndexVersion`, rendered as `Index upgraded: rebuilt from index version 2` and emitted as `upgraded_from_index_version` under `--agent`.

## Historical Artifacts

The following directories intentionally retain `claudemem` references — they are frozen records of decisions/outputs made under the old name. Do NOT rewrite them:

- **`src/migration.ts`** — runtime migration code that looks for `.claudemem/` directories. Renaming breaks migration for existing users.
- **`src/cloud/**`** — contains intentional `X-ClaudeMem-*` header fallback reads (legacy client compatibility). See gotcha #11.
- **`docs/adr/**`** — architecture decision records are historical. Rewriting them falsifies the record.
- **`ai-docs/sessions/**`, `ai-docs/seo-research-claudemem-positioning.md`, `ai-docs/design-reviews/**`, `ai-docs/research-paper-*/**`** — frozen session records, research artifacts, design reviews.
- **`experiments/query-expansion/results/**`** — frozen experiment JSON outputs from benchmark runs.
- **`experiments/query-expansion/training/**`, `experiments/query-expansion/bench/run-finetuned.py`** — training scripts that reference HuggingFace model names like `jackrudenko/claudemem-expansion-*`. These are **external identifiers** on HuggingFace — renaming here would point at non-existent repos.
- **`eval/mnemex-search-steps-evaluation/runs/**`** — frozen eval run outputs.
- **`.agents/skills/agentbench-eval/SKILL.md`** — agentbench skill doc; references in it describe the repo at a point in time.
- **Lockfiles** (`package-lock.json`, `bun.lock`, `vscode-extension/*-lock.json`) — regenerate on next install.
