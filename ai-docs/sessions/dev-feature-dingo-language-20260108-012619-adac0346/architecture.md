# Architecture: Dingo Language Support for claudemem

## 1. Overview

### 1.1 System Purpose
Add native support for the Dingo programming language to claudemem's semantic code search system. Dingo is a superset of Go with additional syntax sugar features including:
- Rust-style and arrow-style lambda expressions
- `let` bindings for immutable variables
- `enum` declarations with pattern matching
- `match` expressions with guard clauses
- Error propagation operator (`?`)
- Safe navigation (`?.`)
- Null coalescing (`??`)

### 1.2 Key Components

```
claudemem/
├── src/
│   ├── types.ts                      # ADD: "dingo" to SupportedLanguage
│   ├── parsers/
│   │   └── parser-manager.ts         # ADD: Dingo language config
│   └── core/
│       └── analysis/
│           └── test-detector.ts      # ADD: Dingo test patterns
├── grammars/
│   └── tree-sitter-dingo.wasm        # NEW: Built WASM grammar
└── scripts/
    ├── download-grammars.ts          # ADD: Dingo download logic
    └── build-dingo-grammar.ts        # NEW: Build script for WASM
```

### 1.3 Architecture Pattern
Follow existing **Language Plugin Pattern** used for all claudemem languages:
1. Type definition in `types.ts`
2. Configuration in `parser-manager.ts` with chunk/reference queries
3. WASM grammar in `grammars/` directory
4. Download/build automation in `scripts/`

### 1.4 Integration Points
- **AST Parsing**: web-tree-sitter with Dingo WASM grammar
- **Chunk Extraction**: Tree-sitter queries matching Dingo constructs
- **Symbol Graph**: Reference tracking for Dingo-specific syntax
- **Test Detection**: Pattern matching for `*_test.dingo` files
- **PageRank**: Standard graph algorithm (no changes needed)

---

## 2. Component Design

### 2.1 Type System Changes

#### File: `src/types.ts`

**Change**: Add `"dingo"` to `SupportedLanguage` union type

```typescript
export type SupportedLanguage =
  | "typescript"
  | "javascript"
  // ... existing languages ...
  | "dingo";  // NEW
```

**Rationale**:
- Maintains type safety across the codebase
- Enables autocomplete for Dingo in IDE
- No breaking changes (union type extension)

**Dependencies**: None

---

### 2.2 Parser Configuration

#### File: `src/parsers/parser-manager.ts`

**Change**: Add Dingo language configuration to `LANGUAGE_CONFIGS`

```typescript
dingo: {
  id: "dingo",
  extensions: [".dingo"],
  grammarFile: "tree-sitter-dingo.wasm",
  chunkQuery: `
    ; Standard Go constructs
    (function_declaration
      name: (identifier) @name) @chunk
    (method_declaration
      name: (identifier) @name) @chunk
    (type_declaration
      (type_spec
        name: (identifier) @name)) @chunk

    ; Dingo-specific: enum declarations
    (enum_declaration
      name: (identifier) @name) @chunk

    ; Dingo-specific: let bindings (only top-level or significant)
    (let_declaration
      name: (identifier) @name) @chunk

    ; Dingo-specific: lambda expressions
    (rust_style_lambda) @chunk
    (arrow_style_lambda) @chunk

    ; Dingo-specific: match expressions (extract as blocks)
    (match_expression) @chunk
  `,
  referenceQuery: `
    ; Function/method calls (same as Go)
    (call_expression
      function: (identifier) @ref.call)
    (call_expression
      function: (selector_expression
        field: (identifier) @ref.call))

    ; Type references (same as Go)
    (identifier) @ref.type

    ; Qualified type references (package.Type)
    (qualified_type
      (identifier) @ref.import)

    ; Import statements (same as Go)
    (import_spec
      path: (interpreted_string_literal) @ref.import)

    ; Dingo-specific: enum variant references
    (variant_pattern
      type: (identifier) @ref.type)

    ; Dingo-specific: safe navigation references
    (safe_navigation
      field: (identifier) @ref.call)

    ; Dingo-specific: match pattern bindings
    (binding_pattern) @ref.type
  `,
}
```

**Design Decisions**:

1. **Chunk Query Strategy**:
   - **Include Go constructs**: Dingo is a superset, so all Go patterns apply
   - **Enum declarations**: Full enum definitions as chunks (including variants)
   - **Let bindings**: Extract as chunks (useful for top-level constants)
   - **Lambdas**: Extract both rust-style (`|x| expr`) and arrow-style (`x => expr`)
   - **Match expressions**: Extract entire match block (analogous to switch in Go)

2. **Reference Query Strategy**:
   - **Reuse Go patterns**: Imports, calls, type references work identically
   - **Enum variants**: Track variant usage in pattern matching
   - **Safe navigation**: Track field access through `?.` operator
   - **Match patterns**: Track symbol bindings in patterns

3. **Trade-offs**:
   - **Granularity**: Extract lambdas as chunks (may create many small chunks)
     - Pro: Lambdas are first-class functions, deserve semantic search
     - Con: Could noise results if project has many inline lambdas
     - **Decision**: Include them, user can filter by chunkType if needed
   - **Let bindings**: Extract all vs. only top-level
     - Pro: Top-level lets are module-level constants (important)
     - Con: Local lets inside functions are less important
     - **Decision**: Extract all (tree-sitter query can't distinguish scope)

---

### 2.3 Test File Detection

#### File: `src/core/analysis/test-detector.ts`

**Change**: Add Dingo test patterns to `TEST_PATTERNS`

```typescript
const TEST_PATTERNS: Record<string, RegExp[]> = {
  // ... existing patterns ...

  dingo: [
    /_test\.dingo$/,           // Standard Go convention: foo_test.dingo
    /^test_.*\.dingo$/,        // Alternative: test_foo.dingo
  ],
};
```

**Rationale**:
- Follow Go's `_test.go` convention (Dingo is Go superset)
- Enable test-aware features (`test-gaps`, downranking test files)

---

### 2.4 Grammar Download Automation

#### File: `scripts/download-grammars.ts`

**Change**: Add Dingo to grammar download list

```typescript
const GRAMMAR_PACKAGES = [
  // ... existing packages ...
  { pkg: "tree-sitter-dingo", wasm: ["tree-sitter-dingo.wasm"] },
];
```

**Problem**: No public WASM releases exist for tree-sitter-dingo

**Solution**: Build locally from source (see section 3 below)

---

## 3. WASM Grammar Build Process

### 3.1 Challenge

Tree-sitter-dingo grammar exists at `/Users/jack/mag/dingo/editors/nvim/tree-sitter-dingo/` but:
- Only `dingo.so` exists (native binary, not WASM)
- No pre-built WASM available on GitHub releases or UNPKG
- Must build WASM from grammar.js source

### 3.2 Build Workflow

#### Option A: Manual Build (One-time Setup)

```bash
# Navigate to grammar directory
cd /Users/jack/mag/dingo/editors/nvim/tree-sitter-dingo

# Install tree-sitter CLI globally
npm install -g tree-sitter-cli

# Build WASM
tree-sitter build --wasm

# Copy to claudemem grammars directory
cp tree-sitter-dingo.wasm /Users/jack/mag/claudemem/grammars/
```

**Pros**:
- Simple, direct approach
- No automation overhead

**Cons**:
- Manual step for developers
- Not repeatable in CI/CD
- Requires tree-sitter-cli installed globally

#### Option B: Automated Build Script (Recommended)

**New File**: `scripts/build-dingo-grammar.ts`

```typescript
#!/usr/bin/env bun

/**
 * Build tree-sitter-dingo WASM grammar
 *
 * Builds WASM from the local Dingo grammar source since no
 * pre-built releases are available publicly.
 */

import { existsSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const GRAMMARS_DIR = join(import.meta.dir, "../grammars");
const DINGO_GRAMMAR_PATH = join(
  import.meta.dir,
  "../../dingo/editors/nvim/tree-sitter-dingo"
);
const WASM_FILE = "tree-sitter-dingo.wasm";

async function buildDingoGrammar() {
  console.log("\n🔨 Building tree-sitter-dingo WASM grammar...\n");

  // Check if WASM already exists
  const wasmPath = join(GRAMMARS_DIR, WASM_FILE);
  if (existsSync(wasmPath)) {
    console.log(`✓ ${WASM_FILE} (cached)`);
    return;
  }

  // Check if grammar source exists
  if (!existsSync(DINGO_GRAMMAR_PATH)) {
    console.error(`✗ Dingo grammar not found at: ${DINGO_GRAMMAR_PATH}`);
    console.error(
      "  Please clone the Dingo repository or specify DINGO_GRAMMAR_PATH"
    );
    process.exit(1);
  }

  // Check if tree-sitter CLI is installed
  try {
    execSync("tree-sitter --version", { stdio: "ignore" });
  } catch {
    console.error("✗ tree-sitter CLI not found");
    console.error("  Install with: npm install -g tree-sitter-cli");
    process.exit(1);
  }

  console.log(`⬇ Building WASM from ${DINGO_GRAMMAR_PATH}...`);

  try {
    // Build WASM in grammar directory
    execSync("tree-sitter build --wasm", {
      cwd: DINGO_GRAMMAR_PATH,
      stdio: "inherit",
    });

    // Copy to grammars directory
    const builtWasm = join(DINGO_GRAMMAR_PATH, WASM_FILE);
    if (!existsSync(builtWasm)) {
      throw new Error("WASM build succeeded but file not found");
    }

    copyFileSync(builtWasm, wasmPath);
    console.log(`✓ ${WASM_FILE} (built from source)`);
  } catch (error) {
    console.error(`✗ Failed to build Dingo WASM:`, error);
    process.exit(1);
  }
}

buildDingoGrammar().catch(console.error);
```

**Integration**: Modify `scripts/download-grammars.ts`

```typescript
// At the end of main() function
console.log("\n📦 Building Dingo grammar from source...\n");
execSync("bun run scripts/build-dingo-grammar.ts", { stdio: "inherit" });
```

**Pros**:
- Automated, repeatable process
- Works in CI/CD pipelines
- Clear error messages for missing dependencies

**Cons**:
- Requires tree-sitter-cli installed
- Adds build step complexity

#### Option C: Commit Pre-built WASM (Simplest)

```bash
# One-time build
cd /Users/jack/mag/dingo/editors/nvim/tree-sitter-dingo
tree-sitter build --wasm
cp tree-sitter-dingo.wasm /Users/jack/mag/claudemem/grammars/

# Commit to Git
cd /Users/jack/mag/claudemem
git add grammars/tree-sitter-dingo.wasm
git commit -m "feat: add pre-built tree-sitter-dingo WASM grammar"
```

**Update**: `scripts/download-grammars.ts` (skip download, use committed file)

```typescript
// No changes needed - file already in grammars/
```

**Pros**:
- Zero runtime dependencies
- Instant setup for new developers
- Works in CI/CD without extra tooling

**Cons**:
- Binary file in Git (not ideal but acceptable for grammars)
- Must manually rebuild if grammar.js changes

**Recommendation**: **Option C (commit pre-built WASM)** for pragmatism
- Tree-sitter grammars change infrequently
- Other projects (VS Code extensions) commit WASM files routinely
- Can add Option B later if grammar development becomes active

---

## 4. Data Flow Architecture

### 4.1 Indexing Pipeline

```
┌─────────────────────────────────────────────────────────────┐
│ 1. File Discovery                                            │
│    - Scan project for *.dingo files                          │
│    - Apply .gitignore exclusions                             │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│ 2. Language Detection                                        │
│    - ParserManager.getLanguage(".dingo") → "dingo"           │
│    - Load tree-sitter-dingo.wasm grammar                     │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│ 3. AST Parsing                                               │
│    - Parser.parse(sourceCode, "dingo")                       │
│    - Generate syntax tree with Dingo-specific nodes          │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│ 4. Chunk Extraction (chunkQuery)                             │
│    - function_declaration → function chunks                  │
│    - enum_declaration → enum chunks                          │
│    - rust_style_lambda → lambda chunks                       │
│    - match_expression → match chunks                         │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│ 5. Reference Extraction (referenceQuery)                     │
│    - call_expression → function calls                        │
│    - variant_pattern → enum variant usage                    │
│    - safe_navigation → field references                      │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│ 6. Symbol Graph Construction                                 │
│    - Build nodes from definitions                            │
│    - Build edges from references                             │
│    - Compute PageRank importance scores                      │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│ 7. Embedding Generation                                      │
│    - Embed chunk content with configured model               │
│    - Store vectors in LanceDB                                │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│ 8. Enrichment (Optional)                                     │
│    - Generate file summaries (LLM)                           │
│    - Generate symbol summaries (LLM)                         │
│    - Extract usage examples                                  │
└─────────────────────────────────────────────────────────────┘
```

### 4.2 Search Pipeline

```
┌─────────────────────────────────────────────────────────────┐
│ User Query: "error handling with ? operator"                 │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│ Query Classification                                         │
│    - Intent: semantic (functionality question)               │
│    - Filters: language=dingo (optional)                      │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│ Hybrid Search                                                │
│    - Vector search: embed query, find similar chunks         │
│    - BM25 search: keyword match "error", "?", "operator"     │
│    - Combine scores with weights                             │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│ Dingo-Aware Filtering                                        │
│    - Prioritize chunks with error_propagation nodes          │
│    - Include match_expression chunks (error handling)        │
│    - Rank by PageRank (high-importance symbols first)        │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────┐
│ Results                                                       │
│    1. func processData() error { ... } // High PageRank      │
│    2. match result { Ok(v) => ..., Err(e) => ... }           │
│    3. let value = operation()? // error_propagation          │
└─────────────────────────────────────────────────────────────┘
```

---

## 5. Implementation Phases

### Phase 1: Core Language Support (Foundation)

**Goal**: Enable basic Dingo file indexing and search

**Tasks**:
1. Add `"dingo"` to `SupportedLanguage` in `types.ts`
2. Build `tree-sitter-dingo.wasm` from source grammar
3. Add Dingo config to `LANGUAGE_CONFIGS` in `parser-manager.ts`
   - Write chunkQuery for functions, methods, types
   - Write referenceQuery for calls, imports
4. Test parsing sample Dingo files

**Acceptance Criteria**:
- `claudemem index` recognizes `.dingo` files
- Functions, methods, types extracted as chunks
- Basic symbol graph with function calls tracked
- Search returns relevant Dingo code

**Estimated Effort**: 2-4 hours

**Dependencies**: None

---

### Phase 2: Dingo-Specific Constructs (Enhancement)

**Goal**: Support Dingo's unique syntax features

**Tasks**:
1. Extend chunkQuery:
   - Add `enum_declaration` extraction
   - Add `let_declaration` extraction
   - Add lambda expressions (rust_style, arrow_style)
   - Add `match_expression` extraction
2. Extend referenceQuery:
   - Add `variant_pattern` references (enum variants)
   - Add `safe_navigation` references (`?.`)
   - Add `error_propagation` tracking (`?`)
3. Test with Dingo-specific code examples

**Acceptance Criteria**:
- Enums indexed as chunks with variants tracked
- Match expressions searchable
- Lambdas indexed as separate chunks
- Safe navigation and error propagation in symbol graph

**Estimated Effort**: 3-5 hours

**Dependencies**: Phase 1 complete

---

### Phase 3: Test Detection & Analysis (Quality)

**Goal**: Enable test-aware features for Dingo

**Tasks**:
1. Add Dingo patterns to `test-detector.ts`
2. Test `claudemem test-gaps` on Dingo project
3. Verify test file downranking in search

**Acceptance Criteria**:
- `*_test.dingo` files recognized as tests
- `test-gaps` identifies untested Dingo code
- Test files ranked lower in search results

**Estimated Effort**: 1-2 hours

**Dependencies**: Phase 1 complete

---

### Phase 4: Documentation & Validation (Polish)

**Goal**: Document Dingo support and validate end-to-end

**Tasks**:
1. Update README.md with Dingo in supported languages
2. Add Dingo examples to documentation
3. Write integration test for Dingo indexing
4. Test MCP server mode with Dingo project
5. Update AI instructions (`ai-skill.ts`) with Dingo examples

**Acceptance Criteria**:
- Documentation mentions Dingo support
- Integration test passes
- MCP server works with Dingo files
- AI agents know about Dingo support

**Estimated Effort**: 2-3 hours

**Dependencies**: Phases 1-3 complete

---

## 6. Tree-Sitter Query Design

### 6.1 Chunk Query (Detailed)

```scheme
; =============================================
; STANDARD GO CONSTRUCTS
; =============================================

; Function declarations
(function_declaration
  name: (identifier) @name) @chunk

; Method declarations (with receiver)
(method_declaration
  name: (identifier) @name) @chunk

; Type declarations (structs, interfaces, type aliases)
(type_declaration
  (type_spec
    name: (identifier) @name)) @chunk

; =============================================
; DINGO-SPECIFIC CONSTRUCTS
; =============================================

; Enum declarations with variants
(enum_declaration
  name: (identifier) @name) @chunk

; Let bindings (immutable variables)
; Note: Extracts all lets, including local scope
; Alternative: Filter by depth in post-processing
(let_declaration
  name: (identifier) @name) @chunk

; Rust-style lambdas: |x, y| expr
(rust_style_lambda) @chunk

; Arrow-style lambdas: (x, y) => expr
(arrow_style_lambda) @chunk

; Match expressions (entire block)
(match_expression) @chunk
```

**Design Notes**:

1. **Enum Chunks**: Extract entire enum definition including all variants
   - Variants are part of the enum's identity
   - Searching for enum should show all variants

2. **Lambda Chunks**: Extract even unnamed lambdas
   - Lambdas are first-class functions in Dingo
   - Useful for finding callback patterns
   - May create many small chunks (acceptable trade-off)

3. **Match Chunks**: Extract entire match expression, not individual arms
   - Match is a control flow construct (like if/switch)
   - Arms are tightly coupled to match subject
   - Searching for match should show full pattern

4. **Let Chunks**: Extract all lets (no scope filtering)
   - Tree-sitter query can't distinguish top-level vs local
   - Can filter by depth in code if needed
   - Local lets still useful for finding initialization patterns

### 6.2 Reference Query (Detailed)

```scheme
; =============================================
; STANDARD GO REFERENCES
; =============================================

; Direct function calls
(call_expression
  function: (identifier) @ref.call)

; Method calls (receiver.method())
(call_expression
  function: (selector_expression
    field: (identifier) @ref.call))

; Type references in declarations
(type_identifier) @ref.type

; Qualified types (package.Type)
(qualified_type
  (identifier) @ref.import)

; Import statements
(import_spec
  path: (interpreted_string_literal) @ref.import)

; =============================================
; DINGO-SPECIFIC REFERENCES
; =============================================

; Enum variant usage in match patterns
; Example: match val { Some(x) => ... }
(variant_pattern
  type: (identifier) @ref.type)

; Safe navigation field access
; Example: user?.address
(safe_navigation
  field: (identifier) @ref.call)

; Safe navigation with method call
; Example: user?.getName()
(safe_navigation
  field: (identifier) @ref.call)

; Binding patterns in match (symbol capture)
; Example: match val { x => ... }
(binding_pattern) @ref.type

; Error propagation (tracks function that might error)
; Example: result?
(error_propagation
  operand: (call_expression
    function: (identifier) @ref.call))
```

**Design Notes**:

1. **Variant Patterns**: Track enum variant usage
   - Builds edges from match arm to enum definition
   - Enables "find all uses of Some variant"

2. **Safe Navigation**: Track field access through `?.`
   - Same semantics as regular field access
   - Helps find nullable field dependencies

3. **Error Propagation**: Track error-returning functions
   - `foo()?` creates edge to `foo`
   - Helps identify error-producing call chains

4. **Binding Patterns**: Track symbol bindings in match
   - Useful for finding where values are destructured
   - May be noisy (many bindings) - can refine if needed

---

## 7. Testing Strategy

### 7.1 Unit Tests

**Test File**: `test/integration/dingo-parsing.test.ts`

```typescript
import { describe, test, expect } from "bun:test";
import { ParserManager } from "../../src/parsers/parser-manager.js";

describe("Dingo Language Support", () => {
  const parser = new ParserManager();

  test("detects .dingo file extension", () => {
    expect(parser.getLanguage("example.dingo")).toBe("dingo");
  });

  test("parses Dingo function declaration", async () => {
    const code = `
      func add(a int, b int) int {
        return a + b
      }
    `;
    const tree = await parser.parse(code, "dingo");
    expect(tree).not.toBeNull();
  });

  test("parses Dingo enum declaration", async () => {
    const code = `
      enum Result {
        Ok(int),
        Err(string),
      }
    `;
    const tree = await parser.parse(code, "dingo");
    expect(tree).not.toBeNull();
  });

  test("parses rust-style lambda", async () => {
    const code = `let add = |x, y| x + y`;
    const tree = await parser.parse(code, "dingo");
    expect(tree).not.toBeNull();
  });

  test("parses match expression", async () => {
    const code = `
      match result {
        Ok(val) => val,
        Err(e) => 0,
      }
    `;
    const tree = await parser.parse(code, "dingo");
    expect(tree).not.toBeNull();
  });

  test("parses error propagation", async () => {
    const code = `let value = getUser()?`;
    const tree = await parser.parse(code, "dingo");
    expect(tree).not.toBeNull();
  });
});
```

### 7.2 Integration Tests

**Test**: Full indexing workflow with sample Dingo project

```typescript
describe("Dingo Indexing Integration", () => {
  test("indexes Dingo project end-to-end", async () => {
    const projectPath = "./test/fixtures/sample-dingo-project";
    const indexer = new Indexer(projectPath);

    const result = await indexer.index();

    expect(result.filesIndexed).toBeGreaterThan(0);
    expect(result.chunksCreated).toBeGreaterThan(0);

    // Verify Dingo-specific chunks extracted
    const chunks = await indexer.getChunks();
    expect(chunks.some(c => c.language === "dingo")).toBe(true);
    expect(chunks.some(c => c.chunkType === "function")).toBe(true);
  });

  test("symbol graph includes Dingo symbols", async () => {
    const graph = await indexer.getSymbolGraph();
    const dingoSymbols = graph.symbols.filter(s => s.language === "dingo");

    expect(dingoSymbols.length).toBeGreaterThan(0);
    expect(dingoSymbols.some(s => s.kind === "enum")).toBe(true);
  });
});
```

### 7.3 Manual Testing

**Test Dingo File**: `test/fixtures/sample-dingo.dingo`

```go
package main

import "fmt"

// Enum with variants
enum Result {
  Ok(int),
  Err(string),
}

// Function using error propagation
func processData(input string) Result {
  let data = parseInput(input)?
  let processed = transform(data)?
  return Result.Ok(processed)
}

// Match expression
func handleResult(r Result) int {
  match r {
    Ok(val) => val,
    Err(e) => {
      fmt.Println(e)
      return 0
    },
  }
}

// Lambda expressions
let add = |x, y| x + y
let multiply = (x, y) => x * y

// Safe navigation
func getUserName(user *User) string {
  return user?.name ?? "anonymous"
}
```

**Manual Test Commands**:

```bash
# Index the test file
claudemem index test/fixtures/

# Search for enum
claudemem search "Result enum"

# Search for lambdas
claudemem search "lambda functions"

# Search for error handling
claudemem search "error propagation with ?"

# Verify symbol graph
claudemem symbol Result
claudemem callers processData

# Test map command
claudemem map
```

---

## 8. Performance Considerations

### 8.1 Parsing Performance

**Expected**: Comparable to Go parsing (same complexity class)
- Tree-sitter grammars have O(n) time complexity
- Dingo grammar inherits Go's performance characteristics
- Additional Dingo constructs (enums, lambdas) add minimal overhead

**Validation**:
- Benchmark Dingo parsing vs Go parsing on equivalent code
- Ensure no regression in large file indexing (>1000 lines)

### 8.2 Memory Overhead

**Additional Memory**:
- WASM grammar: ~500KB-1MB (loaded once per language)
- AST nodes: Proportional to code size (same as Go)
- Chunk/symbol overhead: ~10-20% more chunks due to lambdas/enums

**Mitigation**:
- WASM grammars shared across all files (singleton)
- AST nodes garbage collected after processing
- Chunk deduplication prevents redundant storage

### 8.3 Search Performance

**No degradation expected**:
- Vector search: O(log n) with HNSW index (language-agnostic)
- BM25 search: O(n) but parallelized across documents
- Symbol graph: PageRank computed once, cached

**Optimization Opportunity**:
- Filter by `language="dingo"` to reduce search space
- Prioritize high-PageRank Dingo symbols

---

## 9. Error Handling & Edge Cases

### 9.1 Grammar Build Failures

**Scenario**: WASM build fails due to missing tree-sitter-cli

**Handling**:
```typescript
// In build-dingo-grammar.ts
try {
  execSync("tree-sitter --version");
} catch {
  console.error("tree-sitter CLI not found");
  console.error("Install: npm install -g tree-sitter-cli");
  process.exit(1);
}
```

**Fallback**: Document manual build steps in README

### 9.2 Invalid Dingo Syntax

**Scenario**: User has syntax errors in `.dingo` file

**Handling**:
- Tree-sitter produces partial AST with ERROR nodes
- Indexer continues, extracts valid chunks
- Logs warning: "Syntax errors in file.dingo (line 42)"

**No crash**: Graceful degradation (same as other languages)

### 9.3 Grammar Source Missing

**Scenario**: Dingo grammar not found at expected path

**Handling**:
```typescript
if (!existsSync(DINGO_GRAMMAR_PATH)) {
  console.error("Dingo grammar not found at:", DINGO_GRAMMAR_PATH);
  console.error("Set DINGO_GRAMMAR_PATH env var or install grammar");
  process.exit(1);
}
```

**Alternative**: Environment variable override
```bash
export DINGO_GRAMMAR_PATH=/custom/path/to/tree-sitter-dingo
```

### 9.4 Ambiguous Lambda Syntax

**Scenario**: Conflict between rust-style lambda `|x|` and bitwise OR

**Resolution**: Grammar.js already handles precedence
- Lambda parsing has `prec(PREC.call, ...)`
- Bitwise OR in binary_expression has lower precedence
- Tree-sitter's GLR parser resolves conflicts

**Validation**: Test cases with both constructs
```go
let fn = |x| x + 1    // Lambda
let mask = a | b      // Bitwise OR (no conflict)
```

---

## 10. Security Considerations

### 10.1 WASM Grammar Integrity

**Risk**: Malicious WASM grammar could execute arbitrary code

**Mitigation**:
- Use web-tree-sitter's sandboxed WASM execution
- Build WASM from trusted source (official Dingo repo)
- Option: Checksum validation on WASM file

```typescript
const expectedHash = "sha256:abc123...";
const actualHash = crypto.createHash("sha256")
  .update(readFileSync(wasmPath))
  .digest("hex");

if (`sha256:${actualHash}` !== expectedHash) {
  throw new Error("WASM grammar checksum mismatch");
}
```

### 10.2 Untrusted Dingo Code

**Risk**: Indexing malicious `.dingo` files

**Mitigation**:
- Tree-sitter only parses, never executes code
- No eval() or dynamic code execution in indexer
- Same safety as existing languages (Go, Rust, etc.)

**Conclusion**: No additional risk beyond existing language support

---

## 11. Maintenance & Future Work

### 11.1 Grammar Updates

**When Dingo grammar changes**:

1. Rebuild WASM:
   ```bash
   cd /path/to/tree-sitter-dingo
   tree-sitter build --wasm
   ```

2. Copy to claudemem:
   ```bash
   cp tree-sitter-dingo.wasm /path/to/claudemem/grammars/
   ```

3. Test chunk/reference queries:
   - New AST nodes may require query updates
   - Run integration tests to catch breakage

4. Commit updated WASM:
   ```bash
   git add grammars/tree-sitter-dingo.wasm
   git commit -m "chore: update tree-sitter-dingo grammar to vX.Y.Z"
   ```

### 11.2 Query Refinement

**Based on usage patterns**, refine queries:

1. **Too many lambda chunks**: Add filters
   ```scheme
   ; Only extract named lambdas
   (let_declaration
     value: (lambda_expression)) @chunk
   ```

2. **Missing references**: Extend referenceQuery
   ```scheme
   ; Track null coalescing
   (null_coalesce
     left: (identifier) @ref.type)
   ```

3. **Noisy results**: Add chunk type weights
   ```typescript
   // In search options
   typeWeights: {
     lambda: 0.5,  // Downrank lambda chunks
   }
   ```

### 11.3 Dingo Language Evolution

**If Dingo adds new syntax**:

1. Update grammar.js in Dingo repo
2. Rebuild WASM (see 11.1)
3. Add new chunk patterns to chunkQuery
4. Add new reference patterns to referenceQuery
5. Update tests with new syntax examples
6. Document new features in README

**Example**: If Dingo adds traits (like Rust):

```scheme
; New chunk query
(trait_declaration
  name: (identifier) @name) @chunk

; New reference query
(trait_bound
  (identifier) @ref.implements)
```

---

## 12. Key Decisions & Trade-offs

### Decision 1: Commit WASM vs Build on Install

**Options**:
- **A**: Commit `tree-sitter-dingo.wasm` to Git
- **B**: Build WASM during `npm install`/`bun install`
- **C**: Download pre-built WASM from GitHub releases

**Chosen**: **Option A (commit WASM)**

**Rationale**:
- Simplest developer experience (zero setup)
- Works in CI/CD without extra tooling
- WASM files are ~500KB (acceptable for Git)
- Other projects (VS Code, tree-sitter CLI) commit WASMs
- Can migrate to Option C when Dingo publishes releases

**Trade-off**: Must manually update when grammar changes (acceptable for infrequent updates)

---

### Decision 2: Lambda Chunk Granularity

**Options**:
- **A**: Extract all lambdas as chunks (fine-grained)
- **B**: Extract only named lambdas (`let fn = |x| ...`)
- **C**: Don't extract lambdas (treat as expressions)

**Chosen**: **Option A (extract all lambdas)**

**Rationale**:
- Lambdas are first-class functions in Dingo
- Useful for finding callback patterns
- Semantic search benefits from lambda bodies
- Can filter by `chunkType` if too noisy

**Trade-off**: More chunks (10-20% increase) but better search recall

---

### Decision 3: Let Declaration Scope

**Options**:
- **A**: Extract all `let` declarations
- **B**: Extract only top-level `let` (file scope)
- **C**: Extract only exported `let`

**Chosen**: **Option A (extract all lets)**

**Rationale**:
- Tree-sitter query can't easily distinguish scope
- Local lets useful for finding initialization patterns
- Minimal noise (lets are typically significant)
- Can post-filter by depth if needed

**Trade-off**: Some local lets may clutter results (acceptable)

---

### Decision 4: Match Expression Chunking

**Options**:
- **A**: Extract entire `match` expression as one chunk
- **B**: Extract each `match_arm` as separate chunk
- **C**: Don't extract match (treat as control flow)

**Chosen**: **Option A (entire match as chunk)**

**Rationale**:
- Match arms tightly coupled to subject
- Searching for "error handling" should show full match
- Analogous to extracting `if/else` as single construct
- Keeps context intact (subject + all arms)

**Trade-off**: Can't search individual arms (acceptable - rare use case)

---

## 13. Success Metrics

### Acceptance Criteria (AC) Validation

1. **AC1: `.dingo` files are recognized and indexed**
   - Metric: `filesIndexed` count includes `.dingo` files
   - Test: `claudemem index` on Dingo project

2. **AC2: Functions, methods, types extracted as chunks**
   - Metric: `chunksCreated` includes Dingo constructs
   - Test: Query SQLite for `language='dingo'` chunks

3. **AC3: Dingo-specific constructs parsed**
   - Metric: Chunks with `enum`, `lambda`, `match` types
   - Test: Search for enum/lambda/match code

4. **AC4: Symbol graph includes Dingo symbols**
   - Metric: Symbol table has `language='dingo'` entries
   - Test: `claudemem symbol Result` finds enum

5. **AC5: `claudemem search` returns relevant Dingo code**
   - Metric: Search quality (precision/recall)
   - Test: Manual evaluation on sample queries

6. **AC6: `claudemem map` shows Dingo file structure**
   - Metric: Map includes Dingo files with symbols
   - Test: `claudemem map` includes `.dingo` files

7. **AC7: Reference tracking works**
   - Metric: Symbol references table has Dingo edges
   - Test: `claudemem callers` finds Dingo call sites

### Performance Benchmarks

- **Parsing Speed**: <100ms for 1000-line Dingo file
- **Indexing Speed**: <5s for 100 Dingo files
- **Search Latency**: <500ms for hybrid search
- **Memory Usage**: <50MB overhead for Dingo grammar

---

## 14. Rollout Plan

### Phase 1: Internal Testing (Week 1)

1. Build WASM grammar
2. Add Dingo config to codebase
3. Test on sample Dingo files
4. Verify all acceptance criteria
5. Fix any query issues

### Phase 2: Documentation (Week 1)

1. Update README.md
2. Add Dingo examples to docs
3. Update AI skill files
4. Write migration guide (if any)

### Phase 3: Release (Week 2)

1. Merge PR with Dingo support
2. Tag release (e.g., `v0.16.0`)
3. Publish to npm
4. Announce in changelog

### Phase 4: Monitoring (Ongoing)

1. Collect user feedback on Dingo support
2. Monitor for parsing errors
3. Refine queries based on usage
4. Update grammar as Dingo evolves

---

## 15. File Modification Summary

### Modified Files

| File | Changes | Complexity |
|------|---------|------------|
| `src/types.ts` | Add `"dingo"` to `SupportedLanguage` | Trivial |
| `src/parsers/parser-manager.ts` | Add Dingo config to `LANGUAGE_CONFIGS` | Medium |
| `src/core/analysis/test-detector.ts` | Add Dingo test patterns | Trivial |
| `scripts/download-grammars.ts` | Add Dingo to package list | Trivial |

### New Files

| File | Purpose | Complexity |
|------|---------|------------|
| `grammars/tree-sitter-dingo.wasm` | Compiled grammar | N/A (binary) |
| `scripts/build-dingo-grammar.ts` | Build automation | Low (optional) |
| `test/integration/dingo-parsing.test.ts` | Unit tests | Medium |
| `test/fixtures/sample-dingo.dingo` | Test data | Trivial |

---

## 16. Dependencies

### Build-Time Dependencies

- **tree-sitter-cli**: For building WASM (if using Option B)
  - Install: `npm install -g tree-sitter-cli`
  - Version: `>=0.20.0`

### Runtime Dependencies

- **web-tree-sitter**: Already in `package.json`
  - No changes needed

### Source Dependencies

- **tree-sitter-dingo grammar**:
  - Source: `/Users/jack/mag/dingo/editors/nvim/tree-sitter-dingo/`
  - Must be available to build WASM

---

## 17. Risks & Mitigations

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Grammar source unavailable | Low | High | Commit pre-built WASM |
| WASM build fails | Medium | Medium | Document manual build steps |
| Query syntax errors | Low | High | Extensive testing with sample code |
| Performance regression | Low | Medium | Benchmark before/after |
| Dingo grammar changes | Medium | Low | Version WASM, test on updates |

---

## 18. Open Questions

1. **Should lambdas be named in chunks?**
   - Current: All lambdas extracted
   - Alternative: Only named lambdas
   - **Decision**: Extract all (can refine later)

2. **How to handle inline match expressions?**
   - Current: Extract entire match
   - Alternative: Extract only top-level matches
   - **Decision**: Extract all (tree-sitter can't filter easily)

3. **Should enum variants be separate chunks?**
   - Current: Enum as one chunk (includes variants)
   - Alternative: Each variant as chunk
   - **Decision**: Single enum chunk (variants are tightly coupled)

---

## 19. Conclusion

This architecture provides a comprehensive plan for adding Dingo language support to claudemem. The design follows existing patterns, minimizes complexity, and ensures compatibility with the current indexing and search pipeline.

**Key Highlights**:
- Leverages existing tree-sitter infrastructure
- Reuses Go patterns (Dingo is a superset)
- Adds Dingo-specific constructs (enums, lambdas, match)
- Pragmatic WASM build approach (commit pre-built file)
- Phased implementation (iterative delivery)

**Next Steps**:
1. Review this architecture document
2. Build `tree-sitter-dingo.wasm` from source
3. Begin Phase 1 implementation (core support)
4. Validate with sample Dingo project
5. Iterate based on testing feedback

**Estimated Total Effort**: 8-14 hours (across 4 phases)
