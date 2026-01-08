# Requirements Document: Extended Language Support and Document Indexing

**Feature ID:** extended-language-support-v1
**Created:** 2026-01-06
**Status:** Draft
**Owner:** Development Team

---

## 1. Feature Description

Extend claudemem's semantic code search capabilities to support additional programming languages and document formats beyond the current 10 supported languages (TypeScript, JavaScript, Python, Go, Rust, C, C++, Java, TSX, JSX). This enhancement will enable claudemem to index and search across a broader range of file types commonly found in modern software projects, including web languages, shell scripts, data query languages, configuration files, and technical documentation.

### Current State

claudemem currently supports:
- **Languages with tree-sitter AST parsing:** TypeScript, JavaScript, Python, Go, Rust, C, C++, Java, TSX, JSX
- **Fallback:** Line-based chunking for unsupported files
- **Architecture:** LanceDB vector storage, OpenRouter/Ollama embeddings, symbol graph with PageRank

### Target State

claudemem will support:
- **14+ additional programming languages** with appropriate parsing strategies
- **4 document formats** with intelligent header-based chunking
- **Enhanced docstring extraction** from all supported languages
- **Maintained backward compatibility** with existing indexes and functionality

---

## 2. Functional Requirements

### FR-1: Web Language Support
**Priority:** HIGH
**Description:** Add support for web development languages using appropriate parsing strategies.

**Languages:**
- HTML (.html, .htm)
- CSS (.css)
- SCSS (.scss)
- SASS (.sass)

**Acceptance Criteria:**
- FR-1.1: Files with these extensions are detected and indexed
- FR-1.2: HTML is parsed to extract meaningful chunks (e.g., sections, components, templates)
- FR-1.3: CSS/SCSS/SASS are parsed to extract rulesets, mixins, functions
- FR-1.4: Search queries return relevant results from these file types
- FR-1.5: Use tree-sitter grammars where available, fall back to regex for CSS variants

### FR-2: Shell Script Support
**Priority:** HIGH
**Description:** Add support for shell scripting languages.

**Languages:**
- Bash (.sh, .bash)
- Zsh (.zsh)
- Fish (.fish)

**Acceptance Criteria:**
- FR-2.1: Shell script files are detected and indexed
- FR-2.2: Functions and major script sections are extracted as chunks
- FR-2.3: Use tree-sitter-bash grammar for parsing
- FR-2.4: Fish uses tree-sitter-fish if available
- FR-2.5: Zsh falls back to bash grammar with compatibility mode

### FR-3: Data Language Support
**Priority:** MEDIUM
**Description:** Add support for data query and definition languages.

**Languages:**
- SQL (.sql)
- GraphQL (.graphql, .gql)

**Acceptance Criteria:**
- FR-3.1: SQL files are indexed with queries, views, procedures as chunks
- FR-3.2: GraphQL schemas are indexed with types, queries, mutations as chunks
- FR-3.3: Use tree-sitter grammars where available
- FR-3.4: Fallback to regex-based parsing for SQL dialects without grammars

### FR-4: Configuration Format Support
**Priority:** MEDIUM
**Description:** Add support for configuration and data serialization formats.

**Formats:**
- YAML (.yaml, .yml)
- JSON (.json)
- TOML (.toml)

**Acceptance Criteria:**
- FR-4.1: Configuration files are detected and indexed
- FR-4.2: Top-level keys/sections are extracted as chunks
- FR-4.3: JSON uses simpler parser (can leverage tree-sitter-json)
- FR-4.4: YAML uses tree-sitter-yaml or fallback parser
- FR-4.5: TOML uses tree-sitter-toml or fallback parser
- FR-4.6: Very large config files are split intelligently by top-level keys

### FR-5: Document Format Support
**Priority:** HIGH
**Description:** Add support for technical documentation formats with intelligent chunking.

**Formats:**
- Markdown (.md)
- reStructuredText (.rst)
- AsciiDoc (.adoc, .asciidoc)
- Org mode (.org)

**Acceptance Criteria:**
- FR-5.1: Document files are detected and indexed
- FR-5.2: Primary chunking strategy: split by headers (# ## ### for Markdown, etc.)
- FR-5.3: Preserve heading hierarchy in chunk metadata
- FR-5.4: Apply size limits: split large sections exceeding MAX_CHUNK_TOKENS
- FR-5.5: Extract and preserve header levels (h1, h2, h3, etc.) as metadata
- FR-5.6: Code blocks within documents are preserved intact (no splitting mid-block)
- FR-5.7: Search can filter by document type vs. code type

### FR-6: Documentation Comment Extraction
**Priority:** HIGH
**Description:** Extract and index documentation comments/docstrings separately from code for enhanced searchability.

**Target Comment Types:**
- JSDoc (TypeScript/JavaScript)
- Python docstrings (triple-quoted strings)
- Rustdoc (/// and //!)
- JavaDoc (Java)
- GoDoc (// and /* ... */)
- XML comments (C#, if supported)

**Acceptance Criteria:**
- FR-6.1: Function/method/class-level documentation comments are extracted as separate searchable chunks
- FR-6.2: Extracted docstrings are linked to their parent symbol in metadata
- FR-6.3: Inline comments (single-line //, #) are NOT extracted (too noisy)
- FR-6.4: Multi-line block comments at the top of files (file headers) are extracted
- FR-6.5: Search can target documentation specifically (e.g., "search for auth docs")
- FR-6.6: Docstrings appear in context when searching for related code

### FR-7: Language Detection Enhancement
**Priority:** MEDIUM
**Description:** Enhance language detection to support all new file extensions.

**Acceptance Criteria:**
- FR-7.1: `getLanguage(filePath)` correctly identifies all new languages
- FR-7.2: Extension mappings are comprehensive and collision-free
- FR-7.3: Multi-extension languages (e.g., .graphql and .gql) are handled correctly
- FR-7.4: Unknown extensions gracefully fall back to line-based chunking
- FR-7.5: Language type is correctly stored in chunk metadata

### FR-8: Backward Compatibility
**Priority:** CRITICAL
**Description:** Ensure existing functionality continues to work without breaking changes.

**Acceptance Criteria:**
- FR-8.1: Existing 10 languages continue to parse and chunk identically
- FR-8.2: Existing indexes can be read without migration
- FR-8.3: Existing CLI commands work unchanged
- FR-8.4: Symbol graph construction works for all languages (new and old)
- FR-8.5: PageRank calculations include new language chunks
- FR-8.6: Test suite passes for all existing languages

---

## 3. Non-Functional Requirements

### NFR-1: Performance
**Description:** Indexing performance must not degrade significantly with new languages.

**Criteria:**
- NFR-1.1: Indexing speed for new languages should be within 2x of existing TypeScript/JavaScript performance
- NFR-1.2: Tree-sitter grammars should be lazy-loaded (not all loaded at startup)
- NFR-1.3: Fallback parsers should execute in < 100ms for typical files (< 1000 lines)
- NFR-1.4: Document chunking by headers should be O(n) in file size

### NFR-2: Maintainability
**Description:** Code should be modular and easy to extend for future languages.

**Criteria:**
- NFR-2.1: New language support added via configuration objects (similar to existing `LANGUAGE_CONFIGS`)
- NFR-2.2: Clear separation between tree-sitter parsing and fallback parsing
- NFR-2.3: Document chunking logic isolated in separate module
- NFR-2.4: Comprehensive inline documentation for parser selection logic

### NFR-3: Quality
**Description:** New features must meet existing quality standards.

**Criteria:**
- NFR-3.1: Unit tests for each new language parser
- NFR-3.2: Integration tests for document chunking strategies
- NFR-3.3: Test coverage maintained at > 70% for new code
- NFR-3.4: Type safety: all new code uses TypeScript strict mode

### NFR-4: Dependency Management
**Description:** Tree-sitter grammars must be managed as downloadable WASM files.

**Criteria:**
- NFR-4.1: New grammars downloaded to `grammars/` directory
- NFR-4.2: Grammar files bundled with distribution (npm package, Homebrew)
- NFR-4.3: Grammar loading failures handled gracefully (fallback to simpler parsing)
- NFR-4.4: Clear error messages when grammars are missing

### NFR-5: Documentation
**Description:** User-facing and developer documentation must be updated.

**Criteria:**
- NFR-5.1: README.md updated with complete list of supported languages
- NFR-5.2: CLAUDE.md updated with new language capabilities
- NFR-5.3: AI skill documents (ai-skill.ts) updated with new features
- NFR-5.4: Example queries for new file types added to documentation

---

## 4. User Stories

### US-1: Web Developer
**As a** frontend developer
**I want to** search my CSS/SCSS files for specific style rules
**So that** I can quickly find where colors, layouts, and responsive breakpoints are defined

**Acceptance:** Search "primary color definition" returns relevant CSS/SCSS rulesets

---

### US-2: DevOps Engineer
**As a** DevOps engineer
**I want to** search bash scripts for deployment logic
**So that** I can understand how our CI/CD pipeline works

**Acceptance:** Search "deploy to production" returns relevant bash functions and sections

---

### US-3: Full-Stack Developer
**As a** full-stack developer
**I want to** search GraphQL schemas for type definitions
**So that** I can understand the API contract without opening multiple files

**Acceptance:** Search "user authentication types" returns relevant GraphQL type definitions

---

### US-4: Technical Writer
**As a** documentation maintainer
**I want to** search markdown documentation for specific topics
**So that** I can find and update documentation sections quickly

**Acceptance:** Search "installation instructions" returns markdown sections by header

---

### US-5: API Developer
**As a** backend developer
**I want to** search Python docstrings for API usage examples
**So that** I can find examples of how to use internal libraries

**Acceptance:** Search "authentication example" returns docstrings containing usage patterns

---

### US-6: Configuration Manager
**As a** platform engineer
**I want to** search YAML configuration files for specific settings
**So that** I can audit configuration across microservices

**Acceptance:** Search "database connection settings" returns relevant YAML sections

---

## 5. Acceptance Criteria

### Overall Feature Acceptance

**The extended language support feature is considered complete when:**

1. **Language Coverage:** All 18 new languages/formats are supported (4 web + 3 shell + 2 data + 3 config + 4 docs + 2 comments = 18)
2. **Indexing Works:** `claudemem index` successfully processes files in all new formats
3. **Search Works:** `claudemem search <query>` returns relevant results from new file types
4. **Quality Checks Pass:** All existing tests pass + new tests for new languages pass
5. **Documentation Updated:** README and CLAUDE.md reflect new capabilities
6. **No Regressions:** Existing 10 languages continue to work identically
7. **Performance Acceptable:** Indexing time increase is < 20% for typical projects with mixed file types
8. **User Validation:** Manual testing confirms user stories are satisfied

---

## 6. Technical Constraints

### TC-1: Tree-sitter Grammar Availability
**Constraint:** Not all languages have mature tree-sitter grammars.

**Mitigation:**
- Research grammar availability before implementation
- Implement robust fallback parsing for languages without grammars
- Document which languages use tree-sitter vs. fallback

**Grammars to Evaluate:**
- ✅ Confirmed available: bash, css, html, json, yaml, toml, graphql
- ❓ Need verification: scss, sass, fish, rst, asciidoc, org-mode

### TC-2: WASM File Size
**Constraint:** Each grammar adds ~100-500KB to distribution size.

**Mitigation:**
- Accept increased distribution size (total ~5-8MB for all grammars)
- Consider optional grammar downloads for less common languages (future enhancement)
- Compress grammars in npm package

### TC-3: Parser Complexity
**Constraint:** Some formats (YAML, Markdown) have complex parsing edge cases.

**Mitigation:**
- Start with simple chunking strategies (headers, top-level keys)
- Iterate based on user feedback
- Don't aim for perfect parsing initially (pragmatic approach)

### TC-4: Backward Compatibility
**Constraint:** Existing indexes must continue to work without migration.

**Mitigation:**
- No changes to core chunk schema
- New languages use existing `CodeChunk` type
- Language field already supports arbitrary string values

### TC-5: Symbol Graph for Non-Code Files
**Constraint:** Documents/configs don't have "symbols" in traditional sense.

**Mitigation:**
- Documents: treat headers as symbols (PageRank can still apply)
- Configs: treat top-level keys as symbols
- Symbol extraction remains optional (existing fallback already handles this)

---

## 7. Open Questions

### OQ-1: Configuration File Chunking Depth
**Question:** Should we chunk nested configuration (e.g., YAML nested keys) or just top-level?

**Options:**
- A. Top-level only (simpler, faster)
- B. Nested keys up to 2 levels deep (more granular)
- C. Configurable depth (flexible but complex)

**Recommendation:** Start with option A, iterate to B based on user feedback.

---

### OQ-2: Document Code Block Handling
**Question:** Should code blocks within Markdown be indexed separately as code?

**Options:**
- A. Index as part of document chunk (simpler)
- B. Extract and index as code with detected language (richer)
- C. Configurable behavior (flexible)

**Recommendation:** Start with option A, consider B as enhancement.

---

### OQ-3: Docstring Chunk Type
**Question:** Should docstrings have their own `chunkType` (e.g., "docstring") or share existing types?

**Options:**
- A. New type: `"docstring"` or `"documentation"`
- B. Use existing types with metadata flag: `isDocumentation: true`
- C. Use `"comment"` chunk type

**Recommendation:** Option A for clarity and filtering capability.

---

### OQ-4: Language Priority for Embedding Models
**Question:** Should different file types use different embedding models (e.g., code-specific for code, text-specific for docs)?

**Options:**
- A. Single model for all (simpler, consistent)
- B. Dual models: code model + doc model (better quality)
- C. Configurable per language (complex)

**Recommendation:** Option A for v1, consider B for future optimization.

---

### OQ-5: HTML Template Extraction
**Question:** How should we handle templating languages in HTML (JSX, Vue, Svelte templates)?

**Options:**
- A. Treat as plain HTML (misses logic)
- B. Detect and use framework-specific parsers (complex, many frameworks)
- C. Extract script/style sections separately (pragmatic middle ground)

**Recommendation:** Option A for initial release, C as enhancement.

---

## 8. Success Metrics

### Quantitative Metrics

1. **Language Coverage:** 28 total languages supported (10 existing + 18 new)
2. **Indexing Success Rate:** > 95% of files in target formats successfully indexed
3. **Search Relevance:** User testing shows > 80% relevant results for new file types
4. **Performance:** Indexing time increase < 20% for mixed codebases
5. **Adoption:** > 30% of users index at least one new file type within first month

### Qualitative Metrics

1. **User Satisfaction:** Positive feedback on new language support in user interviews
2. **Issue Rate:** < 5 bug reports per new language in first 2 weeks post-release
3. **Documentation Quality:** New language examples in README receive community contributions

---

## 9. Implementation Phases

### Phase 1: Web Languages (Week 1)
- HTML, CSS, SCSS/SASS
- Tree-sitter integration for HTML
- Fallback parsing for CSS variants
- Unit tests and documentation

### Phase 2: Shell + Data Languages (Week 2)
- Bash, Zsh, Fish
- SQL, GraphQL
- Tree-sitter integration where available
- Integration tests

### Phase 3: Configuration Formats (Week 3)
- YAML, JSON, TOML
- Header-based chunking logic
- Configuration-specific metadata extraction
- Performance testing

### Phase 4: Document Formats (Week 4)
- Markdown, reStructuredText, AsciiDoc, Org mode
- Header-based chunking with hierarchy preservation
- Document-specific search enhancements
- User acceptance testing

### Phase 5: Docstring Extraction (Week 5)
- JSDoc, Python docstrings, Rustdoc, JavaDoc, GoDoc
- Docstring-to-symbol linking
- Enhanced search filtering
- End-to-end testing

### Phase 6: Polish & Release (Week 6)
- Performance optimization
- Documentation completion
- Bug fixes from beta testing
- Release preparation

---

## 10. Dependencies

### Internal Dependencies
- `src/parsers/parser-manager.ts` - Language detection and parser loading
- `src/core/chunker.ts` - Chunk extraction logic
- `src/types.ts` - Type definitions (may need `chunkType` extension)

### External Dependencies
- Tree-sitter WASM grammars (must download/bundle):
  - tree-sitter-html
  - tree-sitter-css
  - tree-sitter-bash
  - tree-sitter-fish
  - tree-sitter-json
  - tree-sitter-yaml
  - tree-sitter-toml
  - tree-sitter-graphql
  - tree-sitter-markdown (if available)

### Risk Mitigation
- Download all grammars before implementation starts
- Test grammar loading in development environment
- Implement comprehensive fallback for missing grammars

---

## 11. Risks and Mitigations

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| Grammar unavailability for key languages | HIGH | MEDIUM | Implement robust fallback parsers; verify availability early |
| Performance degradation with many file types | MEDIUM | MEDIUM | Lazy-load grammars; benchmark each language |
| Increased bundle size impacts adoption | LOW | HIGH | Accept size increase; document as tradeoff; consider optional grammars |
| Complex document parsing introduces bugs | MEDIUM | HIGH | Start simple (header-only); comprehensive testing |
| Backward compatibility breaks existing users | HIGH | LOW | Rigorous regression testing; no schema changes |

---

## 12. Future Enhancements (Out of Scope for v1)

1. **Additional Languages:** PHP, Ruby, Swift, Kotlin, Scala
2. **Smart Code Block Extraction:** Extract code from Markdown as separate chunks with language detection
3. **Multi-Model Embeddings:** Use specialized models for code vs. docs
4. **Custom Chunking Rules:** User-configurable chunking strategies per file type
5. **Language-Specific Queries:** Advanced search filters (e.g., "find all bash functions that call curl")
6. **Documentation Linking:** Automatically link code to related documentation chunks
7. **Notebook Support:** Jupyter notebooks (.ipynb) with cell-level chunking

---

## Appendix A: Grammar Research Checklist

**Task:** Verify tree-sitter grammar availability before implementation.

- [ ] tree-sitter-html - https://github.com/tree-sitter/tree-sitter-html
- [ ] tree-sitter-css - https://github.com/tree-sitter/tree-sitter-css
- [ ] tree-sitter-bash - https://github.com/tree-sitter/tree-sitter-bash
- [ ] tree-sitter-fish - https://github.com/ram02z/tree-sitter-fish
- [ ] tree-sitter-json - https://github.com/tree-sitter/tree-sitter-json
- [ ] tree-sitter-yaml - https://github.com/ikatyang/tree-sitter-yaml
- [ ] tree-sitter-toml - https://github.com/ikatyang/tree-sitter-toml
- [ ] tree-sitter-graphql - https://github.com/bkegley/tree-sitter-graphql
- [ ] tree-sitter-markdown - https://github.com/MDeiml/tree-sitter-markdown
- [ ] tree-sitter-rst - Research needed
- [ ] tree-sitter-asciidoc - Research needed (may not exist)
- [ ] tree-sitter-org - https://github.com/milisims/tree-sitter-org

---

## Appendix B: Type Definitions Extension

**Potential changes to `src/types.ts`:**

```typescript
// Add new chunk types
export type ChunkType =
  | "function"
  | "method"
  | "class"
  | "module"
  | "block"
  | "docstring"        // NEW: documentation comments
  | "document-section" // NEW: document headers
  | "config-section"   // NEW: config top-level keys
  | "stylesheet-rule"  // NEW: CSS rulesets
  | "query"            // NEW: SQL/GraphQL queries
  | "shell-function"   // NEW: shell script functions
  ;

// Add document-specific metadata
export interface CodeChunk {
  // ... existing fields ...

  // NEW: Optional fields for documents
  headingLevel?: number;      // For documents: 1 = h1, 2 = h2, etc.
  parentHeading?: string;     // For documents: parent section title
  documentType?: "markdown" | "rst" | "asciidoc" | "org";

  // NEW: Optional field for docstrings
  isDocumentation?: boolean;  // True if this is a docstring/comment
  documentedSymbol?: string;  // Symbol this docstring documents
}
```

---

**END OF REQUIREMENTS DOCUMENT**
