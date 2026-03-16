# ADR-001: Code Chunk Size Limits

**Status:** Accepted
**Date:** 2026-03-02
**Context:** Chunking constants were set without empirical basis

## Decision

Lower `MAX_CHUNK_TOKENS` from 1500 to 600 tokens. Keep `MIN_CHUNK_TOKENS` at 50.

### Previous Values (no empirical basis)

```
MAX_CHUNK_TOKENS = 1500   // ~75 lines at 80 chars/line
CHARS_PER_TOKEN  = 4      // rough heuristic
```

These were guesses. The 75-line split threshold had no research backing.

### New Values

```
MAX_CHUNK_TOKENS = 600    // ~30 lines — within the 512-800 research sweet spot
CHARS_PER_TOKEN  = 4      // unchanged (reasonable for code)
```

## Research

Multiple 2025-2026 studies converge on **256-512 tokens** as optimal for RAG retrieval:

| Study | Optimal Range | Key Finding |
|-------|--------------|-------------|
| [Rethinking Chunk Size (arxiv 2505.21700)](https://arxiv.org/html/2505.21700v2) | 512-1024 for technical | TechQA: 61.3% recall@1 at 512 tokens. Smaller (64-128) better for fact-based. |
| [Firecrawl 2026 benchmark](https://www.firecrawl.dev/blog/best-chunking-strategies-rag) | 512 recursive | 69% accuracy across 50 papers. Semantic chunking underperformed (54%). |
| [AI21 query-dependent study](https://www.ai21.com/blog/query-dependent-chunking/) | varies per query | Best chunk size varies even within the same corpus. |
| [MDPI Bioengineering Nov 2025](https://doi.org/) | adaptive boundaries | Topic-aligned chunking: 87% vs 13% for fixed-size. |

### Why 600 (not 512)

- Our chunks are **AST-aware** — functions/methods are natural units, not blind splits
- The 600-token limit only triggers on oversized constructs (large classes, long functions)
- 600 tokens is ~30 lines of code, which is a reasonable method/function size
- Gives headroom above the 512 sweet spot for code's higher information density vs prose

### Code-specific considerations

No study specifically benchmarks code chunk sizes. However:
- Code has higher token density than prose (variable names, operators, syntax)
- AST-aware chunking already provides natural semantic boundaries (functions, classes)
- The MAX_CHUNK_TOKENS limit is a safety cap for oversized AST nodes, not the primary chunking strategy
- Most functions are well under 600 tokens; this limit mainly affects large classes

## AST-Aware Class Splitting (companion fix)

Previously, oversized classes (e.g. a 1300-line `Indexer` class) were blindly split by
line count. This produced chunks that started in the middle of one method and ended in
the middle of another — semantically meaningless for embeddings.

**Fix**: In `extractChunks()`, when a class exceeds `MAX_CHUNK_TOKENS`, we now return
`true` (continue descending) instead of `false` (stop). This makes the tree walker
extract individual methods as separate chunks, respecting AST boundaries.

```
Before: Indexer class → splitLargeChunk() → 18 "block" chunks cutting across methods
After:  Indexer class → descend → constructor, index, search, ... as individual "method" chunks
```

Individual methods that are still oversized (e.g. `indexInternal` at 640 lines) will
still go through `splitLargeChunk()`, but the parts are labeled correctly as `method`
and stay within a single method's code.

## Consequences

- Requires re-indexing (`claudemem index --force`) after this change
- Large classes are decomposed into individual methods (better semantic boundaries)
- `splitLargeChunk()` preserves original `chunkType` (no more `"block"` type)
- Methods extracted from classes get proper `parentName` for class context
- Each method chunk has a focused embedding → better search precision
- Total chunk count may change (methods replace arbitrary blocks)
