# Changelog

All notable changes to mnemex are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow semver.

## [0.37.0] - 2026-10-05

Work you have already paid for is no longer paid for again. One index now serves every git
worktree of a repository, embeddings are cached once per machine, and search reflects the code
you have not committed yet. Three ranking defects are fixed along the way.

### Upgrade notes — read before upgrading

- **Every repository rebuilds its index once.** The index format moves to version 5 and its
  location moves to `<git-common-dir>/mnemex`, shared by all worktrees. The first `mnemex index`
  on this version rebuilds there and reports where the old index was (`abandoned_store_dir=` under
  `--agent`). **The old `.mnemex/` index is left in place, never deleted** — remove it yourself.
- **That first rebuild re-embeds each repository once.** The embedding cache is new in this
  release and starts empty. Every rebuild after it, and every other worktree of the same tree, is
  served from the cache.
- **Session observations do not survive the rebuild.** Observations recorded with the MCP
  `observe` tool live in the index and are not carried across. MCP memories (the `memory_*`
  tools) are separate files and are unaffected.
- **Search rejects unknown flags.** `mnemex search` now fails on an unrecognised dash-argument and
  suggests the closest real flag, instead of ignoring it.
- **`dead-code` reports more.** Unreferenced exported types are now reportable (see Fixed).

### Added

- **One index per repository, shared by every worktree.** Each row records which branches it
  belongs to; a search answers for the current branch. A second worktree of an indexed tree costs
  zero embedding requests and zero LLM calls. `mnemex branches` lists and prunes the branches an
  index holds. `--force` now rebuilds only the current branch; `--force-all` rebuilds everything.
- **Persistent, machine-global embedding cache** at `~/.mnemex/embed-cache.db`, keyed on the text
  embedded, so a rebase, a re-clone or a new worktree re-embeds nothing it has seen. Bounded at
  2 GiB with LRU eviction. Off with `"embedCache": false` or `MNEMEX_DISABLE_EMBED_CACHE=1`.
- **Search includes uncommitted work.** Edited and new untracked files are searchable without
  re-indexing, through a per-worktree overlay that re-embeds only what changed: one edited file
  costs about 0.1 s and one embedding request. Overlay results are ranked by the same fusion as
  indexed ones, and a stale indexed row is hidden only when the overlay serves a fresher copy or the
  file was deleted. On by default; off with `--no-dirty` or `"dirtyOverlay": false`. `--agent`
  output gains `overlay*` keys and a per-row `source=dirty`. Overlay results carry no symbol graph,
  code units or summaries, and say so in `overlay_gaps`.
- **Penalty observability:** `--agent` search reports `penalty_lookups`, `penalty_same_file` and
  `penalty_applied`, and marks demoted rows ` penalty=dead`.

### Fixed

- **The dead-code penalty judged the wrong symbol.** It compared an absolute result path with a
  repo-relative symbol path, never matched, and fell back to the first same-named symbol in any
  file — demoting live production code for a dead namesake in a test file and sparing dead code. It
  now judges the symbol in the result's own file (including label names such as `X (fields)`) and
  does nothing when that file has none.
- **The same code appeared twice in search results.** A span indexed as both a code chunk and a
  code unit took two result slots (about 1 in 9); it now appears once and the freed slot is filled.
- **No type could ever be reported dead.** The symbol graph recorded every exported type as its own
  caller. `dead-code --include-exported` now reports unreferenced exported types, `callers <Type>`
  no longer lists the type itself, and exported types lose inflated PageRank after the rebuild,
  which shifts `map` and search ranking slightly.
- **`resolveReferencesByName` could freeze indexing for over 10 s** on mid-size repositories,
  long enough for a second indexer to take the lock.
- `mnemex hooks install` works from linked worktrees and submodules.
- An update whose re-add failed no longer loses rows.
- MCP `context` answers for an absolute file path; it returned nothing before.

### Known limitations

- References resolve by name, so a reference can be credited to a different same-named symbol.
  A live function can therefore still be judged dead by `dead-code` and the search penalty.
- Self-recursive functions are still never reported dead.
- If the embedding provider cannot embed the search QUERY, search fails as before; the overlay
  falls back to indexed results only for its own failures.
- In a store shared by several branches, another branch's content takes part in keyword ranking
  statistics, so result ORDER can differ slightly from a single-branch index; the result SET is
  always correct for your branch.

## [0.36.1] - 2026-09-09

The compiled binaries attached to releases could not start. This fixes them, and
adds the check that would have caught it.

If you installed mnemex from npm you were never affected. If you downloaded a
binary from a GitHub Release, or installed through Homebrew, every version from
0.33.0 to 0.36.0 died before running a single command.

### Fixed

- **The release binaries start.** Two independent defects, each fatal on its own,
  which is why the first diagnosis was wrong — fixing either alone still produced
  a dead binary.

  The first was a `package.json` read at module scope in `src/cli.ts`. Inside a
  `bun --compile` binary `__dirname` is `/$bunfs/root`, so it resolved to
  `/$bunfs/package.json`, which does not exist, and threw before any command
  handler ran. The version is now embedded at build time.

  The second was the build externalising `@opentui/core` and `@opentui/react`
  themselves. An external module is not embedded, so the binary had nothing to
  resolve them from. Only the eight per-platform native packages need to stay
  external, and they genuinely do: `bun install` on a glibc runner skips the musl
  optional dependency while the bundler demands both libc branches, so removing
  the externals outright breaks three of the four release targets.

### Added

- **The release build now runs the binary it just produced**, on three of four
  targets — every one that is native to its runner. A successful build was never
  the check: all four builds succeeded for three releases while producing
  binaries that could not run.
- **The same check runs on every pull request**, building a native binary on
  Linux and macOS and executing it from a temporary directory outside the
  checkout, where nothing can resolve a module from the repository. A check that
  lives only in the release workflow is first exercised during a release, and by
  then the tag exists and the version number is spent.

### Known limitations

- TUI commands (`mnemex tui`, the setup wizard) fail in the standalone binary
  with `Cannot find package '@opentui/core-<platform>'`, because the per-platform
  package stays external. Every other command works. Embedding it requires
  force-installing the target's package in CI before the build, which is a
  separate change. The npm install is unaffected and its TUI works.
- `mnemex-darwin-x64` is cross-compiled on an arm64 macOS runner, so it is the
  one artifact still shipped without being executed first.

## [0.36.0] - 2026-09-09

Your API keys can now live in the macOS Keychain instead of in plaintext in
`~/.mnemex/config.json`. Nothing moves on upgrade: the migration is opt-in, runs
in two steps, and every step is inspectable and reversible. The existing Keychain
module was rewritten rather than extended — it had seven measured defects, and two
of them destroyed keys.

### Added

- **Keychain-backed storage for all six credentials** (`openrouter`, `voyage`,
  `anthropic`, `context7`, `cloud`, `ollama`). Resolution order, first answer wins:
  environment variable, then Keychain, then `~/.mnemex/config.json`. One resolver
  serves every getter, so the order cannot drift between them.
- **`mnemex keychain status`** — what is stored where, and whether the backend
  works. Read-only, one attribute-only lookup for all six, no value reads. Keys are
  masked to their last four characters. A key that could not be read is reported as
  unreadable, never as absent.
- **`mnemex keychain migrate [--dry-run]`** — copies plaintext keys into the
  Keychain and verifies each round-trip, leaving `config.json` untouched. It writes
  create-only, so an existing item is never overwritten; `security` refuses the
  write rather than the code deciding not to.
- **`mnemex keychain prune`** — removes the plaintext copies, but only those that
  re-verify byte-for-byte against the Keychain first. A key that does not verify is
  refused by name, with the remedy; a read failure aborts the whole prune and
  writes nothing.
- **`mnemex keychain rm <id> [--force]`** — deletes one item, and refuses when no
  plaintext copy remains, so the last copy of a key cannot go by accident.
- **`OLLAMA_API_KEY`** as a first-class credential, resolved through the same chain
  as the rest.
- **Opt-out**, for a locked or ACL-hostile Keychain: `MNEMEX_DISABLE_KEYCHAIN=1`
  for one run, or `"keychain": false` in the config for good. Either makes the
  process fall back to the config file with zero `security` calls.

### Fixed

- **A failed Keychain write no longer deletes the key from `config.json`.** The
  write's result was discarded and the file was stripped unconditionally. A secret
  now leaves the file only when that save proved the Keychain holds those exact
  bytes, and an unconfirmed delete keeps the field and says so.
- **Off-macOS, saving no longer destroys every secret.** The module claimed to fall
  back to the config file; it stripped the keys and stored them nowhere.
- **Secrets no longer appear in `argv`**, where any user on the machine could read
  them with `ps`. Values now go to `security` over stdin, hex-encoded.
- **`getApiKey()` costs one `security` spawn, not seven** (101 ms measured before).
- **"Could not read the Keychain" is no longer reported as "nothing is stored".**
  Reads return a three-way answer, so a failure and an absence stay distinguishable
  wherever the difference matters.
- **An explicitly `undefined` config field means untouched.** It previously
  destroyed a plaintext-only key silently, without appearing in the save report at
  all. Only `""` clears a value.
- **A value read from the Keychain is never written back to the file in plaintext.**
- **An unrecognised flag now aborts the command.** `keychain migrate --dry-runDD`
  matched no known flag, fell through to the destructive default, ran a real
  migration and exited 0. Each subcommand now declares the flags it accepts and
  refuses anything else before taking the lock or touching the Keychain.
- **`excludePatterns` stores your additions only.** Loading prepends the 102
  built-in defaults for convenience, and saving wrote that concatenation back —
  growing the file by 102 entries every time (measured on a real file: 408 entries,
  102 unique). Saving now normalises, which also heals an already-polluted file.

### Changed

- **`~/.mnemex/config.json` is treated as a secret store**, since a key may still
  legitimately live there: a `0700` directory, atomic tmp-then-rename writes, and an
  unconditional `chmod 0600` on every save. `writeFileSync`'s `mode:` is ignored for
  a file that already exists, so an existing `0644` file stayed `0644`.
- **One cross-process lock guards save, migrate, prune and rm, and it fails
  closed.** If the lock cannot be taken, the command changes nothing and says why.
  The previous advisory lock gave up after two seconds and then wrote anyway.
- **An unparseable config file is preserved** as `config.json.corrupt-<timestamp>`
  rather than merged over.

### Security

- **`OLLAMA_API_KEY` is bound to the `ollama.com` endpoint, not to the `local`
  provider.** Ollama Cloud, LM Studio and any self-hosted OpenAI-compatible server
  all resolve to the `local` provider, so attaching the key by provider type sent an
  Ollama Cloud credential to third-party and self-hosted endpoints. An explicitly
  passed key is still honoured anywhere.
- **Claude Code's OAuth token is no longer read by `execSync` on a relative binary
  name.** That was a PATH hijack (CWE-426): a planted `security` executable was
  handed the token. It now goes through the same port as everything else.
- **No test can reach the real login Keychain.** The adapter denies by default and
  only the production entry point turns it on, so importing the module cannot spawn
  `security`, and a test that spawns the entry point is caught by a static sweep
  over both test roots.
- **Every entry-point launch routes through one guarded launcher**, enforced by an
  import- and alias-resolving capability analysis over `src/`.

### Known limitation

The compiled binaries attached to releases cannot start outside a `node_modules`
tree (`Cannot find module '@opentui/react'`). This is pre-existing and affects
v0.33.0 through v0.35.0 identically; the npm install path is unaffected. Fix
tracked for a follow-up release.

## [0.35.0] - 2026-09-08

mnemex now knows whether your terminal is light or dark, and paints accordingly.
Until now every interactive screen assumed a dark background; on a light terminal
the code preview was yellow on white. The answer is decided once, at startup,
before the first coloured byte, from the first source that has an opinion.

### Added

- **Terminal theme detection.** Resolution order, first answer wins: the `--theme=light|dark`
  flag, then `MNEMEX_THEME`, then `TERM_THEME` (only `light` and `dark` count; `auto` or
  anything else is "no opinion" and falls through rather than meaning dark), then an OSC 11
  query to the terminal on an interactive TTY only (bounded at 200 ms, and usually answered
  or declined in single-digit milliseconds thanks to a DA1 sentinel), then `COLORFGBG`, then
  dark. `TERM_THEME` skips the query entirely. Nothing is printed when a source answered;
  the only diagnostic goes to stderr, only on the default path, and only with `MNEMEX_DEBUG`.
- **A light palette** for the TUI and for the ANSI output of every CLI command, with text
  contrast of at least 4.5:1 on white pinned by tests. The dark palette is byte-identical to
  0.34.0.
- **`MNEMEX_THEME`** as mnemex's own theme variable, and `--theme` as a global flag,
  documented in `mnemex --help` and the README, including a note for tmux and zellij users.

### Changed

- **`TERM_THEME` and `MNEMEX_THEME` are read from the process environment only, never from
  a `.env` file.** Bun loads a cwd `.env` into `process.env` before any user code runs, so
  the CLI entry now runs with `--env-file=/dev/null` (in the shebang for the npm install,
  and compiled into the standalone binaries). `dotenv` remains the loader for `./.env`, as
  before. Consequence: Bun's automatic loading of `.env.local` and `.env.$NODE_ENV` no
  longer applies to mnemex; put those values in `./.env` or the environment. The shebang
  needs an `env` that supports `-S` (macOS, FreeBSD, GNU coreutils ≥ 8.30); on BusyBox
  run `bun --env-file=/dev/null dist/index.js` instead.
- **TUI components read colours from the palette instead of their own literals.** The
  syntax highlighter, result list, result detail view, and two smaller screens carried
  hardcoded hex values; thirty roles moved into the palette so both themes reach every
  screen.
- The terminal query (OSC 11) runs only for the TUI commands (`ui`, `monitor`, `setup`,
  `admin`), and only on an interactive TTY — never for `--agent`, `--mcp`, `mnemex rg`,
  `--help`, `--version`, a bare `mnemex`, `TERM=dumb`, or a piped stdout. The query puts
  stdin in raw mode, and a backgrounded job (`mnemex index &`) that still holds the
  terminal would be stopped by SIGTTOU for doing that; a backgrounded job must never be
  stopped by a tty query. Every other command still takes the theme from `--theme`,
  `MNEMEX_THEME`, `TERM_THEME` and `COLORFGBG`, so machine-readable output stays
  byte-exact and the ANSI palette still switches.

## [0.34.0] - 2026-09-04

A release about failing loudly. Two silent failures are gone: an index built with
one embedding model and searched with another was destroyed and rebuilt without
being asked, and a model the provider did not have produced an index that could
never answer a single query. Both now stop and say what to do about it.

### Added

- **`onModelMismatch` decides what happens when the index and the config disagree
  about the embedding model.** `use-indexed` (the default) keeps the index and
  switches to the model it was built with; `force-model` clears and rebuilds with
  the configured one, which is what every version until now did unconditionally.
  Readable from project config, global config, or `MNEMEX_ON_MODEL_MISMATCH`.
- **`mnemex index` accepts `-m` / `--model`.** It never has: the value was
  silently consumed as the project path. This matters more than it sounds,
  because the remedy the mismatch error has been printing for users to run —
  `mnemex index --force --model <name>` — could therefore never have worked.

### Changed

- **On a model mismatch, the default is now to use the model the index was built
  with.** Rebuilding spends money and time; adopting the stored model costs
  nothing and loses nothing. The failure mode of the new default is an error you
  can act on, and the failure mode of the old one was a silent bill. Set
  `"onModelMismatch": "force-model"` to keep the previous behaviour.
- **The embedding provider is recorded alongside the model.** Without it the
  feature above cannot work at all: the provider is inferred from the model
  *string*, so a bare name like `nomic-embed-text` matches no prefix rule and is
  requested from whatever provider the config happens to name today. An index
  written before this release has no provider on record and says so by name.
- LanceDB 0.33 → 0.38.
- An error that escapes a command prints its message and nothing else. Previously
  bun's default handler rendered four frames of minified `dist/` paths, two
  "missing sourcemaps" notes and a version banner for ordinary operational
  failures. `MNEMEX_DEBUG=1` restores the stack.

### Fixed

- **A missing embedding model no longer writes an index that can never be read.**
  Only connection errors failed fast; everything else — including the 404 for a
  model the provider does not have — was treated as a skippable chunk that
  contributed an empty vector. Every chunk failing meant every vector empty, and
  LanceDB fixes the column width at creation, so the table was born
  `FixedSizeList[0]` and was unreadable forever. A missing model is now fatal, a
  100% failure rate throws whatever the cause, and `embedOne` refuses to return a
  zero-length vector. The deliberate skip for a genuine *partial* failure is
  unchanged and pinned by a test.
- **An index already in that state is detected when its table opens, and repaired
  by the next index run.** Reaching native code with it produced a Rust panic on
  LanceDB 0.13 (`attempt to divide by zero`, twice, with cargo paths), a
  `LanceError(Schema)` on 0.33 and later, and on a plain scan zero rows in
  silence. `mnemex status` explains the state instead of reporting an empty index.
- **An unreachable model is reported before it is used, not after.** The check
  had a single caller inside the indexing path, which agent mode skips entirely,
  so a search produced `No vector column found to match with the query vector
  dimension: 0`. It now names the model, the provider on record and the
  provider's own error, and leaves the index untouched.
- The MCP search tool no longer swallows an unavailable-model error as a
  non-fatal auto-index failure.
- Mismatch and repair notices no longer go to stdout, which is the JSON-RPC
  stream when running as an MCP server.

## [0.33.0] - 2026-09-02

A correctness and performance release. Search is roughly 18x faster, and seven
defects are fixed — every one of which failed **silently**, several while
reporting success.

### Fixed

- **Search no longer rebuilds the BM25 index on every query.** `ensureFtsIndex()`
  forced a full rebuild guarded by a per-instance flag, while a fresh store is
  constructed per search. Measured on a real 19,862-row store: the redundant
  rebuild cost **275 ms**, about half of total search latency and 32x the query
  it was enabling. End-to-end search **554 ms -> 30.8 ms**. It was also a source
  of non-determinism, so results are now more stable, not less.

- **Deletes could silently do nothing and report success.** `deleteByFile`,
  `deleteByFileHash`, `deleteAllByFile` and `deleteByDocumentType` checked a raw
  table handle, but the table is opened lazily by the search path. On a store
  where nothing had opened it yet the delete no-opped and returned 0 —
  indistinguishable from "nothing to delete". Live on three paths: `docs clear`
  printed "Cleared documentation" while orphaned chunks stayed searchable;
  `docs fetch` never deleted before re-fetching; and the incremental indexer left
  chunks of **deleted files searchable forever**, recoverable only by
  `index --force`.

- **A file path could delete the entire index.** Several predicates interpolated
  values directly into SQL. A path containing `x' OR filePath LIKE '%` renders a
  well-formed match-everything predicate, so a delete aimed at one file emptied
  the table. LanceDB offers no parameterized predicate API, so all ~30 predicate
  sites are now individually audited and escaped.

- **Enriched search filtered by document type returned nothing.** The `LIKE`
  escaper was applied to an `IN` list; SQL string literals do not process
  backslash escapes, so `file\_summary` matched no row. 10 of 11 document types
  contain an underscore, so type-filtered search was silently empty.

- **Incremental reindex re-embedded underscored files every run.** The same
  escaping mismatch made `getChunksWithVectors` return nothing for any path
  containing `_`, disabling vector reuse without any error.

- **Windows global installs could not find tree-sitter grammars** (issue #4). The
  dist check hardcoded a forward slash, so it was false on Windows and the
  grammar path resolved to `node_modules\grammars`. It also false-positived on
  any `dist` ancestor directory and on names like `distribution/`.

- **Local embedding providers requested the wrong URL** (issue #4). The `local`
  provider default lacked the `/v1` path segment. Normalization now happens in
  the client, so **configs already saved in the broken state repair themselves**
  with no user action. Custom gateway paths (LiteLLM and similar) are left alone.

### Added

- **Self-invalidating memory.** Every document carries `valid_from_commit` /
  `invalidated_at_commit`, backed by a new commit-provenance table. Documents
  split three ways: derived types auto-invalidate and requeue when their source
  file changes; observed types are flagged stale and **never** auto-deleted;
  external documentation is exempt, because a repo commit says nothing about it.
  Facts are superseded, never deleted.

- **A labeled retrieval eval set and a harness wired to real search.** 135
  queries derived from git history with 403 relevance judgements. The ablation
  harness existed but had never been connected to anything — it defaulted to a
  mock returning no results.

- **Three gated retrieval features, all default-off**: TM2C2 convex fusion,
  per-query adaptive fusion weights with a query-length score floor, and
  query-seeded Personalized PageRank routed to structural and semantic intents.

### Changed

- **The CLI and the MCP server now agree on whether learning is enabled.** They
  previously disagreed for anyone who had never run `mnemex init`: the CLI
  treated learning as on, the MCP server as off. Both now use one predicate with
  the CLI's existing opt-out default, so **MCP users who never configured
  learning will now have it enabled**. Set `learning: false` in config to opt out.

- **`search` and `search_code` now rank identically.** `search` previously
  discarded session observations and ignored learned file boosts, so the same
  query returned different results depending on which tool was called.

### Performance

- Search: 554 ms -> 30.8 ms (~18x).
- `FileTracker` construction: 346 us -> 35 us.
- Learning layer per search: 190 us -> 2 us.

### Known limitations

- **Root-mounted embedding endpoints now get `/v1` appended.** Endpoint
  normalization adds `/v1` to any URL with no path at all. A server that serves
  `/embeddings` at the root (`http://host:8080`) worked before and will now 404.
  Set an explicit path on the endpoint to opt out. Endpoints that already carry
  a path — including gateway prefixes like `/openai` — are left untouched.

- **A config edit made outside the process needs an MCP server restart.** The
  learning-enabled flag is cached per project path and only invalidated by
  in-process saves, so editing `config.json` in an editor is invisible to a
  long-running MCP server until it restarts.

### Notes

TM2C2 fusion was implemented, measured against the 135-query set, and **rejected**:
it loses on all six metrics, so the default remains reciprocal-rank fusion. The
measurement is committed under `eval/code-search-harness/results/clean-run/`.

A pre-release code review caught a fusion regression before it shipped: setting a
stable id on every semantic result made those hits unmergeable with the four
backends that key on `file:startLine`, so one code location surfaced twice and
lost its consensus boost. Merge keying now prefers a real code anchor and falls
back to the id only for anchor-less documents. Fixed in this release; it never
reached a published version.

[0.33.0]: https://github.com/MadAppGang/mnemex/releases/tag/v0.33.0
