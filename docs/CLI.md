# claudemem CLI Reference

Complete command-line interface documentation for claudemem - local semantic code search for Claude Code.

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
npm install -g claude-codemem

# homebrew (macOS)
brew tap MadAppGang/claude-mem && brew install --cask claudemem

# or curl
curl -fsSL https://raw.githubusercontent.com/MadAppGang/mnemex/main/install.sh | bash
```

---

## Quick Start

```bash
# 1. First time setup (configure embedding provider)
claudemem init

# 2. Index your project
claudemem index

# 3. Search with natural language
claudemem search "authentication flow"
claudemem search "where do we handle errors"
```

---

## Core Commands

### `init` - Interactive Setup

Configure embedding and LLM providers interactively.

```bash
claudemem init
```

Configures:
- Embedding provider (OpenRouter, Ollama, or Custom endpoint)
- Embedding model selection
- LLM enrichment (optional semantic summaries)
- API keys

### `index` - Index Codebase

Parse and index your codebase for semantic search.

```bash
claudemem index [path]
```

**Options:**
| Flag | Description |
|------|-------------|
| `-f, --force` | Force re-index all files (ignore cache) |
| `--no-llm` | Disable LLM enrichment (faster, code-only) |

**Examples:**
```bash
# Index current directory
claudemem index

# Index specific path
claudemem index /path/to/project

# Force full re-index
claudemem index --force

# Fast index without LLM summaries
claudemem index --no-llm
```

### `search` - Semantic Search

Search indexed code using natural language queries.

```bash
claudemem search <query> [options]
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
claudemem search "authentication flow"

# Limit results
claudemem search "error handling" -n 5

# Filter by language
claudemem search "database queries" -l python

# Skip auto-reindex (faster)
claudemem search "config" --no-reindex

# Keyword-only search (no API calls)
claudemem search "parseJSON" --keyword
```

### `status` - Show Index Status

Display information about the current index.

```bash
claudemem status [path]
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
claudemem clear [path]
```

### `models` - List Embedding Models

Show available embedding models from OpenRouter.

```bash
claudemem models [options]
# or
claudemem --models [options]
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
claudemem --models

# Free models only
claudemem --models --free

# Ollama models
claudemem --models --ollama
```

---

## Symbol Graph Commands

These commands query the symbol graph for code navigation. Designed for AI agents.

### `map` - Repository Structure

Get a structured view of the codebase with PageRank-ranked symbols.

```bash
claudemem map [query] [options]
```

**Options:**
| Flag | Description |
|------|-------------|
| `--raw` | Machine-readable output (for parsing) |
| `--tokens <n>` | Max tokens for output (default: 2000) |

**Examples:**
```bash
# Full repo structure
claudemem map

# Focused on authentication
claudemem map "auth"

# For AI agent parsing
claudemem --nologo map --raw
```

### `symbol` - Find Symbol Definition

Locate where a symbol (function, class, etc.) is defined.

```bash
claudemem symbol <name> [options]
```

**Options:**
| Flag | Description |
|------|-------------|
| `--raw` | Machine-readable output |
| `--file <hint>` | Disambiguate by file path |

**Examples:**
```bash
# Find symbol
claudemem symbol createIndexer

# Disambiguate by file
claudemem symbol parse --file="parser.ts"
```

### `callers` - Find What Uses a Symbol

Discover all code that calls/references a symbol.

```bash
claudemem callers <name> [options]
```

**Options:**
| Flag | Description |
|------|-------------|
| `--raw` | Machine-readable output |
| `--callers <n>` | Max callers to show (default: 10) |

**Examples:**
```bash
# What uses VectorStore?
claudemem callers VectorStore

# Machine-readable
claudemem --nologo callers VectorStore --raw
```

### `callees` - Find What a Symbol Uses

Discover all symbols that a function/class depends on.

```bash
claudemem callees <name> [options]
```

**Options:**
| Flag | Description |
|------|-------------|
| `--raw` | Machine-readable output |
| `--callees <n>` | Max callees to show (default: 15) |

### `context` - Full Symbol Context

Get a symbol's definition along with its callers and callees.

```bash
claudemem context <name> [options]
```

Combines `symbol`, `callers`, and `callees` in one call.

---

## Code Analysis Commands

Static analysis commands powered by the symbol graph and PageRank.

### `dead-code` - Find Unused Code

Detect potentially dead code (zero callers + low PageRank).

```bash
claudemem dead-code [options]
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
claudemem dead-code

# Include exported symbols
claudemem dead-code --include-exported

# Lower threshold (more results)
claudemem dead-code --max-pagerank 0.01
```

### `test-gaps` - Find Untested Code

Find high-importance code that lacks test coverage.

```bash
claudemem test-gaps [options]
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
claudemem impact <symbol> [options]
```

**Options:**
| Flag | Description |
|------|-------------|
| `--max-depth <n>` | Traversal depth (default: 10) |
| `--raw` | Machine-readable output |

**Examples:**
```bash
# What's affected if I change createIndexer?
claudemem impact createIndexer

# Limit depth
claudemem impact parseConfig --max-depth 5
```

---

## Benchmark Commands

### `benchmark` - Embedding Model Benchmark

Compare embedding models for index speed, search quality, and cost.

```bash
claudemem benchmark [options]
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
# Run on claudemem's test queries
claudemem benchmark

# Auto-generate queries (any codebase)
claudemem benchmark --auto

# Specific models
claudemem benchmark --models=voyage-code-3,openai/text-embedding-3-small
```

### `benchmark-llm` - LLM Summary Benchmark

Comprehensive evaluation of LLM summary quality.

```bash
claudemem benchmark-llm [options]
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
claudemem benchmark-llm --list

# Upload a specific run to Firebase
claudemem benchmark-llm upload <run-id>
```

**Examples:**
```bash
# Compare multiple generators
claudemem benchmark-llm --generators=openrouter/openai/gpt-4o,cc/haiku

# Resume interrupted run
claudemem benchmark-llm --resume=abc123-def456

# Local only (no Firebase)
claudemem benchmark-llm --no-upload

# Use Gemini as judge
claudemem benchmark-llm --judges=google/gemini-2.0-flash-001
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

### `benchmark-list` - List Benchmark Runs

List all benchmark runs in the database.

```bash
claudemem benchmark-list [options]
```

**Options:**
| Flag | Description |
|------|-------------|
| `--limit=<n>` | Max runs to show (default: 20) |
| `--status=<s>` | Filter by status: completed, failed, running |
| `--project=<path>` | Project path |

### `benchmark-show` - Show Benchmark Results

Display detailed results for a specific run.

```bash
claudemem benchmark-show <run-id> [options]
```

---

## Server Modes

### MCP Server (Claude Code Integration)

Run claudemem as an MCP (Model Context Protocol) server for Claude Code.

```bash
claudemem --mcp
```

**Available Tools:**
- `search_code` - Semantic search (auto-indexes changes)
- `index_codebase` - Manual full reindex
- `get_status` - Check what's indexed
- `clear_index` - Start fresh

### Autocomplete Server

Run a JSONL server for editor autocomplete integration.

```bash
claudemem --autocomplete-server --project <path>
```

---

## Developer Experience

### `watch` - Auto-Reindex on Changes

Run in daemon mode, watching for file changes.

```bash
claudemem watch [options]
```

**Options:**
| Flag | Description |
|------|-------------|
| `--debounce <ms>` | Debounce time (default: 1000ms) |

### `hooks` - Git Hook Management

Install a post-commit hook for automatic indexing.

```bash
claudemem hooks <subcommand>
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
claudemem hooks install

# Check status
claudemem hooks status

# Remove hook
claudemem hooks uninstall
```

---

## Environment Variables

| Variable | Description |
|----------|-------------|
| `OPENROUTER_API_KEY` | API key for OpenRouter (embeddings + LLM) |
| `ANTHROPIC_API_KEY` | API key for Anthropic LLM |
| `VOYAGE_API_KEY` | API key for Voyage AI embeddings |
| `CLAUDEMEM_MODEL` | Override default embedding model |
| `CLAUDEMEM_LLM` | LLM spec for enrichment (see below) |

---

## LLM Provider Configuration

The `CLAUDEMEM_LLM` environment variable uses a unified spec format:

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
export CLAUDEMEM_LLM="cc/sonnet"

# Use OpenRouter
export CLAUDEMEM_LLM="or/openai/gpt-4o"

# Use local Ollama
export CLAUDEMEM_LLM="ollama/llama3.2"
```

---

## AI Agent Instructions

Get role-based prompts for AI agents.

```bash
claudemem ai <role> [options]
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
claudemem ai

# Full skill document
claudemem ai skill

# Append to CLAUDE.md
claudemem ai skill --raw >> CLAUDE.md

# Compact developer instructions
claudemem ai developer --compact
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
| `~/.claudemem/config.json` | Global config (provider, model, API keys) |
| `.claudemem/` | Project index directory (add to `.gitignore`) |
| `.claudemem/index.db` | SQLite vector database |
| `.claudemem/benchmark.db` | Benchmark results database |

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
- npm: https://www.npmjs.com/package/claude-codemem
