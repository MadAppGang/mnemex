# Requirements: Dingo Language Support for claudemem

## Feature Description

Add native support for the Dingo programming language to claudemem's semantic code search. Dingo is a superset of Go with additional syntax sugar features like:
- Rust-style lambdas (`|x, y| expr`)
- Arrow-style lambdas (`(x) => expr`)
- `let` bindings
- `enum` declarations with variants
- `match` expressions with pattern matching
- Error propagation operator (`?`)
- Safe navigation (`?.`)
- Null coalescing (`??`)
- Result/Option types

## Functional Requirements

### FR1: Language Detection
- Recognize `.dingo` file extension as Dingo source files
- Detect language as "dingo" for file categorization

### FR2: Tree-sitter Parsing
- Use the existing tree-sitter-dingo grammar from `/Users/jack/mag/dingo/editors/nvim/tree-sitter-dingo/`
- Build and bundle WASM file `tree-sitter-dingo.wasm`
- Parse Dingo files for AST extraction

### FR3: Chunk Extraction
Extract semantic chunks from Dingo code:
- Function declarations (standard Go-style)
- Method declarations
- Type declarations (structs, interfaces)
- **Dingo-specific**: `enum` declarations
- **Dingo-specific**: `let` bindings (if significant)
- Lambda expressions (both rust-style and arrow-style)
- `match` expressions with pattern arms

### FR4: Symbol Graph Integration
Extract symbol definitions and references:
- Functions, methods, types (like Go)
- Enum types and variants
- Lambda parameters
- Match patterns
- Import statements
- Type references

### FR5: Reference Tracking
Track references/calls between symbols:
- Function/method calls
- Type references
- Import statements
- Enum variant usage
- Safe navigation chains
- Error propagation chains

## Non-Functional Requirements

### NFR1: Performance
- Parsing performance should be comparable to Go parsing
- No additional memory overhead beyond grammar storage

### NFR2: Compatibility
- Must work with existing claudemem indexing pipeline
- Symbol graph must integrate with PageRank calculation
- Must work with MCP server mode

### NFR3: Maintainability
- Follow existing patterns from Go language support
- Use similar query structures where applicable
- Clear comments explaining Dingo-specific additions

## Constraints

### C1: Grammar Source
- Tree-sitter grammar already exists at `/Users/jack/mag/dingo/editors/nvim/tree-sitter-dingo/`
- Grammar.js defines all AST node types
- WASM must be built from this grammar

### C2: Code Patterns
- Follow existing `LANGUAGE_CONFIGS` pattern in `parser-manager.ts`
- Add to `SupportedLanguage` union type in `types.ts`
- Follow existing reference query patterns

## Acceptance Criteria

1. **AC1**: `.dingo` files are recognized and indexed
2. **AC2**: Functions, methods, types are extracted as chunks
3. **AC3**: Dingo-specific constructs (enum, match, lambdas) are parsed
4. **AC4**: Symbol graph includes Dingo symbols with PageRank
5. **AC5**: `claudemem search` returns relevant Dingo code
6. **AC6**: `claudemem map` shows Dingo file structure
7. **AC7**: Reference tracking works for Dingo symbols
