# claudemem + Claude Code Integration Guide

Complete guide for using claudemem with Claude Code and the Code Analysis Plugin for intelligent codebase investigation.

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Quick Start](#quick-start)
- [Installing the Code Analysis Plugin](#installing-the-code-analysis-plugin)
- [How It Works](#how-it-works)
- [Detective Skills](#detective-skills)
- [Workflow Examples](#workflow-examples)
- [Command Reference](#command-reference)
- [Best Practices](#best-practices)
- [Troubleshooting](#troubleshooting)

---

## Overview

**claudemem** is a local semantic code search tool that provides AST-based structural analysis with PageRank ranking. When combined with Claude Code's **Code Analysis Plugin**, it enables Claude to intelligently navigate and understand codebases using:

- **Semantic search** - Natural language queries that understand code meaning
- **Symbol graph** - PageRank-based importance ranking
- **Call chain analysis** - callers/callees for impact assessment
- **Dead code detection** - Find unused symbols
- **Test gap analysis** - Identify untested high-importance code

```
┌─────────────────────────────────────────────────────────────────┐
│                    CLAUDEMEM + CLAUDE CODE                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                   CLAUDE CODE                              │  │
│  │  User Query → Code Analysis Plugin → Detective Skills      │  │
│  └───────────────────────────────────────────────────────────┘  │
│                              ↓                                   │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                   CLAUDEMEM CLI                            │  │
│  │  map | symbol | callers | callees | context | search       │  │
│  └───────────────────────────────────────────────────────────┘  │
│                              ↓                                   │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                   LOCAL INDEX                              │  │
│  │  AST Parse → Symbol Graph → PageRank → LanceDB Vectors     │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Architecture

### Components

| Component | Purpose |
|-----------|---------|
| **claudemem CLI** | Local semantic code search with AST analysis |
| **Code Analysis Plugin** | Claude Code plugin that provides detective skills |
| **Detective Skills** | Role-based investigation patterns (architect, developer, tester, debugger) |
| **PreToolUse Hooks** | Intercept grep/find/glob and suggest claudemem instead |

### Why This Matters

Traditional code search (grep, find, glob) returns **string matches**. claudemem returns **semantic relationships**:

| Approach | What You Get | Token Cost |
|----------|--------------|------------|
| `grep -r "auth"` | Every line containing "auth" | High (irrelevant matches) |
| `claudemem search "authentication"` | Functions handling authentication | Low (ranked results) |
| `claudemem callers authenticate` | Every function that uses auth | Precise (impact analysis) |

---

## Quick Start

### Step 1: Install claudemem

```bash
# npm (recommended)
npm install -g claude-codemem

# or homebrew (macOS)
brew tap MadAppGang/claude-mem && brew install --cask claudemem

# or curl
curl -fsSL https://raw.githubusercontent.com/MadAppGang/mnemex/main/install.sh | bash
```

### Step 2: Configure and Index

```bash
# First time setup (configure embedding provider)
claudemem init

# Index your project
cd /path/to/your/project
claudemem index

# Verify
claudemem status
```

### Step 3: Add the MAG Claude Plugins Marketplace

```bash
# In Claude Code, add the marketplace globally (one-time setup)
/plugin marketplace add MadAppGang/claude-code
```

Then enable the code-analysis plugin in your project's `.claude/settings.json`:

```json
{
  "enabledPlugins": {
    "code-analysis@mag-claude-plugins": true
  }
}
```

Commit this file to git so your team gets the same setup automatically.

### Step 4: Start Using

Now in Claude Code, just ask questions naturally:

```
"How does authentication work in this codebase?"
"Find all usages of the PaymentService class"
"What would break if I change the authenticate function?"
```

Claude will automatically use claudemem through the detective skills.

---

## Installing the Code Analysis Plugin

### Step 1: Add the Marketplace (One-Time Setup)

Each developer on your team does this once:

```bash
# In Claude Code
/plugin marketplace add MadAppGang/claude-code
```

This registers the MAG Claude Plugins marketplace in your Claude Code installation.

### Step 2: Enable Plugin in Your Project

Add or edit `.claude/settings.json` in your project root:

```json
{
  "enabledPlugins": {
    "code-analysis@mag-claude-plugins": true
  }
}
```

**Commit this file to git** so team members get the same setup automatically.

### Multiple Plugins

Need more plugins from the marketplace? Add more entries:

```json
{
  "enabledPlugins": {
    "code-analysis@mag-claude-plugins": true,
    "frontend@mag-claude-plugins": true,
    "orchestration@mag-claude-plugins": true
  }
}
```

### Updating Plugins

To update to the latest version:

```bash
/plugin marketplace update mag-claude-plugins
```

### Verify Installation

In Claude Code, the plugin adds these skills (visible in `/skills`):
- `claudemem-search`
- `developer-detective`
- `architect-detective`
- `tester-detective`
- `debugger-detective`
- `ultrathink-detective`

---

## How It Works

### 1. Automatic Skill Selection

When you ask Claude a question, the Code Analysis Plugin automatically selects the appropriate detective skill:

| Your Question | Skill Used | Why |
|---------------|------------|-----|
| "How does X work?" | developer-detective | Implementation focus |
| "What's the architecture?" | architect-detective | Structure focus |
| "What's tested?" | tester-detective | Coverage focus |
| "Why is X broken?" | debugger-detective | Bug investigation |
| "Full codebase review" | ultrathink-detective | Comprehensive analysis |

### 2. Hook Interception

The plugin includes PreToolUse hooks that intercept inefficient search patterns:

```
User: "Find all files with database queries"
Claude: [About to use Grep tool]
Hook: ⚠️ Consider using claudemem instead:
      claudemem --nologo map "database query" --raw
```

This guides Claude toward the more efficient claudemem commands.

### 3. claudemem Commands

The skills use these claudemem commands in a specific order:

```bash
# 1. Get structural overview (ALWAYS FIRST)
claudemem --nologo map "feature area" --raw

# 2. Find specific symbol
claudemem --nologo symbol SymbolName --raw

# 3. Check what uses it (impact analysis)
claudemem --nologo callers SymbolName --raw

# 4. Check what it depends on
claudemem --nologo callees SymbolName --raw

# 5. Get full context (symbol + callers + callees)
claudemem --nologo context SymbolName --raw

# 6. Semantic search for code snippets
claudemem --nologo search "natural language query" --raw
```

---

## Detective Skills

### developer-detective

**Purpose:** Implementation investigation using callers/callees analysis

**Best for:**
- "How does X work?"
- "Find implementation of Y"
- "Trace data flow through Z"
- "What would break if I change W?"

**Example workflow:**
```bash
# Find the symbol
claudemem --nologo symbol processPayment --raw

# Trace what it calls (dependencies)
claudemem --nologo callees processPayment --raw

# Trace what calls it (impact)
claudemem --nologo callers processPayment --raw
```

### architect-detective

**Purpose:** System design and architectural analysis

**Best for:**
- "What's the architecture?"
- "Find design patterns"
- "Map the system layers"
- "Identify dead code"

**Example workflow:**
```bash
# Get full repo structure with PageRank
claudemem --nologo map --raw

# Focus on high PageRank symbols (> 0.05 = core abstractions)
claudemem --nologo map "service controller" --raw

# Find dead code (cleanup opportunities)
claudemem --nologo dead-code --raw
```

### tester-detective

**Purpose:** Test coverage and quality analysis

**Best for:**
- "What's tested?"
- "Find test coverage gaps"
- "Which critical code lacks tests?"

**Example workflow:**
```bash
# Find test gaps (high PageRank + no test callers)
claudemem --nologo test-gaps --raw

# Check test coverage for specific function
claudemem --nologo callers criticalFunction --raw
# Look for callers from *.test.ts, *.spec.ts files
```

### debugger-detective

**Purpose:** Bug investigation and root cause analysis

**Best for:**
- "Why is X broken?"
- "Find the bug source"
- "Trace error handling"

**Example workflow:**
```bash
# Locate the buggy function
claudemem --nologo symbol brokenFunction --raw

# Get full context (callers + callees)
claudemem --nologo context brokenFunction --raw

# Check impact of potential fix
claudemem --nologo impact brokenFunction --raw
```

### ultrathink-detective

**Purpose:** Comprehensive multi-dimensional analysis (uses Opus model)

**Best for:**
- "Full codebase review"
- "Comprehensive audit"
- "Deep investigation"
- Complex bugs spanning multiple systems

**Example workflow:**
```bash
# All dimensions analyzed:
# 1. Architecture (map)
# 2. Implementation (callers/callees)
# 3. Test coverage (test-gaps)
# 4. Reliability (context)
# 5. Security (auth callers)
# 6. Performance (search patterns)
# 7. Code health (dead-code + impact)
```

---

## Workflow Examples

### Example 1: Understanding a New Codebase

**User prompt:** "Help me understand how this codebase works"

**What Claude does:**
```bash
# 1. Get structural overview
claudemem --nologo map --raw
# → Identifies high-PageRank symbols (core abstractions)

# 2. For each core abstraction, trace dependencies
claudemem --nologo context CoreService --raw
# → Shows what it depends on and what depends on it

# 3. Map the layers
claudemem --nologo map "controller handler endpoint" --raw  # Presentation
claudemem --nologo map "service business domain" --raw      # Business
claudemem --nologo map "repository database" --raw          # Data
```

**Output:** Architecture diagram with core abstractions, layer structure, and data flows.

### Example 2: Safe Refactoring

**User prompt:** "I want to rename DatabaseConnection to DatabasePool"

**What Claude does:**
```bash
# 1. Find the symbol
claudemem --nologo symbol DatabaseConnection --raw
# → src/db/connection.ts:15-89

# 2. Get ALL callers (impact radius)
claudemem --nologo callers DatabaseConnection --raw
# → Shows every file:line that references it

# 3. For each caller, update systematically
# ... edits each location ...

# 4. Verify no remaining references
claudemem --nologo callers DatabasePool --raw
```

### Example 3: Bug Investigation

**User prompt:** "Users are getting 500 errors during checkout"

**What Claude does:**
```bash
# 1. Map checkout-related code
claudemem --nologo map "checkout payment error" --raw

# 2. Find the checkout handler
claudemem --nologo symbol CheckoutController --raw

# 3. Trace the flow
claudemem --nologo callees CheckoutController --raw
# → validateCart → processPayment → saveOrder

# 4. Get full context for the likely culprit
claudemem --nologo context processPayment --raw

# 5. Check error handling
claudemem --nologo map "throw error exception checkout" --raw
```

### Example 4: Adding a New Feature

**User prompt:** "Add rate limiting to the API endpoints"

**What Claude does:**
```bash
# 1. Map existing API structure
claudemem --nologo map "API middleware endpoint" --raw

# 2. Find where requests are handled
claudemem --nologo symbol APIMiddleware --raw

# 3. Check what patterns already exist
claudemem --nologo callees APIMiddleware --raw

# 4. Find similar existing middleware for patterns
claudemem --nologo search "middleware validation guard" --raw

# 5. Implement following existing patterns
```

---

## Command Reference

### Core Commands (v0.3.0+)

| Command | Purpose | Typical Use |
|---------|---------|-------------|
| `map [query]` | Structural overview with PageRank | Always first - understand before diving in |
| `symbol <name>` | Find exact location | When you know the symbol name |
| `callers <name>` | What calls this? | Before any modification - know the impact |
| `callees <name>` | What does this call? | Trace dependencies and data flow |
| `context <name>` | Full context | Complex modifications needing awareness |
| `search <query>` | Semantic search | When you need actual code snippets |

### Analysis Commands (v0.4.0+)

| Command | Purpose | Typical Use |
|---------|---------|-------------|
| `dead-code` | Find unused symbols | Cleanup and tech debt assessment |
| `test-gaps` | Find untested code | Test coverage analysis |
| `impact <name>` | Transitive callers | Risk assessment before refactoring |

### Output Flags

| Flag | Purpose |
|------|---------|
| `--nologo` | Suppress ASCII art (required for parsing) |
| `--raw` | Machine-readable output format |
| `--tokens <n>` | Limit output tokens |

---

## Best Practices

### DO:

✅ **Always start with `map`** - Understand structure before diving in
```bash
claudemem --nologo map "feature area" --raw
```

✅ **Check `callers` before modifying** - Know your impact radius
```bash
claudemem --nologo callers functionToChange --raw
```

✅ **Focus on high PageRank first** - These are core abstractions
```
PageRank > 0.05 = Architectural pillar
PageRank 0.01-0.05 = Important symbol
PageRank < 0.01 = Utility code
```

✅ **Read specific file:line ranges** - Not whole files
```bash
# Good: Read only the relevant lines
Read({ file_path: "src/auth.ts", offset: 45, limit: 20 })

# Bad: Read entire file
Read({ file_path: "src/auth.ts" })
```

✅ **Use `--nologo --raw` for all commands** - Clean, parseable output
```bash
claudemem --nologo search "query" --raw
```

### DON'T:

❌ **Don't use grep/find for semantic questions**
```bash
# Bad: Returns string matches, not relationships
grep -r "authenticate" .

# Good: Returns semantic relationships
claudemem --nologo callers authenticate --raw
```

❌ **Don't modify without checking callers**
```bash
# Bad: Edit without knowing impact
Edit({ file: "auth.ts", ... })

# Good: Check impact first
claudemem --nologo callers functionToChange --raw
# Then edit with full awareness
```

❌ **Don't search before mapping**
```bash
# Bad: Search results lack context
claudemem --nologo search "fix the bug" --raw

# Good: Map first, then search
claudemem --nologo map "feature area" --raw
claudemem --nologo search "specific query" --raw
```

---

## Troubleshooting

### "claudemem: command not found"

```bash
# Install globally via npm
npm install -g claude-codemem

# Or add to PATH if installed via homebrew
export PATH="/opt/homebrew/bin:$PATH"

# Verify
which claudemem
claudemem --version  # Should be 0.3.0+
```

### "No index found"

```bash
# Index your project
cd /path/to/project
claudemem index

# Check status
claudemem status
```

### "OPENROUTER_API_KEY not set"

claudemem needs an API key for embeddings:

```bash
# Set your OpenRouter API key
export OPENROUTER_API_KEY="your-key-here"

# Or configure during init
claudemem init
```

Get a free key at https://openrouter.ai

### Plugin not working

```bash
# Verify marketplace is added
/plugin marketplace list

# Should show: mag-claude-plugins

# If not listed, add it:
/plugin marketplace add MadAppGang/claude-code

# Verify plugin is enabled
/plugin list

# Should show: code-analysis@mag-claude-plugins

# If not enabled, check .claude/settings.json has:
# { "enabledPlugins": { "code-analysis@mag-claude-plugins": true } }
```

### Commands returning empty results

```bash
# Check if index is up to date
claudemem status

# Re-index if needed
claudemem index --force

# Check version for newer commands
claudemem --version
# dead-code, test-gaps, impact require v0.4.0+
```

---

## Requirements

| Requirement | Version | Notes |
|-------------|---------|-------|
| claudemem | 0.3.0+ | Core commands (map, symbol, callers, callees, context) |
| claudemem | 0.4.0+ | Analysis commands (dead-code, test-gaps, impact) |
| Claude Code | Latest | Plugin support required |
| Node.js | 18+ | For npm installation |
| API Key | OpenRouter | For embeddings (free tier available) |

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

- **claudemem GitHub:** https://github.com/MadAppGang/mnemex
- **claudemem npm:** https://www.npmjs.com/package/claude-codemem
- **Claude Code Plugins:** https://docs.anthropic.com/en/docs/claude-code/plugins
- **Plugin Marketplace:** mag-claude-plugins

---

**Maintained by:** MadAppGang
**Last Updated:** December 2025
