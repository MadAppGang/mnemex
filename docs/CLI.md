# mnemex CLI Reference

Complete command-line interface documentation for mnemex - local semantic code search for Claude Code.

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Core Commands](#core-commands)
- [Symbol Graph Commands](#symbol-graph-commands)
- [Code Analysis Commands](#code-analysis-commands)
- [Benchmark Commands](#benchmark-commands)
- [Server Modes](#server-modes)
- [Developer Experience](#developer-experience)
- [Environment Variables](#environment-variables)
- [LLM Provider Configuration](#llm-provider-configuration)

---

## Installation

```bash
# npm (recommended)
npm install -g mnemex

# homebrew (macOS)
brew tap MadAppGang/homebrew-tap && brew install mnemex

# or curl
curl -fsSL https://raw.githubusercontent.com/MadAppGang/mnemex/main/install.sh | bash
```

---

## Quick Start

```bash
# 1. First time setup (configure embedding provider)
mnemex init

# 2. Index your project
mnemex index

# 3. Search with natural language
mnemex search "authentication flow"
mnemex search "where do we handle errors"
```

---

## Core Commands

### `init` - Interactive Setup

Configure embedding and LLM providers interactively.

```bash
mnemex init
```

Configures:
- Embedding provider (OpenRouter, Ollama, or Custom endpoint)
- Embedding model selection
- LLM enrichment (optional semantic summaries)
- API keys

### `index` - Index Codebase

Parse and index your codebase for semantic search.

```bash
mnemex index [path]
```

**Options:**
| Flag | Description |
|------|-------------|
| `-f, --force` | Re-index every file of **this branch**; other branches keep their rows |
| `--force-all` | Rebuild the whole store, **every branch** — each one must index again |
| `--no-llm` | Disable LLM enrichment (faster, code-only) |

**Examples:**
```bash
# Index current directory
mnemex index

# Index specific path
mnemex index /path/to/project

# Re-index this branch from scratch (other branches are untouched)
mnemex index --force

# Rebuild the entire store, every branch
mnemex index --force-all

# Fast index without LLM summaries
mnemex index --no-llm
```

One index is shared by every branch and worktree of a repository. `--force`
therefore rebuilds **only the branch you are on**: a row another branch still
holds is kept and simply stops being yours. `--force-all` is the deliberate
whole-store rebuild; after it, every other branch reports itself empty until it
is indexed again. A model change, an index-version upgrade and a corrupt vector
column rebuild the whole store on their own, because each of those is a property
of the store rather than of one branch.

### `search` - Semantic Search

Search indexed code using natural language queries.

```bash
mnemex search <query> [options]
```

**Options:**
| Flag | Description |
|------|-------------|
| `-n, --limit <n>` | Maximum results (default: 10) |
| `-l, --language <lang>` | Filter by programming language |
| `-p, --path <path>` | Project path (default: current directory) |
| `-y, --yes` | Auto-create index if missing |
| `--no-reindex` | Skip auto-reindexing changed files |
| `--use-case <case>` | Search preset: `fim`, `search`, `navigation` |
| `-k, --keyword` | Keyword-only search (BM25, no embeddings) |

**Examples:**
```bash
# Basic search
mnemex search "authentication flow"

# Limit results
mnemex search "error handling" -n 5

# Filter by language
mnemex search "database queries" -l python

# Skip auto-reindex (faster)
mnemex search "config" --no-reindex

# Keyword-only search (no API calls)
mnemex search "parseJSON" --keyword
```

### `status` - Show Index Status

Display information about the current index.

```bash
mnemex status [path]
```

Shows:
- Number of indexed files
- Number of code chunks
- Last indexed timestamp
- Embedding model used
- Index size

### `clear` - Clear Index

Remove all indexed data for a project.

```bash
mnemex clear [path]
```

### `models` - List Embedding Models

Show available embedding models from OpenRouter.

```bash
mnemex models [options]
# or
mnemex --models [options]
```

**Options:**
| Flag | Description |
|------|-------------|
| `--free` | Show only free models |
| `--refresh` | Force refresh from API |
| `--ollama` | Show Ollama local models |

**Examples:**
```bash
# All models
mnemex --models

# Free models only
mnemex --models --free

# Ollama models
mnemex --models --ollama
```

---

## Symbol Graph Commands

These commands query the symbol graph for code navigation. Designed for AI agents.

### `map` - Repository Structure

Get a structured view of the codebase with PageRank-ranked symbols.

```bash
mnemex map [query] [options]
```

**Options:**
| Flag | Description |
|------|-------------|
| `--raw` | Machine-readable output (for parsing) |
| `--tokens <n>` | Max tokens for output (default: 2000) |

**Examples:**
```bash
# Full repo structure
mnemex map

# Focused on authentication
mnemex map "auth"

# For AI agent parsing
mnemex --nologo map --raw
```

### `symbol` - Find Symbol Definition

Locate where a symbol (function, class, etc.) is defined.

```bash
mnemex symbol <name> [options]
```

**Options:**
| Flag | Description |
|------|-------------|
| `--raw` | Machine-readable output |
| `--file <hint>` | Disambiguate by file path |

**Examples:**
```bash
# Find symbol
mnemex symbol createIndexer

# Disambiguate by file
mnemex symbol parse --file="parser.ts"
```

### `callers` - Find What Uses a Symbol

Discover all code that calls/references a symbol.

```bash
mnemex callers <name> [options]
```

**Options:**
| Flag | Description |
|------|-------------|
| `--raw` | Machine-readable output |
| `--callers <n>` | Max callers to show (default: 10) |

**Examples:**
```bash
# What uses VectorStore?
mnemex callers VectorStore

# Machine-readable
mnemex --nologo callers VectorStore --raw
```

### `callees` - Find What a Symbol Uses

Discover all symbols that a function/class depends on.

```bash
mnemex callees <name> [options]
```

**Options:**
| Flag | Description |
|------|-------------|
| `--raw` | Machine-readable output |
| `--callees <n>` | Max callees to show (default: 15) |

### `context` - Full Symbol Context

Get a symbol's definition along with its callers and callees.

```bash
mnemex context <name> [options]
```

Combines `symbol`, `callers`, and `callees` in one call.

---

## Code Analysis Commands

Static analysis commands powered by the symbol graph and PageRank.

### `dead-code` - Find Unused Code

Detect potentially dead code (zero callers + low PageRank).

```bash
mnemex dead-code [options]
```

**Options:**
| Flag | Description |
|------|-------------|
| `--max-pagerank <n>` | PageRank threshold (default: 0.001) |
| `--include-exported` | Include exported symbols |
| `-n, --limit <n>` | Max results (default: 50) |
| `--raw` | Machine-readable output |

**Examples:**
```bash
# Find dead code
mnemex dead-code

# Include exported symbols
mnemex dead-code --include-exported

# Lower threshold (more results)
mnemex dead-code --max-pagerank 0.01
```

### `test-gaps` - Find Untested Code

Find high-importance code that lacks test coverage.

```bash
mnemex test-gaps [options]
```

**Options:**
| Flag | Description |
|------|-------------|
| `--min-pagerank <n>` | Minimum PageRank (default: 0.01) |
| `-n, --limit <n>` | Max results (default: 30) |
| `--raw` | Machine-readable output |

### `impact` - Change Impact Analysis

Analyze the blast radius of changing a symbol.

```bash
mnemex impact <symbol> [options]
```

**Options:**
| Flag | Description |
|------|-------------|
| `--max-depth <n>` | Traversal depth (default: 10) |
| `--raw` | Machine-readable output |

**Examples:**
```bash
# What's affected if I change createIndexer?
mnemex impact createIndexer

# Limit depth
mnemex impact parseConfig --max-depth 5
```

---

## Benchmark Commands

### `benchmark` - Benchmarking Tools

`benchmark` is a parent command with subcommands. Running it with no subcommand
prints help and **runs nothing** — unknown flags (e.g. `mnemex benchmark --list`)
are rejected with a hint rather than silently launching a benchmark.

```bash
mnemex benchmark <subcommand> [options]
```

| Subcommand | Description |
|------------|-------------|
| `help` | Show benchmark help (default when no subcommand given) |
| `list` | List all benchmark runs |
| `show <run-id>` | Show results for a specific run |
| `llm [options]` | Comprehensive LLM summary evaluation (4 methods, resumable) |
| `embedding [options]` | Compare embedding models (index, search quality, cost; alias: `run`) |
| `delete <run-id>` | Delete a run and its report files (alias: `rm`) |

```bash
mnemex benchmark              # prints help, runs nothing
mnemex benchmark list
mnemex benchmark show <run-id>
mnemex benchmark llm --cases=20
mnemex benchmark embedding --auto
mnemex benchmark delete <run-id>
```

#### `benchmark embedding` - Embedding Model Benchmark

Compare embedding models for index speed, search quality, and cost. (Alias: `benchmark run`.)

```bash
mnemex benchmark embedding [options]
```

**Options:**
| Flag | Description |
|------|-------------|
| `--models=<list>` | Comma-separated model IDs to test |
| `--real` | Use 100 chunks (default: 50) |
| `--auto` | Auto-generate queries (works on any codebase) |
| `--verbose` | Show detailed per-query results |

**Examples:**
```bash
# Run on mnemex's test queries
mnemex benchmark embedding

# Auto-generate queries (any codebase)
mnemex benchmark embedding --auto

# Specific models
mnemex benchmark embedding --models=voyage-code-3,openai/text-embedding-3-small
```

#### `benchmark llm` - LLM Summary Benchmark

Comprehensive evaluation of LLM summary quality.

```bash
mnemex benchmark llm [options]
```

**Options:**
| Flag | Description |
|------|-------------|
| `--generators=<list>` | LLM models to test (comma-separated) |
| `--judges=<list>` | Judge models for evaluation |
| `--cases=<n>` | Number of code units (default: 20) |
| `--resume=<run-id>` | Resume from previous run |
| `--local-parallelism=<n>` | Local model parallelism (1, 2-4, or `all`) |
| `--no-upload` | Skip Firebase upload (local only) |
| `--list, -l` | List all benchmark runs |
| `--verbose, -v` | Show detailed progress |

**Subcommands:**
```bash
# List previous runs
mnemex benchmark llm --list

# Upload a specific run to Firebase
mnemex benchmark llm upload <run-id>
```

**Examples:**
```bash
# Compare multiple generators
mnemex benchmark llm --generators=openrouter/openai/gpt-4o,cc/haiku

# Resume interrupted run
mnemex benchmark llm --resume=abc123-def456

# Local only (no Firebase)
mnemex benchmark llm --no-upload

# Use Gemini as judge
mnemex benchmark llm --judges=google/gemini-2.0-flash-001
```

**Evaluation Methods:**
- **LLM-as-Judge** - Pointwise and pairwise comparison
- **Contrastive Matching** - Can agent distinguish similar code?
- **Retrieval (P@K/MRR)** - Can agent find the right code?
- **Self-Evaluation** - Can model use its own summaries?

**Outputs:**
- JSON report (detailed data)
- Markdown report (human-readable)
- HTML report (visual dashboard)

#### `benchmark list` - List Benchmark Runs

List all benchmark runs in the database.

```bash
mnemex benchmark list [options]
```

**Options:**
| Flag | Description |
|------|-------------|
| `--limit=<n>` | Max runs to show (default: 20) |
| `--status=<s>` | Filter by status: completed, failed, running |
| `--project=<path>` | Project path |

#### `benchmark show` - Show Benchmark Results

Display detailed results for a specific run.

```bash
mnemex benchmark show <run-id> [options]
```

**Options:**
| Flag | Description |
|------|-------------|
| `--json` | Output raw JSON instead of the interactive view |
| `--project=<path>` | Project path |

#### `benchmark delete` - Delete a Benchmark Run

Delete a run's database row and its on-disk report files
(`<run-id>.json`, `.md`, `.html` under `.mnemex/benchmark-reports`). Non-interactive
(no confirmation prompt) so it's safe in `--agent` mode.

```bash
mnemex benchmark delete <run-id> [options]
```

**Options:**
| Flag | Description |
|------|-------------|
| `--project=<path>` | Project path |
| `--yes, -y` | Accepted for symmetry; the command always just deletes |

---

## Server Modes

### MCP Server (Claude Code Integration)

Run mnemex as an MCP (Model Context Protocol) server for Claude Code.

```bash
mnemex --mcp
```

**Available Tools:**
- `search_code` - Semantic search (auto-indexes changes)
- `index_codebase` - Manual full reindex
- `get_status` - Check what's indexed
- `clear_index` - Start fresh

### Autocomplete Server

Run a JSONL server for editor autocomplete integration.

```bash
mnemex --autocomplete-server --project <path>
```

---

## Developer Experience

### `watch` - Auto-Reindex on Changes

Run in daemon mode, watching for file changes.

```bash
mnemex watch [options]
```

**Options:**
| Flag | Description |
|------|-------------|
| `--debounce <ms>` | Debounce time (default: 1000ms) |

### `hooks` - Git Hook Management

Install a post-commit hook for automatic indexing.

```bash
mnemex hooks <subcommand>
```

**Subcommands:**
| Command | Description |
|---------|-------------|
| `install` | Install git post-commit hook |
| `uninstall` | Remove the hook |
| `status` | Check if hook is installed |

**Examples:**
```bash
# Install hook
mnemex hooks install

# Check status
mnemex hooks status

# Remove hook
mnemex hooks uninstall
```

---

## Environment Variables

| Variable | Description |
|----------|-------------|
| `OPENROUTER_API_KEY` | API key for OpenRouter (embeddings + LLM) |
| `ANTHROPIC_API_KEY` | API key for Anthropic LLM |
| `VOYAGE_API_KEY` | API key for Voyage AI embeddings |
| `MNEMEX_MODEL` | Override default embedding model |
| `MNEMEX_LLM` | LLM spec for enrichment (see below) |

---

## LLM Provider Configuration

The `MNEMEX_LLM` environment variable uses a unified spec format:

| Prefix | Provider | Example |
|--------|----------|---------|
| `cc/` | Claude Code (subscription) | `cc/sonnet`, `cc/opus`, `cc/haiku` |
| `a/` | Anthropic API | `a/sonnet`, `a/opus` |
| `or/` | OpenRouter | `or/openai/gpt-4o`, `or/google/gemini-2.0-flash` |
| `ollama/` | Ollama (local) | `ollama/llama3.2`, `ollama/qwen2.5` |
| `lmstudio/` | LM Studio (local) | `lmstudio/` |

**Examples:**
```bash
# Use Claude Code subscription
export MNEMEX_LLM="cc/sonnet"

# Use OpenRouter
export MNEMEX_LLM="or/openai/gpt-4o"

# Use local Ollama
export MNEMEX_LLM="ollama/llama3.2"
```

---

## AI Agent Instructions

Get role-based prompts for AI agents.

```bash
mnemex ai <role> [options]
```

**Roles:**
- `skill` - Full skill document
- `architect` - System design, dead-code detection
- `developer` - Implementation, impact analysis
- `tester` - Test coverage gaps, test planning
- `debugger` - Error tracing, bug impact

**Options:**
| Flag | Description |
|------|-------------|
| `-c, --compact` | Minimal version (~50 tokens) |
| `-q, --quick` | Quick reference (~30 tokens) |
| `-m, --mcp-format` | MCP tools format |
| `-r, --raw` | No colors (for piping) |

**Examples:**
```bash
# Show available roles
mnemex ai

# Full skill document
mnemex ai skill

# Append to CLAUDE.md
mnemex ai skill --raw >> CLAUDE.md

# Compact developer instructions
mnemex ai developer --compact
```

---

## Global Options

| Flag | Description |
|------|-------------|
| `-v, --version` | Show version |
| `-h, --help` | Show help |
| `--nologo` | Suppress ASCII logo (for scripts/agents) |

---

## Configuration Files

| Path | Purpose |
|------|---------|
| `~/.mnemex/config.json` | Global config (provider, model, API keys) |
| `.mnemex/` | Project index directory (add to `.gitignore`) |
| `.mnemex/index.db` | SQLite vector database |
| `.mnemex/benchmark.db` | Benchmark results database |

---

## Supported Languages

Full AST-aware parsing:
- TypeScript
- JavaScript
- Python
- Go
- Rust
- C
- C++
- Java

Other languages fall back to line-based chunking.

---

## More Information

- GitHub: https://github.com/MadAppGang/mnemex
- npm: https://www.npmjs.com/package/mnemex
