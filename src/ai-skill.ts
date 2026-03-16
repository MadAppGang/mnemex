/**
 * Comprehensive AI Agent Skill for mnemex
 *
 * Symbol graph commands:
 * - map: structural overview with PageRank ranking
 * - symbol: find symbol definitions
 * - callers/callees: dependency tracking
 * - context: full symbol context
 *
 * Code analysis commands (v0.3.0):
 * - dead-code: find unused symbols (zero callers + low PageRank)
 * - test-gaps: find untested high-PageRank symbols
 * - impact: analyze change blast radius (transitive callers)
 *
 * Developer experience:
 * - watch: auto-reindex on file changes
 * - hooks: git post-commit hook for auto-indexing
 *
 * Core principle: STRUCTURE FIRST, then targeted reads
 */

import {
	getInstructions,
	getCompactInstructions,
	type AgentRole,
	VALID_ROLES,
} from "./ai-instructions.js";

/**
 * Full agentic skill document for mnemex
 * Designed for embedding in CLAUDE.md or system prompts
 */
export const MNEMEX_SKILL = `<skill name="mnemex" version="0.3">
<purpose>
Code intelligence via symbol graph + semantic search + code analysis.
Provides STRUCTURE FIRST understanding before reading code.

Primary use: Navigate code by SYMBOLS and DEPENDENCIES, not text.
Use INSTEAD of grep/find for: architecture discovery, impact analysis, dependency tracing.
</purpose>

<capabilities>
SYMBOL GRAPH:
  Extract symbols (functions, classes, types) from AST
  Track cross-file references (calls, imports, type usage)
  Compute PageRank = symbol importance score
  Generate token-budgeted repo maps

CODE ANALYSIS:
  Dead code detection (zero callers + low PageRank)
  Test gap analysis (high PageRank without test callers)
  Impact analysis (transitive callers across files)

SEMANTIC SEARCH:
  Natural language → vector similarity + BM25
  Searches raw code AND LLM-enriched summaries
  Use AFTER structure is understood (not first step!)

INDEXING:
  Parse code → AST chunking → embed → vector store
  Auto-reindex on file changes before search/map
  Watch mode for continuous re-indexing
  Git hooks for post-commit indexing
</capabilities>

<tools>
SYMBOL GRAPH COMMANDS (primary - always use --agent):
  mnemex map [query]       # Repo structure, symbols ranked by PageRank
  mnemex symbol <name>     # Find symbol definition (file:line, signature)
  mnemex callers <name>    # What depends on this symbol
  mnemex callees <name>    # What this symbol depends on
  mnemex context <name>    # Full context: symbol + callers + callees

CODE ANALYSIS COMMANDS:
  mnemex dead-code         # Find unused: zero callers + low PageRank
  mnemex test-gaps         # Find untested: high PageRank + no test callers
  mnemex impact <name>     # Transitive callers across all files

SEARCH (secondary - after structure understood):
  mnemex search "query"    # Semantic search, returns file:line + code
  mnemex search "q" --map  # Search + include repo map context

PACK (export codebase for AI):
  mnemex pack [path]       # Pack to XML file (repomix-compatible)
  mnemex pack --stdout     # Write to stdout
  mnemex pack --format md  # Markdown format
  mnemex pack --include "src/**" --exclude "*.test.ts"

INDEX/STATUS:
  mnemex index [path] [-f] # Index codebase (force with -f)
  mnemex status            # Show index info
  mnemex clear             # Remove index
  mnemex watch             # Auto-reindex on file changes (daemon)
  mnemex hooks install     # Git post-commit hook for auto-indexing

AI INSTRUCTIONS:
  mnemex ai <role>         # Role instructions (architect|developer|tester|debugger)
</tools>

<output-format>
Raw output ( flag) for reliable parsing:

file: src/core/indexer.ts
line: 75-758
kind: class
name: Indexer
signature: export class Indexer
pagerank: 0.0842
exported: true
---
file: src/core/store.ts
line: 12-89
kind: class
name: VectorStore
...

Records separated by "---". Each field: "key: value" on own line.
</output-format>

<workflow>
1. MAP STRUCTURE (always start here)
   mnemex --agent map "task keywords"   → See relevant symbols ranked by PageRank
   → High PageRank (>0.05) = heavily used, understand first
   → Low PageRank (<0.01) = utilities, defer

2. LOCATE SYMBOL
   mnemex --agent symbol TargetClass   → Get exact file:line, signature, export status
   → Only read what you found, not entire files

3. CHECK IMPACT (before modifying!)
   mnemex --agent callers TargetClass   → Direct callers that will break if you change interface
   mnemex impact TargetClass   → ALL transitive callers (full blast radius)

4. UNDERSTAND DEPENDENCIES
   mnemex --agent callees TargetClass   → What this code can use
   → Available utilities and interfaces

5. GET FULL CONTEXT (complex changes)
   mnemex --agent context TargetClass   → Symbol + all callers + all callees at once

6. CODE ANALYSIS (when relevant)
   mnemex dead-code        → Find unused code
   mnemex test-gaps        → Find untested code

7. SEARCH (when needed)
   mnemex --agent search "specific query"   → Use for natural language discovery
   → After structure is understood
</workflow>

<pagerank-guide>
PageRank indicates symbol importance in the codebase:

HIGH (>0.05):
  Core abstractions everyone depends on
  Understand these FIRST - changes have wide impact
  Examples: main entry points, core services, key interfaces

MEDIUM (0.01-0.05):
  Feature implementations, business logic
  Important for specific functionality
  Moderate impact radius

LOW (<0.01):
  Utilities, helpers, leaf nodes
  Safe to read later, low impact
  Often implementation details
</pagerank-guide>

<best-practices>
✓ STRUCTURE FIRST: map → symbol → callers → then read code
✓ Check PageRank before reading files (high = important)
✓ Check callers BEFORE modifying anything
✓ Use exact file:line from symbol output (not whole files)
✓ Trace full caller chain before complex changes
✓ Use --agent for all agent commands
</best-practices>

<avoid>
× grep for code discovery
  grep "auth" → 500 matches, no ranking, no relationships
  INSTEAD: mnemex map "authentication"
× Reading entire files
  cat src/auth.ts → 80% irrelevant, token waste
  INSTEAD: mnemex symbol → read exact line range

× Modifying without checking callers
  Change signature → break unknown callers
  INSTEAD: mnemex callers <symbol> BEFORE changes

× Ignoring PageRank
  Low PageRank = probably utility, not core
  INSTEAD: Focus on high PageRank symbols first

× Starting with search
  Search returns snippets, not structure
  INSTEAD: map → understand → then search if needed

× Not using  for parsing
  Decorated output breaks parsing
  INSTEAD: Always use --agent
</avoid>

<scenarios>
BUG FIX:
  1. mnemex map "error keywords"  2. mnemex symbol FunctionFromStackTrace  3. mnemex callers FunctionFromStackTrace  4. mnemex impact BuggyFunction  (assess scope)
  5. Read identified file:line ranges
  6. Fix bug, verify callers still work

NEW FEATURE:
  1. mnemex map "feature area"  2. mnemex callees ExistingFeature  (see patterns)
  3. mnemex context ModificationPoint  4. Implement following existing patterns
  5. mnemex test-gaps  (check coverage)

REFACTORING:
  1. mnemex symbol SymbolToRename  2. mnemex impact SymbolToRename  (full scope)
  3. Update all caller locations from output
  4. Verify each file:line updated

UNDERSTANDING CODEBASE:
  1. mnemex map  (overall structure)
  2. Identify top 5 by PageRank
  3. mnemex context <top-symbol>  for each
  4. Trace flow via callees

CLEANUP (new!):
  1. mnemex dead-code  (find unused)
  2. Review each symbol for dynamic usage
  3. Remove confirmed dead code

TEST PLANNING (new!):
  1. mnemex test-gaps  (prioritized list)
  2. Focus on high PageRank symbols
  3. mnemex impact <symbol>  for test scope
</scenarios>

<supported-languages>
TypeScript (.ts, .tsx), JavaScript (.js, .jsx)
Python (.py), Go (.go), Rust (.rs)
C (.c, .h), C++ (.cpp, .hpp), Java (.java)
</supported-languages>
</skill>`;

/**
 * Role-specific skill extensions
 */
export function getFullSkillWithRole(role: AgentRole): string {
	const roleInstructions = getInstructions(role);
	return `${MNEMEX_SKILL}

<role-extension>
${roleInstructions}
</role-extension>`;
}

/**
 * Compact skill for tight context budgets
 */
export const MNEMEX_SKILL_COMPACT = `<skill name="mnemex">
CODE INTELLIGENCE via symbol graph + semantic search + code analysis.
STRUCTURE FIRST: map → symbol → callers → then read code.

SYMBOL GRAPH (primary - use --agent):
  mnemex map [query]       # Repo structure, PageRank ranking
  mnemex symbol <name>     # Find definition (file:line)
  mnemex callers <name>    # What depends on this (BEFORE modifying!)
  mnemex callees <name>    # What this depends on
  mnemex context <name>    # Full context at once

CODE ANALYSIS:
  mnemex dead-code         # Find unused (zero callers + low PageRank)
  mnemex test-gaps         # Find untested (high PageRank + no test callers)
  mnemex impact <name>     # ALL transitive callers (blast radius)

PACK:
  mnemex pack [path]       # Export codebase to single AI file (XML/MD/plain)
  mnemex pack --stdout     # Write to stdout

SEARCH (after structure understood):
  mnemex search "query"    # Semantic search → file:line results

PAGERANK = importance:
  High (>0.05) = core abstractions, read first
  Low (<0.01) = utilities, defer

WORKFLOW: map → identify high PageRank → symbol → impact analysis → implement
AVOID: grep (no ranking), reading whole files, modifying without impact check
</skill>`;

/**
 * Get compact skill with role
 */
export function getCompactSkillWithRole(role: AgentRole): string {
	const roleCompact = getCompactInstructions(role);
	return `${MNEMEX_SKILL_COMPACT}

${roleCompact}`;
}

/**
 * MCP-specific instruction for Claude Code integration
 * Note: CLI commands preferred for agent workflows
 */
export const MNEMEX_MCP_SKILL = `<mcp-skill name="mnemex">
NOTE: For AI agents, CLI commands with --agent are preferred.
MCP tools available for Claude Code integration:

TOOLS:
  search_code(query, limit?, language?)  # Semantic search
  index_codebase(path?, force?)          # Index project
  get_status(path?)                      # Check index
  clear_index(path?)                     # Reset index

PREFERRED CLI WORKFLOW:
  mnemex map "task"              # Structure first
  mnemex symbol <name>           # Find definition
  mnemex callers <name>          # Check direct impact
  mnemex impact <name>           # Full transitive impact (blast radius)
  mnemex callees <name>          # Dependencies
  mnemex dead-code               # Find unused code
  mnemex test-gaps               # Find untested code
  mnemex pack --stdout            # Export codebase to single AI file
  mnemex search "query"          # When needed

WHEN TO USE MCP:
  ✓ Quick semantic searches
  ✓ Integration with Claude Code

WHEN TO USE CLI:
  ✓ Structure discovery (map, symbol, callers, callees)
  ✓ Code analysis (dead-code, test-gaps, impact)
  ✓ Dependency tracing
  ✓ Any workflow requiring parsed output
</mcp-skill>`;

/**
 * Quick reference card (minimal tokens)
 */
export const MNEMEX_QUICK_REF = `mnemex: symbol graph + semantic search + code analysis (--agent)
  map [query]      # Structure overview, PageRank ranked
  symbol <name>    # Find definition (file:line)
  callers <name>   # What depends on this (BEFORE modifying!)
  callees <name>   # What this depends on
  context <name>   # Symbol + callers + callees
  dead-code        # Find unused (zero callers + low PageRank)
  test-gaps        # Find untested (high PageRank + no test callers)
  impact <name>    # ALL transitive callers (blast radius)
  search "query"   # Semantic search (after structure understood)
WORKFLOW: map → symbol → impact → implement
AVOID: grep, whole file reads, modifying without impact check`;
