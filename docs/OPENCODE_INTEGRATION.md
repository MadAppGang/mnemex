# claudemem + OpenCode Integration Guide

Integrate claudemem with [OpenCode](https://opencode.ai/) to replace grep/glob/list with intelligent semantic search.

## Table of Contents

- [Overview](#overview)
- [Quick Start](#quick-start)
- [Plugin Installation](#plugin-installation)
- [How It Works](#how-it-works)
- [Configuration Options](#configuration-options)
- [Custom Tools](#custom-tools)
- [Troubleshooting](#troubleshooting)

---

## Overview

[OpenCode](https://github.com/sst/opencode) is an open-source AI coding agent for the terminal. Like Claude Code, it has a plugin system with hooks that can intercept tool executions.

**The integration works by:**
1. Intercepting `grep`, `glob`, `list`, and `read` tool calls via `tool.execute.before` hook
2. Suggesting claudemem alternatives for semantic queries
3. Optionally replacing tools entirely with claudemem commands

```
┌─────────────────────────────────────────────────────────────────┐
│                    OPENCODE + CLAUDEMEM                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  User Query: "Find authentication code"                         │
│                              ↓                                   │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                   OPENCODE                                 │  │
│  │  LLM decides to use: grep tool                            │  │
│  └───────────────────────────────────────────────────────────┘  │
│                              ↓                                   │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │              tool.execute.before HOOK                      │  │
│  │  Intercepts grep → Suggests: claudemem search "auth"       │  │
│  └───────────────────────────────────────────────────────────┘  │
│                              ↓                                   │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                   CLAUDEMEM                                │  │
│  │  Semantic search → Ranked results with PageRank           │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Quick Start

### Step 1: Install claudemem

```bash
npm install -g claude-codemem
```

### Step 2: Index Your Project

```bash
cd /path/to/your/project
claudemem init    # First-time setup
claudemem index   # Index codebase
```

### Step 3: Install the Plugin

```bash
# Create plugin directory
mkdir -p .opencode/plugin

# Download the plugin
curl -o .opencode/plugin/claudemem.ts \
  https://raw.githubusercontent.com/MadAppGang/mnemex/main/integrations/opencode/claudemem.ts
```

Or create it manually (see [Plugin Installation](#plugin-installation)).

### Step 4: Configure OpenCode

Add to your `opencode.json`:

```json
{
  "plugin": [
    "file://.opencode/plugin/claudemem.ts"
  ]
}
```

---

## Plugin Installation

### Option 1: Minimal Plugin (Suggestion Only)

This version suggests claudemem alternatives without blocking the original tool:

Create `.opencode/plugin/claudemem.ts`:

```typescript
/**
 * claudemem Integration Plugin for OpenCode
 *
 * Intercepts grep/glob/list tools and suggests claudemem alternatives
 * for semantic code search.
 */

import type { Plugin } from "opencode"

export const ClaudemumPlugin: Plugin = async (ctx) => {
  const { $ } = ctx

  // Check if claudemem is available
  let claudememAvailable = false
  try {
    const result = await $`which claudemem`
    claudememAvailable = result.exitCode === 0
  } catch {
    claudememAvailable = false
  }

  return {
    "tool.execute.before": async (input, output) => {
      if (!claudememAvailable) return

      const tool = input.tool
      const args = output.args

      // Intercept grep with semantic queries
      if (tool === "grep" && args.pattern) {
        const pattern = args.pattern

        // Detect semantic queries (not regex patterns)
        const isSemanticQuery = !pattern.match(/[\[\]\(\)\|\*\+\?\{\}\\^$]/)

        if (isSemanticQuery) {
          console.log(`\n💡 Tip: For semantic search, try:`)
          console.log(`   claudemem --nologo search "${pattern}" --raw\n`)
        }
      }

      // Intercept glob for broad file searches
      if (tool === "glob" && args.pattern) {
        const pattern = args.pattern

        // Detect broad patterns like **/*.ts
        if (pattern.includes("**")) {
          console.log(`\n💡 Tip: For structural overview, try:`)
          console.log(`   claudemem --nologo map --raw\n`)
        }
      }

      // Intercept list for directory exploration
      if (tool === "list") {
        console.log(`\n💡 Tip: For codebase structure, try:`)
        console.log(`   claudemem --nologo map --raw\n`)
      }
    },
  }
}
```

### Option 2: Full Replacement Plugin

This version replaces grep/glob with claudemem when appropriate:

Create `.opencode/plugin/claudemem-replace.ts`:

```typescript
/**
 * claudemem Full Replacement Plugin for OpenCode
 *
 * Replaces grep/glob with claudemem for semantic queries.
 * Falls back to original tools for regex patterns.
 */

import type { Plugin } from "opencode"

interface ClaudemumResult {
  file: string
  line: string
  kind: string
  name: string
  score?: number
  content?: string
}

export const ClaudemumReplacePlugin: Plugin = async (ctx) => {
  const { $ } = ctx

  // Check if claudemem is available and indexed
  let claudememReady = false
  try {
    const result = await $`claudemem status 2>/dev/null`
    claudememReady = result.exitCode === 0
  } catch {
    claudememReady = false
  }

  // Helper to parse claudemem --raw output
  const parseClaudemumOutput = (output: string): ClaudemumResult[] => {
    const results: ClaudemumResult[] = []
    const records = output.split("---")

    for (const record of records) {
      const lines = record.trim().split("\n")
      const result: Partial<ClaudemumResult> = {}

      for (const line of lines) {
        const [key, ...valueParts] = line.split(": ")
        const value = valueParts.join(": ").trim()
        if (key && value) {
          result[key as keyof ClaudemumResult] = value
        }
      }

      if (result.file) {
        results.push(result as ClaudemumResult)
      }
    }

    return results
  }

  return {
    "tool.execute.before": async (input, output) => {
      if (!claudememReady) return

      const tool = input.tool
      const args = output.args

      // Replace grep with claudemem search for semantic queries
      if (tool === "grep" && args.pattern) {
        const pattern = args.pattern

        // Detect if this is a semantic query (not a regex)
        const isRegex = /[\[\]\(\)\|\*\+\?\{\}\\^$]/.test(pattern)

        if (!isRegex) {
          try {
            const result = await $`claudemem --nologo search ${pattern} --raw -n 10`

            if (result.exitCode === 0 && result.stdout.trim()) {
              const matches = parseClaudemumOutput(result.stdout)

              // Format as grep-like output
              const formatted = matches.map(m =>
                `${m.file}:${m.line}: ${m.name} (${m.kind})`
              ).join("\n")

              // Return the result, preventing original grep execution
              output.result = formatted
              output.skip = true

              console.log(`\n🔍 claudemem semantic search: ${matches.length} results\n`)
            }
          } catch (e) {
            // Fall back to original grep on error
            console.log(`\n⚠️ claudemem failed, using grep\n`)
          }
        }
      }

      // Replace glob with claudemem map for broad searches
      if (tool === "glob" && args.pattern) {
        const pattern = args.pattern

        // Only intercept very broad patterns
        if (pattern === "**/*" || pattern === "**/*.ts" || pattern === "**/*.js") {
          try {
            const result = await $`claudemem --nologo map --raw --tokens 2000`

            if (result.exitCode === 0 && result.stdout.trim()) {
              output.result = result.stdout
              output.skip = true

              console.log(`\n📊 claudemem map: structural overview\n`)
            }
          } catch {
            // Fall back to original glob
          }
        }
      }
    },
  }
}
```

### Option 3: Custom Tools Plugin

Add claudemem as custom tools alongside built-in tools:

Create `.opencode/plugin/claudemem-tools.ts`:

```typescript
/**
 * claudemem Custom Tools Plugin for OpenCode
 *
 * Adds claudemem commands as first-class tools.
 */

import type { Plugin } from "opencode"
import { tool } from "opencode"

export const ClaudemumToolsPlugin: Plugin = async (ctx) => {
  const { $ } = ctx

  return {
    tool: {
      // Semantic code search
      claudemem_search: tool({
        description: "Semantic code search using natural language. Better than grep for understanding code meaning.",
        args: {
          query: tool.schema.string().describe("Natural language search query"),
          limit: tool.schema.number().optional().describe("Max results (default: 10)"),
        },
        async execute({ query, limit = 10 }) {
          const result = await $`claudemem --nologo search ${query} --raw -n ${limit}`
          return result.stdout || "No results found"
        },
      }),

      // Repository structure map
      claudemem_map: tool({
        description: "Get structural overview of codebase with PageRank-ranked symbols. Use before diving into code.",
        args: {
          query: tool.schema.string().optional().describe("Focus area (optional)"),
          tokens: tool.schema.number().optional().describe("Max tokens (default: 2000)"),
        },
        async execute({ query, tokens = 2000 }) {
          const cmd = query
            ? $`claudemem --nologo map ${query} --raw --tokens ${tokens}`
            : $`claudemem --nologo map --raw --tokens ${tokens}`
          const result = await cmd
          return result.stdout || "No symbols found"
        },
      }),

      // Find symbol definition
      claudemem_symbol: tool({
        description: "Find exact location of a symbol (function, class, etc.) by name.",
        args: {
          name: tool.schema.string().describe("Symbol name to find"),
        },
        async execute({ name }) {
          const result = await $`claudemem --nologo symbol ${name} --raw`
          return result.stdout || `Symbol '${name}' not found`
        },
      }),

      // Find callers (impact analysis)
      claudemem_callers: tool({
        description: "Find all code that calls/uses a symbol. Essential before modifying any code.",
        args: {
          name: tool.schema.string().describe("Symbol name"),
        },
        async execute({ name }) {
          const result = await $`claudemem --nologo callers ${name} --raw`
          return result.stdout || `No callers found for '${name}'`
        },
      }),

      // Find callees (dependencies)
      claudemem_callees: tool({
        description: "Find all symbols that a function/class calls. Traces data flow and dependencies.",
        args: {
          name: tool.schema.string().describe("Symbol name"),
        },
        async execute({ name }) {
          const result = await $`claudemem --nologo callees ${name} --raw`
          return result.stdout || `No callees found for '${name}'`
        },
      }),

      // Full context
      claudemem_context: tool({
        description: "Get full context: symbol definition + callers + callees. Use for complex modifications.",
        args: {
          name: tool.schema.string().describe("Symbol name"),
        },
        async execute({ name }) {
          const result = await $`claudemem --nologo context ${name} --raw`
          return result.stdout || `Context not found for '${name}'`
        },
      }),
    },
  }
}
```

---

## How It Works

### Hook Types Used

| Hook | Purpose |
|------|---------|
| `tool.execute.before` | Intercept grep/glob/list before execution |
| `tool.execute.after` | (Optional) Post-process results |

### Tools Intercepted

| OpenCode Tool | claudemem Alternative | When to Replace |
|---------------|----------------------|-----------------|
| `grep` | `claudemem search` | Semantic/natural language queries |
| `glob` | `claudemem map` | Broad file pattern searches |
| `list` | `claudemem map` | Directory structure exploration |
| `read` | (No replacement) | Use after claudemem locates files |

### Decision Logic

```
grep "authentication flow"
  → Is it a regex? (has special chars like [, ], |, *, etc.)
    → YES: Use original grep
    → NO: Use claudemem search (semantic)

glob "**/*.ts"
  → Is it a broad pattern?
    → YES: Suggest claudemem map
    → NO: Use original glob
```

---

## Configuration Options

### opencode.json

```json
{
  "plugin": [
    "file://.opencode/plugin/claudemem.ts"
  ],
  "tools": {
    "claudemem_search": true,
    "claudemem_map": true,
    "claudemem_symbol": true,
    "claudemem_callers": true,
    "claudemem_callees": true,
    "claudemem_context": true
  }
}
```

### Environment Variables

```bash
# Required for claudemem
export OPENROUTER_API_KEY="your-key"

# Optional: Override default model
export CLAUDEMEM_MODEL="voyage/voyage-code-3"
```

---

## Custom Tools

When using the custom tools plugin, OpenCode's LLM can directly call:

| Tool | Example |
|------|---------|
| `claudemem_search` | "Find error handling code" |
| `claudemem_map` | "Show me the codebase structure" |
| `claudemem_symbol` | "Find the UserService class" |
| `claudemem_callers` | "What calls processPayment?" |
| `claudemem_callees` | "What does AuthService depend on?" |
| `claudemem_context` | "Full context for DatabasePool" |

### Benefits Over Built-in Tools

| Built-in Tool | Limitation | claudemem Advantage |
|---------------|------------|---------------------|
| grep | String matching only | Semantic understanding |
| glob | Returns all matches | PageRank-ranked results |
| list | Flat directory listing | Symbol graph with importance |
| read | Reads whole files | Targeted file:line locations |

---

## Troubleshooting

### "claudemem: command not found"

```bash
# Install globally
npm install -g claude-codemem

# Verify
which claudemem
claudemem --version
```

### "No index found"

```bash
# Index your project
claudemem init
claudemem index
claudemem status
```

### Plugin not loading

```bash
# Check plugin syntax
bun check .opencode/plugin/claudemem.ts

# Verify opencode.json
cat opencode.json | jq '.plugin'
```

### Hook not firing

The `tool.execute.before` hook only fires when the LLM actually uses the tool. If you're not seeing interception:

1. Ensure the plugin is loaded (check OpenCode logs)
2. Verify claudemem is installed and indexed
3. Check that the query triggers grep/glob (not another tool)

---

## Comparison: Claude Code vs OpenCode

| Feature | Claude Code | OpenCode |
|---------|-------------|----------|
| Hook system | PreToolUse/PostToolUse | tool.execute.before/after |
| Plugin location | `.claude/plugins/` | `.opencode/plugin/` |
| Config format | `plugin.json` | `opencode.json` |
| Tool interception | Block + return message | Set `output.skip = true` |
| Custom tools | MCP servers | `tool` export in plugin |

The integration pattern is nearly identical - both use pre-execution hooks to intercept and optionally replace tool behavior.

---

## Sources

- [OpenCode Official Site](https://opencode.ai/)
- [OpenCode GitHub](https://github.com/sst/opencode)
- [OpenCode Plugins Documentation](https://opencode.ai/docs/plugins/)
- [OpenCode Tools Documentation](https://opencode.ai/docs/tools/)
- [OpenCode Config Documentation](https://opencode.ai/docs/config/)
- [Plugin Development Guide](https://gist.github.com/rstacruz/946d02757525c9a0f49b25e316fbe715)

---

**Maintained by:** MadAppGang
**Last Updated:** December 2025
