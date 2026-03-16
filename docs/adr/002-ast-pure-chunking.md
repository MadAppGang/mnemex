# ADR-002: AST-Pure Chunking

**Status:** Accepted
**Date:** 2026-03-02
**Supersedes:** Previous `extractChunks()` + `splitLargeChunk()` approach
**Related:** ADR-001 (chunk size limits)

## Problem

The previous chunker had two critical flaws:

### 1. ~16% of code was orphaned (not in any chunk)

Tested on `indexer.ts` (1562 lines): 227 non-empty lines were not covered by any chunk.

| Orphan type | Example | Why missed |
|------------|---------|------------|
| File imports | `import { foo } from "./bar"` | `import_statement` not in `getChunkType()` |
| Module constants | `const MAX = 100` | `lexical_declaration` not in `getChunkType()` |
| Class fields | `private field: string` | `public_field_definition` not recognized |
| Static properties | `static readonly ITEMS = [...]` | Same — field definition |
| JSDoc comments | `/** Does something */` | `comment` nodes separate from method nodes |
| Small methods | `clear(): void { ... }` | Below `MIN_CHUNK_TOKENS` threshold |

### 2. Oversized nodes got blind line-split

`splitLargeChunk()` cut by line count with zero AST awareness. A 640-line method
became 22 arbitrary 29-line blocks that started/ended mid-statement.

## Decision

Replace `extractChunks()` + `splitLargeChunk()` with AST-pure chunking:

> **Every line of source code belongs to exactly one chunk.**
> **Every chunk maps to an AST node (or connected group of sibling nodes).**
> **No orphans. No blind splits.**

### New Architecture

**Step 1: Top-down AST walk with size-aware decisions** (`processChildren`)

```
For each child node:
  if recognized type && fits MAX_CHUNK_TOKENS → emit as one chunk
  if recognized type && too large && container (class/module) → descend into body
  if recognized type && too large && leaf (function/method) → split into connected parts
  if unrecognized (import, field, comment) → accumulate as gap
```

**Step 2: Connected parts for oversized leaves** (`splitIntoConnectedParts`)

Oversized functions/methods split by line count at MAX_CHUNK_TOKENS boundaries,
but each part carries:
- Original `chunkType` (not "block")
- Name with `(part K/N)` suffix
- `partIndex` / `totalParts` for downstream consumers

**Step 3: Gap absorption** (`flushGap`)

Non-chunk siblings (imports, fields, comments) are handled:
1. JSDoc comments immediately before a method → included in that method's chunk
2. Field declarations in class body → merged into a "fields" module chunk
3. File header (imports + constants before first function) → "preamble" module chunk
4. Trivial gaps (< 10 chars) → dropped

### Data Model Changes

Added to `ParsedChunk` and `CodeChunk`:
```typescript
partIndex?: number;   // 1-based index within the group
totalParts?: number;  // total parts in the group
```

## Consequences

### Positive
- ~100% code coverage (no orphan lines)
- Every chunk has semantic type (function, method, class, module)
- JSDoc attached to its method (better embeddings)
- Class fields grouped as meaningful chunks
- File preamble (imports/constants) preserved
- Oversized splits preserve original type + are linked via partIndex/totalParts
- `splitLargeChunk()` eliminated (source of "block" type + cross-boundary splits)

### Negative
- Chunk count increases ~10-15% (gap chunks for fields/imports)
- Gap chunks ("fields", "preamble") have lower search value but prevent orphans
- Comment attachment is heuristic (JSDoc goes to next sibling — correct 99% of time)

### Migration
- Requires `claudemem index --force` to re-index after this change
- `splitLargeChunk()` removed, replaced by `splitIntoConnectedParts()`
- `extractChunks()` + `walkTree()` removed, replaced by `extractChunksAST()` + `processChildren()`
- `fallbackChunk()` kept for truly unparseable files only
