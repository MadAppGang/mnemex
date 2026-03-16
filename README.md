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

### Developer experience
```
mnemex watch             # auto-reindex on file changes (daemon mode)
mnemex hooks install     # install git post-commit hook for auto-indexing
mnemex hooks uninstall   # remove the hook
mnemex hooks status      # check if hook is installed
```

### IDE integrations
```
mnemex install opencode                # install OpenCode plugins (suggestion + tools)
mnemex install opencode --type tools   # install tools plugin only
mnemex install opencode status         # check installation status
mnemex install opencode uninstall      # remove plugins
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
```

## Config

Env vars:
- `OPENROUTER_API_KEY` — for OpenRouter provider
- `MNEMEX_MODEL` — override embedding model
- `CONTEXT7_API_KEY` — for documentation fetching (optional)

Files:
- `~/.mnemex/config.json` — global config (provider, model, docs settings)
- `.mnemex/` — project index (add to .gitignore)

## Limitations

- First index takes a minute on large codebases
- Ollama is slower than cloud (runs locally, no batching)
- Embedding quality depends on the model you pick
- Not magic — sometimes grep is still faster for exact strings

## License

MIT

---

[GitHub](https://github.com/MadAppGang/mnemex) · [npm](https://www.npmjs.com/package/mnemex) · [OpenRouter](https://openrouter.ai)
