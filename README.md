<p align="center">
  <img src="assets/logo.png" alt="mnemex" width="600">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/mnemex"><img src="https://img.shields.io/npm/v/mnemex.svg" alt="npm version"></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
  <a href="https://github.com/MadAppGang/mnemex"><img src="https://img.shields.io/github/stars/MadAppGang/mnemex?style=social" alt="GitHub stars"></a>
</p>

---

Local semantic code search for Claude Code. Index your codebase once, search it with natural language.

## Install

```bash
# npm
npm install -g mnemex

# homebrew (macOS)
brew tap MadAppGang/tap && brew install mnemex

# or just curl it
curl -fsSL https://raw.githubusercontent.com/MadAppGang/mnemex/main/install.sh | bash
```

## Why this exists

Claude Code's built-in search (grep/glob) works fine for exact matches. But when you're trying to find "where do we handle auth tokens" or "error retry logic" — good luck.

mnemex fixes that. It chunks your code using tree-sitter (so it actually understands functions/classes, not just lines), generates embeddings via OpenRouter, and stores everything locally in LanceDB.

The search combines keyword matching with vector similarity. Works surprisingly well for finding stuff you kinda-sorta remember but can't grep for.

## Quick start

```bash
# first time setup
mnemex init

# index your project
mnemex index

# search
mnemex search "authentication flow"
mnemex search "where do we validate user input"
```

That's it. Changed some files? Just search again — it auto-reindexes modified files before searching.

## Embedding Model Benchmark

Run your own benchmark with `mnemex benchmark`. Here are results on real code search tasks:

<p align="center">
  <img src="assets/benchmark.png" alt="Embedding Model Benchmark" width="700">
</p>

| Model | Speed | NDCG | Cost | Notes |
|-------|-------|------|------|-------|
| **voyage-code-3** | 4.5s | 175% | $0.007 | Best quality |
| **gemini-embedding-001** | 2.9s | 170% | $0.007 | Great free option |
| **voyage-3-large** | 1.8s | 164% | $0.007 | Fast & accurate |
| **voyage-3.5-lite** | 1.2s | 163% | $0.001 | Best value |
| voyage-3.5 | 1.2s | 150% | $0.002 | Fastest |
| mistral-embed | 16.6s | 150% | $0.006 | Slow |
| text-embedding-3-small | 3.0s | 141% | $0.001 | Decent |
| text-embedding-3-large | 3.1s | 141% | $0.005 | Not worth it |
| all-minilm-l6-v2 | 2.7s | 128% | $0.0001 | Cheapest (local) |

**Summary:**
- 🏆 **Best Quality:** voyage-code-3 (175% NDCG)
- ⚡ **Fastest:** voyage-3.5 (1.2s)
- 💰 **Cheapest:** all-minilm-l6-v2 (local, free)

## Embedding providers

mnemex supports three embedding providers:

### OpenRouter (cloud, default)
```bash
mnemex init  # select "OpenRouter"
# requires API key from https://openrouter.ai/keys
# ~$0.01 per 1M tokens
```

### Ollama (local, free)
```bash
# install Ollama first: https://ollama.ai
ollama pull nomic-embed-text

mnemex init  # select "Ollama"
```

Recommended Ollama models:
- `nomic-embed-text` — best quality, 768d, 274MB
- `mxbai-embed-large` — large context, 1024d, 670MB
- `all-minilm` — fastest, 384d, 46MB

### Custom endpoint (local server)
```bash
mnemex init  # select "Custom endpoint"
# expects OpenAI-compatible /embeddings endpoint
```

View available models:
```bash
mnemex --models           # OpenRouter models
mnemex --models --ollama  # Ollama models
```

## Using with Claude Code

Run it as an MCP server:

```bash
mnemex --mcp
```

Then Claude Code can use these tools:
- `search_code` — semantic search (auto-indexes changes)
- `index_codebase` — manual full reindex
- `get_status` — check what's indexed
- `clear_index` — start fresh

### Grep replacement (`mnemex rg`)

mnemex ships a drop-in `rg` replacement that Claude Code's built-in Grep tool will call. It runs real ripgrep and mnemex semantic search **in parallel**, then merges the results with mnemex-ranked hits listed first — so every result `rg` would have returned is preserved, plus semantically related hits that literal regex misses.

```bash
# One-time install
mnemex rg install

# This writes ~/.local/bin/rg as a shim that execs `mnemex rg "$@"`
# and sets USE_BUILTIN_RIPGREP=0 in ~/.claude/settings.json so that
# Claude Code picks up the PATH rg instead of its bundled binary.
```

Requirements:
- `~/.local/bin` must be early on your `$PATH`: `export PATH="$HOME/.local/bin:$PATH"`
- The project needs a `.mnemex/` index for augmentation to kick in. Without one, the shim is a zero-overhead passthrough to the bundled `rg`.

How it behaves:
- **With an index**: runs `rg` + `mnemex search` in parallel (2s cap on mnemex), merges output with semantic hits first, deduplicated by `file:line`.
- **Without an index**: direct passthrough to the bundled `rg`. Byte-identical output, no overhead.
- **`--count` mode or no pattern**: passthrough only (mnemex can't meaningfully augment counts).
- **Flag-honoring**: mnemex-side filtering respects `-F`, `-w`, `-x`, `-i`, `-s`, `-S` so it doesn't surface lines that `rg` would have rejected.

To revert:

```bash
mnemex rg uninstall
# Removes ~/.local/bin/rg and unsets USE_BUILTIN_RIPGREP in ~/.claude/settings.json
```

## IDE Integrations

mnemex integrates with AI coding assistants to replace grep/glob with semantic search.

### Claude Code

Install the [code-analysis plugin](https://github.com/MadAppGang/claude-code) for automatic mnemex integration:

```bash
# In Claude Code
/plugin marketplace add MadAppGang/claude-code

# Enable the plugin in settings
# Add to your Claude Code settings:
{
  "enabledPlugins": {
    "code-analysis@mag-claude-plugins": true
  }
}
```

This gives you detective agents that use mnemex under the hood:
- `developer-detective` — trace implementations, find usages
- `architect-detective` — analyze architecture, find patterns
- `tester-detective` — find test gaps, coverage analysis
- `debugger-detective` — trace errors, find bug sources

### OpenCode

Automatic installation:

```bash
# Install plugins (suggestion + tools)
mnemex install opencode

# Check status
mnemex install opencode status

# Uninstall
mnemex install opencode uninstall
```

Manual installation — see [docs/OPENCODE_INTEGRATION.md](docs/OPENCODE_INTEGRATION.md).

## VS Code autocomplete (experimental)

This repo also contains an experimental VS Code inline completion extension that talks to a persistent `mnemex` autocomplete server.

- Autocomplete server: `mnemex --autocomplete-server --project .`
- VS Code extension source: `extensions/vscode-mnemex-autocomplete/`

## What it actually does

1. **Parses code** with tree-sitter — extracts functions, classes, methods as chunks (not dumb line splits)
2. **Generates embeddings** via OpenRouter (default: voyage-3.5-lite, best value)
3. **Stores locally** in LanceDB — everything stays in `.mnemex/` in your project
4. **Hybrid search** — BM25 for exact matches + vector similarity for semantic. Combines both.
5. **Builds symbol graph** — tracks references between symbols, computes PageRank for importance

## Pack — export codebase for AI

Pack your entire codebase into a single AI-friendly file. Works like [repomix](https://github.com/yamadashy/repomix) but with correct XML escaping and built right into mnemex.

```bash
# XML format (default, repomix-compatible)
mnemex pack

# Markdown or plain text
mnemex pack --format markdown
mnemex pack --format plain

# Pipe to stdout
mnemex pack --stdout | pbcopy

# Filter files
mnemex pack --include "src/**/*.ts" --exclude "**/*.test.ts"

# Custom output path
mnemex pack -o context.xml
```

### Why not just use repomix?

You can — mnemex's XML output is structurally compatible with repomix. But mnemex pack actually produces **more correct XML**. In independent testing by multiple AI models (GPT-5, Kimi K2.5), mnemex scored higher:

| Criterion | mnemex pack | repomix v1.12 |
|-----------|---------------|---------------|
| XML well-formedness | **Correct** — escapes `&` `<` `>` in content | Broken — raw `<div>`, `&` in content |
| Binary file marking | `[binary]` tag in directory tree | Listed but not marked |
| Directory tree | Tree characters (`├──` `└──` `│`) | Flat indentation |
| .gitignore in output | Included | Omitted |

The key issue: repomix v1.12 doesn't XML-escape file content, so files containing `<`, `>`, or `&` produce **invalid XML** that breaks parsers. mnemex handles this correctly.

## Symbol graph & code analysis

Beyond semantic search, mnemex builds a **symbol graph** with PageRank scores. This enables powerful code analysis:

### Dead code detection
```bash
mnemex dead-code
# Finds: symbols with zero callers + low PageRank + not exported
# Great for: cleaning up unused code
```

### Test coverage gaps
```bash
mnemex test-gaps
# Finds: high-PageRank symbols not called by any test file
# Great for: prioritizing what to test next
```

### Change impact analysis
```bash
mnemex impact FileTracker
# Shows: all transitive callers, grouped by file
# Great for: understanding blast radius before refactoring
```

### Keep index fresh
```bash
# Option 1: Watch mode (daemon)
mnemex watch

# Option 2: Git hook (auto-index after commits)
mnemex hooks install
```

## Documentation indexing

mnemex can automatically fetch and index documentation for your project dependencies. This gives you semantic search across both your code AND the frameworks you use.

### How it works

1. **Detects dependencies** from `package.json`, `requirements.txt`, `go.mod`, `Cargo.toml`
2. **Fetches docs** using a provider hierarchy with automatic fallback:
   - **Context7** — 6000+ libraries, versioned API docs & code examples (requires free API key)
   - **llms.txt** — Official AI-optimized docs from framework sites (Vue, Nuxt, Langchain, etc.)
   - **DevDocs** — Consistent offline documentation for 100+ languages
3. **Chunks & indexes** documentation alongside your code
4. **Search everything** with natural language queries

### Setup

```bash
mnemex init  # prompts to enable docs & configure Context7
```

Or configure manually:
```bash
export CONTEXT7_API_KEY=your-key  # get free key at https://context7.com/dashboard
```

### Commands

```bash
mnemex docs fetch              # fetch docs for all detected dependencies
mnemex docs fetch react vue    # fetch specific libraries
mnemex docs status             # show indexed docs & cache state
mnemex docs clear              # clear cached documentation
```

### What gets indexed

| Source | Best For | Coverage | Auth Required |
|--------|----------|----------|---------------|
| **Context7** | Code examples, API reference | 6000+ libs | Free API key |
| **llms.txt** | Official structured docs | 500+ sites | None |
| **DevDocs** | Offline fallback | 100+ langs | None |

### Configuration

In `~/.mnemex/config.json`:
```json
{
  "docs": {
    "enabled": true,
    "providers": ["context7", "llms_txt", "devdocs"],
    "cacheTTL": 24,
    "maxPagesPerLibrary": 10,
    "excludeLibraries": ["lodash"]
  }
}
```

Environment variables:
- `CONTEXT7_API_KEY` — Context7 API key (optional but recommended)
- `MNEMEX_DOCS_ENABLED` — disable docs entirely (`false`)

## Supported languages

TypeScript, JavaScript, Python, Go, Rust, C, C++, Java.

If your language isn't here, it falls back to line-based chunking. Works, but not as clean.

## CLI reference

### Basic commands
```
mnemex init              # setup wizard
mnemex index [path]      # index codebase
mnemex search <query>    # search (auto-reindexes changed files)
mnemex status            # what's indexed
mnemex clear             # nuke the index
mnemex models            # list embedding models
mnemex benchmark         # benchmark embedding models
mnemex --mcp             # run as MCP server
```

### Symbol graph commands (for AI agents)
```
mnemex map [query]       # repo structure with PageRank scores
mnemex symbol <name>     # find symbol definition
mnemex callers <name>    # what calls this symbol?
mnemex callees <name>    # what does this symbol call?
mnemex context <name>    # symbol + callers + callees
```

### Code analysis commands
```
mnemex dead-code         # find potentially dead code (zero callers + low PageRank)
mnemex test-gaps         # find important code without test coverage
mnemex impact <symbol>   # analyze change impact (transitive callers)
```

### Pack commands
```
mnemex pack [path]       # pack codebase to XML (default: <name>-pack.xml)
mnemex pack --format md  # markdown format
mnemex pack --stdout     # write to stdout
mnemex pack --include "src/**" --exclude "*.test.ts"
```

### Pack flags
```
-o, --output <file>       # output file path
--format <xml|markdown|plain>  # output format (default: xml)
--stdout                  # write to stdout instead of file
--include <pattern>       # glob pattern to include (repeatable)
--exclude <pattern>       # additional exclusion pattern (repeatable)
--no-gitignore            # don't use .gitignore patterns
--max-file-size <bytes>   # max file size (default: 1048576)
--tokens                  # show token count report
```

### Interactive TUI
```
mnemex ui [path]         # full-screen TUI (search, map, graph, analysis, doctor)
mnemex setup             # interactive setup wizard (provider, model, scope)
mnemex monitor [path]    # passive display of MCP activity from Claude Code
```

Keyboard shortcuts in the TUI:
- `Tab` / `Shift+Tab` — cycle tabs
- `1`–`5` — jump to tab (search, map, graph, analysis, doctor)
- `?` — toggle help overlay
- `q` — quit

### Developer experience
```
mnemex watch             # auto-reindex on file changes (daemon mode)
mnemex hooks install     # install git post-commit hook for auto-indexing
mnemex hooks uninstall   # remove the hook
mnemex hooks status      # check if hook is installed
```

### API keys and the macOS Keychain
```
mnemex keychain status               # what is stored where, and whether the backend works
mnemex keychain migrate --dry-run    # preview moving plaintext keys into the Keychain
mnemex keychain migrate              # copy them (config.json is left unchanged)
mnemex keychain prune                # remove the plaintext copies that re-verify
mnemex keychain rm <id>              # delete one Keychain item (--force if it is the last copy)
```

On macOS, API keys entered through `mnemex init` or the setup wizard go to the system
Keychain (service `mnemex`) instead of plaintext `~/.mnemex/config.json`. Resolution order
per key is **environment variable → Keychain → `~/.mnemex/config.json`**, and keys are
`openrouter`, `voyage`, `anthropic`, `context7`, `cloud`, `ollama`.

Upgrading moves nothing. Keys already in `config.json` keep working exactly as before;
`migrate` and `prune` are two separate, opt-in steps so an interrupted or regretted
migration cannot lose a key. A failed or unavailable Keychain write never drops a key —
it stays in `config.json`, which is now written atomically at mode `0600`.

Opt out with `MNEMEX_DISABLE_KEYCHAIN=1` or `"keychain": false` in `~/.mnemex/config.json`.
On Linux and Windows everything stays in the config file, with no attempt to spawn anything.

> **Downgrade note:** once a key lives only in the Keychain (after `migrate` + `prune`, or
> for a key entered after upgrading), a downgrade to ≤ 0.32.0 reads only `config.json` and
> will not find it. The item is not destroyed — it stays in Keychain Access.app and is
> readable with `security find-generic-password -s mnemex -a <account> -w`.

### IDE integrations
```
mnemex install opencode                # install OpenCode plugins (suggestion + tools)
mnemex install opencode --type tools   # install tools plugin only
mnemex install opencode status         # check installation status
mnemex install opencode uninstall      # remove plugins
mnemex rg install                      # install ~/.local/bin/rg shim for Claude Code Grep
mnemex rg uninstall                    # remove shim and revert Claude Code settings
mnemex rg [rg args...]                 # drop-in ripgrep + mnemex semantic augmentation
```

### Documentation commands
```
mnemex docs fetch        # fetch docs for all detected dependencies
mnemex docs fetch <lib>  # fetch docs for specific library
mnemex docs status       # show indexed docs and providers
mnemex docs clear        # clear cached documentation
```

### Search flags
```
-n, --limit <n>       # max results (default: 10)
-l, --language <lang> # filter by language
-y, --yes             # auto-create index without asking
--no-reindex          # skip auto-reindex
```

### Code analysis flags
```
--max-pagerank <n>    # dead-code threshold (default: 0.001)
--min-pagerank <n>    # test-gaps threshold (default: 0.01)
--max-depth <n>       # impact analysis depth (default: 10)
--include-exported    # include exported symbols in dead-code scan
--agent               # agent mode: no logo, compact output (for AI tools)
--theme=light|dark    # colour theme (default: auto-detect); also `--theme light`
```

## Config

Env vars:
- `OPENROUTER_API_KEY` — for OpenRouter provider
- `MNEMEX_MODEL` — override embedding model
- `MNEMEX_ON_MODEL_MISMATCH` — `use-indexed` (default) or `force-model`, see below
- `CONTEXT7_API_KEY` — for documentation fetching (optional)
- `MNEMEX_DISABLE_EMBED_CACHE` — set to `1` to recompute every vector instead of reusing the embedding cache
- `MNEMEX_EMBED_CACHE_PATH` — put the embedding cache somewhere other than `~/.mnemex/embed-cache.db`
- `MNEMEX_THEME` — `light` or `dark`; mnemex's own theme override
- `TERM_THEME` — `light` or `dark`; the shared terminal-theme convention, honoured when `MNEMEX_THEME` is unset

The colour theme is resolved once at startup, first answer wins: `--theme` flag → `MNEMEX_THEME` → `TERM_THEME` → OSC 11 probe of the terminal background (only for the TUI commands `ui`, `monitor`, `setup`, `admin`, and only on an interactive TTY; never under `--agent`, `--mcp`, `mnemex rg`, piped output or `TERM=dumb` — a backgrounded job must never be stopped by a tty query, so other commands take the theme from the flag and environment only) → `COLORFGBG` → dark. Only `./.env` is loaded, via dotenv (Bun's automatic `.env.local` / `.env.$NODE_ENV` loading is disabled), and `TERM_THEME` / `MNEMEX_THEME` are never read from `.env` — they must come from the real process environment.

Inside tmux or zellij, mnemex asks the multiplexer, not your terminal, for the background colour. Recent versions answer OSC 11 on the outer terminal's behalf; if yours does not, or you switched the terminal's theme after starting the session, set `TERM_THEME=light|dark` (or `MNEMEX_THEME`) — it takes precedence and mnemex's probe is skipped. (The TUI library still sends its own query at startup; its answer does not affect mnemex's colours.)

Files:
- `~/.mnemex/config.json` — global config (provider, model, docs settings)
- `~/.mnemex/embed-cache.db` — embedding cache, shared by every repo on the machine
- `.mnemex/` — project index (add to .gitignore)

### Embedding cache

Embedding the same text twice costs the same money and the same minutes as embedding it
once, so mnemex keeps the vectors it has already paid for in a single SQLite file at
`~/.mnemex/embed-cache.db`. It is **machine-global**: every repository, every clone and
every git worktree on the machine reads and writes the same file, which is what makes the
second worktree of a tree you have already indexed nearly free.

An entry is keyed on the embedding model, the vector dimension and the exact text that was
embedded — nothing else. Moving a file, switching branches, rebasing or re-cloning does not
invalidate anything, because none of those change the text. Changing the model does, since
the model is part of the key; the old entries stay until they are evicted.

The file is capped at 2 GiB and evicts least-recently-used entries when it grows past that.
Deleting it is always safe — the next index run pays full price once and refills it.

Turn it off with `MNEMEX_DISABLE_EMBED_CACHE=1`, or persistently in `~/.mnemex/config.json`:

```json
{
  "embedCache": false
}
```

Point it elsewhere with `MNEMEX_EMBED_CACHE_PATH=/path/to/embed-cache.db` (each path is an
independent cache). Either way search results are unchanged: vectors are cached as float32,
which is what the index stores regardless, so a served vector is bit-for-bit the one the
index would have held.

`mnemex index` reports what it did — `Embed cache: 4210 cached, 96 embedded` — and
`--agent` emits the same numbers as `embed_cache_tier`, `embed_cache_hits`,
`embed_cache_misses` and `embed_cache_writes`.

### Changing the embedding model

An index can only be searched with the model that built it, so mnemex records that
model and notices when your config names a different one. `onModelMismatch` decides
what happens then:

- `use-indexed` (default) — keep the index and use the model it was built with.
  Nothing is re-embedded, nothing is spent, and the command tells you which model it
  used. If that model is unreachable it fails loudly and leaves the index untouched.
- `force-model` — clear the index and rebuild it with the model your config names.

```json
{
  "onModelMismatch": "force-model"
}
```

Set it globally in `~/.mnemex/config.json` or per project in `mnemex.json` (project
wins); `MNEMEX_ON_MODEL_MISMATCH` overrides both. Either way `mnemex index --force`
and `mnemex index --model <model>` rebuild with the model you name.

## Limitations

- First index takes a minute on large codebases
- Ollama is slower than cloud (runs locally, no batching)
- Embedding quality depends on the model you pick
- Not magic — sometimes grep is still faster for exact strings

## License

MIT

---

[GitHub](https://github.com/MadAppGang/mnemex) · [npm](https://www.npmjs.com/package/mnemex) · [OpenRouter](https://openrouter.ai)
